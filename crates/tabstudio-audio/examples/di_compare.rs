//! Renders one bass phrase through two DIs, dry and through the same NAM amp, as WAV files
//! with matched loudness, for listening comparisons.
//! Usage: cargo run --release --example di_compare <notes.txt> <out dir> <nam model> <nam input dB> <nam output dB> <name=sfz>...
//! notes.txt lines: `<sample at 48 kHz> on|off <key> <velocity> <keyswitch> <lane>`.
use std::collections::BTreeMap;
use std::path::Path;
use tabstudio_audio::nam::{NamAmp, NamRuntime, NamStage, NamTone};
use tabstudio_audio::sfz::{SfizzApi, SfzInstrument, BLOCK};

const RATE: u32 = 48000;

fn rms_db(x: &[f32]) -> f64 {
    let s: f64 = x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64;
    10.0 * s.max(1e-20).log10()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (notes, out, model) = (&args[1], Path::new(&args[2]), &args[3]);
    let (input_db, output_db): (f32, f32) = (args[4].parse().unwrap(), args[5].parse().unwrap());
    let events: Vec<(usize, bool, u8, u8, u8, u8)> = std::fs::read_to_string(notes)
        .unwrap()
        .lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split_whitespace().collect();
            (p.len() == 6).then(|| (p[0].parse().unwrap(), p[1] == "on", p[2].parse().unwrap(), p[3].parse().unwrap(), p[4].parse().unwrap(), p[5].parse().unwrap()))
        })
        .collect();
    let end = events.iter().map(|e| e.0).max().unwrap_or(0) + RATE as usize * 2;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native");
    let api = SfizzApi::load(&root.join("runtime/sfizz.dll")).unwrap();
    let runtime = NamRuntime::new(Some(&std::env::temp_dir().join("tabstudio-nam-compare"))).unwrap();
    let json = std::fs::read_to_string(model).unwrap();
    std::fs::create_dir_all(out).unwrap();
    let mut first_level: Option<f64> = None;
    for spec in &args[6..] {
        let (name, file) = spec.split_once('=').unwrap();
        let mut sfz = SfzInstrument::new(api.clone(), Path::new(file), &BTreeMap::new(), RATE).unwrap();
        let (mut left, mut right) = (vec![0f32; end], vec![0f32; end]);
        let mut next = 0;
        let mut start = 0;
        while start < end {
            let frames = BLOCK.min(end - start);
            while next < events.len() && events[next].0 < start + frames {
                let (_, on, key, velocity, keyswitch, lane) = events[next];
                if on { sfz.note_on(lane, key, velocity, keyswitch) } else { sfz.note_off(lane, key, 0) }
                next += 1;
            }
            sfz.render(&mut left[start..start + frames], &mut right[start..start + frames]);
            start += frames;
        }
        // Every DI enters the amp at the first DI's level, so the amp is driven equally.
        let level = rms_db(&left);
        let reference = *first_level.get_or_insert(level);
        let trim = 10f32.powf(((reference - level) / 20.0) as f32);
        for v in left.iter_mut().chain(right.iter_mut()) {
            *v *= trim;
        }
        println!("DI  {name:8} phrase level {level:6.1} dB RMS, into the amp at {reference:6.1}");
        let dry = (left.clone(), right.clone());
        let amp = NamAmp::new(&runtime, &json, RATE as f64).unwrap();
        let mut stage = NamStage::new(amp, NamTone { input: input_db, output: output_db, bass: 0.0, mid: 0.0, treble: 0.0, cabinet: false }, RATE as f64);
        for s in (0..end).step_by(BLOCK) {
            let e = (s + BLOCK).min(end);
            stage.process(&mut left[s..e], &mut right[s..e]);
        }
        for (label, (l, r)) in [("DI", dry), ("NAM", (left, right))] {
            // Level the files for listening: -20 dB RMS each (the level difference is reported).
            let before = rms_db(&l);
            let gain = 10f32.powf(((-20.0 - before) / 20.0) as f32);
            let (l, r): (Vec<f32>, Vec<f32>) = (l.iter().map(|v| (v * gain).clamp(-1.0, 1.0)).collect(), r.iter().map(|v| (v * gain).clamp(-1.0, 1.0)).collect());
            let path = out.join(format!("{label} - {name}.wav"));
            std::fs::write(&path, tabstudio_audio::wav::stereo_16(&l, &r, RATE)).unwrap();
            println!("{label:3} {name:8} level before matching {before:6.1} dB RMS -> {}", path.display());
        }
    }
}
