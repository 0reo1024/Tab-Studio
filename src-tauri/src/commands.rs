//! Commands behind window.desktop / window.nativeFx in the Tauri build
//! (src/platform/tauri.ts). Mirrors electron/main.cjs, including the rule that
//! files are only read or overwritten when the user chose them in this session.
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::frame;
use crate::fsutil::{atomic_write, extension_is, file_name, safe_name};
use crate::recovery::{RecoveryStore, parse_write};
use crate::session::{SessionStore, WindowState};

const MAX_SCORE: u64 = 40 * 1024 * 1024;
const MAX_EXPORT: usize = 80 * 1024 * 1024;

pub struct AppState {
    pub session: Mutex<SessionStore>,
    pub recovery: RecoveryStore,
    pub files: Mutex<FileState>,
    pub native_dir: PathBuf,
    pub uploads: Mutex<Uploads>,
    pub sampler: crate::sampler::SamplerHost,
    /// Plugins found by the last scan (only these can be loaded).
    pub plugins: Mutex<std::collections::HashSet<String>>,
    pub audio: std::sync::Arc<crate::audio::AudioService>,
    pub data_dir: PathBuf,
}

/// Large request bodies arrive in pieces (WebView2 drops a single IPC body of ~38MB).
#[derive(Default)]
pub struct Uploads {
    next: u64,
    pending: HashMap<u64, Vec<u8>>,
}

const MAX_UPLOAD: usize = 600 * 1024 * 1024;

#[derive(Default)]
pub struct FileState {
    saved_project_path: Option<String>,
    document_paths: HashSet<String>,
    pending_open: Option<(String, String)>,
    open_counter: u64,
    exporting: bool,
    pub allow_close: bool,
}

fn path_key(file: &str) -> String {
    if cfg!(windows) { file.to_lowercase() } else { file.to_string() }
}

impl FileState {
    fn allow(&mut self, file: &str) {
        self.document_paths.insert(path_key(file));
    }
    fn allowed(&self, file: &str) -> bool {
        self.document_paths.contains(&path_key(file))
    }
}

type CommandResult<T> = Result<T, String>;

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn raw_body<'a>(request: &'a Request<'_>) -> CommandResult<&'a [u8]> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("データ形式が不正です。".into()),
    }
}

/// The command's body: either sent directly, or `{"upload":id}` naming pieces sent with upload_chunk.
fn take_body(state: &State<'_, AppState>, request: &Request<'_>) -> CommandResult<Vec<u8>> {
    let raw = raw_body(request)?;
    if let Some((header, rest)) = frame::split(raw) {
        if let (Some(id), true, 1) = (header.get("upload").and_then(Value::as_u64), rest.is_empty(), header.as_object().map_or(0, |o| o.len())) {
            return state.uploads.lock().unwrap_or_else(|e| e.into_inner()).pending.remove(&id).ok_or_else(|| "送信データが見つかりません。".to_string());
        }
    }
    Ok(raw.to_vec())
}

