import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {settings} from '../src/score';
import {encodeEventList,eventListFromMidi} from '../src/audio/event-list';

function midiOf(tex:string){const score=at.importer.ScoreLoader.loadAlphaTex(tex,settings);const file=new at.midi.MidiFile();new at.midi.MidiFileGenerator(score,settings,new at.midi.AlphaSynthMidiFileHandler(file)).generate();return file;}
type Row={tick:number;kind:number;channel:number;data1:number;data2:number;value:number;track:number};
function decode(bytes:Uint8Array):{division:number;rows:Row[]}{
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);assert.equal(String.fromCharCode(...bytes.subarray(0,4)),'TSEV');assert.equal(view.getUint32(4,true),1);
 const count=view.getUint32(12,true);assert.equal(bytes.byteLength,16+count*16);
 return {division:view.getUint32(8,true),rows:Array.from({length:count},(_,i)=>{const at=16+i*16;return {tick:view.getUint32(at,true),kind:bytes[at+4],channel:bytes[at+5],data1:bytes[at+6],data2:bytes[at+7],value:view.getUint32(at+8,true),track:view.getUint16(at+12,true)};})};
}

test('alphaTab MIDI becomes the engine event list with tempo, programs, notes and note bends', ()=>{
 const midi=midiOf('\\tempo 90 . \\track "A" \\instrument 27 . :4 3.3 5.3{b (0 4)} r r \\track "B" \\instrument 33 . :4 0.4 r r r');
 const {division,rows}=decode(eventListFromMidi(midi));
 assert.equal(division,midi.division);
 const tempo=rows.find(r=>r.kind===0x51)!;assert.equal(tempo.value,90000);
 assert.deepEqual([...new Set(rows.filter(r=>r.kind===0xC0).map(r=>`${r.track}:${r.data1}`))].sort(),['0:27','1:33']);
 const noteOns=rows.filter(r=>r.kind===0x90);assert.equal(noteOns.length,3);assert.ok(noteOns.every(r=>r.data2>0));
 // Each note-on comes before its note-off (alphaTab's own type numbers are swapped).
 for(const on of noteOns){const off=rows.find(r=>r.kind===0x80&&r.track===on.track&&r.data1===on.data1)!;assert.ok(off.tick>on.tick,`note ${on.data1} off ${off.tick} after on ${on.tick}`);}
 assert.equal(Math.min(...noteOns.map(r=>r.tick)),0,'the first note starts at tick 0');
 assert.deepEqual([...new Set(noteOns.map(r=>r.track))].sort(),[0,1]);
 // alphaTab resets each note's bend (center 0x80000000) and the bent note rises above center.
 const bends=rows.filter(r=>r.kind===0x60);assert.ok(bends.some(r=>r.value===0x80000000));assert.ok(bends.some(r=>r.value>0x80000000),'bend up');
 assert.ok(rows.some(r=>r.kind===0x58&&r.data1===4&&r.data2===2),'4/4');
 assert.ok(rows.every(r=>r.channel<16&&r.data1<128&&r.data2<128));
});

test('the tick shift is passed on for the metronome', ()=>{
 const {rows}=decode(eventListFromMidi({division:960,tickShift:240,tracks:[{events:[{type:0x2F,tick:3840,track:0}]}]}));
 assert.deepEqual(rows[0],{tick:0,kind:0x7E,channel:0,data1:0,data2:0,value:240,track:0});
 assert.equal(decode(eventListFromMidi({division:960,tracks:[{events:[]}]})).rows.length,0);
});

test('SFZ articulations ride in the record: lane, continued, keyswitch, and the bend reference', ()=>{
 const events=[{type:128,tick:0,track:1,channel:2,noteKey:40,noteVelocity:90},{type:96,tick:0,track:1,channel:2,noteKey:40,value:0x80000000},{type:128,tick:0,track:1,channel:2,noteKey:40,noteVelocity:80}];
 const map=new Map([['1:128:0:2:40',[{lane:6,keyswitch:27,reference:40,continued:false},{lane:5,keyswitch:24,reference:40,continued:true}]],['1:96:0:2:40',[{lane:6,keyswitch:27,reference:38,continued:true}]]]);
 const bytes=encodeEventList(960,events,map),view=new DataView(bytes.buffer);
 const art=(i:number)=>view.getUint16(16+i*16+14,true);
 assert.equal(art(0),6|(27<<8),'first note: lane 6, palm mute');
 assert.equal(art(1),6|0x80|(27<<8));assert.equal(bytes[16+16+7],38,'bend reference in data2');
 assert.equal(art(2),5|0x80|(24<<8),'same key again takes the next articulation');
 assert.equal(new DataView(encodeEventList(960,events).buffer).getUint16(16+14,true),0,'none without a map');
});

test('unknown events are skipped and fields fall back to data1/data2', ()=>{
 const {rows}=decode(encodeEventList(480,[{type:0xF0,tick:0,track:0},{type:0xB0,tick:5,track:2,channel:3,data1:7,data2:100},{type:0xE0,tick:6,track:0,channel:1,data1:0,data2:96}]));
 assert.deepEqual(rows,[{tick:5,kind:0xB0,channel:3,data1:7,data2:100,value:0,track:2},{tick:6,kind:0xE0,channel:1,data1:0,data2:0,value:96<<7,track:0}]);
});
