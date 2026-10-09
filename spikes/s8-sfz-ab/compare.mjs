// Spike S8: the same SFZ events through the Electron build's Python sfz-host (sfizz via
// ctypes) and through the native engine's SfzInstrument (sfizz via Rust FFI); compare.
// Usage: node spikes/s8-sfz-ab/compare.mjs
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
const root=process.cwd(),native=path.join(root,'native'),out=path.join(root,'test-results/s8');await fs.mkdir(out,{recursive:true});
const sfz=JSON.parse(await fs.readFile(path.join(native,'soundfonts.json'),'utf8')).standardGuitar;
const rate=48000,center=2**31;
// Low E (lane 6), a D on lane 4 bent up a whole tone, a palm-muted A (keyswitch 27) and a
// chord on three strings; volume CC and a pitch wheel move.
const events=[
 {sample:0,type:176,controller:7,value:100},
 {sample:0,type:96,noteKey:40,value:center,lane:6,reference:40},
 {sample:0,type:128,noteKey:40,noteVelocity:100,lane:6,keyswitch:24},
 {sample:24000,type:144,noteKey:40,noteVelocity:0,lane:6},
 {sample:24000,type:96,noteKey:50,value:center,lane:4,reference:50},
 {sample:24000,type:128,noteKey:50,noteVelocity:110,lane:4,keyswitch:24},
 {sample:36000,type:96,noteKey:50,value:center+Math.round(center*2/16),lane:4,reference:50},
 {sample:60000,type:144,noteKey:50,noteVelocity:0,lane:4},
 {sample:60000,type:96,noteKey:45,value:center,lane:5,reference:45},
 {sample:60000,type:128,noteKey:45,noteVelocity:90,lane:5,keyswitch:27},
 {sample:84000,type:144,noteKey:45,noteVelocity:0,lane:5},
 ...[[52,4],[55,3],[59,2]].flatMap(([key,lane])=>[{sample:96000,type:96,noteKey:key,value:center,lane,reference:key},{sample:96000,type:128,noteKey:key,noteVelocity:95,lane,keyswitch:24}]),
 {sample:120000,type:224,value:9000},
 ...[[52,4],[55,3],[59,2]].map(([key,lane])=>({sample:156000,type:144,noteKey:key,noteVelocity:0,lane})),
];
await fs.writeFile(path.join(out,'events.json'),JSON.stringify(events));
// Native.
execFileSync(path.join(root,'crates/tabstudio-audio/target/release/tabstudio-audio.exe'),['sfzrender',path.join(native,'runtime','sfizz.dll'),sfz,path.join(out,'events.json'),path.join(out,'native.f32')]);
// Python host, in render blocks that end at event samples (as the native render splits).
const lanes=[...new Set(events.filter(e=>e.lane).map(e=>e.lane))].sort((a,b)=>a-b),pitches={};
for(const e of events)if(e.type===128)(pitches[e.lane]??=[]).push(e.noteKey);
const host=spawn(path.join(native,'runtime','python.exe'),[path.join(native,'sfz-host.py'),sfz,JSON.stringify(lanes),JSON.stringify(pitches)],{stdio:['pipe','pipe','ignore']});
const waiting=new Map();let id=0;
readline.createInterface({input:host.stdout}).on('line',line=>{if(!line.startsWith('TABSTUDIO:'))return;const d=JSON.parse(line.slice(10));waiting.get(d.id)?.(d);waiting.delete(d.id);});
const ask=(cmd,args={})=>new Promise(resolve=>{const n=++id;waiting.set(n,resolve);host.stdin.write(JSON.stringify({id:n,cmd,...args})+'\n');});
await new Promise(resolve=>waiting.set(0,resolve));
const frames=rate*4,pcm=new Float32Array(frames*2);let position=0;
const cuts=[...new Set([...events.map(e=>e.sample),frames])].sort((a,b)=>a-b);
for(const cut of cuts){
 while(position<cut){const count=Math.min(4096,cut-position),block=events.filter(e=>e.sample===position).map(e=>({...e,delay:0}));const r=await ask('render',{frames:count,rate,events:block});if(r.error)throw new Error(r.error);const data=Buffer.from(r.pcm,'base64');pcm.set(new Float32Array(data.buffer,data.byteOffset,data.length/4),position*2);position+=count;}
}
host.kill();
const nativePcm=new Float32Array((await fs.readFile(path.join(out,'native.f32'))).buffer.slice(0));
const rms=(a,s,e)=>Math.sqrt(a.slice(s*2,e*2).reduce((t,v)=>t+v*v,0)/((e-s)*2));
let diff=0,energy=0;for(let i=0;i<pcm.length;i++){diff+=(pcm[i]-nativePcm[i])**2;energy+=pcm[i]**2;}
console.log('overall difference',(10*Math.log10(diff/energy)).toFixed(1),'dB relative to the signal');
for(const [name,s,e]of [['low E',0,24000],['D bent',24000,60000],['palm mute',60000,84000],['chord',96000,156000],['release',156000,frames]]){const a=rms(pcm,s,e),b=rms(nativePcm,s,e);console.log(name.padEnd(10),'python',a.toFixed(4),'native',b.toFixed(4),'diff',(20*Math.log10(b/a)).toFixed(2),'dB');}
