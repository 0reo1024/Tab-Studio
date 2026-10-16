// Run against the release Tauri build; all files and preferences stay in a fresh test profile.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {launchTauri} from './tauri-app.mjs';

const folder=path.resolve(`test-results/tauri-regressions-${Date.now()}`),out=path.join(folder,'exports');
await fs.mkdir(out,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data'),executable:path.resolve('src-tauri/target/release/tab-studio.exe'),env:{TAB_STUDIO_TEST_MUTE:'1',TAB_STUDIO_TEST_SAVE_DIR:out}});
const page=app.page,results={folder};
page.setDefaultTimeout(20000);
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;});
const project=tex=>{const score=at.importer.ScoreLoader.loadAlphaTex(tex,new at.Settings());return JSON.stringify({format:'TabStudio',version:1,sourceName:score.title,warnings:[],score:JSON.parse(at.model.JsonConverter.scoreToJson(score))});};
async function load(name,tex){await page.evaluate(([name,p])=>window.tabStudio.load(name+'.tabstudio',new TextEncoder().encode(p)),[name,project(tex)]);await ready();}
async function menu(root,item){await page.locator('.menu-root').filter({has:page.locator(':scope>button',{hasText:new RegExp('^'+root+'$')})}).locator(':scope>button').click();if(item)await page.getByRole('menuitem',{name:item,exact:true}).click();}
async function save(name){await page.locator('#score-scroll').focus();await page.keyboard.press('Control+s');await page.waitForFunction(name=>window.tabStudio.getState().documents.find(d=>d.active)?.name===name+'.tg'&&!window.tabStudio.getState().dirty,name);}
try{
 await page.locator('#start-demo').click();await ready();
 await load('Race-A','\\title "Race-A" \\tempo 120 . :4 0.1 1.1 2.1 3.1 | 4.1 5.1 6.1 7.1');await save('Race-A');
 const dense='\\title "Race-B" \\tempo 120 '+Array.from({length:4},(_,i)=>'\\track "Part '+i+'" . '+Array(168).fill(':16 3.1 5.1 7.1 9.1 3.1 5.1 7.1 9.1 3.1 5.1 7.1 9.1 3.1 5.1 7.1 9.1').join(' | ')).join(' ');
 await load('Race-B',dense);await save('Race-B');
 await page.evaluate(()=>window.tabStudio.selectNote(80,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('12');await page.keyboard.press('Enter');await ready();
 const fileA=path.join(out,'Race-A.tg'),fileB=path.join(out,'Race-B.tg'),beforeA=await fs.readFile(fileA),beforeB=await fs.readFile(fileB);
 await page.keyboard.press('Control+s');await page.locator('.document-tab button[role=tab]').filter({hasText:'Race-A.tg'}).click();await ready();
 for(let i=0;i<100&&(await fs.readFile(fileB)).equals(beforeB);i++)await new Promise(r=>setTimeout(r,50));
 results.saveRace={aChanged:!(await fs.readFile(fileA)).equals(beforeA),bChanged:!(await fs.readFile(fileB)).equals(beforeB),documents:await page.evaluate(()=>window.tabStudio.getState().documents)};
 assert.equal(results.saveRace.aChanged,false,'switching tabs must not overwrite A');
 assert.equal(results.saveRace.bChanged,true,'B must be written');
 await page.waitForFunction(()=>!window.tabStudio.getState().documents.find(d=>d.name==='Race-B.tg')?.dirty);
 const copy=path.join(folder,'saved-B.tg');await fs.copyFile(fileB,copy);await page.locator('#fileInput').setInputFiles(copy);
 await page.waitForFunction(()=>window.tabStudio.getState().documents.find(d=>d.active)?.name==='saved-B.tg'&&!window.tabStudio.getState().rendering);
 assert.equal(await page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[80].voices[0].beats[0].notes[0].fret),12);
 console.log('SAVE RACE',JSON.stringify(results.saveRace));
 await page.screenshot({path:path.join(folder,'save-race.png')});

 // Hold the actual disk write after encoding to exercise edits and repeated saves in flight.
 await page.locator('.document-tab button[role=tab]').filter({hasText:'Race-B.tg'}).click();await ready();
 await page.evaluate(()=>{const original=window.desktop.saveScore;window.saveCalls=0;window.desktop.saveScore=async args=>{window.saveCalls++;window.saveWaiting=true;await new Promise(r=>window.releaseSave=r);return original(args);};window.restoreSave=()=>window.desktop.saveScore=original;});
 await page.locator('#score-scroll').focus();await page.keyboard.press('Control+s');await page.waitForFunction(()=>window.saveWaiting);
 await page.evaluate(()=>window.tabStudio.selectNote(80,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('13');await page.keyboard.press('Enter');await ready();
 await page.keyboard.press('Control+s');
 await page.locator('.document-tab button[role=tab]').filter({hasText:'Race-A.tg'}).click();await ready();
 await page.evaluate(()=>window.tabStudio.selectNote(0,0));await page.locator('#score-scroll').focus();await page.keyboard.press('Enter');await page.locator('#inline-fret').fill('22');await page.keyboard.press('Enter');await ready();
 await page.evaluate(()=>{window.releaseSave();window.restoreSave();});
 await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Race-B.tg')&&document.getElementById('status').textContent.includes('保存しました'));
 results.inFlight=await page.evaluate(()=>({calls:window.saveCalls,documents:window.tabStudio.getState().documents}));
 assert.equal(results.inFlight.calls,1,'duplicate saves must not race');
 assert.ok(results.inFlight.documents.find(d=>d.name==='Race-B.tg').dirty,'later edits to B must remain dirty');
 assert.ok(results.inFlight.documents.find(d=>d.name==='Race-A.tg').dirty,'edits in A must remain dirty');
 assert.ok((await fs.readFile(fileA)).equals(beforeA),'A is still unchanged on disk');
 async function diskFret(name){
  const copy=path.join(folder,name+'.tg');await fs.copyFile(fileB,copy);await page.locator('#fileInput').setInputFiles(copy);
  await page.waitForFunction(name=>window.tabStudio.getState().documents.find(d=>d.active)?.name===name+'.tg'&&!window.tabStudio.getState().rendering&&!window.tabStudio.getState().loading,name);
  return page.evaluate(()=>window.tabStudio.getScore().tracks[0].staves[0].bars[80].voices[0].beats[0].notes[0].fret);
 }
 assert.equal(await diskFret('held-save'),12,'later edits must not leak into the in-flight snapshot');
 await page.locator('.document-tab button[role=tab]').filter({hasText:'Race-B.tg'}).click();await ready();await save('Race-B');
 assert.equal(await diskFret('after-retry'),13);
 assert.ok(await page.evaluate(()=>window.tabStudio.getState().documents.find(d=>d.name==='Race-A.tg').dirty));
 console.log('IN-FLIGHT EDITS',JSON.stringify(results.inFlight));

 await load('FirstNote','\\title "FirstNote" \\tempo 120 . :4 5.1 r r r | 7.1 r r r');
 await page.locator('#home').click();await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);
 const samples=await page.evaluate(async()=>{const out=[];for(let i=0;i<65;i++){const s=await window.__TAURI_INTERNALS__.invoke('audio_status');out.push({position:s.position,peaks:s.peaks});await new Promise(r=>setTimeout(r,40));}return out;});
 results.firstNote={firstPeak:Math.max(0,...samples.filter(s=>s.position<.45).map(s=>s.peaks[0]??0)),secondBarPeak:Math.max(0,...samples.filter(s=>s.position>=2&&s.position<2.45).map(s=>s.peaks[0]??0)),samples};
 await page.locator('#stop').click();
 assert.ok(results.firstNote.firstPeak>.001,'the note on tick zero must sound');
 assert.ok(results.firstNote.secondBarPeak>.001,'later notes must still sound');
 console.log('FIRST NOTE',JSON.stringify({...results.firstNote,samples:undefined}));

 await load('Order','\\title "Order" \\track "One" . :4 0.1 1.1 2.1 3.1 \\track "Two" . :4 4.1 5.1 6.1 7.1 \\track "Three" . :4 8.1 9.1 10.1 11.1');await menu('表示','すべてのトラックを表示');await ready();
 await page.locator('#tracks .track-settings').nth(1).click();await page.locator('#track-down').click();await ready();await page.locator('#trackDialog [data-close]').click();
 results.reorder=await page.evaluate(()=>({model:window.tabStudio.getScore().tracks.map(t=>t.name),visible:window.tabStudio.getState().visibleTracks,rows:window.tabStudio.api.boundsLookup.staffSystems[0].bars[0].bars.map(b=>(b.bar??b.beats[0]?.beat.voice.bar)?.staff.track.name)}));
 await page.screenshot({path:path.join(folder,'reorder.png')});await menu('表示','すべてのトラックを表示');await ready();results.reorder.afterShowAll=await page.evaluate(()=>window.tabStudio.api.boundsLookup.staffSystems[0].bars[0].bars.map(b=>(b.bar??b.beats[0]?.beat.voice.bar)?.staff.track.name));
 assert.deepEqual([...new Set(results.reorder.rows)],results.reorder.model,'the rendered order must match the score');
 assert.deepEqual(results.reorder.visible,[0,1,2]);
 console.log('REORDER',JSON.stringify(results.reorder));

 const renderedOrder=()=>page.evaluate(()=>[...new Set(window.tabStudio.api.boundsLookup.staffSystems[0].bars[0].bars.map(b=>(b.bar??b.beats[0]?.beat.voice.bar)?.staff.track.name))]);
 await page.locator('#score-scroll').focus();await page.keyboard.press('Control+z');await ready();assert.deepEqual(await renderedOrder(),['One','Two','Three']);
 await page.keyboard.press('Control+y');await ready();assert.deepEqual(await renderedOrder(),['One','Three','Two']);
 await menu('トラック','トラック複製');await page.locator('#duplicate-track-source').selectOption('0');await page.locator('#duplicate-track-apply').click();await ready();
 assert.deepEqual(await renderedOrder(),await page.evaluate(()=>window.tabStudio.getScore().tracks.map(t=>t.name)),'duplicated tracks must render directly after their source');
 await page.locator('#tracks .track').nth(1).locator('input[type=checkbox]').first().uncheck();await ready();
 assert.deepEqual(await renderedOrder(),await page.evaluate(()=>window.tabStudio.getState().visibleTracks.map(i=>window.tabStudio.getScore().tracks[i].name)),'a subset keeps score order');
 await menu('表示','すべてのトラックを表示');await ready();

 const preview=()=>page.evaluate(()=>window.tabStudio.preview.play(window.tabStudio.getScore().tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0]));
 const before=await preview();const choosing=page.waitForEvent('filechooser');await menu('ツール','SoundFontを交換…');await (await choosing).setFiles(path.resolve('public/alphatab/soundfont/sonivox.sf2'));await page.waitForFunction(()=>document.getElementById('status').textContent.includes('音源を交換しました：sonivox.sf2'),null,{timeout:60000});const after=await preview();await menu('ツール');
 assert.ok(Math.abs(before.peak-after.peak)>.0001,'the chosen bank must change preview audio');
 results.soundfont={before,after,menu:await page.locator('.menu-root.open').innerText()};await page.screenshot({path:path.join(folder,'soundfont.png')});await page.keyboard.press('Escape');console.log('SOUNDFONT',JSON.stringify(results.soundfont));
 assert.ok(!results.soundfont.menu.includes('読み込み中'),'loading must finish');
 // Corrupt banks produce an error and retain the last working bank.
 const invalid=path.join(folder,'invalid.sf2');await fs.writeFile(invalid,'not a soundfont');
 const badChooser=page.waitForEvent('filechooser');await menu('ツール','SoundFontを交換…');await(await badChooser).setFiles(invalid);
 await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('音源を読み込めませんでした'));
 const retained=await preview();assert.equal(retained.peak,after.peak);assert.ok(await page.locator('#play').isEnabled());
 // SF3 is supported as well, without reusing the bundled font's size-based cache.
 const sf3Chooser=page.waitForEvent('filechooser');await menu('ツール','SoundFontを交換…');await(await sf3Chooser).setFiles(path.resolve('public/alphatab/soundfont/sonivox.sf3'));
 await page.waitForFunction(()=>document.getElementById('status').textContent.includes('音源を交換しました：sonivox.sf3'),null,{timeout:60000});
 const compressed=await preview();assert.ok(compressed.peak>.001);
 results.soundfont.retained=retained;results.soundfont.sf3=compressed;
 await page.locator('#home').click();await page.locator('#play').click();
 await page.waitForFunction(async()=>{const s=await window.__TAURI_INTERNALS__.invoke('audio_status');return s.playing&&s.peaks.some(p=>p>.001);});await page.locator('#stop').click();
 results.errors=app.errors;assert.deepEqual(app.errors,[]);
 await fs.writeFile(path.join(folder,'results.json'),JSON.stringify(results,null,2));console.log('RESULTS='+path.join(folder,'results.json'));
}finally{await app.close();}
