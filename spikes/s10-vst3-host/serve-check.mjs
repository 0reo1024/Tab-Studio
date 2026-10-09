// Spike S10: drive tabstudio-fx-host with fx-host.py's line protocol: load, process,
// state/restore round trip, editor open (window captured to a PNG), editor-close, close.
// Usage: node spikes/s10-vst3-host/serve-check.mjs <plugin.vst3> <out-dir>
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const [plugin,out]=process.argv.slice(2);fs.mkdirSync(out,{recursive:true});
const host=spawn(path.resolve('crates/tabstudio-fx-host/target/release/tabstudio-fx-host.exe'),[plugin],{stdio:['pipe','pipe','inherit']});
const waiting=new Map();let id=0;
readline.createInterface({input:host.stdout}).on('line',line=>{if(!line.startsWith('TABSTUDIO:'))return;const d=JSON.parse(line.slice(10));waiting.get(d.id)?.(d);waiting.delete(d.id);});
const ask=(cmd,args={})=>new Promise(resolve=>{const n=++id;waiting.set(n,resolve);host.stdin.write(JSON.stringify({id:n,cmd,...args})+'\n');});
const t0=Date.now();const ready=await new Promise(r=>waiting.set(0,r));console.log('ready',JSON.stringify(ready),Date.now()-t0,'ms');
if(ready.error)process.exit(1);
const frames=4096,pcm=new Float32Array(frames*2);for(let i=0;i<frames;i++){pcm[2*i]=pcm[2*i+1]=.3*Math.sin(i*2*Math.PI*110/48000);}
let t=Date.now();const p=await ask('process',{pcm:Buffer.from(pcm.buffer).toString('base64'),rate:48000});
const res=new Float32Array(Buffer.from(p.pcm,'base64').buffer.slice(0));console.log('process',p.error??`${res.length/2} frames, peak ${Math.max(...res.map(Math.abs)).toFixed(3)}, ${Date.now()-t} ms`);
const s=await ask('state');console.log('state',s.error??`${Buffer.from(s.state,'base64').length} bytes`);
const r=await ask('restore',{state:s.state});console.log('restore',JSON.stringify(r));
// Editor: answered when the window is closed; capture it while open.
const editor=ask('editor');const wait=Number(process.env.EDITOR_WAIT??4000),until=Date.now()+wait;
// Audio keeps flowing while the editor is open (as during playback).
while(Date.now()<until){await ask('process',{pcm:Buffer.from(pcm.buffer).toString('base64'),rate:48000});await new Promise(r=>setTimeout(r,80));}
const shot=path.resolve(out,'editor.bmp');console.log('capture',JSON.stringify(await ask('capture',{path:shot})));
const closed=await ask('editor-close');const e=await editor;console.log('editor-close',JSON.stringify(closed),'editor answered with',e.error??`state ${Buffer.from(e.state,'base64').length} bytes`);
console.log('close',JSON.stringify(await ask('close')));
await new Promise(r=>host.on('exit',code=>{console.log('exit',code);r();}));
