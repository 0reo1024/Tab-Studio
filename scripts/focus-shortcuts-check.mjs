import {_electron as electron} from '@playwright/test';
import * as at from '@coderline/alphatab';
import assert from 'node:assert/strict';
import path from 'node:path';
const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Focus shortcuts" \\tempo 90 . '+Array(8).fill(':4 3.1 5.1 7.1 5.1').join(' | '),new at.Settings());
const project=JSON.stringify({format:'TabStudio',version:1,sourceName:score.title,warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.resolve('test-results/focus-shortcuts-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 await page.evaluate(p=>window.tabStudio.load('focus.tabstudio',new TextEncoder().encode(p)),project);
 await page.waitForFunction(()=>window.tabStudio.getScore().title==='Focus shortcuts'&&!window.tabStudio.getState().rendering);
 // Selecting a speed must not require a click back on the score, even on first load.
 await page.locator('#speed').selectOption('0.8');await page.locator('#speed').focus();await page.keyboard.press('Space');
 await page.waitForFunction(()=>window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition>150);
 await page.locator('#speed').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);
 await page.locator('#speed').focus();await page.keyboard.press('ArrowRight');assert.ok(await page.evaluate(()=>window.tabStudio.getState().selected));
 const controls=['#speed','#clickKind','#clickVolume','#click','#follow','#tracks input[type=range]','#tracks select','#tracks input[type=checkbox]','#current'];
 for(const selector of controls){
  await page.evaluate(()=>window.tabStudio.select(1,1));
  const control=page.locator(selector).first(),before=await control.evaluate(e=>({value:e.value,checked:e.checked}));
  const initial=await page.evaluate(()=>window.tabStudio.getState().selected);
  for(const [key,check] of [['ArrowRight',s=>s.bar===1&&s.beat===2],['ArrowLeft',s=>s.bar===1&&s.beat===1],['ArrowDown',s=>s.bar===1&&s.string===initial.string-1],['ArrowUp',s=>s.bar===1&&s.beat===1&&s.string===initial.string]]){
   await control.focus();await page.keyboard.press(key);assert.ok(check(await page.evaluate(()=>window.tabStudio.getState().selected)),selector+' '+key);
  }
  assert.deepEqual(await page.evaluate(()=>window.tabStudio.getState().selected),initial);
  const start=await page.evaluate(()=>window.tabStudio.api.tickPosition);await control.focus();await page.keyboard.press('Space');await page.waitForFunction(t=>window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition>t+100,start);
  await control.focus();await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);
  assert.deepEqual(await control.evaluate(e=>({value:e.value,checked:e.checked})),before,selector+' must not consume score shortcuts');
 }
 // Open menus must relinquish Space and arrows without invoking the highlighted item.
 for(const menu of await page.locator('.menu-root').all()){
  await page.evaluate(()=>window.tabStudio.select(1,1));await menu.locator(':scope > button').click();await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.menu-root.open').count(),0);assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.beat),2);
 }
 const originalStart=await page.evaluate(()=>window.tabStudio.api.tickPosition);
 const file=page.locator('.menu-root').first();await file.locator(':scope > button').click();await file.locator('.menu-item').first().focus();await page.keyboard.press('Space');
 await page.waitForFunction(()=>window.tabStudio.getState().playing);assert.equal(await page.locator('.menu-root.open').count(),0);assert.equal(await page.evaluate(()=>window.tabStudio.getScore().title),'Focus shortcuts');
 // Arrow seeking keeps playback going and Ctrl+Space retains its original start.
 await page.evaluate(()=>window.tabStudio.select(1,1));await page.locator('#speed').focus();await page.keyboard.press('Control+ArrowRight');
 assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.bar),2);assert.ok(await page.evaluate(()=>window.tabStudio.getState().playing));
 await page.locator('#clickKind').focus();await page.keyboard.press('ArrowDown');assert.ok(await page.evaluate(()=>window.tabStudio.getState().selected.bar>=4));assert.ok(await page.evaluate(()=>window.tabStudio.getState().playing));
 await page.keyboard.press('Control+Space');await page.waitForFunction(t=>!window.tabStudio.getState().playing&&Math.abs(window.tabStudio.api.tickPosition-t)<2,originalStart);
 // Keys arriving during a re-render are applied against the new score bounds.
 await page.evaluate(()=>{window.tabStudio.select(1,1);document.querySelector('#zoomOut').click();document.querySelector('#speed').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true}));});
 await page.waitForFunction(()=>!window.tabStudio.getState().rendering&&window.tabStudio.getState().selected.string===5);
 await page.evaluate(()=>{window.tabStudio.select(1,1);document.querySelector('#zoomIn').click();document.querySelector('#speed').dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));});
 await page.waitForFunction(()=>!window.tabStudio.getState().rendering&&window.tabStudio.getState().playing);await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);
 // A Space inside fret input commits the number and starts playback without inserting a space.
 await page.evaluate(()=>window.tabStudio.select(0,0));await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('12');await page.keyboard.press('Space');
 await page.waitForFunction(()=>!window.tabStudio.getState().rendering&&window.tabStudio.getState().playing);
 assert.ok(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[0].notes.some(n=>n.fret===12)));assert.ok(!await page.locator('#inline-fret').isVisible());
 await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);
 assert.deepEqual(errors,[]);console.log('FOCUS SHORTCUTS PASSED: 9 controls / changed speed / first load / all menus / playback arrow seek / Ctrl+Space / render queue / fret input Space');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
