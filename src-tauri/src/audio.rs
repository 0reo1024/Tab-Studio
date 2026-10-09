//! The native audio engine (crates/tabstudio-audio) behind Tauri commands.
//! The device stream lives on its own thread (cpal streams are not Send everywhere);
//! commands go to the engine's lock-free queue and a status thread pushes the transport
//! position and meters to the WebView about 60 times a second.
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tabstudio_audio::click::{ClickBank, Metronome};
use tabstudio_audio::nam::{NamAmp, NamRuntime, NamStage, NamTone};
use tabstudio_audio::engine::{Command, Control, Loaded, Preview, Status, TrackMix, render_offline};
use tabstudio_audio::player::{CountIn, Player};
use tabstudio_audio::song::Song;
use tabstudio_audio::synth::SoundFont;
use tabstudio_audio::{output, sf3};

/// The GM bank alphaTab plays (public/alphatab/soundfont).
pub const SOUNDFONT: &str = "alphatab/soundfont/GeneralUser-Classical.sf3";

/// Which SFZ instrument a track has in the engine, and for which lanes/pitches.
#[derive(Clone)]
struct Built {
    file: PathBuf,
    pitches: BTreeMap<u8, BTreeSet<u8>>,
}

struct Running {
    control: Control,
    status: Arc<Status>,
    sample_rate: u32,
    device: String,
    font: Arc<SoundFont>,
    clicks: Arc<ClickBank>,
    tracks: usize,
    song: Option<Arc<Song>>,
    /// The SFZ file each track should play (None: GM synth).
    sounds: Vec<Option<PathBuf>>,
    built: Vec<Option<Built>>,
    /// Which NAM model (the front end's key) each track's amp runs.
    nam: Vec<Option<String>>,
    stop: Sender<()>,
}

#[derive(Default)]
pub struct AudioService {
    running: Mutex<Option<Running>>,
    /// sfizz, loaded on first use from `sfizz_library`.
    sfizz: Mutex<Option<Arc<tabstudio_audio::sfz::SfizzApi>>>,
    sfizz_library: Mutex<Option<PathBuf>>,
    /// The compiled NAM engine; prepared in the background when the device opens.
    nam_runtime: Arc<Mutex<Option<Arc<NamRuntime>>>>,
    nam_cache: Mutex<Option<PathBuf>>,
    sampler_build: Mutex<()>,
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
}

#[derive(Deserialize, Debug, PartialEq)]
pub struct FxSpec {
    pub kind: String,
    pub amount: f32,
}

