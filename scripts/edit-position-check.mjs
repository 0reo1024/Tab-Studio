import {_electron as electron} from '@playwright/test';
import * as at from '@coderline/alphatab';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const version=JSON.parse(await fs.readFile('package.json','utf8')).version,folder=path.resolve('test-results/edit-position-'+Date.now());await fs.mkdir(folder,{recursive:true});
const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve(`release/${version}/win-unpacked/Tab Studio.exe`),args:[],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}});
const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Editing position" \\instrument 27 . '+Array(20).fill(':4 3.1 5.1 7.1 9.1').join(' | '),new at.Settings());
const restScore=at.importer.ScoreLoader.loadAlphaTex('\\title "Rest selection" . :1 r | :2 r r | :4 r r r r | :8 r r r r r r r r | :16 r r r r r r r r r r r r r r r r',new at.Settings());
restScore.tracks[0].staves[0].bars[2].voices[0].beats[0].dots=1;
restScore.tracks[0].staves[0].bars[3].voices[0].beats[0].tupletNumerator=3;restScore.tracks[0].staves[0].bars[3].voices[0].beats[0].tupletDenominator=2;
const project=s=>JSON.stringify({format:'TabStudio',version:1,sourceName:s.title,warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(s))});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 await page.evaluate(()=>{window.midiLoads=0;window.loadedMidis=0;window.tabStudio.api.midiLoad.on(()=>window.midiLoads++);document.querySelector('#score').addEventListener('alphaTab.midiFileLoaded',()=>window.loadedMidis++);});
 const ready=()=>page.waitForFunction(()=>window.tabStudio.getState().ready&&!window.tabStudio.getState().rendering&&window.midiLoads===window.loadedMidis);
 await page.evaluate(p=>window.tabStudio.load('position.tabstudio',new TextEncoder().encode(p)),project(score));await ready();
 await page.evaluate(()=>{window.tabStudio.selectNote(10,2);document.querySelector('#score-scroll').scrollTop=500;});const scrollTop=await page.locator('#score-scroll').evaluate(e=>e.scrollTop);const tick=await page.evaluate(()=>window.tabStudio.getScore().masterBars[10].start+window.tabStudio.getScore().tracks[0].staves[0].bars[10].voices[0].beats[2].playbackStart);await page.waitForFunction(t=>Math.abs(window.tabStudio.api.tickPosition-t)<2,tick);
 const samePosition=async()=>{await ready();await page.waitForFunction(t=>Math.abs(window.tabStudio.api.tickPosition-t)<2,tick);assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.bar),10);};
 await page.locator('.track select[title="音色"]').selectOption('5');await samePosition();assert.ok(Math.abs(await page.locator('#score-scroll').evaluate(e=>e.scrollTop)-scrollTop)<2);
 await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('11');await page.keyboard.press('Enter');await samePosition();await page.keyboard.press('Control+z');await samePosition();await page.keyboard.press('Control+y');await samePosition();
 await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('12');await page.keyboard.press('ArrowRight');await ready();const moved=tick+960;await page.waitForFunction(t=>Math.abs(window.tabStudio.api.tickPosition-t)<2,moved);assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.beat),3);await page.keyboard.press('Escape');
 await page.locator('.track-settings').click();await page.locator('#track-instrument').selectOption('0');await page.locator('#track-apply').click();await ready();assert.equal(await page.locator('.track select[title="音色"]').inputValue(),'0');assert.ok(Math.abs(await page.evaluate(()=>window.tabStudio.api.tickPosition)-moved)<2);await page.locator('[data-close=trackDialog]').click();
 await page.locator('#score-scroll').focus();await page.keyboard.press('Space');await page.waitForFunction(t=>window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition>t+150,moved);await page.keyboard.press('Control+Space');await page.waitForFunction(t=>!window.tabStudio.getState().playing&&Math.abs(window.tabStudio.api.tickPosition-t)<2,moved);
 await page.evaluate(p=>window.tabStudio.load('rests.tabstudio',new TextEncoder().encode(p)),project(restScore));await ready();const before=await page.evaluate(()=>window.tabStudio.serialize());
 for(let bar=0;bar<5;bar++){
  const point=async()=>page.evaluate(i=>{const api=window.tabStudio.api,b=window.tabStudio.getScore().tracks[0].staves[0].bars[i].voices[0].beats[0],bb=api.boundsLookup.findBeats(b).at(-1),r=document.querySelector('#score').getBoundingClientRect();return {x:r.x+bb.onNotesX,y:r.y+bb.barBounds.visualBounds.y};},bar);
  let p=await point();await page.mouse.click(p.x,p.y);assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),before);await page.mouse.dblclick(p.x,p.y);await page.locator('#inline-fret').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),before);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.tabStudio.getState().dirty),false);assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),before);
 }
 await page.evaluate(()=>window.tabStudio.select(0,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('5');await page.keyboard.press('Enter');await ready();assert.ok(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats.some(b=>b.notes.some(n=>n.fret===5))));assert.equal(await page.evaluate(()=>window.tabStudio.getState().dirty),true);
 assert.deepEqual(errors,[]);await page.screenshot({path:path.join(folder,'rest-edit.png')});console.log('EDIT POSITION PASSED: sound / fret / undo and redo / arrow after edit / scroll retained / track-dialog sound / Space and Ctrl+Space / rests unchanged by click and double-click / explicit note entry');console.log('QA_FOLDER='+folder);
}catch(e){await (await app.firstWindow()).screenshot({path:path.join(folder,'failure.png')});throw e;}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
