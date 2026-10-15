//! A shared-memory audio link between the native engine (in the app) and one external
//! effect running in tabstudio-fx-host (another process).
//!
//! Layout of the named mapping: a header, then an input ring and an output ring of
//! CAPACITY interleaved stereo f32 frames. The engine's audio callback writes its block to
//! the input ring, bumps `written` and signals the host's wake event; the host processes
//! whole blocks in order and bumps `processed`. The engine reads the output for frames
//! `LATENCY` behind what it just wrote, so it never waits for the host: a late or dead host
//! only means silence for those frames (counted in `late`). Bypass plays the input ring's
//! own history at the same delay, so switching keeps the timing.
//!
//! A live link (instrument monitoring) reads much sooner: its delay is stored in the header
//! (`Shared::create_with_latency`), and the host neither compensates the plugin's latency
//! there (output cannot come before its input) nor skips ahead by more than that delay.
//!
//! The host also compensates the plugin's reported latency: the output it writes for input
//! frame k lands at position k - plugin latency (as pedalboard did), so effects line up.
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

/// Ring size in frames (power of two).
pub const CAPACITY: usize = 16384;
/// How far behind the engine reads the host's output (frames): 2048 at 48 kHz is 43 ms.
pub const LATENCY: usize = 2048;
const MAGIC: u32 = u32::from_le_bytes(*b"TSFX");
const VERSION: u32 = 1;

#[repr(C)]
pub struct Header {
    magic: AtomicU32,
    version: AtomicU32,
    /// Engine sample rate (f64 bits); the host re-prepares the plugin when it changes.
    pub sample_rate: AtomicU64,
    /// Input frames the engine has written.
    pub written: AtomicU64,
    /// Output frames the host has finished (valid in the output ring up to here).
    pub processed: AtomicU64,
    /// Host loop counter (a sign of life).
    pub heartbeat: AtomicU64,
    /// Frames the engine played as silence because the host was late.
    pub late: AtomicU64,
    /// How far behind the engine reads (frames); 0 means LATENCY (links made before this field).
    pub delay: AtomicU64,
    _reserved: [u64; 1],
}

const HEADER: usize = 64;
const RING: usize = CAPACITY * 2 * 4;
pub const SIZE: usize = HEADER + 2 * RING;

/// A mapped link: the header and the two rings (owned by whoever created/opened it).
pub struct Shared {
    base: *mut u8,
    #[cfg(windows)]
    mapping: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(windows)]
    event: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(not(windows))]
    _memory: Vec<u64>,
}

// SAFETY: the mapping is plain shared memory accessed through atomics (header) and by
// one writer per ring (engine: input; host: output), ordered by the atomics.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

impl Shared {
    pub fn header(&self) -> &Header {
        unsafe { &*(self.base as *const Header) }
    }

    /// The engine's read delay in frames.
    pub fn delay(&self) -> usize {
        match self.header().delay.load(Ordering::Acquire) as usize {
            0 => LATENCY,
            d => d.min(CAPACITY / 4),
        }
    }

    /// A live link: the engine reads `delay` frames behind instead of LATENCY.
    pub fn create_with_latency(name: &str, sample_rate: f64, delay: usize) -> Result<Shared, String> {
        let shared = Shared::create(name, sample_rate)?;
        shared.header().delay.store(delay.clamp(1, CAPACITY / 4) as u64, Ordering::Release);
        Ok(shared)
    }
    fn ring(&self, output: bool) -> *mut f32 {
        unsafe { self.base.add(HEADER + if output { RING } else { 0 }) as *mut f32 }
    }
    #[inline]
    fn read(&self, output: bool, frame: u64) -> (f32, f32) {
        let at = (frame as usize % CAPACITY) * 2;
        unsafe { (*self.ring(output).add(at), *self.ring(output).add(at + 1)) }
    }
    #[inline]
    fn write(&self, output: bool, frame: u64, l: f32, r: f32) {
        let at = (frame as usize % CAPACITY) * 2;
        unsafe {
            *self.ring(output).add(at) = l;
            *self.ring(output).add(at + 1) = r;
        }
    }

