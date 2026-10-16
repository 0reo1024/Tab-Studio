//! Backing tracks: an audio file (MP3, AAC/M4A, FLAC, WAV, AIFF, Ogg Vorbis) played in time
//! with the song. The file is decoded once on a control thread, resampled to the device rate
//! and kept in memory as 16-bit stereo, so every seek, loop wrap and count-in start lands on
//! its exact sample (no container seeking, no MP3 seek tables). The audio thread reads it at
//! `offset + song position`: straight from memory at speed 1, through Signalsmith Stretch
//! (time stretch without a pitch change, and pitch shift) otherwise.
//!
//! Real-time rules as elsewhere: `Backing::new` allocates (stretcher, scratch buffers) on the
//! control side; `render` never allocates.
use std::path::Path;
use std::sync::Arc;

use signalsmith_stretch::Stretch;

/// Waveform resolution: one peak per 10 ms.
pub const PEAKS_PER_SECOND: usize = 100;
/// Longest file accepted (16-bit stereo at 48 kHz: about 350 MB).
pub const MAX_SECONDS: f64 = 30.0 * 60.0;
/// The loudness backing tracks are leveled to (LUFS): about where the GM and DI tracks sit,
/// so a mastered recording (often -8 LUFS) does not drive the master limiter.
pub const TARGET_LUFS: f64 = -16.0;
/// Crossfade on jumps (seek, loop wrap, speed change) and the fade at pause, in frames.
const FADE: usize = 256;
/// Largest input per block: the player's top speed (4x) of the largest block.
const MAX_INPUT: usize = crate::engine::MAX_BLOCK * 4;

/// A decoded file at the engine rate, interleaved stereo.
pub struct BackingAudio {
    pub samples: Vec<i16>,
    pub rate: u32,
    /// The file's own rate and channel count, for display.
    pub source_rate: u32,
    pub source_channels: usize,
    pub codec: String,
    /// Integrated loudness (ITU-R BS.1770), None for silence.
    pub lufs: Option<f64>,
    /// Peak per 1/PEAKS_PER_SECOND s, 0..255 (linear).
    pub peaks: Vec<u8>,
}

impl BackingAudio {
    pub fn frames(&self) -> usize {
        self.samples.len() / 2
    }
    pub fn seconds(&self) -> f64 {
        self.frames() as f64 / self.rate as f64
    }
    /// The gain that brings the file to TARGET_LUFS (dB, clamped).
    pub fn trim_db(&self) -> f64 {
        self.lufs.map_or(0.0, |l| (TARGET_LUFS - l).clamp(-24.0, 12.0))
    }
}

/// Decodes `path` and resamples it to `rate`.
pub fn decode_file(path: &Path, rate: u32) -> Result<BackingAudio, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("ファイルを開けません：{e}"))?;
    let extension = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    decode(Box::new(file), extension.as_deref(), rate)
}

