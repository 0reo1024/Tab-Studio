import type {ScoreFormat} from '../export-score';
import type {LayoutSettings} from '../layout-settings';
import type {ScoreData} from '../edit-snapshot';
/** Foreground open/save/export, delegated to a long-lived document worker. The
 * background-tab loader uses its own instance, which it releases when idle. */
let worker:Worker|undefined,next=0;
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
function documentWorker(){
 if(worker)return worker;
 const created=new Worker(new URL('../document-loader.worker.ts',import.meta.url),{type:'module'});
 created.onmessage=({data})=>{const request=pending.get(data.id);if(!request)return;pending.delete(data.id);if(data.error)request.reject(new Error(data.error));else request.resolve(data);};
 created.onerror=event=>{for(const request of pending.values())request.reject(new Error(event.message||'譜面を処理できませんでした。'));pending.clear();created.terminate();if(worker===created)worker=undefined;};
 return worker=created;
}
function call<T>(message:Record<string,unknown>,transfer:Transferable[]=[]):Promise<T>{const id=++next;return new Promise<T>((resolve,reject)=>{pending.set(id,{resolve,reject});documentWorker().postMessage({...message,id},transfer);});}
export function parseDocument(name:string,bytes:Uint8Array){const copy=new Uint8Array(bytes);return call<{data:ScoreData;warnings:string[];layout?:LayoutSettings}>({cmd:'tabStudio.document',name,bytes:copy},[copy.buffer]);}
/** 'save' writes Tab Studio's TG (with project data); other formats match the export dialog. */
export async function encodeDocument(format:'save'|ScoreFormat,data:ScoreData,layout:LayoutSettings,sourceName:string,warnings:string[]){return (await call<{bytes:Uint8Array}>({cmd:'tabStudio.export',format,data,layout,sourceName,warnings})).bytes;}
export async function documentJson(data:ScoreData){return (await call<{json:string}>({cmd:'tabStudio.json',data})).json;}
