//! SFZ instruments through sfizz's C API, loaded at run time (sfizz.dll / libsfizz.dylib,
//! BSD-2). A port of native/sfz-host.py: for the Standard Guitar library every string is
//! its own lane (its own sfizz synth) so per-string bends stay independent; each lane only
//! loads the regions for the pitches it plays; articulations select keyswitches.
//!
//! Lanes are built on a control thread (sample loading takes seconds); the audio thread
//! only sends events and renders.
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CString, c_char, c_int, c_uint, c_void};
use std::path::{Path, PathBuf};
use std::sync::Arc;

type Synth = *mut c_void;

/// The sfizz functions the host uses (native/sfizz.h).
pub struct SfizzApi {
    _lib: libloading::Library,
    create: unsafe extern "C" fn() -> Synth,
    free: unsafe extern "C" fn(Synth),
    load_file: unsafe extern "C" fn(Synth, *const c_char) -> bool,
    load_string: unsafe extern "C" fn(Synth, *const c_char, *const c_char) -> bool,
    num_regions: unsafe extern "C" fn(Synth) -> c_int,
    set_block: unsafe extern "C" fn(Synth, c_int),
    set_rate: unsafe extern "C" fn(Synth, f32),
    set_preload: unsafe extern "C" fn(Synth, c_uint),
    note_on: unsafe extern "C" fn(Synth, c_int, c_int, c_int),
    note_off: unsafe extern "C" fn(Synth, c_int, c_int, c_int),
    cc: unsafe extern "C" fn(Synth, c_int, c_int, c_int),
    pitch_wheel: unsafe extern "C" fn(Synth, c_int, f32),
    render: unsafe extern "C" fn(Synth, *mut *mut f32, c_int, c_int),
    all_sound_off: unsafe extern "C" fn(Synth),
    active_voices: unsafe extern "C" fn(Synth) -> c_int,
}

impl SfizzApi {
    pub fn load(library: &Path) -> Result<Arc<SfizzApi>, String> {
        unsafe {
            let lib = libloading::Library::new(library).map_err(|e| format!("sfizzを読み込めません：{e}"))?;
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get($name).map_err(|e| format!("sfizz: {e}"))?
                };
            }
            Ok(Arc::new(SfizzApi {
                create: sym!(b"sfizz_create_synth\0"),
                free: sym!(b"sfizz_free\0"),
                load_file: sym!(b"sfizz_load_file\0"),
                load_string: sym!(b"sfizz_load_string\0"),
                num_regions: sym!(b"sfizz_get_num_regions\0"),
                set_block: sym!(b"sfizz_set_samples_per_block\0"),
                set_rate: sym!(b"sfizz_set_sample_rate\0"),
                set_preload: sym!(b"sfizz_set_preload_size\0"),
                note_on: sym!(b"sfizz_send_note_on\0"),
                note_off: sym!(b"sfizz_send_note_off\0"),
                cc: sym!(b"sfizz_send_cc\0"),
                pitch_wheel: sym!(b"sfizz_send_hd_pitch_wheel\0"),
                render: sym!(b"sfizz_render_block\0"),
                all_sound_off: sym!(b"sfizz_all_sound_off\0"),
                active_voices: sym!(b"sfizz_get_num_active_voices\0"),
                _lib: lib,
            }))
        }
    }
}

/// Patches loaded for the Standard Guitar, in sfz-host.py order.
const PATCHES: [&str; 13] = ["Sus_Down", "Sus_Up", "Mute_Down", "Mute_Up", "Mute_Fret", "Natural_Harmonics", "Picking_Harmonics", "Legato", "Release1_Sus_Down", "Release1_Sus_Up", "Release1_Mute_Down", "Release1_Mute_Up", "Release1_Legato"];
const CONTROL: &str = "<control> set_cc20=0 set_cc21=95 set_cc22=127 set_cc23=0 set_cc24=13 set_cc25=108 set_cc48=0\n";
pub const BLOCK: usize = 4096;

/// MIDI key from a number or a note name like "g#7" / "eb2".
pub fn midi_key(value: &str) -> Option<i32> {
    if let Ok(n) = value.parse::<i32>() {
        return Some(n);
    }
    let v = value.to_lowercase();
    let mut chars = v.chars();
    let letter = chars.next()?;
    let base = match letter {
        'c' => 0,
        'd' => 2,
        'e' => 4,
        'f' => 5,
        'g' => 7,
        'a' => 9,
        'b' => 11,
        _ => return None,
    };
    let rest: String = chars.collect();
    let (accidental, octave) = match rest.chars().next() {
        Some('#') => (1, &rest[1..]),
        Some('b') if rest.len() > 1 => (-1, &rest[1..]),
        _ => (0, rest.as_str()),
    };
    let octave: i32 = octave.parse().ok()?;
    Some(12 * (octave + 1) + base + accidental)
}

/// The line-start `lokey=` / `hikey=` of a region (sfz-host.py uses `(?m)^\s*key\s*=`).
fn region_key(region: &str, name: &str) -> Option<i32> {
    for line in region.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix(name) {
            let rest = rest.trim_start();
            if let Some(value) = rest.strip_prefix('=') {
                return value.split_whitespace().next().and_then(midi_key);
            }
        }
    }
    None
}

/// Keeps the regions that cover any of `keys` (regions without a line-start range stay).
pub fn restrict_patch(patch: &str, keys: &BTreeSet<u8>) -> String {
    if keys.is_empty() {
        return patch.to_string();
    }
    let mut parts = patch.split("<region>");
    let head = parts.next().unwrap_or("");
    let kept: Vec<String> = parts
        .filter(|region| match (region_key(region, "lokey"), region_key(region, "hikey")) {
            (Some(lo), Some(hi)) => keys.iter().any(|&k| lo <= k as i32 && k as i32 <= hi),
            _ => true,
        })
        .map(|r| format!("<region>{r}"))
        .collect();
    if kept.is_empty() { String::new() } else { format!("{head}{}", kept.concat()) }
}

/// The Standard Guitar patch texts (sfz-host.py's adjustments applied).
/// The keyswitch a Standard Guitar note selects, as `note_on` sends it: none (0) and the
/// bass Slap range (100+) play the default sustain (24).
pub fn standard_switch(keyswitch: u8) -> u8 {
    if keyswitch == 0 || keyswitch >= SLAP_KEYSWITCH { 24 } else { keyswitch }
}

/// Each patch with the keyswitch that selects it (its `sw_last`; None: always active).
fn standard_patches(file: &Path) -> Vec<(Option<u8>, String)> {
    let directory = file.parent().unwrap_or(Path::new(".")).join("Individual Patchs").join("Standard_Guitar_KSOP");
    let mut out = Vec::new();
    for name in PATCHES {
        let Ok(text) = std::fs::read_to_string(directory.join(format!("{name}.sfz"))) else { continue };
        let mut patch = text.trim_start_matches('\u{feff}').replace("sw_hikey=g#7", "sw_hikey=32");
        if name == "Natural_Harmonics" {
            // Original keys select physical harmonic positions, not their sounding pitch:
            // map the samples to measured fundamentals and extend to the nearest regions.
            let keys = [52, 57, 59, 62, 64, 67, 69, 71, 74, 76, 78, 79, 83, 88];
            patch = patch.split("<region>").next().unwrap_or("").to_string();
            for (i, key) in keys.iter().enumerate() {
                let low = if i == 0 { 35 } else { (keys[i - 1] + key) / 2 + 1 };
                let high = if i == keys.len() - 1 { 108 } else { (key + keys[i + 1]) / 2 };
                patch += &format!("<region> sample=..\\Samples\\Natural Harmonics\\{}.flac lokey={low} hikey={high} pitch_keycenter={key}\n", i + 1);
            }
        } else if name == "Picking_Harmonics" {
            let mut result = String::new();
            for token in patch.split_inclusive(|c: char| c.is_whitespace()) {
                let trimmed = token.trim_end();
                let mut replaced = None;
                for opcode in ["pitch_keycenter=", "lokey=", "hikey="] {
                    if let Some(value) = trimmed.strip_prefix(opcode) {
                        if value.parse::<i32>().is_err() {
                            if let Some(key) = midi_key(value) {
                                replaced = Some(format!("{opcode}{}{}", (key + 24).min(127), &token[trimmed.len()..]));
                            }
                        }
                    }
                }
                result += &replaced.unwrap_or_else(|| token.to_string());
            }
            patch = result.replace("lokey=59", "lokey=35");
        }
        let switch = patch.split_whitespace().find_map(|t| t.strip_prefix("sw_last=")).and_then(midi_key).and_then(|k| u8::try_from(k).ok());
        out.push((switch, patch.replace("<global>", "<global> bend_up=1600 bend_down=-1600") + "\n"));
    }
    out
}

