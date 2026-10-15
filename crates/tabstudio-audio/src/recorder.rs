//! The always-on recorder (instrument input): keeps the last few minutes in memory, appends
//! everything to rotating WAV segments on disk (so a crash loses at most a few seconds) and
//! writes takes on request. Runs on its own thread; the audio threads only feed it rings
//! (live.rs).
//!
//! Timeline: frame k is the k-th dry (DI) sample recorded since the recorder started. The
//! wet ("heard") stream is stored 1:1 beside it; it trails the dry one by the monitor delay
//! (a few ms), which is left as is.
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 32-bit float mono WAV, sizes patched as it grows.
pub struct WavWriter {
    file: File,
    frames: u64,
    pub path: PathBuf,
    patched: Instant,
}

impl WavWriter {
    pub fn create(path: &Path, rate: u32) -> std::io::Result<WavWriter> {
        let mut file = File::create(path)?;
        file.write_all(&header(rate, 0))?;
        Ok(WavWriter { file, frames: 0, path: path.to_path_buf(), patched: Instant::now() })
    }

    pub fn append(&mut self, samples: &[f32]) -> std::io::Result<()> {
        let mut bytes = Vec::with_capacity(samples.len() * 4);
        for v in samples {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        self.file.write_all(&bytes)?;
        self.frames += samples.len() as u64;
        if self.patched.elapsed() > Duration::from_secs(5) {
            self.patch()?;
        }
        Ok(())
    }

    /// Rewrites the sizes so the file is valid up to here (also done on drop).
    pub fn patch(&mut self) -> std::io::Result<()> {
        self.patched = Instant::now();
        let data = (self.frames * 4).min(u32::MAX as u64 - 64) as u32;
        self.file.seek(SeekFrom::Start(4))?;
        self.file.write_all(&(data + 36).to_le_bytes())?;
        self.file.seek(SeekFrom::Start(40))?;
        self.file.write_all(&data.to_le_bytes())?;
        self.file.seek(SeekFrom::End(0))?;
        self.file.flush()
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }
}

impl Drop for WavWriter {
    fn drop(&mut self) {
        let _ = self.patch();
    }
}

fn header(rate: u32, data: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data).to_le_bytes());
    h[8..16].copy_from_slice(b"WAVEfmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&3u16.to_le_bytes()); // IEEE float
    h[22..24].copy_from_slice(&1u16.to_le_bytes());
    h[24..28].copy_from_slice(&rate.to_le_bytes());
    h[28..32].copy_from_slice(&(rate * 4).to_le_bytes());
    h[32..34].copy_from_slice(&4u16.to_le_bytes());
    h[34..36].copy_from_slice(&32u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data.to_le_bytes());
    h
}

/// Reads a mono float WAV written by WavWriter (tests and recovery).
pub fn read_wav(path: &Path) -> std::io::Result<Vec<f32>> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" {
        return Err(std::io::Error::other("not a WAV file"));
    }
    Ok(bytes[44..].chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect())
}

/// The local date and time for file names (YYYYMMDD-HHMMSS).
pub fn local_stamp() -> String {
    #[cfg(windows)]
    unsafe {
        let mut t: windows_sys::Win32::Foundation::SYSTEMTIME = std::mem::zeroed();
        windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut t);
        return format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
    }
    #[allow(unreachable_code)]
    stamp(SystemTime::now())
}

/// A UTC date-time as YYYYMMDD-HHMMSS.
pub fn stamp(time: SystemTime) -> String {
    let secs = time.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rest) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil from days (H. Hinnant).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rest / 3600, rest / 60 % 60, rest % 60)
}

/// A point on the timeline: wall clock and, if the song was playing, its position.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mark {
    pub frame: u64,
    pub unix_ms: u64,
    /// Song seconds (at speed 1) when the score was playing.
    pub song: Option<f64>,
}

/// A stretch of playing between silences (frames on the timeline).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Phrase {
    pub start: u64,
    pub end: u64,
}

pub struct RecorderConfig {
    /// Segment files go to `dir/segments`, takes to `takes`.
    pub dir: PathBuf,
    pub takes: PathBuf,
    pub rate: u32,
    pub history_seconds: usize,
    pub segment_seconds: u64,
    /// Total size of the segment files kept (oldest removed first).
    pub disk_cap: u64,
}

