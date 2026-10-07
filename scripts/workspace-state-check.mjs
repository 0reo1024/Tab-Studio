import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
const root=process.cwd(),folder=path.join(root,'test-results','workspace-'+Date.now()),profile=path.join(folder,'profile');
await fs.mkdir(folder,{recursive:true});
const legacy=path.join(folder,'Legacy.tabstudio'),saved=path.join(folder,'Saved.tg'),other=path.join(folder,'Other.tg');
let current;
async function launch(){const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.join(root,'node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[root],env:{...process.env,TAB_STUDIO_TEST_DATA:profile}});const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await ready(page);return {app,page,errors};}
async function ready(page){await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering&&!window.tabStudio.getState().loading);}
async function closeClean(){assert.deepEqual(current.errors,[]);const closed=current.app.waitForEvent('close');await current.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;current=undefined;}
async function open(file){const opened=await current.page.evaluate(file=>window.desktop.openFilePath(file),file);await current.page.evaluate(f=>window.tabStudio.load(f.name,new Uint8Array(f.bytes),f.openToken,f.path),opened);await ready(current.page);}
try{
  current=await launch();let {app,page}=current;
  assert.equal(await page.locator('#editMode').count(),0);assert.equal(await page.evaluate(()=>window.tabStudio.getState().editMode),true);
  await page.locator('#addTrack').click();await ready(page);const project=JSON.parse(await page.evaluate(()=>window.tabStudio.serialize()));project.score.title='Session & TG';await fs.writeFile(legacy,JSON.stringify(project));
  await open(legacy);await page.evaluate(()=>window.tabStudio.closeDocument(window.tabStudio.getState().documents[0].id));await page.locator('#exit-discard').click();await ready(page);
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async(_window,options)=>{if(!options.defaultPath.endsWith('.tg')||options.filters[0].extensions[0]!=='tg')throw new Error('Incorrect save default');return {canceled:false,filePath:file};};},saved);
  await page.evaluate(()=>document.querySelector('#save').click());await page.waitForFunction(()=>document.querySelector('#source').textContent==='TG'&&!window.tabStudio.getState().dirty);
  const files=unzipSync(new Uint8Array(await fs.readFile(saved)));assert.deepEqual(Object.keys(files).sort(),['content.xml','version.txt']);assert.equal(strFromU8(files['version.txt']),'TuxGuitar_file_format 2.0.0');assert.ok((await fs.readFile(legacy,'utf8')).startsWith('{'));
  await page.locator('#tracks .track-top input').nth(1).uncheck();await ready(page);assert.deepEqual(await page.evaluate(()=>window.tabStudio.getState().visibleTracks),[0]);assert.equal(await page.evaluate(()=>window.tabStudio.getState().dirty),false);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1210,770));const size=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getSize());await closeClean();
  current=await launch();({app,page}=current);assert.equal(await page.evaluate(()=>window.tabStudio.getScore().title),'Session & TG');assert.deepEqual(await page.evaluate(()=>window.tabStudio.getState().visibleTracks),[0]);assert.deepEqual(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getSize()),size);
  // Hold only the native file read, so we can observe the full startup interval.
  await app.evaluate((_,file)=>{const fs=process.getBuiltinModule('node:fs/promises'),original=fs.readFile;fs.readFile=async function(target,...args){if(target===file&&!args.length){await new Promise(resolve=>{process.releaseRead=resolve;});fs.readFile=original;}return original.call(this,target,...args);};},saved);
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('#loading-indicator').waitFor({state:'visible'});assert.ok((await page.locator('#loading-message').textContent()).includes('読み込み中'));assert.equal(await page.locator('.workspace').evaluate(el=>el.inert),true);await page.screenshot({path:path.join(folder,'loading.png')});
  await app.evaluate(async()=>{for(let i=0;i<200&&!process.releaseRead;i++)await new Promise(r=>setTimeout(r,10));if(!process.releaseRead)throw new Error('No pending file read');process.releaseRead();});await ready(page);assert.equal(await page.locator('#loading-indicator').isVisible(),false);assert.deepEqual(await page.evaluate(()=>window.tabStudio.getState().visibleTracks),[0]);
  // Save-as copies current visibility; subsequent changes remain per document.
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},other);
  await page.keyboard.press('Control+Shift+s');await page.waitForFunction(()=>document.querySelector('#title').textContent==='Session & TG'&&document.querySelector('#source').textContent==='TG');await page.waitForFunction(async file=>(await window.desktop.recentFiles())[0]?.path===file,other);
  await page.locator('#tracks .track-top input').nth(1).check();await ready(page);await page.locator('#tracks .track-top input').nth(0).uncheck();await ready(page);
  await open(saved);assert.deepEqual(await page.evaluate(()=>window.tabStudio.getState().visibleTracks),[0]);await open(other);assert.deepEqual(await page.evaluate(()=>window.tabStudio.getState().visibleTracks),[1]);
  await page.evaluate(()=>window.tabStudio.select(0,0,1));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('12');await page.keyboard.press('Enter');await ready(page);
  await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>{throw new Error('Overwrite should not show a dialog');};});await page.keyboard.press('Control+s');await page.waitForFunction(()=>!window.tabStudio.getState().dirty);await ready(page);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].maximize());await page.waitForTimeout(350);await closeClean();
  current=await launch();({app,page}=current);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized()),true);assert.deepEqual(await page.evaluate(()=>window.tabStudio.getState().visibleTracks),[1]);assert.equal(await page.evaluate(()=>window.tabStudio.getScore().tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0].fret),12);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].unmaximize());await page.waitForTimeout(350);assert.deepEqual(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getSize()),size);await closeClean();
  console.log('WORKSPACE PASSED: loading interval / exact edit label / TG defaults and overwrite / legacy conversion / per-file track visibility / normal size and maximized restart');
}finally{if(current)await current.app.evaluate(()=>process.exit(0)).catch(()=>{});}
