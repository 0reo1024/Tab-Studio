import * as at from '@coderline/alphatab';
let installed=false;
function stolen(beat:at.model.Beat){const group=beat.graceGroup;return group?.beats[0]?.graceType===at.model.GraceType.OnBeat&&group.beats.some(b=>b.notes.some(n=>n.slideOutType===at.model.SlideOutType.Legato))?group.beats.reduce((v,b)=>v+b.playbackDuration,0):0;}
/** Playback timing changes leave notation, stored pitches and beat lengths intact. */
export function installPlaybackTechniques(){
 if(installed)return;installed=true;
 const proto=at.midi.MidiFileGenerator.prototype as any,beat=proto._generateBeat,note=proto._generateNote,slide=proto._generateSlide,duration=proto._getNoteDuration;
 const leads=new WeakMap<at.model.Note,number>();
 proto._generateBeat=function(b:at.model.Beat,start:number,...args:any[]){
  const offset=stolen(b),tick=start+b.playbackStart-offset,t=b.voice.bar.staff.track;
  if(!b.hasWhammyBar&&b.vibrato===at.model.VibratoType.None&&(b.previousBeat?.hasWhammyBar||b.previousBeat?.vibrato))for(const channel of new Set([t.playbackInfo.primaryChannel,t.playbackInfo.secondaryChannel]))this._handler.addBend(t.index,tick,channel,8192);
  return beat.call(this,b,start-offset,...args);
 };
 proto._generateNote=function(n:at.model.Note,start:number,length:number,...args:any[]){
  if(n.beat.graceType===at.model.GraceType.None)length+=stolen(n.beat);
  const lead=n.slideInType!==at.model.SlideInType.None&&!n.hasBend&&!n.beat.hasWhammyBar?Math.min(Math.max(0,start),120,length/4):0;
  leads.set(n,lead);try{return note.call(this,n,start-lead,length+lead,...args);}finally{leads.delete(n);}
 };
 proto._getNoteDuration=function(n:at.model.Note,...args:any[]){const value=duration.call(this,n,...args);if(n.beat.graceType!==at.model.GraceType.None&&n.slideOutType===at.model.SlideOutType.Legato)value.untilTieOrSlideEnd+=stolen(n.beat);return value;};
 proto._generateSlide=function(n:at.model.Note,start:number,length:any,key:number,channel:number,tempo:number){
  if(n.slideInType===at.model.SlideInType.None)return slide.call(this,n,start,length,key,channel,tempo);
  const lead=leads.get(n)??0,offset=this._settings.player.slide.simpleSlidePitchOffset*(n.slideInType===at.model.SlideInType.IntoFromAbove?1:-1);
  for(let i=0;i<=6;i++)this._handler.addNoteBend(n.beat.voice.bar.staff.track.index,Math.round(start+lead*i/6),channel,key,8192+(lead?offset*(1-i/6):0)/2*512);
  if(n.slideOutType!==at.model.SlideOutType.None)slide.call(this,Object.assign(new at.model.Note(),n,{slideInType:at.model.SlideInType.None}),start,length,key,channel,tempo);
 };
}
