//! The external effect host (crates/tabstudio-fx-host), built next to the app so the app
//! finds it beside its own executable. One process per loaded plugin.
#[cfg(windows)]
fn main() {
    tabstudio_fx_host::host_main();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("tabstudio-fx-host: VST3 hosting is implemented for Windows only");
    std::process::exit(1);
}