pub fn to_command(request: Request, sample_rate: u32, song: Option<&Song>) -> Result<Command, String> {
    let finite = |v: f64| if v.is_finite() { Ok(v) } else { Err("値が不正です。".to_string()) };
    Ok(match request {
        Request::Play => Command::Play,
        Request::Pause => Command::Pause,
        Request::Seek { seconds } => Command::Seek(finite(seconds)?.max(0.0)),
        // Before the first song arrives there is nothing to seek in; the load starts at 0.
        Request::SeekTick { tick } => Command::Seek(song.map_or(0.0, |song| song.tick_to_time(tick))),
        Request::Speed { value } => Command::Speed(finite(value)?),
        Request::Loop { start: Some(start), end: Some(end) } => Command::Loop(Some((finite(start)?, finite(end)?))),
        Request::Loop { .. } => Command::Loop(None),
        Request::LoopTicks { start: Some(start), end: Some(end) } => {
            let song = song.ok_or("曲が読み込まれていません。")?;
            Command::Loop(Some((song.tick_to_time(start), song.tick_to_time(end))))
        }
        Request::LoopTicks { .. } => Command::Loop(None),
        Request::Track { index, gain, pan, mute, solo, send } => Command::Track(index, TrackMix { gain: gain.max(0.0), pan: pan.clamp(-1.0, 1.0), mute, solo, send: send.clamp(0.0, 1.0) }),
        Request::TrackFx { index, fx } => {
            use tabstudio_audio::fx::{FxChain, FxKind};
            if fx.len() > 16 {
                return Err("エフェクトが多すぎます。".into());
            }
            let specs = fx
                .iter()
                .map(|f| {
                    let kind = match f.kind.as_str() {
                        "eq" => FxKind::Eq,
                        "compressor" => FxKind::Compressor,
                        "delay" => FxKind::Delay,
                        other => return Err(format!("未対応のエフェクトです：{other}")),
                    };
                    Ok((kind, f.amount.clamp(0.0, 1.0)))
                })
                .collect::<Result<Vec<_>, String>>()?;
            Command::TrackFx(index, Box::new(FxChain::new(&specs, sample_rate as f64)))
        }
        Request::Bus { gain, reverb } => Command::Bus { gain, reverb },
        Request::Master { gain } => Command::Master(gain.max(0.0)),
        Request::Metronome { enabled, sound, volume } => Command::Metronome(Metronome { enabled, kind: sound.min(4), volume: volume.clamp(0.0, 2.0) }),
        Request::TrackSound { .. } => return Err("TrackSound is handled by the audio service".into()),
        Request::TrackNamTone { index, input, output, bass, mid, treble, cabinet } => {
            let db = |v: f32| if v.is_finite() { Ok(v.clamp(-60.0, 40.0)) } else { Err("値が不正です。".to_string()) };
            Command::TrackNamTone(index, NamTone { input: db(input)?, output: db(output)?, bass: db(bass)?, mid: db(mid)?, treble: db(treble)?, cabinet })
        }
        Request::CountIn { ticks, duration } => {
            if ticks.len() > tabstudio_audio::player::MAX_COUNT_TICKS || !duration.is_finite() || ticks.iter().any(|t| !t.0.is_finite()) {
                return Err("カウントの指定が不正です。".into());
            }
            Command::CountIn(CountIn::new(&ticks, duration, sample_rate))
        }
    })
}

/// Automated checks (TAB_STUDIO_TEST_DATA + TAB_STUDIO_TEST_MUTE) keep the speakers silent;
/// meters and positions still work because muting is applied at the master only.
fn test_muted() -> bool {
    std::env::var_os("TAB_STUDIO_TEST_DATA").is_some() && std::env::var_os("TAB_STUDIO_TEST_MUTE").is_some()
}

