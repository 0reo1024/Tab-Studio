import test from 'node:test';
import assert from 'node:assert/strict';
import {newScore} from '../src/start-screen';
import {threeBendPoints} from '../src/techniques';
import {defaultSettings,readSettings,shortcutCommand} from '../src/app-settings';

test('startup defaults to the home screen; the new preference persists independently of legacy reopening',()=>{
 assert.equal(defaultSettings().startup,'home');
 assert.equal(readSettings('{"reopenLast":true}').startup,'home');
 const s={...defaultSettings(),startup:'last'};assert.equal(readSettings(JSON.stringify(s)).startup,'last');
 assert.equal(readSettings('{"startup":"broken"}').startup,'home');
 assert.equal(shortcutCommand(defaultSettings().shortcuts,'Ctrl+B'),'techniqueDetails');
});
test('new score creates the chosen instrument and tempo without embedding the title into notation source',()=>{
 for(const [instrument,strings,staves]of [['guitar',6,1],['guitar7',7,1],['bass',4,1],['bass5',5,1],['keyboard',0,2],['drums',0,1]] as const){
  const s=newScore({title:'曲 "test" \\track danger',tempo:137,instrument});assert.equal(s.title,'曲 "test" \\track danger');assert.equal(s.tempo,137);assert.equal(s.tracks.length,1);assert.equal(s.tracks[0].staves.length,staves);assert.equal(s.tracks[0].staves[0].tuning.length,strings);assert.equal(s.masterBars.length,4);assert.equal(s.tracks[0].isPercussion,instrument==='drums');assert.ok(s.tracks[0].staves.every(st=>st.bars.every(bar=>bar.voices.every(v=>v.beats.every(b=>b.isRest)))));
 }
 assert.throws(()=>newScore({title:'',tempo:10,instrument:'guitar'}));assert.throws(()=>newScore({title:'',tempo:120.5,instrument:'guitar'}));
 assert.equal(newScore({title:' ',tempo:120,instrument:'guitar'}).title,'Untitled');
});
test('bend editor samples three points and never mutates imported curves',()=>{
 const two=[{offset:0,value:0},{offset:60,value:4}],before=structuredClone(two);assert.deepEqual(threeBendPoints(two),[{offset:0,value:0},{offset:30,value:2},{offset:60,value:4}]);assert.deepEqual(two,before);
 const points=[{offset:0,value:0},{offset:15,value:2},{offset:30,value:4},{offset:45,value:2},{offset:60,value:0}];assert.deepEqual(threeBendPoints(points),[{offset:0,value:0},{offset:30,value:4},{offset:60,value:0}]);assert.equal(threeBendPoints([]).length,3);
});