/// Decodes a stream (`extension` helps the format probe).
pub fn decode(source: Box<dyn symphonia::core::io::MediaSource>, extension: Option<&str>, rate: u32) -> Result<BackingAudio, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{CODEC_TYPE_NULL, DecoderOptions};
    use symphonia::core::errors::Error;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    if matches!(extension, Some("opus" | "webm" | "mkv" | "wma")) {
        return Err(format!("{}形式には対応していません。MP3・M4A(AAC)・FLAC・WAVなどに変換してください。", extension.unwrap_or("").to_uppercase()));
    }
    let stream = MediaSourceStream::new(source, Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = extension {
        hint.with_extension(extension);
    }
    // Gapless: MP3/AAC encoder delay and padding are trimmed, so the audio starts where the
    // music starts (25-50 ms otherwise) and a saved offset survives a re-encode.
    let options = FormatOptions { enable_gapless: true, ..Default::default() };
    let probed = symphonia::default::get_probe().format(&hint, stream, &options, &MetadataOptions::default()).map_err(|e| format!("音声ファイルとして読み込めません（{e}）。"))?;
    let mut format = probed.format;
    let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or("音声トラックがありません。")?;
    let (track_id, params) = (track.id, track.codec_params.clone());
    let codec = symphonia::default::get_codecs().get_codec(params.codec).map_or("?".to_string(), |c| c.short_name.to_string());
    let mut decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).map_err(|e| format!("この音声形式（{codec}）には対応していません（{e}）。"))?;
    let source_rate = params.sample_rate.ok_or("サンプルレートが不明です。")?;
    let mut channels = params.channels.map_or(0, |c| c.count());
    let (mut left, mut right) = (Vec::new(), Vec::new());
    let limit = (MAX_SECONDS * source_rate as f64) as usize;
    let mut buffer: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(format!("読み込み中にエラーが発生しました（{e}）。")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // A damaged frame is skipped, as players do.
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(format!("デコードできません（{e}）。")),
        };
        let spec = *decoded.spec();
        channels = spec.channels.count();
        let needed = decoded.capacity() as u64;
        if buffer.as_ref().is_none_or(|b| (b.capacity() as u64) < needed) {
            buffer = Some(SampleBuffer::new(needed, spec));
        }
        let buffer = buffer.as_mut().unwrap();
        buffer.copy_interleaved_ref(decoded);
        let samples = buffer.samples();
        for frame in samples.chunks_exact(channels.max(1)) {
            // Mono plays on both sides; surround keeps its front pair.
            let (l, r) = if frame.len() == 1 { (frame[0], frame[0]) } else { (frame[0], frame[1]) };
            left.push(l);
            right.push(r);
        }
        if left.len() > limit {
            return Err(format!("{}分を超える音声には対応していません。", (MAX_SECONDS / 60.0) as u32));
        }
    }
    if left.is_empty() {
        return Err("音声データがありません。".into());
    }
    let (left, right) = if source_rate == rate { (left, right) } else { resample(left, right, source_rate, rate)? };
    let lufs = integrated_loudness(&left, &right, rate as f64);
    let bin = (rate as usize / PEAKS_PER_SECOND).max(1);
    let peaks = left.chunks(bin).zip(right.chunks(bin)).map(|(l, r)| (l.iter().chain(r).fold(0f32, |m, v| m.max(v.abs())).min(1.0) * 255.0).round() as u8).collect();
    let samples = left.iter().zip(&right).flat_map(|(l, r)| [to_i16(*l), to_i16(*r)]).collect();
    Ok(BackingAudio { samples, rate, source_rate, source_channels: channels, codec, lufs, peaks })
}

