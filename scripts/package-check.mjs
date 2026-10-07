import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve(`release/${version}/win-unpacked/Tab Studio.exe`),args:[],env:{...process.env,TAB_STUDIO_TEST_DATA:path.resolve('test-results/packaged-'+Date.now())}});
try{
 const page=await app.firstWindow();await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering);
 assert.equal(await app.evaluate(({app})=>app.getVersion()),version);
 assert.equal(await app.evaluate(({Menu})=>Menu.getApplicationMenu()),null);
 assert.equal(await page.locator('.titlebar').count(),0);
 assert.equal(await page.evaluate(()=>window.tabStudio.api.settings.display.barsPerRow),-1);
 assert.equal(await page.locator('.edit-details,.sidebar-bottom').count(),0);
 await page.locator('.menu-root').filter({has:page.locator(':scope > button',{hasText:/^拍子・小節$/})}).locator(':scope > button').click();await page.getByRole('menuitem',{name:/選択小節のテンポ/}).click();assert.ok(await page.locator('#tempoDialog').isVisible());await page.locator('[data-close=tempoDialog]').click();
 assert.equal(await page.locator('#clickKind').inputValue(),'wood');assert.equal(await page.evaluate(()=>window.tabStudio.getState().notation),'tab');
 await page.locator('#speed').selectOption('0.8');await page.locator('#speed').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>window.tabStudio.getState().playing);
 await page.locator('#speed').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);
 await page.evaluate(()=>window.tabStudio.select(0,0));await page.locator('#speed').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>window.tabStudio.getState().selected.beat),1);assert.equal(await page.locator('#speed').inputValue(),'0.8');
 assert.equal(await page.locator('#editMode').count(),0);
 assert.equal(await page.evaluate(()=>window.tabStudio.getState().editMode),true);await page.keyboard.press('Enter');
 await page.evaluate(()=>window.tabStudio.select(0,0));await page.locator('#edit-palette [data-action="dynamic6"]').click();await page.waitForFunction(()=>!window.tabStudio.getState().rendering);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await page.locator('#exitDialog').waitFor({state:'visible'});
 await page.locator('#exit-cancel').click();assert.ok(!await page.locator('#exitDialog').isVisible());
 console.log('PACKAGED WINDOWS APP PASSED: development / renderer / audio ready / Space and arrows after speed change / instant app menu / edited close dialog');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
