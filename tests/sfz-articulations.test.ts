import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
import {settings} from '../src/score';
import {installSfzCapture,articulationMap,eventKey} from '../src/sfz-articulations';
Object.assign(globalThis,{DOMParser});installSfzCapture();
function midi(score:at.model.Score){const file=new at.midi.MidiFile();new at.midi.MidiFileGenerator(score,settings,new at.midi.AlphaSynthMidiFileHandler(file)).generate();return file;}
test('SFZ metadata preserves two independent strings at a shared pitch',()=>{
 const score=at.importer.ScoreLoader.loadAlphaTex('. :4 (7.1 12.2) r r r',settings),notes=score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes;
 notes[0].isPalmMute=true;notes[1].harmonicType=at.model.HarmonicType.Pinch;notes[1].harmonicValue=0;
 const file=midi(score),map=articulationMap(file),on=file.tracks.flatMap(t=>t.events).filter(e=>e.type===128);
 assert.equal(on.length,2);const values=on.flatMap(e=>map.get(eventKey(e))??[]);assert.ok(values.some(v=>v.keyswitch===27));assert.ok(values.some(v=>v.keyswitch===21));assert.equal(new Set(values.map(v=>v.lane)).size,2);
 assert.ok(on.every(e=>!Object.hasOwn(e,'keyswitch')),'normal MIDI remains unchanged');
});
test('grace 7 to 9 retains the complete slide range and native string metadata',()=>{
 const score=at.importer.ScoreLoader.loadAlphaTex('. :4 7.1 9.1 5.1 r',settings),beats=score.tracks[0].staves[0].bars[0].voices[0].beats;
 beats[0].graceType=at.model.GraceType.OnBeat;beats[0].notes[0].slideOutType=at.model.SlideOutType.Legato;score.finish(settings);
 const file=midi(score),map=articulationMap(file),bends=file.tracks.flatMap(t=>t.events).filter(e=>e.type===96) as at.midi.NoteBendEvent[];
 assert.ok(bends.some(e=>e.value===2415919104),'slide arrives two semitones above fret 7');
 assert.ok(bends.every(e=>map.get(eventKey(e))?.[0].lane===beats[0].notes[0].string));
});
test('slap and pop beats ask for the bass Slap program',()=>{
 const score=at.importer.ScoreLoader.loadAlphaTex('. :4 3.4 5.2 7.3 2.4',settings),beats=score.tracks[0].staves[0].bars[0].voices[0].beats;
 beats[0].slap=true;beats[1].pop=true;beats[2].slap=true;beats[2].notes[0].isGhost=true;
 const file=midi(score),map=articulationMap(file),on=file.tracks.flatMap(t=>t.events).filter(e=>e.type===128);
 assert.deepEqual(on.map(e=>map.get(eventKey(e))?.[0].keyswitch),[124,126,125,24]);
});
