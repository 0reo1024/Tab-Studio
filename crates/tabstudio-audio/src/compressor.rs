//! DynamicsCompressorNode as Chromium implements it (DynamicsCompressorKernel): a static
//! curve (linear, exponential knee, constant ratio), automatic makeup gain
//! (full-range gain)^-0.6, a 6 ms look-ahead, a detector with fast release and an adaptive
//! release envelope recomputed every 32 frames. The mixer uses it for the track compressor
//! and the master limiter, so the native mix keeps the same loudness.
const PRE_DELAY_SIZE: usize = 1024;
const DIVISION: usize = 32;

fn db_to_lin(db: f32) -> f32 {
    10f32.powf(0.05 * db)
}
fn lin_to_db(x: f32) -> f32 {
    20.0 * x.log10()
}

pub struct Compressor {
    sample_rate: f32,
    threshold_db: f32,
    knee_db: f32,
    attack: f32,
    release: f32,
    linear_threshold: f32,
    slope: f32,
    knee_threshold: f32,
    knee_threshold_db: f32,
    y_knee_threshold_db: f32,
    k: f32,
    makeup: f32,
    release_poly: [f32; 5],
    detector_average: f32,
    compressor_gain: f32,
    max_attack_diff_db: f32,
    pre_delay: [Vec<f32>; 2],
    read: usize,
    write: usize,
    division: usize,
    envelope_rate: f32,
    scaled_desired_gain: f32,
}

impl Compressor {
    /// WebAudio defaults: threshold -24 dB, knee 30 dB, ratio 12, attack 0.003 s, release 0.25 s.
    pub fn new(sample_rate: f64, threshold_db: f32, knee_db: f32, ratio: f32, attack: f32, release: f32) -> Compressor {
        let pre_delay_frames = ((0.006 * sample_rate) as usize).min(PRE_DELAY_SIZE - 1);
        let mut c = Compressor {
            sample_rate: sample_rate as f32,
            threshold_db,
            knee_db,
            attack,
            release,
            linear_threshold: 1.0,
            slope: 1.0,
            knee_threshold: 1.0,
            knee_threshold_db: 0.0,
            y_knee_threshold_db: 0.0,
            k: 1.0,
            makeup: 1.0,
            release_poly: [0.0; 5],
            detector_average: 0.0,
            compressor_gain: 1.0,
            max_attack_diff_db: -1.0,
            pre_delay: [vec![0.0; PRE_DELAY_SIZE], vec![0.0; PRE_DELAY_SIZE]],
            read: 0,
            write: pre_delay_frames,
            division: 0,
            envelope_rate: 1.0,
            scaled_desired_gain: 1.0,
        };
        c.set_curve(threshold_db, knee_db, ratio);
        c
    }

    pub fn set_curve(&mut self, threshold_db: f32, knee_db: f32, ratio: f32) {
        self.threshold_db = threshold_db;
        self.knee_db = knee_db;
        self.linear_threshold = db_to_lin(threshold_db);
        self.slope = 1.0 / ratio;
        self.k = self.k_at_slope(1.0 / ratio);
        self.knee_threshold_db = threshold_db + knee_db;
        self.knee_threshold = db_to_lin(self.knee_threshold_db);
        self.y_knee_threshold_db = lin_to_db(self.knee_curve(self.knee_threshold, self.k));
        self.makeup = (1.0 / self.saturate(1.0, self.k)).powf(0.6);
        // Adaptive release: a 4th order polynomial through four release zones.
        let frames = self.sample_rate * self.release;
        let y = [0.09f32, 0.16, 0.42, 0.98].map(|zone| frames * zone);
        self.release_poly = [
            0.999_999_999_999_999_8 * y[0] + 1.843_221_968_432_392_3e-16 * y[1] - 1.937_339_435_167_642_3e-16 * y[2] + 8.824_516_011_816_245e-18 * y[3],
            -1.578_832_035_284_588_8 * y[0] + 2.330_583_703_207_428_6 * y[1] - 0.914_119_420_484_042_9 * y[2] + 0.162_367_752_561_203_2 * y[3],
            0.533_414_286_910_642_4 * y[0] - 1.272_736_789_213_631 * y[1] + 0.925_885_604_220_751_2 * y[2] - 0.186_563_101_917_762_26 * y[3],
            0.087_834_631_382_072_34 * y[0] - 0.169_416_296_792_562_2 * y[1] + 0.085_880_579_515_952_72 * y[2] - 0.004_298_914_105_462_83 * y[3],
            -0.042_416_883_008_123_074 * y[0] + 0.111_569_382_798_760_2 * y[1] - 0.097_646_763_252_658_72 * y[2] + 0.028_494_263_462_021_576 * y[3],
        ];
    }

