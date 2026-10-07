import {_electron as electron} from '@playwright/test';
import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {importTg} from '../src/tg-reader.ts';
globalThis.DOMParser=DOMParser;
const root=process.cwd(),folder=path.resolve('test-results/export-'+Date.now());await fs.mkdir(folder,{recursive:true});
const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.join(root,'node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[root],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}});
try{
  const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  const ready=()=>page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering&&!window.tabStudio.getState().loading);await ready();
  async function menu(pdf=false){await page.locator('.menu-root').first().locator(':scope > button').click();await page.getByRole('menuitem',{name:pdf?'PDFに出力…':'書き出し…',exact:true}).click();await page.locator('#exportDialog').waitFor({state:'visible'});}
  async function output(format,name,pdfMenu=false){await menu(pdfMenu);if(pdfMenu)assert.equal(await page.locator('#export-format').inputValue(),'pdf');else await page.locator('#export-format').selectOption(format);
    if(name==='demo.gp')await page.screenshot({path:path.join(folder,'export-dialog.png')});
    const file=path.join(folder,name);await app.evaluate(({dialog},{file,format})=>{dialog.showSaveDialog=async(_window,options)=>{if(options.filters[0].extensions[0]!==format||!options.defaultPath.endsWith('.'+format))throw new Error('Invalid output filter');return {canceled:false,filePath:file};};},{file,format});
    await page.locator('#export-apply').click();await page.locator('#exportDialog').waitFor({state:'hidden',timeout:70000});assert.ok((await fs.stat(file)).size>100);return file;
  }
  await page.evaluate(()=>window.tabStudio.select(0,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('13');await page.keyboard.press('Enter');await ready();const before=await page.evaluate(()=>window.tabStudio.serialize());
  for(const format of ['gp','tg','mid']){
    const file=await output(format,'demo.'+format);const bytes=new Uint8Array(await fs.readFile(file));
    if(format==='mid'){const b=Buffer.from(bytes);assert.equal(b.subarray(0,4).toString(),'MThd');assert.equal(b.readUInt16BE(8),1);}
    else{const score=format==='tg'?importTg(bytes).score:at.importer.ScoreLoader.loadScoreFromBytes(bytes,new at.Settings());assert.equal(score.title,'First Session');assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret,13);}
    assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),before);assert.equal(await page.evaluate(()=>window.tabStudio.getState().dirty),true);assert.deepEqual(await page.evaluate(()=>window.desktop.recentFiles()),[]);
  }
  const pdfs=[];pdfs.push(await output('pdf','demo.pdf',true));assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),before);assert.equal((await app.windows()).length,1);
  await menu();await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});await page.locator('#export-apply').click();await page.waitForFunction(()=>document.querySelector('#export-error').textContent.includes('キャンセル'));assert.equal(await page.evaluate(()=>window.tabStudio.getState().dirty),true);
  await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:'Z:\\TabStudio-missing-export-folder\\Score.pdf'});});await page.locator('#export-format').selectOption('pdf');await page.locator('#export-apply').click();await page.waitForFunction(()=>document.querySelector('#export-error').textContent.includes('書き出せません'),{},{timeout:70000});assert.equal(await page.evaluate(()=>window.tabStudio.getState().dirty),true);assert.equal((await app.windows()).length,1);await page.locator('#export-cancel').click();
  const bars=Array.from({length:24},(_,bar)=>':16 '+Array.from({length:16},(_,i)=>`${10+(bar+i)%10}.1`).join(' '));
  const score=at.importer.ScoreLoader.loadAlphaTex('\\title "PDF レイアウト確認" \\artist "Tab Studio" \\tempo 220 \\track "LeadVisible" . '+bars.join(' | ')+' \\track "SecondVisible" '+bars.map(()=>':4 0.6 r 3.5 r').join(' | ')+' \\track "HiddenIgnored" '+bars.map(()=>':1 r').join(' | '),new at.Settings());
  score.masterBars.at(-1).section=Object.assign(new at.model.Section(),{text:'END-24',marker:'END'});
  const project=JSON.stringify({format:'TabStudio',version:1,sourceName:'PDF QA',warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});
  page.once('dialog',d=>d.accept());await page.evaluate(p=>window.tabStudio.load('QA.tabstudio',new TextEncoder().encode(p)),project);await ready();await page.locator('#tracks .track-top input').nth(2).uncheck();await ready();
  const longBefore=await page.evaluate(()=>window.tabStudio.serialize());pdfs.push(await output('pdf','multi-page.pdf',true));assert.equal(await page.evaluate(()=>window.tabStudio.serialize()),longBefore);
  await page.locator('#tracks .track-top input').nth(1).uncheck();await ready();pdfs.push(await output('pdf','one-track.pdf',true));
  await page.locator('.menu-root').filter({has:page.locator(':scope > button',{hasText:/^表示$/})}).locator(':scope > button').click();await page.getByRole('menuitem',{name:'五線譜 ＋ TAB',exact:true}).click();await ready();pdfs.push(await output('pdf','standard-and-tab.pdf',true));
  // A tall system must stay on one page, scaled with all its tracks visible.
  const tall=at.importer.ScoreLoader.loadAlphaTex('\\title "Tall system" '+Array.from({length:12},(_,i)=>`\\track "Track ${i+1}" . :4 3.1 5.1 7.1 9.1`).join(' '),new at.Settings());
  const p=JSON.stringify({format:'TabStudio',version:1,sourceName:'Tall QA',warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(tall))});await page.evaluate(p=>window.tabStudio.load('Tall.tabstudio',new TextEncoder().encode(p)),p);await ready();
  for(let i=4;i<12;i++){await page.locator('#tracks .track-top input').nth(i).check();await ready();}
  pdfs.push(await output('pdf','tall-system.pdf',true));assert.equal((await app.windows()).length,1);assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(folder,'pdfs.json'),JSON.stringify(pdfs));console.log('EXPORT UI PASSED: GP/TG/MIDI roundtrip / unchanged edits and save target / PDF / cancel / disk failure / hidden tracks / multi-page / staff plus TAB / tall system');console.log('PDF_QA_FOLDER='+folder);
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
