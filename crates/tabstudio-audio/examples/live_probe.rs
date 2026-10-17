//! Live-input investigation (instrument recording and plugin monitoring, phase 1). Measures
//! what the devices and the effect host allow before anything is built on them.
//!
//! cargo run --release --example live_probe -- devices
//!   Every host/device with its default and supported configs and buffer ranges.
//! cargo run --release --example live_probe -- duplex [--in NAME] [--out NAME] [--seconds S] [--buffer F] [--monitor]
//!   Input -> ring -> output, as the monitor will run. Reports callback sizes, the driver's own
//!   capture/playback timestamps, how long audio waits in the ring, under/overruns and clock
//!   drift. Output is silent unless --monitor (feedback risk with speakers).
//! cargo run --release --example live_probe -- loopback [--in NAME] [--out NAME] [--seconds S] [--buffer F]
//!   Plays a click every 500 ms and finds it in the input: the real output->input round trip.
//!   Needs a cable from output to input, or VB-Audio Virtual Cable (--out "CABLE Input" --in "CABLE Output").
//! cargo run --release --example live_probe -- wasapi
//!   What WASAPI itself allows per endpoint (cpal only uses shared mode with the engine's
//!   10 ms period): shared-mode engine periods (IAudioClient3), the exclusive-mode minimum
//!   period and which formats exclusive mode accepts.
//! cargo run --release --features asio --example live_probe -- engine [--asio] [--out NAME] [--in NAME] [--buffer F] [--channel N] [--seconds S] [--monitor] [--switch]
//!   The real path: the engine on the chosen device with the instrument input, monitor and
//!   recorder (into a temp folder). Reports driver latencies, callback load, input
//!   drops/trims and what the recorder kept. --switch reopens the device halfway (the engine
//!   core moves to the new streams) and checks nothing is lost. Long runs = soak test.
//!   --ping N: with a cable from an output back to the instrument input, sends N clicks (the
//!   app's 遅延を実測 measurement, monitor muted so nothing rings) and prints each round trip
//!   as the engine sees it (click written -> heard at the input).
//! cargo run --release --example live_probe -- fxlink <tabstudio-fx-host.exe> <plugin.vst3> [--block F] [--seconds S] [--editor] [--mmcss]
//!   Feeds an effect in tabstudio-fx-host through the shared-memory link at real-time pace and
//!   measures the host's turnaround (block written -> block processed), which bounds how small
//!   the link's fixed delay (fxlink::LATENCY) could be for live monitoring.
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("devices") => devices(),
        Some("duplex") => duplex(&Options::parse(&args[2..]), false),
        #[cfg(windows)]
        Some("wasapi") => wasapi::report(),
        Some("engine") => engine(&Options::parse(&args[2..])),
        Some("loopback") => duplex(&Options::parse(&args[2..]), true),
        Some("fxlink") if args.len() >= 4 => fxlink(&args[2], &args[3], &Options::parse(&args[4..])),
        _ => {
            eprintln!("usage: live_probe devices | duplex [...] | loopback [...] | fxlink <fx-host.exe> <plugin.vst3> [...]");
            Ok(())
        }
    }
}

#[derive(Default)]
struct Options {
    input: Option<String>,
    output: Option<String>,
    seconds: f64,
    buffer: Option<u32>,
    block: usize,
    monitor: bool,
    editor: bool,
    asio: bool,
    switch: bool,
    channel: u32,
    mmcss: bool,
    ping: usize,
    threshold: Option<f32>,
    tone: Option<f32>,
}

impl Options {
    fn parse(args: &[String]) -> Options {
        let mut o = Options { seconds: 10.0, block: 128, ..Default::default() };
        let mut i = 0;
        while i < args.len() {
            let value = args.get(i + 1).cloned().unwrap_or_default();
            match args[i].as_str() {
                "--in" => { o.input = Some(value); i += 1; }
                "--out" => { o.output = Some(value); i += 1; }
                "--seconds" => { o.seconds = value.parse().unwrap_or(10.0); i += 1; }
                "--buffer" => { o.buffer = value.parse().ok(); i += 1; }
                "--block" => { o.block = value.parse().unwrap_or(128); i += 1; }
                "--monitor" => o.monitor = true,
                "--asio" => o.asio = true,
                "--switch" => o.switch = true,
                "--channel" => { o.channel = value.parse().unwrap_or(0); i += 1; }
                "--editor" => o.editor = true,
                "--mmcss" => o.mmcss = true,
                "--ping" => { o.ping = value.parse().unwrap_or(5); i += 1; }
                "--threshold" => { o.threshold = value.parse().ok(); i += 1; }
                "--tone" => { o.tone = value.parse().ok(); i += 1; }
                other => eprintln!("ignored option {other}"),
            }
            i += 1;
        }
        o
    }
}

