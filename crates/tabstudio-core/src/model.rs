//! The document model. It mirrors the alphaTab JSON the app works with today
//! (JsonConverter.scoreToJsObject plus the app's studio* data), so loading and saving
//! through it is lossless: the structure and the fields edits use are typed; every other
//! field of a node is kept verbatim in `extra` and written back unchanged. Typed fields
//! grow as edit commands move into the core (P3-6).
//!
//! Every node also gets a stable id (`uid`) for the session: it survives edits that move
//! things around (inserting a bar shifts indexes, not ids) and is what change-sets and
//! the op log refer to. It is not part of the file format.
use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

pub type Extra = Map<String, Value>;

// Reading: the JSON is parsed once into a Value and the nodes take their maps apart by
// moving (typed fields and child lists out, the rest stays as `extra`). serde's flatten
// re-buffers every nested level and became very slow on long songs (a 56 MB score took
// minutes in WASM); this is linear.

fn object(value: Value, what: &str) -> Result<Extra, String> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(format!("{what} はオブジェクトではありません。")),
    }
}

fn children<T>(map: &mut Extra, key: &str, read: fn(Value) -> Result<T, String>) -> Result<Vec<T>, String> {
    match map.shift_remove(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items.into_iter().map(read).collect(),
        Some(_) => Err(format!("{key} はリストではありません。")),
    }
}

/// An integer field becomes typed; anything else (null, a float) stays verbatim in `extra`.
fn int(map: &mut Extra, key: &str) -> Option<i32> {
    let n = map.get(key)?.as_i64().filter(|n| i32::try_from(*n).is_ok())?;
    map.shift_remove(key);
    Some(n as i32)
}

fn boolean(map: &mut Extra, key: &str) -> Option<bool> {
    let b = map.get(key)?.as_bool()?;
    map.shift_remove(key);
    Some(b)
}

macro_rules! from_value_deserialize {
    ($($t:ty),*) => {$(
        impl<'de> Deserialize<'de> for $t {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                <$t>::from_value(Value::deserialize(d)?).map_err(serde::de::Error::custom)
            }
        }
    )*};
}
from_value_deserialize!(Score, MasterBar, Track, Staff, Bar, Voice, Beat, Note);

impl Score {
    pub fn from_value(v: Value) -> Result<Score, String> {
        let mut m = object(v, "譜面")?;
        Ok(Score { master_bars: children(&mut m, "masterbars", MasterBar::from_value)?, tracks: children(&mut m, "tracks", Track::from_value)?, extra: m })
    }
}
impl MasterBar {
    pub fn from_value(v: Value) -> Result<MasterBar, String> {
        Ok(MasterBar { uid: Uid::default(), extra: object(v, "小節情報")? })
    }
}
impl Track {
    pub fn from_value(v: Value) -> Result<Track, String> {
        let mut m = object(v, "トラック")?;
        Ok(Track { uid: Uid::default(), staves: children(&mut m, "staves", Staff::from_value)?, extra: m })
    }
}
impl Staff {
    pub fn from_value(v: Value) -> Result<Staff, String> {
        let mut m = object(v, "五線")?;
        Ok(Staff { uid: Uid::default(), bars: children(&mut m, "bars", Bar::from_value)?, extra: m })
    }
}
impl Bar {
    pub fn from_value(v: Value) -> Result<Bar, String> {
        let mut m = object(v, "小節")?;
        Ok(Bar { uid: Uid::default(), raw: None, voices: children(&mut m, "voices", Voice::from_value)?, extra: m })
    }
}
impl Voice {
    pub fn from_value(v: Value) -> Result<Voice, String> {
        let mut m = object(v, "声部")?;
        Ok(Voice { uid: Uid::default(), beats: children(&mut m, "beats", Beat::from_value)?, extra: m })
    }
}
impl Beat {
    pub fn from_value(v: Value) -> Result<Beat, String> {
        let mut m = object(v, "拍")?;
        let notes = children(&mut m, "notes", Note::from_value)?;
        Ok(Beat { uid: Uid::default(), notes, duration: int(&mut m, "duration"), dots: int(&mut m, "dots"), is_empty: boolean(&mut m, "isempty"), extra: m })
    }
}
impl Note {
    pub fn from_value(v: Value) -> Result<Note, String> {
        let mut m = object(v, "音符")?;
        Ok(Note { uid: Uid::default(), fret: int(&mut m, "fret"), string: int(&mut m, "string"), extra: m })
    }
}

