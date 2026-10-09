import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {settings} from '../src/score';
import {masterAudio,trackAudio} from '../src/mixer-state';
import {NativeEngine,type EngineHost,type EngineStatus} from '../src/audio/native-engine';
import {NativePlayback,nativeMix,tempoMap} from '../src/audio/native-playback';

const score=()=>at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 0.6 r r r
\track "B" \tuning E4 B3 G3 D3 A2 E2
:4 0.5 r r r
\track "C" \tuning E4 B3 G3 D3 A2 E2
:4 0.4 r r r`,settings);

test('engine mix follows MixerAudio: volume/8, balance pan, mute, solo, reverb send, FX, bus 1/sqrt(audible), master', ()=>{
 const s=score();s.tracks[0].playbackInfo.volume=16;s.tracks[1].playbackInfo.balance=16;s.tracks[2].playbackInfo.isMute=true;
 const a=trackAudio(s.tracks[0]);a.reverb=true;a.send=.4;a.fx=[{id:'1',kind:'eq',name:'EQ',enabled:true,amount:.7},{id:'2',kind:'delay',name:'D',enabled:false,amount:.5},{id:'3',kind:'external',name:'X',enabled:true,amount:1,path:'x.vst3'},{id:'4',kind:'compressor',name:'C',enabled:true,amount:.3}];
 let mix=nativeMix(s);
 assert.equal(mix.tracks[0].gain,2);assert.equal(mix.tracks[0].send,.4);assert.equal(mix.tracks[1].send,0,'reverb off: no send');
 assert.deepEqual(mix.fx[0],[{kind:'eq',amount:.7},{kind:'compressor',amount:.3}],'enabled built-in FX in order');
 assert.equal(mix.tracks[1].pan,1);assert.equal(mix.tracks[2].mute,true);assert.equal(mix.master,1);
 assert.equal(mix.bus.gain,1/Math.SQRT2,'two audible tracks');assert.equal(mix.bus.reverb,true);
 s.tracks[1].playbackInfo.isSolo=true;masterAudio(s).volume=.5;masterAudio(s).reverb=false;mix=nativeMix(s);
 assert.equal(mix.tracks[1].solo,true);assert.equal(mix.bus.gain,1,'one audible track');assert.equal(mix.master,.5);assert.equal(mix.bus.reverb,false);
 masterAudio(s).mute=true;assert.equal(nativeMix(s).master,0);
});

function setup(){
 const calls:unknown[]=[];let push:((s:EngineStatus)=>void)|undefined;
 const host:EngineHost={invoke:async<T>(command:string,args?:Record<string,unknown>)=>{if(args?.request)calls.push(args.request);return (command==='audio_start'?{sampleRate:48000,device:'x'}:undefined) as T;},send:async<T>()=>({tracks:3,endTime:8}) as T,subscribe:async l=>{push=l;}};
 const engine=new NativeEngine(host),output={handler:undefined as unknown,positions:[] as number[],updatePosition(ms:number){this.positions.push(ms);}};
 const player={output,state:1,tickPosition:0};
 const playback=new NativePlayback(engine,()=>player,e=>{throw e;});
 const status=(s:Partial<EngineStatus>)=>push!({position:0,playing:false,counting:false,finished:0,wraps:0,frames:0,peaks:[],clickPeak:0,master:[0,0],...s});
 return {engine,playback,output,player,calls,status};
}

test('load reaches the engine with the mix; the clock is forwarded only while both play', async()=>{
 const {playback,output,player,calls,status}=setup();
 playback.attach();assert.equal(output.handler,playback.handler);
 await playback.load({division:960,tracks:[{events:[]}]},score());
 assert.equal(calls.filter(c=>(c as {kind?:string}).kind==='track').length,3);assert.ok(calls.some(c=>(c as {kind?:string}).kind==='master'));
 const kinds=()=>calls.map(c=>(c as {kind?:string}).kind);
 assert.equal(kinds().filter(k=>k==='trackFx').length,3,'every track chain once');assert.ok(kinds().includes('bus'));
 const s=score();playback.sync(s);await new Promise(r=>setTimeout(r,0));
 assert.equal(kinds().filter(k=>k==='trackFx').length,3,'unchanged chains are not rebuilt');
 trackAudio(s.tracks[1]).fx=[{id:'d',kind:'delay',name:'D',enabled:true,amount:.5}];playback.sync(s);await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls.filter(c=>(c as {kind?:string}).kind==='trackFx').at(-1),{kind:'trackFx',index:1,fx:[{kind:'delay',amount:.5}]});
 calls.length=0;
 status({position:1,playing:false});assert.deepEqual(output.positions,[],'stopped engine: alphaTab owns the position');
 status({position:1.5,playing:true});
 // A user pause is not forwarded (alphaTab may already have sought elsewhere)...
 status({position:1.6,playing:false});
 // ...but the song end is, once, so alphaTab finishes.
 status({position:8,playing:false,finished:1});status({position:8,playing:false,finished:1});
 assert.deepEqual(output.positions,[1500,8000]);
 player.state=0;status({position:2,playing:true});assert.equal(output.positions.length,2,'alphaTab paused: ignored');
 player.state=1;playback.handler.playbackRate=.5;status({position:1,playing:true,finished:1});assert.equal(output.positions.at(-1),2000);
});

test('an engine loop wrap reaches alphaTab as the loop end; its seek back is not repeated', async()=>{
 const {playback,output,player,calls,status}=setup();playback.attach();
 // 120 bpm: tick 1920 = 1 s, tick 3840 = 2 s.
 await playback.load({division:960,tracks:[{events:[{type:81,tick:0,track:0,beatsPerMinute:120}]}]},score());
 playback.loop({startTick:1920,endTick:3840});
 status({position:1.9,playing:true});status({position:1.05,playing:true,wraps:1});
 assert.deepEqual(output.positions.map(Math.round),[1900,2002],'wrap -> just past the loop end');
 await new Promise(r=>setTimeout(r,0));calls.length=0;player.tickPosition=1920;playback.handler.seekTo(1000);player.tickPosition=2400;playback.handler.seekTo(1250);
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls,[{kind:'seekTick',tick:2400}],'only the echo seek is skipped');
});

test('loops go to the engine in ticks (once a song is loaded); counts call the engine', async()=>{
 const {playback,calls}=setup();
 playback.loop({startTick:960,endTick:3840});
 assert.equal(calls.length,0,'no song yet: kept for the load');
 await playback.load({division:960,tracks:[{events:[]}]},score());
 assert.deepEqual(calls.at(-1),{kind:'loopTicks',start:960,end:3840},'sent after the load (with speed and mix)');
 assert.ok(calls.some(c=>(c as {kind?:string}).kind==='speed'));
 playback.loop(null);
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls.at(-1),{kind:'loopTicks',start:null,end:null});
 (globalThis as {requestAnimationFrame?:(f:()=>void)=>void}).requestAnimationFrame=f=>setTimeout(f,5);
 const shown:number[]=[];
 const ok=await playback.count({duration:.05,ticks:[{offset:0,accent:true,remaining:2},{offset:.025,accent:false,remaining:1}]},()=>false,n=>shown.push(n));
 assert.equal(ok,true);assert.deepEqual(calls.find(c=>(c as {kind?:string}).kind==='countIn'),{kind:'countIn',ticks:[[0,true],[.025,false]],duration:.05});
 assert.equal(shown[0],2);
 const cancelled=await playback.count({duration:1,ticks:[{offset:0,accent:true,remaining:1}]},()=>true,()=>{});
 assert.equal(cancelled,false);
});

test('NAM tracks play the Standard Guitar DI, SFZ tracks their file, others the GM synth', ()=>{
 const s=score();trackAudio(s.tracks[0]).nam.enabled=true;trackAudio(s.tracks[1]).sound={kind:'sfz',name:'X',path:'C:/x.sfz'};
 assert.deepEqual(nativeMix(s,'C:/di.sfz').sounds,['C:/di.sfz','C:/x.sfz',null]);
 assert.deepEqual(nativeMix(s).sounds,[null,'C:/x.sfz',null],'no DI known yet');
});

test('tempo map turns ticks into song seconds', ()=>{
 const seconds=tempoMap({division:960,tracks:[{events:[{type:81,tick:0,track:0,beatsPerMinute:120},{type:81,tick:3840,track:0,beatsPerMinute:60}]}]});
 assert.equal(seconds(1920),1);assert.equal(seconds(3840),2);assert.equal(seconds(4800),3);
});
