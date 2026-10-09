//! Metronome clicks: the same deterministic waves as src/metronome.ts `clickWave`
//! (wood, rim, hat, beep), plus "standard", which plays alphaSynth's metronome note
//! (percussion key 33, velocity 95) on a synthesizer.
pub const KIND_STANDARD: u8 = 0;
pub const KIND_WOOD: u8 = 1;
pub const KIND_RIM: u8 = 2;
pub const KIND_HAT: u8 = 3;
pub const KIND_BEEP: u8 = 4;

/// Port of clickWave(kind, accent, rate) — keep the two in step.
pub fn click_wave(kind: u8, accent: bool, rate: u32) -> Vec<f32> {
    let rate_f = rate as f64;
    let duration = if kind == KIND_HAT { 0.065 } else { 0.09 };
    let length = (rate_f * duration).ceil() as usize;
    let mut seed: u32 = 8735;
    let freq = match kind {
        KIND_BEEP => if accent { 1500.0 } else { 1000.0 },
        KIND_WOOD => if accent { 1200.0 } else { 850.0 },
        _ => if accent { 1900.0 } else { 1400.0 },
    };
    let decay = match kind {
        KIND_BEEP => 0.018,
        KIND_WOOD => 0.012,
        _ => 0.009,
    };
    let tau = std::f64::consts::TAU;
    (0..length)
        .map(|i| {
            let t = i as f64 / rate_f;
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = seed as f64 / 2_147_483_648.0 - 1.0;
            let envelope = (t / 0.0007).min(1.0) * (-t / decay).exp();
            let wave = match kind {
                KIND_HAT => noise,
                KIND_RIM => 0.65 * noise + 0.35 * (tau * freq * t).sin(),
                KIND_WOOD => 0.75 * (tau * freq * t).sin() + 0.25 * (tau * freq * 1.47 * t).sin(),
                _ => (tau * freq * t).sin(),
            };
            (wave * envelope * if accent { 0.65 } else { 0.5 }) as f32
        })
        .collect()
}

/// All click waves for one sample rate, built off the audio thread.
pub struct ClickBank {
    /// [kind-1][accent as usize]
    waves: Vec<[Vec<f32>; 2]>,
}

impl ClickBank {
    pub fn new(rate: u32) -> ClickBank {
        ClickBank { waves: [KIND_WOOD, KIND_RIM, KIND_HAT, KIND_BEEP].iter().map(|&k| [click_wave(k, false, rate), click_wave(k, true, rate)]).collect() }
    }
    pub fn wave(&self, kind: u8, accent: bool) -> Option<&[f32]> {
        self.waves.get((kind as usize).checked_sub(1)?).map(|pair| &pair[accent as usize][..])
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metronome {
    pub enabled: bool,
    pub kind: u8,
    pub volume: f32,
}

impl Default for Metronome {
    fn default() -> Self {
        Metronome { enabled: false, kind: KIND_WOOD, volume: 0.65 }
    }
}

const VOICES: usize = 8;

/// A few overlapping one-shot clicks, mixed without allocation.
pub struct ClickVoices {
    active: [Option<(u8, bool, usize)>; VOICES],
}

impl Default for ClickVoices {
    fn default() -> Self {
        ClickVoices { active: [None; VOICES] }
    }
}

impl ClickVoices {
    pub fn start(&mut self, kind: u8, accent: bool) {
        let slot = self.active.iter().position(Option::is_none).unwrap_or(0);
        self.active[slot] = Some((kind, accent, 0));
    }
    pub fn clear(&mut self) {
        self.active = [None; VOICES];
    }
    /// Adds the active clicks into both channels.
    pub fn render(&mut self, bank: &ClickBank, gain: f32, left: &mut [f32], right: &mut [f32]) {
        for slot in &mut self.active {
            let Some((kind, accent, position)) = *slot else { continue };
            let Some(wave) = bank.wave(kind, accent) else {
                *slot = None;
                continue;
            };
            let count = (wave.len() - position).min(left.len());
            for i in 0..count {
                let v = wave[position + i] * gain;
                left[i] += v;
                right[i] += v;
            }
            *slot = if position + count >= wave.len() { None } else { Some((kind, accent, position + count)) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waves_match_the_typescript_formula() {
        // Reference values from src/metronome.ts clickWave (samples 50, 333, 1000).
        let cases: [(u8, bool, u32, usize, [f32; 3]); 4] = [
            (KIND_WOOD, true, 48000, 4320, [0.3199329972267151, 0.3345414400100708, -0.028633199632167816]),
            (KIND_RIM, false, 44100, 3969, [-0.3350738286972046, 0.09792610257863998, 0.0005861156969331205]),
            (KIND_HAT, true, 48000, 3120, [-0.5144862532615662, 0.27992308139801025, 0.036002349108457565]),
            (KIND_BEEP, false, 48000, 4320, [0.12213312089443207, -0.13014435768127441, -0.13609588146209717]),
        ];
        for (kind, accent, rate, length, values) in cases {
            let wave = click_wave(kind, accent, rate);
            assert_eq!(wave.len(), length);
            for (i, expected) in [50, 333, 1000].into_iter().zip(values) {
                assert!((wave[i] - expected).abs() < 1e-6, "kind {kind} sample {i}: {} vs {expected}", wave[i]);
            }
        }
    }

    #[test]
    fn voices_overlap_and_finish() {
        let bank = ClickBank::new(48000);
        let mut voices = ClickVoices::default();
        voices.start(KIND_BEEP, true);
        let (mut l, mut r) = (vec![0f32; 2000], vec![0f32; 2000]);
        voices.render(&bank, 1.0, &mut l, &mut r);
        voices.start(KIND_BEEP, false);
        let (mut l2, mut r2) = (vec![0f32; 8000], vec![0f32; 8000]);
        voices.render(&bank, 1.0, &mut l2, &mut r2);
        assert!(l2[100].abs() > 0.0);
        assert!(voices.active.iter().all(Option::is_none), "both clicks ended");
        assert!(bank.wave(KIND_STANDARD, true).is_none());
    }
}
