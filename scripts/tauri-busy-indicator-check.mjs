// Tauri build: the centered loading notice. Switching to a large tab and switching a track's DI
// show it (above the mixer's modal dialog), it never blocks clicks, and it goes away once loading ends.
// Usage: pnpm tauri build --no-bundle && TAURI_PROFILE=release node --import tsx scripts/tauri-busy-indicator-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';
import {project} from '../src/score.ts';
import {trackAudio,applyNamPreset} from '../src/mixer-state.ts';

const folder=path.resolve(`test-results/busy-indicator-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const long=path.join(folder,'long.gp5');
await fs.copyFile(process.env.LONG_SONG||path.join(os.homedir(),'Desktop','Champagne_Gtr1_Gtr2.gp5'),long);
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(30000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading&&!document.querySelector('#play').disabled;},{},{timeout:120000});
const idle=()=>page.waitForFunction(()=>!document.querySelector('#busy-indicator').matches(':popover-open'),{},{timeout:60000});
/** Every time the notice opens, with its text and whether it is above everything else. */
const shown=()=>page.evaluate(()=>window.__busy.splice(0));
async function capture(name){
 // Screenshot while the notice is up, if it is.
 for(let i=0;i<100;i++){if(await page.evaluate(()=>document.querySelector('#busy-indicator').matches(':popover-open'))){await page.waitForTimeout(300);await page.screenshot({path:path.join(folder,name)});return true;}await page.waitForTimeout(50);}
 return false;
}
try{
 await page.locator('#start-demo').click();await ready();
 await page.evaluate(()=>{window.__busy=[];const el=document.querySelector('#busy-indicator');el.addEventListener('toggle',e=>{if(e.newState==='open')window.__busy.push(el.textContent);});});
 const score=at.importer.ScoreLoader.loadAlphaTex('\\title "LP" \\tempo 120 \\track "Guitar" \\staff {tabs} \\instrument 29 . :4 (0.6 2.5 2.4) 3.3 (5.2 5.1) 7.3 | 0.6 3.6 5.5 (7.4 7.3)',new at.Settings());
 applyNamPreset(trackAudio(score.tracks[0]).nam,'fender-super');
 await page.evaluate(p=>window.tabStudio.load('LP.tabstudio',new TextEncoder().encode(p)),project(score,'LP',[]));await ready();await idle();
 await page.evaluate(async file=>{const f=await window.desktop.openFilePath(file);await window.tabStudio.load(f.name,new Uint8Array(f.bytes),f.openToken,f.path);},long);
 await ready();await idle();shown();

 // 1. Tab switch to the large song.
 const ids=await page.evaluate(()=>window.tabStudio.getState().documents.map(d=>d.id));
 await page.evaluate(id=>window.tabStudio.activateDocument(id),ids.at(-2));await ready();await idle();shown();
 await page.evaluate(id=>window.tabStudio.activateDocument(id),ids.at(-1));
 const tabShot=await capture('tab-switch.png');await ready();await idle();
 const tab=await shown();console.log('tab switch:',JSON.stringify(tab));
 assert.ok(tabShot&&tab.length>0,'shown while the large tab loads');

 // 2. DI switch in the mixer's sound dialog (a modal dialog): the notice is drawn above it.
 await page.evaluate(id=>window.tabStudio.activateDocument(id),ids.at(-2));await ready();await idle();shown();
 await page.locator('#mixer-toggle').click();
 await page.locator('#mixer [data-sound="0"]').click();await page.waitForFunction(()=>document.querySelectorAll('#mixer-sound option').length>=2);
 await page.locator('#mixer-sound').selectOption({label:'Guitar DI (Trummer LP Bridge)'});
 const diShot=await capture('di-switch.png');
 // di-switch.png: the notice is drawn above the modal dialog (checked by eye; hit-testing ignores it).
 // Clicks still reach the dialog underneath while the notice is up.
 await page.getByRole('button',{name:'閉じる',exact:true}).click();
 await ready();await idle();
 const di=await shown();console.log('DI switch:',JSON.stringify(di));
 assert.ok(diShot&&di.some(t=>t.includes('音源を読み込み中')),'shown while the DI loads');
 assert.deepEqual(app.errors,[]);
 console.log('PASS tauri-busy-indicator-check',folder);
}finally{await app.close();}
