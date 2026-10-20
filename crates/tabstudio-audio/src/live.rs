//! Instrument input: the monitor (input -> amp/plugins -> output) and the feeds for the
//! always-on recorder (docs/live-input.md).
//!
//! Real-time side (no allocation, no locks):
//! - `InputTap` runs in the input device callback: picks the instrument channel, meters it
//!   and pushes the dry (DI) samples to the monitor ring and, while recording, to the
//!   recorder ring.
//! - `LiveStage` runs inside the engine's output callback: takes the dry samples (keeping at
//!   most `keep` frames waiting, so a drifting input clock cannot grow the delay), runs them
//!   through the NAM amp and the insert chain, mixes the result into the output and, while
//!   recording, pushes what was heard ("wet") 1:1 with the dry samples it consumed.
//!   It also plays back history (`Replay`).
//! The recorder thread (recorder.rs) owns the history and the files.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};

use crate::fx::FxChain;
use crate::nam::NamStage;

/// Ring sizes between the threads (frames, mono). 2^17 is 2.7 s at 48 kHz: enough for the
/// recorder thread to be late by a second without losing audio.
pub const RECORD_RING: usize = 1 << 17;
const MONITOR_RING: usize = 1 << 14;
/// The latest input samples kept for the tuner (0.17 s at 48 kHz).
pub const SCOPE_LEN: usize = 1 << 13;
/// Silence (no input) for longer than this marks the input as stalled (frames).
pub const NO_POSITION: u64 = u64::MAX;

/// What the UI reads (floats as bits; peaks reset when read).
#[derive(Default)]
pub struct LiveStatus {
    input_peak: AtomicU32,
    monitor_peak: AtomicU32,
    /// Input frames that did not fit the monitor ring (the engine stopped taking them).
    pub overflows: AtomicU64,
    /// Output frames the monitor had no input for.
    pub underruns: AtomicU64,
    /// Waiting input frames dropped to keep the delay short (clock drift).
    pub trimmed: AtomicU64,
    /// Dry frames the recorder ring could not take (the recorder thread was too slow).
    pub record_overflows: AtomicU64,
    /// Total input frames seen (the timeline clock is the recorder's count of these).
    pub captured: AtomicU64,
    /// Last input callback size (frames).
    pub input_block: AtomicU64,
    /// Frames waiting between input and monitor at the last output block.
    pub held: AtomicU64,
    /// Timeline frame being replayed (NO_POSITION when not replaying).
    pub replay_at: AtomicU64,
    /// The recorder takes dry/wet samples only while this is on (setting "liveRecording").
    pub recording: AtomicBool,
    /// Also record what was heard (amp/plugin output); off: only the DI.
    pub record_wet: AtomicBool,
    /// Which input channel is the instrument (0-based).
    pub channel: AtomicU32,
    /// Input callbacks seen (a sign of life for the UI).
    pub input_callbacks: AtomicU64,
    /// Round-trip measurement: set to ask for one; the result is frames from the click
    /// leaving the engine to it coming back through the input and reaching the output
    /// (PING_NONE: none yet, PING_TIMEOUT: not heard within a second).
    pub ping_request: AtomicBool,
    pub ping_result: AtomicI64,
    /// Input level (f32 bits) that counts as the click coming back; 0 (the default): eight
    /// times the input's own noise just before the click, at least PING_FLOOR and at most 0.2,
    /// so a quiet loopback (headphones turned down against feedback) is still heard.
    pub ping_threshold: AtomicU32,
    /// The latest dry samples of the instrument channel (the tuner reads them).
    pub scope: Scope,
}

/// The latest input samples, written by the input callback without locks. A reader racing a
/// callback may get a few samples of the next block among the last ones: harmless for a tuner.
pub struct Scope {
    samples: Box<[AtomicU32]>,
    end: AtomicU64,
}

impl Default for Scope {
    fn default() -> Scope {
        Scope { samples: (0..SCOPE_LEN).map(|_| AtomicU32::new(0)).collect(), end: AtomicU64::new(0) }
    }
}

