import type {model} from '@coderline/alphatab';
import {masterAudio,trackAudio} from '../mixer-state';
import {articulationMap} from '../sfz-articulations';
import {externalMediaHandler,type EngineStatus,type NativeEngine} from './native-engine';
import type {ClickKind} from '../metronome';
type Score=model.Score;
type ExternalOutput={handler?:unknown;updatePosition(milliseconds:number):void};
type CountPattern={duration:number;ticks:{offset:number;accent:boolean;remaining:number}[]};
type MidiFile=Parameters<NativeEngine['load']>[0];

/** Song seconds of a MIDI tick from the file's tempo events (like the engine's tempo map). */
export function tempoMap(file:MidiFile){
 const tempos=file.tracks.flatMap(t=>t.events).filter(e=>e.type===81).sort((a,b)=>a.tick-b.tick);
 const points:{tick:number;time:number;perTick:number}[]=[{tick:0,time:0,perTick:60/(120*file.division)}];
 for(const e of tempos){const last=points.at(-1)!,time=last.time+(e.tick-last.tick)*last.perTick,perTick=60/((e.beatsPerMinute??120)*file.division);if(e.tick===last.tick)last.perTick=perTick;else points.push({tick:e.tick,time,perTick});}
 return (tick:number)=>{let p=points[0];for(const q of points)if(q.tick<=tick)p=q;return p.time+(tick-p.tick)*p.perTick;};
}

/** The mixer law of MixerAudio.sync/configure as engine settings: track gain = volume / 8,
 * pan = (balance - 8) / 8, reverb send = send when the track's reverb is on, insert FX in
 * order (built-in kinds); the music bus = 1/sqrt(audible tracks) with the master reverb
 * switch; master = volume, or 0 when muted. */
export function nativeMix(score:Score,guitarDI?:string){
 const solo=score.tracks.some(t=>t.playbackInfo.isSolo);
 const audible=score.tracks.filter(t=>!t.playbackInfo.isMute&&(!solo||t.playbackInfo.isSolo)&&t.playbackInfo.volume>0).length;
 const master=masterAudio(score);
 return {
  tracks:score.tracks.map(t=>{const p=trackAudio(t);return {gain:t.playbackInfo.volume/8,pan:(t.playbackInfo.balance-8)/8,mute:t.playbackInfo.isMute,solo:t.playbackInfo.isSolo,send:p.reverb?p.send:0};}),
  fx:score.tracks.map(t=>trackAudio(t).fx.filter(f=>f.enabled&&f.kind!=='external').map(f=>({kind:f.kind as 'eq'|'compressor'|'delay',amount:f.amount}))),
  // NAM always amplifies the Standard Guitar DI (as MixerAudio.configure); otherwise an SFZ sound plays its file.
  sounds:score.tracks.map(t=>{const p=trackAudio(t);return p.nam.enabled?guitarDI??null:p.sound.kind==='sfz'?p.sound.path??null:null;}),
  bus:{gain:1/Math.sqrt(Math.max(1,audible)),reverb:master.reverb},
  master:master.mute?0:master.volume,
 };
}

/** Wires the native engine to alphaTab's external-media player and the app's mixer,
 * click and count-in. Used only when the "native audio" setting is on (Tauri). */
