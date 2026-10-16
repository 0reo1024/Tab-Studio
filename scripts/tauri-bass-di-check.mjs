// The Bass DIs in the Tauri release build, muted: a bass NAM track's sound dialog lists Fashion
// (the default), Standard (Standard Bass V2 finger) and Growly; each choice plays and is kept, and
// a change while playing keeps the bass sounding (the replaced instrument is freed off the engine
// lock and kept for reuse, so a change back is immediate).
// Usage: TAURI_PROFILE=release node --import tsx scripts/tauri-bass-di-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';
import {project} from '../src/score.ts';
import {trackAudio,applyNamPreset} from '../src/mixer-state.ts';

const folder=path.resolve(`test-results/bass-di-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(30000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading&&!document.querySelector('#play').disabled;},{},{timeout:60000});
const playing=on=>page.waitForFunction(on=>window.tabStudio.getState().playing===on,on,{timeout:30000});
/** Samples the engine every 50 ms: [song seconds, track 0 peak]. */
const sample=ms=>page.evaluate(async ms=>{const out=[];const t0=performance.now();while(performance.now()-t0<ms){const s=await window.__TAURI_INTERNALS__.invoke('audio_status');out.push([s.position,s.peaks[0]??0]);await new Promise(r=>setTimeout(r,50));}return out;},ms);
/** Plays from bar 1 with Space; returns the track's peak over two seconds and how long the start took. */
async function peak(){
 await page.evaluate(()=>window.tabStudio.select(0,0));await page.locator('#score-scroll').focus();
 const t0=Date.now();await page.keyboard.press('Space');await playing(true);const start=Date.now()-t0;
 const value=Math.max(...(await sample(2000)).filter(s=>s[0]>.1).map(s=>s[1]));
 await page.keyboard.press('Space');await playing(false);return {peak:value,start};
}
const choose=async label=>{
 await page.locator('#mixer [data-sound="0"]').click();await page.waitForFunction(()=>document.querySelectorAll('#mixer-sound option').length>=3);
 const options=await page.locator('#mixer-sound option').allInnerTexts();
 assert.deepEqual(options,['Bass DI (Fashion)','Bass DI (Standard)','Bass DI (Growly)']);assert.ok(!(await page.locator('#mixer-sound').isDisabled()));
 await page.locator('#mixer-sound').selectOption({label});
 await page.getByRole('button',{name:'閉じる',exact:true}).click();
};
try{
 await page.locator('#start-demo').click();await ready();
 // Eighth notes across the bass's range for 16 bars: it never rests.
 const bar=':8 0.4 3.4 5.4 7.4 0.3 2.3 5.3 7.3';
 const score=at.importer.ScoreLoader.loadAlphaTex(`\\title "Bass DI" \\tempo 120 \\track "Bass" \\staff {tabs} \\tuning G2 D2 A1 E1 \\instrument 33 . ${Array(16).fill(bar).join(' | ')}`,new at.Settings());
 applyNamPreset(trackAudio(score.tracks[0]).nam,'bass-darkglass-b7k');
 await page.evaluate(p=>window.tabStudio.load('Bass DI.tabstudio',new TextEncoder().encode(p)),project(score,'Bass DI',[]));await ready();
 const results={fashion:await peak()};assert.ok(results.fashion.peak>.01,'the default Fashion DI sounds');
 await page.locator('#mixer-toggle').click();
 for(const [key,label,file] of [['standard','Bass DI (Standard)','Bass DI Finger'],['growly','Bass DI (Growly)','Bass DI Growly'],['fashionAgain','Bass DI (Fashion)','Bass DI Fashion']]){
  await choose(label);await page.screenshot({path:path.join(folder,`sound-${key}.png`)});
  const sound=await page.evaluate(()=>JSON.parse(window.tabStudio.serialize()).score.tracks[0].studioaudio.sound);
  assert.ok(sound.path.includes(file),JSON.stringify(sound));
  results[key]=await peak();assert.ok(results[key].peak>.01,`${label} sounds`);
  assert.ok(results[key].start<3000,`${label} starts without a long wait (${results[key].start} ms)`);
 }
 // A change while playing: the bass keeps sounding (at most a short gap while the new DI loads).
 await page.evaluate(()=>window.tabStudio.select(0,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Space');await playing(true);
 await page.waitForTimeout(500);await choose('Bass DI (Growly)');
 const during=await sample(5000);
 await page.keyboard.press('Space');await playing(false);
 let gap=0,longest=0;for(let i=1;i<during.length;i++){gap=during[i][1]<.005?gap+(during[i][0]-during[i-1][0]):0;longest=Math.max(longest,gap);}
 results.whilePlaying={longestSilence:+longest.toFixed(2),moved:+(during.at(-1)[0]-during[0][0]).toFixed(2),last:+during.at(-1)[1].toFixed(3)};
 assert.ok(results.whilePlaying.moved>4,'playback kept going');assert.ok(longest<1,'the bass keeps sounding after a DI change while playing '+JSON.stringify(results.whilePlaying));
 const notice=await page.evaluate(()=>document.querySelector('#notice')?.textContent??'');assert.ok(!/エラー|できません|音声エンジン/.test(notice),notice);
 assert.deepEqual(app.errors,[]);
 await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(results,null,1));
 console.log('PASS tauri-bass-di-check',JSON.stringify(results),folder);
}finally{await app.close();}
