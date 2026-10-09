import {platform} from '../platform/bridge';
import {perfRecord,perfStart} from '../perf';
import {snapshotDiff} from '../snapshot-diff';
/** What the recovery writer needs to know about the open documents. */
export type RecoveryHost={
 hasUnsavedWork:()=>boolean;
 isRendering:()=>boolean;
 /** The active document's id and current snapshot, plus workspace metadata. */
 active:()=>{id:number;data:unknown;sourceName:string;warnings:string[]};
 documentPath:()=>string;
 documents:()=>unknown[];
 message:(text:string)=>void;
};
type RecoveryFiles={revision:number;manifest:string;files:{id:number;bytes:Uint8Array}[];remove:number[];bytes:number};
/** Debounced unsaved-work recovery. Serialization happens in a worker that keeps
 * its own copy of each document; desktop builds store one file per document. */
export function createRecovery(host:RecoveryHost){
 let timer:ReturnType<typeof setTimeout>|undefined,revision=0,postedAt=0;
 let writing:Promise<unknown>=Promise.resolve();
 const worker=new Worker(new URL('../recovery.worker.ts',import.meta.url),{type:'module'});
 /** Snapshots share unchanged subtrees, so only nodes whose identity changed are cloned across threads. */
 const sent=new Map<number,unknown>();
 function post(id:number,data:unknown){const previous=sent.get(id);if(previous===data)return;sent.set(id,data);if(previous===undefined){worker.postMessage({cmd:'document',id,data});return;}worker.postMessage({cmd:'patch',id,patch:snapshotDiff(previous,data)});}
 function remove(id:number){sent.delete(id);worker.postMessage({cmd:'remove',id});}
 // Recovery files can exceed the localStorage quota; desktop builds keep them in userData.
 function writeJson(json:string){const desktop=platform.desktop;if(desktop?.writeRecovery){writing=writing.catch(()=>{}).then(()=>{const done=perfStart('recovery.write');return desktop.writeRecovery!(json).finally(done);}).catch(e=>host.message(`復旧用データを保存できません：${e instanceof Error?e.message:String(e)}`));return;}try{localStorage.setItem('tabstudio-recovery',json);}catch{host.message('復旧用データが大きすぎるため保存できませんでした。');}}
 /** Only documents whose snapshot changed are written. A failed write makes the
  * worker forget what is stored, so the next save is complete. */
 function writeFiles(payload:RecoveryFiles){writing=writing.catch(()=>{}).then(()=>{const done=perfStart('recovery.write');return platform.desktop!.writeRecoveryDocuments!({manifest:payload.manifest,files:payload.files,remove:payload.remove}).finally(done);}).catch(e=>{worker.postMessage({cmd:'reset'});host.message(`復旧用データを保存できません：${e instanceof Error?e.message:String(e)}`);});}
 function cancel(){clearTimeout(timer);}
 function clear(){worker.postMessage({cmd:'reset'});try{localStorage.removeItem('tabstudio-recovery');}catch{}const desktop=platform.desktop;if(desktop?.clearRecovery)writing=writing.catch(()=>{}).then(()=>desktop.clearRecovery!()).catch(()=>{});}
 async function read():Promise<string|null>{let legacy:string|null=null;try{legacy=localStorage.getItem('tabstudio-recovery');}catch{}const desktop=platform.desktop;if(desktop?.readRecovery){try{const text=await desktop.readRecovery();if(text)return text;}catch{}}return legacy;}
 worker.onmessage=(event:MessageEvent<{revision:number;json:string}|RecoveryFiles>)=>{const data=event.data;if(postedAt){perfRecord('recovery.worker',performance.now()-postedAt,postedAt);postedAt=0;}perfRecord('recovery.bytes',('json' in data?data.json.length:data.bytes)/1024);
  if('manifest' in data){if(!host.hasUnsavedWork()){worker.postMessage({cmd:'reset'});return;}writeFiles(data);}
  else{if(!host.hasUnsavedWork()||data.revision!==revision)return;writeJson(data.json);}
  try{localStorage.setItem('tabstudio-recovery-path',host.documentPath());}catch{}};
 function schedule(){cancel();const current=++revision;const persist=()=>{if(current!==revision||!host.hasUnsavedWork())return;if(host.isRendering()){timer=setTimeout(persist,100);return;}const done=perfStart('recovery.post'),active=host.active();post(active.id,active.data);worker.postMessage({revision:current,sourceName:active.sourceName,warnings:active.warnings,activeDocument:active.id,documents:host.documents(),split:!!platform.desktop?.writeRecoveryDocuments});done();postedAt=performance.now();};timer=setTimeout(persist,700);}
 return {post,remove,schedule,cancel,clear,read};
}
