import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {loopPlaybackRange} from '../src/playback-range';

const point=(bar:number,beat:number)=>({track:0,staff:0,voice:0,bar,beat});
function sample(tex=':4 1.1 2.1 3.1 4.1 | 5.1 6.1 7.1 8.1 | 9.1 10.1 11.1 12.1'){
  const score=at.importer.ScoreLoader.loadAlphaTex(tex,new at.Settings());
  const timeline=()=>{const file=new at.midi.MidiFile(),generator=new at.midi.MidiFileGenerator(score,new at.Settings(),new at.midi.AlphaSynthMidiFileHandler(file));generator.generate();return generator.tickLookup.masterBars;};
  return {score,timeline};
}
test('measure selection includes the entire last bar, even with an empty voice',()=>{
  const {score,timeline}=sample(':4 1.1 2.1 3.1 4.1 | :1 r | :4 9.1 10.1 11.1 12.1');
  assert.deepEqual(loopPlaybackRange(score,timeline(),{start:2,end:2,enabled:true}),{startTick:3840,endTick:7680});
});
test('a reversed beat selection loops only its beats, across bar boundaries',()=>{
  const {score,timeline}=sample(),beats={anchor:point(1,1),focus:point(0,2)};
  assert.deepEqual(loopPlaybackRange(score,timeline(),{start:1,end:2,enabled:true,beats}),{startTick:1920,endTick:5760});
});
test('partial bar loop includes the full dotted final beat and rests',()=>{
  const {score,timeline}=sample(':8 1.1 r :4 3.1{d} :8 4.1 :4 r');
  assert.deepEqual(loopPlaybackRange(score,timeline(),{start:1,end:1,enabled:true,beats:{anchor:point(0,1),focus:point(0,2)}}),{startTick:480,endTick:2400});
});
test('repeat visits use the first matching end after the start, not an earlier end',()=>{
  const {score,timeline}=sample();score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.rebuildRepeatGroups();score.finish(new at.Settings());
  const visits=timeline();assert.deepEqual(visits.map(v=>v.masterBar.index),[0,1,0,1,2]);
  assert.deepEqual(loopPlaybackRange(score,visits,{start:2,end:3,enabled:true,beats:{anchor:point(1,2),focus:point(2,1)}}),{startTick:5760,endTick:17280});
});
test('missing playback data and stale selections cannot start a loop',()=>{
  const {score,timeline}=sample();
  assert.equal(loopPlaybackRange(score,[],{start:1,end:1,enabled:true}),null);
  assert.equal(loopPlaybackRange(score,timeline(),{start:1,end:1,enabled:true,beats:{anchor:point(0,0),focus:point(0,99)}}),null);
});
