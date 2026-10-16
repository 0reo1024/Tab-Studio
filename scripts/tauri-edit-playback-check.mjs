// Playback right after edits, in the Tauri release build on the native engine (muted output):
// edit -> play (waiting for the app, and at once), quick successive edits -> play, editing
// while playing (refused) and pause -> edit -> resume, edit -> seek -> play, and tracks added,
// deleted (NAM follows its track) and restored. The engine's own status is the evidence: its
// position and per-track meters while the edited bars play.
// Usage: TAURI_PROFILE=release node --import tsx scripts/tauri-edit-playback-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';
import {project} from '../src/score.ts';
import {trackAudio} from '../src/mixer-state.ts';

const folder=path.resolve(`test-results/edit-playback-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(30000);const logs=[];page.on('console',m=>{if(m.type()==='error')logs.push(m.text().slice(0,300));});
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading&&!document.querySelector('#play').disabled;},{},{timeout:60000}).catch(async e=>{console.log('NOT READY',JSON.stringify(await page.evaluate(()=>{const s=window.tabStudio.getState();return {ready:s.ready,rendering:s.rendering,loading:s.loading,play:document.querySelector('#play').disabled,playClass:document.querySelector('#play').className,notice:document.querySelector('#notice')?.textContent,tracks:s.tracks};})));throw e;});
const state=()=>page.evaluate(()=>window.tabStudio.getState());
const notice=()=>page.evaluate(()=>document.querySelector('#notice')?.textContent??'');
const frets=(track=0)=>page.evaluate(track=>window.tabStudio.getScore().tracks[track].staves[0].bars.map(b=>b.voices[0].beats.map(x=>x.notes.length?x.notes.map(n=>n.fret).join('+'):'-').join(' ')),track);
// 120 bpm 4/4: bar n (0-based) plays from 2n to 2n+2 seconds.
const BAR=2;
/** Opens a menu item; a menu that closed again (a redraw right after loading) is reopened. */
async function menu(root,item){for(let attempt=0;;attempt++){await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:new RegExp('^'+root+'$')})}).locator(':scope>button').click();try{await page.getByRole('menuitem',{name:item,exact:true}).click({timeout:3000});return;}catch(e){if(attempt>=3)throw new Error(`menu ${root} > ${item}: ${e.message}`);await page.keyboard.press('Escape');}}}
/** Engine status every 30 ms until `until` seconds of song time (or `ms` of wall time). */
async function sample({until,ms=8000}){return page.evaluate(async({until,ms})=>{const out=[],t0=performance.now();while(performance.now()-t0<ms){const s=await window.__TAURI_INTERNALS__.invoke('audio_status');out.push({position:s.position,playing:s.playing,peaks:[...s.peaks]});if(s.position>=until)break;await new Promise(r=>setTimeout(r,30));}return out;},{until,ms});}
const peakIn=(samples,track,from,to)=>Math.max(0,...samples.filter(s=>s.position>=from&&s.position<to).map(s=>s.peaks[track]??0));
/** Waits for playback to start; a timeout names the step and what the app showed. */
async function started(step){await page.waitForFunction(()=>window.tabStudio.getState().playing,{},{timeout:30000}).catch(async e=>{throw new Error(`${step}: playback did not start (${JSON.stringify(await page.evaluate(()=>({play:document.querySelector('#play').textContent,disabled:document.querySelector('#play').disabled,notice:document.querySelector('#notice')?.textContent,state:window.tabStudio.getState().rendering})))})`);});}
async function pause(step='pause'){if((await state()).playing){await page.locator('#play').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing,{},{timeout:15000}).catch(e=>{throw new Error(`${step}: still playing (${e.message})`);});}}
/** Puts the cursor on a bar (a click on its first beat seeks there) and plays. */
async function playFrom(bar,{wait=true,track=0}={}){
 if(wait)await ready();
 await page.evaluate(([bar,track])=>window.tabStudio.select(bar,0,track),[bar,track]);
 await page.locator('#play').click();await started('wait 2');
}
async function loadScore(tex,setup){
 const score=at.importer.ScoreLoader.loadAlphaTex(tex,new at.Settings());setup?.(score);
 await page.evaluate(p=>window.tabStudio.load('Edit playback.tabstudio',new TextEncoder().encode(p)),project(score,'Edit playback',[]));await ready();
}
/** Types a fret on the selected beat's string (Enter, digits, Enter). */
async function typeFret(bar,beat,fret,track=0){await page.evaluate(([bar,beat,track])=>window.tabStudio.selectNote(bar,beat,track),[bar,beat,track]);await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill(String(fret),{timeout:15000}).catch(async e=>{throw new Error(`typeFret ${bar}:${beat}: the fret editor did not open (${JSON.stringify(await state().then(s=>({playing:s.playing,selected:s.selected})))})`);});await page.keyboard.press('Enter');}
const results=[];const check=(ok,label,detail,samples)=>{results.push({ok,label,detail,samples:ok?undefined:samples});console.log(ok?'OK  ':'FAIL',label,detail??'');};
const SILENT=.002,SOUND=.01;
try{
 await page.locator('#start-demo').click();await ready();
 const tex='\\title "Edit playback" \\tempo 120 \\track "Guitar" \\staff {tabs} . :4 5.6 7.6 5.5 7.5 | 5.6 7.6 5.5 7.5 | r r r r | 5.6 7.6 5.5 7.5 | 5.6 7.6 5.5 7.5';
 await loadScore(tex);
 // A. Edit -> play, waiting for the app: bar 2 cleared plays silent, a note typed into the
 // empty bar 3 sounds.
 await page.evaluate(()=>window.tabStudio.select(1,0));await page.locator('#score-scroll').focus();
 await menu('編集','小節の範囲選択…');await page.locator('#range-start').fill('2');await page.locator('#range-end').fill('2');await page.locator('#range-apply').click();
 await page.keyboard.press('Control+Delete');await ready();
 assert.equal((await frets())[1],'-','bar 2 cleared');
 await playFrom(1);let s=await sample({until:BAR*2+.2});await pause();
 check(peakIn(s,0,BAR+.15,BAR*2-.05)<SILENT,'A1 cleared bar plays silent',peakIn(s,0,BAR+.15,BAR*2-.05),s);
 await typeFret(2,0,3);await ready();
 await playFrom(2);s=await sample({until:BAR*2+.8});await pause();
 check(peakIn(s,0,BAR*2,BAR*2+.8)>SOUND,'A2 note typed into a rest sounds',peakIn(s,0,BAR*2,BAR*2+.8));
 // B. Edit -> play at once (Space right after Enter), and two quick edits -> play.
 await typeFret(2,1,5);await page.keyboard.press('Space');await started('wait 3');
 s=await sample({until:BAR*2+1.2,ms:10000});await pause();
 const startAt=s.find(x=>x.playing)?.position??-1;
 check(Math.abs(startAt-(BAR*2+.5))<.25,'B1 play right after an edit starts at the edited beat',startAt);
 check(peakIn(s,0,BAR*2+.5,BAR*2+1)>SOUND,'B1 the just-typed note sounds',peakIn(s,0,BAR*2+.5,BAR*2+1));
 await page.evaluate(()=>window.tabStudio.select(3,0));await page.locator('#score-scroll').focus();
 await menu('編集','小節の範囲選択…');await page.locator('#range-start').fill('4');await page.locator('#range-end').fill('4');await page.locator('#range-apply').click();
 await page.keyboard.press('Control+Delete');await typeFret(4,0,9);await page.keyboard.press('Control+z');
 await page.evaluate(()=>window.tabStudio.select(3,0));await page.locator('#play').click();await started('wait 4');
 s=await sample({until:BAR*4+.6,ms:12000});await pause();
 check(peakIn(s,0,BAR*3+.15,BAR*4-.05)<SILENT,'B2 quick edits -> play: the cleared bar 4 stays silent',peakIn(s,0,BAR*3+.15,BAR*4-.05));
 check(peakIn(s,0,BAR*4,BAR*4+.6)>SOUND,'B2 bar 5 still sounds',peakIn(s,0,BAR*4,BAR*4+.6));
 // B3. A mouse click on Play right after an edit (the fret redraw starting then once
 // disabled the button and the click was dropped): five times in a row.
 for(let i=0;i<5;i++){
  await typeFret(4,1,7+i);await page.evaluate(()=>window.tabStudio.select(4,0));
  const t0=Date.now();await page.locator('#play').click();await started('B3 click '+i);const wait=Date.now()-t0;
  s=await sample({until:BAR*4+.8,ms:5000});await pause();
  check(peakIn(s,0,BAR*4,BAR*4+.8)>SOUND,`B3 click Play right after an edit (${i+1}/5) starts and sounds`,{wait,peak:peakIn(s,0,BAR*4,BAR*4+.8)});
 }
 // C. Editing while playing is refused (the song plays on as it was); pause -> edit -> resume
 // plays the edit.
 // (The note is near the start: selecting it seeks there, so the song cannot end meanwhile.)
 await playFrom(0);await page.waitForTimeout(300);const before=await frets();
 await page.evaluate(()=>window.tabStudio.selectNote(0,1));await page.keyboard.press('Delete');await page.waitForTimeout(200);
 check(JSON.stringify(await frets())===JSON.stringify(before)&&(await state()).playing,'C1 an edit while playing is refused and playback goes on',await notice());
 await pause();await typeFret(0,3,10);
 await page.evaluate(()=>window.tabStudio.select(0,2));await page.locator('#play').click();await started('wait 5');
 s=await sample({until:BAR,ms:6000});await pause();
 const resumed=s.find(x=>x.playing)?.position??-1;
 check(Math.abs(resumed-1)<.2&&peakIn(s,0,1.5,2)>SOUND,'C2 pause -> edit -> play resumes at the cursor with the edit',{resumed,peak:peakIn(s,0,1.5,2)});
 // D. Edit -> seek (a click on bar 4) -> play.
 await typeFret(0,0,8);await ready();
 {const p=await page.evaluate(()=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[3].voices[0].beats[0],bb=window.tabStudio.api.boundsLookup.findBeat(b),r=bb.barBounds.visualBounds,score=document.querySelector('#score').getBoundingClientRect();return {x:score.left+bb.onNotesX,y:score.top+r.y+r.h-4};});
  await page.locator('#score-scroll').evaluate((el,y)=>{el.scrollTop+=y-el.getBoundingClientRect().top-200;},p.y);
  const q=await page.evaluate(()=>{const b=window.tabStudio.getScore().tracks[0].staves[0].bars[3].voices[0].beats[0],bb=window.tabStudio.api.boundsLookup.findBeat(b),r=bb.barBounds.visualBounds,score=document.querySelector('#score').getBoundingClientRect();return {x:score.left+bb.onNotesX,y:score.top+r.y+r.h-4};});
  await page.mouse.click(q.x,q.y);}
 await page.locator('#play').click();await started('wait 6');
 s=await sample({until:BAR*3+.5,ms:6000});await pause();
 const seekStart=s.find(x=>x.playing)?.position??-1;
 check(Math.abs(seekStart-BAR*3)<.2,'D edit -> seek -> play starts at the clicked bar',seekStart);
 // E. Tracks: a bass track with NAM after the guitar; add a track and play; delete the guitar:
 // the bass (now track 1 -> 0) sounds with its NAM; undo brings both back.
 await loadScore('\\title "Tracks" \\tempo 120 \\track "Guitar" \\staff {tabs} . :4 5.6 7.6 5.5 7.5 | 5.6 7.6 5.5 7.5 \\track "Bass" \\staff {tabs} \\tuning G2 D2 A1 E1 \\instrument 33 . :4 3.3 5.3 3.4 5.4 | 3.3 5.3 3.4 5.4',score=>{Object.assign(trackAudio(score.tracks[1]).nam,{enabled:true,preset:'bass-ampeg-svt',model:'bass-ampeg-svt',modelName:'SVT',kind:'bass'});});
 await playFrom(0);s=await sample({until:1.5});await pause();
 check(peakIn(s,0,.1,1.5)>SOUND&&peakIn(s,1,.1,1.5)>SOUND,'E1 guitar and bass (NAM) both sound',[peakIn(s,0,.1,1.5),peakIn(s,1,.1,1.5)]);
 await menu('トラック','トラック追加');await page.getByRole('menuitem',{name:'6弦ギター',exact:true}).click().catch(async()=>{});
 await page.waitForTimeout(300);if(await page.locator('dialog[open]').count())await page.keyboard.press('Escape');
 await ready();const tracks=(await state()).tracks;
 if(tracks===3){await typeFret(0,0,12,2);await ready();await playFrom(0);s=await sample({until:1.2});await pause();
  check(peakIn(s,2,.0,1.2)>SOUND&&peakIn(s,1,.1,1.2)>SOUND,'E2 an added track sounds, the others keep theirs',[0,1,2].map(i=>peakIn(s,i,.1,1.2)));}
 else check(false,'E2 a track was added',tracks);
 await page.evaluate(()=>window.tabStudio.select(0,0,0));await menu('トラック','トラック削除');await ready();
 const names=await page.evaluate(()=>window.tabStudio.getScore().tracks.map(t=>t.name));
 await playFrom(0);s=await sample({until:1.5});await pause();
 check(names[0]==='Bass'&&peakIn(s,0,.1,1.5)>SOUND,'E3 after deleting the guitar the bass plays as track 1',{names,peaks:[0,1].map(i=>peakIn(s,i,.1,1.5))});
 const nam=await page.evaluate(async()=>{const head=new TextEncoder().encode(JSON.stringify({index:0,key:'bass-ampeg-svt'})),body=new Uint8Array(4+head.length);new DataView(body.buffer).setUint32(0,head.length,true);body.set(head,4);return window.__TAURI_INTERNALS__.invoke('audio_nam',body);});
 check(nam?.loaded===false,'E3 the NAM amp moved with the bass track',nam);
 await page.keyboard.press('Control+z');await ready();
 await playFrom(0);s=await sample({until:1.5});await pause();
 check(peakIn(s,0,.1,1.5)>SOUND&&peakIn(s,1,.1,1.5)>SOUND,'E4 undo: guitar and bass sound again',[0,1,2].map(i=>peakIn(s,i,.1,1.5)));
 check(app.errors.length===0&&!logs.some(l=>!/AlphaTab/.test(l)),'no page errors',[...app.errors,...logs]);
 await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(results,null,1));
 const failed=results.filter(r=>!r.ok);
 if(failed.length){console.log('FAILED',failed.length,folder);process.exitCode=1;}else console.log('PASS tauri-edit-playback-check',folder);
}finally{await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(results,null,1));await app.close();}
