import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {settings} from '../src/score';
import {trackAudio} from '../src/mixer-state';
import {applySfzFallback,SFZ_FALLBACK_PROGRAM} from '../src/audio/sfz-fallback';

function setup(){
 const score=at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "Gtr1" \instrument 5 \tuning E4 B3 G3 D3 A2 E2
:4 3.3 r r r
\track "Gtr2" \instrument 28 \tuning E4 B3 G3 D3 A2 E2
:4 0.6 r r r
\track "Bass" \instrument 33 \tuning G2 D2 A1 E1
:4 0.4 r r r`,settings);
 for(const i of [0,1])trackAudio(score.tracks[i]).sound={kind:'sfz',name:'Guitar DI',path:'C:/guitar.sfz'};
 const file=new at.midi.MidiFile();new at.midi.MidiFileGenerator(score,settings,new at.midi.AlphaSynthMidiFileHandler(file)).generate();
 const programs=()=>file.tracks.flatMap(t=>t.events).filter(e=>e.type===192).map(e=>`${e.track}:${(e as at.midi.ProgramChangeEvent).program}`);
 return {score,file,programs};
}

test('without an SFZ host, SFZ tracks play a clean electric guitar instead of their stored GM program', ()=>{
 const {score,file,programs}=setup();
 assert.ok(programs().includes('1:28'),'the file asks for the muted guitar');
 assert.ok(applySfzFallback(file,score,false)>0);
 assert.ok(programs().filter(p=>p.startsWith('0:')||p.startsWith('1:')).every(p=>p.endsWith(':'+SFZ_FALLBACK_PROGRAM)));
 assert.ok(programs().filter(p=>p.startsWith('2:')).every(p=>p==='2:33'),'GM tracks keep their program');
 assert.equal(score.tracks[1].playbackInfo.program,28,'the score itself is unchanged');
});

test('with an SFZ host nothing changes', ()=>{
 const {score,file,programs}=setup();
 const before=programs();
 assert.equal(applySfzFallback(file,score,true),0);
 assert.deepEqual(programs(),before);
});
