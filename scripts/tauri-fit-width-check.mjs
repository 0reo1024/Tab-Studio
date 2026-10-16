// Narrow windows in the Tauri release build: the page shrinks with the window (scale and width
// together, so lines break as before) and the whole score width stays visible without a
// horizontal scroll; the document's zoom is untouched. The real window is resized (Win32) down to
// the app's minimum width (tauri.conf.json minWidth 1024).
// Usage: TAURI_PROFILE=release node scripts/tauri-fit-width-check.mjs [score file]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';

const folder=path.resolve(`test-results/fit-width-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:tauriExecutable(process.env.TAURI_PROFILE||'release'),env:{TAB_STUDIO_TEST_MUTE:'1'}});
const {page}=app;page.setDefaultTimeout(30000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;},{},{timeout:60000});
/** Restores and resizes the app's main window to `width` x 900 physical pixels. */
function resize(width){
 const script=`Add-Type @'
using System;using System.Runtime.InteropServices;
public static class W{[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);[DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int t,bool r);}
'@
$h=(Get-Process -Id ${app.child.pid}).MainWindowHandle;[W]::ShowWindow($h,9)|Out-Null;[W]::MoveWindow($h,40,40,${width},900,$true)|Out-Null`;
 execFileSync('powershell.exe',['-NoProfile','-Command',script],{stdio:'ignore'});
}
const measure=()=>page.evaluate(()=>{const s=document.querySelector('#score-scroll'),paper=document.querySelector('.paper').getBoundingClientRect(),view=s.getBoundingClientRect();return {window:innerWidth,pane:Math.round(view.width),scrollWidth:s.scrollWidth,clientWidth:s.clientWidth,fit:getComputedStyle(document.documentElement).getPropertyValue('--paper-fit').trim(),paperLeft:Math.round(paper.left-view.left),paperRight:Math.round(paper.right-view.left),zoom:document.querySelector('#zoom')?.textContent,scale:window.tabStudio.api.settings.display.scale,dirty:window.tabStudio.getState().dirty};});
try{
 await page.locator('#start-demo').click();await ready();
 const file=process.argv[2]??path.resolve('tests/fixtures/sample.gp');
 if(process.argv[2]){await page.locator('#fileInput').setInputFiles(file);await page.waitForFunction(name=>window.tabStudio.getState().documents.find(d=>d.active)?.name===name,path.basename(file));await ready();}
 const results=[];
 for(const width of [1500,1250,1100,1024,1500]){
  resize(width);await page.waitForTimeout(600);await ready();await page.waitForTimeout(300);
  const m=measure();const r={width,...(await m)};results.push(r);console.log(JSON.stringify(r));
  await page.screenshot({path:path.join(folder,`width-${width}-${results.length}.png`)});
  assert.ok(r.scrollWidth<=r.clientWidth+1,`no horizontal scroll at ${width}: ${r.scrollWidth} > ${r.clientWidth}`);
  assert.ok(r.paperLeft>=0&&r.paperRight<=r.clientWidth+1,`the whole page is in view at ${width}`);
  assert.equal(r.zoom,results[0].zoom,'the zoom shown is the document\'s');
 }
 assert.ok(Number(results.find(r=>r.width===1024).fit)<Number(results[0].fit),'a narrow window shrinks the page');
 // Editing on the shrunk page: click a tab note where it is drawn, type a fret, confirm.
 resize(1024);await page.waitForTimeout(600);await ready();
 const target=await page.evaluate(()=>{const api=window.tabStudio.api,beat=window.tabStudio.getScore().tracks[0].staves[0].bars[1].voices[0].beats.find(b=>b.notes.length),note=beat.notes[0];
  const bounds=api.boundsLookup.findBeats(beat).map(b=>b.notes?.find(n=>n.note===note)).filter(Boolean).at(-1).noteHeadBounds,score=document.querySelector('#score').getBoundingClientRect();
  document.querySelector('#score-scroll').scrollTop+=score.top+bounds.y-450;const after=document.querySelector('#score').getBoundingClientRect();
  return {x:after.left+bounds.x+bounds.w/2,y:after.top+bounds.y+bounds.h/2,w:bounds.w,h:bounds.h,fret:note.fret,string:note.string};});
 await page.mouse.click(target.x,target.y);await page.waitForTimeout(200);
 const fret=target.fret===7?9:7;await page.keyboard.press('Enter');await page.locator('#inline-fret').waitFor({state:'visible'});
 const input=await page.locator('#inline-fret').boundingBox();
 await page.keyboard.type(String(fret));await page.keyboard.press('Enter');await ready();
 const edited=await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[1].voices[0].beats.find(b=>b.notes.length).notes[0].fret);
 results.push({edit:{target,input,fret,edited}});console.log('EDIT',JSON.stringify(results.at(-1).edit));
 assert.equal(edited,fret,'the clicked note took the typed fret');
 assert.ok(input.x<target.x&&target.x<input.x+input.width&&input.y<target.y&&target.y<input.y+input.height,'the fret input sits on the clicked note');
 await page.screenshot({path:path.join(folder,'edit-1024.png')});
 resize(1500);await page.waitForTimeout(600);await ready();
 const widened=results.filter(r=>r.width===1500).at(-1);assert.equal(widened.fit,results[0].fit,'widening restores it');
 assert.equal(widened.dirty,results[0].dirty,'resizing does not edit the document');
 assert.deepEqual(app.errors,[]);
 await fs.writeFile(path.join(folder,'results.json'),JSON.stringify(results,null,1));
 console.log('PASS tauri-fit-width-check',folder);
}finally{await app.close();}