struct Lane {
    synth: Synth,
    key: Option<i32>,
    midi_key: Option<i32>,
    pitch: f32,
    wheel: f32,
    pending: [f32; 128],
}

/// One loaded SFZ instrument for a track.
pub struct SfzInstrument {
    api: Arc<SfizzApi>,
    pub file: PathBuf,
    standard: bool,
    /// A lane per string (`is_string_guitar`).
    strings: bool,
    /// A Les Paul DI (`is_lespaul_di` or `is_trummer_lp`): mutes on keyswitch 27.
    lespaul: bool,
    /// The Trummer Les Paul's level (TRUMMER_GAIN_NECK or _BRIDGE; None for other files).
    trummer: Option<f32>,
    /// Standard Bass V2: lane 0 plays the file, lane SLAP_LANE the library's Slap program.
    bass: bool,
    /// Which sounding keys went to the slap lane (their offs and bends follow them).
    slap_keys: [bool; 128],
    /// The Bass DI articulation (ART_PALM..) each sounding key plays on ART_LANE (0: lane 0).
    art_keys: [u8; 128],
    /// The main lane takes keyswitches (the library's KSOP; not Tab Studio's finger program).
    bass_switches: bool,
    /// The Bass DI (Fashionbass, BASS_DI_GAIN), with its articulations on ART_LANE.
    bass_di: bool,
    /// The Growlybass Bass DI, leveled like the other bass DIs (GROWLY_GAIN).
    growly: bool,
    lanes: Vec<Option<Lane>>,
    /// Which pitches each lane was built for (for reuse decisions on reload).
    pub pitches: BTreeMap<u8, BTreeSet<u8>>,
    /// The articulations it was built for (`with_switches`; None: all of them).
    pub switches: Option<BTreeMap<u8, BTreeSet<u8>>>,
    pub sample_rate: u32,
    controls: [Option<u8>; 128],
    scratch: [Vec<f32>; 2],
}

// The synths are only used by one thread at a time (built on a control thread, then
// handed to the audio thread through the engine's command queue).
unsafe impl Send for SfzInstrument {}

impl Drop for SfzInstrument {
    fn drop(&mut self) {
        for lane in self.lanes.iter().flatten() {
            unsafe { (self.api.free)(lane.synth) };
        }
    }
}

/// Keyswitches from 100 select the Slap program's articulation `keyswitch - 100`.
pub const SLAP_KEYSWITCH: u8 = 100;
const SLAP_LANE: usize = 1;
/// Beside the Bass DI: its articulations (`bass_di_articulations`), picked by keyswitch.
const ART_LANE: usize = 2;
/// Bass sits lower than guitar at the same level: pick +6 dB, finger (Fender JB) and slap +3 dB
/// (as sfz-host.py).
const BASS_GAIN_PICK: f32 = 2.0;
const BASS_GAIN_FINGER: f32 = 1.41;
// The Slap program plays about 9 dB below the KSOP program at the same velocity: +12 dB.
const BASS_GAIN_SLAP: f32 = 4.06;

/// Bass DI levels by key 23..=67, in quarter dB, added through the velocity (these programs
/// follow velocity squared: 40 log10 dB). Measured at velocity 79 with every articulation
/// rendered offline (`cargo run --release --example bass_levels`), smoothed over five keys,
/// and aimed at the pick sustain's median; palm -2, dead -4 and ghost -6 dB keep their
/// natural lightness. Without this the articulations and registers differed by up to 15 dB.
const LEVEL_FINGER_SUS: [i8; 45] = [12, 11, 11, 11, 11, 9, 9, 7, 7, 7, 7, 7, 7, 7, 7, 9, 9, 9, 3, 3, 3, 3, 1, 1, 0, 0, 0, 0, 0, -8, -8, -8, -8, -11, -11, -12, -12, -16, -16, -16, -16, -16, -16, -16, -16];
const LEVEL_PICK_SUS: [i8; 45] = [10, 10, 10, 5, 2, 2, 2, 2, 2, 3, 3, 5, 3, 4, 4, 3, -1, -1, -2, -2, 0, 0, 2, 2, 2, -1, -3, -3, -3, -3, -3, 1, 3, 3, 3, 2, -2, -5, -11, -13, -13, -13, -13, -13, 0];
const LEVEL_PICK_UP: [i8; 45] = [3, 5, 3, 8, 8, 7, 4, 4, 4, 7, 7, 7, 7, 6, 3, 3, 3, 1, 1, 3, 5, 11, 11, 11, 9, 7, 3, 3, 7, 2, 11, 11, 11, 7, 7, 2, 0, 0, -1, -1, -2, -2, -5, -9, 0];
const LEVEL_PICK_DEAD: [i8; 45] = [-10, -9, -6, -3, 2, 3, 3, 3, 3, 11, 15, 18, 19, 19, 20, 21, 20, 22, 22, 21, 21, 25, 25, 27, 27, 31, 31, 33, 33, 34, 34, 35, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 0];
const LEVEL_PICK_PALM: [i8; 45] = [15, 13, 11, 14, 8, 7, 4, 7, 7, 8, 9, 10, 9, 8, 7, 6, 6, 5, 5, 6, 7, 13, 13, 13, 13, 9, 9, 9, 9, 9, 9, 9, 17, 20, 21, 21, 21, 14, 13, 10, 9, 7, 9, 10, 0];
const LEVEL_PICK_HAMMER: [i8; 45] = [-14, -10, -8, -8, -8, -8, -8, -8, -7, -7, 1, 4, 4, 4, 1, 1, 0, -6, -7, -7, -7, -2, 3, 3, -2, -2, -4, -5, -5, -7, -7, 2, 2, 1, 1, 1, 0, -5, -7, -7, -8, -9, -7, -5, 0];
const LEVEL_PICK_THUMP: [i8; 45] = [-11, -4, -1, -1, -1, -1, -1, -1, 0, 1, 1, 1, 1, 2, 2, 2, 1, 1, -3, -3, -3, 4, 4, 4, -4, -5, -5, -5, -5, -5, -4, -2, 2, -2, -2, -2, -2, -2, -2, -2, -1, -1, -3, -1, 0];
const LEVEL_PICK_POP: [i8; 45] = [-10, -10, -10, -10, -10, -7, -7, -7, -7, -2, -1, 1, 3, 3, 5, 5, 5, 5, 5, 6, 8, 8, 11, 15, 16, 17, 18, 16, 16, 14, 11, 8, 8, 8, 10, 12, 12, 11, 11, 8, 7, 7, 6, 6, 0];
const LEVEL_PICK_GHOST: [i8; 45] = [6, 6, 7, 8, 8, 9, 9, 7, 7, 8, 8, 10, 10, 10, 10, 8, 8, 9, 9, 11, 11, 12, 12, 9, 9, 11, 11, 13, 13, 13, 13, 11, 11, 12, 12, 15, 15, 15, 15, 12, 12, 12, 9, 12, 0];
const LEVEL_PICK_SLAPHP: [i8; 45] = [15, 9, 8, 3, 2, 2, 1, -1, -3, -3, -3, -3, -3, -3, -3, -4, -9, -13, -15, -15, -15, -13, -12, -12, -12, -12, -12, -18, -21, -22, -22, -22, -21, -21, -21, -24, -24, -28, -31, -31, -31, -31, -30, -30, 0];

