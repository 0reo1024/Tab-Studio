import {_electron as electron} from '@playwright/test';
import * as at from '@coderline/alphatab';
import assert from 'node:assert/strict';
import path from 'node:path';
const rows=at.importer.ScoreLoader.loadAlphaTex('\\title "Rows" \\track "Lead" . '+Array(8).fill(':4 3.1 5.1 7.1 5.1').join(' | ')+' \\track "Rhythm" '+Array(8).fill(':8 r 0.6 r 2.5 r 0.6 r 3.5').join(' | '),new at.Settings());
const blank=at.importer.ScoreLoader.loadAlphaTex('\\title "Full rest" . :1 r | r',new at.Settings());
function project(score){return JSON.stringify({format:'TabStudio',version:1,sourceName:score.title,warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});}
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.resolve('test-results/navigation-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 await page.evaluate(p=>window.tabStudio.load('rows.tabstudio',new TextEncoder().encode(p)),project(rows));
 await page.waitForFunction(()=>window.tabStudio.getScore().title==='Rows'&&!window.tabStudio.getState().rendering);
 assert.equal(await page.locator('#notation').count(),0);
 const view=page.locator('.menu-root').filter({has:page.locator(':scope > button', {hasText:/^表示$/})});
 await view.locator(':scope > button').click();assert.ok(await page.getByRole('menuitem',{name:/TABのみ$/}).evaluate(e=>e.classList.contains('checked')));
 await page.getByRole('menuitem',{name:/五線譜 ＋ TAB$/}).click();await page.waitForFunction(()=>!window.tabStudio.getState().rendering);
 assert.ok(await page.evaluate(()=>window.tabStudio.getScore().tracks.every(t=>t.staves[0].showStandardNotation)));
 await view.locator(':scope > button').click();assert.ok(await page.getByRole('menuitem',{name:/五線譜 ＋ TAB$/}).evaluate(e=>e.classList.contains('checked')));
 await page.getByRole('menuitem',{name:/TABのみ$/}).click();await page.waitForFunction(()=>!window.tabStudio.getState().rendering);
 await page.evaluate(()=>window.tabStudio.select(1,2,1));await page.locator('#score-scroll').focus();
 const initial=await page.evaluate(()=>window.tabStudio.getState().selected);
 async function row(){return page.evaluate(()=>{const s=window.tabStudio.getState().selected,a=window.tabStudio.api,b=window.tabStudio.getScore().tracks[s.track].staves[s.staff].bars[s.bar].voices[s.voice].beats[s.beat];return a.boundsLookup.staffSystems.indexOf(a.boundsLookup.findBeats(b).at(-1).barBounds.masterBarBounds.staffSystemBounds);});}
 const initialRow=await row();await page.keyboard.press('ArrowDown');assert.equal(await row(),initialRow);assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.string),initial.string-1);await page.keyboard.press('ArrowUp');assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.string),initial.string);await page.keyboard.press('Escape');
 await page.evaluate(()=>window.tabStudio.select(1,2,1));await page.keyboard.press('Shift+ArrowDown');assert.equal(await row(),initialRow+1);assert.ok(await page.evaluate(()=>window.tabStudio.getState().fragmentRange));await page.keyboard.press('Escape');
 await page.evaluate(p=>window.tabStudio.load('rest.tabstudio',new TextEncoder().encode(p)),project(blank));await page.waitForFunction(()=>window.tabStudio.getScore().title==='Full rest'&&!window.tabStudio.getState().rendering);

 const p=await page.evaluate(()=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[0],bb=window.tabStudio.api.boundsLookup.findBeats(b).at(-1),r=document.querySelector('#score').getBoundingClientRect();return{x:r.x+bb.onNotesX,y:r.y+bb.barBounds.visualBounds.y};});
 await page.mouse.click(p.x,p.y);assert.ok(!await page.locator('#inline-fret').isVisible());assert.equal(await page.evaluate(()=>window.tabStudio.getState().dirty),false);assert.ok(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[0].isFullBarRest));
 await page.mouse.dblclick(p.x,p.y);await page.waitForFunction(()=>!window.tabStudio.getState().rendering&&!document.querySelector('#inline-fret').hidden);
 await page.keyboard.type('5');await page.keyboard.press('Enter');await page.waitForFunction(()=>!window.tabStudio.getState().rendering);
 assert.ok(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats.some(b=>b.notes.some(n=>n.fret===5))));
 assert.deepEqual(errors,[]);console.log('NAVIGATION PASSED: display menu / checked notation / always-edit string movement / cursor Shift row selection / full-rest double-click edit');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
