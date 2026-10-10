import {plain,type ScoreData} from '../edit-snapshot';
import type {At,EditOp,ListName} from './index';
/** Turns the change between two edit snapshots into core ops (migration P3-6).
 *
 * EditSnapshot keeps unchanged subtrees as the very same objects across edits (share /
 * patchBeat / patchBar), so a changed measure, master bar or header field is found by
 * reference, without comparing contents: the diff costs one step per measure, and only
 * what changed is serialized.
 *
 * When measures were inserted or removed, share() pairs measures by position, so the
 * ones after the change are equal but no longer the same objects; the unchanged start
 * and end of the list are then found by content, and the middle becomes removes and
 * inserts. Track or staff counts changing becomes one whole-score replacement. */
type Data=Map<string,any>;
const list=(node:Data,key:string):Data[]=>node.get(key)??[];
/** Same content (Maps, arrays, plain values), stopping at the first difference. */
function same(a:unknown,b:unknown):boolean{
 if(a===b)return true;
 if(a instanceof Map&&b instanceof Map){if(a.size!==b.size)return false;for(const [k,v]of a)if(!b.has(k)||!same(v,b.get(k)))return false;return true;}
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>same(v,b[i]));
 if(a&&b&&typeof a==='object'&&typeof b==='object'){const ka=Object.keys(a),kb=Object.keys(b);return ka.length===kb.length&&ka.every(k=>same((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));}
 return Number.isNaN(a)&&Number.isNaN(b);
}
/** Field changes of a node's own fields (children lists excluded). */
function fields(prev:Data,next:Data,at:At,children:string[]):EditOp[]{
 const ops:EditOp[]=[];
 for(const key of new Set([...prev.keys(),...next.keys()])){
  if(children.includes(key))continue;
  const a=prev.get(key),b=next.get(key);
  if(a!==b)ops.push({op:'set',at,key,value:b===undefined?null:plain(b)});
 }
 return ops;
}
/** The range [start, end) of `prev` that differs from `next`, with the unchanged head and
 * tail found by content (head first by reference, which is the common case). */
function changedRange(prev:Data[],next:Data[]){
 let head=0;while(head<prev.length&&head<next.length&&(prev[head]===next[head]||same(prev[head],next[head])))head++;
 let tail=0;while(tail<prev.length-head&&tail<next.length-head&&same(prev[prev.length-1-tail],next[next.length-1-tail]))tail++;
 return {head,removed:prev.length-head-tail,inserted:next.slice(head,next.length-tail)};
}
function splice(ops:EditOp[],at:At,name:ListName,prev:Data[],next:Data[]){
 const {head,removed,inserted}=changedRange(prev,next);
 for(let i=0;i<removed;i++)ops.push({op:'remove',at,list:name,index:head});
 inserted.forEach((node,i)=>ops.push({op:'insert',at,list:name,index:head+i,node:plain(node)}));
}
export function snapshotOps(prevData:ScoreData,nextData:ScoreData):EditOp[]{
 const prev=prevData as unknown as Data,next=nextData as unknown as Data;
 if(prev===next)return [];
 const pt=list(prev,'tracks'),nt=list(next,'tracks');
 if(pt.length!==nt.length||nt.some((track,t)=>list(track,'staves').length!==list(pt[t],'staves').length))return [{op:'replaceScore',score:plain(next)}];
 const ops=fields(prev,next,{},['masterbars','tracks']);
 const replace=(at:At,name:'masterbars'|'bars',index:number,node:Data)=>{ops.push({op:'replace',at,list:name,index,node:plain(node)});};
 const pm=list(prev,'masterbars'),nm=list(next,'masterbars');
 if(pm.length===nm.length)nm.forEach((m,i)=>{if(m!==pm[i])replace({},'masterbars',i,m);});
 else splice(ops,{},'masterbars',pm,nm);
 nt.forEach((track,t)=>{
  const old=pt[t];if(track===old)return;
  ops.push(...fields(old,track,{track:t},['staves']));
  list(track,'staves').forEach((staff,s)=>{
   const was=list(old,'staves')[s];if(staff===was)return;
   ops.push(...fields(was,staff,{track:t,staff:s},['bars']));
   const pb=list(was,'bars'),nb=list(staff,'bars');
   if(pb.length===nb.length)nb.forEach((bar,b)=>{if(bar!==pb[b])replace({track:t,staff:s},'bars',b,bar);});
   else splice(ops,{track:t,staff:s},'bars',pb,nb);
  });
 });
 return ops;
}
