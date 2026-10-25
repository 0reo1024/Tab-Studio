// A duration chosen with a range selected applies to every beat of it, in the Tauri release build:
// a dragged beat range and bars from the range dialog; Ctrl+Z restores; too long is refused.
// Usage: TAURI_PROFILE=release node --import tsx scripts/tauri-range-duration-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';

const folder=path.resolve(`test-results/range-duration-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(20000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;});
/** Per bar of track 0: duration:fret (r for a rest). */
const bars=()=>page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars.map(b=>b.voices[0].beats.map(x=>`${x.duration}:${x.notes.length?x.notes.map(n=>n.fret).join('+'):'r'}`).join(' ')));
const point=(bar,beat)=>page.evaluate(([bar,beat])=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[bar].voices[0].beats[beat],bb=window.tabStudio.api.boundsLookup.findBeat(b),r=bb.barBounds.visualBounds,score=document.querySelector('#score').getBoundingClientRect();return {x:score.left+bb.onNotesX,y:score.top+r.y+4};},[bar,beat]);
async function drag(a,b){const p=await point(...a),q=await point(...b);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move((p.x+q.x)/2,p.y,{steps:5});await page.mouse.move(q.x,q.y,{steps:5});await page.mouse.up();assert.ok((await page.evaluate(()=>window.tabStudio.getState())).fragmentRange,'a beat range');}
async function menu(root,item){await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:new RegExp('^'+root+'$')})}).locator(':scope>button').click();await page.getByRole('menuitem',{name:item,exact:true}).click();}
try{
 await page.locator('#start-demo').click();await ready();
 const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Durations" \\tempo 120 \\track "Guitar" \\staff {tabs} . :4 1.1 2.1 3.1 4.1 | 5.1 6.1 7.1 8.1 | :8 1.1 2.1 :4 r :2 r | :1 r',new at.Settings());
 const project=JSON.stringify({format:'TabStudio',version:1,sourceName:score.title,warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
 await page.evaluate(p=>window.tabStudio.load('Durations.tabstudio',new TextEncoder().encode(p)),project);await ready();
 const original=await bars();console.log('original',JSON.stringify(original));
 // 1. Drag over bar 1 and choose an 8th (Ctrl+5): four 8ths, then a half rest; bar 2 untouched.
 await drag([0,0],[0,3]);await page.keyboard.press('Control+5');await ready();
 let now=await bars();console.log('8ths',JSON.stringify(now));
 assert.equal(now[0],'8:1 8:2 8:3 8:4 2:r');assert.equal(now[1],original[1]);
 const s=await page.evaluate(()=>window.tabStudio.getState());assert.deepEqual([s.fragmentRange.anchor.beat,s.fragmentRange.focus.beat],[0,3],'the range stays on the changed beats');
 await page.screenshot({path:path.join(folder,'eighths.png')});
 await page.keyboard.press('Control+z');await ready();assert.deepEqual(await bars(),original,'Ctrl+Z restores');
 // 1b. The same with the edit palette's 8th button (a click must not drop the range).
 await drag([0,0],[0,3]);await page.locator('[data-action="duration8"]:visible').first().click();await ready();
 assert.equal((await bars())[0],'8:1 8:2 8:3 8:4 2:r','the palette button changes the whole range');
 await page.keyboard.press('Control+z');await ready();assert.deepEqual(await bars(),original);
 // 2. Bar 3's two 8ths as quarters: they take the rests after them.
 await drag([2,0],[2,1]);await page.keyboard.press('Control+4');await ready();
 now=await bars();console.log('quarters',JSON.stringify(now));assert.ok(now[2].startsWith('4:1 4:2 '),now[2]);assert.equal(now[1],original[1]);
 await page.keyboard.press('Control+z');await ready();
 // 3. Bar 2's first two quarters as halves: notes follow, so it is refused and nothing changes.
 await drag([1,0],[1,1]);await page.keyboard.press('Control+2');await ready();
 assert.deepEqual(await bars(),original,'refused');assert.match(await page.locator('#notice').textContent(),/休符が足りません/);
 // 4. Bars from the range dialog: bar 2 as 8ths.
 await menu('編集','小節の範囲選択…');await page.locator('#range-start').fill('2');await page.locator('#range-end').fill('2');await page.locator('#range-apply').click();
 await page.keyboard.press('Control+5');await ready();now=await bars();console.log('bar range',JSON.stringify(now));assert.equal(now[1],'8:5 8:6 8:7 8:8 2:r');assert.equal(now[0],original[0]);
 assert.deepEqual(app.errors,[]);console.log('PASS tauri-range-duration-check',folder);
}finally{await app.close();}
