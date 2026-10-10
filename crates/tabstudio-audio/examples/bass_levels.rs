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
