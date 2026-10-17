//! The engine at a small ASIO buffer without the device: one thread wakes every `block`
//! frames (as a driver's buffer switch does), feeds the instrument input and runs
//! `Core::process`, and every callback's time is kept, so the distribution (not only the
//! mean) can be held against the budget. Runs scenario by scenario so the costly part shows.
//!
//! cargo run --release --example callback_bench -- [--block F] [--seconds S] [--tracks N]
//!     [--helpers N] [--nam model.nam] [--fx <tabstudio-fx-host.exe> <plugin.vst3>] [--busy N]
//!     [--sfz <sfizz.dll> <file.sfz>] [--send S]
//!   --helpers sets the engine pool (TABSTUDIO_AUDIO_HELPERS); --busy N runs N spinning threads
//!   at normal priority (a busy UI / WebView); --fx links one effect as the live monitor does;
//!   --sfz plays every track with the SFZ (as a guitar score does); --send feeds the reverb.
//!   TABSTUDIO_AUDIO_AHEAD=0 renders the music inline in the callback (as before 2026-10-17);
//!   BENCH_PRIO=tc runs the "driver" thread at TIME_CRITICAL instead of MMCSS Pro Audio (MMCSS
//!   threads stall ~2 ms when every core is busy: SystemResponsiveness keeps 20 % for others).
use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tabstudio_audio::engine::{self, Command, MAX_BLOCK};
use tabstudio_audio::live::{LiveMix, LiveStatus, live_parts};
use tabstudio_audio::{player, song};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str, n: usize| args.iter().position(|a| a == name).map(|i| args[i + 1..=i + n].to_vec());
    let num = |name: &str, default: f64| flag(name, 1).and_then(|v| v[0].parse().ok()).unwrap_or(default);
    let block = num("--block", 64.0) as usize;
    let seconds = num("--seconds", 15.0);
    let tracks = num("--tracks", 4.0) as u16;
    if let Some(h) = flag("--helpers", 1) {
        // Read by Pool::default_helpers when the engine is made.
        unsafe { std::env::set_var("TABSTUDIO_AUDIO_HELPERS", &h[0]) };
    }
    let rate = 48000u32;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut font_bytes = std::fs::read(root.join("public/alphatab/soundfont/sonivox.sf2"))?;
    let font = Arc::new(tabstudio_audio::synth::SoundFont::new(&mut font_bytes.as_mut_slice().as_ref())?);

    let stop = Arc::new(AtomicBool::new(false));
    let busy: Vec<_> = (0..num("--busy", 0.0) as usize)
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

    let (mut core, mut control) = engine::new_engine(rate);
    let send = |control: &mut engine::Control, c: Command| {
        let mut c = Some(c);
        while let Some(cmd) = c.take() {
            if let Err(back) = control.send(cmd) {
                c = Some(back);
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    };
    let status = LiveStatus::new();
    let parts = live_parts(status.clone(), block * 2, MAX_BLOCK);
    let mut tap = parts.tap;
    send(&mut control, Command::Master(0.0));
    if tracks > 0 {
        let song = Arc::new(stress_song(tracks, seconds + 5.0));
        let player = player::Player::new(song.clone(), &font, Arc::new(tabstudio_audio::click::ClickBank::new(rate)), rate)?;
        send(&mut control, Command::Load(engine::Loaded::new(player)));
        // --sfz <sfizz.dll> <file.sfz>: every track plays the SFZ (as a guitar score does).
        if let Some(sfz) = flag("--sfz", 2) {
            let api = tabstudio_audio::sfz::SfizzApi::load(std::path::Path::new(&sfz[0]))?;
            let file = std::path::PathBuf::from(&sfz[1]);
            let standard = tabstudio_audio::sfz::is_string_guitar(&file);
            for t in 0..tracks {
                let mut needed = std::collections::BTreeMap::new();
                for (lane, keys) in song.sfz_pitches(t) {
                    needed.entry(if standard { lane.clamp(1, 12) } else { 0 }).or_insert_with(std::collections::BTreeSet::new).extend(keys);
                }
                let instrument = tabstudio_audio::sfz::SfzInstrument::new(api.clone(), &file, &needed, rate)?;
                send(&mut control, Command::TrackSampler(t as usize, Some(Box::new(instrument))));
            }
        }
        // --send S: every track feeds the reverb (the mixer's default send is 0).
        let reverb_send = num("--send", 0.0) as f32;
        for t in 0..tracks as usize {
            send(&mut control, Command::Track(t, engine::TrackMix { gain: 0.5, send: reverb_send, ..Default::default() }));
        }
        std::thread::sleep(Duration::from_millis(500));
        control.collect_garbage();
        send(&mut control, Command::Play);
    }
    send(&mut control, Command::Live(Some(parts.stage)));
    send(&mut control, Command::LiveMix(LiveMix::default()));
    if let Some(nam) = flag("--nam", 1) {
        let runtime = tabstudio_audio::nam::NamRuntime::new(None)?;
        let amp = tabstudio_audio::nam::NamAmp::new(&runtime, &std::fs::read_to_string(&nam[0])?, rate as f64)?;
        let stage = tabstudio_audio::nam::NamStage::new(amp, tabstudio_audio::nam::NamTone { cabinet: true, ..Default::default() }, rate as f64);
        send(&mut control, Command::LiveNam(Some(Box::new(stage))));
    }
    // The live link as live_input.rs makes it: delay of 2 blocks (3 below 128 frames).
    let mut host = None;
    let mut links = Vec::new();
    if let Some(fx) = flag("--fx", 2) {
        let blocks = flag("--link-blocks", 1).and_then(|v| v[0].parse().ok()).unwrap_or(if block < 128 { 3 } else { 2 });
        let delay = (block * blocks).max(1);
        let name = format!("bench-{}", std::process::id());
        let shared = Arc::new(tabstudio_fxlink::Shared::create_with_latency(&name, rate as f64, delay)?);
        let mut child = std::process::Command::new(&fx[0]).arg(&fx[1]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut wait = |id: &str| -> Result<String> {
            for line in lines.by_ref() {
                let line = line?;
                if let Some(body) = line.strip_prefix("TABSTUDIO:") {
                    if body.contains(&format!("\"id\":{id}")) {
                        return if body.contains("\"error\"") { Err(body.to_string().into()) } else { Ok(body.to_string()) };
                    }
                }
            }
            Err("host closed".into())
        };
        println!("fx ready: {}", wait("0")?);
        writeln!(stdin, "{{\"id\":1,\"cmd\":\"link\",\"name\":\"{name}\"}}")?;
        println!("fx linked: {} (delay {delay} frames)", wait("1")?);
        let chain = tabstudio_audio::fx::FxChain::build(vec![tabstudio_audio::fx::ChainItem::External(shared.clone(), true)], rate as f64);
        send(&mut control, Command::LiveFx(Some(Box::new(chain))));
        links.push(shared);
        host = Some((child, stdin));
    }

    // The "driver" thread: MMCSS Pro Audio, as ASIO drivers run their buffer switch.
    let period = Duration::from_secs_f64(block as f64 / rate as f64);
    let total = (seconds / period.as_secs_f64()) as usize;
    let warmup = (0.5 / period.as_secs_f64()) as usize;
    let status_music = control.status.clone();
    let thread = std::thread::spawn(move || {
        pro_audio_thread();
        let mut out = vec![0f32; block * 2];
        let mut input = vec![0f32; block * 2];
        let mut noise = 1u32;
        let mut times = Vec::with_capacity(total);
        let mut slips = 0usize;
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
            } else if now - due > period {
                slips += 1;
            }
            for v in input.iter_mut() {
                noise ^= noise << 13;
                noise ^= noise >> 17;
                noise ^= noise << 5;
                *v = (noise as f32 / u32::MAX as f32 - 0.5) * 0.3;
            }
            let t = Instant::now();
            tap.push(&input, 2);
            core.process(&mut out, 2);
            if k >= warmup {
                times.push(t.elapsed().as_secs_f64() * 1e6);
            }
        }
        (times, slips, status_music.music_short())
    });
    let (mut times, slips, short) = thread.join().map_err(|_| "bench thread panicked")?;
    stop.store(true, Ordering::Relaxed);
    for b in busy {
        let _ = b.join();
    }
    let budget = period.as_secs_f64() * 1e6;
    let over = times.iter().filter(|t| **t > budget).count();
    let over_half = times.iter().filter(|t| **t > budget * 0.5).count();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| times[((times.len() - 1) as f64 * p) as usize];
    let late: u64 = links.iter().map(|l| l.header().late.load(Ordering::Relaxed)).sum();
    println!(
        "block {block} (budget {budget:.0} us) tracks {tracks} helpers {:?}: callbacks {} | p50 {:.0} p99 {:.0} p99.9 {:.0} max {:.0} us | over budget {over} ({:.3}%), over half {over_half} | fx late frames {late} (link now {} frames), driver slips {slips}, music short frames {short}, monitor underruns {}",
        std::env::var("TABSTUDIO_AUDIO_HELPERS").ok(),
        times.len(),
        pct(0.5),
        pct(0.99),
        pct(0.999),
        times.last().copied().unwrap_or(0.0),
        over as f64 * 100.0 / times.len().max(1) as f64,
        links.iter().map(|l| l.delay()).max().unwrap_or(0),
        status.underruns.load(Ordering::Relaxed),
    );
    if let Some((mut child, stdin)) = host {
        drop(stdin);
        let _ = child.wait();
    }
    Ok(())
}

