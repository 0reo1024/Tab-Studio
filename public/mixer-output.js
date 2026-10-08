/* A single clock and queue for all track channels, including metronome. */
class StudioOutput extends AudioWorkletProcessor {
 constructor(){super();this.queue=[];this.offset=0;this.pending=0;this.stopped=false;this.played=0;this.queued=0;this.primed=false;this.ended=false;this.epoch=0;this.underrun=0;
  this.port.onmessage=({data:d})=>{if(d.cmd==='add'){if(d.epoch!==undefined&&d.epoch!==this.epoch)return;this.pending=Math.max(0,this.pending-1);if(d.frames){this.queue.push(d);this.queued+=d.frames;}else this.ended=true;}else if(d.cmd==='reset'){this.epoch=d.epoch??this.epoch+1;this.queue=[];this.offset=0;this.queued=0;this.primed=false;this.pending=0;this.played=0;this.ended=false;this.underrun=0;}else if(d.cmd==='stop')this.stopped=true;};
 }
 process(inputs,outputs){
  const count=outputs[0]?.[0]?.length??128;let done=0;
  // Prime a short reserve before advancing the clock; keep native sample IPC ahead of playback.
  if(this.queued>=32768||this.stopped||this.ended)this.primed=true;
  while(this.primed&&done<count&&this.queue.length){const q=this.queue[0],n=Math.min(count-done,q.frames-this.offset);
   for(const [index,pcm]of q.stems){const out=outputs[index];if(!out)continue;for(let j=0;j<n;j++){out[0][done+j]=pcm[(this.offset+j)*2];out[1][done+j]=pcm[(this.offset+j)*2+1];}}
   done+=n;this.offset+=n;this.queued-=n;if(this.offset>=q.frames){this.queue.shift();this.offset=0;}
  }
  if(this.primed&&!this.stopped&&!this.ended&&done<count)this.underrun+=count-done;else if(this.underrun){this.port.postMessage({cmd:'underrun',epoch:this.epoch,frames:this.underrun});this.underrun=0;}
  this.played+=done;if(this.played>=1024||((this.stopped||this.ended&&!this.queued)&&this.played)){this.port.postMessage({cmd:'played',epoch:this.epoch,frames:this.played});this.played=0;}
  while(!this.stopped&&!this.ended&&this.queued+this.pending*2048<65536){this.pending++;this.port.postMessage({cmd:'request',epoch:this.epoch});}
  return !this.stopped||this.queue.length>0;
 }
}
registerProcessor('studio-output',StudioOutput);
