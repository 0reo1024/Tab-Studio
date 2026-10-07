import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.resolve('test-results/seek-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 await page.locator('#follow').uncheck();const before=await page.evaluate(()=>window.tabStudio.api.boundsLookup.staffSystems.map(s=>[s.realBounds.x,s.realBounds.y,s.realBounds.w,s.realBounds.h]));
 async function click(bar,beat){const p=await page.evaluate(({bar,beat})=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[bar].voices[0].beats[beat],bb=window.tabStudio.api.boundsLookup.findBeats(b).at(-1),r=document.querySelector('#score').getBoundingClientRect();return{x:r.x+bb.onNotesX,y:r.y+bb.barBounds.visualBounds.y,tick:b.voice.bar.masterBar.start+b.playbackStart};},{bar,beat});await page.mouse.click(p.x,p.y);return p.tick;}
 await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition>250);
 const target=await click(2,2);await page.waitForFunction(t=>window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition>=t&&window.tabStudio.api.tickPosition<t+1000,target);
 const jumped=await page.evaluate(()=>window.tabStudio.api.tickPosition);await page.waitForFunction(t=>window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition>t+150,jumped);
 const backwards=await click(0,2);await page.waitForFunction(t=>window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition>=t&&window.tabStudio.api.tickPosition<t+700,backwards);
 assert.deepEqual(await page.evaluate(()=>window.tabStudio.api.boundsLookup.staffSystems.map(s=>[s.realBounds.x,s.realBounds.y,s.realBounds.w,s.realBounds.h])),before);
 await page.keyboard.press('Control+Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition<3);
 assert.deepEqual(errors,[]);console.log('PLAYBACK SEEK PASSED: forward / backward click continues playback / fixed layout / original Ctrl+Space start');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
