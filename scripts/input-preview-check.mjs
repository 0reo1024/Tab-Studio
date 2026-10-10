import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const folder=path.resolve('test-results/input-preview-'+Date.now());await fs.mkdir(folder,{recursive:true});let app;
async function launch(){app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}});const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.locator('#start-demo').click();await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);return page;}
try{
 let page=await launch();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const ready=()=>page.waitForFunction(()=>window.tabStudio.getState().ready&&!window.tabStudio.getState().rendering);
 await page.evaluate(()=>{window.calls=[];window.results=[];window.renders=0;window.tabStudio.api.postRenderFinished.on(()=>window.renders++);const preview=window.tabStudio.preview;for(const method of ['play','enqueue']){const original=preview[method].bind(preview);preview[method]=async note=>{const event={method,fret:note.fret,pitch:note.realValue};window.calls.push(event);const result=await original(note);window.results.push({...event,...result});return result;};}});
 const calls=()=>page.evaluate(()=>window.calls.length);
 const results=()=>page.evaluate(()=>window.results);
 const point=async(beat,bar=0)=>page.evaluate(({beat,bar})=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[bar].voices[0].beats[beat],bb=window.tabStudio.api.boundsLookup.findBeats(b).at(-1),r=document.querySelector('#score').getBoundingClientRect(),v=bb.barBounds.visualBounds,n=b.notes[0];return{x:r.left+bb.onNotesX,y:r.top+v.y+(6-(n?.string??6))*v.h/5};},{beat,bar});
 assert.equal(await page.evaluate(()=>window.tabStudio.getState().settings.previewClick),true);assert.equal(await page.locator('#settings-preview-timing').count(),0);
 await page.evaluate(()=>window.tabStudio.selectNote(0,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');
 const before=await page.evaluate(()=>({renders:window.renders,score:window.tabStudio.serialize()}));
 await page.keyboard.type('12',{delay:0});await page.waitForFunction(()=>window.results.filter(r=>r.method==='enqueue'&&r.played).length===2);
 let data=await results();assert.deepEqual(data.map(r=>r.fret),[1,12]);assert.equal(data[1].pitch-data[0].pitch,11);assert.ok(data.every(r=>r.played&&r.peak>0.001&&r.frames>1000));
 assert.equal(await page.evaluate(()=>window.renders),before.renders);assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),before.score);
 // Typing the same value again also sounds; invalid and blank entries are silent.
 await page.locator('#inline-fret').fill('12');await page.waitForFunction(()=>window.results.length===3);
 await page.locator('#inline-fret').fill('99');assert.equal(await calls(),3);await page.locator('#inline-fret').fill('');assert.equal(await calls(),3);
 // Confirming with Enter or by moving does not play the note again.
 await page.locator('#inline-fret').fill('12');await page.waitForFunction(()=>window.results.length===4);await page.keyboard.press('Enter');await ready();assert.equal(await calls(),4);assert.equal(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret),12);
 await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('14');await page.waitForFunction(()=>window.results.length===5);await page.keyboard.press('ArrowRight');await ready();assert.equal(await calls(),5);assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.beat),1);await page.keyboard.press('Escape');
 const target=await point(3);await page.mouse.click(target.x,target.y);await page.waitForFunction(()=>window.results.length===6);assert.equal((await results())[5].method,'play');assert.equal((await results())[5].fret,0);assert.equal((await results())[5].played,true);
 const rest=await point(1,3);await page.mouse.click(rest.x,rest.y);assert.equal(await calls(),6);
 const start=await point(0),end=await point(2);await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:8});await page.mouse.up();assert.equal(await calls(),6);await page.keyboard.press('Escape');
 async function setting(clicked,enabled=true){await page.keyboard.press('Control+,');await page.locator('#settings-preview').setChecked(enabled);await page.locator('#settings-preview-click').setChecked(clicked);await page.locator('#settings-apply').click();}
 // A subsequent click must not discard either of the newly typed values.
 await page.evaluate(()=>window.tabStudio.selectNote(0,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.keyboard.type('23',{delay:0});await page.mouse.click(target.x,target.y);await ready();await page.waitForFunction(()=>window.results.length>=9);
 data=await results();assert.deepEqual(data.slice(6,8).map(r=>r.fret),[2,23]);assert.ok(data.slice(6).every(r=>r.played));const afterClick=await calls();
 // Single-click preview off: clicks are silent, typing still sounds, Enter and movement stay silent.
 await setting(false);await page.mouse.click(target.x,target.y);assert.equal(await calls(),afterClick);
 await page.evaluate(()=>window.tabStudio.selectNote(0,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('16');await page.waitForFunction(n=>window.results.length===n+1,afterClick);assert.equal((await results()).at(-1).fret,16);assert.equal((await results()).at(-1).method,'enqueue');await page.keyboard.press('Enter');await ready();assert.equal(await calls(),afterClick+1);
 await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('17');await page.waitForFunction(n=>window.results.length===n+2,afterClick);await page.keyboard.press('ArrowRight');await ready();assert.equal(await calls(),afterClick+2);await page.keyboard.press('Escape');
 await setting(true,false);await page.mouse.click(target.x,target.y);await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('18');await page.keyboard.press('Enter');await ready();assert.equal(await calls(),afterClick+2);await page.screenshot({path:path.join(folder,'app.png')});
 // Settings are durable, even when edits are deliberately discarded.
 const closed=app.waitForEvent('close');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await page.locator('#exit-discard').click();await closed;app=undefined;
 page=await launch();assert.equal(await page.evaluate(()=>window.tabStudio.getState().settings.preview),false);assert.equal(await page.evaluate(()=>window.tabStudio.getState().settings.previewClick),true);assert.deepEqual(errors,[]);
 console.log('INPUT PREVIEW PASSED: fast 1 then 12 both audible at once / every typed value sounds, invalid silent / draft score unchanged / Enter and movement silent / single-click audio / rest and drag silent / click preview off / preview off / settings restart');console.log('QA_FOLDER='+folder);
}finally{if(app)await app.evaluate(()=>process.exit(0)).catch(()=>{});}
