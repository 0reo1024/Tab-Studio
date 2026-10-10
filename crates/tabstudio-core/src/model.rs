//! The document model. It mirrors the alphaTab JSON the app works with today
//! (JsonConverter.scoreToJsObject plus the app's studio* data), so loading and saving
//! through it is lossless: the structure and the fields edits use are typed; every other
//! field of a node is kept verbatim in `extra` and written back unchanged. Typed fields
//! grow as edit commands move into the core (P3-6).
//!
//! Every node also gets a stable id (`uid`) for the session: it survives edits that move
//! things around (inserting a bar shifts indexes, not ids) and is what change-sets and
//! the op log refer to. It is not part of the file format.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type Extra = Map<String, Value>;

/// Session-stable node identity (not saved).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Uid(pub u32);

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Score {
    #[serde(rename = "masterbars", default)]
    pub master_bars: Vec<MasterBar>,
    #[serde(default)]
    pub tracks: Vec<Track>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct MasterBar {
    #[serde(skip)]
    pub uid: Uid,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Track {
    #[serde(skip)]
    pub uid: Uid,
    #[serde(default)]
    pub staves: Vec<Staff>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Staff {
    #[serde(skip)]
    pub uid: Uid,
    #[serde(default)]
    pub bars: Vec<Bar>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Bar {
    #[serde(skip)]
    pub uid: Uid,
    #[serde(default)]
    pub voices: Vec<Voice>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Voice {
    #[serde(skip)]
    pub uid: Uid,
    #[serde(default)]
    pub beats: Vec<Beat>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Beat {
    #[serde(skip)]
    pub uid: Uid,
    #[serde(default)]
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

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
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
