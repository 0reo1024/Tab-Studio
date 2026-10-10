//! The boundary format: ops and change-sets as JSON the WebView (and tests) speak.
//! Nodes are addressed by position ({track, staff, bar, voice, beat, note}) when an edit
//! is made; inside the core they become session uids, so the undo log stays valid when
//! later edits move things.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::*;
use crate::ops::{ChangeSet, List, Node, Op};
use crate::Document;

/// A position in the score; the deepest given index names the node.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct At {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub masterbar: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staff: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bar: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beat: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum EditOp {
    /// Sets (value present) or removes (value null/absent) a field of the node at `at`.
    Set {
        at: At,
        key: String,
        #[serde(default)]
        value: Option<Value>,
    },
    /// Inserts `node` (alphaTab JSON) into the list `list` of the node at `at`
    /// ("masterbars"/"tracks" with an empty `at`).
    Insert { at: At, list: String, index: usize, node: Value },
    /// Removes item `index` of `list` under the node at `at`.
    Remove { at: At, list: String, index: usize },
    /// Replaces item `index` of `list` under the node at `at` with `node` (content change).
    Replace { at: At, list: String, index: usize, node: Value },
    /// Replaces the whole score (alphaTab JSON): structure changes not expressed as ops.
    ReplaceScore { score: Value },
}

/// Change-set in positions, for the adapter: which bars to refresh, or rebuild.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    /// [track, staff, bar] of every changed bar.
    pub bars: Vec<[usize; 3]>,
    pub structure: bool,
    pub song: bool,
}

fn list(name: &str) -> Result<List, String> {
    Ok(match name {
        "masterbars" => List::MasterBars,
        "tracks" => List::Tracks,
        "bars" => List::Bars,
        "voices" => List::Voices,
        "beats" => List::Beats,
        "notes" => List::Notes,
        other => return Err(format!("不明なリスト：{other}")),
    })
}

fn renumber_beat(b: &mut Beat, id: &mut dyn FnMut() -> Uid) {
    b.uid = id();
    b.notes.iter_mut().for_each(|n| n.uid = id());
}
fn renumber_voice(v: &mut Voice, id: &mut dyn FnMut() -> Uid) {
    v.uid = id();
    v.beats.iter_mut().for_each(|b| renumber_beat(b, id));
}
fn renumber_bar(b: &mut Bar, id: &mut dyn FnMut() -> Uid) {
    b.uid = id();
    b.voices.iter_mut().for_each(|v| renumber_voice(v, id));
}

impl Document {
    /// The uid of the node at a position.
    pub fn uid_at(&mut self, at: &At) -> Result<Uid, String> {
        let missing = || "指定した位置に要素がありません。".to_string();
        if *at == At::default() {
            return Ok(crate::ops::SCORE);
        }
        // Anything inside a measure (or the measure's own fields) needs it parsed.
        if let (Some(t), Some(st), Some(b)) = (at.track, at.staff, at.bar) {
            self.ensure_bar(t, st, b)?;
        }
        let s = &self.score;
        if let Some(m) = at.masterbar {
            return s.master_bars.get(m).map(|m| m.uid).ok_or_else(missing);
        }
        let track = s.tracks.get(at.track.ok_or_else(missing)?).ok_or_else(missing)?;
        let Some(st) = at.staff else { return Ok(track.uid) };
        let staff = track.staves.get(st).ok_or_else(missing)?;
        let Some(b) = at.bar else { return Ok(staff.uid) };
        let bar = staff.bars.get(b).ok_or_else(missing)?;
        let Some(v) = at.voice else { return Ok(bar.uid) };
        let voice = bar.voices.get(v).ok_or_else(missing)?;
        let Some(be) = at.beat else { return Ok(voice.uid) };
        let beat = voice.beats.get(be).ok_or_else(missing)?;
        let Some(n) = at.note else { return Ok(beat.uid) };
        beat.notes.get(n).map(|n| n.uid).ok_or_else(missing)
    }