fn name(device: &cpal::Device) -> String {
    device.description().map(|d| d.to_string()).unwrap_or_else(|_| "?".into())
}

fn devices() -> Result<()> {
    for d in tabstudio_audio::device::list() {
        println!("engine list: {:?} {} buffers {:?} (range {}..{})", d.backend, d.name, d.buffer_sizes, d.buffer_min, d.buffer_max);
    }
    println!("hosts available: {:?}", cpal::available_hosts());
    for id in cpal::available_hosts() {
        let host = cpal::host_from_id(id)?;
        let default_in = host.default_input_device().map(|d| name(&d));
        let default_out = host.default_output_device().map(|d| name(&d));
        println!("== host {id:?} (default in: {default_in:?}, default out: {default_out:?})");
        for device in host.devices()? {
            println!("-- {}", name(&device));
            if let Ok(c) = device.default_input_config() {
                println!("   input default: {} ch {} Hz {:?} buffer {:?}", c.channels(), c.sample_rate(), c.sample_format(), c.buffer_size());
            }
            if let Ok(configs) = device.supported_input_configs() {
                for c in configs {
                    println!("   input supports: {} ch {}-{} Hz {:?} buffer {:?}", c.channels(), c.min_sample_rate(), c.max_sample_rate(), c.sample_format(), c.buffer_size());
                }
            }
            if let Ok(c) = device.default_output_config() {
                println!("   output default: {} ch {} Hz {:?} buffer {:?}", c.channels(), c.sample_rate(), c.sample_format(), c.buffer_size());
            }
        }
    }
    Ok(())
}

fn find(host: &cpal::Host, wanted: &Option<String>, input: bool) -> Result<cpal::Device> {
    let device = match wanted {
        None if input => host.default_input_device(),
        None => host.default_output_device(),
        Some(w) => {
            let w = w.to_lowercase();
            let mut list = if input { host.input_devices()?.collect::<Vec<_>>() } else { host.output_devices()?.collect() };
            list.retain(|d| name(d).to_lowercase().contains(&w));
            list.into_iter().next()
        }
    };
    device.ok_or_else(|| format!("{} device {:?} not found", if input { "input" } else { "output" }, wanted).into())
}

/// Running min/mean/max plus kept samples for percentiles.
#[derive(Default, Clone)]
struct Series(Vec<f64>);

impl Series {
    fn push(&mut self, v: f64) {
        self.0.push(v);
    }
    fn summary(&self, unit: &str) -> String {
        if self.0.is_empty() {
            return "no samples".into();
        }
        let mut v = self.0.clone();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
        format!("n={} min {:.2} p50 {:.2} p99 {:.2} p99.9 {:.2} max {:.2} {unit}", v.len(), v[0], p(0.5), p(0.99), p(0.999), v[v.len() - 1])
    }
}

/// What the device callbacks record (behind a mutex: read only after the streams stop;
/// the callbacks only try_lock, so they never block on it).
#[derive(Default)]
struct Record {
    in_frames: Series,
    out_frames: Series,
    /// Driver capture timestamp -> input callback (ms).
    in_latency: Series,
    /// Output callback -> driver playback timestamp (ms).
    out_latency: Series,
    /// Frames waiting in the input->output ring when the output callback runs.
    held: Series,
    /// Measured click round trips (ms), loopback mode.
    round_trips: Series,
    first_in: Option<Instant>,
    first_out: Option<Instant>,
}

