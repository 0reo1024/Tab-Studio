//! Track and master effects matching the WebAudio nodes the mixer used (src/mixer-audio.ts),
//! following the Web Audio API specification formulas so the native mix sounds the same.
//! Compared against Chromium renders by `tabstudio-audio fxcompare` (spike S7).
//! Everything here is allocation-free after construction.
use std::f64::consts::PI;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FilterKind {
    Lowpass,
    Highpass,
    Peaking,
    Lowshelf,
    Highshelf,
}

/// BiquadFilterNode (Web Audio spec coefficients), one state per channel.
#[derive(Clone, Debug)]
pub struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    state: [[f64; 4]; 2],
}

impl Biquad {
    /// `q` as the node's Q attribute (default 1); `gain` in dB.
    pub fn new(kind: FilterKind, frequency: f64, q: f64, gain: f64, sample_rate: f64) -> Biquad {
        let mut f = Biquad { b: [1.0, 0.0, 0.0], a: [0.0, 0.0], state: [[0.0; 4]; 2] };
        f.set(kind, frequency, q, gain, sample_rate);
        f
    }

    pub fn set(&mut self, kind: FilterKind, frequency: f64, q: f64, gain: f64, sample_rate: f64) {
        let nyquist = sample_rate / 2.0;
        let f0 = frequency.clamp(0.0, nyquist);
        let a_gain = 10f64.powf(gain / 40.0);
        let w0 = 2.0 * PI * f0 / sample_rate;
        let (sin, cos) = w0.sin_cos();
        // The spec's alpha variants: Q in dB for low/highpass, linear Q for peaking, S = 1 for shelves.
        let alpha_q = sin / (2.0 * q);
        let alpha_q_db = sin / (2.0 * 10f64.powf(q / 20.0));
        let alpha_s = sin / 2.0 * 2f64.sqrt();
        // Spec edge cases at 0 Hz and Nyquist: the filter is a pass-through, silence or a gain.
        let pass = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        let mute = (0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        let gained = (a_gain * a_gain, 0.0, 0.0, 1.0, 0.0, 0.0);
        let (b0, b1, b2, a0, a1, a2) = if f0 >= nyquist {
            match kind {
                FilterKind::Highpass => mute,
                FilterKind::Lowshelf => gained,
                _ => pass,
            }
        } else if f0 <= 0.0 {
            match kind {
                FilterKind::Lowpass => mute,
                FilterKind::Highshelf => gained,
                _ => pass,
            }
        } else {
            match kind {
                FilterKind::Lowpass => ((1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0, 1.0 + alpha_q_db, -2.0 * cos, 1.0 - alpha_q_db),
                FilterKind::Highpass => ((1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0, 1.0 + alpha_q_db, -2.0 * cos, 1.0 - alpha_q_db),
                FilterKind::Peaking => (1.0 + alpha_q * a_gain, -2.0 * cos, 1.0 - alpha_q * a_gain, 1.0 + alpha_q / a_gain, -2.0 * cos, 1.0 - alpha_q / a_gain),
                FilterKind::Lowshelf => {
                    let s = 2.0 * a_gain.sqrt() * alpha_s;
                    (
                        a_gain * ((a_gain + 1.0) - (a_gain - 1.0) * cos + s),
                        2.0 * a_gain * ((a_gain - 1.0) - (a_gain + 1.0) * cos),
                        a_gain * ((a_gain + 1.0) - (a_gain - 1.0) * cos - s),
                        (a_gain + 1.0) + (a_gain - 1.0) * cos + s,
                        -2.0 * ((a_gain - 1.0) + (a_gain + 1.0) * cos),
                        (a_gain + 1.0) + (a_gain - 1.0) * cos - s,
                    )
                }
                FilterKind::Highshelf => {
                    let s = 2.0 * a_gain.sqrt() * alpha_s;
                    (
                        a_gain * ((a_gain + 1.0) + (a_gain - 1.0) * cos + s),
                        -2.0 * a_gain * ((a_gain - 1.0) + (a_gain + 1.0) * cos),
                        a_gain * ((a_gain + 1.0) + (a_gain - 1.0) * cos - s),
                        (a_gain + 1.0) - (a_gain - 1.0) * cos + s,
                        2.0 * ((a_gain - 1.0) - (a_gain + 1.0) * cos),
                        (a_gain + 1.0) - (a_gain - 1.0) * cos - s,
                    )
                }
            }
        };
        self.b = [b0 / a0, b1 / a0, b2 / a0];
        self.a = [a1 / a0, a2 / a0];
    }

    #[inline]
    pub fn process(&mut self, channel: usize, x: f32) -> f32 {
        let s = &mut self.state[channel];
        let x = x as f64;
        let y = self.b[0] * x + self.b[1] * s[0] + self.b[2] * s[1] - self.a[0] * s[2] - self.a[1] * s[3];
        s[1] = s[0];
        s[0] = x;
        s[3] = s[2];
        s[2] = y;
        y as f32
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        for v in left.iter_mut() {
            *v = self.process(0, *v);
        }
        for v in right.iter_mut() {
            *v = self.process(1, *v);
        }
    }

    pub fn reset(&mut self) {
        self.state = [[0.0; 4]; 2];
    }
}

/// StereoPannerNode on a stereo input (equal power, as in the spec).
pub fn stereo_pan(pan: f32, left: &mut [f32], right: &mut [f32]) {
    let p = pan.clamp(-1.0, 1.0);
    let x = if p <= 0.0 { p + 1.0 } else { p };
    let (gl, gr) = ((x * std::f32::consts::FRAC_PI_2).cos(), (x * std::f32::consts::FRAC_PI_2).sin());
    for (l, r) in left.iter_mut().zip(right.iter_mut()) {
        let (il, ir) = (*l, *r);
        if p <= 0.0 {
            *l = il + ir * gl;
            *r = ir * gr;
        } else {
            *l = il * gl;
            *r = ir + il * gr;
        }
    }
}

/// StereoPannerNode on a mono input (`left` holds it; `right` is overwritten): equal power,
/// gain L = cos(x pi/2), R = sin(x pi/2) with x = (pan + 1) / 2.
pub fn mono_pan(pan: f32, left: &mut [f32], right: &mut [f32]) {
    let x = (pan.clamp(-1.0, 1.0) + 1.0) / 2.0;
    let (gl, gr) = ((x * std::f32::consts::FRAC_PI_2).cos(), (x * std::f32::consts::FRAC_PI_2).sin());
    for (l, r) in left.iter_mut().zip(right.iter_mut()) {
        let input = *l;
        *l = input * gl;
        *r = input * gr;
    }
}

/// The mixer's delay: dry + (0.3 s delay with 0.3 feedback) x amount. In WebAudio the
/// feedback cycle adds one render quantum (128 frames) per round trip, so echoes land at
/// D, 2D + 128, 3D + 256, ... (measured in Chromium); the recirculation path here has
/// that extra quantum too: wet[t] = x[t - D] + 0.3 * wet[t - D - 128].
pub struct Delay {
    input: [Vec<f32>; 2],
    wet: [Vec<f32>; 2],
    input_pos: usize,
    wet_pos: usize,
    pub amount: f32,
}

impl Delay {
    pub const SECONDS: f64 = 0.3;
    pub const FEEDBACK: f32 = 0.3;
    pub const QUANTUM: usize = 128;
    pub fn new(sample_rate: f64, amount: f32) -> Delay {
        let length = (Self::SECONDS * sample_rate).round() as usize;
        Delay { input: [vec![0.0; length], vec![0.0; length]], wet: [vec![0.0; length + Self::QUANTUM], vec![0.0; length + Self::QUANTUM]], input_pos: 0, wet_pos: 0, amount }
    }
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let (in_len, wet_len) = (self.input[0].len(), self.wet[0].len());
        for i in 0..left.len() {
            for (c, sample) in [&mut left[i], &mut right[i]].into_iter().enumerate() {
                let delayed = self.input[c][self.input_pos];
                let wet = delayed + Self::FEEDBACK * self.wet[c][self.wet_pos];
                self.input[c][self.input_pos] = *sample;
                self.wet[c][self.wet_pos] = wet;
                *sample += wet * self.amount;
            }
            self.input_pos = (self.input_pos + 1) % in_len;
            self.wet_pos = (self.wet_pos + 1) % wet_len;
        }
    }
    pub fn reset(&mut self) {
        for b in self.input.iter_mut().chain(self.wet.iter_mut()) {
            b.fill(0.0);
        }
    }
}

/// The mixer's reverb impulse: seeded noise, 1.8 s, (1 - t)^3 decay x 0.18 (mixer-audio.ts).
pub fn reverb_impulse(sample_rate: f64) -> [Vec<f32>; 2] {
    let length = (sample_rate * 1.8).floor() as usize;
    let mut seed: u32 = 871;
    let mut make = || {
        (0..length)
            .map(|i| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((seed as f64 / 2_147_483_648.0 * 2.0 - 1.0) * (1.0 - i as f64 / length as f64).powi(3) * 0.18) as f32
            })
            .collect::<Vec<f32>>()
    };
    let left = make();
    let right = make();
    [left, right]
}

/// ConvolverNode normalization (normalize = true, the default), as Chromium computes it.
pub fn convolver_normalization(impulse: &[Vec<f32>], sample_rate: f64) -> f32 {
    const GAIN_CALIBRATION: f64 = 0.00125; // -58 dB
    const GAIN_CALIBRATION_SAMPLE_RATE: f64 = 44100.0;
    const MIN_POWER: f64 = 0.000125;
    let length = impulse.first().map_or(0, Vec::len).max(1);
    let power: f64 = impulse.iter().flat_map(|c| c.iter()).map(|v| (*v as f64) * (*v as f64)).sum();
    let mut power = (power / (impulse.len().max(1) * length) as f64).sqrt();
    if !power.is_finite() || power < MIN_POWER {
        power = MIN_POWER;
    }
    let mut scale = 1.0 / power * GAIN_CALIBRATION;
    scale *= GAIN_CALIBRATION_SAMPLE_RATE / sample_rate;
    scale as f32
}

/// Uniformly partitioned FFT convolution, one impulse per channel (left->left, right->right),
/// with one block of latency.
struct UniformConvolver {
    block: usize,
    fft: Arc<dyn realfft::RealToComplex<f32>>,
    ifft: Arc<dyn realfft::ComplexToReal<f32>>,
    /// [channel][partition] spectra of the impulse.
    filters: Vec<Vec<Vec<realfft::num_complex::Complex<f32>>>>,
    /// [channel][partition] spectra of past input blocks (ring).
    history: Vec<Vec<Vec<realfft::num_complex::Complex<f32>>>>,
    head: usize,
    input: [Vec<f32>; 2],
    overlap: [Vec<f32>; 2],
    output: [Vec<f32>; 2],
    filled: usize,
    scratch_time: Vec<f32>,
    scratch_freq: Vec<realfft::num_complex::Complex<f32>>,
    accumulator: Vec<realfft::num_complex::Complex<f32>>,
}

impl UniformConvolver {
    fn new(impulse: &[Vec<f32>; 2], block: usize) -> UniformConvolver {
        let mut planner = realfft::RealFftPlanner::<f32>::new();
        let size = block * 2;
        let fft = planner.plan_fft_forward(size);
        let ifft = planner.plan_fft_inverse(size);
        let partitions = impulse[0].len().div_ceil(block).max(1);
        let bins = size / 2 + 1;
        let filters = impulse
            .iter()
            .map(|channel| {
                (0..partitions)
                    .map(|p| {
                        let mut time = vec![0f32; size];
                        let start = p * block;
                        let end = (start + block).min(channel.len());
                        time[..end - start].copy_from_slice(&channel[start..end]);
                        let mut spectrum = fft.make_output_vec();
                        fft.process(&mut time, &mut spectrum).expect("fft size");
                        spectrum
                    })
                    .collect()
            })
            .collect();
        let zeros = vec![realfft::num_complex::Complex::new(0f32, 0f32); bins];
        UniformConvolver {
            block,
            history: (0..2).map(|_| vec![zeros.clone(); partitions]).collect(),
            filters,
            head: 0,
            input: [vec![0.0; block], vec![0.0; block]],
            overlap: [vec![0.0; block], vec![0.0; block]],
            output: [vec![0.0; block], vec![0.0; block]],
            filled: 0,
            scratch_time: vec![0.0; size],
            scratch_freq: zeros.clone(),
            accumulator: zeros,
            fft,
            ifft,
        }
    }

