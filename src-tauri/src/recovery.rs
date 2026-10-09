//! Unsaved-work recovery, one gzip file per document plus a small manifest.
//! Same folder layout and read format as electron/recovery-store.cjs: only changed
//! documents are rewritten and the manifest is written last, so a crash mid-write
//! leaves the previous consistent set readable.
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::fsutil::atomic_write;

pub struct RecoveryDocument {
    pub id: i64,
    pub bytes: Vec<u8>,
}

pub struct RecoveryWrite {
    pub manifest: String,
    pub files: Vec<RecoveryDocument>,
    pub remove: Vec<i64>,
}

pub struct RecoveryStore {
    folder: PathBuf,
    legacy_file: PathBuf,
    /// Serializes writes, reads and clears like the JS promise queue.
    queue: Mutex<()>,
}

const INVALID: &str = "復旧データが不正です。";

impl RecoveryStore {
    pub fn new(folder: PathBuf, legacy_file: PathBuf) -> Self {
        Self { folder, legacy_file, queue: Mutex::new(()) }
    }

    fn file(&self, id: i64) -> PathBuf {
        self.folder.join(format!("document-{id}.json.gz"))
    }

    pub fn write(&self, payload: RecoveryWrite) -> Result<(), String> {
        if payload.manifest.len() > 16 * 1024 * 1024 || payload.files.iter().any(|f| f.bytes.len() > 512 * 1024 * 1024) {
            return Err(INVALID.into());
        }
        let _guard = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let run = || -> std::io::Result<()> {
            std::fs::create_dir_all(&self.folder)?;
            for doc in &payload.files {
                atomic_write(&self.file(doc.id), &doc.bytes)?;
            }
            atomic_write(&self.folder.join("manifest.json"), payload.manifest.as_bytes())?;
            for id in &payload.remove {
                remove_file(&self.file(*id))?;
            }
            remove_file(&self.legacy_file)
        };
        run().map_err(|e| e.to_string())
    }

    /// Returns the same JSON text the single-file format used, so restore code is shared.
    pub fn read(&self) -> Option<String> {
        let _guard = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let manifest = match std::fs::read_to_string(self.folder.join("manifest.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            Some(Value::Object(map)) => map,
            Some(_) => return None,
            None => return std::fs::read_to_string(&self.legacy_file).ok(),
        };
        let mut documents = Vec::new();
        for meta in manifest.get("documents").and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = meta.get("id").and_then(Value::as_i64) else { continue };
            let Some(score) = std::fs::read(self.file(id)).ok().and_then(|raw| gunzip(&raw)) else { continue };
            let head = serde_json::to_string(meta).unwrap_or_default();
            let Some(open) = head.strip_suffix('}') else { continue };
            documents.push(format!("{open},\"score\":{score}}}"));
        }
        if documents.is_empty() {
            return None;
        }
        let active = manifest.get("activeDocument").cloned().unwrap_or(Value::Null);
        let mut rest = manifest;
        rest.shift_remove("documents");
        rest.shift_remove("activeDocument");
        let head = serde_json::to_string(&rest).unwrap_or_else(|_| "{}".into());
        let prefix = if head == "{}" { "{".to_string() } else { format!("{},", &head[..head.len() - 1]) };
        Some(format!("{prefix}\"workspace\":{{\"activeDocument\":{active},\"documents\":[{}]}}}}", documents.join(",")))
    }

    pub fn clear(&self) -> Result<(), String> {
        let _guard = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let run = || -> std::io::Result<()> {
            if self.folder.exists() {
                std::fs::remove_dir_all(&self.folder)?;
            }
            remove_file(&self.legacy_file)
        };
        run().map_err(|e| e.to_string())
    }
}

