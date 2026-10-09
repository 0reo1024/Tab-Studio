// Spike S6: objective comparison of alphaSynth vs native renders of the same events.
// Loudness (RMS / peak), timing offset (envelope cross-correlation), envelope
// similarity, and a pitch track (autocorrelation) to check bends.
// Usage: node spikes/s6-synth-ab/compare.mjs <folder>
import fs from 'node:fs';
import path from 'node:path';
const folder=path.resolve(process.argv[2]??'test-results/s6');
function read(file){const b=fs.readFileSync(file);const rate=b.readUInt32LE(24),n=(b.length-44)/4,mono=new Float32Array(n);for(let i=0;i<n;i++)mono[i]=(b.readInt16LE(44+i*4)+b.readInt16LE(46+i*4))/65536;return {rate,mono};}
const peak=a=>a.reduce((m,v)=>Math.max(m,Math.abs(v)),0);
const rms=a=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/Math.max(1,a.length));
function envelope(a,rate,ms=20){const w=Math.round(rate*ms/1000),out=[];for(let i=0;i+w<=a.length;i+=w)out.push(rms(a.subarray(i,i+w)));return out;}
function correlate(x,y,lag){let s=0,sx=0,sy=0;const n=Math.min(x.length,y.length)-Math.abs(lag);for(let i=0;i<n;i++){const a=x[i+Math.max(0,lag)],b=y[i+Math.max(0,-lag)];s+=a*b;sx+=a*a;sy+=b*b;}return s/Math.sqrt(sx*sy||1);}
function pitch(a,rate,at){const n=2048,start=Math.round(at*rate);if(start+2*n>a.length)return null;const seg=a.subarray(start,start+2*n);let best=0,bestLag=0;for(let lag=Math.round(rate/1200);lag<Math.round(rate/60);lag++){let s=0;for(let i=0;i<n;i++)s+=seg[i]*seg[i+lag];if(s>best){best=s;bestLag=lag;}}return bestLag?+(12*Math.log2(rate/bestLag/440)+69).toFixed(2):null;}
const rows=[];
for(const file of fs.readdirSync(folder).filter(f=>f.endsWith('-alphasynth.wav')).sort()){
 const name=file.replace('-alphasynth.wav',''),a=read(path.join(folder,file)),b=read(path.join(folder,name+'-native.wav'));
 const ea=envelope(a.mono,a.rate),eb=envelope(b.mono,b.rate);let bestLag=0,best=-1;for(let lag=-25;lag<=25;lag++){const c=correlate(ea,eb,lag);if(c>best){best=c;bestLag=lag;}}
 const row={name,rmsA:+rms(a.mono).toFixed(4),rmsB:+rms(b.mono).toFixed(4),gainB_over_A_dB:+(20*Math.log10(rms(b.mono)/rms(a.mono))).toFixed(1),peakA:+peak(a.mono).toFixed(3),peakB:+peak(b.mono).toFixed(3),offsetMs:bestLag*20,envelopeCorrelation:+best.toFixed(3)};
 if(name.includes('bends'))row.pitch=[0.3,0.6,0.9,1.5].map(t=>({t,alphaSynth:pitch(a.mono,a.rate,t),native:pitch(b.mono,b.rate,t)}));
 rows.push(row);
}
console.log(JSON.stringify(rows,null,1));
fs.writeFileSync(path.join(folder,'compare.json'),JSON.stringify(rows,null,1));
