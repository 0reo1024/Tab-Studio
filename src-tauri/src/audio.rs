//! The native audio engine (crates/tabstudio-audio) behind Tauri commands.
//! The device stream lives on its own thread (cpal streams are not Send everywhere);
//! commands go to the engine's lock-free queue and a status thread pushes the transport
//! position and meters to the WebView about 60 times a second.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tabstudio_audio::backing::{Backing, BackingAudio, BackingMix, BackingTransport};
use tabstudio_audio::click::{ClickBank, Metronome};
use tabstudio_audio::nam::{NamAmp, NamRuntime, NamStage, NamTone};
use tabstudio_audio::engine::{Command, Control, Loaded, Preview, Status, TrackMix, render_offline};
use tabstudio_audio::player::{CountIn, Player};
use tabstudio_audio::sfz::SfzInstrument;
use tabstudio_audio::song::Song;
use tabstudio_audio::synth::SoundFont;
use tabstudio_audio::sf3;

/// The GM bank alphaTab plays (public/alphatab/soundfont).
pub const SOUNDFONT: &str = "alphatab/soundfont/GeneralUser-Classical.sf3";

/// Which SFZ instrument a track has in the engine, and for which lanes/pitches.
#[derive(Clone)]
struct Built {
    file: PathBuf,
    pitches: BTreeMap<u8, BTreeSet<u8>>,
    /// The Standard Guitar articulations loaded per lane (other SFZ files load whole).
    switches: BTreeMap<u8, BTreeSet<u8>>,
}

pub(crate) struct Running {
    pub(crate) control: Control,
    pub(crate) status: Arc<Status>,
    pub(crate) sample_rate: u32,
    pub(crate) device: String,
    font: Arc<SoundFont>,
    clicks: Arc<ClickBank>,
    tracks: usize,
    pub(crate) song: Option<Arc<Song>>,
    /// The SFZ file each track should play (None: GM synth).
    sounds: Vec<Option<PathBuf>>,
    built: Vec<Option<Built>>,
    /// Which NAM model (the front end's key) each track's amp runs.
    nam: Vec<Option<String>>,
    /// External effects per track (for the delay compensation), MAX_TRACKS long.
    externals: Vec<usize>,
    /// The device thread (stop, or reopen another device / with the instrument input).
    pub(crate) requests: Sender<crate::live_input::DeviceRequest>,
    /// What is open now (the device thread updates it, also when it recovers a lost device).
    pub(crate) device_state: Arc<crate::live_input::DeviceShared>,
}

#[derive(Default)]
pub struct AudioService {
    pub(crate) running: Mutex<Option<Running>>,
    /// Instrument input: device choice, monitor, recorder (live_input.rs).
    pub(crate) live: Mutex<crate::live_input::LiveState>,
    /// One device reopen at a time (commands run in parallel).
    pub(crate) reopening: Mutex<()>,
    /// sfizz, loaded on first use from `sfizz_library`.
    sfizz: Mutex<Option<Arc<tabstudio_audio::sfz::SfizzApi>>>,
    sfizz_library: Mutex<Option<PathBuf>>,
    /// The compiled NAM engine; prepared in the background when the device opens.
    nam_runtime: Arc<Mutex<Option<Arc<NamRuntime>>>>,
    nam_cache: Mutex<Option<PathBuf>>,
    sampler_build: Mutex<()>,
    /// MIDI reloads and bank replacement must build with the same current bank.
    song_build: Mutex<()>,
    /// Shared-memory links to effect hosts, by instance id.
    links: Mutex<std::collections::HashMap<String, Arc<tabstudio_fxlink::Shared>>>,
    pub(crate) linker: Mutex<Option<Linker>>,
    pub(crate) link_counter: AtomicU64,
    /// Incremented per subscription so an older status thread stops.
    subscription: Arc<AtomicU64>,
}

/// SF3 -> SF2 once, cached next to the user data keyed by the source size.
pub fn cached_soundfont(source: &[u8], cache_dir: &Path) -> Result<Vec<u8>, String> {
    if !sf3::is_sf3(source) {
        return Ok(source.to_vec());
    }
    let cache = cache_dir.join(format!("GeneralUser-Classical-{}.sf2", source.len()));
    if let Ok(bytes) = std::fs::read(&cache) {
        return Ok(bytes);
    }
    let converted = sf3::to_sf2(source).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&cache, &converted).map_err(|e| e.to_string())?;
    Ok(converted)
}

