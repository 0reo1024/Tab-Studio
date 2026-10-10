// Core creation cost on the perf benchmark's 600-bar x 8-track song, step by step.
import fs from 'node:fs';
import * as at from '@coderline/alphatab';
import {settings} from '../../src/score';
import {editData,EditSnapshot,plain} from '../../src/edit-snapshot';
import {loadCore,Core} from '../../src/core';
await loadCore(fs.readFileSync('src/core/wasm/tabstudio_core_bg.wasm'));
const bars=600,parts=['\\title "Large benchmark" \\tempo 120'];
const guitar=(b:number)=>`:8 ${(b%5)+3}.1 (${(b%5)+5}.2 ${(b%5)+5}.3) 7.1 5.2 r (3.3 5.4) 7.2 8.1`;
const lead=(b:number)=>`:16 ${b%12}.1 ${(b%12)+2}.1 ${(b%12)+3}.1 ${(b%12)+5}.1 :8 ${(b%12)+7}.2 5.2 :4 7.3 :8 5.3 3.4 :4 5.4`;
const bass=(b:number)=>`:8 ${b%7}.4 ${b%7}.4 ${(b%7)+2}.3 ${(b%7)+2}.3 ${b%7}.4 r 3.3 5.3`;
for(let t=0;t<8;t++){const kind=t===6||t===7?'bass':t%2?'lead':'guitar';parts.push(`\\track "${kind} ${t+1}"`+(kind==='bass'?' \\tuning G2 D2 A1 E1':'')+' .');parts.push(Array.from({length:bars},(_,b)=>(kind==='bass'?bass:kind==='lead'?lead:guitar)(b)).join(' | '));}
const score=at.importer.ScoreLoader.loadAlphaTex(parts.join(' '),new at.Settings());
let t=performance.now();const snap=new EditSnapshot().get(score);console.log('snapshot',(performance.now()-t).toFixed(0),'ms');
t=performance.now();const p=plain(snap);console.log('plain',(performance.now()-t).toFixed(0),'ms');
t=performance.now();const json=JSON.stringify(p);console.log('stringify',(performance.now()-t).toFixed(0),'ms',(json.length/1e6).toFixed(1),'MB');
fs.writeFileSync('test-results/big-600x8.json',json);
if(process.env.SKIP_WASM)process.exit(0);
t=performance.now();const core=Core.fromData(p);console.log('Core.fromData',(performance.now()-t).toFixed(0),'ms');core.free();