/// Session-stable node identity (not saved).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Uid(pub u32);

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Score {
    #[serde(rename = "masterbars")]
    pub master_bars: Vec<MasterBar>,
    pub tracks: Vec<Track>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct MasterBar {
    #[serde(skip)]
    pub uid: Uid,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Track {
    #[serde(skip)]
    pub uid: Uid,
    pub staves: Vec<Staff>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Staff {
    #[serde(skip)]
    pub uid: Uid,
    pub bars: Vec<Bar>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A measure. Loaded measures stay as their JSON text (`raw`) until something reads or
/// edits inside them (Document::ensure_bar): most of a long song is never touched, and
/// keeping millions of small JSON values made the core heavy in WASM (a 600-bar,
/// 8-track song took minutes and gigabytes). While `raw` is set, `voices` and `extra`
/// are empty and unused.
#[derive(Clone, Debug, Default)]
pub struct Bar {
    pub uid: Uid,
    pub raw: Option<Box<RawValue>>,
    pub voices: Vec<Voice>,
    pub extra: Extra,
}

impl Serialize for Bar {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if let Some(raw) = &self.raw {
            return raw.serialize(s);
        }
        let mut map = s.serialize_map(Some(self.extra.len() + 1))?;
        map.serialize_entry("voices", &self.voices)?;
        for (k, v) in &self.extra {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

impl PartialEq for Bar {
    /// Same content (raw or parsed).
    fn eq(&self, other: &Bar) -> bool {
        self.uid == other.uid && serde_json::to_value(self).ok() == serde_json::to_value(other).ok()
    }
}

impl Bar {
    pub fn is_parsed(&self) -> bool {
        self.raw.is_none()
    }
    /// Parses a raw measure in place, numbering its voices, beats and notes with `id`.
    pub fn parse(&mut self, id: &mut dyn FnMut() -> Uid) -> Result<(), String> {
        let Some(raw) = self.raw.take() else { return Ok(()) };
        let value: Value = match serde_json::from_str(raw.get()) {
            Ok(v) => v,
            Err(e) => {
                self.raw = Some(raw);
                return Err(format!("小節を読み込めません：{e}"));
            }
        };
        let parsed = match Bar::from_value(value) {
            Ok(b) => b,
            Err(e) => {
                self.raw = Some(raw);
                return Err(e);
            }
        };
        self.voices = parsed.voices;
        self.extra = parsed.extra;
        for v in &mut self.voices {
            v.uid = id();
            for b in &mut v.beats {
                b.uid = id();
                for n in &mut b.notes {
                    n.uid = id();
                }
            }
        }
        Ok(())
    }
}

/// Reads a score keeping each measure as raw JSON (see Bar).
pub fn score_from_json(json: &str) -> Result<Score, String> {
    let lazy: LazyScore = serde_json::from_str(json).map_err(|e| format!("譜面データを読み込めません：{e}"))?;
    Ok(lazy.0)
}

/// Collects an object's fields: `child` names the list read with `read_child`, every other
/// field goes into `extra` as a Value.
fn visit_object<'de, A: MapAccess<'de>, T: Deserialize<'de>>(mut map: A, child: &str) -> Result<(Vec<T>, Extra), A::Error> {
    let mut children = Vec::new();
    let mut extra = Extra::new();
    while let Some(key) = map.next_key::<String>()? {
        if key == child {
            children = map.next_value::<Vec<T>>()?;
        } else {
            let value = map.next_value::<Value>()?;
            extra.insert(key, value);
        }
    }
    Ok((children, extra))
}

struct LazyScore(Score);
struct LazyTrack(Track);
struct LazyStaff(Staff);
struct RawBar(Bar);

impl<'de> Deserialize<'de> for RawBar {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(RawBar(Bar { raw: Some(Box::<RawValue>::deserialize(d)?), ..Default::default() }))
    }
}

macro_rules! lazy_visitor {
    ($name:ident, $what:literal, |$map:ident| $body:expr) => {
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                struct V;
                impl<'de> Visitor<'de> for V {
                    type Value = $name;
                    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                        f.write_str($what)
                    }
                    fn visit_map<A: MapAccess<'de>>(self, $map: A) -> Result<$name, A::Error> {
                        $body
                    }
                }
                d.deserialize_map(V)
            }
        }
    };
}

lazy_visitor!(LazyStaff, "a staff", |map| {
    let (bars, extra) = visit_object::<_, RawBar>(map, "bars")?;
    Ok(LazyStaff(Staff { uid: Uid::default(), bars: bars.into_iter().map(|b| b.0).collect(), extra }))
});
lazy_visitor!(LazyTrack, "a track", |map| {
    let (staves, extra) = visit_object::<_, LazyStaff>(map, "staves")?;
    Ok(LazyTrack(Track { uid: Uid::default(), staves: staves.into_iter().map(|s| s.0).collect(), extra }))
});
lazy_visitor!(LazyScore, "a score", |map| {
    let mut map = map;
    let mut tracks = Vec::new();
    let mut master_bars = Vec::new();
    let mut extra = Extra::new();
    while let Some(key) = map.next_key::<String>()? {
        match key.as_str() {
            "tracks" => tracks = map.next_value::<Vec<LazyTrack>>()?.into_iter().map(|t| t.0).collect(),
            "masterbars" => master_bars = map.next_value::<Vec<MasterBar>>()?,
            _ => {
                let value = map.next_value::<Value>()?;
                extra.insert(key, value);
            }
        }
    }
    Ok(LazyScore(Score { master_bars, tracks, extra }))
});

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Voice {
    #[serde(skip)]
    pub uid: Uid,
    pub beats: Vec<Beat>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Beat {
    #[serde(skip)]
    pub uid: Uid,
    pub notes: Vec<Note>,
    /// alphaTab Duration: 1 = whole, 2 = half, 4 = quarter, ... (negative: double/quadruple whole).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dots: Option<i32>,
    #[serde(rename = "isempty", skip_serializing_if = "Option::is_none")]
    pub is_empty: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Note {
    #[serde(skip)]
    pub uid: Uid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fret: Option<i32>,
    /// alphaTab string number: 1 = the lowest-pitched string; tuning.length is the
    /// highest-pitched one (the top line of the tab).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub string: Option<i32>,
    #[serde(flatten)]
    pub extra: Extra,
}
