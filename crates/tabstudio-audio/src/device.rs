//! Audio devices for the engine: WASAPI (shared, the default) or ASIO, the output and an
//! optional instrument input (live.rs). Unlike output::open_default this opens a chosen
//! device, converts to the driver's sample format (ASIO drivers want their own, e.g. I32)
//! and gives the engine core back when the streams close, so the device can be switched
//! while the song, mixer and effects stay loaded.
//!
//! With ASIO the input stream is built first: cpal then calls it before the output in every
//! buffer switch, so the monitor plays the same buffer's input (latency = input + output
//! buffer + the driver's own).
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::engine::{Control, Core, new_engine};
use crate::live::InputTap;
use crate::output::CallbackStats;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Wasapi,
    Asio,
}

impl Backend {
    pub fn parse(name: &str) -> Backend {
        if name.eq_ignore_ascii_case("asio") { Backend::Asio } else { Backend::Wasapi }
    }
    pub fn name(self) -> &'static str {
        match self {
            Backend::Wasapi => "wasapi",
            Backend::Asio => "asio",
        }
    }
    fn host(self) -> Result<cpal::Host, String> {
        match self {
            Backend::Wasapi => Ok(cpal::default_host()),
            #[cfg(all(windows, feature = "asio"))]
            Backend::Asio => cpal::host_from_id(cpal::HostId::Asio).map_err(|e| format!("ASIOを使えません：{e}")),
            #[cfg(not(all(windows, feature = "asio")))]
            Backend::Asio => Err("このビルドはASIOに対応していません。".into()),
        }
    }
}

/// Which device to open.
#[derive(Clone, Debug, PartialEq)]
pub struct DeviceSpec {
    pub backend: Backend,
    /// Output device (WASAPI) or ASIO driver name; None: the default.
    pub output: Option<String>,
    /// Instrument input: None for no input. WASAPI: the input device (None: default);
    /// ASIO always uses the same driver as the output.
    pub input: Option<Option<String>>,
    /// Buffer size in frames (ASIO; WASAPI shared mode ignores it).
    pub buffer: Option<u32>,
}

impl Default for DeviceSpec {
    fn default() -> Self {
        DeviceSpec { backend: Backend::Wasapi, output: None, input: None, buffer: None }
    }
}

/// A device as the settings list it.
#[derive(Clone, Debug, PartialEq)]
pub struct DeviceInfo {
    pub backend: Backend,
    pub name: String,
    pub inputs: u16,
    pub outputs: u16,
    pub sample_rate: u32,
    pub buffer_min: u32,
    pub buffer_max: u32,
    pub default_output: bool,
    pub default_input: bool,
}

fn name(device: &cpal::Device) -> String {
    device.description().map(|d| d.to_string()).unwrap_or_else(|_| "?".into())
}

fn buffer_range(size: &cpal::SupportedBufferSize) -> (u32, u32) {
    match size {
        cpal::SupportedBufferSize::Range { min, max } => (*min, *max),
        _ => (0, 0),
    }
}

/// Every device of every available backend.
pub fn list() -> Vec<DeviceInfo> {
    let mut out = Vec::new();
    for backend in [Backend::Wasapi, Backend::Asio] {
        let Ok(host) = backend.host() else { continue };
        let default_out = host.default_output_device().map(|d| name(&d));
        let default_in = host.default_input_device().map(|d| name(&d));
        let Ok(devices) = host.devices() else { continue };
        for device in devices {
            let n = name(&device);
            let input = device.default_input_config().ok();
            let output = device.default_output_config().ok();
            let any = output.as_ref().or(input.as_ref());
            let Some(any) = any else { continue };
            let (buffer_min, buffer_max) = buffer_range(any.buffer_size());
            out.push(DeviceInfo {
                backend,
                inputs: input.as_ref().map_or(0, |c| c.channels()),
                outputs: output.as_ref().map_or(0, |c| c.channels()),
                sample_rate: any.sample_rate(),
                buffer_min,
                buffer_max,
                default_output: default_out.as_deref() == Some(n.as_str()),
                default_input: default_in.as_deref() == Some(n.as_str()),
                name: n,
            });
        }
    }
    out
}

