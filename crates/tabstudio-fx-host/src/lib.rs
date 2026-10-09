//! Tab Studio's external effect host (plan P2-13): VST3 effects run in their own process
//! (tabstudio-fx-host.exe, one per plugin) so a crashing plugin cannot take the app down.
pub mod preset;
#[cfg(windows)]
pub mod vst3host;
#[cfg(windows)]
pub mod editor;
#[cfg(windows)]
pub mod serve;

/// The host program's entry (also built as src-tauri's `tabstudio-fx-host` binary).
#[cfg(windows)]
pub fn host_main() {
    let args: Vec<String> = std::env::args().collect();
    unsafe { windows_sys::Win32::System::Ole::OleInitialize(std::ptr::null()) };
    let result = match args.get(1).map(String::as_str) {
        Some("render") => spike_render(&args),
        Some("state") => spike_state(&args),
        Some(path) => serve::run(std::path::Path::new(path)),
        None => Err("usage: tabstudio-fx-host <plugin.vst3>".into()),
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn spike_render(args: &[String]) -> Result<(), String> {
    use crate::vst3host::Plugin;
    let rate: f64 = args.get(3).and_then(|r| r.parse().ok()).ok_or("rate")?;
    let mut plugin = Plugin::load(std::path::Path::new(&args[2]), rate, 512)?;
    if let Some(state) = args.get(6) {
        plugin.set_preset(&std::fs::read(state).map_err(|e| e.to_string())?)?;
    }
    eprintln!("{} latency {}", plugin.name, plugin.latency);
    let raw = std::fs::read(&args[4]).map_err(|e| e.to_string())?;
    let pcm: Vec<f32> = raw.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
    let (mut l, mut r): (Vec<f32>, Vec<f32>) = pcm.chunks_exact(2).map(|f| (f[0], f[1])).unzip();
    let t = std::time::Instant::now();
    plugin.process(&mut l, &mut r);
    eprintln!("processed {} frames in {:?}", l.len(), t.elapsed());
    let out: Vec<u8> = l.iter().zip(&r).flat_map(|(a, b)| [a.to_le_bytes(), b.to_le_bytes()]).flatten().collect();
    std::fs::write(&args[5], out).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn spike_state(args: &[String]) -> Result<(), String> {
    let plugin = crate::vst3host::Plugin::load(std::path::Path::new(&args[2]), 48000.0, 512)?;
    std::fs::write(&args[3], plugin.preset()?).map_err(|e| e.to_string())
}

