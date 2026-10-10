//! The playback event list the WebView sends once per MIDI (re)load: alphaTab's
//! MidiFileGenerator output after the app's adjustments, in a compact binary form
//! (src/audio/event-list.ts writes it). Times are resolved once into seconds at speed 1.
//!
//! Layout (little endian): "TSEV", u32 version (1), u32 division, u32 count, then
//! `count` records of 16 bytes: u32 tick, u8 kind, u8 channel, u8 data1, u8 data2,
//! u32 value, u16 track, u16 articulation. The articulation (SFZ instruments, from
//! src/sfz-articulations.ts) packs the string lane (bits 0-6, 0 = none), a "continued"
//! flag for ties and legato slides (bit 7) and the keyswitch key (bits 8-15); for a
//! per-note bend `data2` carries the bend's reference key.

pub const KIND_NOTE_OFF: u8 = 0x80;
pub const KIND_NOTE_ON: u8 = 0x90;
pub const KIND_KEY_PRESSURE: u8 = 0xA0;
pub const KIND_CONTROL: u8 = 0xB0;
pub const KIND_PROGRAM: u8 = 0xC0;
pub const KIND_CHANNEL_PRESSURE: u8 = 0xD0;
/// Pitch wheel; `value` holds the 14-bit wheel position (8192 = center).
pub const KIND_PITCH_BEND: u8 = 0xE0;
/// Per-note pitch bend; `data1` = key, `value` = 32-bit bend (0x80000000 = center).
pub const KIND_NOTE_BEND: u8 = 0x60;
/// Tempo; `value` = beats per minute x 1000.
pub const KIND_TEMPO: u8 = 0x51;
/// Time signature; `data1` = numerator, `data2` = denominator as a power of two.
pub const KIND_TIME_SIGNATURE: u8 = 0x58;
pub const KIND_END: u8 = 0x2F;
/// alphaTab's MidiFile.tickShift (lead-in for notes before the first beat); `value` = ticks.
pub const KIND_TICK_SHIFT: u8 = 0x7E;

const RECORD: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Event {
    pub tick: u32,
    pub kind: u8,
    pub channel: u8,
    pub data1: u8,
    pub data2: u8,
    pub value: u32,
    pub track: u16,
    /// SFZ articulation, see the module docs.
    pub articulation: u16,
    /// Seconds from the song start at playback speed 1.
    pub time: f64,
}

impl Event {
    pub fn lane(&self) -> u8 {
        (self.articulation & 0x7F) as u8
    }
    pub fn continued(&self) -> bool {
        self.articulation & 0x80 != 0
    }
    pub fn keyswitch(&self) -> u8 {
        (self.articulation >> 8) as u8 & 0x7F
    }
    pub fn is_channel_event(&self) -> bool {
        (0x80..=0xE0).contains(&self.kind) || self.kind == KIND_NOTE_BEND
    }
}

#[derive(Clone, Debug, Default)]
pub struct Song {
    pub division: u32,
    pub events: Vec<Event>,
    /// Number of tracks (highest track index + 1); each track renders as its own stem.
    pub tracks: usize,
    /// (tick, seconds, seconds per tick) at each tempo change, for tick <-> time.
    tempo_map: Vec<(u32, f64, f64)>,
    pub end_tick: u32,
    pub end_time: f64,
    /// Metronome beats (seconds at speed 1, accent), as alphaTab's sequencer places them.
    pub metronome: Vec<(f64, bool)>,
}

