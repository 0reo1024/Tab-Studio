import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),folder=path.join(root,'test-results','tab-restore-'+Date.now()),profile=path.join(folder,'profile');
await fs.mkdir(folder,{recursive:true});
const wrapper=path.join(folder,'main.cjs');
await fs.writeFile(wrapper,`const fs=require('node:fs/promises');const original=fs.readFile;fs.readFile=async function(file,...args){if(String(file).endsWith('Slow.tabstudio'))await new Promise(r=>setTimeout(r,2200));return original.call(this,file,...args);};require(${JSON.stringify(path.join(root,'electron/main.cjs'))});`);
let current;const errors=[];
async function launch(slow=false){
 const executablePath=process.env.TAB_STUDIO_TEST_EXE||path.join(root,'node_modules/electron/dist/electron.exe');
 const app=await electron.launch({executablePath,args:process.env.TAB_STUDIO_TEST_EXE?[]:[slow?wrapper:root],env:{...process.env,TAB_STUDIO_TEST_DATA:profile}});
 const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));current={app,page};return current;
}
async function ready(){await current.page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);}
async function close(){const closed=current.app.waitForEvent('close');await current.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;current=null;}
try{
 await launch();await current.page.locator('#start-demo').click();await ready();
 const base=JSON.parse(await current.page.evaluate(()=>window.tabStudio.serialize()));
 await current.page.keyboard.press('Control+,');await current.page.locator('#settings-startup').selectOption('last');await current.page.locator('#settings-apply').click();await close();
 const files=[];
 for(let i=0;i<10;i++){const file=path.join(folder,i===0?'Slow.tabstudio':`Document ${i}.tabstudio`);const data=structuredClone(base);data.score.title=`Document ${i}`;await fs.writeFile(file,JSON.stringify(data));files.push(file);}
 const fixtures=path.join(root,'test-results','desktop-fixtures-1791297700903');
 for(const name of ['tg-v2.tg','tg-v15.tg','notes.gp5','notes.gp']){const file=path.join(folder,name);await fs.copyFile(path.join(fixtures,name),file);files.push(file);}
 const missing=path.join(folder,'Missing.tabstudio');files.push(missing);
 const sessionFile=path.join(profile,'workspace-session.json'),session=JSON.parse(await fs.readFile(sessionFile,'utf8'));
 Object.assign(session,{lastFile:files[6],recentFiles:[files[6]],workspace:{files,active:files[6]}});await fs.writeFile(sessionFile,JSON.stringify(session));
 await launch(!process.env.TAB_STUDIO_TEST_EXE);await ready();
 let state=await current.page.evaluate(()=>window.tabStudio.getState());
 assert.equal(state.title,'Document 6');assert.equal(state.documents.length,15);assert.deepEqual(state.documents.map(d=>d.name),files.map(f=>path.basename(f)));
 if(!process.env.TAB_STUDIO_TEST_EXE)assert.ok(state.documents.some(d=>d.loading),'foreground is usable while a deliberately slow background read is still pending');
 const originalActive=state.documents[6].id,replacement=state.documents[7].id;
 await current.page.evaluate(id=>window.tabStudio.closeDocument(id),originalActive);
 await current.page.waitForFunction(([originalActive,replacement])=>{const docs=window.tabStudio.getState().documents;return !docs.some(d=>d.id===originalActive)&&docs.some(d=>d.id===replacement&&d.active)&&!window.tabStudio.getState().rendering;},[originalActive,replacement]);
 const removed=state.documents[5].id;await current.page.evaluate(id=>window.tabStudio.closeDocument(id),removed);
 const first=state.documents[12].id,last=state.documents[13].id;
 await current.page.evaluate(([first,last])=>{window.tabStudio.activateDocument(first);window.tabStudio.activateDocument(last);},[first,last]);
 await current.page.waitForFunction(id=>window.tabStudio.getState().documents.some(d=>d.id===id&&d.active)&&!window.tabStudio.getState().rendering,last);await ready();
 assert.ok(!(await current.page.evaluate(()=>window.tabStudio.getState().documents)).some(d=>d.id===removed));
 await current.page.waitForFunction(()=>window.tabStudio.getState().documents.every(d=>!d.loading));
 state=await current.page.evaluate(()=>window.tabStudio.getState());assert.equal(state.documents.filter(d=>d.error).length,1);
 for(const name of ['tg-v2.tg','tg-v15.tg','notes.gp5','notes.gp']){
  const id=state.documents.find(d=>d.name===name).id;await current.page.evaluate(id=>window.tabStudio.activateDocument(id),id);await ready();
  assert.ok((await current.page.evaluate(()=>window.tabStudio.getScore().tracks.length))>0);
 }
 const missingId=state.documents.find(d=>d.name==='Missing.tabstudio').id;
 await fs.writeFile(missing,JSON.stringify(base));await current.page.evaluate(id=>window.tabStudio.activateDocument(id),missingId);await current.page.waitForFunction(id=>window.tabStudio.getState().documents.some(d=>d.id===id&&d.active),missingId);await ready();
 // Closing the active tab and saving the result must not resurrect closed tabs.
 await current.page.evaluate(id=>window.tabStudio.closeDocument(id),missingId);await ready();
 state=await current.page.evaluate(()=>window.tabStudio.getState());const expected=state.documents.map(d=>d.name),active=state.documents.find(d=>d.active).name;
 await close();await launch();await ready();state=await current.page.evaluate(()=>window.tabStudio.getState());assert.deepEqual(state.documents.map(d=>d.name),expected);assert.equal(state.documents.find(d=>d.active).name,active);
 await current.page.keyboard.press('Control+,');await current.page.locator('#settings-startup').selectOption('home');await current.page.locator('#settings-apply').click();await close();
 await launch();await current.page.locator('#start-resume').click();await ready();assert.deepEqual((await current.page.evaluate(()=>window.tabStudio.getState().documents)).map(d=>d.name),expected);
 assert.deepEqual(errors,[]);await close();
 console.log('TAB RESTORE PASSED: 15 tabs / original order / middle active / foreground priority / pending switch and close / GP and TG background parsing / missing-file retry / restart / home resume');
 console.log('QA_FOLDER='+folder);
}finally{if(current)await current.app.evaluate(()=>process.exit(0)).catch(()=>{});}
