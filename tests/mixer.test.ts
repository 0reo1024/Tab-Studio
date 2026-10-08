import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DOMParser} from '@xmldom/xmldom';
import {demoScore,serialize,deserialize,project,readProject} from '../src/score';
import {trackAudio,masterAudio,mixerView,applyNamPreset,sanitizeTrackAudio} from '../src/mixer-state';
import {duplicateTrack,moveTrack,removeTrack} from '../src/score-operations';
import {EditSnapshot,normalizeEdit,restoreScore} from '../src/edit-snapshot';
import {exportTg} from '../src/tg-writer';
import {importTg} from '../src/tg-reader';
Object.assign(globalThis,{DOMParser});

test('NAM/FX/SFZ settings round trip through TG, projects and edit snapshots',()=>{const s=demoScore(),audio=trackAudio(s.tracks[0]);applyNamPreset(audio.nam,'lead');audio.sound={kind:'sfz',name:'Standard Guitar',path:'C:/Audio/Standard.sfz'};audio.reverb=true;audio.fx.push({id:'bias',kind:'external',name:'BIAS FX 2',path:'C:/Plugins/BIAS.vst3',state:'preset-bytes',enabled:true,amount:1});masterAudio(s).volume=.5;
 for(const restored of [importTg(exportTg(s,'Test',[])).score,deserialize(serialize(s)),readProject(project(s,'Test',[])).score,normalizeEdit(s).score,restoreScore(new EditSnapshot().get(s)!)] ){assert.deepEqual(trackAudio(restored.tracks[0]),audio);assert.equal(masterAudio(restored).volume,.5);}
});
test('a bypassed plugin keeps its full editor state when the score is saved and loaded',()=>{
 const score=demoScore(),state=Buffer.alloc(250_000,37).toString('base64');
 trackAudio(score.tracks[0]).fx.push({id:'bias',kind:'external',name:'BIAS FX 2',path:'C:/Plugins/BIAS.vst3',state,enabled:false,amount:1});
 for(const reopened of [importTg(exportTg(score,'BIAS',[])).score,readProject(project(score,'BIAS',[])).score]){
  const fx=trackAudio(reopened.tracks[0]).fx[0];assert.equal(fx.state,state);assert.equal(fx.enabled,false);
 }
});
test('track copies, reorder and deletion carry independent audio settings',()=>{const s=demoScore();applyNamPreset(trackAudio(s.tracks[0]).nam,'crunch');const copy=duplicateTrack(s,0);trackAudio(copy.tracks[1]).nam.input=-20;assert.equal(trackAudio(copy.tracks[0]).nam.input,3);const moved=moveTrack(copy,1,0);assert.equal(trackAudio(moved.tracks[0]).nam.input,-20);assert.equal(trackAudio(moved.tracks[1]).nam.input,3);const removed=removeTrack(moved,0);assert.equal(trackAudio(removed.tracks[0]).nam.input,3);});
test('history audio data is immutable after subsequent edits',()=>{const s=demoScore(),snap=new EditSnapshot(),before=snap.get(s)!;applyNamPreset(trackAudio(s.tracks[0]).nam,'lead');snap.invalidate();const after=snap.get(s)!;assert.equal(trackAudio(restoreScore(before).tracks[0]).nam.enabled,false);assert.equal(trackAudio(restoreScore(after).tracks[0]).nam.preset,'lead');});

test('unchanged NAM and FX settings share one immutable history object',()=>{
 const s=demoScore(),snap=new EditSnapshot();applyNamPreset(trackAudio(s.tracks[0]).nam,'lead');trackAudio(s.tracks[0]).fx.push({id:'fx',kind:'external',name:'FX',path:'C:/fx.vst3',state:'large preset',enabled:true,amount:1});
 const initial=trackAudio(s.tracks[0]).nam.input,first=snap.get(s)!,audio=(first.get('tracks') as Map<string,any>[])[0].get('studioaudio');
 const note=s.tracks[0].staves[0].bars[0].voices[0].beats.find(b=>b.notes.length)!.notes[0];note.fret+=1;snap.invalidate();
 const second=snap.get(s)!,next=(second.get('tracks') as Map<string,any>[])[0].get('studioaudio');
 assert.equal(next,audio);assert.notEqual(second,first);
 trackAudio(s.tracks[0]).nam.input=5;snap.invalidate();const third=snap.get(s)!;
 assert.notEqual((third.get('tracks') as Map<string,any>[])[0].get('studioaudio'),audio);
 assert.equal(trackAudio(restoreScore(first).tracks[0]).nam.input,initial);
});
test('invalid stored audio values are bounded and unknown FX are ignored',()=>{const p=sanitizeTrackAudio({send:99,nam:{input:NaN,output:999,enabled:true},fx:[{kind:'unknown'},{kind:'delay',amount:-1}]});assert.equal(p.send,1);assert.equal(p.nam.input,0);assert.equal(p.nam.output,12);assert.equal(p.fx.length,1);assert.equal(p.fx[0].amount,0);});

test('each score owns mixer dimensions that survive project, TG and edit restoration',()=>{
 const first=demoScore(),second=demoScore();Object.assign(mixerView(first),{height:280,width:350});Object.assign(mixerView(second),{height:6,width:390});
 for(const restored of [deserialize(serialize(first)),readProject(project(first,'First',[])).score,importTg(exportTg(first,'First',[])).score,normalizeEdit(first).score,restoreScore(new EditSnapshot().get(first)!)]){
  assert.deepEqual(mixerView(restored),{height:280,width:350,tracks:1});mixerView(restored).width=320;
 }
 assert.deepEqual(mixerView(first),{height:280,width:350,tracks:1});assert.deepEqual(mixerView(second),{height:6,width:390,tracks:1});
});

test('mixer size snapshots remain immutable and old scores use automatic dimensions',()=>{
 const score=demoScore(),snapshot=new EditSnapshot();assert.deepEqual(mixerView(score),{height:0,width:0,tracks:1});const before=snapshot.get(score)!;
 mixerView(score).height=6;snapshot.invalidate();const after=snapshot.get(score)!;
 assert.equal(mixerView(restoreScore(before)).height,0);assert.equal(mixerView(restoreScore(after)).height,6);
});
