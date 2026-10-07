import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {serialize,deserialize,voiceQ} from '../src/score';
import {copyBeats,pasteBeats,clearBeats,type BeatPoint} from '../src/beat-clipboard';
import {copyBars,pasteBars,insertBars,deleteBars,addTrack} from '../src/score-operations';
import {cleanEditJson} from '../src/edit-json';
import {pasteMeasurePhrase} from '../src/paste-measures';
import {setFret} from '../src/editor';
import fs from 'node:fs';
const point=(bar:number,beat:number,track=0):BeatPoint=>({track,staff:0,voice:0,bar,beat});
const range=(bar:number,beat:number,endBar=bar,endBeat=beat)=>({anchor:point(bar,beat),focus:point(endBar,endBeat)});
const make=(tex=':4 3.1 5.1 5.1 7.1 | 9.1 11.1 11.1 13.1 | 1.1 2.1 3.1 4.1')=>at.importer.ScoreLoader.loadAlphaTex(tex,new at.Settings());
const beats=(s:at.model.Score,bar=0,track=0)=>s.tracks[track].staves[0].bars[bar].voices[0].beats;
function linked(){const s=make();beats(s)[0].notes[0].isHammerPullOrigin=true;beats(s)[1].notes[0].slideOutType=at.model.SlideOutType.Shift;beats(s)[2].notes[0].isTieDestination=true;return deserialize(serialize(s));}
test('the reported hammerPullDestination error is repaired for linked beat copy and repeated paste',()=>{
  const s=linked();assert.match(serialize(s),/hammerpulloriginnoteid/);const before=serialize(s),clip=copyBeats(s,range(0,0,0,2)),pasted=pasteBeats(s,clip,point(1,0)).score;
  const n=beats(pasted,1).map(b=>b.notes[0]);assert.equal(n[0].hammerPullDestination,n[1]);assert.equal(n[1].hammerPullOrigin,n[0]);assert.equal(n[2].tieOrigin,n[1]);assert.equal(n[1].slideTarget,n[2]);assert.equal(serialize(s),before);assert.doesNotThrow(()=>pasteBeats(pasted,clip,point(2,1),true));
});
test('whole-measure paste and structure edits preserve linked effects with new IDs',()=>{
  const s=linked(),pasted=pasteBars(s,copyBars(s,0,0,0),1,0,false);assert.equal(beats(pasted,1)[0].notes[0].hammerPullDestination,beats(pasted,1)[1].notes[0]);assert.doesNotThrow(()=>insertBars(s,1,1));assert.doesNotThrow(()=>deleteBars(s,0,0));
});
test('cut and delete safely rebuild dangling effect links',()=>{
  const s=linked(),cleared=clearBeats(s,range(0,1,0,2));assert.ok(beats(cleared)[1].isRest&&beats(cleared)[2].isRest);const json=JSON.parse(serialize(s));json.tracks[0].staves[0].bars[0].voices[0].beats[1].notes=[];cleanEditJson(json);assert.doesNotThrow(()=>deserialize(JSON.stringify(json)));
});
test('shortening a copied phrase does not retain connections to missing source notes',()=>{
  const s=linked(),last=copyBeats(s,range(0,1,0,1));assert.doesNotThrow(()=>pasteBeats(s,last,point(2,3)));const source=copyBars(s,0,0,null);assert.doesNotThrow(()=>pasteBars(s,source,3,0,true));
});
test('different meter accepts a measure phrase and preserves destination meter and following music',()=>{
  const source=make(':4 1.1 2.1 3.1 4.1'),dest=make('\\ts 3 4 :4 8.1 9.1 10.1 | 11.1 12.1 13.1'),pasted=pasteMeasurePhrase(dest,copyBars(source,0,0,0),point(0,0));assert.deepEqual(beats(pasted).map(b=>b.notes[0].fret),[1,2,3]);assert.deepEqual(beats(pasted,1).map(b=>b.notes[0].fret),[4,12,13]);assert.ok(pasted.masterBars.every(m=>m.timeSignatureNumerator===3));assert.ok(pasted.tracks[0].staves[0].bars.every(b=>Math.abs(voiceQ(b.voices[0])-3)<1e-6));
});
test('six-string phrases adapt to bass strings while retaining sounding pitches',()=>{
  const s=addTrack(make(),true),clip=copyBeats(s,range(0,0,0,2)),pasted=pasteBeats(s,clip,point(1,0,1)).score;assert.deepEqual(beats(pasted,1,1).slice(0,3).map(b=>b.notes[0].realValueWithoutHarmonic),beats(s).slice(0,3).map(b=>b.notes[0].realValueWithoutHarmonic));assert.ok(beats(pasted,1,1).slice(0,3).every(b=>b.notes[0].string<=4));
});
test('measure clips with different string counts fit the selected track',()=>{
  const s=addTrack(make(),true),pasted=pasteMeasurePhrase(s,copyBars(s,0,0,0),point(1,0,1));assert.equal(beats(pasted,1,1)[0].notes[0].realValueWithoutHarmonic,beats(s)[0].notes[0].realValueWithoutHarmonic);assert.equal(beats(pasted,1)[0].notes[0].fret,9);
});
test('a single grace note pastes before the destination without consuming rhythm',()=>{
  const s=make();beats(s)[0].graceType=at.model.GraceType.BeforeBeat;const clip=copyBeats(s,range(0,0));assert.equal(clip.length,0);const pasted=pasteBeats(s,clip,point(1,0));assert.equal(beats(pasted.score,1)[0].graceType,at.model.GraceType.BeforeBeat);assert.equal(beats(pasted.score,1)[1].notes[0].fret,9);assert.deepEqual(pasted.range,{anchor:point(1,0),focus:point(1,0)});
});
test('a local second voice is padded across other bars before alphaTab chaining',()=>{
  const s=make(),json=JSON.parse(serialize(s));json.tracks[0].staves[0].bars[0].voices.push({beats:[{duration:1,notes:[],isempty:false}]});cleanEditJson(json);const normalized=deserialize(JSON.stringify(json));assert.ok(normalized.tracks[0].staves[0].bars.every(b=>b.voices.length===2));
});
test('typing a different fret on a tie destination keeps the newly entered number',()=>{
  const s=linked();setFret(beats(s)[2],beats(s)[2].notes[0].string,12);const json=JSON.parse(serialize(s));cleanEditJson(json);const edited=deserialize(JSON.stringify(json));assert.equal(beats(edited)[2].notes[0].fret,12);assert.ok(!beats(edited)[2].notes[0].isTieDestination);
});
for(const extension of ['gp3','gp4','gp5','gpx','gp'])test(`linked effects from imported ${extension} support complete measure copy/paste`,()=>{
  const s=at.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(`tests/fixtures/notes.${extension}`)),new at.Settings());assert.doesNotThrow(()=>pasteBars(s,copyBars(s,0,s.masterBars.length-1,null),s.masterBars.length,0,true));
});
