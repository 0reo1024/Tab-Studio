// Spike S11: the wasm-bindgen module inside the real app pages (Tauri's WebView2 and
// Electron's Chromium): instantiate from bytes, edit, undo, and time a call.
import fs from 'node:fs';
import path from 'node:path';
import {_electron as electron} from '@playwright/test';
import {launchTauri,tauriExecutable} from '../../scripts/tauri-app.mjs';
const glue=fs.readFileSync('spikes/s11-wasm/pkg/s11_wasm.js','utf8'),wasm=[...fs.readFileSync('spikes/s11-wasm/pkg/s11_wasm_bg.wasm')];
const probe=async page=>page.evaluate(async([glue,wasm])=>{
 const url=URL.createObjectURL(new Blob([glue],{type:'text/javascript'}));const m=await import(url);
 m.initSync({module:new Uint8Array(wasm)});const doc=new m.Doc(1000);
 const t=performance.now();for(let i=0;i<200000;i++)doc.set_fret(i%1000,i%24);const us=(performance.now()-t)*1000/200000;
 doc.set_fret(3,7);doc.set_fret(3,9);doc.undo();
 return {fret:doc.fret(3),callMicros:Math.round(us*1000)/1000,userAgent:navigator.userAgent.match(/(Chrome|Edg)\/[\d.]+/g)?.join(' ')};
},[glue,wasm]);
const tauri=await launchTauri({dataDir:path.resolve(`test-results/s11-${Date.now()}`),executable:tauriExecutable('release')});
try{await tauri.page.waitForFunction(()=>!!window.nativeAudio,{},{timeout:30000});console.log('Tauri   ',JSON.stringify(await probe(tauri.page)));}finally{await tauri.app?.close?.();await tauri.close();}
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST:'1',TAB_STUDIO_TEST_DATA:path.resolve(`test-results/s11-e-${Date.now()}`)}});
try{const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');console.log('Electron',JSON.stringify(await probe(page)));}finally{await app.close();}
