import type * as at from '@coderline/alphatab';
import {beatQ,voiceQ} from './score';
import {rests} from './editor';
function checkMeter(score:at.model.Score,index:number,numerator:number,denominator:number){
 if(!Number.isInteger(numerator)||numerator<1||numerator>32||![1,2,4,8,16,32,64].includes(denominator))throw new Error('拍子を正しく指定してください。');
 const capacity=numerator*4/denominator,voices=score.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars[index].voices));
 for(const voice of voices){let q=0,lastSound=0;for(const beat of voice.beats){q+=beatQ(beat);if(!beat.isRest)lastSound=q;}if(lastSound>capacity+1e-7)throw new Error('音符が新しい拍子を超えます。音価を短くしてから変更してください。');}
 return {capacity,voices};
}
/** Only bars start..end change; the bars after keep their own meter. Every bar
 * is checked first, so a rejected range leaves the score untouched. */
export function setMeterRange(score:at.model.Score,start:number,end:number,numerator:number,denominator:number){
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>=score.masterBars.length)throw new Error(`小節は1〜${score.masterBars.length}の範囲で、開始≦終了になるよう指定してください。`);
 for(let i=start;i<=end;i++){try{checkMeter(score,i,numerator,denominator);}catch(e){throw new Error(`${i+1}小節目：${e instanceof Error?e.message:e}`);}}
 for(let i=start;i<=end;i++)setMeter(score,i,numerator,denominator);
}
export function setMeter(score:at.model.Score,index:number,numerator:number,denominator:number){
 // Validate sounding notes before changing any voice, so rejected meter edits
 // leave the original score intact even outside the app transaction.
 const {capacity,voices}=checkMeter(score,index,numerator,denominator);
 for(const voice of voices){if(voice.beats.every(b=>b.isRest)){voice.beats=[];for(const r of rests(capacity))voice.addBeat(r);continue;}let total=voiceQ(voice);while(total>capacity+1e-7){const last=voice.beats.pop()!,q=beatQ(last);total-=q;if(total<capacity-1e-7){for(const r of rests(capacity-total))voice.addBeat(r);total=capacity;}}for(const r of rests(capacity-total))voice.addBeat(r);}
 const bar=score.masterBars[index];bar.timeSignatureNumerator=numerator;bar.timeSignatureDenominator=denominator;
}
