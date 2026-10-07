import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {transposeNote,shiftString} from '../src/note-actions';
import {setMeter} from '../src/meter-editor';
import {settings,serialize,voiceQ} from '../src/score';
test('half steps affect only the selected chord note and string shifts preserve pitch',()=>{
 const s=at.importer.ScoreLoader.loadAlphaTex('. :4 (10.3 4.5) r r r',settings),b=s.tracks[0].staves[0].bars[0].voices[0].beats[0],n=b.notes[0],other=b.notes[1],old=n.realValueWithoutHarmonic,fret=n.fret,string=n.string;n.isPalmMute=true;
 transposeNote(n,1);assert.equal(n.realValueWithoutHarmonic,old+1);assert.equal(other.fret,4);transposeNote(n,-1);assert.equal(n.fret,fret);shiftString(n,1);assert.equal(n.realValueWithoutHarmonic,old);assert.equal(n.string,string+1);shiftString(n,-1);assert.equal(n.fret,fret);assert.equal(n.string,string);assert.equal(n.isPalmMute,true);
});
test('a rejected string shift and invalid fret leave the note unchanged',()=>{const s=at.importer.ScoreLoader.loadAlphaTex('. :4 (0.1 2.2) r r r',settings),n=s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0],before=serialize(s);assert.throws(()=>shiftString(n,1));assert.throws(()=>transposeNote(n,-1));assert.equal(serialize(s),before);});
test('meter changes trim trailing rests and keep sounding notes at their original onsets',()=>{const s=at.importer.ScoreLoader.loadAlphaTex('. :4 3.1 r 5.1 r | :1 r',settings);setMeter(s,0,3,4);const v=s.tracks[0].staves[0].bars[0].voices[0];assert.equal(voiceQ(v),3);assert.deepEqual(v.beats.map(b=>b.notes[0]?.fret),[3,undefined,5]);assert.equal(s.masterBars[1].timeSignatureNumerator,4);setMeter(s,0,6,4);assert.equal(voiceQ(v),6);});
test('meter changes that truncate a sounding note fail atomically',()=>{const s=at.importer.ScoreLoader.loadAlphaTex('. :4 3.1 r 5.1 r',settings),before=serialize(s);assert.throws(()=>setMeter(s,0,2,4));assert.equal(serialize(s),before);assert.throws(()=>setMeter(s,0,4,3));});
