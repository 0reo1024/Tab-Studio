import fs from 'node:fs';
import path from 'node:path';
import {channelAudio} from './channel-audio.mjs';
import {renderTransferWorker} from './render-patch.mjs';
const source='node_modules/@coderline/alphatab/dist';
fs.mkdirSync('public/alphatab',{recursive:true});
for(const name of ['alphaTab.core.mjs','alphaTab.worker.mjs','alphaTab.worklet.mjs','font','soundfont'])fs.cpSync(path.join(source,name),path.join('public/alphatab',name),{recursive:true});
fs.writeFileSync('public/alphatab/alphaTab.core.mjs',renderTransferWorker(channelAudio(fs.readFileSync(path.join(source,'alphaTab.core.mjs'),'utf8'))));
fs.mkdirSync('licenses',{recursive:true});
fs.copyFileSync('node_modules/@coderline/alphatab/LICENSE','licenses/alphaTab-MPL-2.0.txt');
fs.copyFileSync('src/tg-reader.ts','licenses/tg-reader.ts');

fs.copyFileSync('src/tg-writer.ts','licenses/tg-writer.ts');
fs.copyFileSync('scripts/channel-audio.mjs','licenses/alphaTab-channel-audio-patch.mjs');
fs.copyFileSync('scripts/render-patch.mjs','licenses/alphaTab-render-transfer-patch.mjs');