#[derive(Debug, PartialEq)]
pub struct ParseError(pub &'static str);

impl Song {
    /// Lanes and pitches each track's SFZ instrument needs (note-ons with a string lane;
    /// lane 0 for notes without one).
    pub fn sfz_pitches(&self, track: u16) -> std::collections::BTreeMap<u8, std::collections::BTreeSet<u8>> {
        let mut out = std::collections::BTreeMap::new();
        for e in self.events.iter().filter(|e| e.track == track && e.kind == KIND_NOTE_ON) {
            out.entry(e.lane()).or_insert_with(std::collections::BTreeSet::new).insert(e.data1);
        }
        out
    }

    /// The Standard Guitar articulations each lane uses (keyswitches as `note_on` sends them).
    pub fn sfz_switches(&self, track: u16) -> std::collections::BTreeMap<u8, std::collections::BTreeSet<u8>> {
        let mut out = std::collections::BTreeMap::new();
        for e in self.events.iter().filter(|e| e.track == track && e.kind == KIND_NOTE_ON) {
            out.entry(e.lane()).or_insert_with(std::collections::BTreeSet::new).insert(crate::sfz::standard_switch(e.keyswitch()));
        }
        out
    }

    pub fn parse(bytes: &[u8]) -> Result<Song, ParseError> {
        if bytes.len() < 16 || &bytes[..4] != b"TSEV" {
            return Err(ParseError("not an event list"));
        }
        let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        if word(4) != 1 {
            return Err(ParseError("unsupported event list version"));
        }
        let division = word(8).max(1);
        let count = word(12) as usize;
        if bytes.len() != 16 + count * RECORD {
            return Err(ParseError("event list has the wrong length"));
        }
        let events: Vec<Event> = (0..count)
            .map(|i| {
                let r = &bytes[16 + i * RECORD..16 + (i + 1) * RECORD];
                Event {
                    tick: u32::from_le_bytes(r[0..4].try_into().unwrap()),
                    kind: r[4],
                    channel: r[5] & 0x0F,
                    data1: r[6] & 0x7F,
                    data2: r[7] & 0x7F,
                    value: u32::from_le_bytes(r[8..12].try_into().unwrap()),
                    track: u16::from_le_bytes(r[12..14].try_into().unwrap()),
                    articulation: u16::from_le_bytes(r[14..16].try_into().unwrap()),
                    time: 0.0,
                }
            })
            .collect();
        Ok(Song::from_events(division, events))
    }

    pub fn from_events(division: u32, mut events: Vec<Event>) -> Song {
        // Stable: events at the same tick keep the generator's order (bend before note-on).
        events.sort_by_key(|e| e.tick);
        let mut tempo_map = vec![(0u32, 0.0f64, 60.0 / (120.0 * division as f64))];
        for e in events.iter().filter(|e| e.kind == KIND_TEMPO && e.value > 0) {
            let &(tick, time, spt) = tempo_map.last().unwrap();
            let at = time + (e.tick - tick) as f64 * spt;
            let next = 60.0 / (e.value as f64 / 1000.0 * division as f64);
            if e.tick == tick {
                tempo_map.last_mut().unwrap().2 = next;
            } else {
                tempo_map.push((e.tick, at, next));
            }
        }
        let mut song = Song { division, events: Vec::new(), tracks: 0, tempo_map, end_tick: 0, end_time: 0.0, metronome: Vec::new() };
        for e in &mut events {
            e.time = song.tick_to_time(e.tick);
        }
        song.end_tick = events.iter().map(|e| e.tick).max().unwrap_or(0);
        song.end_time = song.tick_to_time(song.end_tick);
        song.tracks = events.iter().filter(|e| e.kind != KIND_TICK_SHIFT).map(|e| e.track as usize + 1).max().unwrap_or(0);
        song.metronome = metronome_beats(&song, &events);
        song.events = events;
        song
    }

    pub fn tick_to_time(&self, tick: u32) -> f64 {
        let index = self.tempo_map.partition_point(|&(t, _, _)| t <= tick).saturating_sub(1);
        let (t, time, spt) = self.tempo_map[index];
        time + (tick - t) as f64 * spt
    }

    pub fn time_to_tick(&self, seconds: f64) -> f64 {
        let index = self.tempo_map.partition_point(|&(_, time, _)| time <= seconds).saturating_sub(1);
        let (t, time, spt) = self.tempo_map[index];
        t as f64 + (seconds - time) / spt
    }

    /// Index of the first event at or after `seconds`.
    pub fn index_at(&self, seconds: f64) -> usize {
        self.events.partition_point(|e| e.time < seconds)
    }
}

/// Port of alphaTab MidiFileSequencer's metronome placement: a beat every denominator
/// unit from the tick shift, numbered `floor(tick / length) % numerator` (0 = accent),
/// emitted while walking the events (so beats stop at the last event).
fn metronome_beats(song: &Song, events: &[Event]) -> Vec<(f64, bool)> {
    let mut beats = Vec::new();
    let mut tick = events.iter().find(|e| e.kind == KIND_TICK_SHIFT).map_or(0, |e| e.value) as u64;
    let (mut length, mut count) = (0u64, 0u64);
    for e in events {
        if length > 0 {
            while tick < e.tick as u64 {
                beats.push((song.tick_to_time(tick as u32), (tick / length) % count.max(1) == 0));
                tick += length;
            }
        }
        if e.kind == KIND_TIME_SIGNATURE {
            count = e.data1.max(1) as u64;
            length = (song.division as u64 * 4) >> e.data2.min(6);
        }
    }
    beats
}

/// Writes an event list in the binary layout (tests and the CLI harness).
pub fn encode(division: u32, events: &[Event]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + events.len() * RECORD);
    out.extend_from_slice(b"TSEV");
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&division.to_le_bytes());
    out.extend_from_slice(&(events.len() as u32).to_le_bytes());
    for e in events {
        out.extend_from_slice(&e.tick.to_le_bytes());
        out.extend_from_slice(&[e.kind, e.channel, e.data1, e.data2]);
        out.extend_from_slice(&e.value.to_le_bytes());
        out.extend_from_slice(&e.track.to_le_bytes());
        out.extend_from_slice(&e.articulation.to_le_bytes());
    }
    out
}