/// Appends one piece of a large body; `{"id":null}` starts a new upload. Returns the upload id.
#[tauri::command]
pub async fn upload_chunk(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<u64> {
    let (header, bytes) = frame::split(raw_body(&request)?).ok_or("送信データが不正です。")?;
    let mut uploads = state.uploads.lock().unwrap_or_else(|e| e.into_inner());
    let id = match header["id"].as_u64() {
        Some(id) => id,
        None => {
            uploads.next += 1;
            let id = uploads.next;
            // An upload abandoned by a failed send is dropped once a few newer ones exist.
            uploads.pending.retain(|old, _| id - old < 8);
            uploads.pending.insert(id, Vec::new());
            id
        }
    };
    let buffer = uploads.pending.get_mut(&id).ok_or("送信データが見つかりません。")?;
    if buffer.len() + bytes.len() > MAX_UPLOAD {
        uploads.pending.remove(&id);
        return Err("送信データが大きすぎます。".into());
    }
    buffer.extend_from_slice(bytes);
    Ok(id)
}

fn session_mut<'a>(state: &'a State<'_, AppState>) -> std::sync::MutexGuard<'a, SessionStore> {
    state.session.lock().unwrap_or_else(|e| e.into_inner())
}

fn files_mut<'a>(state: &'a State<'_, AppState>) -> std::sync::MutexGuard<'a, FileState> {
    state.files.lock().unwrap_or_else(|e| e.into_inner())
}

/// Reads a score the user picked and remembers it until the page accepts it (accept_open).
fn prepare_open(state: &State<'_, AppState>, file: &str) -> CommandResult<Response> {
    if !Path::new(file).is_absolute() {
        return Err("ファイルの場所が不正です。".into());
    }
    if std::fs::metadata(file).map_err(text)?.len() > MAX_SCORE {
        return Err("40MBを超えるファイルは初期版では読み込めません。".into());
    }
    let bytes = std::fs::read(file).map_err(text)?;
    let mut files = files_mut(state);
    files.open_counter += 1;
    let token = files.open_counter.to_string();
    files.pending_open = Some((token.clone(), file.to_string()));
    Ok(Response::new(frame::join(&json!({"name": file_name(file), "path": file, "openToken": token}), &bytes)))
}

fn none() -> Response {
    Response::new(frame::join(&Value::Null, &[]))
}

#[tauri::command]
pub async fn workspace_session(state: State<'_, AppState>) -> CommandResult<Value> {
    Ok(serde_json::to_value(session_mut(&state).workspace()).map_err(text)?)
}

#[tauri::command]
pub async fn remember_workspace(state: State<'_, AppState>, value: Value) -> CommandResult<()> {
    session_mut(&state).remember_workspace(&value).map_err(text)
}

#[tauri::command]
pub async fn read_workspace_file(state: State<'_, AppState>, path: String) -> CommandResult<Response> {
    if !session_mut(&state).workspace().files.iter().any(|f| f == &path) {
        return Err("前回のタブにないファイルです。".into());
    }
    let meta = std::fs::metadata(&path).map_err(text)?;
    if !meta.is_file() || meta.len() > MAX_SCORE {
        return Err("譜面ファイルを読み込めません（上限40MB）。".into());
    }
    let bytes = std::fs::read(&path).map_err(text)?;
    files_mut(&state).allow(&path);
    Ok(Response::new(frame::join(&json!({"name": file_name(&path), "path": path}), &bytes)))
}

#[tauri::command]
pub async fn recent_files(state: State<'_, AppState>) -> CommandResult<Value> {
    serde_json::to_value(session_mut(&state).recent()).map_err(text)
}

#[tauri::command]
pub async fn last_score(state: State<'_, AppState>) -> CommandResult<Response> {
    let last = session_mut(&state).state.last_file.clone();
    match last {
        Some(file) => prepare_open(&state, &file),
        None => Ok(none()),
    }
}

#[tauri::command]
pub async fn open_recent(state: State<'_, AppState>, path: String) -> CommandResult<Response> {
    if !session_mut(&state).state.recent_files.contains(&path) {
        return Err("履歴にないファイルです。".into());
    }
    prepare_open(&state, &path)
}

#[tauri::command]
pub async fn open_file_path(state: State<'_, AppState>, path: String) -> CommandResult<Response> {
    prepare_open(&state, &path)
}

#[tauri::command]
pub async fn open_score(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) -> CommandResult<Response> {
    let picked = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("譜面を開く")
        .add_filter("TAB / Guitar Pro", &["tg", "gp3", "gp4", "gp5", "gpx", "gp", "tabstudio"])
        .add_filter("すべてのファイル", &["*"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(none()) };
    let file = picked.into_path().map_err(text)?;
    prepare_open(&state, &file.to_string_lossy())
}

/// Asks where to save, starting from `default` (a full path or just a file name).
fn ask_save_path(app: &AppHandle, window: &WebviewWindow, title: &str, default: &str, filter: &str, ext: &str) -> CommandResult<Option<PathBuf>> {
    if let Some(answer) = test_save_answer(default) {
        return Ok(answer);
    }
    let mut dialog = app.dialog().file().set_parent(window).set_title(title).add_filter(filter, &[ext]);
    let default = Path::new(default);
    if default.is_absolute() {
        if let Some(dir) = default.parent() {
            dialog = dialog.set_directory(dir);
        }
    }
    dialog = dialog.set_file_name(file_name(&default.to_string_lossy()));
    match dialog.blocking_save_file() {
        Some(file) => Ok(Some(file.into_path().map_err(text)?)),
        None => Ok(None),
    }
}

/// Automated checks only (with TAB_STUDIO_TEST_DATA): save dialogs answer with this folder
/// plus the suggested name, and overwrite questions answer yes.
pub fn test_save_dir() -> Option<PathBuf> {
    std::env::var_os("TAB_STUDIO_TEST_DATA")?;
    std::env::var_os("TAB_STUDIO_TEST_SAVE_DIR").map(PathBuf::from)
}

/// Automated checks only: `<test data>/test-save-answer` holds the path the next save
/// dialog returns (empty = cancel), like the Electron checks replacing showSaveDialog.
fn test_save_answer(default: &str) -> Option<Option<PathBuf>> {
    let data = PathBuf::from(std::env::var_os("TAB_STUDIO_TEST_DATA")?);
    if let Ok(answer) = std::fs::read_to_string(data.join("test-save-answer")) {
        let answer = answer.trim();
        return Some((!answer.is_empty()).then(|| PathBuf::from(answer)));
    }
    test_save_dir().map(|dir| Some(dir.join(file_name(default))))
}

/// Forces the extension, like electron/export-files.cjs exportPath.
fn with_extension(file: PathBuf, ext: &str) -> PathBuf {
    if extension_is(&file, ext) {
        return file;
    }
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    file.with_file_name(format!("{stem}.{ext}"))
}

#[tauri::command]
pub async fn save_score(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>, request: Request<'_>) -> CommandResult<Value> {
    let body = take_body(&state, &request)?;
    let (args, bytes) = frame::split(&body).ok_or("保存データが不正です。")?;
    if bytes.len() as u64 > MAX_SCORE || !bytes.starts_with(b"PK") {
        return Err("保存データが不正です。".into());
    }
    let name = safe_name(args["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("Untitled"), 120);
    let mut file = {
        let files = files_mut(&state);
        if args["hasPath"] == Value::Bool(true) {
            args["path"].as_str().filter(|p| files.allowed(p) && extension_is(Path::new(p), "tg")).map(String::from)
        } else {
            files.saved_project_path.clone()
        }
    };
    if file.is_none() || args["saveAs"] == Value::Bool(true) {
        let default = file.clone().unwrap_or_else(|| format!("{name}.tg"));
        let Some(chosen) = ask_save_path(&app, &window, "TG譜面を保存", &default, "TuxGuitar", "tg")? else { return Ok(Value::Bool(false)) };
        file = Some(with_extension(chosen, "tg").to_string_lossy().into_owned());
    }
    let file = file.expect("a save path was chosen");
    atomic_write(Path::new(&file), bytes).map_err(text)?;
    {
        let mut files = files_mut(&state);
        files.saved_project_path = Some(file.clone());
        files.allow(&file);
    }
    session_mut(&state).remember(&file).map_err(text)?;
    Ok(json!({"name": file_name(&file), "path": file}))
}

fn signature(format: &str) -> Option<(&'static str, &'static [u8])> {
    match format {
        "gp" => Some(("Guitar Pro 7", b"PK")),
        "tg" => Some(("TuxGuitar", b"PK")),
        "mid" => Some(("MIDI", b"MThd")),
        "pdf" => Some(("PDF", b"%PDF-")),
        _ => None,
    }
}

pub fn validate_export(bytes: &[u8], format: &str) -> CommandResult<()> {
    let (_, sig) = signature(format).ok_or("未対応の出力形式です。")?;
    if bytes.len() > MAX_EXPORT {
        return Err("書き出しデータが不正です。".into());
    }
    if !bytes.starts_with(sig) {
        return Err("出力形式とデータが一致しません。".into());
    }
    Ok(())
}

struct ExportGuard<'a>(&'a State<'a, AppState>);
impl Drop for ExportGuard<'_> {
    fn drop(&mut self) {
        files_mut(self.0).exporting = false;
    }
}

#[tauri::command]
pub async fn export_score(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>, request: Request<'_>) -> CommandResult<Value> {
    let body = take_body(&state, &request)?;
    let (args, bytes) = frame::split(&body).ok_or("書き出しデータが不正です。")?;
    let format = args["format"].as_str().unwrap_or_default().to_string();
    let (label, _) = signature(&format).ok_or("未対応の出力形式です。")?;
    let score_json = if format == "pdf" {
        let tracks = args["tracks"].as_array();
        if bytes.len() > MAX_EXPORT || tracks.is_none_or(|t| t.len() > 128) {
            return Err("PDF用の譜面が不正です。".into());
        }
        Some(String::from_utf8(bytes.to_vec()).map_err(|_| "PDF用の譜面が不正です。")?)
    } else {
        validate_export(bytes, &format)?;
        None
    };
    {
        let mut files = files_mut(&state);
        if files.exporting {
            return Err("書き出しが完了するまでお待ちください。".into());
        }
        files.exporting = true;
    }
    let _guard = ExportGuard(&state);
    let name = safe_name(args["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("Untitled"), 120);
    let Some(chosen) = ask_save_path(&app, &window, &format!("{label}を書き出し"), &format!("{name}.{format}"), label, &format)? else { return Ok(Value::Bool(false)) };
    let file = with_extension(chosen, &format);
    let Some(score_json) = score_json else {
        atomic_write(&file, bytes).map_err(text)?;
        let file = file.to_string_lossy().into_owned();
        return Ok(json!({"name": file_name(&file), "path": file}));
    };
    export_pdf(&app, &window, &args, score_json, file)
}

fn export_pdf(app: &AppHandle, window: &WebviewWindow, args: &Value, score_json: String, file: PathBuf) -> CommandResult<Value> {
    let (pdf, page) = crate::pdf::pdf_options(&args["pdf"])?;
    let mut tracks: Vec<i64> = Vec::new();
    for track in args["tracks"].as_array().into_iter().flatten() {
        let index = track.as_i64().filter(|i| *i >= 0).ok_or("表示するトラックを選択してください。")?;
        if !tracks.contains(&index) {
            tracks.push(index);
        }
    }
    if tracks.is_empty() {
        return Err("表示するトラックを選択してください。".into());
    }
    let separate = pdf["separateTracks"] == Value::Bool(true);
    let groups: Vec<Vec<i64>> = if separate { tracks.iter().map(|t| vec![*t]).collect() } else { vec![tracks] };
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let outputs: Vec<PathBuf> = groups
        .iter()
        .map(|group| {
            if !separate {
                return file.clone();
            }
            let track_name = args["trackNames"][group[0] as usize].as_str().filter(|n| !n.is_empty()).unwrap_or("Track");
            file.with_file_name(format!("{stem} - {:02} {}.pdf", group[0] + 1, safe_name(track_name, 80)))
        })
        .collect();
    if separate {
        let existing: Vec<String> = outputs.iter().filter(|o| o.exists()).map(|o| file_name(&o.to_string_lossy())).collect();
        if !existing.is_empty() && test_save_dir().is_none() {
            use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
            let overwrite = app
                .dialog()
                .message(existing.join("
"))
                .title("同名のPDFを上書きしますか？")
                .kind(MessageDialogKind::Warning)
                .parent(window)
                .buttons(MessageDialogButtons::OkCancelCustom("上書き".into(), "キャンセル".into()))
                .blocking_show();
            if !overwrite {
                return Ok(Value::Bool(false));
            }
        }
    }
    let mut generated = Vec::new();
    for (i, group) in groups.iter().enumerate() {
        let temp = std::env::temp_dir().join(format!("tab-studio-{}-{i}.pdf", std::process::id()));
        let request = json!({"scoreJson": score_json, "tracks": group, "pdf": pdf});
        generated.push(crate::pdf::render_pdf(app, &format!("pdf-{i}"), &request, &page, &temp)?);
    }
    for (output, bytes) in outputs.iter().zip(&generated) {
        validate_export(bytes, "pdf")?;
        atomic_write(output, bytes).map_err(text)?;
    }
    let name = if separate { format!("{}個のPDF", outputs.len()) } else { file_name(&file.to_string_lossy()) };
    Ok(json!({"name": name, "path": outputs[0].to_string_lossy()}))
}

#[tauri::command]
pub async fn accept_open(state: State<'_, AppState>, token: String) -> CommandResult<()> {
    let file = {
        let mut files = files_mut(&state);
        let Some((pending, file)) = files.pending_open.clone() else { return Ok(()) };
        if pending != token {
            return Ok(());
        }
        files.allow(&file);
        files.saved_project_path = extension_is(Path::new(&file), "tg").then(|| file.clone());
        files.pending_open = None;
        file
    };
    session_mut(&state).remember(&file).map_err(text)
}

#[tauri::command]
pub async fn activate_document(state: State<'_, AppState>, path: Option<String>) -> CommandResult<()> {
    let path = path.filter(|p| !p.is_empty());
    if let Some(file) = &path {
        if !Path::new(file).is_absolute() {
            return Err("ファイルの場所が不正です。".into());
        }
        let known = files_mut(&state).allowed(file);
        if !known {
            if !std::fs::metadata(file).map(|m| m.is_file()).unwrap_or(false) {
                return Err("譜面ファイルがありません。".into());
            }
            files_mut(&state).allow(file);
        }
    }
    files_mut(&state).saved_project_path = path.clone().filter(|p| extension_is(Path::new(p), "tg"));
    let mut session = session_mut(&state);
    match &path {
        Some(file) => session.remember(file),
        None => session.clear_last(),
    }
    .map_err(text)
}

#[tauri::command]
pub async fn reset_save_path(state: State<'_, AppState>) -> CommandResult<()> {
    {
        let mut files = files_mut(&state);
        files.saved_project_path = None;
        files.pending_open = None;
    }
    session_mut(&state).clear_last().map_err(text)
}

#[tauri::command]
pub async fn recovery_write_documents(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<()> {
    let payload = parse_write(&take_body(&state, &request)?)?;
    state.recovery.write(payload)
}

#[tauri::command]
pub async fn recovery_read(state: State<'_, AppState>) -> CommandResult<Option<String>> {
    Ok(state.recovery.read())
}

#[tauri::command]
pub async fn recovery_clear(state: State<'_, AppState>) -> CommandResult<()> {
    state.recovery.clear()
}

pub fn remember_window_size(window: &WebviewWindow, state: &State<'_, AppState>) {
    let (Ok(minimized), Ok(fullscreen), Ok(maximized)) = (window.is_minimized(), window.is_fullscreen(), window.is_maximized()) else { return };
    if minimized || fullscreen {
        return;
    }
    let mut session = session_mut(state);
    // While maximized keep the last normal size, as Electron's getNormalBounds did.
    let (width, height) = match (&session.state.window_state, maximized) {
        (Some(previous), true) => (previous.width, previous.height),
        _ => {
            let Ok(size) = window.inner_size() else { return };
            let scale = window.scale_factor().unwrap_or(1.0);
            ((size.width as f64 / scale).round() as u32, (size.height as f64 / scale).round() as u32)
        }
    };
    if maximized && session.state.window_state.is_none() {
        return;
    }
    let _ = session.remember_window(WindowState { width, height, maximized });
}

#[tauri::command]
pub async fn finish_close(window: WebviewWindow, state: State<'_, AppState>) -> CommandResult<()> {
    remember_window_size(&window, &state);
    files_mut(&state).allow_close = true;
    window.close().map_err(text)
}

#[tauri::command]
pub async fn toggle_fullscreen(window: WebviewWindow) -> CommandResult<()> {
    let full = window.is_fullscreen().map_err(text)?;
    window.set_fullscreen(!full).map_err(text)
}

#[tauri::command]
pub async fn nam_model(state: State<'_, AppState>, id: String) -> CommandResult<String> {
    let library: Value = serde_json::from_slice(&std::fs::read(state.native_dir.join("nam-models.json")).map_err(text)?).map_err(text)?;
    let Some(file) = library.get(&id).and_then(Value::as_str) else { return Err("このNAMモデルは未登録です。".into()) };
    std::fs::read_to_string(nam_model_path(&state.native_dir, file)).map_err(text)
}

/// A nam-models.json entry: relative to the native folder; an absolute one written before the
/// project folder moved falls back to the file of that name in native/nam-models.
fn nam_model_path(native: &Path, file: &str) -> PathBuf {
    let path = native.join(file);
    if path.is_file() {
        return path;
    }
    Path::new(file).file_name().map(|name| native.join("nam-models").join(name)).filter(|p| p.is_file()).unwrap_or(path)
}

/// Where native assets (nam-models.json, ...) live: the bundle's resources when installed,
/// else the source tree (debug builds and release builds run from target/).
pub fn native_dir(app: &AppHandle) -> PathBuf {
    let bundled = app.path().resource_dir().map(|d| d.join("native")).ok().filter(|d| d.is_dir());
    bundled.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../native"))
}

/// The Electron build keeps its session in %APPDATA%/tab-studio. Copy it once so the
/// Tauri build starts with the same recent files and tabs.
pub fn import_electron_session(app: &AppHandle, target: &Path) {
    if target.exists() {
        return;
    }
    let Ok(roaming) = app.path().data_dir() else { return };
    let source = roaming.join("tab-studio").join("workspace-session.json");
    if let Ok(bytes) = std::fs::read(&source) {
        let _ = atomic_write(target, &bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::{absolute, same_path};

    #[test]
    fn nam_model_paths_survive_a_moved_project() {
        let native = std::env::temp_dir().join(format!("tabstudio-nam-{}", std::process::id()));
        std::fs::create_dir_all(native.join("nam-models")).unwrap();
        std::fs::write(native.join("nam-models").join("a.nam"), "{}").unwrap();
        assert_eq!(nam_model_path(&native, "nam-models/a.nam"), native.join("nam-models/a.nam"));
        // Written before the folder was renamed: the same file under native/nam-models.
        assert_eq!(nam_model_path(&native, r"C:\old folder\native\nam-models\a.nam"), native.join("nam-models").join("a.nam"));
        assert!(!nam_model_path(&native, "nam-models/missing.nam").is_file());
        std::fs::remove_dir_all(&native).ok();
    }

    #[test]
    fn export_validation_matches_electron() {
        assert!(validate_export(b"PK\x03\x04", "gp").is_ok());
        assert!(validate_export(b"MThd....", "mid").is_ok());
        assert!(validate_export(b"PK..", "mid").is_err());
        assert!(validate_export(b"%PDF-1.7", "pdf").is_ok());
        assert!(validate_export(b"PK", "exe").is_err());
    }

    #[test]
    fn extension_is_forced() {
        let base = std::env::temp_dir();
        assert_eq!(with_extension(base.join("song.TG"), "tg"), base.join("song.TG"));
        assert_eq!(with_extension(base.join("song.txt"), "tg"), base.join("song.tg"));
        assert_eq!(with_extension(base.join("song"), "mid"), base.join("song.mid"));
    }

    #[test]
    fn allowed_paths_ignore_case_on_windows() {
        let mut files = FileState::default();
        let file = absolute(&std::env::temp_dir().join("Song.tg").to_string_lossy());
        files.allow(&file);
        assert!(files.allowed(&file));
        assert_eq!(files.allowed(&file.to_uppercase()), cfg!(windows));
        assert!(same_path(&file, &file));
    }
}

// SFZ instruments (Guitar DI) through the Python host; see sampler.rs.

#[tauri::command]
pub async fn sfz_library(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Value> {
    let electron = app.path().data_dir().ok().map(|d| d.join("tab-studio").join("standard-guitar.json"));
    let desktop = app.path().desktop_dir().ok();
    let found = crate::sampler::find_standard_guitar(&state.data_dir.join("standard-guitar.json"), electron.as_deref(), &state.native_dir, desktop.as_deref());
    let mut library: Vec<Value> = found.into_iter().map(|path| json!({"name": "Guitar DI", "path": path})).collect();
    // The Standard Guitar stays first: it is the Guitar DI unless a track chose a Les Paul.
    library.extend(crate::sampler::find_lespaul(&state.native_dir).into_iter().map(|(name, path)| json!({"name": name, "path": path})));
    library.extend(crate::sampler::find_standard_bass(&state.native_dir).into_iter().map(|(name, path)| json!({"name": name, "path": path})));
    Ok(Value::Array(library))
}

#[tauri::command]
pub async fn sfz_file(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) -> CommandResult<Option<String>> {
    let picked = app.dialog().file().set_parent(&window).set_title("SFZ音源を選択（Standard Guitarなど）").add_filter("SFZ instrument", &["sfz"]).blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let file = picked.into_path().map_err(text)?.to_string_lossy().into_owned();
    if file.to_lowercase().ends_with("01-standard guitar ksop.sfz") {
        atomic_write(&state.data_dir.join("standard-guitar.json"), json!({"path": file}).to_string().as_bytes()).map_err(text)?;
    }
    Ok(Some(file))
}

#[tauri::command]
pub async fn sfz_load(state: State<'_, AppState>, path: String, lanes: Option<Value>, pitches: Option<Value>) -> CommandResult<Value> {
    let lanes = crate::sampler::valid_lanes(&lanes.unwrap_or(json!([])))?;
    let pitches = crate::sampler::valid_pitches(&pitches.unwrap_or(json!({})))?;
    let native = state.native_dir.clone();
    let (id, name) = state.sampler.load(&native, &path, &lanes, &pitches)?;
    Ok(json!({"id": id, "name": name}))
}

#[tauri::command]
pub async fn sfz_prepare(state: State<'_, AppState>, id: String, lanes: Value, pitches: Option<Value>) -> CommandResult<Value> {
    let lanes = crate::sampler::valid_lanes(&lanes)?;
    let pitches = crate::sampler::valid_pitches(&pitches.unwrap_or(json!({})))?;
    state.sampler.command(&id, "prepare", json!({"lanes": lanes, "pitches": pitches}))
}

#[tauri::command]
pub async fn sfz_render(state: State<'_, AppState>, id: String, frames: u32, rate: f64, events: Value) -> CommandResult<Response> {
    Ok(Response::new(state.sampler.render(&id, frames, rate, events)?))
}

#[tauri::command]
pub async fn sfz_reset(state: State<'_, AppState>, id: String) -> CommandResult<Value> {
    state.sampler.command(&id, "reset", json!({}))
}

// External effects (VST3) through tabstudio-fx-host; see sampler.rs and plugins.rs.

/// Saved plugin folders: this app's list, then the Electron build's.
fn fx_folders(app: &AppHandle, state: &AppState) -> Vec<PathBuf> {
    let mut folders = crate::plugins::saved_folders(&state.data_dir.join("fx-folders.json"));
    if let Ok(roaming) = app.path().data_dir() {
        folders.extend(crate::plugins::saved_folders(&roaming.join("tab-studio").join("fx-folders.json")));
    }
    folders.dedup();
    folders.truncate(crate::plugins::MAX_FOLDERS);
    folders
}

fn fx_scan_now(app: &AppHandle, state: &AppState) -> Value {
    let mut roots = crate::plugins::system_folders();
    roots.extend(fx_folders(app, state));
    let found = crate::plugins::scan(&roots);
    *state.plugins.lock().unwrap_or_else(|e| e.into_inner()) = found.iter().map(|(p, _)| p.to_string_lossy().into_owned()).collect();
    crate::plugins::listing(&found)
}

#[tauri::command]
pub async fn fx_scan(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Value> {
    Ok(fx_scan_now(&app, &state))
}

/// Adds a folder to search (remembered) and rescans.
#[tauri::command]
pub async fn fx_folder(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) -> CommandResult<Value> {
    if let Some(picked) = app.dialog().file().set_parent(&window).set_title("プラグインのフォルダー").blocking_pick_folder() {
        let folder = picked.into_path().map_err(text)?;
        let file = state.data_dir.join("fx-folders.json");
        let mut folders = crate::plugins::saved_folders(&file);
        if !folders.contains(&folder) {
            folders.push(folder);
        }
        folders.truncate(crate::plugins::MAX_FOLDERS);
        atomic_write(&file, json!(folders).to_string().as_bytes()).map_err(text)?;
    }
    Ok(fx_scan_now(&app, &state))
}

/// The host program, built beside the app (src/bin/tabstudio-fx-host.rs).
fn fx_host_program() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(text)?;
    let host = exe.with_file_name(if cfg!(windows) { "tabstudio-fx-host.exe" } else { "tabstudio-fx-host" });
    if host.is_file() { Ok(host) } else { Err("外部FXホストが見つかりません。".into()) }
}

#[tauri::command]
pub async fn fx_load(app: AppHandle, state: State<'_, AppState>, path: String, preset: Option<String>) -> CommandResult<Value> {
    if !state.plugins.lock().unwrap_or_else(|e| e.into_inner()).contains(&path) {
        fx_scan_now(&app, &state);
        if !state.plugins.lock().unwrap_or_else(|e| e.into_inner()).contains(&path) {
            return Err("プラグイン一覧から選択してください。".into());
        }
    }
    let (id, name) = state.sampler.load_fx(&fx_host_program()?, Path::new(&path), preset.as_deref())?;
    Ok(json!({"id": id, "name": name}))
}

/// Body: frame header {id, rate}, then stereo f32 PCM; answers the processed PCM.
#[tauri::command]
pub async fn fx_process(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<Response> {
    let body = take_body(&state, &request)?;
    let (header, pcm) = frame::split(&body).ok_or("音声ブロックが不正です。")?;
    let id = header["id"].as_str().ok_or("FXが読み込まれていません。")?;
    let rate = header["rate"].as_f64().unwrap_or(0.0);
    Ok(Response::new(state.sampler.process(id, pcm, rate)?))
}

/// Opens the plugin's editor; answers with its state once the user closes it.
#[tauri::command]
pub async fn fx_editor(state: State<'_, AppState>, id: String) -> CommandResult<Value> {
    state.sampler.command_waiting(&id, "editor", json!({}))
}

#[tauri::command]
pub async fn fx_state(state: State<'_, AppState>, id: String) -> CommandResult<Value> {
    state.sampler.command(&id, "state", json!({}))
}

#[tauri::command]
pub async fn fx_close(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    state.audio.unlink(&id);
    state.audio.live_unlink(&id);
    state.sampler.close(&id);
    Ok(())
}

// Native audio engine (crates/tabstudio-audio); see audio.rs.

#[tauri::command]
pub async fn audio_start(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Value> {
    let cache = state.data_dir.join("audio-cache");
    let resolver = app.asset_resolver();
    let asset = ["/", ""].iter().find_map(|prefix| resolver.get(format!("{prefix}{}", crate::audio::SOUNDFONT))).map(|a| a.bytes);
    state.audio.set_nam_cache(cache.clone());
    let handle = app.clone();
    state.audio.set_linker(Box::new(move |id, name| handle.state::<AppState>().sampler.command(id, "link", json!({"name": name}))));
    state.audio.set_sfizz_library(state.native_dir.join("runtime").join(if cfg!(windows) { "sfizz.dll" } else { "libsfizz.dylib" }));
    // Takes go to Music\Tab Studio 録音 (automated checks keep them in their profile).
    let takes = if std::env::var_os("TAB_STUDIO_TEST_DATA").is_some() { None } else { app.path().audio_dir().or_else(|_| app.path().document_dir()).ok() }
        .map(|d| d.join("Tab Studio 録音"))
        .unwrap_or_else(|| state.data_dir.join("live").join("takes"));
    state.audio.set_live_dirs(&state.data_dir, takes);
    let (rate, device) = state.audio.start(|| crate::audio::soundfont_bytes(asset, &cache))?;
    Ok(json!({"sampleRate": rate, "device": device}))
}

#[tauri::command]
pub async fn audio_load(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<Value> {
    let body = take_body(&state, &request)?;
    state.audio.load(&body)
}

#[tauri::command]
pub async fn audio_soundfont(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<()> {
    let body = take_body(&state, &request)?;
    state.audio.soundfont(&body)
}

#[tauri::command]
pub async fn audio_command(state: State<'_, AppState>, request: crate::audio::Request) -> CommandResult<()> {
    state.audio.command(request)
}

#[tauri::command]
pub async fn audio_subscribe(state: State<'_, AppState>, channel: tauri::ipc::Channel<Value>) -> CommandResult<()> {
    state.audio.subscribe(move |status| channel.send(status).is_ok());
    Ok(())
}

/// Body: frame header {index, key}, then the model's JSON text (empty when key is null:
/// the track's amp is removed). The engine keeps the amp while the key stays the same.
#[tauri::command]
pub async fn audio_nam(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<Value> {
    let body = take_body(&state, &request)?;
    let (header, json) = frame::split(&body).ok_or("NAMデータが不正です。")?;
    let index = header["index"].as_u64().ok_or("トラック番号が不正です。")? as usize;
    let key = header["key"].as_str().map(str::to_string);
    let json = if json.is_empty() { None } else { Some(std::str::from_utf8(json).map_err(text)?) };
    let loaded = state.audio.set_track_nam(index, key, json)?;
    Ok(json!({"loaded": loaded}))
}

/// Body: frame header {track}, then the preview's event list.
#[tauri::command]
pub async fn audio_preview(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<Value> {
    let body = take_body(&state, &request)?;
    let (header, events) = frame::split(&body).ok_or("試聴データが不正です。")?;
    let track = header["track"].as_u64().unwrap_or(0) as usize;
    state.audio.preview(events, track)
}

#[tauri::command]
pub async fn audio_preview_stop(state: State<'_, AppState>) -> CommandResult<()> {
    state.audio.stop_preview()
}

/// Picks an audio file for the backing track.
#[tauri::command]
pub async fn backing_file(app: AppHandle, window: WebviewWindow) -> CommandResult<Option<String>> {
    let picked = app.dialog().file().set_parent(&window).set_title("伴奏の音声ファイルを選択").add_filter("音声ファイル", &["mp3", "m4a", "aac", "mp4", "flac", "wav", "aif", "aiff", "ogg", "oga"]).blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    Ok(Some(picked.into_path().map_err(text)?.to_string_lossy().into_owned()))
}

/// Decodes the backing file (off the async runtime: a long file takes seconds) and plays it
/// with the song. `document`: the score's path, to find the audio next to a moved project.
#[tauri::command]
pub async fn backing_load(state: State<'_, AppState>, path: String, document: Option<String>) -> CommandResult<Value> {
    let audio = state.audio.clone();
    tauri::async_runtime::spawn_blocking(move || audio.backing_load(std::path::Path::new(&path), document.as_deref().map(std::path::Path::new))).await.map_err(text)?
}

#[tauri::command]
pub async fn backing_clear(state: State<'_, AppState>) -> CommandResult<()> {
    state.audio.backing_clear()
}

#[tauri::command]
pub async fn audio_status(state: State<'_, AppState>) -> CommandResult<Option<Value>> {
    Ok(state.audio.status())
}

// Instrument input (live_input.rs).

#[tauri::command]
pub async fn live_devices(state: State<'_, AppState>) -> CommandResult<Value> {
    Ok(state.audio.live_devices())
}

#[tauri::command]
pub async fn live_configure(state: State<'_, AppState>, config: crate::live_input::LiveConfig) -> CommandResult<Value> {
    state.audio.live_configure(config)
}

#[tauri::command]
pub async fn live_enable(state: State<'_, AppState>, on: bool, recording: bool) -> CommandResult<Value> {
    state.audio.live_enable(on, recording)
}

#[tauri::command]
pub async fn live_recording(state: State<'_, AppState>, on: bool) -> CommandResult<()> {
    state.audio.live_recording(on);
    Ok(())
}

#[tauri::command]
pub async fn live_status(state: State<'_, AppState>) -> CommandResult<Value> {
    Ok(state.audio.live_status())
}

/// Body: frame header {key}, then the model's JSON text (empty: keep the running amp with
/// that key, or remove it when key is null).
#[tauri::command]
pub async fn live_nam(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<()> {
    let body = take_body(&state, &request)?;
    let (header, json) = frame::split(&body).ok_or("NAMデータが不正です。")?;
    let key = header["key"].as_str().map(str::to_string);
    let json = if json.is_empty() { None } else { Some(std::str::from_utf8(json).map_err(text)?) };
    state.audio.live_nam(key, json)
}

#[tauri::command]
pub async fn live_nam_tone(state: State<'_, AppState>, input: f32, output: f32, bass: f32, mid: f32, treble: f32, cabinet: bool) -> CommandResult<()> {
    let db = |v: f32| if v.is_finite() { Ok(v.clamp(-60.0, 40.0)) } else { Err("値が不正です。".to_string()) };
    state.audio.live_nam_tone(tabstudio_audio::nam::NamTone { input: db(input)?, output: db(output)?, bass: db(bass)?, mid: db(mid)?, treble: db(treble)?, cabinet })
}

#[tauri::command]
pub async fn live_fx(state: State<'_, AppState>, fx: Vec<crate::audio::FxSpec>) -> CommandResult<()> {
    state.audio.live_fx(fx)
}

#[tauri::command]
pub async fn live_recent(state: State<'_, AppState>, frames: usize) -> CommandResult<Value> {
    Ok(state.audio.live_recent(frames))
}

#[tauri::command]
pub async fn live_overview(state: State<'_, AppState>, from: u64, to: u64, buckets: usize) -> CommandResult<Value> {
    Ok(state.audio.live_overview(from, to, buckets))
}

#[tauri::command]
pub async fn live_replay(state: State<'_, AppState>, from: u64, to: u64, looping: bool, source: String, with_song: bool) -> CommandResult<Value> {
    state.audio.live_replay(from, to, looping, &source, with_song)
}

#[tauri::command]
pub async fn live_replay_stop(state: State<'_, AppState>) -> CommandResult<()> {
    state.audio.live_replay_stop()
}

#[tauri::command]
pub async fn live_take_start(state: State<'_, AppState>, back: f64, label: String, extra: Value) -> CommandResult<Value> {
    state.audio.live_take_start(back, &label, &extra)
}

#[tauri::command]
pub async fn live_take_stop(state: State<'_, AppState>) -> CommandResult<Value> {
    Ok(state.audio.live_take_stop())
}

#[tauri::command]
pub async fn live_save(state: State<'_, AppState>, from: u64, to: u64, label: String, extra: Value) -> CommandResult<Value> {
    state.audio.live_save(from, to, &label, &extra)
}

#[tauri::command]
pub async fn live_ping(state: State<'_, AppState>) -> CommandResult<Value> {
    state.audio.live_ping()
}

#[tauri::command]
pub async fn live_reconnect(state: State<'_, AppState>) -> CommandResult<Value> {
    state.audio.live_reconnect()
}

#[tauri::command]
pub async fn live_takes(state: State<'_, AppState>) -> CommandResult<Value> {
    state.audio.live_takes()
}

/// Shows the takes folder (or one take) in Explorer.
#[tauri::command]
pub async fn live_reveal(state: State<'_, AppState>, path: Option<String>) -> CommandResult<()> {
    let dir = state.audio.live_takes_dir()?;
    let target = path.map(PathBuf::from).filter(|p| p.starts_with(&dir) && p.exists());
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("explorer.exe");
        match &target {
            Some(file) => command.arg(format!("/select,{}", file.display())),
            None => command.arg(&dir),
        };
        command.spawn().map_err(text)?;
    }
    #[cfg(not(windows))]
    let _ = target;
    Ok(())
}

#[tauri::command]
pub async fn audio_stop(state: State<'_, AppState>) -> CommandResult<()> {
    state.audio.stop();
    Ok(())
}
