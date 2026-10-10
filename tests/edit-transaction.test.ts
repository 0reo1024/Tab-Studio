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