fn to_i16(v: f32) -> i16 {
    (v.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

/// Band-limited resampling (rubato's FFT resampler), delay removed, length rate-scaled.
fn resample(left: Vec<f32>, right: Vec<f32>, from: u32, to: u32) -> Result<(Vec<f32>, Vec<f32>), String> {
    use rubato::{FftFixedInOut, Resampler};
    let mut resampler = FftFixedInOut::<f32>::new(from as usize, to as usize, 1024, 2).map_err(|e| e.to_string())?;
    let delay = resampler.output_delay();
    let expected = (left.len() as f64 * to as f64 / from as f64).round() as usize;
    let chunk = resampler.input_frames_next();
    let (mut out_l, mut out_r) = (Vec::with_capacity(expected + chunk * 2), Vec::with_capacity(expected + chunk * 2));
    let mut input = vec![vec![0f32; chunk]; 2];
    let mut at = 0;
    // Feed until the delayed output covers the whole file (zeros past the end).
    while out_l.len() < expected + delay {
        for (channel, source) in input.iter_mut().zip([&left, &right]) {
            for (i, v) in channel.iter_mut().enumerate() {
                *v = source.get(at + i).copied().unwrap_or(0.0);
            }
        }
        at += chunk;
        let output = resampler.process(&input, None).map_err(|e| e.to_string())?;
        out_l.extend_from_slice(&output[0]);
        out_r.extend_from_slice(&output[1]);
    }
    out_l.drain(..delay);
    out_r.drain(..delay);
    out_l.truncate(expected);
    out_r.truncate(expected);
    Ok((out_l, out_r))
}

/// ITU-R BS.1770-4 integrated loudness: K-weighting, 400 ms blocks with 75 % overlap,
/// the -70 LUFS absolute and -10 LU relative gates.
pub fn integrated_loudness(left: &[f32], right: &[f32], rate: f64) -> Option<f64> {
    // K-weighting: a high shelf (+4 dB above ~1.7 kHz) then a ~38 Hz high pass.
    let shelf = {
        let (f0, gain, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
        let k = (std::f64::consts::PI * f0 / rate).tan();
        let (vh, vb) = (10f64.powf(gain / 20.0), 10f64.powf(gain / 20.0).powf(0.4996667741545416));
        let a0 = 1.0 + k / q + k * k;
        ([(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0], [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0])
    };
    let high_pass = {
        let (f0, q) = (38.13547087602444, 0.5003270373238773);
        let k = (std::f64::consts::PI * f0 / rate).tan();
        let a0 = 1.0 + k / q + k * k;
        ([1.0, -2.0, 1.0], [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0])
    };
    let weighted = |x: &[f32]| -> Vec<f64> {
        let mut out: Vec<f64> = x.iter().map(|&v| v as f64).collect();
        for (b, a) in [shelf, high_pass] {
            let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
            for v in out.iter_mut() {
                let y = b[0] * *v + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
                (x2, x1, y2, y1) = (x1, *v, y1, y);
                *v = y;
            }
        }
        out
    };
    let (l, r) = (weighted(left), weighted(right));
    let (block, hop) = ((0.4 * rate) as usize, (0.1 * rate) as usize);
    if l.len() < block || hop == 0 {
        return None;
    }
    let energies: Vec<f64> = (0..=(l.len() - block) / hop)
        .map(|i| {
            let range = i * hop..i * hop + block;
            (l[range.clone()].iter().map(|v| v * v).sum::<f64>() + r[range].iter().map(|v| v * v).sum::<f64>()) / block as f64
        })
        .collect();
    let loudness = |z: f64| -0.691 + 10.0 * z.log10();
    let gated = |threshold: f64| -> Option<f64> {
        let kept: Vec<f64> = energies.iter().copied().filter(|&z| z > 0.0 && loudness(z) > threshold).collect();
        (!kept.is_empty()).then(|| kept.iter().sum::<f64>() / kept.len() as f64)
    };
    let relative = loudness(gated(-70.0)?) - 10.0;
    gated(relative).map(loudness)
}

/// The backing strip and its alignment (applied on the audio thread).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BackingMix {
    /// Linear fader gain (1 = unity), on top of the loudness trim.
    pub gain: f32,
    pub mute: bool,
    pub solo: bool,
    /// Where the score's start lies in the file (seconds; negative: the file starts later).
    pub offset: f64,
    /// Pitch shift in semitones (playback keeps its tempo).
    pub semitones: f32,
    /// Fine tempo trim: the file runs at `rate` x the song speed (recordings that drift).
    pub rate: f64,
    /// Level the file to TARGET_LUFS.
    pub normalize: bool,
    /// Plays with the song (offset/rate apply); otherwise on its own transport.
    pub linked: bool,
    /// The speed on its own transport (time stretched, the pitch kept).
    pub speed: f64,
}

impl Default for BackingMix {
    fn default() -> Self {
        BackingMix { gain: 1.0, mute: false, solo: false, offset: 0.0, semitones: 0.0, rate: 1.0, normalize: true, linked: true, speed: 1.0 }
    }
}

/// The file's own transport (when not linked to the song).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BackingTransport {
    Play,
    Pause,
    /// Seconds of the file.
    Seek(f64),
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    /// Straight from memory (speed 1, no pitch shift): sample exact, no latency.
    Direct,
    Stretch { speed: f64, semitones: f32 },
}

/// The real-time player of a decoded file.
pub struct Backing {
    pub audio: Arc<BackingAudio>,
    stretch: Stretch,
    mix: BackingMix,
    trim: f32,
    mode: Mode,
    /// Whether the last segment played (a later start or jump crossfades from it).
    playing: bool,
    /// The song position expected at the next segment while continuous.
    expected: f64,
    /// Direct mode: the next source frame heard.
    read: i64,
    /// Stretch mode: the next source frame fed, and the fractional input carry.
    feed: i64,
    carry: f64,
    /// Frames left of the fade-in after a jump.
    fade_in: usize,
    /// Its own transport: playing, and the file position (seconds) of the next frame.
    own_playing: bool,
    own_position: f64,
    /// The file position heard last (seconds), for the UI.
    heard: f64,
    input: Vec<f32>,
    output: Vec<f32>,
    fade: [Vec<f32>; 2],
}

impl Backing {
    /// Builds the player (allocates; control thread).
    pub fn new(audio: Arc<BackingAudio>, mix: BackingMix) -> Box<Backing> {
        let stretch = Stretch::preset_default(2, audio.rate);
        let preroll = Self::preroll(&stretch);
        let trim = 10f64.powf(audio.trim_db() / 20.0) as f32;
        Box::new(Backing {
            audio,
            stretch,
            mix,
            trim,
            mode: Mode::Direct,
            playing: false,
            expected: 0.0,
            read: 0,
            feed: 0,
            carry: 0.0,
            fade_in: 0,
            own_playing: false,
            own_position: 0.0,
            heard: 0.0,
            input: vec![0.0; 2 * (MAX_INPUT + preroll + FADE * 4)],
            output: vec![0.0; 2 * crate::engine::MAX_BLOCK.max(FADE)],
            fade: [vec![0.0; FADE], vec![0.0; FADE]],
        })
    }

    fn preroll(stretch: &Stretch) -> usize {
        stretch.input_latency() * 2
    }

    pub fn mix(&self) -> BackingMix {
        self.mix
    }

    pub fn set_mix(&mut self, mix: BackingMix) {
        if self.mix.linked && !mix.linked {
            // Unlinked: its own transport stands where the song left it.
            self.own_playing = false;
            self.own_position = self.heard.clamp(0.0, self.audio.seconds());
        }
        self.mix = mix;
    }

    pub fn transport(&mut self, command: BackingTransport) {
        match command {
            BackingTransport::Play => {
                if self.own_position >= self.audio.seconds() - 0.01 {
                    self.own_position = 0.0;
                }
                self.own_playing = true;
            }
            BackingTransport::Pause => self.own_playing = false,
            BackingTransport::Seek(seconds) => self.own_position = seconds.clamp(0.0, self.audio.seconds()),
        }
        if !self.own_playing {
            self.heard = self.own_position;
        }
    }

    /// Whether it plays on its own transport.
    pub fn own_playing(&self) -> bool {
        !self.mix.linked && self.own_playing
    }

    /// The file position heard last (seconds).
    pub fn heard(&self) -> f64 {
        self.heard
    }

    /// Renders a block on its own transport; stops at the end of the file.
    pub fn render_own(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len().min(right.len());
        let speed = self.mix.speed.clamp(0.25, 4.0);
        let at = self.own_playing.then_some(self.own_position);
        self.render_source(left, right, at, speed);
        if self.own_playing {
            self.own_position += n as f64 * speed / self.audio.rate as f64;
            if self.own_position >= self.audio.seconds() {
                self.own_playing = false;
                self.own_position = self.audio.seconds();
            }
        }
    }

    /// The strip gain: fader x loudness trim, 0 when muted.
    pub fn gain(&self) -> f32 {
        if self.mix.mute { 0.0 } else { self.mix.gain * if self.mix.normalize { self.trim } else { 1.0 } }
    }

    /// Source frames ahead of what is heard that the stretcher must be fed (its input and
    /// output latency; the output latency counts in output frames, so at `speed` source frames).
    fn lead(&self, speed: f64) -> i64 {
        (self.stretch.input_latency() as f64 + self.stretch.output_latency() as f64 * speed).round() as i64
    }

    fn mode_for(&self, speed: f64) -> Mode {
        if (speed - 1.0).abs() < 1e-9 && self.mix.semitones == 0.0 { Mode::Direct } else { Mode::Stretch { speed, semitones: self.mix.semitones } }
    }

    /// Renders one transport segment of the song into `left`/`right` (overwritten). `at`: the
    /// song position at its first frame while the song plays (None: stopped); `speed`: the song
    /// speed. The file runs at `mix.rate` x song time from `offset`.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32], at: Option<f64>, speed: f64) {
        let (offset, rate) = (self.mix.offset, self.mix.rate);
        self.render_source(left, right, at.map(|p| offset + p * rate), speed * rate);
    }

    /// Renders from a file position (seconds) at `speed` (None: stopped).
    fn render_source(&mut self, left: &mut [f32], right: &mut [f32], at: Option<f64>, speed: f64) {
        let n = left.len().min(right.len());
        left[..n].fill(0.0);
        right[..n].fill(0.0);
        if n == 0 {
            return;
        }
        let Some(position) = at else {
            if self.playing {
                // Paused or stopped: the sound fades instead of cutting off.
                self.fade_out(left, right);
                self.playing = false;
            }
            return;
        };
        let rate = self.audio.rate as f64;
        let mode = self.mode_for(speed);
        let continuous = self.playing && self.mode == mode && (position - self.expected).abs() < 2.0 / rate;
        if !continuous {
            if self.playing {
                self.fade_out(left, right);
            }
            self.start(position * rate, mode);
            self.fade_in = FADE;
        }
        self.stream(left, right, n);
        self.playing = true;
        self.expected = position + n as f64 * speed / rate;
        self.heard = self.expected;
    }

    /// The current stream's next FADE frames, faded out, added to the output.
    fn fade_out(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = FADE.min(left.len());
        let [mut fl, mut fr] = std::mem::take(&mut self.fade);
        self.stream(&mut fl[..n], &mut fr[..n], n);
        for i in 0..n {
            let g = 1.0 - (i as f32 + 1.0) / n as f32;
            left[i] += fl[i] * g;
            right[i] += fr[i] * g;
        }
        self.fade = [fl, fr];
    }

    /// Starts reading at a source frame (fractional).
    fn start(&mut self, source: f64, mode: Mode) {
        self.mode = mode;
        match mode {
            Mode::Direct => self.read = source.round() as i64,
            Mode::Stretch { speed, semitones } => {
                self.stretch.reset();
                self.stretch.set_transpose_factor_semitones(semitones, None);
                self.feed = source.round() as i64 + self.lead(speed);
                self.carry = 0.0;
                // Pre-roll: the stretcher hears what leads up to the new position, so the first
                // output is already the music there.
                let preroll = Self::preroll(&self.stretch);
                self.fill_input(self.feed - preroll as i64, preroll);
                self.stretch.seek(&self.input[..preroll * 2], speed);
            }
        }
    }

    /// Copies `frames` source frames from `from` into the input scratch (silence outside the file).
    fn fill_input(&mut self, from: i64, frames: usize) {
        let samples = &self.audio.samples;
        let total = (samples.len() / 2) as i64;
        for i in 0..frames {
            let at = from + i as i64;
            let (l, r) = if at >= 0 && at < total { (samples[at as usize * 2], samples[at as usize * 2 + 1]) } else { (0, 0) };
            self.input[i * 2] = l as f32 / 32768.0;
            self.input[i * 2 + 1] = r as f32 / 32768.0;
        }
    }

    /// Adds the next `n` frames of the stream (with any pending fade-in) to the output.
    fn stream(&mut self, left: &mut [f32], right: &mut [f32], n: usize) {
        match self.mode {
            Mode::Direct => {
                let samples = &self.audio.samples;
                let total = (samples.len() / 2) as i64;
                for i in 0..n {
                    let at = self.read + i as i64;
                    if at >= 0 && at < total {
                        left[i] = samples[at as usize * 2] as f32 / 32768.0;
                        right[i] = samples[at as usize * 2 + 1] as f32 / 32768.0;
                    } else {
                        left[i] = 0.0;
                        right[i] = 0.0;
                    }
                }
                self.read += n as i64;
            }
            Mode::Stretch { speed, .. } => {
                let mut done = 0;
                while done < n {
                    let frames = (n - done).min(self.output.len() / 2);
                    let wanted = self.carry + frames as f64 * speed;
                    let take = (wanted.floor() as usize).min(MAX_INPUT);
                    self.carry = wanted - take as f64;
                    self.fill_input(self.feed, take);
                    self.feed += take as i64;
                    self.stretch.process(&self.input[..take * 2], &mut self.output[..frames * 2]);
                    for i in 0..frames {
                        left[done + i] = self.output[i * 2];
                        right[done + i] = self.output[i * 2 + 1];
                    }
                    done += frames;
                }
            }
        }
        if self.fade_in > 0 {
            for i in 0..n.min(self.fade_in) {
                let g = (FADE - self.fade_in + i + 1) as f32 / FADE as f32;
                left[i] *= g;
                right[i] *= g;
            }
            self.fade_in -= n.min(self.fade_in);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48000;

    /// A file of clicks (one-sample impulses) every `every` frames, `seconds` long.
    fn clicks(seconds: f64, every: usize) -> Arc<BackingAudio> {
        let frames = (seconds * RATE as f64) as usize;
        let mut samples = vec![0i16; frames * 2];
        for at in (0..frames).step_by(every) {
            samples[at * 2] = 16000;
            samples[at * 2 + 1] = 16000;
        }
        Arc::new(BackingAudio { samples, rate: RATE, source_rate: RATE, source_channels: 2, codec: "test".into(), lufs: None, peaks: Vec::new() })
    }

    /// A tone whose phase tells the source position: sin(2 pi f t).
    fn tone(seconds: f64, frequency: f64) -> Arc<BackingAudio> {
        let frames = (seconds * RATE as f64) as usize;
        let samples = (0..frames).flat_map(|i| {
            let v = ((i as f64 / RATE as f64 * frequency * std::f64::consts::TAU).sin() * 16000.0) as i16;
            [v, v]
        });
        Arc::new(BackingAudio { samples: samples.collect(), rate: RATE, source_rate: RATE, source_channels: 2, codec: "test".into(), lufs: None, peaks: Vec::new() })
    }

    fn play(backing: &mut Backing, from: f64, speed: f64, frames: usize, block: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let (mut l, mut r) = (vec![0f32; block], vec![0f32; block]);
        let mut position = from;
        while out.len() < frames {
            backing.render(&mut l, &mut r, Some(position), speed);
            out.extend_from_slice(&l);
            position += block as f64 * speed / RATE as f64;
        }
        out.truncate(frames);
        out
    }

    #[test]
    fn speed_one_reads_the_file_sample_exactly_at_offset_plus_position() {
        let audio = clicks(4.0, 4800);
        let mut backing = Backing::new(audio.clone(), BackingMix { offset: 0.5, ..Default::default() });
        // Song 0.25 s + offset 0.5 s = file 0.75 s: clicks at 0.8, 0.9, ... (frame 2400, 7200, ...).
        let out = play(&mut backing, 0.25, 1.0, 24000, 480);
        let onsets: Vec<usize> = out.iter().enumerate().filter(|(_, v)| v.abs() > 0.1).map(|(i, _)| i).collect();
        assert_eq!(&onsets[..3], &[2400, 7200, 12000]);
        // A jump (seek) lands exactly too; the first frames fade in, so check a later click.
        let mut l = vec![0f32; 9600];
        let mut r = vec![0f32; 9600];
        backing.render(&mut l, &mut r, Some(1.0), 1.0);
        let onsets: Vec<usize> = l.iter().enumerate().filter(|(_, v)| v.abs() > 0.1).map(|(i, _)| i).collect();
        assert_eq!(onsets, vec![4800]);
    }

    #[test]
    fn a_tempo_trim_scales_the_file_position() {
        // The file runs 2 % faster than the song: song 10 s is file 0.5 + 10.2 s.
        let audio = clicks(20.0, 48);
        let mut backing = Backing::new(audio, BackingMix { offset: 0.5, rate: 1.02, ..Default::default() });
        let (mut l, mut r) = (vec![0f32; 480], vec![0f32; 480]);
        backing.render(&mut l, &mut r, Some(10.0), 1.0);
        assert!(matches!(backing.mode, Mode::Stretch { speed, .. } if (speed - 1.02).abs() < 1e-12));
        let heard = backing.feed - backing.lead(1.02) - 480 * 102 / 100;
        assert!((heard - (10.7 * RATE as f64) as i64).abs() <= 1, "{heard}");
    }

    #[test]
    fn on_its_own_transport_it_plays_seeks_and_stops_at_the_end() {
        let audio = clicks(1.0, 4800);
        let mut backing = Backing::new(audio, BackingMix { linked: false, ..Default::default() });
        let (mut l, mut r) = (vec![0f32; 4800], vec![0f32; 4800]);
        backing.render_own(&mut l, &mut r);
        assert!(l.iter().all(|v| *v == 0.0), "paused");
        backing.transport(BackingTransport::Seek(0.45));
        backing.transport(BackingTransport::Play);
        backing.render_own(&mut l, &mut r);
        // From 0.45 s: the click at 0.5 s comes 2400 frames in.
        let onsets: Vec<usize> = l.iter().enumerate().filter(|(_, v)| v.abs() > 0.1).map(|(i, _)| i).collect();
        assert_eq!(onsets, vec![2400]);
        assert!((backing.heard() - 0.55).abs() < 1e-9);
        for _ in 0..10 {
            backing.render_own(&mut l, &mut r);
        }
        assert!(!backing.own_playing(), "stopped at the end of the file");
        backing.transport(BackingTransport::Play);
        assert!(backing.own_playing() && backing.own_position == 0.0, "plays again from the start");
        // Linking it to the song hands the transport over; unlinking stops where it was heard.
        backing.set_mix(BackingMix { linked: true, ..Default::default() });
        assert!(!backing.own_playing());
        backing.render(&mut l, &mut r, Some(0.2), 1.0);
        backing.set_mix(BackingMix { linked: false, ..Default::default() });
        assert!(!backing.own_playing() && (backing.own_position - 0.3).abs() < 1e-9);
    }

    #[test]
    fn before_the_file_and_after_its_end_is_silence() {
        let audio = clicks(1.0, 480);
        let mut backing = Backing::new(audio, BackingMix { offset: -0.5, ..Default::default() });
        let out = play(&mut backing, 0.0, 1.0, 24000 + 4800, 480);
        assert!(out[..24000].iter().all(|v| *v == 0.0), "the file starts 0.5 s into the song");
        assert!(out[24000..].iter().any(|v| v.abs() > 0.1));
        let out = play(&mut backing, 5.0, 1.0, 4800, 480);
        assert!(out.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn stretched_playback_stays_on_the_song_position_at_practice_speeds() {
        // Clicks every 0.5 s: each must land where the song position says it is heard.
        for speed in [0.5, 0.75, 1.25] {
            let audio = clicks(20.0, 24000);
            let mut backing = Backing::new(audio, BackingMix::default());
            // The first click comes 50 ms after the start: the pre-roll already aligns it.
            let from = 1.45;
            let frames = (8.0 * RATE as f64) as usize;
            let out = play(&mut backing, from, speed, frames, 512);
            // Expected output frame of the click at source time c: (c - from) / speed seconds.
            let mut errors = Vec::new();
            for k in 3..16 {
                let click = k as f64 * 0.5;
                if click < from {
                    continue;
                }
                let expected = ((click - from) / speed * RATE as f64) as usize;
                if expected + 2400 >= out.len() {
                    break;
                }
                // The stretched click is smeared: take the energy centroid around the expectation.
                let (lo, hi) = (expected.saturating_sub(2400), expected + 2400);
                let energy: f64 = out[lo..hi].iter().map(|v| (*v as f64).powi(2)).sum();
                let centroid = out[lo..hi].iter().enumerate().map(|(i, v)| (lo + i) as f64 * (*v as f64).powi(2)).sum::<f64>() / energy;
                errors.push((centroid - expected as f64) / RATE as f64 * 1000.0);
            }
            assert!(errors.len() > 3, "{speed}: {errors:?}");
            let worst = errors.iter().fold(0f64, |m, e| m.max(e.abs()));
            assert!(worst < 1.0, "speed {speed}: click timing errors (ms) {errors:?}");
        }
    }

    #[test]
    fn long_stretched_playback_does_not_drift() {
        // 5 minutes at 0.75: the feed advances by exactly speed x frames (fractions carried).
        let audio = tone(1.0, 440.0);
        let mut backing = Backing::new(audio, BackingMix::default());
        let (mut l, mut r) = (vec![0f32; 441], vec![0f32; 441]);
        let speed = 0.75;
        let mut position = 0.0;
        backing.render(&mut l, &mut r, Some(position), speed);
        let start = backing.feed as f64 + backing.carry;
        let blocks = 300 * RATE as usize / 441;
        for _ in 1..blocks {
            position += 441.0 * speed / RATE as f64;
            backing.render(&mut l, &mut r, Some(position), speed);
        }
        // Every block continued the stream (no re-prime) and the feed kept the song's pace.
        let fed = backing.feed as f64 + backing.carry - start;
        let expected = (blocks - 1) as f64 * 441.0 * speed;
        assert!((fed - expected).abs() < 1.0, "fed {fed} vs {expected}");
    }

    #[test]
    fn jumps_and_pauses_fade_instead_of_clicking() {
        let audio = tone(10.0, 220.0);
        let mut backing = Backing::new(audio, BackingMix::default());
        let out = play(&mut backing, 1.0, 1.0, 4800, 480);
        assert!(out[0].abs() < 0.01, "fades in at the start");
        let (mut l, mut r) = (vec![0f32; 480], vec![0f32; 480]);
        // Pause: the next block holds the fade-out, then silence.
        backing.render(&mut l, &mut r, None, 1.0);
        let steps = l.windows(2).fold(0f32, |m, w| m.max((w[1] - w[0]).abs()));
        assert!(steps < 0.05, "smooth fade-out: {steps}");
        assert!(l[FADE..].iter().all(|v| *v == 0.0));
        backing.render(&mut l, &mut r, None, 1.0);
        assert!(l.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn pitch_shift_keeps_the_tempo() {
        let audio = tone(6.0, 440.0);
        let mut backing = Backing::new(audio, BackingMix { semitones: 12.0, ..Default::default() });
        let out = play(&mut backing, 0.5, 1.0, 96000, 512);
        // Zero crossings over the last second: an octave up is ~880 Hz.
        let tail = &out[48000..];
        let crossings = tail.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((crossings as i64 - 880).abs() < 20, "{crossings} rising crossings in 1 s");
    }

    #[test]
    fn decodes_a_wav_resamples_it_and_measures_its_loudness() {
        // 1 s of 1 kHz at amplitude 0.1, as a 44.1 kHz WAV.
        let source = 44100;
        let left: Vec<f32> = (0..source).map(|i| (i as f32 / source as f32 * 1000.0 * std::f32::consts::TAU).sin() * 0.1).collect();
        let bytes = crate::wav::stereo_16(&left, &left, source as u32);
        let audio = decode(Box::new(std::io::Cursor::new(bytes)), Some("wav"), RATE).unwrap();
        assert_eq!(audio.source_rate, 44100);
        assert_eq!(audio.frames(), 48000, "rate-scaled length");
        // Still a 1 kHz tone at the same level, without a delay at the start.
        let l: Vec<f32> = audio.samples.iter().step_by(2).map(|v| *v as f32 / 32768.0).collect();
        let crossings = l[4800..43200].windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((crossings as i64 - 800).abs() <= 1, "{crossings}");
        let peak = l[4800..43200].iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.1).abs() < 0.005, "{peak}");
        let first = l.iter().position(|v| v.abs() > 0.02).unwrap();
        assert!(first < 10, "no resampler delay at the start: {first}");
        // Mean square 0.005 per channel, two channels: -0.691 + 10 log10(0.01) = -20.7 LUFS,
        // plus the K-weighting's +0.7 dB at 1 kHz.
        let lufs = audio.lufs.unwrap();
        assert!((lufs + 20.0).abs() < 0.5, "{lufs}");
        assert_eq!(audio.peaks.len(), 100);
        assert!(decode(Box::new(std::io::Cursor::new(b"not audio".to_vec())), Some("mp3"), RATE).is_err());
        assert!(decode(Box::new(std::io::Cursor::new(Vec::new())), Some("opus"), RATE).is_err());
    }
}
