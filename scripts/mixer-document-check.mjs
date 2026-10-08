import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {demoScore,project} from '../src/score.ts';
import {duplicateTrack} from '../src/score-operations.ts';
const folder=path.resolve('test-results/mixer-documents-'+Date.now());await fs.mkdir(folder,{recursive:true});
let app,page;const errors=[];
async function launch(profile){app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST:'1',TAB_STUDIO_TEST_DATA:path.join(folder,profile)}});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.locator('#start-demo').click();await ready();}
async function ready(){await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);}
async function close(){await app.evaluate(()=>process.exit(0)).catch(()=>{});app=null;}
async function load(name,bytes){await page.evaluate(([name,bytes])=>window.tabStudio.load(name,new TextEncoder().encode(bytes)),[name,bytes]);await ready();return page.evaluate(()=>window.tabStudio.getState().documents.find(d=>d.active).id);}
async function activate(id){await page.evaluate(id=>window.tabStudio.activateDocument(id),id);await ready();}
async function geometry(){return page.locator('#mixer').evaluate(e=>({height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width}));}
async function height(value){const r=await page.locator('.mixer-resize').boundingBox(),size=await geometry();await page.mouse.move(r.x+80,r.y+2);await page.mouse.down();await page.mouse.move(r.x+80,r.y+2-(value-size.height));await page.mouse.up();}
async function width(value){const r=await page.locator('.mixer-width-resize').boundingBox(),size=await geometry();await page.mouse.move(r.x+2,r.y+40);await page.mouse.down();await page.mouse.move(r.x+2+value-size.width,r.y+40);await page.mouse.up();}
async function show(){await page.getByRole('button',{name:'表示',exact:true}).click();await page.getByRole('menuitem',{name:'ミキサー',exact:true}).click();}
try{
 await launch('first');
 const a=duplicateTrack(demoScore(),0),b=duplicateTrack(a,0);a.title='Mixer A';b.title='Mixer B';
 const idA=await load('A.tabstudio',project(a,'A',[]));await show();await height(260);await width(440);
 assert.deepEqual(await geometry(),{height:260,width:440});
 const savedA=await page.evaluate(()=>window.tabStudio.serialize());assert.equal(JSON.parse(savedA).score.studiomixer.height,260);await fs.writeFile(path.join(folder,'A.tabstudio'),savedA);
 const idB=await load('B.tabstudio',project(b,'B',[]));assert.deepEqual(await geometry(),{height:509,width:661},'new score starts at its own natural dimensions');
 await height(350);await width(600);const savedB=await page.evaluate(()=>window.tabStudio.serialize());await fs.writeFile(path.join(folder,'B.tabstudio'),savedB);
 for(let i=0;i<2;i++){await activate(idA);assert.deepEqual(await geometry(),{height:260,width:440});await activate(idB);assert.deepEqual(await geometry(),{height:350,width:600});}
 await height(6);const collapsedB=await page.evaluate(()=>window.tabStudio.serialize());await activate(idA);assert.deepEqual(await geometry(),{height:260,width:440});await activate(idB);assert.deepEqual(await geometry(),{height:6,width:600});
 await close();await launch('fresh');
 await load('A.tabstudio',await fs.readFile(path.join(folder,'A.tabstudio'),'utf8'));await show();assert.deepEqual(await geometry(),{height:260,width:440});
 await load('B.tabstudio',await fs.readFile(path.join(folder,'B.tabstudio'),'utf8'));assert.deepEqual(await geometry(),{height:350,width:600});
 await load('Collapsed B.tabstudio',collapsedB);assert.deepEqual(await geometry(),{height:6,width:600},'collapsed height is retained on reopen');
 assert.deepEqual(errors,[]);console.log('MIXER DOCUMENTS PASSED: independent tab dimensions, fresh-profile file restoration, collapsed-state restoration');
}finally{if(app)await close();}