/// The Bass DI: Karoryfer Fashionbass (CC0; a direct-recorded Killer KB-Simmony, neck pickup,
/// onboard EQ flat; five velocity layers, three round robins), played through its Tab Studio
/// program "Tab Studio Bass DI Fashion.sfz" (mapped at pitch). BASS_DI_GAIN brings it to the
/// loudness the earlier Bass DI (Growlybass) had on nam_levels' bass phrase (-11.16 LUFS at
/// velocity 95, paced), which NAM_MODEL_LEVEL (src/mixer-state.ts) was measured on: unleveled it
/// played at -26.83 LUFS, so +15.67 dB.
const BASS_DI_GAIN: f32 = 6.07;
/// Fashionbass has no slap, palm-mute or dead-note recordings: ART_LANE voices them from its
/// own samples (fashionbass_clean.sfz, no release samples) under one `<master>` each, selected
/// by `sw_last` on keys 1..=5 (its lowest note is key 12). Palm mutes: the notes with a short
/// decay through a low-pass; thumped and popped notes: the notes from the upper velocity layers
/// through a "smile" EQ (more lows and highs, less mids), pops brighter; dead and slapped ghost
/// notes: its muted-string noises (keys 84..=87, `dead_note_key`). Levels (dB, added to each
/// zone's in `bass_di_text`) are matched on the attack to the finger notes (`bass_levels
/// fashion`): thump 0, pop +1, palm -2, dead -4 and ghost -6 dB, as the Standard Bass V2 tables.
const ART_PALM: u8 = 1;
const ART_THUMP: u8 = 2;
const ART_POP: u8 = 3;
const ART_DEAD: u8 = 4;
const ART_GHOST: u8 = 5;
const ART_MASTERS: [(u8, &str, f32); 5] = [
    (ART_PALM, "ampeg_hold=0.02 ampeg_decay=0.35 ampeg_sustain=0 fil_type=lpf_2p cutoff=650 fil_veltrack=1800", 0.0),
    (ART_THUMP, "eq1_freq=90 eq1_bw=1.2 eq1_gain=3 eq2_freq=550 eq2_bw=1.4 eq2_gain=-8 eq3_freq=3000 eq3_bw=1.6 eq3_gain=11", -1.0),
    (ART_POP, "eq1_freq=90 eq1_bw=1.2 eq1_gain=2 eq2_freq=550 eq2_bw=1.4 eq2_gain=-8 eq3_freq=2500 eq3_bw=1.6 eq3_gain=15", -2.8),
    (ART_DEAD, "", 2.8),
    (ART_GHOST, "", 0.7),
];
/// Fashionbass's level by sample zone (its lowest key, dB): the finger notes' attacks evened to
/// their median (keys 23..=67, velocity 79, paced; `bass_levels buzz` KEYS row), which spread
/// from -2 to +8 dB, the top zones loudest. Applied as each zone `<group>`'s volume
/// (`bass_di_text`), so velocity still picks the layer the note was played with.
const BASS_DI_ZONES: [(u8, f32); 19] = [
    (12, 0.5), (20, 0.5), (23, 0.5), (25, -0.5), (28, 2.0), (31, -1.0), (34, 1.0), (37, 0.0), (40, 0.5), (43, 0.0),
    (46, 1.5), (49, 1.0), (52, -2.5), (55, -1.5), (58, 0.0), (61, -3.5), (64, -5.0), (67, -7.5), (69, -7.5),
];

/// Bass DI (Growly): Karoryfer Growlybass (CC0, a direct-recorded Squier Jazz bass), played through
/// its Tab Studio program "Tab Studio Bass DI Growly.sfz" (which shifts it to sound as written).
/// At velocity 79 it sits 12.35 dB under the Standard Bass V2 finger DI per note, and about 4 dB
/// under it again in sustained phrases (shorter decays), so it is raised 15.35 dB (NAM drives its
/// amp from this level) and evened by key through the velocity (its layers follow velocity
/// closely). Fashionbass (BASS_DI_GAIN) was matched to it. Measured with `cargo run --release
/// --example bass_levels file|velcurve <sfz>` and `--example di_compare` (quarter dB, keys 23..=67).
const GROWLY_GAIN: f32 = 5.855 * DI_MATCH_GROWLY;
/// Offered beside Fashionbass, the Standard Bass V2 finger program and Growlybass are matched to it
/// through the bass amps (the NAM models are leveled on Fashionbass): on nam_levels' bass phrase
/// (BASS_DI=<sfz>, Darkglass B7K, Fender Rumble, Ampeg SVT) they played 2.1 and 2.3 dB louder on
/// average (Fashionbass -11.14 LUFS; finger -9.05, Growly -8.89). The amps compress, so -3 dB in
/// brings them to -10.78 and -10.61 (per model within about ±2 dB: the Darkglass drives hardest).
const DI_MATCH_FINGER: f32 = 0.7;
const DI_MATCH_GROWLY: f32 = 0.7;
const LEVEL_GROWLY: [i8; 45] = [8, 6, 6, 6, 6, 6, 6, 5, 5, 6, 5, 5, 6, 3, 2, -1, -1, -1, 10, 10, 10, 3, -1, -2, -10, -10, -10, 0, 0, 0, -2, -4, -6, -8, -12, -18, -18, -20, -20, -20, -20, -20, -20, -21, -18];

/// Whether `file` is the Growlybass Bass DI program (by its Tab Studio program name).
pub fn is_growly_bass(file: &Path) -> bool {
    file.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().contains("bass di growly"))
}

/// Whether `file` is the Bass DI program (Fashionbass, by its Tab Studio program name).
pub fn is_bass_di(file: &Path) -> bool {
    file.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().contains("bass di fashion"))
}

/// The Bass DI articulation a note's keyswitch plays on ART_LANE: palm mute (27), dead note (23),
/// slapped ghost note (SLAP_KEYSWITCH + 25), pop (+ 26) or thump (the other slap keyswitches,
/// slap hammer-ons included). None: a finger note on lane 0.
pub fn bass_di_articulation(keyswitch: u8) -> Option<u8> {
    match keyswitch {
        27 => Some(ART_PALM),
        23 => Some(ART_DEAD),
        k if k == SLAP_KEYSWITCH + 25 => Some(ART_GHOST),
        k if k == SLAP_KEYSWITCH + 26 => Some(ART_POP),
        k if k >= SLAP_KEYSWITCH => Some(ART_THUMP),
        _ => None,
    }
}

/// A Fashionbass mapping with each zone `<group>`'s volume set to BASS_DI_ZONES plus `offset`
/// dB (added to the volume a group already has, e.g. its release samples' -8).
fn bass_di_text(text: &str, offset: f32) -> String {
    let mut out = String::with_capacity(text.len() + 8192);
    for (i, chunk) in text.split("<group>").enumerate() {
        if i == 0 {
            out.push_str(chunk);
            continue;
        }
        let end = chunk.find("<region>").unwrap_or(chunk.len());
        let (header, rest) = chunk.split_at(end);
        let value = |name: &str| header.lines().find_map(|l| l.trim().strip_prefix(name)?.trim().parse::<f32>().ok());
        let zone = value("lokey=").and_then(|k| BASS_DI_ZONES.iter().find(|z| z.0 as f32 == k)).map_or(0.0, |z| z.1);
        let volume = value("volume=").unwrap_or(0.0) + zone + offset;
        // The header's first line is the rest of the `<group>` line (empty), so the volume
        // ends that line.
        out.push_str(&format!("<group>\nvolume={volume:.2}"));
        for line in header.lines().filter(|l| !l.trim().starts_with("volume=")) {
            out.push_str(line);
            out.push('\n');
        }
        out.push_str(rest);
    }
    out
}

/// ART_LANE's program text from fashionbass_clean.sfz (see ART_MASTERS).
fn bass_di_articulations(clean: &str) -> String {
    ART_MASTERS.iter().map(|(switch, opcodes, db)| format!("<master> sw_lokey=1 sw_hikey=7 sw_last={switch} {opcodes}\n{}\n", bass_di_text(clean, *db))).collect()
}

/// The muted-string noise a dead note plays (keys 84..=87: Fashionbass's C, G, D and A strings,
/// fifths apart): the string an EADG(B) bass would most likely mute at `key`.
fn dead_note_key(key: u8) -> c_int {
    match key {
        0..=32 => 84,
        33..=37 => 85,
        38..=42 => 86,
        _ => 87,
    }
}

