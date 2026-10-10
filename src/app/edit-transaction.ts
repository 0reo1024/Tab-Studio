import type * as at from '@coderline/alphatab';
import {settings,type Score} from '../score';
import {normalizeEdit,type EditSnapshot,type ScoreData} from '../edit-snapshot';
import {canRefinishBar,refinishBar,restoreBars} from '../bar-edit';
import {perfTime} from '../perf';
/** The edit-transaction seam (migration P0-4/P3-0): every score edit goes through
 * commit / commitBeats / record, and undo/redo through history. The document core
 * (P3) replaces what happens inside without touching the callers. */
type Beat=at.model.Beat;
/** [track, staff, bar] of a measure. */
export type BarRef=[number,number,number];
/** What a history entry needs here; main.ts adds the view state (selection, layout...). */
export type EditBase={data:ScoreData;firstChangedBar?:number;bars?:BarRef[]};
export const barRef=(bar:at.model.Bar):BarRef=>[bar.staff.track.index,bar.staff.index,bar.index];
export const barRefs=(beats:Beat[])=>[...new Map(beats.map(b=>{const ref=barRef(b.voice.bar);return [ref.join(':'),ref] as const;})).values()];
export type EditHost<S extends EditBase>={
 score():Score;
 /** A rebuilt score replaces the current one (layout carried over, selection kept in range). */
 adopt(next:Score):void;
 playing():boolean;
 capture():S;
 restore(state:S,inPlace?:boolean):void;
 message(text:string):void;
 clearMessage():void;
 status(text:string):void;
 /** true: the score changed (snapshot re-serialized lazily); false: the snapshot was patched. */
 markDirty(invalidate?:boolean):void;
 /** The playback MIDI must be regenerated. */
 playbackChanged():void;
 render(firstChangedBar?:number):void;
 scheduleFretDraw(bar:number):void;
 updateInspector():void;
 resetLoop():void;
 snapshot:EditSnapshot;
};
export function createEditTransactions<S extends EditBase>(host:EditHost<S>,limit=60){
 const undo:S[]=[],redo:S[]=[];
 /** A new undo entry; any redo history is gone. */
 function record(before:S){undo.push(before);if(undo.length>limit)undo.shift();redo.length=0;}
 const paused=()=>{if(host.playing()){host.message('一時停止してから編集してください。');return false;}return true;};
 /** Independent beat edits share the fret path: no full-song reconstruction. */
 function commitBeats(beats:Beat[],fn:()=>void,text:string){return perfTime('edit.local',()=>commitBeatsNow(beats,fn,text));}
 function commitBeatsNow(beats:Beat[],fn:()=>void,text:string){
  if(!paused())return false;if(!beats.length)return false;
  const before=host.capture();before.firstChangedBar=Math.max(0,Math.min(...beats.map(b=>b.voice.bar.index))-3);before.bars=barRefs(beats);
  try{fn();for(const b of beats){b.finish(settings);host.snapshot.patchBeat(host.score(),b);}record(before);host.playbackChanged();host.markDirty(false);host.scheduleFretDraw(Math.min(...beats.map(b=>b.voice.bar.index)));host.updateInspector();host.status(text);return true;}
  catch(e){host.restore(before);host.render(before.firstChangedBar);host.message(e instanceof Error?e.message:String(e));return false;}
 }
 /** Runs fn on the score. A result replaces the score; otherwise an edit confined to
  * localBar re-finishes only that measure, and anything else normalizes the song. */
 function commit(fn:(s:Score)=>Score|void,success:string,firstChangedBar?:number,localBar?:at.model.Bar):boolean{return perfTime('edit.commit',()=>commitNow(fn,success,firstChangedBar,localBar));}
 function commitNow(fn:(s:Score)=>Score|void,success:string,firstChangedBar?:number,localBar?:at.model.Bar):boolean{
  if(!paused())return false;const before=host.capture();before.firstChangedBar=firstChangedBar;
  try{host.clearMessage();const score=host.score(),result=fn(score);
   if(!result&&localBar&&localBar.staff.bars[localBar.index]===localBar&&canRefinishBar(localBar)){perfTime('edit.refinish',()=>refinishBar(localBar));host.snapshot.patchBar(score,localBar);before.bars=[barRef(localBar)];record(before);host.playbackChanged();host.markDirty(false);host.render(firstChangedBar);host.status(success);return true;}
   // Still confined to one measure (it gained a link), so undo can swap just that measure.
   if(!result&&localBar)before.bars=[barRef(localBar)];
   const normalized=result?null:perfTime('edit.normalize',()=>normalizeEdit(score)),next=result??normalized!.score;record(before);host.adopt(next);host.markDirty();if(normalized)host.snapshot.set(host.score(),normalized.data);host.render(firstChangedBar);host.status(success);return true;}
  catch(error){const score=host.score(),inPlace=!!localBar&&score.tracks[localBar.staff.track.index]?.staves[localBar.staff.index]?.bars[localBar.index]===localBar&&restoreBars(score,before.data,[barRef(localBar)]);host.restore(before,inPlace);host.render(firstChangedBar);host.message(error instanceof Error?error.message:String(error));return false;}
 }
 /** Undo (back) or redo. */
 function history(back:boolean){perfTime('edit.history',()=>historyNow(back));}
 function historyNow(back:boolean){
  if(host.playing())return;const from=back?undo:redo,to=back?redo:undo;if(!from.length)return;const state=from.pop()!;to.push({...host.capture(),firstChangedBar:state.firstChangedBar,bars:state.bars});
  // A bar-local edit is undone by swapping only its measures; the Score (and MIDI) stay.
  const inPlace=!!state.bars&&perfTime('edit.restoreBars',()=>restoreBars(host.score(),state.data,state.bars!));
  host.restore(state,inPlace);host.resetLoop();if(inPlace){host.playbackChanged();host.markDirty(false);}else host.markDirty();host.snapshot.set(host.score(),state.data,false);host.render(state.firstChangedBar);
 }
 return {undo,redo,record,commit,commitBeats,history};
}