/// What the WebView sends to `audio_command`.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    Play,
    Pause,
    /// Song seconds at speed 1.
    Seek { seconds: f64 },
    /// Seek to a MIDI tick (alphaTab's tickPosition), converted with the song's tempo map.
    SeekTick { tick: u32 },
    Speed { value: f64 },
    Loop { start: Option<f64>, end: Option<f64> },
    /// Loop range in MIDI ticks (alphaTab's playbackRange), converted with the song's tempo map.
    LoopTicks { start: Option<u32>, end: Option<u32> },
    Track { index: usize, gain: f32, pan: f32, mute: bool, solo: bool, #[serde(default)] send: f32 },
    /// A track's insert effects in order: kind "eq" | "compressor" | "delay", amount 0..1.
    TrackFx { index: usize, fx: Vec<FxSpec> },
    /// The music bus gain (1/sqrt(audible tracks)) and the master reverb switch.
    Bus { gain: f32, reverb: bool },
    Master { gain: f32 },
    Metronome { enabled: bool, sound: u8, volume: f32 },
    /// Clicks at (seconds from now, accent); the song starts after `duration` seconds.
    CountIn { ticks: Vec<(f64, bool)>, duration: f64 },
    /// The track plays this SFZ file (None: the GM synth). Handled by the service.
    /// With `deferred` the file is only recorded; the next song load builds it.
    TrackSound { index: usize, sfz: Option<String>, #[serde(default)] deferred: bool },
    /// The NAM knobs (dB, dB, dB x3, cabinet filter on/off).
    TrackNamTone { index: usize, input: f32, output: f32, bass: f32, mid: f32, treble: f32, cabinet: bool },
    /// The backing track's strip and alignment (offset: seconds of the file at the song start;
    /// rate: fine tempo trim of the file against the song).
    /// linked: plays with the song; otherwise on its own transport at `speed`.
    Backing { gain: f32, mute: bool, solo: bool, offset: f64, semitones: f32, #[serde(default = "unity")] rate: f64, #[serde(default = "on")] normalize: bool, #[serde(default = "on")] linked: bool, #[serde(default = "unity")] speed: f64 },
    /// The backing file's own transport.
    BackingPlay,
    BackingPause,
    BackingSeek { seconds: f64 },
}

fn unity() -> f64 {
    1.0
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct FxSpec {
    pub kind: String,
    #[serde(default)]
    pub amount: f32,
    /// kind "external": the loaded effect (fx_load's id) and whether it is on.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default = "on")]
    pub enabled: bool,
}

fn on() -> bool {
    true
}

/// Tells an effect host to open a link (instance id, link name).
/// Answers the host's reply ({linked, latency}).
pub type Linker = Box<dyn Fn(&str, &str) -> Result<Value, String> + Send + Sync>;

/// How far before a tick seek still starts its notes (MIDI ticks; 960 per quarter, so about a
/// millisecond at 300 bpm).
const SEEK_SLACK_TICKS: u32 = 4;

pub fn to_command(request: Request, sample_rate: u32, song: Option<&Song>) -> Result<Command, String> {
    let finite = |v: f64| if v.is_finite() { Ok(v) } else { Err("値が不正です。".to_string()) };
    Ok(match request {
        Request::Play => Command::Play,
        Request::Pause => Command::Pause,
        Request::Seek { seconds } => Command::Seek(finite(seconds)?.max(0.0)),
        // Before the first song arrives there is nothing to seek in; the load starts at 0.
        // alphaTab's positions run a tick or two past the note they stand on (a freshly opened
        // song's cursor is at tick 2): notes up to SEEK_SLACK_TICKS before the target play.
        Request::SeekTick { tick } => Command::Seek(song.map_or(0.0, |song| song.tick_to_time(tick.saturating_sub(SEEK_SLACK_TICKS)))),
        Request::Speed { value } => Command::Speed(finite(value)?),
        Request::Loop { start: Some(start), end: Some(end) } => Command::Loop(Some((finite(start)?, finite(end)?))),
        Request::Loop { .. } => Command::Loop(None),
        Request::LoopTicks { start: Some(start), end: Some(end) } => {
            let song = song.ok_or("曲が読み込まれていません。")?;
            Command::Loop(Some((song.tick_to_time(start), song.tick_to_time(end))))
        }
        Request::LoopTicks { .. } => Command::Loop(None),
        Request::Track { index, gain, pan, mute, solo, send } => Command::Track(index, TrackMix { gain: gain.max(0.0), pan: pan.clamp(-1.0, 1.0), mute, solo, send: send.clamp(0.0, 1.0) }),
        Request::TrackFx { .. } => return Err("TrackFx is handled by the audio service".into()),
        Request::Bus { gain, reverb } => Command::Bus { gain, reverb },
        Request::Master { gain } => Command::Master(gain.max(0.0)),
        Request::Metronome { enabled, sound, volume } => Command::Metronome(Metronome { enabled, kind: sound.min(4), volume: volume.clamp(0.0, 2.0) }),
        Request::TrackSound { .. } => return Err("TrackSound is handled by the audio service".into()),
        Request::TrackNamTone { index, input, output, bass, mid, treble, cabinet } => {
            let db = |v: f32| if v.is_finite() { Ok(v.clamp(-60.0, 40.0)) } else { Err("値が不正です。".to_string()) };
            Command::TrackNamTone(index, NamTone { input: db(input)?, output: db(output)?, bass: db(bass)?, mid: db(mid)?, treble: db(treble)?, cabinet })
        }
        Request::Backing { gain, mute, solo, offset, semitones, rate, normalize, linked, speed } => {
            if !(gain.is_finite() && offset.is_finite() && semitones.is_finite() && rate.is_finite() && speed.is_finite()) {
                return Err("値が不正です。".into());
            }
            Command::BackingMix(BackingMix { gain: gain.clamp(0.0, 4.0), mute, solo, offset: offset.clamp(-3600.0, 3600.0), semitones: semitones.clamp(-12.0, 12.0), rate: rate.clamp(0.8, 1.25), normalize, linked, speed: speed.clamp(0.25, 2.0) })
        }
        Request::BackingPlay => Command::BackingTransport(BackingTransport::Play),
        Request::BackingPause => Command::BackingTransport(BackingTransport::Pause),
        Request::BackingSeek { seconds } => Command::BackingTransport(BackingTransport::Seek(finite(seconds)?.max(0.0))),
        Request::CountIn { ticks, duration } => {
            if ticks.len() > tabstudio_audio::player::MAX_COUNT_TICKS || !duration.is_finite() || ticks.iter().any(|t| !t.0.is_finite()) {
                return Err("カウントの指定が不正です。".into());
            }
            Command::CountIn(CountIn::new(&ticks, duration, sample_rate))
        }
    })
}

/// A track's insert chain from the mixer's list; `link` gives an external effect's link.
pub fn build_chain(fx: &[FxSpec], rate: u32, mut link: impl FnMut(&str) -> Result<Arc<tabstudio_fxlink::Shared>, String>) -> Result<tabstudio_audio::fx::FxChain, String> {
    use tabstudio_audio::fx::{ChainItem, FxChain, FxKind};
    if fx.len() > 16 {
        return Err("エフェクトが多すぎます。".into());
    }
    let mut items = Vec::with_capacity(fx.len());
    for f in fx {
        let amount = f.amount.clamp(0.0, 1.0);
        items.push(match f.kind.as_str() {
            "eq" => ChainItem::Builtin(FxKind::Eq, amount),
            "compressor" => ChainItem::Builtin(FxKind::Compressor, amount),
            "delay" => ChainItem::Builtin(FxKind::Delay, amount),
            "external" => ChainItem::External(link(f.id.as_deref().ok_or("外部FXが読み込まれていません。")?)?, f.enabled),
            other => return Err(format!("未対応のエフェクトです：{other}")),
        });
    }
    Ok(FxChain::build(items, rate as f64))
}

/// Automated checks (TAB_STUDIO_TEST_DATA + TAB_STUDIO_TEST_MUTE) keep the speakers silent;
/// meters and positions still work because muting is applied at the master only.
fn test_muted() -> bool {
    std::env::var_os("TAB_STUDIO_TEST_DATA").is_some() && std::env::var_os("TAB_STUDIO_TEST_MUTE").is_some()
}

/// SFZ instruments the engine let go of (a track changed its sound, or a document playing
/// other sounds became active), newest last: building one takes seconds, so switching back to a
/// document or a DI reuses them (`update_samplers`). At most SAMPLER_CACHE_SIZE are kept: a
/// Guitar DI instrument for a whole song holds a few hundred MB (two cover switching between a
/// song with two NAM guitars and one without).
static SAMPLER_CACHE: Mutex<Vec<Box<SfzInstrument>>> = Mutex::new(Vec::new());
const SAMPLER_CACHE_SIZE: usize = 2;

/// Keeps `instrument` for reuse; returns what no longer fits (to be dropped off the lock).
fn keep_sampler(instrument: Box<SfzInstrument>) -> Vec<Box<dyn std::any::Any + Send>> {
    let mut cache = SAMPLER_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.push(instrument);
    let over = cache.len().saturating_sub(SAMPLER_CACHE_SIZE);
    cache.drain(..over).map(|i| i as Box<dyn std::any::Any + Send>).collect()
}

/// A kept instrument for `file` at `rate` covering `needed` pitches and `switches`.
fn reuse_sampler(file: &Path, rate: u32, needed: &BTreeMap<u8, BTreeSet<u8>>, switches: &BTreeMap<u8, BTreeSet<u8>>) -> Option<Box<SfzInstrument>> {
    let covers = |need: &BTreeMap<u8, BTreeSet<u8>>, got: &BTreeMap<u8, BTreeSet<u8>>| need.iter().all(|(l, k)| got.get(l).is_some_and(|h| k.is_subset(h)));
    let mut cache = SAMPLER_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let found = cache.iter().rposition(|i| i.file == file && i.sample_rate == rate && covers(needed, &i.pitches) && i.switches.as_ref().is_none_or(|have| covers(switches, have)))?;
    let mut instrument = cache.remove(found);
    drop(cache);
    instrument.all_sound_off();
    Some(instrument)
}

/// Decoded backing files, newest last (switching documents back and forth reuses them):
/// (path, size, modified, rate, audio).
type BackingEntry = (PathBuf, u64, Option<std::time::SystemTime>, u32, Arc<BackingAudio>);
static BACKING_CACHE: Mutex<Vec<BackingEntry>> = Mutex::new(Vec::new());
const BACKING_CACHE_SIZE: usize = 2;

/// Where a backing file is: its saved path, else a file of that name next to the document
/// (a project folder that was moved or copied with its audio).
pub fn find_backing(path: &Path, document: Option<&Path>) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    let name = path.file_name()?;
    let near = document?.parent()?.join(name);
    near.is_file().then_some(near)
}

/// Sends a command to the audio thread. Callers hold the engine lock: what the audio thread
/// let go of (a replaced SFZ instrument takes seconds to free) is dropped on its own thread,
/// so playback, status and other commands do not wait behind it.
pub(crate) fn send(control: &mut Control, mut command: Command) -> Result<(), String> {
    for _ in 0..200 {
        match control.send(command) {
            Ok(()) => {
                let mut garbage = Vec::new();
                for old in control.take_garbage() {
                    match old.downcast::<SfzInstrument>() {
                        Ok(instrument) => garbage.extend(keep_sampler(instrument)),
                        Err(other) => garbage.push(other),
                    }
                }
                if !garbage.is_empty() {
                    let _ = std::thread::Builder::new().name("tabstudio-audio-free".into()).spawn(move || drop(garbage));
                }
                return Ok(());
            }
            Err(back) => {
                command = back;
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
    Err("音声エンジンが応答しません。".into())
}

impl AudioService {
    /// Opens the device and loads the sound font on first use. Returns (rate, device).
    pub fn start(&self, soundfont: impl FnOnce() -> Result<Vec<u8>, String>) -> Result<(u32, String), String> {
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = running.as_ref() {
            return Ok((r.sample_rate, r.device.clone()));
        }
        let bytes = soundfont()?;
        let font = Arc::new(SoundFont::new(&mut bytes.as_slice()).map_err(|e| e.to_string())?);
        drop(bytes);
        // The output device chosen for the instrument input (ASIO etc.) plays everything.
        let spec = self.live.lock().unwrap_or_else(|e| e.into_inner()).output_spec();
        let (control, device_state, requests) = crate::live_input::spawn_device(spec)?;
        let opened = device_state.opened();
        let (sample_rate, device) = (opened.sample_rate, opened.output_name.clone());
        let status = control.status.clone();
        let clicks = Arc::new(ClickBank::new(sample_rate));
        let mut control = control;
        if test_muted() {
            send(&mut control, Command::Master(0.0))?;
        }
        *running = Some(Running { control, status, sample_rate, device: device.clone(), font, clicks, tracks: 0, song: None, sounds: Vec::new(), built: Vec::new(), nam: Vec::new(), externals: vec![0; tabstudio_audio::engine::MAX_TRACKS], requests, device_state });
        drop(running);
        self.prepare_nam();
        Ok((sample_rate, device))
    }

    /// Replace the GM bank for both playback and previews. Parse first so a rejected
    /// bank leaves the working font and song intact; Load preserves transport/SFZ/FX.
    pub fn soundfont(&self, source: &[u8]) -> Result<(), String> {
        if source.len() > 200 * 1024 * 1024 {
            return Err("音源は200MB以下を選んでください。".into());
        }
        let bytes = if sf3::is_sf3(source) {
            sf3::to_sf2(source).map_err(|e| e.to_string())?
        } else {
            source.to_vec()
        };
        let font = Arc::new(SoundFont::new(&mut bytes.as_slice()).map_err(|e| e.to_string())?);
        let _building = self.song_build.lock().unwrap_or_else(|e| e.into_inner());
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        let player = r.song.as_ref().map(|song| Player::new(song.clone(), &font, r.clicks.clone(), r.sample_rate)).transpose()?;
        send(&mut r.control, Command::StopPreview)?;
        if let Some(player) = player {
            send(&mut r.control, Command::Load(Loaded::new(player)))?;
        }
        r.font = font;
        Ok(())
    }

    /// Loads a song (binary event list); the transport carries over across reloads.
    pub fn load(&self, events: &[u8]) -> Result<Value, String> {
        let _building = self.song_build.lock().unwrap_or_else(|e| e.into_inner());
        let song = Arc::new(Song::parse(events).map_err(|e| e.0.to_string())?);
        let (font, clicks, rate) = {
            let running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let r = running.as_ref().ok_or("音声エンジンが起動していません。")?;
            (r.font.clone(), r.clicks.clone(), r.sample_rate)
        };
        // Building synthesizers allocates; do it here, not under the lock or on the audio thread.
        let player = Player::new(song.clone(), &font, clicks, rate)?;
        let tracks = player.tracks();
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        r.tracks = tracks;
        r.song = Some(song.clone());
        send(&mut r.control, Command::Load(Loaded::new(player)))?;
        drop(running);
        self.update_samplers()?;
        Ok(json!({"tracks": tracks, "endTime": song.end_time}))
    }

    /// How to reach effect hosts (set by the app: sends them the `link` command).
    pub fn set_linker(&self, linker: Linker) {
        *self.linker.lock().unwrap_or_else(|e| e.into_inner()) = Some(linker);
    }

    /// Forgets an effect's link (its host was closed).
    pub fn unlink(&self, id: &str) {
        self.links.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    /// The shared-memory link for an effect host, made (and announced to it) on first use.
    fn link(&self, id: &str, rate: u32) -> Result<Arc<tabstudio_fxlink::Shared>, String> {
        if let Some(shared) = self.links.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            return Ok(shared.clone());
        }
        let name = format!("{}-{}-{}", std::process::id(), id, self.link_counter.fetch_add(1, Ordering::Relaxed));
        let shared = Arc::new(tabstudio_fxlink::Shared::create(&name, rate as f64)?);
        {
            let linker = self.linker.lock().unwrap_or_else(|e| e.into_inner());
            let linker = linker.as_ref().ok_or("外部FXホストに接続できません。")?;
            linker(id, &name)?;
        }
        self.links.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), shared.clone());
        Ok(shared)
    }

    /// A track's insert chain, external effects included; keeps every track lined up
    /// behind the external effects' delay.
    fn set_track_fx(&self, index: usize, fx: Vec<FxSpec>) -> Result<(), String> {
        if index >= tabstudio_audio::engine::MAX_TRACKS {
            return Err("トラック番号が不正です。".into());
        }
        let rate = self.running.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| r.sample_rate).ok_or("音声エンジンが起動していません。")?;
        let chain = build_chain(&fx, rate, |id| self.link(id, rate))?;
        let count = chain.externals();
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        send(&mut r.control, Command::TrackFx(index, Box::new(chain)))?;
        if r.externals[index] != count {
            r.externals[index] = count;
            let compensation = tabstudio_audio::engine::Compensation::new(&r.externals, tabstudio_fxlink::LATENCY);
            send(&mut r.control, Command::Compensation(Box::new(compensation)))?;
        }
        Ok(())
    }

    /// Where the compiled NAM engine is cached between runs.
    pub fn set_nam_cache(&self, dir: PathBuf) {
        *self.nam_cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
    }

    /// Compiles the NAM engine off the calling thread (about a second the first time).
    fn prepare_nam(&self) {
        let (slot, cache) = (self.nam_runtime.clone(), self.nam_cache.lock().unwrap_or_else(|e| e.into_inner()).clone());
        let _ = std::thread::Builder::new().name("tabstudio-nam-compile".into()).spawn(move || {
            let mut runtime = slot.lock().unwrap_or_else(|e| e.into_inner());
            if runtime.is_none() {
                *runtime = NamRuntime::new(cache.as_deref()).ok();
            }
        });
    }

    pub(crate) fn nam_runtime(&self) -> Result<Arc<NamRuntime>, String> {
        let mut runtime = self.nam_runtime.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = runtime.as_ref() {
            return Ok(r.clone());
        }
        let cache = self.nam_cache.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let built = NamRuntime::new(cache.as_deref())?;
        *runtime = Some(built.clone());
        Ok(built)
    }

    /// Gives a track a NAM amp running `json` (the model named `key`), or removes it (key None).
    /// Returns whether a model was loaded; the same key again keeps the running amp.
    pub fn set_track_nam(&self, index: usize, key: Option<String>, json: Option<&str>) -> Result<bool, String> {
        if index >= tabstudio_audio::engine::MAX_TRACKS {
            return Err("トラック番号が不正です。".into());
        }
        let rate = {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
            if r.nam.len() <= index {
                r.nam.resize(index + 1, None);
            }
            if r.nam[index] == key {
                return Ok(false);
            }
            if key.is_none() {
                r.nam[index] = None;
                send(&mut r.control, Command::TrackNam(index, None))?;
                return Ok(false);
            }
            r.sample_rate
        };
        let json = json.ok_or("NAMモデルのデータがありません。")?;
        // Instantiating and loading takes tens of milliseconds: outside the lock.
        let amp = NamAmp::new(&*self.nam_runtime()?, json, rate as f64)?;
        let stage = Box::new(NamStage::new(amp, NamTone::default(), rate as f64));
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        if r.nam.len() <= index {
            r.nam.resize(index + 1, None);
        }
        r.nam[index] = key;
        send(&mut r.control, Command::TrackNam(index, Some(stage)))?;
        Ok(true)
    }

    /// Where sfizz is (native/runtime); loaded the first time an SFZ track needs it.
    pub fn set_sfizz_library(&self, path: PathBuf) {
        *self.sfizz_library.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    }

    fn sfizz(&self) -> Result<Arc<tabstudio_audio::sfz::SfizzApi>, String> {
        let mut api = self.sfizz.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(api) = api.as_ref() {
            return Ok(api.clone());
        }
        let path = self.sfizz_library.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("SFZ音源の再生部品（sfizz）が見つかりません。")?;
        let loaded = tabstudio_audio::sfz::SfizzApi::load(&path)?;
        *api = Some(loaded.clone());
        Ok(loaded)
    }

    /// Sets a track's SFZ file and (re)builds what the current song needs.
    pub fn set_track_sound(&self, index: usize, sfz: Option<String>, deferred: bool) -> Result<(), String> {
        {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
            if r.sounds.len() <= index {
                r.sounds.resize(index + 1, None);
            }
            let next = sfz.map(PathBuf::from);
            if r.sounds[index] == next {
                return Ok(());
            }
            r.sounds[index] = next;
        }
        if deferred {
            return Ok(());
        }
        self.update_samplers()
    }

    /// Gives every SFZ track an instrument covering the song's lanes and pitches. Building
    /// one takes seconds (sample loading), so it happens here, outside the lock and off the
    /// audio thread, and only when the loaded one does not already cover what is needed.
    fn update_samplers(&self) -> Result<(), String> {
        // One build at a time: a second caller then finds the instrument already built
        // instead of loading the same samples again in parallel.
        let _building = self.sampler_build.lock().unwrap_or_else(|e| e.into_inner());
        let (song, sounds, built, rate) = {
            let running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let Some(r) = running.as_ref() else { return Ok(()) };
            let Some(song) = r.song.clone() else { return Ok(()) };
            (song, r.sounds.clone(), r.built.clone(), r.sample_rate)
        };
        let mut changes: Vec<(usize, Option<Box<tabstudio_audio::sfz::SfzInstrument>>, Option<Built>)> = Vec::new();
        let mut builds: Vec<(usize, PathBuf, BTreeMap<u8, BTreeSet<u8>>, BTreeMap<u8, BTreeSet<u8>>)> = Vec::new();
        for index in 0..song.tracks.max(sounds.len()).max(built.len()) {
            let want = sounds.get(index).cloned().flatten().filter(|_| index < song.tracks);
            let have = built.get(index).cloned().flatten();
            match want {
                None => {
                    if have.is_some() {
                        changes.push((index, None, None));
                    }
                }
                Some(file) => {
                    let standard = tabstudio_audio::sfz::is_standard_guitar(&file);
                    let strings = tabstudio_audio::sfz::is_string_guitar(&file);
                    // Notes without a string go to the first lane, as sfz-host.py does.
                    let mut needed: BTreeMap<u8, BTreeSet<u8>> = BTreeMap::new();
                    for (lane, keys) in song.sfz_pitches(index as u16) {
                        let lane = if strings { lane.clamp(1, 12) } else { 0 };
                        needed.entry(lane).or_default().extend(keys);
                    }
                    let mut switches: BTreeMap<u8, BTreeSet<u8>> = BTreeMap::new();
                    if standard {
                        for (lane, keys) in song.sfz_switches(index as u16) {
                            switches.entry(lane.clamp(1, 12)).or_default().extend(keys);
                        }
                    } else if tabstudio_audio::sfz::is_bass_di(&file) {
                        // The Bass DI adds its articulation lane once the song has palm mutes, dead
                        // notes or slaps (see with_switches; 23 stands for all of them).
                        if song.sfz_bass_di_articulations(index as u16) {
                            switches.entry(0).or_default().insert(23);
                        }
                    }
                    if let Some(have) = &have {
                        let subset = |need: &BTreeMap<u8, BTreeSet<u8>>, got: &BTreeMap<u8, BTreeSet<u8>>| need.iter().all(|(l, k)| got.get(l).is_some_and(|h| k.is_subset(h)));
                        if have.file == file && subset(&needed, &have.pitches) && subset(&switches, &have.switches) {
                            continue;
                        }
                        // Grow from what is loaded so edits do not shrink and reload repeatedly.
                        if have.file == file {
                            for (lane, keys) in &have.pitches {
                                needed.entry(*lane).or_default().extend(keys.iter().copied());
                            }
                            for (lane, keys) in &have.switches {
                                switches.entry(*lane).or_default().extend(keys.iter().copied());
                            }
                        }
                    }
                    if let Some(instrument) = reuse_sampler(&file, rate, &needed, &switches) {
                        let info = Built { file, pitches: instrument.pitches.clone(), switches: instrument.switches.clone().unwrap_or(switches) };
                        changes.push((index, Some(instrument), Some(info)));
                        continue;
                    }
                    builds.push((index, file, needed, switches));
                }
            }
        }
        // Tracks load in parallel, like the Electron build's one host process per track.
        if !builds.is_empty() {
            let api = self.sfizz()?;
            let built: Vec<Result<_, String>> = std::thread::scope(|scope| {
                let handles: Vec<_> = builds
                    .into_iter()
                    .map(|(index, file, needed, switches)| {
                        let api = api.clone();
                        scope.spawn(move || {
                            let instrument = tabstudio_audio::sfz::SfzInstrument::with_switches(api, &file, &needed, Some(&switches), rate)?;
                            Ok((index, Box::new(instrument), Built { file, pitches: needed, switches }))
                        })
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("SFZ音源の読み込みに失敗しました。".into()))).collect()
            });
            for result in built {
                let (index, instrument, info) = result?;
                changes.push((index, Some(instrument), Some(info)));
            }
        }
        if changes.is_empty() {
            return Ok(());
        }
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        for (index, instrument, info) in changes {
            if r.built.len() <= index {
                r.built.resize(index + 1, None);
            }
            r.built[index] = info;
            send(&mut r.control, Command::TrackSampler(index, instrument))?;
        }
        Ok(())
    }

    /// Renders a note/phrase preview offline and plays it through `track`'s mix.
    /// Returns what the WebView preview reported: frames and peak.
    pub fn preview(&self, events: &[u8], track: usize) -> Result<Value, String> {
        let song = Arc::new(Song::parse(events).map_err(|e| e.0.to_string())?);
        let (font, clicks, rate) = {
            let running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let r = running.as_ref().ok_or("音声エンジンが起動していません。")?;
            (r.font.clone(), r.clicks.clone(), r.sample_rate)
        };
        let player = Player::new(song, &font, clicks, rate)?;
        let (left, right) = render_offline(player, rate, 20.0);
        let peak = left.iter().chain(&right).fold(0f32, |m, v| m.max(v.abs()));
        let frames = left.len();
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        if frames > 0 {
            send(&mut r.control, Command::Preview(Preview::new(left, right, track)))?;
        }
        Ok(json!({"frames": frames, "peak": peak, "played": frames > 0}))
    }

    /// Decodes a backing file (or reuses a decoded one) and gives it to the engine.
    /// Takes seconds for a long file: call off the async runtime.
    pub fn backing_load(&self, path: &Path, document: Option<&Path>) -> Result<Value, String> {
        let rate = self.running.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| r.sample_rate).ok_or("音声エンジンが起動していません。")?;
        let found = find_backing(path, document).ok_or_else(|| format!("音声ファイルが見つかりません：{}", path.display()))?;
        let meta = std::fs::metadata(&found).map_err(|e| e.to_string())?;
        let (size, modified) = (meta.len(), meta.modified().ok());
        let cached = {
            let cache = BACKING_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            cache.iter().rev().find(|e| e.0 == found && e.1 == size && e.2 == modified && e.3 == rate).map(|e| e.4.clone())
        };
        let audio = match cached {
            Some(audio) => audio,
            None => {
                let audio = Arc::new(tabstudio_audio::backing::decode_file(&found, rate)?);
                let mut cache = BACKING_CACHE.lock().unwrap_or_else(|e| e.into_inner());
                cache.retain(|e| e.0 != found);
                cache.push((found.clone(), size, modified, rate, audio.clone()));
                let over = cache.len().saturating_sub(BACKING_CACHE_SIZE);
                let dropped: Vec<_> = cache.drain(..over).collect();
                drop(cache);
                drop(dropped);
                audio
            }
        };
        // The stretcher and buffers are built here, not on the audio thread.
        let backing = Backing::new(audio.clone(), BackingMix::default());
        {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
            send(&mut r.control, Command::Backing(Some(backing)))?;
        }
        Ok(json!({
            "path": found.to_string_lossy(),
            "name": found.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            "seconds": audio.seconds(),
            "sourceRate": audio.source_rate,
            "channels": audio.source_channels,
            "codec": audio.codec,
            "lufs": audio.lufs,
            "trimDb": audio.trim_db(),
            "peaksPerSecond": tabstudio_audio::backing::PEAKS_PER_SECOND,
            "peaks": audio.peaks,
        }))
    }

    pub fn backing_clear(&self) -> Result<(), String> {
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        match running.as_mut() {
            Some(r) => send(&mut r.control, Command::Backing(None)),
            None => Ok(()),
        }
    }

    pub fn stop_preview(&self) -> Result<(), String> {
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        match running.as_mut() {
            Some(r) => send(&mut r.control, Command::StopPreview),
            None => Ok(()),
        }
    }

    pub fn command(&self, request: Request) -> Result<(), String> {
        if let Request::TrackSound { index, sfz, deferred } = request {
            return self.set_track_sound(index, sfz, deferred);
        }
        if let Request::TrackFx { index, fx } = request {
            return self.set_track_fx(index, fx);
        }
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_mut().ok_or("音声エンジンが起動していません。")?;
        let mut command = to_command(request, r.sample_rate, r.song.as_deref())?;
        if test_muted() {
            if let Command::Master(_) = command {
                command = Command::Master(0.0);
            }
        }
        send(&mut r.control, command)
    }

    pub fn status(&self) -> Option<Value> {
        let running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let r = running.as_ref()?;
        let mut value = snapshot(&r.status, r.tracks);
        // Frames external effects delivered too late (played as silence); 0 when they keep up.
        let late: u64 = self.links.lock().unwrap_or_else(|e| e.into_inner()).values().map(|l| l.header().late.load(Ordering::Relaxed)).sum();
        value["fxLate"] = json!(late);
        let opened = r.device_state.opened();
        let c = &opened.stats;
        value["callbacks"] = json!({
            "count": c.callbacks.load(Ordering::Relaxed),
            "overloads": c.overloads.load(Ordering::Relaxed),
            "maxMicros": c.max_micros.load(Ordering::Relaxed),
            "meanMicros": c.total_micros.load(Ordering::Relaxed) / c.callbacks.load(Ordering::Relaxed).max(1),
            "frames": c.last_frames.load(Ordering::Relaxed),
        });
        Some(value)
    }

    /// Pushes status snapshots until another subscription replaces this one or the engine stops.
    pub fn subscribe(self: &Arc<Self>, sink: impl Fn(Value) -> bool + Send + 'static) {
        let generation = self.subscription.fetch_add(1, Ordering::AcqRel) + 1;
        let service = self.clone();
        std::thread::spawn(move || {
            while service.subscription.load(Ordering::Acquire) == generation {
                let Some(value) = service.status() else { break };
                if !sink(value) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(16));
            }
        });
    }

    pub fn stop(&self) {
        self.subscription.fetch_add(1, Ordering::AcqRel);
        self.live_shutdown();
        if let Some(r) = self.running.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = r.requests.send(crate::live_input::DeviceRequest::Stop);
        }
    }
}

