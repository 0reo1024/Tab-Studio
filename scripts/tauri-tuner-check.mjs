// The instrument input panel on the release Tauri build (real device): the tuner opened from the
// Rewind section reads the latest input, and closing the panel (× or a click outside) stops
// listening back. Pitch detection itself: tests/tuner.test.ts.
// Usage: node scripts/tauri-tuner-check.mjs
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {launchTauri} from './tauri-app.mjs';

const folder=path.resolve(`test-results/tauri-tuner-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:path.resolve('src-tauri/target/release/tab-studio.exe'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const page=app.page;page.setDefaultTimeout(30000);
const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('live_status'));
async function menu(root,item){await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:new RegExp('^'+root+'$')})}).locator(':scope>button').click();await page.getByRole('menuitem',{name:item,exact:true}).click();}
const openPanel=async()=>{await menu('ツール','楽器入力（録音・練習）…');await page.locator('#live-input[open]').waitFor();};
try{
 await page.locator('#start-demo').click();await page.waitForFunction(()=>window.tabStudio?.getState()?.ready);
 await menu('ツール','設定…');await page.locator('#settings-live-recording').check();await page.locator('#settings-apply').click();
 await openPanel();await page.waitForFunction(()=>document.querySelectorAll('#live-output option').length>1);
 // 1. Tuner before the input is on: it says how to use it.
 await page.locator('#live-tuner-open').click();await page.locator('#live-tuner').waitFor();
 await page.waitForFunction(()=>document.querySelector('#tuner-cents')?.textContent.includes('入力をオン'));
 await page.locator('#live-toggle').click();
 await page.waitForFunction(()=>document.querySelector('#live-rec')?.textContent.includes('Rewind（直近5分）'),null,{timeout:30000});
 const s=await status();console.log('device',s.backend,s.output,s.input,'rate',s.sampleRate);
 await page.waitForTimeout(1500);
 const recent=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('live_recent',{frames:4096}));
 assert.equal(recent.samples.length,4096,'the latest 4096 input samples');assert.equal(recent.rate,s.sampleRate);
 // The tuner shows a note or waits (dimmed) for one; either way it no longer asks to turn the input on.
 await page.waitForFunction(()=>!document.querySelector('#tuner-cents')?.textContent.includes('入力をオン'));
 const shown=await page.evaluate(()=>({note:document.querySelector('#tuner-note').textContent,cents:document.querySelector('#tuner-cents').textContent,idle:document.querySelector('#live-tuner').classList.contains('idle')}));console.log('tuner',JSON.stringify(shown));
 await page.locator('#live-input').screenshot({path:path.join(folder,'tuner.png')});
 // The A4 choice is kept.
 await page.locator('#tuner-a4').selectOption('442');assert.equal(await page.evaluate(()=>localStorage.getItem('tabstudio-tuner-a4')),'442');
 // 2. Listening back stops when the panel closes (×), and again with a click outside it.
 await page.waitForTimeout(2500);
 for(const how of ['close button','click outside']){
  if(!(await page.locator('#live-input[open]').count()))await openPanel();
  await page.locator('#live-play').click();await page.waitForFunction(()=>window.__TAURI_INTERNALS__.invoke('live_status').then(s=>s.replay!==null),null,{timeout:10000,polling:100});
  if(how==='close button')await page.locator('#live-close').click();else await page.mouse.click(30,200);
  await page.waitForFunction(()=>!document.querySelector('#live-input[open]'));
  await page.waitForFunction(()=>window.__TAURI_INTERNALS__.invoke('live_status').then(s=>s.replay===null),null,{timeout:3000,polling:100});
  console.log('OK replay stops on',how);
 }
 // Reopening keeps the tuner shown and running.
 await openPanel();assert.ok(await page.locator('#live-tuner').isVisible(),'the tuner stays open');
 await page.locator('#live-toggle').click();await page.waitForFunction(()=>document.querySelector('#live-toggle')?.textContent==='入力をオン');
 assert.deepEqual(app.errors,[]);console.log('PASS tauri-tuner-check',folder);
}finally{await app.close();}
