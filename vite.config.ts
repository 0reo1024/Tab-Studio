import { defineConfig, type Plugin } from 'vite';
import { renderTransferMain, restTupletPatch } from './scripts/render-patch.mjs';
/** Main-thread half of the alphaTab render-transfer patch (the worker half is in public/alphatab). */
function alphaTabRenderTransfer():Plugin{return {name:'tabstudio-alphatab-render-transfer',enforce:'pre',transform(code,id){if(/@coderline[\/]alphatab[\/]dist[\/]alphaTab\.core\.mjs$/.test(id.split('?')[0]))return {code:restTupletPatch(renderTransferMain(code)),map:null};}};}
export default defineConfig({ base: './', plugins:[alphaTabRenderTransfer()], optimizeDeps:{exclude:['@coderline/alphatab']}, build: { target: 'es2022',rolldownOptions:{input:{main:'index.html',print:'print.html'}} }, server: { host: '127.0.0.1', port: 5173 } });
