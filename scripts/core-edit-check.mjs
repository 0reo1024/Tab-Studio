// P3-6: the "new edit engine" (document core) in the Electron app. Opens a song with many
// linked measures (SONG=path, default ~/Desktop/Champagne.tg, else the demo), makes
// edits that today normalize the whole song (duration, bend) plus fret entries, then
// undoes and redoes them, checking after every step that the view equals the snapshot
// (verifySnapshot) and the core is still running. Prints the edit timings.
// Usage: node scripts/core-edit-check.mjs
import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const song=process.env.SONG||path.join(os.homedir(),'Desktop','Champagne.tg');
const app=await electron.launch({executablePath:process.env.TAB_STUDIO_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:process.env.TAB_STUDIO_TEST_EXE?[]:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST:'1',TAB_STUDIO_TEST_DATA:path.resolve('test-results/core-edit-'+Date.now())}});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForLoadState('domcontentloaded');
 await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('tabstudio-settings')||'{}');s.coreEdits=true;localStorage.setItem('tabstudio-settings',JSON.stringify(s));});
 await page.reload();await page.waitForLoadState('domcontentloaded');
 await page.locator('#start-demo').click({timeout:30000});
 const settled=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;});
 await settled();
 if(fs.existsSync(song)){await page.evaluate(([name,b])=>window.tabStudio.load(name,new Uint8Array(b)),[path.basename(song),[...fs.readFileSync(song)]]);await settled();}
 const info=await page.evaluate(()=>({bars:window.tabStudio.getScore().masterBars.length,tracks:window.tabStudio.getScore().tracks.length}));
 console.log(`song: ${fs.existsSync(song)?path.basename(song):'demo'} (${info.tracks} tracks, ${info.bars} bars)`);
 const t0=Date.now(),log=(...a)=>console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s]`,...a);
 const check=async label=>{log(`settling after ${label}`);await settled();log(label);const r=await page.evaluate(()=>({verify:window.tabStudio.verifySnapshot(),core:window.tabStudio.coreActive(),notice:window.tabStudio.coreError?.()}));if(!r.core)log('core error:',r.notice);assert.equal(r.verify,true,`${label}: view differs from snapshot ${JSON.stringify(r.verify).slice(0,300)}`);assert.equal(r.core,true,`${label}: the core stopped`);};
 const action=async(bar,beat,id)=>{log(`start ${id} at bar ${bar + 1}`);await page.evaluate(([bar,beat])=>window.tabStudio.selectNote(bar,beat),[bar,beat]);await page.evaluate(id=>window.tabStudio.paletteAction(id),id);await check(`${id} at bar ${bar + 1}`);};
 await page.evaluate(()=>window.tabStudio.perf.reset());
 // Edits in the middle of the song (linked measures in Champagne).
 const bars=[Math.min(10,info.bars-1),Math.min(30,info.bars-1),Math.min(60,info.bars-1)];
 // The first beats with a note in the bar (techniques need a note).
 const noteBeats=bar=>page.evaluate(bar=>window.tabStudio.getScore().tracks[0].staves[0].bars[bar].voices[0].beats.flatMap((b,i)=>b.notes.length?[i]:[]),bar);
 for(const bar of bars){const beats=await noteBeats(bar);assert.ok(beats.length,`bar ${bar + 1} has notes`);await action(bar,beats[0],'duration8');const after=await noteBeats(bar);await action(bar,after[1]??after[0],'bend');}
 const fret=async(bar,value)=>{await page.evaluate(([bar])=>window.tabStudio.selectNote(bar,0),[bar]);await page.evaluate(v=>{window.tabStudio.paletteAction('inline');const input=document.querySelector('#inline-fret');input.value=String(v);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));},value);await check(`fret at bar ${bar + 1}`);};
 for(const bar of bars)await fret(bar,7);
 const edits=await page.evaluate(()=>window.tabStudio.perf.summary());
 // Undo everything made here, then redo half of it.
 const history=async(id,count)=>{for(let i=0;i<count;i++){await page.evaluate(id=>document.getElementById(id).click(),id);await check(`${id} ${i + 1}`);}};
 await page.evaluate(()=>window.tabStudio.perf.reset());
 await history('undo',bars.length*3);await history('redo',bars.length);
 const undoes=await page.evaluate(()=>window.tabStudio.perf.summary());
 const pick=(s,name)=>s.spans?.[name]??s[name];
 const show=(s,name)=>{const v=pick(s,name);return v?`${name}: n=${v.count} median ${v.median} ms max ${v.max} ms`:`${name}: -`;};
 for(const name of ['edit.commit','edit.core','edit.normalize','edit.refinish','edit.local'])console.log(show(edits,name));
 console.log(show(undoes,'edit.history'));
 assert.deepEqual(errors,[]);
 console.log('PASS core-edit-check');
}finally{await app.evaluate(()=>process.exit(0)).catch(()=>{});}