fn find(host: &cpal::Host, wanted: Option<&str>, input: bool) -> Result<cpal::Device, String> {
    let device = match wanted {
        None if input => host.default_input_device(),
        None => host.default_output_device(),
        Some(w) => {
            let list: Vec<cpal::Device> = host.devices().map_err(|e| e.to_string())?.collect();
            let matches = |d: &cpal::Device| if input { d.default_input_config().is_ok() } else { d.default_output_config().is_ok() };
            let exact = list.iter().find(|d| name(d) == w && matches(d)).cloned();
            exact.or_else(|| list.into_iter().find(|d| name(d).contains(w) && matches(d)))
        }
    };
    device.ok_or_else(|| format!("{}「{}」が見つかりません。", if input { "入力デバイス" } else { "出力デバイス" }, wanted.unwrap_or("既定")))
}

/// The sample rate `spec` would open at (to check before switching a running engine).
pub fn probe_rate(spec: &DeviceSpec) -> Result<u32, String> {
    let host = spec.backend.host()?;
    let device = find(&host, spec.output.as_deref(), false)?;
    Ok(device.default_output_config().map_err(|e| e.to_string())?.sample_rate())
}

/// The engine core inside a callback; sent back when the callback is dropped.
struct Holder {
    core: Option<Core>,
    back: Sender<Core>,
}

impl Drop for Holder {
    fn drop(&mut self) {
        if let Some(core) = self.core.take() {
            let _ = self.back.send(core);
        }
    }
}

/// The input tap inside the input callback; sent back when the callback is dropped, so a
/// reopened device keeps feeding the same monitor and recorder.
struct TapHolder {
    tap: Option<InputTap>,
    back: Sender<InputTap>,
}

impl Drop for TapHolder {
    fn drop(&mut self) {
        if let Some(tap) = self.tap.take() {
            let _ = self.back.send(tap);
        }
    }
}

/// What a stream error means for the device.
fn on_error(stats: &CallbackStats, error: &cpal::Error, input: bool) {
    use cpal::ErrorKind::*;
    match error.kind() {
        DeviceNotAvailable | StreamInvalidated | HostUnavailable => {
            stats.lost.fetch_add(1, Ordering::Relaxed);
        }
        Xrun => {
            stats.xruns.fetch_add(1, Ordering::Relaxed);
        }
        _ => {}
    }
    eprintln!("audio {} error: {error}", if input { "input" } else { "output" });
}

/// The open streams (not Send: keep them on the thread that opened them).
pub struct Streams {
    _input: Option<cpal::Stream>,
    _output: cpal::Stream,
}

/// What was opened.
pub struct Opened {
    pub stats: Arc<CallbackStats>,
    pub sample_rate: u32,
    pub channels: u16,
    pub output_name: String,
    pub input_name: Option<String>,
    pub input_channels: u16,
    /// Buffer the driver runs at (frames; WASAPI: its period).
    pub buffer: u32,
    pub backend: Backend,
}

/// How the core is supplied: an existing one (switching devices) or a new one.
pub enum CoreSource {
    New,
    Existing(Core),
}

/// What `open` hands back when the streams close: the core, and the input tap if any.
pub struct Returned {
    pub core: Receiver<Core>,
    pub tap: Receiver<InputTap>,
}

/// Opens `spec`. The core (and the tap) come back through `Returned` when the streams close,
/// or at once if opening failed; a new engine's Control is returned with the streams.
pub fn open(spec: &DeviceSpec, core: CoreSource, tap: Option<InputTap>) -> (Result<(Streams, Opened, Option<Control>), String>, Returned) {
    let (back, returned) = channel();
    let (tap_back, tap_returned) = channel();
    let tap = TapHolder { tap, back: tap_back };
    let result = open_inner(spec, core, tap, back);
    (result, Returned { core: returned, tap: tap_returned })
}

