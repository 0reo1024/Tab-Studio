import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeEngine,externalMediaHandler,type EngineHost,type EngineStatus} from '../src/audio/native-engine';

function fakeHost(){
 const calls:{command:string;args?:unknown}[]=[];let push:((s:EngineStatus)=>void)|undefined;
 const host:EngineHost={
  invoke:async<T>(command:string,args?:Record<string,unknown>)=>{calls.push({command,args});return (command==='audio_start'?{sampleRate:48000,device:'Test'}:undefined) as T;},
  send:async<T>(command:string,body:Uint8Array)=>{calls.push({command,args:body.byteLength});return {tracks:2,endTime:8} as T;},
  subscribe:async listener=>{push=listener;},
 };
 return {host,calls,push:(s:Partial<EngineStatus>)=>push!({position:0,playing:false,counting:false,finished:0,wraps:0,frames:0,peaks:[],clickPeak:0,master:[0,0],...s})};
}
const midi={division:960,tracks:[{events:[{type:81,tick:0,track:0,beatsPerMinute:120},{type:128,tick:0,track:0,channel:0,noteKey:40,noteVelocity:90},{type:144,tick:480,track:0,channel:0,noteKey:40,noteVelocity:0}]}]};

test('the engine starts once, loads event lists and forwards status', async()=>{
 const {host,calls,push}=fakeHost();const engine=new NativeEngine(host);
 await Promise.all([engine.start(),engine.start()]);
 assert.equal(calls.filter(c=>c.command==='audio_start').length,1);
 assert.equal(engine.sampleRate,48000);
 const result=await engine.load(midi);
 assert.deepEqual(result,{tracks:2,endTime:8});assert.equal(engine.endTime,8);
 assert.equal(calls.at(-1)!.command,'audio_load');assert.equal(calls.at(-1)!.args,16+3*16);
 const seen:number[]=[];const off=engine.onStatus(s=>seen.push(s.position));
 push({position:1.5});off();push({position:2});
 assert.deepEqual(seen,[1.5]);assert.equal(engine.status?.position,2);
});

test('requests map to engine commands', async()=>{
 const {host,calls}=fakeHost();const engine=new NativeEngine(host);
 await engine.loop({start:1,end:2});await engine.loop(null);
 await engine.track(1,{gain:.5,pan:-.2,mute:false,solo:true});
 await engine.metronome(true,'beep',.6);
 await engine.countIn([{offset:0,accent:true},{offset:.5,accent:false}],1);
 assert.deepEqual(calls.map(c=>c.args),[
  {request:{kind:'loop',start:1,end:2}},{request:{kind:'loop',start:null,end:null}},
  {request:{kind:'track',index:1,gain:.5,pan:-.2,mute:false,solo:true}},
  {request:{kind:'metronome',enabled:true,sound:4,volume:.6}},
  {request:{kind:'countIn',ticks:[[0,true],[.5,false]],duration:1}},
 ]);
});

test('seeks use the alphaTab tick when available (its speed changes re-seek before playbackRate is set)', async()=>{
 const {host,calls}=fakeHost();const engine=new NativeEngine(host);await engine.load(midi);calls.length=0;
 let tick:number|undefined=1920.4;const handler=externalMediaHandler(engine,()=>{},()=>tick);
 handler.seekTo(999999);tick=undefined;handler.seekTo(1000);
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls.map(c=>c.args),[{request:{kind:'seekTick',tick:1920}},{request:{kind:'seek',seconds:1}}]);
});

test('the alphaTab handler converts between alphaTab time and song time', async()=>{
 const {host,calls}=fakeHost();const engine=new NativeEngine(host);await engine.load(midi);calls.length=0;
 const handler=externalMediaHandler(engine);
 assert.equal(handler.backingTrackDuration,8000);
 handler.playbackRate=.5;
 // alphaTab works in ms divided by the speed: at half speed 4000 ms is 2 s of song.
 assert.equal(handler.backingTrackDuration,16000);
 handler.seekTo(4000);handler.play();handler.pause();handler.masterVolume=.3;
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls.map(c=>c.args),[{request:{kind:'speed',value:.5}},{request:{kind:'seek',seconds:2}},{request:{kind:'play'}},{request:{kind:'pause'}},{request:{kind:'master',gain:.3}}]);
 assert.equal(handler.positionMs(2),4000);
});
