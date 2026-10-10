// Edit-to-screen time on real songs (render speed work). For each file: open it, then near
// the start, middle and end of track 1 make a bend, a duration change and a fret entry,
// undoing each, with the edited bar on screen, and time until the score is laid out again
// (postRenderFinished) and until every system in view shows the new layout ("on screen";
// 'stale' when one still does not after 2 s). Checks the view
// against the snapshot and each merge of partial note bounds against the whole lookup. A time of null means the action changed nothing (nothing was redrawn within 5 s).
// With CHECK=1 the bounds checks run (they slow the redraws, so times are measured without).
// DETAIL=1 prints what the layout worker did for each edit.
// VISIBLE=1 shows the window (a hidden one checks visibility less often, so systems are drawn later).
// Usage: [CHECK=1] [DETAIL=1] [VISIBLE=1] node scripts/render-songs.mjs file1 [file2 ...]
import {_electron as electron} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const files=process.argv.slice(2),check=process.env.CHECK==='1';
const folder=path.resolve('test-results/render-songs-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,...(process.env.VISIBLE==='1'?{}:{TAB_STUDIO_TEST:'1'}),TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}});
const rows=[];let failed=false;
try{
 const page=await app.firstWindow();page.setDefaultTimeout(120000);
 await page.locator('#start-demo').click({timeout:30000});
 const settled=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;});
 await settled();
 await page.evaluate(()=>{const api=window.tabStudio.api;window.renderDone=0;api.postRenderFinished.on(()=>window.renderDone++);
  // What the layout worker did for the last render (systems kept, first bar sent, when it finished).
  const t=window.workerInfo={};api.renderer.instance._worker.addEventListener('message',e=>{const d=e.data;if(d?.cmd==='alphaTab.renderFinished')t.finished=performance.now();if(d?.cmd==='alphaTab.postRenderFinished'){t.reused=d.studioReused;t.from=d.studioFrom;t.posted=performance.now();}});
  api.renderer.partialRenderFinished.on(()=>(t.paints??=[]).push(performance.now()));
  window.longTasks=[];new PerformanceObserver(list=>{for(const e of list.getEntries())window.longTasks.push([e.startTime,e.duration]);}).observe({type:'longtask'});
  const r=api.renderer.instance,rs=r.renderScore.bind(r);r.renderScore=(...a)=>{t.called=performance.now();t.partial=r._studioBoundsScore===a[0]&&!!r.boundsLookup;t.hint=a[2]?.firstChangedMasterBar;t.sameScore=a[0]===window.lastRenderedScore;window.lastRenderedScore=a[0];return rs(...a);};});
 /** Runs fn in the page and waits for the redraw it causes; returns ms. */
 const timed=async(fn,arg)=>page.evaluate(async([src,arg])=>{const before=window.renderDone,t0=performance.now();window.workerInfo.paints=[];(0,eval)(src)(arg);
  await new Promise(resolve=>{const check=()=>{const s=window.tabStudio.getState();if(window.renderDone>before&&!s.rendering&&s.ready)resolve();else if(performance.now()-t0>5000)resolve();else setTimeout(check,2);};check();});
  const done=performance.now();
  // On screen: every system in view shows the current layout (alphaTab draws the visible ones
  // after layout); checked every 5 ms for up to 2 s.
  const staleInView=()=>{const view=document.querySelector('#score-scroll').getBoundingClientRect();return [...document.querySelector('#score .at-surface').children].filter(p=>{const r=p.getBoundingClientRect();return r.bottom>view.top&&r.top<view.bottom&&r.height>0&&p.renderedResultId!==p.layoutResultId;}).length;};
  while(staleInView()&&performance.now()-done<2000)await new Promise(r=>setTimeout(r,5));
  window.lastScreen=staleInView()?null:performance.now()-t0;
  const busy=window.longTasks.filter(([st])=>st>=t0).map(([st,d])=>`${(st-t0).toFixed(0)}+${d.toFixed(0)}`).join(','),spans=performance.getEntriesByType('measure').filter(e=>e.startTime>=t0&&e.duration>=5).map(e=>`${e.name}@${(e.startTime-t0).toFixed(0)}+${e.duration.toFixed(0)}`).join(',');
  const w=window.workerInfo;const stale=staleInView();
  window.lastDetail=`check ${JSON.stringify(window.tabStudio.api.renderer.instance.studioBoundsChecks?.at(-1))?.slice(0,140)}, stale on screen ${stale}, long tasks [${busy}] spans [${spans}] call ${(w.called-t0).toFixed(0)} paints ${w.paints.length}  layout ${(w.finished-t0).toFixed(0)} bounds ${(w.posted-w.finished).toFixed(0)} kept ${w.reused??0} from ${w.from??'-'} (hint ${w.hint}, same score ${w.sameScore}, partial asked ${w.partial})`;
  return window.renderDone>before?+(done-t0).toFixed(1):null;},[fn.toString(),arg]);
 for(const file of files){
  const name=path.basename(file);
  await page.evaluate(([n,b])=>window.tabStudio.load(n,new Uint8Array(b)),[name,[...fs.readFileSync(file)]]);await settled();await page.waitForTimeout(2500);
  if(check)await page.evaluate(()=>{const r=window.tabStudio.api.renderer.instance;r.studioCheckBounds=true;r.studioBoundsChecks=[];});
  const info=await page.evaluate(()=>{const s=window.tabStudio.getScore();const bars=s.tracks[0].staves[0].bars;const withNote=bars.flatMap((b,i)=>b.voices[0].beats.some(x=>x.notes.length)?[i]:[]);return {bars:s.masterBars.length,tracks:s.tracks.length,withNote};});
  const pick=f=>info.withNote[Math.min(info.withNote.length-1,Math.floor(f*(info.withNote.length-1)))];
  const times={bend:[],duration:[],fret:[],undo:[]},screen={bend:[],duration:[],fret:[]};
  for(const [where,bar] of [['start',pick(0.05)],['middle',pick(0.5)],['end',pick(0.95)]]){
   for(const kind of ['bend','duration','fret']){
    // The edited bar is on screen, as when editing by hand.
    await page.evaluate(bar=>{const m=window.tabStudio.api.boundsLookup.findMasterBarByIndex(bar);document.querySelector('#score-scroll').scrollTo({top:Math.max(0,m.visualBounds.y-150)});},bar);await page.waitForTimeout(400);
    await page.evaluate(bar=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[bar].voices[0].beats.findIndex(x=>x.notes.length);window.tabStudio.selectNote(bar,b);},bar);await settled();
    const ms=await timed(kind=>{if(kind==='fret'){window.tabStudio.paletteAction('inline');const i=document.querySelector('#inline-fret');i.value=String(((window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0]?.fret??0)+3)%15);i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));}else window.tabStudio.paletteAction(kind==='bend'?'bend':'duration8');},kind);
    times[kind].push([where,ms]);screen[kind].push([where,ms===null?null:await page.evaluate(()=>window.lastScreen===null?'stale':+window.lastScreen.toFixed(1))]);await settled();
    const verify=()=>page.evaluate(()=>{try{return window.tabStudio.verifySnapshot();}catch(e){return 'error: '+e.message;}});
    if(process.env.DETAIL==='1')console.log(`  ${name} ${kind} ${where} (bar ${bar}): ${ms} ms, ${await page.evaluate(()=>window.lastDetail)}, snapshot ${await verify()}`);
    times.undo.push([where,await timed(()=>document.getElementById('undo').click())]);await settled();
    if(process.env.DETAIL==='1')console.log(`  ${name} undo ${kind} ${where}: check ${await page.evaluate(()=>JSON.stringify(window.tabStudio.api.renderer.instance.studioBoundsChecks?.length)+" "+JSON.stringify(window.tabStudio.api.renderer.instance.studioBoundsChecks?.at(-1))?.slice(0,60))} ${await page.evaluate(()=>window.lastDetail.replace(/long tasks.*kept/,"kept").slice(0,200))} snapshot ${await page.evaluate(()=>{try{return window.tabStudio.verifySnapshot();}catch(e){return 'error: '+e.message;}})}`);
   }
  }
  const ok=await page.evaluate(()=>window.tabStudio.verifySnapshot());
  // Every partial bounds merge must equal the whole lookup of the same layout (check mode).
  // (Not compared with a later full render: alphaTab's layout keeps spacing state between
  // layouts, so the same score can come out a few pixels different.)
  const checks=await page.evaluate(()=>{const r=window.tabStudio.api.renderer.instance,c=r.studioBoundsChecks??[];r.studioBoundsChecks=[];return c;});
  const same=!check||checks.length>0&&checks.every(c=>c===true);
  for(const c of checks.filter(c=>c!==true).slice(0,3))console.log(`  ${name} merge differs: ${c}`);
  if(ok!==true||!same)failed=true;
  rows.push({name,bars:info.bars,tracks:info.tracks,times,screen,ok:ok===true,same,checks:checks.length});
  console.log(`${name} (${info.bars} bars, ${info.tracks} tracks): on screen ${Object.entries(screen).map(([k,v])=>`${k} ${v.map(([w,ms])=>`${w} ${ms}`).join(' / ')}`).join(' | ')} || layout done ${Object.entries(times).map(([k,v])=>`${k} ${v.map(([w,ms])=>`${w} ${ms}`).join(' / ')}`).join(' | ')} | snapshot ${ok===true} ${check?`bounds merged ${checks.filter(c=>c===true).length}/${checks.length}`:''}`);
 }
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(rows,null,1));
 console.log('report:',path.join(folder,'report.json'));
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
if(failed)process.exitCode=1;
