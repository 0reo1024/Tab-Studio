// Runs the Electron UI check scripts against the Tauri build. Loaded with
// `node --import` before the script (run-ui-checks.mjs does this when UI_TARGET=tauri).
// `_electron.launch` starts src-tauri/target/<TAURI_PROFILE>/tab-studio.exe instead and
// returns an object with the parts of ElectronApplication the scripts use. Main-process
// `app.evaluate` calls are translated for the common cases:
// process.exit -> quit, window show -> nothing, window close -> WM_CLOSE,
// capturePage -> page screenshot, dialog.showSaveDialog mocks -> the Tauri test answer file.
import {_electron} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launchTauri} from './tauri-app.mjs';
_electron.launch=async(options={})=>{
 const dataDir=options.env?.TAB_STUDIO_TEST_DATA??fs.mkdtempSync(path.join(os.tmpdir(),'tab-studio-tauri-'));
 const env={...options.env};delete env.TAB_STUDIO_TEST_DATA;
 const tauri=await launchTauri({dataDir,env});
 const answer=path.join(dataDir,'test-save-answer');
 const closeWindow=()=>execFileSync('powershell',['-NoProfile','-Command',`(Get-Process -Id ${tauri.child.pid} -ErrorAction SilentlyContinue).CloseMainWindow()|Out-Null`]);
 const listeners=[];tauri.exited.then(()=>{for(const l of listeners.splice(0))l();});
 return {
  firstWindow:async()=>tauri.page,windows:()=>tauri.child.exitCode===null?[tauri.page]:[],
  context:()=>tauri.page.context(),process:()=>tauri.child,
  waitForEvent:(name)=>name==='close'?tauri.exited:Promise.reject(new Error(`Tauri shim: event ${name} is not supported`)),
  on:(name,fn)=>{if(name==='close')listeners.push(fn);},
  close:()=>tauri.close(),
  async evaluate(fn,arg){
   const source=fn.toString();
   if(source.includes('process.exit')){await tauri.close();return;}
   if(source.includes('capturePage'))return (await tauri.page.screenshot()).toString('base64');
   if(/getAllWindows\(\)\[0\]\.close\(\)/.test(source)){closeWindow();return;}
   if(/\.show(Inactive)?\(\)/.test(source)&&!source.includes('dialog'))return;
   if(source.includes('showSaveDialog')){
    const dialog={};fn({dialog,app:{},BrowserWindow:{getAllWindows:()=>[]}},arg);
    try{const result=await dialog.showSaveDialog(null,{defaultPath:'',filters:[{extensions:['']}]});fs.writeFileSync(answer,result.canceled?'':result.filePath);}
    catch{fs.rmSync(answer,{force:true});}
    return;
   }
   throw new Error('Tauri shim: unsupported main-process evaluate: '+source.slice(0,120));
  },
 };
};
