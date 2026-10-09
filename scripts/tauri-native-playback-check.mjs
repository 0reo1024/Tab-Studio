// Tauri build with the "native audio engine" setting on (P2-8c): the app plays through
// the Rust engine and alphaTab follows its clock. Output is muted (TAB_STUDIO_TEST_MUTE).
import assert from 'node:assert/strict';
import path from 'node:path';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';
/** A fresh app with the setting on (the player mode is chosen at startup), on the demo. */
async function open(practice){
 const app=await launchTauri({dataDir:path.resolve(`test-results/tauri-native-${Date.now()}`),env:{TAB_STUDIO_TEST_MUTE:'1'},executable:tauriExecutable(process.env.TAURI_PROFILE||'debug')});
 const {page}=app;const logs=[];page.on('console',m=>{if(m.type()==='error')logs.push(m.text().slice(0,200));});
 await page.waitForFunction(()=>!!window.nativeAudio,{},{timeout:30000});
 await page.evaluate(practice=>{localStorage.setItem('tabstudio-settings',JSON.stringify({nativeAudio:true}));if(practice)localStorage.setItem('tabstudio-practice',JSON.stringify(practice));},practice);
 await page.reload();await page.waitForLoadState('domcontentloaded');
 await page.locator('#start-demo').click({timeout:30000});
 await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering,{},{timeout:60000});
 return {app,page,logs,state:()=>page.evaluate(()=>window.tabStudio.getState())};
}
let {app,page,logs,state}=await open();
try{
 assert.equal(await page.evaluate(()=>window.tabStudio.api.settings.player.playerMode),4,'external media mode');
 const t0=Date.now();await page.locator('#play').click();
 await page.waitForFunction(()=>window.tabStudio.getState().playing,{},{timeout:30000});console.log('play started after',Date.now()-t0,'ms (first time includes engine start)');
 await page.waitForTimeout(1500);let s=await state();
 assert.ok(s.playing&&s.lastTick>1000,'cursor follows the engine: tick '+s.lastTick);
 const peaks=await page.evaluate(()=>window.tabStudio.mixerAudio.peaks());assert.ok(peaks.tracks[0]>0,'meters from the engine '+JSON.stringify(peaks));
 await page.locator('#play').click();await page.waitForTimeout(300);s=await state();const pausedTick=s.lastTick;
 assert.ok(!s.playing,'paused');await page.waitForTimeout(500);assert.equal((await state()).lastTick,pausedTick,'stays paused');
 // Half speed: ticks advance at half the rate.
 await page.locator('#speed').selectOption('0.5');await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);
 const a=(await state()).lastTick;await page.waitForTimeout(1000);const b=(await state()).lastTick;await page.locator('#play').click();
 const perSecond=b-a;console.log('ticks per second at 50%',perSecond);assert.ok(perSecond>700&&perSecond<1150,'110 bpm at 50% ~ 880 ticks/s: '+perSecond);
 await page.locator('#speed').selectOption('1');
 // Loop bar 1 (110 bpm 4/4 = 2.18 s): after 3 s the cursor is back inside bar 1.
 await page.locator('#loop-from').fill('1');await page.locator('#loop-to').fill('1');await page.locator('#loop-to').press('Enter');
 await page.locator('#loop-play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);await page.waitForTimeout(3000);
 s=await state();assert.ok(s.playing&&s.lastTick<3840,'looping inside bar 1: '+s.lastTick);
 await page.locator('#loop-play').click();await page.waitForTimeout(300);
 // Mixer: muting the track in the track list silences it in the engine (meters drop to 0).
 await page.locator('#tracks .track-controls input[type=checkbox]').first().check();
 await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);await page.waitForTimeout(600);
 const muted=await page.evaluate(()=>window.tabStudio.mixerAudio.peaks());assert.equal(muted.tracks[0],0,'muted track is silent '+JSON.stringify(muted));
 await page.locator('#play').click();await page.locator('#tracks .track-controls input[type=checkbox]').first().uncheck();await page.waitForTimeout(300);
 // Play to the end: the song finishes and the player stops by itself.
 await page.evaluate(()=>window.tabStudio.select(3,0));await page.waitForTimeout(200);
 await page.locator('#play').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing,{},{timeout:15000});
 console.log('finished at end, tick',(await state()).lastTick);
 assert.deepEqual(app.errors,[]);assert.deepEqual(logs.filter(l=>!/AlphaTab/.test(l)),[]);
 await app.close();
 // Count-in (practice: 1 bar): engine clicks first, then the song starts.
 ({app,page,logs,state}=await open({countBars:1,countOnResume:true}));
 await page.locator('#play').click();await page.waitForFunction(()=>/カウント/.test(document.querySelector('#time')?.textContent??''),{},{timeout:10000});
 const during=(await state()).lastTick;assert.ok(!(await state()).playing,'not playing during the count');
 await page.waitForFunction(()=>window.tabStudio.getState().playing,{},{timeout:10000});await page.waitForTimeout(800);
 s=await state();assert.ok(s.playing&&s.lastTick>during+500,'song starts after the count: '+s.lastTick);
 assert.deepEqual(app.errors,[]);
 console.log('PASS tauri-native-playback-check');
}finally{await app.close();}
