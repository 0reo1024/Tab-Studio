// Spike S1/S2: launch the Tauri debug build with WebView2 remote debugging,
// attach Playwright over CDP, open the demo score and check rendering + playback.
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import path from 'node:path';
const root=process.cwd(),exe=path.join(root,'src-tauri/target/debug/tab-studio.exe'),port=9333;
const child=spawn(exe,[],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'inherit'});
const started=Date.now();let browser;
for(let i=0;i<100&&!browser;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);}catch{await new Promise(r=>setTimeout(r,200));}}
try{
 const context=browser.contexts()[0];let page=context.pages()[0];for(let i=0;!page&&i<50;i++){await new Promise(r=>setTimeout(r,100));page=context.pages()[0];}
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push('console: '+m.text());});
 await page.locator('#start-demo').click({timeout:30000});
 console.log('start screen ready after',Date.now()-started,'ms','url',page.url());
 await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering,{},{timeout:60000});
 console.log('demo rendered after',Date.now()-started,'ms');
 const info=await page.evaluate(()=>({svg:document.querySelectorAll('#score svg, .at-surface svg').length,ua:navigator.userAgent,worklet:typeof AudioWorkletNode,wasm:typeof WebAssembly,sab:typeof SharedArrayBuffer,desktop:!!window.desktop,tauri:!!window.__TAURI_INTERNALS__}));
 console.log(info);
 await page.keyboard.press('Space');await page.waitForTimeout(3000);
 const tick=await page.evaluate(()=>window.tabStudio.getState());
 console.log('after 3s play state', JSON.stringify(tick).slice(0,400));
 await page.keyboard.press('Space');
 await page.screenshot({path:path.join(root,'test-results/s1-tauri.png')});
 console.log('errors',errors);
}finally{await browser?.close().catch(()=>{});child.kill();}
