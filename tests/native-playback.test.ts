import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {settings} from '../src/score';
import {masterAudio} from '../src/mixer-state';
import {NativeEngine,type EngineHost,type EngineStatus} from '../src/audio/native-engine';
import {NativePlayback,nativeMix} from '../src/audio/native-playback';

const score=()=>at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 0.6 r r r
\track "B" \tuning E4 B3 G3 D3 A2 E2
:4 0.5 r r r
\track "C" \tuning E4 B3 G3 D3 A2 E2
:4 0.4 r r r`,settings);

test('engine mix follows MixerAudio: volume/8 over sqrt(audible), balance pan, mute, solo, master', ()=>{
 const s=score();s.tracks[0].playbackInfo.volume=16;s.tracks[1].playbackInfo.balance=16;s.tracks[2].playbackInfo.isMute=true;
 let mix=nativeMix(s);
 assert.equal(mix.tracks[0].gain,2/Math.SQRT2);assert.equal(mix.tracks[1].pan,1);assert.equal(mix.tracks[2].mute,true);assert.equal(mix.master,1);
 s.tracks[1].playbackInfo.isSolo=true;masterAudio(s).volume=.5;mix=nativeMix(s);
 assert.equal(mix.tracks[1].solo,true);assert.equal(mix.tracks[1].gain,s.tracks[1].playbackInfo.volume/8,'one audible track: no bus reduction');assert.equal(mix.master,.5);
 masterAudio(s).mute=true;assert.equal(nativeMix(s).master,0);
});

function setup(){
 const calls:unknown[]=[];let push:((s:EngineStatus)=>void)|undefined;
 const host:EngineHost={invoke:async<T>(command:string,args?:Record<string,unknown>)=>{calls.push(args?.request??command);return (command==='audio_start'?{sampleRate:48000,device:'x'}:undefined) as T;},send:async<T>()=>({tracks:3,endTime:8}) as T,subscribe:async l=>{push=l;}};
 const engine=new NativeEngine(host),output={handler:undefined as unknown,positions:[] as number[],updatePosition(ms:number){this.positions.push(ms);}};
 const playback=new NativePlayback(engine,()=>({output}),e=>{throw e;});
 const status=(s:Partial<EngineStatus>)=>push!({position:0,playing:false,counting:false,finished:0,wraps:0,frames:0,peaks:[],clickPeak:0,master:[0,0],...s});
 return {engine,playback,output,calls,status};
}

test('load reaches the engine with the mix; the clock is forwarded only while playing', async()=>{
 const {playback,output,calls,status}=setup();
 playback.attach();assert.equal(output.handler,playback.handler);
 await playback.load({division:960,tracks:[{events:[]}]},score());
 assert.equal(calls.filter(c=>(c as {kind?:string}).kind==='track').length,3);assert.ok(calls.some(c=>(c as {kind?:string}).kind==='master'));
 status({position:1,playing:false});assert.deepEqual(output.positions,[],'paused: alphaTab owns the position');
 status({position:1.5,playing:true});status({position:8,playing:false});status({position:8,playing:false});
 assert.deepEqual(output.positions,[1500,8000],'playing, then the final stop position once');
 playback.handler.playbackRate=.5;status({position:1,playing:true});assert.equal(output.positions.at(-1),2000);
});

test('loops go to the engine in ticks; counts call the engine and finish after the duration', async()=>{
 const {playback,calls}=setup();
 playback.loop({startTick:960,endTick:3840});playback.loop(null);
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls.slice(-2),[{kind:'loopTicks',start:960,end:3840},{kind:'loopTicks',start:null,end:null}]);
 (globalThis as {requestAnimationFrame?:(f:()=>void)=>void}).requestAnimationFrame=f=>setTimeout(f,5);
 const shown:number[]=[];
 const ok=await playback.count({duration:.05,ticks:[{offset:0,accent:true,remaining:2},{offset:.025,accent:false,remaining:1}]},()=>false,n=>shown.push(n));
 assert.equal(ok,true);assert.deepEqual(calls.find(c=>(c as {kind?:string}).kind==='countIn'),{kind:'countIn',ticks:[[0,true],[.025,false]],duration:.05});
 assert.equal(shown[0],2);
 const cancelled=await playback.count({duration:1,ticks:[{offset:0,accent:true,remaining:1}]},()=>true,()=>{});
 assert.equal(cancelled,false);
});
