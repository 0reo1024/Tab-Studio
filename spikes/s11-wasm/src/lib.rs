//! Spike S11: a stateful document object in WASM called synchronously from the WebView.
//! `Doc` holds beats; edits return a small change-set; `to_json` serializes everything.
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize, Clone)]
struct Beat {
    id: u32,
    fret: i8,
    duration: u8,
}

#[wasm_bindgen]
pub struct Doc {
    beats: Vec<Beat>,
    undo: Vec<(usize, i8)>,
}

#[wasm_bindgen]
impl Doc {
    #[wasm_bindgen(constructor)]
    pub fn new(count: usize) -> Doc {
        Doc { beats: (0..count).map(|i| Beat { id: i as u32, fret: 0, duration: 4 }).collect(), undo: Vec::new() }
    }
    /// One edit: returns the touched beat index (the change-set of this spike).
    pub fn set_fret(&mut self, index: usize, fret: i8) -> usize {
        let old = std::mem::replace(&mut self.beats[index].fret, fret);
        self.undo.push((index, old));
        index
    }
    pub fn undo(&mut self) -> Option<usize> {
        let (index, fret) = self.undo.pop()?;
        self.beats[index].fret = fret;
        Some(index)
    }
    pub fn fret(&self, index: usize) -> i8 {
        self.beats[index].fret
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.beats).unwrap()
    }
    pub fn load_json(json: &str) -> Result<Doc, JsError> {
        Ok(Doc { beats: serde_json::from_str(json)?, undo: Vec::new() })
    }
}