    /// Creates a new link (the app side) under `name`.
    #[cfg(windows)]
    pub fn create(name: &str, sample_rate: f64) -> Result<Shared, String> {
        use windows_sys::Win32::System::Memory::*;
        use windows_sys::Win32::System::Threading::CreateEventW;
        let wide = |s: String| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        unsafe {
            let mapping = CreateFileMappingW(windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE, std::ptr::null(), PAGE_READWRITE, 0, SIZE as u32, wide(format!("Local\\TabStudioFx-{name}")).as_ptr());
            if mapping.is_null() {
                return Err("外部FXの共有メモリを作れません。".into());
            }
            let view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, SIZE);
            if view.Value.is_null() {
                windows_sys::Win32::Foundation::CloseHandle(mapping);
                return Err("外部FXの共有メモリを作れません。".into());
            }
            let event = CreateEventW(std::ptr::null(), 0, 0, wide(format!("Local\\TabStudioFxWake-{name}")).as_ptr());
            let shared = Shared { base: view.Value as *mut u8, mapping, event };
            let h = shared.header();
            h.sample_rate.store(sample_rate.to_bits(), Ordering::Relaxed);
            h.version.store(VERSION, Ordering::Relaxed);
            h.magic.store(MAGIC, Ordering::Release);
            Ok(shared)
        }
    }

    /// Opens an existing link (the host side).
    #[cfg(windows)]
    pub fn open(name: &str) -> Result<Shared, String> {
        use windows_sys::Win32::System::Memory::*;
        use windows_sys::Win32::System::Threading::{EVENT_ALL_ACCESS, OpenEventW};
        let wide = |s: String| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        unsafe {
            let mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, wide(format!("Local\\TabStudioFx-{name}")).as_ptr());
            if mapping.is_null() {
                return Err("外部FXの共有メモリが見つかりません。".into());
            }
            let view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, SIZE);
            if view.Value.is_null() {
                windows_sys::Win32::Foundation::CloseHandle(mapping);
                return Err("外部FXの共有メモリを開けません。".into());
            }
            let event = OpenEventW(EVENT_ALL_ACCESS, 0, wide(format!("Local\\TabStudioFxWake-{name}")).as_ptr());
            let shared = Shared { base: view.Value as *mut u8, mapping, event };
            let h = shared.header();
            if h.magic.load(Ordering::Acquire) != MAGIC || h.version.load(Ordering::Relaxed) != VERSION {
                return Err("外部FXの共有メモリが不正です。".into());
            }
            Ok(shared)
        }
    }

    /// An in-process link for tests and non-Windows builds.
    #[cfg(not(windows))]
    pub fn create(_name: &str, sample_rate: f64) -> Result<Shared, String> {
        let mut memory = vec![0u64; SIZE / 8];
        let shared = Shared { base: memory.as_mut_ptr() as *mut u8, _memory: memory };
        shared.header().sample_rate.store(sample_rate.to_bits(), Ordering::Relaxed);
        shared.header().magic.store(MAGIC, Ordering::Release);
        shared.header().version.store(VERSION, Ordering::Relaxed);
        Ok(shared)
    }

    fn wake(&self) {
        #[cfg(windows)]
        unsafe {
            if !self.event.is_null() {
                windows_sys::Win32::System::Threading::SetEvent(self.event);
            }
        }
    }

    /// Host side: waits up to `ms` for the engine's signal.
    pub fn wait(&self, ms: u32) {
        #[cfg(windows)]
        unsafe {
            if !self.event.is_null() {
                windows_sys::Win32::System::Threading::WaitForSingleObject(self.event, ms);
                return;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(ms.min(5) as u64));
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Foundation::CloseHandle;
            windows_sys::Win32::System::Memory::UnmapViewOfFile(windows_sys::Win32::System::Memory::MEMORY_MAPPED_VIEW_ADDRESS { Value: self.base as *mut _ });
            CloseHandle(self.mapping);
            if !self.event.is_null() {
                CloseHandle(self.event);
            }
        }
    }
}

/// The engine end: one per external effect in a track chain. Allocation-free.
pub struct EngineEnd {
    shared: std::sync::Arc<Shared>,
    delay: usize,
}

