// Spike S6: for several scores, render the app's own alphaSynth output (api.exportAudio)
// and save the exact event list the app plays (after its midiLoad adjustments), so
// the native engine can render the same events for an A/B comparison.
// Usage: pnpm build && node --import tsx spikes/s6-synth-ab/reference.mjs <out folder>
import {_electron as electron} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {encodeEventList} from '../../src/audio/event-list.ts';
import * as at from '@coderline/alphatab';
import {settings,project} from '../../src/score.ts';
const out=path.resolve(process.argv[2]??'test-results/s6');await fs.mkdir(out,{recursive:true});
function wav(pcm,rate){const head=Buffer.alloc(44);head.write('RIFF',0);head.writeUInt32LE(36+pcm.length,4);head.write('WAVEfmt ',8);head.writeUInt32LE(16,16);head.writeUInt16LE(1,20);head.writeUInt16LE(2,22);head.writeUInt32LE(rate,24);head.writeUInt32LE(rate*4,28);head.writeUInt16LE(4,32);head.writeUInt16LE(16,34);head.write('data',36);head.writeUInt32LE(pcm.length,40);return Buffer.concat([head,pcm]);}
const variants=[
 {name:'01-demo-electric'},
 {name:'02-demo-nylon',texFile:'spikes/s6-synth-ab/02-demo-nylon.tex'},
 {name:'03-bends-distortion',texFile:'spikes/s6-synth-ab/03-bends-distortion.tex'},
 {name:'04-band',texFile:'spikes/s6-synth-ab/04-band.tex'},
 {name:'05-fixture-notes-gp',file:'tests/fixtures/notes.gp'},
];
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(out,'profile-'+Date.now())}});
try{
 const page=await app.firstWindow();page.on('pageerror',e=>console.log('PAGEERROR',e.message));page.on('console',m=>{if(m.text().startsWith('S6'))console.log(m.text());});
 await page.locator('#start-demo').click();
 const ready=()=>page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering,{},{timeout:60000});
 await ready();
 for(const v of variants){
  if(v.texFile){const score=at.importer.ScoreLoader.loadAlphaTex(await fs.readFile(v.texFile,'utf8'),settings);await page.evaluate(p=>window.tabStudio.load('S6.tabstudio',new TextEncoder().encode(p)),project(score,'S6',[]));await ready();}
  if(v.file){const bytes=[...await fs.readFile(v.file)];await page.evaluate(([name,bytes])=>window.tabStudio.load(name,new Uint8Array(bytes)),[path.basename(v.file),bytes]);await ready();}
  const result=await page.evaluate(async v=>{
   const api=window.tabStudio.api;
   const midiPromise=new Promise(resolve=>{const h=f=>{api.midiLoad.off(h);resolve(f);};api.midiLoad.on(h);});
   if(v.program!==undefined)window.tabStudio.getScore().tracks[0].playbackInfo.program=v.program;api.loadMidiForScore();
   const midi=await midiPromise;console.log('S6 midi');await new Promise(r=>setTimeout(r,500));
   const fields=['type','tick','track','channel','noteKey','noteVelocity','controller','value','program','beatsPerMinute','numerator','denominatorIndex'];
   const events=midi.tracks.flatMap(t=>t.events).map(e=>Object.fromEntries(fields.filter(k=>e[k]!==undefined).map(k=>[k,e[k]])));
   // api.exportAudio regenerates the MIDI without the app's midiLoad adjustment (CC7/CC10 = 63
   // at tick 0); volume/balance 7.875 make the generator emit 63 (value*8) as well.
   const tracks=window.tabStudio.getScore().tracks,saved=tracks.map(t=>[t.playbackInfo.volume,t.playbackInfo.balance]);
   for(const t of tracks){t.playbackInfo.volume=7.875;t.playbackInfo.balance=7.875;}
   const exporter=await api.exportAudio({sampleRate:44100,useSyncPoints:false,masterVolume:1,metronomeVolume:0,trackVolume:new Map(),trackTranspositionPitches:new Map()});
   tracks.forEach((t,i)=>{[t.playbackInfo.volume,t.playbackInfo.balance]=saved[i];});
   const parts=[];let chunk,total=0;while((chunk=await exporter.render(1000))){const pcm=new Int16Array(chunk.samples.length);for(let i=0;i<pcm.length;i++)pcm[i]=Math.max(-1,Math.min(1,chunk.samples[i]))*32767;parts.push(pcm);total+=pcm.length;}
   console.log('S6 rendered',total);exporter.destroy?.();
   const all=new Int16Array(total);let at=0;for(const p of parts){all.set(p,at);at+=p.length;}
   let binary='';const bytes=new Uint8Array(all.buffer);for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
   return {division:midi.division,events,pcm:btoa(binary)};
  },v);
  await fs.writeFile(path.join(out,v.name+'.tsev'),encodeEventList(result.division,result.events));
  const pcm=Buffer.from(result.pcm,'base64');
  await fs.writeFile(path.join(out,v.name+'-alphasynth.wav'),wav(pcm,44100));
  console.log(v.name,'events',result.events.length,'seconds',(pcm.length/4/44100).toFixed(2));
 }
}finally{await app.close();}
