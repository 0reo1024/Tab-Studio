import {_electron as electron} from '@playwright/test';
import * as at from '@coderline/alphatab';
import assert from 'node:assert/strict';
import path from 'node:path';
const bars=8;
const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Two tracks" \\tempo 300 \\track "Lead" . '+Array(bars).fill(':4 3.1 5.1 7.1 5.1').join(' | ')+' \\track "Rhythm" '+Array(bars).fill(':8 r 0.6 r 2.5 r 0.6 r 3.5').join(' | '),new at.Settings());
const project=JSON.stringify({format:'TabStudio',version:1,sourceName:'Two tracks',warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.resolve('test-results/multitrack-'+Date.now())}});
try{
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 await page.evaluate(p=>window.tabStudio.load('two.tabstudio',new TextEncoder().encode(p)),project);
 await page.waitForFunction(()=>window.tabStudio.getState().tracks===2&&!window.tabStudio.getState().rendering);
 await page.locator('#follow').uncheck();
 const areas=await page.evaluate(()=>window.tabStudio.api.boundsLookup.staffSystems.map(s=>{
  const rows=new Map();for(const m of s.bars)for(const b of m.bars){const model=b.bar??b.beats[0]?.beat.voice.bar;if(model)rows.set(model.staff.track.index+':'+model.staff.index,b.visualBounds);}
  const values=[...rows.values()],top=Math.min(...values.map(b=>b.y));return{y:top-12,h:Math.max(...values.map(b=>b.y+b.h))-top+24};
 }));
 assert.ok(areas.length>=2);
 await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);
 const samples=await page.evaluate(()=>new Promise(resolve=>{
  const out=[];
  function sample(){const e=document.querySelector('.at-cursor-beat'),m=new DOMMatrix(getComputedStyle(e).transform);out.push({x:m.m41,y:m.m42,h:e.getBoundingClientRect().height,tick:window.tabStudio.api.tickPosition});if(window.tabStudio.getState().playing)requestAnimationFrame(sample);else resolve(out);}
  requestAnimationFrame(sample);
 }));
 const visited=new Set();let previous;
 for(const sample of samples){if(sample.tick===0)continue;const row=areas.findIndex(a=>Math.abs(a.y-sample.y)<1&&Math.abs(a.h-sample.h)<1);assert.ok(row>=0,'frame jumped between tracks: '+JSON.stringify(sample));visited.add(row);
  if(previous&&row===previous.row&&sample.tick>=previous.tick)assert.ok(sample.x>=previous.x-2,'backward frame movement within a row: '+JSON.stringify({previous,sample}));previous={...sample,row};
 }
 assert.ok(visited.size>=2);assert.ok(samples.length>100);
 const start=480;
 // Select and play in the same turn, before the worker can acknowledge seeking.
 await page.evaluate(()=>{window.tabStudio.select(0,1,1);document.querySelector('#play').click();});
 await page.waitForFunction(()=>window.tabStudio.getState().playing);
 await page.screenshot({path:path.resolve('test-results/two-track-frame.png')});
 await page.locator('#speed').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);
 const paused=await page.evaluate(()=>window.tabStudio.api.tickPosition);await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>window.tabStudio.api.tickPosition),paused);
 await page.keyboard.press('Control+Space');await page.waitForFunction(t=>Math.abs(window.tabStudio.api.tickPosition-t)<2,start,{timeout:5000});
 assert.deepEqual(errors,[]);console.log(`MULTITRACK PASSED: ${samples.length} frames / ${visited.size} rows / no track jumps / Space and Ctrl+Space`);
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
