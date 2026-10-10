// Times opening a song until playback is ready (play button enabled, nothing loading).
// Usage: node scripts/open-to-play-probe.mjs [file]   (UI_TARGET=tauri via scripts/tauri-ui-shim.mjs)
import {_electron as electron} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const file=process.argv[2]||path.join(process.env.USERPROFILE,'Desktop','Champagne.tg');
const folder=path.resolve('test-results/open-to-play-'+Date.now());await fs.mkdir(folder,{recursive:true});let app;
try{
 app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}});
 const page=await app.firstWindow();page.setDefaultTimeout(180000);await page.locator('#start-demo').click();
 const playable=()=>{const s=window.tabStudio?.getState(),b=document.querySelector('#play');return !!(s?.ready&&!s.rendering&&b&&!b.disabled&&!b.classList.contains('nam-loading'));};
 await page.waitForFunction(playable);
 for(const round of [1,2]){
  const bytes=[...await fs.readFile(file)];
  const t=await page.evaluate(async({bytes,name,file})=>{
   const marks=[],t0=performance.now(),mark=label=>marks.push([label,Math.round(performance.now()-t0)]);
   const timer=setInterval(()=>{const b=document.querySelector('#play'),s=window.tabStudio.getState();const l=`${s.rendering?'rendering ':''}${b?.classList.contains('nam-loading')?'loading-audio ':''}${b?.disabled?'disabled':''}`.trim();if(marks.at(-1)?.[2]!==l)marks.push([l||'ready',Math.round(performance.now()-t0),l]);},20);
   await window.tabStudio.load(name,new Uint8Array(bytes),undefined,file+(Math.random()));mark('load() returned');
   await new Promise(r=>{const check=()=>{const b=document.querySelector('#play'),s=window.tabStudio.getState();if(s.ready&&!s.rendering&&b&&!b.disabled&&!b.classList.contains('nam-loading'))r();else setTimeout(check,20);};check();});
   mark('playable');clearInterval(timer);return marks.map(m=>m.slice(0,2));
  },{bytes,name:path.basename(file),file});
  console.log(`round ${round}: `+t.map(([l,ms])=>`${ms}ms ${l}`).join(' | '));
 }
}finally{if(app)await app.evaluate(()=>process.exit(0)).catch(()=>{});}
