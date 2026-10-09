import {eventListFromMidi,type MidiLikeEvent} from './event-list';
/** Client for the native audio engine (src-tauri/src/audio.rs). Song positions are
 * seconds at playback speed 1 ("song time"); alphaTab's external-media time axis is
 * milliseconds already divided by the playback speed (spike S5), so the handler
 * converts between the two. */
export type EngineStatus={position:number;playing:boolean;counting:boolean;finished:number;wraps:number;frames:number;peaks:number[];clickPeak:number;master:[number,number]};
export type EngineRequest=
 {kind:'play'}|{kind:'pause'}|{kind:'seek';seconds:number}|{kind:'seekTick';tick:number}|{kind:'speed';value:number}|
 {kind:'loop';start:number|null;end:number|null}|
 /** Loop in MIDI ticks (alphaTab playbackRange); the engine converts with its tempo map. */
 {kind:'loopTicks';start:number|null;end:number|null}|
 {kind:'track';index:number;gain:number;pan:number;mute:boolean;solo:boolean}|
 {kind:'master';gain:number}|
 {kind:'metronome';enabled:boolean;sound:number;volume:number}|
 {kind:'countIn';ticks:[number,boolean][];duration:number};
export type EngineHost={
 invoke:<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
 /** Sends a raw body (large ones in pieces). */
 send:<T>(command:string,body:Uint8Array)=>Promise<T>;
 /** Starts pushing status snapshots to `listener`. */
 subscribe:(listener:(status:EngineStatus)=>void)=>Promise<void>;
};
/** Metronome sounds in the engine's numbering (crates/tabstudio-audio/src/click.rs). */
export const clickSound={standard:0,wood:1,rim:2,hat:3,beep:4} as const;
type MidiFile={division:number;tickShift?:number;tracks:{events:MidiLikeEvent[]}[]};
export class NativeEngine{
 status:EngineStatus|undefined;endTime=0;sampleRate=0;device='';
 private listeners=new Set<(status:EngineStatus)=>void>();
 private starting:Promise<void>|undefined;
 constructor(private host:EngineHost){}
 start(){
  return this.starting??=(async()=>{
   const info=await this.host.invoke<{sampleRate:number;device:string}>('audio_start');this.sampleRate=info.sampleRate;this.device=info.device;
   await this.host.subscribe(status=>{this.status=status;for(const listener of this.listeners)listener(status);});
  })().catch(error=>{this.starting=undefined;throw error;});
 }
 onStatus(listener:(status:EngineStatus)=>void){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
 async load(midi:MidiFile){await this.start();const result=await this.host.send<{tracks:number;endTime:number}>('audio_load',eventListFromMidi(midi));this.endTime=result.endTime;return result;}
 command(request:EngineRequest){return this.host.invoke<void>('audio_command',{request});}
 play(){return this.command({kind:'play'});}
 pause(){return this.command({kind:'pause'});}
 seek(seconds:number){return this.command({kind:'seek',seconds});}
 speed(value:number){return this.command({kind:'speed',value});}
 loop(range:{start:number;end:number}|null){return this.command({kind:'loop',start:range?.start??null,end:range?.end??null});}
 track(index:number,mix:{gain:number;pan:number;mute:boolean;solo:boolean}){return this.command({kind:'track',index,...mix});}
 master(gain:number){return this.command({kind:'master',gain});}
 metronome(enabled:boolean,sound:keyof typeof clickSound,volume:number){return this.command({kind:'metronome',enabled,sound:clickSound[sound],volume});}
 countIn(ticks:{offset:number;accent:boolean}[],duration:number){return this.command({kind:'countIn',ticks:ticks.map(t=>[t.offset,t.accent]),duration});}
 stop(){this.starting=undefined;return this.host.invoke<void>('audio_stop');}
}
/** alphaTab IExternalMediaHandler backed by the engine. alphaTab owns the transport
 * (play/pause/seek/speed); `positionMs` converts engine status for updatePosition.
 * alphaTab changes its own speed and re-seeks *before* it sets playbackRate here, so a
 * seek in milliseconds would be converted with the old speed. With `tick` (the player's
 * tickPosition, already updated when seekTo runs) the engine seeks by tick instead. */
export function externalMediaHandler(engine:NativeEngine,report:(error:unknown)=>void=()=>{},tick?:()=>number|undefined){
 let rate=1,volume=1;
 const run=(action:Promise<unknown>)=>{void action.catch(report);};
 return {
  get backingTrackDuration(){return engine.endTime*1000/rate;},
  get playbackRate(){return rate;},
  set playbackRate(value:number){rate=value>0?value:1;run(engine.speed(rate));},
  get masterVolume(){return volume;},
  set masterVolume(value:number){volume=value;run(engine.master(value));},
  seekTo(milliseconds:number){const at=tick?.();run(at!==undefined&&Number.isFinite(at)?engine.command({kind:'seekTick',tick:Math.max(0,Math.round(at))}):engine.seek(Math.max(0,milliseconds)*rate/1000));},
  play(){run(engine.play());},
  pause(){run(engine.pause());},
  /** alphaTab's time for an engine position (song seconds). */
  positionMs(songSeconds:number){return songSeconds*1000/rate;},
 };
}
