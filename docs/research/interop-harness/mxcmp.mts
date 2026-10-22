import {readFileSync} from 'node:fs';
const {DOMParser}=(await import('file:///C:/Users/takeu/Desktop/Tab Studio/node_modules/.pnpm/@xmldom+xmldom@0.9.12/node_modules/@xmldom/xmldom/lib/index.js')).default;Object.assign(globalThis,{DOMParser});
const root='file:///C:/Users/takeu/Desktop/Tab Studio/src/';
const {importGuitarPro}=await import(root+'score.ts');const {importTg}=await import(root+'tg-reader.ts');
const load=(f:string)=>{const b=new Uint8Array(readFileSync(f));return f.endsWith('.tg')?importTg(b).score:importGuitarPro(b);};
function keys(s:any){const k:string[]=[];let fret=0,tabStaves=0,staves=0,all=0;for(const t of s.tracks)for(const st of t.staves){staves++;if(st.showTablature&&!st.isPercussion)tabStaves++;for(const bar of st.bars)for(const v of bar.voices)for(const be of v.beats)for(const n of be.notes){if(n.isTieDestination)continue;all++;if(n.fret>=0&&n.string>0)fret++;k.push([bar.index,be.playbackStart,n.realValue].join(':'));}}return {k,fret,tabStaves,staves,all};}
const [a,b]=process.argv.slice(2);const A=keys(load(a)),B=keys(load(b));
const bag=new Map<string,number>();for(const x of A.k)bag.set(x,(bag.get(x)??0)+1);let same=0;for(const x of B.k){const n=bag.get(x)??0;if(n>0){same++;bag.set(x,n-1);}}
console.log(JSON.stringify({ref:a.split('/').pop(),mx:b.split('/').pop(),refNotes:A.all,mxNotes:B.all,pitchOnsetRecall:+(same/A.all).toFixed(3),precision:+(same/B.all).toFixed(3),mxFretAssigned:+(B.fret/B.all).toFixed(3),mxTabStaves:`${B.tabStaves}/${B.staves}`,refTabStaves:`${A.tabStaves}/${A.staves}`}));
