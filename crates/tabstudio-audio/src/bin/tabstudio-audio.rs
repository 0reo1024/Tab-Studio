//! CLI harness: `convert <in.sf3> <out.sf2>`, `render <soundfont> <in.mid> <out.wav>`,
//! `events <soundfont> <in.tsev> <out.wav>` (the engine's own player, stems summed).
use std::sync::Arc;
use tabstudio_audio::{engine, output, player, song, sf3, wav};

fn load_font(path: &str) -> Result<Arc<tabstudio_audio::synth::SoundFont>, Box<dyn std::error::Error>> {
    let mut data = std::fs::read(path)?;
    if sf3::is_sf3(&data) {
        data = sf3::to_sf2(&data)?;
    }
    Ok(Arc::new(tabstudio_audio::synth::SoundFont::new(&mut data.as_slice())?))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("convert") => {
            let data = std::fs::read(&args[2])?;
            let started = std::time::Instant::now();
            let out = sf3::to_sf2(&data)?;
            std::fs::write(&args[3], &out)?;
            println!("converted {} -> {} bytes in {:?}", data.len(), out.len(), started.elapsed());
        }
        Some("render") => {
            let mut data = std::fs::read(&args[2])?;
            if sf3::is_sf3(&data) {
                data = sf3::to_sf2(&data)?;
            }
            let font = Arc::new(tabstudio_audio::synth::SoundFont::new(&mut data.as_slice())?);
            let midi = Arc::new(tabstudio_audio::synth::MidiFile::new(&mut std::fs::File::open(&args[3])?)?);
            let settings = tabstudio_audio::synth::SynthesizerSettings::new(44100);
            let synth = tabstudio_audio::synth::Synthesizer::new(&font, &settings)?;
            let mut sequencer = tabstudio_audio::synth::MidiFileSequencer::new(synth);
            sequencer.play(&midi, false);
            let frames = ((midi.get_length() + 2.0) * 44100.0) as usize;
            let (mut left, mut right) = (vec![0f32; frames], vec![0f32; frames]);
            let started = std::time::Instant::now();
            sequencer.render(&mut left, &mut right);
            let took = started.elapsed();
            std::fs::write(&args[4], wav::stereo_16(&left, &right, 44100))?;
            println!("rendered {:.1}s of audio in {:?} ({:.0}x real time)", frames as f64 / 44100.0, took, frames as f64 / 44100.0 / took.as_secs_f64());
        }
        Some("events") => {
            let font = load_font(&args[2])?;
            let song = Arc::new(song::Song::parse(&std::fs::read(&args[3])?).map_err(|e| e.0)?);
            let rate = 44100;
            let mut player = player::Player::new(song.clone(), &font, Arc::new(tabstudio_audio::click::ClickBank::new(rate)), rate)?;
            let block = 512;
            let mut stems: Vec<player::Stem> = (0..=player.tracks()).map(|_| player::Stem::new(block)).collect();
            let (mut left, mut right) = (Vec::new(), Vec::new());
            let tail = (2.0 * rate as f64) as usize;
            let started = std::time::Instant::now();
            player.play();
            let mut after_end = 0;
            while after_end < tail {
                player.render(&mut stems, block);
                for i in 0..block {
                    left.push(stems.iter().map(|s| s.left[i]).sum::<f32>());
                    right.push(stems.iter().map(|s| s.right[i]).sum::<f32>());
                }
                if !player.is_playing() {
                    after_end += block;
                }
            }
            let took = started.elapsed();
            std::fs::write(&args[4], wav::stereo_16(&left, &right, rate))?;
            println!("{} tracks, {:.1}s in {:?}", player.tracks(), left.len() as f64 / rate as f64, took);
        }
        Some("live") => {
            // live <soundfont> <buffer frames> <seconds> [audible]: plays a dense synthetic
            // 8-track song on the default device (muted unless "audible") and reports timing.
            let font = load_font(&args[2])?;
            let buffer: u32 = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(512);
            let seconds: f64 = args.get(4).and_then(|v| v.parse().ok()).unwrap_or(10.0);
            let audible = args.get(5).is_some_and(|v| v == "audible");
            let mut out = output::open_default(Some(buffer))?;
            println!("device {} {} Hz {} ch", out.device_name, out.sample_rate, out.channels);
            let song = Arc::new(stress_song(8, seconds));
            let player = player::Player::new(song, &font, Arc::new(tabstudio_audio::click::ClickBank::new(out.sample_rate)), out.sample_rate)?;
            let status = out.control.status.clone();
            let mut send = |c| { let mut c = Some(c); while let Some(cmd) = c.take() { if let Err(back) = out.control.send(cmd) { c = Some(back); std::thread::sleep(std::time::Duration::from_millis(1)); } } };
            send(engine::Command::Master(if audible { 0.5 } else { 0.0 }));
            send(engine::Command::Load(engine::Loaded::new(player)));
            // Worst case mixer load: every track with EQ + compressor + delay and a reverb send.
            for t in 0..8 {
                send(engine::Command::Track(t, engine::TrackMix { gain: 0.5, send: 0.3, ..Default::default() }));
                send(engine::Command::TrackFx(t, Box::new(tabstudio_audio::fx::FxChain::new(&[(tabstudio_audio::fx::FxKind::Eq, 0.7), (tabstudio_audio::fx::FxKind::Compressor, 0.5), (tabstudio_audio::fx::FxKind::Delay, 0.3)], out.sample_rate as f64))));
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
            let started = std::time::Instant::now();
            send(engine::Command::Play);
            while status.position() == 0.0 { std::thread::yield_now(); }
            let start_latency = started.elapsed();
            let mut seeks = Vec::new();
            for i in 0..5 {
                std::thread::sleep(std::time::Duration::from_secs_f64(seconds / 6.0));
                let target = (i as f64 + 0.5) * seconds / 6.0;
                let t = std::time::Instant::now();
                send(engine::Command::Seek(target));
                while (status.position() - target).abs() > 0.2 { std::thread::yield_now(); }
                seeks.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            std::thread::sleep(std::time::Duration::from_secs_f64(seconds / 6.0));
            drop(send);
            let s = &out.stats;
            println!("buffer {} frames (device gave {}), callbacks {}, overloads {}, max callback {} us (budget {} us)",
                buffer, s.last_frames.load(std::sync::atomic::Ordering::Relaxed), s.callbacks.load(std::sync::atomic::Ordering::Relaxed),
                s.overloads.load(std::sync::atomic::Ordering::Relaxed), s.max_micros.load(std::sync::atomic::Ordering::Relaxed),
                (s.last_frames.load(std::sync::atomic::Ordering::Relaxed) as f64 / out.sample_rate as f64 * 1e6) as u64);
            println!("play start {:.1} ms, seek {:?} ms", start_latency.as_secs_f64() * 1000.0, seeks.iter().map(|v| (v * 10.0).round() / 10.0).collect::<Vec<_>>());
        }
        Some("fxcompare") => fxcompare(&args[2])?,
        Some("parts") => bench_parts(),
        Some("bench") => bench(&args[2], args.get(3).and_then(|v| v.parse().ok()).unwrap_or(10.0))?,
        _ => eprintln!("usage: tabstudio-audio convert <in.sf3> <out.sf2> | render <soundfont> <in.mid> <out.wav>"),
    }
    Ok(())
}

/// Dense test material: `tracks` tracks of 16th-note triads on different GM programs.
fn stress_song(tracks: u16, seconds: f64) -> song::Song {
    use song::*;
    let mut events = vec![Event { tick: 0, kind: KIND_TEMPO, channel: 0, data1: 0, data2: 0, value: 120_000, track: 0, time: 0.0 }];
    let programs = [0u8, 24, 27, 30, 33, 48, 56, 73];
    let sixteenths = (seconds * 8.0) as u32;
    for t in 0..tracks {
        let channel = (t % 9) as u8;
        let ev = |tick, kind, d1, d2| Event { tick, kind, channel, data1: d1, data2: d2, value: 0, track: t, time: 0.0 };
        events.push(ev(0, KIND_PROGRAM, programs[t as usize % 8], 0));
        for n in 0..sixteenths {
            let tick = n * 240;
            for (i, offset) in [0u8, 4, 7].iter().enumerate() {
                let key = 48 + (t as u8 * 3 + (n % 12) as u8 + offset) % 36;
                let _ = i;
                events.push(ev(tick, KIND_NOTE_ON, key, 90));
                events.push(ev(tick + 230, KIND_NOTE_OFF, key, 0));
            }
        }
    }
    events.push(Event { tick: sixteenths * 240, kind: KIND_END, channel: 0, data1: 0, data2: 0, value: 0, track: 0, time: 0.0 });
    Song::from_events(960, events)
}

/// The S7 test input (spikes/s7-fx-reference/reference.mjs `input()`), mono.
fn s7_input(rate: usize) -> Vec<f32> {
    let mut x = vec![0f32; rate * 4];
    let tau = std::f64::consts::TAU;
    for (start, amp) in [(0usize, 0.05), (rate * 3 / 4, 0.3), (rate * 3 / 2, 0.9)] {
        for i in 0..rate / 2 {
            x[start + i] = (amp * (tau * 440.0 * i as f64 / rate as f64).sin()) as f32;
        }
    }
    x[rate * 9 / 4] = 1.0;
    let sweep = (rate as f64 * 2.5).floor() as usize;
    for i in 0..rate / 2 {
        let t = i as f64 / rate as f64;
        x[sweep + i] = (0.5 * (tau * (100.0 + 4000.0 * t) * t).sin()) as f32;
    }
    x
}

/// Renders one S7 case with the native DSP.
fn s7_render(kind: &str, amount: f32, rate: usize) -> (Vec<f32>, Vec<f32>) {
    use tabstudio_audio::compressor::Compressor;
    use tabstudio_audio::dsp::*;
    let x = s7_input(rate);
    let (mut l, mut r) = (x.clone(), x);
    let sr = rate as f64;
    match kind {
        "eq" => Biquad::new(FilterKind::Peaking, 1200.0, 1.0, ((amount - 0.5) * 24.0) as f64, sr).process_stereo(&mut l, &mut r),
        "compressor" => {
            let mut c = Compressor::new(sr, -10.0 - 30.0 * amount, 30.0, 2.0 + 6.0 * amount, 0.003, 0.25);
            for (a, b) in l.chunks_mut(128).zip(r.chunks_mut(128)) {
                c.process(a, b);
            }
        }
        "limiter" => {
            let mut c = Compressor::new(sr, -3.0, 0.0, 20.0, 0.003, 0.12);
            c.process(&mut l, &mut r);
        }
        "delay" => Delay::new(sr, amount).process(&mut l, &mut r),
        "reverb" => {
            let ir = reverb_impulse(sr);
            let scale = convolver_normalization(&ir, sr);
            let ir = [ir[0].iter().map(|v| v * scale).collect(), ir[1].iter().map(|v| v * scale).collect()];
            let mut c = Convolver::new(&ir, 128);
            c.process(&mut l, &mut r);
        }
        "nam-eq" => {
            for (k, f, g) in [(FilterKind::Lowshelf, 150.0, amount * 6.0), (FilterKind::Peaking, 800.0, -amount * 6.0), (FilterKind::Highshelf, 3500.0, amount * 6.0)] {
                Biquad::new(k, f, 1.0, g as f64, sr).process_stereo(&mut l, &mut r);
            }
            Biquad::new(FilterKind::Highpass, 70.0, 1.0, 0.0, sr).process_stereo(&mut l, &mut r);
            Biquad::new(FilterKind::Lowpass, 6500.0, 1.0, 0.0, sr).process_stereo(&mut l, &mut r);
        }
        "pan" => stereo_pan(amount * 2.0 - 1.0, &mut l, &mut r),
        _ => {}
    }
    (l, r)
}

fn fxcompare(dir: &str) -> Result<(), Box<dyn std::error::Error>> {
    let index: serde_json_lite::Index = serde_json_lite::read(&std::fs::read_to_string(std::path::Path::new(dir).join("index.json"))?);
    let rate = 48000usize;
    let segments = [("tone -26dB", 0.0, 0.5), ("tone -10dB", 0.75, 1.25), ("tone -1dB", 1.5, 2.0), ("impulse", 2.25, 2.5), ("sweep", 2.5, 3.0), ("tail", 3.0, 4.0)];
    for case in index.cases {
        let bytes = std::fs::read(std::path::Path::new(dir).join(format!("{}.f32", case.name)))?;
        let reference: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        let (l, r) = s7_render(&case.kind, case.amount, rate);
        // Best alignment (our convolver lags one 128-frame block).
        let mut best = (0isize, f64::MAX);
        for lag in [0isize, 128, 256] {
            let err: f64 = (0..rate * 4 - 300).map(|i| { let j = i as isize + lag; if j < 0 || j as usize >= l.len() { 0.0 } else { let d = l[j as usize] as f64 - reference[i * 2] as f64; d * d } }).sum();
            if err < best.1 { best = (lag, err); }
        }
        let lag = best.0;
        let mut line = format!("{:<18} lag {:>3}", case.name, lag);
        for (name, a, b) in segments {
            let (s, e) = ((a * rate as f64) as usize, (b * rate as f64) as usize);
            let rms = |f: &dyn Fn(usize) -> f32| ((s..e).map(|i| { let v = f(i) as f64; v * v }).sum::<f64>() / (e - s) as f64).sqrt();
            let want = rms(&|i| reference[i * 2]);
            let got = rms(&|i| { let j = i as isize + lag; if j >= 0 && (j as usize) < l.len() { l[j as usize] } else { 0.0 } });
            let _ = &r;
            if want > 1e-6 { line += &format!(" | {name} {:+.2}dB", 20.0 * (got / want).log10()); }
        }
        println!("{line}");
    }
    Ok(())
}

/// Tiny reader for the S7 index (avoids a JSON dependency in the engine crate).
mod serde_json_lite {
    pub struct Case { pub name: String, pub kind: String, pub amount: f32 }
    pub struct Index { pub cases: Vec<Case> }
    pub fn read(text: &str) -> Index {
        let mut cases = Vec::new();
        for part in text.split("\"name\":").skip(1) {
            let field = |key: &str| part.split(&format!("\"{key}\":")).nth(1).map(|v| v.trim_start().trim_start_matches('"').split(|c| c == '"' || c == ',' || c == '}' || c == '\n').next().unwrap_or("").trim().to_string()).unwrap_or_default();
            let name = part.trim_start().trim_start_matches('"').split('"').next().unwrap_or("").to_string();
            cases.push(Case { name, kind: field("kind"), amount: field("amount").parse().unwrap_or(0.0) });
        }
        Index { cases }
    }
}

/// Offline cost of the worst-case mixer (8 tracks with EQ + compressor + delay + reverb send).
fn bench(font_path: &str, seconds: f64) -> Result<(), Box<dyn std::error::Error>> {
    let font = load_font(font_path)?;
    let rate = 48000u32;
    let (mut core, mut control) = engine::new_engine(rate);
    let song = Arc::new(stress_song(8, seconds));
    let player = player::Player::new(song, &font, Arc::new(tabstudio_audio::click::ClickBank::new(rate)), rate)?;
    let _ = control.send(engine::Command::Load(engine::Loaded::new(player)));
    for t in 0..8 {
        let _ = control.send(engine::Command::Track(t, engine::TrackMix { gain: 0.5, send: 0.3, ..Default::default() }));
        let _ = control.send(engine::Command::TrackFx(t, Box::new(tabstudio_audio::fx::FxChain::new(&[(tabstudio_audio::fx::FxKind::Eq, 0.7), (tabstudio_audio::fx::FxKind::Compressor, 0.5), (tabstudio_audio::fx::FxKind::Delay, 0.3)], rate as f64))));
    }
    let _ = control.send(engine::Command::Play);
    let mut out = vec![0f32; 480 * 2];
    let blocks = (seconds * rate as f64 / 480.0) as usize;
    let (mut worst, started) = (std::time::Duration::ZERO, std::time::Instant::now());
    for _ in 0..blocks {
        let t = std::time::Instant::now();
        core.process(&mut out, 2);
        worst = worst.max(t.elapsed());
    }
    let total = started.elapsed();
    println!("{seconds}s of audio in {total:?} ({:.1}% of real time), worst 480-frame block {worst:?} (budget 10 ms)", total.as_secs_f64() / seconds * 100.0);
    Ok(())
}

/// Per-component cost for 10 s at 48 kHz in 480-frame blocks.
fn bench_parts() {
    use tabstudio_audio::{compressor::Compressor, dsp::*};
    let rate = 48000usize;
    let blocks = rate * 10 / 480;
    let input: Vec<f32> = (0..480).map(|i| (i as f32 * 0.05).sin() * 0.5).collect();
    let time = |name: &str, f: &mut dyn FnMut(&mut [f32], &mut [f32])| {
        let (mut l, mut r) = (input.clone(), input.clone());
        let t = std::time::Instant::now();
        for _ in 0..blocks {
            l.copy_from_slice(&input);
            r.copy_from_slice(&input);
            f(&mut l, &mut r);
        }
        println!("{name:<12} {:>8.1} ms per 10 s", t.elapsed().as_secs_f64() * 1000.0);
    };
    let mut c = Compressor::new(rate as f64, -25.0, 30.0, 5.0, 0.003, 0.25);
    time("compressor", &mut |l, r| c.process(l, r));
    let mut e = Biquad::new(FilterKind::Peaking, 1200.0, 1.0, 6.0, rate as f64);
    time("eq", &mut |l, r| e.process_stereo(l, r));
    let mut d = Delay::new(rate as f64, 0.5);
    time("delay", &mut |l, r| d.process(l, r));
    let ir = reverb_impulse(rate as f64);
    let mut conv = Convolver::new(&ir, 128);
    time("reverb128", &mut |l, r| conv.process(l, r));
    let mut conv = Convolver::new(&ir, 512);
    time("reverb512", &mut |l, r| conv.process(l, r));
}
