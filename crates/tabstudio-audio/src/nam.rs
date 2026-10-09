//! NAM amp stage, matching the WebAudio chain in src/mixer-audio.ts configure():
//! input gain -> NAM (mono) -> lowshelf 150 Hz, peaking 800 Hz, highshelf 3500 Hz ->
//! highpass 70 Hz / lowpass 6500 Hz (cabinet; 0 Hz / Nyquist when off) -> output gain.
//!
//! The model runs in the same nam-engine.wasm the worklet runs (neural-amp-modeler-wasm
//! 2.0.1, MIT), here through wasmtime, so the amp sounds bit-identical (spike S9). Wasmtime
//! does not run the legacy exception-handling encoding Emscripten emitted, so the crate
//! embeds a copy translated to the standard (exnref) encoding by binaryen's wasm-opt
//! --translate-to-exnref (see scripts/convert-nam-wasm.mjs); the arithmetic is unchanged.
use std::path::Path;
use std::sync::Arc;

use wasmtime::{Caller, Config, Engine, Instance, Linker, Memory, Module, Store, TypedFunc};

use crate::dsp::{Biquad, FilterKind};

const WASM: &[u8] = include_bytes!("../assets/nam-engine-exnref.wasm");
/// The worklet's render quantum; the wasm instance buffer holds this many frames.
const QUANTUM: usize = 128;
/// After a model load the worklet fades in over 1024 frames.
const FADE_IN_FRAMES: usize = 1024;
const HEAP_MAX: u64 = 536_870_912;

/// The compiled wasm module, shared by every amp (compiling takes about a second).
pub struct NamRuntime {
    engine: Engine,
    module: Module,
}

impl NamRuntime {
    /// Compiles the module, or reuses a compiled copy from `cache_dir` when it is current.
    pub fn new(cache_dir: Option<&Path>) -> Result<Arc<NamRuntime>, String> {
        let mut config = Config::new();
        config.wasm_exceptions(true);
        let engine = Engine::new(&config).map_err(|e| e.to_string())?;
        let cached = cache_dir.map(|dir| dir.join(format!("nam-engine-{:016x}.cwasm", cache_key(&engine))));
        if let Some(path) = cached.as_ref().filter(|p| p.is_file()) {
            // SAFETY: the file is our own serialization for this exact engine configuration
            // (the name carries its compatibility hash); a stale or broken one fails to load
            // and is recompiled below.
            if let Ok(module) = unsafe { Module::deserialize_file(&engine, path) } {
                return Ok(Arc::new(NamRuntime { engine, module }));
            }
        }
        let module = Module::new(&engine, WASM).map_err(|e| format!("NAMエンジンを準備できません：{e}"))?;
        if let (Some(path), Ok(bytes)) = (cached, module.serialize()) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let partial = path.with_extension("writing");
            if std::fs::write(&partial, bytes).is_ok() {
                let _ = std::fs::rename(&partial, &path);
            }
        }
        Ok(Arc::new(NamRuntime { engine, module }))
    }
}

fn cache_key(engine: &Engine) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    engine.precompile_compatibility_hash().hash(&mut h);
    WASM.len().hash(&mut h);
    WASM[..4096.min(WASM.len())].hash(&mut h);
    WASM[WASM.len().saturating_sub(4096)..].hash(&mut h);
    h.finish()
}

fn memory(c: &mut Caller<'_, ()>) -> Option<Memory> {
    c.get_export("i").and_then(|e| e.into_memory())
}

fn write_u32(data: &mut [u8], at: i32, value: u32) {
    let at = at as u32 as usize;
    if let Some(slot) = data.get_mut(at..at + 4) {
        slot.copy_from_slice(&value.to_le_bytes());
    }
}

/// One NAM model instance (its own wasm instance and memory).
pub struct NamAmp {
    store: Store<()>,
    memory: Memory,
    process: TypedFunc<(i32, i32), ()>,
    id: i32,
    buffer: usize,
    sample_rate: f64,
    silent_frames: usize,
    fade: usize,
    failed: bool,
}

