/** Lightweight timing probes for the editor's hot paths. Each sample is also a
 * performance.measure entry, so DevTools traces show the same spans. Only the
 * most recent samples are kept; nothing here allocates per frame. */
const LIMIT=2000;
const samples=new Map<string,number[]>();
export function perfRecord(name:string,ms:number,start=performance.now()-ms){
 let list=samples.get(name);if(!list){list=[];samples.set(name,list);}
 list.push(ms);if(list.length>LIMIT){list.splice(0,list.length-LIMIT);performance.clearMeasures(name);}
 try{performance.measure(name,{start,duration:ms});}catch{}
}
export function perfStart(name:string){const start=performance.now();return ()=>perfRecord(name,performance.now()-start,start);}
export function perfTime<T>(name:string,fn:()=>T):T{const done=perfStart(name);try{return fn();}finally{done();}}
export type PerfSummary={count:number;median:number;p95:number;max:number;total:number};
function quantile(sorted:number[],q:number){return sorted[Math.min(sorted.length-1,Math.ceil(q*sorted.length)-1)]??0;}
export function perfSummary(names?:string[]):Record<string,PerfSummary>{
 const result:Record<string,PerfSummary>={};
 for(const [name,list]of samples){if(names&&!names.includes(name))continue;const sorted=[...list].sort((a,b)=>a-b);result[name]={count:sorted.length,median:quantile(sorted,.5),p95:quantile(sorted,.95),max:sorted.at(-1)??0,total:sorted.reduce((a,b)=>a+b,0)};}
 return result;
}
export function perfReset(){samples.clear();performance.clearMeasures();}
