//! Song playback: one synthesizer per track (each track is its own stem for the mixer),
//! sample-accurate event timing at any playback speed, seek with controller chase,
//! loop ranges that wrap inside the audio callback, the metronome on the song's beats
//! and a count-in that starts the song on the exact sample after its last click.
//!
//! Real-time rule: `render` and the transport setters never allocate. `Player::new`
//! allocates and therefore runs on a control thread; the engine swaps players in.
use std::sync::Arc;

use crate::click::{ClickBank, ClickVoices, KIND_STANDARD, KIND_WOOD, Metronome};
use crate::sfz::SfzInstrument;
use crate::song::*;
use crate::synth::{SoundFont, Synthesizer, SynthesizerSettings};

/// alphaSynth-compatible defaults: its gain staging, no built-in reverb/chorus (the mixer has its own).
pub fn synth_settings(sample_rate: u32, block: usize) -> SynthesizerSettings {
    let mut settings = SynthesizerSettings::new(sample_rate as i32);
    settings.enable_reverb_and_chorus = false;
    settings.block_size = block.clamp(8, 1024);
    settings.maximum_polyphony = 128;
    settings.alphasynth_gain = true;
    settings
}

/// Measured level difference to alphaSynth after `alphasynth_gain` (spike S6: native was
/// 1.2-1.7 dB quieter on five scores, envelopes otherwise matching); +1.5 dB.
pub const ALPHASYNTH_TRIM: f32 = 1.188;
/// alphaSynth's metronome: percussion key 33 at velocity 95.
const METRONOME_CHANNEL: i32 = 9;
const METRONOME_KEY: i32 = 33;
const METRONOME_VELOCITY: i32 = 95;
pub const MAX_COUNT_TICKS: usize = 32;

pub struct Stem {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl Stem {
    pub fn new(frames: usize) -> Stem {
        Stem { left: vec![0.0; frames], right: vec![0.0; frames] }
    }
}

/// A count-in: clicks at frame offsets, then playback starts at `total` frames.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CountIn {
    pub ticks: [(u64, bool); MAX_COUNT_TICKS],
    pub len: usize,
    pub total: u64,
}

impl CountIn {
    /// `ticks`: (seconds from now, accent); `duration`: seconds until the song starts.
    pub fn new(ticks: &[(f64, bool)], duration: f64, sample_rate: u32) -> CountIn {
        let mut out = CountIn { ticks: [(0, false); MAX_COUNT_TICKS], len: 0, total: (duration.max(0.0) * sample_rate as f64).round() as u64 };
        for &(at, accent) in ticks.iter().take(MAX_COUNT_TICKS) {
            out.ticks[out.len] = ((at.max(0.0) * sample_rate as f64).round() as u64, accent);
            out.len += 1;
        }
        out
    }
}

struct Counting {
    plan: CountIn,
    next: usize,
    elapsed: u64,
}

pub struct Player {
    song: Arc<Song>,
    synths: Vec<Synthesizer>,
    /// Tracks played by an SFZ instrument instead of the GM synth (kept across reloads).
    samplers: Vec<Option<Box<SfzInstrument>>>,
    /// Track render order for the worker pool: SFZ tracks (the costly ones) first.
    order: Vec<usize>,
    /// Renders tracks in parallel when set (the engine's pool; None renders serially).
    pool: Option<std::sync::Arc<crate::pool::Pool>>,
    click_synth: Synthesizer,
    clicks: Arc<ClickBank>,
    click_voices: ClickVoices,
    metronome: Metronome,
    sample_rate: f64,
    /// Song position in seconds at speed 1.
    position: f64,
    next: usize,
    next_click: usize,
    speed: f64,
    loop_range: Option<(f64, f64)>,
    playing: bool,
    counting: Option<Counting>,
    finished: bool,
    /// Counts loop wraps so the UI can tell a wrap from a seek.
    pub wraps: u64,
}

impl Player {
    pub fn new(song: Arc<Song>, font: &Arc<SoundFont>, clicks: Arc<ClickBank>, sample_rate: u32) -> Result<Player, String> {
        let settings = synth_settings(sample_rate, 64);
        let make = || -> Result<Synthesizer, String> {
            let mut synth = Synthesizer::new(font, &settings).map_err(|e| e.to_string())?;
            synth.set_master_volume(ALPHASYNTH_TRIM);
            Ok(synth)
        };
        let synths = (0..song.tracks.max(1)).map(|_| make()).collect::<Result<Vec<_>, String>>()?;
        let click_synth = make()?;
        let samplers = (0..synths.len()).map(|_| None).collect();
        let order = (0..synths.len()).collect();
        let mut player = Player {
            song,
            synths,
            samplers,
            order,
            pool: None,
            click_synth,
            clicks,
            click_voices: ClickVoices::default(),
            metronome: Metronome::default(),
            sample_rate: sample_rate as f64,
            position: 0.0,
            next: 0,
            next_click: 0,
            speed: 1.0,
            loop_range: None,
            playing: false,
            counting: None,
            finished: false,
            wraps: 0,
        };
        player.seek(0.0);
        Ok(player)
    }