impl NamAmp {
    /// Instantiates the engine and loads a .nam model (JSON text). Allocates; not for the audio thread.
    pub fn new(runtime: &NamRuntime, json: &str, sample_rate: f64) -> Result<NamAmp, String> {
        let error = |e: wasmtime::Error| format!("NAMモデルを読み込めません：{e}");
        let mut store = Store::new(&runtime.engine, ());
        let mut linker = Linker::new(&runtime.engine);
        // The Emscripten imports, with the glue's behaviour (no files, empty environment).
        linker.func_wrap("a", "h", || -> wasmtime::Result<()> { Err(wasmtime::Error::msg("NAM engine aborted")) }).map_err(error)?;
        linker
            .func_wrap("a", "g", |mut c: Caller<'_, ()>, requested: i32| -> i32 {
                let Some(mem) = memory(&mut c) else { return 0 };
                let (old, want) = (mem.data_size(&c) as u64, requested as u32 as u64);
                if want > HEAP_MAX {
                    return 0;
                }
                let mut cut = 1.0;
                while cut <= 4.0 {
                    let over = ((old as f64) * (1.0 + 0.2 / cut)).min(want as f64 + 100_663_296.0);
                    let next = (((want as f64).max(over) / 65536.0).ceil() as u64 * 65536).min(HEAP_MAX);
                    if mem.grow(&mut c, next.saturating_sub(old).div_ceil(65536)).is_ok() {
                        return 1;
                    }
                    cut *= 2.0;
                }
                0
            })
            .map_err(error)?;
        linker.func_wrap("a", "b", |_: i32, _: i32| -> i32 { 0 }).map_err(error)?;
        linker
            .func_wrap("a", "c", |mut c: Caller<'_, ()>, count: i32, size: i32| -> i32 {
                if let Some(mem) = memory(&mut c) {
                    let data = mem.data_mut(&mut c);
                    write_u32(data, count, 0);
                    write_u32(data, size, 0);
                }
                0
            })
            .map_err(error)?;
        linker.func_wrap("a", "d", |_: i32| -> i32 { 52 }).map_err(error)?;
        linker.func_wrap("a", "e", |_: i32, _: i32, _: i32, _: i32| -> i32 { 52 }).map_err(error)?;
        linker.func_wrap("a", "f", |_: i32, _: i64, _: i32, _: i32| -> i32 { 70 }).map_err(error)?;
        // stdout/stderr: counted and dropped.
        linker
            .func_wrap("a", "a", |mut c: Caller<'_, ()>, _fd: i32, iov: i32, count: i32, written: i32| -> i32 {
                let Some(mem) = memory(&mut c) else { return 0 };
                let data = mem.data_mut(&mut c);
                let read = |at: usize| data.get(at..at + 4).map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
                let total: u32 = (0..count.max(0) as usize).map(|i| read(iov as u32 as usize + i * 8 + 4)).sum();
                write_u32(data, written, total);
                0
            })
            .map_err(error)?;
        let instance: Instance = linker.instantiate(&mut store, &runtime.module).map_err(error)?;
        let memory = instance.get_memory(&mut store, "i").ok_or("NAMエンジンが不正です。")?;
        instance.get_typed_func::<(), ()>(&mut store, "j").map_err(error)?.call(&mut store, ()).map_err(error)?;
        let id = instance.get_typed_func::<(f32, i32), i32>(&mut store, "k").map_err(error)?.call(&mut store, (sample_rate as f32, QUANTUM as i32)).map_err(error)?;
        let buffer = instance.get_typed_func::<i32, i32>(&mut store, "p").map_err(error)?.call(&mut store, id).map_err(error)? as u32 as usize;
        let malloc = instance.get_typed_func::<i32, i32>(&mut store, "B").map_err(error)?;
        let free = instance.get_typed_func::<i32, ()>(&mut store, "A").map_err(error)?;
        let bytes = json.as_bytes();
        let ptr = malloc.call(&mut store, bytes.len() as i32 + 1).map_err(error)? as u32 as usize;
        {
            let data = memory.data_mut(&mut store);
            let slot = data.get_mut(ptr..ptr + bytes.len() + 1).ok_or("NAMモデルが大きすぎます。")?;
            slot[..bytes.len()].copy_from_slice(bytes);
            slot[bytes.len()] = 0;
        }
        let ok = instance.get_typed_func::<(i32, i32, f32), i32>(&mut store, "m").map_err(error)?.call(&mut store, (id, ptr as i32, 0.0)).map_err(error)?;
        free.call(&mut store, ptr as i32).map_err(error)?;
        if ok == 0 {
            let at = instance.get_typed_func::<(), i32>(&mut store, "y").map_err(error)?.call(&mut store, ()).map_err(error)? as u32 as usize;
            let data = memory.data(&store);
            let end = data[at..].iter().position(|b| *b == 0).map_or(at, |n| at + n);
            let reason = String::from_utf8_lossy(&data[at..end]).into_owned();
            return Err(format!("NAMモデルを読み込めません：{}", if reason.is_empty() { "model load failed".into() } else { reason }));
        }
        let process = instance.get_typed_func::<(i32, i32), ()>(&mut store, "q").map_err(error)?;
        Ok(NamAmp { store, memory, process, id, buffer, sample_rate, silent_frames: 0, fade: FADE_IN_FRAMES, failed: false })
    }

    /// Runs the model over `samples` in place, in worklet-sized pieces, with the worklet's
    /// fade-in after loading and its idle cut-off (silence after one second of silent input).
    pub fn process(&mut self, samples: &mut [f32]) {
        for chunk in samples.chunks_mut(QUANTUM) {
            if self.failed {
                chunk.fill(0.0);
                continue;
            }
            let silent = chunk.iter().all(|v| v.abs() <= 1e-10);
            self.silent_frames = if silent { self.silent_frames + chunk.len() } else { 0 };
            if self.silent_frames as f64 > self.sample_rate {
                chunk.fill(0.0);
                continue;
            }
            let at = self.buffer;
            let data = self.memory.data_mut(&mut self.store);
            for (i, v) in chunk.iter().enumerate() {
                data[at + i * 4..at + i * 4 + 4].copy_from_slice(&v.to_le_bytes());
            }
            if self.process.call(&mut self.store, (self.id, chunk.len() as i32)).is_err() {
                self.failed = true;
                chunk.fill(0.0);
                continue;
            }
            let data = self.memory.data(&self.store);
            for (i, v) in chunk.iter_mut().enumerate() {
                let b = &data[at + i * 4..at + i * 4 + 4];
                *v = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            }
            for v in chunk.iter_mut() {
                if self.fade == 0 {
                    break;
                }
                *v *= 1.0 - self.fade as f32 / FADE_IN_FRAMES as f32;
                self.fade -= 1;
            }
        }
    }
}

