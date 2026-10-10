import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as at from '@coderline/alphatab';
import {settings} from '../src/score';
import {EditSnapshot,normalizeEdit,plain,editData,restoreScore} from '../src/edit-snapshot';
import {loadCore,Core} from '../src/core';
import {snapshotOps} from '../src/core/sync';

await loadCore(fs.readFileSync(new URL('../src/core/wasm/tabstudio_core_bg.wasm',import.meta.url)));
const song=()=>at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 0.6 1.6 2.6 3.6 | 5.6 7.6 8.6 r | 0.5 2.5 3.5 2.5 | 3.4 5.4 r r`,settings);
const json=(v:unknown)=>JSON.parse(JSON.stringify(v));

test('a beat edit becomes one measure replacement and the core matches the snapshot', ()=>{
 const score=song(),snapshot=new EditSnapshot(),prev=snapshot.get(score),core=Core.fromData(plain(prev));
 const beat=score.tracks[0].staves[0].bars[2].voices[0].beats[1];beat.notes[0].fret=9;beat.finish(settings);snapshot.patchBeat(score,beat);
 const ops=snapshotOps(prev,snapshot.get(score));
 assert.deepEqual(ops.map(o=>o.op),['replace']);assert.deepEqual((ops[0] as {at:unknown}).at,{track:0,staff:0});
 core.edit('fret',ops);
 assert.deepEqual(core.data(),json(plain(snapshot.get(score))));
 core.free();
});

test('track header changes become field sets; nothing changed means no ops', ()=>{
 const score=song(),snapshot=new EditSnapshot(),prev=snapshot.get(score),core=Core.fromData(plain(prev));
 assert.deepEqual(snapshotOps(prev,snapshot.get(score)),[]);
 score.tracks[0].name='Lead';snapshot.patchTracks(score);
 const ops=snapshotOps(prev,snapshot.get(score));
 assert.ok(ops.length>=1&&ops.every(o=>o.op==='set'));assert.ok(ops.some(o=>o.op==='set'&&o.key==='name'&&o.value==='Lead'));
 core.edit('rename',ops);assert.deepEqual(core.data(),json(plain(snapshot.get(score))));
 core.free();
});

test('a whole-song normalize shares unchanged measures, so only the changed one is sent', ()=>{
 const score=song(),snapshot=new EditSnapshot(),prev=snapshot.get(score),core=Core.fromData(plain(prev));
 score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].fret=12;
 const normalized=normalizeEdit(score);snapshot.set(normalized.score,normalized.data);
 const ops=snapshotOps(prev,snapshot.get(normalized.score));
 assert.ok(ops.filter(o=>o.op==='replace').length<=2,`few measures sent: ${ops.length} ops`);
 core.edit('normalize',ops);assert.deepEqual(core.data(),json(plain(snapshot.get(normalized.score))));
 core.free();
});

test('measures removed or inserted become removes/inserts of just those measures, undoably', ()=>{
 const score=song(),snapshot=new EditSnapshot(),prev=snapshot.get(score),core=Core.fromData(plain(prev));
 // As the app deletes measures: the same song without measures 2-3 (ids kept).
 const data=editData(score);data.masterbars.splice(1,2);data.tracks[0].staves[0].bars.splice(1,2);
 const next=restoreScore(data);snapshot.set(next,new EditSnapshot().get(next),true);
 const ops=snapshotOps(prev,snapshot.get(next));
 assert.ok(!ops.some(o=>o.op==='replaceScore'),ops.map(o=>o.op).join());
 assert.equal(ops.filter(o=>o.op==='remove'&&o.list==='bars').length,2,'just the two measures of the staff');
 const changes=core.edit('cut',ops);assert.equal(changes.structure,true);assert.equal(core.data().masterbars.length,2);
 assert.deepEqual(core.data(),json(plain(snapshot.get(next))));
 core.undo();assert.deepEqual(core.data(),json(plain(prev)));
 core.free();
});

test('a different number of tracks replaces the whole score', ()=>{
 const score=song(),snapshot=new EditSnapshot(),prev=snapshot.get(score);
 const two=at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 0.6 1.6 2.6 3.6
\track "B" \tuning E4 B3 G3 D3 A2 E2
:4 0.5 r r r`,settings);
 assert.deepEqual(snapshotOps(prev,new EditSnapshot().get(two)).map(o=>o.op),['replaceScore']);
});