    pub fn song(&self) -> &Song {
        &self.song
    }
    /// Number of track stems; `render` takes one more stem for the metronome.
    pub fn tracks(&self) -> usize {
        self.synths.len()
    }
    pub fn position(&self) -> f64 {
        self.position
    }
    pub fn is_playing(&self) -> bool {
        self.playing
    }
    pub fn is_counting(&self) -> bool {
        self.counting.is_some()
    }
    /// True once playback reached the song end without a loop (the engine then stops).
    pub fn take_finished(&mut self) -> bool {
        std::mem::take(&mut self.finished)
    }

    pub fn speed(&self) -> f64 {
        self.speed
    }

    /// Puts an SFZ instrument on a track (or removes it); returns the previous one, which the
    /// caller must not drop on the audio thread.
    pub fn set_sampler(&mut self, track: usize, sampler: Option<Box<SfzInstrument>>) -> Option<Box<SfzInstrument>> {
        let slot = self.samplers.get_mut(track)?;
        if let Some(next) = &sampler {
            let _ = next;
            self.synths[track].note_off_all(true);
        }
        let old = std::mem::replace(slot, sampler);
        self.sort_order();
        old
    }

    /// SFZ tracks first so the pool starts the longest tasks first (no allocation).
    fn sort_order(&mut self) {
        let samplers = &self.samplers;
        self.order.sort_unstable_by_key(|&t| (samplers[t].is_none(), t));
    }

    /// Lets the player render its tracks on `pool` (set by the engine; Arc clone only).
    pub fn set_pool(&mut self, pool: Option<std::sync::Arc<crate::pool::Pool>>) {
        self.pool = pool;
    }

    pub fn take_sampler(&mut self, track: usize) -> Option<Box<SfzInstrument>> {
        self.samplers.get_mut(track)?.take()
    }

    pub fn set_speed(&mut self, speed: f64) {
        self.speed = speed.clamp(0.1, 4.0);
    }

    pub fn set_metronome(&mut self, metronome: Metronome) {
        self.metronome = metronome;
        self.click_synth.set_master_volume(ALPHASYNTH_TRIM * metronome.volume.max(0.0));
    }

    /// Loop between two song positions (seconds at speed 1); `None` plays through.
    pub fn set_loop(&mut self, range: Option<(f64, f64)>) {
        self.loop_range = range.filter(|(a, b)| b - a > 0.001);
    }

    pub fn play(&mut self) {
        if self.position >= self.song.end_time && self.loop_range.is_none() {
            self.seek(0.0);
        }
        self.playing = true;
    }

    /// Plays the count-in clicks, then starts the song exactly at `plan.total`.
    pub fn count_in(&mut self, plan: CountIn) {
        if self.position >= self.song.end_time && self.loop_range.is_none() {
            self.seek(0.0);
        }
        self.playing = false;
        self.counting = Some(Counting { plan, next: 0, elapsed: 0 });
    }

    pub fn pause(&mut self) {
        self.playing = false;
        self.counting = None;
        for synth in &mut self.synths {
            synth.note_off_all(true);
        }
        for sampler in self.samplers.iter_mut().flatten() {
            sampler.all_sound_off();
        }
    }

    /// Jumps to a song position: silences notes, then replays every non-note channel
    /// event before it (program, controllers, pitch wheel) so the state matches.
    pub fn seek(&mut self, seconds: f64) {
        let target = seconds.clamp(0.0, self.song.end_time.max(0.0));
        for synth in &mut self.synths {
            synth.reset();
        }
        for sampler in self.samplers.iter_mut().flatten() {
            sampler.all_sound_off();
        }
        let next = self.song.index_at(target);
        for i in 0..next {
            let e = self.song.events[i];
            if matches!(e.kind, KIND_CONTROL | KIND_PROGRAM | KIND_PITCH_BEND) {
                self.dispatch(e);
            }
        }
        self.next = next;
        self.next_click = self.song.metronome.partition_point(|&(time, _)| time < target - 1e-9);
        self.position = target;
    }