#[cfg(test)]
pub(crate) fn event(tick: u32, kind: u8, channel: u8, data1: u8, data2: u8, value: u32, track: u16) -> Event {
    Event { tick, kind, channel, data1, data2, value, track, articulation: 0, time: 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tempo_changes_map_ticks_to_seconds_both_ways() {
        // 120 bpm for 2 bars of 4/4 (division 960), then 60 bpm.
        let events = vec![event(0, KIND_TEMPO, 0, 0, 0, 120_000, 0), event(7680, KIND_TEMPO, 0, 0, 0, 60_000, 0), event(15360, KIND_END, 0, 0, 0, 0, 1)];
        let song = Song::parse(&encode(960, &events)).unwrap();
        assert!((song.tick_to_time(3840) - 2.0).abs() < 1e-9);
        assert!((song.tick_to_time(7680) - 4.0).abs() < 1e-9);
        assert!((song.tick_to_time(11520) - 8.0).abs() < 1e-9);
        assert!((song.end_time - 12.0).abs() < 1e-9);
        assert!((song.time_to_tick(6.0) - 9600.0).abs() < 1e-6);
        assert!((song.time_to_tick(1.0) - 1920.0).abs() < 1e-6);
        assert_eq!(song.tracks, 2);
        assert_eq!(song.index_at(4.0), 1);
        assert!(song.metronome.is_empty(), "no time signature, no beats");
    }

    #[test]
    fn metronome_beats_follow_time_signatures_like_alphatab() {
        // 4/4 bar, then 6/8 from tick 3840; the song ends at tick 3840 + 2880.
        let events = vec![
            event(0, KIND_TEMPO, 0, 0, 0, 120_000, 0),
            event(0, KIND_TIME_SIGNATURE, 0, 4, 2, 0, 0),
            event(3840, KIND_TIME_SIGNATURE, 0, 6, 3, 0, 0),
            event(6720, KIND_END, 0, 0, 0, 0, 0),
        ];
        let song = Song::from_events(960, events);
        let ticks: Vec<u32> = song.metronome.iter().map(|&(t, _)| song.time_to_tick(t).round() as u32).collect();
        assert_eq!(ticks, vec![0, 960, 1920, 2880, 3840, 4320, 4800, 5280, 5760, 6240]);
        // Numbering is floor(tick / length) % numerator, as alphaTab does (not bar-relative).
        assert_eq!(song.metronome.iter().map(|b| b.1).collect::<Vec<_>>(), vec![true, false, false, false, false, false, false, false, true, false]);
    }

    #[test]
    fn articulations_round_trip_and_list_sfz_pitches() {
        let mut on = event(0, KIND_NOTE_ON, 0, 40, 90, 0, 1);
        on.articulation = 6 | 0x80 | (27 << 8);
        let mut other = event(480, KIND_NOTE_ON, 0, 45, 90, 0, 1);
        other.articulation = 5;
        let song = Song::parse(&encode(960, &[on, other, event(960, KIND_NOTE_ON, 0, 50, 90, 0, 0)])).unwrap();
        let e = song.events[0];
        assert_eq!((e.lane(), e.continued(), e.keyswitch()), (6, true, 27));
        let pitches = song.sfz_pitches(1);
        assert_eq!(pitches.keys().copied().collect::<Vec<_>>(), vec![5, 6]);
        assert!(pitches[&6].contains(&40) && pitches[&5].contains(&45));
        assert!(song.sfz_pitches(0).contains_key(&0));
    }

    #[test]
    fn rejects_bad_input_and_keeps_same_tick_order() {
        assert_eq!(Song::parse(b"nope").unwrap_err(), ParseError("not an event list"));
        let mut bytes = encode(960, &[event(0, KIND_NOTE_ON, 0, 40, 90, 0, 0)]);
        bytes.push(0);
        assert!(Song::parse(&bytes).is_err());
        let events = vec![event(480, KIND_NOTE_BEND, 0, 40, 0, 0x8000_0000, 0), event(480, KIND_NOTE_ON, 0, 40, 90, 0, 0), event(0, KIND_PROGRAM, 0, 27, 0, 0, 0)];
        let song = Song::parse(&encode(960, &events)).unwrap();
        assert_eq!(song.events.iter().map(|e| e.kind).collect::<Vec<_>>(), vec![KIND_PROGRAM, KIND_NOTE_BEND, KIND_NOTE_ON]);
    }
}
