import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {demoScore,project} from '../src/score.ts';
import {trackAudio} from '../src/mixer-state.ts';
const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST:'1',TAB_STUDIO_TEST_DATA:path.resolve('test-results/sound-sync-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.locator('#start-demo').click();await page.waitForFunction(()=>window.tabStudio?.getState().ready);
 const guitar=await page.evaluate(async()=>(await window.nativeFx.sfzLibrary())[0]);assert.equal(guitar.name,'Guitar DI');
 const score=demoScore();trackAudio(score.tracks[0]).sound={kind:'sfz',name:'Standard Guitar · DI',path:guitar.path};
 await page.evaluate(p=>window.tabStudio.load('Sound.tabstudio',new TextEncoder().encode(p)),project(score,'Sound',[]));await page.waitForFunction(()=>window.tabStudio.getState().ready&&!window.tabStudio.getState().rendering);
 const buttonPosition=await page.locator('#mixer-toggle').boundingBox();await page.locator('#mixer-toggle').click();assert.equal(await page.locator('#mixer-toggle').getAttribute('aria-pressed'),'true');assert.deepEqual(await page.locator('#mixer-toggle').boundingBox(),buttonPosition);
 assert.equal(await page.locator('#tracks select').inputValue(),'27');assert.equal(await page.locator('#tracks select option').textContent(),'Guitar DI');assert.ok(await page.locator('#tracks select').isDisabled());
 await page.locator('[data-sound="0"]').click();await page.locator('#mixer-program').waitFor();assert.ok(await page.locator('#mixer-program').isDisabled());
 await page.locator('#mixer-sound').selectOption('gm');await page.waitForFunction(()=>!document.querySelector('#mixer-program').disabled);assert.ok(await page.locator('#tracks select').isEnabled());
 await page.evaluate(()=>window.tabStudio.api.midiLoad.on(file=>window.lastPrograms=file.tracks.flatMap(t=>t.events).filter(e=>e.track===0&&e.type===192).map(e=>e.program)));
 await page.locator('#mixer-program').selectOption('5');await page.waitForFunction(()=>window.lastPrograms?.length&&window.lastPrograms.every(p=>p===5)&&!window.tabStudio.getState().rendering);
 assert.equal(await page.locator('#tracks select').inputValue(),'5');assert.equal(await page.locator('#mixer-program').inputValue(),'5');assert.equal(await page.locator('#mixer-program option').count(),128);
 await page.getByRole('button',{name:'閉じる',exact:true}).click();await page.locator('#tracks select').selectOption('30');await page.waitForFunction(()=>window.lastPrograms?.every(p=>p===30)&&!window.tabStudio.getState().rendering);
 await page.locator('[data-sound="0"]').click();await page.locator('#mixer-program').waitFor();assert.equal(await page.locator('#mixer-program').inputValue(),'30');assert.equal(await page.locator('#mixer-program option:checked').textContent(),'Distortion');
 await page.getByRole('button',{name:'閉じる',exact:true}).click();await page.locator('#mixer-toggle').click();assert.ok(await page.locator('#mixer').isHidden());assert.deepEqual(await page.locator('#mixer-toggle').boundingBox(),buttonPosition);await page.locator('#mixer-toggle').click();assert.ok(await page.locator('#mixer').isVisible());
 assert.deepEqual(errors,[]);console.log('MIXER SOUND PASSED: legacy Guitar DI name, GM lock, 128 shared names, bidirectional selection and playback MIDI, fixed toggle');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
