import * as at from '@coderline/alphatab';

export type TransposeOptions={semitones:number;start:number;end:number;track:number;allTracks:boolean;chords:boolean;keepStrings:boolean};
const sharp=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'],flat=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
function chordName(name:string,delta:number){return name.replace(/^([A-G])([#b]?)/,shift).replace(/\/([A-G])([#b]?)$/,(_,n,a)=>'/'+shift('',n,a));function shift(_:string,n:string,a:string){const pitch=({C:0,D:2,E:4,F:5,G:7,A:9,B:11} as Record<string,number>)[n]+(a==='#'?1:a==='b'?-1:0);return (a==='b'?flat:sharp)[((pitch+delta)%12+12)%12];}}
type Position={string:number;fret:number};
function positions(staff:at.model.Staff,tones:{pitch:number;string:number}[],keep:boolean):Position[]{
 const candidates=tones.map(t=>staff.tuning.map((open,i)=>({string:staff.tuning.length-i,fret:t.pitch+staff.transpositionPitch-open-staff.capo})).filter(p=>p.fret>=0&&p.fret<=36).sort((a,b)=>(keep?Number(b.string===t.string)-Number(a.string===t.string):0)||a.fret-b.fret));
 const order=candidates.map((_,i)=>i).sort((a,b)=>candidates[a].length-candidates[b].length),used=new Set<number>(),result:Position[]=[];
 function assign(i:number):boolean{if(i===order.length)return true;const n=order[i];for(const p of candidates[n])if(!used.has(p.string)){used.add(p.string);result[n]=p;if(assign(i+1))return true;used.delete(p.string);}return false;}
 if(!assign(0))throw new Error('移調後の音をこのチューニングの0〜36フレットに配置できません。');return result;
}
// Prepare every change first: an unplayable note or chord must not partly transpose the score.
export function transposeScore(score:at.model.Score,o:TransposeOptions){
 if(!Number.isInteger(o.semitones)||Math.abs(o.semitones)>24)throw new Error('移調量は−24〜24の整数で指定してください。');
 if(!Number.isInteger(o.start)||!Number.isInteger(o.end)||o.start<0||o.end<o.start||o.end>=score.masterBars.length||!score.tracks[o.track])throw new Error('移調する小節・トラックを選択してください。');
 if(!o.semitones)return;
 const changes:(()=>void)[]=[],tracks=o.allTracks?score.tracks:[score.tracks[o.track]];
 for(const track of tracks)for(const staff of track.staves){if(staff.isPercussion)continue;const chordIds=new Map<string,string>();
  for(const bar of staff.bars.slice(o.start,o.end+1))for(const voice of bar.voices)for(const beat of voice.beats){
   const notes=beat.notes.filter(n=>!n.isDead),tones=notes.map(n=>({pitch:n.realValueWithoutHarmonic+o.semitones,string:n.string}));
   if(tones.some(t=>t.pitch<0||t.pitch>127))throw new Error('移調後の音高が範囲外です。');
   if(staff.tuning.length){const target=positions(staff,tones,o.keepStrings);notes.forEach((n,i)=>changes.push(()=>{n.string=target[i].string;n.fret=target[i].fret;}));}
   else notes.forEach((n,i)=>changes.push(()=>{const pitch=tones[i].pitch+staff.transpositionPitch;n.octave=Math.floor(pitch/12);n.tone=((pitch%12)+12)%12;}));
   if(o.chords&&beat.chordId&&beat.chord){const oldId=beat.chordId;let newId=chordIds.get(oldId);if(!newId){newId=`${oldId}-transpose-${Date.now()}-${chordIds.size}`;chordIds.set(oldId,newId);const old=beat.chord,chord=new at.model.Chord();Object.assign(chord,old);chord.name=chordName(old.name,o.semitones);chord.strings=[...old.strings];chord.barreFrets=[];
     if(staff.tuning.length&&old.strings.length){const tones=old.strings.flatMap((f,i)=>f<0?[]:[{pitch:staff.tuning[i]+staff.capo-staff.transpositionPitch+f+o.semitones,string:staff.tuning.length-i}]),target=positions(staff,tones,o.keepStrings);chord.strings=staff.tuning.map(()=>-1);for(const p of target)chord.strings[staff.tuning.length-p.string]=p.fret;chord.firstFret=chord.strings.some(f=>f>0)?Math.min(...chord.strings.filter(f=>f>0)):1;}
     const id=newId;changes.push(()=>staff.addChord(id,chord));
    }const id=newId;changes.push(()=>{beat.chordId=id;});}
  }
 }
 for(const change of changes)change();
}
