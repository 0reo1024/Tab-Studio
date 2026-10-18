//! The real-time engine core, independent of the audio device so it can be tested:
//! commands arrive through a lock-free queue, `process` renders one device buffer,
//! and the state the UI needs (position, playing, meters) is published through atomics.
//!
//! Real-time rules for `process`: no allocation, no locks, no frees. A newly loaded
//! song arrives fully built (player + stem buffers); the replaced one is handed back
//! through the `retired` queue and dropped on the control thread.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use crate::backing::{Backing, BackingMix, BackingTransport};
use crate::click::Metronome;
use crate::compressor::Compressor;
use crate::dsp::{Convolver, convolver_normalization, mono_pan, reverb_impulse, stereo_pan};
use crate::nam::{NamStage, NamTone};
use crate::fx::FxChain;
use crate::player::{CountIn, FreeClick, Player, Stem};

pub const MAX_TRACKS: usize = 64;
/// Largest block rendered at once; bigger device buffers are processed in pieces.
pub const MAX_BLOCK: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq)]
/// A track strip as in mixer-audio.ts: FX -> StereoPanner(pan) -> gain -> music bus,
/// with a post-gain send to the shared reverb.
pub struct TrackMix {
    /// Linear gain (the mixer uses volume / 8).
    pub gain: f32,
    /// -1 (left) .. 1 (right), StereoPannerNode on the stereo stem.
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    /// Reverb send level (0 when the track's reverb is off).
    pub send: f32,
}

impl Default for TrackMix {
    fn default() -> Self {
        TrackMix { gain: 1.0, pan: 0.0, mute: false, solo: false, send: 0.0 }
    }
}

/// A rendered audition (note or phrase preview), played once through a track's mix.
pub struct Preview {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub track: usize,
    position: usize,
}

impl Preview {
    pub fn new(left: Vec<f32>, right: Vec<f32>, track: usize) -> Box<Preview> {
        Box::new(Preview { left, right, track, position: 0 })
    }
}

/// Renders a short song offline (a preview): until it ends plus its release tail, with
/// trailing silence trimmed. Runs on a control thread.
pub fn render_offline(mut player: Player, sample_rate: u32, max_seconds: f64) -> (Vec<f32>, Vec<f32>) {
    let block = 1024;
    let tracks = player.tracks();
    let mut stems: Vec<Stem> = (0..=tracks).map(|_| Stem::new(block)).collect();
    let (mut left, mut right) = (Vec::new(), Vec::new());
    let limit = (max_seconds * sample_rate as f64) as usize;
    let tail = (0.6 * sample_rate as f64) as usize;
    let mut after = 0;
    player.play();
    while left.len() < limit && after < tail {
        player.render(&mut stems, block);
        for i in 0..block {
            left.push(stems[..tracks].iter().map(|s| s.left[i]).sum::<f32>());
            right.push(stems[..tracks].iter().map(|s| s.right[i]).sum::<f32>());
        }
        if !player.is_playing() {
            after += block;
        }
    }
    let last = left.iter().zip(&right).rposition(|(l, r)| l.abs() > 1e-5 || r.abs() > 1e-5).map_or(0, |i| i + 1);
    left.truncate(last);
    right.truncate(last);
    (left, right)
}

/// A song ready to swap in on the audio thread.
pub struct Loaded {
    pub player: Player,
    pub stems: Vec<Stem>,
}

impl Loaded {
    pub fn new(player: Player) -> Box<Loaded> {
        // One stem per track plus the metronome stem.
        let stems = (0..=player.tracks()).map(|_| Stem::new(MAX_BLOCK)).collect();
        Box::new(Loaded { player, stems })
    }
}

pub enum Command {
    Load(Box<Loaded>),
    Play,
    Pause,
    /// Song position in seconds at speed 1.
    Seek(f64),
    Speed(f64),
    /// The loop range (song seconds) and, for "count each loop", the count-in played on every wrap.
    Loop(Option<(f64, f64)>, Option<CountIn>),
    Track(usize, TrackMix),
    /// Replaces a track's insert effects (the old chain is retired).
    TrackFx(usize, Box<FxChain>),
    /// Plays a track with an SFZ instrument (None: back to the GM synth). Kept across reloads.
    TrackSampler(usize, Option<Box<crate::sfz::SfzInstrument>>),
    /// Puts a NAM amp at the head of a track's strip (None: removes it). Kept across reloads.
    TrackNam(usize, Option<Box<NamStage>>),
    /// The NAM knobs of a track (applied to its amp now and to one installed later).
    TrackNamTone(usize, NamTone),
    /// Delays that line tracks up behind external effects (the old set is retired).
    Compensation(Box<Compensation>),
    /// The music bus: gain (the mixer's 1/sqrt(audible tracks)) and the master reverb switch.
    Bus { gain: f32, reverb: bool },
    Master(f32),
    Metronome(Metronome),
    /// Count-in clicks, then playback starts on the exact frame.
    CountIn(CountIn),
    /// The standalone metronome (None: off). Song playback and a count-in stop it.
    FreeClick(Option<FreeClick>),
    /// Plays a rendered preview through its track's mix, replacing one still sounding.
    Preview(Box<Preview>),
    StopPreview,
    /// Instrument input: installs (or removes) the monitor. A new stage takes over the old
    /// one's amp, plugins and levels (the device was reopened).
    Live(Option<Box<crate::live::LiveStage>>),
    LiveMix(crate::live::LiveMix),
    /// The monitor's NAM amp (None: none) and its knobs.
    LiveNam(Option<Box<NamStage>>),
    LiveNamTone(NamTone),
    /// The monitor's insert chain (built-in and external effects on live links).
    LiveFx(Option<Box<FxChain>>),
    /// Plays a stretch of the recorded history (None: stops).
    LiveReplay(Option<Box<crate::live::Replay>>),
    /// The backing track (None: removes it). Kept across song reloads.
    Backing(Option<Box<Backing>>),
    /// Its strip and alignment (applied to the current one and to one installed later).
    BackingMix(BackingMix),
    /// Its own transport (when not linked to the song).
    BackingTransport(BackingTransport),
}

/// A stereo delay line (allocated on the control side).
pub struct DelayLine {
    buffer: Vec<f32>,
    at: usize,
}

impl DelayLine {
    pub fn new(frames: usize) -> DelayLine {
        DelayLine { buffer: vec![0.0; frames * 2], at: 0 }
    }
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = self.buffer.len() / 2;
        if n == 0 {
            return;
        }
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let (dl, dr) = (self.buffer[self.at * 2], self.buffer[self.at * 2 + 1]);
            self.buffer[self.at * 2] = *l;
            self.buffer[self.at * 2 + 1] = *r;
            *l = dl;
            *r = dr;
            self.at = (self.at + 1) % n;
        }
    }
}

/// External effects return their audio late (tabstudio-fxlink LATENCY each). As the
/// WebAudio mixer did with its delay nodes, every track is delayed to the latest one and
/// the click by the full amount, so everything stays together; `frames` is that amount,
/// which the reported position subtracts while playing so the cursor matches the sound.
pub struct Compensation {
    pub tracks: Vec<DelayLine>,
    pub click: DelayLine,
    pub frames: usize,
}

impl Compensation {
    /// `externals[i]`: how many external effects track i runs.
    pub fn new(externals: &[usize], latency: usize) -> Compensation {
        let most = externals.iter().copied().max().unwrap_or(0);
        Compensation {
            tracks: externals.iter().map(|&n| DelayLine::new((most - n) * latency)).collect(),
            click: DelayLine::new(most * latency),
            frames: most * latency,
        }
    }
}

/// What the UI reads. Floats are stored as bits.
pub struct Status {
    position: AtomicU64,
    playing: AtomicBool,
    /// Increments when playback reached the song end by itself.
    finished: AtomicU64,
    /// Increments on every loop wrap.
    wraps: AtomicU64,
    /// Total frames delivered to the device (a clock for latency measurements).
    frames: AtomicU64,
    counting: AtomicBool,
    click_peak: AtomicU32,
    backing_peak: AtomicU32,
    /// The backing file's position heard (seconds) and whether its own transport plays.
    backing_position: AtomicU64,
    backing_playing: AtomicBool,
    master_peak: [AtomicU32; 2],
    track_peaks: [AtomicU32; MAX_TRACKS],
    /// Music frames the device played as silence because the anticipation thread was late.
    music_short: AtomicU64,
}

impl Default for Status {
    fn default() -> Self {
        Status {
            position: AtomicU64::new(0f64.to_bits()),
            playing: AtomicBool::new(false),
            finished: AtomicU64::new(0),
            wraps: AtomicU64::new(0),
            frames: AtomicU64::new(0),
            counting: AtomicBool::new(false),
            click_peak: AtomicU32::new(0),
            backing_peak: AtomicU32::new(0),
            backing_position: AtomicU64::new(0f64.to_bits()),
            backing_playing: AtomicBool::new(false),
            master_peak: [AtomicU32::new(0), AtomicU32::new(0)],
            track_peaks: std::array::from_fn(|_| AtomicU32::new(0)),
            music_short: AtomicU64::new(0),
        }
    }
}