    fn dispatch(&mut self, e: Event) {
        if let Some(Some(sampler)) = self.samplers.get_mut(e.track as usize) {
            match e.kind {
                KIND_NOTE_ON => sampler.note_on(e.lane(), e.data1, e.data2, e.keyswitch()),
                KIND_NOTE_OFF => sampler.note_off(e.lane(), e.data1, e.data2),
                KIND_NOTE_BEND => sampler.note_bend(e.lane(), e.data1, e.value, e.data2, e.continued()),
                KIND_CONTROL => sampler.control(e.data1, e.data2),
                KIND_PITCH_BEND => sampler.pitch_wheel(e.value),
                _ => {}
            }
            return;
        }
        let Some(synth) = self.synths.get_mut(e.track as usize) else { return };
        let channel = e.channel as i32;
        match e.kind {
            KIND_NOTE_BEND => synth.note_bend(channel, e.data1 as i32, e.value),
            KIND_PITCH_BEND => synth.process_midi_message(channel, 0xE0, (e.value & 0x7F) as i32, ((e.value >> 7) & 0x7F) as i32),
            KIND_NOTE_ON | KIND_NOTE_OFF | KIND_KEY_PRESSURE | KIND_CONTROL | KIND_PROGRAM | KIND_CHANNEL_PRESSURE => {
                synth.process_midi_message(channel, e.kind as i32, e.data1 as i32, e.data2 as i32)
            }
            _ => {}
        }
    }

    fn click(&mut self, kind: u8, accent: bool) {
        if kind == KIND_STANDARD {
            self.click_synth.note_off(METRONOME_CHANNEL, METRONOME_KEY);
            self.click_synth.note_on(METRONOME_CHANNEL, METRONOME_KEY, METRONOME_VELOCITY);
        } else {
            self.click_voices.start(kind, accent);
        }
    }

    fn render_synths(&mut self, stems: &mut [Stem], from: usize, to: usize) {
        if to <= from {
            return;
        }
        let tracks = self.synths.len();
        fn track(synth: &mut Synthesizer, sampler: &mut Option<Box<SfzInstrument>>, stem: &mut Stem, from: usize, to: usize) {
            match sampler {
                Some(sampler) => {
                    stem.left[from..to].fill(0.0);
                    stem.right[from..to].fill(0.0);
                    sampler.render(&mut stem.left[from..to], &mut stem.right[from..to]);
                }
                None => synth.render(&mut stem.left[from..to], &mut stem.right[from..to]),
            }
        }
        // Tracks are independent, so rendering them in parallel gives the same samples;
        // tiny segments are not worth waking helpers for.
        match self.pool.as_ref().filter(|p| p.helpers() > 0 && tracks > 1 && to - from >= 32 && stems.len() >= tracks) {
            Some(pool) => {
                use crate::pool::Parts;
                let (synths, samplers, stems_at, order) = (Parts(self.synths.as_mut_ptr()), Parts(self.samplers.as_mut_ptr()), Parts(stems.as_mut_ptr()), &self.order);
                // SAFETY: each task index maps to a different track (order is a permutation),
                // so every task touches its own synth, sampler and stem only.
                pool.run(tracks, &|i| unsafe {
                    let t = order[i];
                    track(synths.at(t), samplers.at(t), stems_at.at(t), from, to);
                });
            }
            None => {
                for ((synth, sampler), stem) in self.synths.iter_mut().zip(self.samplers.iter_mut()).zip(stems.iter_mut()) {
                    track(synth, sampler, stem, from, to);
                }
            }
        }
        if let Some(stem) = stems.get_mut(tracks) {
            self.click_synth.render(&mut stem.left[from..to], &mut stem.right[from..to]);
            self.click_voices.render(&self.clicks, self.metronome.volume, &mut stem.left[from..to], &mut stem.right[from..to]);
        }
    }

