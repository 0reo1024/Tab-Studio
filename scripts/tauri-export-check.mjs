// Tauri build: GP/TG/MIDI/PDF export through the export dialog (spike S4 + P1-6).
// The same demo PDF is also produced by the Electron build so both can be compared.
// Usage: pnpm tauri build --debug --no-bundle && node scripts/tauri-export-check.mjs
import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {launchTauri} from './tauri-app.mjs';
const root=process.cwd(),folder=path.resolve(`test-results/tauri-export-${Date.now()}`),out=path.join(folder,'tauri');
await fs.mkdir(out,{recursive:true});
async function exportAll(page,target,formats){
 const ready=()=>page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering&&!window.tabStudio.getState().loading,{},{timeout:60000});
 await page.locator('#start-demo').click({timeout:30000}).catch(()=>{});await ready();
 for(const format of formats){
  await page.locator('.menu-root').first().locator(':scope > button').click();
  await page.getByRole('menuitem',{name:format==='pdf'?'PDFに出力…':'書き出し…',exact:true}).click();
  await page.locator('#exportDialog').waitFor({state:'visible'});
  if(format!=='pdf')await page.locator('#export-format').selectOption(format);
  const before=(await fs.readdir(target)).length;
  await page.locator('#export-apply').click();
  for(let i=0;i<300&&(await fs.readdir(target)).length===before;i++)await new Promise(r=>setTimeout(r,200));
  await page.locator('#exportDialog').waitFor({state:'hidden',timeout:60000});
 }
}
const tauri=await launchTauri({dataDir:path.join(folder,'data'),env:{TAB_STUDIO_TEST_SAVE_DIR:out}});
try{
 await exportAll(tauri.page,out,['gp','tg','mid','pdf']);
 assert.deepEqual(tauri.errors,[]);
}finally{await tauri.close();}
const files=(await fs.readdir(out)).sort();console.log('Tauri exports',files);
const signatures={gp:'PK',tg:'PK',mid:'MThd',pdf:'%PDF-'};
for(const [ext,sig]of Object.entries(signatures)){const file=files.find(f=>f.endsWith('.'+ext));assert.ok(file,ext);assert.equal((await fs.readFile(path.join(out,file))).subarray(0,sig.length).toString('latin1'),sig);}
// Electron reference PDF of the same demo.
const reference=path.join(folder,'electron');await fs.mkdir(reference);
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,'electron-data')}});
try{
 const page=await app.firstWindow();
 await app.evaluate(({dialog},dir)=>{dialog.showSaveDialog=async(_w,o)=>({canceled:false,filePath:dir+'\\'+o.defaultPath});},reference);
 await exportAll(page,reference,['pdf']);
}finally{await app.close();}
const pdfs=[path.join(out,files.find(f=>f.endsWith('.pdf'))),path.join(reference,(await fs.readdir(reference)).find(f=>f.endsWith('.pdf')))];
// Page count and paper size from the page dictionaries (Chromium writes them uncompressed).
async function pages(file){const text=(await fs.readFile(file)).toString('latin1'),count=text.match(/\/Type\s*\/Page(?!s)/g)?.length??0,box=text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);return {file,bytes:text.length,pages:Array.from({length:count},()=>({w:Math.round(box[3]-box[1]),h:Math.round(box[4]-box[2])}))};}
const [mine,theirs]=[await pages(pdfs[0]),await pages(pdfs[1])];console.log(JSON.stringify({tauri:mine,electron:theirs}));
assert.ok(mine.pages.length>0,'Tauri PDF has pages');
assert.equal(mine.pages.length,theirs.pages.length,'same page count');
assert.ok(mine.pages.every((p,i)=>p.w===theirs.pages[i].w&&p.h===theirs.pages[i].h),'same paper size');
console.log('PASS tauri-export-check',folder);