impl Status {
    pub fn position(&self) -> f64 {
        f64::from_bits(self.position.load(Ordering::Acquire))
    }
    pub fn playing(&self) -> bool {
        self.playing.load(Ordering::Acquire)
    }
    pub fn finished(&self) -> u64 {
        self.finished.load(Ordering::Acquire)
    }
    pub fn wraps(&self) -> u64 {
        self.wraps.load(Ordering::Acquire)
    }
    pub fn counting(&self) -> bool {
        self.counting.load(Ordering::Acquire)
    }
    pub fn take_click_peak(&self) -> f32 {
        f32::from_bits(self.click_peak.swap(0, Ordering::AcqRel))
    }
    pub fn backing_position(&self) -> f64 {
        f64::from_bits(self.backing_position.load(Ordering::Acquire))
    }
    pub fn backing_playing(&self) -> bool {
        self.backing_playing.load(Ordering::Acquire)
    }
    pub fn take_backing_peak(&self) -> f32 {
        f32::from_bits(self.backing_peak.swap(0, Ordering::AcqRel))
    }
    pub fn frames(&self) -> u64 {
        self.frames.load(Ordering::Acquire)
    }
    pub fn music_short(&self) -> u64 {
        self.music_short.load(Ordering::Relaxed)
    }
    /// Peak since the last call (meters reset when read).
    pub fn take_track_peak(&self, track: usize) -> f32 {
        self.track_peaks.get(track).map_or(0.0, |p| f32::from_bits(p.swap(0, Ordering::AcqRel)))
    }
    pub fn take_master_peak(&self) -> [f32; 2] {
        [0, 1].map(|c| f32::from_bits(self.master_peak[c].swap(0, Ordering::AcqRel)))
    }
}

fn raise_peak(slot: &AtomicU32, value: f32) {
    let mut current = slot.load(Ordering::Relaxed);
    while value > f32::from_bits(current) {
        match slot.compare_exchange_weak(current, value.to_bits(), Ordering::AcqRel, Ordering::Relaxed) {
            Ok(_) => break,
            Err(seen) => current = seen,
        }
    }
}

/// The mixer's master limiter: DynamicsCompressor threshold -3, knee 0, ratio 20,
/// attack 0.003, release 0.12 (with its automatic makeup gain, as in the WebAudio build).
fn master_limiter(sample_rate: u32) -> Compressor {
    Compressor::new(sample_rate as f64, -3.0, 0.0, 20.0, 0.003, 0.12)
}

/// The mixer's reverb: the seeded 1.8 s impulse, normalized like ConvolverNode.
fn mixer_reverb(sample_rate: u32) -> Convolver {
    let rate = sample_rate as f64;
    let impulse = reverb_impulse(rate);
    let scale = convolver_normalization(&impulse, rate);
    let impulse = [impulse[0].iter().map(|v| v * scale).collect(), impulse[1].iter().map(|v| v * scale).collect()];
    Convolver::new(&impulse, 128)
}

/// The music: song, tracks, previews, reverb, click and backing track, rendered into the
/// music bus (on the anticipation thread, or inline in the Core).
struct Music {
    loaded: Option<Box<Loaded>>,
    preview: Option<Box<Preview>>,
    retired_previews: rtrb::Producer<Box<Preview>>,
    mix: [TrackMix; MAX_TRACKS],
    fx: Vec<Option<Box<FxChain>>>,
    retired_fx: rtrb::Producer<Box<FxChain>>,
    retired_samplers: rtrb::Producer<Box<crate::sfz::SfzInstrument>>,
    nam: Vec<Option<Box<NamStage>>>,
    nam_tone: [NamTone; MAX_TRACKS],
    retired_nam: rtrb::Producer<Box<NamStage>>,
    compensation: Option<Box<Compensation>>,
    retired_compensation: rtrb::Producer<Box<Compensation>>,
    /// Helpers that render tracks in parallel (handed to every loaded player).
    pool: Option<Arc<crate::pool::Pool>>,
    sample_rate: f64,
    bus_gain: f32,
    reverb_on: bool,
    reverb: Convolver,
    bus: Stem,
    send: Stem,
    /// Each strip's peak this block (written by the parallel strip stage).
    strip_peaks: [f32; MAX_TRACKS],
    metronome: Metronome,
    free_click: Option<FreeClick>,
    status: Arc<Status>,
    commands: rtrb::Consumer<Command>,
    retired: rtrb::Producer<Box<Loaded>>,
    backing: Option<Box<Backing>>,
    backing_mix: BackingMix,
    backing_stem: Stem,
    /// Anything else the audio thread lets go of (freed on the control side).
    retired_any: rtrb::Producer<Box<dyn std::any::Any + Send>>,
}

/// The control side: send commands, read status, drop retired songs.
pub struct Control {
    commands: rtrb::Producer<Command>,
    retired: rtrb::Consumer<Box<Loaded>>,
    retired_previews: rtrb::Consumer<Box<Preview>>,
    retired_fx: rtrb::Consumer<Box<FxChain>>,
    retired_samplers: rtrb::Consumer<Box<crate::sfz::SfzInstrument>>,
    retired_nam: rtrb::Consumer<Box<NamStage>>,
    retired_compensation: rtrb::Consumer<Box<Compensation>>,
    retired_any: rtrb::Consumer<Box<dyn std::any::Any + Send>>,
    /// What the Core (device callback side) let go of: monitor stages and their parts.
    retired_core: rtrb::Consumer<Box<dyn std::any::Any + Send>>,
    /// Retired objects taken off the queues and not yet dropped (`take_garbage`).
    garbage: Vec<Box<dyn std::any::Any + Send>>,
    pub status: Arc<Status>,
    pub sample_rate: u32,
}

impl Control {
    /// Sends a command; returns it back if the queue is full (the caller may retry).
    /// Retired objects are only moved aside here: freeing an SFZ instrument takes seconds,
    /// so callers holding a lock drop them later (`take_garbage`).
    pub fn send(&mut self, command: Command) -> Result<(), Command> {
        self.gather_garbage();
        self.commands.push(command).map_err(|rtrb::PushError::Full(c)| c)
    }
    fn gather_garbage(&mut self) {
        fn drain<T: Send + 'static>(queue: &mut rtrb::Consumer<Box<T>>, into: &mut Vec<Box<dyn std::any::Any + Send>>) {
            while let Ok(old) = queue.pop() {
                into.push(old);
            }
        }
        let into = &mut self.garbage;
        drain(&mut self.retired, into);
        drain(&mut self.retired_previews, into);
        drain(&mut self.retired_fx, into);
        drain(&mut self.retired_samplers, into);
        drain(&mut self.retired_nam, into);
        drain(&mut self.retired_compensation, into);
        while let Ok(old) = self.retired_any.pop() {
            into.push(old);
        }
        while let Ok(old) = self.retired_core.pop() {
            into.push(old);
        }
    }
    /// What the audio thread let go of, for the caller to drop (off any lock).
    pub fn take_garbage(&mut self) -> Vec<Box<dyn std::any::Any + Send>> {
        self.gather_garbage();
        std::mem::take(&mut self.garbage)
    }
    pub fn collect_garbage(&mut self) {
        drop(self.take_garbage());
    }
}

pub fn new_engine(sample_rate: u32) -> (Core, Control) {
    new_engine_with(sample_rate, anticipate())
}

/// `ahead`: render the music on the anticipation thread (else inline in `process`).
fn new_engine_with(sample_rate: u32, ahead: bool) -> (Core, Control) {
    let (command_tx, command_rx) = rtrb::RingBuffer::new(256);
    let (retired_tx, retired_rx) = rtrb::RingBuffer::new(16);
    let (preview_tx, preview_rx) = rtrb::RingBuffer::new(64);
    let status = Arc::new(Status::default());
    let (fx_tx, fx_rx) = rtrb::RingBuffer::new(MAX_TRACKS * 2);
    let (sampler_tx, sampler_rx) = rtrb::RingBuffer::new(MAX_TRACKS * 2);
    let (nam_tx, nam_rx) = rtrb::RingBuffer::new(MAX_TRACKS * 2);
    let (comp_tx, comp_rx) = rtrb::RingBuffer::new(16);
    let (any_tx, any_rx) = rtrb::RingBuffer::new(64);
    let (forward_tx, forward_rx) = rtrb::RingBuffer::new(256);
    let (core_any_tx, core_any_rx) = rtrb::RingBuffer::new(64);
    let music = Music {
        loaded: None,
        preview: None,
        retired_previews: preview_tx,
        mix: [TrackMix::default(); MAX_TRACKS],
        fx: (0..MAX_TRACKS).map(|_| None).collect(),
        retired_fx: fx_tx,
        retired_samplers: sampler_tx,
        nam: (0..MAX_TRACKS).map(|_| None).collect(),
        nam_tone: [NamTone::default(); MAX_TRACKS],
        retired_nam: nam_tx,
        compensation: None,
        retired_compensation: comp_tx,
        pool: Some(Arc::new(crate::pool::Pool::new(crate::pool::Pool::default_helpers()))),
        sample_rate: sample_rate as f64,
        bus_gain: 1.0,
        reverb_on: true,
        reverb: mixer_reverb(sample_rate),
        bus: Stem::new(MAX_BLOCK),
        send: Stem::new(MAX_BLOCK),
        strip_peaks: [0.0; MAX_TRACKS],
        metronome: Metronome::default(),
        free_click: None,
        status: status.clone(),
        commands: forward_rx,
        retired: retired_tx,
        backing: None,
        backing_mix: BackingMix::default(),
        backing_stem: Stem::new(MAX_BLOCK),
        retired_any: any_tx,
    };
    let music = Box::new(music);
    let (music, ahead) = if ahead { (None, Some(Ahead::start(music))) } else { (Some(music), None) };
    let core = Core {
        music,
        ahead,
        commands: command_rx,
        forward: forward_tx,
        sample_rate,
        master: 1.0,
        limiter: master_limiter(sample_rate),
        bus: Stem::new(MAX_BLOCK),
        live: None,
        live_mix: crate::live::LiveMix::default(),
        live_tone: NamTone::default(),
        status: status.clone(),
        retired_any: core_any_tx,
    };
    (core, Control { commands: command_tx, retired: retired_rx, retired_previews: preview_rx, retired_fx: fx_rx, retired_samplers: sampler_rx, retired_nam: nam_rx, retired_compensation: comp_rx, retired_any: any_rx, retired_core: core_any_rx, garbage: Vec::new(), status, sample_rate })
}

