import {_electron as electron} from '@playwright/test';
import * as at from '@coderline/alphatab';
import assert from 'node:assert/strict';
import path from 'node:path';
const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Whole clicks" \\tempo 90 . :1 3.1 | r | 5.1 | r',new at.Settings());
const project=JSON.stringify({format:'TabStudio',version:1,sourceName:score.title,warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.resolve('test-results/menu-settings-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>{errors.push(e.message);console.log(e.stack);});
 await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 await page.evaluate(p=>window.tabStudio.load('whole.tabstudio',new TextEncoder().encode(p)),project);await page.waitForFunction(()=>window.tabStudio.getScore().title==='Whole clicks'&&!window.tabStudio.getState().rendering);
 assert.equal(await page.locator('.edit-details,.sidebar-bottom').count(),0);
 const before=await page.evaluate(()=>window.tabStudio.serialize());
 for(const bar of [2,1,0,3]){
  const p=await page.evaluate(i=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[i].voices[0].beats[0],bb=window.tabStudio.api.boundsLookup.findBeats(b).at(-1),r=document.querySelector('#score').getBoundingClientRect();return{x:r.x+bb.onNotesX,y:r.y+bb.barBounds.visualBounds.y,tick:b.voice.bar.masterBar.start+b.playbackStart};},bar);
  await page.mouse.click(p.x,p.y);await page.waitForFunction(t=>Math.abs(window.tabStudio.api.tickPosition-t)<2,p.tick);
  assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.bar),bar);assert.equal(await page.evaluate(()=>window.tabStudio.getState().dirty),false);
  assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),before);assert.ok(!await page.locator('#inline-fret').isVisible());
  const cursor=await page.locator('.at-cursor-beat').boundingBox();assert.ok(Math.abs(cursor.x+cursor.width/2-p.x)<2);
 }
 assert.ok(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[1].voices[0].beats[0].isFullBarRest));
 async function menu(name,item){const root=page.locator('.menu-root').filter({has:page.locator(':scope > button',{hasText:new RegExp('^'+name+'$')})});await root.locator(':scope > button').click();if(item)await root.getByRole('menuitem',{name:item}).click();return root;}
 await page.evaluate(()=>window.tabStudio.select(1,0));await menu('拍子・小節',/^選択小節のテンポ/);assert.equal(await page.locator('#tempo-title').textContent(),'2小節のテンポ');assert.equal(await page.locator('#tempo').inputValue(),'90');
 await page.locator('#tempo').fill('19');await page.locator('#applyTempo').click();assert.ok(await page.locator('#tempoDialog').isVisible());assert.ok((await page.locator('#tempo-error').textContent()).includes('20〜400'));
 await page.locator('#tempo').fill('220');await page.screenshot({path:path.resolve('test-results/menu-tempo.png')});await page.locator('#applyTempo').click();await page.waitForFunction(()=>!window.tabStudio.getState().rendering);
 assert.equal(await page.evaluate(()=>window.tabStudio.getScore().masterBars[1].tempoAutomations[0].value),220);assert.equal(await page.evaluate(()=>window.tabStudio.getScore().masterBars[0].tempoAutomations[0].value),90);
 await menu('拍子・小節',/^選択小節のテンポ/);await page.locator('#tempo').fill('180');await page.locator('[data-close=tempoDialog]').click();assert.equal(await page.evaluate(()=>window.tabStudio.getScore().masterBars[1].tempoAutomations[0].value),220);
 // The palette opens the same tempo editor.
 await page.locator('[data-action=tempo]').click();assert.ok(await page.locator('#tempoDialog').isVisible());assert.equal(await page.locator('#tempo').inputValue(),'220');await page.locator('[data-close=tempoDialog]').click();
 await menu('プレーヤー',/^練習ループ/);await page.locator('#loopStart').fill('3');await page.locator('#loopEnd').fill('2');await page.locator('#loop').check();await page.locator('#loop-apply').click();assert.ok(await page.locator('#loopDialog').isVisible());assert.ok((await page.locator('#loop-error').textContent()).length>0);
 await page.locator('#loopStart').fill('2');await page.locator('#loopEnd').fill('3');await page.screenshot({path:path.resolve('test-results/menu-loop.png')});await page.locator('#loop-apply').click();
 const range=await page.evaluate(()=>window.tabStudio.api.playbackRange);assert.ok(range.startTick>0&&range.endTick>range.startTick);assert.ok(await page.evaluate(()=>window.tabStudio.api.isLooping));
 await menu('プレーヤー');assert.ok(await page.getByRole('menuitem',{name:/範囲を繰り返す$/}).evaluate(e=>e.classList.contains('checked')));await page.getByRole('menuitem',{name:/練習ループ/}).click();await page.locator('#loopStart').fill('1');await page.locator('#loop').uncheck();await page.locator('[data-close=loopDialog]').click();assert.deepEqual(await page.evaluate(()=>window.tabStudio.api.playbackRange),range);assert.ok(await page.evaluate(()=>window.tabStudio.api.isLooping));
 await menu('プレーヤー',/^練習ループ/);assert.equal(await page.locator('#loopStart').inputValue(),'2');assert.equal(await page.locator('#loopEnd').inputValue(),'3');assert.ok(await page.locator('#loop').isChecked());await page.locator('[data-close=loopDialog]').click();
 await menu('プレーヤー',/範囲を繰り返す$/);assert.ok(!await page.evaluate(()=>window.tabStudio.api.isLooping));
 await menu('プレーヤー',/範囲を繰り返す$/);assert.deepEqual(await page.evaluate(()=>window.tabStudio.api.playbackRange),range);
 await page.keyboard.press('Escape');const start=await page.evaluate(()=>window.tabStudio.api.tickPosition);await page.keyboard.press('Space');await page.waitForFunction(t=>window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition>t+150,start);await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);
 await menu('ツール');assert.ok(await page.getByRole('menuitem',{name:'音源の準備ができました'}).isDisabled());await page.screenshot({path:path.resolve('test-results/menu-audio.png')});const chooser=page.waitForEvent('filechooser');await page.getByRole('menuitem',{name:/SoundFontを交換/}).click();assert.equal(await (await chooser).element().getAttribute('id'),'sfInput');
 await menu('ファイル',/^読み込み情報/);assert.ok(await page.locator('#reportDialog').isVisible());assert.equal(await page.locator('#reportSource').textContent(),'whole.tabstudio');await page.locator('#closeReport').click();
 assert.deepEqual(errors,[]);console.log('MENU SETTINGS PASSED: removed sidebar blocks / whole notes and rests unchanged / cursor seeks / tempo apply and cancel / palette / loop validation, apply, cancel and toggle / audio status and chooser / import report');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
