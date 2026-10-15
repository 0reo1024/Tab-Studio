//! The host process loop. The main thread owns the editor window and pumps messages;
//! a reader thread takes stdin requests, runs `process` itself (as fx-host.py does, so a
//! busy editor never stalls audio) and hands everything else to the main thread.
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use crate::editor::Editor;
use crate::vst3host::Plugin;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

/// Largest `process` block accepted (as fx-host.py: 1 MiB of stereo f32).
const MAX_PCM: usize = 1024 * 1024;
const BLOCK: usize = 512;

/// The plugin is used from the reader thread (audio) and the main thread (state, editor),
/// one call at a time.
struct Shared(Mutex<Plugin>);
// SAFETY: VST3 processors and controllers are called from host threads by design; every
// call here goes through the mutex, so there is no concurrent use of one object.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

fn reply(id: &Value, mut value: Value) {
    value["id"] = id.clone();
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "TABSTUDIO:{value}");
    let _ = out.flush();
}

fn fail(id: &Value, error: impl ToString) {
    reply(id, json!({"error": error.to_string()}));
}

pub fn run(path: &Path) -> Result<(), String> {
    let plugin = match load(path) {
        Ok(p) => p,
        Err(e) => {
            fail(&json!(0), &e);
            return Err(e);
        }
    };
    let (name, latency, controller) = (plugin.name.clone(), plugin.latency, plugin.controller().cloned());
    let shared = Arc::new(Shared(Mutex::new(plugin)));
    reply(&json!(0), json!({"name": name, "ready": true, "latency": latency}));
    let (tx, rx) = channel::<Value>();
    let main_thread = unsafe { GetCurrentThreadId() };
    let reader = shared.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
            if request["cmd"] == "process" {
                process(&reader, &request);
                continue;
            }
            let closing = request["cmd"] == "close";
            if tx.send(request).is_err() {
                break;
            }
            unsafe { PostThreadMessageW(main_thread, WM_APP, 0, 0) };
            if closing {
                break;
            }
        }
        // stdin closed (the app went away): shut down.
        let _ = tx.send(json!({"id": null, "cmd": "close"}));
        unsafe { PostThreadMessageW(main_thread, WM_APP, 0, 0) };
    });
    main_loop(&shared, controller, &name, rx);
    Ok(())
}

fn load(path: &Path) -> Result<Plugin, String> {
    // The Electron host loads at 44.1 kHz and re-prepares on the first block's rate.
    let mut plugin = Plugin::load(path, 44100.0, BLOCK)?;
    // Initialize DSP before the first editor open (BIAS builds its engine lazily).
    let (mut l, mut r) = (vec![0f32; BLOCK], vec![0f32; BLOCK]);
    plugin.process(&mut l, &mut r);
    Ok(plugin)
}

fn process(shared: &Shared, request: &Value) {
    let id = &request["id"];
    let raw = match request["pcm"].as_str().map(|s| B64.decode(s)) {
        Some(Ok(raw)) if raw.len() <= MAX_PCM && raw.len() % 8 == 0 => raw,
        _ => return fail(id, "Invalid stereo PCM block"),
    };
    let rate = request["rate"].as_f64().unwrap_or(0.0);
    if !(22050.0..=192000.0).contains(&rate) {
        return fail(id, "Invalid sample rate");
    }
    let (mut left, mut right): (Vec<f32>, Vec<f32>) = raw.chunks_exact(8).map(|f| (f32::from_le_bytes(f[0..4].try_into().unwrap()), f32::from_le_bytes(f[4..8].try_into().unwrap()))).unzip();
    {
        let mut plugin = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        if plugin.sample_rate != rate {
            if let Err(e) = plugin.set_sample_rate(rate) {
                return fail(id, e);
            }
        }
        plugin.process(&mut left, &mut right);
    }
    let pcm: Vec<u8> = left.iter().zip(&right).flat_map(|(l, r)| [l.to_le_bytes(), r.to_le_bytes()]).flatten().collect();
    reply(id, json!({"pcm": B64.encode(pcm)}));
}

fn state(shared: &Shared) -> Result<String, String> {
    Ok(B64.encode(shared.0.lock().unwrap_or_else(|e| e.into_inner()).preset()?))
}

/// The native engine's shared-memory link (tabstudio-fxlink), served on its own thread.
struct Link {
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Link {
    fn start(shared: Arc<Shared>, name: &str) -> Result<Link, String> {
        let link = tabstudio_fxlink::Shared::open(name)?;
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new().name("fx-link".into()).spawn(move || {
            // Pro Audio scheduling: at normal priority this thread was seen stalling 9-13 ms,
            // too long for a live (short delay) link (docs/live-input-phase1.md).
            pro_audio_thread();
            let mut end = tabstudio_fxlink::HostEnd::new(link, BLOCK);
            while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                let rate = end.sample_rate();
                let latency = {
                    let mut plugin = shared.0.lock().unwrap_or_else(|e| e.into_inner());
                    if plugin.sample_rate != rate && (22050.0..=192000.0).contains(&rate) {
                        let _ = plugin.set_sample_rate(rate);
                    }
                    plugin.latency as usize
                };
                end.pump(20, latency, |l, r| shared.0.lock().unwrap_or_else(|e| e.into_inner()).process(l, r));
            }
        }).map_err(|e| e.to_string())?;
        Ok(Link { stop, thread: Some(thread) })
    }
}

