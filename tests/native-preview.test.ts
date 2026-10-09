import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {settings,serialize} from '../src/score';
import {splitFrame} from '../src/platform/frame';
import {NativeNotePreview} from '../src/audio/native-preview';
import type {EngineHost} from '../src/audio/native-engine';

const copy=(b:Uint8Array)=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;
function rows(bytes:Uint8Array){const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),n=v.getUint32(12,true);return Array.from({length:n},(_,i)=>({tick:v.getUint32(16+i*16,true),kind:bytes[16+i*16+4],channel:bytes[16+i*16+5],data1:bytes[16+i*16+6],data2:bytes[16+i*16+7]}));}

test('a note preview is the worker\'s one-note MIDI: program, then the note for a quarter at velocity 100', ()=>{
 const r=rows(NativeNotePreview.noteEvents(52,27,false));
 assert.ok(r.some(e=>e.kind===0xC0&&e.data1===27&&e.channel===0));
 const on=r.find(e=>e.kind===0x90)!,off=r.find(e=>e.kind===0x80)!;
 assert.deepEqual([on.data1,on.data2,on.tick,off.tick],[52,100,0,960]);
 assert.ok(rows(NativeNotePreview.noteEvents(38,0,true)).filter(e=>e.kind===0x90).every(e=>e.channel===9),'drums on channel 9');
});

test('previews go to the engine with their track and report its result; typed notes keep their order', async()=>{
 const sent:{track:number;events:number}[]=[];
 const host:EngineHost={invoke:async<T>()=>undefined as T,subscribe:async()=>{},send:async<T>(command:string,body:Uint8Array)=>{assert.equal(command,'audio_preview');const {header,bytes}=splitFrame<{track:number}>(copy(body));sent.push({track:header.track,events:bytes.byteLength});return {frames:30000,peak:.3,played:true} as T;}};
 const preview=new NativeNotePreview(host,async()=>{});
 const score=at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 1.6 12.6 r r`,settings);
 const [a,b]=score.tracks[0].staves[0].bars[0].voices[0].beats.map(x=>x.notes[0]);
 const results=await Promise.all([preview.enqueue(a),preview.enqueue(b)]);
 assert.deepEqual(results.map(r=>r?.pitch),[a.realValue,b.realValue]);
 assert.ok(results.every(r=>r?.played&&r.peak===.3&&r.frames===30000));
 assert.equal(sent.length,2);assert.ok(sent.every(s=>s.track===0&&s.events>16));
 const phrase=await preview.playPhrase(serialize(score),0);
 assert.equal(phrase?.played,true);assert.equal(sent.length,3);
});