    /// Reads a node from JSON for `list`, giving it and its children fresh uids.
    fn node_from_json(&mut self, list: List, value: Value) -> Result<Node, String> {
        let bad = |e: serde_json::Error| format!("挿入する要素が不正です：{e}");
        let mut node = match list {
            List::MasterBars => Node::MasterBar(serde_json::from_value(value).map_err(bad)?),
            List::Tracks => Node::Track(serde_json::from_value(value).map_err(bad)?),
            List::Bars => Node::Bar(serde_json::from_value(value).map_err(bad)?),
            List::Voices => Node::Voice(serde_json::from_value(value).map_err(bad)?),
            List::Beats => Node::Beat(serde_json::from_value(value).map_err(bad)?),
            List::Notes => Node::Note(serde_json::from_value(value).map_err(bad)?),
        };
        let mut id = || self.fresh_uid();
        match &mut node {
            Node::MasterBar(m) => m.uid = id(),
            Node::Track(t) => {
                t.uid = id();
                for s in &mut t.staves {
                    s.uid = id();
                    s.bars.iter_mut().for_each(|b| renumber_bar(b, &mut id));
                }
            }
            Node::Bar(b) => renumber_bar(b, &mut id),
            Node::Voice(v) => renumber_voice(v, &mut id),
            Node::Beat(b) => renumber_beat(b, &mut id),
            Node::Note(n) => n.uid = id(),
        }
        Ok(node)
    }

    fn parent_uid(&mut self, at: &At) -> Result<Option<Uid>, String> {
        if *at == At::default() {
            Ok(None)
        } else {
            self.uid_at(at).map(Some)
        }
    }

    /// Turns boundary ops into core ops (positions -> uids), in order.
    pub fn resolve(&mut self, ops: Vec<EditOp>) -> Result<Vec<Op>, String> {
        let mut out = Vec::with_capacity(ops.len());
        for op in ops {
            out.push(match op {
                EditOp::Set { at, key, value } => Op::SetField { node: self.uid_at(&at)?, key, value: value.filter(|v| !v.is_null()) },
                EditOp::Insert { at, list: name, index, node } => {
                    let l = list(&name)?;
                    let parent = self.parent_uid(&at)?;
                    Op::Insert { parent, list: l, index, node: Box::new(self.node_from_json(l, node)?) }
                }
                EditOp::Remove { at, list: name, index } => Op::Remove { parent: self.parent_uid(&at)?, list: list(&name)?, index },
                EditOp::Replace { at, list: name, index, node } => {
                    let l = list(&name)?;
                    let parent = self.parent_uid(&at)?;
                    Op::Replace { parent, list: l, index, node: Box::new(self.node_from_json(l, node)?) }
                }
                EditOp::ReplaceScore { score } => {
                    let score: Score = serde_json::from_value(score).map_err(|e| format!("譜面データが不正です：{e}"))?;
                    let mut doc = Document::with_score(score);
                    doc.renumber_from(self.next_uid());
                    self.set_next_uid(doc.next_uid());
                    Op::ReplaceScore { score: Box::new(doc.score) }
                }
            });
        }
        Ok(out)
    }

    /// A change-set in positions (as the document is now).
    pub fn positions(&self, changes: &ChangeSet) -> Changes {
        let mut bars = Vec::new();
        for (track, staff, bar) in &changes.bars {
            let Some(t) = self.score.tracks.iter().position(|x| x.uid == *track) else { continue };
            let Some(s) = self.score.tracks[t].staves.iter().position(|x| x.uid == *staff) else { continue };
            bars.push([t, s, *bar]);
        }
        Changes { bars, structure: changes.structure, song: changes.song }
    }

    /// One user action from boundary JSON (an array of EditOp); returns Changes JSON.
    /// Positions in later ops refer to the document after the earlier ops of the same
    /// action have been applied, so ops are resolved and applied one at a time.
    pub fn edit_json(&mut self, label: &str, ops_json: &str) -> Result<String, String> {
        let ops: Vec<EditOp> = serde_json::from_str(ops_json).map_err(|e| format!("編集データが不正です：{e}"))?;
        let changes = self.transact_with(label, ops.len(), |doc, i| {
            let op = ops[i].clone();
            Ok(doc.resolve(vec![op])?.remove(0))
        })?;
        Ok(serde_json::to_string(&self.positions(&changes)).unwrap())
    }