export class NativePlayback{
 readonly handler;
 private loading:Promise<unknown>=Promise.resolve();
 private countGeneration=0;
 /** The Standard Guitar DI file NAM tracks use (from the SFZ library), once known. */
 private guitarDI:string|undefined;private guitarDILookup:Promise<string|undefined>|undefined;
 constructor(readonly engine:NativeEngine,private player:()=>unknown,private report:(error:unknown)=>void,private findGuitarDI:()=>Promise<string|undefined>=async()=>undefined){
  this.handler=externalMediaHandler(engine,report,()=>(this.player() as {tickPosition?:number}|undefined)?.tickPosition,tick=>{
   // alphaTab answers a loop end with a seek to the loop start; the engine is already there.
   if(this.echoSeek===tick){this.echoSeek=undefined;return true;}return false;
  });
  engine.onStatus(status=>this.follow(status));
 }
 private echoSeek:number|undefined;
 private wraps=0;private finished=0;
 private range:{startTick:number;endTick:number}|null=null;
 private loaded=false;
 private seconds:((tick:number)=>number)|undefined;
 /** Forwards the engine clock to alphaTab while both play. When the engine stopped at the
  * song end, or wrapped a loop, alphaTab gets the end position once so its own finish/loop
  * handling (playerFinished: trainer, count each loop) runs as with the built-in synth.
  * The loop end is passed 2 ms late so rounding cannot leave alphaTab just before it. */
 private follow(status:EngineStatus){
  const output=this.output(),alphaTabPlaying=(this.player() as {state?:number}|undefined)?.state===1;
  const wrapped=status.wraps>this.wraps,finished=status.finished>this.finished;this.wraps=status.wraps;this.finished=status.finished;
  if(!output||!alphaTabPlaying)return;
  if(wrapped&&this.range&&this.seconds){this.echoSeek=this.range.startTick;output.updatePosition(this.handler.positionMs(this.seconds(this.range.endTick)+.002));return;}
  if(status.playing||finished)output.updatePosition(this.handler.positionMs(status.position));
 }
 private output(){return (this.player() as {output?:ExternalOutput}|undefined)?.output;}
 /** Call when alphaTab's player is (re)created. */
 attach(){const output=this.output();if(output&&output.handler!==this.handler)output.handler=this.handler;}
 private run(action:Promise<unknown>){void action.catch(this.report);}
 /** The MIDI the app plays (after its midiLoad adjustments). */
 load(file:Parameters<NativeEngine['load']>[0],score:Score){
  this.seconds=tempoMap(file);this.fxSent=[];
  // A reload replaces the engine's song: resend what belongs to the transport.
  // Track sounds go first: the engine loads SFZ instruments for the new song's notes.
  this.loading=this.resolveGuitarDI(score).then(()=>{this.syncSounds(score);return this.engine.load(file,articulationMap(file as Parameters<typeof articulationMap>[0]));}).then(()=>{this.loaded=true;this.sync(score);this.run(this.engine.speed(this.handler.playbackRate));this.loop(this.range);});
  this.loading.catch(this.report);
  return this.loading;
 }
 /** Resolves when the last load reached the engine (playback waits for it). */
 ready(){return this.loading.catch(()=>{});}
 private fxSent:string[]=[];private soundSent:(string|null)[]=[];
 private async resolveGuitarDI(score:Score){
  if(this.guitarDI||!score.tracks.some(t=>trackAudio(t).nam.enabled))return;
  this.guitarDILookup??=this.findGuitarDI().catch(()=>undefined);
  this.guitarDI=await this.guitarDILookup;this.guitarDILookup=undefined;
  if(!this.guitarDI)this.report(new Error('NAMにはStandard Guitar（Guitar DI）の音源が必要ですが、見つかりません。'));
 }
 private syncSounds(score:Score){
  nativeMix(score,this.guitarDI).sounds.forEach((sfz,index)=>{if(this.soundSent[index]!==sfz){this.soundSent[index]=sfz;this.run(this.engine.command({kind:'trackSound',index,sfz}));}});
 }
 sync(score:Score){
  const mix=nativeMix(score);
  mix.tracks.forEach((track,index)=>this.run(this.engine.track(index,track)));
  // Rebuilding a chain resets delay/compressor state: only send chains that changed.
  mix.fx.forEach((fx,index)=>{const key=JSON.stringify(fx);if(this.fxSent[index]!==key){this.fxSent[index]=key;this.run(this.engine.command({kind:'trackFx',index,fx}));}});
  this.run(this.engine.command({kind:'bus',...mix.bus}));
  // A sound change (SFZ loaded, NAM switched) may need the Guitar DI first.
  void this.resolveGuitarDI(score).then(()=>this.syncSounds(score));
  this.run(this.engine.master(mix.master));
 }
 click(on:boolean,kind:ClickKind,volume:number){this.run(this.engine.metronome(on,kind,volume));}
 /** Loop ranges are in ticks of the loaded song; one set before the first load is sent after it. */
 loop(range:{startTick:number;endTick:number}|null){this.range=range?{startTick:range.startTick,endTick:range.endTick}:null;if(!this.loaded)return;this.run(this.engine.command({kind:'loopTicks',start:range?.startTick??null,end:range?.endTick??null}));}
 /** Count-in with the engine's clicks (same interface as ClickAudio.count). */
 async count(pattern:CountPattern,cancelled:()=>boolean,display:(remaining:number)=>void){
  const generation=++this.countGeneration;
  await this.engine.countIn(pattern.ticks.map(t=>({offset:t.offset,accent:t.accent})),pattern.duration);
  const start=performance.now();
  return new Promise<boolean>(resolve=>{let shown=-1;const update=()=>{
   if(generation!==this.countGeneration){resolve(false);return;}
   if(cancelled()){this.stop();resolve(false);return;}
   const elapsed=(performance.now()-start)/1000;if(elapsed>=pattern.duration){resolve(true);return;}
   const current=[...pattern.ticks].reverse().find(t=>t.offset<=elapsed)??pattern.ticks[0];
   if(current&&shown!==current.remaining){shown=current.remaining;display(shown);}
   requestAnimationFrame(update);
  };update();});
 }
 /** Meter values in MixerAudio.peaks() shape, from the latest engine status. */
 peaks(){const s=this.engine.status;return {click:s?.clickPeak??0,tracks:s?.peaks??[],master:Math.max(...(s?.master??[0,0]))};}
 stop(){this.countGeneration++;if(this.engine.status?.counting)this.run(this.engine.pause());}
}
