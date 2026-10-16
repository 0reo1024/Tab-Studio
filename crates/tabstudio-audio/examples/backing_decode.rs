//! Decodes backing files as the app does and reports what matters for practice: decode time,
//! length, loudness and the leveling trim, where the music starts (gapless trimming), and the
//! stretcher's cost per block at practice speeds.
//! Usage: cargo run --release --example backing_decode -- <file>... [--rate 48000]
use std::sync::Arc;
use std::time::Instant;

use tabstudio_audio::backing::{Backing, BackingMix, decode_file};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let rate = match args.iter().position(|a| a == "--rate") {
        Some(i) => {
            let r = args[i + 1].parse().expect("rate");
            args.drain(i..i + 2);
            r
        }
        None => 48000,
    };
    for path in &args {
        let started = Instant::now();
        let audio = match decode_file(std::path::Path::new(path), rate) {
            Ok(a) => Arc::new(a),
            Err(e) => {
                println!("{path}: {e}");
                continue;
            }
        };
        let decode_ms = started.elapsed().as_secs_f64() * 1000.0;
        let first = audio.samples.iter().position(|v| v.unsigned_abs() > 300).map_or(0, |i| i / 2);
        println!(
            "{path}\n  {:.1} s, {} {} Hz {} ch -> {rate} Hz, decoded in {decode_ms:.0} ms ({:.0}x realtime), {:.0} MB in memory",
            audio.seconds(),
            audio.codec,
            audio.source_rate,
            audio.source_channels,
            audio.seconds() * 1000.0 / decode_ms,
            audio.samples.len() as f64 * 2.0 / 1e6
        );
        println!("  loudness {:?} LUFS, trim {:+.1} dB, first sound at {:.1} ms", audio.lufs.map(|l| (l * 10.0).round() / 10.0), audio.trim_db(), first as f64 * 1000.0 / rate as f64);
        // Real-time cost: 512-frame blocks for 20 s from the middle of the file.
        for speed in [1.0, 0.75, 0.5] {
            let mut backing = Backing::new(audio.clone(), BackingMix::default());
            let (mut l, mut r) = (vec![0f32; 512], vec![0f32; 512]);
            let mut position = audio.seconds() / 3.0;
            let blocks = 20 * rate as usize / 512;
            let mut worst = 0f64;
            let started = Instant::now();
            for _ in 0..blocks {
                let t = Instant::now();
                backing.render(&mut l, &mut r, Some(position), speed);
                worst = worst.max(t.elapsed().as_secs_f64() * 1e6);
                position += 512.0 * speed / rate as f64;
            }
            let mean = started.elapsed().as_secs_f64() * 1e6 / blocks as f64;
            println!("  speed {speed}: {mean:.0} us mean, {worst:.0} us worst per 512-frame block (budget {:.0} us)", 512.0 * 1e6 / rate as f64);
        }
    }
}