impl Scope {
    fn write(&self, at: u64, value: f32) {
        self.samples[(at % SCOPE_LEN as u64) as usize].store(value.to_bits(), Ordering::Relaxed);
    }

    /// The last `frames` samples (fewer when the input has not delivered that many yet).
    pub fn recent(&self, frames: usize) -> Vec<f32> {
        let end = self.end.load(Ordering::Acquire);
        let n = (frames.min(SCOPE_LEN) as u64).min(end);
        (end - n..end).map(|at| f32::from_bits(self.samples[(at % SCOPE_LEN as u64) as usize].load(Ordering::Relaxed))).collect()
    }
}

pub const PING_NONE: i64 = i64::MIN;
/// Least level a returning click must reach (-50 dBFS).
pub const PING_FLOOR: f32 = 0.003;
pub const PING_TIMEOUT: i64 = -1;

impl LiveStatus {
    pub fn new() -> Arc<LiveStatus> {
        let status = LiveStatus::default();
        status.replay_at.store(NO_POSITION, Ordering::Relaxed);
        status.ping_result.store(PING_NONE, Ordering::Relaxed);

        status.record_wet.store(true, Ordering::Relaxed);
        Arc::new(status)
    }
    pub fn take_input_peak(&self) -> f32 {
        f32::from_bits(self.input_peak.swap(0, Ordering::AcqRel))
    }
    pub fn take_monitor_peak(&self) -> f32 {
        f32::from_bits(self.monitor_peak.swap(0, Ordering::AcqRel))
    }
    pub fn replay_position(&self) -> Option<u64> {
        match self.replay_at.load(Ordering::Acquire) {
            NO_POSITION => None,
            at => Some(at),
        }
    }
}

fn raise(slot: &AtomicU32, value: f32) {
    let mut current = slot.load(Ordering::Relaxed);
    while value > f32::from_bits(current) {
        match slot.compare_exchange_weak(current, value.to_bits(), Ordering::AcqRel, Ordering::Relaxed) {
            Ok(_) => break,
            Err(seen) => current = seen,
        }
    }
}

/// The input device callback's end.
pub struct InputTap {
    monitor: rtrb::Producer<f32>,
    record: rtrb::Producer<f32>,
    status: Arc<LiveStatus>,
}

impl InputTap {
    /// `data` is interleaved with `channels` per frame.
    pub fn push(&mut self, data: &[f32], channels: usize) {
        let channels = channels.max(1);
        let frames = data.len() / channels;
        let channel = (self.status.channel.load(Ordering::Relaxed) as usize).min(channels - 1);
        let recording = self.status.recording.load(Ordering::Relaxed);
        let mut peak = 0f32;
        let (mut lost, mut record_lost) = (0u64, 0u64);
        let scope_at = self.status.scope.end.load(Ordering::Relaxed);
        for f in 0..frames {
            let v = data[f * channels + channel];
            self.status.scope.write(scope_at + f as u64, v);
            peak = peak.max(v.abs());
            if self.monitor.push(v).is_err() {
                lost += 1;
            }
            if recording && self.record.push(v).is_err() {
                record_lost += 1;
            }
        }
        let s = &self.status;
        raise(&s.input_peak, peak);
        if lost > 0 {
            s.overflows.fetch_add(lost, Ordering::Relaxed);
        }
        if record_lost > 0 {
            s.record_overflows.fetch_add(record_lost, Ordering::Relaxed);
        }
        s.scope.end.store(scope_at + frames as u64, Ordering::Release);
        s.captured.fetch_add(frames as u64, Ordering::Relaxed);
        s.input_block.store(frames as u64, Ordering::Relaxed);
        s.input_callbacks.fetch_add(1, Ordering::Relaxed);
    }
}

/// The monitor's levels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiveMix {
    /// Input gain before the amp (dB).
    pub input_db: f32,
    /// Monitor level (linear) into the output.
    pub level: f32,
    /// Monitor off: the input is still taken (and recorded) but not heard.
    pub monitor: bool,
}

impl Default for LiveMix {
    fn default() -> Self {
        LiveMix { input_db: 0.0, level: 1.0, monitor: true }
    }
}

