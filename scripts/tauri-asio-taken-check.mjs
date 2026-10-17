// Another app taking the ASIO driver (Tauri build, real ASIO device): the panel offers only
// the buffers the driver accepts; when a second client opens the driver at another buffer the
// app takes it back once (and says so), lets it go if it is taken again soon (and says how to
// get it back), and "もう一度つなぐ" brings it back. The second client is live_probe at 32.
// Usage: node --import tsx scripts/tauri-asio-taken-check.mjs (needs an ASIO device and
// crates/tabstudio-audio/target/release/examples/live_probe.exe built with --features asio).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import {launchTauri} from './tauri-app.mjs';

const probe=path.resolve('crates/tabstudio-audio/target/release/examples/live_probe.exe');
const folder=path.resolve(`test-results/tauri-asio-taken-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:path.resolve('src-tauri/target/release/tab-studio.exe'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const page=app.page,results={folder};page.setDefaultTimeout(30000);
const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('live_status'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
/** The status once `ok` holds (polled up to 15 s; the app notices a stall after 2 s). */
async function until(ok){let s;for(let i=0;i<60;i++){s=await status();if(ok(s))return s;await wait(250);}return s;}
/** The other app: the probe on the same driver at 32 frames for `seconds`. Resolves with how
 * many seconds of callbacks it got (the driver keeps one of the two clients running, not
 * always the newer one). */
function intruder(seconds){
 const child=spawn(probe,['engine','--asio','--buffer','32','--channel','3','--seconds',String(seconds)],{stdio:['ignore','pipe','ignore']});
 let out='';child.stdout.on('data',d=>out+=d);
 return new Promise(resolve=>child.once('exit',()=>resolve(Number(/captured \d+ frames \(([\d.]+) s\)/.exec(out)?.[1]??0))));
}
/** Opens the driver from the probe until `ok` holds for the app (up to `tries` times). */
async function steal(ok,tries,seconds){
 const runs=[];let s;
 for(let i=0;i<tries;i++){const done=intruder(seconds);s=await until(ok);runs.push({probeSeconds:await done,ok:ok(s)});if(ok(s))break;}
 return {s,runs};
}
/** Opens a menu item (retried: right after startup the menu can open before it is filled in). */
async function menu(root,item){
 for(let i=0;;i++){
  await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:new RegExp('^'+root+'$')})}).locator(':scope>button').click();
  try{await page.getByRole('menuitem',{name:item,exact:true}).click({timeout:5000});return;}catch(e){if(i>=2)throw e;await page.keyboard.press('Escape');await wait(1000);}
 }
}
try{
 await page.locator('#start-demo').click();await page.waitForFunction(()=>window.tabStudio?.getState()?.ready);
 await menu('ツール','楽器入力（録音・練習）…');await page.locator('#live-input[open]').waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('#live-output option').length>1);
 await page.locator('#live-backend').selectOption('asio');await page.waitForTimeout(1500);
 results.buffers=await page.locator('#live-buffer option').evaluateAll(o=>o.map(e=>({value:e.value,disabled:e.disabled})));
 assert.ok(results.buffers.every(b=>Math.log2(Number(b.value))%1===0||b.disabled),'only the sizes the driver accepts (powers of two for Nano Cortex)');
 await page.locator('#live-buffer').selectOption('64');await page.waitForTimeout(1500);
 let s=await status();results.before={backend:s.backend,buffer:s.buffer};assert.equal(s.backend,'asio');
 // 1. Taken once: ours stalls, takes the driver back and says so.
 let took=await steal(s=>!!s.deviceNotice,4,6);s=took.s;results.firstRuns=took.runs;results.first={xruns:s.xruns,inputCallbacks:s.inputCallbacks,backend:s.backend,taken:s.deviceTaken,notice:s.deviceNotice,lost:s.deviceLost,note:await page.locator('#live-note').textContent()};

 // With Nano Cortex the newer client usually stops itself within ~1.5 s and ours goes on; only
 // when ours stops for 2 s does the app take the driver back (and say so).
 results.first.reproduced=!!s.deviceNotice;
 assert.equal(s.backend,'asio');if(s.deviceNotice)assert.match(s.deviceNotice,/別のアプリ/);
 if(!results.first.reproduced){results.second={reproduced:false};}
 // 2. Taken again soon after: ours lets it go and says how to get it back. The driver does not
 // always stop ours for long enough (2 s) to notice: then this step is reported as not reproduced.
 if(results.first.reproduced){took=await steal(s=>s.deviceTaken,3,4);s=took.s;results.secondRuns=took.runs;}
 if(results.first.reproduced)results.second={reproduced:!!s.deviceTaken,backend:s.backend,lost:s.deviceLost,button:await page.locator('#live-reconnect').waitFor({state:'visible',timeout:10000}).then(()=>true,()=>false)};
 if(s.deviceTaken&&!results.second.button){
  const trace=[];for(let i=0;i<15;i++){const t=await status();trace.push({taken:t.deviceTaken,backend:t.backend,hidden:await page.evaluate(()=>document.querySelector('#live-reconnect').hidden),open:await page.locator('#live-input[open]').count()});await wait(200);}
  results.trace=trace;
 }
 if(s.deviceTaken){
  assert.match(s.deviceLost??'',/もう一度つなぐ/);assert.equal(results.second.button,true);
  await page.locator('#live-input').screenshot({path:path.join(folder,'taken.png')});
  await wait(1500);
  // 3. The other app closed: "もう一度つなぐ" brings the driver back. (When the driver was
  // briefly not there while the other app had it, the app comes back by itself once it is.)
  const back=await status();
  results.cameBackByItself=back.backend==='asio'&&!back.deviceTaken;
  if(!results.cameBackByItself)await page.locator('#live-reconnect').click();
 }else{
  await wait(1500);
  await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('live_reconnect'));
 }
 s=await until(s=>s.backend==='asio'&&!s.deviceTaken&&s.deviceLost===null);results.reconnected={backend:s.backend,buffer:s.buffer,taken:s.deviceTaken,lost:s.deviceLost,button:await page.locator('#live-reconnect').isVisible()};
 assert.equal(s.backend,'asio');assert.equal(s.deviceTaken,false);assert.equal(s.deviceLost,null);assert.equal(results.reconnected.button,false);
 console.log('ASIO TAKEN',JSON.stringify(results,null,1));
 console.log('PASS tauri-asio-taken-check');
}finally{console.log('RESULTS',JSON.stringify(results));await app.close();}
