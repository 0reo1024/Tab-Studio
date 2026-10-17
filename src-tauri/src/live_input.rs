//! Instrument input (docs/live-input.md): which device the engine plays through (WASAPI or
//! ASIO), the instrument channel, the monitor (gain, NAM amp, plugins on short live links),
//! the always-on recorder (last 5 minutes + rotating files) and takes.
//!
//! The device streams live on one thread (cpal streams are not Send). Switching device or
//! turning the input on/off asks that thread to reopen: it closes the streams, gets the
//! engine core back and moves it to the new ones, so the song and mixer stay loaded.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tabstudio_audio::device::{self, Backend, CoreSource, DeviceSpec};
use tabstudio_audio::engine::{Command, Control, MAX_BLOCK};
use tabstudio_audio::live::{InputTap, LiveMix, LiveStatus, Replay, ReplaySource, live_parts};
use tabstudio_audio::nam::{NamAmp, NamStage, NamTone};
use tabstudio_audio::recorder::{Recorder, RecorderConfig};

use crate::audio::{AudioService, FxSpec, build_chain, send};

/// Saved in live.json (app data).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveConfig {
    /// "wasapi" | "asio": the engine's whole output goes through this.
    pub backend: String,
    /// Output device / ASIO driver (None: default).
    pub output: Option<String>,
    /// WASAPI input device (None: default). ASIO uses the driver's inputs.
    pub input: Option<String>,
    /// Instrument channel (0-based) of the input.
    pub channel: u32,
    /// ASIO buffer (frames).
    pub buffer: u32,
    pub input_db: f32,
    pub level: f32,
    pub monitor: bool,
    /// Size cap for the rolling recording files (MB).
    pub disk_mb: u64,
    /// Record what was heard (amp/plugins) beside the DI.
    pub record_wet: bool,
    /// Plugins on the monitor: "latency" (start one block behind, grow when lateness comes
    /// back) or "stable" (start where nothing dropped in tests, grow on any lateness).
    pub link_mode: String,
}

impl Default for LiveConfig {
    fn default() -> Self {
        LiveConfig { backend: "wasapi".into(), output: None, input: None, channel: 0, buffer: 128, input_db: 0.0, level: 1.0, monitor: true, disk_mb: 2048, record_wet: true, link_mode: "latency".into() }
    }
}

impl LiveConfig {
    fn spec(&self, input: bool) -> DeviceSpec {
        let backend = Backend::parse(&self.backend);
        DeviceSpec { backend, output: self.output.clone(), input: input.then(|| self.input.clone().filter(|_| backend == Backend::Wasapi)), buffer: Some(self.buffer.clamp(16, 4096)) }
    }
    fn stable_links(&self) -> bool {
        self.link_mode == "stable"
    }
    fn mix(&self) -> LiveMix {
        LiveMix { input_db: self.input_db, level: self.level, monitor: self.monitor }
    }
}

/// What the device thread reports after opening (Send).
#[derive(Clone)]
pub struct OpenedInfo {
    pub sample_rate: u32,
    pub output_name: String,
    pub input_name: Option<String>,
    pub input_channels: u16,
    pub buffer: u32,
    pub backend: Backend,
    pub stats: Arc<tabstudio_audio::output::CallbackStats>,
    /// Set when the configured device failed and another one was opened instead.
    pub fallback: Option<String>,
}

impl OpenedInfo {
    fn from(o: &device::Opened, fallback: Option<String>) -> OpenedInfo {
        OpenedInfo { sample_rate: o.sample_rate, output_name: o.output_name.clone(), input_name: o.input_name.clone(), input_channels: o.input_channels, buffer: o.buffer, backend: o.backend, stats: o.stats.clone(), fallback }
    }
}

pub enum DeviceRequest {
    Stop,
    Reopen { spec: DeviceSpec, tap: Option<InputTap>, reply: Sender<Result<OpenedInfo, String>> },
}

/// Shared by the device thread and the service: what is open, and whether the chosen
/// device is lost.
pub struct DeviceShared {
    opened: Mutex<OpenedInfo>,
    lost: Mutex<Option<String>>,
    /// The chosen ASIO driver was taken by another app (lost says so); reconnecting is the
    /// user's call, since taking it back stops that app.
    taken: std::sync::atomic::AtomicBool,
    /// A passing remark (shown for NOTICE_SECONDS), e.g. that the driver was taken back.
    notice: Mutex<Option<(String, Instant)>>,
}

const NOTICE_SECONDS: u64 = 30;

/// Shown when another app opened the same ASIO driver at another buffer and ours stopped.
fn taken_back_message(driver: &str, buffer: u32) -> String {
    format!("別のアプリが同じASIOドライバ（{driver}）を違うバッファで使い始めたため、音が一度止まりました。こちらに戻しましたが、そのアプリの音は止まっています。両方で使うときは、そのアプリのバッファを {buffer} にそろえてください。")
}

fn taken_message(driver: &str, buffer: u32) -> String {
    format!("別のアプリが同じASIOドライバ（{driver}）を違うバッファで使っているため、音が止まりました。そのアプリを閉じるか、そのアプリのバッファを {buffer} にそろえてから「もう一度つなぐ」を押してください。いまは既定の出力で鳴らしています。")
}

