// Stage-A performance baseline: drives the built app (dist/) through the hot
// editing paths on the 168-bar benchmark score and a synthetic 600-bar x 8-track
// score, then writes median/p95/max for wall-clock latency and internal spans.
// Usage: pnpm build && node scripts/perf-benchmark.mjs [label]
import {_electron as electron} from '@playwright/test';
import * as at from '@coderline/alphatab';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const label=process.argv[2]||'run',folder=path.resolve('test-results/perf-'+label+'-'+Date.now());await fs.mkdir(folder,{recursive:true});
const only=process.env.PERF_FIXTURE;
function fixture168(){
 const notes=Array(168).fill(':16 3.1 5.1 7.1 9.1 3.1 5.1 7.1 9.1 3.1 5.1 7.1 9.1 3.1 5.1 7.1 9.1').join(' | '),bass=Array(168).fill(':8 3.4 5.4 3.4 5.4 3.4 5.4 3.4 5.4').join(' | ');
 return '\\title "Editing benchmark" \\track "Guitar" . '+notes+' \\track "Bass" \\tuning G2 D2 A1 E1 . '+bass;
}
function fixture600(){
 const bars=600,parts=['\\title "Large benchmark" \\tempo 120'];
 const guitar=b=>`:8 ${(b%5)+3}.1 (${(b%5)+5}.2 ${(b%5)+5}.3) 7.1 5.2 r (3.3 5.4) 7.2 8.1`;
 const lead=b=>`:16 ${b%12}.1 ${(b%12)+2}.1 ${(b%12)+3}.1 ${(b%12)+5}.1 :8 ${(b%12)+7}.2 5.2 :4 7.3 :8 5.3 3.4 :4 5.4`;
 const bass=b=>`:8 ${b%7}.4 ${b%7}.4 ${(b%7)+2}.3 ${(b%7)+2}.3 ${b%7}.4 r 3.3 5.3`;
 for(let t=0;t<8;t++){
  const kind=t===6||t===7?'bass':t%2?'lead':'guitar';
  parts.push(`\\track "${kind} ${t+1}"`+(kind==='bass'?' \\tuning G2 D2 A1 E1':'')+' .');
  parts.push(Array.from({length:bars},(_,b)=>(kind==='bass'?bass:kind==='lead'?lead:guitar)(b)).join(' | '));
 }
 return parts.join(' ');
}
function project(tex){const score=at.importer.ScoreLoader.loadAlphaTex(tex,new at.Settings());return {bars:score.masterBars.length,tracks:score.tracks.length,notes:score.tracks.reduce((n,t)=>n+t.staves[0].bars.reduce((m,b)=>m+b.voices[0].beats.reduce((k,x)=>k+x.notes.length,0),0),0),json:JSON.stringify({format:'TabStudio',version:1,sourceName:'benchmark',warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))}),gp:[...new at.exporter.Gp7Exporter().export(score,new at.Settings())]};}
const stats=list=>{const timeouts=list.filter(v=>v===null).length;list=list.filter(v=>v!==null);const s=[...list].sort((a,b)=>a-b),q=p=>s[Math.min(s.length-1,Math.ceil(p*s.length)-1)]??0;return {n:s.length,...(timeouts?{timeouts}:{}),median:+q(.5).toFixed(2),p95:+q(.95).toFixed(2),max:+(s.at(-1)??0).toFixed(2)};};
const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}});
const report={label,date:new Date().toISOString(),fixtures:{}};
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(240000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.error('    console error: '+m.text().slice(0,300));});
 let crashed=false;page.on('crash',()=>{crashed=true;console.error('RENDERER CRASHED');report.crashed=true;});
 const step=text=>{console.error(`  ${new Date().toISOString().slice(11,19)} ${text}`);if(crashed)throw new Error('renderer crashed');};
 const ready=()=>page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering&&!window.tabStudio.getState().loading,null,{polling:50});
 await page.locator('#start-demo').click({timeout:15000}).catch(()=>{});await ready();
 await page.evaluate(()=>{window.visibleScoreReady=()=>{const viewport=document.querySelector('#score-scroll').getBoundingClientRect(),parts=[...document.querySelectorAll('#score .at-surface > div')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom>viewport.top&&r.top<viewport.bottom&&r.right>viewport.left&&r.left<viewport.right;});return parts.length>0&&parts.every(e=>e.querySelector('svg,canvas')&&(!e.layoutResultId||e.renderedResultId===e.layoutResultId));};
  window.longTasks=[];new PerformanceObserver(list=>window.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});
  // Dispatch a key, report synchronous handler time and time until the visible score is settled.
  window.benchKey=async(key,ctrl=false,shift=false,target)=>{const start=performance.now();(target?document.querySelector(target):document.activeElement||window).dispatchEvent(new KeyboardEvent('keydown',{key,code:key,ctrlKey:ctrl,shiftKey:shift,bubbles:true,cancelable:true}));const handlerMs=performance.now()-start;const timedOut=await window.benchSettle(start);return {handlerMs,settledMs:timedOut?null:performance.now()-start};};
  window.benchFrame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  // Settled = layout, MIDI and visible SVG done. A 60s ceiling turns a hung render into a recorded timeout.
  window.benchSettle=start=>new Promise(resolve=>{const check=()=>{const s=window.tabStudio.getState();if(!s.rendering&&s.ready&&window.visibleScoreReady())requestAnimationFrame(()=>resolve(false));else if(performance.now()-start>60000)resolve(true);else requestAnimationFrame(check);};requestAnimationFrame(check);});
 });
 // The large score exceeds the 40MB .tabstudio limit as JSON, so it is opened as Guitar Pro 7.
 for(const [name,tex,format]of [['168x2',fixture168(),'tabstudio'],['600x8',fixture600(),'gp']]){
  if(only&&only!==name)continue;
  const p=project(tex),result={bars:p.bars,tracks:p.tracks,notes:p.notes,wall:{},spans:{}};console.error(`[${name}] ${p.bars} bars, ${p.tracks} tracks, ${p.notes} notes`);
  // Load (foreground parse + first render + MIDI).
  const loadMs=await page.evaluate(async([json,gp,format])=>{const start=performance.now();await window.tabStudio.load('benchmark-'+Math.random().toString(36).slice(2)+'.'+format,format==='gp'?new Uint8Array(gp):new TextEncoder().encode(json));await new Promise(resolve=>{const check=()=>{const s=window.tabStudio.getState();if(s.ready&&!s.rendering&&window.visibleScoreReady())resolve();else requestAnimationFrame(check);};check();});return performance.now()-start;},[format==='gp'?null:p.json,format==='gp'?p.gp:null,format]);
  assert.equal(await page.evaluate(()=>window.tabStudio.getState().bars),p.bars,'benchmark score did not load');
  result.wall.load=stats([loadMs]);result.loadSpans=await page.evaluate(()=>window.tabStudio.perf.summary());
  await page.locator('#tracks .track').nth(1).locator('.track-top input[type=checkbox]').check();await ready();
  await page.evaluate(()=>{window.tabStudio.perf.reset();window.longTasks=[];});
  const select=async(bar,beat=0,note=false)=>{await page.evaluate(([bar,beat,note])=>{if(note)window.tabStudio.selectNote(bar,beat);else window.tabStudio.select(bar,beat);const b=window.tabStudio.getScore().tracks[0].staves[0].bars[bar].voices[0].beats[beat],bb=window.tabStudio.api.boundsLookup.findBeat(b);document.querySelector('#score-scroll').scrollTop=Math.max(0,bb.barBounds.visualBounds.y-100);document.querySelector('#score-scroll').focus();},[bar,beat,note]);await page.waitForFunction(()=>window.visibleScoreReady(),null,{polling:50});};
  const large=name!=='168x2',n=(small,big)=>large?big:small;
  const run=async(key,count,fn)=>{step(key);const samples=[];for(let i=0;i<count;i++){const s=await fn(i);samples.push(s);if(s.settledMs===null){console.error('    timeout in '+key,JSON.stringify(await page.evaluate(()=>{const s=window.tabStudio.getState();return {rendering:s.rendering,ready:s.ready,playing:s.playing,visible:window.visibleScoreReady(),isReady:window.tabStudio.api.isReadyForPlayback};})));await ready().catch(()=>{throw new Error('app did not recover after '+key);});}}result.wall[key]={handler:stats(samples.map(s=>s.handlerMs)),settled:stats(samples.map(s=>s.settledMs))};};
  const mid=Math.floor(p.bars/2);
  // 1. Arrow navigation (selection move).
  await select(mid,0,true);
  await run('arrowMove',n(40,20),()=>page.evaluate(()=>window.benchKey('ArrowRight')));
  // 2. Shift+Arrow range extension.
  await select(mid,0);
  await run('rangeExtend',n(24,12),()=>page.evaluate(()=>window.benchKey('ArrowRight',false,true)));
  await page.evaluate(()=>window.benchKey('Escape'));
  // 3. Local fret entry (digit typed, committed by moving right).
  await select(mid,0,true);
  await run('fretEdit',n(12,6),i=>page.evaluate(async i=>{const start=performance.now();window.tabStudio.paletteAction('inline');const input=document.querySelector('#inline-fret');input.value=String(10+i%5);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',bubbles:true,cancelable:true}));const handlerMs=performance.now()-start;const timedOut=await window.benchSettle(start);return {handlerMs,settledMs:timedOut?null:performance.now()-start};},i));
  await page.keyboard.press('Escape');await ready();
  // 4. Intra-bar structural edits (generic commit path today): duration, dot, bend.
  const palette=async(id,count,bar)=>{await select(bar,1,true);await run(typeof id==='function'?'duration':id,count,i=>page.evaluate(async id=>{const start=performance.now();window.tabStudio.paletteAction(id);const handlerMs=performance.now()-start;const timedOut=await window.benchSettle(start);return {handlerMs,settledMs:timedOut?null:performance.now()-start};},typeof id==='function'?id(i):id));};
  await palette(i=>i%2?'duration8':'duration16',n(10,5),mid+2);
  await palette('dotted',n(10,5),mid+4);
  await palette('bend',n(10,5),mid+6);
  // 5. Undo / redo.
  await select(mid,0,true);
  await run('undo',n(10,5),()=>page.evaluate(()=>window.benchKey('z',true)));
  await run('redo',n(10,5),()=>page.evaluate(()=>window.benchKey('y',true)));
  // 6. Recovery autosave (debounced 700ms after the last edit).
  await page.waitForTimeout(2500);
  // 7. MIDI regeneration.
  const midi=[];for(let i=0;i<4;i++)midi.push(await page.evaluate(()=>new Promise(resolve=>{const start=performance.now();document.querySelector('#score').addEventListener('alphaTab.midiFileLoaded',()=>resolve(performance.now()-start),{once:true});window.tabStudio.api.loadMidiForScore();})));
  step('midiReload');result.wall.midiReload=stats(midi);
  result.spans=await page.evaluate(()=>window.tabStudio.perf.summary());
  step('playback');await page.evaluate(()=>window.tabStudio.perf.reset());
  // 8. Playback: rAF frame gaps with the follower active, plus audio underruns.
  await select(mid,0);
  const playback=await page.evaluate(async()=>{const frames=[];let last=0,running=true;const loop=t=>{if(last)frames.push(t-last);last=t;if(running)requestAnimationFrame(loop);};
   const before=window.longTasks.length;window.tabStudio.mixerAudio.underrunFrames=0;document.querySelector('#play').click();
   await new Promise(r=>{const check=()=>window.tabStudio.getState().playing?r():setTimeout(check,20);check();});requestAnimationFrame(loop);await new Promise(r=>setTimeout(r,5000));running=false;
   const underrun=window.tabStudio.mixerAudio.underrunFrames;document.querySelector('#play').click();await new Promise(r=>{const check=()=>!window.tabStudio.getState().playing?r():setTimeout(check,20);check();});
   return {frames,underrunFrames:underrun,longTasks:window.longTasks.slice(before)};});
  result.wall.playbackFrame=stats(playback.frames);result.playback={underrunFrames:playback.underrunFrames,longTasks:playback.longTasks.length,maxLongTask:Math.max(0,...playback.longTasks)};
  // 9. Playback while the main thread is blocked for 1s out of every 1.3s (a stand-in for heavy UI work).
  result.playbackSpans=await page.evaluate(()=>window.tabStudio.perf.summary());
  step('playbackStress');
  result.playbackStress=await page.evaluate(async()=>{window.tabStudio.perf.reset();window.tabStudio.mixerAudio.underrunFrames=0;document.querySelector('#play').click();
   await new Promise(r=>{const check=()=>window.tabStudio.getState().playing?r():setTimeout(check,20);check();});await new Promise(r=>setTimeout(r,1500));
   const until=performance.now()+6500;while(performance.now()<until){const end=performance.now()+1000;while(performance.now()<end){}await new Promise(r=>setTimeout(r,300));}
   const underrunFrames=window.tabStudio.mixerAudio.underrunFrames,packets=window.tabStudio.perf.summary()['audio.packet'];document.querySelector('#play').click();
   await new Promise(r=>{const check=()=>!window.tabStudio.getState().playing?r():setTimeout(check,20);check();});
   return {underrunFrames,mainThreadPacketMs:packets?{count:packets.count,total:+packets.total.toFixed(1)}:null};});
  // The incrementally patched edit snapshot must still equal a fresh serialization.
  result.snapshotConsistent=await page.evaluate(()=>window.tabStudio.verifySnapshot?.()??null);
  for(const value of Object.values(result.spans))for(const k of ['median','p95','max','total'])value[k]=+value[k].toFixed(2);
  const longTasks=await page.evaluate(()=>window.longTasks);result.longTasks={count:longTasks.length,...stats(longTasks)};
  result.dom={svgNodes:await page.evaluate(()=>document.querySelectorAll('#score svg *').length)};
  report.fixtures[name]=result;console.error(JSON.stringify(result.wall));await fs.writeFile(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 }
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,1));console.error('report: '+path.join(folder,'report.json'));
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
