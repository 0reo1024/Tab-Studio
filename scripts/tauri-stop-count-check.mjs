// Tauri build, muted, native engine: Ctrl+Space goes back to where playback started and scrolls it
// into view however far the view moved; the next Space counts in again (it is not a resume). The
// count-in is a number of clicks, set in 練習設定 (4 → 4 clicks).
// Usage: TAURI_PROFILE=release node --import tsx scripts/tauri-stop-count-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';

const folder=path.resolve(`test-results/stop-count-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(30000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!document.querySelector('#play').disabled;},{},{timeout:60000});
const state=()=>page.evaluate(()=>window.tabStudio.getState());
async function menu(root,item){await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:new RegExp('^'+root+'$')})}).locator(':scope>button').click();await page.getByRole('menuitem',{name:item,exact:true}).click();}
/** Whether the beat cursor is inside the score view, and where. */
const cursorShown=()=>page.evaluate(()=>{const c=document.querySelector('.at-cursor-beat')?.getBoundingClientRect(),v=document.querySelector('#score-scroll').getBoundingClientRect();return {shown:!!c&&c.height>0&&c.top>=v.top&&c.bottom<=v.bottom,top:c&&Math.round(c.top-v.top),scroll:document.querySelector('#score-scroll').scrollTop};});
/** The count numbers shown while counting in (until playback really starts). */
async function countShown(){return page.evaluate(()=>new Promise(resolve=>{const seen=[];const t0=performance.now();const tick=()=>{const m=/カウント (\d+)/.exec(document.querySelector('#time').textContent??'');if(m&&seen.at(-1)!==m[1])seen.push(m[1]);if(performance.now()-t0>6000||seen.length&&!m&&window.tabStudio.getState().playing)return resolve(seen);requestAnimationFrame(tick);};tick();}));}
const bars=n=>Array.from({length:n},(_,i)=>`${i%12}.1 ${(i+2)%12}.2 ${(i+4)%12}.3 ${(i+5)%12}.4`).join(' | ');
try{
 await page.waitForFunction(()=>!!window.nativeAudio,{},{timeout:30000});
 await page.evaluate(()=>{localStorage.setItem('tabstudio-settings',JSON.stringify({nativeAudio:true,follow:true}));localStorage.setItem('tabstudio-practice',JSON.stringify({countBars:1}));});
 await page.reload();await page.waitForLoadState('domcontentloaded');
 await page.locator('#start-demo').click({timeout:30000});await ready();
 // 1. The setting: a saved "1 bar" reads as 4 clicks; the dialog takes a number of clicks.
 await menu('プレーヤー','練習設定…');assert.equal(await page.locator('#count-beats').inputValue(),'4','1 bar saved before reads as 4 clicks');assert.ok(await page.locator('#count-in').isChecked(),'and the count-in is on');
 await page.locator('#practice-settings').screenshot({path:path.join(folder,'practice-settings.png')});
 await page.locator('#count-beats').fill('99');await page.locator('#practice-settings [data-apply]').click();
 assert.match(await page.locator('#practice-settings .enhancement-error').textContent(),/1〜32/,'out of range is refused');
 await page.locator('#count-beats').fill('3');await page.locator('#practice-settings [data-apply]').click();
 assert.equal(JSON.parse(await page.evaluate(()=>localStorage.getItem('tabstudio-practice'))).countBeats,3);
 // Off: no count, the number is kept; then on again.
 await menu('プレーヤー','練習設定…');await page.locator('#count-in').uncheck();await page.locator('#practice-settings [data-apply]').click();
 assert.deepEqual((({countIn,countBeats})=>({countIn,countBeats}))(JSON.parse(await page.evaluate(()=>localStorage.getItem('tabstudio-practice')))),{countIn:false,countBeats:3});
 await menu('プレーヤー','練習設定…');assert.equal(await page.locator('#count-beats').inputValue(),'3');await page.locator('#count-in').check();await page.locator('#practice-settings [data-apply]').click();
 const score=at.importer.ScoreLoader.loadAlphaTex(`\\title "Stop" \\tempo 200 \\track "G" \\staff {score tabs} . :4 ${bars(60)}`,new at.Settings());
 const project=JSON.stringify({format:'TabStudio',version:1,sourceName:'Stop',warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
 await page.evaluate(p=>window.tabStudio.load('Stop.tabstudio',new TextEncoder().encode(p)),project);await ready();
 // 2. Play from bar 3: three clicks first.
 await page.evaluate(()=>window.tabStudio.select(2,2));await page.evaluate(()=>window.tabStudio.select(2,2));
 const a=await page.evaluate(()=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[2].voices[0].beats[0],bb=window.tabStudio.api.boundsLookup.findBeat(b),s=document.querySelector('#score').getBoundingClientRect();return {x:s.left+bb.onNotesX,y:s.top+bb.barBounds.visualBounds.y+bb.barBounds.visualBounds.h-8};});
 await page.mouse.click(a.x,a.y);await page.waitForTimeout(300);await page.keyboard.press('Escape');
 const startTick=(await state()).lastTick;console.log('start tick',startTick);
 await page.locator('#score-scroll').focus();
 const first=countShown();await page.keyboard.press('Space');const counted=await first;console.log('first play counts',counted);
 assert.deepEqual(counted,['3','2','1'],'three clicks before playing');
 await page.waitForFunction(()=>window.tabStudio.getState().playing);await page.waitForTimeout(3000);
 // 3. Scroll far away while it plays (the follower waits 3 s after a wheel), then Ctrl+Space.
 await page.evaluate(()=>{const v=document.querySelector('#score-scroll');v.dispatchEvent(new WheelEvent('wheel',{deltaY:6000}));v.scrollTop=v.scrollHeight;});await page.waitForTimeout(300);
 assert.ok(!(await cursorShown()).shown,'the cursor is off screen before stopping');
 await page.keyboard.press('Control+Space');
 await page.waitForFunction(()=>!window.tabStudio.getState().playing);await page.waitForTimeout(1500);
 const back=await state();assert.equal(back.lastTick,startTick,'back at the playback start');
 const shown=await cursorShown();console.log('after Ctrl+Space',JSON.stringify(shown));assert.ok(shown.shown,'the playback start is on screen');
 await page.screenshot({path:path.join(folder,'after-stop.png')});
 // 4. Space again: a fresh start, counted in (not a resume).
 const second=countShown();await page.keyboard.press('Space');const again=await second;console.log('after Ctrl+Space counts',again);
 assert.deepEqual(again,['3','2','1'],'counted in again after Ctrl+Space');
 await page.waitForFunction(()=>window.tabStudio.getState().playing);await page.waitForTimeout(800);
 // A plain pause and Space resumes without counting ("一時停止からの再開時もカウントする" is off).
 await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);
 const third=countShown();await page.keyboard.press('Space');const resumed=await third;console.log('resume counts',resumed);
 assert.deepEqual(resumed,[],'a resume after pausing is not counted');
 await page.keyboard.press('Control+Space');
 assert.deepEqual(app.errors,[]);console.log('PASS tauri-stop-count-check',folder);
}finally{await app.close();}
