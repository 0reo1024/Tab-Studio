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
use crate::player::{CountIn, Player, Stem};

pub const MAX_TRACKS: usize = 64;
/// Largest block rendered at once; bigger device buffers are processed in pieces.
pub const MAX_BLOCK: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackMix {
    /// Linear gain (1 = unity).
    pub gain: f32,
    /// -1 (left) .. 1 (right).
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
}

impl Default for TrackMix {
    fn default() -> Self {
        TrackMix { gain: 1.0, pan: 0.0, mute: false, solo: false }
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

/// Transparent below the ceiling; fast attack, slow release above it.
struct Limiter {
    gain: f32,
    release: f32,
}

impl Limiter {
    const CEILING: f32 = 0.891; // -1 dBFS
    fn new(sample_rate: u32) -> Limiter {
        Limiter { gain: 1.0, release: 1.0 - (-1.0 / (0.15 * sample_rate as f32)).exp() }
    }
    fn process(&mut self, left: &mut f32, right: &mut f32) {
        let peak = left.abs().max(right.abs());
        let wanted = if peak * self.gain > Self::CEILING { Self::CEILING / peak } else { 1.0 };
        self.gain = if wanted < self.gain { wanted } else { self.gain + (wanted - self.gain) * self.release };
        *left *= self.gain;
        *right *= self.gain;
    }
}

pub struct Core {
    loaded: Option<Box<Loaded>>,
    preview: Option<Box<Preview>>,
    retired_previews: rtrb::Producer<Box<Preview>>,
    mix: [TrackMix; MAX_TRACKS],
    master: f32,
    metronome: Metronome,
    limiter: Limiter,
    status: Arc<Status>,
    commands: rtrb::Consumer<Command>,
    retired: rtrb::Producer<Box<Loaded>>,
}

/// The control side: send commands, read status, drop retired songs.
pub struct Control {
    commands: rtrb::Producer<Command>,
    retired: rtrb::Consumer<Box<Loaded>>,
    retired_previews: rtrb::Consumer<Box<Preview>>,
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
    }
}

pub fn new_engine(sample_rate: u32) -> (Core, Control) {
    let (command_tx, command_rx) = rtrb::RingBuffer::new(256);
    let (retired_tx, retired_rx) = rtrb::RingBuffer::new(16);
    let (preview_tx, preview_rx) = rtrb::RingBuffer::new(64);
    let status = Arc::new(Status::default());
    let core = Core { loaded: None, preview: None, retired_previews: preview_tx, mix: [TrackMix::default(); MAX_TRACKS], master: 1.0, metronome: Metronome::default(), limiter: Limiter::new(sample_rate), status: status.clone(), commands: command_rx, retired: retired_tx };
    (core, Control { commands: command_tx, retired: retired_rx, retired_previews: preview_rx, status, sample_rate })
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
    pub fn process(&mut self, out: &mut [f32], channels: usize) {
        self.apply_commands();
        let channels = channels.max(1);
        let frames_total = out.len() / channels;
        let any_solo = self.mix.iter().any(|m| m.solo);
        let mut done = 0;
        while done < frames_total {
            let frames = (frames_total - done).min(MAX_BLOCK);
            let block = &mut out[done * channels..(done + frames) * channels];
            block.fill(0.0);
            if let Some(loaded) = &mut self.loaded {
                let stems = &mut loaded.stems[..];
                loaded.player.render(stems, frames);
                let tracks = loaded.player.tracks();
                for (index, stem) in stems.iter().enumerate() {
                    if index == tracks {
                        // The metronome is never muted by solo and has its own volume.
                        let mut peak = 0f32;
                        for i in 0..frames {
                            peak = peak.max(stem.left[i].abs()).max(stem.right[i].abs());
                            block[i * channels] += stem.left[i];
                            if channels > 1 {
                                block[i * channels + 1] += stem.right[i];
                            }
                        }
                        raise_peak(&self.status.click_peak, peak);
                        continue;
                    }
                    let mix = self.mix.get(index).copied().unwrap_or_default();
                    let audible = !mix.mute && (!any_solo || mix.solo);
                    // Equal-power pan on top of the synth's own stereo image.
                    let angle = (mix.pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
                    let (gl, gr) = (mix.gain * angle.cos() * std::f32::consts::SQRT_2, mix.gain * angle.sin() * std::f32::consts::SQRT_2);
                    let mut peak = 0f32;
                    for i in 0..frames {
                        let (l, r) = (stem.left[i] * gl, stem.right[i] * gr);
                        peak = peak.max(l.abs()).max(r.abs());
                        if audible {
                            block[i * channels] += l;
                            if channels > 1 {
                                block[i * channels + 1] += r;
                            }
                        }
                    }
                    if index < MAX_TRACKS {
                        raise_peak(&self.status.track_peaks[index], if audible { peak } else { 0.0 });
                    }
                }
                if loaded.player.take_finished() {
                    self.status.finished.fetch_add(1, Ordering::AcqRel);
                }
                self.status.wraps.store(loaded.player.wraps, Ordering::Release);
                self.status.position.store(loaded.player.position().to_bits(), Ordering::Release);
                self.status.playing.store(loaded.player.is_playing(), Ordering::Release);
                self.status.counting.store(loaded.player.is_counting(), Ordering::Release);
            }
            if let Some(preview) = &mut self.preview {
                // Through the track's gain, pan and mute (as the WebAudio preview went through the track graph).
                let mix = self.mix.get(preview.track).copied().unwrap_or_default();
                let audible = !mix.mute && (!any_solo || mix.solo);
                let angle = (mix.pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
                let (gl, gr) = (mix.gain * angle.cos() * std::f32::consts::SQRT_2, mix.gain * angle.sin() * std::f32::consts::SQRT_2);
                let count = (preview.left.len() - preview.position).min(frames);
                if audible {
                    for i in 0..count {
                        block[i * channels] += preview.left[preview.position + i] * gl;
                        if channels > 1 {
                            block[i * channels + 1] += preview.right[preview.position + i] * gr;
                        }
                    }
                }
                preview.position += count;
                if preview.position >= preview.left.len() {
                    self.retire_preview(None);
                }
            }
            let (mut peak_l, mut peak_r) = (0f32, 0f32);
            for i in 0..frames {
                let mut l = block[i * channels] * self.master;
                let mut r = if channels > 1 { block[i * channels + 1] * self.master } else { l };
                self.limiter.process(&mut l, &mut r);
                peak_l = peak_l.max(l.abs());
                peak_r = peak_r.max(r.abs());
                block[i * channels] = l;
                if channels > 1 {
                    block[i * channels + 1] = r;
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
        assert!(l > 0.0 && r > 0.0 && l <= Limiter::CEILING + 1e-3);
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
    fn limiter_holds_the_ceiling() {
        let mut limiter = Limiter::new(48000);
        let (mut l, mut r) = (4.0f32, -2.0f32);
        limiter.process(&mut l, &mut r);
        assert!(l.abs() <= Limiter::CEILING + 1e-6 && r.abs() <= Limiter::CEILING);
        let (mut l, mut r) = (0.1f32, 0.1f32);
        for _ in 0..48000 {
            (l, r) = (0.1, 0.1);
            limiter.process(&mut l, &mut r);
        }
        let _ = r;
        assert!((l - 0.1).abs() < 1e-3, "recovers to unity: {l}");
    }
}