    /// The JSON of one node (for the adapter to refresh a bar), or of the whole score.
    pub fn node_json(&self, at: &At) -> Result<String, String> {
        let s = &self.score;
        let err = |_| "要素を書き出せません。".to_string();
        if *at == At::default() {
            return Ok(self.to_json());
        }
        if let Some(m) = at.masterbar {
            return serde_json::to_string(s.master_bars.get(m).ok_or("小節がありません。")?).map_err(err);
        }
        let t = s.tracks.get(at.track.unwrap_or(0)).ok_or("トラックがありません。")?;
        let Some(st) = at.staff else { return serde_json::to_string(t).map_err(err) };
        let staff = t.staves.get(st).ok_or("五線がありません。")?;
        let Some(b) = at.bar else { return serde_json::to_string(staff).map_err(err) };
        serde_json::to_string(staff.bars.get(b).ok_or("小節がありません。")?).map_err(err)
    }
}

impl Document {
    /// A track (with its staves, each without bars) or a staff without its bars: what is
    /// needed to rebuild one bar in the view without serializing the whole track.
    pub fn header_json(&self, at: &At) -> Result<String, String> {
        let t = self.score.tracks.get(at.track.ok_or("トラックを指定してください。")?).ok_or("トラックがありません。")?;
        let value = match at.staff {
            None => serde_json::to_string(&t.clone_header()),
            Some(st) => {
                let staff = t.staves.get(st).ok_or("五線がありません。")?;
                serde_json::to_string(&Staff { uid: staff.uid, bars: Vec::new(), extra: staff.extra.clone() })
            }
        };
        value.map_err(|_| "要素を書き出せません。".to_string())
    }
}

