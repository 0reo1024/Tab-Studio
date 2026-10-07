import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
import {addTrack,moveTrack} from '../src/score-operations';
import {setDrum} from '../src/drum-editor';
import {setPitch} from '../src/standard-editor';
import {splitFullRest} from '../src/editor';
import {demoScore,serialize,voiceQ,importGuitarPro} from '../src/score';
import {exportScore} from '../src/export-score';
import {importTg} from '../src/tg-reader';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
function arrangement(){let s=addTrack(addTrack(demoScore(),'drums'),'keyboard');for(const [staff,pitch]of [[s.tracks[1].staves[0],38],[s.tracks[2].staves[0],72],[s.tracks[2].staves[1],48]] as const){splitFullRest(staff.bars[0].voices[0].beats[0]);const b=staff.bars[0].voices[0].beats[0];if(staff.isPercussion)setDrum(b,pitch,0);else setPitch(b,pitch,0);}return s;}
test('drum and keyboard tracks align every measure and use independent pitched / percussion channels',()=>{const original=demoScore(),before=serialize(original),s=addTrack(addTrack(original,'drums'),'keyboard'),d=s.tracks[1],k=s.tracks[2];assert.equal(serialize(original),before);assert.equal(d.playbackInfo.primaryChannel,9);assert.equal(d.staves[0].isPercussion,true);assert.equal(d.staves[0].tuning.length,0);assert.equal(k.playbackInfo.program,0);assert.equal(k.staves.length,2);assert.equal(k.staves[1].bars[0].clef,at.model.Clef.F4);assert.notEqual(k.playbackInfo.primaryChannel,9);assert.notEqual(k.playbackInfo.primaryChannel,s.tracks[0].playbackInfo.primaryChannel);for(const t of s.tracks)for(const st of t.staves){assert.equal(st.bars.length,s.masterBars.length);for(const b of st.bars)assert.equal(voiceQ(b.voices[0]),4);}const moved=moveTrack(s,1,0);assert.equal(moved.tracks[0].playbackInfo.primaryChannel,9);assert.equal(moved.tracks[2].staves.length,2);});
test('drum editing retains rhythm and supports simultaneous instruments without duplicate sounds',()=>{const s=arrangement(),b=s.tracks[1].staves[0].bars[0].voices[0].beats[0];setDrum(b,42,0,true);assert.deepEqual(b.notes.map(n=>n.percussionArticulation),[38,42]);const before=serialize(s);assert.throws(()=>setDrum(b,42,0,true));assert.equal(serialize(s),before);setDrum(b,36,0);assert.deepEqual(b.notes.map(n=>n.realValue),[36,42]);assert.equal(b.duration,4);});
for(const format of ['tg','gp'] as const)test(`${format} roundtrip retains drums, both keyboard staves and sounding pitches`,()=>{const s=arrangement(),reopened=format==='tg'?importTg(exportScore(s,format)).score:importGuitarPro(exportScore(s,format));assert.equal(reopened.tracks[1].staves[0].isPercussion,true);assert.equal(reopened.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0].realValue,38);assert.equal(reopened.tracks[2].staves.length,2);assert.deepEqual(reopened.tracks[2].staves.map(st=>st.bars[0].voices[0].beats[0].notes[0].realValue),[72,48]);});
