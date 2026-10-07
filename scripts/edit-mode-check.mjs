import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.resolve('test-results/edit-mode-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 await page.evaluate(()=>{window.previewNotes=[];const a=window.tabStudio.preview,play=a.play.bind(a);a.play=async n=>{const result=await play(n);window.previewNotes.push({fret:n.fret,string:n.string,pitch:n.realValue,...result});return result;};});
 async function point(beat=0){return page.evaluate(i=>{const a=window.tabStudio.api,b=window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[i],bounds=a.boundsLookup.findBeats(b).at(-1),r=document.querySelector('#score').getBoundingClientRect(),v=bounds.barBounds.visualBounds,string=b.notes[0]?.string??6;return{x:r.x+bounds.onNotesX,y:r.y+v.y+(6-string)*v.h/5,string};},beat);}
 const p=await point();await page.mouse.click(p.x,p.y);assert.ok(!await page.locator('#inline-fret').isVisible());
 assert.equal(await page.locator('#editMode').count(),0);await page.keyboard.press('e');assert.equal(await page.evaluate(()=>window.tabStudio.getState().editMode),true);
 await page.mouse.move(p.x+1,p.y);assert.ok(await page.locator('#hover-note').isVisible());
 await page.screenshot({path:path.resolve('test-results/edit-mode-hover.png')});
 await page.mouse.click(p.x,p.y);assert.ok(!await page.locator('#inline-fret').isVisible());await page.mouse.dblclick(p.x,p.y);assert.ok(await page.locator('#inline-fret').isVisible());
 await page.keyboard.type('12',{delay:50});assert.equal(await page.evaluate(()=>window.previewNotes.length),0);
 await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>!window.tabStudio.getState().rendering&&!document.querySelector('#inline-fret').hidden&&window.previewNotes.length===1);assert.equal(await page.evaluate(()=>window.previewNotes[0].fret),12);assert.ok(await page.evaluate(()=>window.previewNotes[0].peak>.001&&window.previewNotes[0].frames>1000));
 assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.beat),1);
 assert.equal(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[0].notes.find(n=>n.string===window.previewNotes[0].string).fret),12);
 await page.keyboard.type('7');await page.keyboard.press('ArrowUp');await page.waitForFunction(()=>!window.tabStudio.getState().rendering&&!document.querySelector('#inline-fret').hidden);
 assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.string),Math.min(6,p.string+1));
 await page.keyboard.type('5');await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>!window.tabStudio.getState().rendering&&!document.querySelector('#inline-fret').hidden);
 assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.string),p.string);
 await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>!window.tabStudio.getState().rendering&&!document.querySelector('#inline-fret').hidden);
 assert.equal(await page.locator('#inline-fret').inputValue(),'12');
 await page.screenshot({path:path.resolve('test-results/edit-mode-input.png')});
 await page.keyboard.press('Enter');assert.ok(!await page.locator('#inline-fret').isVisible());
 const next=await point(2);await page.mouse.dblclick(next.x,next.y);await page.keyboard.type('9');await page.keyboard.press('Escape');
 assert.ok(!await page.locator('#inline-fret').isVisible());
 await page.waitForFunction(()=>!window.tabStudio.getState().rendering);
 // Use a nonzero start and stop while still playing with focus inside a form.
 await page.evaluate(()=>window.tabStudio.select(0,3));await page.waitForFunction(()=>Math.abs(window.tabStudio.api.tickPosition-1440)<2);
 await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition>1800);
 await page.locator('#speed').focus();await page.keyboard.press('Control+Space');
 await page.waitForFunction(()=>!window.tabStudio.getState().playing&&Math.abs(window.tabStudio.api.tickPosition-1440)<2,{},{timeout:5000});
 await page.waitForTimeout(300);assert.ok(Math.abs(await page.evaluate(()=>window.tabStudio.api.tickPosition)-1440)<2);
 assert.deepEqual(errors,[]);console.log('EDIT MODE PASSED: always editing / removed mode button / hover / double click / confirmed-note preview / arrows while typing / Escape / Ctrl+Space during playback');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