impl EngineEnd {
    pub fn new(shared: std::sync::Arc<Shared>) -> EngineEnd {
        let delay = shared.delay();
        EngineEnd { shared, delay }
    }

    /// Frames between a block going in and its effect output coming back.
    pub fn delay(&self) -> usize {
        self.delay
    }

    /// Sends this block and replaces it with the effect's output `delay` frames ago (or the
    /// dry input from then, when bypassed).
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], bypass: bool) {
        let s = &*self.shared;
        let h = s.header();
        let start = h.written.load(Ordering::Relaxed);
        let n = left.len().min(right.len());
        for i in 0..n {
            s.write(false, start + i as u64, left[i], right[i]);
        }
        h.written.store(start + n as u64, Ordering::Release);
        s.wake();
        let done = h.processed.load(Ordering::Acquire);
        let mut late = 0;
        for i in 0..n {
            let at = (start + i as u64).checked_sub(self.delay as u64);
            let (l, r) = match at {
                None => (0.0, 0.0),
                Some(at) if bypass => s.read(false, at),
                Some(at) if at < done => s.read(true, at),
                Some(_) => {
                    late += 1;
                    (0.0, 0.0)
                }
            };
            left[i] = l;
            right[i] = r;
        }
        if late > 0 {
            h.late.fetch_add(late, Ordering::Relaxed);
        }
    }
}

