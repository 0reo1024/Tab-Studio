import type {model} from '@coderline/alphatab';
import {masterAudio,trackAudio,NAM_INPUT_TRIM,NAM_OUTPUT_TRIM,namOutputLevel} from '../mixer-state';
import {articulationMap} from '../sfz-articulations';
import {diKind,diSound} from '../instrument-options';
import {externalMediaHandler,type EngineFx,type EngineStatus,type NativeEngine} from './native-engine';
import type {NativeFxAPI} from '../platform/bridge';
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
 * order (built-in kinds); the music bus = 1/sqrt(tracks with volume) with the master reverb
 * switch; master = volume, or 0 when muted. */
/** The DI files known so far: the SFZ library, or just a Guitar DI path. */
export type DiLibrary=string|{name:string;path:string}[];
const diList=(library?:DiLibrary)=>typeof library==='string'?[{name:'Guitar DI',path:library}]:library??[];
export function nativeMix(score:Score,library?:DiLibrary){
 const solo=score.tracks.some(t=>t.playbackInfo.isSolo);
 // As MixerAudio.sync: headroom for every track with volume, so solo/mute keep other tracks' level.
 const audible=score.tracks.filter(t=>t.playbackInfo.volume>0).length;
 const master=masterAudio(score);
 return {
  tracks:score.tracks.map(t=>{const p=trackAudio(t);return {gain:t.playbackInfo.volume/8,pan:(t.playbackInfo.balance-8)/8,mute:t.playbackInfo.isMute,solo:t.playbackInfo.isSolo,send:p.reverb?p.send:0};}),
  // Built-in FX when on; external FX always (off = bypass, as MixerAudio keeps them loaded),
  // named by the mixer's FX id until NativePlayback maps them to loaded hosts.
  fx:score.tracks.map(t=>trackAudio(t).fx.filter(f=>f.enabled||f.kind==='external').map((f):MixFx=>f.kind==='external'?{kind:'external',fxId:f.id,enabled:f.enabled}:{kind:f.kind,amount:f.amount})),
  // NAM amplifies the DI of its amp type, and so do GM guitars/basses with insert FX
  // (as MixerAudio.configure); otherwise an SFZ sound plays its file.
  sounds:score.tracks.map(t=>{const p=trackAudio(t),own=p.sound.kind==='sfz'?p.sound.path??null:null,kind=diKind(t,p);return kind?diSound(kind,diList(library),p.sound)?.path??own:own;}),
  /** Each track's NAM amp: the model key (null: off) and its knobs. */
  nam:score.tracks.map(t=>{const n=trackAudio(t).nam;return {key:n.enabled?namKey(n):null,tone:{input:n.input+NAM_INPUT_TRIM,output:n.output+NAM_OUTPUT_TRIM,bass:n.bass,mid:n.mid,treble:n.treble,cabinet:n.cabinet}};}),
  bus:{gain:1/Math.sqrt(Math.max(1,audible)),reverb:master.reverb},
  master:master.mute?0:master.volume,
 };
}

