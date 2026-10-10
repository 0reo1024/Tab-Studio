// Spike S12: which keys the alphaTab JSON (JsonConverter.scoreToJsObject + the app's
// audio data) carries, per level, across fixtures; so the core model covers them all.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
import {demoScore,settings} from '../../src/score';
import {editData} from '../../src/edit-snapshot';
import {importTg} from '../../src/tg-reader';
const scores:[string,at.model.Score][]=[['demo',demoScore()]];
const champagne=path.join(os.homedir(),'Desktop','Champagne.tg');
if(fs.existsSync(champagne))scores.push(['Champagne',importTg(new Uint8Array(fs.readFileSync(champagne))).score]);
for(const f of fs.readdirSync('tests/fixtures').filter(f=>/\.(gp|gp5|gpx|gp4|tg)$/i.test(f)).slice(0,6)){try{const b=new Uint8Array(fs.readFileSync(path.join('tests/fixtures',f)));scores.push([f,f.endsWith('.tg')?importTg(b).score:at.importer.ScoreLoader.loadScoreFromBytes(b,settings)]);}catch(e){console.log('skip',f,String(e).slice(0,80));}}
const levels=new Map<string,Map<string,Set<string>>>();
function walk(v:any,level:string){
 if(Array.isArray(v)){for(const x of v)walk(x,level);return;}
 if(!v||typeof v!=='object')return;
 const keys=levels.get(level)??new Map();levels.set(level,keys);
 for(const [k,x] of Object.entries(v)){const types=keys.get(k)??new Set();keys.set(k,types);types.add(Array.isArray(x)?'array':x===null?'null':typeof x);
  const child=['tracks','staves','bars','voices','beats','notes','masterbars'].includes(k)?k:Array.isArray(x)||typeof x==='object'?`${level}.${k}`:null;if(child)walk(x,child);}
}
for(const [name,s] of scores){walk(editData(s),'score');console.log('fixture',name,s.tracks.length,'tracks',s.masterBars.length,'bars');}
for(const [level,keys] of levels)console.log(`\n[${level}] ${[...keys].map(([k,t])=>`${k}:${[...t].join('|')}`).join(' ')}`);
