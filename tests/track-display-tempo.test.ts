import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
import {demoScore,settings,serialize} from '../src/score';
import {addTrack,duplicateTrack,moveTrack,tuningPresets} from '../src/score-operations';
import {setSongTempo} from '../src/song-tempo';
import {setTrackNotation,trackNotation} from '../src/track-notation';
import {normalizeEdit} from '../src/edit-snapshot';
import {exportTg} from '../src/tg-writer';
import {importTg} from '../src/tg-reader';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
test('song tempo updates initial playback MIDI while preserving later tempo changes and TG roundtrip',()=>{
 const score=demoScore();score.masterBars[2].tempoAutomations=[at.model.Automation.buildTempoAutomation(false,0,95,2)];score.masterBars[0].tempoAutomations.push(at.model.Automation.buildTempoAutomation(false,.5,140,2));setSongTempo(score,180);const next=normalizeEdit(score).score;
 assert.equal(next.tempo,180);assert.deepEqual(next.masterBars[0].tempoAutomations.map(a=>a.value),[180,140]);assert.equal(next.masterBars[2].tempoAutomations[0].value,95);
 const midi=new at.midi.MidiFile();new at.midi.MidiFileGenerator(next,settings,new at.midi.AlphaSynthMidiFileHandler(midi)).generate();const tempos=midi.tracks.flatMap(t=>t.events).filter(e=>e.type===at.midi.MidiEventType.TempoChange).map(e=>(e as at.midi.TempoChangeEvent).microSecondsPerQuarterNote);assert.ok(tempos.some(v=>Math.abs(v-60000000/180)<1));assert.ok(tempos.some(v=>Math.abs(v-60000000/95)<1));
 const loaded=importTg(exportTg(next,'tempo.tg',[])).score;assert.equal(loaded.tempo,180);assert.equal(loaded.masterBars[2].tempoAutomations[0].value,95);
 const before=serialize(next);assert.throws(()=>setSongTempo(next,0));assert.throws(()=>setSongTempo(next,Infinity));assert.equal(serialize(next),before);
});
test('song tempo adds a beginning event without removing a later first-bar event',()=>{const s=demoScore();s.masterBars[0].tempoAutomations=[at.model.Automation.buildTempoAutomation(false,.5,90,2)];setSongTempo(s,160);assert.equal(s.tempo,160);assert.deepEqual(s.masterBars[0].tempoAutomations.map(a=>[a.ratioPosition,a.value]),[[0,160],[.5,90]]);});
test('7-string guitar and 5-string bass use the complete tuning, distinct channels and retain TG settings',()=>{
 const source=demoScore(),before=serialize(source),s=addTrack(addTrack(source,'guitar7'),'bass5');assert.equal(serialize(source),before);assert.deepEqual(s.tracks[1].staves[0].tuning,tuningPresets.guitar7);assert.deepEqual(s.tracks[2].staves[0].tuning,tuningPresets.bass5);assert.equal(s.tracks[2].playbackInfo.program,33);assert.equal(new Set(s.tracks.map(t=>t.playbackInfo.primaryChannel)).size,3);const loaded=importTg(exportTg(s,'extended.tg',[])).score;assert.equal(loaded.tracks[1].staves[0].tuning.length,7);assert.equal(loaded.tracks[2].staves[0].tuning.length,5);
});
test('mixed per-track notation survives normalization, duplicate, reorder and TG save',()=>{
 let s=addTrack(addTrack(demoScore(),'guitar'),'bass');setTrackNotation(s.tracks[0],'tab');setTrackNotation(s.tracks[1],'standard');setTrackNotation(s.tracks[2],'both');s=normalizeEdit(s).score;assert.deepEqual(s.tracks.map(trackNotation),['tab','standard','both']);s=duplicateTrack(s,1);assert.deepEqual(s.tracks.map(trackNotation),['tab','standard','standard','both']);s=moveTrack(s,3,0);const loaded=importTg(exportTg(s,'display.tg',[])).score;assert.deepEqual(loaded.tracks.map(trackNotation),['both','tab','standard','standard']);
 const drum=addTrack(s,'drums').tracks.at(-1)!;const before=drum.staves.map(st=>[st.showStandardNotation,st.showTablature]);assert.throws(()=>setTrackNotation(drum,'tab'));assert.deepEqual(drum.staves.map(st=>[st.showStandardNotation,st.showTablature]),before);
});