/** A chain entry from the mixer settings (external FX by their mixer id). */
export type MixFx={kind:'eq'|'compressor'|'delay';amount:number}|{kind:'external';fxId:string;enabled:boolean};
/** Whether MixerAudio.configure gives the track a DI (guitar or bass). */
export function usesDI(t:Score['tracks'][number]){return diKind(t,trackAudio(t))!==null;}
/** Identifies a NAM model: a named one by id, an imported one by a hash of its JSON. */
export function namKey(n:{model:string;modelJson?:string}){
 if(n.modelJson===undefined)return n.model;
 let h=0x811c9dc5;for(let i=0;i<n.modelJson.length;i++){h^=n.modelJson.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
 return `json:${n.modelJson.length}:${h.toString(16)}`;
}

/** Wires the native engine to alphaTab's external-media player and the app's mixer,
 * click and count-in. Used only when the "native audio" setting is on (Tauri). */
export class NativePlayback{
 readonly handler;
 private loading:Promise<unknown>=Promise.resolve();
 private countGeneration=0;
 /** The DI files NAM/FX tracks use (the SFZ library, or a Guitar DI path), once known. */
 private guitarDI:DiLibrary|undefined;private guitarDILookup:Promise<DiLibrary|undefined>|undefined;
 constructor(readonly engine:NativeEngine,private player:()=>unknown,private report:(error:unknown)=>void,private findGuitarDI:()=>Promise<DiLibrary|undefined>=async()=>undefined,private namModel:(model:string)=>Promise<string>=async()=>{throw new Error('NAMモデルを読み込めません。');},private effects?:Pick<NativeFxAPI,'load'|'close'|'editor'>){
  // alphaTab reports floor(time-to-tick) + 1. Seeking to that tick skips boundary notes.
  this.handler=externalMediaHandler(engine,report,()=>{const tick=(this.player() as {tickPosition?:number}|undefined)?.tickPosition;return tick===undefined?undefined:Math.max(0,tick-1);},tick=>{
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
  // Sounds are recorded first and built by the load for the new song's notes; the load
  // returns once they are ready, and SFZ tracks show as loading meanwhile.
  // Loads run one at a time and a newer one supersedes those still waiting: an earlier load
  // held up (finding the Guitar DI, building SFZ instruments) used to reach the engine after
  // the newer song and replace it, so the previous song or the unedited one played.
  const generation=++this.loadGeneration,current=()=>generation===this.loadGeneration;
  this.loading=this.loading.catch(()=>{}).then(()=>current()?this.resolveGuitarDI(score):undefined).then(async()=>{if(!current())return;await Promise.all(this.syncSounds(score,true));if(!current())return;const sfz=nativeMix(score,this.guitarDI).sounds.flatMap((s,i)=>s?[i]:[]);await this.busy(sfz,this.engine.load(file,articulationMap(file as Parameters<typeof articulationMap>[0])));if(!current())return;this.loaded=true;this.sync(score);this.run(this.engine.speed(this.handler.playbackRate));this.loop(this.range);});
  this.loading.catch(this.report);
  return this.loading;
 }
 private loadGeneration=0;
 /** Resolves when the last load reached the engine (playback waits for it). */
 ready(){return this.loading.catch(()=>{}).then(()=>Promise.allSettled([...this.work])).then(()=>{});}
 private fxSent:string[]=[];private soundSent:(string|null)[]=[];
 private async resolveGuitarDI(score:Score){
  if(this.guitarDI&&diList(this.guitarDI).length||!score.tracks.some(usesDI))return;
  this.guitarDILookup??=this.findGuitarDI().catch(()=>undefined);
  this.guitarDI=await this.guitarDILookup;this.guitarDILookup=undefined;
  // Only NAM requires it; GM guitars/basses with FX keep the GM sound without it (as MixerAudio).
  const missing=score.tracks.find(t=>{const p=trackAudio(t),kind=diKind(t,p);return p.nam.enabled&&kind&&!diSound(kind,diList(this.guitarDI),p.sound);});
  if(missing)this.report(new Error(diKind(missing,trackAudio(missing))==='bass'?'ベースのNAMにはBass DI（Fashionbass）の音源が必要ですが、見つかりません。scripts/install-fashionbass.py で登録してください。':'NAMにはStandard Guitar（Guitar DI）の音源が必要ですが、見つかりません。'));
 }
 /** Sends changed track sounds. Deferred: only recorded (the coming load builds them);
  * otherwise the engine builds now and the track shows as loading until it is ready. */
 private syncSounds(score:Score,deferred=false){
  const sent:Promise<unknown>[]=[];
  nativeMix(score,this.guitarDI).sounds.forEach((sfz,index)=>{if(this.soundSent[index]===sfz)return;this.soundSent[index]=sfz;
   const request=this.engine.command({kind:'trackSound',index,sfz,...(deferred?{deferred}:{})});sent.push(request);
   this.run(deferred||sfz===null?request:this.busy([index],request));});
  return sent;
 }
 sync(score:Score){
  const mix=nativeMix(score);
  mix.tracks.forEach((track,index)=>this.run(this.engine.track(index,track)));
  // Rebuilding a chain resets delay/compressor state: only send chains that changed.
  this.syncEffects(score);
  mix.fx.forEach((list,index)=>{
   // External FX enter the chain once their host is loaded (loading resends the chain).
   const fx:EngineFx[]=list.flatMap((f):EngineFx[]=>{if(f.kind!=='external')return [f];const id=this.effectHosts.get(f.fxId)?.id;return id?[{kind:'external',id,enabled:f.enabled}]:[];});
   const key=JSON.stringify(fx);if(this.fxSent[index]!==key){this.fxSent[index]=key;this.run(this.engine.command({kind:'trackFx',index,fx}));}
  });
  this.run(this.engine.command({kind:'bus',...mix.bus}));
  // A sound change (SFZ loaded, NAM switched) may need the Guitar DI first.
  void this.resolveGuitarDI(score).then(()=>{this.syncSounds(score);});
  this.syncNam(score);
  this.run(this.engine.master(mix.master));
 }
 /** Effect hosts by mixer FX id: loaded once and kept while the FX stays (bypass too). */
 private effectHosts=new Map<string,{path:string;state?:string;id?:string;loading?:Promise<void>}>();
 private lastScore:Score|undefined;
 /** Loads hosts for new external FX (with their saved state) and closes removed ones. */
 private syncEffects(score:Score){
  this.lastScore=score;
  if(!this.effects)return;
  const wanted=new Map<string,{path:string;state?:string;track:number}>();
  score.tracks.forEach((t,track)=>{for(const f of trackAudio(t).fx)if(f.kind==='external'&&f.path)wanted.set(f.id,{path:f.path,state:f.state,track});});
  for(const [fxId,host] of this.effectHosts)if(!wanted.has(fxId)||wanted.get(fxId)!.path!==host.path||wanted.get(fxId)!.state!==host.state){this.effectHosts.delete(fxId);if(host.id)this.run(this.effects.close(host.id));else void host.loading?.then(()=>{if(host.id)return this.effects!.close(host.id);});}
  for(const [fxId,want] of wanted){
   if(this.effectHosts.has(fxId))continue;
   const host:{path:string;state?:string;id?:string;loading?:Promise<void>}={path:want.path,state:want.state};this.effectHosts.set(fxId,host);
   host.loading=this.busy([want.track],this.effects.load(want.path,want.state).then(loaded=>{
    if(this.effectHosts.get(fxId)!==host){void this.effects!.close(loaded.id);return;}
    host.id=loaded.id;this.fxSent=[];if(this.lastScore)this.sync(this.lastScore);
   })).catch(error=>{if(this.effectHosts.get(fxId)===host)this.effectHosts.delete(fxId);this.report(error);});
  }
 }
 /** Opens an external FX editor; resolves with the state once the user closes it (as
  * MixerAudio.openEditor: the plugin keeps running, the state is only recorded). */
 async openEditor(score:Score,index:number,fxId:string){
  this.syncEffects(score);
  const host=this.effectHosts.get(fxId),fx=trackAudio(score.tracks[index]).fx.find(f=>f.id===fxId);
  await host?.loading;
  if(!host?.id||!fx||!this.effects)throw new Error('FXを読み込めませんでした。');
  const result=await this.effects.editor(host.id);
  if(this.effectHosts.get(fxId)===host)fx.state=host.state=result.state;
 }
 private namSent:(string|null)[]=[];private toneSent:string[]=[];
 /** Output normalization per model key, known once its JSON has been read. */
 private namNorm=new Map<string,number>();
 /** The NAM amps: a model goes to the engine when a track's key changes (loading it takes a
  * moment, so the track's loading state shows meanwhile); the knobs whenever they change. */
 private syncNam(score:Score){
  nativeMix(score).nam.forEach(({key,tone},index)=>{
   const sendTone=()=>{const leveled={...tone,output:tone.output+(key!==null?this.namNorm.get(key)??0:0)},toneKey=JSON.stringify(leveled);if(this.toneSent[index]!==toneKey){this.toneSent[index]=toneKey;this.run(this.engine.command({kind:'trackNamTone',index,...leveled}));}};
   sendTone();
   if((this.namSent[index]??null)===key)return;this.namSent[index]=key;
   if(key===null){this.run(this.engine.nam(index,null));return;}
   const n=trackAudio(score.tracks[index]).nam;
   this.run(this.busy([index],(async()=>{try{const json=n.modelJson??await this.namModel(n.model);this.namNorm.set(key,namOutputLevel(n));if(this.namSent[index]===key){sendTone();await this.engine.nam(index,key,json);}}catch(e){if(this.namSent[index]===key)this.namSent[index]=null;throw e;}})()));
  });
 }
 /** Tracks waiting for an SFZ instrument or a NAM model (counted: both can be pending). */
 private pending=new Map<number,number>();private work=new Set<Promise<unknown>>();
 private busy<T>(tracks:number[],work:Promise<T>){
  if(!tracks.length)return work;
  // Playback waits for these too (ready()), as MixerAudio waits for NAM and SFZ.
  this.work.add(work);work.then(()=>this.work.delete(work),()=>this.work.delete(work));
  for(const i of tracks)this.pending.set(i,(this.pending.get(i)??0)+1);
  // The count is released before anything else runs: a throwing listener must not leave a
  // track loading for good (the play button then stayed on "NAM読み込み中").
  const done=work.finally(()=>{for(const i of tracks){const n=(this.pending.get(i)??1)-1;if(n>0)this.pending.set(i,n);else this.pending.delete(i);}this.loadingChanged();});
  this.loadingChanged();return done;
 }
 private loadingChanged(){try{this.onLoading();}catch(e){this.report(e);}}
 /** Called when a track starts or stops loading its NAM model. */
 onLoading=()=>{};
 isLoading(index:number){return this.pending.has(index);}
 click(on:boolean,kind:ClickKind,volume:number){this.run(this.engine.metronome(on,kind,volume));}
 /** The standalone metronome in the engine (same interface as ClickAudio.free). */
 free(plan:{interval:number;beats:number}|null){this.run(this.engine.command({kind:'freeClick',interval:plan?.interval??null,...(plan?{beats:plan.beats}:{})}));}
 /** Loop ranges are in ticks of the loaded song; one set before the first load is sent after it. */
 loop(range:{startTick:number;endTick:number}|null){this.range=range?{startTick:range.startTick,endTick:range.endTick}:null;this.sendLoop();}
 /** "Count each loop": the engine counts in from the loop end on every wrap, on the beat
  * (null: wrap straight on). Kept with the range and resent after every song load. */
 loopCount(pattern:CountPattern|null){this.loopPattern=pattern;this.sendLoop();}
 private loopPattern:CountPattern|null=null;
 private sendLoop(){if(!this.loaded)return;const range=this.range,count=range&&this.loopPattern?{ticks:this.loopPattern.ticks.map((t):[number,boolean]=>[t.offset,t.accent]),duration:this.loopPattern.duration}:null;this.run(this.engine.command({kind:'loopTicks',start:range?.startTick??null,end:range?.endTick??null,count}));}
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
