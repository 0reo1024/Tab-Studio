mod commands;
mod frame;
mod pdf;
mod fsutil;
mod recovery;
mod session;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, LogicalSize, Manager, WindowEvent};

use commands::AppState;

/// User data folder; TAB_STUDIO_TEST_DATA isolates automated checks as in Electron.
fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    match std::env::var_os("TAB_STUDIO_TEST_DATA") {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_data_dir().expect("app data folder"),
    }
}

/// Restores the remembered size, clamped to the work area like electron/main.cjs.
fn restore_window(window: &tauri::WebviewWindow, saved: Option<session::WindowState>) {
    let Ok(Some(monitor)) = window.current_monitor() else { return };
    let scale = monitor.scale_factor();
    let area = monitor.work_area().size.to_logical::<f64>(scale);
    let min = LogicalSize::new(area.width.min(1024.0), area.height.min(680.0));
    let _ = window.set_min_size(Some(min));
    let width = min.width.max(area.width.min(saved.as_ref().map_or(1440.0, |s| s.width as f64)));
    let height = min.height.max(area.height.min(saved.as_ref().map_or(950.0, |s| s.height as f64)));
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.center();
    if saved.is_some_and(|s| s.maximized) {
        let _ = window.maximize();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            let handle = app.handle();
            let data = data_dir(handle);
            let session_file = data.join("workspace-session.json");
            if std::env::var_os("TAB_STUDIO_TEST_DATA").is_none() {
                commands::import_electron_session(handle, &session_file);
            }
            let mut store = session::SessionStore::new(session_file);
            store.initialize();
            let saved = store.state.window_state.clone();
            app.manage(AppState {
                session: Mutex::new(store),
                recovery: recovery::RecoveryStore::new(data.join("recovery"), data.join("recovery.json")),
                files: Mutex::new(Default::default()),
                native_dir: commands::native_dir(handle),
                uploads: Mutex::new(Default::default()),
            });
            // The main window is built here so automated checks get their own WebView
            // storage (localStorage etc.) next to TAB_STUDIO_TEST_DATA, as Electron's userData did.
            let config = app.config().app.windows.iter().find(|w| w.label == "main").expect("main window config").clone();
            let mut builder = tauri::WebviewWindowBuilder::from_config(handle, &config)?;
            if std::env::var_os("TAB_STUDIO_TEST_DATA").is_some() {
                builder = builder.data_directory(data.join("webview"));
            }
            let window = builder.build()?;
            restore_window(&window, saved);
            Ok(())
        })
        .on_window_event(|window, event| {
            // The page decides whether to close (unsaved tabs); it answers with finish_close.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let allow = state.files.lock().map(|f| f.allow_close).unwrap_or(true);
                if !allow {
                    api.prevent_close();
                    let _ = window.emit_to(window.label(), "close-request", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_session,
            commands::remember_workspace,
            commands::read_workspace_file,
            commands::recent_files,
            commands::last_score,
            commands::open_recent,
            commands::open_file_path,
            commands::open_score,
            commands::save_score,
            commands::export_score,
            commands::accept_open,
            commands::activate_document,
            commands::reset_save_path,
            commands::recovery_write_documents,
            commands::recovery_read,
            commands::recovery_clear,
            commands::finish_close,
            commands::toggle_fullscreen,
            commands::nam_model,
            commands::upload_chunk,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tab Studio");
}