    /// Renders `frames` frames into the stems: one per track, then the metronome stem.
    /// While paused the synths still render (release tails) but time stands still.
    pub fn render(&mut self, stems: &mut [Stem], frames: usize) {
        let mut done = 0;
        while done < frames {
            let remaining = frames - done;
            if let Some(counting) = &mut self.counting {
                let next_tick = counting.plan.ticks[..counting.plan.len].get(counting.next).map_or(u64::MAX, |t| t.0);
                let until = next_tick.min(counting.plan.total).saturating_sub(counting.elapsed);
                let step = (until as usize).min(remaining);
                self.render_synths(stems, done, done + step);
                done += step;
                let counting = self.counting.as_mut().unwrap();
                counting.elapsed += step as u64;
                let mut due = [(false, false); MAX_COUNT_TICKS];
                let mut count = 0;
                while counting.next < counting.plan.len && counting.plan.ticks[counting.next].0 <= counting.elapsed {
                    due[count] = (true, counting.plan.ticks[counting.next].1);
                    count += 1;
                    counting.next += 1;
                }
                let started = counting.elapsed >= counting.plan.total;
                // The count always uses a wave click ("standard" counts with wood, as in the WebAudio build).
                let kind = if self.metronome.kind == KIND_STANDARD { KIND_WOOD } else { self.metronome.kind };
                for &(_, accent) in &due[..count] {
                    self.click(kind, accent);
                }
                if started {
                    self.counting = None;
                    self.playing = true;
                }
                continue;
            }
            if !self.playing {
                self.render_synths(stems, done, frames);
                return;
            }
            let seconds_per_frame = self.speed / self.sample_rate;
            // The next point where something has to happen: an event, a metronome beat,
            // the loop end or the song end.
            let mut boundary = self.song.events.get(self.next).map_or(f64::INFINITY, |e| e.time);
            if self.metronome.enabled {
                boundary = boundary.min(self.song.metronome.get(self.next_click).map_or(f64::INFINITY, |c| c.0));
            }
            let loop_end = self.loop_range.filter(|&(_, end)| self.position < end).map(|(_, end)| end);
            if let Some(end) = loop_end {
                boundary = boundary.min(end);
            }
            if loop_end.is_none() {
                boundary = boundary.min(self.song.end_time.max(self.position));
            }
            let until = ((boundary - self.position) / seconds_per_frame).ceil().max(0.0);
            let step = if until.is_finite() { (until as usize).min(remaining) } else { remaining };
            self.render_synths(stems, done, done + step);
            done += step;
            self.position += step as f64 * seconds_per_frame;
            let reached = step < remaining || self.position >= boundary - 1e-9;
            if !reached {
                continue;
            }
            // Events due at or before the current position (tolerance: under one frame).
            let due = self.position + seconds_per_frame * 0.5;
            let mut dispatched = false;
            while let Some(&e) = self.song.events.get(self.next) {
                if e.time > due {
                    break;
                }
                self.dispatch(e);
                self.next += 1;
                dispatched = true;
            }
            while let Some(&(time, accent)) = self.song.metronome.get(self.next_click) {
                if time > due {
                    break;
                }
                if self.metronome.enabled {
                    self.click(self.metronome.kind, accent);
                }
                self.next_click += 1;
                dispatched = true;
            }
            if let Some((start, end)) = self.loop_range {
                if self.position >= end - 1e-9 {
                    self.seek(start);
                    self.wraps += 1;
                    continue;
                }
            }
            if self.loop_range.is_none() && self.next >= self.song.events.len() && self.position >= self.song.end_time - 1e-9 {
                self.playing = false;
                self.finished = true;
                for synth in &mut self.synths {
                    synth.note_off_all(false);
                }
                continue;
            }
            if step == 0 && !dispatched {
                // Guard against a zero-length step that dispatched nothing.
                let one = 1.min(frames - done);
                self.render_synths(stems, done, done + one);
                done += one;
                self.position += one as f64 * seconds_per_frame;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::click::{KIND_BEEP, Metronome};

    fn font() -> Option<Arc<SoundFont>> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/alphatab/soundfont/sonivox.sf2");
        let bytes = std::fs::read(path).ok()?;
        Some(Arc::new(SoundFont::new(&mut bytes.as_slice()).unwrap()))
    }

    fn song() -> Arc<Song> {
        // One track: 120 bpm 4/4, a note every beat for 4 beats (2 seconds).
        let mut events = vec![event(0, KIND_TEMPO, 0, 0, 0, 120_000, 0), event(0, KIND_TIME_SIGNATURE, 0, 4, 2, 0, 0), event(0, KIND_PROGRAM, 0, 27, 0, 0, 0)];
        for beat in 0..4u32 {
            events.push(event(beat * 960, KIND_NOTE_ON, 0, 60, 100, 0, 0));
            events.push(event(beat * 960 + 480, KIND_NOTE_OFF, 0, 60, 0, 0, 0));
        }
        events.push(event(3840, KIND_END, 0, 0, 0, 0, 0));
        Arc::new(Song::from_events(960, events))
    }

    fn player(font: &Arc<SoundFont>) -> Player {
        Player::new(song(), font, Arc::new(ClickBank::new(44100)), 44100).unwrap()
    }

    fn stems(frames: usize) -> Vec<Stem> {
        vec![Stem::new(frames), Stem::new(frames)]
    }

    fn energy(stem: &Stem, from: usize, to: usize) -> f32 {
        stem.left[from..to].iter().map(|v| v * v).sum::<f32>()
    }

    #[test]
    fn plays_through_and_finishes_at_the_song_end() {
        let Some(font) = font() else { return };
        let mut player = player(&font);
        let mut stems = stems(44100);
        player.play();
        player.render(&mut stems, 22050);
        assert!((player.position() - 0.5).abs() < 1e-6);
        assert!(energy(&stems[0], 0, 22050) > 0.0, "the first note sounds");
        player.render(&mut stems, 44100);
        player.render(&mut stems, 44100);
        assert!(!player.is_playing());
        assert!(player.take_finished());
        assert!((player.position() - 2.0).abs() < 1e-3);
    }

    #[test]
    fn speed_scales_song_time() {
        let Some(font) = font() else { return };
        let mut player = player(&font);
        let mut stems = stems(44100);
        player.set_speed(0.5);
        player.play();
        player.render(&mut stems, 44100);
        assert!((player.position() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn loops_wrap_sample_accurately_and_seek_restores_programs() {
        let Some(font) = font() else { return };
        let mut player = player(&font);
        let mut stems = stems(44100);
        player.set_loop(Some((0.5, 1.0)));
        player.seek(0.5);
        player.play();
        // 1.25 s of real time: 0.5 -> 1.0, wrap, 0.5 -> 1.0, wrap, 0.5 -> 0.75.
        player.render(&mut stems, 44100);
        player.render(&mut stems, 11025);
        assert_eq!(player.wraps, 2);
        assert!((player.position() - 0.75).abs() < 1e-3, "{}", player.position());
        assert!(player.is_playing());
    }

    #[test]
    fn note_events_land_on_their_sample() {
        let Some(font) = font() else { return };
        let mut player = player(&font);
        let mut stems = stems(44100);
        player.seek(0.25);
        player.play();
        // The second note starts at 0.5 s = 11025 frames after 0.25 s; 64-frame synth blocks.
        player.render(&mut stems, 22050);
        assert_eq!(energy(&stems[0], 0, 11025), 0.0);
        assert!(energy(&stems[0], 11025 + 64, 22050) > 0.0);
    }

    fn onsets(stem: &Stem) -> Vec<usize> {
        let mut out = Vec::new();
        let mut silent = 0;
        for (i, v) in stem.left.iter().enumerate() {
            if v.abs() > 1e-4 {
                if silent > 500 || out.is_empty() && silent == i {
                    out.push(i);
                }
                silent = 0;
            } else {
                silent += 1;
            }
        }
        out
    }

    #[test]
    fn metronome_clicks_on_every_beat_with_the_bar_accent() {
        let Some(font) = font() else { return };
        let mut player = player(&font);
        player.set_metronome(Metronome { enabled: true, kind: KIND_BEEP, volume: 1.0 });
        let mut stems = stems(44100 * 2);
        player.play();
        player.render(&mut stems, 44100 * 2);
        // 120 bpm: beats every 22050 frames; the click stem is the last stem. A click wave
        // starts at 0 (attack ramp), so it becomes audible one sample after its beat.
        assert_eq!(onsets(&stems[1]), vec![1, 22051, 44101, 66151]);
        let accent = stems[1].left[..4000].iter().fold(0f32, |m, v| m.max(v.abs()));
        let plain = stems[1].left[22050..26050].iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(accent > plain * 1.2, "first beat of the bar is accented");
        assert_eq!(player.song().metronome.iter().filter(|c| c.1).count(), 1);
    }

    #[test]
    fn count_in_clicks_then_starts_on_the_exact_frame() {
        let Some(font) = font() else { return };
        let mut player = player(&font);
        player.set_metronome(Metronome { enabled: false, kind: KIND_BEEP, volume: 1.0 });
        let mut stems = stems(44100 * 2);
        player.count_in(CountIn::new(&[(0.0, true), (0.25, false), (0.5, false), (0.75, false)], 1.0, 44100));
        player.render(&mut stems, 22050);
        assert!(player.is_counting() && !player.is_playing());
        assert_eq!(player.position(), 0.0);
        player.render(&mut stems, 44100);
        assert!(!player.is_counting() && player.is_playing());
        // Song started at 1.0 s of the count: 0.5 s more of song time rendered.
        assert!((player.position() - 0.5).abs() < 1e-6, "{}", player.position());
        // The first note begins exactly 22050 frames into the second render (+ synth block).
        assert_eq!(energy(&stems[0], 0, 22050), 0.0);
        assert!(energy(&stems[0], 22050, 22050 + 2000) > 0.0);
        // Pausing cancels a count.
        player.count_in(CountIn::new(&[(0.0, true)], 1.0, 44100));
        player.pause();
        assert!(!player.is_counting());
    }
}
