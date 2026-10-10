import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {serialize,deserialize,voiceQ,beatQ} from '../src/score';
import {copyBeats,pasteBeats,clearBeats,rangeBeats,type BeatPoint} from '../src/beat-clipboard';
import {exportTg} from '../src/tg-writer';
import {importTg} from '../src/tg-reader';
import {DOMParser} from '@xmldom/xmldom';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
const make=(tex=':4 1.1 2.1 3.1 4.1 | 5.1 6.1 7.1 8.1 | 9.1 10.1 11.1 12.1')=>at.importer.ScoreLoader.loadAlphaTex(tex,new at.Settings());
const point=(bar:number,beat:number,track=0,voice=0):BeatPoint=>({track,staff:0,voice,bar,beat});
const range=(bar:number,beat:number,endBar=bar,endBeat=beat)=>({anchor:point(bar,beat),focus:point(endBar,endBeat)});
const beats=(s:at.model.Score,bar=0)=>s.tracks[0].staves[0].bars[bar].voices[0].beats;
const frets=(s:at.model.Score,bar=0)=>beats(s,bar).map(b=>b.notes[0]?.fret??null);
function lengths(s:at.model.Score){for(const t of s.tracks)for(const staff of t.staves)for(const bar of staff.bars)for(const voice of bar.voices)assert.ok(Math.abs(voiceQ(voice)-bar.masterBar.timeSignatureNumerator*4/bar.masterBar.timeSignatureDenominator)<1e-6);}
test('beat ranges reverse correctly and copy only the requested chord/rest/effects',()=>{
  const s=make(':8 (3.1 5.2) r 7.1 9.1 1.1 2.1 3.1 4.1');beats(s)[0].notes[0].isPalmMute=true;const before=serialize(s),r={anchor:point(0,2),focus:point(0,0)},clip=copyBeats(s,r);
  assert.equal(clip.count,3);assert.equal(clip.length,1.5);assert.equal(rangeBeats(s,r).length,3);
  const result=pasteBeats(s,clip,point(0,5)).score;assert.equal(beats(result)[5].notes.length,2);assert.ok(beats(result)[5].notes[0].isPalmMute);assert.ok(beats(result)[6].isRest);assert.equal(frets(result)[7],7);assert.equal(serialize(s),before);lengths(result);
});
test('overwrite preserves the earlier and later note onsets, track and voice isolation',()=>{
  const s=make('\\track "A" . :4 1.1 2.1 3.1 4.1 | 5.1 6.1 7.1 8.1 \\track "B" . :4 9.1 10.1 11.1 12.1 | 1.1 2.1 3.1 4.1'),before=serialize(s),clip=copyBeats(s,range(0,1,0,2));
  const result=pasteBeats(s,clip,point(1,1));assert.deepEqual(frets(result.score,1),[5,2,3,8]);assert.deepEqual(result.range,{anchor:point(1,1),focus:point(1,2)});assert.equal(result.score.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0].fret,9);assert.equal(serialize(s),before);lengths(result.score);
});
test('phrases cross bar boundaries, append space and receive unique IDs',()=>{
  const s=make(),clip=copyBeats(s,range(0,3,1,1)),result=pasteBeats(s,clip,point(2,3));assert.equal(result.score.masterBars.length,4);assert.deepEqual(frets(result.score,2),[9,10,11,4]);assert.deepEqual(frets(result.score,3).slice(0,2),[5,6]);assert.deepEqual(result.range,{anchor:point(2,3),focus:point(3,1)});lengths(result.score);
  const ids=result.score.tracks.flatMap(t=>t.staves.flatMap(st=>st.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(b=>b.notes.map(n=>n.id))))));assert.equal(new Set(ids).size,ids.length);
});
test('a long pasted note splits at a bar line with a tie and preserves the old tail',()=>{
  const s=make(':2 3.1 4.1 | :4 5.1 6.1 7.1 8.1 | 9.1 10.1 11.1 12.1'),clip=copyBeats(s,range(0,0)),result=pasteBeats(s,clip,point(1,3)).score;
  assert.deepEqual(frets(result,1),[5,6,7,3]);assert.deepEqual(frets(result,2),[3,10,11,12]);assert.ok(beats(result,2)[0].notes[0].isTieDestination);assert.equal(beatQ(beats(result,1)[3]),1);lengths(result);
});
test('partial overwrite of a longer destination retains its duration outside the phrase',()=>{
  const s=make(':4 1.1 2.1 3.1 4.1 | :1 9.1'),result=pasteBeats(s,copyBeats(s,range(0,0)),point(1,0)).score;
  assert.equal(frets(result,1)[0],1);assert.ok(beats(result,1).slice(1).every(b=>b.notes[0].fret===9));assert.ok(!beats(result,1)[1].notes[0].isTieDestination);lengths(result);
});
test('insert paste shifts the target voice and keeps other tracks at their original times',()=>{
  const s=make('\\track "A" . :4 1.1 2.1 3.1 4.1 | 5.1 6.1 7.1 8.1 \\track "B" . :4 9.1 10.1 11.1 12.1 | 1.1 2.1 3.1 4.1'),result=pasteBeats(s,copyBeats(s,range(0,0,0,1)),point(0,2),true).score;
  assert.deepEqual(frets(result),[1,2,1,2]);assert.deepEqual(frets(result,1),[3,4,5,6]);assert.deepEqual(frets(result,2).slice(0,2),[7,8]);assert.equal(result.tracks[1].staves[0].bars[1].voices[0].beats[0].notes[0].fret,1);assert.ok(result.tracks[1].staves[0].bars[2].voices[0].beats[0].isRest);lengths(result);
});
test('triplets and dots keep exact phrase length and following note timing',()=>{
  const s=make(':8{tu 3} 1.1 2.1 3.1 :4 4.1{d} :8 5.1 :4 6.1 | :4 7.1 8.1 9.1 10.1'),clip=copyBeats(s,range(0,0,0,2)),result=pasteBeats(s,clip,point(1,1)).score;
  assert.ok(Math.abs(clip.length-1)<1e-6);assert.ok(beats(result,1)[1].hasTuplet);assert.deepEqual(frets(result,1),[7,1,2,3,9,10]);lengths(result);
});
test('full measure rests in odd meters copy as their actual capacity',()=>{
  const s=make('\\ts 5 4 :1 r | :4 1.1 2.1 3.1 4.1 5.1'),clip=copyBeats(s,range(0,0)),result=pasteBeats(s,clip,point(1,0)).score;assert.equal(clip.length,5);assert.ok(beats(result,1).every(b=>b.isRest));lengths(result);
});
test('clear range creates rests without shifting notes and rejects mixed voices',()=>{
  const s=make(),before=serialize(s),result=clearBeats(s,range(0,2,1,1));assert.deepEqual(frets(result),[1,2,null]);assert.equal(beats(result)[2].duration,2);assert.deepEqual(frets(result,1),[null,7,8]);assert.equal(beats(result,1)[0].duration,2);assert.equal(beats(result,1)[1].playbackStart,beats(s,1)[2].playbackStart);lengths(result);assert.equal(serialize(s),before);assert.throws(()=>copyBeats(s,{anchor:point(0,0),focus:point(0,1,1)}),/同じトラック/);
});
test('fragment paste and shifted phrases survive TG save/reopen',()=>{
  const s=make(),result=pasteBeats(s,copyBeats(s,range(0,1,1,0)),point(2,1),true).score;
  assert.deepEqual(JSON.parse(serialize(importTg(exportTg(result)).score)),JSON.parse(serialize(deserialize(serialize(result)))));
});
test('overwrite breaks an external destination tie without changing its surviving pitch',()=>{
  const s=make(':4 1.1 2.1 3.1 9.1 | 9.1 10.1 11.1 12.1');beats(s,1)[0].notes[0].isTieDestination=true;
  const result=pasteBeats(s,copyBeats(s,range(0,0)),point(0,3)).score;assert.equal(frets(result)[3],1);assert.equal(frets(result,1)[0],9);assert.ok(!beats(result,1)[0].notes[0].isTieDestination);lengths(result);
});
test('a second voice can be pasted without rewriting the first voice',()=>{
  const s=make();for(const bar of s.tracks[0].staves[0].bars){const v=new at.model.Voice();bar.addVoice(v);for(let i=0;i<4;i++){const b=new at.model.Beat();b.duration=4;const n=new at.model.Note();n.string=1;n.fret=20+i;b.addNote(n);v.addBeat(b);}}const normalized=deserialize(serialize(s));
  const r={anchor:point(0,1,0,1),focus:point(0,2,0,1)},clip=copyBeats(normalized,r),result=pasteBeats(normalized,clip,point(0,0,0,1)).score;assert.deepEqual(frets(result),[1,2,3,4]);assert.deepEqual(result.tracks[0].staves[0].bars[0].voices[1].beats.map(b=>b.notes[0].fret),[21,22,22,23]);lengths(result);lengths(pasteBeats(normalized,clip,point(2,3,0,1),true).score);
});
test('piano phrases retain sound pitches and adapt to string instrument destinations',()=>{
  const s=make('\\track "Piano" \\instrument 0 . :4 C4 D4 E4 F4 | G4 A4 B4 C5'),clip=copyBeats(s,range(0,1,0,2)),result=pasteBeats(s,clip,point(1,1)).score;assert.deepEqual(beats(result,1).map(b=>b.notes[0].realValueWithoutHarmonic),[67,62,64,72]);assert.deepEqual(beats(pasteBeats(make(),clip,point(0,0)).score).slice(0,2).map(b=>b.notes[0].realValueWithoutHarmonic),[62,64]);lengths(result);
});
test('grace notes travel with their main note without consuming its time',()=>{
  const s=make();beats(s)[0].graceType=at.model.GraceType.BeforeBeat;const clip=copyBeats(s,range(0,0,0,1));assert.equal(clip.length,1);const result=pasteBeats(s,clip,point(1,0)).score;assert.equal(beats(result,1)[0].graceType,at.model.GraceType.BeforeBeat);assert.deepEqual(frets(result,1),[1,2,6,7,8]);assert.equal(beats(result,1).filter(b=>b.graceType===at.model.GraceType.None).reduce((a,b)=>a+beatQ(b),0),4);
});
test('cleared beats become the simplest rests on the beat grid',()=>{
  const durations=(s:at.model.Score,bar=0)=>beats(s,bar).map(b=>[b.duration,b.notes.length?1:0,b.hasTuplet?b.tupletNumerator:0]);
  // A triplet group whose notes are all deleted becomes one plain quarter rest (no bracket over rests).
  let s=make(':8 3.1 {tu 3} 3.1 {tu 3} 3.1 {tu 3} 5.1 {tu 3} 5.1 {tu 3} 5.1 {tu 3} :4 7.1 8.1');let result=clearBeats(s,range(0,0,0,5));assert.deepEqual(durations(result),[[2,0,0],[4,1,0],[4,1,0]]);lengths(result);
  // An off-beat 8th + 16ths keep the grid: 8th rest on the off-beat, then a quarter.
  s=make(':8 1.1 2.1 :16 3.1 3.1 3.1 3.1 :4 4.1 5.1');result=clearBeats(s,range(0,1,0,5));assert.deepEqual(durations(result),[[8,1,0],[8,0,0],[4,0,0],[4,1,0],[4,1,0]]);lengths(result);
  // Rests next to the cleared beats join in; notes outside stay put.
  s=make(':8 1.1 r 2.1 2.1 :4 r 3.1');result=clearBeats(s,range(0,2,0,3));assert.deepEqual(durations(result),[[8,1,0],[8,0,0],[4,0,0],[4,0,0],[4,1,0]]);lengths(result);
  // Part of an unfinished triplet stays a triplet rest instead of being forced off the grid.
  s=make(':8 3.1 {tu 3} 4.1 {tu 3} 5.1 {tu 3} :4 r r r');result=clearBeats(s,range(0,1,0,1));assert.deepEqual(durations(result).slice(0,3),[[8,1,3],[8,0,3],[8,1,3]]);lengths(result);
});
