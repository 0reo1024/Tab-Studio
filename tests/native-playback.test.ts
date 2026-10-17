import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {settings} from '../src/score';
import {masterAudio,trackAudio,NAM_MODEL_LEVEL} from '../src/mixer-state';
import {NativeEngine,type EngineHost,type EngineStatus} from '../src/audio/native-engine';
import {NativePlayback,nativeMix,tempoMap} from '../src/audio/native-playback';

const score=()=>at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 0.6 r r r
\track "B" \tuning E4 B3 G3 D3 A2 E2
:4 0.5 r r r
\track "C" \tuning E4 B3 G3 D3 A2 E2
:4 0.4 r r r`,settings);

test('engine mix follows MixerAudio: volume/8, balance pan, mute, solo, reverb send, FX, bus 1/sqrt(tracks with volume), master', ()=>{
 const s=score();s.tracks[0].playbackInfo.volume=16;s.tracks[1].playbackInfo.balance=16;s.tracks[2].playbackInfo.isMute=true;
 const a=trackAudio(s.tracks[0]);a.reverb=true;a.send=.4;a.fx=[{id:'1',kind:'eq',name:'EQ',enabled:true,amount:.7},{id:'2',kind:'delay',name:'D',enabled:false,amount:.5},{id:'3',kind:'external',name:'X',enabled:true,amount:1,path:'x.vst3'},{id:'4',kind:'compressor',name:'C',enabled:true,amount:.3}];
 let mix=nativeMix(s);
 assert.equal(mix.tracks[0].gain,2);assert.equal(mix.tracks[0].send,.4);assert.equal(mix.tracks[1].send,0,'reverb off: no send');
 assert.deepEqual(mix.fx[0],[{kind:'eq',amount:.7},{kind:'external',fxId:'3',enabled:true},{kind:'compressor',amount:.3}],'enabled built-in FX and external FX in order');
 assert.equal(mix.tracks[1].pan,1);assert.equal(mix.tracks[2].mute,true);assert.equal(mix.master,1);
 assert.equal(mix.bus.gain,1/Math.sqrt(s.tracks.length),'every track with volume, muted ones included');assert.equal(mix.bus.reverb,true);
 s.tracks[1].playbackInfo.isSolo=true;masterAudio(s).volume=.5;masterAudio(s).reverb=false;mix=nativeMix(s);
 assert.equal(mix.tracks[1].solo,true);assert.equal(mix.bus.gain,1/Math.sqrt(s.tracks.length),'solo keeps the other tracks at their mix level');assert.equal(mix.master,.5);assert.equal(mix.bus.reverb,false);
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
 await new Promise(r=>setTimeout(r,0));calls.length=0;player.tickPosition=1921;playback.handler.seekTo(1000);player.tickPosition=2401;playback.handler.seekTo(1250);
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls,[{kind:'seekTick',tick:2400}],'only the echo seek is skipped');
});

test('loops go to the engine in ticks (once a song is loaded); counts call the engine', async()=>{
 const {playback,calls}=setup();
 playback.loop({startTick:960,endTick:3840});
 assert.equal(calls.length,0,'no song yet: kept for the load');
 await playback.load({division:960,tracks:[{events:[]}]},score());
 assert.deepEqual(calls.at(-1),{kind:'loopTicks',start:960,end:3840,count:null},'sent after the load (with speed and mix)');
 // Count each loop rides with the range (and is resent with it after a load).
 playback.loopCount({duration:1,ticks:[{offset:0,accent:true,remaining:2},{offset:.5,accent:false,remaining:1}]});
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls.at(-1),{kind:'loopTicks',start:960,end:3840,count:{ticks:[[0,true],[.5,false]],duration:1}});
 playback.loopCount(null);
 assert.ok(calls.some(c=>(c as {kind?:string}).kind==='speed'));
 playback.loop(null);
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls.at(-1),{kind:'loopTicks',start:null,end:null,count:null});
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

test('NAM: the model goes to the engine once per key, the knobs when they change, off removes the amp', async()=>{
 const sent:{header:unknown;json:string}[]=[],calls:unknown[]=[];
 const host:EngineHost={invoke:async<T>(command:string,args?:Record<string,unknown>)=>{if(args?.request)calls.push(args.request);return (command==='audio_start'?{sampleRate:48000,device:'x'}:undefined) as T;},
  send:async<T>(command:string,body:Uint8Array)=>{if(command==='audio_nam'){const length=new DataView(body.buffer,body.byteOffset).getUint32(0,true);sent.push({header:JSON.parse(new TextDecoder().decode(body.subarray(4,4+length))),json:new TextDecoder().decode(body.subarray(4+length))});return {loaded:true} as T;}return {tracks:3,endTime:8} as T;},subscribe:async()=>{}};
 const models:string[]=[];
 const playback=new NativePlayback(new NativeEngine(host),()=>undefined,e=>{throw e;},async()=>'C:/DI.sfz',async model=>{models.push(model);return `{"model":"${model}"}`;});
 const loading:boolean[]=[];playback.onLoading=()=>loading.push(playback.isLoading(0));
 const s=score(),n=trackAudio(s.tracks[0]).nam;n.enabled=true;n.model='fender-super';n.bass=3;
 const settle=()=>new Promise(r=>setTimeout(r,10));
 playback.sync(s);await settle();
 assert.deepEqual(sent,[{header:{index:0,key:'fender-super'},json:'{"model":"fender-super"}'}]);assert.ok(loading.includes(true)&&loading.at(-1)===false,'loading while the model and Guitar DI load: '+loading);
 assert.deepEqual([...calls].reverse().find(c=>(c as {kind?:string;index?:number}).kind==='trackNamTone'&&(c as {index:number}).index===0),{kind:'trackNamTone',index:0,input:0-12,output:-6+12+NAM_MODEL_LEVEL['fender-super'],bass:3,mid:0,treble:0,cabinet:false},'the engine gets the knobs with the DI level trims (input -12 dB, output +12 dB) and the model leveling');
 assert.equal(nativeMix(s,'C:/DI.sfz').sounds[0],'C:/DI.sfz','NAM plays the Guitar DI');
 calls.length=0;playback.sync(s);await settle();
 assert.equal(sent.length,1,'same model: not resent');assert.ok(!calls.some(c=>(c as {kind?:string}).kind==='trackNamTone'),'same knobs: not resent');
 n.treble=-2;playback.sync(s);await settle();
 assert.equal((calls.find(c=>(c as {kind?:string}).kind==='trackNamTone') as {treble:number}).treble,-2);
 n.modelJson='{"imported":1}';playback.sync(s);await settle();
 assert.match((sent.at(-1)!.header as {key:string}).key,/^json:14:/);assert.equal(sent.at(-1)!.json,'{"imported":1}');assert.deepEqual(models,['fender-super'],'imported JSON is sent as is');
 n.enabled=false;playback.sync(s);await settle();
 assert.deepEqual(sent.at(-1),{header:{index:0,key:null},json:''});
});

test('GM guitar tracks with insert FX play the Guitar DI, as MixerAudio does', ()=>{
 const s=score();s.tracks[1].playbackInfo.program=29;trackAudio(s.tracks[1]).fx=[{id:'e',kind:'eq',name:'EQ',enabled:true,amount:.5}];
 const sounds=nativeMix(s,'C:/DI.sfz').sounds;
 assert.equal(sounds[1],'C:/DI.sfz');assert.equal(sounds[0],null,'no FX: GM');
 s.tracks[1].playbackInfo.program=0;assert.equal(nativeMix(s,'C:/DI.sfz').sounds[1],null,'not a guitar program');
});

test('a load records SFZ sounds deferred and the tracks show as loading until the engine built them', async()=>{
 const calls:unknown[]=[];let finishLoad=()=>{};
 const host:EngineHost={invoke:async<T>(command:string,args?:Record<string,unknown>)=>{if(args?.request)calls.push(args.request);return (command==='audio_start'?{sampleRate:48000,device:'x'}:undefined) as T;},
  send:async<T>()=>{await new Promise<void>(r=>{finishLoad=r;});return {tracks:3,endTime:8} as T;},subscribe:async()=>{}};
 const playback=new NativePlayback(new NativeEngine(host),()=>undefined,e=>{throw e;});
 const s=score();trackAudio(s.tracks[2]).sound={kind:'sfz',name:'Bass',path:'C:/bass.sfz'};
 const done=playback.load({division:960,tracks:[{events:[]}]},s);
 await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(calls.find(c=>(c as {kind?:string}).kind==='trackSound'&&(c as {index:number}).index===2),{kind:'trackSound',index:2,sfz:'C:/bass.sfz',deferred:true});
 assert.ok(playback.isLoading(2)&&!playback.isLoading(0),'only the SFZ track waits');
 let ready=false;void playback.ready().then(()=>{ready=true;});await new Promise(r=>setTimeout(r,10));assert.equal(ready,false,'playback waits for the instrument');
 finishLoad();await done;await playback.ready();assert.ok(!playback.isLoading(2));
});

test('loads reach the engine in order: an earlier load held up finding the Guitar DI never replaces a newer song', async()=>{
 const loaded:number[]=[];let findDI:(path:string)=>void=()=>{};
 const host:EngineHost={invoke:async<T>(command:string)=>(command==='audio_start'?{sampleRate:48000,device:'x'}:undefined) as T,
  send:async<T>(command:string,body:Uint8Array)=>{if(command==='audio_load')loaded.push(body.length);return {tracks:3,endTime:8} as T;},subscribe:async()=>{}};
 const playback=new NativePlayback(new NativeEngine(host),()=>undefined,e=>{throw e;},()=>new Promise<string>(r=>{findDI=r;}));
 // The first song has a NAM guitar: its load waits for the Guitar DI lookup.
 const first=score();first.tracks[0].playbackInfo.program=29;trackAudio(first.tracks[0]).nam.enabled=true;
 const older=playback.load({division:960,tracks:[{events:[{type:81,tick:0,track:0,beatsPerMinute:120}]}]},first);
 await new Promise(r=>setTimeout(r,10));
 const newer=playback.load({division:960,tracks:[{events:[]}]},score());
 await new Promise(r=>setTimeout(r,10));
 let ready=false;void playback.ready().then(()=>{ready=true;});await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(loaded,[],'the newer load waits for the one before it');assert.equal(ready,false,'playback waits too');
 findDI('C:/DI.sfz');await older;await newer;await playback.ready();
 // Only the newer song (no events: the shorter list) reaches the engine.
 const sizes:number[]=[];const probe=new NativePlayback(new NativeEngine({...host,send:async<T>(command:string,body:Uint8Array)=>{if(command==='audio_load')sizes.push(body.length);return {tracks:3,endTime:8} as T;}}),()=>undefined,e=>{throw e;});
 await probe.load({division:960,tracks:[{events:[]}]},score());
 assert.deepEqual(loaded,sizes,'the engine got the newer song only');
});

test('a throwing loading listener cannot leave a track loading (NAM moved to another track index)', async()=>{
 const host:EngineHost={invoke:async<T>(command:string)=>(command==='audio_start'?{sampleRate:48000,device:'x'}:undefined) as T,send:async<T>(command:string)=>(command==='audio_nam'?{loaded:true}:{tracks:2,endTime:8}) as T,subscribe:async()=>{}};
 const reports:unknown[]=[];
 const playback=new NativePlayback(new NativeEngine(host),()=>undefined,e=>{reports.push(e);},async()=>'C:/DI.sfz',async model=>`{"model":"${model}"}`);
 // The app's listener redraws track cards, which once threw while a deleted track's card remained.
 playback.onLoading=()=>{throw new TypeError('Invalid value used as weak map key');};
 const s=score(),n=trackAudio(s.tracks[0]).nam;n.enabled=true;n.model='bass-ampeg-svt';n.kind='bass';
 playback.sync(s);await new Promise(r=>setTimeout(r,10));await playback.ready();
 assert.ok(!playback.isLoading(0),'the amp loaded and the track is no longer loading');
 assert.ok(reports.length>0,'the listener error is reported, not thrown into the sync');
});

test('external FX: hosts load once with their saved state, join the chain when ready, bypass keeps them, removal closes them; the editor records the state', async()=>{
 const calls:unknown[]=[],fxCalls:unknown[]=[];let next=0;
 const host:EngineHost={invoke:async<T>(command:string,args?:Record<string,unknown>)=>{if(args?.request)calls.push(args.request);return (command==='audio_start'?{sampleRate:48000,device:'x'}:undefined) as T;},send:async<T>()=>({tracks:3,endTime:8}) as T,subscribe:async()=>{}};
 const effects={load:async(path:string,state?:string)=>{fxCalls.push(['load',path,state]);return {id:`h${++next}`,name:'Amp'};},close:async(id:string)=>{fxCalls.push(['close',id]);},editor:async(id:string)=>{fxCalls.push(['editor',id]);return {state:'NEW'};}};
 const playback=new NativePlayback(new NativeEngine(host),()=>undefined,e=>{throw e;},async()=>undefined,async()=>'{}',effects);
 const s=score(),a=trackAudio(s.tracks[0]);a.fx=[{id:'f1',kind:'external',name:'Amp',enabled:true,amount:1,path:'C:/VST3/Amp.vst3',state:'OLD'}];
 const settle=()=>new Promise(r=>setTimeout(r,10));
 const chains=()=>calls.filter(c=>(c as {kind:string}).kind==='trackFx'&&(c as {index:number}).index===0).map(c=>(c as {fx:unknown}).fx);
 playback.sync(s);
 assert.ok(playback.isLoading(0),'the track waits for its plugin');
 await settle();
 assert.deepEqual(fxCalls,[['load','C:/VST3/Amp.vst3','OLD']]);
 assert.deepEqual(chains().at(-1),[{kind:'external',id:'h1',enabled:true}],'joins the chain once loaded');
 a.fx[0].enabled=false;playback.sync(s);await settle();
 assert.deepEqual(chains().at(-1),[{kind:'external',id:'h1',enabled:false}],'bypass keeps the host');
 assert.equal(fxCalls.length,1,'not reloaded for bypass');
 await playback.openEditor(s,0,'f1');
 assert.deepEqual(fxCalls.at(-1),['editor','h1']);assert.equal(a.fx[0].state,'NEW','the edited state is kept for saving');
 playback.sync(s);await settle();assert.equal(fxCalls.filter(c=>(c as string[])[0]==='load').length,1,'its own new state does not reload it');
 a.fx=[];playback.sync(s);await settle();
 assert.deepEqual(fxCalls.at(-1),['close','h1']);assert.deepEqual(chains().at(-1),[]);
});
test('a bass NAM plays the Bass DI (finger unless pick was chosen) and a guitar NAM the Guitar DI',async()=>{
 const {diKind,diSound}=await import('../src/instrument-options');
 const library=[{name:'Guitar DI',path:'C:/g.sfz'},{name:'Bass DI (finger)',path:'C:/finger.sfz'},{name:'Bass DI (pick)',path:'C:/pick.sfz'}];
 const s=at.importer.ScoreLoader.loadAlphaTex('. :4 3.1 r r r',new at.Settings());const t=s.tracks[0],p=trackAudio(t);
 p.nam.enabled=true;p.nam.model='bass-orange-d200';assert.equal(diKind(t,p),'bass');assert.equal(nativeMix(s,library).sounds[0],'C:/finger.sfz');
 p.sound={kind:'sfz',name:'Bass DI (pick)',path:'C:/pick.sfz'};assert.equal(diSound('bass',library,p.sound)?.path,'C:/pick.sfz');assert.equal(nativeMix(s,library).sounds[0],'C:/pick.sfz');
 p.nam.model='fender-super';assert.equal(nativeMix(s,library).sounds[0],'C:/g.sfz');
 p.nam.enabled=false;p.sound={kind:'gm',name:'GeneralUser GS'};t.playbackInfo.program=33;p.fx=[{id:'eq',kind:'eq',name:'EQ',enabled:true,amount:.5}];assert.equal(nativeMix(s,library).sounds[0],'C:/finger.sfz','a GM bass with FX gets the Bass DI');
});

// The real alphaTab sequencer reports floor(time-to-tick) + 1 even on exact boundaries.
test('external seeks include notes at the start and at later beat boundaries',async()=>{
 const {playback,player,calls}=setup();
 await playback.load({division:960,tracks:[{events:[{type:81,tick:0,track:0,beatsPerMinute:120}]}]},score());
 await new Promise(r=>setTimeout(r,0));calls.length=0;
 player.tickPosition=1;playback.handler.seekTo(0);
 player.tickPosition=961;playback.handler.seekTo(500);
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls,[{kind:'seekTick',tick:0},{kind:'seekTick',tick:960}]);
});
