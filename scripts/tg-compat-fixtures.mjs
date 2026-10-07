import fs from 'node:fs/promises';
import {DOMParser} from '@xmldom/xmldom';
import {demoScore,importGuitarPro} from '../src/score.ts';
import {importTg} from '../src/tg-reader.ts';
import {exportTg} from '../src/tg-writer.ts';
globalThis.DOMParser=DOMParser;
const folder='test-results/tg-reference/exports';await fs.mkdir(folder,{recursive:true});
const manifest=[];
for(const name of ['demo','tg-v15.tg','tg-v2.tg','notes.gp3','notes.gp4','notes.gp5','notes.gpx','notes.gp']){
  const bytes=name==='demo'?null:new Uint8Array(await fs.readFile('tests/fixtures/'+name));
  const score=name==='demo'?demoScore():name.endsWith('.tg')?importTg(bytes).score:importGuitarPro(bytes);
  await fs.writeFile(`${folder}/${name}.tg`,exportTg(score));
  manifest.push({name,title:score.title,bars:score.masterBars.length,notes:score.tracks.reduce((sum,t)=>sum+t.staves.reduce((sum,s)=>sum+s.bars.reduce((sum,b)=>sum+b.voices.reduce((sum,v)=>sum+v.beats.reduce((sum,b)=>sum+b.notes.length,0),0),0),0),0)});
}
await fs.writeFile(folder+'/manifest.json',JSON.stringify(manifest));
console.log('Generated eight TG compatibility fixtures');
