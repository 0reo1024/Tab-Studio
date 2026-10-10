import * as at from '@coderline/alphatab';
import {settings} from './score';
import {canEditFretLocally} from './local-fret-edit';
/** alphaTab's finish() is only repeatable for beats without cross-beat links:
 * ties, slides, hammer-ons, let-ring/palm-mute chains, grace groups, whammy
 * continuations and fermatas all keep state from the first pass. */
function linkFree(beat:at.model.Beat){return canEditFretLocally(beat)&&!beat.fermata&&!beat.isLetRing&&!beat.isPalmMute&&!beat.notes.some(n=>n.isLetRing||n.isPalmMute||n.hasEffectSlur||n.effectSlurOrigin||n.isEffectSlurOrigin);}
/** Edits that stay inside one measure (durations, dots, tuplets, rests, note
 * removal, beat flags) can re-finish just that measure when it and the beats
 * bordering it carry no relationships. Otherwise the caller normalizes the song. */
export function canRefinishBar(bar:at.model.Bar){
 if(bar.sustainPedals.length||bar.previousBar?.sustainPedals.length)return false;
 for(const voice of bar.voices){
  if(!voice.beats.length||voice.beats.some(b=>b.voice!==voice||!linkFree(b)))return false;
  const before=bar.previousBar?.voices[voice.index]?.beats.at(-1),after=bar.nextBar?.voices[voice.index]?.beats[0];
  if(before&&!linkFree(before)||after&&!linkFree(after))return false;
 }
 return true;
}
/** Rebuild beat order, ticks and tuplet groups of an edited measure in place.
 * The Score object (and with it alphaTab's player state) stays the same. */
export function refinishBar(bar:at.model.Bar){
 for(const voice of bar.voices){
  for(const beat of voice.beats){beat.voice=voice;beat.tupletGroup=null;(beat as unknown as {noteValueLookup:Map<number,at.model.Note>}).noteValueLookup.clear();}
  // finish() chains beats forward; the measure's first beat is linked from the previous one.
  const first=voice.beats[0],before=bar.previousBar?.voices[voice.index]?.beats.at(-1);
  first.previousBeat=before??null;if(before)before.nextBeat=first;
 }
 bar.finish(settings);
}
type BarRef=[track:number,staff:number,bar:number];
/** Undo/redo of a bar-local edit: rebuild only the listed measures from a history
 * snapshot and swap them into the live score. Returns false (score untouched) when
 * a measure or its neighbours carry links, so the caller restores the whole song. */
export function restoreBars(score:at.model.Score,data:Map<string,any>|null|undefined,refs:BarRef[]):boolean{
 if(!data)return false;
 const fresh:{staff:at.model.Staff;index:number;bar:at.model.Bar}[]=[];
 for(const [t,s,b]of refs){
  const staff=score.tracks[t]?.staves[s],track=(data.get('tracks') as Map<string,any>[]|undefined)?.[t];
  if(!staff||!track||b>=staff.bars.length)return false;
  // Beat.finish() gives the score's very first beat an instrument automation, so a
  // measure after the first is rebuilt behind a copy of itself (as index 1).
  const pick=<T,>(list:T[])=>b?[list[b],list[b]]:[list[0]],at1=b?1:0;
  const mini=new Map(data);mini.set('masterbars',pick(data.get('masterbars') as unknown[]));
  const copy=new Map(track);copy.set('staves',(track.get('staves') as Map<string,any>[]).map(st=>{const c=new Map(st);c.set('bars',pick(st.get('bars')));return c;}));mini.set('tracks',[copy]);
  fresh.push({staff,index:b,bar:at.model.JsonConverter.jsObjectToScore(mini,settings).tracks[0].staves[s].bars[at1]});
 }
 return swapInBars(fresh);
}
/** A measure's alphaTab JSON (plain objects) rebuilt as a Bar, from just that measure:
 * its master bar, the track and staff headers and the bar itself (the document core's
 * pieces). Built behind a copy of itself after the first bar, like restoreBars. */
export function barFromJson(index:number,masterBar:unknown,track:{staves:Record<string,unknown>[]}&Record<string,unknown>,staff:number,bars:unknown[]):at.model.Bar{
 const pick=<T,>(x:T)=>index?[x,x]:[x];
 const mini={masterbars:pick(masterBar),tracks:[{...track,staves:track.staves.map((st,i)=>({...st,bars:pick(bars[i])}))}]};
 return at.model.JsonConverter.jsObjectToScore(mini as never,settings).tracks[0].staves[staff].bars[index?1:0];
}
/** Swaps rebuilt measures into the live score and re-finishes them. Returns false (score
 * untouched) when a measure or its neighbours carry links, or the voice count differs:
 * the caller then rebuilds the whole song. */
export function swapInBars(fresh:{staff:at.model.Staff;index:number;bar:at.model.Bar}[]):boolean{
 for(const {staff,index:b,bar}of fresh){
  if(b>=staff.bars.length)return false;
  if(bar.voices.some(v=>!v.beats.length||v.beats.some(x=>!linkFree(x))))return false;
  const before=staff.bars[b-1],after=staff.bars[b+1];
  for(const v of bar.voices){const x=before?.voices[v.index]?.beats.at(-1),y=after?.voices[v.index]?.beats[0];if(x&&!linkFree(x)||y&&!linkFree(y))return false;}
  if(bar.sustainPedals.length||before?.sustainPedals.length||staff.bars[b].voices.length!==bar.voices.length)return false;
 }
 for(const {staff,index,bar}of fresh){
  bar.staff=staff;bar.index=index;staff.bars[index]=bar;
  bar.previousBar=staff.bars[index-1]??null;if(bar.previousBar)bar.previousBar.nextBar=bar;
  bar.nextBar=staff.bars[index+1]??null;if(bar.nextBar)bar.nextBar.previousBar=bar;
 }
 for(const {bar}of fresh)refinishBar(bar);
 return true;
}
