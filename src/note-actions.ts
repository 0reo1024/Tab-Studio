import * as at from '@coderline/alphatab';
import {setFret} from './editor';
import {setPitch} from './standard-editor';
export function transposeNote(note:at.model.Note,delta:-1|1){
 const staff=note.beat.voice.bar.staff;if(staff.isPercussion)throw new Error('打楽器の音符は半音移動できません。');
 if(staff.tuning.length)setFret(note.beat,note.string,note.fret+delta);else setPitch(note.beat,note.realValueWithoutHarmonic+delta,note.index);
 return note;
}
export function shiftString(note:at.model.Note,direction:-1|1){
 const staff=note.beat.voice.bar.staff,string=note.string+direction;if(staff.isPercussion||!staff.tuning.length)throw new Error('弦のあるトラックで音符を選択してください。');
 if(string<1||string>staff.tuning.length)throw new Error('これ以上その方向の弦へ移動できません。');
 if(note.beat.notes.some(n=>n!==note&&n.string===string))throw new Error('移動先の弦には音符があります。');
 const fret=note.realValueWithoutHarmonic+staff.transpositionPitch-staff.tuning[staff.tuning.length-string]-staff.capo;
 if(fret<0||fret>36)throw new Error('同じ音高を移動先の弦で演奏できません。');
 note.isTieDestination=false;note.tieOrigin=null;note.string=string;note.fret=fret;return note;
}
/** Move every pitched note of a selection together. Ties stay when both ends
 * move; nothing changes if any note cannot follow (fret 0–36, string range). */
export function shiftNotes(beats:at.model.Beat[],kind:'transpose'|'string',delta:-1|1){
 const moved=new Set(beats),plans:(()=>void)[]=[];
 for(const beat of beats){const staff=beat.voice.bar.staff;if(staff.isPercussion||kind==='string'&&!staff.tuning.length)continue;for(const n of beat.notes){
  const keepTie=!!n.tieOrigin&&moved.has(n.tieOrigin.beat);
  const tie=()=>{if(!keepTie){n.isTieDestination=false;n.tieOrigin=null;}};
  if(kind==='string'){const string=n.string+delta;if(string<1||string>staff.tuning.length)throw new Error('選択範囲に、これ以上その方向の弦へ移動できない音符があります。');const fret=n.realValueWithoutHarmonic+staff.transpositionPitch-staff.tuning[staff.tuning.length-string]-staff.capo;if(fret<0||fret>36)throw new Error('選択範囲に、同じ音高を移動先の弦で演奏できない音符があります。');plans.push(()=>{n.string=string;n.fret=fret;tie();});}
  else if(staff.tuning.length){const fret=n.fret+delta;if(fret<0||fret>36)throw new Error('選択範囲に、半音移動できない音符があります（フレットは0〜36）。');plans.push(()=>{n.fret=fret;tie();});}
  else{const pitch=n.realValueWithoutHarmonic+delta;if(pitch<0||pitch>127)throw new Error('選択範囲に、音域外になる音符があります。');plans.push(()=>{setPitch(beat,pitch,beat.notes.indexOf(n));tie();});}
 }}
 if(!plans.length)throw new Error(kind==='string'?'弦を移動できる音符が選択範囲にありません。':'半音移動できる音符が選択範囲にありません。');
 for(const apply of plans)apply();return plans.length;
}