fn send(control: &mut Control, mut command: Command) -> Result<(), String> {
    for _ in 0..200 {
        match control.send(command) {
            Ok(()) => return Ok(()),
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
        let (ready_tx, ready_rx) = channel();
        let (stop_tx, stop_rx) = channel::<()>();
        std::thread::Builder::new()
            .name("tabstudio-audio-output".into())
            .spawn(move || match output::open_default(Some(512)) {
                Ok(out) => {
                    let (rate, device) = (out.sample_rate, out.device_name.clone());
                    // Hand the control side over and keep the stream alive until told to stop.
                    let (stream, control) = out.split();
                    let _ = ready_tx.send(Ok((control, rate, device)));
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            })
            .map_err(|e| e.to_string())?;
        let (control, sample_rate, device) = ready_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "音声デバイスを開けません。".to_string())??;
        let status = control.status.clone();
        let clicks = Arc::new(ClickBank::new(sample_rate));
        let mut control = control;
        if test_muted() {
            send(&mut control, Command::Master(0.0))?;
        }
        *running = Some(Running { control, status, sample_rate, device: device.clone(), font, clicks, tracks: 0, song: None, sounds: Vec::new(), built: Vec::new(), nam: Vec::new(), stop: stop_tx });
        drop(running);
        self.prepare_nam();
        Ok((sample_rate, device))
    }

    /// Loads a song (binary event list); the transport carries over across reloads.
    pub fn load(&self, events: &[u8]) -> Result<Value, String> {
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

    fn nam_runtime(&self) -> Result<Arc<NamRuntime>, String> {
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
        let mut builds: Vec<(usize, PathBuf, BTreeMap<u8, BTreeSet<u8>>)> = Vec::new();
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
                    // Notes without a string go to the first lane, as sfz-host.py does.
                    let mut needed: BTreeMap<u8, BTreeSet<u8>> = BTreeMap::new();
                    for (lane, keys) in song.sfz_pitches(index as u16) {
                        let lane = if standard { lane.clamp(1, 12) } else { 0 };
                        needed.entry(lane).or_default().extend(keys);
                    }
                    if let Some(have) = &have {
                        if have.file == file && needed.iter().all(|(l, k)| have.pitches.get(l).is_some_and(|h| k.is_subset(h))) {
                            continue;
                        }
                        // Grow from what is loaded so edits do not shrink and reload repeatedly.
                        if have.file == file {
                            for (lane, keys) in &have.pitches {
                                needed.entry(*lane).or_default().extend(keys.iter().copied());
                            }
                        }
                    }
                    builds.push((index, file, needed));
                }
            }
        }
        // Tracks load in parallel, like the Electron build's one host process per track.
        if !builds.is_empty() {
            let api = self.sfizz()?;
            let built: Vec<Result<_, String>> = std::thread::scope(|scope| {
                let handles: Vec<_> = builds
                    .into_iter()
                    .map(|(index, file, needed)| {
                        let api = api.clone();
                        scope.spawn(move || {
                            let instrument = tabstudio_audio::sfz::SfzInstrument::new(api, &file, &needed, rate)?;
                            Ok((index, Box::new(instrument), Built { file, pitches: needed }))
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
        Some(snapshot(&r.status, r.tracks))
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
        if let Some(r) = self.running.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = r.stop.send(());
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
    fn requests_become_engine_commands() {
        let parse = |v: Value| to_command(serde_json::from_value(v).unwrap(), 48000, None);
        assert!(matches!(parse(json!({"kind": "play"})).unwrap(), Command::Play));
        assert!(matches!(parse(json!({"kind": "seek", "seconds": -2.0})).unwrap(), Command::Seek(s) if s == 0.0));
        assert!(matches!(parse(json!({"kind": "loop", "start": 1.0, "end": 2.0})).unwrap(), Command::Loop(Some((a, b))) if a == 1.0 && b == 2.0));
        assert!(matches!(parse(json!({"kind": "loop", "start": null, "end": null})).unwrap(), Command::Loop(None)));
        assert!(matches!(parse(json!({"kind": "track", "index": 2, "gain": 0.5, "pan": 3.0, "mute": false, "solo": true})).unwrap(), Command::Track(2, m) if m.pan == 1.0 && m.solo && m.send == 0.0));
        assert!(matches!(parse(json!({"kind": "track", "index": 0, "gain": 1.0, "pan": 0.0, "mute": false, "solo": false, "send": 0.25})).unwrap(), Command::Track(0, m) if m.send == 0.25));
        assert!(matches!(parse(json!({"kind": "trackFx", "index": 1, "fx": [{"kind": "eq", "amount": 0.7}, {"kind": "delay", "amount": 0.2}]})).unwrap(), Command::TrackFx(1, _)));
        assert!(parse(json!({"kind": "trackFx", "index": 1, "fx": [{"kind": "external", "amount": 1.0}]})).is_err());
        assert!(matches!(parse(json!({"kind": "bus", "gain": 0.7, "reverb": false})).unwrap(), Command::Bus { reverb: false, .. }));
        assert!(matches!(parse(json!({"kind": "metronome", "enabled": true, "sound": 9, "volume": 0.6})).unwrap(), Command::Metronome(m) if m.kind == 4));
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
        assert!(matches!(to_command(request, 48000, Some(&song)).unwrap(), Command::Seek(s) if s == 1.0));
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
    fn commands_need_a_started_engine() {
        let service = AudioService::default();
        assert!(service.load(b"TSEV").is_err());
        assert!(service.command(Request::Play).is_err());
        assert!(service.status().is_none());
    }
}