/// Whether the music renders ahead on its own thread (TABSTUDIO_AUDIO_AHEAD=0: inline in the
/// device callback, as before; unit tests run inline so they stay deterministic).
fn anticipate() -> bool {
    if cfg!(test) {
        return false;
    }
    std::env::var("TABSTUDIO_AUDIO_AHEAD").map_or(true, |v| v != "0")
}

/// Frames the anticipation thread renders at once (sfizz and the strips cost much less per
/// frame in larger blocks than in a 64-frame ASIO buffer).
const AHEAD_CHUNK: usize = 256;
/// Least music kept rendered ahead of the device (16 ms at 48 kHz): room for the spikes of
/// note starts in SFZ instruments, which took 2-3 ms at once in a 1.3 ms ASIO buffer.
const AHEAD_MIN: usize = 768;
/// Queue size in frames (left, right, song-playing flag per frame).
const AHEAD_CAPACITY: usize = 16384;

struct AheadShared {
    stop: AtomicBool,
    /// The device's last callback size (frames): the queue is kept at twice that at least.
    block: AtomicU64,
    /// The queue has been filled once (before that, a device that opened at once finds it
    /// still filling: not a shortfall worth reporting).
    primed: AtomicBool,
    /// The device callback before the current one (a stream that starts by filling its
    /// whole buffer asks for more than the queue was sized for: that one is not counted).
    last_block: AtomicU64,
}

/// The music, rendered ahead of the device on its own thread (anticipative processing, as
/// DAWs do for tracks that take no live input): the device callback only takes finished
/// music from the queue and adds the instrument monitor, so a costly or spiky song (SFZ
/// instruments, many tracks) cannot make a small ASIO buffer miss its deadline.
struct Ahead {
    queue: rtrb::Consumer<f32>,
    shared: Arc<AheadShared>,
    thread: std::thread::Thread,
}

impl Ahead {
    fn start(mut music: Box<Music>) -> Ahead {
        let (mut tx, queue) = rtrb::RingBuffer::new(AHEAD_CAPACITY * 3);
        let shared = Arc::new(AheadShared { stop: AtomicBool::new(false), block: AtomicU64::new(0), primed: AtomicBool::new(false), last_block: AtomicU64::new(0) });
        let worker = shared.clone();
        let thread = std::thread::Builder::new()
            .name("tabstudio-audio-ahead".into())
            .spawn(move || {
                raise_priority();
                while !worker.stop.load(Ordering::Acquire) {
                    let queued = AHEAD_CAPACITY - tx.slots() / 3;
                    let target = (worker.block.load(Ordering::Relaxed) as usize * 2).max(AHEAD_MIN).min(AHEAD_CAPACITY - AHEAD_CHUNK);
                    if queued >= target || tx.slots() < AHEAD_CHUNK * 3 {
                        worker.primed.store(true, Ordering::Relaxed);
                        std::thread::park_timeout(std::time::Duration::from_millis(2));
                        continue;
                    }
                    let playing = music.render(AHEAD_CHUNK, queued + AHEAD_CHUNK);
                    let flag = if playing { 1.0 } else { 0.0 };
                    if let Ok(mut chunk) = tx.write_chunk_uninit(AHEAD_CHUNK * 3) {
                        let (a, b) = chunk.as_mut_slices();
                        for (k, slot) in a.iter_mut().chain(b.iter_mut()).enumerate() {
                            slot.write(match k % 3 {
                                0 => music.bus.left[k / 3],
                                1 => music.bus.right[k / 3],
                                _ => flag,
                            });
                        }
                        unsafe { chunk.commit_all() };
                    }
                }
                // The music (SFZ instruments and all) is freed here, off the device thread.
            })
            .expect("anticipation thread");
        Ahead { queue, shared, thread: thread.thread().clone() }
    }
}

/// The anticipation thread renders audio: run it at the audio thread's urgency.
fn raise_priority() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL};
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }
}

/// What runs in the device callback: the music (from the anticipation queue, or rendered
/// inline), then the instrument monitor, master gain and limiter.
pub struct Core {
    /// Inline music (no anticipation thread).
    music: Option<Box<Music>>,
    ahead: Option<Ahead>,
    commands: rtrb::Consumer<Command>,
    /// Commands for the music, passed on in order.
    forward: rtrb::Producer<Command>,
    sample_rate: u32,
    master: f32,
    limiter: Compressor,
    bus: Stem,
    live: Option<Box<crate::live::LiveStage>>,
    live_mix: crate::live::LiveMix,
    live_tone: NamTone,
    status: Arc<Status>,
    retired_any: rtrb::Producer<Box<dyn std::any::Any + Send>>,
}

impl Drop for Core {
    fn drop(&mut self) {
        if let Some(ahead) = &self.ahead {
            ahead.shared.stop.store(true, Ordering::Release);
            ahead.thread.unpark();
        }
    }
}

impl Core {
    /// The rate the core was built for.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Whether an instrument input is installed.
    pub fn has_live(&self) -> bool {
        self.live.is_some()
    }

    /// Hands an object to the control side to free (leaked if the queue is full).
    fn retire<T: Send + 'static>(&mut self, old: Box<T>) {
        let old: Box<dyn std::any::Any + Send> = old;
        if let Err(rtrb::PushError::Full(old)) = self.retired_any.push(old) {
            std::mem::forget(old);
        }
    }

    /// Applies the monitor's and the master's commands and passes the rest on to the music
    /// (a full music queue leaves them waiting, in order).
    fn apply_commands(&mut self) {
        while self.forward.slots() > 0 {
            let Ok(command) = self.commands.pop() else { break };
            match command {
                Command::Master(gain) => self.master = gain.max(0.0),
                Command::Live(next) => {
                    let mut next = next;
                    if let Some(stage) = &mut next {
                        stage.set_mix(self.live_mix);
                        if let Some(old) = &mut self.live {
                            stage.nam = old.nam.take();
                            stage.fx = old.fx.take();
                            stage.replay = old.replay.take();
                        }
                    }
                    if let Some(old) = std::mem::replace(&mut self.live, next) {
                        self.retire(old);
                    }
                }
                Command::LiveMix(mix) => {
                    self.live_mix = mix;
                    if let Some(stage) = &mut self.live {
                        stage.set_mix(mix);
                    }
                }
                Command::LiveNam(nam) => {
                    let nam = nam.map(|mut n| {
                        n.set_tone(self.live_tone);
                        n
                    });
                    let old = match &mut self.live {
                        Some(stage) => std::mem::replace(&mut stage.nam, nam),
                        None => nam,
                    };
                    if let Some(old) = old {
                        self.retire(old);
                    }
                }
                Command::LiveNamTone(tone) => {
                    self.live_tone = tone;
                    if let Some(nam) = self.live.as_mut().and_then(|s| s.nam.as_mut()) {
                        nam.set_tone(tone);
                    }
                }
                Command::LiveFx(fx) => {
                    let old = match &mut self.live {
                        Some(stage) => std::mem::replace(&mut stage.fx, fx),
                        None => fx,
                    };
                    if let Some(old) = old {
                        self.retire(old);
                    }
                }
                Command::LiveReplay(replay) => {
                    let old = match &mut self.live {
                        Some(stage) => {
                            let old = stage.take_replay();
                            stage.replay = replay;
                            old
                        }
                        None => replay,
                    };
                    if let Some(old) = old {
                        self.retire(old);
                    }
                }
                other => {
                    let _ = self.forward.push(other);
                }
            }
        }
    }

    /// Takes `frames` of music into `self.bus`; returns whether the song plays in them.
    fn take_music(&mut self, frames: usize) -> bool {
        if let Some(music) = self.music.as_mut() {
            let playing = music.render(frames, 0);
            self.bus.left[..frames].copy_from_slice(&music.bus.left[..frames]);
            self.bus.right[..frames].copy_from_slice(&music.bus.right[..frames]);
            return playing;
        }
        let Some(ahead) = self.ahead.as_mut() else { return false };
        let available = (ahead.queue.slots() / 3).min(frames);
        let mut playing = false;
        if let Ok(chunk) = ahead.queue.read_chunk(available * 3) {
            let (a, b) = chunk.as_slices();
            for (k, v) in a.iter().chain(b.iter()).enumerate() {
                match k % 3 {
                    0 => self.bus.left[k / 3] = *v,
                    1 => self.bus.right[k / 3] = *v,
                    _ => playing |= *v != 0.0,
                }
            }
            chunk.commit_all();
        }
        if available < frames {
            self.bus.left[available..frames].fill(0.0);
            self.bus.right[available..frames].fill(0.0);
            if ahead.shared.primed.load(Ordering::Relaxed) && ahead.shared.last_block.load(Ordering::Relaxed) >= ahead.shared.block.load(Ordering::Relaxed) {
                self.status.music_short.fetch_add((frames - available) as u64, Ordering::Relaxed);
            }
        }
        playing
    }

    /// Renders `out` (interleaved, `channels` per frame; the first two get left/right).
    /// Signal flow: the music bus (Music::render), then the instrument monitor (not scaled
    /// by the bus's 1/sqrt), master gain and limiter.
    pub fn process(&mut self, out: &mut [f32], channels: usize) {
        self.apply_commands();
        let channels = channels.max(1);
        let frames_total = out.len() / channels;
        if let Some(ahead) = &self.ahead {
            let last = ahead.shared.block.swap(frames_total as u64, Ordering::Relaxed);
            ahead.shared.last_block.store(last, Ordering::Relaxed);
        }
        let mut done = 0;
        while done < frames_total {
            let frames = (frames_total - done).min(MAX_BLOCK);
            let song_playing = self.take_music(frames);
            let finished = match &mut self.live {
                Some(live) => {
                    live.process(&mut self.bus.left[..frames], &mut self.bus.right[..frames], frames, song_playing);
                    if live.replay_done() { live.take_replay() } else { None }
                }
                None => None,
            };
            if let Some(old) = finished {
                self.retire(old);
            }
            for i in 0..frames {
                self.bus.left[i] *= self.master;
                self.bus.right[i] *= self.master;
            }
            self.limiter.process(&mut self.bus.left[..frames], &mut self.bus.right[..frames]);
            let (mut peak_l, mut peak_r) = (0f32, 0f32);
            let block = &mut out[done * channels..(done + frames) * channels];
            for i in 0..frames {
                let (l, r) = (self.bus.left[i], self.bus.right[i]);
                peak_l = peak_l.max(l.abs());
                peak_r = peak_r.max(r.abs());
                block[i * channels] = l;
                if channels > 1 {
                    block[i * channels + 1] = r;
                    for extra in 2..channels {
                        block[i * channels + extra] = 0.0;
                    }
                }
            }
            raise_peak(&self.status.master_peak[0], peak_l);
            raise_peak(&self.status.master_peak[1], peak_r);
            done += frames;
        }
        self.status.frames.fetch_add(frames_total as u64, Ordering::AcqRel);
        if let Some(ahead) = &self.ahead {
            ahead.thread.unpark();
        }
    }

    /// The inline music (tests look inside it).
    #[cfg(test)]
    fn music(&mut self) -> &mut Music {
        self.music.as_mut().expect("inline music")
    }
}

