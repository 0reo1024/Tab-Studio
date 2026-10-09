// Rebuilds crates/tabstudio-audio/assets/nam-engine-exnref.wasm from public/nam/nam-engine.wasm.
// The Emscripten build uses the legacy wasm exception-handling encoding (try/catch), which
// wasmtime does not run; binaryen translates it to the standard exnref encoding. Only
// exception control flow changes: spike S9 checked the output is sample-identical in V8.
// Needs binaryen (Apache-2.0), e.g. installed in a scratch folder: npm install binaryen@132.0.0
// Usage: node scripts/convert-nam-wasm.mjs <path to binaryen's bin/wasm-opt>
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const wasmOpt=process.argv[2];
if(!wasmOpt){console.error('usage: node scripts/convert-nam-wasm.mjs <binaryen/bin/wasm-opt>');process.exit(1);}
const features=['exception-handling','bulk-memory','nontrapping-float-to-int','sign-ext','mutable-globals','simd','reference-types','multivalue'].map(f=>`--enable-${f}`);
execFileSync(process.execPath,[wasmOpt,...features,'--translate-to-exnref',path.resolve('public/nam/nam-engine.wasm'),'-o',path.resolve('crates/tabstudio-audio/assets/nam-engine-exnref.wasm')],{stdio:'inherit'});
console.log('wrote crates/tabstudio-audio/assets/nam-engine-exnref.wasm');
