// Verify range selection and looping in the actual release app with muted output.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {launchTauri} from './tauri-app.mjs';

const folder=path.resolve(`test-results/selection-loop-${Date.now()}`);
await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:path.resolve('src-tauri/target/release/tab-studio.exe'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const page=app.page;page.setDefaultTimeout(20000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;});
async function menu(root,item){await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:new RegExp('^'+root+'$')})}).locator(':scope>button').click();await page.getByRole('menuitem',{name:item,exact:true}).click();}
async function start(expected,fromMenu=false){
  if(fromMenu)await menu('プレーヤー','ループ範囲を再生');else await page.locator('#loop-play').click();
  await page.waitForFunction(()=>window.tabStudio.getState().playing);
  assert.deepEqual(await page.evaluate(()=>{const r=window.tabStudio.api.playbackRange;return {startTick:r.startTick,endTick:r.endTick};}),expected);
  const samples=await page.evaluate(async()=>{const samples=[];for(let i=0;i<100;i++){samples.push(await window.__TAURI_INTERNALS__.invoke('audio_status'));await new Promise(r=>setTimeout(r,40));}return samples;});
  const start=expected.startTick/1920,end=expected.endTick/1920;
  await fs.writeFile(path.join(folder,`samples-${expected.startTick}.json`),JSON.stringify(samples,null,2));
  assert.ok(samples.some((s,i)=>i&&s.position<samples[i-1].position-.1),'native playback must wrap');
  assert.ok(samples.every(s=>s.position>=start-.08&&s.position<=end+.08),`native playback stays inside the selected range: ${JSON.stringify(samples.filter(s=>s.position<start-.08||s.position>end+.08).map(s=>({position:s.position,playing:s.playing,wraps:s.wraps})))}`);
  assert.ok(samples.some(s=>Math.max(...s.peaks)>.001),'selected notes must sound');
  await page.locator('#loop-play').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing);
  console.log('LOOP OK',JSON.stringify(expected));
}
try{
  await page.locator('#start-demo').click();await ready();
  const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Selection loop" \\tempo 120 . :4 1.1 2.1 3.1 4.1 | 5.1 6.1 7.1 8.1 | 9.1 10.1 11.1 12.1',new at.Settings());
  const project=JSON.stringify({format:'TabStudio',version:1,sourceName:score.title,warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
  await page.evaluate(p=>window.tabStudio.load('Selection loop.tabstudio',new TextEncoder().encode(p)),project);await ready();
  await menu('編集','小節の範囲選択…');
  await page.locator('#range-start').fill('2');await page.locator('#range-end').fill('2');await page.locator('#range-apply').click();
  await start({startTick:3840,endTick:7680},true);
  assert.equal(await page.locator('#loop-from').inputValue(),'2');assert.equal(await page.locator('#loop-to').inputValue(),'2');
  await page.evaluate(()=>window.tabStudio.select(1,2));await page.locator('#score-scroll').focus();await page.keyboard.press('Shift+ArrowLeft');
  assert.ok(await page.evaluate(()=>window.tabStudio.getState().fragmentRange));
  await start({startTick:4800,endTick:6720});
  // Editing a note forces MIDI regeneration; the selected beat range must survive it.
  await page.evaluate(()=>window.tabStudio.selectNote(0,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('10');await page.keyboard.press('Enter');await ready();
  await page.evaluate(()=>window.tabStudio.select(0,3));await page.locator('#score-scroll').focus();await page.keyboard.press('Shift+ArrowRight');
  await start({startTick:2880,endTick:4800});
  // Explicit dialog settings override a selection, and normal playback leaves loop mode.
  await menu('プレーヤー','ループ範囲…');await page.locator('#loopStart').fill('3');await page.locator('#loopEnd').fill('3');await page.locator('#loop').check();await page.locator('#loop-apply').click();
  await page.waitForFunction(()=>window.tabStudio.getState().playing);assert.equal(await page.evaluate(()=>window.tabStudio.api.playbackRange.startTick),7680);
  await page.locator('#play').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing);assert.equal(await page.evaluate(()=>window.tabStudio.api.isLooping),false);
  await page.evaluate(()=>window.tabStudio.select(0,0));await page.locator('#loop-from').fill('1');await page.locator('#loop-to').fill('1');await page.locator('#loop-to').press('Enter');
  await start({startTick:0,endTick:3840});
  await page.locator('#home').click();await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);
  await page.waitForFunction(async()=>{const s=await window.__TAURI_INTERNALS__.invoke('audio_status');return s.position<.45&&Math.max(...s.peaks)>.001;});await page.locator('#stop').click();
  assert.deepEqual(app.errors,[]);await fs.writeFile(path.join(folder,'result.json'),JSON.stringify({passed:true},null,2));console.log('PASSED',folder);
}finally{await app.close();}