impl Music {
    fn apply_commands(&mut self) {
        while let Ok(command) = self.commands.pop() {
            match command {
                Command::Load(mut next) => {
                    next.player.set_pool(self.pool.clone());
                    if let Some(old) = &self.loaded {
                        // Carry the transport over so a reload (edit) does not stop playback.
                        // The loop range is in song seconds of the old song; the client resends it.
                        let playing = old.player.is_playing();
                        next.player.set_speed(old.player.speed());
                        next.player.seek(old.player.position());
                        if playing {
                            next.player.play();
                        }
                    }
                    next.player.set_metronome(self.metronome);
                    next.player.set_free_click(self.free_click);
                    if let Some(old) = &mut self.loaded {
                        // SFZ instruments take seconds to load: they move to the new song.
                        for track in 0..old.player.tracks() {
                            if let Some(sampler) = old.player.take_sampler(track) {
                                if let Some(stale) = next.player.set_sampler(track, Some(sampler)) {
                                    Self::retire_sampler(&mut self.retired_samplers, stale);
                                }
                            }
                        }
                    }
                    if let Some(old) = self.loaded.replace(next) {
                        // If the queue is full the old song is leaked rather than freed here.
                        if let Err(rtrb::PushError::Full(old)) = self.retired.push(old) {
                            std::mem::forget(old);
                        }
                    }
                }
                Command::Play => {
                    self.free_click = None;
                    if let Some(l) = &mut self.loaded {
                        l.player.play();
                    }
                }
                Command::Pause => {
                    if let Some(l) = &mut self.loaded {
                        l.player.pause();
                    }
                }
                Command::Seek(seconds) => {
                    if let Some(l) = &mut self.loaded {
                        l.player.seek(seconds);
                    }
                }
                Command::Speed(speed) => {
                    if let Some(l) = &mut self.loaded {
                        l.player.set_speed(speed);
                    }
                }
                Command::Loop(range, count) => {
                    if let Some(l) = &mut self.loaded {
                        l.player.set_loop(range);
                        l.player.set_loop_count(count);
                    }
                }
                Command::Track(index, mix) => {
                    if let Some(slot) = self.mix.get_mut(index) {
                        *slot = mix;
                    }
                }
                Command::TrackFx(index, chain) => {
                    if let Some(slot) = self.fx.get_mut(index) {
                        if let Some(old) = slot.replace(chain) {
                            if let Err(rtrb::PushError::Full(old)) = self.retired_fx.push(old) {
                                std::mem::forget(old);
                            }
                        }
                    }
                }
                Command::TrackSampler(index, sampler) => {
                    match &mut self.loaded {
                        Some(l) => {
                            if let Some(old) = l.player.set_sampler(index, sampler) {
                                Self::retire_sampler(&mut self.retired_samplers, old);
                            }
                        }
                        None => {
                            if let Some(sampler) = sampler {
                                Self::retire_sampler(&mut self.retired_samplers, sampler);
                            }
                        }
                    }
                }
                Command::TrackNam(index, stage) => {
                    let tone = self.nam_tone.get(index).copied();
                    match (self.nam.get_mut(index), tone) {
                        (Some(slot), Some(tone)) => {
                            let stage = stage.map(|mut s| {
                                s.set_tone(tone);
                                s
                            });
                            if let Some(old) = std::mem::replace(slot, stage) {
                                Self::retire_nam(&mut self.retired_nam, old);
                            }
                        }
                        _ => {
                            if let Some(stage) = stage {
                                Self::retire_nam(&mut self.retired_nam, stage);
                            }
                        }
                    }
                }
                Command::Compensation(next) => {
                    if let Some(old) = self.compensation.replace(next) {
                        if let Err(rtrb::PushError::Full(old)) = self.retired_compensation.push(old) {
                            std::mem::forget(old);
                        }
                    }
                }
                Command::TrackNamTone(index, tone) => {
                    if let Some(slot) = self.nam_tone.get_mut(index) {
                        *slot = tone;
                        if let Some(stage) = &mut self.nam[index] {
                            stage.set_tone(tone);
                        }
                    }
                }
                Command::Bus { gain, reverb } => {
                    self.bus_gain = gain.max(0.0);
                    self.reverb_on = reverb;
                }
                Command::Metronome(metronome) => {
                    self.metronome = metronome;
                    if let Some(l) = &mut self.loaded {
                        l.player.set_metronome(metronome);
                    }
                }
                Command::Preview(next) => self.retire_preview(Some(next)),
                Command::StopPreview => self.retire_preview(None),
                Command::CountIn(plan) => {
                    self.free_click = None;
                    if let Some(l) = &mut self.loaded {
                        l.player.count_in(plan);
                    }
                }
                Command::FreeClick(plan) => {
                    self.free_click = plan;
                    if let Some(l) = &mut self.loaded {
                        l.player.set_free_click(plan);
                    }
                }
                Command::Backing(next) => {
                    let next = next.map(|mut b| {
                        b.set_mix(self.backing_mix);
                        b
                    });
                    if let Some(old) = std::mem::replace(&mut self.backing, next) {
                        self.retire(old);
                    }
                }
                Command::BackingMix(mix) => {
                    self.backing_mix = mix;
                    if let Some(b) = &mut self.backing {
                        b.set_mix(mix);
                    }
                }
                Command::BackingTransport(command) => {
                    if let Some(b) = &mut self.backing {
                        b.transport(command);
                    }
                }
                // Handled by the Core before they reach the music.
                Command::Master(_) | Command::Live(_) | Command::LiveMix(_) | Command::LiveNam(_) | Command::LiveNamTone(_) | Command::LiveFx(_) | Command::LiveReplay(_) => {}
            }
        }
    }