    /// One frame in, one frame out (lagging by one block).
    #[inline]
    fn next(&mut self, l: f32, r: f32) -> (f32, f32) {
        let out = (self.output[0][self.filled], self.output[1][self.filled]);
        self.input[0][self.filled] = l;
        self.input[1][self.filled] = r;
        self.filled += 1;
        if self.filled == self.block {
            self.filled = 0;
            self.run_block();
        }
        out
    }

    fn run_block(&mut self) {
        let block = self.block;
        let partitions = self.filters[0].len();
        self.head = (self.head + partitions - 1) % partitions;
        for c in 0..2 {
            self.scratch_time[..block].copy_from_slice(&self.input[c]);
            self.scratch_time[block..].fill(0.0);
            self.fft.process(&mut self.scratch_time, &mut self.history[c][self.head]).expect("fft size");
            self.accumulator.fill(realfft::num_complex::Complex::new(0.0, 0.0));
            for p in 0..partitions {
                let x = &self.history[c][(self.head + p) % partitions];
                let h = &self.filters[c][p];
                for ((acc, a), b) in self.accumulator.iter_mut().zip(x).zip(h) {
                    *acc += a * b;
                }
            }
            self.scratch_freq.copy_from_slice(&self.accumulator);
            // Real-signal spectra must have real DC and Nyquist bins for the inverse.
            self.scratch_freq[0].im = 0.0;
            let last = self.scratch_freq.len() - 1;
            self.scratch_freq[last].im = 0.0;
            self.ifft.process(&mut self.scratch_freq, &mut self.scratch_time).expect("fft size");
            let norm = 1.0 / (2 * block) as f32;
            for i in 0..block {
                self.output[c][i] = self.scratch_time[i] * norm + self.overlap[c][i];
                self.overlap[c][i] = self.scratch_time[block + i] * norm;
            }
        }
    }
}

/// Two-stage partitioned convolution: the first taps with small blocks (latency `block`),
/// the long tail with 2048-frame blocks whose one-block latency is hidden by starting the
/// tail at tap 2048 - `block`. Same output as one uniform convolver at a fraction of the
/// cost (the 1.8 s mixer reverb went from 25 % to a few % of a core).
pub struct Convolver {
    head: UniformConvolver,
    tail: Option<UniformConvolver>,
}

impl Convolver {
    pub const TAIL_BLOCK: usize = 2048;

