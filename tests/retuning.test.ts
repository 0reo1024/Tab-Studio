import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {configureTrack,tuningPresets} from '../src/score-operations';
import {serialize,deserialize,settings} from '../src/score';
import {RetuningError} from '../src/retuning';
import {cleanEditJson} from '../src/edit-json';
import {exportTg} from '../src/tg-writer';
import {importTg} from '../src/tg-reader';
import {DOMParser} from '@xmldom/xmldom';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
const make=(tex:string)=>at.importer.ScoreLoader.loadAlphaTex(tex,settings);
const notes=(s:at.model.Score,track=0)=>s.tracks[track].staves.flatMap(st=>st.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(b=>b.notes))));
const pitches=(s:at.model.Score)=>s.tracks.map((_,i)=>notes(s,i).map(n=>n.realValue));
const change=(s:at.model.Score,tuning:number[],capo=s.tracks[0].staves[0].capo)=>configureTrack(s,0,{name:s.tracks[0].name||'Guitar',tuning,capo});
function midi(s:at.model.Score){const file=new at.midi.MidiFile();new at.midi.MidiFileGenerator(s,settings,new at.midi.AlphaSynthMidiFileHandler(file)).generate();return file.tracks.flatMap(t=>t.events.filter(e=>e.type===at.midi.MidiEventType.NoteOn).map(e=>[e.tick,(e as at.midi.NoteOnEvent).noteKey,(e as at.midi.NoteOnEvent).noteVelocity]));}

