import type {model} from '@coderline/alphatab';
import {masterAudio} from '../mixer-state';
import {externalMediaHandler,type NativeEngine} from './native-engine';
import type {ClickKind} from '../metronome';
type Score=model.Score;
type ExternalOutput={handler?:unknown;updatePosition(milliseconds:number):void};
type CountPattern={duration:number;ticks:{offset:number;accent:boolean;remaining:number}[]};

/** The mixer law of MixerAudio.sync, as engine track settings: gain = volume / 8 scaled by
 * 1/sqrt(audible tracks) (the music bus), pan = (balance - 8) / 8; master = volume or 0. */
export function nativeMix(score:Score){
 const solo=score.tracks.some(t=>t.playbackInfo.isSolo);
 const audible=score.tracks.filter(t=>!t.playbackInfo.isMute&&(!solo||t.playbackInfo.isSolo)&&t.playbackInfo.volume>0).length;
 const bus=1/Math.sqrt(Math.max(1,audible)),master=masterAudio(score);
 return {
  tracks:score.tracks.map(t=>({gain:t.playbackInfo.volume/8*bus,pan:(t.playbackInfo.balance-8)/8,mute:t.playbackInfo.isMute,solo:t.playbackInfo.isSolo})),
  master:master.mute?0:master.volume,
 };
}

/** Wires the native engine to alphaTab's external-media player and the app's mixer,
 * click and count-in. Used only when the "native audio" setting is on (Tauri). */
export class NativePlayback{
 readonly handler;
 private loading:Promise<unknown>=Promise.resolve();
 private wasPlaying=false;
 private countGeneration=0;
 constructor(readonly engine:NativeEngine,private player:()=>unknown,private report:(error:unknown)=>void){
  this.handler=externalMediaHandler(engine,report,()=>(this.player() as {tickPosition?:number}|undefined)?.tickPosition);
  // Forward the engine clock while it plays, plus the final position when it stops
  // (alphaTab then detects the song end). Paused seeks are alphaTab's own.
  engine.onStatus(status=>{const output=this.output();if(output&&(status.playing||this.wasPlaying))output.updatePosition(this.handler.positionMs(status.position));this.wasPlaying=status.playing;});
 }
 private output(){return (this.player() as {output?:ExternalOutput}|undefined)?.output;}
 /** Call when alphaTab's player is (re)created. */
 attach(){const output=this.output();if(output&&output.handler!==this.handler)output.handler=this.handler;}
 private run(action:Promise<unknown>){void action.catch(this.report);}
 /** The MIDI the app plays (after its midiLoad adjustments). */
 load(file:Parameters<NativeEngine['load']>[0],score:Score){
  this.loading=this.engine.load(file).then(()=>this.sync(score));
  this.loading.catch(this.report);
  return this.loading;
 }
 /** Resolves when the last load reached the engine (playback waits for it). */
 ready(){return this.loading.catch(()=>{});}
 sync(score:Score){const mix=nativeMix(score);mix.tracks.forEach((track,index)=>this.run(this.engine.track(index,track)));this.run(this.engine.master(mix.master));}
 click(on:boolean,kind:ClickKind,volume:number){this.run(this.engine.metronome(on,kind,volume));}
 loop(range:{startTick:number;endTick:number}|null){this.run(this.engine.command({kind:'loopTicks',start:range?.startTick??null,end:range?.endTick??null}));}
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
