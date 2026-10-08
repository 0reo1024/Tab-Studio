import * as at from '@coderline/alphatab';
import {installPlaybackTechniques} from './playback-techniques';
export type Articulation={lane:number;keyswitch:number;reference:number;continued:boolean};
const metadata=new WeakMap<object,Articulation>();let installed=false;
export const eventKey=(e:any)=>`${e.track}:${e.type}:${e.tick}:${e.channel}:${e.noteKey}`;
/** Capture at MIDI generation so grace, repeats, ornaments and ties retain the original string. */
export function installSfzCapture(){
 if(installed)return;installed=true;installPlaybackTechniques();let note:at.model.Note|undefined;
 const generator=at.midi.MidiFileGenerator.prototype as any,file=at.midi.MidiFile.prototype as any;
 const generate=generator._generateNote,add=file.addEvent;
 generator._generateNote=function(n:at.model.Note,...args:any[]){const before=note;note=n;try{return generate.call(this,n,...args);}finally{note=before;}};
 file.addEvent=function(e:any){if(note&&[128,144,96].includes(e.type)){
  const key=note.isDead?23:note.isPalmMute?27:note.harmonicType===at.model.HarmonicType.Natural?20:note.harmonicType!==at.model.HarmonicType.None?21:note.isHammerPullDestination?30:note.beat.pickStroke===at.model.PickStroke.Up?25:24;
  metadata.set(e,{lane:note.string>0?note.string:0,keyswitch:key,reference:e.noteKey,continued:!!(note.isTieDestination||note.slideOrigin?.slideOutType===at.model.SlideOutType.Legato)});
 }return add.call(this,e);};
}
export function articulationMap(file:at.midi.MidiFile){const result=new Map<string,Articulation[]>();for(const track of file.tracks)for(const e of track.events){const value=metadata.get(e);if(!value)continue;const key=eventKey(e),list=result.get(key)??[];list.push(value);result.set(key,list);}return result;}
