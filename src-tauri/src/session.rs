//! Recent files, last file, window size and the open-tab workspace.
//! Same JSON file and rules as electron/session-store.cjs.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::fsutil::{absolute, atomic_write, file_name, same_path};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Workspace {
    pub files: Vec<String>,
    pub active: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub last_file: Option<String>,
    pub recent_files: Vec<String>,
    pub window_state: Option<WindowState>,
    pub workspace: Option<Workspace>,
}

#[derive(Serialize)]
pub struct RecentFile {
    pub path: String,
    pub name: String,
}

pub struct SessionStore {
    file: PathBuf,
    pub state: SessionState,
}

fn is_absolute(value: &str) -> bool {
    Path::new(value).is_absolute()
}

impl SessionStore {
    pub fn new(file: PathBuf) -> Self {
        Self { file, state: SessionState::default() }
    }

    pub fn initialize(&mut self) {
        let Ok(text) = std::fs::read_to_string(&self.file) else { return };
        let Ok(data) = serde_json::from_str::<Value>(&text) else { return };
        self.state.recent_files = data["recentFiles"]
            .as_array()
            .map(|files| files.iter().filter_map(Value::as_str).filter(|f| is_absolute(f)).take(8).map(String::from).collect())
            .unwrap_or_default();
        self.state.last_file = data["lastFile"].as_str().filter(|f| is_absolute(f)).map(String::from);
        self.state.workspace = if data["workspace"].is_object() { Some(normalize_workspace(&data["workspace"])) } else { None };
        let size = &data["windowState"];
        if let (Some(width), Some(height)) = (size["width"].as_u64(), size["height"].as_u64()) {
            if (320..=32000).contains(&width) && (240..=32000).contains(&height) {
                self.state.window_state = Some(WindowState { width: width as u32, height: height as u32, maximized: size["maximized"] == Value::Bool(true) });
            }
        }
    }

    pub fn recent(&self) -> Vec<RecentFile> {
        self.state.recent_files.iter().map(|path| RecentFile { path: path.clone(), name: file_name(path) }).collect()
    }

    pub fn workspace(&self) -> Workspace {
        self.state.workspace.clone().unwrap_or_else(|| {
            let last = self.state.last_file.clone();
            normalize_workspace(&serde_json::json!({"files": last.iter().collect::<Vec<_>>(), "active": last}))
        })
    }

    pub fn remember_workspace(&mut self, value: &Value) -> std::io::Result<()> {
        let next = normalize_workspace(value);
        if self.state.workspace.as_ref() == Some(&next) {
            return Ok(());
        }
        self.state.workspace = Some(next);
        self.persist()
    }

    pub fn remember(&mut self, file: &str) -> std::io::Result<()> {
        let resolved = absolute(file);
        let mut recent = vec![resolved.clone()];
        recent.extend(self.state.recent_files.iter().filter(|f| f.to_lowercase() != resolved.to_lowercase()).cloned());
        recent.truncate(8);
        self.state.last_file = Some(resolved);
        self.state.recent_files = recent;
        self.persist()
    }

    pub fn clear_last(&mut self) -> std::io::Result<()> {
        self.state.last_file = None;
        self.persist()
    }

    pub fn remember_window(&mut self, size: WindowState) -> std::io::Result<()> {
        self.state.window_state = Some(size);
        self.persist()
    }

    fn persist(&self) -> std::io::Result<()> {
        let content = serde_json::to_vec(&self.state).expect("session state serializes");
        atomic_write(&self.file, &content)
    }
}

/// Absolute paths only, resolved, de-duplicated (case-insensitively on Windows);
/// `active` must be one of the files, else the first file.
pub fn normalize_workspace(value: &Value) -> Workspace {
    let mut files: Vec<String> = Vec::new();
    for file in value["files"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if !is_absolute(file) || file.len() > 32768 {
            continue;
        }
        let resolved = absolute(file);
        if !files.iter().any(|f| same_path(f, &resolved)) {
            files.push(resolved);
        }
    }
    let active = value["active"].as_str().and_then(|a| files.iter().find(|f| same_path(f, a)).cloned());
    let active = active.or_else(|| files.first().cloned());
    Workspace { files, active }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs(name: &str) -> String {
        std::env::temp_dir().join(name).to_string_lossy().into_owned()
    }

    #[test]
    fn workspace_is_deduplicated_and_active_is_kept() {
        let a = abs("A.tg");
        let value = serde_json::json!({"files": [a, "relative.tg", a.to_uppercase(), abs("B.tg")], "active": abs("b.TG")});
        let ws = normalize_workspace(&value);
        assert_eq!(ws.files.len(), if cfg!(windows) { 2 } else { 3 });
        assert!(same_path(ws.active.as_deref().unwrap(), &abs("B.tg")));
        let other = normalize_workspace(&serde_json::json!({"files": [abs("C.tg")], "active": "elsewhere"}));
        assert_eq!(other.active, Some(abs("C.tg")));
    }

    #[test]
    fn persists_in_the_electron_shape_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("workspace-session.json");
        let mut store = SessionStore::new(file.clone());
        store.initialize();
        assert_eq!(store.workspace(), Workspace { files: vec![], active: None });
        for i in 0..10 {
            store.remember(&abs(&format!("{i}.tg"))).unwrap();
        }
        store.remember_window(WindowState { width: 1200, height: 800, maximized: true }).unwrap();
        store.remember_workspace(&serde_json::json!({"files": [abs("9.tg")], "active": abs("9.tg")})).unwrap();
        let raw: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(raw["recentFiles"].as_array().unwrap().len(), 8);
        assert_eq!(raw["lastFile"], Value::String(abs("9.tg")));
        assert_eq!(raw["windowState"]["maximized"], Value::Bool(true));
        let mut again = SessionStore::new(file);
        again.initialize();
        assert_eq!(again.state.recent_files[0], abs("9.tg"));
        assert_eq!(again.recent()[0].name, "9.tg");
        assert_eq!(again.workspace().files, vec![abs("9.tg")]);
        assert_eq!(again.state.window_state, Some(WindowState { width: 1200, height: 800, maximized: true }));
        again.clear_last().unwrap();
        assert_eq!(again.state.last_file, None);
    }

    #[test]
    fn workspace_falls_back_to_last_file() {
        let mut store = SessionStore::new(std::env::temp_dir().join("unused-session.json"));
        store.state.last_file = Some(abs("last.tg"));
        assert_eq!(store.workspace(), Workspace { files: vec![abs("last.tg")], active: Some(abs("last.tg")) });
    }
}
