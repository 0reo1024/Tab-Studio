import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
import {demoScore,settings,type Score} from '../src/score';
import {addTrack} from '../src/score-operations';
import {setTrackInstrument} from '../src/track-instrument';
import {normalizeEdit} from '../src/edit-snapshot';
import {exportTg} from '../src/tg-writer';
import {importTg} from '../src/tg-reader';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
function programs(score:Score,index=0){const midi=new at.midi.MidiFile();new at.midi.MidiFileGenerator(score,settings,new at.midi.AlphaSynthMidiFileHandler(midi)).generate();return midi.tracks.flatMap(t=>t.events).filter(e=>e.track===index&&e.type===at.midi.MidiEventType.ProgramChange).map(e=>(e as at.midi.ProgramChangeEvent).program);}
test('track sound overrides initial and later instrument events in actual playback MIDI, without changing another track or volume',()=>{
 const score=addTrack(demoScore(),'guitar'),track=score.tracks[0],later=track.staves[0].bars[2].voices[0].beats[1];later.automations.push(at.model.Automation.buildInstrumentAutomation(false,0,30));const volume=new at.model.Automation();volume.type=at.model.AutomationType.Volume;volume.value=9;later.automations.push(volume);
 assert.ok(programs(score).includes(30));setTrackInstrument(score,0,5);const normalized=normalizeEdit(score).score;assert.deepEqual([...new Set(programs(normalized))],[5]);assert.deepEqual([...new Set(programs(normalized,1))],[27]);assert.equal(later.automations.find(a=>a.type===at.model.AutomationType.Volume)?.value,9);
});
test('TG save and reload preserve the selected sound for playback',()=>{const score=demoScore();setTrackInstrument(score,0,0);const loaded=importTg(exportTg(normalizeEdit(score).score,'test.tg',[])).score;assert.equal(loaded.tracks[0].playbackInfo.program,0);assert.deepEqual([...new Set(programs(loaded))],[0]);});
test('keyboard sound changes cover both staves and reject invalid values',()=>{const score=addTrack(demoScore(),'keyboard');for(const staff of score.tracks[1].staves)staff.bars[0].voices[0].beats[0].automations.push(at.model.Automation.buildInstrumentAutomation(false,0,16));setTrackInstrument(score,1,4);assert.deepEqual([...new Set(programs(normalizeEdit(score).score,1))],[4]);assert.throws(()=>setTrackInstrument(score,1,128));assert.throws(()=>setTrackInstrument(score,99,0));});