fn open_inner(spec: &DeviceSpec, core: CoreSource, mut tap: TapHolder, back: Sender<Core>) -> Result<(Streams, Opened, Option<Control>), String> {
    // Whatever happens, an existing core goes back through `back` (Holder's drop).
    let mut holder = Holder { core: None, back };
    let mut existing = None;
    if let CoreSource::Existing(core) = core {
        existing = Some(core);
    }
    let host = spec.backend.host()?;
    let output = find(&host, spec.output.as_deref(), false)?;
    let out_default = output.default_output_config().map_err(|e| e.to_string())?;
    let rate = out_default.sample_rate();
    let control = match existing {
        Some(core) => {
            holder.core = Some(core);
            None
        }
        None => {
            let (core, control) = new_engine(rate);
            holder.core = Some(core);
            Some(control)
        }
    };
    if control.is_none() && holder.core.as_ref().is_some_and(|c| c.sample_rate() != rate) {
        return Err(format!("サンプルレートが違います（{} Hz → {} Hz）。アプリを再起動すると切り替わります。", holder.core.as_ref().map_or(0, |c| c.sample_rate()), rate));
    }
    // ASIO: the first two outputs (drivers list every output); WASAPI: the device's own
    // layout (the engine writes silence to channels past two).
    let channels = if spec.backend == Backend::Asio { out_default.channels().min(2) } else { out_default.channels() }.max(1);
    let mut out_config = out_default.config();
    out_config.channels = channels;
    if let Some(frames) = spec.buffer.filter(|_| spec.backend == Backend::Asio) {
        let (min, max) = buffer_range(out_default.buffer_size());
        out_config.buffer_size = cpal::BufferSize::Fixed(if max > 0 { frames.clamp(min, max) } else { frames });
    }
    let stats = Arc::new(CallbackStats::default());

    // Input first (see the module notes).
    let (mut input_stream, mut input_name, mut input_channels) = (None, None, 0);
    if let (Some(wanted), true) = (&spec.input, tap.tap.is_some()) {
        let device = match spec.backend {
            Backend::Asio => output.clone(),
            Backend::Wasapi => find(&host, wanted.as_deref(), true)?,
        };
        let config = device.default_input_config().map_err(|e| format!("入力を開けません：{e}"))?;
        if config.sample_rate() != rate {
            return Err(format!("入力（{} Hz）と出力（{} Hz）のサンプルレートが違います。どちらかの設定を合わせてください。", config.sample_rate(), rate));
        }
        let mut in_config = config.config();
        in_config.buffer_size = out_config.buffer_size;
        input_channels = in_config.channels;
        let holder = TapHolder { tap: tap.tap.take(), back: tap.back.clone() };
        let stream = build_input(&device, in_config, config.sample_format(), holder, stats.clone())?;
        input_name = Some(name(&device));
        input_stream = Some(stream);
    }
    let output_stream = build_output(&output, out_config.clone(), out_default.sample_format(), &mut holder, stats.clone())?;
    if let Some(s) = &input_stream {
        s.play().map_err(|e| e.to_string())?;
    }
    output_stream.play().map_err(|e| e.to_string())?;
    let buffer = match out_config.buffer_size {
        cpal::BufferSize::Fixed(f) => f,
        cpal::BufferSize::Default => buffer_range(out_default.buffer_size()).0,
    };
    let opened = Opened { stats, sample_rate: rate, channels, output_name: name(&output), input_name, input_channels, buffer, backend: spec.backend };
    Ok((Streams { _input: input_stream, _output: output_stream }, opened, control))
}

