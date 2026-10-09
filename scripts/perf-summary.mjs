// Print a compact table from one or two perf-benchmark reports: node scripts/perf-summary.mjs base.json [after.json]
import fs from 'node:fs';
const [a,b]=process.argv.slice(2).map(f=>JSON.parse(fs.readFileSync(f,'utf8')));
const fmt=v=>v===undefined?'-':`${v.median} / ${v.p95} / ${v.max}`;
for(const name of Object.keys(a.fixtures)){
 const A=a.fixtures[name],B=b?.fixtures[name];console.log(`\n### ${name} (${A.bars} bars × ${A.tracks} tracks, ${A.notes} notes)\n`);
 console.log(b?'| metric | baseline median / p95 / max (ms) | after median / p95 / max (ms) |\n|---|---|---|':'| metric | median / p95 / max (ms) |\n|---|---|');
 const row=(label,x,y)=>console.log(b?`| ${label} | ${fmt(x)} | ${fmt(y)} |`:`| ${label} | ${fmt(x)} |`);
 for(const [k,v]of Object.entries(A.wall)){if(v.handler){row(k+' handler',v.handler,B?.wall[k]?.handler);row(k+' settled',v.settled,B?.wall[k]?.settled);}else row(k,v,B?.wall[k]);}
 for(const k of [...new Set([...Object.keys(A.spans),...Object.keys(B?.spans??{})])].sort())row('span '+k+(k==='recovery.bytes'?' (KB)':''),A.spans[k],B?.spans[k]);
 for(const k of [...new Set([...Object.keys(A.loadSpans??{}),...Object.keys(B?.loadSpans??{})])].filter(k=>k.startsWith('file.')).sort())row('load span '+k,A.loadSpans?.[k],B?.loadSpans?.[k]);
 row('longTasks',A.longTasks,B?.longTasks);
 const stress=r=>r?.playbackStress?`${r.playbackStress.underrunFrames} underrun frames, main-thread audio packet work ${r.playbackStress.mainThreadPacketMs?`${r.playbackStress.mainThreadPacketMs.total}ms in ${r.playbackStress.mainThreadPacketMs.count} packets`:'none'}`:'-';
 console.log(`\nplayback with the main thread blocked 1s of every 1.3s: ${stress(A)}${b?' → '+stress(B):''}`);
 for(const r of [A,B])if(r?.snapshotConsistent!=null)console.log(`\nsnapshot consistent after edits (${r===A?'first':'second'} report): ${r.snapshotConsistent}`);
 console.log(`\nplayback underrun frames: ${A.playback.underrunFrames}${b?' → '+B?.playback.underrunFrames:''}; long tasks during playback: ${A.playback.longTasks}${b?' → '+B?.playback.longTasks:''}`);
}
