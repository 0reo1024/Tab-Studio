//! NAM output levels at the app's default settings: one guitar phrase on the Guitar DI and one
//! bass phrase on the Bass DI are rendered once, then each model plays the same DI with what the
//! app sends for a new NAM track (input 0 + NAM_INPUT_TRIM, output -6 + NAM_OUTPUT_TRIM + the
//! model's leveling, flat EQ). Prints RMS and integrated loudness (ITU-R BS.1770, LUFS) per model,
//! for the track default (no cabinet filter) and the instrument input's (cabinet on).
//! Usage (scripts/nam-levels.mjs writes the list; GUITAR_DI=<sfz> / BASS_DI=<sfz> play another DI):
//!   cargo run --release --example nam_levels <models.tsv> [input offset dB]
//! The input offset drives every amp hotter or softer than the DI does (the instrument input
//! plays a real instrument at its own level).
//! models.tsv lines: `<id>\t<guitar|bass>\t<output dB the app sends>\t<path>`.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use tabstudio_audio::nam::{NamAmp, NamRuntime, NamStage, NamTone};
use tabstudio_audio::sfz::{SfizzApi, SfzInstrument, BLOCK};

const RATE: u32 = 48000;
/// mixer-state.ts NAM_INPUT_TRIM: SFZ DIs play at full channel volume.
const INPUT_TRIM: f32 = -12.0;
const VELOCITY: u8 = 95; // alphaTab's default dynamic (f)

/// (start in eighths, length in eighths, lane, key) at 120 bpm.
type Phrase = Vec<(usize, usize, u8, u8)>;

fn guitar_phrase() -> Phrase {
    // Lanes here count from the high e (6 = low E), the reverse of the app's (alphaTab's
    // note.string, 1 = lowest): a DI that picks samples by string plays some notes elsewhere.
    let mut p = Vec::new();
    // Two bars of E5 / A5 power chords in eighths, a single-note line, an open E chord.
    for i in 0..16 {
        let chord: &[(u8, u8)] = if i < 8 { &[(6, 40), (5, 47), (4, 52)] } else { &[(5, 45), (4, 52), (3, 57)] };
        p.extend(chord.iter().map(|&(lane, key)| (i, 1, lane, key)));
    }
    for (i, &(lane, key)) in [(3, 55), (3, 57), (2, 59), (2, 62), (1, 64), (1, 67), (1, 64), (2, 62), (2, 59), (3, 57), (3, 55), (4, 52), (3, 55), (3, 57), (2, 59), (2, 60)].iter().enumerate() {
        p.push((16 + i, 1, lane, key));
    }
    p.extend([(6, 40), (5, 47), (4, 52), (3, 56), (2, 59), (1, 64)].iter().map(|&(lane, key)| (32, 8, lane, key)));
    p
}

fn bass_phrase() -> Phrase {
    let mut p = Vec::new();
    for (i, key) in [28, 28, 31, 33, 33, 35, 36, 38, 40, 40, 43, 45, 43, 40, 38, 36, 33, 33, 36, 38, 40, 45, 47, 48, 45, 43, 40, 38, 36, 35, 33, 31].into_iter().enumerate() {
        p.push((i, 1, 0, key));
    }
    p.push((32, 8, 0, 28));
    p
}

fn render_di(api: &std::sync::Arc<SfizzApi>, file: &Path, phrase: &Phrase) -> (Vec<f32>, Vec<f32>) {
    let eighth = RATE as usize / 4;
    let mut pitches: BTreeMap<u8, BTreeSet<u8>> = BTreeMap::new();
    for &(_, _, lane, key) in phrase {
        pitches.entry(lane).or_default().insert(key);
    }
    let mut sfz = SfzInstrument::new(api.clone(), file, &pitches, RATE).unwrap();
    let mut events: Vec<(usize, bool, u8, u8)> = Vec::new();
    for &(start, length, lane, key) in phrase {
        events.push((start * eighth, true, lane, key));
        events.push(((start + length) * eighth - eighth / 20, false, lane, key));
    }
    events.sort_by_key(|e| (e.0, e.1));
    let end = events.last().unwrap().0 + RATE as usize;
    let (mut left, mut right) = (vec![0f32; end], vec![0f32; end]);
    let (mut next, mut start) = (0, 0);
    while start < end {
        let frames = 256.min(end - start);
        while next < events.len() && events[next].0 < start + frames {
            let (_, on, lane, key) = events[next];
            if on { sfz.note_on(lane, key, VELOCITY, 24) } else { sfz.note_off(lane, key, 0) }
            next += 1;
        }
        sfz.render(&mut left[start..start + frames], &mut right[start..start + frames]);
        start += frames;
        // Near real time, so sfizz streams the samples past its preload (else they fall silent).
        std::thread::sleep(std::time::Duration::from_millis(4));
    }
    (left, right)
}

