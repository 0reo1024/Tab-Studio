//! Transactions and the undo/redo log: one user action = one transaction = one undo step.
//! The log keeps inverse ops only (O(change)), so it can be long.
use crate::ops::{ChangeSet, Op};
use crate::Document;

/// How many undo steps are kept (the snapshot history kept 60; ops are small).
pub const UNDO_LIMIT: usize = 500;

#[derive(Clone, Debug, PartialEq)]
pub struct Transaction {
    pub label: String,
    /// Ops that undo this transaction, in the order to apply them.
    pub undo: Vec<Op>,
}

impl Document {
    /// Applies `ops` as one undoable action. If one fails, the ones before it are rolled
    /// back and the document is unchanged.
    pub fn transact(&mut self, label: &str, ops: &[Op]) -> Result<ChangeSet, String> {
        let mut changes = ChangeSet::default();
        let inverses = self.apply_all(ops, &mut changes)?;
        self.undo_log.push(Transaction { label: label.to_string(), undo: inverses });
        if self.undo_log.len() > UNDO_LIMIT {
            self.undo_log.remove(0);
        }
        self.redo_log.clear();
        Ok(changes)
    }

    /// Like `transact`, but op `i` is made by `make(doc, i)` right before it is applied,
    /// so it can depend on the earlier ops (positions after an insert).
    pub fn transact_with(&mut self, label: &str, count: usize, mut make: impl FnMut(&mut Document, usize) -> Result<Op, String>) -> Result<ChangeSet, String> {
        let mut changes = ChangeSet::default();
        let mut inverses: Vec<Op> = Vec::with_capacity(count);
        for i in 0..count {
            let result = make(self, i).and_then(|op| self.apply(&op, &mut changes));
            match result {
                Ok(inverse) => inverses.push(inverse),
                Err(error) => {
                    let mut ignored = ChangeSet::default();
                    for inverse in inverses.iter().rev() {
                        self.apply(inverse, &mut ignored).expect("an inverse always applies");
                    }
                    return Err(error);
                }
            }
        }
        inverses.reverse();
        self.undo_log.push(Transaction { label: label.to_string(), undo: inverses });
        if self.undo_log.len() > UNDO_LIMIT {
            self.undo_log.remove(0);
        }
        self.redo_log.clear();
        Ok(changes)
    }

    /// Applies ops in order; returns their inverses in undo order, or rolls back.
    fn apply_all(&mut self, ops: &[Op], changes: &mut ChangeSet) -> Result<Vec<Op>, String> {
        let mut inverses = Vec::with_capacity(ops.len());
        for op in ops {
            match self.apply(op, changes) {
                Ok(inverse) => inverses.push(inverse),
                Err(error) => {
                    let mut ignored = ChangeSet::default();
                    for inverse in inverses.iter().rev() {
                        self.apply(inverse, &mut ignored).expect("an inverse always applies");
                    }
                    return Err(error);
                }
            }
        }
        inverses.reverse();
        Ok(inverses)
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_log.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_log.is_empty()
    }

    /// Undoes the last action; returns what changed (None: nothing to undo).
    pub fn undo(&mut self) -> Option<Result<ChangeSet, String>> {
        let t = self.undo_log.pop()?;
        let mut changes = ChangeSet::default();
        Some(match self.apply_all(&t.undo, &mut changes) {
            Ok(redo) => {
                self.redo_log.push(Transaction { label: t.label, undo: redo });
                Ok(changes)
            }
            Err(e) => {
                self.undo_log.push(t);
                Err(e)
            }
        })
    }

    /// Redoes the last undone action.
    pub fn redo(&mut self) -> Option<Result<ChangeSet, String>> {
        let t = self.redo_log.pop()?;
        let mut changes = ChangeSet::default();
        Some(match self.apply_all(&t.undo, &mut changes) {
            Ok(undo) => {
                self.undo_log.push(Transaction { label: t.label, undo });
                Ok(changes)
            }
            Err(e) => {
                self.redo_log.push(t);
                Err(e)
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::model::*;
    use crate::ops::{List, Node, Op};
    use crate::Document;
    use serde_json::{Value, json};

    fn demo() -> Document {
        let json = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/demo.json")).unwrap();
        let mut doc = Document::from_json(&json).unwrap();
        doc.parse_all().unwrap();
        doc
    }
    fn snapshot(doc: &Document) -> Value {
        serde_json::from_str(&doc.to_json()).unwrap()
    }

    #[test]
    fn a_fret_edit_is_one_undo_step_and_reports_its_bar() {
        let mut doc = demo();
        let before = snapshot(&doc);
        let note = doc.score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].uid;
        let changes = doc.transact("fret", &[Op::SetField { node: note, key: "fret".into(), value: Some(json!(12)) }]).unwrap();
        assert_eq!(doc.score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].fret, Some(12));
        assert_eq!(changes.bars, vec![(doc.score.tracks[0].uid, doc.score.tracks[0].staves[0].uid, 1)]);
        assert!(!changes.structure && !changes.song);
        doc.undo().unwrap().unwrap();
        assert_eq!(snapshot(&doc), before);
        assert!(doc.can_redo() && !doc.can_undo());
        doc.redo().unwrap().unwrap();
        assert_eq!(doc.score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].fret, Some(12));
    }

    #[test]
    fn a_failing_op_rolls_the_transaction_back() {
        let mut doc = demo();
        let before = snapshot(&doc);
        let note = doc.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].uid;
        let result = doc.transact("bad", &[Op::SetField { node: note, key: "fret".into(), value: Some(json!(3)) }, Op::SetField { node: Uid(999_999), key: "fret".into(), value: Some(json!(1)) }]);
        assert!(result.is_err());
        assert_eq!(snapshot(&doc), before);
        assert!(!doc.can_undo());
    }

