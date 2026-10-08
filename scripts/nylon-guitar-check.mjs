import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {demoScore,project} from '../src/score.ts';

const score=demoScore();score.tracks[0].playbackInfo.program=24;
const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST:'1',TAB_STUDIO_TEST_DATA:path.resolve('test-results/nylon-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('#start-demo').click();await page.waitForFunction(()=>window.tabStudio?.getState().ready);
 await page.evaluate(p=>window.tabStudio.load('Nylon.tabstudio',new TextEncoder().encode(p)),project(score,'Nylon',[]));
 await page.waitForFunction(()=>window.tabStudio.getState().ready&&!window.tabStudio.getState().rendering,undefined,{timeout:60000});
 assert.ok(await page.evaluate(()=>window.tabStudio.api.settings.player.soundFont.endsWith('/GeneralUser-Classical.sf3')));
 const preview=await page.evaluate(async()=>{const note=window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];return window.tabStudio.preview.play(note);});
 assert.equal(preview.played,true);assert.ok(preview.peak>.001);
 await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);
 const peak=await page.evaluate(()=>new Promise(resolve=>{const audio=window.tabStudio.mixerAudio,pcm=new Float32Array(256);let peak=0;const end=performance.now()+1800;const sample=()=>{audio.graphs[0].meter.getFloatTimeDomainData(pcm);for(const v of pcm)peak=Math.max(peak,Math.abs(v));if(performance.now()<end)setTimeout(sample,20);else resolve(peak);};sample();}));
 assert.ok(peak>.001);assert.equal(await page.evaluate(()=>window.tabStudio.getState().playing),true);assert.deepEqual(errors,[]);
 console.log('NYLON GUITAR PASSED: bundled classical soundfont, note preview, actual playback');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