fn duplex(o: &Options, loopback: bool) -> Result<()> {
    let host = cpal::default_host();
    let input = find(&host, &o.input, true)?;
    let output = find(&host, &o.output, false)?;
    let in_config = input.default_input_config()?;
    let out_config = output.default_output_config()?;
    println!("input  {} : {} ch {} Hz {:?}", name(&input), in_config.channels(), in_config.sample_rate(), in_config.sample_format());
    println!("output {} : {} ch {} Hz {:?}", name(&output), out_config.channels(), out_config.sample_rate(), out_config.sample_format());
    let rate = out_config.sample_rate() as f64;
    if in_config.sample_rate() != out_config.sample_rate() {
        println!("NOTE: input and output rates differ; the monitor would need resampling (this probe does not resample)");
    }
    let (in_ch, out_ch) = (in_config.channels() as usize, out_config.channels() as usize);
    let mut in_stream_config = in_config.config();
    let mut out_stream_config = out_config.config();
    if let Some(frames) = o.buffer {
        in_stream_config.buffer_size = cpal::BufferSize::Fixed(frames);
        out_stream_config.buffer_size = cpal::BufferSize::Fixed(frames);
    }
    let record = Arc::new(Mutex::new(Record::default()));
    let (overruns, underruns, trimmed) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let (in_total, out_total) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let (mut producer, mut consumer) = rtrb::RingBuffer::<f32>::new(1 << 16);
    // Loopback: the playback time (QPC ns) of the last click, and whether one is in flight.
    let click_at = Arc::new(AtomicU64::new(0));
    let armed = Arc::new(AtomicBool::new(false));

    let (rec, over, total, click, arm) = (record.clone(), overruns.clone(), in_total.clone(), click_at.clone(), armed.clone());
    let in_rate = in_config.sample_rate() as f64;
    let in_stream = input.build_input_stream::<f32, _, _>(
        in_stream_config,
        move |data: &[f32], info: &cpal::InputCallbackInfo| {
            let frames = data.len() / in_ch.max(1);
            let ts = info.timestamp();
            let capture_ns = ts.capture.as_nanos() as u64;
            let mut found = None;
            for f in 0..frames {
                // Loudest channel, so a mono instrument on input 2 still counts.
                let v = (0..in_ch).map(|c| data[f * in_ch + c]).fold(0f32, |a, b| if b.abs() > a.abs() { b } else { a });
                if !loopback && producer.push(v).is_err() {
                    over.fetch_add(1, Ordering::Relaxed);
                }
                if loopback && found.is_none() && arm.load(Ordering::Acquire) && v.abs() > 0.25 {
                    found = Some(f);
                }
            }
            total.fetch_add(frames as u64, Ordering::Relaxed);
            if let Ok(mut r) = rec.try_lock() {
                r.first_in.get_or_insert_with(Instant::now);
                r.in_frames.push(frames as f64);
                r.in_latency.push(ts.callback.saturating_duration_since(ts.capture).as_secs_f64() * 1e3);
                if let Some(f) = found {
                    let heard = capture_ns + (f as f64 / in_rate * 1e9) as u64;
                    let sent = click.load(Ordering::Acquire);
                    if heard > sent {
                        r.round_trips.push((heard - sent) as f64 / 1e6);
                    }
                    arm.store(false, Ordering::Release);
                }
            }
        },
        |e| eprintln!("input error: {e}"),
        None,
    )?;

    let (rec, under, trim, total, click, arm) = (record.clone(), underruns.clone(), trimmed.clone(), out_total.clone(), click_at.clone(), armed.clone());
    let monitor = o.monitor;
    let mut since_click = 0usize;
    let interval = (rate * 0.5) as usize;
    let out_stream = output.build_output_stream::<f32, _, _>(
        out_stream_config,
        move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
            let frames = data.len() / out_ch.max(1);
            let ts = info.timestamp();
            let playback_ns = ts.playback.as_nanos() as u64;
            let mut held = 0;
            let mut click_frame = None;
            if loopback {
                data.fill(0.0);
                if since_click >= interval && !arm.load(Ordering::Acquire) {
                    since_click = 0;
                    click_frame = Some(0);
                    for c in 0..out_ch {
                        data[c] = 0.9;
                        if out_ch > 0 && frames > 1 {
                            data[out_ch + c] = 0.9;
                        }
                    }
                }
                since_click += frames;
            } else {
                held = consumer.slots();
                // Keep at most two output blocks waiting: older audio is dropped so the
                // monitor delay cannot creep up (clock drift between devices).
                let keep = frames * 2;
                if held > keep {
                    let drop = held - keep;
                    if let Ok(chunk) = consumer.read_chunk(drop) {
                        chunk.commit_all();
                    }
                    trim.fetch_add(drop as u64, Ordering::Relaxed);
                }
                for f in 0..frames {
                    let v = match consumer.pop() {
                        Ok(v) => v,
                        Err(_) => {
                            under.fetch_add(1, Ordering::Relaxed);
                            0.0
                        }
                    };
                    for c in 0..out_ch {
                        data[f * out_ch + c] = if monitor { v } else { 0.0 };
                    }
                }
            }
            total.fetch_add(frames as u64, Ordering::Relaxed);
            if let Ok(mut r) = rec.try_lock() {
                r.first_out.get_or_insert_with(Instant::now);
                r.out_frames.push(frames as f64);
                r.out_latency.push(ts.playback.saturating_duration_since(ts.callback).as_secs_f64() * 1e3);
                r.held.push(held as f64);
            }
            if let Some(f) = click_frame {
                click.store(playback_ns + (f as f64 / rate * 1e9) as u64, Ordering::Release);
                arm.store(true, Ordering::Release);
            }
        },
        |e| eprintln!("output error: {e}"),
        None,
    )?;
    in_stream.play()?;
    out_stream.play()?;
    let started = Instant::now();
    std::thread::sleep(Duration::from_secs_f64(o.seconds));
    let elapsed = started.elapsed().as_secs_f64();
    drop(in_stream);
    drop(out_stream);

    let r = record.lock().unwrap();
    let ms = |frames: f64| frames / rate * 1e3;
    println!("input callback frames:  {}", r.in_frames.summary("frames"));
    println!("output callback frames: {}", r.out_frames.summary("frames"));
    println!("input  capture->callback:  {}", r.in_latency.summary("ms"));
    println!("output callback->playback: {}", r.out_latency.summary("ms"));
    let in_rate_seen = in_total.load(Ordering::Relaxed) as f64 / elapsed;
    let out_rate_seen = out_total.load(Ordering::Relaxed) as f64 / elapsed;
    println!("frames/s seen: input {in_rate_seen:.1}, output {out_rate_seen:.1} (wall clock, {elapsed:.1} s)");
    if loopback {
        println!("LOOPBACK round trip (output click -> heard at input): {}", r.round_trips.summary("ms"));
        println!("(the monitor adds the ring hold below on top of this; run duplex for it)");
    } else {
        let held: Vec<f64> = r.held.0.iter().map(|f| ms(*f)).collect();
        println!("ring hold at output callback: {}", Series(held).summary("ms"));
        println!("overruns {} underrun frames {} trimmed frames {}", overruns.load(Ordering::Relaxed), underruns.load(Ordering::Relaxed), trimmed.load(Ordering::Relaxed));
        let median = |s: &Series| { let mut v = s.0.clone(); v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v.get(v.len() / 2).copied().unwrap_or(0.0) };
        let estimate = median(&r.in_latency) + ms(median(&r.held)) + median(&r.out_latency);
        println!("ESTIMATE (driver timestamps, excludes converter/USB/driver-internal delay): {estimate:.1} ms input->output");
    }
    Ok(())
}

