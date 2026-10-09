/// <reference lib="webworker" />
import {gzipSync} from 'fflate';
const scores=new Map<number,unknown>();
/** Documents (by snapshot identity) the desktop store already holds. */
const written=new Map<number,unknown>();
/** Rebuild only the changed path; untouched subtrees stay shared with the previous copy. */
function apply(old:any,patch:any):any{
 if('r' in patch)return patch.r;
 if(patch.m){const next=new Map(old instanceof Map?old:[]);for(const key of patch.d)next.delete(key);for(const [key,child]of patch.m)next.set(key,apply(next.get(key),child));return next;}
 const next=(Array.isArray(old)?old:[]).slice(0,patch.n);for(const [i,child]of patch.a)next[i]=apply(next[i],child);return next;
}
const json=(value:unknown)=>JSON.stringify(value,(_key,item)=>item instanceof Map?Object.fromEntries(item):item);
const encoder=new TextEncoder();
self.onmessage=(event:MessageEvent<any>)=>{
 const payload=event.data;
 if(payload.cmd==='document'){scores.set(payload.id,payload.data);return;}
 if(payload.cmd==='remove'){scores.delete(payload.id);return;}
 if(payload.cmd==='patch'){if(scores.has(payload.id))scores.set(payload.id,apply(scores.get(payload.id),payload.patch));return;}
 if(payload.cmd==='reset'){written.clear();return;}
 const {revision,sourceName,warnings,activeDocument,documents,split}=payload,data=scores.get(activeDocument);if(data===undefined)return;
 if(split){
  // Desktop: one compressed file per document, rewritten only when its snapshot changed.
  const files:{id:number;bytes:Uint8Array}[]=[],transfer:ArrayBuffer[]=[];let bytes=0;
  for(const doc of documents){const score=scores.get(doc.id)??data;if(written.get(doc.id)===score)continue;const packed=gzipSync(encoder.encode(json(score)),{level:1});files.push({id:doc.id,bytes:packed});transfer.push(packed.buffer as ArrayBuffer);written.set(doc.id,score);bytes+=packed.byteLength;}
  const ids=new Set(documents.map((doc:any)=>doc.id)),remove=[...written.keys()].filter(id=>!ids.has(id));for(const id of remove)written.delete(id);
  self.postMessage({revision,manifest:json({format:'TabStudio',version:1,sourceName,warnings,activeDocument,documents}),files,remove,bytes},transfer);
  return;
 }
 const workspace={activeDocument,documents:documents.map((doc:any)=>({...doc,score:scores.get(doc.id)??data}))};
 self.postMessage({revision,json:json({format:'TabStudio',version:1,sourceName,warnings,score:data,workspace})});
};