fn build_output(device: &cpal::Device, config: cpal::StreamConfig, format: cpal::SampleFormat, holder: &mut Holder, stats: Arc<CallbackStats>) -> Result<cpal::Stream, String> {
    let moved = Holder { core: holder.core.take(), back: holder.back.clone() };
    match format {
        cpal::SampleFormat::F32 => output_stream::<f32>(device, config, moved, stats),
        cpal::SampleFormat::I32 => output_stream::<i32>(device, config, moved, stats),
        cpal::SampleFormat::I16 => output_stream::<i16>(device, config, moved, stats),
        cpal::SampleFormat::I24 => output_stream::<cpal::I24>(device, config, moved, stats),
        other => Err(format!("出力のサンプル形式 {other} には対応していません。")),
    }
}

fn output_stream<T>(device: &cpal::Device, config: cpal::StreamConfig, mut holder: Holder, stats: Arc<CallbackStats>) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + cpal::FromSample<f32> + Send + 'static,
{
    let ch = config.channels.max(1) as usize;
    let rate = config.sample_rate as f64;
    let mut scratch = vec![0f32; 4096 * ch];
    let errors = stats.clone();
    device
        .build_output_stream::<T, _, _>(
            config,
            move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
                let started = Instant::now();
                if let Some(core) = holder.core.as_mut() {
                    for chunk in data.chunks_mut(scratch.len()) {
                        let s = &mut scratch[..chunk.len()];
                        core.process(s, ch);
                        for (o, v) in chunk.iter_mut().zip(s.iter()) {
                            *o = T::from_sample(*v);
                        }
                    }
                }
                let ts = info.timestamp();
                stats.output_latency_us.store(ts.playback.saturating_duration_since(ts.callback).as_micros() as u64, Ordering::Relaxed);
                record(&stats, started, data.len() / ch, rate);
            },
            move |error| on_error(&errors, &error, false),
            None,
        )
        .map_err(|e| format!("出力を開けません：{e}"))
}

fn record(stats: &CallbackStats, started: Instant, frames: usize, rate: f64) {
    let micros = started.elapsed().as_micros() as u64;
    let budget = (frames as f64 / rate * 1e6) as u64;
    stats.callbacks.fetch_add(1, Ordering::Relaxed);
    stats.last_frames.store(frames as u64, Ordering::Relaxed);
    stats.max_micros.fetch_max(micros, Ordering::Relaxed);
    stats.total_micros.fetch_add(micros, Ordering::Relaxed);
    if micros > budget {
        stats.overloads.fetch_add(1, Ordering::Relaxed);
    }
}

fn build_input(device: &cpal::Device, config: cpal::StreamConfig, format: cpal::SampleFormat, tap: TapHolder, stats: Arc<CallbackStats>) -> Result<cpal::Stream, String> {
    match format {
        cpal::SampleFormat::F32 => input_stream::<f32>(device, config, tap, stats),
        cpal::SampleFormat::I32 => input_stream::<i32>(device, config, tap, stats),
        cpal::SampleFormat::I16 => input_stream::<i16>(device, config, tap, stats),
        cpal::SampleFormat::I24 => input_stream::<cpal::I24>(device, config, tap, stats),
        other => Err(format!("入力のサンプル形式 {other} には対応していません。")),
    }
}

fn input_stream<T>(device: &cpal::Device, config: cpal::StreamConfig, mut tap: TapHolder, stats: Arc<CallbackStats>) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    let ch = config.channels.max(1) as usize;
    let mut scratch = vec![0f32; 4096 * ch];
    let errors = stats.clone();
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], info: &cpal::InputCallbackInfo| {
                for chunk in data.chunks(scratch.len()) {
                    let s = &mut scratch[..chunk.len()];
                    for (o, v) in s.iter_mut().zip(chunk.iter()) {
                        *o = <f32 as cpal::FromSample<T>>::from_sample_(*v);
                    }
                    if let Some(tap) = tap.tap.as_mut() {
                        tap.push(s, ch);
                    }
                }
                let ts = info.timestamp();
                stats.input_latency_us.store(ts.callback.saturating_duration_since(ts.capture).as_micros() as u64, Ordering::Relaxed);
            },
            move |error| on_error(&errors, &error, true),
            None,
        )
        .map_err(|e| format!("入力を開けません：{e}"))
}
