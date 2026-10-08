import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {project} from '../src/score.ts';
import {duplicateTrack} from '../src/score-operations.ts';
import {trackAudio,applyNamPreset} from '../src/mixer-state.ts';
const pattern=':8 '+Array.from({length:32},(_,i)=>(i%8===7?'(3.6 2.5 0.4 0.3 0.2 3.1) |':'(0.6 2.5 2.4 0.3 0.2 0.1)')).join(' ');
let score=at.importer.ScoreLoader.loadAlphaTex('\\title "Audio Stability" \\tempo 110 \\track "Guitar" \\instrument 27 . '+Array(4).fill(pattern).join(' '),new at.Settings());
score=duplicateTrack(score,0);applyNamPreset(trackAudio(score.tracks[0]).nam,'fender-super');applyNamPreset(trackAudio(score.tracks[1]).nam,'marshall-jcm800');
const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST:'1',TAB_STUDIO_TEST_DATA:path.resolve('test-results/stability-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.locator('#start-demo').click();await page.waitForFunction(()=>window.tabStudio?.getState().ready);
 const bias=await page.evaluate(async()=>{const plugins=await window.nativeFx.scan();return plugins.find(p=>p.name.includes('BIAS FX 2'))?.path;});assert.ok(bias);trackAudio(score.tracks[0]).fx.push({id:'bias-stability',kind:'external',name:'BIAS FX 2',path:bias,enabled:true,amount:1});
 await page.evaluate(p=>window.tabStudio.load('Stability.tabstudio',new TextEncoder().encode(p)),project(score,'Stability',[]));await page.waitForFunction(()=>window.tabStudio.getState().tracks===2&&window.tabStudio.getState().ready&&!window.tabStudio.getState().rendering);
 console.log('STABILITY: loading audio chain');
 await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing,undefined,{timeout:120000});
 console.log('STABILITY: playing');
 await page.evaluate(async()=>{
  const audio=window.tabStudio.mixerAudio,c=audio.context;window.stableNodes=audio.graphs.map(g=>[g.nam,...g.nodes]);
  const code=`class Capture extends AudioWorkletProcessor{constructor(){super();this.peaks=[0,0,0,0,0];this.quiets=[0,0,0,0,0];this.longests=[0,0,0,0,0];this.active=false;this.quiet=0;this.longest=0;this.frames=0;this.peak=0;}process(inputs){const a=inputs[0]?.[0];if(!a)return true;let peak=0;for(let i=0;i<a.length;i++)peak=Math.max(peak,Math.abs(a[i]));if(peak>1e-5)this.active=true;if(this.active){for(let ch=0;ch<5;ch++){let p=0;for(const v of inputs[ch]?.[0]??[])p=Math.max(p,Math.abs(v));this.peaks[ch]=Math.max(this.peaks[ch],p);this.quiets[ch]=p<1e-7?this.quiets[ch]+a.length:0;this.longests[ch]=Math.max(this.longests[ch],this.quiets[ch]);}this.quiet=peak<1e-7?this.quiet+a.length:0;this.longest=Math.max(this.longest,this.quiet);this.frames+=a.length;this.peak=Math.max(this.peak,peak);if(this.frames%4096===0)this.port.postMessage({frames:this.frames,longest:this.longest,peak:this.peak,peaks:this.peaks,longests:this.longests});}return true;}}registerProcessor('stability-capture',Capture);`;
  const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));await c.audioWorklet.addModule(url);URL.revokeObjectURL(url);const node=new AudioWorkletNode(c,'stability-capture',{numberOfInputs:5,numberOfOutputs:1});audio.master.connect(node,0,0);audio.graphs[0].input.connect(node,0,1);audio.graphs[1].input.connect(node,0,2);audio.graphs[0].gain.connect(node,0,3);audio.graphs[1].gain.connect(node,0,4);node.connect(c.destination);node.port.onmessage=({data})=>window.stability=data;
 });
 console.log('STABILITY: capturing');
 await page.waitForFunction(()=>window.stability?.frames>10000,undefined,{timeout:30000});
 // Exercise frequent live gain/EQ updates while both NAM channels and BIAS run.
 await page.getByRole('button',{name:'表示',exact:true}).click();await page.getByRole('menuitem',{name:'ミキサー',exact:true}).click();await page.locator('[data-nam-track="0"]').click();await page.locator('[data-nam=input]').waitFor();
 console.log('STABILITY: changing live controls');
 await page.evaluate(()=>{let n=0;window.stressStart=window.stability.frames;window.stressChanges=0;window.gainStress=setInterval(()=>{const input=document.querySelector('[data-nam=input]');if(input){input.value=String(n++%4);window.stressChanges++;input.dispatchEvent(new Event('input',{bubbles:true}));}},35);});
 await page.waitForFunction(()=>window.stability?.frames>window.stressStart+window.tabStudio.mixerAudio.context.sampleRate*8,undefined,{timeout:30000});
 const result=await page.evaluate(async()=>{clearInterval(window.gainStress);const a=window.tabStudio.mixerAudio;await a.prepare(window.tabStudio.getScore());return {...window.stability,underrun:a.underrunFrames,changes:window.stressChanges,retained:a.graphs.every((g,i)=>[g.nam,...g.nodes].every((n,j)=>n===window.stableNodes[i][j])),playing:window.tabStudio.getState().playing,status:document.querySelector("#status")?.textContent,notice:document.querySelector("#notice")?.textContent,resources:a.resourceStats()};});
 console.log('STABILITY PCM DIAGNOSTICS',result);assert.ok(result.changes>20,'continuous gain updates exercised during capture');assert.equal(result.playing,true);assert.equal(result.retained,true,'live gain changes retain all NAM/FX nodes and their buffers');assert.ok(result.longest<=256,`unexpected silent gap: ${result.longest} frames`);assert.ok(result.peak>.001);assert.deepEqual(errors,[]);
 console.log('MIXER STABILITY PASSED: two Standard Guitar/NAM channels + BIAS, repeated live gain changes, retained processing nodes; longest silent run',result.longest,'frames');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