    fn knee_curve(&self, x: f32, k: f32) -> f32 {
        if x < self.linear_threshold {
            return x;
        }
        self.linear_threshold + (1.0 - (-k * (x - self.linear_threshold)).exp()) / k
    }

    fn saturate(&self, x: f32, k: f32) -> f32 {
        if x < self.knee_threshold {
            self.knee_curve(x, k)
        } else {
            db_to_lin(self.y_knee_threshold_db + self.slope * (lin_to_db(x) - self.knee_threshold_db))
        }
    }

    fn slope_at(&self, x: f32, k: f32) -> f32 {
        if x < self.linear_threshold {
            return 1.0;
        }
        let x2 = x * 1.001;
        let (x_db, x2_db) = (lin_to_db(x), lin_to_db(x2));
        let (y_db, y2_db) = (lin_to_db(self.knee_curve(x, k)), lin_to_db(self.knee_curve(x2, k)));
        (y2_db - y_db) / (x2_db - x_db)
    }

    fn k_at_slope(&self, desired: f32) -> f32 {
        let x = db_to_lin(self.threshold_db + self.knee_db);
        let (mut min_k, mut max_k, mut k) = (0.1f32, 10000f32, 5f32);
        for _ in 0..15 {
            if self.slope_at(x, k) < desired {
                max_k = k;
            } else {
                min_k = k;
            }
            k = (min_k * max_k).sqrt();
        }
        k
    }

    fn update_envelope(&mut self) {
        if !self.detector_average.is_finite() {
            self.detector_average = 1.0;
        }
        let scaled = self.detector_average.asin() / std::f32::consts::FRAC_PI_2;
        self.scaled_desired_gain = scaled;
        let releasing = scaled > self.compressor_gain;
        let mut diff_db = lin_to_db(self.compressor_gain / scaled);
        if releasing {
            self.max_attack_diff_db = -1.0;
            if !diff_db.is_finite() {
                diff_db = -1.0;
            }
            let x = 0.25 * (diff_db.clamp(-12.0, 0.0) + 12.0);
            let [a, b, c, d, e] = self.release_poly;
            let frames = a + b * x + c * x * x + d * x * x * x + e * x * x * x * x;
            self.envelope_rate = db_to_lin(5.0 / frames);
        } else {
            if !diff_db.is_finite() {
                diff_db = 1.0;
            }
            if self.max_attack_diff_db == -1.0 || self.max_attack_diff_db < diff_db {
                self.max_attack_diff_db = diff_db;
            }
            let effective = self.max_attack_diff_db.max(0.5);
            let attack_frames = self.attack.max(0.001) * self.sample_rate;
            self.envelope_rate = 1.0 - (0.25 / effective).powf(1.0 / attack_frames);
        }
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let sat_release_frames = 0.0025 * self.sample_rate;
        for i in 0..left.len() {
            if self.division == 0 {
                self.update_envelope();
            }
            self.division = (self.division + 1) % DIVISION;
            let (l, r) = (left[i], right[i]);
            self.pre_delay[0][self.write] = l;
            self.pre_delay[1][self.write] = r;
            let input = l.abs().max(r.abs());
            let shaped = self.saturate(input, self.k);
            let attenuation = if input <= 0.0001 { 1.0 } else { shaped / input };
            let attenuation_db = (-lin_to_db(attenuation)).max(2.0);
            let sat_release_rate = db_to_lin(attenuation_db / sat_release_frames) - 1.0;
            let rate = if attenuation > self.detector_average { sat_release_rate } else { 1.0 };
            self.detector_average = (self.detector_average + (attenuation - self.detector_average) * rate).min(1.0);
            if !self.detector_average.is_finite() {
                self.detector_average = 1.0;
            }
            if self.envelope_rate < 1.0 {
                self.compressor_gain += (self.scaled_desired_gain - self.compressor_gain) * self.envelope_rate;
            } else {
                self.compressor_gain = (self.compressor_gain * self.envelope_rate).min(1.0);
            }
            let gain = self.makeup * (std::f32::consts::FRAC_PI_2 * self.compressor_gain).sin();
            left[i] = self.pre_delay[0][self.read] * gain;
            right[i] = self.pre_delay[1][self.read] * gain;
            self.read = (self.read + 1) % PRE_DELAY_SIZE;
            self.write = (self.write + 1) % PRE_DELAY_SIZE;
        }
    }
}
