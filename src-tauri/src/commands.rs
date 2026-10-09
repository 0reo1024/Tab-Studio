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
    std::fs::read_to_string(file).map_err(text)
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
    Ok(match found {
        Some(path) => json!([{"name": "Guitar DI", "path": path}]),
        None => json!([]),
    })
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

#[tauri::command]
pub async fn fx_close(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    state.sampler.close(&id);
    Ok(())
}

// Native audio engine (crates/tabstudio-audio); see audio.rs.

#[tauri::command]
pub async fn audio_start(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Value> {
    let cache = state.data_dir.join("audio-cache");
    let resolver = app.asset_resolver();
    let asset = ["/", ""].iter().find_map(|prefix| resolver.get(format!("{prefix}{}", crate::audio::SOUNDFONT))).map(|a| a.bytes);
    state.audio.set_sfizz_library(state.native_dir.join("runtime").join(if cfg!(windows) { "sfizz.dll" } else { "libsfizz.dylib" }));
    let (rate, device) = state.audio.start(|| crate::audio::soundfont_bytes(asset, &cache))?;
    Ok(json!({"sampleRate": rate, "device": device}))
}

#[tauri::command]
pub async fn audio_load(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<Value> {
    let body = take_body(&state, &request)?;
    state.audio.load(&body)
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

#[tauri::command]
pub async fn audio_status(state: State<'_, AppState>) -> CommandResult<Option<Value>> {
    Ok(state.audio.status())
}

#[tauri::command]
pub async fn audio_stop(state: State<'_, AppState>) -> CommandResult<()> {
    state.audio.stop();
    Ok(())
}
