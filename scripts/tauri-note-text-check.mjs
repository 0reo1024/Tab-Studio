// The note text dialog applies on Enter (not on the Enter that confirms an IME conversion), in the
// Tauri release build. Usage: TAURI_PROFILE=release node --import tsx scripts/tauri-note-text-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';

const folder=path.resolve(`test-results/note-text-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(20000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;});
const text=()=>page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[1].text);
const dialogOpen=()=>page.evaluate(()=>document.querySelector('#textDialog').open);
try{
 await page.locator('#start-demo').click();await ready();
 await page.evaluate(()=>window.tabStudio.selectNote(0,1));await page.locator('[data-action="text"]:visible').first().click();
 await page.locator('#textDialog[open]').waitFor();assert.equal(await page.locator('#text-title').textContent(),'音符のテキスト');
 const before=await text();await page.locator('#text-value').fill('Intro');
 // The Enter that ends an IME conversion only confirms the characters.
 await page.locator('#text-value').evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})));
 assert.ok(await dialogOpen(),'composing Enter does not apply');assert.equal(await text(),before);
 await page.locator('#text-value').press('Enter');await ready();
 assert.ok(!(await dialogOpen()),'Enter closes the dialog');assert.equal(await text(),'Intro','Enter applies the text');
 await page.screenshot({path:path.join(folder,'applied.png')});
 // Ctrl+Z takes it back.
 await page.locator('#score-scroll').focus();await page.keyboard.press('Control+z');await ready();assert.equal(await text(),before);
 assert.deepEqual(app.errors,[]);console.log('PASS tauri-note-text-check',folder);
}finally{await app.close();}
