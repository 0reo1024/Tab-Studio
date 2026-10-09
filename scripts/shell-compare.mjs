// P1-10: startup time and memory of the Electron build vs the Tauri build (Windows).
// Startup = launch until the start screen is usable, then until the demo is rendered.
// Memory = private working set summed over the app's whole process tree (WebView2 /
// Chromium helper processes included), after the demo has been open and idle for 5 s.
// Usage: pnpm build && pnpm tauri build --no-bundle && node scripts/shell-compare.mjs [runs]
import {_electron as electron} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';
const runs=Number(process.argv[2]??3),root=process.cwd(),folder=path.resolve(`test-results/shell-compare-${Date.now()}`);
await fs.mkdir(folder,{recursive:true});
function treeMemoryMB(pid){
 const script=`$all=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId;$ids=@(${pid});$i=0;while($i -lt $ids.Count){$ids+=@($all|Where-Object{$_.ParentProcessId -eq $ids[$i]}|ForEach-Object{$_.ProcessId});$i++};$sum=0;foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p){$sum+=$p.PrivateMemorySize64}};"$($ids.Count) $sum"`;
 const [count,bytes]=execFileSync('powershell',['-NoProfile','-Command',script]).toString().trim().split(' ').map(Number);
 return {processes:count,mb:Math.round(bytes/1048576)};
}
async function measure(page,pid,started){
 await page.locator('#start-demo').waitFor({state:'visible',timeout:60000});const start=Math.round(performance.now()-started);
 await page.locator('#start-demo').click();
 await page.waitForFunction(()=>window.tabStudio?.getState().ready&&!window.tabStudio.getState().rendering,{},{timeout:60000});const demo=Math.round(performance.now()-started);
 await new Promise(r=>setTimeout(r,5000));
 return {startScreenMs:start,demoReadyMs:demo,...treeMemoryMB(pid)};
}
const results={electron:[],tauri:[]};
for(let i=0;i<runs;i++){
 let started=performance.now();
 const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,`electron-${i}`)}});
 try{results.electron.push(await measure(await app.firstWindow(),app.process().pid,started));}finally{await app.close();}
 const tauri=await launchTauri({dataDir:path.join(folder,`tauri-${i}`),executable:tauriExecutable(process.env.TAURI_PROFILE||'release')});
 try{results.tauri.push(await measure(tauri.page,tauri.child.pid,tauri.started));}finally{await tauri.close();}
}
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const summary=Object.fromEntries(Object.entries(results).map(([k,v])=>[k,{startScreenMs:median(v.map(r=>r.startScreenMs)),demoReadyMs:median(v.map(r=>r.demoReadyMs)),memoryMB:median(v.map(r=>r.mb)),processes:median(v.map(r=>r.processes))}]));
await fs.writeFile(path.join(folder,'report.json'),JSON.stringify({results,summary},null,1));
console.table(summary);console.log(folder);