/// The host end: processes whatever the engine wrote, in blocks of at most `block` frames.
pub struct HostEnd {
    shared: Shared,
    /// Input frames processed so far.
    next: u64,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl HostEnd {
    pub fn new(shared: Shared, block: usize) -> HostEnd {
        let next = shared.header().written.load(Ordering::Acquire);
        shared.header().processed.store(next, Ordering::Release);
        // A live link plays the plugin's own delay instead of hiding it.
        HostEnd { shared, next, left: vec![0.0; block], right: vec![0.0; block] }
    }

    pub fn sample_rate(&self) -> f64 {
        f64::from_bits(self.shared.header().sample_rate.load(Ordering::Relaxed))
    }

    /// Waits up to `ms`, then processes everything pending with `effect(left, right)`.
    /// `latency` is the plugin's own delay, removed from the output. Returns false when
    /// nothing was pending.
    pub fn pump(&mut self, ms: u32, latency: usize, mut effect: impl FnMut(&mut [f32], &mut [f32])) -> bool {
        let s = &self.shared;
        let h = s.header();
        let delay = s.delay();
        let latency = if delay < LATENCY { 0 } else { latency };
        h.heartbeat.fetch_add(1, Ordering::Relaxed);
        let mut written = h.written.load(Ordering::Acquire);
        if written == self.next {
            s.wait(ms);
            written = h.written.load(Ordering::Acquire);
        }
        if written == self.next {
            return false;
        }
        // Far behind (the host was stalled): skip to fresh audio instead of catching up.
        let behind = if delay < LATENCY { delay as u64 * 2 } else { (CAPACITY - LATENCY * 2) as u64 };
        if written - self.next > behind {
            self.next = written - (delay as u64 / 2).max(1).min(written - self.next);
        }
        let block = self.left.len();
        while self.next < written {
            let n = ((written - self.next) as usize).min(block);
            for i in 0..n {
                let (l, r) = s.read(false, self.next + i as u64);
                self.left[i] = l;
                self.right[i] = r;
            }
            effect(&mut self.left[..n], &mut self.right[..n]);
            for i in 0..n {
                if let Some(at) = (self.next + i as u64).checked_sub(latency as u64) {
                    s.write(true, at, self.left[i], self.right[i]);
                }
            }
            self.next += n as u64;
            h.processed.store(self.next.saturating_sub(latency as u64), Ordering::Release);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn link(name: &str) -> (EngineEnd, HostEnd) {
        let shared = Arc::new(Shared::create(name, 48000.0).unwrap());
        #[cfg(windows)]
        let host = Shared::open(name).unwrap();
        #[cfg(not(windows))]
        let host = Shared { base: shared.base, _memory: Vec::new() };
        (EngineEnd::new(shared), HostEnd::new(host, 512))
    }

    #[test]
    fn effect_output_arrives_latency_frames_later_and_bypass_keeps_the_timing() {
        let (mut engine, mut host) = link(&format!("test-{}", std::process::id()));
        let input: Vec<f32> = (0..8192).map(|i| i as f32).collect();
        let mut out = Vec::new();
        for (k, block) in input.chunks(480).enumerate() {
            let (mut l, mut r) = (block.to_vec(), block.iter().map(|v| -v).collect::<Vec<_>>());
            // The host runs between callbacks here; in the app it is another process.
            if k > 0 {
                while host.pump(0, 0, |l, r| { for v in l.iter_mut().chain(r.iter_mut()) { *v *= 0.5; } }) {}
            }
            engine.process(&mut l, &mut r, k >= 14);
            out.extend(l.iter().zip(&r).map(|(a, b)| (*a, *b)));
        }
        assert!(out[..LATENCY].iter().all(|f| *f == (0.0, 0.0)));
        // Effect: half the input, 2048 frames later (frames already processed when read).
        let f = 4000;
        assert_eq!(out[f], ((f - LATENCY) as f32 * 0.5, -((f - LATENCY) as f32) * 0.5));
        // Bypassed blocks play the dry input from LATENCY frames earlier.
        let f = 14 * 480 + 10;
        assert_eq!(out[f], ((f - LATENCY) as f32, -((f - LATENCY) as f32)));
    }

    #[test]
    fn a_missing_host_means_counted_silence_not_waiting() {
        let (mut engine, _host) = link(&format!("late-{}", std::process::id()));
        let (mut l, mut r) = (vec![1.0f32; 4096], vec![1.0f32; 4096]);
        engine.process(&mut l, &mut r, false);
        assert!(l.iter().chain(&r).all(|v| *v == 0.0));
        assert_eq!(engine.shared.header().late.load(Ordering::Relaxed), (4096 - LATENCY) as u64);
    }

    #[test]
    fn a_live_link_reads_its_own_short_delay_and_keeps_the_plugin_delay() {
        let name = format!("live-{}", std::process::id());
        let shared = Arc::new(Shared::create_with_latency(&name, 48000.0, 256).unwrap());
        #[cfg(windows)]
        let host = Shared::open(&name).unwrap();
        #[cfg(not(windows))]
        let host = Shared { base: shared.base, _memory: Vec::new() };
        let (mut engine, mut host) = (EngineEnd::new(shared), HostEnd::new(host, 128));
        assert_eq!(engine.delay(), 256);
        let mut out = Vec::new();
        for (k, block) in (0..4096).map(|i| i as f32).collect::<Vec<_>>().chunks(128).enumerate() {
            let (mut l, mut r) = (block.to_vec(), block.to_vec());
            if k > 0 {
                // A plugin reporting 100 frames of latency (the audio is not delayed here): the
                // live link does not shift it.
                while host.pump(0, 100, |_, _| {}) {}
            }
            engine.process(&mut l, &mut r, false);
            out.extend(l);
        }
        assert_eq!(out[3000], (3000 - 256) as f32);
    }

    #[test]
    fn plugin_latency_is_removed() {
        let (mut engine, mut host) = link(&format!("lat-{}", std::process::id()));
        // A plugin that delays by 100 frames: the link takes them off again.
        let mut history: Vec<f32> = vec![0.0; 100];
        let mut out = Vec::new();
        for (k, block) in (0..6000).map(|i| i as f32).collect::<Vec<_>>().chunks(500).enumerate() {
            let (mut l, mut r) = (block.to_vec(), block.to_vec());
            if k > 0 {
                while host.pump(0, 100, |l, r| {
                    for i in 0..l.len() {
                        history.push(l[i]);
                        let v = history.remove(0);
                        l[i] = v;
                        r[i] = v;
                    }
                }) {}
            }
            engine.process(&mut l, &mut r, false);
            out.extend(l);
        }
        assert_eq!(out[3000], (3000 - LATENCY) as f32);
    }
}