fn remove_file(file: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn gunzip(raw: &[u8]) -> Option<String> {
    let mut text = String::new();
    flate2::read::GzDecoder::new(raw).read_to_string(&mut text).ok()?;
    Some(text)
}

/// Body layout sent by src/platform/tauri.ts: u32 LE header length, JSON header
/// `{manifest, files:[{id,length}], remove}`, then the document bytes back to back.
pub fn parse_write(body: &[u8]) -> Result<RecoveryWrite, String> {
    let (header, mut rest) = crate::frame::split(body).ok_or(INVALID)?;
    let manifest = header["manifest"].as_str().ok_or(INVALID)?.to_string();
    let mut files = Vec::new();
    for entry in header["files"].as_array().ok_or(INVALID)? {
        let id = entry["id"].as_i64().ok_or(INVALID)?;
        let length = entry["length"].as_u64().ok_or(INVALID)? as usize;
        if length > rest.len() {
            return Err(INVALID.into());
        }
        files.push(RecoveryDocument { id, bytes: rest[..length].to_vec() });
        rest = &rest[length..];
    }
    let remove = header["remove"].as_array().ok_or(INVALID)?.iter().map(|v| v.as_i64().ok_or(INVALID)).collect::<Result<Vec<_>, _>>()?;
    Ok(RecoveryWrite { manifest, files, remove })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gzip(text: &str) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(text.as_bytes()).unwrap();
        encoder.finish().unwrap()
    }

    fn store(dir: &Path) -> RecoveryStore {
        RecoveryStore::new(dir.join("recovery"), dir.join("recovery.json"))
    }

    #[test]
    fn reads_back_the_single_file_json_shape() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        assert_eq!(store.read(), None);
        let manifest = r#"{"version":2,"activeDocument":2,"documents":[{"id":1,"sourceName":"a.tg"},{"id":2,"sourceName":"b.tg","dirty":true}]}"#;
        store.write(RecoveryWrite { manifest: manifest.into(), files: vec![RecoveryDocument { id: 1, bytes: gzip(r#"{"x":1}"#) }, RecoveryDocument { id: 2, bytes: gzip(r#"{"y":[2]}"#) }], remove: vec![] }).unwrap();
        let text = store.read().unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value, serde_json::json!({"version":2,"workspace":{"activeDocument":2,"documents":[{"id":1,"sourceName":"a.tg","score":{"x":1}},{"id":2,"sourceName":"b.tg","dirty":true,"score":{"y":[2]}}]}}));
        // Only changed documents are rewritten; removed ones disappear.
        store.write(RecoveryWrite { manifest: r#"{"activeDocument":1,"documents":[{"id":1}]}"#.into(), files: vec![], remove: vec![2] }).unwrap();
        assert!(!dir.path().join("recovery/document-2.json.gz").exists());
        let value: Value = serde_json::from_str(&store.read().unwrap()).unwrap();
        assert_eq!(value, serde_json::json!({"workspace":{"activeDocument":1,"documents":[{"id":1,"score":{"x":1}}]}}));
        store.clear().unwrap();
        assert_eq!(store.read(), None);
    }

    #[test]
    fn falls_back_to_the_legacy_file_and_removes_it_after_a_write() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        std::fs::write(dir.path().join("recovery.json"), "{\"legacy\":true}").unwrap();
        assert_eq!(store.read().as_deref(), Some("{\"legacy\":true}"));
        store.write(RecoveryWrite { manifest: r#"{"documents":[]}"#.into(), files: vec![], remove: vec![] }).unwrap();
        assert!(!dir.path().join("recovery.json").exists());
        assert_eq!(store.read(), None);
    }

    #[test]
    fn parses_the_framed_body_and_rejects_bad_lengths() {
        let body = crate::frame::join(&serde_json::json!({"manifest":"{}","files":[{"id":3,"length":2},{"id":4,"length":1}],"remove":[7]}), &[1, 2, 3]);
        let parsed = parse_write(&body).unwrap();
        assert_eq!(parsed.files[0].bytes, vec![1, 2]);
        assert_eq!(parsed.files[1].id, 4);
        assert_eq!(parsed.remove, vec![7]);
        let short = crate::frame::join(&serde_json::json!({"manifest":"{}","files":[{"id":3,"length":9}],"remove":[]}), &[1]);
        assert!(parse_write(&short).is_err());
        assert!(parse_write(&[1, 0]).is_err());
    }
}