    #[test]
    fn inserting_and_removing_bars_keeps_identities() {
        let mut doc = demo();
        let before = snapshot(&doc);
        let staff = doc.score.tracks[0].staves[0].uid;
        let bar = doc.score.tracks[0].staves[0].bars[0].clone();
        let master = doc.score.master_bars[0].clone();
        let changes = doc
            .transact("insert bar", &[Op::Insert { parent: None, list: List::MasterBars, index: 1, node: Box::new(Node::MasterBar(master)) }, Op::Insert { parent: Some(staff), list: List::Bars, index: 1, node: Box::new(Node::Bar(bar.clone())) }])
            .unwrap();
        assert!(changes.structure);
        assert_eq!(doc.score.tracks[0].staves[0].bars.len(), before["tracks"][0]["staves"][0]["bars"].as_array().unwrap().len() + 1);
        doc.undo().unwrap().unwrap();
        assert_eq!(snapshot(&doc), before);
        // The removed bar comes back with the same node ids.
        let removed_uid = doc.score.tracks[0].staves[0].bars[1].uid;
        doc.transact("delete", &[Op::Remove { parent: Some(staff), list: List::Bars, index: 1 }]).unwrap();
        doc.undo().unwrap().unwrap();
        assert_eq!(doc.score.tracks[0].staves[0].bars[1].uid, removed_uid);
    }

    /// Random edits (fields, notes in and out, beats in and out), then undo everything:
    /// the document is exactly the original; redo everything: exactly the edited one.
    #[test]
    fn random_edits_undo_and_redo_exactly() {
        let mut doc = demo();
        let original = snapshot(&doc);
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut rand = |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % n as u64) as usize
        };
        let mut steps = 0;
        for _ in 0..400 {
            let staff = &doc.score.tracks[0].staves[0];
            let b = rand(staff.bars.len());
            let voice = &staff.bars[b].voices[0];
            let voice_uid = voice.uid;
            if voice.beats.is_empty() {
                continue;
            }
            let be = rand(voice.beats.len());
            let beat = &voice.beats[be];
            let beat_uid = beat.uid;
            let op = match rand(6) {
                0 if !beat.notes.is_empty() => Op::SetField { node: beat.notes[rand(beat.notes.len())].uid, key: "fret".into(), value: Some(json!(rand(25))) },
                1 => Op::SetField { node: beat_uid, key: "duration".into(), value: Some(json!([1, 2, 4, 8, 16][rand(5)])) },
                2 => Op::SetField { node: beat_uid, key: "text".into(), value: if rand(2) == 0 { None } else { Some(json!("x")) } },
                3 if !beat.notes.is_empty() => Op::Remove { parent: Some(beat_uid), list: List::Notes, index: rand(beat.notes.len()) },
                4 => {
                    let mut note = Note::default();
                    note.fret = Some(rand(12) as i32);
                    note.string = Some(1 + rand(6) as i32);
                    note.uid = doc.fresh_uid();
                    Op::Insert { parent: Some(beat_uid), list: List::Notes, index: 0, node: Box::new(Node::Note(note)) }
                }
                5 if voice.beats.len() > 1 => Op::Remove { parent: Some(voice_uid), list: List::Beats, index: rand(voice.beats.len()) },
                _ => continue,
            };
            doc.transact("random", &[op]).unwrap();
            steps += 1;
        }
        assert!(steps > 200);
        let edited = snapshot(&doc);
        assert_ne!(edited, original);
        while let Some(r) = doc.undo() {
            r.unwrap();
        }
        assert_eq!(snapshot(&doc), original);
        while let Some(r) = doc.redo() {
            r.unwrap();
        }
        assert_eq!(snapshot(&doc), edited);
    }
}
