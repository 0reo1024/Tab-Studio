import * as at from '@coderline/alphatab';
let installed=false;
/** Slide-ins as a hand plays them: fret by fret at a fixed speed whatever the note's length
 * or tempo (the Standard Guitar's Slide_in patches: 40 ms a fret, about 140 ms at most).
 * `beforeBeat` is the share of the slide played before the beat (0: picked on the beat). */
export const slideIn={beforeBeat:0};
/** Frets a slide-in without a start fret covers (alphaTab's simpleSlidePitchOffset: 6 quarter tones). */
const FRETS=3,FRET_MS=40,MAX_MS=144,GLIDE_MS=10,SEMITONE=512,TOP_FRET=24;
type Slide={from:number;to:number;ms:number;shift:number};
const ticks=(ms:number,tempo:number)=>Math.round(ms*tempo*960/60000);
function plain(n:at.model.Note){
 if(n.slideInType===at.model.SlideInType.None||n.hasBend||n.beat.hasWhammyBar)return 0;
 // From below it starts at fret 1 at the lowest (no slide into fret 0 or 1 from an open string).
 const below=n.slideInType===at.model.SlideInType.IntoFromBelow;
 return n.isStringed?below?-Math.min(FRETS,Math.max(0,n.fret-1)):Math.min(FRETS,Math.max(0,TOP_FRET-n.fret)):below?-FRETS:FRETS;
}
/** The slide a note starts with (a slide-in, or a grace note's legato slide into its main note),
 * with `shift`: ticks from its generated start to where it is picked. */
function slideOf(n:at.model.Note,tempo:number):Slide|undefined{
 const target=n.slideTarget,grace=n.beat.graceType;
 if(grace!==at.model.GraceType.None&&n.slideOutType===at.model.SlideOutType.Legato&&target&&target.beat.graceType===at.model.GraceType.None){
  const to=target.realValue-n.realValue,ms=Math.min(FRET_MS*Math.abs(to),MAX_MS);if(!to)return;
  // A slashed (before-beat) grace is the slide-in's start: place it like a plain slide-in.
  const shift=grace===at.model.GraceType.BeforeBeat?target.beat.absolutePlaybackStart-n.beat.absolutePlaybackStart-ticks(ms*slideIn.beforeBeat,tempo):0;
  return {from:0,to,ms,shift};
 }
 if(grace!==at.model.GraceType.None)return;
 const from=plain(n);if(!from)return;
 const ms=Math.min(FRET_MS*Math.abs(from),MAX_MS);
 return {from,to:0,ms,shift:-Math.min(n.beat.absolutePlaybackStart,ticks(ms*slideIn.beforeBeat,tempo))};
}
/** Playback timing changes leave notation, stored pitches and beat lengths intact. */
export function installPlaybackTechniques(){
 if(installed)return;installed=true;
 const proto=at.midi.MidiFileGenerator.prototype as any,beat=proto._generateBeat,note=proto._generateNote,slide=proto._generateSlide,duration=proto._getNoteDuration;
 const slides=new WeakMap<at.model.Note,Slide>();
 proto._generateBeat=function(b:at.model.Beat,start:number,...args:any[]){
  const tick=start+b.playbackStart,t=b.voice.bar.staff.track;
  if(!b.hasWhammyBar&&b.vibrato===at.model.VibratoType.None&&(b.previousBeat?.hasWhammyBar||b.previousBeat?.vibrato))for(const channel of new Set([t.playbackInfo.primaryChannel,t.playbackInfo.secondaryChannel]))this._handler.addBend(t.index,tick,channel,8192);
  return beat.call(this,b,start,...args);
 };
 proto._generateNote=function(n:at.model.Note,start:number,length:number,tempo:number,...args:any[]){
  const s=slideOf(n,tempo);if(!s)return note.call(this,n,start,length,tempo,...args);
  slides.set(n,s);try{return note.call(this,n,start+s.shift,length,tempo,...args);}finally{slides.delete(n);}
 };
 // Durations are measured from where the note is picked, and a note ends when the next note
 // on its string is picked (a slide-in picked before the beat, or after a grace's usual start).
 proto._getNoteDuration=function(n:at.model.Note,played:number,tempo:number,...args:any[]){
  const value=duration.call(this,n,played,tempo,...args),own=slides.get(n)?.shift??0;
  const next=n.isTieOrigin||n.slideOutType!==at.model.SlideOutType.None?undefined:n.beat.nextBeat?.notes.find(m=>m.string===n.string&&!m.isTieDestination),later=next&&slideOf(next,tempo);
  if(later){const end=next.beat.absolutePlaybackStart+later.shift-n.beat.absolutePlaybackStart-own;for(const k of ['noteOnly','untilTieOrSlideEnd','letRingEnd'] as const)if(value[k]>=played)value[k]=Math.max(1,end);}
  if(own)for(const k of ['noteOnly','untilTieOrSlideEnd','letRingEnd'] as const)value[k]=Math.max(1,value[k]-own);
  return value;
 };
 proto._generateSlide=function(n:at.model.Note,start:number,length:any,key:number,channel:number,tempo:number){
  const s=slides.get(n),out=()=>{if(n.slideOutType!==at.model.SlideOutType.None)slide.call(this,Object.assign(new at.model.Note(),n,{slideInType:at.model.SlideInType.None}),start,length,key,channel,tempo);};
  // A slide-in with no fret to start from (onto fret 1 from below) is picked as written.
  if(!s){if(n.slideInType===at.model.SlideInType.None)slide.call(this,n,start,length,key,channel,tempo);else out();return;}
  const track=n.beat.voice.bar.staff.track.index,steps=Math.abs(s.to-s.from),dir=Math.sign(s.to-s.from),step=ticks(s.ms/steps,tempo),glide=Math.min(ticks(GLIDE_MS,tempo),step>>1);
  const bend=(tick:number,semitones:number)=>this._handler.addNoteBend(track,Math.round(tick),channel,key,8192+semitones*SEMITONE);
  // Each fret holds, then glides into the next over GLIDE_MS (the library's eg time2).
  bend(start,s.from);
  for(let i=1;i<=steps;i++){const tick=start+i*step,from=s.from+dir*(i-1);bend(tick-glide,from);bend(tick-glide/2,from+dir/2);bend(tick,from+dir);}
  if(n.beat.graceType===at.model.GraceType.None)out();
 };
}
