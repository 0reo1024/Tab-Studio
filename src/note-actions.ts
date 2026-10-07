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