/// A take being written: its files are written by their own thread, so the history lock
/// is only held to copy samples, never for disk writes.
struct Take {
    tx: std::sync::mpsc::Sender<(Vec<f32>, Vec<f32>)>,
    /// Answers (DI frames written, whether the monitor file has any sound, error).
    thread: std::thread::JoinHandle<(u64, bool, Option<String>)>,
    start: u64,
    meta: serde_like::Meta,
    dry_path: PathBuf,
    wet_path: PathBuf,
}

impl Take {
    /// Ends the writer; removes a silent monitor file (monitor off / not recorded).
    fn finish(self, marks: &[Mark], rate: u32) -> Result<(PathBuf, u64), String> {
        let Take { tx, thread, start, mut meta, dry_path, wet_path } = self;
        drop(tx);
        let (frames, wet_sound, error) = thread.join().map_err(|_| "テイクの書き込みが止まりました。".to_string())?;
        if !wet_sound {
            let _ = std::fs::remove_file(&wet_path);
        }
        meta.finish(start, frames, marks, rate);
        std::fs::write(dry_path.with_extension("json"), meta.json()).map_err(|e| e.to_string())?;
        match error {
            Some(e) => Err(e),
            None => Ok((dry_path, frames)),
        }
    }
}

/// File names for a take (local time + label).
fn take_paths(config: &RecorderConfig, label: &str) -> (PathBuf, PathBuf) {
    let clean: String = label.chars().filter(|c| !r#"\/:*?"<>|"#.contains(*c)).take(60).collect();
    let base = format!("{} {}", local_stamp(), clean.trim()).trim().to_string();
    (config.takes.join(format!("{base} DI.wav")), config.takes.join(format!("{base} モニタ.wav")))
}

fn spawn_take(config: &RecorderConfig, rate: u32, start: u64, label: &str, meta: &str) -> Result<Take, String> {
    std::fs::create_dir_all(&config.takes).map_err(|e| e.to_string())?;
    let (dry_path, wet_path) = take_paths(config, label);
    let mut dry = WavWriter::create(&dry_path, rate).map_err(|e| e.to_string())?;
    let mut wet = WavWriter::create(&wet_path, rate).map_err(|e| e.to_string())?;
    let (tx, rx) = std::sync::mpsc::channel::<(Vec<f32>, Vec<f32>)>();
    let thread = std::thread::Builder::new()
        .name("tabstudio-take".into())
        .spawn(move || {
            let (mut sound, mut error) = (false, None);
            for (d, w) in rx {
                sound |= w.iter().any(|v| v.abs() > 1e-5);
                if let Err(e) = dry.append(&d).and_then(|_| wet.append(&w)) {
                    error.get_or_insert(e.to_string());
                }
            }
            (dry.frames(), sound, error)
        })
        .map_err(|e| e.to_string())?;
    Ok(Take { tx, thread, start, meta: serde_like::Meta::new(meta), dry_path, wet_path })
}

struct History {
    rate: u32,
    dry: Vec<f32>,
    wet: Vec<f32>,
    /// Dry frames recorded (the timeline end).
    total: u64,
    wet_total: u64,
    marks: std::collections::VecDeque<Mark>,
    segment: Option<(WavWriter, WavWriter)>,
    segment_started: u64,
    take: Option<Take>,
    last_error: Option<String>,
}

impl History {
    fn capacity(&self) -> usize {
        self.dry.len()
    }
    fn oldest(&self) -> u64 {
        self.total.saturating_sub(self.capacity() as u64)
    }
}

/// The recorder (control side).
pub struct Recorder {
    history: Arc<Mutex<History>>,
    config: Arc<RecorderConfig>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// How the recorder learns the song position for its marks.
pub type SongClock = Box<dyn Fn() -> Option<f64> + Send>;

impl Recorder {
    pub fn new(config: RecorderConfig) -> Recorder {
        let capacity = config.rate as usize * config.history_seconds;
        let history = History {
            rate: config.rate,
            dry: vec![0.0; capacity],
            wet: vec![0.0; capacity],
            total: 0,
            wet_total: 0,
            marks: Default::default(),
            segment: None,
            segment_started: 0,
            take: None,
            last_error: None,
        };
        Recorder { history: Arc::new(Mutex::new(history)), config: Arc::new(config), stop: Arc::new(AtomicBool::new(false)), thread: None }
    }

    /// Starts taking samples from a live input's rings (replacing an earlier pair).
    pub fn attach(&mut self, mut dry: rtrb::Consumer<f32>, mut wet: rtrb::Consumer<f32>, clock: SongClock) {
        self.detach();
        let stop = Arc::new(AtomicBool::new(false));
        self.stop = stop.clone();
        let (history, config) = (self.history.clone(), self.config.clone());
        self.thread = std::thread::Builder::new()
            .name("tabstudio-recorder".into())
            .spawn(move || {
                let mut buffer = vec![0f32; crate::live::RECORD_RING];
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(20));
                    let song = clock();
                    let mut h = history.lock().unwrap_or_else(|e| e.into_inner());
                    pump(&mut h, &config, &mut dry, &mut wet, &mut buffer, song);
                }
                let mut h = history.lock().unwrap_or_else(|e| e.into_inner());
                pump(&mut h, &config, &mut dry, &mut wet, &mut buffer, None);
                h.segment = None;
            })
            .ok();
    }

    /// Stops the thread (what was recorded stays in memory; the segment is closed).
    pub fn detach(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }

    pub fn rate(&self) -> u32 {
        self.config.rate
    }

    /// (oldest frame kept, end of the timeline).
    pub fn range(&self) -> (u64, u64) {
        let h = self.lock();
        (h.oldest(), h.total)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, History> {
        self.history.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn last_error(&self) -> Option<String> {
        self.lock().last_error.clone()
    }

    /// Copies [from, to) of the history (clamped to what is kept): (origin, dry, wet).
    pub fn snapshot(&self, from: u64, to: u64) -> (u64, Vec<f32>, Vec<f32>) {
        let h = self.lock();
        let (from, to) = (from.max(h.oldest()), to.min(h.total));
        if to <= from {
            return (from, Vec::new(), Vec::new());
        }
        let cap = h.capacity() as u64;
        let dry: Vec<f32> = (from..to).map(|f| h.dry[(f % cap) as usize]).collect();
        let wet: Vec<f32> = (from..to).map(|f| if f < h.wet_total { h.wet[(f % cap) as usize] } else { 0.0 }).collect();
        (from, dry, wet)
    }

    /// Peak per bucket over [from, to) (dry, wet), for the timeline drawing.
    pub fn overview(&self, from: u64, to: u64, buckets: usize) -> (Vec<f32>, Vec<f32>) {
        let h = self.lock();
        let buckets = buckets.clamp(1, 4000);
        let (mut dry, mut wet) = (vec![0f32; buckets], vec![0f32; buckets]);
        let (lo, hi) = (from.max(h.oldest()), to.min(h.total));
        if hi <= lo || to <= from {
            return (dry, wet);
        }
        let cap = h.capacity() as u64;
        let span = (to - from) as f64;
        // Sample at most ~200 points per bucket: the drawing needs the shape, not every peak.
        let step = (((hi - lo) / (buckets as u64 * 200)).max(1)) as usize;
        for f in (lo..hi).step_by(step) {
            let b = (((f - from) as f64 / span) * buckets as f64) as usize;
            let b = b.min(buckets - 1);
            let at = (f % cap) as usize;
            dry[b] = dry[b].max(h.dry[at].abs());
            if f < h.wet_total {
                wet[b] = wet[b].max(h.wet[at].abs());
            }
        }
        (dry, wet)
    }

    /// Playing between silences: 100 ms windows louder than `threshold_db` (RMS), joined
    /// across gaps shorter than `gap` seconds; shorter than 0.5 s dropped.
    pub fn phrases(&self, threshold_db: f32, gap: f64) -> Vec<Phrase> {
        let h = self.lock();
        let window = (h.rate / 10).max(1) as u64;
        let cap = h.capacity() as u64;
        let threshold = 10f32.powf(threshold_db / 20.0);
        let mut active: Vec<(u64, u64)> = Vec::new();
        let mut start = h.oldest() / window * window;
        start = start.max(h.oldest());
        while start + window <= h.total {
            let sum: f32 = (start..start + window).map(|f| h.dry[(f % cap) as usize].powi(2)).sum();
            if (sum / window as f32).sqrt() > threshold {
                match active.last_mut() {
                    Some(last) if start - last.1 <= (gap * h.rate as f64) as u64 => last.1 = start + window,
                    _ => active.push((start, start + window)),
                }
            }
            start += window;
        }
        active.into_iter().filter(|(s, e)| e - s >= h.rate as u64 / 2).map(|(start, end)| Phrase { start, end }).collect()
    }

    /// Marks within [from, to).
    pub fn marks(&self, from: u64, to: u64) -> Vec<Mark> {
        self.lock().marks.iter().filter(|m| m.frame >= from && m.frame < to).copied().collect()
    }

    /// The song position heard at `frame` (if the score was playing then).
    pub fn song_at(&self, frame: u64) -> Option<f64> {
        let h = self.lock();
        let before = h.marks.iter().rev().find(|m| m.frame <= frame)?;
        let after = h.marks.iter().find(|m| m.frame > frame);
        let song = before.song?;
        match after.and_then(|a| a.song.map(|s| (a.frame, s))) {
            Some((af, asong)) if asong >= song && af > before.frame => Some(song + (asong - song) * (frame - before.frame) as f64 / (af - before.frame) as f64),
            _ => Some(song + (frame - before.frame) as f64 / h.rate as f64),
        }
    }

    /// Starts a take with the last `back` frames; it keeps growing until `stop_take`.
    /// `meta` is stored beside it (device, amp, plugins). Returns the DI file's path.
    pub fn start_take(&self, back: u64, label: &str, meta: &str) -> Result<PathBuf, String> {
        let mut h = self.lock();
        if h.take.is_some() {
            return Err("保存中のテイクがあります。".into());
        }
        let from = h.total.saturating_sub(back).max(h.oldest());
        let take = spawn_take(&self.config, h.rate, from, label, meta)?;
        // The backlog is copied here (memory only) and written by the take's thread;
        // later samples follow it in order through the same channel.
        let cap = h.capacity() as u64;
        let dry: Vec<f32> = (from..h.total).map(|f| h.dry[(f % cap) as usize]).collect();
        let wet: Vec<f32> = (from..h.total).map(|f| if f < h.wet_total { h.wet[(f % cap) as usize] } else { 0.0 }).collect();
        let _ = take.tx.send((dry, wet));
        let path = take.dry_path.clone();
        h.take = Some(take);
        Ok(path)
    }

    /// Ends the take; returns (DI path, frames).
    pub fn stop_take(&self) -> Option<(PathBuf, u64)> {
        let (take, marks, rate) = {
            let mut h = self.lock();
            let take = h.take.take()?;
            (take, h.marks.iter().copied().collect::<Vec<Mark>>(), h.rate)
        };
        take.finish(&marks, rate).ok()
    }

    /// Whether a take is being written, and since which frame.
    pub fn take_start(&self) -> Option<u64> {
        self.lock().take.as_ref().map(|t| t.start)
    }

    /// Writes [from, to) as a finished take (outside the history lock); returns the DI path.
    pub fn save_range(&self, from: u64, to: u64, label: &str, meta: &str) -> Result<PathBuf, String> {
        let (origin, dry, wet) = self.snapshot(from, to);
        if dry.is_empty() {
            return Err("保存する範囲に音がありません。".into());
        }
        let marks: Vec<Mark> = self.lock().marks.iter().copied().collect();
        let take = spawn_take(&self.config, self.config.rate, origin, label, meta)?;
        let _ = take.tx.send((dry, wet));
        take.finish(&marks, self.config.rate).map(|(path, _)| path)
    }

    /// Feeds samples directly (tests, and the probe without an engine).
    pub fn feed(&self, dry: &[f32], wet: &[f32], song: Option<f64>) {
        let mut h = self.lock();
        append(&mut h, &self.config, dry, wet, song);
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.detach();
    }
}

fn pump(h: &mut History, config: &RecorderConfig, dry: &mut rtrb::Consumer<f32>, wet: &mut rtrb::Consumer<f32>, buffer: &mut [f32], song: Option<f64>) {
    let n = dry.slots().min(buffer.len());
    if let Ok(chunk) = dry.read_chunk(n) {
        let (a, b) = chunk.as_slices();
        buffer[..a.len()].copy_from_slice(a);
        buffer[a.len()..a.len() + b.len()].copy_from_slice(b);
        chunk.commit_all();
    }
    let dry_samples = buffer[..n].to_vec();
    let m = wet.slots().min(buffer.len());
    if let Ok(chunk) = wet.read_chunk(m) {
        let (a, b) = chunk.as_slices();
        buffer[..a.len()].copy_from_slice(a);
        buffer[a.len()..a.len() + b.len()].copy_from_slice(b);
        chunk.commit_all();
    }
    append(h, config, &dry_samples, &buffer[..m], song);
}

fn append(h: &mut History, config: &RecorderConfig, dry: &[f32], wet: &[f32], song: Option<f64>) {
    let cap = h.capacity() as u64;
    if cap == 0 {
        return;
    }
    if !dry.is_empty() {
        let at = h.total;
        h.marks.push_back(Mark { frame: at, unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0), song });
        let oldest = h.oldest();
        while h.marks.front().is_some_and(|m| m.frame < oldest) {
            h.marks.pop_front();
        }
    }
    for v in dry {
        let at = (h.total % cap) as usize;
        h.dry[at] = *v;
        h.total += 1;
    }
    // Wet stays 1:1 with dry; if it fell far behind (no monitor stage), pad with silence.
    if h.total > h.wet_total + h.rate as u64 && wet.is_empty() {
        while h.wet_total + (h.rate as u64 / 10) < h.total {
            let at = (h.wet_total % cap) as usize;
            h.wet[at] = 0.0;
            h.wet_total += 1;
        }
    }
    for v in wet {
        if h.wet_total >= h.total + h.rate as u64 {
            break; // wet ahead of dry by more than a second: not from this input
        }
        let at = (h.wet_total % cap) as usize;
        h.wet[at] = *v;
        h.wet_total += 1;
    }
    if let Err(e) = write_disk(h, config, dry, wet) {
        h.last_error = Some(e.to_string());
        h.segment = None;
    }
}

fn write_disk(h: &mut History, config: &RecorderConfig, dry: &[f32], wet: &[f32]) -> std::io::Result<()> {
    if let Some(take) = &h.take {
        let _ = take.tx.send((dry.to_vec(), wet.to_vec()));
    }
    if dry.is_empty() && wet.is_empty() {
        return Ok(());
    }
    let rotate = h.segment.as_ref().is_some_and(|(d, _)| d.frames() >= config.segment_seconds * h.rate as u64);
    if rotate || h.segment.is_none() {
        h.segment = None;
        let dir = config.dir.join("segments");
        std::fs::create_dir_all(&dir)?;
        let base = local_stamp();
        let d = WavWriter::create(&dir.join(format!("{base}-{:012}-dry.wav", h.total)), h.rate)?;
        let w = WavWriter::create(&dir.join(format!("{base}-{:012}-wet.wav", h.total)), h.rate)?;
        h.segment = Some((d, w));
        h.segment_started = h.total;
        prune(&dir, config.disk_cap);
    }
    if let Some((d, w)) = &mut h.segment {
        d.append(dry)?;
        w.append(wet)?;
    }
    Ok(())
}

/// Removes the oldest segment files beyond `cap` bytes (the newest pair is always kept).
pub fn prune(dir: &Path, cap: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(String, u64, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".wav"))
        .filter_map(|e| Some((e.file_name().to_string_lossy().into_owned(), e.metadata().ok()?.len(), e.path())))
        .collect();
    files.sort();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    let keep = 2;
    let removable = files.len().saturating_sub(keep);
    for (_, size, path) in files.into_iter().take(removable) {
        if total <= cap {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= size;
        }
    }
}

