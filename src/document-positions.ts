import {visibilityKey} from './track-visibility';

export type PositionSelection={track:number;staff:number;bar:number;voice:number;beat:number;string:number;surface?:'tab'|'standard';note?:number;pitch?:number};
/** Where a saved file was last viewed: playback position, scroll offsets and the selected beat. */
export type DocumentPosition={tick:number;top:number;left:number;selected:PositionSelection|null};
type Storage={getItem(key:string):string|null;setItem(key:string,value:string):void};
const storageKey='tabstudio-positions',limit=100;
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;

function readSelection(raw:any):PositionSelection|null{
 if(!raw||typeof raw!=='object')return null;
 for(const key of ['track','staff','bar','voice','beat','string'])if(!Number.isInteger(raw[key])||raw[key]<0)return null;
 const result:PositionSelection={track:raw.track,staff:raw.staff,bar:raw.bar,voice:raw.voice,beat:raw.beat,string:raw.string};
 if(raw.surface==='tab'||raw.surface==='standard')result.surface=raw.surface;
 if(Number.isInteger(raw.note))result.note=raw.note;if(Number.isInteger(raw.pitch))result.pitch=raw.pitch;
 return result;
}

/** Last positions of recently used files, newest last; capped so the list cannot grow without bound. */
export function createPositionStore(storage:Storage){
 const positions=new Map<string,DocumentPosition>();
 try{const saved=JSON.parse(storage.getItem(storageKey)||'[]');if(Array.isArray(saved))for(const entry of saved.slice(-limit)){if(!Array.isArray(entry)||typeof entry[0]!=='string')continue;const p=entry[1];if(p&&finite(p.tick)&&finite(p.top)&&finite(p.left))positions.set(entry[0],{tick:p.tick,top:p.top,left:p.left,selected:readSelection(p.selected)});}}catch{}
 return {
  get(path:string):DocumentPosition|undefined{const p=path&&positions.get(visibilityKey(path));return p?structuredClone(p):undefined;},
  /** Records several files at once with a single storage write. */
  remember(entries:{path:string;position:DocumentPosition}[]){
   let changed=false;
   for(const {path,position}of entries){if(!path||!finite(position.tick)||!finite(position.top)||!finite(position.left))continue;const key=visibilityKey(path);positions.delete(key);positions.set(key,{tick:position.tick,top:position.top,left:position.left,selected:readSelection(position.selected)});changed=true;}
   if(!changed)return;while(positions.size>limit)positions.delete(positions.keys().next().value!);
   try{storage.setItem(storageKey,JSON.stringify([...positions]));}catch{}
  },
 };
}
