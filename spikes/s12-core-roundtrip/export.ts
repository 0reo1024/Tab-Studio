// Spike S12: writes the app's alphaTab JSON (editData) for fixtures, for the core's tests.
// Usage: npx tsx spikes/s12-core-roundtrip/export.ts <out dir> [song.tg ...]
import fs from 'node:fs';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
import {demoScore,settings} from '../../src/score';
import {editData} from '../../src/edit-snapshot';
import {importTg} from '../../src/tg-reader';
const [out,...songs]=process.argv.slice(2);fs.mkdirSync(out,{recursive:true});
const write=(name:string,score:at.model.Score)=>{fs.writeFileSync(path.join(out,name+'.json'),JSON.stringify(editData(score)));console.log('wrote',name);};
write('demo',demoScore());
for(const f of fs.readdirSync('tests/fixtures').filter(f=>/\.(gp|gp3|gp4|gp5|gpx|tg)$/i.test(f))){const b=new Uint8Array(fs.readFileSync(path.join('tests/fixtures',f)));write(f.replace(/\./g,'-'),f.endsWith('.tg')?importTg(b).score:at.importer.ScoreLoader.loadScoreFromBytes(b,settings));}
for(const s of songs){const b=new Uint8Array(fs.readFileSync(s));write(path.basename(s).replace(/\./g,'-'),s.endsWith('.tg')?importTg(b).score:at.importer.ScoreLoader.loadScoreFromBytes(b,settings));}
