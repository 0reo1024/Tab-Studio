import * as at from '@coderline/alphatab';
import {settings,type Score} from '../score';
import {restoreScore} from '../edit-snapshot';
import type {Changes,Core} from './index';
/** The alphaTab adapter (migration P3-5): brings the live alphaTab Score (the view) up to
 * date with the document core after an edit, undo or redo.
 *
 * alphaTab's finish() links beats across measures (ties, slides, hammer-ons, slurs,
 * palm-mute and let-ring chains...) and cannot redo that for one measure in place. So
 * each changed measure is widened to a "link-closed" range of its track: extended left
 * and right until no link crosses the boundary in any staff. That range is rebuilt from
 * the core's JSON as a small song of its own (behind a copy of its first measure, so it
 * is not the song's first measure) and swapped in; the boundary beats are relinked.
 * The Score object, its layout and the player stay. Structure or song-level changes
 * rebuild the whole song from the core. */
/** ranges: [track, first, last] measures rebuilt in place. */
export type Applied={score:Score;inPlace:boolean;bars:number;ranges:[number,number,number][]};

const linkedNote=(n:at.model.Note)=>n.isTieOrigin||n.isTieDestination||n.isHammerPullOrigin||n.isHammerPullDestination||!!n.slideOrigin||!!n.slideTarget||n.slideOutType!==at.model.SlideOutType.None||n.slideInType!==at.model.SlideInType.None||n.hasEffectSlur||!!n.effectSlurOrigin||n.isEffectSlurOrigin||n.isLetRing||n.isPalmMute||!!n.bendOrigin||n.isContinuedBend;
const linkedBeat=(b:at.model.Beat|undefined)=>!!b&&(b.isLetRing||b.isPalmMute||b.hasWhammyBar||b.isContinuedWhammy||b.graceType!==at.model.GraceType.None||!!b.fermata||b.notes.some(linkedNote));
/** No link crosses the boundary before measure i of this track (in the live score). */
export function cleanBoundary(track:at.model.Track,i:number){
 return track.staves.every(st=>{const a=st.bars[i-1],b=st.bars[i];if(!a||!b)return true;if(a.sustainPedals.length||b.sustainPedals.length)return false;
  return b.voices.every(v=>!linkedBeat(v.beats[0]))&&a.voices.every(v=>!linkedBeat(v.beats.at(-1)));});
}
/** The link-closed range around measure b of a track. */
export function linkRange(track:at.model.Track,b:number):[number,number]{
 const count=track.staves[0]?.bars.length??0;let lo=b,hi=b;
 while(lo>0&&!cleanBoundary(track,lo))lo--;
 while(hi+1<count&&!cleanBoundary(track,hi+1))hi++;
 return [lo,hi];
}
/** Rebuilds measures lo..hi of a track from the core and swaps them into the score. */
function swapRange(score:Score,core:Core,t:number,lo:number,hi:number){
 const track=core.header({track:t}),prefix=lo>0?1:0;
 const masterbars=[...(prefix?[core.node({masterbar:lo})]:[]),...Array.from({length:hi-lo+1},(_,k)=>core.node({masterbar:lo+k}))];
 const staves=track.staves.map((st:Record<string,unknown>,s:number)=>{const bars=Array.from({length:hi-lo+1},(_,k)=>core.node({track:t,staff:s,bar:lo+k}));return {...st,bars:prefix?[bars[0],...bars]:bars};});
 const built=at.model.JsonConverter.jsObjectToScore({masterbars,tracks:[{...track,staves}]} as never,settings).tracks[0];
 const live=score.tracks[t];
 if(built.staves.length!==live.staves.length)throw new Error('staff count');
 for(const [s,staff]of live.staves.entries()){
  const fresh=built.staves[s].bars.slice(prefix);
  if(fresh.length!==hi-lo+1||fresh.some((bar,k)=>bar.voices.length!==staff.bars[lo+k].voices.length))throw new Error('voice count');
  for(const [k,bar]of fresh.entries()){bar.staff=staff;bar.index=lo+k;staff.bars[lo+k]=bar;}
  for(let i=lo;i<=hi;i++){const bar=staff.bars[i];bar.previousBar=staff.bars[i-1]??null;bar.nextBar=staff.bars[i+1]??null;}
  // The boundaries carry no links, so only the neighbour pointers need joining.
  const before=staff.bars[lo-1],after=staff.bars[hi+1];if(before)before.nextBar=staff.bars[lo];if(after)after.previousBar=staff.bars[hi];
  for(const v of staff.bars[lo].voices){const last=before?.voices[v.index]?.beats.at(-1),first=v.beats[0];if(first)first.previousBeat=last??null;if(last)last.nextBeat=first??null;}
  for(const v of staff.bars[hi].voices){const first=after?.voices[v.index]?.beats[0],last=v.beats.at(-1);if(last)last.nextBeat=first??null;if(first)first.previousBeat=last??null;}
 }
}
export function applyChanges(score:Score,core:Core,changes:Changes):Applied{
 if(!changes.structure&&!changes.song){
  if(!changes.bars.length)return {score,inPlace:true,bars:0,ranges:[]};
  // Merge the changed measures into link-closed ranges per track.
  const ranges=new Map<number,[number,number][]>();
  for(const [t,,b]of changes.bars){const track=score.tracks[t];if(!track)return rebuild(core);const r=linkRange(track,b),list=ranges.get(t)??[];list.push(r);ranges.set(t,list);}
  let bars=0;const done:[number,number,number][]=[];
  try{
   for(const [t,list]of ranges){
    list.sort((a,b)=>a[0]-b[0]);const merged:[number,number][]=[];
    for(const r of list){const last=merged.at(-1);if(last&&r[0]<=last[1]+1)last[1]=Math.max(last[1],r[1]);else merged.push([...r]);}
    for(const [lo,hi]of merged){swapRange(score,core,t,lo,hi);bars+=hi-lo+1;done.push([t,lo,hi]);}
   }
   return {score,inPlace:true,bars,ranges:done};
  }catch{return rebuild(core);}
 }
 return rebuild(core);
}
function rebuild(core:Core):Applied{const score=restoreScore(core.data());return {score,inPlace:false,bars:score.masterBars.length,ranges:[]};}