    /// Hands an object to the control side to free (leaked if the queue is full).
    fn retire<T: Send + 'static>(&mut self, old: Box<T>) {
        let old: Box<dyn std::any::Any + Send> = old;
        if let Err(rtrb::PushError::Full(old)) = self.retired_any.push(old) {
            std::mem::forget(old);
        }
    }

    fn retire_nam(queue: &mut rtrb::Producer<Box<NamStage>>, old: Box<NamStage>) {
        if let Err(rtrb::PushError::Full(old)) = queue.push(old) {
            std::mem::forget(old);
        }
    }

    fn retire_sampler(queue: &mut rtrb::Producer<Box<crate::sfz::SfzInstrument>>, old: Box<crate::sfz::SfzInstrument>) {
        if let Err(rtrb::PushError::Full(old)) = queue.push(old) {
            std::mem::forget(old);
        }
    }

    fn retire_preview(&mut self, next: Option<Box<Preview>>) {
        let old = std::mem::replace(&mut self.preview, next);
        if let Some(old) = old {
            if let Err(rtrb::PushError::Full(old)) = self.retired_previews.push(old) {
                std::mem::forget(old);
            }
        }
    }

    /// Renders `frames` (at most MAX_BLOCK) of the music bus into `self.bus`, before the
    /// instrument monitor, master gain and limiter (Core). `ahead`: frames between this
    /// block's end and the ear (the anticipation queue), taken off the reported positions.
    /// Returns whether the song plays.
    /// Signal flow as in mixer-audio.ts: each track stem -> its FX -> StereoPanner -> gain
    /// (meter) -> music bus, plus a post-gain reverb send; the reverb returns into the bus;
    /// the bus is scaled by 1/sqrt(audible); clicks join after the bus; master gain;
    /// limiter.
    fn render(&mut self, frames: usize, ahead: usize) -> bool {
        self.apply_commands();
        let frames = frames.min(MAX_BLOCK);
        let ahead = ahead as f64 / self.sample_rate;
        // A soloed backing track mutes the tracks that are not soloed, and the other way round.
        let backing_solo = self.backing.as_ref().is_some_and(|b| b.mix().solo);
        let any_solo = self.mix.iter().any(|m| m.solo) || backing_solo;
        self.bus.left[..frames].fill(0.0);
        self.bus.right[..frames].fill(0.0);
        self.send.left[..frames].fill(0.0);
        self.send.right[..frames].fill(0.0);
        let preview_track = self.preview.as_ref().map(|p| p.track);
        let mut preview_mixed = false;
        let mut click_stem = None;
        if let Some(loaded) = &mut self.loaded {
            loaded.player.render(&mut loaded.stems[..], frames);
            let tracks = loaded.player.tracks();
            click_stem = Some(tracks);
            let count = tracks.min(MAX_TRACKS);
            // 1. Strip inputs (serial, cheap): the track's own stem, silenced when it is
            //    not audible (its FX keep running so tails die out), plus an audition.
            for index in 0..count {
                let mix = self.mix[index];
                let audible = !mix.mute && (!any_solo || mix.solo);
                let stem = &mut loaded.stems[index];
                let (l, r) = (&mut stem.left[..frames], &mut stem.right[..frames]);
                if !audible {
                    l.fill(0.0);
                    r.fill(0.0);
                }
                if preview_track == Some(index) {
                    // Auditions enter the track strip like the WebAudio preview did.
                    if let Some(preview) = &mut self.preview {
                        let n = (preview.left.len() - preview.position).min(frames);
                        if audible {
                            for i in 0..n {
                                l[i] += preview.left[preview.position + i];
                                r[i] += preview.right[preview.position + i];
                            }
                        }
                        preview.position += n;
                        preview_mixed = true;
                    }
                }
            }
            // 2. Each strip (NAM, insert FX, delay compensation, pan, gain), tracks in
            //    parallel: they are independent, so the result is the same as in order.
            {
                use crate::pool::Parts;
                let (stems, nam, fx, peaks) = (Parts(loaded.stems.as_mut_ptr()), Parts(self.nam.as_mut_ptr()), Parts(self.fx.as_mut_ptr()), Parts(self.strip_peaks.as_mut_ptr()));
                let lines = Parts(self.compensation.as_mut().map_or(std::ptr::null_mut(), |c| c.tracks.as_mut_ptr()));
                let lines_len = self.compensation.as_ref().map_or(0, |c| c.tracks.len());
                let mixes = &self.mix;
                let strip = |index: usize| unsafe {
                    let mix = mixes[index];
                    let audible = !mix.mute && (!any_solo || mix.solo);
                    let stem = stems.at(index);
                    let (l, r) = (&mut stem.left[..frames], &mut stem.right[..frames]);
                    // NAM heads the strip; from there on the WebAudio chain carries one
                    // channel, and a StereoPanner pans a mono input with the mono law.
                    let mono = match nam.at(index) {
                        Some(stage) => {
                            stage.process(l, r);
                            true
                        }
                        None => false,
                    };
                    if let Some(chain) = fx.at(index) {
                        chain.process(l, r);
                    }
                    if index < lines_len {
                        lines.at(index).process(l, r);
                    }
                    if mono {
                        mono_pan(mix.pan, l, r);
                    } else {
                        stereo_pan(mix.pan, l, r);
                    }
                    let gain = if audible { mix.gain } else { 0.0 };
                    let mut peak = 0f32;
                    for i in 0..frames {
                        l[i] *= gain;
                        r[i] *= gain;
                        peak = peak.max(l[i].abs()).max(r[i].abs());
                    }
                    *peaks.at(index) = peak;
                };
                match &self.pool {
                    Some(pool) => pool.run(count, &strip),
                    None => (0..count).for_each(strip),
                }
            }
            // 3. Sum into the music bus and the reverb send, in track order.
            for index in 0..count {
                let mix = self.mix[index];
                let stem = &loaded.stems[index];
                for i in 0..frames {
                    self.bus.left[i] += stem.left[i];
                    self.bus.right[i] += stem.right[i];
                    self.send.left[i] += stem.left[i] * mix.send;
                    self.send.right[i] += stem.right[i] * mix.send;
                }
                raise_peak(&self.status.track_peaks[index], self.strip_peaks[index]);
            }
            // The backing track follows the transport segment by segment (count-in start,
            // loop wraps and the song end fall inside blocks), behind the same delay as the
            // tracks when external effects add one.
            if let Some(backing) = self.backing.as_mut().filter(|b| b.mix().linked) {
                let lag = self.compensation.as_ref().map_or(0.0, |c| c.frames as f64 / self.sample_rate) * loaded.player.speed();
                let speed = loaded.player.speed();
                let marks = loaded.player.marks();
                for (i, &(from, position, playing)) in marks.iter().enumerate() {
                    let to = marks.get(i + 1).map_or(frames, |m| m.0).min(frames);
                    if to > from {
                        backing.render(&mut self.backing_stem.left[from..to], &mut self.backing_stem.right[from..to], playing.then_some(position - lag), speed);
                    }
                }
            }
            if loaded.player.take_finished() {
                self.status.finished.fetch_add(1, Ordering::AcqRel);
            }
            self.status.wraps.store(loaded.player.wraps, Ordering::Release);
            // While playing, report what is heard: the song position minus the delay
            // external effects add (in song seconds at the current speed).
            let lag = (self.compensation.as_ref().map_or(0.0, |c| c.frames as f64 / self.sample_rate) + ahead) * loaded.player.speed();
            let position = if loaded.player.is_playing() { (loaded.player.position() - lag).max(0.0) } else { loaded.player.position() };
            self.status.position.store(position.to_bits(), Ordering::Release);
            self.status.playing.store(loaded.player.is_playing(), Ordering::Release);
            self.status.counting.store(loaded.player.is_counting(), Ordering::Release);
        }
        if !preview_mixed {
            // No song (or no such track): the audition goes straight to the bus.
            if let Some(preview) = &mut self.preview {
                let mix = self.mix.get(preview.track).copied().unwrap_or_default();
                let count = (preview.left.len() - preview.position).min(frames);
                if !mix.mute {
                    for i in 0..count {
                        self.bus.left[i] += preview.left[preview.position + i] * mix.gain;
                        self.bus.right[i] += preview.right[preview.position + i] * mix.gain;
                    }
                }
                preview.position += count;
            }
        }
        if self.preview.as_ref().is_some_and(|p| p.position >= p.left.len()) {
            self.retire_preview(None);
        }
        // Reverb return, always processed so its state stays continuous.
        self.reverb.process(&mut self.send.left[..frames], &mut self.send.right[..frames]);
        let reverb = if self.reverb_on { 1.0 } else { 0.0 };
        for i in 0..frames {
            self.bus.left[i] = (self.bus.left[i] + self.send.left[i] * reverb) * self.bus_gain;
            self.bus.right[i] = (self.bus.right[i] + self.send.right[i] * reverb) * self.bus_gain;
        }
        // The backing track is a finished mix: after the music bus's 1/sqrt(tracks) scaling,
        // before the master gain and limiter.
        if let Some(backing) = &mut self.backing {
            {
                if !backing.mix().linked {
                    backing.render_own(&mut self.backing_stem.left[..frames], &mut self.backing_stem.right[..frames]);
                } else if self.loaded.is_none() {
                    backing.render(&mut self.backing_stem.left[..frames], &mut self.backing_stem.right[..frames], None, 1.0);
                }
                let audible = !any_solo || backing_solo;
                let gain = if audible { backing.gain() } else { 0.0 };
                let mut peak = 0f32;
                for i in 0..frames {
                    let (l, r) = (self.backing_stem.left[i] * gain, self.backing_stem.right[i] * gain);
                    peak = peak.max(l.abs()).max(r.abs());
                    self.bus.left[i] += l;
                    self.bus.right[i] += r;
                }
                raise_peak(&self.status.backing_peak, peak);
                // What is heard: the anticipation queue still holds `ahead` of it.
                let speed = match &self.loaded {
                    Some(l) if backing.mix().linked => l.player.speed(),
                    _ => backing.mix().speed,
                };
                let heard = if backing.own_playing() || self.status.playing() { (backing.heard() - ahead * speed).max(0.0) } else { backing.heard() };
                self.status.backing_position.store(heard.to_bits(), Ordering::Release);
                self.status.backing_playing.store(backing.own_playing(), Ordering::Release);
            }
        }
        if let (Some(index), Some(loaded)) = (click_stem, &mut self.loaded) {
            let stem = &mut loaded.stems[index];
            if let Some(c) = &mut self.compensation {
                c.click.process(&mut stem.left[..frames], &mut stem.right[..frames]);
            }
            let mut peak = 0f32;
            for i in 0..frames {
                peak = peak.max(stem.left[i].abs()).max(stem.right[i].abs());
                self.bus.left[i] += stem.left[i];
                self.bus.right[i] += stem.right[i];
            }
            raise_peak(&self.status.click_peak, peak);
        }
        self.loaded.as_ref().is_some_and(|l| l.player.is_playing())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::song::*;
    use crate::synth::SoundFont;

    fn setup() -> Option<(Core, Control, Arc<SoundFont>)> {
        let bytes = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/alphatab/soundfont/sonivox.sf2")).ok()?;
        let font = Arc::new(SoundFont::new(&mut bytes.as_slice()).unwrap());
        let (core, control) = new_engine(48000);
        Some((core, control, font))
    }

    fn two_tracks() -> Arc<Song> {
        let mut events = vec![event(0, KIND_TEMPO, 0, 0, 0, 120_000, 0), event(0, KIND_PROGRAM, 0, 0, 0, 0, 0), event(0, KIND_PROGRAM, 1, 0, 0, 0, 1)];
        for beat in 0..8u32 {
            events.push(event(beat * 960, KIND_NOTE_ON, 0, 60, 100, 0, 0));
            events.push(event(beat * 960 + 900, KIND_NOTE_OFF, 0, 60, 0, 0, 0));
            events.push(event(beat * 960, KIND_NOTE_ON, 1, 52, 100, 0, 1));
            events.push(event(beat * 960 + 900, KIND_NOTE_OFF, 1, 52, 0, 0, 1));
        }
        events.push(event(7680, KIND_END, 0, 0, 0, 0, 0));
        Arc::new(Song::from_events(960, events))
    }

    fn load(control: &mut Control, font: &Arc<SoundFont>) {
        let player = Player::new(two_tracks(), font, Arc::new(crate::click::ClickBank::new(48000)), 48000).unwrap();
        assert!(control.send(Command::Load(Loaded::new(player))).is_ok());
    }

    /// Runs `callbacks` device callbacks of `block` frames, `wait` apart; returns the left
    /// channel and the reported position after each callback.
    fn run_callbacks(core: &mut Core, block: usize, callbacks: usize, wait: std::time::Duration) -> (Vec<f32>, Vec<f64>, Arc<Status>) {
        let status = core.status.clone();
        let mut out = vec![0f32; block * 2];
        let (mut left, mut positions) = (Vec::new(), Vec::new());
        for _ in 0..callbacks {
            core.process(&mut out, 2);
            left.extend(out.chunks(2).map(|f| f[0]));
            positions.push(status.position());
            std::thread::sleep(wait);
        }
        (left, positions, status)
    }

    #[test]
    fn anticipated_music_is_the_inline_music_later() {
        // A preview (no synth, so no block grid) through both paths: the same samples.
        let block = 64;
        let signal: Vec<f32> = (0..20000).map(|i| ((i * 37 % 101) as f32 - 50.0) / 500.0).collect();
        let mut runs = Vec::new();
        for ahead in [false, true] {
            let (mut core, mut control) = new_engine_with(48000, ahead);
            // Settle the master limiter on silence and let the thread fill its queue.
            let (_, _, status) = run_callbacks(&mut core, block, 200, std::time::Duration::from_millis(1));
            let short = status.music_short();
            assert!(control.send(Command::Preview(Preview::new(signal.clone(), signal.clone(), 0))).is_ok());
            let (left, _, status) = run_callbacks(&mut core, block, 600, std::time::Duration::from_micros(300));
            assert_eq!(status.music_short(), short, "the queue never ran dry");
            runs.push(left);
        }
        let first = |l: &[f32]| l.iter().position(|v| v.abs() > 1e-9).expect("the preview sounds");
        let (a, b) = (first(&runs[0]), first(&runs[1]));
        assert!(b >= a, "the queue only delays");
        for i in 0..runs[1].len() - b {
            assert!((runs[0][a + i] - runs[1][b + i]).abs() < 1e-6, "frame {i}: {} vs {}", runs[0][a + i], runs[1][b + i]);
        }
    }

    #[test]
    fn anticipated_song_reports_what_is_heard() {
        let Some((_, _, font)) = setup() else { return };
        let block = 64;
        let (mut core, mut control) = new_engine_with(48000, true);
        let (_, _, status) = run_callbacks(&mut core, block, 50, std::time::Duration::from_millis(1));
        let short = status.music_short();
        load(&mut control, &font);
        control.send(Command::Play).ok();
        let (left, positions, status) = run_callbacks(&mut core, block, 1500, std::time::Duration::from_micros(300));
        assert_eq!(status.music_short(), short, "the queue never ran dry while playing");
        // The first note is at the song start plus its attack (288 frames, as inline): the
        // position reported is what has been heard since then, to within one chunk.
        let start = left.iter().position(|v| v.abs() > 1e-6).expect("music sounds") - 288;
        for callback in [600, 1000, 1499] {
            let heard = ((callback + 1) * block).saturating_sub(start) as f64 / 48000.0;
            let reported = positions[callback];
            assert!((reported - heard).abs() <= (AHEAD_CHUNK + block) as f64 / 48000.0, "callback {callback}: reported {reported:.4} s, heard {heard:.4} s");
        }
    }

    #[test]
    fn plays_publishes_position_and_meters() {
        let Some((mut core, mut control, font)) = setup() else { return };
        load(&mut control, &font);
        control.send(Command::Play).ok();
        let mut out = vec![0f32; 480 * 2];
        for _ in 0..100 {
            core.process(&mut out, 2);
        }
        assert!((control.status.position() - 1.0).abs() < 1e-6);
        assert!(control.status.playing());
        assert!(control.status.take_track_peak(0) > 0.0);
        assert!(control.status.take_track_peak(1) > 0.0);
        assert_eq!(control.status.take_track_peak(0), 0.0, "meters reset when read");
        assert_eq!(control.status.frames(), 48000);
        let [l, r] = control.status.take_master_peak();
        assert!(l > 0.0 && r > 0.0 && l <= 1.0 && r <= 1.0);
    }

    #[test]
    fn mute_and_solo_remove_tracks_from_the_mix() {
        let Some((mut core, mut control, font)) = setup() else { return };
        load(&mut control, &font);
        control.send(Command::Play).ok();
        control.send(Command::Track(0, TrackMix { mute: true, ..Default::default() })).ok();
        control.send(Command::Track(1, TrackMix { mute: true, ..Default::default() })).ok();
        let mut out = vec![0f32; 4800 * 2];
        core.process(&mut out, 2);
        assert!(out.iter().all(|v| *v == 0.0), "everything muted");
        control.send(Command::Track(0, TrackMix::default())).ok();
        control.send(Command::Track(1, TrackMix { solo: true, ..Default::default() })).ok();
        core.process(&mut out, 2);
        assert!(out.iter().any(|v| *v != 0.0));
        assert_eq!(control.status.take_track_peak(0), 0.0, "track 0 is not soloed");
    }

    #[test]
    fn reload_keeps_the_transport_and_retires_the_old_song() {
        let Some((mut core, mut control, font)) = setup() else { return };
        load(&mut control, &font);
        control.send(Command::Play).ok();
        let mut out = vec![0f32; 4800 * 2];
        for _ in 0..5 {
            core.process(&mut out, 2);
        }
        load(&mut control, &font);
        core.process(&mut out, 2);
        assert!(control.status.playing());
        assert!((control.status.position() - 0.6).abs() < 1e-6);
        // Speed carries over a reload too.
        control.send(Command::Speed(0.5)).ok();
        core.process(&mut out, 2);
        load(&mut control, &font);
        core.process(&mut out, 2);
        // 0.6 s, then two 0.1 s blocks at half speed (one before, one after the reload).
        assert!((control.status.position() - 0.7).abs() < 1e-6, "{}", control.status.position());
        control.collect_garbage();
        assert!(control.retired.is_empty());
    }

    #[test]
    fn large_device_buffers_and_mono_outputs_work() {
        let Some((mut core, mut control, font)) = setup() else { return };
        load(&mut control, &font);
        control.send(Command::Play).ok();
        let mut out = vec![0f32; MAX_BLOCK * 3];
        core.process(&mut out, 1);
        assert!((control.status.position() - (MAX_BLOCK * 3) as f64 / 48000.0).abs() < 1e-6);
        assert!(out.iter().any(|v| *v != 0.0));
    }

    #[test]
    fn metronome_and_count_in_reach_the_output() {
        let Some((mut core, mut control, font)) = setup() else { return };
        load(&mut control, &font);
        control.send(Command::Metronome(Metronome { enabled: true, kind: crate::click::KIND_WOOD, volume: 0.5 })).ok();
        control.send(Command::Track(0, TrackMix { mute: true, ..Default::default() })).ok();
        control.send(Command::Track(1, TrackMix { mute: true, ..Default::default() })).ok();
        control.send(Command::CountIn(CountIn::new(&[(0.0, true), (0.5, false)], 1.0, 48000))).ok();
        let mut out = vec![0f32; 4800 * 2];
        core.process(&mut out, 2);
        assert!(control.status.counting());
        assert!(control.status.take_click_peak() > 0.0, "count click");
        assert!(out.iter().any(|v| *v != 0.0), "clicks are heard even with every track muted");
        for _ in 0..10 {
            core.process(&mut out, 2);
        }
        assert!(!control.status.counting());
        assert!(control.status.playing());
    }

    #[test]
    fn the_standalone_metronome_clicks_without_moving_the_song() {
        let Some((mut core, mut control, font)) = setup() else { return };
        load(&mut control, &font);
        control.send(Command::Metronome(Metronome { enabled: false, kind: crate::click::KIND_WOOD, volume: 0.5 })).ok();
        control.send(Command::FreeClick(Some(FreeClick::new(0.05, 4, 48000)))).ok();
        let mut out = vec![0f32; 4800 * 2];
        for _ in 0..3 {
            core.process(&mut out, 2);
            assert!(control.status.take_click_peak() > 0.0, "clicks keep coming with the click switched off");
        }
        assert!(!control.status.playing() && !control.status.counting());
        assert_eq!(control.status.position(), 0.0);
        control.send(Command::Play).ok();
        control.send(Command::Pause).ok();
        core.process(&mut out, 2);
        control.status.take_click_peak();
        for _ in 0..3 {
            core.process(&mut out, 2);
        }
        assert_eq!(control.status.take_click_peak(), 0.0, "song playback stopped it");
    }

    #[test]
    fn previews_render_offline_and_play_once_through_the_track_mix() {
        let Some((mut core, mut control, font)) = setup() else { return };
        let events = vec![event(0, KIND_PROGRAM, 0, 0, 0, 0, 0), event(0, KIND_NOTE_ON, 0, 60, 100, 0, 0), event(480, KIND_NOTE_OFF, 0, 60, 0, 0, 0), event(960, KIND_END, 0, 0, 0, 0, 0)];
        let player = Player::new(Arc::new(Song::from_events(960, events)), &font, Arc::new(crate::click::ClickBank::new(48000)), 48000).unwrap();
        let (left, right) = render_offline(player, 48000, 5.0);
        assert!(left.len() > 24000 && left.len() < 48000 * 2, "note + release, silence trimmed: {}", left.len());
        assert!(left.iter().any(|v| v.abs() > 0.01));
        let frames = left.len();
        control.send(Command::Preview(Preview::new(left, right, 0))).ok();
        let mut out = vec![0f32; 4800 * 2];
        core.process(&mut out, 2);
        assert!(out.iter().any(|v| *v != 0.0), "plays without a song loaded or playing");
        for _ in 0..(frames / 4800 + 1) {
            core.process(&mut out, 2);
        }
        assert!(core.music().preview.is_none(), "finished previews are retired");
        // A muted track mutes its preview.
        control.send(Command::Track(0, TrackMix { mute: true, ..Default::default() })).ok();
        control.send(Command::Preview(Preview::new(vec![0.5; 4800], vec![0.5; 4800], 0))).ok();
        core.process(&mut out, 2);
        assert!(out.iter().all(|v| *v == 0.0));
        control.collect_garbage();
    }

    #[test]
    fn master_chain_limits_loud_input_like_the_webaudio_limiter() {
        let mut limiter = master_limiter(48000);
        let (mut l, mut r) = (vec![2.0f32; 48000], vec![-2.0f32; 48000]);
        limiter.process(&mut l, &mut r);
        // After the attack, a +6 dBFS input sits near the -3 dB threshold (plus makeup gain).
        assert!(l[47000].abs() < 1.0 && l[47000].abs() > 0.5, "{}", l[47000]);
    }

    #[test]
    fn reverb_send_reaches_the_bus_and_the_master_switch_mutes_it() {
        let Some((mut core, mut control, font)) = setup() else { return };
        load(&mut control, &font);
        control.send(Command::Play).ok();
        control.send(Command::Track(0, TrackMix { mute: true, ..Default::default() })).ok();
        control.send(Command::Track(1, TrackMix { gain: 1.0, send: 1.0, ..Default::default() })).ok();
        let mut out = vec![0f32; 4800 * 2];
        for _ in 0..5 {
            core.process(&mut out, 2);
        }
        // Stop the dry signal: the reverb tail remains.
        control.send(Command::Track(1, TrackMix { mute: true, send: 1.0, ..Default::default() })).ok();
        core.process(&mut out, 2);
        core.process(&mut out, 2);
        let tail = out.iter().fold(0f32, |m, v| m.max(v.abs()));
        control.send(Command::Bus { gain: 1.0, reverb: false }).ok();
        core.process(&mut out, 2);
        // Skip the limiter's 6 ms look-ahead, which still holds the previous output.
        let off = out[600 * 2..].iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(tail > 1e-4, "reverb tail {tail}");
        assert!(off < tail / 10.0, "master reverb off {off} vs {tail}");
    }

    #[test]
    fn track_fx_are_swapped_in_and_the_old_chain_retired() {
        let Some((mut core, mut control, font)) = setup() else { return };
        load(&mut control, &font);
        control.send(Command::Play).ok();
        control.send(Command::TrackFx(0, Box::new(FxChain::new(&[(crate::fx::FxKind::Delay, 1.0)], 48000.0)))).ok();
        control.send(Command::TrackFx(0, Box::new(FxChain::new(&[(crate::fx::FxKind::Eq, 1.0)], 48000.0)))).ok();
        let mut out = vec![0f32; 4800 * 2];
        core.process(&mut out, 2);
        assert!(core.music().fx[0].is_some());
        control.collect_garbage();
        assert!(control.retired_fx.is_empty());
    }

    #[test]
    fn parallel_track_rendering_gives_the_same_samples() {
        let Some((_, _, font)) = setup() else { return };
        let render = |helpers: usize| {
            let (mut core, mut control) = new_engine(48000);
            core.music().pool = Some(Arc::new(crate::pool::Pool::new(helpers)));
            load(&mut control, &font);
            // Every strip busy: NAM on track 0 (when the model is here), insert FX everywhere.
            if let Ok(json) = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/nam/deluxe-a2.nam")) {
                let runtime = crate::nam::NamRuntime::new(None).unwrap();
                let amp = crate::nam::NamAmp::new(&runtime, &json, 48000.0).unwrap();
                control.send(Command::TrackNam(0, Some(Box::new(NamStage::new(amp, NamTone { cabinet: true, ..NamTone::default() }, 48000.0))))).ok();
            }
            for t in 0..2 {
                use crate::fx::FxKind::*;
                control.send(Command::TrackFx(t, Box::new(FxChain::new(&[(Eq, 0.7), (Compressor, 0.5), (Delay, 0.3)], 48000.0)))).ok();
                control.send(Command::Track(t, TrackMix { pan: if t == 0 { -0.5 } else { 0.4 }, send: 0.3, ..Default::default() })).ok();
            }
            control.send(Command::Play).ok();
            let mut out = vec![0f32; 480 * 2];
            let mut all = Vec::new();
            for _ in 0..200 {
                core.process(&mut out, 2);
                all.extend_from_slice(&out);
            }
            all
        };
        let serial = render(0);
        assert!(serial.iter().any(|v| v.abs() > 1e-4));
        assert_eq!(serial, render(3));
    }

    #[test]
    fn external_effects_run_through_the_link_and_the_mix_is_compensated() {
        use tabstudio_fxlink::{HostEnd, LATENCY, Shared};
        let Some((mut core, mut control, font)) = setup() else { return };
        load(&mut control, &font);
        let name = format!("engine-test-{}", std::process::id());
        let shared = Arc::new(Shared::create(&name, 48000.0).unwrap());
        // A stand-in for tabstudio-fx-host: silences the left channel.
        #[cfg(windows)]
        let host_side = Shared::open(&name).unwrap();
        #[cfg(not(windows))]
        let host_side = return;
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let host = std::thread::spawn(move || {
            let mut end = HostEnd::new(host_side, 512);
            while !flag.load(Ordering::Relaxed) {
                end.pump(5, 0, |l, _| l.fill(0.0));
            }
        });
        let chain = crate::fx::FxChain::build(vec![crate::fx::ChainItem::External(shared.clone(), true)], 48000.0);
        assert_eq!(chain.externals(), 1);
        control.send(Command::TrackFx(0, Box::new(chain))).ok();
        control.send(Command::Compensation(Box::new(Compensation::new(&[1, 0], LATENCY)))).ok();
        control.send(Command::Track(1, TrackMix { mute: true, ..Default::default() })).ok();
        control.send(Command::Play).ok();
        let mut out = vec![0f32; 480 * 2];
        let mut frames = Vec::new();
        for _ in 0..40 {
            core.process(&mut out, 2);
            frames.extend(out.chunks(2).map(|f| (f[0], f[1])));
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        stop.store(true, Ordering::Relaxed);
        host.join().unwrap();
        // Nothing for LATENCY frames, then the effect's output (left silenced, right sounding).
        assert!(frames[..LATENCY].iter().all(|f| *f == (0.0, 0.0)));
        assert!(frames[LATENCY..].iter().any(|f| f.1.abs() > 1e-4));
        assert!(frames.iter().all(|f| f.0.abs() < 1e-6), "left is silenced by the effect");
        // The cursor reports what is heard: LATENCY frames behind the song position.
        let heard = control.status.position();
        assert!((heard - (40.0 * 480.0 - LATENCY as f64) / 48000.0).abs() < 1e-6, "{heard}");
    }

    #[test]
    fn nam_heads_the_strip_and_pans_its_mono_signal() {
        let Some((mut core, mut control, font)) = setup() else { return };
        let Ok(json) = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/nam/deluxe-a2.nam")) else { return };
        load(&mut control, &font);
        let runtime = crate::nam::NamRuntime::new(None).unwrap();
        let stage = |tone| Box::new(NamStage::new(crate::nam::NamAmp::new(&runtime, &json, 48000.0).unwrap(), tone, 48000.0));
        control.send(Command::Play).ok();
        control.send(Command::Track(1, TrackMix { mute: true, ..Default::default() })).ok();
        // Hard left: a mono input keeps nothing on the right (a stereo one would keep its left half).
        control.send(Command::Track(0, TrackMix { pan: -1.0, ..Default::default() })).ok();
        control.send(Command::TrackNamTone(0, NamTone { output: 0.0, ..NamTone::default() })).ok();
        control.send(Command::TrackNam(0, Some(stage(NamTone::default())))).ok();
        let mut out = vec![0f32; 4800 * 2];
        core.process(&mut out, 2);
        assert!(core.music().nam[0].is_some());
        assert!(out.chunks(2).any(|f| f[0].abs() > 1e-4));
        assert!(out.chunks(2).all(|f| f[1].abs() < 1e-7));
        // The replaced amp is retired to the control side; removing it restores the plain strip.
        control.send(Command::TrackNam(0, Some(stage(NamTone::default())))).ok();
        control.send(Command::TrackNam(0, None)).ok();
        core.process(&mut out, 2);
        assert!(core.music().nam[0].is_none());
        control.collect_garbage();
        assert!(control.retired_nam.is_empty());
    }


    /// A backing file with a one-sample click every `every` frames (48 kHz).
    fn click_file(seconds: f64, every: usize) -> std::sync::Arc<crate::backing::BackingAudio> {
        let frames = (seconds * 48000.0) as usize;
        let mut samples = vec![0i16; frames * 2];
        for at in (0..frames).step_by(every) {
            samples[at * 2] = 16000;
            samples[at * 2 + 1] = 16000;
        }
        std::sync::Arc::new(crate::backing::BackingAudio { samples, rate: 48000, source_rate: 48000, source_channels: 2, codec: "test".into(), lufs: None, peaks: Vec::new() })
    }

    /// Runs the core in `block`-frame buffers, collecting what the backing strip produced and
    /// the frames where the player wrapped a loop.
    fn backing_output(core: &mut Core, blocks: usize, block: usize) -> (Vec<f32>, Vec<usize>) {
        let mut out = vec![0f32; block * 2];
        let (mut heard, mut wraps) = (Vec::new(), Vec::new());
        for _ in 0..blocks {
            core.process(&mut out, 2);
            let player = &core.music().loaded.as_ref().unwrap().player;
            wraps.extend(player.marks().iter().skip(1).filter(|m| m.2).map(|m| heard.len() + m.0));
            heard.extend_from_slice(&core.music().backing_stem.left[..block]);
        }
        (heard, wraps)
    }

    fn onsets(samples: &[f32]) -> Vec<usize> {
        samples.iter().enumerate().filter(|(_, v)| v.abs() > 0.2).map(|(i, _)| i).collect()
    }

    #[test]
    fn the_backing_track_starts_on_the_count_in_frame_and_wraps_with_the_loop() {
        let Some((mut core, mut control, font)) = setup() else { return };
        load(&mut control, &font);
        // Clicks every 0.1 s; the score starts 0.05 s into the file.
        let audio = click_file(10.0, 4800);
        control.send(Command::Backing(Some(Backing::new(audio, BackingMix::default())))).ok();
        control.send(Command::BackingMix(BackingMix { offset: 0.05, ..Default::default() })).ok();
        // A count-in of 0.3 s: silence, then the file from 0.05 s on the exact frame 14400.
        control.send(Command::CountIn(CountIn::new(&[(0.0, true)], 0.3, 48000))).ok();
        let (heard, _) = backing_output(&mut core, 60, 500);
        assert!(heard[..14400].iter().all(|v| *v == 0.0));
        // File clicks at 0.1, 0.2 s are heard 0.05 s, 0.15 s after the song starts.
        assert_eq!(&onsets(&heard)[..3], &[14400 + 2400, 14400 + 7200, 14400 + 12000]);
        // A loop 0.5..0.8 s of song time: after each wrap the file is back at 0.55 s, whose
        // clicks (0.6, 0.7, 0.8 s) come 0.05, 0.15, 0.25 s into the loop.
        control.send(Command::Seek(0.5)).ok();
        control.send(Command::Loop(Some((0.5, 0.8)), None)).ok();
        let (heard, wraps) = backing_output(&mut core, 60, 500);
        assert!(wraps.len() >= 2, "{wraps:?}");
        for pair in wraps.windows(2) {
            assert_eq!(onsets(&heard[pair[0]..pair[1]]), vec![2400, 7200, 12000], "after the wrap at {}", pair[0]);
        }
        // Mute silences the strip; solo silences the tracks instead.
        control.send(Command::BackingMix(BackingMix { offset: 0.05, solo: true, ..Default::default() })).ok();
        let mut out = vec![0f32; 4800 * 2];
        core.process(&mut out, 2);
        control.status.take_track_peak(0);
        control.status.take_backing_peak();
        core.process(&mut out, 2);
        assert_eq!(control.status.take_track_peak(0), 0.0, "tracks are muted by the backing solo");
        assert!(control.status.take_backing_peak() > 0.0);
        control.send(Command::BackingMix(BackingMix { offset: 0.05, mute: true, ..Default::default() })).ok();
        core.process(&mut out, 2);
        control.status.take_backing_peak();
        core.process(&mut out, 2);
        assert_eq!(control.status.take_backing_peak(), 0.0);
        // On its own transport it plays without the song playing.
        control.send(Command::Pause).ok();
        control.send(Command::BackingMix(BackingMix { linked: false, ..Default::default() })).ok();
        control.send(Command::BackingTransport(BackingTransport::Seek(2.0))).ok();
        control.send(Command::BackingTransport(BackingTransport::Play)).ok();
        core.process(&mut out, 2);
        control.status.take_backing_peak();
        core.process(&mut out, 2);
        assert!(!control.status.playing() && control.status.backing_playing());
        assert!(control.status.take_backing_peak() > 0.0);
        assert!((control.status.backing_position() - 2.2).abs() < 1e-6, "{}", control.status.backing_position());
        // A song reload (an edit) keeps the backing track.
        load(&mut control, &font);
        core.process(&mut out, 2);
        assert!(core.music().backing.is_some());
        control.send(Command::Backing(None)).ok();
        core.process(&mut out, 2);
        assert!(core.music().backing.is_none());
        control.collect_garbage();
    }

    #[test]
    fn the_instrument_monitor_plays_through_the_engine_and_keeps_its_chain_when_the_device_reopens() {
        use crate::fx::{FxChain, FxKind};
        use crate::live::{LiveStatus, live_parts};
        let rate = 48000u32;
        let (mut core, mut control) = new_engine(rate);
        let sine = |n: usize| (0..n).map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 1200.0 / rate as f32).sin() * 0.1).collect::<Vec<f32>>();
        let peak = |out: &[f32]| out.iter().fold(0f32, |m, v| m.max(v.abs()));
        let status = LiveStatus::new();
        let mut parts = live_parts(status.clone(), 256, MAX_BLOCK);
        control.send(Command::Live(Some(parts.stage))).ok().unwrap();
        let mut out = vec![0f32; 512 * 2];
        let mut run = |tap: &mut crate::live::InputTap, core: &mut Core| {
            let mut last = 0f32;
            for _ in 0..20 {
                tap.push(&sine(512), 1);
                out.fill(0.0);
                core.process(&mut out, 2);
                last = peak(&out);
            }
            last
        };
        let dry = run(&mut parts.tap, &mut core);
        // (The master limiter adds its makeup gain, as in the WebAudio build.)
        assert!(dry > 0.08 && dry < 0.2, "monitor plays the input: {dry}");
        // EQ +12 dB at 1200 Hz: the chain is heard.
        control.send(Command::LiveFx(Some(Box::new(FxChain::new(&[(FxKind::Eq, 1.0)], rate as f64))))).ok().unwrap();
        let boosted = run(&mut parts.tap, &mut core);
        assert!(boosted > dry * 2.5, "chain applied: {boosted}");
        // The device reopens with new rings: the chain stays.
        let mut again = live_parts(status.clone(), 256, MAX_BLOCK);
        control.send(Command::Live(Some(again.stage))).ok().unwrap();
        let reopened = run(&mut again.tap, &mut core);
        assert!((reopened - boosted).abs() < boosted * 0.1, "chain kept: {reopened} vs {boosted}");
        // Input off: silence, and the old stage is handed back for freeing.
        control.send(Command::Live(None)).ok().unwrap();
        assert!(run(&mut again.tap, &mut core) < 1e-6);
        control.collect_garbage();
    }
}
