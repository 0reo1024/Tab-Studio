import {_electron as electron} from '@playwright/test';
import * as at from '@coderline/alphatab';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const folder=path.resolve('test-results/range-playback-'+Date.now());
await fs.mkdir(folder,{recursive:true});
const app=await electron.launch({
 executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),
 args:process.env.TAB_STUDIO_TEST_EXE?[]:[process.cwd()],
 env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}
});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(e.message));
 const ready=()=>page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering&&!window.tabStudio.getState().loading);
 const state=()=>page.evaluate(()=>window.tabStudio.getState());
 const playing=()=>page.waitForFunction(()=>window.tabStudio.getState().playing);
 const paused=()=>page.waitForFunction(()=>!window.tabStudio.getState().playing);
 await ready();
 const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Range playback" \\tempo 90 \\track "Lead" . '+Array(12).fill(':8 0.1 2.1 4.1 5.1 7.1 9.1 11.1 12.1').join(' | ')+' \\track "Rhythm" . '+Array(12).fill(':4 0.6 2.6 3.6 5.6').join(' | '),new at.Settings());
 const project=JSON.stringify({format:'TabStudio',version:1,sourceName:'Range playback',warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
 await page.evaluate(p=>window.tabStudio.load('range.tabstudio',new TextEncoder().encode(p)),project);await ready();
 const menu=async(label,item)=>{await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:new RegExp('^'+label+'$')})}).locator(':scope>button').dispatchEvent('click');await page.getByRole('menuitem',{name:item,exact:true}).click();};
 await menu('表示','すべてのトラックを表示');await ready();
 const point=(bar,beat,string=null)=>page.evaluate(({bar,beat,string})=>{
  const b=window.tabStudio.getScore().tracks[0].staves[0].bars[bar].voices[0].beats[beat],bb=window.tabStudio.api.boundsLookup.findBeats(b).at(-1),r=document.querySelector('#score').getBoundingClientRect(),v=bb.barBounds.visualBounds;
  return{x:r.x+bb.onNotesX,y:r.y+v.y+(6-(string??b.notes[0].string))*v.h/5};
 },{bar,beat,string});
 const cursor=()=>page.evaluate(()=>{const c=document.querySelector('.at-cursor-beat'),s=getComputedStyle(c),r=c.getBoundingClientRect();return{opacity:s.opacity,display:s.display,x:r.x,y:r.y,height:r.height};});
 const blue=()=>page.evaluate(()=>{const c=document.querySelector('#selection-marker'),s=getComputedStyle(c);return{opacity:s.opacity,display:s.display,border:s.borderColor,width:c.getBoundingClientRect().width};});
 // A cursor-only Shift selection stays blue while the live green frame moves.
 let p=await point(0,0);await page.mouse.click(p.x+20,p.y);
 const originalTick=await page.evaluate(()=>window.tabStudio.api.tickPosition);
 await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Shift+ArrowRight');assert.ok(Math.abs(await page.evaluate(()=>window.tabStudio.api.tickPosition)-originalTick)<2);
 const fragment=(await state()).fragmentRange;assert.ok(fragment);
 assert.equal((await cursor()).opacity,'0');
 await page.locator('#speed').selectOption('0.8');await page.locator('#speed').focus();
 await page.keyboard.press('Space');await playing();
 assert.deepEqual((await state()).fragmentRange,fragment);assert.ok(await page.locator('#range-highlight>div').count());
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.at-cursor-beat')).opacity==='1');
 const first=await cursor();assert.ok(first.height>100,'The playback frame spans both tracks');
 await page.waitForFunction(x=>document.querySelector('.at-cursor-beat').getBoundingClientRect().x>x+5,first.x);
 await page.screenshot({path:path.join(folder,'range-and-playing-frame.png')});
 await page.keyboard.press('Space');await paused();assert.deepEqual((await state()).fragmentRange,fragment);assert.equal((await cursor()).opacity,'0');
 // The same visibility rule applies to full measure selections.
 await page.keyboard.press('Escape');await page.keyboard.press('Control+a');const measures=(await state()).selectedRange;assert.ok(measures);
 await page.keyboard.press('Space');await playing();assert.deepEqual((await state()).selectedRange,measures);assert.equal((await cursor()).opacity,'1');
 await page.keyboard.press('Control+Space');await paused();assert.deepEqual((await state()).selectedRange,measures);assert.equal((await cursor()).opacity,'0');
 // Space stops in place and exits looping; the next Space starts normal playback.
 await page.locator('#loop-from').fill('2');await page.locator('#loop-to').fill('2');await page.keyboard.press('Enter');
 await page.locator('#loop-play').click();await playing();assert.equal(await page.evaluate(()=>window.tabStudio.api.isLooping),true);
 const start=await page.evaluate(()=>window.tabStudio.api.playbackRange.startTick);
 await page.waitForFunction(t=>window.tabStudio.api.tickPosition>t+400,start);
 const beforePause=await page.evaluate(()=>window.tabStudio.api.tickPosition);
 await page.keyboard.press('Space');await paused();
 const stopped=await page.evaluate(()=>({tick:window.tabStudio.api.tickPosition,loop:window.tabStudio.api.isLooping,range:window.tabStudio.api.playbackRange}));
 assert.equal(stopped.loop,false);assert.equal(stopped.range,null);assert.ok(stopped.tick>=beforePause-2);assert.ok(stopped.tick>start+300);assert.equal(await page.locator('#loop-play').getAttribute('aria-pressed'),'false');
 await page.keyboard.press('Space');await playing();assert.equal(await page.evaluate(()=>window.tabStudio.api.isLooping),false);assert.equal(await page.evaluate(()=>window.tabStudio.api.playbackRange),null);
 await page.keyboard.press('Control+Space');await paused();assert.ok(Math.abs(await page.evaluate(()=>window.tabStudio.api.tickPosition)-stopped.tick)<2);
 // Ctrl+Space can leave a paused loop armed; normal playback still cancels it.
 await page.locator('#loop-play').click();await playing();await page.keyboard.press('Control+Space');await paused();assert.equal(await page.evaluate(()=>window.tabStudio.api.isLooping),true);
 await page.locator('#play').click();await playing();assert.equal(await page.evaluate(()=>window.tabStudio.api.isLooping),false);await page.keyboard.press('Space');await paused();
 // Right clicking inside a selected range retains the range for clipboard actions.
 await page.evaluate(()=>document.querySelector('#score-scroll').scrollTo({top:0,left:0}));p=await point(0,1);
 await page.mouse.click(p.x,p.y,{button:'right'});await page.locator('#score-context').waitFor({state:'visible'});assert.deepEqual((await state()).selectedRange,measures);await page.keyboard.press('Escape');
 // Right click selects a note and paints the same blue outline as a double-click popup.
 await page.keyboard.press('Escape');p=await point(0,1);await page.mouse.dblclick(p.x,p.y);await page.mouse.click(p.x,p.y);await page.locator('#score-context').waitFor({state:'visible'});
 const doubleBlue=await blue();assert.equal(doubleBlue.display,'block');assert.equal(doubleBlue.opacity,'1');assert.equal(doubleBlue.width,20);
 await page.keyboard.press('Escape');p=await point(0,3);await page.mouse.click(p.x,p.y,{button:'right'});await page.locator('#score-context').waitFor({state:'visible'});
 assert.equal((await state()).selected.beat,3);assert.equal((await state()).noteSelected,true);assert.deepEqual(await blue(),doubleBlue);assert.equal((await cursor()).opacity,'0');
 await page.screenshot({path:path.join(folder,'right-click-blue-selection.png')});
 // An empty string also gets a visible blue edit position, without inserting a note.
 await page.keyboard.press('Escape');const original=await page.evaluate(()=>window.tabStudio.serialize());p=await point(0,4,3);await page.mouse.click(p.x,p.y,{button:'right'});await page.locator('#score-context').waitFor({state:'visible'});
 assert.deepEqual(await blue(),doubleBlue);assert.equal((await cursor()).opacity,'0');assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),original);
 await page.keyboard.press('Escape');assert.equal((await cursor()).opacity,'1');assert.equal((await blue()).display,'none');
 // Range gestures must never replace the playback position with their endpoint.
 const tick=()=>page.evaluate(()=>window.tabStudio.api.tickPosition);
 async function checkSelectionStart(expected){
  assert.ok(Math.abs(await tick()-expected)<2);
  const range=(await state()).fragmentRange??(await state()).selectedRange;assert.ok(range);
  await page.keyboard.press('Space');await playing();
  await page.waitForFunction(t=>window.tabStudio.api.tickPosition>t+240,expected);
  await page.keyboard.press('Control+Space');await paused();assert.ok(Math.abs(await tick()-expected)<2);
  assert.deepEqual((await state()).fragmentRange??(await state()).selectedRange,range);
 }
 await page.evaluate(()=>{document.querySelector('#score-scroll').scrollTo({top:0,left:0});window.tabStudio.select(0,5);});
 let origin=await tick();assert.ok(origin>0);
 await page.keyboard.press('Shift+ArrowLeft');await page.keyboard.press('Shift+ArrowLeft');await checkSelectionStart(origin);
 // Pause/resume uses the new stopped position, rather than resetting to the original selection.
 await page.keyboard.press('Space');await playing();await page.waitForFunction(t=>window.tabStudio.api.tickPosition>t+240,origin);
 await page.keyboard.press('Space');await paused();const resume=await tick();assert.ok(resume>origin+200);
 await page.keyboard.press('Space');await playing();await page.keyboard.press('Control+Space');await paused();assert.ok(Math.abs(await tick()-resume)<2);
 await page.keyboard.press('Escape');await page.evaluate(()=>window.tabStudio.select(0,2));origin=await tick();
 await page.keyboard.press('Shift+ArrowDown');assert.ok((await state()).fragmentRange.focus.bar>0);await checkSelectionStart(origin);
 await page.keyboard.press('Escape');await page.evaluate(()=>{document.querySelector('#score-scroll').scrollTo({top:0,left:0});window.tabStudio.select(0,4);});origin=await tick();p=await point(0,1);
 await page.keyboard.down('Shift');await page.mouse.click(p.x,p.y);await page.keyboard.up('Shift');await checkSelectionStart(origin);
 // The pre-drag cursor is outside this new range, and still controls its playback start.
 await page.keyboard.press('Escape');await page.evaluate(()=>{document.querySelector('#score-scroll').scrollTo({top:0,left:0});window.tabStudio.select(0,6);});origin=await tick();
 const dragFrom=await point(0,1),dragTo=await point(0,4);await page.mouse.move(dragFrom.x,dragFrom.y);await page.mouse.down();await page.mouse.move(dragTo.x,dragTo.y,{steps:12});await page.mouse.up();
 assert.equal((await state()).fragmentRange.anchor.beat,1);assert.equal((await state()).fragmentRange.focus.beat,4);await checkSelectionStart(origin);
 await page.keyboard.press('Escape');await page.evaluate(()=>window.tabStudio.select(0,3));origin=await tick();
 await menu('編集','小節の範囲選択…');await page.locator('#range-start').fill('2');await page.locator('#range-end').fill('3');await page.locator('#range-apply').click();await checkSelectionStart(origin);
 assert.deepEqual(errors,[]);
 console.log('RANGE PLAYBACK / CONTEXT PASSED: fragment and measure selection maintained / live green cursor over two tracks / pause visibility / Space cancels loop / normal resume / Ctrl+Space / range context preserved / note and empty-string blue selection / original cursor preserved for keyboard, Shift-click, drag and measure selection / pause-resume');
 console.log('QA_FOLDER='+folder);
}catch(e){const p=await app.firstWindow();console.log(await p.evaluate(()=>({state:window.tabStudio?.getState(),loop:window.tabStudio?.api.isLooping,notes:window.tabStudio?.getScore().tracks[0].staves[0].bars[0].voices[0].beats[3].notes.map(n=>({fret:n.fret,string:n.string,id:n.id})),bounds:window.tabStudio?.api.boundsLookup.findBeats(window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[3]).map(b=>({x:b.onNotesX,notes:b.beat.notes.map(n=>({fret:n.fret,string:n.string,id:n.id}))})),notice:document.querySelector('#notice')?.textContent})));await p.screenshot({path:path.join(folder,'failure.png')});throw e;}
finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
