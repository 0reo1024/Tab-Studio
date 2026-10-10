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