impl Track {
    fn clone_header(&self) -> Track {
        Track { uid: self.uid, staves: self.staves.iter().map(|s| Staff { uid: s.uid, bars: Vec::new(), extra: s.extra.clone() }).collect(), extra: self.extra.clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn score_fields_and_whole_score_replacement_are_undoable() {
        let mut doc = demo();
        let before: Value = serde_json::from_str(&doc.to_json()).unwrap();
        let changes = doc.edit_json("title", &json!([{"op": "set", "at": {}, "key": "title", "value": "New"}]).to_string()).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&changes).unwrap()["song"], json!(true));
        let mut other = before.clone();
        other["masterbars"].as_array_mut().unwrap().truncate(1);
        other["tracks"][0]["staves"][0]["bars"].as_array_mut().unwrap().truncate(1);
        let changes = doc.edit_json("replace", &json!([{"op": "replaceScore", "score": other}]).to_string()).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&changes).unwrap()["structure"], json!(true));
        assert_eq!(doc.score.master_bars.len(), 1);
        assert!(doc.score.tracks[0].staves[0].bars[0].uid.0 > 0);
        doc.undo().unwrap().unwrap();
        doc.undo().unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&doc.to_json()).unwrap(), before);
    }

    #[test]
    fn replacing_a_bar_is_a_content_change_of_that_bar() {
        let mut doc = demo();
        let before: Value = serde_json::from_str(&doc.to_json()).unwrap();
        let mut bar: Value = serde_json::from_str(&doc.node_json(&At { track: Some(0), staff: Some(0), bar: Some(1), ..Default::default() }).unwrap()).unwrap();
        bar["voices"][0]["beats"][0]["notes"][0]["fret"] = json!(15);
        let changes = doc.edit_json("bar", &json!([{"op": "replace", "at": {"track": 0, "staff": 0}, "list": "bars", "index": 1, "node": bar}]).to_string()).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&changes).unwrap(), json!({"bars": [[0, 0, 1]], "structure": false, "song": false}));
        assert_eq!(doc.score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].fret, Some(15));
        doc.undo().unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&doc.to_json()).unwrap(), before);
    }

    #[test]
    fn untouched_measures_stay_raw_and_edits_parse_them_first() {
        let json = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/demo.json")).unwrap();
        let mut doc = Document::from_json(&json).unwrap();
        assert!(doc.score.tracks[0].staves[0].bars.iter().all(|b| !b.is_parsed()), "loaded measures are kept as JSON text");
        // A field of a raw measure itself: parsed first, so the change is written out.
        doc.edit_json("clef", &json!([{"op": "set", "at": {"track": 0, "staff": 0, "bar": 3}, "key": "clef", "value": 2}]).to_string()).unwrap();
        let bar: Value = serde_json::from_str(&doc.node_json(&At { track: Some(0), staff: Some(0), bar: Some(3), ..Default::default() }).unwrap()).unwrap();
        assert_eq!(bar["clef"], json!(2));
        assert!(doc.score.tracks[0].staves[0].bars[3].is_parsed() && !doc.score.tracks[0].staves[0].bars[0].is_parsed());
        doc.undo().unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&doc.to_json()).unwrap(), serde_json::from_str::<Value>(&json).unwrap());
    }

    #[test]
    fn headers_leave_out_children() {
        let doc = demo();
        let track: Value = serde_json::from_str(&doc.header_json(&At { track: Some(0), ..Default::default() }).unwrap()).unwrap();
        assert_eq!(track["staves"].as_array().unwrap().len(), 1);
        assert_eq!(track["staves"][0]["bars"], json!([]));
        assert!(track.get("name").is_some());
        let staff: Value = serde_json::from_str(&doc.header_json(&At { track: Some(0), staff: Some(0), ..Default::default() }).unwrap()).unwrap();
        assert_eq!(staff["bars"], json!([]));
        assert!(staff.get("stringtuning").is_some());
        assert!(doc.header_json(&At::default()).is_err());
    }

    fn demo() -> Document {
        Document::from_json(&std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/demo.json")).unwrap()).unwrap()
    }

    #[test]
    fn edits_arrive_as_json_and_report_positions() {
        let mut doc = demo();
        let changes = doc.edit_json("fret", &json!([{"op": "set", "at": {"track": 0, "staff": 0, "bar": 2, "voice": 0, "beat": 0, "note": 0}, "key": "fret", "value": 9}]).to_string()).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&changes).unwrap(), json!({"bars": [[0, 0, 2]], "structure": false, "song": false}));
        assert_eq!(doc.score.tracks[0].staves[0].bars[2].voices[0].beats[0].notes[0].fret, Some(9));
        // Inserting a note from JSON, then setting it in the same action (positions after the insert).
        doc.edit_json("add", &json!([
            {"op": "insert", "at": {"track": 0, "staff": 0, "bar": 2, "voice": 0, "beat": 0}, "list": "notes", "index": 0, "node": {"fret": 3, "string": 6}},
            {"op": "set", "at": {"track": 0, "staff": 0, "bar": 2, "voice": 0, "beat": 0, "note": 0}, "key": "fret", "value": 4}
        ]).to_string()).unwrap();
        let bar: Value = serde_json::from_str(&doc.node_json(&At { track: Some(0), staff: Some(0), bar: Some(2), ..Default::default() }).unwrap()).unwrap();
        assert_eq!(bar["voices"][0]["beats"][0]["notes"][0]["fret"], json!(4));
        // One undo step for the whole action.
        doc.undo().unwrap().unwrap();
        assert_eq!(doc.score.tracks[0].staves[0].bars[2].voices[0].beats[0].notes[0].fret, Some(9));
        assert!(doc.edit_json("bad", r#"[{"op": "set", "at": {"track": 7}, "key": "name", "value": 1}]"#).is_err());
        assert!(doc.edit_json("bad", r#"[{"op": "insert", "at": {}, "list": "chords", "index": 0, "node": {}}]"#).is_err());
    }
}
