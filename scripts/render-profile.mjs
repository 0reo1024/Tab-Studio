// Where the time after an edit goes until the score is on screen (render speed study,
// after P3). Loads the perf-benchmark's large song (600 bars x 8 tracks) or SONG=path,
// makes a few edits and times alphaTab's stages from the main thread:
//   edit handler -> renderScore call -> renderStarted (worker began) -> partial layouts /
//   partial renders (chunks) -> renderFinished -> postRenderFinished,
// plus main-thread long tasks and how many chunks / DOM nodes were produced.
// Usage: node scripts/render-profile.mjs [bars]
import {_electron as electron} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import * as at from '@coderline/alphatab';
const bars=Number(process.argv[2]||600);
function fixture(){
 const parts=['\\title "Large benchmark" \\tempo 120'];
 const guitar=b=>`:8 ${(b%5)+3}.1 (${(b%5)+5}.2 ${(b%5)+5}.3) 7.1 5.2 r (3.3 5.4) 7.2 8.1`;
 const lead=b=>`:16 ${b%12}.1 ${(b%12)+2}.1 ${(b%12)+3}.1 ${(b%12)+5}.1 :8 ${(b%12)+7}.2 5.2 :4 7.3 :8 5.3 3.4 :4 5.4`;
 const bass=b=>`:8 ${b%7}.4 ${b%7}.4 ${(b%7)+2}.3 ${(b%7)+2}.3 ${b%7}.4 r 3.3 5.3`;
 for(let t=0;t<8;t++){const kind=t===6||t===7?'bass':t%2?'lead':'guitar';parts.push(`\\track "${kind} ${t+1}"`+(kind==='bass'?' \\tuning G2 D2 A1 E1':'')+' .');parts.push(Array.from({length:bars},(_,b)=>(kind==='bass'?bass:kind==='lead'?lead:guitar)(b)).join(' | '));}
 const score=at.importer.ScoreLoader.loadAlphaTex(parts.join(' '),new at.Settings());
 return new at.exporter.Gp7Exporter().export(score,new at.Settings());
}
const folder=path.resolve('test-results/render-profile-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST:'1',TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(120000);
 await page.locator('#start-demo').click({timeout:30000});
 const settled=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;});
 await settled();
 await page.evaluate(b=>window.tabStudio.load('large.gp',new Uint8Array(b)),[...fixture()]);await settled();
 await page.waitForTimeout(3000);
 // Instrument alphaTab's events and long tasks.
 await page.evaluate(()=>{
  const api=window.tabStudio.api,r=api.renderer.instance??api.renderer,log=window.renderLog=[];const at=label=>log.push([label,performance.now()]);
  api.renderStarted.on(()=>at('renderStarted'));api.renderFinished.on(()=>at('renderFinished'));api.postRenderFinished.on(()=>at('postRenderFinished'));
  r.partialLayoutFinished?.on(()=>at('partialLayout'));r.partialRenderFinished?.on(()=>at('partialRender'));r.preRender?.on(()=>at('preRender'));
  // Messages from the layout worker, with their size class.
  const worker=r._worker;if(worker)worker.addEventListener('message',e=>{const d=e.data;if(d?.cmd&&d.cmd!=='alphaTab.partialLayoutFinished')at('worker:'+d.cmd.replace('alphaTab.','')+(d.studioReused?' reused '+d.studioReused:'')+(d.studioFrom!==undefined?' from '+d.studioFrom:''));});
  const render=api.renderScore.bind(api);api.renderScore=(...a)=>{at('renderScore');return render(...a);};
  window.longTasks=[];new PerformanceObserver(list=>{for(const e of list.getEntries())window.longTasks.push([e.startTime,e.duration]);}).observe({type:'longtask'});
 });
 const edit=async(label,id,bar)=>{
  await page.evaluate(([bar])=>window.tabStudio.selectNote(bar,0),[bar]);await settled();await page.waitForTimeout(500);
  const result=await page.evaluate(async id=>{
   window.renderLog.length=0;window.longTasks.length=0;const t0=performance.now();window.tabStudio.paletteAction(id);const handler=performance.now()-t0;
   await new Promise(resolve=>{const check=()=>{const s=window.tabStudio.getState();if(!s.rendering&&s.ready&&window.renderLog.some(e=>e[0]==='postRenderFinished'))resolve();else setTimeout(check,5);};check();});
   const total=performance.now()-t0,events=window.renderLog.map(([l,t])=>[l,+(t-t0).toFixed(1)]);
   const counts={};for(const [l]of events)counts[l]=(counts[l]??0)+1;
   return {handler:+handler.toFixed(1),total:+total.toFixed(1),first:Object.fromEntries(events.filter((e,i,a)=>a.findIndex(x=>x[0]===e[0])===i)),last:Object.fromEntries([...events].reverse().filter((e,i,a)=>a.findIndex(x=>x[0]===e[0])===i)),counts,longTasks:window.longTasks.map(([s,d])=>[+(s-t0).toFixed(0),+d.toFixed(0)]),svgNodes:document.querySelectorAll('#score svg *').length,chunks:document.querySelectorAll('#score .at-surface > div, #score .at-surface > svg').length};
  },id);
  console.log(`\n${label}:`,JSON.stringify(result));
 };
 // CHECK=1: compare each partial bounds merge with the whole lookup of the same layout.
 if(process.env.CHECK==='1')await page.evaluate(()=>{const r=window.tabStudio.api.renderer.instance;r.studioCheckBounds=true;r.studioBoundsChecks=[];});
 const mid=Math.floor(bars/2);
 await edit('bend (middle)','bend',mid);
 await edit('duration8 (middle)','duration8',mid+2);
 await edit('bend (start)','bend',2);
 await edit('bend (end)','bend',bars-3);
 if(process.env.CHECK==='1')console.log('\nmerge checks:',JSON.stringify(await page.evaluate(()=>window.tabStudio.api.renderer.instance.studioBoundsChecks)));
 // The merged bounds (note positions) must equal what a full render produces.
 // (to 1/1000 px: systems kept by layout are moved by adding dy, which can differ in the last bits)
 const bounds=()=>page.evaluate(()=>JSON.stringify(window.tabStudio.api.renderer.boundsLookup.toJson(),(k,v)=>v instanceof Map?Object.fromEntries(v):v));
 const merged=await bounds();
 await page.evaluate(()=>window.tabStudio.api.render());await settled();await page.waitForTimeout(1000);
 const full=await bounds();
 const out=[];{const walk=(x,y,p)=>{if(out.length>=4)return;if(x&&y&&typeof x==='object'&&typeof y==='object'){for(const k of new Set([...Object.keys(x),...Object.keys(y)]))walk(x[k],y[k],p+'.'+k);return;}if(typeof x==='number'&&typeof y==='number'&&Math.abs(x-y)<=1e-3)return;if(JSON.stringify(x)!==JSON.stringify(y))out.push(`${p}: ${JSON.stringify(x)?.slice(0,40)} vs ${JSON.stringify(y)?.slice(0,40)}`);};walk(JSON.parse(merged),JSON.parse(full),'');if(out.length)console.log('first differences:',out.join(' | '));}
 console.log(`\nbounds after partial merges equal a full render: ${!out.length} (${(merged.length/1e6).toFixed(1)} MB)`);
 if(out.length)process.exitCode=1;
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