/// What a history replay plays.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ReplaySource {
    /// What was heard (amp/plugin output); falls back to dry when no wet was recorded.
    Wet,
    /// The DI as recorded, unprocessed.
    Dry,
    /// The DI through the current amp and plugins (re-amp).
    Reamp,
}

/// A snapshot of the history being played back (built on the control side).
pub struct Replay {
    pub dry: Vec<f32>,
    pub wet: Vec<f32>,
    /// Timeline frame of dry[0].
    pub origin: u64,
    pub position: usize,
    /// Loop the snapshot instead of stopping at its end.
    pub looping: bool,
    pub source: ReplaySource,
    pub gain: f32,
    /// Hold until the score starts playing (the app starts it), then begin on that block,
    /// so the take and the score line up.
    pub wait_for_song: bool,
}

/// The monitor inside the engine's output callback.
pub struct LiveStage {
    input: rtrb::Consumer<f32>,
    wet: rtrb::Producer<f32>,
    status: Arc<LiveStatus>,
    mix: LiveMix,
    gain: f32,
    pub(crate) nam: Option<Box<NamStage>>,
    pub(crate) fx: Option<Box<FxChain>>,
    pub(crate) replay: Option<Box<Replay>>,
    left: Vec<f32>,
    right: Vec<f32>,
    /// Most input frames left waiting after a block (the rest is dropped at once).
    keep: usize,
    /// Smallest surplus (input waiting beyond the block) seen in this window: audio that
    /// waited the whole window only adds delay, so it is dropped at the window's end.
    min_surplus: usize,
    window_left: usize,
    /// Output frames produced (the clock for the round-trip measurement).
    produced: u64,
    /// The measurement click: when it left (output frame), and the give-up frame.
    ping: Option<(u64, u64)>,
    /// The level the click must reach (set when it goes out).
    ping_threshold: f32,
    /// The input's recent peak (decaying, halving every 0.1 s): its noise when nothing plays.
    noise: f32,
    click_next: bool,
}

/// Frames per surplus window (0.5 s at 48 kHz) and the margin kept against jitter.
const WINDOW: usize = 24000;
const MARGIN: usize = 32;

/// The four ends of a live input: the tap for the input callback, the stage for the engine,
/// and the recorder's two consumers (dry, wet).
pub struct LiveParts {
    pub tap: InputTap,
    pub stage: Box<LiveStage>,
    pub dry: rtrb::Consumer<f32>,
    pub wet: rtrb::Consumer<f32>,
}

/// `keep`: input frames allowed to wait (about one input block plus one output block).
pub fn live_parts(status: Arc<LiveStatus>, keep: usize, max_block: usize) -> LiveParts {
    let (monitor_tx, monitor_rx) = rtrb::RingBuffer::new(MONITOR_RING);
    let (dry_tx, dry_rx) = rtrb::RingBuffer::new(RECORD_RING);
    let (wet_tx, wet_rx) = rtrb::RingBuffer::new(RECORD_RING);
    let tap = InputTap { monitor: monitor_tx, record: dry_tx, status: status.clone() };
    let stage = Box::new(LiveStage {
        input: monitor_rx,
        wet: wet_tx,
        status,
        mix: LiveMix::default(),
        gain: 1.0,
        nam: None,
        fx: None,
        replay: None,
        left: vec![0.0; max_block],
        right: vec![0.0; max_block],
        keep: keep.max(1),
        min_surplus: usize::MAX,
        window_left: WINDOW,
        produced: 0,
        ping: None,
        ping_threshold: 0.2,
        noise: 0.0,
        click_next: false,
    });
    LiveParts { tap, stage, dry: dry_rx, wet: wet_rx }
}

impl LiveStage {
    pub fn set_mix(&mut self, mix: LiveMix) {
        self.mix = mix;
        self.gain = 10f32.powf(mix.input_db.clamp(-40.0, 40.0) / 20.0);
    }