impl DeviceShared {
    pub fn opened(&self) -> OpenedInfo {
        self.opened.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    /// Why the chosen device is not playing (None: it is).
    pub fn lost(&self) -> Option<String> {
        self.lost.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn set(&self, opened: OpenedInfo, lost: Option<String>) {
        *self.opened.lock().unwrap_or_else(|e| e.into_inner()) = opened;
        *self.lost.lock().unwrap_or_else(|e| e.into_inner()) = lost;
        self.taken.store(false, Ordering::Relaxed);
    }
    /// Another app holds the chosen ASIO driver (see lost()).
    pub fn taken(&self) -> bool {
        self.taken.load(Ordering::Relaxed)
    }
    /// The remark of the last NOTICE_SECONDS, if any.
    pub fn notice(&self) -> Option<String> {
        self.notice.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(_, at)| at.elapsed() < Duration::from_secs(NOTICE_SECONDS)).map(|(m, _)| m.clone())
    }
    fn tell(&self, message: String) {
        *self.notice.lock().unwrap_or_else(|e| e.into_inner()) = Some((message, Instant::now()));
    }
}

/// The device thread's side: the open streams and where the core and tap come back.
struct Device {
    streams: Option<device::Streams>,
    returned: device::Returned,
    /// What should be open (the user's choice).
    wanted: DeviceSpec,
    stats: Arc<tabstudio_audio::output::CallbackStats>,
    lost_seen: u64,
    /// Output callbacks last seen, and when they last moved (a driver that stops calling
    /// back without reporting an error, as some ASIO drivers do when switched off).
    callbacks_seen: u64,
    moved_at: Instant,
    shared: Arc<DeviceShared>,
    /// All of `wanted` (with its input) is open. Otherwise the watch waits for it to return.
    on_wanted: bool,
    /// `wanted` was seen missing since it last failed (so its reappearance is a real return,
    /// not a device that enumerates but will not open, e.g. busy in another app).
    absent: bool,
    /// Failed opens since `wanted` reappeared (a device just switched on can need a moment).
    tries: u8,
    /// The input tap while what is open has no input, so the input (monitor and recorder)
    /// comes back with the device.
    spare_tap: Option<InputTap>,
    next_try: Instant,
    /// When the ASIO driver was last taken back from another app (a second time soon after
    /// means the two apps would keep taking it from each other: then ours lets go).
    taken_at: Option<Instant>,
}

/// Shown while the chosen device is away.
fn waiting_message(error: &str) -> String {
    format!("音声デバイスが使えません（{error}）。つなぎ直す・電源を入れると自動で戻ります。")
}

impl Device {
    fn new(streams: device::Streams, returned: device::Returned, wanted: DeviceSpec, stats: Arc<tabstudio_audio::output::CallbackStats>, shared: Arc<DeviceShared>) -> Device {
        Device { streams: Some(streams), returned, wanted, stats, lost_seen: 0, callbacks_seen: 0, moved_at: Instant::now(), shared, on_wanted: true, absent: false, tries: 0, spare_tap: None, next_try: Instant::now(), taken_at: None }
    }

    /// Closes the streams and opens `spec` with the core and `tap` (else the previous tap,
    /// so the monitor and recorder keep their rings). Without an input in `spec`, the tap
    /// is kept for when `wanted` (with its input) opens again.
    fn switch(&mut self, spec: &DeviceSpec, tap: Option<InputTap>) -> Result<OpenedInfo, String> {
        drop(self.streams.take());
        let core = self.returned.core.recv_timeout(Duration::from_secs(5)).map_err(|_| "音声エンジンが応答しません。".to_string())?;
        let old_tap = self.returned.tap.try_recv().ok().or_else(|| self.spare_tap.take());
        let tap = tap.or(old_tap);
        let tap = if spec.input.is_some() {
            tap
        } else {
            self.spare_tap = tap.filter(|_| self.wanted.input.is_some());
            None
        };
        let (result, returned) = device::open(spec, CoreSource::Existing(core), tap);
        self.returned = returned;
        let (streams, opened, _) = result?;
        self.streams = Some(streams);
        self.stats = opened.stats.clone();
        self.lost_seen = 0;
        self.callbacks_seen = 0;
        self.moved_at = Instant::now();
        Ok(OpenedInfo::from(&opened, None))
    }

    /// What is open is not all of `wanted`: watch for it to come back.
    fn wait_for_wanted(&mut self) {
        self.on_wanted = false;
        self.absent = !device::present(&self.wanted);
        self.tries = 0;
        self.next_try = Instant::now() + Duration::from_secs(3);
    }

    /// `wanted` opened.
    fn joined(&mut self, opened: OpenedInfo) {
        self.on_wanted = true;
        self.tries = 0;
        self.shared.set(opened, None);
    }

    /// Opens `spec`; if it fails, `wanted` without the input, then the default output, and
    /// waits for `wanted` to come back.
    fn open(&mut self, spec: &DeviceSpec, tap: Option<InputTap>) -> Result<OpenedInfo, String> {
        let error = match self.switch(spec, tap) {
            Ok(opened) => {
                self.joined(opened.clone());
                return Ok(opened);
            }
            Err(e) => e,
        };
        self.wait_for_wanted();
        let message = waiting_message(&error);
        for retry in [DeviceSpec { input: None, ..self.wanted.clone() }, DeviceSpec::default()] {
            if let Ok(opened) = self.switch(&retry, None) {
                self.shared.set(OpenedInfo { fallback: Some(error.clone()), ..opened }, Some(message));
                return Err(error);
            }
        }
        *self.shared.lost.lock().unwrap_or_else(|e| e.into_inner()) = Some(message);
        Err(format!("{error}（どの出力も開けませんでした）"))
    }

    /// Plays the default output (no input) so the app is never left silent.
    fn rescue_default(&mut self, message: &str) {
        match self.switch(&DeviceSpec::default(), None) {
            Ok(opened) => self.shared.set(OpenedInfo { fallback: Some(message.to_string()), ..opened }, Some(message.to_string())),
            Err(_) => *self.shared.lost.lock().unwrap_or_else(|e| e.into_inner()) = Some(message.to_string()),
        }
    }

    /// The output has stopped calling back for 2 s.
    fn stalled(&mut self, now: Instant) -> bool {
        let callbacks = self.stats.callbacks.load(Ordering::Relaxed);
        if callbacks != self.callbacks_seen {
            self.callbacks_seen = callbacks;
            self.moved_at = now;
            return false;
        }
        now.duration_since(self.moved_at) > Duration::from_secs(2)
    }

