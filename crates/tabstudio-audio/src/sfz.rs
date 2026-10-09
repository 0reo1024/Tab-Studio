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
fn standard_patches(file: &Path) -> Vec<String> {
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
        out.push(patch.replace("<global>", "<global> bend_up=1600 bend_down=-1600") + "\n");
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
    lanes: Vec<Option<Lane>>,
    /// Which pitches each lane was built for (for reuse decisions on reload).
    pub pitches: BTreeMap<u8, BTreeSet<u8>>,
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

pub fn is_standard_guitar(file: &Path) -> bool {
    file.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().contains("standard guitar"))
}

impl SfzInstrument {
    /// Builds the lanes: for the Standard Guitar one per string in `pitches`, each with only
    /// the regions for its pitches; any other SFZ is a single lane (0) with the whole file.
    pub fn new(api: Arc<SfizzApi>, file: &Path, pitches: &BTreeMap<u8, BTreeSet<u8>>, sample_rate: u32) -> Result<SfzInstrument, String> {
        let standard = is_standard_guitar(file);
        let path = CString::new(file.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let patches = if standard { standard_patches(file) } else { Vec::new() };
        let mut lanes: Vec<Option<Lane>> = (0..=12).map(|_| None).collect();
        let lane_ids: Vec<u8> = if standard { pitches.keys().copied().filter(|l| (1..=12).contains(l)).collect() } else { vec![0] };
        let lane_ids = if lane_ids.is_empty() { vec![if standard { 1 } else { 0 }] } else { lane_ids };
        // Lanes load in parallel (each is its own sfizz synth; loading is disk and decode bound).
        struct SendSynth(Synth);
        unsafe impl Send for SendSynth {}
        let results: Vec<Result<(u8, SendSynth), String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = lane_ids
                .iter()
                .map(|&lane| {
                    let (api, path, patches) = (&api, &path, &patches);
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
                        let ok = if standard {
                            let empty = BTreeSet::new();
                            let keys = pitches.get(&lane).unwrap_or(&empty);
                            let mut body: String = patches.iter().map(|p| restrict_patch(p, keys)).collect();
                            if !body.contains("<region>") {
                                body = patches.concat();
                            }
                            let text = CString::new(format!("{CONTROL}{body}")).map_err(|e| e.to_string())?;
                            unsafe { (api.load_string)(synth, path.as_ptr(), text.as_ptr()) }
                        } else {
                            unsafe { (api.load_file)(synth, path.as_ptr()) }
                        };
                        if !ok || unsafe { (api.num_regions)(synth) } < 1 {
                            unsafe { (api.free)(synth) };
                            return Err("SFZに再生できる音色がありません。".into());
                        }
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
        Ok(SfzInstrument { api, file: file.to_path_buf(), standard, lanes, pitches: pitches.clone(), controls: [None; 128], scratch: [vec![0.0; BLOCK], vec![0.0; BLOCK]] })
    }

    /// True when this instrument already has every lane and pitch `needed` asks for.
    pub fn covers(&self, file: &Path, needed: &BTreeMap<u8, BTreeSet<u8>>) -> bool {
        self.file == file && needed.iter().all(|(lane, keys)| self.pitches.get(lane).is_some_and(|have| keys.is_subset(have)))
    }

    fn lane_index(&self, lane: u8) -> usize {
        if self.standard { lane.clamp(1, 12) as usize } else { 0 }
    }

    fn set_pitch(api: &SfizzApi, lane: &Lane) {
        unsafe { (api.pitch_wheel)(lane.synth, 0, (lane.pitch + lane.wheel).clamp(-1.0, 1.0)) };
    }

    pub fn note_on(&mut self, lane: u8, key: u8, velocity: u8, keyswitch: u8) {
        let index = self.lane_index(lane);
        let standard = self.standard;
        let api = self.api.clone();
        let Some(state) = self.lanes[index].as_mut() else { return };
        unsafe {
            if standard {
                let switch = if keyswitch == 0 { 24 } else { keyswitch as c_int };
                (api.note_on)(state.synth, 0, switch, 1);
                (api.note_off)(state.synth, 0, switch, 0);
            }
            state.key = Some(key as i32);
            state.midi_key = Some(key as i32);
            state.pitch = std::mem::take(&mut state.pending[key as usize & 127]);
            Self::set_pitch(&api, state);
            (api.note_on)(state.synth, 0, key as c_int, velocity as c_int);
        }
    }

    pub fn note_off(&mut self, lane: u8, key: u8, velocity: u8) {
        let index = self.lane_index(lane);
        if let Some(state) = self.lanes[index].as_ref() {
            unsafe { (self.api.note_off)(state.synth, 0, key as c_int, velocity as c_int) };
        }
    }

    /// Per-note bend (32-bit, 0x80000000 = center); a continued note (tie, legato slide)
    /// keeps bending relative to the string's sounding root.
    pub fn note_bend(&mut self, lane: u8, key: u8, value: u32, reference: u8, continued: bool) {
        let index = self.lane_index(lane);
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

    /// Adds every lane into `left`/`right` (any length; rendered in sfizz blocks).
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mut done = 0;
        while done < left.len() {
            let frames = (left.len() - done).min(BLOCK);
            for lane in self.lanes.iter().flatten() {
                let [sl, sr] = &mut self.scratch;
                let mut channels = [sl.as_mut_ptr(), sr.as_mut_ptr()];
                unsafe { (self.api.render)(lane.synth, channels.as_mut_ptr(), 2, frames as c_int) };
                for i in 0..frames {
                    left[done + i] += sl[i];
                    right[done + i] += sr[i];
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
}