    /// Adds this block's monitor (and replay) to `out_l`/`out_r` (`frames` <= max block).
    /// `song_playing`: the score is playing this block (starts a replay waiting for it).
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32], frames: usize, song_playing: bool) {
        let frames = frames.min(self.left.len()).min(out_l.len()).min(out_r.len());
        let status = &*self.status;
        let recording = status.recording.load(Ordering::Relaxed) && status.record_wet.load(Ordering::Relaxed);
        // 1. Drop what waits beyond `keep` + this block (the input clock runs ahead).
        let waiting = self.input.slots();
        let allowed = self.keep + frames;
        if waiting > allowed {
            let drop = waiting - allowed;
            if let Ok(chunk) = self.input.read_chunk(drop) {
                chunk.commit_all();
            }
            status.trimmed.fetch_add(drop as u64, Ordering::Relaxed);
            if recording {
                // Keep wet aligned 1:1 with dry: the dropped input was not heard.
                for _ in 0..drop {
                    let _ = self.wet.push(0.0);
                }
            }
        }
        // Steady surplus: what waited through a whole window (startup backlog, a faster
        // input clock) goes, so the monitor delay settles at the block plus MARGIN.
        let waiting = self.input.slots();
        self.min_surplus = self.min_surplus.min(waiting.saturating_sub(frames));
        self.window_left = self.window_left.saturating_sub(frames);
        if self.window_left == 0 {
            let drop = self.min_surplus.saturating_sub(MARGIN).min(waiting.saturating_sub(frames));
            if drop > 0 {
                if let Ok(chunk) = self.input.read_chunk(drop) {
                    chunk.commit_all();
                }
                status.trimmed.fetch_add(drop as u64, Ordering::Relaxed);
                if recording {
                    for _ in 0..drop {
                        let _ = self.wet.push(0.0);
                    }
                }
            }
            self.min_surplus = usize::MAX;
            self.window_left = WINDOW;
        }
        status.held.store(self.input.slots() as u64, Ordering::Relaxed);
        // 2. Input (gained) and, for a re-amp replay, the replayed DI.
        let (l, r) = (&mut self.left[..frames], &mut self.right[..frames]);
        let mut taken = 0;
        let mut missing = 0u64;
        let mut heard = None;
        let threshold = self.ping_threshold;
        let mut block_peak = 0f32;
        for i in 0..frames {
            let v = match self.input.pop() {
                Ok(v) => {
                    taken += 1;
                    block_peak = block_peak.max(v.abs());
                    if self.ping.is_some() && heard.is_none() && v.abs() > threshold {
                        heard = Some(i);
                    }
                    v * self.gain
                }
                Err(_) => {
                    missing += 1;
                    0.0
                }
            };
            l[i] = v;
        }
        if missing > 0 && missing < frames as u64 {
            status.underruns.fetch_add(missing, Ordering::Relaxed);
        }
        let mut replay_out = None;
        if let Some(replay) = self.replay.as_mut().filter(|r| r.wait_for_song && song_playing) {
            replay.wait_for_song = false;
        }
        if let Some(replay) = self.replay.as_mut().filter(|r| !r.wait_for_song) {
            let len = replay.dry.len();
            if replay.position >= len && replay.looping && len > 0 {
                replay.position = 0;
            }
            let n = (len.saturating_sub(replay.position)).min(frames);
            match replay.source {
                ReplaySource::Reamp => {
                    for i in 0..n {
                        l[i] += replay.dry[replay.position + i] * self.gain * replay.gain;
                    }
                }
                ReplaySource::Wet | ReplaySource::Dry => replay_out = Some(n),
            }
            status.replay_at.store(replay.origin + replay.position as u64, Ordering::Release);
        }
        r.copy_from_slice(l);
        // 3. Amp and plugins.
        if let Some(nam) = &mut self.nam {
            nam.process(l, r);
        }
        if let Some(fx) = &mut self.fx {
            fx.process(l, r);
        }
        // 4. What was heard goes to the recorder, one wet sample per dry sample taken.
        if recording {
            for i in 0..taken.min(frames) {
                let _ = self.wet.push(if self.mix.monitor { 0.5 * (l[i] + r[i]) } else { 0.0 });
            }
        }
        // The round trip: the click comes back as input; it would reach the output now.
        if let Some((sent, give_up)) = self.ping {
            match heard {
                Some(i) => {
                    status.ping_result.store((self.produced + i as u64 - sent) as i64, Ordering::Release);
                    self.ping = None;
                }
                None if self.produced >= give_up => {
                    status.ping_result.store(PING_TIMEOUT, Ordering::Release);
                    self.ping = None;
                }
                None => {}
            }
        }
        // 5. Into the output (the monitor is silent while a click is out, so it cannot ring).
        let level = if self.mix.monitor && self.ping.is_none() { self.mix.level } else { 0.0 };
        let mut peak = 0f32;
        for i in 0..frames {
            let (a, b) = (l[i] * level, r[i] * level);
            peak = peak.max(a.abs()).max(b.abs());
            out_l[i] += a;
            out_r[i] += b;
        }
        if let (Some(n), Some(replay)) = (replay_out, self.replay.as_mut().filter(|r| !r.wait_for_song)) {
            let wet = replay.source == ReplaySource::Wet && replay.wet.len() >= replay.dry.len();
            for i in 0..n {
                let at = replay.position + i;
                let v = if wet { replay.wet[at] } else { replay.dry[at] } * replay.gain;
                out_l[i] += v;
                out_r[i] += v;
            }
        }
        if let Some(replay) = self.replay.as_mut().filter(|r| !r.wait_for_song) {
            let n = replay.dry.len().saturating_sub(replay.position).min(frames);
            replay.position += n;
        }
        raise(&status.monitor_peak, peak);
        if self.ping.is_none() {
            self.noise = block_peak.max(self.noise * 0.5f32.powf(frames as f32 / 4800.0));
        }
        if self.ping.is_none() && status.ping_request.swap(false, Ordering::AcqRel) {
            let set = f32::from_bits(status.ping_threshold.load(Ordering::Relaxed));
            self.ping_threshold = if set > 0.0 { set } else { (self.noise * 8.0).clamp(PING_FLOOR, 0.2) };
            // The click goes out on the next block's first frame.
            // Give up after 48000 frames (a second at 48 kHz).
            self.ping = Some((self.produced + frames as u64, self.produced + frames as u64 + 48000));
            self.click_next = true;
        } else if self.click_next {
            self.click_next = false;
            out_l[0] += 0.9;
            out_r[0] += 0.9;
        }
        self.produced += frames as u64;
    }

    /// True when a replay reached its end (the engine then retires it).
    pub fn replay_done(&self) -> bool {
        self.replay.as_ref().is_some_and(|r| !r.looping && r.position >= r.dry.len())
    }

    pub(crate) fn take_replay(&mut self) -> Option<Box<Replay>> {
        self.status.replay_at.store(NO_POSITION, Ordering::Release);
        self.replay.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(keep: usize) -> (LiveParts, Arc<LiveStatus>) {
        let status = LiveStatus::new();
        (live_parts(status.clone(), keep, 512), status)
    }

    #[test]
    fn the_monitor_plays_the_chosen_channel_with_its_gain() {
        let (mut p, status) = parts(256);
        status.channel.store(1, Ordering::Relaxed);
        // Two channels: the instrument is on the second.
        let data: Vec<f32> = (0..128).flat_map(|i| [9.0, i as f32 / 1000.0]).collect();
        p.tap.push(&data, 2);
        p.stage.set_mix(LiveMix { input_db: 6.0206, level: 1.0, monitor: true });
        let (mut l, mut r) = (vec![0.0; 128], vec![0.0; 128]);
        p.stage.process(&mut l, &mut r, 128, false);
        assert!((l[100] - 0.2).abs() < 1e-4, "{}", l[100]);
        assert_eq!(l, r);
        assert!((status.take_input_peak() - 0.127).abs() < 1e-6);
        assert_eq!(status.captured.load(Ordering::Relaxed), 128);
    }

    #[test]
    fn the_scope_keeps_the_latest_samples_of_the_chosen_channel() {
        let (mut p, status) = parts(256);
        status.channel.store(1, Ordering::Relaxed);
        assert!(status.scope.recent(10).is_empty());
        let data: Vec<f32> = (0..SCOPE_LEN + 100).flat_map(|i| [9.0, i as f32]).collect();
        p.tap.push(&data, 2);
        let last = status.scope.recent(4);
        assert_eq!(last, vec![(SCOPE_LEN + 96) as f32, (SCOPE_LEN + 97) as f32, (SCOPE_LEN + 98) as f32, (SCOPE_LEN + 99) as f32]);
        // Never more than it keeps.
        assert_eq!(status.scope.recent(SCOPE_LEN * 2).len(), SCOPE_LEN);
        assert_eq!(status.scope.recent(SCOPE_LEN * 2)[0], 100.0);
    }

    #[test]
    fn waiting_input_beyond_keep_is_dropped_so_the_delay_cannot_grow() {
        let (mut p, status) = parts(64);
        let data: Vec<f32> = (0..1000).map(|i| i as f32).collect();
        p.tap.push(&data, 1);
        let (mut l, mut r) = (vec![0.0; 128], vec![0.0; 128]);
        p.stage.process(&mut l, &mut r, 128, false);
        // 1000 waiting, 64 + 128 allowed: the oldest 808 go; the block plays 808..936.
        assert_eq!(status.trimmed.load(Ordering::Relaxed), 808);
        assert_eq!(l[0], 808.0);
        assert_eq!(status.held.load(Ordering::Relaxed), 192);
    }

    #[test]
    fn a_steady_backlog_is_dropped_after_a_window_leaving_a_small_margin() {
        let (mut p, status) = parts(4096);
        p.tap.push(&vec![0.1; 1000], 1); // startup backlog
        let (mut l, mut r) = (vec![0.0; 64], vec![0.0; 64]);
        for _ in 0..(WINDOW / 64 + 2) {
            p.tap.push(&vec![0.1; 64], 1);
            p.stage.process(&mut l, &mut r, 64, false);
        }
        // 1000 waited the whole window: all but MARGIN went.
        assert_eq!(status.trimmed.load(Ordering::Relaxed), 1000 - MARGIN as u64);
        // Held counts this block too.
        assert_eq!(status.held.load(Ordering::Relaxed), MARGIN as u64 + 64);
        assert_eq!(status.underruns.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn the_round_trip_is_measured_from_the_click_leaving_to_it_coming_back() {
        let (mut p, status) = parts(4096);
        let (mut l, mut r) = (vec![0.0; 64], vec![0.0; 64]);
        status.ping_request.store(true, Ordering::Relaxed);
        p.stage.process(&mut l, &mut r, 64, false); // asks: the click leaves at frame 64
        l.fill(0.0);
        r.fill(0.0);
        p.stage.process(&mut l, &mut r, 64, false);
        assert_eq!(l[0], 0.9);
        // The interface returns it 300 frames later: input frame 364 is the click.
        let mut input = vec![0.0f32; 400];
        input[364 - 128] = 0.8;
        for block in input.chunks(64) {
            p.tap.push(block, 1);
            l.fill(0.0);
            r.fill(0.0);
            p.stage.process(&mut l, &mut r, 64, false);
        }
        assert_eq!(status.ping_result.load(Ordering::Relaxed), 300);
    }

    #[test]
    fn a_quiet_click_is_heard_above_the_inputs_own_noise_and_noise_alone_is_not() {
        let (mut p, status) = parts(4096);
        let (mut l, mut r) = (vec![0.0; 64], vec![0.0; 64]);
        // Half a second of input noise around 0.0004 (as a turned-down loopback hums).
        let noise = |k: usize| if k % 7 == 0 { 0.0004 } else { -0.0002 };
        for b in 0..375 {
            let block: Vec<f32> = (0..64).map(|i| noise(b * 64 + i)).collect();
            p.tap.push(&block, 1);
            p.stage.process(&mut l, &mut r, 64, false);
        }
        status.ping_request.store(true, Ordering::Relaxed);
        p.tap.push(&vec![0.0004; 64], 1);
        p.stage.process(&mut l, &mut r, 64, false);
        // The noise goes on (never above 8x itself); the click comes back at 0.02 (-34 dBFS),
        // far below the old fixed 0.2, 640 frames after it left.
        let mut input: Vec<f32> = (0..1024).map(noise).collect();
        input[640] = 0.02; // the click left on input[0]'s block
        for block in input.chunks(64) {
            p.tap.push(block, 1);
            p.stage.process(&mut l, &mut r, 64, false);
        }
        assert_eq!(status.ping_result.load(Ordering::Relaxed), 640);
        // Noise alone: the click never comes back, so the measurement gives up (no false hit).
        status.ping_result.store(PING_NONE, Ordering::Relaxed);
        status.ping_request.store(true, Ordering::Relaxed);
        for b in 0..800 {
            let block: Vec<f32> = (0..64).map(|i| noise(b * 64 + i)).collect();
            p.tap.push(&block, 1);
            p.stage.process(&mut l, &mut r, 64, false);
        }
        assert_eq!(status.ping_result.load(Ordering::Relaxed), PING_TIMEOUT);
    }

    #[test]
    fn a_replay_waiting_for_the_score_starts_on_the_block_the_score_starts() {
        let (mut p, status) = parts(64);
        p.stage.replay = Some(Box::new(Replay { dry: vec![0.1; 1000], wet: Vec::new(), origin: 0, position: 0, looping: false, source: ReplaySource::Dry, gain: 1.0, wait_for_song: true }));
        let (mut l, mut r) = (vec![0.0; 128], vec![0.0; 128]);
        p.stage.process(&mut l, &mut r, 128, false);
        assert!(l.iter().all(|v| *v == 0.0));
        assert_eq!(status.replay_position(), None);
        p.stage.process(&mut l, &mut r, 128, true);
        assert!((l[0] - 0.1).abs() < 1e-6);
        assert_eq!(status.replay_position(), Some(0));
    }

    #[test]
    fn recording_feeds_dry_and_wet_one_to_one_and_stops_when_off() {
        let (mut p, status) = parts(4096);
        status.recording.store(true, Ordering::Relaxed);
        p.tap.push(&vec![0.5; 300], 1);
        let (mut l, mut r) = (vec![0.0; 256], vec![0.0; 256]);
        p.stage.set_mix(LiveMix { input_db: 0.0, level: 0.5, monitor: true });
        p.stage.process(&mut l, &mut r, 256, false);
        assert_eq!(p.dry.slots(), 300);
        assert_eq!(p.wet.slots(), 256);
        assert_eq!(p.wet.pop().unwrap(), 0.5);
        assert_eq!(l[0], 0.25);
        status.recording.store(false, Ordering::Relaxed);
        p.tap.push(&vec![0.5; 100], 1);
        assert_eq!(p.dry.slots(), 300);
        // Monitor off: still taken (recording continues elsewhere), not heard.
        p.stage.set_mix(LiveMix { input_db: 0.0, level: 1.0, monitor: false });
        let (mut l, mut r) = (vec![0.0; 128], vec![0.0; 128]);
        p.stage.process(&mut l, &mut r, 128, false);
        assert!(l.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn replay_plays_wet_dry_or_through_the_chain_and_reports_its_position() {
        let (mut p, status) = parts(64);
        let dry: Vec<f32> = vec![0.1; 1000];
        let wet: Vec<f32> = vec![0.3; 1000];
        for (source, expect) in [(ReplaySource::Wet, 0.3), (ReplaySource::Dry, 0.1), (ReplaySource::Reamp, 0.1)] {
            p.stage.replay = Some(Box::new(Replay { dry: dry.clone(), wet: wet.clone(), origin: 5000, position: 0, looping: false, source, gain: 1.0, wait_for_song: false }));
            let (mut l, mut r) = (vec![0.0; 256], vec![0.0; 256]);
            p.stage.process(&mut l, &mut r, 256, false);
            assert!((l[10] - expect).abs() < 1e-6, "{source:?} {}", l[10]);
            assert_eq!(status.replay_position(), Some(5000));
        }
        // Runs out at the end unless looping.
        let (mut l, mut r) = (vec![0.0; 512], vec![0.0; 512]);
        for _ in 0..4 {
            p.stage.process(&mut l, &mut r, 512, false);
        }
        assert!(p.stage.replay_done());
        assert!(p.stage.take_replay().is_some());
        assert_eq!(status.replay_position(), None);
    }
}
