//! Edit operations with inverses. Every user action becomes a transaction of primitive
//! ops; applying an op returns its exact inverse, so undo/redo is replaying inverses
//! (O(change), no snapshots). Ops name nodes by session uid, so inserting a bar earlier
//! in the song does not invalidate them.
use serde_json::Value;

use crate::model::*;
use crate::Document;

/// Lists a node can be inserted into / removed from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum List {
    /// Score.masterbars (parent: none).
    MasterBars,
    /// Score.tracks (parent: none).
    Tracks,
    /// Staff.bars (parent: a staff).
    Bars,
    /// Bar.voices (parent: a bar).
    Voices,
    /// Voice.beats (parent: a voice).
    Beats,
    /// Beat.notes (parent: a beat).
    Notes,
}

/// A node's data while it is outside the document (JSON as in the file, plus the uids of
/// the node and everything under it so a re-inserted node keeps its identity).
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    MasterBar(MasterBar),
    Track(Track),
    Bar(Bar),
    Voice(Voice),
    Beat(Beat),
    Note(Note),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    /// Sets (Some) or removes (None) a field of a node; typed fields included.
    SetField { node: Uid, key: String, value: Option<Value> },
    /// Inserts `node` at `index` of `list` under `parent` (None for score-level lists).
    Insert { parent: Option<Uid>, list: List, index: usize, node: Box<Node> },
    /// Removes the node at `index` of `list` under `parent`.
    Remove { parent: Option<Uid>, list: List, index: usize },
}

/// What an edit touched, for the view (alphaTab adapter) and the MIDI.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChangeSet {
    /// Bars (by index in their staff) whose content changed, per (track, staff) uid pair.
    pub bars: Vec<(Uid, Uid, usize)>,
    /// The bar or track structure changed (bars/tracks added, removed or reordered):
    /// the view rebuilds the song instead of patching bars.
    pub structure: bool,
    /// Score-level or master-bar fields changed (tempo, time signature, repeats, title...).
    pub song: bool,
}

/// Where a node is: indexes from the score down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
    MasterBar(usize),
    Track(usize),
    Staff(usize, usize),
    Bar(usize, usize, usize),
    Voice(usize, usize, usize, usize),
    Beat(usize, usize, usize, usize, usize),
    Note(usize, usize, usize, usize, usize, usize),
}

