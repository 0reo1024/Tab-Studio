// Slap and pop on the Bass DI (Fashionbass) in the Tauri release build, muted: a bass NAM song
// without slaps plays; slap/pop added to a bar make the engine add the Bass DI's articulation
// lane (about a second more to prepare than an ordinary edit), and the slapped bar sounds.
// The routing itself (which lane plays each articulation, and its level) is checked offline
// by `cargo test bass_di` and `cargo run --release --example bass_levels -- fashion`.
// Usage: TAURI_PROFILE=release node --import tsx scripts/tauri-bass-slap-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';
import {project} from '../src/score.ts';
import {trackAudio} from '../src/mixer-state.ts';

const folder=path.resolve(`test-results/bass-slap-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(30000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading&&!document.querySelector('#play').disabled;},{},{timeout:60000});
async function menu(root,item){for(let attempt=0;;attempt++){await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:new RegExp('^'+root+'$')})}).locator(':scope>button').click();try{await page.getByRole('menuitem',{name:item,exact:true}).click({timeout:3000});return;}catch(e){if(attempt>=3)throw e;await page.keyboard.press('Escape');}}}
/** Plays a bar; returns its track peak and how long play took to start (the app waits for the engine's instruments). */
async function peakOfBar(bar){
 await page.evaluate(bar=>window.tabStudio.select(bar,0),bar);const t0=Date.now();await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing,{},{timeout:20000}).catch(async e=>{throw new Error('play did not start: '+JSON.stringify(await page.evaluate(()=>{const s=window.tabStudio.getState();return {ready:s.ready,rendering:s.rendering,loading:s.loading,play:document.querySelector('#play').textContent,disabled:document.querySelector('#play').disabled,notice:document.querySelector('#notice')?.textContent,status:document.querySelector('#status')?.textContent,range:s.selectedRange,fragment:s.fragmentRange};})));});const wait=Date.now()-t0;
 const peak=await page.evaluate(async bar=>{let peak=0;const t0=performance.now();while(performance.now()-t0<3000){const s=await window.__TAURI_INTERNALS__.invoke('audio_status');if(s.position>=bar*2+.1&&s.position<bar*2+1.9)peak=Math.max(peak,s.peaks[0]??0);if(s.position>=bar*2+1.9)break;await new Promise(r=>setTimeout(r,30));}return peak;},bar);
 await page.locator('#play').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing);return {peak,wait};
}
/** Selects bar `bar` (1-based) with the range dialog and applies a palette action to it. */
async function applyToBar(bar,action){
 await menu('編集','小節の範囲選択…');await page.locator('#range-start').fill(String(bar));await page.locator('#range-end').fill(String(bar));await page.locator('#range-apply').click();
 await page.locator(`#edit-palette button[data-action="${action}"]`).click();
}
try{
 await page.locator('#start-demo').click();await ready();
 const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Slap" \\tempo 120 \\track "Bass" \\staff {tabs} \\tuning G2 D2 A1 E1 \\instrument 33 . :4 0.4 3.4 5.4 3.4 | 0.4 0.4 5.3 7.3 | 0.4 3.4 5.4 3.4 | 0.4 0.4 5.3 7.3',new at.Settings());
 Object.assign(trackAudio(score.tracks[0]).nam,{enabled:true,preset:'bass-ampeg-svt',model:'bass-ampeg-svt',modelName:'SVT',kind:'bass'});
 await page.evaluate(p=>window.tabStudio.load('Slap.tabstudio',new TextEncoder().encode(p)),project(score,'Slap',[]));await ready();
 const finger=await peakOfBar(0);console.log('finger bar',JSON.stringify(finger));assert.ok(finger.peak>.01,'the Bass DI sounds');
 // Edit -> play at once: play waits for the engine to have the edited song's instruments.
 await applyToBar(3,'accent');const plain=await peakOfBar(2);console.log('ordinary edit (accent) -> play',JSON.stringify(plain));
 await applyToBar(2,'slap');const slap=await peakOfBar(1);console.log('slap added -> play',JSON.stringify(slap));
 assert.ok((await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[1].voices[0].beats.every(b=>b.slap))),'bar 2 slapped');
 assert.ok(slap.peak>.01,'the slapped bar sounds');
 assert.ok(slap.wait-plain.wait>300,`play waited for the Slap program to load (${slap.wait} ms vs ${plain.wait} ms)`);
 await applyToBar(4,'pop');const pop=await peakOfBar(3);console.log('pop added (Slap program already loaded) -> play',JSON.stringify(pop));assert.ok(pop.peak>.01,'the popped bar sounds');
 const notice=await page.evaluate(()=>document.querySelector('#notice')?.textContent??'');assert.ok(!/エラー|できません|音声エンジン/.test(notice),notice);
 assert.deepEqual(app.errors,[]);
 await fs.writeFile(path.join(folder,'result.json'),JSON.stringify({finger,plain,slap,pop},null,1));
 console.log(`PASS tauri-bass-slap-check: play after adding slaps waited ${slap.wait-plain.wait} ms longer than after an ordinary edit (the Slap program loading)`,folder);
}finally{await app.close();}