/// The JSON beside a take, without a serde dependency.
mod serde_like {
    use super::Mark;
    pub struct Meta {
        extra: String,
        body: String,
    }
    impl Meta {
        pub fn new(extra: &str) -> Meta {
            Meta { extra: extra.to_string(), body: String::new() }
        }
        pub fn finish(&mut self, start: u64, frames: u64, marks: &[Mark], rate: u32) {
            let created = marks.iter().find(|m| m.frame >= start).map_or(0, |m| m.unix_ms);
            let songs: Vec<String> = marks
                .iter()
                .filter(|m| m.frame >= start && m.frame < start + frames)
                .filter_map(|m| m.song.map(|s| format!("[{:.3},{:.3}]", (m.frame - start) as f64 / rate as f64, s)))
                .collect();
            self.body = format!("\"recordedAt\":{created},\"sampleRate\":{rate},\"seconds\":{:.3},\"songPositions\":[{}]", frames as f64 / rate as f64, songs.join(","));
        }
        pub fn json(&self) -> String {
            let extra = self.extra.trim();
            let extra = if extra.starts_with('{') && extra.ends_with('}') && extra.len() > 2 { format!("{},", &extra[1..extra.len() - 1]) } else { String::new() };
            format!("{{{extra}{}}}", self.body)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tabstudio-recorder-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn recorder(dir: &Path, seconds: usize) -> Recorder {
        Recorder::new(RecorderConfig { dir: dir.to_path_buf(), takes: dir.join("takes"), rate: 100, history_seconds: seconds, segment_seconds: 3, disk_cap: 1 << 30 })
    }

    #[test]
    fn history_keeps_only_the_last_minutes_and_snapshots_wrap() {
        let dir = temp("wrap");
        let r = recorder(&dir, 10); // 1000 frames
        let data: Vec<f32> = (0..2500).map(|i| i as f32).collect();
        for chunk in data.chunks(100) {
            r.feed(chunk, chunk, None);
        }
        assert_eq!(r.range(), (1500, 2500));
        let (origin, dry, wet) = r.snapshot(0, 3000);
        assert_eq!(origin, 1500);
        assert_eq!(dry.len(), 1000);
        assert_eq!(dry[0], 1500.0);
        assert_eq!(dry[999], 2499.0);
        assert_eq!(wet, dry);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn segments_rotate_on_disk_and_are_readable_mid_write() {
        let dir = temp("segments");
        let r = recorder(&dir, 10);
        let data: Vec<f32> = (0..750).map(|i| i as f32 / 1000.0).collect();
        for chunk in data.chunks(50) {
            r.feed(chunk, &[], None);
        }
        drop(r);
        let mut files: Vec<_> = std::fs::read_dir(dir.join("segments")).unwrap().map(|e| e.unwrap().path()).filter(|p| p.to_string_lossy().ends_with("-dry.wav")).collect();
        files.sort();
        // 300 frames per segment: 300 + 300 + 150.
        assert_eq!(files.len(), 3);
        let all: Vec<f32> = files.iter().flat_map(|f| read_wav(f).unwrap()).collect();
        assert_eq!(all, data);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_disk_cap_removes_the_oldest_segments() {
        let dir = temp("prune");
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..6 {
            std::fs::write(dir.join(format!("2026101{i}-x-dry.wav")), vec![0u8; 1000]).unwrap();
        }
        prune(&dir, 2500);
        let mut left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["20261014-x-dry.wav", "20261015-x-dry.wav"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_take_starts_in_the_past_and_keeps_growing_until_stopped() {
        let dir = temp("take");
        let r = recorder(&dir, 10);
        r.feed(&vec![0.1; 500], &vec![0.2; 500], Some(4.0));
        let path = r.start_take(200, "練習", "{\"device\":\"x\"}").unwrap();
        r.feed(&vec![0.3; 100], &vec![0.4; 100], Some(9.0));
        let (done, frames) = r.stop_take().unwrap();
        assert_eq!(done, path);
        assert_eq!(frames, 300);
        let dry = read_wav(&path).unwrap();
        assert_eq!(dry.len(), 300);
        assert_eq!(dry[0], 0.1);
        assert_eq!(dry[299], 0.3);
        let wet = read_wav(&PathBuf::from(path.to_string_lossy().replace(" DI.wav", " モニタ.wav"))).unwrap();
        assert_eq!(wet[299], 0.4);
        let json = std::fs::read_to_string(path.with_extension("json")).unwrap();
        assert!(json.starts_with("{\"device\":\"x\",\"recordedAt\":"), "{json}");
        assert!(json.contains("\"songPositions\":[[2.000,9.000]]"), "{json}");
        // After stopping, new samples do not reach the take.
        r.feed(&vec![0.5; 100], &[], None);
        assert_eq!(read_wav(&path).unwrap().len(), 300);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn phrases_split_playing_at_silences_and_song_positions_interpolate() {
        let dir = temp("phrases");
        let r = recorder(&dir, 60);
        let tone = |n: usize| (0..n).map(|i| if i % 2 == 0 { 0.3 } else { -0.3 }).collect::<Vec<f32>>();
        r.feed(&vec![0.0; 100], &[], None); // 1 s silence
        r.feed(&tone(200), &[], Some(10.0)); // 2 s playing (song 10 s..)
        r.feed(&vec![0.0; 50], &[], Some(12.0)); // 0.5 s gap: joined
        r.feed(&tone(100), &[], Some(12.5));
        r.feed(&vec![0.0; 300], &[], None); // 3 s silence: split
        r.feed(&tone(80), &[], None);
        let phrases = r.phrases(-40.0, 1.0);
        assert_eq!(phrases, vec![Phrase { start: 100, end: 450 }, Phrase { start: 750, end: 830 }]);
        assert_eq!(r.song_at(200), Some(11.0));
        assert_eq!(r.song_at(50), None);
        let (dry, _) = r.overview(0, 830, 83);
        assert_eq!(dry[0], 0.0);
        assert!((dry[20] - 0.3).abs() < 1e-6);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stamps_are_utc_dates() {
        assert_eq!(stamp(UNIX_EPOCH + Duration::from_secs(1_760_486_400 + 3661)), "20251015-010101");
    }
}