fn engine(o: &Options) -> Result<()> {
    use tabstudio_audio::device::{self, Backend, CoreSource, DeviceSpec};
    use tabstudio_audio::engine::Command;
    use tabstudio_audio::live::{LiveMix, LiveStatus, live_parts};
    use tabstudio_audio::recorder::{Recorder, RecorderConfig};
    let spec = DeviceSpec { backend: if o.asio { Backend::Asio } else { Backend::Wasapi }, output: o.output.clone(), input: Some(o.input.clone().filter(|_| !o.asio)), buffer: o.buffer };
    let status = LiveStatus::new();
    status.channel.store(o.channel, Ordering::Relaxed);
    status.recording.store(true, Ordering::Relaxed);
    let keep = o.buffer.unwrap_or(480) as usize * 2;
    let parts = live_parts(status.clone(), keep, tabstudio_audio::engine::MAX_BLOCK);
    let (opened, core_back) = device::open(&spec, CoreSource::New, Some(parts.tap));
    let (streams, info, control) = opened?;
    let mut control = control.unwrap();
    println!("{:?} out \"{}\" in {:?} ({} ch) {} Hz buffer {} frames", info.backend, info.output_name, info.input_name, info.input_channels, info.sample_rate, info.buffer);
    let dir = std::env::temp_dir().join(format!("tabstudio-live-probe-{}", std::process::id()));
    let mut recorder = Recorder::new(RecorderConfig { dir: dir.clone(), takes: dir.join("takes"), rate: info.sample_rate, history_seconds: 300, segment_seconds: 300, disk_cap: 2 << 30 });
    recorder.attach(parts.dry, parts.wet, Box::new(|| None));
    let send = |control: &mut tabstudio_audio::engine::Control, c: Command| { let mut c = Some(c); while let Some(cmd) = c.take() { if let Err(back) = control.send(cmd) { c = Some(back); std::thread::sleep(Duration::from_millis(1)); } } };
    send(&mut control, Command::Master(if o.monitor || o.ping > 0 { 1.0 } else { 0.0 }));
    send(&mut control, Command::Live(Some(parts.stage)));
    // Pinging: the monitor stays off so the input never feeds back into the output.
    send(&mut control, Command::LiveMix(LiveMix { monitor: o.monitor && o.ping == 0, ..LiveMix::default() }));
    if let Some(amp) = o.tone {
        // A 1 kHz tone for 0.3 s at `amp` (monitor off): is the output reaching the input at all?
        send(&mut control, Command::Master(1.0));
        std::thread::sleep(Duration::from_millis(500));
        let _ = status.take_input_peak();
        let rate = info.sample_rate as f64;
        let tone: Vec<f32> = (0..(rate * 0.3) as usize).map(|i| amp * (std::f64::consts::TAU * 1000.0 * i as f64 / rate).sin() as f32).collect();
        send(&mut control, Command::Preview(tabstudio_audio::engine::Preview::new(tone.clone(), tone, 0)));
        std::thread::sleep(Duration::from_millis(500));
        let peak = status.take_input_peak();
        println!("tone {amp}: input channel {} peak {:.4} ({:.1} dBFS)", o.channel, peak, 20.0 * peak.max(1e-9).log10());
    }
    if o.ping > 0 {
        if let Some(t) = o.threshold {
            status.ping_threshold.store(t.to_bits(), Ordering::Relaxed);
        }
        std::thread::sleep(Duration::from_millis(1000));
        let rate = info.sample_rate as f64;
        let mut found = Vec::new();
        for k in 0..o.ping {
            status.ping_result.store(tabstudio_audio::live::PING_NONE, Ordering::Release);
            status.ping_request.store(true, Ordering::Release);
            let mut result = tabstudio_audio::live::PING_NONE;
            for _ in 0..150 {
                std::thread::sleep(Duration::from_millis(20));
                result = status.ping_result.load(Ordering::Acquire);
                if result != tabstudio_audio::live::PING_NONE {
                    break;
                }
            }
            let peak = status.take_input_peak();
            if result > 0 {
                println!("ping {k}: {result} frames = {:.2} ms (input peak {:.2})", result as f64 / rate * 1e3, peak);
                found.push(result);
            } else {
                println!("ping {k}: not heard (input peak {peak:.3}; the click must come back above 0.2)");
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        found.sort();
        if let (Some(lo), Some(hi)) = (found.first(), found.last()) {
            println!("round trip at buffer {}: {lo}..{hi} frames = {:.2}..{:.2} ms over {} clicks", info.buffer, *lo as f64 / rate * 1e3, *hi as f64 / rate * 1e3, found.len());
        }
    }
    let started = Instant::now();
    let half = Duration::from_secs_f64(o.seconds / 2.0);
    let mut streams = Some(streams);
    let mut stats = info.stats.clone();
    let mut peak = 0f32;
    let mut switched = None;
    while started.elapsed() < Duration::from_secs_f64(o.seconds) {
        std::thread::sleep(Duration::from_millis(250));
        peak = peak.max(status.take_input_peak());
        if o.switch && switched.is_none() && started.elapsed() > half {
            // Close the streams: the core comes back and moves to freshly opened ones.
            let before = status.captured.load(Ordering::Relaxed);
            let t = Instant::now();
            drop(streams.take());
            let core = core_back.core.recv_timeout(Duration::from_secs(5))?;
            let parts2 = live_parts(status.clone(), keep, tabstudio_audio::engine::MAX_BLOCK);
            let (opened, back2) = device::open(&spec, CoreSource::Existing(core), Some(parts2.tap));
            let (s2, info2, _) = opened?;
            streams = Some(s2);
            stats = info2.stats.clone();
            recorder.attach(parts2.dry, parts2.wet, Box::new(|| None));
            send(&mut control, Command::Live(Some(parts2.stage)));
            switched = Some((t.elapsed(), before, back2));
        }
    }
    let elapsed = started.elapsed().as_secs_f64();
    let s = &stats;
    let r = |a: &std::sync::atomic::AtomicU64| a.load(Ordering::Relaxed);
    println!("ran {elapsed:.1} s; input peak {:.3} ({:.1} dBFS)", peak, 20.0 * peak.max(1e-9).log10());
    println!("driver latency: input {:.2} ms, output {:.2} ms", r(&s.input_latency_us) as f64 / 1e3, r(&s.output_latency_us) as f64 / 1e3);
    println!("callbacks {} (last {} frames), overloads {}, max {} us, mean {} us, driver xruns {}, music short {}", r(&s.callbacks), r(&s.last_frames), r(&s.overloads), r(&s.max_micros), r(&s.total_micros) / r(&s.callbacks).max(1), r(&s.xruns), control.status.music_short());
    println!("input: captured {} frames ({:.1} s), block {}, overflows {}, trimmed {}, underruns {}, recorder overflows {}, held {}",
        r(&status.captured), r(&status.captured) as f64 / 48000.0, r(&status.input_block), r(&status.overflows), r(&status.trimmed), r(&status.underruns), r(&status.record_overflows), r(&status.held));
    if let Some((took, before, _)) = &switched {
        println!("device switch took {:.0} ms (captured before switch {before})", took.as_secs_f64() * 1e3);
    }
    std::thread::sleep(Duration::from_millis(100));
    let (oldest, end) = recorder.range();
    println!("recorder kept frames {oldest}..{end} ({:.1} s), error {:?}", (end - oldest) as f64 / 48000.0, recorder.last_error());
    drop(control);
    drop(streams);
    recorder.detach();
    let segs: Vec<_> = std::fs::read_dir(dir.join("segments")).map(|d| d.filter_map(|e| e.ok()).map(|e| (e.file_name().to_string_lossy().into_owned(), e.metadata().map(|m| m.len()).unwrap_or(0))).collect()).unwrap_or_default();
    println!("segment files: {segs:?}");
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// Raises the calling thread to the MMCSS "Pro Audio" class, as audio threads in DAWs run.
#[cfg(windows)]
fn pro_audio_thread() -> bool {
    #[link(name = "avrt")]
    extern "system" {
        fn AvSetMmThreadCharacteristicsW(task: *const u16, index: *mut u32) -> *mut core::ffi::c_void;
    }
    let task: Vec<u16> = "Pro Audio".encode_utf16().chain(Some(0)).collect();
    let mut index = 0u32;
    unsafe { !AvSetMmThreadCharacteristicsW(task.as_ptr(), &mut index).is_null() }
}

#[cfg(not(windows))]
fn pro_audio_thread() -> bool {
    false
}

fn fxlink(host_exe: &str, plugin: &str, o: &Options) -> Result<()> {
    let rate = 48000.0;
    let link = format!("probe-{}", std::process::id());
    let shared = Arc::new(tabstudio_fxlink::Shared::create(&link, rate)?);
    let mut child = std::process::Command::new(host_exe)
        .arg(plugin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<serde_like::Reply>();
    let stdout = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            if let Some(body) = line.strip_prefix("TABSTUDIO:") {
                let _ = tx.send(serde_like::Reply(body.to_string()));
            }
        }
    });
    let wait = |id: &str| -> Result<String> {
        loop {
            let reply = rx.recv_timeout(Duration::from_secs(60))?;
            if reply.0.contains(&format!("\"id\":{id}")) {
                if reply.0.contains("\"error\"") {
                    return Err(reply.0.into());
                }
                return Ok(reply.0);
            }
        }
    };
    let loaded = Instant::now();
    println!("ready: {} ({:.1} s)", wait("0")?, loaded.elapsed().as_secs_f64());
    writeln!(stdin, "{{\"id\":1,\"cmd\":\"link\",\"name\":\"{link}\"}}")?;
    let linked = wait("1")?;
    println!("linked: {linked}");
    let plugin_latency: u64 = linked.split("\"latency\":").nth(1).and_then(|s| s.trim_end_matches('}').split(',').next()?.trim().parse().ok()).unwrap_or(0);
    if o.editor {
        writeln!(stdin, "{{\"id\":2,\"cmd\":\"editor\"}}")?;
        std::thread::sleep(Duration::from_secs(3));
        println!("editor opened (measuring with it on screen)");
    }

    let block = o.block;
    let period = Duration::from_secs_f64(block as f64 / rate);
    let mmcss = o.mmcss && pro_audio_thread();
    let h = shared.header();
    let mut engine = tabstudio_fxlink::EngineEnd::new(shared.clone());
    let (mut l, mut r) = (vec![0f32; block], vec![0f32; block]);
    let mut noise = 1u32;
    let mut turnaround = Series::default();
    // How late each block was sent against its schedule (the probe thread's own stalls).
    let mut slip = Series::default();
    // Blocks sent but not yet back: (frame the host must reach, time sent, counted).
    let mut pending: std::collections::VecDeque<(u64, Instant, bool)> = std::collections::VecDeque::new();
    let blocks = (o.seconds / period.as_secs_f64()) as usize;
    let late_before = h.late.load(Ordering::Relaxed);
    let mut late_after_warmup = 0;
    let started = Instant::now();
    let resolve = |pending: &mut std::collections::VecDeque<(u64, Instant, bool)>, turnaround: &mut Series| {
        let done = h.processed.load(Ordering::Acquire);
        while pending.front().is_some_and(|p| p.0 <= done) {
            let (_, sent, counted) = pending.pop_front().unwrap();
            if counted {
                turnaround.push(sent.elapsed().as_secs_f64() * 1e3);
            }
        }
    };
    for k in 0..blocks {
        let scheduled = started + period * k as u32;
        // Engine-side pacing: spin (yielding) to the block's time, collecting returns meanwhile.
        while Instant::now() < scheduled {
            resolve(&mut pending, &mut turnaround);
            std::thread::yield_now();
        }
        if k == 50 {
            late_after_warmup = h.late.load(Ordering::Relaxed);
        }
        for i in 0..block {
            noise ^= noise << 13; noise ^= noise >> 17; noise ^= noise << 5;
            l[i] = (noise as f32 / u32::MAX as f32 - 0.5) * 0.2;
            r[i] = l[i];
        }
        let sent = Instant::now();
        if k > 50 {
            slip.push((sent - scheduled).as_secs_f64() * 1e3);
        }
        engine.process(&mut l, &mut r, false);
        let target = h.written.load(Ordering::Acquire).saturating_sub(plugin_latency);
        pending.push_back((target, sent, k > 50));
        resolve(&mut pending, &mut turnaround);
    }
    let drain = Instant::now();
    while !pending.is_empty() && drain.elapsed() < Duration::from_secs(2) {
        resolve(&mut pending, &mut turnaround);
        std::thread::yield_now();
    }
    let lost = pending.len();
    let late = h.late.load(Ordering::Relaxed) - late_before;
    let late_warm = h.late.load(Ordering::Relaxed) - late_after_warmup;
    writeln!(stdin, "{{\"id\":9,\"cmd\":\"close\"}}").ok();
    let _ = child.wait();
    let block_ms = period.as_secs_f64() * 1e3;
    println!("block {block} frames ({block_ms:.2} ms) at {rate} Hz, plugin latency {plugin_latency} frames ({:.2} ms), engine thread MMCSS {}", plugin_latency as f64 / rate * 1e3, if mmcss { "on" } else { "off" });
    println!("turnaround (block written -> processed): {}", turnaround.summary("ms"));
    let over = |n: f64| turnaround.0.iter().filter(|t| **t > block_ms * n).count();
    println!("blocks slower than 1/2/3/4/8 block periods: {} / {} / {} / {} / {} of {} (never back: {lost})", over(1.0), over(2.0), over(3.0), over(4.0), over(8.0), turnaround.0.len());
    println!("probe send slip (own scheduling): {}", slip.summary("ms"));
    println!("frames the 2048-frame link played as silence: {late} ({late_warm} after the first 50 blocks)");
    Ok(())
}

/// Replies are matched on their raw JSON text (the probe needs only id/latency/error).
mod serde_like {
    pub struct Reply(pub String);
}

#[cfg(windows)]
mod wasapi {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
    use windows::Win32::System::Com::*;
    use windows::core::Interface;

    fn pcm(bits: u16, container: u16) -> WAVEFORMATEXTENSIBLE {
        let channels = 2u16;
        let align = channels * container / 8;
        WAVEFORMATEXTENSIBLE {
            Format: WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
                nChannels: channels,
                nSamplesPerSec: 48000,
                nAvgBytesPerSec: 48000 * align as u32,
                nBlockAlign: align,
                wBitsPerSample: container,
                cbSize: 22,
            },
            Samples: WAVEFORMATEXTENSIBLE_0 { wValidBitsPerSample: bits },
            dwChannelMask: 3,
            SubFormat: KSDATAFORMAT_SUBTYPE_PCM,
        }
    }

    pub fn report() -> super::Result<()> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let devices = enumerator.EnumAudioEndpoints(eAll, DEVICE_STATE_ACTIVE)?;
            for i in 0..devices.GetCount()? {
                let device = devices.Item(i)?;
                let name = device.OpenPropertyStore(STGM_READ)?.GetValue(&PKEY_Device_FriendlyName)?.to_string();
                let flow = if device.cast::<IMMEndpoint>()?.GetDataFlow()? == eCapture { "input " } else { "output" };
                let client: IAudioClient3 = device.Activate(CLSCTX_ALL, None)?;
                let (mut default, mut minimum) = (0i64, 0i64);
                client.GetDevicePeriod(Some(&mut default), Some(&mut minimum))?;
                let mix = client.GetMixFormat()?;
                let (mut d, mut fundamental, mut min, mut max) = (0u32, 0u32, 0u32, 0u32);
                let engine = client.GetSharedModeEnginePeriod(mix, &mut d, &mut fundamental, &mut min, &mut max);
                println!("{flow} {name}");
                let (rate, channels, bits) = ({ (*mix).nSamplesPerSec }, { (*mix).nChannels }, { (*mix).wBitsPerSample });
                println!("   mix format {rate} Hz {channels} ch {bits} bit");
                println!("   device period default {:.2} ms, exclusive minimum {:.2} ms", default as f64 / 1e4, minimum as f64 / 1e4);
                match engine {
                    Ok(()) => println!("   shared engine period (IAudioClient3) default {d} min {min} max {max} step {fundamental} frames ({:.2} ms min)", min as f64 / rate as f64 * 1e3),
                    Err(e) => println!("   shared engine period: {e}"),
                }
                let mut supported = Vec::new();
                for (label, bits, container) in [("16", 16, 16), ("24", 24, 24), ("24in32", 24, 32), ("32", 32, 32)] {
                    let format = pcm(bits, container);
                    if client.IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &format.Format, None) == windows::Win32::Foundation::S_OK {
                        supported.push(label);
                    }
                }
                let mix_ok = client.IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, mix, None) == windows::Win32::Foundation::S_OK;
                println!("   exclusive 48 kHz stereo PCM accepted: {:?}, mix format: {}", supported, mix_ok);
                CoTaskMemFree(Some(mix as *const _));
            }
        }
        Ok(())
    }
}
