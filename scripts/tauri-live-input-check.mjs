// Instrument input end to end on the release Tauri build (real device; ASIO when the build
// and the PC have it): settings toggle, input on, NAM amp, a VST3 on a live link, the
// timeline, a take, replay, input off. Files stay in a fresh test profile.
// Usage: node scripts/tauri-live-input-check.mjs [seconds of monitoring] [plugin name]
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {launchTauri} from './tauri-app.mjs';

const seconds=Number(process.argv[2]||20),pluginName=process.argv[3]||'bx_greenscreamer';
// Seconds of history before the take test (over 300: the take reaches a full 5 minutes back).
const folder=path.resolve(`test-results/tauri-live-input-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:path.resolve('src-tauri/target/release/tab-studio.exe'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const page=app.page,results={folder};page.setDefaultTimeout(30000);
const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('live_status'));
const shot=name=>page.locator('#live-input').screenshot({path:path.join(folder,name+'.png')});
async function menu(root,item){await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:new RegExp('^'+root+'$')})}).locator(':scope>button').click();await page.getByRole('menuitem',{name:item,exact:true}).click();}
try{
 await page.locator('#start-demo').click();await page.waitForFunction(()=>window.tabStudio?.getState()?.ready);
 // Settings: the recording switch is shown in the Tauri build and saved.
 await menu('ツール','設定…');await page.locator('#settings-live-recording').check();await page.locator('#settings-apply').click();
 results.setting=await page.evaluate(()=>JSON.parse(localStorage.getItem('tabstudio-settings')).liveRecording);assert.equal(results.setting,true);
 await menu('ツール','楽器入力（録音・練習）…');await page.locator('#live-input[open]').waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('#live-output option').length>1);
 const asio=await page.locator('#live-backend option[value=asio]').isEnabled();results.asio=asio;
 if(asio){await page.locator('#live-backend').selectOption('asio');await page.waitForTimeout(800);await page.locator('#live-buffer').selectOption('128');await page.waitForTimeout(800);}
 await page.locator('#live-toggle').click();
 await page.waitForFunction(()=>document.querySelector('#live-rec')?.textContent.includes('録音中'),null,{timeout:30000});
 let s=await status();results.opened={backend:s.backend,output:s.output,input:s.input,buffer:s.buffer,channels:s.inputChannels,fallback:s.fallback};
 assert.ok(s.enabled&&s.recording);
 // Amp: the first model in the library.
 await page.locator('#live-nam').selectOption({index:1});await page.waitForTimeout(1500);
 // A VST3 on a live link.
 await page.locator('#live-plugin-add').focus();await page.waitForFunction(()=>document.querySelectorAll('#live-plugin-add option').length>1,null,{timeout:60000});
 const value=await page.locator('#live-plugin-add option').filter({hasText:pluginName}).first().getAttribute('value');
 if(value){await page.locator('#live-plugin-add').selectOption(value);await page.waitForFunction(()=>document.querySelector('#live-latency')?.textContent.includes('プラグイン'),null,{timeout:30000});}
 results.plugin=!!value;
 // The score plays for a while during the recording (its positions are marked).
 await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);
 await page.waitForTimeout(6000);await page.locator('#play').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing);
 await page.waitForTimeout(Math.max(0,seconds-6)*1000);
 s=await status();results.monitor={latency:s.latency,drops:s.drops,timeline:s.timeline,inputCallbacks:s.inputCallbacks,label:await page.locator('#live-latency').textContent()};
 assert.ok(s.timeline.end>=(seconds-2)*s.sampleRate,'the recorder keeps the input');
 assert.equal(s.drops.overflows,0);assert.equal(s.drops.recorder,0);
 await shot('monitoring');
 // Round-trip measurement: without a cable (and muted by the test) the click is not heard.
 await page.locator('#live-ping').click();await page.locator('#live-ping',{hasText:'測る'}).click();
 await page.waitForFunction(()=>document.querySelector('#live-note')?.textContent.includes('ケーブル')||/実測/.test(document.querySelector('#live-ping-out')?.textContent??''),null,{timeout:10000});
 results.ping={note:await page.locator('#live-note').textContent(),out:await page.locator('#live-ping-out').textContent()};
 // Select the last 5 s on the timeline and replay it.
 const box=await page.locator('#live-canvas').boundingBox();
 await page.mouse.move(box.x+box.width-40,box.y+60);await page.mouse.down();await page.mouse.move(box.x+box.width-4,box.y+60,{steps:5});await page.mouse.up();
 results.selection=await page.locator('#live-sel').textContent();assert.match(results.selection,/選択/);
 await page.locator('#live-play').click();await page.waitForFunction(()=>window.__TAURI_INTERNALS__.invoke('live_status').then(s=>s.replay!==null));
 await page.locator('#live-stop').click();
 // Replay with the score: select 2 s of the stretch recorded while it played.
 {
  s=await status();const rate=s.sampleRate,end=s.timeline.end;
  const ov=await page.evaluate(([f,t])=>window.__TAURI_INTERNALS__.invoke('live_overview',{from:f,to:t,buckets:100}),[Math.max(0,end-300*rate),end]);
  const marked=ov.marks.filter(m=>m[2]!==null);assert.ok(marked.length>=3,'song positions were marked');
  const from=marked[1][0],to=from+2*rate,expect=marked[1][2];
  const x=f=>box.x+(f-(end-300*rate))/(300*rate)*box.width;
  await page.mouse.move(x(from),box.y+60);await page.mouse.down();await page.mouse.move(x(to),box.y+60,{steps:4});await page.mouse.up();
  await page.locator('#live-song').check();await page.locator('#live-play').click();
  await page.waitForFunction(()=>window.tabStudio.getState().playing,null,{timeout:10000});
  await page.waitForTimeout(400);
  const engine=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));const live=await status();
  results.withSong={expect,engine:engine.position,playing:engine.playing,replay:live.replay,replayFrom:from};
  assert.ok(engine.playing&&live.replay!==null,'score and take play together');
  assert.ok(Math.abs(engine.position-(expect+0.4))<1.0,'the score starts where it was when recorded '+JSON.stringify(results.withSong));
  await page.locator('#live-stop').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing,null,{timeout:10000});
  await page.locator('#live-song').uncheck();
 }
 // A take reaching 30 s back, grown for 2 s.
 await page.locator('#live-back').selectOption(seconds>300?'300':'30');await page.locator('#live-take').click();
 await page.waitForFunction(()=>document.querySelector('#live-take')?.textContent==='保存を終了');await page.waitForTimeout(2000);
 await page.locator('#live-take').click();await page.locator('#live-takes summary').click();
 await page.waitForFunction(()=>document.querySelectorAll('#live-take-list button[data-reveal]').length>0);
 const takes=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('live_takes'));results.take=takes[0];
 const wav=await fs.stat(takes[0].path);results.takeBytes=wav.size;assert.ok(takes[0].seconds>=Math.min(seconds>300?300:30,seconds)-1,'the take reaches back');
 s=await status();results.afterTake={drops:s.drops};assert.equal(s.drops.recorder,0,'the recorder kept up while the take was written');
 const meta=JSON.parse(await fs.readFile(takes[0].path.replace(/\.wav$/,'.json'),'utf8'));results.meta=meta;assert.ok(meta.amp);
 await shot('take');
 await page.locator('#live-toggle').click();await page.waitForFunction(()=>document.querySelector('#live-rec')?.textContent==='入力オフ');
 results.segments=(await fs.readdir(path.join(folder,'data','live','segments'))).length;
 results.errors=app.errors;assert.deepEqual(app.errors,[]);
 console.log('LIVE INPUT',JSON.stringify(results,null,1));
}finally{await fs.writeFile(path.join(folder,'results.json'),JSON.stringify(results,null,1));await app.close();}
