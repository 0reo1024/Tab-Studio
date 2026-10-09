//! The real-time engine core, independent of the audio device so it can be tested:
//! commands arrive through a lock-free queue, `process` renders one device buffer,
//! and the state the UI needs (position, playing, meters) is published through atomics.
//!
//! Real-time rules for `process`: no allocation, no locks, no frees. A newly loaded
//! song arrives fully built (player + stem buffers); the replaced one is handed back
//! through the `retired` queue and dropped on the control thread.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use crate::click::Metronome;
use crate::compressor::Compressor;
use crate::dsp::{Convolver, convolver_normalization, reverb_impulse, stereo_pan};
use crate::fx::FxChain;
use crate::player::{CountIn, Player, Stem};

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
    Loop(Option<(f64, f64)>),
    Track(usize, TrackMix),
    /// Replaces a track's insert effects (the old chain is retired).
    TrackFx(usize, Box<FxChain>),
    /// The music bus: gain (the mixer's 1/sqrt(audible tracks)) and the master reverb switch.
    Bus { gain: f32, reverb: bool },
    Master(f32),
    Metronome(Metronome),
    /// Count-in clicks, then playback starts on the exact frame.
    CountIn(CountIn),
    /// Plays a rendered preview through its track's mix, replacing one still sounding.
    Preview(Box<Preview>),
    StopPreview,
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
    master_peak: [AtomicU32; 2],
    track_peaks: [AtomicU32; MAX_TRACKS],
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
            master_peak: [AtomicU32::new(0), AtomicU32::new(0)],
            track_peaks: std::array::from_fn(|_| AtomicU32::new(0)),
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
    pub fn frames(&self) -> u64 {
        self.frames.load(Ordering::Acquire)
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

pub struct Core {
    loaded: Option<Box<Loaded>>,
    preview: Option<Box<Preview>>,
    retired_previews: rtrb::Producer<Box<Preview>>,
    mix: [TrackMix; MAX_TRACKS],
    fx: Vec<Option<Box<FxChain>>>,
    retired_fx: rtrb::Producer<Box<FxChain>>,
    master: f32,
    bus_gain: f32,
    reverb_on: bool,
    reverb: Convolver,
    bus: Stem,
    send: Stem,
    strip: Stem,
    metronome: Metronome,
    limiter: Compressor,
    status: Arc<Status>,
    commands: rtrb::Consumer<Command>,
    retired: rtrb::Producer<Box<Loaded>>,
}

/// The control side: send commands, read status, drop retired songs.
pub struct Control {
    commands: rtrb::Producer<Command>,
    retired: rtrb::Consumer<Box<Loaded>>,
    retired_previews: rtrb::Consumer<Box<Preview>>,
    retired_fx: rtrb::Consumer<Box<FxChain>>,
    pub status: Arc<Status>,
    pub sample_rate: u32,
}

impl Control {
    /// Sends a command; returns it back if the queue is full (the caller may retry).
    pub fn send(&mut self, command: Command) -> Result<(), Command> {
        self.collect_garbage();
        self.commands.push(command).map_err(|rtrb::PushError::Full(c)| c)
    }
    pub fn collect_garbage(&mut self) {
        while let Ok(old) = self.retired.pop() {
            drop(old);
        }
        while let Ok(old) = self.retired_previews.pop() {
            drop(old);
        }
        while let Ok(old) = self.retired_fx.pop() {
            drop(old);
        }
    }
}

pub fn new_engine(sample_rate: u32) -> (Core, Control) {
    let (command_tx, command_rx) = rtrb::RingBuffer::new(256);
    let (retired_tx, retired_rx) = rtrb::RingBuffer::new(16);
    let (preview_tx, preview_rx) = rtrb::RingBuffer::new(64);
    let status = Arc::new(Status::default());
    let (fx_tx, fx_rx) = rtrb::RingBuffer::new(MAX_TRACKS * 2);
    let core = Core {
        loaded: None,
        preview: None,
        retired_previews: preview_tx,
        mix: [TrackMix::default(); MAX_TRACKS],
        fx: (0..MAX_TRACKS).map(|_| None).collect(),
        retired_fx: fx_tx,
        master: 1.0,
        bus_gain: 1.0,
        reverb_on: true,
        reverb: mixer_reverb(sample_rate),
        bus: Stem::new(MAX_BLOCK),
        send: Stem::new(MAX_BLOCK),
        strip: Stem::new(MAX_BLOCK),
        metronome: Metronome::default(),
        limiter: master_limiter(sample_rate),
        status: status.clone(),
        commands: command_rx,
        retired: retired_tx,
    };
    (core, Control { commands: command_tx, retired: retired_rx, retired_previews: preview_rx, retired_fx: fx_rx, status, sample_rate })
}

impl Core {
    fn apply_commands(&mut self) {
        while let Ok(command) = self.commands.pop() {
            match command {
                Command::Load(mut next) => {
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
                    if let Some(old) = self.loaded.replace(next) {
                        // If the queue is full the old song is leaked rather than freed here.
                        if let Err(rtrb::PushError::Full(old)) = self.retired.push(old) {
                            std::mem::forget(old);
                        }
                    }
                }
                Command::Play => {
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
                Command::Loop(range) => {
                    if let Some(l) = &mut self.loaded {
                        l.player.set_loop(range);
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
                Command::Bus { gain, reverb } => {
                    self.bus_gain = gain.max(0.0);
                    self.reverb_on = reverb;
                }
                Command::Master(gain) => self.master = gain.max(0.0),
                Command::Metronome(metronome) => {
                    self.metronome = metronome;
                    if let Some(l) = &mut self.loaded {
                        l.player.set_metronome(metronome);
                    }
                }
                Command::Preview(next) => self.retire_preview(Some(next)),
                Command::StopPreview => self.retire_preview(None),
                Command::CountIn(plan) => {
                    if let Some(l) = &mut self.loaded {
                        l.player.count_in(plan);
                    }
                }
            }
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

    /// Renders `out` (interleaved, `channels` per frame; the first two get left/right).
    /// Signal flow as in mixer-audio.ts: each track stem -> its FX -> StereoPanner -> gain
    /// (meter) -> music bus, plus a post-gain reverb send; the reverb returns into the bus;
    /// the bus is scaled by 1/sqrt(audible); clicks join after the bus; master gain;
    /// limiter.
    pub fn process(&mut self, out: &mut [f32], channels: usize) {
        self.apply_commands();
        let channels = channels.max(1);
        let frames_total = out.len() / channels;
        let any_solo = self.mix.iter().any(|m| m.solo);
        let mut done = 0;
        while done < frames_total {
            let frames = (frames_total - done).min(MAX_BLOCK);
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
                for index in 0..tracks.min(MAX_TRACKS) {
                    let mix = self.mix[index];
                    let audible = !mix.mute && (!any_solo || mix.solo);
                    let (l, r) = (&mut self.strip.left[..frames], &mut self.strip.right[..frames]);
                    if audible {
                        l.copy_from_slice(&loaded.stems[index].left[..frames]);
                        r.copy_from_slice(&loaded.stems[index].right[..frames]);
                    } else {
                        // The strip input is silenced; its FX keep running so tails die out.
                        l.fill(0.0);
                        r.fill(0.0);
                    }
                    if preview_track == Some(index) {
                        // Auditions enter the track strip like the WebAudio preview did.
                        if let Some(preview) = &mut self.preview {
                            let count = (preview.left.len() - preview.position).min(frames);
                            if audible {
                                for i in 0..count {
                                    l[i] += preview.left[preview.position + i];
                                    r[i] += preview.right[preview.position + i];
                                }
                            }
                            preview.position += count;
                            preview_mixed = true;
                        }
                    }
                    if let Some(chain) = &mut self.fx[index] {
                        chain.process(l, r);
                    }
                    stereo_pan(mix.pan, l, r);
                    let gain = if audible { mix.gain } else { 0.0 };
                    let mut peak = 0f32;
                    for i in 0..frames {
                        l[i] *= gain;
                        r[i] *= gain;
                        peak = peak.max(l[i].abs()).max(r[i].abs());
                        self.bus.left[i] += l[i];
                        self.bus.right[i] += r[i];
                        self.send.left[i] += l[i] * mix.send;
                        self.send.right[i] += r[i] * mix.send;
                    }
                    raise_peak(&self.status.track_peaks[index], peak);
                }
                if loaded.player.take_finished() {
                    self.status.finished.fetch_add(1, Ordering::AcqRel);
                }
                self.status.wraps.store(loaded.player.wraps, Ordering::Release);
                self.status.position.store(loaded.player.position().to_bits(), Ordering::Release);
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
            if let (Some(index), Some(loaded)) = (click_stem, &self.loaded) {
                let stem = &loaded.stems[index];
                let mut peak = 0f32;
                for i in 0..frames {
                    peak = peak.max(stem.left[i].abs()).max(stem.right[i].abs());
                    self.bus.left[i] += stem.left[i];
                    self.bus.right[i] += stem.right[i];
                }
                raise_peak(&self.status.click_peak, peak);
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
        assert!(core.preview.is_none(), "finished previews are retired");
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
        assert!(core.fx[0].is_some());
        control.collect_garbage();
        assert!(control.retired_fx.is_empty());
    }

}
