// P3-5 measurement: one fret change in a long song through the core + adapter (swap one
// measure) versus today's path for edits that leave the measure (normalizeEdit: the
// whole song to JSON and back). Usage: npx tsx spikes/s12-core-roundtrip/adapter-bench.ts song.tg
import fs from 'node:fs';
import {DOMParser} from '@xmldom/xmldom';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
import {importTg} from '../../src/tg-reader';
import {editData,normalizeEdit,restoreScore} from '../../src/edit-snapshot';
import {loadCore,Core} from '../../src/core';
import {applyChanges} from '../../src/core/adapter';
await loadCore(fs.readFileSync('src/core/wasm/tabstudio_core_bg.wasm'));
const score=importTg(new Uint8Array(fs.readFileSync(process.argv[2]))).score;
let t=performance.now();const core=Core.fromData(editData(score));console.log('core load (once per document)',(performance.now()-t).toFixed(1),'ms');
const median=(xs:number[])=>xs.sort((a,b)=>a-b)[xs.length>>1].toFixed(2);
// Bars whose first beat has a note and no links (patchable alone).
const targets:[number,number][]=[];score.tracks[0].staves[0].bars.forEach((bar,b)=>{const beat=bar.voices[0].beats[0];if(beat.notes.length&&b>0)targets.push([b,beat.notes[0].fret]);});
const edit:number[]=[],adapt:number[]=[],undo:number[]=[],ranges:number[]=[];let inPlace=0,checked=0;
const notation=(data:unknown)=>JSON.stringify(editData(restoreScore(JSON.parse(JSON.stringify(data)))),(k,v)=>k.startsWith('studio')?undefined:v);
for(const [b,fret] of targets.slice(0,30)){
 t=performance.now();const changes=core.edit('fret',[{op:'set',at:{track:0,staff:0,bar:b,voice:0,beat:0,note:0},key:'fret',value:(fret+1)%20}]);edit.push(performance.now()-t);
 t=performance.now();const r=applyChanges(score,core,changes);adapt.push(performance.now()-t);if(r.inPlace)inPlace++;ranges.push(r.bars);
 // The view matches the core (the comparison verifySnapshot makes), on every 5th edit.
 if(edit.length%5===1){if(notation(editData(score))!==notation(core.data()))throw new Error('view differs from core after editing bar '+b);checked++;}
 t=performance.now();applyChanges(score,core,core.undo()!);undo.push(performance.now()-t);
}
const normalize:number[]=[];for(let i=0;i<5;i++){t=performance.now();normalizeEdit(score);normalize.push(performance.now()-t);}
console.log(`${score.tracks.length} tracks, ${score.masterBars.length} bars; ${edit.length} edits, ${inPlace} patched in place`);
console.log('rebuilt bars per edit: median',ranges.sort((a,b)=>a-b)[ranges.length>>1],'max',ranges.at(-1),'| view = core checked',checked,'times');
console.log('core edit (median ms)',median(edit),'| adapter swap',median(adapt),'| undo + adapter',median(undo),'| normalizeEdit today',median(normalize));
