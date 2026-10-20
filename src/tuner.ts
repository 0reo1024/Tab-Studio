/** Pitch detection for the instrument tuner (YIN: de Cheveigné & Kawahara 2002), from the
 * latest input samples (src-tauri live_recent). Covers a 5-string bass's low B (31 Hz) to the
 * top of a guitar neck. */
export type Pitch={hz:number;clarity:number};
export type TunerNote={name:string;octave:number;midi:number;cents:number};
const NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

/** The fundamental of `x` (null: too quiet or no clear pitch). Needs about 2.5 periods of the lowest note. */
export function detectPitch(x:ArrayLike<number>,rate:number,minHz=28,maxHz=1500):Pitch|null{
 const n=x.length;let energy=0;for(let i=0;i<n;i++)energy+=x[i]*x[i];
 if(n<64||Math.sqrt(energy/n)<0.002)return null;
 const w=Math.floor(n/2),tauMax=Math.min(w-1,Math.floor(rate/minHz)),tauMin=Math.max(2,Math.floor(rate/maxHz));
 if(tauMax<=tauMin)return null;
 // Cumulative mean normalized difference.
 const d=new Float64Array(tauMax+1);d[0]=1;let sum=0;
 for(let tau=1;tau<=tauMax;tau++){let s=0;for(let j=0;j<w;j++){const v=x[j]-x[j+tau];s+=v*v;}sum+=s;d[tau]=sum>0?s*tau/sum:1;}
 // The first dip under the threshold (its bottom), else the deepest one if it is clear enough.
 let tau=-1;for(let t=tauMin;t<=tauMax;t++)if(d[t]<0.12){while(t+1<=tauMax&&d[t+1]<d[t])t++;tau=t;break;}
 if(tau<0){let best=tauMin;for(let t=tauMin;t<=tauMax;t++)if(d[t]<d[best])best=t;if(d[best]>0.3)return null;tau=best;}
 // Between samples: the parabola through the dip and its neighbours.
 let exact=tau;if(tau>1&&tau<tauMax){const a=d[tau-1],b=d[tau],c=d[tau+1],den=a-2*b+c;if(den>0)exact=tau+(a-c)/(2*den);}
 return {hz:rate/exact,clarity:1-d[tau]};
}

/** The nearest equal-tempered note to `hz` and how far off it is (cents, -50..50). */
export function noteOf(hz:number,a4=440):TunerNote{
 const exact=69+12*Math.log2(hz/a4),midi=Math.round(exact);
 return {name:NAMES[((midi%12)+12)%12],octave:Math.floor(midi/12)-1,midi,cents:(exact-midi)*100};
}

/** The middle of the last few readings: one stray reading (a pick attack, an octave slip) does not move the needle. */
export function steady(readings:number[]){const s=[...readings].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:NaN;}
