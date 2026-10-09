/* A single clock and queue for all track channels, including metronome.
 * Two feeds share it: packets relayed by the main thread (with an epoch), or, on
 * the direct route, packets from the synth worker over a MessagePort. The direct
 * route also routes channels to track outputs and renders the click here, so
 * no audio sample passes through the main thread. */
function clickWave(kind,accent,rate){
 const duration=kind==='hat'?.065:.09,pcm=new Float32Array(Math.ceil(rate*duration));let seed=8735;
 for(let i=0;i<pcm.length;i++){const t=i/rate;seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=seed/2147483648-1;
  const freq=(kind==='beep'?accent?1500:1000:kind==='wood'?accent?1200:850:accent?1900:1400);
  const envelope=Math.min(1,t/.0007)*Math.exp(-t/(kind==='beep'?.018:kind==='wood'?.012:.009));
  const wave=kind==='hat'?noise:kind==='rim'?.65*noise+.35*Math.sin(2*Math.PI*freq*t):kind==='wood'?.75*Math.sin(2*Math.PI*freq*t)+.25*Math.sin(2*Math.PI*freq*1.47*t):Math.sin(2*Math.PI*freq*t);
  pcm[i]=wave*envelope*(accent?.65:.5);
 }return pcm;
}
class StudioOutput extends AudioWorkletProcessor {
 constructor(){super();this.queue=[];this.offset=0;this.pending=0;this.stopped=false;this.played=0;this.queued=0;this.primed=false;this.ended=false;this.epoch=0;this.underrun=0;
  this.worker=null;this.routing=new Map();this.clickIndex=-1;this.click={on:false,kind:'wood',volume:.65};this.voices=[];this.waves=new Map();
  this.port.onmessage=({data:d})=>{if(d.cmd==='add'){if(d.epoch!==undefined&&d.epoch!==this.epoch)return;this.pending=Math.max(0,this.pending-1);if(d.frames){this.queue.push(d);this.queued+=d.frames;}else this.ended=true;}else if(d.cmd==='reset'){this.epoch=d.epoch??this.epoch+1;this.clear();}else if(d.cmd==='stop')this.stopped=true;
   else if(d.cmd==='direct'){this.worker=d.port;this.worker.onmessage=({data:m})=>this.direct(m);}
   else if(d.cmd==='relay'){this.worker?.close();this.worker=null;this.pending=0;}
   else if(d.cmd==='routing'){this.routing=new Map(d.map);this.clickIndex=d.clickIndex;this.click=d.click;if(!this.click.on||this.click.kind==='standard')this.voices=[];}};
 }
 clear(){this.queue=[];this.offset=0;this.queued=0;this.primed=false;this.pending=0;this.played=0;this.ended=false;this.underrun=0;this.voices=[];}
 /** Worker packet: sum channels into track outputs; metronome events become click voices. */
 direct(m){
  if(m.cmd==='reset'){this.clear();return;}if(m.cmd!=='add')return;
  this.pending=Math.max(0,this.pending-1);if(!m.frames){this.ended=true;return;}
  const synthClick=this.click.kind==='standard',routed=new Map();
  for(const [channel,pcm]of m.stems){const index=this.routing.get(channel)??this.clickIndex;if(index===this.clickIndex&&!synthClick)continue;const sum=routed.get(index);if(!sum){routed.set(index,pcm);continue;}const total=new Float32Array(Math.max(sum.length,pcm.length));total.set(sum);for(let j=0;j<pcm.length;j++)total[j]+=pcm[j];routed.set(index,total);}
  const clicks=this.click.on&&!synthClick?m.midi.filter(e=>e.isMetronome).map(e=>({accent:e.metronomeNumerator===0,at:e.delay})):null;
  this.queue.push({frames:m.frames,stems:[...routed],clicks});this.queued+=m.frames;
 }
 wave(accent){const key=this.click.kind+accent;let pcm=this.waves.get(key);if(!pcm){pcm=clickWave(this.click.kind,accent,sampleRate);this.waves.set(key,pcm);}return pcm;}
 process(inputs,outputs){
  const count=outputs[0]?.[0]?.length??128;let done=0;
  // Prime a short reserve before advancing the clock; keep native sample IPC ahead of playback.
  if(this.queued>=32768||this.stopped||this.ended)this.primed=true;
  while(this.primed&&done<count&&this.queue.length){const q=this.queue[0],n=Math.min(count-done,q.frames-this.offset);
   for(const [index,pcm]of q.stems){const out=outputs[index];if(!out)continue;for(let j=0;j<n;j++){out[0][done+j]=pcm[(this.offset+j)*2];out[1][done+j]=pcm[(this.offset+j)*2+1];}}
   if(q.clicks){
    if(this.offset===0)for(const c of q.clicks)this.voices.push({pcm:this.wave(c.accent),position:-c.at});
    const out=outputs[this.clickIndex],volume=this.click.volume;
    if(out)for(let j=0;j<n;j++){out[0][done+j]=0;out[1][done+j]=0;}
    for(const voice of this.voices){if(out)for(let j=0;j<n;j++){const p=voice.position+j;if(p>=0&&p<voice.pcm.length){const v=voice.pcm[p]*volume;out[0][done+j]+=v;out[1][done+j]+=v;}}voice.position+=n;}
    this.voices=this.voices.filter(v=>v.position<v.pcm.length);
   }
   done+=n;this.offset+=n;this.queued-=n;if(this.offset>=q.frames){this.queue.shift();this.offset=0;}
  }
  if(this.primed&&!this.stopped&&!this.ended&&done<count)this.underrun+=count-done;else if(this.underrun){this.port.postMessage({cmd:'underrun',epoch:this.epoch,frames:this.underrun});this.underrun=0;}
  this.played+=done;if(this.played>=1024||((this.stopped||this.ended&&!this.queued)&&this.played)){if(this.worker)this.worker.postMessage({cmd:'played',frames:this.played});else this.port.postMessage({cmd:'played',epoch:this.epoch,frames:this.played});this.played=0;}
  while(!this.stopped&&!this.ended&&this.queued+this.pending*2048<65536){this.pending++;if(this.worker)this.worker.postMessage({cmd:'request'});else this.port.postMessage({cmd:'request',epoch:this.epoch});}
  return !this.stopped||this.queue.length>0;
 }
}
registerProcessor('studio-output',StudioOutput);
