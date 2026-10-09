// Launches the Tauri build (src-tauri/target/<profile>/tab-studio.exe) with WebView2
// remote debugging and attaches Playwright over CDP. Used by the Tauri checks.
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import path from 'node:path';
let nextPort=9400+Math.floor(Math.random()*400);
export function tauriExecutable(profile=process.env.TAURI_PROFILE||'debug'){return path.resolve('src-tauri/target',profile,'tab-studio.exe');}
export async function launchTauri({dataDir,env={},executable=tauriExecutable()}={}){
 const port=nextPort++,started=performance.now();
 const child=spawn(executable,[],{env:{...process.env,...env,...(dataDir?{TAB_STUDIO_TEST_DATA:dataDir}:{}),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:process.env.TAURI_STDIO||'ignore'});
 const exited=new Promise(resolve=>child.once('exit',code=>resolve(code)));
 let browser;
 for(let i=0;i<150&&!browser;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);}catch{await new Promise(r=>setTimeout(r,200));}}
 if(!browser){child.kill();throw new Error('Tauri app did not open a debugging port');}
 const context=browser.contexts()[0];let page=context.pages()[0];
 for(let i=0;!page&&i<100;i++){await new Promise(r=>setTimeout(r,100));page=context.pages()[0];}
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // The first page can still be about:blank; wait for the app document before evaluating in it.
 for(let i=0;i<300&&!/^https?:\/\/tauri\.localhost\//.test(page.url());i++)await new Promise(r=>setTimeout(r,100));
 await page.waitForLoadState('domcontentloaded');
 return {page,browser,child,errors,exited,started,
  async close(){await browser.close().catch(()=>{});if(child.exitCode===null)child.kill();await exited;}};
}
