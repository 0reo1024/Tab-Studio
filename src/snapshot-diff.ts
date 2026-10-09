/** Patch between two identity-shared snapshot trees (Maps and arrays). Unchanged
 * subtrees are the same objects, so the walk only descends into edited paths.
 * Applied by recovery.worker.ts and by alphaTab's layout worker (render-patch.mjs). */
export type SnapshotPatch={r:unknown}|{m:[unknown,SnapshotPatch][];d:unknown[]}|{a:[number,SnapshotPatch][];n:number};
export function snapshotDiff(a:any,b:any):SnapshotPatch{
 if(a instanceof Map&&b instanceof Map){const m:[unknown,SnapshotPatch][]=[];for(const [k,v]of b)if(!a.has(k))m.push([k,{r:v}]);else if(a.get(k)!==v)m.push([k,snapshotDiff(a.get(k),v)]);return {m,d:[...a.keys()].filter(k=>!b.has(k))};}
 if(Array.isArray(a)&&Array.isArray(b)){const items:[number,SnapshotPatch][]=[];for(let i=0;i<b.length;i++)if(a[i]!==b[i])items.push([i,i<a.length?snapshotDiff(a[i],b[i]):{r:b[i]}]);return {a:items,n:b.length};}
 return {r:b};
}
/** Diagnostics: paths where two plain JSON values differ (at most `limit`). */
export function jsonDifferences(a:unknown,b:unknown,limit=5,path=''):string[]{
 const out:string[]=[];
 const walk=(x:any,y:any,p:string)=>{if(out.length>=limit)return;
  if(x&&y&&typeof x==='object'&&typeof y==='object'&&Array.isArray(x)===Array.isArray(y)){for(const k of new Set([...Object.keys(x),...Object.keys(y)]))walk(x[k],y[k],p+'.'+k);return;}
  if(JSON.stringify(x)!==JSON.stringify(y))out.push(`${p}: ${JSON.stringify(x)?.slice(0,60)} ≠ ${JSON.stringify(y)?.slice(0,60)}`);};
 walk(a,b,path);return out;
}
