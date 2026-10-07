import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),folder=path.join(root,'test-results','session-'+Date.now()),profile=path.join(folder,'profile');
await fs.mkdir(folder,{recursive:true});
const saved=path.join(folder,'Remember me.tg');
const first=path.join(folder,'Remember me.tabstudio'),second=path.join(folder,'Other.tabstudio'),bad=path.join(folder,'Broken.tabstudio');
let current,firstLaunch=true;
async function launch(){const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],env:{...process.env,TAB_STUDIO_TEST_DATA:profile}});const page=await app.firstWindow();if(firstLaunch){firstLaunch=false;await page.locator('#start-demo').click();}page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);return{app,page,errors};}
async function closeClean(){const closed=current.app.waitForEvent('close');await current.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;current=undefined;}
async function open(file,title){await current.app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await current.page.evaluate(()=>document.querySelector('#open').click());await current.page.waitForFunction(title=>window.tabStudio.getScore().title===title&&!window.tabStudio.getState().rendering,title);}
try{
 current=await launch();let {page,app}=current;await page.keyboard.press('Control+,');await page.locator('#settings-startup').selectOption('last');await page.locator('#settings-apply').click();
 const base=JSON.parse(await page.evaluate(()=>window.tabStudio.serialize()));base.score.title='Remember me';await fs.writeFile(first,JSON.stringify(base));base.score.title='Other';await fs.writeFile(second,JSON.stringify(base));await fs.writeFile(bad,'broken json');
 await open(first,'Remember me');await open(second,'Other');await open(first,'Remember me');
 assert.deepEqual((await page.evaluate(()=>window.desktop.recentFiles())).map(f=>f.path),[first,second]);
 const fileMenu=page.locator('.menu-root').first();await fileMenu.locator(':scope > button').click();
 assert.ok(await fileMenu.getByRole('menuitem',{name:'Remember me.tabstudio',exact:true}).isVisible());assert.ok(await fileMenu.getByRole('menuitem',{name:'Other.tabstudio',exact:true}).isVisible());
 await page.screenshot({path:path.join(root,'test-results/recent-files.png')});await page.keyboard.press('Escape');
 await page.evaluate(()=>window.tabStudio.select(0,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('12');await page.keyboard.press('Enter');await page.waitForFunction(()=>!window.tabStudio.getState().rendering);
 await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},saved);await page.evaluate(()=>document.querySelector('#save').click());await page.waitForFunction(()=>!window.tabStudio.getState().dirty);
 await closeClean();current=await launch();({page,app}=current);
 assert.equal(await page.evaluate(()=>window.tabStudio.getScore().title),'Remember me');assert.equal(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret),12);
 // Failed imports must not become the last document or change the save target.
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},bad);await page.evaluate(()=>document.querySelector('#open').click());await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('読み込みに失敗'));
 assert.equal((await page.evaluate(()=>window.desktop.recentFiles())).length,3);
 await page.evaluate(()=>window.tabStudio.select(0,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('23');await page.keyboard.press('Enter');await page.waitForFunction(()=>!window.tabStudio.getState().rendering);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await page.locator('#exitDialog').waitFor({state:'visible'});const closed=app.waitForEvent('close');await page.locator('#exit-discard').click();await closed;current=undefined;
 current=await launch();({page}=current);assert.equal(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret),12);await closeClean();
 await fs.rename(saved,path.join(folder,'moved.tg'));
 current=await launch();({page}=current);assert.equal(await page.evaluate(()=>window.tabStudio.getScore().title),'Remember me');assert.ok((await page.locator('#notice').textContent()).includes('前回のファイルを開けませんでした'));
 await page.locator('.menu-root').first().locator(':scope > button').click();await page.getByRole('menuitem',{name:'Other.tabstudio',exact:true}).click();await page.waitForFunction(()=>window.tabStudio.getScore().title==='Other'&&!window.tabStudio.getState().rendering);
 assert.deepEqual(current.errors,[]);await closeClean();
 console.log('SESSION PASSED: recent menu / deduplicated paths / reopen last file / saved edits / discard / failed import / missing-file fallback / history click');
}finally{if(current)await current.app.evaluate(()=>process.exit(0)).catch(()=>{});}
