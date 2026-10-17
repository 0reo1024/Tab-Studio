// Tauri build, muted: with a count-in, loop playback shows the green bar (beat cursor) at the loop
// start while it counts — when the loop starts and, with "count each loop", every time it repeats.
// Usage: pnpm tauri build --no-bundle && TAURI_PROFILE=release node scripts/tauri-loop-count-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';
const folder=path.resolve(`test-results/loop-count-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(30000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!document.querySelector('#play').disabled;},{},{timeout:60000});
/** Beat cursor x/y on the page and the bar (1-based) whose bounds contain it. */
const cursor=()=>page.evaluate(()=>{const c=document.querySelector('.at-cursor-beat'),r=c.getBoundingClientRect(),s=document.querySelector('#score').getBoundingClientRect(),x=r.left-s.left+1,y=r.top-s.top+r.height/2;
 const bar=window.tabStudio.api.boundsLookup.findBeat?undefined:undefined;
 const hit=window.tabStudio.api.boundsLookup.staffSystems.flatMap(sys=>sys.bars).find(b=>{const v=b.visualBounds;return x>=v.x-1&&x<=v.x+v.w&&y>=v.y-20&&y<=v.y+v.h+20;});
 return {x:Math.round(x),y:Math.round(y),bar:hit?hit.index+1:null,time:document.querySelector('#time').textContent};});
try{
 await page.waitForFunction(()=>!!window.desktop,{},{timeout:30000});
 await page.evaluate(()=>localStorage.setItem('tabstudio-practice',JSON.stringify({countBars:1,countOnResume:true,countEachLoop:true})));
 await page.reload();await page.waitForLoadState('domcontentloaded');
 await page.locator('#start-demo').click({timeout:30000});await ready();
 // SONG=path LOOP=from-to: a real song instead of the demo (bars 2-3).
 if(process.env.SONG){const bytes=[...await fs.readFile(process.env.SONG)];await page.evaluate(([name,b])=>window.tabStudio.load(name,new Uint8Array(b)),[path.basename(process.env.SONG),bytes]);await ready();}
 const [from,to]=(process.env.LOOP||'2-3').split('-');
 // Loop bars 2-3 with the cursor parked in bar 4.
 await page.evaluate(bar=>window.tabStudio.select(bar,0),Number(to));await page.waitForTimeout(500);
 await page.locator('#loop-from').fill(from);await page.locator('#loop-from').press('Enter');
 await page.locator('#loop-to').fill(to);await page.locator('#loop-to').press('Enter');
 await page.waitForTimeout(300);
 console.log('parked',JSON.stringify(await cursor()));
 // Every frame: the count text and the cursor position (to see when the bar moves).
 await page.evaluate(()=>{window.__frames=[];const t0=performance.now();window.__t0=t0;const tick=()=>{const c=document.querySelector('.at-cursor-beat').getBoundingClientRect();window.__frames.push([Math.round(performance.now()-t0),document.querySelector('#time').textContent,Math.round(c.left),Math.round(c.top)]);if(window.__frames.length<2000)requestAnimationFrame(tick);};tick();});
 await page.locator('#loop-play').click();
 await page.waitForFunction(()=>/カウント/.test(document.querySelector('#time').textContent),{},{timeout:10000});
 await page.waitForTimeout(150);
 const first=await cursor();console.log('first count-in',JSON.stringify(first));
 // ...and on screen while it counts (the view scrolls there before the song starts).
 await page.waitForTimeout(700);
 const visible=await page.evaluate(()=>{const c=document.querySelector('.at-cursor-beat').getBoundingClientRect(),v=document.querySelector('#score-scroll').getBoundingClientRect();return {counting:/カウント/.test(document.querySelector('#time').textContent),inView:c.top>=v.top&&c.bottom<=v.bottom};});
 console.log('during count-in',JSON.stringify(visible));assert.ok(visible.counting&&visible.inView,'loop start visible during the count-in');
 await page.screenshot({path:path.join(folder,'first-count.png')});
 // Wait for the loop to end and the next count-in.
 await page.waitForFunction(()=>window.tabStudio.getState().playing,{},{timeout:15000});
 // The engine counts the repeat itself: from playing straight to counting at the wrap, never
 // stopped in between (the app does not pause, seek and restart any more).
 const states=page.evaluate(async()=>{const seen=[];const invoke=window.__TAURI_INTERNALS__.invoke,t0=window.__t0;let wraps=-1;
  while(performance.now()-t0<30000){const s=await invoke('audio_status');if(wraps<0)wraps=s.wraps;const key=s.playing?'playing':s.counting?'counting':'stopped';if(seen.at(-1)?.key!==key||s.wraps!==seen.at(-1)?.wraps)seen.push({key,wraps:s.wraps,t:Math.round(performance.now()-t0)});if(s.wraps>wraps&&seen.filter(x=>x.key==='playing').length>=2)break;}
  return seen;});
 await page.waitForFunction(()=>/カウント/.test(document.querySelector('#time').textContent),{},{timeout:30000});
 await page.waitForTimeout(150);
 const again=await cursor();console.log('repeat count-in',JSON.stringify(again));
 const engine=await states;console.log('engine at the wrap',JSON.stringify(engine));
 const wrapAt=engine.findIndex(x=>x.key==='counting');
 assert.ok(wrapAt>0&&engine[wrapAt-1].key==='playing'&&!engine.some(x=>x.key==='stopped'),'the engine went from playing straight into the count');
 await page.screenshot({path:path.join(folder,'repeat-count.png')});
 await page.waitForTimeout(1500);
 const frames=await page.evaluate(()=>window.__frames);
 // Frames counting in whose cursor is not where the first counting frame's next stable value is.
 // Only count-state changes and cursor jumps (not the smooth movement while playing).
 const changes=[];let last=null;for(const f of frames){if(!last||/カウント/.test(f[1])!==/カウント/.test(last[1])||Math.abs(f[2]-last[2])>15||f[3]!==last[3])changes.push(f);last=f;}
 console.log('changes',JSON.stringify(changes.slice(0,8)));
 // The second count (the repeat): the cursor waits at the loop start, it does not creep on
 // (allowing the first 50 ms: the display can switch a frame before the cursor jumps back).
 const runs=[];for(const f of frames){const counting=/カウント/.test(f[1]);if(counting&&(!runs.length||runs.at(-1).end!==null))runs.push({xs:new Set(),end:null,start:f[0]});if(counting){if(f[0]-runs.at(-1).start>50)runs.at(-1).xs.add(f[2]);}else if(runs.length&&runs.at(-1).end===null)runs.at(-1).end=f[0];}
 const texts=[];for(const f of frames)if(texts.at(-1)?.[1]!==f[1]&&/カウント/.test(f[1]+(texts.at(-1)?.[1]??'')))texts.push([f[0],f[1]]);
 console.log('count display (ms on the engine clock above)',JSON.stringify(texts));
 // Each count shows every number, from 4 down (beats in this 4/4 demo bar).
 const counts=texts.map(t=>t[1]).join(',').split(/,(?!カウント)[^,]*,?/).map(run=>run.split(',').filter(t=>/カウント/.test(t)).join(' ')).filter(Boolean);
 console.log('counts shown',JSON.stringify(counts));if(!process.env.SONG)assert.ok(counts.length>=2&&counts.slice(0,2).every(c=>c==='カウント 4 カウント 3 カウント 2 カウント 1'),'every count number shows');
 console.log('cursor x during each count',JSON.stringify(runs.map(r=>[...r.xs])));
 assert.ok(runs.length>=2&&runs[1].xs.size===1,'the cursor stays put during the loop count');
 // Play during a loop count stops it.
 await page.waitForFunction(()=>/カウント/.test(document.querySelector('#time').textContent),{},{timeout:30000});
 await page.locator('#play').click();
 await page.waitForFunction(async()=>{const s=await window.__TAURI_INTERNALS__.invoke('audio_status');return !s.playing&&!s.counting&&!window.tabStudio.getState().playing;},{},{timeout:5000});
 assert.equal(first.bar,Number(from),'cursor at the loop start when the count-in starts');
 assert.equal(again.bar,Number(from),'cursor back at the loop start for each loop count-in');
 assert.deepEqual(app.errors,[]);
 console.log('PASS tauri-loop-count-check',folder);
}finally{await app.close();}
