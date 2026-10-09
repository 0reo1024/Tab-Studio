// Tauri build: open, save, workspace session, recovery files, close flow and
// binary IPC throughput (spike S3). Dialog-free paths only; dialogs are checked by hand.
// Usage: pnpm tauri build --debug --no-bundle && node scripts/tauri-files-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {launchTauri} from './tauri-app.mjs';
const root=process.cwd(),folder=path.join(root,'test-results',`tauri-files-${Date.now()}`),data=path.join(folder,'data');
await fs.mkdir(folder,{recursive:true});
const song=path.join(folder,'song.tg');await fs.copyFile(path.join(root,'tests/fixtures/tg-v2.tg'),song);
const ready=page=>page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering,{},{timeout:60000});
let app=await launchTauri({dataDir:data});
try{
 const {page}=app;
 await page.locator('#start-demo').click({timeout:30000});await ready(page);
 assert.equal(await page.evaluate(()=>!!window.__TAURI_INTERNALS__&&typeof window.desktop?.openScore),'function');
 // Open through the allowlisted path and load it as the app's drop/recent path does.
 await page.evaluate(async file=>{const f=await window.desktop.openFilePath(file);await window.tabStudio.load(f.name,new Uint8Array(f.bytes),f.openToken,f.path);},song);
 await ready(page);
 const state=await page.evaluate(()=>window.tabStudio.getState());
 assert.equal(state.documents.find(d=>d.active).name,'song.tg');
 const session=JSON.parse(await fs.readFile(path.join(data,'workspace-session.json'),'utf8'));
 assert.equal(path.resolve(session.lastFile),path.resolve(song));assert.equal(path.resolve(session.recentFiles[0]),path.resolve(song));
 assert.deepEqual((await page.evaluate(()=>window.desktop.recentFiles())).map(f=>f.name),['song.tg']);
 // Edit -> recovery files appear (per document gzip + manifest).
 const before=(await fs.stat(song)).mtimeMs;
 await page.evaluate(()=>{window.tabStudio.select(0,0);});await page.keyboard.press('Digit5');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.tabStudio.getState().dirty,{},{timeout:10000});
 for(let i=0;i<50;i++){try{await fs.access(path.join(data,'recovery','manifest.json'));break;}catch{await new Promise(r=>setTimeout(r,200));}}
 const recoveryFiles=await fs.readdir(path.join(data,'recovery'));
 assert.ok(recoveryFiles.includes('manifest.json')&&recoveryFiles.some(f=>/^document-\d+\.json\.gz$/.test(f)),recoveryFiles.join(','));
 const recovered=JSON.parse(await page.evaluate(()=>window.desktop.readRecovery()));
 assert.ok(recovered.workspace.documents.length>=1&&recovered.workspace.documents.every(d=>d.score));
 // Save to the opened .tg path (no dialog because the user opened that file).
 await page.keyboard.press('Control+s');
 await page.waitForFunction(()=>!window.tabStudio.getState().dirty,{},{timeout:20000});
 assert.ok((await fs.stat(song)).mtimeMs>before,'file was rewritten');
 assert.equal((await fs.readFile(song)).subarray(0,2).toString(),'PK');
 // A path the user never chose is refused.
 await assert.rejects(page.evaluate(()=>window.desktop.readWorkspaceFile('C:\\Windows\\win.ini')),/前回のタブにないファイル/);
 // S3: binary IPC throughput, 38MB each way.
 const big=path.join(folder,'big.tg');const payload=Buffer.alloc(38*1024*1024,7);payload.write('PK',0);await fs.writeFile(big,payload);
 const timing=await page.evaluate(async file=>{
  let t=performance.now();const f=await window.desktop.openFilePath(file);const read=performance.now()-t;
  await window.desktop.acceptOpen(f.openToken);
  t=performance.now();await window.desktop.saveScore({name:'big',bytes:f.bytes,path:file});const write=performance.now()-t;
  return {bytes:f.bytes.byteLength,read:Math.round(read),write:Math.round(write)};
 },big);
 assert.equal(timing.bytes,payload.length);assert.deepEqual(await fs.readFile(big),payload);
 console.log('S3 38MB read ms',timing.read,'write ms',timing.write);
 // Close button (WM_CLOSE): with unsaved changes the page asks first and the app stays open.
 const closeWindow=()=>execFileSync('powershell',['-NoProfile','-Command',`(Get-Process -Id ${app.child.pid}).CloseMainWindow()|Out-Null`]);
 await page.evaluate(()=>{window.tabStudio.select(0,1);});await page.keyboard.press('Digit3');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.tabStudio.getState().dirty,{},{timeout:10000});
 closeWindow();await page.locator('#exitDialog').waitFor({state:'visible',timeout:10000});
 assert.equal(app.child.exitCode,null,'still running while asking');
 await page.locator('#exit-cancel').click();await page.locator('#exitDialog').waitFor({state:'hidden'});
 closeWindow();await page.locator('#exitDialog').waitFor({state:'visible',timeout:10000});
 await page.locator('#exit-discard').click().catch(()=>{});
 const code=await Promise.race([app.exited,new Promise(r=>setTimeout(()=>r('timeout'),15000))]);
 assert.notEqual(code,'timeout','app exited after finishClose');
 const closed=JSON.parse(await fs.readFile(path.join(data,'workspace-session.json'),'utf8'));
 assert.ok(closed.windowState?.width>=1024,JSON.stringify(closed.windowState));
 assert.deepEqual(app.errors,[]);
 await app.close();
 // Restart: the workspace and the recovery data are read back by Rust.
 app=await launchTauri({dataDir:data});
 const again=await app.page.evaluate(async()=>{for(let i=0;i<100&&!window.desktop;i++)await new Promise(r=>setTimeout(r,50));return {ws:await window.desktop.workspaceSession(),recent:await window.desktop.recentFiles()};});
 assert.ok(again.recent.some(f=>f.name==='song.tg'));
 console.log('PASS tauri-files-check');
}finally{await app.close();}