/// Dense test material: `tracks` tracks of 16th-note triads on different GM programs
/// (as the tabstudio-audio binary's stress song).
fn stress_song(tracks: u16, seconds: f64) -> song::Song {
    use song::*;
    let mut events = vec![Event { tick: 0, kind: KIND_TEMPO, channel: 0, data1: 0, data2: 0, value: 120_000, track: 0, articulation: 0, time: 0.0 }];
    let programs = [0u8, 24, 27, 30, 33, 48, 56, 73];
    let sixteenths = (seconds * 8.0) as u32;
    for t in 0..tracks {
        let channel = (t % 9) as u8;
        let ev = |tick, kind, d1, d2| Event { tick, kind, channel, data1: d1, data2: d2, value: 0, track: t, articulation: 0, time: 0.0 };
        events.push(ev(0, KIND_PROGRAM, programs[t as usize % 8], 0));
        for n in 0..sixteenths {
            for offset in [0u8, 4, 7] {
                let key = 48 + (t as u8 * 3 + (n % 12) as u8 + offset) % 36;
                events.push(ev(n * 240, KIND_NOTE_ON, key, 90));
                events.push(ev(n * 240 + 230, KIND_NOTE_OFF, key, 0));
            }
        }
    }
    events.push(Event { tick: sixteenths * 240, kind: KIND_END, channel: 0, data1: 0, data2: 0, value: 0, track: 0, articulation: 0, time: 0.0 });
    Song::from_events(960, events)
}

fn pro_audio_thread() {
    #[cfg(windows)]
    {
        #[link(name = "avrt")]
        extern "system" {
            fn AvSetMmThreadCharacteristicsW(task: *const u16, index: *mut u32) -> *mut core::ffi::c_void;
        }
        let task: Vec<u16> = "Pro Audio".encode_utf16().chain(Some(0)).collect();
        let mut index = 0u32;
        if std::env::var("BENCH_PRIO").is_ok_and(|v| v == "tc") {
            use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL};
            unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL) };
            return;
        }
        let ok = unsafe { !AvSetMmThreadCharacteristicsW(task.as_ptr(), &mut index).is_null() };
        if !ok {
            eprintln!("MMCSS Pro Audio failed");
        }
    }
}
