import {readFileSync} from 'node:fs';
const {DOMParser}=(await import('file:///C:/Users/takeu/Desktop/Tab Studio/node_modules/.pnpm/@xmldom+xmldom@0.9.12/node_modules/@xmldom/xmldom/lib/index.js')).default;Object.assign(globalThis,{DOMParser});
const root='file:///C:/Users/takeu/Desktop/Tab Studio/src/';
const {importGuitarPro}=await import(root+'score.ts');const {importTg}=await import(root+'tg-reader.ts');const {exportScore}=await import(root+'export-score.ts');
const f=process.argv[2];const b=new Uint8Array(readFileSync(f));const s=f.endsWith('.tg')?importTg(b).score:importGuitarPro(b);
const find=(sc:any)=>{const r:any[]=[];for(const t of sc.tracks)for(const st of t.staves)for(const bar of st.bars)for(const v of bar.voices)for(const be of v.beats)for(const n of be.notes)if(n.bendType===1||r.length&&false)r.push({t:t.index,bar:bar.index,v:v.index,beat:be.index,str:n.string,type:n.bendType,pts:n.bendPoints?.map((p:any)=>p.offset+':'+p.value).join(' ')});return r;};
const a=find(s).slice(0,3);console.log('before',a);
const back=importGuitarPro(exportScore(s,'gp'));
for(const x of a){const be=back.tracks[x.t].staves[0].bars[x.bar].voices[x.v].beats[x.beat];const n=be.notes.find((n:any)=>n.string===x.str);console.log('after',x.bar,n?.bendType,n?.bendPoints?.map((p:any)=>p.offset+':'+p.value).join(' '));}
