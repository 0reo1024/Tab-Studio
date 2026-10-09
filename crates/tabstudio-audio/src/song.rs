//! The playback event list the WebView sends once per MIDI (re)load: alphaTab's
//! MidiFileGenerator output after the app's adjustments, in a compact binary form
//! (src/audio/event-list.ts writes it). Times are resolved once into seconds at speed 1.
//!
//! Layout (little endian): "TSEV", u32 version (1), u32 division, u32 count, then
//! `count` records of 16 bytes: u32 tick, u8 kind, u8 channel, u8 data1, u8 data2,
//! u32 value, u16 track, u16 reserved.

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
    /// Seconds from the song start at playback speed 1.
    pub time: f64,
}

impl Event {
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
}

#[derive(Debug, PartialEq)]
pub struct ParseError(pub &'static str);

impl Song {
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
        let mut events: Vec<Event> = (0..count)
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
                    time: 0.0,
                }
            })
            .collect();
        // Stable: events at the same tick keep the generator's order (bend before note-on).
        events.sort_by_key(|e| e.tick);
        Ok(Song::from_events(division, events))
    }

    pub fn from_events(division: u32, mut events: Vec<Event>) -> Song {
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
        let mut song = Song { division, events: Vec::new(), tracks: 0, tempo_map, end_tick: 0, end_time: 0.0 };
        for e in &mut events {
            e.time = song.tick_to_time(e.tick);
        }
        song.end_tick = events.iter().map(|e| e.tick).max().unwrap_or(0);
        song.end_time = song.tick_to_time(song.end_tick);
        song.tracks = events.iter().map(|e| e.track as usize + 1).max().unwrap_or(0);
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
        out.extend_from_slice(&[0, 0]);
    }
    out
}

#[cfg(test)]
pub(crate) fn event(tick: u32, kind: u8, channel: u8, data1: u8, data2: u8, value: u32, track: u16) -> Event {
    Event { tick, kind, channel, data1, data2, value, track, time: 0.0 }
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