/// Raises the calling thread to the MMCSS "Pro Audio" class (as DAW audio threads run).
fn pro_audio_thread() {
    #[link(name = "avrt")]
    extern "system" {
        fn AvSetMmThreadCharacteristicsW(task: *const u16, index: *mut u32) -> *mut core::ffi::c_void;
    }
    let task: Vec<u16> = "Pro Audio".encode_utf16().chain(Some(0)).collect();
    let mut index = 0u32;
    unsafe { AvSetMmThreadCharacteristicsW(task.as_ptr(), &mut index) };
}

impl Drop for Link {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn main_loop(shared: &Arc<Shared>, controller: Option<vst3::ComPtr<vst3::Steinberg::Vst::IEditController>>, name: &str, rx: Receiver<Value>) {
    let mut editor: Option<Editor> = None;
    let mut link: Option<Link> = None;
    // `editor` requests wait until the user closes the window, then get the state.
    let mut waiting: Vec<Value> = Vec::new();
    let answer = |waiting: &mut Vec<Value>| {
        if waiting.is_empty() {
            return;
        }
        let result = state(shared);
        for id in waiting.drain(..) {
            match &result {
                Ok(s) => reply(&id, json!({"state": s})),
                Err(e) => fail(&id, e),
            }
        }
    };
    loop {
        unsafe {
            MsgWaitForMultipleObjects(0, std::ptr::null(), 0, 100, QS_ALLINPUT);
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if Editor::take_hidden() {
            answer(&mut waiting);
        }
        while let Ok(request) = rx.try_recv() {
            let id = request["id"].clone();
            match request["cmd"].as_str().unwrap_or("") {
                "state" => match state(shared) {
                    Ok(s) => reply(&id, json!({"state": s})),
                    Err(e) => fail(&id, e),
                },
                "restore" => {
                    let result = request["state"].as_str().ok_or("state がありません。".to_string()).and_then(|s| B64.decode(s).map_err(|e| e.to_string())).and_then(|data| shared.0.lock().unwrap_or_else(|e| e.into_inner()).set_preset(&data));
                    match result {
                        Ok(()) => reply(&id, json!({"restored": true})),
                        Err(e) => fail(&id, e),
                    }
                }
                "reset" => {
                    shared.0.lock().unwrap_or_else(|e| e.into_inner()).reset();
                    reply(&id, json!({"reset": true}));
                }
                "editor" => {
                    match (&editor, &controller) {
                        (Some(e), _) => {
                            e.show();
                            waiting.push(id);
                        }
                        (None, Some(c)) => match Editor::open(c, name) {
                            Ok(e) => {
                                editor = Some(e);
                                waiting.push(id);
                            }
                            Err(e) => fail(&id, e),
                        },
                        (None, None) => fail(&id, "このプラグインには編集画面がありません。"),
                    }
                }
                // Automated checks: save a picture of the open editor window.
                "capture" => match (&editor, request["path"].as_str()) {
                    (Some(e), Some(path)) => match e.capture(Path::new(path)) {
                        Ok((w, h)) => reply(&id, json!({"width": w, "height": h, "visible": e.visible()})),
                        Err(err) => fail(&id, err),
                    },
                    _ => fail(&id, "編集画面が開いていません。"),
                },
                // The native engine links this effect into a track (shared memory).
                "link" => {
                    link = None;
                    match request["name"].as_str().map(|n| Link::start(shared.clone(), n)) {
                        Some(Ok(l)) => {
                            link = Some(l);
                            let latency = shared.0.lock().unwrap_or_else(|e| e.into_inner()).latency;
                            reply(&id, json!({"linked": true, "latency": latency}));
                        }
                        Some(Err(e)) => fail(&id, e),
                        None => fail(&id, "link name がありません。"),
                    }
                }
                "unlink" => {
                    link = None;
                    reply(&id, json!({"unlinked": true}));
                }
                "editor-close" => {
                    editor = None;
                    answer(&mut waiting);
                    reply(&id, json!({"closed": true}));
                }
                "close" => {
                    drop(link.take());
                    drop(editor.take());
                    answer(&mut waiting);
                    if !id.is_null() {
                        reply(&id, json!({"closed": true}));
                    }
                    return;
                }
                other => fail(&id, format!("Unknown FX command: {other}")),
            }
        }
    }
}
