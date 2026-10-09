//! Audio device output (cpal: WASAPI on Windows, CoreAudio on macOS). Owns the stream;
//! the engine core runs inside the device callback. Callback timing is recorded so
//! overloads (a callback that takes longer than the audio it delivers) are visible.
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::engine::{Control, new_engine};

#[derive(Default)]
pub struct CallbackStats {
    pub callbacks: AtomicU64,
    /// Callbacks whose processing took longer than the audio they produced.
    pub overloads: AtomicU64,
    /// Longest processing time, microseconds.
    pub max_micros: AtomicU64,
    /// Sum of processing times, microseconds (mean = total / callbacks).
    pub total_micros: AtomicU64,
    /// Last callback size in frames.
    pub last_frames: AtomicU64,
}

pub struct Output {
    _stream: cpal::Stream,
    pub control: Control,
    pub stats: Arc<CallbackStats>,
    pub sample_rate: u32,
    pub channels: u16,
    pub device_name: String,
}

/// Opens the default output device. `buffer_frames` requests a fixed device buffer
/// (falls back to the device default if refused).
pub fn open_default(buffer_frames: Option<u32>) -> Result<Output, String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("出力デバイスがありません。")?;
    let device_name = device.description().map(|d| d.to_string()).unwrap_or_else(|_| "output".into());
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let sample_rate = supported.sample_rate();
    let channels = supported.channels();
    let mut config = supported.config();
    if let Some(frames) = buffer_frames {
        config.buffer_size = cpal::BufferSize::Fixed(frames);
    }
    let build = |config: cpal::StreamConfig| -> Result<(cpal::Stream, Control, Arc<CallbackStats>), String> {
        let (mut core, control) = new_engine(sample_rate);
        let stats = Arc::new(CallbackStats::default());
        let callback_stats = stats.clone();
        let rate = sample_rate as f64;
        let ch = channels as usize;
        let stream = device
            .build_output_stream::<f32, _, _>(
                config,
                move |data: &mut [f32], _| {
                    let started = Instant::now();
                    core.process(data, ch);
                    let micros = started.elapsed().as_micros() as u64;
                    let frames = (data.len() / ch.max(1)) as u64;
                    let budget = (frames as f64 / rate * 1e6) as u64;
                    callback_stats.callbacks.fetch_add(1, Ordering::Relaxed);
                    callback_stats.last_frames.store(frames, Ordering::Relaxed);
                    callback_stats.max_micros.fetch_max(micros, Ordering::Relaxed);
                    callback_stats.total_micros.fetch_add(micros, Ordering::Relaxed);
                    if micros > budget {
                        callback_stats.overloads.fetch_add(1, Ordering::Relaxed);
                    }
                },
                |error| log_error(&error.to_string()),
                None,
            )
            .map_err(|e| e.to_string())?;
        Ok((stream, control, stats))
    };
    let (stream, control, stats) = match build(config.clone()) {
        Ok(built) => built,
        Err(_) if buffer_frames.is_some() => build(supported.config())?,
        Err(e) => return Err(e),
    };
    stream.play().map_err(|e| e.to_string())?;
    Ok(Output { _stream: stream, control, stats, sample_rate, channels, device_name })
}

/// Keeps the device stream running; dropping it stops the audio.
pub struct StreamGuard {
    _stream: cpal::Stream,
    pub stats: Arc<CallbackStats>,
}

impl Output {
    /// Separates the control side (Send) from the stream, which stays on its thread.
    pub fn split(self) -> (StreamGuard, Control) {
        (StreamGuard { _stream: self._stream, stats: self.stats }, self.control)
    }
}

fn log_error(message: &str) {
    eprintln!("audio output error: {message}");
}