/// The level correction (dB) for a bass note on `index`'s lane with `keyswitch`.
fn bass_level(index: usize, bass_switches: bool, key: u8, keyswitch: u8) -> f32 {
    let table = if index == SLAP_LANE {
        match keyswitch.saturating_sub(SLAP_KEYSWITCH) {
            25 => &LEVEL_PICK_GHOST,
            26 => &LEVEL_PICK_POP,
            27 => &LEVEL_PICK_SLAPHP,
            _ => &LEVEL_PICK_THUMP,
        }
    } else if !bass_switches {
        &LEVEL_FINGER_SUS
    } else {
        match keyswitch {
            25 => &LEVEL_PICK_UP,
            23 => &LEVEL_PICK_DEAD,
            27 => &LEVEL_PICK_PALM,
            30 => &LEVEL_PICK_HAMMER,
            _ => &LEVEL_PICK_SUS,
        }
    };
    key.checked_sub(23).and_then(|i| table.get(i as usize)).map_or(0.0, |q| *q as f32 / 4.0)
}

/// The Slap program beside a Standard Bass V2 KSOP program (pick or Tab Studio's finger voicing).
pub fn standard_bass_slap(file: &Path) -> Option<PathBuf> {
    let parent = file.parent()?;
    let library = if parent.file_name()?.to_string_lossy().eq_ignore_ascii_case("standard_bass_v2_ksop") {
        parent.parent()?.to_path_buf()
    } else {
        return None;
    };
    let slap = library.join("Standard_Bass_V2_Slap").join("#Standard_Bass_V2_Slap.sfz");
    slap.is_file().then_some(slap)
}

pub fn is_standard_guitar(file: &Path) -> bool {
    file.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().contains("standard guitar"))
}

/// The Les Paul DIs play about 2 dB above the Standard Guitar (median over keys 40-84 at
/// velocity 79; examples/guitar_levels.rs) and come out of the bundled guitar amps louder still
/// (clean amps most; GUITAR_DI=<sfz> examples/nam_levels.rs). At this gain their notes sit about
/// 1 dB under the Standard's and a NAM track stays within 0.8 dB of it on average (-0.7 to +2 dB
/// by amp), since NAM drives its amp from this level.
const LESPAUL_GAIN: f32 = 0.7;

/// The Trummer Les Paul's pickups (strings evened by the installer) against the Standard Guitar:
/// medians over keys 40-84 at velocity 79 were 4.7 dB (neck) and 9.3 dB (bridge) under it
/// (examples/guitar_levels.rs). Raised to 1 dB under it, like LESPAUL_GAIN: through the bundled
/// guitar amps a NAM track then stays within about 0.9 dB of the Standard's on average.
const TRUMMER_GAIN_NECK: f32 = 1.53;
const TRUMMER_GAIN_BRIDGE: f32 = 2.6;

/// The FlameStudios Les Paul DIs (scripts/install-lespaul-di.py): sustains on keyswitch 24,
/// mutes on 27.
pub fn is_lespaul_di(file: &Path) -> bool {
    file.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().contains("guitar di lp"))
}

/// Bernhard Trummer's Les Paul (scripts/install-trummer-lp.py): sustains on keyswitch 24, mutes
/// on 27, and beside each pickup's program one per string ("... string<N>.sfz", 1 = low E) that
/// plays each key on that string where it can.
pub fn is_trummer_lp(file: &Path) -> bool {
    file.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().contains("guitar di trummer lp"))
}

/// The Trummer program for notes on string lane `lane` (alphaTab's numbering, 1 = lowest; lanes
/// above 6 use string 6): its string program when present, else the file itself.
fn trummer_string_file(file: &Path, lane: u8) -> PathBuf {
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let string = file.with_file_name(format!("{stem} string{}.sfz", lane.clamp(1, 6)));
    if lane > 0 && string.is_file() { string } else { file.to_path_buf() }
}

/// Guitar DIs that play a lane (sfizz synth) per string, so a bend moves only its string.
pub fn is_string_guitar(file: &Path) -> bool {
    is_standard_guitar(file) || is_lespaul_di(file) || is_trummer_lp(file)
}

impl SfzInstrument {
    /// Builds the lanes: for the Standard Guitar one per string in `pitches`, each with only
    /// the regions for its pitches; any other SFZ is a single lane (0) with the whole file.
    pub fn new(api: Arc<SfizzApi>, file: &Path, pitches: &BTreeMap<u8, BTreeSet<u8>>, sample_rate: u32) -> Result<SfzInstrument, String> {
        Self::with_switches(api, file, pitches, None, sample_rate)
    }

