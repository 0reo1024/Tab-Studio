import * as at from '@coderline/alphatab';
import {settings,type Score} from './score';
import {cleanEditJson} from './edit-json';
import {attachAudioData,restoreAudioData} from './mixer-state';

export type ScoreData=ReturnType<typeof at.model.JsonConverter.scoreToJsObject>;
/** Reuse unchanged immutable subtrees between history entries. A single fret
 * edit should not retain sixty complete copies of a long song in memory. */
function share(previous:any,next:any):any{
  if(previous===next)return previous;
  if(previous instanceof Map&&next instanceof Map){let same=previous.size===next.size;for(const [key,value]of next){const old=previous.get(key),item=share(old,value);if(item!==value||typeof value==='string'&&old===value)next.set(key,item);if(!previous.has(key)||item!==old)same=false;}return same?previous:next;}
  if(Array.isArray(previous)&&Array.isArray(next)){let same=previous.length===next.length;for(let i=0;i<next.length;i++){const old=previous[i];next[i]=share(old,next[i]);if(next[i]!==old)same=false;}return same?previous:next;}
  if(previous&&next&&Object.getPrototypeOf(previous)===Object.prototype&&Object.getPrototypeOf(next)===Object.prototype){let same=Object.keys(previous).length===Object.keys(next).length;for(const key of Object.keys(next)){if(!(key in previous)){same=false;continue;}const old=previous[key],item=share(old,next[key]);next[key]=item;if(item!==old)same=false;}return same?previous:next;}
  return next;
}
/** A detached shallow view: serializing it reads only the overridden children. */
function clone<T extends object>(source:T,override:object):T{return Object.assign(Object.create(Object.getPrototypeOf(source)),source,override);}
/** History keeps the serializer's object graph directly. JSON encoding is only
 * needed at the file/storage boundary, not while editing or undoing. */
export class EditSnapshot {
  private owner:Score|null=null;
  private data:ScoreData|undefined;
  invalidate(){this.owner=null;}
  get(score:Score):ScoreData{if(this.owner!==score){this.owner=score;this.data=share(this.data,attachAudioData(score,at.model.JsonConverter.scoreToJsObject(score)));}return this.data!;}
  /** Copy only the edited beat and its ancestry. Previous history entries stay
   * immutable; unchanged tracks/measures retain their existing snapshot nodes. */
  patchBeat(score:Score,beat:at.model.Beat){
    const voice=beat.voice,bar=voice.bar;
    this.patch(score,bar,{voices:[clone(voice,{beats:[beat]})]},excerpt=>excerpt.get('voices')[0].get('beats')[0],['voices',voice.index,'beats',beat.index]);
  }
  /** Same ancestry copy for a whole measure of one staff (bar-local structural edits). */
  patchBar(score:Score,bar:at.model.Bar){this.patch(score,bar,{},excerpt=>excerpt,[]);}
  private patch(score:Score,bar:at.model.Bar,barOverride:object,pick:(bar:Map<string,any>)=>any,tail:(string|number)[]){
    const old=this.get(score)!,staff=bar.staff,track=staff.track;
    const view=clone(score,{masterBars:[bar.masterBar],tracks:[clone(track,{staves:[clone(staff,{bars:[clone(bar,barOverride)]})]})]}) as Score;
    const excerpt=at.model.JsonConverter.scoreToJsObject(view)!;
    const fresh=pick((excerpt.get('tracks') as Map<string,any>[])[0].get('staves')[0].get('bars')[0]);
    const path:(string|number)[]=['tracks',track.index,'staves',staff.index,'bars',bar.index,...tail];
    const replace=(node:any,index:number):any=>{if(index===path.length)return fresh;const key=path[index];if(Array.isArray(node)){const copy=node.slice();copy[key as number]=replace(node[key as number],index+1);return copy;}const copy=new Map(node);copy.set(key,replace(node.get(key),index+1));return copy;};
    this.owner=score;this.data=replace(old,0);
  }
  /** Track headers (name, playback info, mixer/audio settings) changed without
   * touching notes: refresh everything except the staves and master bars. */
  patchTracks(score:Score){
    const old=this.get(score)!,view=clone(score,{masterBars:[],tracks:score.tracks.map(t=>clone(t,{staves:[]}))}) as Score;
    const fresh=attachAudioData(score,at.model.JsonConverter.scoreToJsObject(view))!,next=new Map(old);
    for(const [key,value]of fresh)if(key!=='masterbars'&&key!=='tracks')next.set(key,value);
    const tracks=old.get('tracks') as Map<string,any>[];next.set('tracks',(fresh.get('tracks') as Map<string,any>[]).map((track,i)=>{const copy=new Map(track);copy.set('staves',tracks[i].get('staves'));return copy;}));
    this.owner=score;this.data=share(old,next);
  }
  set(score:Score,data:ScoreData,reuse=true){this.owner=score;this.data=reuse?share(this.data,data):data;}
}
// The JSON loader also feeds plain objects into this converter internally.
export function restoreScore(data:ScoreData|Record<string,any>):Score{return restoreAudioData(at.model.JsonConverter.jsObjectToScore(data as ScoreData,settings),data);}
export function normalizeEdit(score:Score):{score:Score;data:ScoreData}{const data=attachAudioData(score,at.model.JsonConverter.scoreToJsObject(score));cleanEditJson(data);return {score:restoreScore(data),data};}
/** A ScoreData subtree (Maps) as plain JSON objects. */
export function plain(value:any):any{
  if(value instanceof Map){const result:Record<string,any>={};for(const [key,item]of value)if(item!==undefined)result[key]=plain(item);return result;}
  return Array.isArray(value)?value.map(plain):value;
}
export function editData(score:Score):Record<string,any>{return plain(attachAudioData(score,at.model.JsonConverter.scoreToJsObject(score)));}
/** Serialize a detached view of just the copied measures. Shared model objects
 * are read only, so copying a beat never serializes the rest of the song. */
export function excerptJson(score:Score,start:number,end:number,track:number|null){
  const view=Object.assign(Object.create(Object.getPrototypeOf(score)),score,{masterBars:score.masterBars.slice(start,end+1),tracks:(track===null?score.tracks:[score.tracks[track]]).map(t=>Object.assign(Object.create(Object.getPrototypeOf(t)),t,{staves:t.staves.map(s=>Object.assign(Object.create(Object.getPrototypeOf(s)),s,{bars:s.bars.slice(start,end+1)}))}))}) as Score;
  return editData(view);
}
