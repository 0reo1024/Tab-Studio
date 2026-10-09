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
