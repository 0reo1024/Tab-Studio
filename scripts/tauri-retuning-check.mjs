// Actual Tauri settings, selection, undo/redo, persistence and playback; isolated and muted.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {launchTauri} from './tauri-app.mjs';

const folder=path.resolve(`test-results/retuning-${Date.now()}`),exports=path.join(folder,'exports');await fs.mkdir(exports,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:path.resolve('src-tauri/target/release/tab-studio.exe'),env:{TAB_STUDIO_TEST_MUTE:'1',TAB_STUDIO_TEST_SAVE_DIR:exports}});
const page=app.page;page.setDefaultTimeout(20000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;});
const state=()=>page.evaluate(()=>({tracks:window.tabStudio.getScore().tracks.map(t=>({tuning:[...t.staves[0].tuning],notes:t.staves.flatMap(st=>st.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(b=>b.notes.map(n=>({pitch:n.realValue,string:n.string,fret:n.fret}))))))})),selected:window.tabStudio.getState().selected}));
const pitches=s=>s.tracks.map(t=>t.notes.map(n=>n.pitch));
const open=()=>page.locator('#tracks .track-settings').first().click();
const close=()=>page.locator('#trackDialog [data-close]').click();
async function apply(){await page.locator('#track-apply').click();await ready();assert.equal(await page.locator('#track-error').textContent(),'適用しました');}
try{
  await page.locator('#start-demo').click();await ready();
  const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Retuning" \\tempo 120 \\track "Guitar" . :4 0.6 3.6 (0.1 0.2) r | :4 0.1{sl} 2.1 2.1{t} 4.1 \\track "Other" . :1 7.1 | 9.1',new at.Settings());
  const project=JSON.stringify({format:'TabStudio',version:1,sourceName:'Retuning',warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
  await page.evaluate(p=>window.tabStudio.load('Retuning.tabstudio',new TextEncoder().encode(p)),project);await ready();const before=await state();
  await page.evaluate(()=>window.tabStudio.selectNote(0,0));await open();await page.locator('#track-preset').selectOption('dropD');await apply();
  const drop=await state();assert.deepEqual(pitches(drop),pitches(before));assert.equal(drop.tracks[0].notes[0].fret,2);assert.equal(drop.tracks[0].tuning.at(-1),38);await close();
  await page.locator('#score-scroll').focus();await page.keyboard.press('Control+z');await ready();assert.deepEqual((await state()).tracks,before.tracks);
  await page.keyboard.press('Control+y');await ready();assert.deepEqual((await state()).tracks,drop.tracks);
  await open();await page.locator('#track-preset').selectOption('halfDown');await apply();const half=await state();assert.deepEqual(pitches(half),pitches(before));assert.equal(half.tracks[0].notes[0].fret,1);await close();
  await page.evaluate(()=>window.tabStudio.selectNote(0,2));await open();await page.locator('#track-tuning').fill('F4 B3 G3 D3 A2 E2');await apply();const moved=await state();
  assert.deepEqual(pitches(moved),pitches(before));assert.notEqual(moved.tracks[0].notes[2].string,before.tracks[0].notes[2].string);assert.equal(moved.selected.string,moved.tracks[0].notes[2].string);await close();
  await open();await page.locator('#track-preset').selectOption('guitar7');await apply();const seven=await state();assert.deepEqual(pitches(seven),pitches(before));assert.equal(seven.tracks[0].tuning.length,7);assert.equal(seven.selected.string,seven.tracks[0].notes[2].string);
  const serialized=await page.evaluate(()=>window.tabStudio.serialize());await page.locator('#track-tuning').fill('C8 B7 A7 G7 F7 E7 D7');await page.locator('#track-apply').click();
  const reasons=await page.locator('#track-error').textContent();assert.match(reasons,/音程を保ったまま/);
  assert.equal(reasons.split('\n').filter(line=>line.startsWith('・')).length,seven.tracks[0].notes.length,'every blocked note must appear in one report');assert.match(reasons,/第1小節/);assert.match(reasons,/第2小節/);
  assert.equal(await page.locator('#track-error').evaluate(e=>getComputedStyle(e).whiteSpace),'pre-wrap');await page.screenshot({path:path.join(folder,'all-reasons.png')});
  assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),serialized);await close();
  await page.locator('#score-scroll').focus();await page.keyboard.press('Control+s');await page.waitForFunction(()=>!window.tabStudio.getState().dirty);
  const saved=path.join(exports,'Retuning.tg'),copy=path.join(folder,'reopened.tg');await fs.copyFile(saved,copy);await page.locator('#fileInput').setInputFiles(copy);await ready();
  await page.waitForFunction(()=>window.tabStudio.getState().documents.find(d=>d.active)?.name==='reopened.tg');assert.deepEqual((await state()).tracks,seven.tracks);
  await page.locator('#home').click();await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);
  await page.waitForFunction(async()=>{const s=await window.__TAURI_INTERNALS__.invoke('audio_status');return Math.max(...s.peaks)>.001;});await page.locator('#stop').click();
  assert.deepEqual(app.errors,[]);await fs.writeFile(path.join(folder,'result.json'),JSON.stringify({passed:true,before,drop,half,moved,seven},null,2));console.log('RETUNING PASSED',folder);
}finally{await app.close();}
