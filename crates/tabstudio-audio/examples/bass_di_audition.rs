//! Renders an audition phrase on the Bass DI (Fashionbass) with every articulation Tab Studio
//! sends, dry and through two bundled bass amps (as the app levels them), as WAV files.
//! Usage: cargo run --release --example bass_di_audition <out dir>
//! The phrase at 100 bpm: a finger line, palm-muted eighths, dead notes, then a slap groove
//! (thumps, slapped ghost notes, pops, a slap hammer-on).
use std::collections::BTreeMap;
use std::path::Path;
use tabstudio_audio::nam::{NamAmp, NamRuntime, NamStage, NamTone};
use tabstudio_audio::sfz::{SfizzApi, SfzInstrument, BLOCK, SLAP_KEYSWITCH};

const RATE: u32 = 48000;

/// (start in sixteenths, length in sixteenths, key, velocity, keyswitch).
fn phrase() -> Vec<(usize, usize, u8, u8, u8)> {
    let (t, g, p, h) = (SLAP_KEYSWITCH + 24, SLAP_KEYSWITCH + 25, SLAP_KEYSWITCH + 26, SLAP_KEYSWITCH + 27);
    let mut notes = Vec::new();
    // Bar 1: finger line in eighths.
    for (i, key) in [28u8, 31, 33, 35, 36, 38, 40, 43].into_iter().enumerate() {
        notes.push((i * 2, 2, key, 95, 24));
    }
    // Bar 2: palm-muted eighths on E and A.
    for (i, key) in [28u8, 28, 28, 28, 33, 33, 35, 35].into_iter().enumerate() {
        notes.push((16 + i * 2, 2, key, 95, 27));
    }
    // Bar 3: finger notes with dead notes between.
    for (i, (key, sw)) in [(33u8, 24u8), (33, 23), (33, 23), (36, 24), (38, 24), (38, 23), (40, 24), (40, 23)].into_iter().enumerate() {
        notes.push((32 + i * 2, 2, key, 95, sw));
    }
    // Bars 4-5: slap groove in sixteenths (thump, ghost, pop an octave up).
    for bar in 0..2 {
        let base = 48 + bar * 16;
        let groove: [(usize, u8, u8); 10] = [(0, 28, t), (2, 28, g), (3, 40, p), (4, 28, t), (6, 31, t), (7, 31, h), (8, 33, t), (10, 33, g), (11, 45, p), (14, 43, p)];
        for (at, key, sw) in groove {
            notes.push((base + at, 1, key, 95, sw));
        }
    }
    // A last finger E.
    notes.push((80, 8, 28, 95, 24));
    notes
}

fn render(sfz: &mut SfzInstrument) -> (Vec<f32>, Vec<f32>) {
    let sixteenth = RATE as usize * 60 / 100 / 4;
    let mut events: Vec<(usize, bool, u8, u8, u8)> = Vec::new();
    for (start, length, key, velocity, sw) in phrase() {
        events.push((start * sixteenth, true, key, velocity, sw));
        events.push(((start + length) * sixteenth - sixteenth / 10, false, key, 0, sw));
    }
    events.sort_by_key(|e| (e.0, e.1));
    let end = events.last().unwrap().0 + RATE as usize;
    let (mut left, mut right) = (vec![0f32; end], vec![0f32; end]);
    let (mut next, mut start) = (0, 0);
    while start < end {
        let frames = 256.min(end - start);
        while next < events.len() && events[next].0 < start + frames {
            let (_, on, key, velocity, sw) = events[next];
            if on { sfz.note_on(0, key, velocity, sw) } else { sfz.note_off(0, key, 0) }
            next += 1;
        }
        sfz.render(&mut left[start..start + frames], &mut right[start..start + frames]);
        start += frames;
        // Near real time, so sfizz streams the samples past its preload.
        std::thread::sleep(std::time::Duration::from_millis(4));
    }
    (left, right)
}

/// Writes the file with its peak at -1 dBFS (the app's level is reported: its master limiter
/// holds peaks above -3 dBFS).
fn write(out: &Path, name: &str, l: &[f32], r: &[f32]) {
    let path = out.join(format!("{name}.wav"));
    let peak = l.iter().chain(r).fold(0f32, |m, v| m.max(v.abs())).max(1e-9);
    let gain = 10f32.powf(-1.0 / 20.0) / peak;
    let (l, r): (Vec<f32>, Vec<f32>) = (l.iter().map(|v| v * gain).collect(), r.iter().map(|v| v * gain).collect());
    std::fs::write(&path, tabstudio_audio::wav::stereo_16(&l, &r, RATE)).unwrap();
    println!("wrote {} (at the app's level the peak is {:.1} dBFS)", path.display(), 20.0 * peak.log10());
}

fn main() {
    let out = std::env::args().nth(1).expect("out dir");
    let out = Path::new(&out);
    std::fs::create_dir_all(out).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native");
    let api = SfizzApi::load(&root.join("runtime/sfizz.dll")).unwrap();
    let file = root.join("soundfonts/Fashionbass/Tab Studio Bass DI Fashion.sfz");
    let mut sfz = SfzInstrument::new(api, &file, &BTreeMap::new(), RATE).unwrap();
    let (l, r) = render(&mut sfz);
    write(out, "1 Bass DI (dry)", &l, &r);
    // Through bundled bass amps as a new NAM track plays them: input 0 + NAM_INPUT_TRIM (-12),
    // output -6 + NAM_OUTPUT_TRIM (12) + NAM_MODEL_LEVEL, cabinet off.
    let runtime = NamRuntime::new(Some(&std::env::temp_dir().join("tabstudio-nam-audition"))).unwrap();
    for (n, file, label, level) in [(2, "8wjhc2nmxdl_a2.nam", "Ampeg SVT", 7.0f32), (3, "31b6532747244950_a2.nam", "Hartke LH1000 clean", 11.6), (4, "0oi29hxpzy2_a2.nam", "Darkglass B7K", 0.3)] {
        let model = root.join("nam-models").join(file);
        let Ok(json) = std::fs::read_to_string(&model) else { continue };
        let amp = NamAmp::new(&runtime, &json, RATE as f64).unwrap();
        let mut stage = NamStage::new(amp, NamTone { input: -12.0, output: 6.0 + level, bass: 0.0, mid: 0.0, treble: 0.0, cabinet: false }, RATE as f64);
        let (mut al, mut ar) = (l.clone(), r.clone());
        for s in (0..al.len()).step_by(BLOCK) {
            let e = (s + BLOCK).min(al.len());
            stage.process(&mut al[s..e], &mut ar[s..e]);
        }
        write(out, &format!("{n} {label}"), &al, &ar);
    }
}