    /// As `new`, but a Standard Guitar lane loads only the articulations (keyswitches, see
    /// `standard_switch`) listed for it in `switches`, plus the default sustain. Loading the
    /// unused articulations took most of a song's preparation time. The Bass DI loads its
    /// articulation lane only when `switches` lists one (`bass_di_articulation`).
    pub fn with_switches(api: Arc<SfizzApi>, file: &Path, pitches: &BTreeMap<u8, BTreeSet<u8>>, switches: Option<&BTreeMap<u8, BTreeSet<u8>>>, sample_rate: u32) -> Result<SfzInstrument, String> {
        let standard = is_standard_guitar(file);
        let trummer = is_trummer_lp(file);
        let (strings, lespaul) = (is_string_guitar(file), is_lespaul_di(file) || trummer);
        // A Les Paul lane loads its program's regions for the string's pitches (the Trummer's
        // from that string's program).
        let lespaul_text = if lespaul {
            let lanes: Vec<u8> = if pitches.is_empty() { vec![1] } else { pitches.keys().copied().collect() };
            let mut texts = BTreeMap::new();
            for lane in lanes {
                let source = if trummer { trummer_string_file(file, lane) } else { file.to_path_buf() };
                texts.insert(lane.min(12), std::fs::read_to_string(&source).map_err(|e| format!("{}: {e}", source.display()))?);
            }
            Some(texts)
        } else {
            None
        };
        let slap = if standard { None } else { standard_bass_slap(file) };
        let bass = slap.is_some();
        // Beside the Bass DI its articulation lane loads for songs with palm mutes, dead notes or
        // slaps (it adds about a second to the bass track's preparation).
        let bass_di = is_bass_di(file);
        // Its main lane plays fashionbass.sfz (the Tab Studio program includes it) leveled by zone.
        let bass_di_main = if bass_di {
            let source = file.with_file_name("fashionbass.sfz");
            let text = std::fs::read_to_string(&source).map_err(|e| format!("{}: {e}", source.display()))?;
            Some(CString::new(bass_di_text(&text, 0.0)).map_err(|e| e.to_string())?)
        } else {
            None
        };
        let articulations = if bass_di && switches.is_none_or(|s| s.values().flatten().any(|&k| bass_di_articulation(k).is_some())) {
            match file.parent().map(|dir| std::fs::read_to_string(dir.join("fashionbass_clean.sfz"))) {
                Some(Ok(text)) => Some(CString::new(bass_di_articulations(&text)).map_err(|e| e.to_string())?),
                _ => None,
            }
        } else {
            None
        };
        let bass_switches = bass && file.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().starts_with("#standard_bass"));
        let path = CString::new(file.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let slap_path = match &slap {
            Some(slap) => Some(CString::new(slap.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?),
            None => None,
        };
        let patches = if standard { standard_patches(file) } else { Vec::new() };
        let mut lanes: Vec<Option<Lane>> = (0..=12).map(|_| None).collect();
        let lane_ids: Vec<u8> = if strings { pitches.keys().copied().filter(|l| (1..=12).contains(l)).collect() } else { vec![0] };
        let lane_ids = if lane_ids.is_empty() { vec![if strings { 1 } else { 0 }] } else { lane_ids };
        let mut lane_ids = if bass { vec![0, SLAP_LANE as u8] } else { lane_ids };
        if articulations.is_some() {
            lane_ids.push(ART_LANE as u8);
        }
        // Lanes load in parallel (each is its own sfizz synth; loading is disk and decode bound).
        struct SendSynth(Synth);
        unsafe impl Send for SendSynth {}
        let results: Vec<Result<(u8, SendSynth), String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = lane_ids
                .iter()
                .map(|&lane| {
                    let (api, patches, articulations, bass_di_main, lespaul_text) = (&api, &patches, &articulations, &bass_di_main, &lespaul_text);
                    let path = if bass && lane as usize == SLAP_LANE { slap_path.as_ref().unwrap_or(&path) } else { &path };
                    scope.spawn(move || -> Result<(u8, SendSynth), String> {
                        let synth = unsafe { (api.create)() };
                        if synth.is_null() {
                            return Err("SFZ音源を作成できません。".into());
                        }
                        unsafe {
                            (api.set_block)(synth, BLOCK as c_int);
                            (api.set_rate)(synth, sample_rate as f32);
                            // Keep attacks resident; sfizz streams the rest (sfz-host.py).
                            (api.set_preload)(synth, 8192);
                        }
                        let ok = if let (Some(text), true) = (articulations, lane as usize == ART_LANE) {
                            // The program's path resolves the samples' folder.
                            unsafe { (api.load_string)(synth, path.as_ptr(), text.as_ptr()) }
                        } else if let (Some(text), 0) = (bass_di_main, lane) {
                            unsafe { (api.load_string)(synth, path.as_ptr(), text.as_ptr()) }
                        } else if standard {
                            let empty = BTreeSet::new();
                            let keys = pitches.get(&lane).unwrap_or(&empty);
                            let wanted = switches.map(|s| s.get(&lane).cloned().unwrap_or_default());
                            let chosen: Vec<&String> = patches
                                .iter()
                                .filter(|(switch, _)| match (&wanted, switch) {
                                    (Some(wanted), Some(k)) => *k == 24 || wanted.contains(k),
                                    _ => true,
                                })
                                .map(|(_, p)| p)
                                .collect();
                            let mut body: String = chosen.iter().map(|p| restrict_patch(p, keys)).collect();
                            if !body.contains("<region>") {
                                body = patches.iter().map(|(_, p)| p.as_str()).collect();
                            }
                            let text = CString::new(format!("{CONTROL}{body}")).map_err(|e| e.to_string())?;
                            unsafe { (api.load_string)(synth, path.as_ptr(), text.as_ptr()) }
                        } else if let Some(texts) = lespaul_text {
                            let Some(whole) = texts.get(&lane).or_else(|| texts.values().next()) else { return Err("SFZに再生できる音色がありません。".into()) };
                            let body = pitches.get(&lane).map(|keys| restrict_patch(whole, keys)).filter(|b| b.contains("<region>"));
                            let text = CString::new(body.as_deref().unwrap_or(whole)).map_err(|e| e.to_string())?;
                            unsafe { (api.load_string)(synth, path.as_ptr(), text.as_ptr()) }
                        } else {
                            unsafe { (api.load_file)(synth, path.as_ptr()) }
                        };
                        if !ok || unsafe { (api.num_regions)(synth) } < 1 {
                            unsafe { (api.free)(synth) };
                            return Err("SFZに再生できる音色がありません。".into());
                        }
                        // Full channel volume until the song says otherwise (playback sends CC7 127).
                        unsafe { (api.cc)(synth, 0, 7, 127) };
                        Ok((lane, SendSynth(synth)))
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("SFZ音源の読み込みに失敗しました。".into()))).collect()
        });
        let mut error = None;
        for result in results {
            match result {
                Ok((lane, SendSynth(synth))) => lanes[lane as usize] = Some(Lane { synth, key: None, midi_key: None, pitch: 0.0, wheel: 0.0, pending: [0.0; 128] }),
                Err(e) => error = Some(e),
            }
        }
        if let Some(error) = error {
            for lane in lanes.iter().flatten() {
                unsafe { (api.free)(lane.synth) };
            }
            return Err(error);
        }
        let trummer = trummer.then(|| if file.to_string_lossy().to_lowercase().contains("bridge") { TRUMMER_GAIN_BRIDGE } else { TRUMMER_GAIN_NECK });
        Ok(SfzInstrument { api, file: file.to_path_buf(), standard, strings, lespaul, trummer, bass, slap_keys: [false; 128], art_keys: [0; 128], bass_switches, bass_di, growly: is_growly_bass(file), lanes, pitches: pitches.clone(), switches: switches.cloned(), sample_rate, controls: [None; 128], scratch: [vec![0.0; BLOCK], vec![0.0; BLOCK]] })
    }

    /// True when this instrument already has every lane and pitch `needed` asks for.
    pub fn covers(&self, file: &Path, needed: &BTreeMap<u8, BTreeSet<u8>>) -> bool {
        self.file == file && needed.iter().all(|(lane, keys)| self.pitches.get(lane).is_some_and(|have| keys.is_subset(have)))
    }

    fn lane_index(&self, lane: u8, key: u8) -> usize {
        if self.strings {
            lane.clamp(1, 12) as usize
        } else if self.bass && self.slap_keys[key as usize & 127] {
            SLAP_LANE
        } else if self.art_keys[key as usize & 127] != 0 {
            ART_LANE
        } else {
            0
        }
    }

    /// Standard Bass V2's own programs (pick KSOP and Slap) are mapped an octave above the
    /// sounding pitch: key 40 plays E1 and nothing exists below key 35. The finger program
    /// (Fender JB) is mapped at pitch. Notes are sent an octave up to sound as written.
    /// A Bass DI dead or ghost note plays a muted-string noise (`dead_note_key`).
    fn sounding(&self, index: usize, key: u8) -> c_int {
        if index == ART_LANE && matches!(self.art_keys[key as usize & 127], ART_DEAD | ART_GHOST) {
            dead_note_key(key)
        } else if self.bass && (index == SLAP_LANE || self.bass_switches) {
            (key as c_int + 12).min(127)
        } else {
            key as c_int
        }
    }

    fn set_pitch(api: &SfizzApi, lane: &Lane) {
        unsafe { (api.pitch_wheel)(lane.synth, 0, (lane.pitch + lane.wheel).clamp(-1.0, 1.0)) };
    }

    pub fn note_on(&mut self, lane: u8, key: u8, velocity: u8, keyswitch: u8) {
        if self.bass {
            self.slap_keys[key as usize & 127] = keyswitch >= SLAP_KEYSWITCH;
        }
        // Bass DI palm mutes, dead notes and slaps play on the articulation lane once it is loaded
        // (until a reload adds it, e.g. an x previewed while editing, they play finger notes).
        let art = if self.bass_di && self.lanes[ART_LANE].is_some() { bass_di_articulation(keyswitch).unwrap_or(0) } else { 0 };
        self.art_keys[key as usize & 127] = art;
        let index = self.lane_index(lane, key);
        let sounding = self.sounding(index, key);
        let (standard, bass, bass_switches) = (self.standard, self.bass, self.bass_switches);
        // The KSOP fret mute starts one key above a 5-string's low B: that note mutes by palm.
        let keyswitch = if bass && bass_switches && index != SLAP_LANE && keyswitch == 23 && key < 24 { 27 } else { keyswitch };
        let velocity = if index == ART_LANE {
            // Slaps hit harder than the finger notes beside them: thumps from the f layer up,
            // pops from ff (Fashionbass's layers: ..40, ..65, ..85, ..110, 111..).
            match art {
                ART_THUMP => (velocity as u16 + 32).clamp(96, 127) as u8,
                ART_POP => (velocity as u16 + 40).clamp(111, 127) as u8,
                _ => velocity,
            }
        } else if self.growly {
            let db = key.checked_sub(23).and_then(|i| LEVEL_GROWLY.get(i as usize)).map_or(0.0, |q| *q as f32 / 4.0);
            (velocity as f32 * 10f32.powf(db / 40.0)).round().clamp(1.0, 127.0) as u8
        } else if bass {
            let db = bass_level(index, bass_switches, key, keyswitch);
            (velocity as f32 * 10f32.powf(db / 40.0)).round().clamp(1.0, 127.0) as u8
        } else {
            velocity
        };
        let api = self.api.clone();
        let Some(state) = self.lanes[index].as_mut() else { return };
        unsafe {
            if standard || self.lespaul || index == ART_LANE || (bass && (index == SLAP_LANE || bass_switches)) {
                let switch = match keyswitch {
                    _ if index == ART_LANE => art as c_int,
                    // The Les Paul DIs mute on 27 (palm, fret and up-stroke mutes) and sustain otherwise.
                    23 | 27 | 28 if self.lespaul => 27,
                    _ if self.lespaul => 24,
                    k if bass && index == SLAP_LANE => (k - SLAP_KEYSWITCH) as c_int,
                    // Bass KSOP keys 20/21 are FX, not harmonics: those play sustained.
                    0 | 20 | 21 if bass => 24,
                    0 => 24,
                    k if k >= SLAP_KEYSWITCH => 24,
                    k => k as c_int,
                };
                (api.note_on)(state.synth, 0, switch, 1);
                (api.note_off)(state.synth, 0, switch, 0);
            }
            state.key = Some(key as i32);
            state.midi_key = Some(key as i32);
            state.pitch = std::mem::take(&mut state.pending[key as usize & 127]);
            Self::set_pitch(&api, state);
            (api.note_on)(state.synth, 0, sounding, velocity as c_int);
        }
    }

    pub fn note_off(&mut self, lane: u8, key: u8, velocity: u8) {
        let index = self.lane_index(lane, key);
        let sounding = self.sounding(index, key);
        if let Some(state) = self.lanes[index].as_ref() {
            unsafe { (self.api.note_off)(state.synth, 0, sounding, velocity as c_int) };
        }
    }

    /// Per-note bend (32-bit, 0x80000000 = center); a continued note (tie, legato slide)
    /// keeps bending relative to the string's sounding root.
    pub fn note_bend(&mut self, lane: u8, key: u8, value: u32, reference: u8, continued: bool) {
        let index = self.lane_index(lane, key);
        let api = self.api.clone();
        let Some(state) = self.lanes[index].as_mut() else { return };
        let reference = if reference == 0 { key as i32 } else { reference as i32 };
        let delta = match (continued, state.key) {
            (true, Some(root)) if state.midi_key != Some(key as i32) => (reference - root) as f32 / 16.0,
            _ => 0.0,
        };
        let pitch = (value as f64 - 2_147_483_648.0) as f32 / 2_147_483_648.0 + delta;
        state.pending[key as usize & 127] = pitch;
        state.pitch = pitch;
        Self::set_pitch(&api, state);
    }

    pub fn control(&mut self, controller: u8, value: u8) {
        self.controls[controller as usize & 127] = Some(value);
        for lane in self.lanes.iter().flatten() {
            unsafe { (self.api.cc)(lane.synth, 0, controller as c_int, value as c_int) };
        }
    }

    pub fn pitch_wheel(&mut self, value: u32) {
        let wheel = (value as f32 - 8192.0) / 8192.0;
        let api = self.api.clone();
        for lane in self.lanes.iter_mut().flatten() {
            lane.wheel = wheel;
            Self::set_pitch(&api, lane);
        }
    }

    pub fn all_sound_off(&mut self) {
        for lane in self.lanes.iter_mut().flatten() {
            unsafe { (self.api.all_sound_off)(lane.synth) };
            lane.key = None;
            lane.midi_key = None;
            lane.pitch = 0.0;
            lane.wheel = 0.0;
            lane.pending = [0.0; 128];
        }
    }

    /// The sounding voices per loaded lane (for checks: which program a note went to).
    pub fn active_voices(&self) -> Vec<(usize, i32)> {
        self.lanes.iter().enumerate().filter_map(|(i, lane)| lane.as_ref().map(|l| (i, unsafe { (self.api.active_voices)(l.synth) }))).collect()
    }

    /// Adds every lane into `left`/`right` (any length; rendered in sfizz blocks).
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mut done = 0;
        while done < left.len() {
            let frames = (left.len() - done).min(BLOCK);
            for (index, lane) in self.lanes.iter().enumerate() {
                let Some(lane) = lane else { continue };
                let gain = match (self.bass, index == SLAP_LANE, self.bass_switches) {
                    _ if self.bass_di => BASS_DI_GAIN,
                    _ if self.growly => GROWLY_GAIN,
                    _ if self.trummer.is_some() => self.trummer.unwrap_or(1.0),
                    _ if self.lespaul => LESPAUL_GAIN,
                    (false, _, _) => 1.0,
                    (true, true, true) => BASS_GAIN_SLAP,
                    (true, true, false) => BASS_GAIN_SLAP * DI_MATCH_FINGER,
                    (true, false, true) => BASS_GAIN_PICK,
                    (true, false, false) => BASS_GAIN_FINGER * DI_MATCH_FINGER,
                };
                let [sl, sr] = &mut self.scratch;
                let mut channels = [sl.as_mut_ptr(), sr.as_mut_ptr()];
                unsafe { (self.api.render)(lane.synth, channels.as_mut_ptr(), 2, frames as c_int) };
                for i in 0..frames {
                    left[done + i] += sl[i] * gain;
                    right[done + i] += sr[i] * gain;
                }
            }
            done += frames;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midi_keys_from_numbers_and_names() {
        assert_eq!(midi_key("60"), Some(60));
        assert_eq!(midi_key("c4"), Some(60));
        assert_eq!(midi_key("G#7"), Some(104));
        assert_eq!(midi_key("eb2"), Some(39));
        assert_eq!(midi_key("b-1"), Some(11));
        assert_eq!(midi_key("h2"), None);
    }

    #[test]
    fn patches_keep_only_regions_for_the_played_pitches() {
        let patch = "<global> x\n<region>\nlokey=40\nhikey=45\nsample=a\n<region>\nlokey=50\nhikey=55\nsample=b\n<region> sample=c lokey=60 hikey=61\n";
        let keys: BTreeSet<u8> = [41].into_iter().collect();
        let kept = restrict_patch(patch, &keys);
        assert!(kept.contains("sample=a") && !kept.contains("sample=b"));
        assert!(kept.contains("sample=c"), "ranges not at a line start are kept, as sfz-host.py does");
        assert!(kept.starts_with("<global> x"));
        assert_eq!(restrict_patch("<region>\nlokey=10\nhikey=12\n", &[90].into_iter().collect()), "");
        assert_eq!(restrict_patch(patch, &BTreeSet::new()), patch);
    }

    /// Real library + sfizz when present (the developer machine): a lane per string,
    /// a note renders sound, and covers() decides reuse.
    #[test]
    fn standard_guitar_lane_renders_a_note() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native");
        let dll = root.join("runtime").join(if cfg!(windows) { "sfizz.dll" } else { "libsfizz.dylib" });
        let file = root.join("soundfonts/UI_Standard_Guitar/Programs/01-Standard Guitar KSOP.sfz");
        if !dll.exists() || !file.exists() {
            return;
        }
        let api = SfizzApi::load(&dll).unwrap();
        let pitches: BTreeMap<u8, BTreeSet<u8>> = [(6u8, [40u8].into_iter().collect())].into_iter().collect();
        let mut sfz = SfzInstrument::new(api, &file, &pitches, 48000).unwrap();
        assert!(sfz.covers(&file, &pitches));
        assert!(!sfz.covers(&file, &[(6u8, [41u8].into_iter().collect())].into_iter().collect()));
        sfz.note_on(6, 40, 100, 24);
        let (mut l, mut r) = (vec![0f32; 48000], vec![0f32; 48000]);
        for _ in 0..3 {
            l.fill(0.0);
            r.fill(0.0);
            sfz.render(&mut l, &mut r);
            if l.iter().any(|v| v.abs() > 1e-3) {
                break;
            }
        }
        assert!(l.iter().any(|v| v.abs() > 1e-3), "the low E sounds");
        sfz.all_sound_off();
    }

    /// The Trummer Les Paul (when installed): each string lane loads its string's program, so
    /// the same key plays the string the tab names; mutes and sustains are one sample each.
    #[test]
    fn trummer_lp_plays_the_string_of_each_lane() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native");
        let dll = root.join("runtime").join(if cfg!(windows) { "sfizz.dll" } else { "libsfizz.dylib" });
        let file = root.join("soundfonts/Trummer_LesPaul/Tab Studio Guitar DI Trummer LP Neck.sfz");
        assert!(is_trummer_lp(&file) && is_string_guitar(&file) && !is_lespaul_di(&file));
        if !dll.exists() || !file.exists() {
            return;
        }
        let key52 = |lane: u8| {
            let text = std::fs::read_to_string(trummer_string_file(&file, lane)).unwrap();
            let region = restrict_patch(&text, &[52u8].into_iter().collect());
            region.split("sample=Samples\\Neck\\").nth(1).unwrap()[..8].to_string()
        };
        // E3 (key 52): fret 13 on the low E, fret 3 on the D string (tuned a half step down); lanes
        // above 6 use the high e, whose nearest string reaching E3 is the D.
        assert_eq!((key52(1), key52(3), key52(9)), ("1_D#2_13".into(), "3_C#3_03".into(), "3_C#3_03".into()));
        assert_eq!(trummer_string_file(&file, 0), file);
        let api = SfizzApi::load(&dll).unwrap();
        let pitches: BTreeMap<u8, BTreeSet<u8>> = [(1u8, [40u8, 52].into_iter().collect()), (3u8, [52u8].into_iter().collect())].into_iter().collect();
        let mut sfz = SfzInstrument::new(api.clone(), &file, &pitches, 48000).unwrap();
        for (lane, key, switch) in [(1u8, 40u8, 24u8), (1, 52, 27), (3, 52, 24)] {
            sfz.note_on(lane, key, 79, switch);
            let (mut l, mut r) = (vec![0f32; 1024], vec![0f32; 1024]);
            sfz.render(&mut l, &mut r);
            assert!(l.iter().any(|v| v.abs() > 1e-4), "lane {lane} key {key} sounds");
            assert_eq!(sfz.active_voices().iter().map(|v| v.1).sum::<i32>(), 1, "lane {lane} key {key} plays one sample");
            sfz.all_sound_off();
        }
    }

