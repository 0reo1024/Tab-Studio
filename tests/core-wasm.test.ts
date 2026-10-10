import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {loadCore,Core} from '../src/core';
import {demoScore} from '../src/score';
import {editData,restoreScore} from '../src/edit-snapshot';

await loadCore(fs.readFileSync(new URL('../src/core/wasm/tabstudio_core_bg.wasm',import.meta.url)));
const plain=(v:unknown)=>JSON.parse(JSON.stringify(v));

test('the core loads the app data unchanged and alphaTab reads its output back', ()=>{
 const data=editData(demoScore()),core=Core.fromData(data);
 assert.deepEqual(core.data(),plain(data));
 // alphaTab rebuilds the same song from the core's JSON.
 assert.deepEqual(plain(editData(restoreScore(core.data()))),plain(data));
 core.free();
});

test('edits are undoable steps that report the bars they touched', ()=>{
 const data=editData(demoScore()),core=Core.fromData(data);
 const at={track:0,staff:0,bar:1,voice:0,beat:0,note:0};
 const changes=core.edit('fret',[{op:'set',at,key:'fret',value:11}]);
 assert.deepEqual(changes,{bars:[[0,0,1]],structure:false,song:false});
 assert.equal(core.node({track:0,staff:0,bar:1}).voices[0].beats[0].notes[0].fret,11);
 assert.ok(core.canUndo);
 assert.deepEqual(core.undo(),{bars:[[0,0,1]],structure:false,song:false});
 assert.deepEqual(core.data(),plain(data));
 assert.equal(core.undo(),undefined,'nothing more to undo');
 core.redo();assert.equal(core.node({track:0,staff:0,bar:1}).voices[0].beats[0].notes[0].fret,11);
 assert.throws(()=>core.edit('bad',[{op:'set',at:{track:9},key:'name',value:'x'}]),/指定した位置/);
 assert.equal(core.node({track:0,staff:0,bar:1}).voices[0].beats[0].notes[0].fret,11,'a failed edit changes nothing');
 core.free();
});

test('structure edits (a bar inserted on every staff) are flagged for a rebuild', ()=>{
 const data=editData(demoScore()),core=Core.fromData(data),bars=core.data().masterbars.length;
 const master=core.node({masterbar:0}),bar=core.node({track:0,staff:0,bar:0});
 const changes=core.edit('insert bar',[{op:'insert',at:{},list:'masterbars',index:1,node:master},{op:'insert',at:{track:0,staff:0},list:'bars',index:1,node:bar}]);
 assert.equal(changes.structure,true);assert.equal(core.data().masterbars.length,bars+1);
 core.undo();assert.deepEqual(core.data(),plain(data));
 core.free();
});

import {applyChanges} from '../src/core/adapter';
import * as at from '@coderline/alphatab';
import {settings} from '../src/score';
/** The comparison verifySnapshot uses: both sides re-read by alphaTab, studio data aside. */
const notation=(data:unknown)=>JSON.parse(JSON.stringify(editData(restoreScore(plain(data))),(k,v)=>k.startsWith('studio')?undefined:v));

test('the adapter swaps edited bars into the live score in place, matching the core', ()=>{
 const score=at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 0.6 1.6 2.6 3.6 | 5.6 7.6 8.6 r | 0.5 2.5 3.5 2.5`,settings);
 const core=Core.fromData(editData(score));
 const changes=core.edit('fret',[{op:'set',at:{track:0,staff:0,bar:1,voice:0,beat:1,note:0},key:'fret',value:12},{op:'set',at:{track:0,staff:0,bar:1,voice:0,beat:0},key:'duration',value:8}]);
 const bar1=score.tracks[0].staves[0].bars[1];
 const result=applyChanges(score,core,changes);
 assert.equal(result.inPlace,true);assert.equal(result.score,score,'same Score object');
 assert.notEqual(score.tracks[0].staves[0].bars[1],bar1,'the measure was replaced');
 assert.equal(score.tracks[0].staves[0].bars[1].voices[0].beats[1].notes[0].fret,12);
 assert.equal(score.tracks[0].staves[0].bars[1].voices[0].beats[0].duration,8);
 assert.equal(score.tracks[0].staves[0].bars[1].previousBar,score.tracks[0].staves[0].bars[0],'links to neighbours');
 assert.deepEqual(notation(editData(score)),notation(core.data()));
 // Undo through the core brings the view back too.
 const undone=applyChanges(score,core,core.undo()!);
 assert.equal(undone.inPlace,true);
 assert.equal(score.tracks[0].staves[0].bars[1].voices[0].beats[1].notes[0].fret,7);
 assert.deepEqual(notation(editData(score)),notation(core.data()));
 core.free();
});

test('linked measures are rebuilt together in place; structure changes rebuild the song', ()=>{
 const score=at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 0.6 1.6 2.6 3.6{h} | 5.6 7.6 8.6 r | 0.5 2.5 3.5 2.5`,settings);
 const core=Core.fromData(editData(score));
 // Bar 0 ends with a hammer-on into bar 1: editing bar 1 rebuilds bars 0-1 together, in place.
 let result=applyChanges(score,core,core.edit('fret',[{op:'set',at:{track:0,staff:0,bar:1,voice:0,beat:0,note:0},key:'fret',value:9}]));
 assert.equal(result.inPlace,true);assert.equal(result.score,score);assert.equal(result.bars,2);
 const bars=score.tracks[0].staves[0].bars;
 assert.equal(bars[1].voices[0].beats[0].notes[0].fret,9);
 assert.equal(bars[0].voices[0].beats[3].notes[0].hammerPullDestination,bars[1].voices[0].beats[0].notes[0],'the hammer-on links into the rebuilt bar');
 assert.equal(bars[2].previousBar,bars[1]);
 assert.equal(bars[2].voices[0].beats[0].previousBeat,bars[1].voices[0].beats.at(-1),'joined to the untouched bar after the range');
 assert.deepEqual(notation(editData(score)),notation(core.data()));
 result=applyChanges(result.score,core,core.edit('insert bar',[{op:'insert',at:{},list:'masterbars',index:2,node:core.node({masterbar:1})},{op:'insert',at:{track:0,staff:0},list:'bars',index:2,node:core.node({track:0,staff:0,bar:1})}]));
 assert.equal(result.inPlace,false);assert.equal(result.score.masterBars.length,4);
 assert.deepEqual(notation(editData(result.score)),notation(core.data()));
 core.free();
});
