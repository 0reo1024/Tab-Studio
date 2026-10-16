//! Guitar DIs side by side: pitch (autocorrelation), level (RMS over 0.34 s at velocity 79) and
//! whether a bend on one string leaves another alone. Run from crates/tabstudio-audio:
//! `cargo run --release --example guitar_levels`.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use tabstudio_audio::sfz::{SfizzApi, SfzInstrument};

/// Renders in blocks paced near real time, so sfizz streams the samples past its preload.
fn take(sfz: &mut SfzInstrument, frames: usize) -> Vec<f32> {
    let (mut l, mut r) = (vec![0f32; frames], vec![0f32; frames]);
    for (cl, cr) in l.chunks_mut(1024).zip(r.chunks_mut(1024)) {
        std::thread::sleep(std::time::Duration::from_millis(8));
        sfz.render(cl, cr);
    }
    l
}

fn rms_db(x: &[f32]) -> f32 {
    let sum: f64 = x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64;
    if sum > 1e-12 { (10.0 * sum.log10()) as f32 } else { -120.0 }
}

/// The fundamental (Hz) by autocorrelation between 30 and 1500 Hz.
fn pitch(x: &[f32], rate: f32) -> f32 {
    let x = &x[x.len() / 4..];
    let lags = (rate / 1500.0) as usize..(rate / 30.0) as usize;
    let corr = |lag: usize| x.iter().zip(&x[lag..]).map(|(a, b)| a * b).sum::<f32>();
    let best = lags.clone().map(|lag| (lag, corr(lag))).fold((0, f32::MIN), |a, b| if b.1 > a.1 { b } else { a });
    // The shortest lag with nearly the best correlation (avoid octave errors).
    let first = lags.map(|lag| (lag, corr(lag))).find(|(_, c)| *c > 0.9 * best.1).map_or(best.0, |p| p.0);
    rate / first as f32
}

fn main() {
    let root = Path::new("../../native");
    let api = SfizzApi::load(&root.join("runtime/sfizz.dll")).unwrap();
    let rate = 48000u32;
    let files = [
        ("Standard", root.join("soundfonts/UI_Standard_Guitar/Programs/01-Standard Guitar KSOP.sfz")),
        ("LP Neck", root.join("soundfonts/FlameStudios_LesPaul_Neck/Tab Studio Guitar DI LP Neck.sfz")),
        ("LP Bridge", root.join("soundfonts/FlameStudios_LesPaul_Bridge/Tab Studio Guitar DI LP Bridge.sfz")),
        ("Trummer LP Neck", root.join("soundfonts/Trummer_LesPaul/Tab Studio Guitar DI Trummer LP Neck.sfz")),
        ("Trummer LP Bridge", root.join("soundfonts/Trummer_LesPaul/Tab Studio Guitar DI Trummer LP Bridge.sfz")),
    ];
    let only = std::env::args().nth(1);
    let files: Vec<_> = files.into_iter().filter(|(name, _)| only.as_deref().is_none_or(|o| name.contains(o))).collect();
    let keys: BTreeSet<u8> = (28..=100).collect();
    for (name, file) in &files {
        let pitches: BTreeMap<u8, BTreeSet<u8>> = [(1u8, keys.clone()), (2u8, keys.clone())].into_iter().collect();
        let mut sfz = SfzInstrument::new(api.clone(), file, &pitches, rate).unwrap();
        let mut levels = Vec::new();
        let mut table = Vec::new();
        for key in 40u8..=84 {
            sfz.note_on(1, key, 79, 24);
            let x = take(&mut sfz, 16384);
            sfz.note_off(1, key, 0);
            sfz.all_sound_off();
            levels.push(rms_db(&x));
            table.push(format!("{:.1}", rms_db(&x)));
        }
        let mut sorted = levels.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("{name}: median {:.1} dB (keys 40-84 v79)", sorted[sorted.len() / 2]);
        println!("  by key: {}", table.join(" "));
        let mut cells = Vec::new();
        for key in [28u8, 40, 52, 64, 76, 88, 96, 100] {
            sfz.note_on(1, key, 79, 24);
            let x = take(&mut sfz, 16384);
            sfz.note_off(1, key, 0);
            sfz.all_sound_off();
            let expect = 440.0 * 2f32.powf((key as f32 - 69.0) / 12.0);
            cells.push(format!("{key}:{:.1}/{expect:.1}Hz {:.0}dB", pitch(&x, rate as f32), rms_db(&x)));
        }
        println!("  pitch {}", cells.join("  "));
        // Velocity: soft sustains stay sustains (level after 1 s); mutes are short.
        for (label, velocity, switch) in [("v20 sus", 20u8, 24u8), ("v79 sus", 79, 24), ("v79 palm", 79, 27), ("v79 dead", 79, 23)] {
            sfz.note_on(1, 52, velocity, switch);
            let a = take(&mut sfz, 16384);
            let _ = take(&mut sfz, 32768);
            let b = take(&mut sfz, 16384);
            sfz.note_off(1, 52, 0);
            sfz.all_sound_off();
            println!("  {label}: start {:.1} dB, after 1 s {:.1} dB", rms_db(&a), rms_db(&b));
        }
        // A bend on string 1 must not move string 2's note.
        sfz.note_on(2, 52, 79, 24);
        sfz.note_on(1, 57, 79, 24);
        let _ = take(&mut sfz, 8192);
        sfz.note_bend(1, 57, 0x8000_0000u32 + (0x8000_0000u32 / 8), 0, false);
        let mut both = take(&mut sfz, 16384);
        sfz.all_sound_off();
        sfz.note_on(1, 57, 79, 24);
        let _ = take(&mut sfz, 8192);
        sfz.note_bend(1, 57, 0x8000_0000u32 + (0x8000_0000u32 / 8), 0, false);
        let bent = take(&mut sfz, 16384);
        sfz.all_sound_off();
        sfz.note_on(2, 52, 79, 24);
        let _ = take(&mut sfz, 8192);
        let other = take(&mut sfz, 16384);
        sfz.all_sound_off();
        for (v, b) in both.iter_mut().zip(&bent) {
            *v -= b;
        }
        println!("  bend on string 1: string 2 alone {:.1} Hz, chord minus bent note {:.1} Hz (164.8 if untouched)", pitch(&other, rate as f32), pitch(&both, rate as f32));
    }
}