fn snapshot(status: &Status, tracks: usize) -> Value {
    let peaks: Vec<f32> = (0..tracks).map(|i| status.take_track_peak(i)).collect();
    json!({
        "position": status.position(),
        "playing": status.playing(),
        "counting": status.counting(),
        "finished": status.finished(),
        "wraps": status.wraps(),
        "frames": status.frames(),
        "peaks": peaks,
        "clickPeak": status.take_click_peak(),
        "backingPeak": status.take_backing_peak(),
        "backingPosition": status.backing_position(),
        "backingPlaying": status.backing_playing(),
        "master": status.take_master_peak(),
    })
}

/// The bundled GM bank: from the app's embedded assets, else the source tree (dev builds).
pub fn soundfont_bytes(asset: Option<Vec<u8>>, cache_dir: &Path) -> Result<Vec<u8>, String> {
    let source = match asset {
        Some(bytes) => bytes,
        None => std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public").join(SOUNDFONT)).map_err(|e| e.to_string())?,
    };
    cached_soundfont(&source, cache_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chains_are_built_with_external_links() {
        let specs = |v: Value| serde_json::from_value::<Vec<FxSpec>>(v).unwrap();
        let none = |_: &str| -> Result<Arc<tabstudio_fxlink::Shared>, String> { Err("no host".into()) };
        let chain = build_chain(&specs(json!([{"kind": "eq", "amount": 0.7}, {"kind": "delay", "amount": 0.2}])), 48000, none).unwrap();
        assert_eq!(chain.externals(), 0);
        assert!(build_chain(&specs(json!([{"kind": "external", "amount": 1.0}])), 48000, none).is_err(), "an external FX needs its host id");
        assert!(build_chain(&specs(json!([{"kind": "reverb"}])), 48000, none).is_err());
        assert!(build_chain(&specs(json!((0..17).map(|_| json!({"kind": "eq"})).collect::<Vec<_>>())), 48000, none).is_err());
        let mut asked = Vec::new();
        let chain = build_chain(&specs(json!([{"kind": "external", "id": "7", "enabled": false}, {"kind": "eq", "amount": 0.5}])), 48000, |id| {
            asked.push(id.to_string());
            Ok(Arc::new(tabstudio_fxlink::Shared::create(&format!("chain-test-{}", std::process::id()), 48000.0)?))
        })
        .unwrap();
        assert_eq!(chain.externals(), 1);
        assert_eq!(asked, ["7"]);
    }

    #[test]
    fn requests_become_engine_commands() {
        let parse = |v: Value| to_command(serde_json::from_value(v).unwrap(), 48000, None);
        assert!(matches!(parse(json!({"kind": "play"})).unwrap(), Command::Play));
        assert!(matches!(parse(json!({"kind": "seek", "seconds": -2.0})).unwrap(), Command::Seek(s) if s == 0.0));
        assert!(matches!(parse(json!({"kind": "loop", "start": 1.0, "end": 2.0})).unwrap(), Command::Loop(Some((a, b))) if a == 1.0 && b == 2.0));
        assert!(matches!(parse(json!({"kind": "loop", "start": null, "end": null})).unwrap(), Command::Loop(None)));
        assert!(matches!(parse(json!({"kind": "track", "index": 2, "gain": 0.5, "pan": 3.0, "mute": false, "solo": true})).unwrap(), Command::Track(2, m) if m.pan == 1.0 && m.solo && m.send == 0.0));
        assert!(matches!(parse(json!({"kind": "track", "index": 0, "gain": 1.0, "pan": 0.0, "mute": false, "solo": false, "send": 0.25})).unwrap(), Command::Track(0, m) if m.send == 0.25));
        assert!(parse(json!({"kind": "trackFx", "index": 1, "fx": [{"kind": "eq", "amount": 0.7}]})).is_err(), "built by the service (build_chain)");
        assert!(matches!(parse(json!({"kind": "bus", "gain": 0.7, "reverb": false})).unwrap(), Command::Bus { reverb: false, .. }));
        assert!(matches!(parse(json!({"kind": "metronome", "enabled": true, "sound": 9, "volume": 0.6})).unwrap(), Command::Metronome(m) if m.kind == 4));
        assert!(matches!(parse(json!({"kind": "backing", "gain": 0.8, "mute": false, "solo": true, "offset": 1.25, "semitones": -2.0})).unwrap(), Command::BackingMix(m) if m.solo && m.offset == 1.25 && m.semitones == -2.0 && m.rate == 1.0 && m.normalize && m.linked && m.speed == 1.0));
        assert!(matches!(parse(json!({"kind": "backing", "gain": 1.0, "mute": false, "solo": false, "offset": 0.0, "semitones": 0.0, "linked": false, "speed": 0.1})).unwrap(), Command::BackingMix(m) if !m.linked && m.speed == 0.25));
        assert!(matches!(parse(json!({"kind": "backingSeek", "seconds": -3.0})).unwrap(), Command::BackingTransport(BackingTransport::Seek(s)) if s == 0.0));
        assert!(matches!(parse(json!({"kind": "backingPlay"})).unwrap(), Command::BackingTransport(BackingTransport::Play)));
        assert!(matches!(parse(json!({"kind": "backing", "gain": 9.0, "mute": false, "solo": false, "offset": 0.0, "semitones": 30.0, "rate": 3.0, "normalize": false})).unwrap(), Command::BackingMix(m) if m.gain == 4.0 && m.semitones == 12.0 && m.rate == 1.25 && !m.normalize));
        match parse(json!({"kind": "countIn", "ticks": [[0.0, true], [0.5, false]], "duration": 1.0})).unwrap() {
            Command::CountIn(plan) => {
                assert_eq!(plan.len, 2);
                assert_eq!(plan.ticks[1], (24000, false));
                assert_eq!(plan.total, 48000);
            }
            _ => panic!("count-in"),
        }
        let too_many: Vec<(f64, bool)> = (0..40).map(|i| (i as f64, false)).collect();
        assert!(parse(json!({"kind": "countIn", "ticks": too_many, "duration": 1.0})).is_err());
        assert!(serde_json::from_value::<Request>(json!({"kind": "explode"})).is_err());
        assert!(parse(json!({"kind": "loopTicks", "start": 0, "end": 960})).is_err(), "needs a song");
        let song = Song::from_events(960, vec![]);
        let request: Request = serde_json::from_value(json!({"kind": "loopTicks", "start": 960, "end": 1920})).unwrap();
        // No tempo event: 120 bpm, so a quarter note is 0.5 s.
        assert!(matches!(to_command(request, 48000, Some(&song)).unwrap(), Command::Loop(Some((a, b))) if a == 0.5 && b == 1.0));
        let request: Request = serde_json::from_value(json!({"kind": "seekTick", "tick": 1920})).unwrap();
        assert!(matches!(to_command(request, 48000, Some(&song)).unwrap(), Command::Seek(s) if (s - (1920 - SEEK_SLACK_TICKS) as f64 / 1920.0).abs() < 1e-9));
        // The cursor of a freshly opened song (tick 2) starts at its first note.
        let request: Request = serde_json::from_value(json!({"kind": "seekTick", "tick": 2})).unwrap();
        assert!(matches!(to_command(request, 48000, Some(&song)).unwrap(), Command::Seek(s) if s == 0.0));
    }

    #[test]
    fn sf3_is_converted_once_and_cached() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/alphatab/soundfont/sonivox.sf3");
        let Ok(source) = std::fs::read(path) else { return };
        let dir = tempfile::tempdir().unwrap();
        let first = cached_soundfont(&source, dir.path()).unwrap();
        assert!(!sf3::is_sf3(&first));
        let cached = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(cached, 1);
        assert_eq!(cached_soundfont(&source, dir.path()).unwrap(), first);
        // SF2 passes through without a cache file.
        let sf2 = std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/alphatab/soundfont/sonivox.sf2")).unwrap();
        assert_eq!(cached_soundfont(&sf2, dir.path()).unwrap().len(), sf2.len());
    }

    #[test]
    fn backing_files_are_found_next_to_a_moved_document() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("take.wav");
        std::fs::write(&audio, b"x").unwrap();
        assert_eq!(find_backing(&audio, None), Some(audio.clone()));
        let gone = PathBuf::from("Z:/old/place/take.wav");
        assert_eq!(find_backing(&gone, Some(&dir.path().join("song.tg"))), Some(audio));
        assert_eq!(find_backing(&gone, None), None);
        assert!(AudioService::default().backing_load(&gone, None).is_err(), "needs a started engine");
    }

    #[test]
    fn commands_need_a_started_engine() {
        let service = AudioService::default();
        assert!(service.load(b"TSEV").is_err());
        assert!(service.command(Request::Play).is_err());
        assert!(service.status().is_none());
    }
}
