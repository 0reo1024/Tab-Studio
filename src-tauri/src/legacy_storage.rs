//! One-time import of the Electron build's settings. Electron keeps them in Chromium's
//! localStorage (LevelDB under %APPDATA%/tab-studio/Local Storage/leveldb); the Tauri
//! WebView has its own storage, so without this a user switching builds would lose
//! shortcuts, view and click settings. Keys follow Chromium's format:
//! `_` + origin + `\0` + encoded key; encoded strings start with 1 (Latin-1) or 0 (UTF-16LE).
use std::path::Path;

/// Small preference keys only; documents and recovery data are not copied.
pub const KEYS: &[&str] = &["tabstudio-settings", "tabstudio-view", "tabstudio-click", "tabstudio-practice", "tabstudio-track-views", "tabstudio-helper"];
const ORIGIN: &str = "tabstudio://app";

fn encode_key(name: &str) -> Vec<u8> {
    let mut key = format!("_{ORIGIN}\0").into_bytes();
    key.push(1);
    key.extend_from_slice(name.as_bytes());
    key
}

fn decode(value: &[u8]) -> Option<String> {
    match value.split_first()? {
        (1, rest) => Some(rest.iter().map(|&b| b as char).collect()),
        (0, rest) if rest.len() % 2 == 0 => String::from_utf16(&rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()).ok(),
        _ => None,
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.file_name() != "LOCK" {
            std::fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// Reads the preference keys from a copy of the LevelDB folder (Electron may be running).
pub fn read(leveldb: &Path, scratch: &Path) -> Vec<(String, String)> {
    if !leveldb.is_dir() {
        return Vec::new();
    }
    let _ = std::fs::remove_dir_all(scratch);
    let result = (|| {
        copy_dir(leveldb, scratch).ok()?;
        let options = rusty_leveldb::Options { create_if_missing: false, ..Default::default() };
        let mut db = rusty_leveldb::DB::open(scratch, options).ok()?;
        Some(KEYS.iter().filter_map(|name| Some((name.to_string(), decode(&db.get(&encode_key(name))?)?))).collect::<Vec<_>>())
    })();
    let _ = std::fs::remove_dir_all(scratch);
    result.unwrap_or_default()
}

/// Page script that fills in imported keys the Tauri storage does not have yet, once.
pub fn init_script(entries: &[(String, String)]) -> String {
    let entries = serde_json::to_string(entries).expect("entries serialize");
    format!("(()=>{{try{{if(localStorage.getItem('tabstudio-imported'))return;for(const [k,v] of {entries})if(localStorage.getItem(k)===null)localStorage.setItem(k,v);localStorage.setItem('tabstudio-imported','electron');}}catch(e){{}}}})();")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str) -> Vec<u8> {
        let mut out = vec![0];
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    #[test]
    fn reads_chromium_local_storage_keys_for_the_app_origin_only() {
        let dir = tempfile::tempdir().unwrap();
        let leveldb = dir.path().join("leveldb");
        {
            let mut db = rusty_leveldb::DB::open(&leveldb, rusty_leveldb::Options::default()).unwrap();
            db.put(&encode_key("tabstudio-settings"), &utf16("{\"zoom\":1.2,\"name\":\"ギター\"}")).unwrap();
            let mut latin = vec![1];
            latin.extend_from_slice(b"{\"on\":true}");
            db.put(&encode_key("tabstudio-click"), &latin).unwrap();
            db.put(&encode_key("tabstudio-recovery"), &latin).unwrap();
            db.put(b"_https://example.com\0\x01tabstudio-view", &latin).unwrap();
            db.flush().unwrap();
        }
        let found = read(&leveldb, &dir.path().join("scratch"));
        assert_eq!(found, vec![("tabstudio-settings".to_string(), "{\"zoom\":1.2,\"name\":\"ギター\"}".to_string()), ("tabstudio-click".to_string(), "{\"on\":true}".to_string())]);
        assert!(!dir.path().join("scratch").exists());
        assert!(read(&dir.path().join("missing"), &dir.path().join("scratch")).is_empty());
    }

    #[test]
    fn script_only_fills_missing_keys_once() {
        let script = init_script(&[("tabstudio-view".into(), "{\"a\":\"'\"}".into())]);
        assert!(script.contains("[[\"tabstudio-view\",\"{\\\"a\\\":\\\"'\\\"}\"]]"));
        assert!(script.contains("localStorage.getItem('tabstudio-imported')"));
        assert!(script.contains("localStorage.getItem(k)===null"));
    }
}
