// Spike S7: reference responses of the WebAudio effects the mixer uses (mixer-audio.ts),
// rendered offline in Electron's Chromium, so the native engine's DSP can be compared
// numerically. Writes <out>/<case>.f32 (interleaved stereo float32) and index.json.
// Usage: pnpm build && node spikes/s7-fx-reference/reference.mjs [out]
import {_electron as electron} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve(process.argv[2]??'test-results/s7');await fs.mkdir(out,{recursive:true});
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(out,'profile-'+Date.now())}});
try{
 const page=await app.firstWindow();
 const cases=await page.evaluate(async()=>{
  const rate=48000;
  // Test input (mono, duplicated to stereo): tone bursts at three levels, an impulse, silence tails.
  const input=()=>{const n=rate*4,x=new Float32Array(n);
   for(let i=0;i<rate*.5;i++)x[i]=.05*Math.sin(2*Math.PI*440*i/rate);
   for(let i=0;i<rate*.5;i++)x[rate*.75+i]=.3*Math.sin(2*Math.PI*440*i/rate);
   for(let i=0;i<rate*.5;i++)x[rate*1.5+i]=.9*Math.sin(2*Math.PI*440*i/rate);
   x[rate*2.25]=1;
   for(let i=0;i<rate*.5;i++){const t=i/rate;x[Math.floor(rate*2.5)+i]=.5*Math.sin(2*Math.PI*(100+4000*t)*t);}
   return x;};
  const build=(c,kind,amount)=>{
   const src=c.createBufferSource(),buffer=c.createBuffer(2,rate*4,rate),x=input();buffer.copyToChannel(x,0);buffer.copyToChannel(x,1);src.buffer=buffer;
   let tail=src;const node=n=>{tail.connect(n);tail=n;};
   if(kind==='eq'){const eq=c.createBiquadFilter();eq.type='peaking';eq.frequency.value=1200;eq.gain.value=(amount-.5)*24;node(eq);}
   if(kind==='compressor'){const k=c.createDynamicsCompressor();k.threshold.value=-10-30*amount;k.ratio.value=2+6*amount;node(k);}
   if(kind==='delay'){const dry=c.createGain(),delay=c.createDelay(2),feedback=c.createGain(),wet=c.createGain(),mix=c.createGain();delay.delayTime.value=.3;feedback.gain.value=.3;wet.gain.value=amount;tail.connect(dry);tail.connect(delay);dry.connect(mix);delay.connect(feedback);feedback.connect(delay);delay.connect(wet);wet.connect(mix);tail=mix;}
   if(kind==='limiter'){const l=c.createDynamicsCompressor();l.threshold.value=-3;l.knee.value=0;l.ratio.value=20;l.attack.value=.003;l.release.value=.12;node(l);}
   if(kind==='reverb'){const conv=c.createConvolver(),impulse=c.createBuffer(2,Math.floor(rate*1.8),rate);let seed=871;for(let ch=0;ch<2;ch++){const d=impulse.getChannelData(ch);for(let i=0;i<d.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;d[i]=(seed/2147483648*2-1)*Math.pow(1-i/d.length,3)*.18;}}conv.buffer=impulse;node(conv);}
   if(kind==='nam-eq'){// NAM tone stack: bass/mid/treble shelves+peak, cabinet HP/LP
    for(const [type,freq,value]of [['lowshelf',150,amount*6],['peaking',800,-amount*6],['highshelf',3500,amount*6]]){const f=c.createBiquadFilter();f.type=type;f.frequency.value=freq;f.gain.value=value;node(f);}
    const hp=c.createBiquadFilter();hp.type='highpass';hp.frequency.value=70;node(hp);const lp=c.createBiquadFilter();lp.type='lowpass';lp.frequency.value=6500;node(lp);}
   if(kind==='pan'){const p=c.createStereoPanner();p.pan.value=amount*2-1;node(p);}
   tail.connect(c.destination);src.start();
  };
  const list=[['dry',0],['eq',0],['eq',.25],['eq',.75],['eq',1],['compressor',.25],['compressor',.75],['compressor',1],['delay',.5],['delay',1],['limiter',0],['reverb',0],['nam-eq',1],['pan',0],['pan',.25],['pan',1]];
  const result=[];
  for(const [kind,amount]of list){const c=new OfflineAudioContext(2,rate*4,rate);build(c,kind,amount);const r=await c.startRendering();const l=r.getChannelData(0),rr=r.getChannelData(1),inter=new Float32Array(l.length*2);for(let i=0;i<l.length;i++){inter[2*i]=l[i];inter[2*i+1]=rr[i];}let b='';const bytes=new Uint8Array(inter.buffer);for(let i=0;i<bytes.length;i+=0x8000)b+=String.fromCharCode(...bytes.subarray(i,i+0x8000));result.push({kind,amount,data:btoa(b)});}
  return result;
 });
 const index=[];
 for(const c of cases){const name=`${c.kind}-${c.amount}`;await fs.writeFile(path.join(out,name+'.f32'),Buffer.from(c.data,'base64'));index.push({name,kind:c.kind,amount:c.amount});}
 await fs.writeFile(path.join(out,'index.json'),JSON.stringify({rate:48000,frames:48000*4,cases:index},null,1));
 console.log('wrote',index.length,'cases to',out);
}finally{await app.close();}
