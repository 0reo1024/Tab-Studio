import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as at from '@coderline/alphatab';

const font=(name:string)=>new Uint8Array(readFileSync(new URL(`../public/alphatab/soundfont/${name}`,import.meta.url)));
function signal<T=void>(){const listeners=new Set<(value:T)=>void>();return {on(fn:(value:T)=>void){listeners.add(fn);return ()=>listeners.delete(fn);},off(fn:(value:T)=>void){listeners.delete(fn);},trigger(value:T){for(const fn of listeners)fn(value);}};}
function render(bytes:Uint8Array,program:number,percussion=false){
 const ready=signal(),output:at.synth.ISynthOutput={sampleRate:44100,open(){ready.trigger();},play(){},pause(){},destroy(){},addSamples(){},resetSamples(){},activate(){},ready,sampleRequest:signal(),samplesPlayed:signal<number>(),enumerateOutputDevices:async()=>[],setOutputDevice:async()=>{},getOutputDevice:async()=>null};
 const synth=new at.synth.AlphaSynth(output,100),midi=new at.midi.MidiFile(),handler=new at.midi.AlphaSynthMidiFileHandler(midi),channel=percussion?9:0;
 handler.addTempo(0,120);handler.addProgramChange(0,0,channel,program);handler.addNote(0,0,960,percussion?38:64,100,channel);
 synth.loadSoundFont(bytes,false);synth.loadMidiFile(midi);
 const options=new at.synth.AudioExportOptions();options.sampleRate=44100;options.metronomeVolume=0;
 const pcm=synth.exportAudio(options,midi,[],new Map()).render(300)?.samples;
 assert.ok(pcm?.length);assert.ok(pcm.some(v=>Math.abs(v)>.001));return pcm;
}

test('Nylon program uses the supplied classical guitar samples exactly',()=>{
 const actual=render(font('GeneralUser-Classical.sf3'),24),expected=render(font('classical_guitar_1a.sf3'),0);
 assert.deepEqual(actual,expected);
 assert.notDeepEqual(actual,render(font('GeneralUser-GS.sf2'),24));
});

test('classical guitar replacement preserves piano, electric guitar and drums',()=>{
 const combined=font('GeneralUser-Classical.sf3'),original=font('GeneralUser-GS.sf2');
 for(const [program,percussion] of [[0,false],[30,false],[0,true]] as const)assert.deepEqual(render(combined,program,percussion),render(original,program,percussion));
});
