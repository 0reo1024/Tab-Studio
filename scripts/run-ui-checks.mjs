// Runs Electron UI check scripts one after another against the current dist/ build
// and prints a PASS/FAIL table. Usage: node scripts/run-ui-checks.mjs [names...]
// UI_TARGET=tauri runs them against the Tauri build instead (scripts/tauri-ui-shim.mjs).
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const defaults=['confirmed-edit-check','edit-mode-check','editing-stress-check','edit-performance-check','enhancements-check','range-effects-check','compact-transpose-check','navigation-check','focus-shortcuts-check','multitrack-check','track-display-loop-check','input-preview-check','direct-controls-popover-check','menu-settings-check','layout-check','playback-seek-check','range-playback-context-check','mixer-check','mixer-actions-check','mixer-document-check','mixer-routing-check','mixer-technique-check','mixer-layout-check','mixer-stability-check','memory-lifecycle-check','workspace-features-check','startup-techniques-check','nylon-guitar-check'];
const names=process.argv.slice(2).length?process.argv.slice(2):defaults,results=[],tauri=process.env.UI_TARGET==='tauri',folder=path.resolve(`test-results/ui-checks-${tauri?'tauri-':''}${Date.now()}`);await fs.mkdir(folder,{recursive:true});
for(const name of names){
 const started=Date.now();
 const code=await new Promise(async resolve=>{const source=await fs.readFile(`scripts/${name}.mjs`,'utf8'),shim=[...(tauri?['--import','./scripts/tauri-ui-shim.mjs']:[]),...(source.includes('start-demo')?[]:['--import','./scripts/ui-check-shim.mjs'])];
  const child=spawn(process.execPath,['--import','tsx',...shim,`scripts/${name}.mjs`],{stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
  const timer=setTimeout(()=>{log+='\nTIMEOUT';child.kill();},8*60*1000);child.on('close',async c=>{clearTimeout(timer);await fs.writeFile(path.join(folder,name+'.log'),log);resolve(c);});});
 const seconds=Math.round((Date.now()-started)/1000);results.push({name,ok:code===0,seconds});console.log(`${code===0?'PASS':'FAIL'} ${name} (${seconds}s)`);
}
console.log(`\n${results.filter(r=>r.ok).length}/${results.length} passed · logs: ${folder}`);
