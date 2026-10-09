//! Song playback: one synthesizer per track (each track is its own stem for the mixer),
//! sample-accurate event timing at any playback speed, seek with controller chase,
//! and loop ranges that wrap inside the audio callback.
//!
//! Real-time rule: `render` and the transport setters never allocate. `Player::new`
//! allocates and therefore runs on a control thread; the engine swaps players in.
use std::sync::Arc;

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

pub struct Stem {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl Stem {
    pub fn new(frames: usize) -> Stem {
        Stem { left: vec![0.0; frames], right: vec![0.0; frames] }
    }
}

pub struct Player {
    song: Arc<Song>,
    synths: Vec<Synthesizer>,
    sample_rate: f64,
    /// Song position in seconds at speed 1.
    position: f64,
    next: usize,
    speed: f64,
    loop_range: Option<(f64, f64)>,
    playing: bool,
    finished: bool,
    /// Counts loop wraps so the UI can tell a wrap from a seek.
    pub wraps: u64,
}

impl Player {
    pub fn new(song: Arc<Song>, font: &Arc<SoundFont>, sample_rate: u32) -> Result<Player, String> {
        let settings = synth_settings(sample_rate, 64);
        let synths = (0..song.tracks.max(1))
            .map(|_| {
                let mut synth = Synthesizer::new(font, &settings).map_err(|e| e.to_string())?;
                synth.set_master_volume(ALPHASYNTH_TRIM);
                Ok(synth)
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut player = Player { song, synths, sample_rate: sample_rate as f64, position: 0.0, next: 0, speed: 1.0, loop_range: None, playing: false, finished: false, wraps: 0 };
        player.seek(0.0);
        Ok(player)
    }

    pub fn song(&self) -> &Song {
        &self.song
    }
    pub fn tracks(&self) -> usize {
        self.synths.len()
    }
    pub fn position(&self) -> f64 {
        self.position
    }
    pub fn is_playing(&self) -> bool {
        self.playing
    }
    /// True once playback reached the song end without a loop (the engine then stops).
    pub fn take_finished(&mut self) -> bool {
        std::mem::take(&mut self.finished)
    }

    pub fn set_speed(&mut self, speed: f64) {
        self.speed = speed.clamp(0.1, 4.0);
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

    pub fn pause(&mut self) {
        self.playing = false;
        for synth in &mut self.synths {
            synth.note_off_all(true);
        }
    }

    /// Jumps to a song position: silences notes, then replays every non-note channel
    /// event before it (program, controllers, pitch wheel) so the state matches.
    pub fn seek(&mut self, seconds: f64) {
        let target = seconds.clamp(0.0, self.song.end_time.max(0.0));
        for synth in &mut self.synths {
            synth.reset();
        }
        let next = self.song.index_at(target);
        for i in 0..next {
            let e = self.song.events[i];
            if matches!(e.kind, KIND_CONTROL | KIND_PROGRAM | KIND_PITCH_BEND) {
                self.dispatch(e);
            }
        }
        self.next = next;
        self.position = target;
    }

    fn dispatch(&mut self, e: Event) {
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

    fn render_synths(&mut self, stems: &mut [Stem], from: usize, to: usize) {
        if to <= from {
            return;
        }
        for (synth, stem) in self.synths.iter_mut().zip(stems.iter_mut()) {
            synth.render(&mut stem.left[from..to], &mut stem.right[from..to]);
        }
    }

    /// Renders `frames` frames into the per-track stems (one per track, in order).
    /// While paused the synths still render (release tails, previews) but time stands still.
    pub fn render(&mut self, stems: &mut [Stem], frames: usize) {
        let mut done = 0;
        while done < frames {
            let remaining = frames - done;
            if !self.playing {
                self.render_synths(stems, done, frames);
                return;
            }
            let seconds_per_frame = self.speed / self.sample_rate;
            // The next point where something has to happen: an event, the loop end or the song end.
            let mut boundary = self.song.events.get(self.next).map_or(f64::INFINITY, |e| e.time);
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
            while let Some(&e) = self.song.events.get(self.next) {
                if e.time > due {
                    break;
                }
                self.dispatch(e);
                self.next += 1;
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
            }
            if step == 0 && self.next < self.song.events.len() && self.song.events[self.next].time > due {
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

    fn font() -> Option<Arc<SoundFont>> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/alphatab/soundfont/sonivox.sf2");
        let bytes = std::fs::read(path).ok()?;
        Some(Arc::new(SoundFont::new(&mut bytes.as_slice()).unwrap()))
    }

    fn song() -> Arc<Song> {
        // One track: 120 bpm, a note every beat for 4 beats (2 seconds).
        let mut events = vec![event(0, KIND_TEMPO, 0, 0, 0, 120_000, 0), event(0, KIND_PROGRAM, 0, 27, 0, 0, 0)];
        for beat in 0..4u32 {
            events.push(event(beat * 960, KIND_NOTE_ON, 0, 60, 100, 0, 0));
            events.push(event(beat * 960 + 480, KIND_NOTE_OFF, 0, 60, 0, 0, 0));
        }
        events.push(event(3840, KIND_END, 0, 0, 0, 0, 0));
        Arc::new(Song::from_events(960, events))
    }

    fn energy(stem: &Stem, from: usize, to: usize) -> f32 {
        stem.left[from..to].iter().map(|v| v * v).sum::<f32>()
    }

    #[test]
    fn plays_through_and_finishes_at_the_song_end() {
        let Some(font) = font() else { return };
        let mut player = Player::new(song(), &font, 44100).unwrap();
        let mut stems = vec![Stem::new(44100)];
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
        let mut player = Player::new(song(), &font, 44100).unwrap();
        let mut stems = vec![Stem::new(44100)];
        player.set_speed(0.5);
        player.play();
        player.render(&mut stems, 44100);
        assert!((player.position() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn loops_wrap_sample_accurately_and_seek_restores_programs() {
        let Some(font) = font() else { return };
        let mut player = Player::new(song(), &font, 44100).unwrap();
        let mut stems = vec![Stem::new(44100)];
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
        let mut player = Player::new(song(), &font, 44100).unwrap();
        let mut stems = vec![Stem::new(44100)];
        player.seek(0.25);
        player.play();
        // The second note starts at 0.5 s = 11025 frames after 0.25 s; 64-frame synth blocks.
        player.render(&mut stems, 22050);
        assert_eq!(energy(&stems[0], 0, 11025), 0.0);
        assert!(energy(&stems[0], 11025 + 64, 22050) > 0.0);
    }
}
