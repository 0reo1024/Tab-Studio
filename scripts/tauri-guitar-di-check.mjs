// The Guitar DIs in the Tauri release build, muted: a guitar NAM track's sound dialog lists the
// Standard Guitar and the Les Paul DIs (FlameStudios LP and Trummer LP, neck and bridge), and each choice plays
// and is kept. Levels, pitch and per-string bends are checked offline by
// `cargo run --release --example guitar_levels` (crates/tabstudio-audio).
// Usage: TAURI_PROFILE=release node --import tsx scripts/tauri-guitar-di-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';
import {project} from '../src/score.ts';
import {trackAudio,applyNamPreset} from '../src/mixer-state.ts';

const folder=path.resolve(`test-results/guitar-di-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(30000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading&&!document.querySelector('#play').disabled;},{},{timeout:60000});
/** Plays from bar 1; returns the track's peak over its first two bars. */
async function peak(){
 await page.evaluate(()=>window.tabStudio.select(0,0));await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing,{},{timeout:30000});
 const value=await page.evaluate(async()=>{let peak=0;const t0=performance.now();while(performance.now()-t0<3000){const s=await window.__TAURI_INTERNALS__.invoke('audio_status');if(s.position>.1)peak=Math.max(peak,s.peaks[0]??0);await new Promise(r=>setTimeout(r,30));}return peak;});
 await page.locator('#play').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing);return value;
}
try{
 await page.locator('#start-demo').click();await ready();
 const score=at.importer.ScoreLoader.loadAlphaTex('\\title "LP" \\tempo 120 \\track "Guitar" \\staff {tabs} \\instrument 29 . :4 (0.6 2.5 2.4) 3.3 (5.2 5.1) 7.3{b (0 4)} | 0.6 3.6 5.5 (7.4 7.3)',new at.Settings());
 applyNamPreset(trackAudio(score.tracks[0]).nam,'fender-super');
 await page.evaluate(p=>window.tabStudio.load('LP.tabstudio',new TextEncoder().encode(p)),project(score,'LP',[]));await ready();
 const results={standard:await peak()};assert.ok(results.standard>.01,'the Standard Guitar DI sounds');
 await page.locator('#mixer-toggle').click();
 for(const [key,label,file] of [['neck','Guitar DI (LP Neck)','Guitar DI LP Neck'],['bridge','Guitar DI (LP Bridge)','Guitar DI LP Bridge'],['trummerNeck','Guitar DI (Trummer LP Neck)','Trummer LP Neck'],['trummerBridge','Guitar DI (Trummer LP Bridge)','Trummer LP Bridge']]){
  await page.locator('#mixer [data-sound="0"]').click();await page.waitForFunction(()=>document.querySelectorAll('#mixer-sound option').length>=5);
  const options=await page.locator('#mixer-sound option').allInnerTexts();
  assert.deepEqual(options,['Guitar DI (Standard)','Guitar DI (LP Neck)','Guitar DI (LP Bridge)','Guitar DI (Trummer LP Neck)','Guitar DI (Trummer LP Bridge)']);assert.ok(!(await page.locator('#mixer-sound').isDisabled()));
  await page.locator('#mixer-sound').selectOption({label});await page.screenshot({path:path.join(folder,`sound-${key}.png`)});
  await page.getByRole('button',{name:'閉じる',exact:true}).click();await ready();
  const sound=await page.evaluate(()=>JSON.parse(window.tabStudio.serialize()).score.tracks[0].studioaudio.sound);
  assert.ok(sound.path.includes(file),JSON.stringify(sound));
  results[key]=await peak();assert.ok(results[key]>.01,`${label} sounds`);
 }
 const notice=await page.evaluate(()=>document.querySelector('#notice')?.textContent??'');assert.ok(!/エラー|できません|音声エンジン/.test(notice),notice);
 assert.deepEqual(app.errors,[]);
 await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(results,null,1));
 console.log('PASS tauri-guitar-di-check',JSON.stringify(results),folder);
}finally{await app.close();}
