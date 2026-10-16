use std::collections::BTreeMap;
use std::path::Path;
use tabstudio_audio::sfz::{SfizzApi, SfzInstrument, SLAP_KEYSWITCH};
fn level(sfz: &mut SfzInstrument, key: u8, switch: u8, velocity: u8) -> (f32, f32) {
    sfz.note_on(0, key, velocity, switch);
    let (mut l, mut r) = (vec![0f32; 4096], vec![0f32; 4096]);
    let (mut peak, mut sum, mut n) = (0f32, 0f64, 0usize);
    for block in 0..6 { // ~0.5 s at 48 kHz
        l.fill(0.0); r.fill(0.0);
        sfz.render(&mut l, &mut r);
        for v in &l { peak = peak.max(v.abs()); if block < 4 { sum += (*v as f64).powi(2); n += 1; } }
    }
    sfz.note_off(0, key, 0);
    sfz.all_sound_off();
    let db = |x: f64| if x > 1e-12 { 10.0 * x.log10() } else { -120.0 };
    (db((peak as f64).powi(2)) as f32, db(sum / n as f64) as f32)
}
fn main() {
    let root = Path::new("../../native");
    let api = SfizzApi::load(&root.join("runtime/sfizz.dll")).unwrap();
    let dir = root.join("soundfonts/Ui_Standard_Bass_V2/Standard_Bass_V2_KSOP");
    let mode = std::env::args().nth(1).unwrap_or_default();
    // `velcurve <path> <key>`: level by velocity, three hits each (round robins).
    if mode == "velcurve" {
        let file = std::path::PathBuf::from(std::env::args().nth(2).expect("path"));
        let key: u8 = std::env::args().nth(3).expect("key").parse().unwrap();
        let mut sfz = SfzInstrument::new(api.clone(), &file, &BTreeMap::new(), 48000).unwrap();
        for v in [20u8, 40, 60, 70, 79, 90, 100, 110, 120, 127] {
            let hits: Vec<String> = (0..3).map(|_| format!("{:.1}", level(&mut sfz, key, 24, v).1)).collect();
            println!("key {key} v{v}: {}", hits.join(" "));
        }
        return;
    }
    // `velmap <path> <name> <target dB> [lowest velocity]`: for a program whose velocity layers change its level
    // unevenly, the velocity that brings each key closest to the target (as a quarter-dB table).
    if mode == "velmap" {
        let file = std::path::PathBuf::from(std::env::args().nth(2).expect("path"));
        let name = std::env::args().nth(3).unwrap_or_else(|| "file".into());
        let target: f32 = std::env::args().nth(4).expect("target").parse().unwrap();
        let mut sfz = SfzInstrument::new(api.clone(), &file, &BTreeMap::new(), 48000).unwrap();
        let mut table = Vec::new();
        for k in 23u8..=67 {
            let mut best = (f32::MAX, 79u8);
            let low: u8 = std::env::args().nth(5).map_or(16, |v| v.parse().unwrap());
            for v in (low..=127).step_by(3).chain([79, 127]) {
                level(&mut sfz, k, 24, v);
                let (_, rms) = level(&mut sfz, k, 24, v);
                if rms <= -100.0 { continue; }
                let miss = (rms - target).abs() + (v as f32 - 79.0).abs() * 0.002;
                if miss < best.0 { best = (miss, v); }
            }
            let q = if best.0 == f32::MAX { 0 } else { (4.0 * 40.0 * (best.1 as f32 / 79.0).log10()).round() as i32 };
            table.push(q.clamp(-128, 127).to_string());
        }
        println!("VELMAP {name} [{}]", table.join(", "));
        return;
    }
    // `fashion [path]`: the Bass DI (Fashionbass) with every articulation as Tab Studio sends
    // them (finger 24, palm 27, dead 23, thump 124, ghost 125, pop 126, slap hammer 127), paced so
    // sfizz streams past its preloaded attacks. Per articulation over keys 28..=60 at velocity 79,
    // three hits each: the lane that sounds, the attack (first 4096 frames, ~85 ms) relative to
    // the finger attack (the ART_MASTERS volumes aim at thump 0, pop +1, palm -2, dead -4, ghost
    // -6 dB), the tail (0.5..1.0 s, held) and the share of energy above 2 kHz (0.1..0.8 s).
    // Then the finger notes per key (attack, quarter dB from their median) and per sample zone
    // the energy above 2 kHz (where string buzz would show).
    if mode == "fashion" || mode == "buzz" {
        let file = std::env::args().nth(2).map(std::path::PathBuf::from).unwrap_or_else(|| root.join("soundfonts/Fashionbass/Tab Studio Bass DI Fashion.sfz"));
        let started = std::time::Instant::now();
        let mut sfz = SfzInstrument::new(api.clone(), &file, &BTreeMap::new(), 48000).unwrap();
        println!("lanes {:?} loaded in {} ms", sfz.active_voices().iter().map(|v| v.0).collect::<Vec<_>>(), started.elapsed().as_millis());
        let db = |x: f64| 10.0 * x.max(1e-12).log10();
        // One paced note: (attack power, tail power, high-passed and whole power over 0.1..0.8 s, peak, lanes).
        let mut hit = |sfz: &mut SfzInstrument, key: u8, switch: u8| {
            sfz.note_on(0, key, 79, switch);
            let mut l = Vec::with_capacity(48128);
            let mut lanes = Vec::new();
            while l.len() < 48000 {
                let (mut block, mut r) = (vec![0f32; 1024], vec![0f32; 1024]);
                sfz.render(&mut block, &mut r);
                if l.is_empty() {
                    lanes = sfz.active_voices().into_iter().filter(|v| v.1 > 0).map(|v| v.0).collect::<Vec<_>>();
                }
                l.extend(block);
                std::thread::sleep(std::time::Duration::from_millis(3));
            }
            sfz.note_off(0, key, 0);
            sfz.all_sound_off();
            let a = (-2.0 * std::f64::consts::PI * 2000.0 / 48000.0).exp();
            let (mut px, mut py, mut hf, mut all) = (0f64, 0f64, 0f64, 0f64);
            for (i, v) in l.iter().enumerate() {
                let x = *v as f64;
                let y = a * (py + x - px);
                (px, py) = (x, y);
                if (4800..38400).contains(&i) {
                    hf += y * y;
                    all += x * x;
                }
            }
            let power = |s: &[f32]| s.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / s.len() as f64;
            (power(&l[..4096]), power(&l[24000..]), hf, all, l.iter().fold(0f32, |m, v| m.max(v.abs())), lanes)
        };
        let mut finger_head = 0.0;
        for (art, sw) in [("finger", 24u8), ("palm", 27), ("dead", 23), ("thump", SLAP_KEYSWITCH + 24), ("ghost", SLAP_KEYSWITCH + 25), ("pop", SLAP_KEYSWITCH + 26), ("slap-hp", SLAP_KEYSWITCH + 27)] {
            let (mut heads, mut tail, mut hf, mut all, mut peak, mut lanes) = (Vec::new(), 0.0, 0.0, 0.0, 0f32, Vec::new());
            for key in 28u8..=60 {
                let mut head = 0.0;
                for _ in 0..3 {
                    let (h, t, f, w, p, l) = hit(&mut sfz, key, sw);
                    (head, tail, hf, all, peak) = (head + h, tail + t, hf + f, all + w, peak.max(p));
                    lanes = l;
                }
                heads.push(db(head / 3.0));
            }
            heads.sort_by(|a, b| a.total_cmp(b));
            let head = heads[heads.len() / 2];
            if sw == 24 {
                finger_head = head;
            }
            println!("ART {art:8} lane {lanes:?} attack {head:6.1} dB ({:+5.1} vs finger)  tail {:7.1} dB  above 2 kHz {:6.1} dB  peak {:5.1} dBFS", head - finger_head, db(tail / 99.0), db(hf / all), 20.0 * (peak as f64).max(1e-9).log10());
        }
        if mode == "buzz" {
            // Per key: attack (quarter dB from the median) and energy above 2 kHz.
            let rows: Vec<(u8, f64, f64)> = (23u8..=67).map(|key| {
                let (mut h, mut f, mut w) = (0.0, 0.0, 0.0);
                for _ in 0..3 {
                    let r = hit(&mut sfz, key, 24);
                    (h, f, w) = (h + r.0, f + r.2, w + r.3);
                }
                (key, db(h / 3.0), db(f / w))
            }).collect();
            let mut sorted: Vec<f64> = rows.iter().map(|r| r.1).collect();
            sorted.sort_by(|a, b| a.total_cmp(b));
            let median = sorted[sorted.len() / 2];
            println!("KEYS attack median {median:.1} dB; per key: attack quarter-dB from the median / above 2 kHz dB");
            println!("{}", rows.iter().map(|(k, h, f)| format!("k{k} {:+.0}/{f:.1}", 4.0 * (h - median))).collect::<Vec<_>>().join("  "));
        }
        return;
    }
    // `pitch <path> <key>...`: the sounding fundamental (autocorrelation over 0.1..0.4 s) per key,
    // to check a library's octave mapping (key 28 should sound E1, 41.2 Hz).
    if mode == "pitch" {
        let file = std::path::PathBuf::from(std::env::args().nth(2).expect("path"));
        let mut sfz = SfzInstrument::new(api.clone(), &file, &BTreeMap::new(), 48000).unwrap();
        for key in std::env::args().skip(3).map(|k| k.parse::<u8>().unwrap()) {
            sfz.note_on(0, key, 79, 24);
            let mut l = Vec::new();
            while l.len() < 24000 {
                let (mut block, mut r) = (vec![0f32; 1024], vec![0f32; 1024]);
                sfz.render(&mut block, &mut r);
                l.extend(block);
                std::thread::sleep(std::time::Duration::from_millis(3));
            }
            sfz.note_off(0, key, 0);
            sfz.all_sound_off();
            let x = &l[4800..19200];
            // The first local peak (25..400 Hz) within 90% of the best one: the period.
            let lags = 120..1920;
            let corr: Vec<f64> = lags.clone().map(|lag| x.iter().zip(&x[lag..]).map(|(a, b)| (*a * *b) as f64).sum()).collect();
            let best = corr.iter().cloned().fold(f64::MIN, f64::max);
            let mut i = corr.iter().position(|c| *c >= best * 0.9).unwrap();
            while i + 1 < corr.len() && corr[i + 1] > corr[i] {
                i += 1;
            }
            let lag = i + lags.start;
            let expected = 440.0 * 2f64.powf((key as f64 - 69.0) / 12.0);
            println!("key {key}: {:.1} Hz (as written {expected:.1} Hz)", 48000.0 / lag as f64);
        }
        return;
    }
    // `file <path> [name]`: one plain SFZ program (no articulations), e.g. another bass DI.
    if mode == "file" {
        let file = std::path::PathBuf::from(std::env::args().nth(2).expect("path"));
        let name = std::env::args().nth(3).unwrap_or_else(|| "file".into());
        let mut sfz = SfzInstrument::new(api.clone(), &file, &BTreeMap::new(), 48000).unwrap();
        let rows: Vec<String> = (23u8..=67).map(|k| { level(&mut sfz, k, 24, 79); format!("{:.1}", level(&mut sfz, k, 24, 79).1) }).collect();
        println!("ROW {name}-sus {}", rows.join(" "));
        return;
    }
    let sets: Vec<(&str, std::path::PathBuf, Vec<(&str, u8)>)> = vec![
        ("finger", dir.join("Tab Studio Bass DI Finger.sfz"), vec![("sus", 24u8)]),
        ("pick", dir.join("#Standard_Bass_V2_KSOP.sfz"), vec![("sus", 24), ("up", 25), ("dead", 23), ("palm", 27), ("hammer", 30), ("thump", SLAP_KEYSWITCH + 24), ("pop", SLAP_KEYSWITCH + 26), ("ghost", SLAP_KEYSWITCH + 25), ("slaphp", SLAP_KEYSWITCH + 27)]),
    ];
    for (name, file, switches) in sets {
        let mut sfz = SfzInstrument::new(api.clone(), &file, &BTreeMap::new(), 48000).unwrap();
        if mode == "velocity" {
            for (art, sw) in switches.iter().take(4) {
                let rows: Vec<String> = [40u8, 60, 79, 100, 127].iter().map(|&v| { level(&mut sfz, 40, *sw, v); format!("v{v}:{:.1}", level(&mut sfz, 40, *sw, v).1) }).collect();
                println!("VEL {name} {art} {}", rows.join(" "));
            }
            continue;
        }
        for (art, sw) in switches {
            let rows: Vec<String> = (23u8..=67).map(|k| { level(&mut sfz, k, sw, 79); format!("{:.1}", level(&mut sfz, k, sw, 79).1) }).collect();
            println!("ROW {name}-{art} {}", rows.join(" "));
        }
    }
}
