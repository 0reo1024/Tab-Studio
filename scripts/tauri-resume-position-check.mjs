// Tauri build: "前回と同じ場所から始める". A saved file reopens at the scroll position, playback
// position and selection it had when the app was closed (also after 保存して終了 with several tabs),
// and starts from the top when the setting is off.
// Usage: pnpm tauri build --no-bundle && TAURI_PROFILE=release node scripts/tauri-resume-position-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';
const root=process.cwd(),folder=path.join(root,'test-results',`tauri-resume-${Date.now()}`),data=path.join(folder,'data');
await fs.mkdir(folder,{recursive:true});
// Copies of real songs, so the user's own files are never written.
const long=path.join(folder,'long.gp5'),other=path.join(folder,'other.tg');
await fs.copyFile(process.env.LONG_SONG||path.join(os.homedir(),'Desktop','Champagne_Gtr1_Gtr2.gp5'),long);
await fs.copyFile(path.join(root,'tests/fixtures/tg-v2.tg'),other);
const executable=tauriExecutable(process.env.TAURI_PROFILE||'release');
const ready=page=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;},{},{timeout:120000});
const settle=page=>page.waitForTimeout(1500);
const view=page=>page.evaluate(()=>{const s=window.tabStudio.getState();return {active:s.documents.find(d=>d.active)?.name,names:s.documents.map(d=>d.name),tick:s.lastTick,selected:s.selected&&{bar:s.selected.bar,beat:s.selected.beat,track:s.selected.track},top:document.getElementById('score-scroll').scrollTop};});
async function closeAndWait(app,answer){
 execFileSync('powershell',['-NoProfile','-Command',`(Get-Process -Id ${app.child.pid}).CloseMainWindow()|Out-Null`]);
 if(answer){await app.page.locator('#exitDialog').waitFor({state:'visible',timeout:10000});await app.page.locator(answer).click().catch(()=>{});}
 const code=await Promise.race([app.exited,new Promise(r=>setTimeout(()=>r('timeout'),30000))]);
 assert.notEqual(code,'timeout','app closed');assert.deepEqual(app.errors,[]);await app.close();
}
async function openFile(page,file){await page.evaluate(async file=>{const f=await window.desktop.openFilePath(file);await window.tabStudio.load(f.name,new Uint8Array(f.bytes),f.openToken,f.path);},file);await ready(page);}

let app=await launchTauri({dataDir:data,executable});
try{
 // First run: restore the previous tabs on startup (the existing 起動時の画面 option).
 await app.page.waitForFunction(()=>!!window.desktop,{},{timeout:30000});
 await app.page.evaluate(()=>localStorage.setItem('tabstudio-settings',JSON.stringify({startup:'last'})));
 await app.page.reload();await app.page.waitForLoadState('domcontentloaded');await ready(app.page);
 assert.equal(await app.page.evaluate(()=>window.tabStudio.getState().settings.resumePosition),true,'on by default');
 await openFile(app.page,other);await openFile(app.page,long);
 // Make the other tab unsaved, then come back to the long song and move far down.
 const ids=await app.page.evaluate(()=>window.tabStudio.getState().documents.map(d=>d.id));
 await app.page.evaluate(id=>window.tabStudio.activateDocument(id),ids[ids.length-2]);await ready(app.page);
 await app.page.evaluate(()=>window.tabStudio.select(0,0));await app.page.keyboard.press('Digit5');await app.page.keyboard.press('Enter');
 await app.page.waitForFunction(()=>window.tabStudio.getState().dirty,{},{timeout:10000});
 await app.page.evaluate(id=>window.tabStudio.activateDocument(id),ids[ids.length-1]);await ready(app.page);await settle(app.page);
 const bars=await app.page.evaluate(()=>window.tabStudio.getScore().masterBars.length),bar=Math.min(40,bars-2);
 await app.page.evaluate(bar=>window.tabStudio.select(bar,0),bar);await settle(app.page);
 await app.page.evaluate(()=>{const s=document.getElementById('score-scroll');s.scrollTop=Math.min(1500,s.scrollHeight-s.clientHeight);});await settle(app.page);
 const before=await view(app.page);
 console.log('before close',JSON.stringify(before));
 assert.equal(before.active,'long.gp5');assert.ok(before.top>300,'scrolled down');
 // 保存して終了 saves the other tab (activating it) and must still reopen on the long song.
 await closeAndWait(app,'#exit-save');

 app=await launchTauri({dataDir:data,executable});
 await ready(app.page);await settle(app.page);
 const after=await view(app.page);
 console.log('after restart',JSON.stringify(after));
 assert.equal(after.active,'long.gp5','the tab that was open');
 assert.deepEqual(after.selected,before.selected,'selection');
 // The player reports the seek back rounded to its own tick grid (a tick or so).
 assert.ok(Math.abs(after.tick-before.tick)<=10,`playback position ${after.tick} vs ${before.tick}`);
 assert.ok(Math.abs(after.top-before.top)<=2,`scroll ${after.top} vs ${before.top}`);
 // The other tab keeps its own place too (top, since it was never scrolled).
 assert.ok(after.names.includes('other.tg'));

 // Setting off: the same file starts from the top.
 await app.page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('tabstudio-settings'));s.resumePosition=false;localStorage.setItem('tabstudio-settings',JSON.stringify(s));});
 await closeAndWait(app,null);
 app=await launchTauri({dataDir:data,executable});
 await ready(app.page);await settle(app.page);
 const off=await view(app.page);
 console.log('setting off',JSON.stringify(off));
 assert.equal(off.active,'long.gp5');assert.equal(off.selected,null);assert.ok(off.tick<=10);assert.ok(off.top<5,'top of the score');
 // The settings dialog shows the option.
 await app.page.keyboard.press('Control+Comma');
 await app.page.locator('#settings-resume-position').waitFor({state:'visible',timeout:10000});
 assert.equal(await app.page.locator('#settings-resume-position').isChecked(),false);
 await app.page.locator('#settings-resume-position').scrollIntoViewIfNeeded();await app.page.screenshot({path:path.join(folder,'settings.png')});
 console.log('screenshot',path.join(folder,'settings.png'));
 console.log('PASS tauri-resume-position-check');
}finally{await app.close();}
