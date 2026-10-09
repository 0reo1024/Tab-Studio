// Spike S9: nam-engine.wasm (the same build the WebAudio worklet runs) driven from Rust
// through wasmtime. Renders a WAV-like f32 input through the model in 128-frame blocks,
// exactly as nam-worklet.js does, and reports speed.
// Usage: s9-nam-wasm <nam-engine.wasm> <model.nam> <input.f32 mono> <output.f32> <rate>
use std::time::Instant;
use wasmtime::*;

fn main() -> wasmtime::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let rate: f64 = a[5].parse()?;
    let t = Instant::now();
    let mut config = Config::new();
    config.wasm_exceptions(true);
    let engine = Engine::new(&config)?;
    let module = Module::from_file(&engine, &a[1])?;
    println!("compile {:?}", t.elapsed());
    let mut store = Store::new(&engine, ());
    let mut linker = Linker::new(&engine);
    // Emscripten imports (module "a"): only abort/heap growth/environ/fd stubs.
    linker.func_wrap("a", "h", || -> Result<()> { Err(Error::msg("abort")) })?;
    linker.func_wrap("a", "g", |mut c: Caller<'_, ()>, size: i32| -> i32 {
        let mem = c.get_export("i").and_then(|e| e.into_memory()).unwrap();
        let old = mem.data_size(&c) as u64;
        let want = size as u32 as u64;
        if want > 536870912 { return 0; }
        let mut cut = 1.0;
        while cut <= 4.0 {
            let over = ((old as f64) * (1.0 + 0.2 / cut)).min(want as f64 + 100663296.0);
            let next = ((want as f64).max(over) / 65536.0).ceil() as u64 * 65536;
            let next = next.min(536870912);
            if mem.grow(&mut c, (next.saturating_sub(old) + 65535) / 65536).is_ok() { return 1; }
            cut *= 2.0;
        }
        0
    })?;
    linker.func_wrap("a", "b", |_: i32, _: i32| -> i32 { 0 })?;
    linker.func_wrap("a", "c", |mut c: Caller<'_, ()>, count: i32, size: i32| -> i32 {
        let mem = c.get_export("i").and_then(|e| e.into_memory()).unwrap();
        let d = mem.data_mut(&mut c);
        d[count as usize..count as usize + 4].copy_from_slice(&0u32.to_le_bytes());
        d[size as usize..size as usize + 4].copy_from_slice(&0u32.to_le_bytes());
        0
    })?;
    linker.func_wrap("a", "d", |_: i32| -> i32 { 52 })?;
    linker.func_wrap("a", "e", |_: i32, _: i32, _: i32, _: i32| -> i32 { 52 })?;
    linker.func_wrap("a", "f", |_: i32, _: i64, _: i32, _: i32| -> i32 { 70 })?;
    linker.func_wrap("a", "a", |mut c: Caller<'_, ()>, _fd: i32, iov: i32, n: i32, pnum: i32| -> i32 {
        let mem = c.get_export("i").and_then(|e| e.into_memory()).unwrap();
        let d = mem.data_mut(&mut c);
        let rd = |d: &[u8], p: usize| u32::from_le_bytes(d[p..p + 4].try_into().unwrap()) as usize;
        let mut total = 0;
        for i in 0..n as usize {
            let (ptr, len) = (rd(d, iov as usize + i * 8), rd(d, iov as usize + i * 8 + 4));
            eprint!("{}", String::from_utf8_lossy(&d[ptr..ptr + len]));
            total += len;
        }
        d[pnum as usize..pnum as usize + 4].copy_from_slice(&(total as u32).to_le_bytes());
        0
    })?;
    let inst = linker.instantiate(&mut store, &module)?;
    let mem = inst.get_memory(&mut store, "i").unwrap();
    inst.get_typed_func::<(), ()>(&mut store, "j")?.call(&mut store, ())?;
    let create = inst.get_typed_func::<(f32, i32), i32>(&mut store, "k");
    let create = match create { Ok(f) => f, Err(_) => { eprintln!("k type: {:?}", inst.get_func(&mut store, "k").unwrap().ty(&store)); return Ok(()); } };
    let id = create.call(&mut store, (rate as f32, 128))?;
    let buffer = inst.get_typed_func::<i32, i32>(&mut store, "p")?.call(&mut store, id)? as usize;
    let malloc = inst.get_typed_func::<i32, i32>(&mut store, "B")?;
    let free = inst.get_typed_func::<i32, ()>(&mut store, "A")?;
    let json = std::fs::read(&a[2])?;
    let ptr = malloc.call(&mut store, json.len() as i32 + 1)? as usize;
    mem.data_mut(&mut store)[ptr..ptr + json.len()].copy_from_slice(&json);
    mem.data_mut(&mut store)[ptr + json.len()] = 0;
    let t = Instant::now();
    let load = inst.get_func(&mut store, "m").unwrap();
    println!("m type {:?}", load.ty(&store));
    let load = inst.get_typed_func::<(i32, i32, f32), i32>(&mut store, "m")?;
    let ok = load.call(&mut store, (id, ptr as i32, 0.0))?;
    free.call(&mut store, ptr as i32)?;
    println!("load ok={ok} {:?}", t.elapsed());
    let process = inst.get_typed_func::<(i32, i32), ()>(&mut store, "q")?;
    let raw = std::fs::read(&a[3])?;
    let input: Vec<f32> = raw.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
    let mut out = vec![0f32; input.len()];
    let t = Instant::now();
    for (i, block) in input.chunks(128).enumerate() {
        let d = mem.data_mut(&mut store);
        for (j, v) in block.iter().enumerate() {
            d[buffer + j * 4..buffer + j * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        process.call(&mut store, (id, block.len() as i32))?;
        let d = mem.data(&store);
        for j in 0..block.len() {
            out[i * 128 + j] = f32::from_le_bytes(d[buffer + j * 4..buffer + j * 4 + 4].try_into().unwrap());
        }
    }
    let secs = input.len() as f64 / rate;
    println!("process {:?} for {secs:.1}s audio ({:.1}% of real time)", t.elapsed(), t.elapsed().as_secs_f64() / secs * 100.0);
    std::fs::write(&a[4], out.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())?;
    Ok(())
}