    /// The Les Paul DIs (when installed): a lane per string with only that string's regions,
    /// and a mute (27) sounding where a sustain does.
    #[test]
    fn lespaul_di_plays_a_lane_per_string() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native");
        let dll = root.join("runtime").join(if cfg!(windows) { "sfizz.dll" } else { "libsfizz.dylib" });
        let file = root.join("soundfonts/FlameStudios_LesPaul_Neck/Tab Studio Guitar DI LP Neck.sfz");
        assert!(is_lespaul_di(&file) && is_string_guitar(&file) && !is_standard_guitar(&file));
        if !dll.exists() || !file.exists() {
            return;
        }
        let api = SfizzApi::load(&dll).unwrap();
        let pitches: BTreeMap<u8, BTreeSet<u8>> = [(6u8, [28u8, 40, 52].into_iter().collect()), (1u8, [64u8].into_iter().collect())].into_iter().collect();
        let mut sfz = SfzInstrument::new(api.clone(), &file, &pitches, 48000).unwrap();
        // Sustain and mute layers for the lowest sample (keys 28-40) and key 52, and for key 64.
        assert_eq!(sfz.lanes.iter().enumerate().filter_map(|(i, l)| l.as_ref().map(|l| (i, unsafe { (api.num_regions)(l.synth) }))).collect::<Vec<_>>(), vec![(1, 4), (6, 8)]);
        // One sample per note (a string's lane keeps each region's own keyswitch); mutes die
        // out within a second, sustains do not.
        let level = |x: &[f32]| x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32;
        for (key, switch, sustains) in [(28u8, 24u8, true), (40, 24, true), (52, 27, false), (40, 27, false), (40, 23, false), (40, 25, true)] {
            sfz.note_on(6, key, 79, switch);
            let (mut l, mut r) = (vec![0f32; 1024], vec![0f32; 1024]);
            sfz.render(&mut l, &mut r);
            assert!(l.iter().any(|v| v.abs() > 1e-3), "key {key} switch {switch} sounds");
            assert_eq!(sfz.active_voices().iter().map(|v| v.1).sum::<i32>(), 1, "key {key} switch {switch} plays one sample");
            // The loudest block of the first quarter second against the block at 1 s (rendered
            // near real time, so sfizz streams the samples past its preload).
            let mut start = level(&l);
            for block in 0..47 {
                std::thread::sleep(std::time::Duration::from_millis(15));
                l.fill(0.0);
                r.fill(0.0);
                sfz.render(&mut l, &mut r);
                if block < 11 {
                    start = start.max(level(&l));
                }
            }
            assert_eq!(level(&l) > start / 100.0, sustains, "key {key} switch {switch} after 1 s: {start} -> {}", level(&l));
            sfz.all_sound_off();
        }
    }

    #[test]
    fn bass_levels_follow_the_lane_and_articulation() {
        assert_eq!(bass_level(SLAP_LANE, true, 40, SLAP_KEYSWITCH + 25), LEVEL_PICK_GHOST[17] as f32 / 4.0);
        assert_eq!(bass_level(0, false, 40, 23), LEVEL_FINGER_SUS[17] as f32 / 4.0, "finger has no articulations");
        assert_eq!(bass_level(0, true, 40, 23), LEVEL_PICK_DEAD[17] as f32 / 4.0);
        assert_eq!(bass_level(0, true, 90, 24), 0.0, "outside the table");
    }

    /// Each patch knows its keyswitch; a lane built for some articulations has fewer regions
    /// and still plays those and the default sustain.
    #[test]
    fn standard_guitar_loads_only_the_articulations_a_lane_uses() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native");
        let dll = root.join("runtime").join(if cfg!(windows) { "sfizz.dll" } else { "libsfizz.dylib" });
        let file = root.join("soundfonts/UI_Standard_Guitar/Programs/01-Standard Guitar KSOP.sfz");
        if !dll.exists() || !file.exists() {
            return;
        }
        let switches: Vec<Option<u8>> = standard_patches(&file).iter().map(|(s, _)| *s).collect();
        assert_eq!(switches, [24, 25, 27, 28, 23, 20, 21, 30, 24, 25, 27, 28, 30].map(Some).to_vec(), "sw_last of PATCHES in order");
        assert_eq!((standard_switch(0), standard_switch(124), standard_switch(27)), (24, 24, 27));
        let api = SfizzApi::load(&dll).unwrap();
        let pitches: BTreeMap<u8, BTreeSet<u8>> = [(6u8, [40u8, 43].into_iter().collect())].into_iter().collect();
        let palm: BTreeMap<u8, BTreeSet<u8>> = [(6u8, [27u8].into_iter().collect())].into_iter().collect();
        let all = SfzInstrument::new(api.clone(), &file, &pitches, 48000).unwrap();
        let mut some = SfzInstrument::with_switches(api.clone(), &file, &pitches, Some(&palm), 48000).unwrap();
        let regions = |s: &SfzInstrument| unsafe { (s.api.num_regions)(s.lanes[6].as_ref().unwrap().synth) };
        assert!(regions(&some) < regions(&all), "{} < {}", regions(&some), regions(&all));
        for switch in [24, 27] {
            some.note_on(6, 40, 100, switch);
            let (mut l, mut r) = (vec![0f32; 48000], vec![0f32; 48000]);
            some.render(&mut l, &mut r);
            assert!(l.iter().any(|v| v.abs() > 1e-3), "keyswitch {switch} sounds");
            some.all_sound_off();
        }
    }

    /// Standard Bass V2 when present: a picked note plays on the main lane, a slapped one
    /// (keyswitch 100 + thump) on the Slap program, and its note-off finds that lane.
    #[test]
    fn standard_bass_routes_slap_to_its_own_program() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native");
        let dll = root.join("runtime").join(if cfg!(windows) { "sfizz.dll" } else { "libsfizz.dylib" });
        let file = root.join("soundfonts/Ui_Standard_Bass_V2/Standard_Bass_V2_KSOP/#Standard_Bass_V2_KSOP.sfz");
        if !dll.exists() || !file.exists() {
            return;
        }
        assert!(standard_bass_slap(&file).is_some());
        let api = SfizzApi::load(&dll).unwrap();
        let mut sfz = SfzInstrument::new(api, &file, &BTreeMap::new(), 48000).unwrap();
        assert!(sfz.lanes[0].is_some() && sfz.lanes[SLAP_LANE].is_some());
        let sounds = |sfz: &mut SfzInstrument| {
            let (mut l, mut r) = (vec![0f32; 48000], vec![0f32; 48000]);
            (0..3).any(|_| {
                l.fill(0.0);
                r.fill(0.0);
                sfz.render(&mut l, &mut r);
                l.iter().any(|v| v.abs() > 1e-3)
            })
        };
        sfz.note_on(0, 40, 100, SLAP_KEYSWITCH + 24);
        assert!(sfz.slap_keys[40]);
        assert!(sounds(&mut sfz), "the thump sounds");
        sfz.all_sound_off();
        sfz.note_on(0, 40, 100, 24);
        assert!(!sfz.slap_keys[40]);
        assert!(sounds(&mut sfz), "the picked note sounds");
        sfz.all_sound_off();
        // The library's programs start at key 35 (an octave above pitch): the low E (28)
        // and a 5-string's low B (23) only sound because notes are sent an octave up.
        // The low B's fret mute (23) is missing from the library and falls back to a palm mute.
        for (key, switch) in [(28, SLAP_KEYSWITCH + 24), (28, SLAP_KEYSWITCH + 25), (23, 24), (23, 23)] {
            sfz.note_on(0, key, 100, switch);
            assert!(sounds(&mut sfz), "key {key} with keyswitch {switch} sounds");
            sfz.all_sound_off();
        }
    }

    /// Each Fashionbass zone `<group>` gets BASS_DI_ZONES plus the offset as its one volume,
    /// added to the volume it had (its release samples' -8); other opcodes stay.
    #[test]
    fn bass_di_text_sets_zone_volumes() {
        let text = "// head\n<group>\nlokey=64\nhikey=66\n\n<region>\nsample=a.wav\n<group>\nlokey=64\ntrigger=release\nvolume=-8\n<region>\nsample=b.wav\n<group>\nlokey=84\n<region>\nsample=c.wav\n";
        let out = bass_di_text(text, -2.0);
        assert!(out.starts_with("// head\n"));
        let volumes: Vec<&str> = out.lines().filter(|l| l.starts_with("volume=")).collect();
        assert_eq!(volumes, vec!["volume=-7.00", "volume=-15.00", "volume=-2.00"]);
        assert_eq!(out.matches("<region>").count(), 3);
        assert!(out.contains("trigger=release") && out.contains("sample=b.wav") && out.contains("hikey=66"));
    }

    /// The Bass DI (Fashionbass, when present): at pitch; palm mutes, dead notes and slaps play on
    /// the articulation lane once a song uses them (else finger notes on lane 0); levels against
    /// the finger attack as ART_MASTERS aims (thump 0, pop +1, palm -2, dead -4, ghost -6 dB);
    /// palm mutes and dead notes stop short; thumps and pops are brighter.
    #[test]
    fn bass_di_plays_articulations_on_their_lane() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native");
        let dll = root.join("runtime").join(if cfg!(windows) { "sfizz.dll" } else { "libsfizz.dylib" });
        let file = root.join("soundfonts/Fashionbass/Tab Studio Bass DI Fashion.sfz");
        if !dll.exists() || !file.exists() {
            return;
        }
        assert!(is_bass_di(&file) && standard_bass_slap(&file).is_none());
        let api = SfizzApi::load(&dll).unwrap();
        let fingers: BTreeMap<u8, BTreeSet<u8>> = [(0u8, [24u8].into_iter().collect())].into_iter().collect();
        let mut plain = SfzInstrument::with_switches(api.clone(), &file, &BTreeMap::new(), Some(&fingers), 48000).unwrap();
        assert!(plain.lanes[0].is_some() && plain.lanes[ART_LANE].is_none() && plain.lanes[SLAP_LANE].is_none(), "no articulations: lane 0 alone");
        // Paced so sfizz streams past its preloaded attacks: (attack, tail, energy above 2 kHz
        // over 0.1..0.8 s relative to the whole, first-block lanes, samples).
        let hit = |sfz: &mut SfzInstrument, key: u8, switch: u8| {
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
            let power = |s: &[f32]| s.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / s.len() as f64;
            let a = (-2.0 * std::f64::consts::PI * 2000.0 / 48000.0).exp();
            let (mut px, mut py, mut hf) = (0f64, 0f64, 0f64);
            for v in &l[..38400] {
                let y = a * (py + *v as f64 - px);
                (px, py) = (*v as f64, y);
                hf += y * y;
            }
            (power(&l[..4096]), power(&l[24000..]), hf / 38400.0 / power(&l[..38400]).max(1e-20), lanes, l)
        };
        // Without its lane an x (previewed before the reload) still sounds, on lane 0.
        assert_eq!(hit(&mut plain, 40, 23).3, vec![0]);
        // Key 28 sounds E1 (41.2 Hz): the first autocorrelation peak within 90% of the best.
        let x = hit(&mut plain, 28, 24).4;
        let x = &x[4800..19200];
        let corr: Vec<f64> = (120..1920).map(|lag| x.iter().zip(&x[lag..]).map(|(a, b)| (*a * *b) as f64).sum()).collect();
        let best = corr.iter().cloned().fold(f64::MIN, f64::max);
        let mut i = corr.iter().position(|c| *c >= best * 0.9).unwrap();
        while i + 1 < corr.len() && corr[i + 1] > corr[i] {
            i += 1;
        }
        let hz = 48000.0 / (i + 120) as f64;
        assert!((hz / 41.2 - 1.0).abs() < 0.03, "key 28 sounds {hz:.1} Hz");
        drop(plain);
        let used: BTreeMap<u8, BTreeSet<u8>> = [(0u8, [23u8, 24].into_iter().collect())].into_iter().collect();
        let mut sfz = SfzInstrument::with_switches(api, &file, &BTreeMap::new(), Some(&used), 48000).unwrap();
        assert!(sfz.lanes[0].is_some() && sfz.lanes[ART_LANE].is_some() && sfz.lanes[SLAP_LANE].is_none());
        let mut level = |switch: u8| {
            let (mut head, mut tail, mut hf) = (0.0, 0.0, 0.0);
            for key in (28u8..=60).step_by(4) {
                let (h, t, f, lanes, _) = hit(&mut sfz, key, switch);
                assert_eq!(lanes, vec![if switch == 24 { 0 } else { ART_LANE }], "keyswitch {switch} key {key}");
                (head, tail, hf) = (head + 10.0 * h.max(1e-12).log10(), tail + 10.0 * t.max(1e-12).log10(), hf + 10.0 * f.max(1e-12).log10());
            }
            (head / 9.0, tail / 9.0, hf / 9.0)
        };
        let finger = level(24);
        let arts = [("palm", 27u8, -2.0), ("dead", 23, -4.0), ("thump", SLAP_KEYSWITCH + 24, 0.0), ("ghost", SLAP_KEYSWITCH + 25, -6.0), ("pop", SLAP_KEYSWITCH + 26, 1.0), ("slap hammer", SLAP_KEYSWITCH + 27, 0.0)];
        for (name, switch, aim) in arts {
            let (head, tail, hf) = level(switch);
            println!("{name}: attack {:+.1} dB vs finger (aim {aim:+.0}), tail {tail:.1} dB (finger {:.1}), above 2 kHz {hf:.1} dB (finger {:.1})", head - finger.0, finger.1, finger.2);
            assert!((head - finger.0 - aim).abs() < 1.5, "{name}: attack {:.1} dB vs finger, aim {aim}", head - finger.0);
            if matches!(name, "palm" | "dead" | "ghost") {
                assert!(tail < finger.1 - 20.0, "{name} stops short: tail {tail:.1} vs finger {:.1} dB", finger.1);
            }
            if matches!(name, "thump" | "pop") {
                assert!(hf > finger.2 + 0.5, "{name} is brighter: {hf:.1} vs finger {:.1} dB", finger.2);
            }
        }
    }
}
