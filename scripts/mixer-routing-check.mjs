import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {demoScore,project} from '../src/score.ts';
import {addTrack,duplicateTrack} from '../src/score-operations.ts';
import {setDrum} from '../src/drum-editor.ts';
let score=addTrack(demoScore(),'drums');
for(const bar of score.tracks[1].staves[0].bars){const voice=bar.voices[0];voice.beats=[];for(let n=0;n<8;n++){const beat=new at.model.Beat();beat.duration=8;voice.addBeat(beat);setDrum(beat,38,0,true);}}
score.finish(new at.Settings());score=duplicateTrack(score,1);score.tracks[0].playbackInfo.isMute=true;
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST:'1',TAB_STUDIO_TEST_DATA:path.resolve('test-results/routing-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log(e.stack);});await page.locator('#start-demo').click();await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 await page.evaluate(p=>window.tabStudio.load('Routing.tabstudio',new TextEncoder().encode(p)),project(score,'Routing',[]));await page.waitForFunction(()=>window.tabStudio.getState().tracks===3&&window.tabStudio.getState().ready&&!window.tabStudio.getState().rendering);
 await page.getByRole('button',{name:'表示',exact:true}).click();await page.getByRole('menuitem',{name:'ミキサー',exact:true}).click();
 const peaks=()=>page.evaluate(()=>new Promise(resolve=>{const values=[0,0,0,0];const end=performance.now()+900;const sample=()=>{for(let i=0;i<4;i++)values[i]=Math.max(values[i],window.audioPeaks?.[i]??0);if(performance.now()<end)requestAnimationFrame(sample);else resolve(values);};sample();}));
 await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);
 await page.evaluate(async()=>{const audio=window.tabStudio.mixerAudio,c=audio.context;const code=`class Check extends AudioWorkletProcessor{process(inputs,outputs){this.port.postMessage(inputs.map(ch=>ch.flatMap(a=>Array.from(a)).reduce((p,v)=>Math.max(p,Math.abs(v)),0)));return true;}}registerProcessor('mixer-check',Check);`;const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));await c.audioWorklet.addModule(url);URL.revokeObjectURL(url);const node=new AudioWorkletNode(c,'mixer-check',{numberOfInputs:4,numberOfOutputs:1});audio.graphs.forEach((g,i)=>g.gain.connect(node,0,i));audio.master.connect(node,0,3);node.connect(c.destination);node.port.onmessage=({data})=>window.audioPeaks=data;window.capture=node;});
 let p=await peaks();assert.ok(p[0]<.001);assert.ok(p[1]>.001&&p[2]>.001,'both percussion tracks have separate audio');
 await page.locator('#mixer [data-track="1"] .mixer-ms button').first().click();await page.waitForTimeout(150);p=await peaks();assert.ok(p[1]<.001&&p[2]>.001,'muting one shared-channel drum track preserves the other');
 await page.locator('#mixer [data-track="2"] .mixer-ms button').last().click();await page.waitForTimeout(150);p=await peaks();assert.ok(p[0]<.001&&p[1]<.001&&p[2]>.001);
 await page.locator('#mixer [data-mixer=master]').fill('0');await page.locator('#mixer [data-mixer=master]').dispatchEvent('input');await page.waitForTimeout(150);assert.ok((await peaks())[3]<.001);
 await page.locator('#play').click();assert.deepEqual(errors,[]);console.log('MIXER ROUTING PASSED: independent percussion stems on shared MIDI channel, mute/solo isolation, master silence');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
