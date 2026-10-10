// Builds crates/tabstudio-core for the WebView: cargo (wasm32-unknown-unknown, release)
// then wasm-bindgen --target web into src/core/wasm/ (committed, so building the app does
// not need Rust). Needs the wasm32 target and wasm-bindgen-cli 0.2.129 (see P3 S11).
// Usage: node scripts/build-core-wasm.mjs
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const crate=path.resolve('crates/tabstudio-core');
execFileSync('cargo',['build','--release','--target','wasm32-unknown-unknown'],{cwd:crate,stdio:'inherit'});
execFileSync('wasm-bindgen',['--target','web','--out-dir',path.resolve('src/core/wasm'),path.join(crate,'target/wasm32-unknown-unknown/release/tabstudio_core.wasm')],{stdio:'inherit'});
console.log('wrote src/core/wasm/');
