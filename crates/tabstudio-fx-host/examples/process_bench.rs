//! How long one plugin's own `process` takes per small block, called in this thread at the
//! pace of an ASIO buffer (no link, no other process): the floor for running the plugin
//! inside the audio callback.
//!
//! cargo run --release --example process_bench -- <plugin.vst3> [--block F] [--seconds S] [--prio tc|mmcss] [--busy N]
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

fn main() -> Result<(), String> {
    unsafe { windows_sys::Win32::System::Ole::OleInitialize(std::ptr::null()) };
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let block: usize = flag("--block").and_then(|v| v.parse().ok()).unwrap_or(64);
    let seconds: f64 = flag("--seconds").and_then(|v| v.parse().ok()).unwrap_or(20.0);
    let prio = flag("--prio").unwrap_or_else(|| "tc".into());
    let stop = Arc::new(AtomicBool::new(false));
    let busy: Vec<_> = (0..flag("--busy").and_then(|v| v.parse().ok()).unwrap_or(0usize))
        .map(|_| {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut x = 1u64;
                while !stop.load(Ordering::Relaxed) {
                    x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
                    std::hint::black_box(x);
                }
            })
        })
        .collect();
    let mut plugin = tabstudio_fx_host::vst3host::Plugin::load(std::path::Path::new(&args[1]), 48000.0, 512)?;
    println!("{} latency {}", plugin.name, plugin.latency);
    if prio == "tc" {
        use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL};
        unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL) };
    } else {
        #[link(name = "avrt")]
        extern "system" {
            fn AvSetMmThreadCharacteristicsW(task: *const u16, index: *mut u32) -> *mut core::ffi::c_void;
        }
        let task: Vec<u16> = "Pro Audio".encode_utf16().chain(Some(0)).collect();
        let mut index = 0u32;
        unsafe { AvSetMmThreadCharacteristicsW(task.as_ptr(), &mut index) };
    }
    let period = Duration::from_secs_f64(block as f64 / 48000.0);
    let total = (seconds / period.as_secs_f64()) as usize;
    let (mut l, mut r) = (vec![0f32; block], vec![0f32; block]);
    let mut noise = 1u32;
    let mut times = Vec::with_capacity(total);
    let started = Instant::now();
    for k in 0..total {
        let due = started + period * k as u32;
        let now = Instant::now();
        if now < due {
            if due - now > Duration::from_micros(700) {
                std::thread::sleep(due - now - Duration::from_micros(500));
            }
            while Instant::now() < due {
                std::hint::spin_loop();
            }
        }
        for i in 0..block {
            noise ^= noise << 13;
            noise ^= noise >> 17;
            noise ^= noise << 5;
            l[i] = (noise as f32 / u32::MAX as f32 - 0.5) * 0.3;
            r[i] = l[i];
        }
        let t = Instant::now();
        plugin.process(&mut l, &mut r);
        if k > 400 {
            times.push(t.elapsed().as_secs_f64() * 1e6);
        }
    }
    stop.store(true, Ordering::Relaxed);
    for b in busy {
        let _ = b.join();
    }
    let budget = period.as_secs_f64() * 1e6;
    let over = |f: f64| times.iter().filter(|t| **t > budget * f).count();
    let (o25, o50, o100) = (over(0.25), over(0.5), over(1.0));
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| times[((times.len() - 1) as f64 * p) as usize];
    println!(
        "block {block} prio {prio}: n {} p50 {:.0} p99 {:.0} p99.9 {:.0} max {:.0} us | over 25% {o25}, 50% {o50}, 100% {o100} of budget {budget:.0} us",
        times.len(),
        pct(0.5),
        pct(0.99),
        pct(0.999),
        times.last().copied().unwrap_or(0.0)
    );
    Ok(())
}