test('Drop D and half-step-down adjust frets without changing notes or MIDI pitches',()=>{
  const s=make('\\track "Guitar" . :4 0.6 3.6 (2.5 2.4 1.3) r \\track "Other" . :1 7.1'),before=serialize(s);
  for(const tuning of [tuningPresets.dropD,tuningPresets.halfDown]){
    const out=change(s,tuning);assert.deepEqual(pitches(out),pitches(s));assert.deepEqual(midi(out),midi(s));
    assert.equal(notes(out)[0].fret,tuning===tuningPresets.dropD?2:1);assert.equal(notes(out)[0].string,notes(s)[0].string);
  }
  assert.equal(serialize(s),before);
});
test('higher tuning moves a note to another string and updates chord diagrams',()=>{
  const s=make('. :4 0.1 (0.1 0.2) r r'),staff=s.tracks[0].staves[0],chord=new at.model.Chord();chord.name='E';chord.strings=[0,0,-1,-1,-1,-1];staff.addChord('e',chord);staff.bars[0].voices[0].beats[1].chordId='e';
  const out=change(s,[65,59,55,50,45,40]);assert.deepEqual(pitches(out),pitches(s));assert.notEqual(notes(out)[0].string,notes(s)[0].string);
  const beat=out.tracks[0].staves[0].bars[0].voices[0].beats[1];assert.equal(new Set(beat.notes.map(n=>n.string)).size,2);
  assert.equal(beat.chord!.name,'E');assert.deepEqual(beat.chord!.strings.flatMap((f,i)=>f<0?[]:[out.tracks[0].staves[0].tuning[i]+f]).sort(),[59,64]);
});
test('adding or removing strings remaps physical string numbers while preserving pitches',()=>{
  const s=make('. :4 0.6 3.5 5.1 r'),seven=change(s,tuningPresets.guitar7);
  assert.deepEqual(pitches(seven),pitches(s));assert.deepEqual(notes(seven).map(n=>n.string),notes(s).map(n=>n.string+1));
  const four=change(seven,tuningPresets.bass4);assert.deepEqual(pitches(four),pitches(s));assert.ok(notes(four).every(n=>n.string>=1&&n.string<=4));
});
test('linked slides, hammer-ons and ties keep their pitch and links after string reassignment',()=>{
  const s=make('. :4 0.1{sl} 2.1 2.1{t} 4.1{h} | :1 5.1'),out=change(s,[65,59,55,50,45,40]),n=notes(out);
  assert.deepEqual(pitches(out),pitches(s));assert.deepEqual(midi(out),midi(s));
  assert.equal(n[0].slideTarget,n[1]);assert.equal(n[2].tieOrigin,n[1]);assert.equal(n[3].hammerPullDestination,n[4]);
  assert.equal(n[0].string,n[1].string);assert.equal(n[1].string,n[2].string);
});
test('nonzero capo and transposition are included when preserving tuning-change pitches',()=>{
  const s=make('\\capo 2 . :4 3.6 5.2 7.1 r');s.tracks[0].staves[0].transpositionPitch=2;
  const out=change(s,tuningPresets.halfDown);assert.deepEqual(pitches(out),pitches(s));assert.deepEqual(midi(out),midi(s));
  // A capo-only edit keeps its existing transposing behavior.
  assert.deepEqual(pitches(change(s,tuningPresets.standard,3))[0],pitches(s)[0].map(p=>p+1));
});
test('unplayable pitches or chords reject the whole change, without losing any notes',()=>{
  for(const tex of ['. :4 7.1 0.6 r r','\\tuning E4 B3 . :1 (0.1 0.2)']){
    const s=make(tex),before=serialize(s),tuning=s.tracks[0].staves[0].tuning.map(p=>p+1);
    assert.throws(()=>change(s,tuning),/音程を保ったまま/);assert.equal(serialize(s),before);
  }
});
test('natural harmonics keep their sounding pitch, or safely reject unrepresentable harmonics',()=>{
  const s=make('. :1 12.6'),n=notes(s)[0];n.harmonicType=at.model.HarmonicType.Natural;n.harmonicValue=12;
  // E2's octave is also the seventh-fret harmonic of A1.
  const out=change(s,[64,59,55,50,45,33]);assert.deepEqual(pitches(out),pitches(s));assert.equal(notes(out)[0].harmonicValue,7);assert.equal(notes(out)[0].fret,7);
  const before=serialize(s);assert.throws(()=>change(s,tuningPresets.halfDown),/音程を保ったまま/);assert.equal(serialize(s),before);
});
test('retuned notes, bends and chord diagrams survive TG save and reopen',()=>{
  const s=make('. :4 3.6{b (0 4)} (2.5 2.4) r r'),staff=s.tracks[0].staves[0],chord=new at.model.Chord();chord.name='Em';chord.strings=[0,0,0,2,2,0];staff.addChord('em',chord);staff.bars[0].voices[0].beats[1].chordId='em';
  const out=change(s,tuningPresets.halfDown),loaded=importTg(exportTg(out)).score;
  assert.deepEqual(pitches(loaded),pitches(s));assert.deepEqual(notes(loaded).map(n=>[n.string,n.fret]),notes(out).map(n=>[n.string,n.fret]));assert.ok(notes(loaded)[0].hasBend);
  assert.deepEqual(loaded.tracks[0].staves[0].bars[0].voices[0].beats[1].chord!.strings,[1,1,1,3,3,1]);
});
test('reconstructed harmonic ties cannot silently overwrite the preserved pitch',()=>{
  const s=make('. :2 12.6 12.6{t}'),n=notes(s)[0];n.harmonicType=at.model.HarmonicType.Natural;n.harmonicValue=12;
  const before=serialize(s);assert.throws(()=>change(s,[64,59,55,50,45,33]),/音程を保ったまま/);assert.equal(serialize(s),before);
});
test('reports every blocked note in measure order instead of stopping at the first',()=>{
  const s=make('. :4 0.6 0.5 r r | :4 0.6 0.5 r r'),before=serialize(s);
  assert.throws(()=>change(s,tuningPresets.standard.map(p=>p+12)),e=>{
    assert.ok(e instanceof RetuningError);assert.equal(e.issues.length,4);assert.deepEqual(e.issues.map(i=>[i.bar,i.beat]),[[0,0],[0,1],[1,0],[1,1]]);
    assert.match(e.message,/4件/);assert.match(e.message,/E2/);assert.match(e.message,/A2/);assert.match(e.message,/第2小節/);return true;
  });assert.equal(serialize(s),before);
});
test('combines note, chord, harmonic and every shared diagram failure into one report',()=>{
  const s=make('. :4 0.6 (0.1 0.2) 12.6 r | :4 0.6 (0.1 0.2) r r'),staff=s.tracks[0].staves[0];
  const n=staff.bars[0].voices[0].beats[2].notes[0];n.harmonicType=at.model.HarmonicType.Natural;n.harmonicValue=12;
  const c=new at.model.Chord();c.name='Test';c.strings=[0,0,-1,-1,-1,-1];staff.addChord('c',c);for(const bar of staff.bars)bar.voices[0].beats[1].chordId='c';const before=serialize(s);
  assert.throws(()=>change(s,[45]),e=>{
    assert.ok(e instanceof RetuningError);assert.equal(e.issues.length,7);
    assert.equal(e.issues.filter(i=>i.message.includes('同じ音程がありません')).length,2);
    assert.equal(e.issues.filter(i=>i.message.includes('ナチュラルハーモニクス')).length,1);
    assert.equal(e.issues.filter(i=>i.message.includes('和音の各音')).length,2);
    assert.equal(e.issues.filter(i=>i.message.includes('コード図「Test」')).length,2);return true;
  });assert.equal(serialize(s),before);
});
test('reports pitch inheritance failures even when an unrelated note already failed',()=>{
  const s=make('. :4 12.6 12.6{t} 36.1 r'),n=notes(s)[0];n.harmonicType=at.model.HarmonicType.Natural;n.harmonicValue=12;const before=serialize(s);
  assert.throws(()=>change(s,[63,59,55,50,45,33]),e=>{
    assert.ok(e instanceof RetuningError);assert.equal(e.issues.length,2);
    assert.ok(e.issues.some(i=>i.message.includes('0〜36フレット')));assert.ok(e.issues.some(i=>i.message.includes('再構築すると音程が変わる')));return true;
  });assert.equal(serialize(s),before);
});
test('checks every staff before rejecting the track settings',()=>{
  const s=make('. :1 0.6'),json=JSON.parse(serialize(s));json.tracks[0].staves.push(structuredClone(json.tracks[0].staves[0]));cleanEditJson(json,true);
  const both=deserialize(JSON.stringify(json)),before=serialize(both);
  assert.throws(()=>change(both,tuningPresets.standard.map(p=>p+1)),e=>{
    assert.ok(e instanceof RetuningError);assert.deepEqual(e.issues.map(i=>i.staff),[0,1]);assert.match(e.message,/2段目/);return true;
  });assert.equal(serialize(both),before);
});
