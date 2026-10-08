import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
import {settings} from '../src/score';
import {effectRangeBeats,applyRangeEffect,rangeEffectActive,rangeEffects} from '../src/range-effects';
import {addTrack} from '../src/score-operations';
import {setDrum} from '../src/drum-editor';
import {exportTg} from '../src/tg-writer';
import {importTg} from '../src/tg-reader';
import {normalizeEdit} from '../src/edit-snapshot';
Object.assign(globalThis,{DOMParser});
const sample=()=>at.importer.ScoreLoader.loadAlphaTex('\\track "Guitar" . :8 3.1 5.1 (7.1 8.2) r 9.1 10.1 11.1 12.1 | :4 5.1 6.1 7.1 8.1',settings);
const fragment={anchor:{track:0,staff:0,voice:0,bar:0,beat:3},focus:{track:0,staff:0,voice:0,bar:0,beat:0}};
test('reversed beat range dynamics include chord notes and rests without changing the tail',()=>{
 const score=sample(),beats=effectRangeBeats(score,fragment,null)!;
 assert.equal(beats.length,4);applyRangeEffect(beats,'dynamic7');assert.ok(beats.every(b=>b.dynamics===7&&b.notes.every(n=>n.dynamics===7)));assert.notEqual(score.tracks[0].staves[0].bars[0].voices[0].beats[4].dynamics,7);assert.ok(beats[3].isRest);
});
test('mixed effects converge uniformly then clear; chord and rest rhythm are retained',()=>{
 const score=sample(),beats=effectRangeBeats(score,fragment,null)!,before=beats.map(b=>[b.duration,b.notes.length]);beats[0].notes[0].isPalmMute=true;
 applyRangeEffect(beats,'palm');assert.ok(beats.flatMap(b=>b.notes).every(n=>n.isPalmMute));assert.equal(rangeEffectActive(beats,'palm'),true);applyRangeEffect(beats,'palm');assert.ok(beats.flatMap(b=>b.notes).every(n=>!n.isPalmMute));assert.deepEqual(beats.map(b=>[b.duration,b.notes.length]),before);
});
test('each palette effect applies and clears uniformly on a selected phrase',()=>{
 for(const id of rangeEffects){const score=sample(),beats=effectRangeBeats(score,fragment,null)!;assert.ok(applyRangeEffect(beats,id)>0,id);assert.equal(rangeEffectActive(beats,id),true,id);applyRangeEffect(beats,id);assert.equal(rangeEffectActive(beats,id),false,id);}
});
test('all-track measure scope includes both keyboard staves and voices, while leaving outside measures intact',()=>{
 const score=addTrack(sample(),'keyboard');const second=new at.model.Voice(),beat=new at.model.Beat(),note=new at.model.Note();beat.duration=at.model.Duration.Whole;note.string=6;note.fret=15;beat.addNote(note);second.addBeat(beat);score.tracks[0].staves[0].bars[1].addVoice(second);score.finish(settings);
 const beats=effectRangeBeats(score,null,{start:1,end:1,track:0,allTracks:true})!;applyRangeEffect(beats,'dynamic6');
 assert.ok(score.tracks.every(t=>t.staves.every(st=>st.bars[1].voices.every(v=>v.beats.every(b=>b.dynamics===6)))));
 assert.ok(score.tracks.every(t=>t.staves.every(st=>st.bars[0].voices.every(v=>v.beats.every(b=>b.dynamics!==6)))));assert.equal(second.beats[0].notes[0].dynamics,6);
});
test('guitar techniques skip percussion and independent bend curves survive normalization and TG round trip',()=>{
 const score=addTrack(sample(),'drums'),drum=score.tracks[1].staves[0].bars[0].voices[0].beats[0];setDrum(drum,38,0,true);
 const beats=effectRangeBeats(score,null,{start:0,end:0,track:0,allTracks:true})!;applyRangeEffect(beats,'halfBend');assert.equal(drum.notes[0].hasBend,false);
 const pitched=beats.filter(b=>!b.voice.bar.staff.isPercussion).flatMap(b=>b.notes);assert.ok(pitched.every(n=>n.bendPoints?.length===3&&n.bendPoints[1].value===2));assert.notEqual(pitched[0].bendPoints,pitched[1].bendPoints);
 const normalized=normalizeEdit(score).score,reopened=importTg(exportTg(normalized,'range',[])).score;
 assert.ok(reopened.tracks[0].staves[0].bars[0].voices[0].beats.flatMap(b=>b.notes).every(n=>n.hasBend&&n.bendPoints?.[1].value===2));assert.ok(reopened.tracks[0].staves[0].bars[1].voices[0].beats.flatMap(b=>b.notes).every(n=>!n.hasBend));
});