impl Document {
    fn place(&self, uid: Uid) -> Option<Place> {
        let s = &self.score;
        if let Some(i) = s.master_bars.iter().position(|m| m.uid == uid) {
            return Some(Place::MasterBar(i));
        }
        for (t, track) in s.tracks.iter().enumerate() {
            if track.uid == uid {
                return Some(Place::Track(t));
            }
            for (st, staff) in track.staves.iter().enumerate() {
                if staff.uid == uid {
                    return Some(Place::Staff(t, st));
                }
                for (b, bar) in staff.bars.iter().enumerate() {
                    if bar.uid == uid {
                        return Some(Place::Bar(t, st, b));
                    }
                    for (v, voice) in bar.voices.iter().enumerate() {
                        if voice.uid == uid {
                            return Some(Place::Voice(t, st, b, v));
                        }
                        for (be, beat) in voice.beats.iter().enumerate() {
                            if beat.uid == uid {
                                return Some(Place::Beat(t, st, b, v, be));
                            }
                            if let Some(n) = beat.notes.iter().position(|n| n.uid == uid) {
                                return Some(Place::Note(t, st, b, v, be, n));
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Applies one op; returns its inverse and records what changed.
    pub fn apply(&mut self, op: &Op, changes: &mut ChangeSet) -> Result<Op, String> {
        match op {
            Op::SetField { node, key, value } => {
                let place = self.place(*node).ok_or("編集対象が見つかりません。")?;
                let old = self.set_field(place, key, value.clone())?;
                self.note_change(place, changes);
                Ok(Op::SetField { node: *node, key: key.clone(), value: old })
            }
            Op::Insert { parent, list, index, node } => {
                self.insert(*parent, *list, *index, (**node).clone())?;
                self.note_list_change(*parent, *list, changes)?;
                Ok(Op::Remove { parent: *parent, list: *list, index: *index })
            }
            Op::Remove { parent, list, index } => {
                let node = self.remove(*parent, *list, *index)?;
                self.note_list_change(*parent, *list, changes)?;
                Ok(Op::Insert { parent: *parent, list: *list, index: *index, node: Box::new(node) })
            }
        }
    }

    fn note_change(&self, place: Place, changes: &mut ChangeSet) {
        let s = &self.score;
        let mut bar = |t: usize, st: usize, b: usize| {
            let entry = (s.tracks[t].uid, s.tracks[t].staves[st].uid, b);
            if !changes.bars.contains(&entry) {
                changes.bars.push(entry);
            }
        };
        match place {
            Place::MasterBar(_) => changes.song = true,
            Place::Track(_) | Place::Staff(..) => changes.song = true,
            Place::Bar(t, st, b) | Place::Voice(t, st, b, _) | Place::Beat(t, st, b, _, _) | Place::Note(t, st, b, _, _, _) => bar(t, st, b),
        }
    }

    fn note_list_change(&self, parent: Option<Uid>, list: List, changes: &mut ChangeSet) -> Result<(), String> {
        match list {
            List::MasterBars | List::Tracks | List::Bars => changes.structure = true,
            List::Voices | List::Beats | List::Notes => {
                let place = self.place(parent.ok_or("親がありません。")?).ok_or("編集対象が見つかりません。")?;
                self.note_change(place, changes);
            }
        }
        Ok(())
    }

    fn set_field(&mut self, place: Place, key: &str, value: Option<Value>) -> Result<Option<Value>, String> {
        let s = &mut self.score;
        macro_rules! extra {
            ($node:expr) => {{
                let extra = &mut $node.extra;
                Ok(match value {
                    Some(v) => extra.insert(key.to_string(), v),
                    None => extra.shift_remove(key),
                })
            }};
        }
        let int = |v: &Option<Value>| -> Result<Option<i32>, String> {
            match v {
                None => Ok(None),
                Some(v) => v.as_i64().map(|n| Some(n as i32)).ok_or_else(|| format!("{key} は整数です。")),
            }
        };
        match place {
            Place::MasterBar(i) => extra!(s.master_bars[i]),
            Place::Track(t) => extra!(s.tracks[t]),
            Place::Staff(t, st) => extra!(s.tracks[t].staves[st]),
            Place::Bar(t, st, b) => extra!(s.tracks[t].staves[st].bars[b]),
            Place::Voice(t, st, b, v) => extra!(s.tracks[t].staves[st].bars[b].voices[v]),
            Place::Beat(t, st, b, v, be) => {
                let beat = &mut s.tracks[t].staves[st].bars[b].voices[v].beats[be];
                match key {
                    "duration" => Ok(std::mem::replace(&mut beat.duration, int(&value)?).map(Value::from)),
                    "dots" => Ok(std::mem::replace(&mut beat.dots, int(&value)?).map(Value::from)),
                    "isempty" => {
                        let next = match &value {
                            None => None,
                            Some(v) => Some(v.as_bool().ok_or("isempty は真偽値です。")?),
                        };
                        Ok(std::mem::replace(&mut beat.is_empty, next).map(Value::from))
                    }
                    "notes" => Err("notes は Insert/Remove で編集します。".into()),
                    _ => extra!(beat),
                }
            }
            Place::Note(t, st, b, v, be, n) => {
                let note = &mut s.tracks[t].staves[st].bars[b].voices[v].beats[be].notes[n];
                match key {
                    "fret" => Ok(std::mem::replace(&mut note.fret, int(&value)?).map(Value::from)),
                    "string" => Ok(std::mem::replace(&mut note.string, int(&value)?).map(Value::from)),
                    _ => extra!(note),
                }
            }
        }
    }

    fn insert(&mut self, parent: Option<Uid>, list: List, index: usize, node: Node) -> Result<(), String> {
        let bad = || "挿入位置が不正です。".to_string();
        macro_rules! put {
            ($vec:expr, $value:expr) => {{
                let v = &mut $vec;
                if index > v.len() {
                    return Err(bad());
                }
                v.insert(index, $value);
                Ok(())
            }};
        }
        let place = match parent {
            Some(p) => Some(self.place(p).ok_or("挿入先が見つかりません。")?),
            None => None,
        };
        let s = &mut self.score;
        match (list, place, node) {
            (List::MasterBars, None, Node::MasterBar(m)) => put!(s.master_bars, m),
            (List::Tracks, None, Node::Track(t)) => put!(s.tracks, t),
            (List::Bars, Some(Place::Staff(t, st)), Node::Bar(b)) => put!(s.tracks[t].staves[st].bars, b),
            (List::Voices, Some(Place::Bar(t, st, b)), Node::Voice(v)) => put!(s.tracks[t].staves[st].bars[b].voices, v),
            (List::Beats, Some(Place::Voice(t, st, b, v)), Node::Beat(be)) => put!(s.tracks[t].staves[st].bars[b].voices[v].beats, be),
            (List::Notes, Some(Place::Beat(t, st, b, v, be)), Node::Note(n)) => put!(s.tracks[t].staves[st].bars[b].voices[v].beats[be].notes, n),
            _ => Err("この場所には挿入できません。".into()),
        }
    }

    fn remove(&mut self, parent: Option<Uid>, list: List, index: usize) -> Result<Node, String> {
        let bad = || "削除位置が不正です。".to_string();
        macro_rules! take {
            ($vec:expr, $wrap:expr) => {{
                let v = &mut $vec;
                if index >= v.len() {
                    return Err(bad());
                }
                Ok($wrap(v.remove(index)))
            }};
        }
        let place = match parent {
            Some(p) => Some(self.place(p).ok_or("削除元が見つかりません。")?),
            None => None,
        };
        let s = &mut self.score;
        match (list, place) {
            (List::MasterBars, None) => take!(s.master_bars, Node::MasterBar),
            (List::Tracks, None) => take!(s.tracks, Node::Track),
            (List::Bars, Some(Place::Staff(t, st))) => take!(s.tracks[t].staves[st].bars, Node::Bar),
            (List::Voices, Some(Place::Bar(t, st, b))) => take!(s.tracks[t].staves[st].bars[b].voices, Node::Voice),
            (List::Beats, Some(Place::Voice(t, st, b, v))) => take!(s.tracks[t].staves[st].bars[b].voices[v].beats, Node::Beat),
            (List::Notes, Some(Place::Beat(t, st, b, v, be))) => take!(s.tracks[t].staves[st].bars[b].voices[v].beats[be].notes, Node::Note),
            _ => Err("この場所からは削除できません。".into()),
        }
    }
}