    /// Twice a second. A lost device (unplugged, switched off, driver reset) is reopened
    /// once; if that fails the default output plays without the input, and `wanted` is
    /// tried again once it has been missing and is back (checked every 3 s; up to 3 tries,
    /// as a device just switched on can take a moment). The same applies when `wanted`
    /// could not open in the first place (e.g. the app started with it off).
    fn watch(&mut self) {
        let now = Instant::now();
        if self.streams.is_none() {
            if now >= self.next_try {
                self.next_try = now + Duration::from_secs(2);
                self.rescue_default("音声デバイスを開けません。");
            }
            return;
        }
        let lost = self.stats.lost.load(Ordering::Relaxed);
        if lost > self.lost_seen || self.stalled(now) {
            // An ASIO driver that stopped calling back without an error while it is still
            // there (it loads; switched off it would not): another app opened it at another
            // buffer and the driver went over to that app (Nano Cortex does this).
            let taken = lost == self.lost_seen && self.wanted.backend == Backend::Asio && device::present(&self.wanted);
            self.lost_seen = lost;
            let wanted = self.wanted.clone();
            let driver = self.shared.opened().output_name;
            let buffer = wanted.buffer.unwrap_or(0);
            if taken && self.taken_at.is_some_and(|at| now.duration_since(at) < Duration::from_secs(15)) {
                // Taken again right after we took it back: let the other app have it.
                self.wait_for_wanted();
                self.absent = false;
                let message = taken_message(&driver, buffer);
                self.rescue_default(&message);
                self.shared.taken.store(true, Ordering::Relaxed);
                return;
            }
            match self.switch(&wanted, None) {
                Ok(opened) => {
                    self.joined(opened);
                    if taken {
                        self.taken_at = Some(now);
                        self.shared.tell(taken_back_message(&driver, buffer));
                    }
                }
                Err(e) => {
                    self.wait_for_wanted();
                    self.rescue_default(&waiting_message(&e));
                }
            }
            return;
        }
        if self.on_wanted || now < self.next_try {
            return;
        }
        self.next_try = now + Duration::from_secs(3);
        if !device::present(&self.wanted) {
            self.absent = true;
            return;
        }
        if !self.absent {
            return;
        }
        let wanted = self.wanted.clone();
        match self.switch(&wanted, None) {
            Ok(opened) => self.joined(opened),
            Err(e) => {
                self.tries += 1;
                if self.tries >= 3 {
                    self.absent = false;
                    self.tries = 0;
                }
                self.rescue_default(&waiting_message(&e));
            }
        }
    }
}

/// Starts the device thread on `spec` (falling back to the default WASAPI output if it
/// cannot open, and then waiting for `spec` to come back). Returns the engine's control
/// side, what is open and the request channel.
pub fn spawn_device(spec: DeviceSpec) -> Result<(Control, Arc<DeviceShared>, Sender<DeviceRequest>), String> {
    let (ready_tx, ready_rx) = channel();
    let (tx, rx) = channel::<DeviceRequest>();
    std::thread::Builder::new()
        .name("tabstudio-audio-device".into())
        .spawn(move || {
            let (mut result, mut returned) = device::open(&spec, CoreSource::New, None);
            let mut fallback = None;
            if let Err(e) = &result {
                if spec != DeviceSpec::default() {
                    fallback = Some(e.clone());
                    (result, returned) = device::open(&DeviceSpec::default(), CoreSource::New, None);
                }
            }
            let (streams, opened, control) = match result {
                Ok(ok) => ok,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let lost = fallback.as_deref().map(waiting_message);
            let shared = Arc::new(DeviceShared { opened: Mutex::new(OpenedInfo::from(&opened, fallback.clone())), lost: Mutex::new(lost), taken: Default::default(), notice: Mutex::new(None) });
            let _ = ready_tx.send(Ok((control.expect("new engine"), shared.clone())));
            let mut device = Device::new(streams, returned, spec, opened.stats.clone(), shared);
            if fallback.is_some() {
                device.wait_for_wanted();
            }
            loop {
                match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(DeviceRequest::Reopen { spec, tap, reply }) => {
                        device.wanted = spec.clone();
                        let _ = reply.send(device.open(&spec, tap));
                    }
                    Ok(DeviceRequest::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => device.watch(),
                }
            }
            drop(device.streams.take());
        })
        .map_err(|e| e.to_string())?;
    let (control, shared) = ready_rx.recv_timeout(Duration::from_secs(15)).map_err(|_| "音声デバイスを開けません。".to_string())??;
    Ok((control, shared, tx))
}

/// The instrument input's state (behind AudioService::live).
pub struct LiveState {
    pub config: LiveConfig,
    config_path: Option<PathBuf>,
    dir: Option<PathBuf>,
    takes: Option<PathBuf>,
    pub status: Arc<LiveStatus>,
    pub recorder: Option<Recorder>,
    /// Input on (streams opened with the instrument).
    pub enabled: bool,
    /// The "liveRecording" setting.
    pub recording: bool,
    /// Live links to effect hosts (instance id -> link), their plugins' latency and learning
    /// key (the plugin's name, plus " [stable]" in that mode).
    links: std::collections::HashMap<String, (Arc<tabstudio_fxlink::Shared>, u64, String)>,
    externals: Vec<String>,
    nam_key: Option<String>,
    /// The monitor's chain as last set (rebuilt when the device changes).
    last_fx: Option<Vec<FxSpec>>,
    /// ASIO drivers as last listed (see live_devices).
    asio_devices: Option<Vec<device::DeviceInfo>>,
    /// Device blocks each plugin's live link grew to (plugin name -> blocks; live-links.json),
    /// so a rebuilt chain or the next session starts where the plugin was known to keep up;
    /// and the block the links were made for.
    learned: std::collections::BTreeMap<String, usize>,
    learned_path: Option<PathBuf>,
    link_block: usize,
    /// Per device ("asio|NeuralDSP Nano Cortex"): frames of round trip its driver does not
    /// report, measured by live_ping (live-latency.json). Nano Cortex: 613 at every buffer.
    hidden: std::collections::BTreeMap<String, i64>,
    hidden_path: Option<PathBuf>,
}

impl LiveState {
    /// Keeps, per plugin, how many device blocks its live link grew to (saved when it changed).
    fn remember_delays(&mut self) {
        let block = self.link_block.max(1);
        let mut changed = false;
        for (link, _, plugin) in self.links.values() {
            let blocks = link.delay().div_ceil(block);
            if self.learned.get(plugin) != Some(&blocks) {
                self.learned.insert(plugin.clone(), blocks);
                changed = true;
            }
        }
        if let (true, Some(path)) = (changed, &self.learned_path) {
            if let Ok(text) = serde_json::to_vec_pretty(&self.learned) {
                let _ = crate::fsutil::atomic_write(path, &text);
            }
        }
    }
}

impl Default for LiveState {
    fn default() -> Self {
        LiveState { config: LiveConfig::default(), config_path: None, dir: None, takes: None, status: LiveStatus::new(), recorder: None, enabled: false, recording: false, links: Default::default(), externals: Vec::new(), nam_key: None, last_fx: None, asio_devices: None, learned: Default::default(), learned_path: None, link_block: 0, hidden: Default::default(), hidden_path: None }
    }
}

impl LiveState {
    /// The device the engine should open (the input is added when turned on).
    pub fn output_spec(&self) -> DeviceSpec {
        self.config.spec(false)
    }
}

fn save_config(path: &Path, config: &LiveConfig) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(path, &text).map_err(|e| e.to_string())
}

/// The key a device's measured round trip is kept under.
fn device_key(backend: Backend, output: &str) -> String {
    format!("{}|{output}", backend.name())
}

fn backend_name(b: Backend) -> &'static str {
    b.name()
}

