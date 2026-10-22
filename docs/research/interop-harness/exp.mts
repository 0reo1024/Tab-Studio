import {readFileSync,writeFileSync} from 'node:fs';
const {DOMParser}=(await import('file:///C:/Users/takeu/Desktop/Tab Studio/node_modules/.pnpm/@xmldom+xmldom@0.9.12/node_modules/@xmldom/xmldom/lib/index.js')).default;Object.assign(globalThis,{DOMParser});
const root='file:///C:/Users/takeu/Desktop/Tab Studio/src/';
const {importGuitarPro}=await import(root+'score.ts');const {importTg}=await import(root+'tg-reader.ts');const {exportScore}=await import(root+'export-score.ts');
const [out,...files]=process.argv.slice(2);let i=0;const map:any[]=[];
for(const f of files){i++;const b=new Uint8Array(readFileSync(f));const s=f.endsWith('.tg')?importTg(b).score:importGuitarPro(b);
 let notes=0,bars=s.masterBars.length;for(const t of s.tracks)for(const st of t.staves)for(const bar of st.bars)for(const v of bar.voices)for(const be of v.beats)if(!be.isEmpty)notes+=be.notes.filter((n:any)=>!n.isTieDestination).length;
 writeFileSync(`${out}/e${i}.gp`,exportScore(s,'gp'));writeFileSync(`${out}/e${i}.mid`,exportScore(s,'mid'));map.push({id:'e'+i,file:f.split('/').pop(),bars,notesNoTie:notes,tracks:s.tracks.length});}
writeFileSync(`${out}/map.json`,JSON.stringify(map,null,1));