/// BS.1770 K-weighting at 48 kHz (pre-filter shelf, then RLB high-pass).
fn k_weight(x: &[f32]) -> Vec<f64> {
    let stages = [([1.53512485958697, -2.69169618940638, 1.19839281085285], [-1.69065929318241, 0.73248077421585]), ([1.0, -2.0, 1.0], [-1.99004745483398, 0.99007225036621])];
    let mut y: Vec<f64> = x.iter().map(|v| *v as f64).collect();
    for (b, a) in stages {
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for v in y.iter_mut() {
            let out = b[0] * *v + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
            (x2, x1, y2, y1) = (x1, *v, y1, out);
            *v = out;
        }
    }
    y
}

/// Integrated loudness (LUFS) with the absolute (-70) and relative (-10 LU) gates.
fn lufs(left: &[f32], right: &[f32]) -> f64 {
    let (l, r) = (k_weight(left), k_weight(right));
    let (block, step) = (RATE as usize * 4 / 10, RATE as usize / 10);
    let mut powers = Vec::new();
    let mut at = 0;
    while at + block <= l.len() {
        let p: f64 = (at..at + block).map(|i| l[i] * l[i] + r[i] * r[i]).sum::<f64>() / block as f64;
        powers.push(p);
        at += step;
    }
    let loud = |p: f64| -0.691 + 10.0 * p.max(1e-20).log10();
    let above: Vec<f64> = powers.iter().copied().filter(|p| loud(*p) > -70.0).collect();
    let relative = loud(above.iter().sum::<f64>() / above.len().max(1) as f64) - 10.0;
    let gated: Vec<f64> = above.into_iter().filter(|p| loud(*p) > relative).collect();
    loud(gated.iter().sum::<f64>() / gated.len().max(1) as f64)
}

fn rms_db(left: &[f32], right: &[f32]) -> f64 {
    let s: f64 = left.iter().chain(right).map(|v| (*v as f64).powi(2)).sum::<f64>() / (left.len() + right.len()) as f64;
    10.0 * s.max(1e-20).log10()
}

fn main() {
    let list = std::fs::read_to_string(std::env::args().nth(1).expect("models.tsv")).unwrap();
    let offset: f32 = std::env::args().nth(2).map_or(0.0, |v| v.parse().unwrap());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native");
    let api = SfizzApi::load(&root.join("runtime").join(if cfg!(windows) { "sfizz.dll" } else { "libsfizz.dylib" })).unwrap();
    // GUITAR_DI=<sfz> compares another Guitar DI (e.g. a Les Paul) through the same amps.
    let guitar = std::env::var_os("GUITAR_DI").map(std::path::PathBuf::from).unwrap_or_else(|| root.join("soundfonts/UI_Standard_Guitar/Programs/01-Standard Guitar KSOP.sfz"));
    let bass = std::env::var_os("BASS_DI").map(std::path::PathBuf::from).unwrap_or_else(|| root.join("soundfonts/Fashionbass/Tab Studio Bass DI Fashion.sfz"));
    let dis = [("guitar", render_di(&api, &guitar, &guitar_phrase())), ("bass", render_di(&api, &bass, &bass_phrase()))];
    for (kind, (l, r)) in &dis {
        println!("DI {kind} rms {:.2} lufs {:.2}", rms_db(l, r), lufs(l, r));
    }
    let runtime = NamRuntime::new(Some(&std::env::temp_dir().join("tabstudio-nam-levels"))).unwrap();
    for line in list.lines().filter(|l| !l.trim().is_empty()) {
        let p: Vec<&str> = line.split('\t').collect();
        let (id, kind, output, file) = (p[0], p[1], p[2].parse::<f32>().unwrap(), p[3]);
        let (_, (dl, dr)) = dis.iter().find(|d| d.0 == kind).unwrap();
        let json = std::fs::read_to_string(file).unwrap();
        let mut cells = Vec::new();
        for cabinet in [false, true] {
            let amp = NamAmp::new(&runtime, &json, RATE as f64).unwrap();
            let mut stage = NamStage::new(amp, NamTone { input: INPUT_TRIM + offset, output, bass: 0.0, mid: 0.0, treble: 0.0, cabinet }, RATE as f64);
            let (mut l, mut r) = (dl.clone(), dr.clone());
            for s in (0..l.len()).step_by(BLOCK) {
                let e = (s + BLOCK).min(l.len());
                stage.process(&mut l[s..e], &mut r[s..e]);
            }
            // Skip the amp's fade-in after loading.
            cells.push(format!("{:.2}\t{:.2}", rms_db(&l[2048..], &r[2048..]), lufs(&l[2048..], &r[2048..])));
        }
        println!("MODEL\t{id}\t{kind}\t{}", cells.join("\t"));
    }
}