impl AudioService {
    fn live(&self) -> std::sync::MutexGuard<'_, LiveState> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Where live.json, the rolling files and the takes go (called before the engine starts).
    pub fn set_live_dirs(&self, data: &Path, takes: PathBuf) {
        let mut live = self.live();
        if live.config_path.is_some() {
            return;
        }
        let path = data.join("live.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<LiveConfig>(&text) {
                live.status.record_wet.store(config.record_wet, Ordering::Relaxed);
                live.config = config;
            }
        }
        live.config_path = Some(path);
        let learned = data.join("live-links.json");
        if let Some(map) = std::fs::read_to_string(&learned).ok().and_then(|t| serde_json::from_str(&t).ok()) {
            live.learned = map;
        }
        live.learned_path = Some(learned);
        let hidden = data.join("live-latency.json");
        if let Some(map) = std::fs::read_to_string(&hidden).ok().and_then(|t| serde_json::from_str(&t).ok()) {
            live.hidden = map;
        }
        live.hidden_path = Some(hidden);
        live.dir = Some(data.join("live"));
        live.takes = Some(takes);
    }

    /// Devices of every backend, and the current choice.
    pub fn live_devices(&self) -> Value {
        // The panel asks every few seconds (to see devices switched on or off). Enumerating
        // ASIO loads each driver, so while an ASIO driver plays, its list is the last one read.
        let asio_open = self.running.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|r| r.device_state.opened().backend == Backend::Asio);
        let mut found = device::list_backend(Backend::Wasapi);
        let asio = match (asio_open, self.live().asio_devices.clone()) {
            (true, Some(cached)) => cached,
            _ => device::list_backend(Backend::Asio),
        };
        self.live().asio_devices = Some(asio.clone());
        found.extend(asio);
        let devices: Vec<Value> = found
            .into_iter()
            .map(|d| json!({"backend": backend_name(d.backend), "name": d.name, "inputs": d.inputs, "outputs": d.outputs, "sampleRate": d.sample_rate, "bufferMin": d.buffer_min, "bufferMax": d.buffer_max, "bufferSizes": d.buffer_sizes, "defaultInput": d.default_input, "defaultOutput": d.default_output}))
            .collect();
        json!({"devices": devices, "asio": cfg!(feature = "asio"), "config": self.live().config})
    }

    /// Opens the streams again for the current config (with the input when enabled).
    fn reopen(&self) -> Result<OpenedInfo, String> {
        let _one = self.reopening.lock().unwrap_or_else(|e| e.into_inner());
        let (spec, enabled, status, keep) = {
            let live = self.live();
            let backend = Backend::parse(&live.config.backend);
            // ASIO: input and output share each buffer switch; WASAPI: two clocks, 20 ms of slack.
            let keep = if backend == Backend::Asio { live.config.buffer as usize } else { 960 };
            (live.config.spec(live.enabled), live.enabled, live.status.clone(), keep)
        };
        let parts = enabled.then(|| live_parts(status.clone(), keep, MAX_BLOCK));
        let (tap, rest) = match parts {
            Some(p) => (Some(p.tap), Some((p.stage, p.dry, p.wet))),
            None => (None, None),
        };
        let requests = {
            let running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            running.as_ref().ok_or("音声エンジンが起動していません。")?.requests.clone()
        };
        let (reply_tx, reply_rx) = channel();
        requests.send(DeviceRequest::Reopen { spec, tap, reply: reply_tx }).map_err(|_| "音声エンジンが応答しません。".to_string())?;
        let result = reply_rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "音声デバイスを開けません。".to_string())?;
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        // Whether or not the chosen device opened, an enabled input stays on: if it did not,
        // the device thread keeps the tap and brings the input back when the device returns.
        let now = r.device_state.opened();
        r.device = now.output_name.clone();
        let mut live = self.live();
        match rest {
            Some((stage, dry, wet)) => {
                send(&mut r.control, Command::Live(Some(stage)))?;
                send(&mut r.control, Command::LiveMix(live.config.mix()))?;
                let channels = result.as_ref().map_or(0, |o| o.input_channels);
                let channel = if channels > 0 { live.config.channel.min(channels as u32 - 1) } else { live.config.channel };
                status.channel.store(channel, Ordering::Relaxed);
                status.recording.store(live.recording, Ordering::Relaxed);
                let rate = r.sample_rate;
                if live.recorder.as_ref().is_some_and(|rec| rec.rate() != rate) {
                    live.recorder = None;
                }
                if live.recorder.is_none() {
                    let dir = live.dir.clone().ok_or("録音フォルダが設定されていません。")?;
                    let takes = live.takes.clone().unwrap_or_else(|| dir.join("takes"));
                    live.recorder = Some(Recorder::new(RecorderConfig { dir, takes, rate, history_seconds: 300, segment_seconds: 300, disk_cap: live.config.disk_mb.max(100) * 1024 * 1024 }));
                }
                let clock_status = r.status.clone();
                if let Some(rec) = live.recorder.as_mut() {
                    rec.attach(dry, wet, Box::new(move || clock_status.playing().then(|| clock_status.position())));
                }
            }
            None => {
                send(&mut r.control, Command::Live(None))?;
                if let Some(rec) = live.recorder.as_mut() {
                    rec.detach();
                }
            }
        }
        result
    }

    /// Saves the device choice and levels; reopens when the device part changed.
    pub fn live_configure(&self, config: LiveConfig) -> Result<Value, String> {
        let (device_changed, path, links_changed) = {
            let mut live = self.live();
            let old = live.config.clone();
            let changed = old.backend != config.backend || old.output != config.output || old.input != config.input || old.buffer != config.buffer;
            let links_changed = old.link_mode != config.link_mode;
            live.config = config.clone();
            live.status.channel.store(config.channel, Ordering::Relaxed);
            live.status.record_wet.store(config.record_wet, Ordering::Relaxed);
            (changed, live.config_path.clone(), links_changed)
        };
        if let Some(path) = path {
            save_config(&path, &config)?;
        }
        let running = self.running.lock().unwrap_or_else(|e| e.into_inner()).is_some();
        if !running {
            return Ok(json!({"reopened": false}));
        }
        {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(r) = running.as_mut() {
                send(&mut r.control, Command::LiveMix(config.mix()))?;
            }
        }
        if device_changed {
            let rate = self.running.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| r.sample_rate);
            // A device that is off cannot be probed: switch to it anyway, and the device
            // thread waits for it to come on.
            if let (Some(rate), Ok(wanted)) = (rate, device::probe_rate(&config.spec(false))) {
                if rate != wanted {
                    return Err(format!("このデバイスは {wanted} Hz です（いまは {rate} Hz）。設定は保存しました。アプリを再起動すると切り替わります。"));
                }
            }
            let opened = self.reopen();
            // External effects on live links assumed the old buffer: rebuild the chain.
            self.rebuild_live_fx()?;
            let opened = opened?;
            return Ok(json!({"reopened": true, "device": opened.output_name}));
        }
        if links_changed {
            // The plugins' links start over in the new mode.
            self.rebuild_live_fx()?;
        }
        Ok(json!({"reopened": false}))
    }

    /// Turns the instrument input on or off.
    pub fn live_enable(&self, on: bool, recording: bool) -> Result<Value, String> {
        {
            let mut live = self.live();
            live.recording = recording;
            live.status.recording.store(recording && on, Ordering::Relaxed);
            if live.enabled == on {
                return Ok(self.live_status());
            }
            live.enabled = on;
        }
        // Turning on while the device is away (off, unplugged) still turns the input on: it
        // starts when the device comes back, and the status says so meanwhile.
        if let Err(e) = self.reopen() {
            if !on || self.running.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_none_or(|r| r.device_state.lost().is_none()) {
                return Err(e);
            }
        }
        if on {
            self.rebuild_live_fx()?;
        }
        Ok(self.live_status())
    }

    /// The "liveRecording" setting changed.
    pub fn live_recording(&self, on: bool) {
        let mut live = self.live();
        live.recording = on;
        let enabled = live.enabled;
        live.status.recording.store(on && enabled, Ordering::Relaxed);
        if !on {
            if let Some(rec) = live.recorder.as_ref() {
                rec.stop_take();
            }
        }
    }

    /// Meters, delays and recorder state for the panel (polled while it is open).
    pub fn live_status(&self) -> Value {
        // Lock order everywhere: running, then live.
        let (opened, lost, music_short, taken, notice) = match self.running.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            Some(r) => (Some(r.device_state.opened()), r.device_state.lost(), r.status.music_short(), r.device_state.taken(), r.device_state.notice()),
            None => (None, None, 0, false, None),
        };
        let mut live = self.live();
        // Polled while the input is on: what the links grew to is kept for next time.
        live.remember_delays();
        let s = &live.status;
        let rate = opened.as_ref().map_or(48000, |o| o.sample_rate) as f64;
        let stats = opened.as_ref().map(|o| o.stats.clone());
        // Held counts the block being played. With ASIO the input and output of one buffer
        // switch are the same moment, so only what waits beyond it adds delay.
        let held = s.held.load(Ordering::Relaxed);
        let held = match opened.as_ref() {
            Some(o) if o.backend == Backend::Asio => held.saturating_sub(o.buffer as u64),
            _ => held,
        };
        let (driver_in, driver_out) = stats.as_ref().map_or((0, 0), |st| (st.input_latency_us.load(Ordering::Relaxed), st.output_latency_us.load(Ordering::Relaxed)));
        // What the driver leaves out (USB, converters, the interface's own processing), once
        // measured with a loopback cable: the round trip is then the driver's figures plus it.
        let hidden = opened.as_ref().and_then(|o| live.hidden.get(&device_key(o.backend, &o.output_name)).copied());
        let hidden_ms = hidden.map_or(0.0, |f| f as f64 / rate * 1000.0);
        let link_frames: u64 = live.externals.iter().filter_map(|id| live.links.get(id)).map(|(l, plugin, _)| l.delay() as u64 + plugin).sum();
        let total_ms = (driver_in + driver_out) as f64 / 1000.0 + hidden_ms + (held as f64 + link_frames as f64) / rate * 1000.0;
        let (oldest, end) = live.recorder.as_ref().map_or((0, 0), |r| r.range());
        let late: u64 = live.externals.iter().filter_map(|id| live.links.get(id)).map(|(l, _, _)| l.header().late.load(Ordering::Relaxed)).sum();
        json!({
            "enabled": live.enabled,
            "recording": s.recording.load(Ordering::Relaxed),
            "backend": opened.as_ref().map(|o| backend_name(o.backend)),
            "output": opened.as_ref().map(|o| o.output_name.clone()),
            "input": opened.as_ref().and_then(|o| o.input_name.clone()),
            "inputChannels": opened.as_ref().map_or(0, |o| o.input_channels),
            "buffer": opened.as_ref().map_or(0, |o| o.buffer),
            "fallback": opened.as_ref().and_then(|o| o.fallback.clone()),
            "sampleRate": rate,
            "inputPeak": s.take_input_peak(),
            "monitorPeak": s.take_monitor_peak(),
            "latency": {"totalMs": total_ms, "driverInMs": driver_in as f64 / 1000.0, "driverOutMs": driver_out as f64 / 1000.0, "heldMs": held as f64 / rate * 1000.0, "pluginsMs": link_frames as f64 / rate * 1000.0, "hiddenMs": hidden_ms, "measured": hidden.is_some()},
            "drops": {"overflows": s.overflows.load(Ordering::Relaxed), "underruns": s.underruns.load(Ordering::Relaxed), "trimmed": s.trimmed.load(Ordering::Relaxed), "recorder": s.record_overflows.load(Ordering::Relaxed), "fxLate": late, "musicShort": music_short, "overloads": stats.as_ref().map_or(0, |st| st.overloads.load(Ordering::Relaxed))},
            "inputCallbacks": s.input_callbacks.load(Ordering::Relaxed),
            "timeline": {"oldest": oldest, "end": end},
            "take": live.recorder.as_ref().and_then(|r| r.take_start()),
            "replay": s.replay_position(),
            "error": live.recorder.as_ref().and_then(|r| r.last_error()),
            "deviceLost": lost,
            "deviceTaken": taken,
            "deviceNotice": notice,
            "xruns": stats.as_ref().map_or(0, |st| st.xruns.load(Ordering::Relaxed)),
        })
    }

    /// The monitor's NAM amp (key None removes it).
    pub fn live_nam(&self, key: Option<String>, json_text: Option<&str>) -> Result<(), String> {
        let rate = self.running.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| r.sample_rate).ok_or("音声エンジンが起動していません。")?;
        let stage = match (&key, json_text) {
            (Some(_), Some(text)) => {
                let amp = NamAmp::new(&*self.nam_runtime()?, text, rate as f64)?;
                Some(Box::new(NamStage::new(amp, NamTone::default(), rate as f64)))
            }
            (Some(k), None) if self.live().nam_key.as_ref() == Some(k) => return Ok(()),
            (Some(_), None) => return Err("NAMモデルのデータがありません。".into()),
            (None, _) => None,
        };
        self.live().nam_key = key;
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        send(&mut r.control, Command::LiveNam(stage))
    }

    pub fn live_nam_tone(&self, tone: NamTone) -> Result<(), String> {
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        send(&mut r.control, Command::LiveNamTone(tone))
    }

    /// The monitor's insert chain; external effects get live links (short delay).
    pub fn live_fx(&self, fx: Vec<FxSpec>) -> Result<(), String> {
        self.live().externals = fx.iter().filter(|f| f.kind == "external").filter_map(|f| f.id.clone()).collect();
        let (rate, buffer) = {
            let running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let r = running.as_ref().ok_or("音声エンジンが起動していません。")?;
            (r.sample_rate, r.device_state.opened().buffer)
        };
        // Each link starts one device block behind (or where it grew to before) and grows by
        // a block when its plugin is late (tabstudio-fxlink): a light plugin keeps 1 block, BIAS
        // FX 2 at 64 frames settles at 2-3 (docs/asio-low-buffer-2026-10-17.md).
        self.live().link_block = buffer as usize;
        let chain = build_chain(&fx, rate, |id| self.live_link(id, rate, buffer as usize))?;
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        send(&mut r.control, Command::LiveFx(if fx.is_empty() { None } else { Some(Box::new(chain)) }))?;
        self.live().last_fx = Some(fx);
        Ok(())
    }

    fn rebuild_live_fx(&self) -> Result<(), String> {
        let fx = {
            let mut live = self.live();
            live.remember_delays();
            live.links.clear();
            live.last_fx.clone()
        };
        match fx {
            Some(fx) => self.live_fx(fx),
            None => Ok(()),
        }
    }

    fn live_link(&self, id: &str, rate: u32, block: usize) -> Result<Arc<tabstudio_fxlink::Shared>, String> {
        // A link outlives chain edits (it keeps the delay it grew to); device changes clear them.
        if let Some((shared, _, _)) = self.live().links.get(id) {
            return Ok(shared.clone());
        }
        // One block until the host says which plugin it is (then what it grew to before).
        let block = block.max(16);
        let delay = block.min(tabstudio_fxlink::LIVE_MAX);
        let stable = self.live().config.stable_links();
        let name = format!("{}-live-{}-{}", std::process::id(), id, self.link_counter.fetch_add(1, Ordering::Relaxed));
        let shared = Arc::new(tabstudio_fxlink::Shared::create_with_latency(&name, rate as f64, delay)?);
        shared.header().grow.store(if stable { tabstudio_fxlink::GROW_ANY } else { tabstudio_fxlink::GROW_REPEATED }, Ordering::Release);
        let reply = {
            let linker = self.linker.lock().unwrap_or_else(|e| e.into_inner());
            let linker = linker.as_ref().ok_or("外部FXホストに接続できません。")?;
            linker(id, &name)?
        };
        let plugin = reply.get("latency").and_then(Value::as_u64).unwrap_or(0);
        let plugin_name = reply.get("plugin").and_then(Value::as_str).unwrap_or(id).to_string();
        // Each mode learns on its own; stable starts no shorter than the fixed delay this
        // link had before it adapted (3 blocks under 128 frames, else 2; at least 128 frames).
        let (key, floor) = if stable { (format!("{plugin_name} [stable]"), (block * if block < 128 { 3 } else { 2 }).max(128).div_ceil(block)) } else { (plugin_name, 1) };
        let mut live = self.live();
        let blocks = live.learned.get(&key).copied().unwrap_or(1).max(floor);
        // Set before the engine's end of the link is made (it reads the delay then).
        shared.header().delay.store((block * blocks).min(tabstudio_fxlink::LIVE_MAX) as u64, Ordering::Release);
        live.links.insert(id.to_string(), (shared.clone(), plugin, key));
        Ok(shared)
    }

    /// Opens the chosen device again (after another app had its ASIO driver).
    pub fn live_reconnect(&self) -> Result<Value, String> {
        let opened = self.reopen();
        self.rebuild_live_fx()?;
        let opened = opened?;
        Ok(json!({"device": opened.output_name}))
    }

    /// Measures the real round trip with a loopback cable (an output back into the instrument
    /// input): CLICKS clicks out, each waited for at the input (heard above the input's own
    /// noise, so a turned-down loopback works). Keeps what the driver does not report for this
    /// device, so the panel's latency is the measured one from then on.
    pub fn live_ping(&self) -> Result<Value, String> {
        const CLICKS: usize = 5;
        let (status, enabled) = {
            let live = self.live();
            (live.status.clone(), live.enabled)
        };
        if !enabled {
            return Err("入力をオンにしてから測ってください。".into());
        }
        let opened = self.running.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| r.device_state.opened()).ok_or("音声エンジンが起動していません。")?;
        let rate = opened.sample_rate as f64;
        let mut found = Vec::new();
        for _ in 0..CLICKS {
            status.ping_result.store(tabstudio_audio::live::PING_NONE, Ordering::Release);
            status.ping_request.store(true, Ordering::Release);
            let mut result = tabstudio_audio::live::PING_NONE;
            for _ in 0..75 {
                std::thread::sleep(Duration::from_millis(20));
                result = status.ping_result.load(Ordering::Acquire);
                if result != tabstudio_audio::live::PING_NONE {
                    break;
                }
            }
            status.ping_request.store(false, Ordering::Release);
            if result > 0 {
                found.push(result);
            }
            // Let the click's echo die before the next one.
            std::thread::sleep(Duration::from_millis(150));
        }
        if found.len() < 3 {
            return Err("クリック音が入力に戻ってきませんでした。出力（ヘッドホン端子など）から楽器入力へケーブルをつなぎ、出力の音量を少し上げてください。".into());
        }
        found.sort_unstable();
        let frames = found[found.len() / 2];
        let reported = (opened.stats.input_latency_us.load(Ordering::Relaxed) + opened.stats.output_latency_us.load(Ordering::Relaxed)) as f64 * rate / 1e6;
        let hidden = (frames as f64 - reported).round() as i64;
        {
            let mut live = self.live();
            live.hidden.insert(device_key(opened.backend, &opened.output_name), hidden);
            if let (Some(path), Ok(text)) = (&live.hidden_path, serde_json::to_vec_pretty(&live.hidden)) {
                let _ = crate::fsutil::atomic_write(path, &text);
            }
        }
        let ms = |f: f64| f / rate * 1000.0;
        Ok(json!({"ms": ms(frames as f64), "frames": frames, "clicks": found.len(), "spreadMs": ms((found[found.len() - 1] - found[0]) as f64), "reportedMs": ms(reported), "hiddenMs": ms(hidden as f64)}))
    }

    /// Forgets a closed effect host's live link.
    pub fn live_unlink(&self, id: &str) {
        let mut live = self.live();
        live.remember_delays();
        live.links.remove(id);
    }

    /// The timeline: peaks per bucket over [from, to), phrases and song marks.
    pub fn live_overview(&self, from: u64, to: u64, buckets: usize) -> Value {
        let live = self.live();
        let Some(rec) = live.recorder.as_ref() else { return json!({"dry": [], "wet": [], "phrases": [], "marks": []}) };
        let (dry, wet) = rec.overview(from, to, buckets);
        let round = |v: Vec<f32>| v.into_iter().map(|x| (x * 1000.0).round() / 1000.0).collect::<Vec<f32>>();
        let phrases: Vec<Value> = rec.phrases(-50.0, 2.0).into_iter().filter(|p| p.end > from && p.start < to).map(|p| json!([p.start, p.end])).collect();
        // One mark per second is plenty for the drawing.
        let rate = rec.rate() as u64;
        let mut last = None;
        let marks: Vec<Value> = rec
            .marks(from, to)
            .into_iter()
            .filter(|m| {
                let second = m.frame / rate;
                let keep = last != Some(second);
                last = Some(second);
                keep
            })
            .map(|m| json!([m.frame, m.unix_ms, m.song]))
            .collect();
        json!({"dry": round(dry), "wet": round(wet), "phrases": phrases, "marks": marks, "rate": rate})
    }

    /// Plays [from, to) of the history. `with_song`: the replay waits for the score, which
    /// the app then starts from the returned position (where it was when this was
    /// recorded); both begin on the same engine block.
    pub fn live_replay(&self, from: u64, to: u64, looping: bool, source: &str, with_song: bool) -> Result<Value, String> {
        let (origin, dry, wet, song) = {
            let live = self.live();
            let rec = live.recorder.as_ref().ok_or("まだ録音がありません。")?;
            let (origin, dry, wet) = rec.snapshot(from, to);
            (origin, dry, wet, if with_song { rec.song_at(from) } else { None })
        };
        if dry.is_empty() {
            return Err("この範囲には録音がありません。".into());
        }
        let peak = |v: &[f32]| v.iter().fold(0f32, |m, x| m.max(x.abs()));
        let source = match source {
            "dry" => ReplaySource::Dry,
            "reamp" => ReplaySource::Reamp,
            // Nothing was heard (monitor off): play the DI instead of silence.
            _ if peak(&wet) < 1e-4 && peak(&dry) > 1e-4 => ReplaySource::Dry,
            _ => ReplaySource::Wet,
        };
        let replay = Box::new(Replay { dry, wet, origin, position: 0, looping, source, gain: 1.0, wait_for_song: song.is_some() });
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        // The score's tick there (the app seeks its own cursor and starts it).
        let tick = song.and_then(|seconds| r.song.as_ref().map(|s| s.time_to_tick(seconds).max(0.0).round() as u64));
        send(&mut r.control, Command::LiveReplay(Some(replay)))?;
        Ok(json!({"song": song, "tick": tick}))
    }

    pub fn live_replay_stop(&self) -> Result<(), String> {
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        send(&mut r.control, Command::LiveReplay(None))
    }

    fn take_meta(&self, extra: &Value) -> String {
        let opened = self.running.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| r.device_state.opened());
        let live = self.live();
        let mut meta = json!({
            "app": "Tab Studio",
            "device": opened.as_ref().map(|o| o.output_name.clone()),
            "backend": opened.as_ref().map(|o| backend_name(o.backend)),
            "inputChannel": live.config.channel + 1,
            "inputGainDb": live.config.input_db,
            "amp": live.nam_key,
        });
        if let (Some(map), Some(extra)) = (meta.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                map.insert(k.clone(), v.clone());
            }
        }
        meta.to_string()
    }

    /// Starts a take reaching `back_seconds` into the past; it grows until live_take_stop.
    pub fn live_take_start(&self, back_seconds: f64, label: &str, extra: &Value) -> Result<Value, String> {
        let meta = self.take_meta(extra);
        let live = self.live();
        let rec = live.recorder.as_ref().ok_or("まだ録音がありません。")?;
        if !live.status.recording.load(Ordering::Relaxed) {
            return Err("常時録音がオフです（設定→楽器入力）。".into());
        }
        let back = (back_seconds.clamp(0.0, 300.0) * rec.rate() as f64) as u64;
        let path = rec.start_take(back, label, &meta)?;
        Ok(json!({"path": path}))
    }

    pub fn live_take_stop(&self) -> Value {
        let live = self.live();
        match live.recorder.as_ref().and_then(|r| r.stop_take()) {
            Some((path, frames)) => json!({"path": path, "seconds": frames as f64 / live.recorder.as_ref().map_or(48000, |r| r.rate()) as f64}),
            None => Value::Null,
        }
    }

    /// Saves [from, to) as a take.
    pub fn live_save(&self, from: u64, to: u64, label: &str, extra: &Value) -> Result<Value, String> {
        let meta = self.take_meta(extra);
        let live = self.live();
        let rec = live.recorder.as_ref().ok_or("まだ録音がありません。")?;
        let path = rec.save_range(from, to, label, &meta)?;
        Ok(json!({"path": path}))
    }

    /// The takes folder (created if needed).
    pub fn live_takes_dir(&self) -> Result<PathBuf, String> {
        let dir = self.live().takes.clone().ok_or("録音フォルダが設定されていません。")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    /// Saved takes, newest first.
    pub fn live_takes(&self) -> Result<Value, String> {
        let dir = self.live_takes_dir()?;
        let mut takes: Vec<(String, Value)> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.to_string_lossy().ends_with(" DI.wav"))
            .map(|p| {
                let meta = std::fs::read_to_string(p.with_extension("json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
                let name = p.file_name().map(|n| n.to_string_lossy().trim_end_matches(" DI.wav").to_string()).unwrap_or_default();
                (name.clone(), json!({"name": name, "path": p, "seconds": meta.get("seconds"), "amp": meta.get("amp"), "plugins": meta.get("plugins")}))
            })
            .collect();
        takes.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(Value::Array(takes.into_iter().map(|t| t.1).take(200).collect()))
    }

    /// Stops the recorder thread before the engine goes away.
    pub fn live_shutdown(&self) {
        let mut live = self.live();
        if let Some(rec) = live.recorder.as_mut() {
            rec.stop_take();
            rec.detach();
        }
        live.enabled = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_or_old_config_fills_in_defaults_and_maps_to_a_device_spec() {
        let config: LiveConfig = serde_json::from_str(r#"{"backend":"asio","channel":2}"#).unwrap();
        assert_eq!(config.buffer, 128);
        assert_eq!(config.link_mode, "latency", "plugins default to latency first");
        assert!(!config.stable_links());
        let stable: LiveConfig = serde_json::from_str(r#"{"linkMode":"stable"}"#).unwrap();
        assert!(stable.stable_links());
        assert!(config.monitor);
        let spec = config.spec(true);
        assert_eq!(spec.backend, Backend::Asio);
        // ASIO takes the input from the same driver: no separate input device.
        assert_eq!(spec.input, Some(None));
        assert_eq!(config.spec(false).input, None);
        let wasapi = LiveConfig { input: Some("Mic".into()), ..LiveConfig::default() };
        assert_eq!(wasapi.spec(true).input, Some(Some("Mic".into())));
        assert_eq!(LiveConfig { buffer: 1, ..LiveConfig::default() }.spec(false).buffer, Some(16));
    }
}
