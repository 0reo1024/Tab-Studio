import {_electron as electron} from '@playwright/test';
import * as at from '@coderline/alphatab';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const folder=path.resolve('test-results/edit-performance-'+Date.now());await fs.mkdir(folder,{recursive:true});
const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));const ready=()=>page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering&&!window.tabStudio.getState().loading);await ready();
 const notes=Array(168).fill(':16 3.1 5.1 7.1 9.1 3.1 5.1 7.1 9.1 3.1 5.1 7.1 9.1 3.1 5.1 7.1 9.1').join(' | '),bass=Array(168).fill(':8 3.4 5.4 3.4 5.4 3.4 5.4 3.4 5.4').join(' | ');
 const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Editing benchmark" \\track "Guitar" . '+notes+' \\track "Bass" \\tuning G2 D2 A1 E1 . '+bass,new at.Settings()),project=JSON.stringify({format:'TabStudio',version:1,sourceName:'benchmark',warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});await page.evaluate(p=>window.tabStudio.load('benchmark.tabstudio',new TextEncoder().encode(p)),project);await ready();
 await page.locator('#tracks .track').nth(1).locator('input[type=checkbox]').first().check();await ready();
 await page.evaluate(()=>{window.visibleScoreReady=()=>{const viewport=document.querySelector('#score-scroll').getBoundingClientRect(),parts=[...document.querySelectorAll('#score .at-surface > div')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom>viewport.top&&r.top<viewport.bottom&&r.right>viewport.left&&r.left<viewport.right;});return parts.length>0&&parts.every(e=>e.querySelector('svg,canvas')&&(!e.layoutResultId||e.renderedResultId===e.layoutResultId));};window.longTasks=[];new PerformanceObserver(list=>window.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,ms:e.duration})))).observe({type:'longtask',buffered:false});});
 const select=async(bar,beat=0)=>{await page.evaluate(p=>{window.tabStudio.select(...p);const b=window.tabStudio.getScore().tracks[0].staves[0].bars[p[0]].voices[0].beats[p[1]],bb=window.tabStudio.api.boundsLookup.findBeat(b);document.querySelector('#score-scroll').scrollTop=Math.max(0,bb.barBounds.visualBounds.y-100);document.querySelector('#score-scroll').focus();},[bar,beat]);await page.waitForFunction(()=>window.visibleScoreReady());};
 async function key(key,ctrl=false,shift=false){return page.evaluate(async p=>{const start=performance.now();(document.activeElement||window).dispatchEvent(new KeyboardEvent('keydown',{key:p.key,ctrlKey:p.ctrl,shiftKey:p.shift,bubbles:true,cancelable:true}));const handlerMs=performance.now()-start;await new Promise(resolve=>{const check=()=>{const s=window.tabStudio.getState();if(!s.rendering&&s.ready&&window.visibleScoreReady())requestAnimationFrame(resolve);else requestAnimationFrame(check);};requestAnimationFrame(check);});return {handlerMs,readyMs:performance.now()-start};},{key,ctrl,shift});}
 const results={};
 for(const [name,bar,beats]of [['small',0,3],['large',31,0]]){
  await select(bar);if(name==='large')await key('ArrowLeft',true,true);else for(let i=0;i<beats;i++)await key('ArrowRight',false,true);
  results[name+'Copy']=await key('c',true);await select(80);
  results[name+'Paste']=await key('v',true);assert.equal(await page.evaluate(()=>document.querySelector('#notice').classList.contains('visible')),false);
  results[name+'Undo']=await key('z',true);results[name+'Redo']=await key('y',true);await key('z',true);
 }
 await select(80);await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('12');results.noteEdit=await key('Enter');assert.equal(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[80].voices[0].beats[0].notes[0].fret),12);
 results.noteUndo=await key('z',true);
 await select(0);results.fullSelection=await key('ArrowRight',true,true);
 await page.waitForFunction(()=>window.visibleScoreReady());const summary=await page.evaluate(()=>({svg:document.querySelectorAll('#score svg').length,svgNodes:document.querySelectorAll('#score svg *').length,longTasks:window.longTasks}));assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[80].voices[0].beats[0].notes[0].fret),3);
 await page.screenshot({path:path.join(folder,'editing.png')});const report={results,...summary};await fs.writeFile(path.join(folder,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({results,svg:summary.svg,svgNodes:summary.svgNodes,maxLongTask:Math.max(0,...summary.longTasks.map(t=>t.ms)),folder},null,2));
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
