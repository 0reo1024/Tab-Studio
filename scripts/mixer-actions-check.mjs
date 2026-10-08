import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {demoScore,project} from '../src/score.ts';
import {duplicateTrack} from '../src/score-operations.ts';
const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST:'1',TAB_STUDIO_TEST_DATA:path.resolve('test-results/mixer-actions-'+Date.now())}});
try{
 const page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());await page.bringToFront();await page.locator('#start-demo').click();await page.waitForFunction(()=>window.tabStudio?.getState().ready);
 const score=duplicateTrack(demoScore(),0);await page.evaluate(p=>window.tabStudio.load('Actions.tabstudio',new TextEncoder().encode(p)),project(score,'Actions',[]));await page.waitForFunction(()=>window.tabStudio.getState().ready&&!window.tabStudio.getState().rendering);
 const levels=await page.evaluate(async()=>{
  const score=window.tabStudio.getScore();
  async function render(n){const ctx=new OfflineAudioContext(2,44100,44100),engine=new window.tabStudio.mixerAudio.constructor();await engine.attach(ctx);const sourceScore=Object.create(score);sourceScore.tracks=score.tracks.slice(0,n);await engine.prepare(sourceScore);for(let i=0;i<n;i++){const wave=ctx.createOscillator(),amp=ctx.createGain();wave.frequency.value=220;amp.gain.value=.8;wave.connect(amp);amp.connect(engine.destination(i));wave.start();}const result=await ctx.startRendering();const pcm=result.getChannelData(0);let sum=0,peak=0;for(let i=22050;i<pcm.length;i++){sum+=pcm[i]*pcm[i];peak=Math.max(peak,Math.abs(pcm[i]));}return {rms:Math.sqrt(sum/(pcm.length-22050)),peak};}
  return {single:await render(1),double:await render(2)};
 });assert.ok(levels.double.rms/levels.single.rms<1.5,JSON.stringify(levels));assert.ok(levels.double.peak<1,JSON.stringify(levels));console.log('AUDIO HEADROOM',levels);
 await page.locator('#mixer-toggle').click();const click=page.getByRole('button',{name:'メトロノームのオン・オフ',exact:true});await page.locator('#click').uncheck();await click.click();assert.ok(await page.locator('#click').isChecked());assert.equal(await click.textContent(),'クリック · ON');await page.locator('#click').uncheck();assert.equal(await click.textContent(),'クリック · OFF');
 const pan=page.getByRole('slider',{name:'Guitarのパン',exact:true});assert.equal(await pan.getAttribute('aria-valuetext'),'中央');await pan.fill('12');await pan.dispatchEvent('input');assert.equal(await pan.getAttribute('aria-valuetext'),'R 50%');await pan.dblclick();assert.equal(await pan.inputValue(),'8');assert.equal(await pan.getAttribute('aria-valuetext'),'中央');
 await page.evaluate(()=>{const audio=window.tabStudio.mixerAudio;audio.prepare=async()=>{};audio.openEditor=async(index,id)=>{(window.openedFx??=[]).push({index,id});};});
 await page.locator('[data-track="0"] [data-fx]').click();await page.waitForFunction(()=>document.querySelector('#native-fx-list')?.options.length>0);const list=page.locator('#native-fx-list');await list.selectOption({index:0});await list.dispatchEvent('dblclick');await page.waitForFunction(()=>window.openedFx?.length===1);assert.equal(await page.locator('[data-track="0"] .mixer-fx-slot').count(),1);assert.ok(await page.locator('#mixer-dialog').evaluate(e=>!e.open));
 await page.locator('[data-track="0"] [data-fx]').click();await page.waitForFunction(()=>document.querySelector('#native-fx-list')?.options.length>0);await list.selectOption({index:1});await page.locator('#native-fx-add').click();await page.waitForFunction(()=>window.openedFx.length===2);assert.equal(await page.locator('[data-track="0"] .mixer-fx-slot').count(),2);
 const fxButton=page.locator('[data-track="0"] .mixer-fx-slot [data-fx-id]').first();
 assert.equal(await fxButton.getAttribute('aria-pressed'),'true');
 await fxButton.click();await page.waitForFunction(()=>document.querySelector('[data-track="0"] .mixer-fx-slot [data-fx-id]')?.getAttribute('aria-pressed')==='false');
 await page.locator('[data-track="0"] .mixer-fx-slot [data-fx-id]').first().dblclick();
 await page.waitForFunction(()=>window.openedFx.length===3);
 assert.equal(await page.locator('[data-track="0"] .mixer-fx-slot [data-fx-id]').first().getAttribute('aria-pressed'),'true');
 console.log('MIXER ACTIONS PASSED: audio headroom, click and pan, plugin add, single-click bypass and double-click editor');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
