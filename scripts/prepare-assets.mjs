import fs from 'node:fs';
import path from 'node:path';
const source='node_modules/@coderline/alphatab/dist';
fs.mkdirSync('public/alphatab',{recursive:true});
for(const name of ['alphaTab.core.mjs','alphaTab.worker.mjs','alphaTab.worklet.mjs','font','soundfont'])fs.cpSync(path.join(source,name),path.join('public/alphatab',name),{recursive:true});
fs.mkdirSync('licenses',{recursive:true});
fs.copyFileSync('node_modules/@coderline/alphatab/LICENSE','licenses/alphaTab-MPL-2.0.txt');
fs.copyFileSync('src/tg-reader.ts','licenses/tg-reader.ts');

fs.copyFileSync('src/tg-writer.ts','licenses/tg-writer.ts');
