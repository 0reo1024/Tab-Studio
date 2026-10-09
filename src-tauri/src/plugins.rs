//! The external effect list, as electron/fx-host.cjs scan(): VST3 plugins in the system
//! folder plus folders the user added (fx-folders.json, at most 32), walked up to five
//! levels deep and 2000 plugins. Only listed plugins can be loaded.
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const MAX_FOLDERS: usize = 32;
const MAX_PLUGINS: usize = 2000;

/// The system VST3 folder (%CommonProgramFiles%\VST3).
pub fn system_folders() -> Vec<PathBuf> {
    let common = std::env::var_os("CommonProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files\Common Files"));
    vec![common.join("VST3")]
}

/// Folders saved in `file` (absolute paths only).
pub fn saved_folders(file: &Path) -> Vec<PathBuf> {
    let Ok(bytes) = std::fs::read(file) else { return Vec::new() };
    let Ok(Value::Array(list)) = serde_json::from_slice::<Value>(&bytes) else { return Vec::new() };
    list.iter().filter_map(Value::as_str).map(PathBuf::from).filter(|p| p.is_absolute()).take(MAX_FOLDERS).collect()
}

/// Finds .vst3 plugins (bundle folders or single files) under `roots`.
pub fn scan(roots: &[PathBuf]) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    let mut visited = HashSet::new();
    fn walk(dir: &Path, depth: usize, found: &mut Vec<(PathBuf, String)>, visited: &mut HashSet<PathBuf>) {
        if depth > 5 || found.len() >= MAX_PLUGINS {
            return;
        }
        let Ok(real) = std::fs::canonicalize(dir) else { return };
        if !visited.insert(real.clone()) {
            return;
        }
        let Ok(entries) = std::fs::read_dir(&real) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if name.to_lowercase().ends_with(".vst3") {
                found.push((path, name[..name.len() - 5].to_string()));
                if found.len() >= MAX_PLUGINS {
                    return;
                }
            } else if kind.is_dir() && !kind.is_symlink() {
                walk(&path, depth + 1, found, visited);
            }
        }
    }
    for root in roots {
        walk(root, 0, &mut found, &mut visited);
    }
    found.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    found
}

pub fn listing(found: &[(PathBuf, String)]) -> Value {
    json!(found.iter().map(|(path, name)| json!({"path": path.to_string_lossy(), "name": name, "format": "VST3"})).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_bundles_and_files_without_entering_bundles() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Vendor").join("Amp.vst3").join("Contents").join("x86_64-win")).unwrap();
        std::fs::write(root.join("Vendor").join("Amp.vst3").join("Contents").join("x86_64-win").join("Amp.vst3"), b"").unwrap();
        std::fs::write(root.join("Comp.vst3"), b"").unwrap();
        std::fs::write(root.join("readme.txt"), b"").unwrap();
        let found = scan(&[root.to_path_buf(), root.to_path_buf()]);
        let names: Vec<&str> = found.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(names, ["Amp", "Comp"]);
        assert_eq!(listing(&found)[0]["format"], "VST3");
    }

    #[test]
    fn saved_folders_keep_absolute_paths_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("fx-folders.json");
        let absolute = dir.path().join("plugins");
        std::fs::write(&file, json!(["relative", absolute.to_string_lossy(), 3]).to_string()).unwrap();
        assert_eq!(saved_folders(&file), vec![absolute]);
        assert!(saved_folders(&dir.path().join("missing.json")).is_empty());
    }
}
