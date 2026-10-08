export const clickKinds=['standard','wood','rim','hat','beep'] as const;
export type ClickKind=typeof clickKinds[number];
/** Deterministic short PCM clicks. No per-beat timers or external assets. */
export function clickWave(kind:Exclude<ClickKind,'standard'>,accent:boolean,rate:number){
  const duration=kind==='hat'?.065:.09,pcm=new Float32Array(Math.ceil(rate*duration));let seed=8735;
  for(let i=0;i<pcm.length;i++){const t=i/rate;seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=seed/2147483648-1;
    const freq=(kind==='beep'?accent?1500:1000:kind==='wood'?accent?1200:850:accent?1900:1400);
    const envelope=Math.min(1,t/.0007)*Math.exp(-t/(kind==='beep'?.018:kind==='wood'?.012:.009));
    const wave=kind==='hat'?noise:kind==='rim'?.65*noise+.35*Math.sin(2*Math.PI*freq*t):kind==='wood'?.75*Math.sin(2*Math.PI*freq*t)+.25*Math.sin(2*Math.PI*freq*1.47*t):Math.sin(2*Math.PI*freq*t);
    pcm[i]=wave*envelope*(accent?.65:.5);
  }return pcm;
}
export class ClickAudio{
  private context:AudioContext|undefined;private volume=0.65;private enabled=false;private kind:ClickKind='wood';private sources=new Set<AudioBufferSourceNode>();private gain:GainNode|undefined;private cache=new Map<string,AudioBuffer>();
  private destination?:AudioNode;
  attach(context:AudioContext,destination:AudioNode=context.destination){if(this.context===context&&this.gain&&this.destination===destination)return;this.stop();this.gain?.disconnect();this.context=context;this.destination=destination;this.gain=context.createGain();this.gain.gain.value=this.enabled?this.volume:0;this.gain.connect(destination);this.cache.clear();}
  configure(enabled:boolean,kind:ClickKind,volume:number){this.enabled=enabled;this.kind=kind;this.volume=volume;if(this.gain&&this.context)this.gain.gain.setTargetAtTime(enabled?volume:0,this.context.currentTime,.005);if(!enabled)this.stop();}
  async resume(){await this.context?.resume();}
  stop(){for(const s of this.sources){try{s.stop();}catch{}}this.sources.clear();}
  tick(accent:boolean){
    const ctx=this.context;if(!ctx||!this.gain||!this.enabled||this.kind==='standard'||ctx.state!=='running')return;
    const key=this.kind+accent;let buffer=this.cache.get(key);if(!buffer){const pcm=clickWave(this.kind,accent,ctx.sampleRate);buffer=ctx.createBuffer(1,pcm.length,ctx.sampleRate);buffer.copyToChannel(pcm,0);this.cache.set(key,buffer);}
    const source=ctx.createBufferSource();source.buffer=buffer;source.connect(this.gain);this.sources.add(source);source.onended=()=>{source.disconnect();this.sources.delete(source);};source.start(ctx.currentTime);
  }
  preview(){this.tick(true);}
  /** Schedule the whole count on the audio clock. UI frames only display it. */
  async count(pattern:{duration:number;ticks:{offset:number;accent:boolean;remaining:number}[]},cancelled:()=>boolean,display:(remaining:number)=>void){
    await this.resume();const ctx=this.context;if(!ctx||ctx.state!=='running')throw new Error('音源の準備ができていません。');
    const start=ctx.currentTime+.04,end=start+pattern.duration,gain=ctx.createGain();gain.gain.value=this.volume;gain.connect(this.destination??ctx.destination);const sources:AudioBufferSourceNode[]=[];
    const kind=this.kind==='standard'?'wood':this.kind;
    for(const t of pattern.ticks){const source=ctx.createBufferSource(),pcm=clickWave(kind,t.accent,ctx.sampleRate),buffer=ctx.createBuffer(1,pcm.length,ctx.sampleRate);buffer.copyToChannel(pcm,0);source.buffer=buffer;source.connect(gain);source.start(start+t.offset);sources.push(source);this.sources.add(source);source.onended=()=>{source.disconnect();this.sources.delete(source);};}
    try{return await new Promise<boolean>(resolve=>{let shown=-1;const update=()=>{if(cancelled()){resolve(false);return;}const now=ctx.currentTime;if(now>=end){resolve(true);return;}const current=[...pattern.ticks].reverse().find(t=>start+t.offset<=now)??pattern.ticks[0];if(current&&shown!==current.remaining){shown=current.remaining;display(shown);}requestAnimationFrame(update);};update();});}finally{for(const s of sources){try{s.stop();}catch{}this.sources.delete(s);}gain.disconnect();}
  }
}
