// Drives the S5 page in Electron's Chromium via the vite dev server.
import {_electron as electron} from '@playwright/test';
import {spawn} from 'node:child_process';
import path from 'node:path';
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--port','5199','--strictPort'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.resolve('test-results/s5-'+Date.now()),TAB_STUDIO_DEV_URL:'http://127.0.0.1:5199/spikes/s5-external-media/index.html'}});
try{
 const page=await app.firstWindow();page.on('pageerror',e=>console.log('PAGEERROR',e.message));page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')console.log('CONSOLE',m.text().slice(0,300));});await page.reload();
 await page.waitForTimeout(6000);console.log('STATE',await page.evaluate(()=>JSON.stringify({url:location.href,s5:window.s5&&{r:window.s5.rendered,ready:window.s5.ready,e:window.s5.errors,a:window.s5.attached}})));
 await page.waitForFunction(()=>window.s5?.rendered&&window.s5?.ready,{},{timeout:30000});
 const step=async(label,fn,wait=0)=>{await page.evaluate(fn);if(wait)await page.waitForTimeout(wait);const s=await page.evaluate(()=>({tick:api.tickPosition,time:Math.round(api.timePosition),state:api.playerState,cursor:document.querySelector('.at-cursor-beat')?.getAttribute('style')?.slice(0,80),n:s5.positions.length,beats:s5.beats.length,handler:s5.handler.slice(-4)}));console.log(label,JSON.stringify(s));};
 console.log('midi',await page.evaluate(()=>JSON.stringify({midi:s5.midi,attached:s5.attached,end:s5.endTime,errors:s5.errors})));
 await step('play 1.2s',()=>api.play(),1200);
 await step('pause',()=>api.pause(),200);
 await step('seek tick 3840',()=>{api.tickPosition=3840;},300);
 await step('speed 0.5 + play 1s',()=>{api.playbackSpeed=0.5;api.play();},1000);
 await step('pause',()=>api.pause(),100);
 await step('loop bar1 + play 1.6s',()=>{api.playbackSpeed=1;api.playbackRange={startTick:0,endTick:3840};api.isLooping=true;api.tickPosition=0;api.play();},2600);
 await step('loop continues 2s more',()=>{},2000);
 await step('stop',()=>{api.stop();},300);
 await step('play to end (no loop) 9s',()=>{api.isLooping=false;api.playbackRange=null;api.tickPosition=11520;api.play();},6500);
 console.log('positions sample',JSON.stringify(await page.evaluate(()=>s5.positions.filter((_,i)=>i%15===0).slice(0,40))));
}finally{await app.close();vite.kill();}
