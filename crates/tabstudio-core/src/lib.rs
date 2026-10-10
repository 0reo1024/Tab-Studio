//! tabstudio-core: Tab Studio's document model and edit operations (migration P3).
//! Built natively (save, recovery) and as WASM for the WebView, where edits run
//! synchronously with input.
pub mod model;
pub mod ops;
pub mod history;
pub mod api;
mod document;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use document::Document;