    pub fn new(impulse: &[Vec<f32>; 2], block: usize) -> Convolver {
        let split = Self::TAIL_BLOCK.saturating_sub(block).max(block);
        let part = |range: std::ops::Range<usize>| -> [Vec<f32>; 2] {
            [0, 1].map(|c| impulse[c].get(range.clone()).map_or_else(Vec::new, |s| s.to_vec()))
        };
        let length = impulse[0].len().max(impulse[1].len());
        let mut head = part(0..split.min(length));
        if head[0].is_empty() {
            head = [vec![0.0], vec![0.0]];
        }
        let tail = (length > split && block < Self::TAIL_BLOCK).then(|| UniformConvolver::new(&part(split..length), Self::TAIL_BLOCK));
        Convolver { head: UniformConvolver::new(&head, block), tail }
    }

    /// Output lags input by `block` frames.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for i in 0..left.len() {
            let (l, r) = (left[i], right[i]);
            let (mut ol, mut or) = self.head.next(l, r);
            if let Some(tail) = &mut self.tail {
                let (tl, tr) = tail.next(l, r);
                ol += tl;
                or += tr;
            }
            left[i] = ol;
            right[i] = or;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peaking_eq_boosts_its_band_and_leaves_far_frequencies() {
        let rate = 48000.0;
        let gain_at = |freq: f64| {
            let mut f = Biquad::new(FilterKind::Peaking, 1200.0, 1.0, 12.0, rate);
            let mut peak = 0f32;
            for i in 0..48000 {
                let y = f.process(0, (2.0 * PI * freq * i as f64 / rate).sin() as f32);
                if i > 24000 {
                    peak = peak.max(y.abs());
                }
            }
            20.0 * peak.log10()
        };
        assert!((gain_at(1200.0) - 12.0).abs() < 0.1);
        assert!(gain_at(60.0).abs() < 0.5);
    }

