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
