// Spike S9 reference: nam-engine.wasm run by V8 with the Emscripten glue's import behaviour,
// in 128-frame blocks like nam-worklet.js. Usage: node reference.mjs <wasm> <model> <in.f32> <out.f32> <rate>
import fs from 'node:fs';
const [wasmPath,modelPath,inPath,outPath,rateArg]=process.argv.slice(2),rate=Number(rateArg);
let mem;const u32=()=>new Uint32Array(mem.buffer);
const imports={a:{h:()=>{throw new Error('abort');},g:size=>{size>>>=0;const old=mem.buffer.byteLength,max=536870912;if(size>max)return 0;for(let cut=1;cut<=4;cut*=2){let over=Math.min(old*(1+.2/cut),size+100663296);const next=Math.min(max,Math.ceil(Math.max(size,over)/65536)*65536);try{mem.grow((next-old+65535)/65536|0);return 1;}catch{}}return 0;},
 b:()=>0,c:(n,s)=>{u32()[n>>2]=0;u32()[s>>2]=0;return 0;},d:()=>52,e:()=>52,f:()=>70,a:(fd,iov,n,p)=>{let t=0;for(let i=0;i<n;i++){t+=u32()[(iov+i*8+4)>>2];}u32()[p>>2]=t;return 0;}}};
const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),imports);const x=instance.exports;mem=x.i;x.j();
const id=x.k(rate,128),buf=x.p(id);const json=fs.readFileSync(modelPath);const ptr=x.B(json.length+1);new Uint8Array(mem.buffer).set(json,ptr);new Uint8Array(mem.buffer)[ptr+json.length]=0;
if(!x.m(id,ptr,0))throw new Error('load failed');x.A(ptr);
const raw=fs.readFileSync(inPath),input=new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.length)),out=new Float32Array(input.length);
const t=performance.now();
for(let i=0;i<input.length;i+=128){const n=Math.min(128,input.length-i),view=new Float32Array(mem.buffer,buf,128);view.set(input.subarray(i,i+n));x.q(id,n);out.set(new Float32Array(mem.buffer,buf,n),i);}
console.log('process',((performance.now()-t)/1000/(input.length/rate)*100).toFixed(1),'% of real time');
fs.writeFileSync(outPath,Buffer.from(out.buffer));