/// The NAM panel's knobs: input/output in dB, bass/mid/treble EQ gains in dB, cabinet filter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NamTone {
    pub input: f32,
    pub output: f32,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    pub cabinet: bool,
}

impl Default for NamTone {
    fn default() -> Self {
        NamTone { input: 0.0, output: -6.0, bass: 0.0, mid: 0.0, treble: 0.0, cabinet: false }
    }
}

/// The amp with its tone stack; the track signal becomes mono here (the NAM node is mono).
pub struct NamStage {
    amp: NamAmp,
    input: f32,
    output: f32,
    filters: [Biquad; 5],
    sample_rate: f64,
}

impl NamStage {
    pub fn new(amp: NamAmp, tone: NamTone, sample_rate: f64) -> NamStage {
        let flat = || Biquad::new(FilterKind::Peaking, 1000.0, 1.0, 0.0, sample_rate);
        let mut stage = NamStage { amp, input: 1.0, output: 1.0, filters: [flat(), flat(), flat(), flat(), flat()], sample_rate };
        stage.set_tone(tone);
        stage
    }

    /// Changes the knobs, keeping filter state (no click).
    pub fn set_tone(&mut self, tone: NamTone) {
        let rate = self.sample_rate;
        self.input = 10f32.powf(tone.input / 20.0);
        self.output = 10f32.powf(tone.output / 20.0);
        self.filters[0].set(FilterKind::Lowshelf, 150.0, 1.0, tone.bass as f64, rate);
        self.filters[1].set(FilterKind::Peaking, 800.0, 1.0, tone.mid as f64, rate);
        self.filters[2].set(FilterKind::Highshelf, 3500.0, 1.0, tone.treble as f64, rate);
        self.filters[3].set(FilterKind::Highpass, if tone.cabinet { 70.0 } else { 0.0 }, 1.0, 0.0, rate);
        self.filters[4].set(FilterKind::Lowpass, if tone.cabinet { 6500.0 } else { rate / 2.0 }, 1.0, 0.0, rate);
    }

