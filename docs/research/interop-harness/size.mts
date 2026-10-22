import {readFileSync} from 'node:fs';
const {DOMParser}=(await import('file:///C:/Users/takeu/Desktop/Tab Studio/node_modules/.pnpm/@xmldom+xmldom@0.9.12/node_modules/@xmldom/xmldom/lib/index.js')).default;Object.assign(globalThis,{DOMParser});
const root='file:///C:/Users/takeu/Desktop/Tab Studio/src/';
const {importGuitarPro,serialize,project}=await import(root+'score.ts');
const s=importGuitarPro(new Uint8Array(readFileSync(process.argv[2])));
const j=serialize(s);console.log('tracks',s.tracks.length,'bars',s.masterBars.length,'serializedJSON MB',(j.length/1e6).toFixed(1),'project MB',(project(s,'x',[]).length/1e6).toFixed(1));
const o=JSON.parse(j);const sizes:any={};for(const t of o.tracks){for(const st of t.staves)for(const b of st.bars)for(const v of b.voices)for(const be of v.beats){for(const [k,val] of Object.entries(be)){sizes['beat.'+k]=(sizes['beat.'+k]??0)+JSON.stringify(val).length;}for(const n of be.notes??[])for(const [k,val] of Object.entries(n))sizes['note.'+k]=(sizes['note.'+k]??0)+JSON.stringify(val).length;}}
console.log(Object.entries(sizes).sort((a:any,b:any)=>b[1]-a[1]).slice(0,10).map(([k,v]:any)=>k+' '+(v/1e6).toFixed(1)+'MB').join('\n'));