    #[test]
    fn delay_echoes_like_webaudio_feedback() {
        // Chromium at 48 kHz: echoes at 14400, 28928, 43456 with 1, 0.3, 0.09.
        let mut d = Delay::new(48000.0, 1.0);
        let (mut l, mut r) = (vec![0f32; 48000], vec![0f32; 48000]);
        l[0] = 1.0;
        d.process(&mut l, &mut r);
        let echoes: Vec<(usize, f32)> = l.iter().enumerate().filter(|(_, v)| v.abs() > 1e-4).map(|(i, v)| (i, *v)).collect();
        assert_eq!(echoes.iter().map(|e| e.0).collect::<Vec<_>>(), vec![0, 14400, 28928, 43456]);
        assert!((echoes[2].1 - 0.3).abs() < 1e-6 && (echoes[3].1 - 0.09).abs() < 1e-6);
        assert!(r.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn convolver_matches_direct_convolution() {
        let impulse = [vec![1.0, 0.5, 0.25, 0.0, -0.5, 0.1, 0.0, 0.2, 0.3], vec![0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]];
        let mut conv = Convolver::new(&impulse, 4);
        let input: Vec<f32> = (0..40).map(|i| ((i * 7 % 11) as f32 - 5.0) / 5.0).collect();
        let (mut l, mut r) = (input.clone(), input.clone());
        conv.process(&mut l, &mut r);
        for n in 4..40 {
            let expected: f32 = (0..impulse[0].len()).filter(|k| *k <= n - 4).map(|k| impulse[0][k] * input[n - 4 - k]).sum();
            assert!((l[n] - expected).abs() < 1e-4, "{n}: {} vs {expected}", l[n]);
            assert!((r[n] - if n >= 5 { input[n - 5] } else { 0.0 }).abs() < 1e-4);
        }
    }

    #[test]
    fn two_stage_convolver_matches_direct_convolution_across_the_split() {
        // An impulse longer than the head (2048 - 128 taps) exercises the tail stage.
        let n = 5000;
        let impulse = [(0..n).map(|i| ((i * 13 % 17) as f32 - 8.0) / 80.0).collect::<Vec<f32>>(), vec![0.0; n]];
        let mut conv = Convolver::new(&impulse, 128);
        let input: Vec<f32> = (0..9000).map(|i| ((i * 7 % 11) as f32 - 5.0) / 5.0).collect();
        let (mut l, mut r) = (input.clone(), input.clone());
        conv.process(&mut l, &mut r);
        for out in [130usize, 1919, 2047, 2200, 4100, 7000, 8999] {
            let lagged = out - 128;
            let expected: f32 = (0..n.min(lagged + 1)).map(|k| impulse[0][k] * input[lagged - k]).sum();
            assert!((l[out] - expected).abs() < 1e-3, "{out}: {} vs {expected}", l[out]);
            assert!(r[out].abs() < 1e-4);
        }
    }

    #[test]
    fn stereo_pan_follows_the_spec() {
        let (mut l, mut r) = (vec![1.0f32], vec![1.0f32]);
        stereo_pan(-1.0, &mut l, &mut r);
        assert!((l[0] - 2.0).abs() < 1e-6 && r[0].abs() < 1e-6);
        let (mut l, mut r) = (vec![1.0f32], vec![1.0f32]);
        stereo_pan(0.0, &mut l, &mut r);
        assert!((l[0] - 1.0).abs() < 1e-6 && (r[0] - 1.0).abs() < 1e-6);
    }
}
