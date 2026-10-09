// P2-14 exit check in the Tauri build with the native engine: a real song (default
// ~/Desktop/Champagne.tg, or SONG=path) plays with its own SFZ/NAM/FX settings while the
// device callback timing is recorded; then the warm start time (Play click -> engine
// playing) is measured several times. Output is muted (TAB_STUDIO_TEST_MUTE).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';
const song=process.env.SONG||path.join(os.homedir(),'Desktop','Champagne.tg'),seconds=Number(process.env.SECONDS_PLAYED||60);
assert.ok(fs.existsSync(song),'song not found: '+song);
const app=await launchTauri({dataDir:path.resolve(`test-results/tauri-p2-exit-${Date.now()}`),env:{TAB_STUDIO_TEST_MUTE:'1'},executable:tauriExecutable(process.env.TAURI_PROFILE||'release')});
const {page}=app;
try{
 await page.waitForFunction(()=>!!window.nativeAudio,{},{timeout:30000});
 await page.evaluate(()=>localStorage.setItem('tabstudio-settings',JSON.stringify({nativeAudio:true})));
 await page.reload();await page.waitForLoadState('domcontentloaded');
 await page.locator('#start-demo').click({timeout:30000});
 await page.waitForFunction(()=>window.tabStudio?.getState().ready,{},{timeout:60000});
 const bytes=[...fs.readFileSync(song)];
 await page.evaluate(([name,b])=>window.tabStudio.load(name,new Uint8Array(b)),[path.basename(song),bytes]);
 await page.waitForFunction(()=>window.tabStudio.getState().ready&&!window.tabStudio.getState().rendering,{},{timeout:120000});
 const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
 const tracks=await page.evaluate(()=>window.tabStudio.getScore().tracks.length);
 let t=Date.now();await page.locator('#play').click();
 await page.waitForFunction(()=>window.tabStudio.getState().playing,{},{timeout:120000});
 console.log(`${path.basename(song)}: ${tracks} tracks, first play (loads SFZ/NAM/FX) after ${Date.now()-t} ms`);
 const before=(await status()).callbacks;
 await page.waitForTimeout(seconds*1000);
 const after=await status();
 const played=after.callbacks.count-before.count;
 console.log(`played ${seconds} s: callbacks ${played}, overloads ${after.callbacks.overloads-before.overloads}, max ${after.callbacks.maxMicros} us, mean ${after.callbacks.meanMicros} us (device buffer ${after.callbacks.frames} frames), external FX late frames ${after.fxLate}`);
 await page.locator('#play').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing);
 // Warm starts: click -> the engine reports playing (status polled over IPC, so this
 // includes about one IPC round trip).
 const starts=[];
 for(let i=0;i<7;i++){
  await page.waitForTimeout(400);
  const ms=await page.evaluate(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke,t0=performance.now();document.querySelector('#play').click();
   while(!(await invoke('audio_status')).playing){if(performance.now()-t0>5000)return -1;}return performance.now()-t0;});
  starts.push(Math.round(ms*10)/10);
  await page.waitForTimeout(300);await page.locator('#play').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing);
 }
 const sorted=[...starts].sort((a,b)=>a-b);
 console.log('warm play start (ms):',starts.join(', '),'median',sorted[3]);
 assert.equal(after.callbacks.overloads-before.overloads,0,'no overloads while playing');
 assert.ok(sorted[3]>0&&sorted[3]<100,'play starts within 100 ms');
 console.log('PASS tauri-p2-exit-check');
}finally{await app.close();}
