// When the score's size changes under the view (tracks hidden or shown, an edit), the playback
// position stays where it was on screen, in the Tauri release build.
// Usage: TAURI_PROFILE=release node --import tsx scripts/tauri-render-anchor-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';

const folder=path.resolve(`test-results/render-anchor-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(30000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;});
const settle=async()=>{await ready();await page.waitForTimeout(400);await ready();};
/** Screen y (from the score view's top) of the system holding the playback position, via track 2 (always shown). */
const cursorY=()=>page.evaluate(()=>{const t=window.tabStudio.getState().lastTick,beat=window.tabStudio.api.tickCache.findBeat(new Set([2]),t).beat,bb=window.tabStudio.api.boundsLookup.findBeat(beat),sheet=document.querySelector('#score').getBoundingClientRect(),view=document.querySelector('#score-scroll').getBoundingClientRect();return {y:sheet.top-view.top+bb.barBounds.masterBarBounds.visualBounds.y,bar:beat.voice.bar.index,scroll:document.querySelector('#score-scroll').scrollTop};});
const bars=n=>Array.from({length:n},(_,i)=>`${i%12}.1 ${(i+2)%12}.2 ${(i+4)%12}.3 ${(i+5)%12}.4`).join(' | ');
try{
 await page.locator('#start-demo').click();await ready();
 const score=at.importer.ScoreLoader.loadAlphaTex(`\\title "Anchor" \\tempo 120 \\track "A" \\staff {score tabs} . :4 ${bars(48)} \\track "B" \\staff {score tabs} . :4 ${bars(48)} \\track "C" \\staff {tabs} . :4 ${bars(48)}`,new at.Settings());
 const project=JSON.stringify({format:'TabStudio',version:1,sourceName:score.title,warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
 await page.evaluate(p=>window.tabStudio.load('Anchor.tabstudio',new TextEncoder().encode(p)),project);await settle();
 // Show all three tracks, then put bar 30 of track C in the middle of the view and click it.
 const boxes=page.locator('#tracks .track-top input[type=checkbox]');
 for(let i=0;i<3;i++)if(!(await boxes.nth(i).isChecked())){await boxes.nth(i).check();await settle();}
 await page.evaluate(()=>{const b=window.tabStudio.getScore().tracks[2].staves[0].bars[29].voices[0].beats[0],bb=window.tabStudio.api.boundsLookup.findBeat(b),scroll=document.querySelector('#score-scroll');scroll.scrollTop+=bb.barBounds.visualBounds.y-scroll.clientHeight/2;});await page.waitForTimeout(300);
 const at30=await page.evaluate(()=>{const b=window.tabStudio.getScore().tracks[2].staves[0].bars[29].voices[0].beats[0],bb=window.tabStudio.api.boundsLookup.findBeat(b),sheet=document.querySelector('#score').getBoundingClientRect();return {x:sheet.left+bb.onNotesX,y:sheet.top+bb.barBounds.visualBounds.y+bb.barBounds.visualBounds.h*.5};});
 await page.mouse.click(at30.x,at30.y);await settle();
 const start=await cursorY();assert.equal(start.bar,29,'the playback position is on bar 30: '+JSON.stringify(start));
 await page.screenshot({path:path.join(folder,'start.png')});
 const same=async label=>{const now=await cursorY();console.log(label,JSON.stringify(now));assert.equal(now.bar,29,label+': still bar 30');assert.ok(Math.abs(now.y-start.y)<2,`${label}: the playback position stays at y ${start.y.toFixed(1)} (now ${now.y.toFixed(1)}, scroll ${start.scroll}→${now.scroll})`);await page.screenshot({path:path.join(folder,label.replace(/\W+/g,'-')+'.png')});};
 await boxes.nth(0).uncheck();await settle();await same('hide track A');
 await boxes.nth(1).uncheck();await settle();await same('hide track B');
 await boxes.nth(0).check();await settle();await same('show track A again');
 // An edit at the playback position: a fret typed on the selected beat.
 await page.locator('#score-scroll').focus();await page.keyboard.press('7');await page.keyboard.press('Enter');await settle();await same('edit');
 assert.deepEqual(app.errors,[]);console.log('PASS tauri-render-anchor-check',folder);
}finally{await app.close();}
