// What a whole-song sync into the core costs, step by step (Champagne-sized song).
import fs from 'node:fs';
import {DOMParser} from '@xmldom/xmldom';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
import {importTg} from '../../src/tg-reader';
import {editData,normalizeEdit} from '../../src/edit-snapshot';
import {loadCore,Core} from '../../src/core';
await loadCore(fs.readFileSync('src/core/wasm/tabstudio_core_bg.wasm'));
const score=importTg(new Uint8Array(fs.readFileSync(process.argv[2]))).score;
const time=(label:string,fn:()=>unknown)=>{fn();const t=performance.now();for(let i=0;i<5;i++)fn();console.log(label.padEnd(40),((performance.now()-t)/5).toFixed(1),'ms');};
let data:any,json='';
time('editData (alphaTab -> plain JSON objects)',()=>{data=editData(score);});
time('JSON.stringify',()=>{json=JSON.stringify(data);});
time('core from JSON string (WASM serde)',()=>Core.fromData(data).free());
time('normalizeEdit (today, for comparison)',()=>normalizeEdit(score));
console.log('JSON size',(json.length/1e6).toFixed(1),'MB');
