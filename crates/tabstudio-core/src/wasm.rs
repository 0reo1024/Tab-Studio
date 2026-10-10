//! WASM bindings (wasm-bindgen) for the WebView: a document object edited synchronously.
use wasm_bindgen::prelude::*;

use crate::api::At;

#[wasm_bindgen]
pub struct CoreDocument(crate::Document);

fn js(e: String) -> JsError {
    JsError::new(&e)
}

#[wasm_bindgen]
impl CoreDocument {
    /// Loads the app's alphaTab JSON (a string).
    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(json: &str) -> Result<CoreDocument, JsError> {
        crate::Document::from_json(json).map(CoreDocument).map_err(js)
    }
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> String {
        self.0.to_json()
    }
    /// One user action: `ops` is a JSON array of edit ops; returns the change-set JSON.
    pub fn edit(&mut self, label: &str, ops: &str) -> Result<String, JsError> {
        self.0.edit_json(label, ops).map_err(js)
    }
    /// Undo; returns the change-set JSON, or undefined when there is nothing to undo.
    pub fn undo(&mut self) -> Result<Option<String>, JsError> {
        self.history(true)
    }
    pub fn redo(&mut self) -> Result<Option<String>, JsError> {
        self.history(false)
    }
    fn history(&mut self, back: bool) -> Result<Option<String>, JsError> {
        let result = if back { self.0.undo() } else { self.0.redo() };
        match result {
            None => Ok(None),
            Some(Ok(changes)) => Ok(Some(serde_json::to_string(&self.0.positions(&changes)).unwrap())),
            Some(Err(e)) => Err(js(e)),
        }
    }
    #[wasm_bindgen(js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.0.can_undo()
    }
    #[wasm_bindgen(js_name = canRedo)]
    pub fn can_redo(&self) -> bool {
        self.0.can_redo()
    }
    /// JSON of the node at a position (JSON {track, staff, bar} ...; {} = the whole score).
    #[wasm_bindgen(js_name = nodeJson)]
    pub fn node_json(&self, at: &str) -> Result<String, JsError> {
        let at: At = serde_json::from_str(at).map_err(|e| JsError::new(&e.to_string()))?;
        self.0.node_json(&at).map_err(js)
    }
}
