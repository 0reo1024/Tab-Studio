//! A loaded document: the score plus session state (node ids, undo/redo log).
use crate::history::Transaction;
use crate::model::*;

#[derive(Clone, Debug, Default)]
pub struct Document {
    pub score: Score,
    next_uid: u32,
    pub(crate) undo_log: Vec<Transaction>,
    pub(crate) redo_log: Vec<Transaction>,
}

impl Document {
    /// Reads the app's alphaTab JSON (scoreToJsObject + studio data) and numbers the nodes.
    pub fn from_json(json: &str) -> Result<Document, String> {
        let score = crate::model::score_from_json(json)?;
        let mut doc = Document { score, ..Default::default() };
        doc.assign_uids();
        Ok(doc)
    }

    /// Writes the alphaTab JSON back (fields in their original order).
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.score).expect("a score always serializes")
    }

    pub fn fresh_uid(&mut self) -> Uid {
        self.next_uid += 1;
        Uid(self.next_uid)
    }

    /// Parses measure b of a staff if it is still raw (giving its contents uids).
    pub fn ensure_bar(&mut self, t: usize, st: usize, b: usize) -> Result<(), String> {
        let mut next = self.next_uid;
        let result = match self.score.tracks.get_mut(t).and_then(|x| x.staves.get_mut(st)).and_then(|x| x.bars.get_mut(b)) {
            Some(bar) if !bar.is_parsed() => bar.parse(&mut || {
                next += 1;
                Uid(next)
            }),
            _ => Ok(()),
        };
        self.next_uid = next;
        result
    }

    /// Parses every measure (tests and tools that look inside all of them).
    pub fn parse_all(&mut self) -> Result<(), String> {
        for t in 0..self.score.tracks.len() {
            for st in 0..self.score.tracks[t].staves.len() {
                for b in 0..self.score.tracks[t].staves[st].bars.len() {
                    self.ensure_bar(t, st, b)?;
                }
            }
        }
        Ok(())
    }

    pub(crate) fn with_score(score: Score) -> Document {
        Document { score, ..Default::default() }
    }
    pub(crate) fn next_uid(&self) -> u32 {
        self.next_uid
    }
    pub(crate) fn set_next_uid(&mut self, next: u32) {
        self.next_uid = next;
    }
    /// Numbers every node, continuing after `start`.
    pub(crate) fn renumber_from(&mut self, start: u32) {
        self.next_uid = start;
        self.assign_uids();
    }

    fn assign_uids(&mut self) {
        let mut next = self.next_uid;
        let mut id = || {
            next += 1;
            Uid(next)
        };
        for m in &mut self.score.master_bars {
            m.uid = id();
        }
        for t in &mut self.score.tracks {
            t.uid = id();
            for s in &mut t.staves {
                s.uid = id();
                for b in &mut s.bars {
                    b.uid = id();
                    for v in &mut b.voices {
                        v.uid = id();
                        for beat in &mut v.beats {
                            beat.uid = id();
                            for n in &mut beat.notes {
                                n.uid = id();
                            }
                        }
                    }
                }
            }
        }
        self.next_uid = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    pub(crate) fn fixture(name: &str) -> Option<String> {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).ok()
    }

    #[test]
    fn round_trips_the_demo_exactly_and_numbers_every_node() {
        let json = fixture("demo.json").expect("tests/fixtures/demo.json");
        let mut doc = Document::from_json(&json).unwrap();
        doc.parse_all().unwrap();
        let back: Value = serde_json::from_str(&doc.to_json()).unwrap();
        let original: Value = serde_json::from_str(&json).unwrap();
        // Same content (typed fields are written first, so key order may differ; alphaTab
        // reads objects by key).
        assert_eq!(back, original);
        let beat = &doc.score.tracks[0].staves[0].bars[0].voices[0].beats[0];
        assert!(beat.uid.0 > 0 && beat.duration.is_some());
        let mut ids = std::collections::BTreeSet::new();
        for t in &doc.score.tracks {
            for s in &t.staves {
                for b in &s.bars {
                    assert!(ids.insert(b.uid));
                    for v in &b.voices {
                        for beat in &v.beats {
                            assert!(ids.insert(beat.uid));
                            for n in &beat.notes {
                                assert!(ids.insert(n.uid));
                            }
                        }
                    }
                }
            }
        }
    }

    /// Every exported fixture (tests/fixtures, plus TABSTUDIO_CORE_FIXTURES for local songs
    /// that cannot be committed) survives the round trip unchanged.
    #[test]
    fn every_fixture_round_trips() {
        let mut dirs = vec![std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")];
        if let Some(extra) = std::env::var_os("TABSTUDIO_CORE_FIXTURES") {
            dirs.push(extra.into());
        }
        let mut count = 0;
        for dir in dirs {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                if entry.path().extension().is_some_and(|e| e == "json") {
                    let json = std::fs::read_to_string(entry.path()).unwrap();
                    let doc = Document::from_json(&json).unwrap();
                    let back: Value = serde_json::from_str(&doc.to_json()).unwrap();
                    assert_eq!(back, serde_json::from_str::<Value>(&json).unwrap(), "{}", entry.path().display());
                    count += 1;
                }
            }
        }
        assert!(count >= 8);
    }

    #[test]
    fn bad_json_is_an_error() {
        assert!(Document::from_json("{\"tracks\": 3}").is_err());
        assert!(Document::from_json("not json").is_err());
    }
}
