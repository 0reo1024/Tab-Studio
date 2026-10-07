import * as at from '@coderline/alphatab';
import { beatQ } from './score';
export function capacity(v:at.model.Voice){const m=v.bar.masterBar;return m.timeSignatureNumerator*4/m.timeSignatureDenominator;}
export function rests(q:number):at.model.Beat[]{
  const result:at.model.Beat[]=[];
  for(const d of [1,2,4,8,16,32,64])while(q>=4/d-1e-7){const b=new at.model.Beat();b.duration=d;result.push(b);q-=4/d;}
  if(q>1e-7){const b=new at.model.Beat();b.duration=4;const den=720720,n=Math.round(q*den);const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;const g=gcd(den,n);b.tupletNumerator=den/g;b.tupletDenominator=n/g;result.push(b);}
  return result;
}
/** Consume only adjacent rests. Existing following notes keep their onset. */
export function resizeBeat(b:at.model.Beat,d:number,dots:number,enters:number,times:number){
  const v=b.voice,index=v.beats.indexOf(b),old=beatQ(b);
  const probe=new at.model.Beat();probe.duration=d;probe.dots=dots;probe.tupletNumerator=enters;probe.tupletDenominator=times;
  const length=4/d*(2-1/2**dots)*times/enters,delta=length-old;
  let available=0,count=0;
  if(delta>1e-7){for(let i=index+1;i<v.beats.length&&v.beats[i].isRest;i++){available+=beatQ(v.beats[i]);count++;if(available>=delta-1e-7)break;}
    if(available<delta-1e-7)throw new Error('次の音符までの休符が足りません。音価を短くするか、先に後ろの音符を編集してください。');}
  b.duration=d;b.dots=dots;b.tupletNumerator=enters;b.tupletDenominator=times;
  if(delta>1e-7)v.beats.splice(index+1,count,...rests(available-delta));
  else if(delta<-1e-7)v.beats.splice(index+1,0,...rests(-delta));
  for(const beat of v.beats)beat.voice=v;
}
export function splitFullRest(b:at.model.Beat){
  if(!b.isFullBarRest)return false;const v=b.voice,unit=v.bar.masterBar.timeSignatureDenominator;
  const all:at.model.Beat[]=[];for(let i=0;i<v.bar.masterBar.timeSignatureNumerator;i++){const r=new at.model.Beat();r.duration=unit;all.push(r);}
  v.beats=[];for(const r of all)v.addBeat(r);return true;
}
export function setFret(b:at.model.Beat,string:number,fret:number){
  if(!Number.isInteger(fret)||fret<0||fret>36)throw new Error('フレットは0〜36で入力してください。');
  const n=b.notes.find(n=>n.string===string);if(n){if(n.fret!==fret){n.isTieDestination=false;n.tieOrigin=null;}n.fret=fret;}else{const n=new at.model.Note();n.string=string;n.fret=fret;b.addNote(n);}b.isEmpty=false;
}
