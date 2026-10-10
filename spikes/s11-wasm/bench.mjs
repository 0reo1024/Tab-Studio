// Spike S11: call cost of the wasm-bindgen module from V8 (Node; same engine as the WebView).
// Usage: node spikes/s11-wasm/bench.mjs  (after building pkg/, see README in the commit)
import fs from 'node:fs';
import {initSync,Doc} from './pkg/s11_wasm.js';
initSync({module:fs.readFileSync(new URL('./pkg/s11_wasm_bg.wasm',import.meta.url))});
const doc=new Doc(100000);
const time=(label,n,fn)=>{fn(0);const t=performance.now();for(let i=0;i<n;i++)fn(i);const us=(performance.now()-t)*1000/n;console.log(label.padEnd(36),us.toFixed(3),'µs per call');};
time('set_fret (edit + undo entry)',1e6,i=>doc.set_fret(i%100000,i%24));
time('fret (read)',1e6,i=>doc.fret(i%100000));
time('undo',1e5,()=>doc.undo());
let json;time('to_json (100000 beats)',10,()=>{json=doc.to_json();});
time('load_json (100000 beats)',10,()=>Doc.load_json(json).free());
console.log('fret after undo/redo checks:',doc.fret(5),'json bytes',json.length);
