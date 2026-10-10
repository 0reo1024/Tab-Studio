import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {settings} from '../src/score';
import {EditSnapshot,type ScoreData} from '../src/edit-snapshot';
import {createEditTransactions,type EditBase} from '../src/app/edit-transaction';

const load=()=>at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 0.6 1.6 2.6 3.6 | 5.6 r r r`,settings);
type State=EditBase&{label:string};
function host(){
 let score=load(),playing=false;const snapshot=new EditSnapshot(),log:string[]=[];
 const h={
  score:()=>score,adopt:(next:at.model.Score)=>{score=next;},playing:()=>playing,
  capture:():State=>({data:snapshot.get(score) as ScoreData,label:'state'}),
  restore:()=>log.push('restore'),message:(t:string)=>log.push('message:'+t),clearMessage:()=>{},status:(t:string)=>log.push('status:'+t),
  markDirty:()=>log.push('dirty'),playbackChanged:()=>log.push('playback'),render:(bar?:number)=>log.push('render:'+bar),
  scheduleFretDraw:(bar:number)=>log.push('fret:'+bar),updateInspector:()=>{},resetLoop:()=>log.push('loop'),snapshot,
 };
 return {h,log,setPlaying:(v:boolean)=>{playing=v;},get score(){return score;}};
}

test('history keeps at most the limit; a new edit clears redo', ()=>{
 const {h}=host(),edits=createEditTransactions<State>(h,3);
 for(let i=0;i<5;i++)edits.record({...h.capture(),label:String(i)});
 assert.deepEqual(edits.undo.map(s=>s.label),['2','3','4']);
 edits.history(true);assert.equal(edits.redo.length,1);
 edits.record({...h.capture(),label:'x'});assert.equal(edits.redo.length,0);
});

test('commits refuse while playing; a structural edit normalizes and becomes one undo step', ()=>{
 const t=host(),edits=createEditTransactions<State>(t.h);
 t.setPlaying(true);
 assert.equal(edits.commit(s=>{s.tracks[0].name='B';},'renamed'),false);
 assert.ok(t.log.includes('message:一時停止してから編集してください。'));
 t.setPlaying(false);const before=t.score;
 assert.equal(edits.commit(s=>{s.tracks[0].name='B';},'renamed',2),true);
 assert.notEqual(t.score,before,'the song was rebuilt');assert.equal(t.score.tracks[0].name,'B');
 assert.equal(edits.undo.length,1);assert.ok(t.log.includes('render:2')&&t.log.includes('status:renamed'));
});

test('a failing edit restores and reports instead of recording', ()=>{
 const t=host(),edits=createEditTransactions<State>(t.h);
 assert.equal(edits.commit(()=>{throw new Error('bad edit');},'never'),false);
 assert.equal(edits.undo.length,0);assert.ok(t.log.includes('restore')&&t.log.includes('message:bad edit'));
});

test('beat edits finish only the edited beats and schedule a redraw from that bar', ()=>{
 const t=host(),edits=createEditTransactions<State>(t.h);
 const beat=t.score.tracks[0].staves[0].bars[1].voices[0].beats[0];
 assert.equal(edits.commitBeats([beat],()=>{beat.notes[0].fret=7;},'fret'),true);
 assert.equal(t.score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].fret,7);
 assert.deepEqual(edits.undo[0].bars,[[0,0,1]]);assert.ok(t.log.includes('fret:1')&&t.log.includes('playback'));
});

import fs from 'node:fs';
import {loadCore} from '../src/core';
import {CoreSession} from '../src/core/session';
await loadCore(fs.readFileSync(new URL('../src/core/wasm/tabstudio_core_bg.wasm',import.meta.url)));

/** A host whose capture() starts and flushes the core session, as main.ts does. */
function coreHost(text:string){
 let score=at.importer.ScoreLoader.loadAlphaTex(text,settings),playing=false;
 const snapshot=new EditSnapshot(),log:string[]=[],session=new CoreSession(e=>log.push('core error:'+String(e)));
 const h={
  score:()=>score,adopt:(next:at.model.Score)=>{score=next;},playing:()=>playing,
  capture:():State=>{const now=snapshot.get(score) as ScoreData;session.ensure(now);session.flush(now);return {data:snapshot.get(score) as ScoreData,label:'state'};},
  restore:(state:State,inPlace?:boolean)=>{if(!inPlace)score=at.model.JsonConverter.jsObjectToScore(state.data as never,settings);snapshot.set(score,state.data,false);},
  message:(t:string)=>log.push('message:'+t),clearMessage:()=>{},status:()=>{},markDirty:(i?:boolean)=>{if(i!==false)snapshot.invalidate();},
  playbackChanged:()=>{},render:()=>{},scheduleFretDraw:()=>{},updateInspector:()=>{},resetLoop:()=>{},snapshot,session:()=>session,
 };
 return {h,log,session,get score(){return score;},snapshot};
}
const frets=(score:at.model.Score)=>score.tracks[0].staves[0].bars.map(b=>b.voices[0].beats.map(x=>x.notes[0]?.fret??-1).join(',')).join('|');

test('with the core: a linked measure is rebuilt with its neighbours in place, and undo/redo go through the core', ()=>{
 const t=coreHost(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 0.6 1.6 2.6 3.6{h} | 5.6 7.6 8.6 r | 0.5 2.5 3.5 2.5`);
 const edits=createEditTransactions<State>(t.h);
 const first=frets(t.score),score=t.score;
 // Bar 1 starts with the hammer-on's destination: not refinishable alone.
 assert.equal(edits.commit(s=>{s.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].fret=9;},'fret',0,score.tracks[0].staves[0].bars[1]),true);
 assert.equal(t.score,score,'patched in place, no whole-song rebuild');
 assert.ok(t.session.active,t.log.join());
 assert.equal(t.score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].fret,9);
 assert.equal(t.score.tracks[0].staves[0].bars[0].voices[0].beats[3].notes[0].hammerPullDestination,t.score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0]);
 const edited=frets(t.score);
 // A second, ordinary edit (recorded, sent at the next capture).
 assert.equal(edits.commitBeats([t.score.tracks[0].staves[0].bars[2].voices[0].beats[0]],()=>{t.score.tracks[0].staves[0].bars[2].voices[0].beats[0].notes[0].fret=4;},'fret'),true);
 const twice=frets(t.score);
 edits.history(true);assert.equal(frets(t.score),edited);
 edits.history(true);assert.equal(frets(t.score),first);
 edits.history(false);assert.equal(frets(t.score),edited);
 edits.history(false);assert.equal(frets(t.score),twice);
 assert.ok(t.session.active&&!t.log.length,t.log.join());
 t.session.free();
});
