// Delete on a light-blue range (a mouse drag, Shift+arrows, or bars from the range dialog)
// clears what it covers, in the Tauri release build; Ctrl+Z restores it and Ctrl+Y clears it
// again. The first Delete keeps the rhythm; a second Delete on the rests makes them the
// simplest rests. A single click on a note and Delete still removes just that note.
// Usage: TAURI_PROFILE=release node --import tsx scripts/tauri-delete-range-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';

const folder=path.resolve(`test-results/delete-range-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(20000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;});
/** The notes left per bar of track 0 ('-' for a bar of rests; cleared beats merge into rests). */
const frets=()=>page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars.map(b=>b.voices[0].beats.filter(x=>x.notes.length).map(x=>x.notes.map(n=>n.fret).join('+')).join(' ')||'-'));
/** Screen point of a beat on a string (1 = top line) of the tab staff. */
const point=(bar,beat,string=1)=>page.evaluate(([bar,beat,string])=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[bar].voices[0].beats[beat],bb=window.tabStudio.api.boundsLookup.findBeat(b),r=bb.barBounds.visualBounds,score=document.querySelector('#score').getBoundingClientRect();return {x:score.left+bb.onNotesX,y:score.top+r.y+(string-1)*r.h/5};},[bar,beat,string]);
async function load(){
 const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Delete range" \\tempo 120 \\track "Guitar" \\staff {tabs} . :4 1.1 2.1 3.1 4.1 | 5.1 6.1 7.1 8.1 | 9.1 (10.1 12.3) 11.1 12.1',new at.Settings());
 const project=JSON.stringify({format:'TabStudio',version:1,sourceName:score.title,warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
 await page.evaluate(p=>window.tabStudio.load('Delete range.tabstudio',new TextEncoder().encode(p)),project);await ready();
}
const original=['1 2 3 4','5 6 7 8','9 10+12 11 12'];
async function undoRedo(cleared,label){
 assert.deepEqual(await frets(),cleared,label+': Delete clears the range');
 await page.keyboard.press('Control+z');await ready();assert.deepEqual(await frets(),original,label+': Ctrl+Z restores it');
 await page.keyboard.press('Control+y');await ready();assert.deepEqual(await frets(),cleared,label+': Ctrl+Y clears it again');
 await page.keyboard.press('Control+z');await ready();
 console.log('OK',label);
}
try{
 await page.locator('#start-demo').click();await ready();await load();
 assert.deepEqual(await frets(),original);
 // 1. A mouse drag from bar 1 beat 2 to bar 2 beat 3: the light-blue beat range.
 {const a=await point(0,1),b=await point(1,2);
  await page.mouse.move(a.x,a.y+4);await page.mouse.down();await page.mouse.move((a.x+b.x)/2,a.y+4,{steps:5});await page.mouse.move(b.x,b.y+4,{steps:5});await page.mouse.up();
  const s=await page.evaluate(()=>window.tabStudio.getState());
  assert.ok(s.fragmentRange&&!s.selectedRange,'the drag makes a beat range: '+JSON.stringify({fragment:s.fragmentRange,range:s.selectedRange}));
  assert.ok(await page.locator('#range-highlight > *').count()>0,'drawn in light blue');
  await page.screenshot({path:path.join(folder,'drag-range.png')});
  await page.keyboard.press('Delete');await ready();
  await undoRedo(['1','8','9 10+12 11 12'],'mouse drag range');}
 // 1b. The same drag: the first Delete keeps the rhythm (quarter rests), a second Delete on
 // those rests makes them the simplest rests; Ctrl+Z undoes each step.
 {const durations=()=>page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars.slice(0,2).map(b=>b.voices[0].beats.map(x=>x.duration).join(' ')));
  const a=await point(0,1),b=await point(1,2);
  await page.mouse.move(a.x,a.y+4);await page.mouse.down();await page.mouse.move((a.x+b.x)/2,a.y+4,{steps:5});await page.mouse.move(b.x,b.y+4,{steps:5});await page.mouse.up();
  await page.keyboard.press('Delete');await ready();
  assert.deepEqual(await frets(),['1','8','9 10+12 11 12']);assert.deepEqual(await durations(),['4 4 4 4','4 4 4 4'],'first Delete keeps the rhythm');
  assert.ok((await page.evaluate(()=>window.tabStudio.getState())).fragmentRange,'the range stays selected');
  await page.keyboard.press('Delete');await ready();
  assert.deepEqual(await frets(),['1','8','9 10+12 11 12']);assert.deepEqual(await durations(),['4 4 2','2 4 4'],'second Delete merges the rests');
  await page.keyboard.press('Control+z');await ready();assert.deepEqual(await durations(),['4 4 4 4','4 4 4 4'],'Ctrl+Z: back to the kept rhythm');
  await page.keyboard.press('Control+z');await ready();assert.deepEqual(await frets(),original,'Ctrl+Z twice: the notes are back');
  console.log('OK delete twice');}
 // 2. Shift+arrows from a clicked note.
 // (On a selected note Shift+Right/Left transpose it: the beat is selected without its note.)
 {await page.evaluate(()=>window.tabStudio.select(2,0));await page.locator('#score-scroll').focus();
  await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Shift+ArrowRight');
  assert.ok((await page.evaluate(()=>window.tabStudio.getState())).fragmentRange,'Shift+arrows make a beat range');
  await page.keyboard.press('Delete');await ready();
  await undoRedo(['1 2 3 4','5 6 7 8','12'],'Shift+arrow range');}
 // 3. Bars from the range dialog (selectedRange) and Ctrl+A.
 {await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:/^編集$/})}).locator(':scope>button').click();
  await page.getByRole('menuitem',{name:'小節の範囲選択…',exact:true}).click();
  await page.locator('#range-start').fill('2');await page.locator('#range-end').fill('2');await page.locator('#range-apply').click();
  assert.ok((await page.evaluate(()=>window.tabStudio.getState())).selectedRange,'bar range');
  await page.keyboard.press('Delete');await ready();
  await undoRedo(['1 2 3 4','-','9 10+12 11 12'],'bar range (dialog)');
  await page.locator('#score-scroll').focus();await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');await ready();
  await undoRedo(['-','-','-'],'all bars (Ctrl+A)');}
 // 4. A double-clicked note, then a drag starting on it.
 {const a=await point(0,0),b=await point(0,2);await page.mouse.dblclick(a.x,a.y+4);await ready();await page.keyboard.press('Escape');
  await page.mouse.move(a.x,a.y+4);await page.mouse.down();await page.mouse.move(b.x,b.y+4,{steps:8});await page.mouse.up();
  assert.ok((await page.evaluate(()=>window.tabStudio.getState())).fragmentRange,'drag after a double-click makes a range');
  await page.keyboard.press('Delete');await ready();
  await undoRedo(['4','5 6 7 8','9 10+12 11 12'],'drag after double-click');}
 // 5. A single click on a note: Delete removes just that note.
 {const a=await point(1,1);await page.mouse.click(a.x,a.y+4);await ready();
  const s=await page.evaluate(()=>window.tabStudio.getState());assert.ok(!s.fragmentRange&&!s.selectedRange&&s.noteSelected,'one note selected');
  await page.keyboard.press('Delete');await ready();
  await undoRedo(['1 2 3 4','5 7 8','9 10+12 11 12'],'single note');}
 // 6. A click on a string without a note shows the whole beat (light-blue beat cursor, no
 // note selected): Delete clears that beat, a chord included.
 for(const [bar,beat,string,cleared] of [[1,2,4,['1 2 3 4','5 6 8','9 10+12 11 12']],[2,1,5,['1 2 3 4','5 6 7 8','9 11 12']]]){
  const a=await point(bar,beat,string);await page.mouse.click(a.x,a.y);await ready();
  const s=await page.evaluate(()=>window.tabStudio.getState());assert.ok(!s.noteSelected&&!s.fragmentRange&&!s.selectedRange&&s.selected?.string===7-string,'beat cursor on an empty string: '+JSON.stringify(s.selected));
  await page.keyboard.press('Delete');await ready();
  await undoRedo(cleared,`beat cursor on empty string ${string} (bar ${bar+1})`);}
 // 7. Click a beat, play briefly, pause, Delete without clicking: the beat under the cursor
 // (the selection) is what changes, nothing else.
 {const a=await point(0,2,3);await page.mouse.click(a.x,a.y);await ready();
  const before=await page.evaluate(()=>window.tabStudio.getState().selected);
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.tabStudio.getState().playing);await page.waitForTimeout(700);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);await ready();
  const after=await page.evaluate(()=>window.tabStudio.getState().selected);
  assert.deepEqual({bar:after.bar,beat:after.beat,string:after.string},{bar:before.bar,beat:before.beat,string:before.string},'pausing keeps the selection');
  await page.keyboard.press('Delete');await ready();
  await undoRedo(['1 2 4','5 6 7 8','9 10+12 11 12'],'Delete after play and pause');}
 assert.deepEqual(app.errors,[]);console.log('PASS tauri-delete-range-check',folder);
}finally{await app.close();}