    /// Stereo in, the amp's mono signal out on both channels.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        // The mono NAM node down-mixes its (input-gained) stereo input: 0.5 x (L + R).
        for (l, r) in left.iter_mut().zip(right.iter()) {
            *l = 0.5 * (*l * self.input + *r * self.input);
        }
        self.amp.process(left);
        for v in left.iter_mut() {
            let mut x = *v;
            for f in &mut self.filters {
                x = f.process(0, x);
            }
            *v = x * self.output;
        }
        right.copy_from_slice(left);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> String {
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/nam/deluxe-a2.nam")).unwrap()
    }

    fn guitarish(frames: usize) -> Vec<f32> {
        (0..frames).map(|i| {
            let t = i as f32 / 48000.0;
            let env = (-3.0 * (t % 0.5)).exp();
            env * 0.3 * ((t * 110.0 * std::f32::consts::TAU).sin() + 0.5 * (t * 220.0 * std::f32::consts::TAU).sin())
        }).collect()
    }

    #[test]
    fn output_does_not_depend_on_block_size_and_idles_after_silence() {
        let runtime = NamRuntime::new(None).unwrap();
        let input = guitarish(24000);
        let mut a = input.clone();
        let mut amp = NamAmp::new(&runtime, &model(), 48000.0).unwrap();
        amp.process(&mut a);
        let mut b = input.clone();
        let mut amp = NamAmp::new(&runtime, &model(), 48000.0).unwrap();
        for piece in b.chunks_mut(37) {
            amp.process(piece);
        }
        assert!(a.iter().any(|v| v.abs() > 0.01));
        assert_eq!(a, b);
        // After a second of silence the amp outputs exact zeros, as the worklet does.
        let mut quiet = vec![0f32; 48000 + 256];
        amp.process(&mut quiet);
        assert!(quiet[48000 + 128..].iter().all(|v| *v == 0.0));
    }

    #[test]
    fn bad_models_are_reported() {
        let runtime = NamRuntime::new(None).unwrap();
        assert!(NamAmp::new(&runtime, "{\"architecture\":\"Nope\"}", 48000.0).is_err());
    }

    #[test]
    fn stage_outputs_mono_with_tone() {
        let runtime = NamRuntime::new(None).unwrap();
        let amp = NamAmp::new(&runtime, &model(), 48000.0).unwrap();
        let mut stage = NamStage::new(amp, NamTone { cabinet: true, ..NamTone::default() }, 48000.0);
        let mut l = guitarish(4800);
        let mut r: Vec<f32> = l.iter().map(|v| -v * 0.5).collect();
        stage.process(&mut l, &mut r);
        assert_eq!(l, r);
        assert!(l.iter().any(|v| v.abs() > 0.001));
    }
}
