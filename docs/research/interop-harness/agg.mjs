import {readFileSync} from 'node:fs';
const rows=JSON.parse(readFileSync(process.argv[2],'utf8'));
const ok=rows.filter(r=>!r.error);console.log('files',rows.length,'loadErrors',rows.filter(r=>r.error).map(r=>r.file+': '+r.error));
for(const f of ['gp','tg','tgNative'])console.log(f,'exportErrors',ok.filter(r=>r[f]?.error).map(r=>r.file+': '+r[f].error));
const byExt={};for(const r of ok){const e=r.file.split('.').pop();(byExt[e]??=[]).push(r);}
for(const [e,rs] of Object.entries(byExt)){for(const f of ['gp','tg','tgNative']){const m=rs.filter(r=>r[f]&&!r[f].error).map(r=>r[f].noteMatch);if(!m.length)continue;m.sort((a,b)=>a-b);console.log(`src=${e} via ${f}: n=${m.length} noteMatch min=${m[0].toFixed(3)} median=${m[m.length>>1].toFixed(3)} perfect=${m.filter(x=>x===1).length}`);}}
const feats={};
for(const r of ok){for(const [k,v] of Object.entries(r.census)){if(k.startsWith('beat.dyn.'))continue;const x=feats[k]??={src:0,files:0,gpLost:0,gpFiles:0,tgLost:0,tgFiles:0,tgNativeLost:0,tgNativeFiles:0,gpGain:0,tgGain:0,tgNativeGain:0};x.src+=v;x.files++;}
 for(const f of ['gp','tg','tgNative']){const d=r[f];if(!d||d.error)continue;for(const [k,v] of Object.entries(d.lost)){if(k.startsWith('beat.dyn.'))continue;const x=feats[k]??={src:0,files:0,gpLost:0,gpFiles:0,tgLost:0,tgFiles:0,tgNativeLost:0,tgNativeFiles:0,gpGain:0,tgGain:0,tgNativeGain:0};x[f+'Lost']+=v;x[f+'Files']++;}for(const [k,v] of Object.entries(d.gained)){if(k.startsWith('beat.dyn.'))continue;const x=feats[k]??={src:0,files:0,gpLost:0,gpFiles:0,tgLost:0,tgFiles:0,tgNativeLost:0,tgNativeFiles:0,gpGain:0,tgGain:0,tgNativeGain:0};x[f+'Gain']+=v;}}}
console.log('feature | srcCount | srcFiles | GP7 lost (files) | TG lost (files) | gain gp/tg');
for(const [k,x] of Object.entries(feats).sort((a,b)=>b[1].files-a[1].files))console.log(`${k} | ${x.src} | ${x.files} | ${x.gpLost} (${x.gpFiles}) | ${x.tgLost} (${x.tgFiles}) | ${x.tgNativeLost} (${x.tgNativeFiles}) | gain ${x.gpGain}/${x.tgGain}/${x.tgNativeGain}`);
const dyn=r=>Object.entries(r).filter(([k])=>k.startsWith('beat.dyn.'));let dl={gp:0,tg:0,tgNative:0};for(const r of ok)for(const f of ['gp','tg','tgNative'])if(r[f]&&!r[f].error)dl[f]+=dyn(r[f].lost).reduce((a,[,v])=>a+v,0);console.log('dynamics-changed beats',dl);
const ratios=ok.filter(r=>r.tgBytes&&r.srcBytes).map(r=>({f:r.file,ratio:r.tgBytes/r.srcBytes,tg:r.tgBytes,src:r.srcBytes})).sort((a,b)=>b.ratio-a.ratio);console.log('TG/source size ratio top',ratios.slice(0,5),'median',ratios[ratios.length>>1]);
const w=new Map();for(const r of ok)for(const x of r.tgNative?.warnings??[])w.set(x,(w.get(x)??0)+1);console.log('tgNative warnings',[...w]);
