//! tabstudio-fx-host: one VST3 effect in its own process.
//!
//! `tabstudio-fx-host <plugin.vst3>` speaks the line protocol of the Electron build's
//! native/fx-host.py, so the app side can use either: requests are JSON lines on stdin
//! ({id, cmd, ...}); replies are "TABSTUDIO:" + JSON lines on stdout ({id, ...} or
//! {id, error}); id 0 announces {name, ready, latency} after loading.
//! Commands: process {pcm (base64 interleaved stereo f32), rate} -> {pcm}; state -> {state};
//! restore {state} -> {restored}; reset -> {reset}; editor -> {state} once the user closes
//! the editor window; editor-close -> {closed}; close -> {closed} and exit.
//!
//! Spike S10 commands: `render <plugin> <rate> <in.f32> <out.f32> [state]` and
//! `state <plugin> <out>`.
#[cfg(windows)]
fn main() {
    tabstudio_fx_host::host_main();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("tabstudio-fx-host: VST3 hosting is implemented for Windows only");
    std::process::exit(1);
}
