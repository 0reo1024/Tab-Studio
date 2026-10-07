import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const folder=path.resolve('test-results/menu-palette-'+Date.now());await fs.mkdir(folder,{recursive:true});
const app=await electron.launch({executablePath:path.resolve(`release/${version}/win-unpacked/Tab Studio.exe`),args:[],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 const geometry=await page.evaluate(()=>({transport:document.querySelector('.transport').getBoundingClientRect().height,play:document.querySelector('.transport-buttons .play').getBoundingClientRect().height,settings:getComputedStyle(document.querySelector('.transport-setting')).flexDirection,palette:[...document.querySelectorAll('.palette-buttons button')].map(e=>{const b=e.getBoundingClientRect();return [b.width,b.height,b.right<=e.closest('.palette-section').getBoundingClientRect().right];}),rows:[...document.querySelectorAll('.palette-buttons')].map(e=>[...e.children].map(b=>b.offsetTop))}));
 assert.equal(geometry.transport,76);assert.equal(geometry.play,38);assert.equal(geometry.settings,'column');assert.ok(geometry.palette.every(([w,h,inside])=>w===31&&h===30&&inside));assert.equal(new Set(geometry.rows[0]).size,1);assert.equal(new Set(geometry.rows[2]).size,2);assert.equal(new Set(geometry.rows[3]).size,2);assert.equal(new Set(geometry.rows[4]).size,4);
 const shape=await page.evaluate(()=>({corners:[...document.querySelectorAll('.transport button,.transport select,.palette-buttons button,.track,.track select,.menu-popup,dialog')].map(e=>parseFloat(getComputedStyle(e).borderTopLeftRadius)),toolbar:document.querySelector('.document-toolbar').getBoundingClientRect().right,viewport:document.querySelector('#score-scroll').getBoundingClientRect().right}));assert.ok(shape.corners.every(r=>r<=1),JSON.stringify(shape));assert.ok(shape.toolbar<=shape.viewport,JSON.stringify(shape));await page.screenshot({path:path.join(folder,'controls.png')});
 for(const root of await page.locator('.menu-root').all()){
  await root.locator(':scope > button').click();
  const heights=await root.locator('.menu-popup:not([hidden]) > .menu-item, .menu-popup:not([hidden]) > .menu-node > .menu-item').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height));assert.ok(heights.every(h=>h===32),JSON.stringify(heights));await page.keyboard.press('Escape');
 }
 await page.evaluate(()=>window.tabStudio.select(0,0));
 const noteRoot=page.locator('.menu-root').filter({has:page.locator(':scope > button',{hasText:/^音符$/})});await noteRoot.locator(':scope > button').click();await page.getByRole('menuitem',{name:'音価',exact:true}).hover();
 const overlap=await page.evaluate(()=>{
  const popup=document.querySelector('.submenu-popup:not([hidden])'),cursor=document.querySelector('.at-cursor-beat'),r=popup.getBoundingClientRect(),c=cursor.getBoundingClientRect(),pane=document.querySelector('.score-pane').getBoundingClientRect();
  const x=Math.max(pane.left+25,r.left+25),y=Math.max(pane.top+25,r.bottom-45);cursor.style.translate=`${x-c.left}px ${y-c.top}px`;cursor.style.pointerEvents='auto';const p=cursor.getBoundingClientRect();const top=document.elementFromPoint(p.left+5,p.top+5);const result={covered:!!top?.closest('.submenu-popup'),inside:p.left>=r.left&&p.top>=r.top&&p.left+5<r.right&&p.top+5<r.bottom,height:c.height,point:[p.left,p.top],menu:[r.left,r.top,r.right,r.bottom]};cursor.style.pointerEvents='none';return result;
 });assert.ok(overlap.height>0);assert.ok(overlap.inside&&overlap.covered,JSON.stringify(overlap));await page.screenshot({path:path.join(folder,'menu-over-cursor.png')});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({geometry:{transport:geometry.transport,play:geometry.play,palette:geometry.palette[0]},overlap,folder}));
} catch(e){await (await app.firstWindow()).screenshot({path:path.join(folder,'failure.png')});throw e;}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
