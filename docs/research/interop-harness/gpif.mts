import {readFileSync,writeFileSync} from 'node:fs';
const {DOMParser}=(await import('file:///C:/Users/takeu/Desktop/Tab Studio/node_modules/.pnpm/@xmldom+xmldom@0.9.12/node_modules/@xmldom/xmldom/lib/index.js')).default;Object.assign(globalThis,{DOMParser});
const root='file:///C:/Users/takeu/Desktop/Tab Studio/src/';
const {importGuitarPro}=await import(root+'score.ts');const {importTg}=await import(root+'tg-reader.ts');const {exportScore}=await import(root+'export-score.ts');
const ff=await import('file:///C:/Users/takeu/Desktop/Tab Studio/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/index.mjs');
const f=process.argv[2];const b=new Uint8Array(readFileSync(f));const s=f.endsWith('.tg')?importTg(b).score:importGuitarPro(b);
let byType:any={};for(const t of s.tracks)for(const st of t.staves)for(const bar of st.bars)for(const v of bar.voices)for(const be of v.beats)for(const n of be.notes)if(n.bendType)byType[n.bendType]=(byType[n.bendType]??0)+1;
const gp=exportScore(s,'gp');const z=ff.unzipSync(gp);const x=ff.strFromU8(z['Content/score.gpif']);
console.log('source bends by type',byType,'gpif Bended props',(x.match(/<Property name="Bended">/g)||[]).length,'BendOriginValue',(x.match(/BendOriginValue/g)||[]).length);
const back=importGuitarPro(gp);let bb:any={};for(const t of back.tracks)for(const st of t.staves)for(const bar of st.bars)for(const v of bar.voices)for(const be of v.beats)for(const n of be.notes)if(n.bendType)bb[n.bendType]=(bb[n.bendType]??0)+1;console.log('reimported',bb);
// first custom bend: find its gpif note by checking whether points survived in xml near BendMiddle
