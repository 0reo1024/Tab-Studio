/// <reference lib="webworker" />
const scores=new Map<number,unknown>();
/** Rebuild only the changed path; untouched subtrees stay shared with the previous copy. */
function apply(old:any,patch:any):any{
 if('r' in patch)return patch.r;
 if(patch.m){const next=new Map(old instanceof Map?old:[]);for(const key of patch.d)next.delete(key);for(const [key,child]of patch.m)next.set(key,apply(next.get(key),child));return next;}
 const next=(Array.isArray(old)?old:[]).slice(0,patch.n);for(const [i,child]of patch.a)next[i]=apply(next[i],child);return next;
}
self.onmessage=(event:MessageEvent<any>)=>{
 const payload=event.data;
 if(payload.cmd==='document'){scores.set(payload.id,payload.data);return;}
 if(payload.cmd==='remove'){scores.delete(payload.id);return;}
 if(payload.cmd==='patch'){if(scores.has(payload.id))scores.set(payload.id,apply(scores.get(payload.id),payload.patch));return;}
 const {revision,sourceName,warnings,activeDocument,documents}=payload,data=scores.get(activeDocument);if(data===undefined)return;
 const workspace={activeDocument,documents:documents.map((doc:any)=>({...doc,score:scores.get(doc.id)??data}))};
 const json=JSON.stringify({format:'TabStudio',version:1,sourceName,warnings,score:data,workspace},(_key,value)=>value instanceof Map?Object.fromEntries(value):value);
 self.postMessage({revision,json});
};
