/// <reference lib="webworker" />
const scores=new Map<number,unknown>();
self.onmessage=(event:MessageEvent<any>)=>{
 const payload=event.data;
 if(payload.cmd==='document'){scores.set(payload.id,payload.data);return;}
 if(payload.cmd==='remove'){scores.delete(payload.id);return;}
 const {revision,data,sourceName,warnings,activeDocument,documents}=payload;scores.set(activeDocument,data);
 const workspace={activeDocument,documents:documents.map((doc:any)=>({...doc,score:scores.get(doc.id)??data}))};
 const json=JSON.stringify({format:'TabStudio',version:1,sourceName,warnings,score:data,workspace},(_key,value)=>value instanceof Map?Object.fromEntries(value):value);
 self.postMessage({revision,json});
};
