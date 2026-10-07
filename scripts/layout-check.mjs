import {_electron as electron} from '@playwright/test';
import * as at from '@coderline/alphatab';
import assert from 'node:assert/strict';
import path from 'node:path';
const dense=':32 '+Array.from({length:32},(_,i)=>`${10+i%8}.1`).join(' '),light=':4 3.1 5.1 7.1 5.1';
const bars=[light,light,dense,dense,light,dense,dense,light];
const score=at.importer.ScoreLoader.loadAlphaTex('\\title "Adaptive spacing" \\tempo 240 \\track "Lead" . '+bars.join(' | ')+' \\track "Rhythm" '+bars.map(()=>':8 0.6 r 2.5 r 0.6 r 3.5 r').join(' | '),new at.Settings());
for(const t of score.tracks){t.defaultSystemsLayout=4;t.systemsLayout=[4,4];}
score.defaultSystemsLayout=4;score.systemsLayout=[4,4];
for(const b of score.tracks[0].staves[0].bars[2].voices[0].beats){if(b.index%4===0)b.notes[0].isHammerPullOrigin=true;if(b.index%8===0)b.notes[0].isPalmMute=true;}
const project=JSON.stringify({format:'TabStudio',version:1,sourceName:score.title,warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.resolve('test-results/layout-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 await page.evaluate(p=>window.tabStudio.load('spacing.tabstudio',new TextEncoder().encode(p)),project);await page.waitForFunction(()=>window.tabStudio.getScore().title==='Adaptive spacing'&&!window.tabStudio.getState().rendering);
 async function metrics(){return page.evaluate(()=>{const a=window.tabStudio.api,s=window.tabStudio.getScore(),beats=s.tracks[0].staves[0].bars[2].voices[0].beats.map(b=>a.boundsLookup.findBeats(b).at(-1));return{rows:a.boundsLookup.staffSystems.map(s=>s.bars.map(m=>m.bars[0].beats[0].beat.voice.bar.index)),gap:Math.min(...beats.slice(1).map((b,i)=>b.onNotesX-beats[i].onNotesX)),width:beats[0].barBounds.visualBounds.w,settings:a.settings.display.barsPerRow};});}
 const automatic=await metrics(),original=await page.evaluate(()=>window.tabStudio.serialize());assert.equal(automatic.settings,-1);assert.ok(automatic.gap>24);assert.ok(automatic.rows.some(r=>r.length<4));
 async function rerender(fixed){await page.evaluate(fixed=>new Promise(resolve=>{const a=window.tabStudio.api,done=()=>{a.postRenderFinished.off(done);resolve();};a.postRenderFinished.on(done);a.settings.display.barsPerRow=fixed?4:-1;a.settings.display.stretchForce=fixed?1:1.35;a.updateSettings();a.renderScore(window.tabStudio.getScore(),[0,1]);}),fixed);}
 await rerender(true);
 const fixed=await metrics();assert.ok(automatic.gap>fixed.gap+8,JSON.stringify({automatic,fixed}));assert.ok(automatic.width>fixed.width*1.5);
 await rerender(false);assert.deepEqual(await metrics(),automatic);
 await page.evaluate(()=>{const a=window.tabStudio.api,s=window.tabStudio.getScore(),bb=a.boundsLookup.findBeats(s.tracks[0].staves[0].bars[2].voices[0].beats[0]).at(-1);document.querySelector('#score-scroll').scrollTop=bb.barBounds.masterBarBounds.staffSystemBounds.realBounds.y;});
 await page.screenshot({path:path.resolve('test-results/adaptive-layout.png')});
 const point=await page.evaluate(()=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[2].voices[0].beats[10],bb=window.tabStudio.api.boundsLookup.findBeats(b).at(-1),r=document.querySelector('#score').getBoundingClientRect(),v=bb.barBounds.visualBounds;return{x:r.x+bb.onNotesX,y:r.y+v.y+v.h,tick:b.voice.bar.masterBar.start+b.playbackStart};});
 await page.mouse.click(point.x,point.y);assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.beat),10);assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),original);assert.equal(await page.evaluate(()=>window.tabStudio.getState().dirty),false);
 await page.locator('#follow').uncheck();await page.keyboard.press('Space');await page.waitForFunction(t=>window.tabStudio.getState().playing&&window.tabStudio.api.tickPosition>t+150,point.tick);
 assert.deepEqual(await metrics(),automatic);await page.keyboard.press('Control+Space');await page.waitForFunction(t=>!window.tabStudio.getState().playing&&Math.abs(window.tabStudio.api.tickPosition-t)<2,point.tick);
 await page.keyboard.press('ArrowDown');assert.ok(await page.evaluate(()=>window.tabStudio.getState().selected.bar>2));await page.keyboard.press('ArrowUp');assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.bar),2);
 await page.locator('#zoomOut').click();await page.waitForFunction(()=>!window.tabStudio.getState().rendering);assert.equal((await metrics()).settings,-1);assert.ok((await metrics()).gap>20);
 assert.deepEqual(errors,[]);console.log('LAYOUT PASSED: adaptive rows / dense fret spacing '+automatic.gap.toFixed(1)+'px vs fixed '+fixed.gap.toFixed(1)+'px / imported layout ignored / click / playback fixed / Ctrl+Space / row arrows / zoom');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
