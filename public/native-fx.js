/* Allow the isolated plugin process enough lead time under UI/CPU pressure. */
const FX_LATENCY=8192;
class NativeFx extends AudioWorkletProcessor {
 constructor(){super();this.frame=0;this.fill=0;this.block=new Float32Array(4096);this.results=new Map();this.failed=false;this.destroyed=false;this.silence=0;this.dry=new Float32Array(FX_LATENCY*2);this.epoch=0;this.wet=0;this.lastL=0;this.lastR=0;this.blockActive=false;
  this.port.onmessage=({data:d})=>{if(d.destroy){this.destroyed=true;this.results.clear();this.block=null;this.dry=null;this.port.onmessage=null;return;}if(d.reset){this.epoch++;this.results.clear();this.dry.fill(0);this.frame=0;this.fill=0;this.silence=0;this.wet=0;return;}if(d.epoch!==this.epoch)return;if(d.error){this.failed=true;return;}if(d.pcm&&d.start+2048>this.frame)this.results.set(d.start,d.pcm);};
 }
 process(inputs,outputs){if(this.destroyed)return false;const input=inputs[0],output=outputs[0];if(!output?.[0])return true;
  const frames=output[0].length;let active=false;
  for(let j=0;j<frames;j++){const l=input?.[0]?.[j]??0,r=input?.[1]?.[j]??l;this.block[this.fill*2]=l;this.block[this.fill*2+1]=r;if(Math.abs(l)+Math.abs(r)>1e-8)active=this.blockActive=true;this.fill++;
   const start=Math.floor(this.frame/2048)*2048,pcm=this.results.get(start),offset=this.frame-start;
   const dryIndex=(this.frame%FX_LATENCY)*2;
   // A missed deadline must not insert a block of silence. Crossfade to the
   // equally delayed input until the effect catches up; never change the clock.
   this.wet=Math.max(0,Math.min(1,this.wet+(pcm?1:-1)/128));
   const dl=this.dry[dryIndex],dr=this.dry[dryIndex+1];
   if(pcm){this.lastL=pcm[offset*2];this.lastR=pcm[offset*2+1];}
   output[0][j]=dl+(this.lastL-dl)*this.wet;
   output[1][j]=dr+(this.lastR-dr)*this.wet;
   if(pcm&&offset===2047)this.results.delete(start);
   this.dry[dryIndex]=l;this.dry[dryIndex+1]=r;
   this.frame++;
   if(this.fill===2048){if(!this.failed&&(this.blockActive||this.silence<sampleRate*2)){const pcm=this.block;this.port.postMessage({epoch:this.epoch,start:this.frame-2048+FX_LATENCY,pcm},[pcm.buffer]);this.block=new Float32Array(4096);}this.fill=0;this.blockActive=false;}
  }
  this.silence=active?0:this.silence+frames;
  for(const key of this.results.keys())if(key+2048<this.frame)this.results.delete(key);
  return true;
 }
}
registerProcessor('studio-native-fx',NativeFx);
