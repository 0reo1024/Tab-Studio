// 「音声を再生」 in the Tauri release build: a small movable window that plays an audio file on
// its own (play/pause, seek, speed), or with 「曲と一緒に流す」 in time with the score through the
// engine (meter, pause, practice speed, mute/solo, loudness leveling), its settings are saved
// with the score and reload with it, a missing file offers a relink, and a YouTube video
// follows the song position. Output is muted (TAB_STUDIO_TEST_MUTE); meters still move.
// Usage: TAURI_PROFILE=release node --import tsx scripts/tauri-backing-check.mjs [real.mp3]
// (YouTube needs the internet; BACKING_NO_YOUTUBE=1 skips it.)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {launchTauri,tauriExecutable} from './tauri-app.mjs';

const folder=path.resolve(`test-results/backing-${Date.now()}`);await fs.mkdir(folder,{recursive:true});
/** 20 s at 44.1 kHz: a 220 Hz tone with a click every 0.5 s (a stand-in recording). */
function wav(seconds=20,rate=44100){
 const frames=seconds*rate,data=Buffer.alloc(frames*4),head=Buffer.alloc(44);
 for(let i=0;i<frames;i++){const v=Math.round((Math.sin(i/rate*220*2*Math.PI)*.3+(i%(rate/2)<40?.5:0))*32767*.8);data.writeInt16LE(v,i*4);data.writeInt16LE(v,i*4+2);}
 head.write('RIFF',0);head.writeUInt32LE(36+data.length,4);head.write('WAVEfmt ',8);head.writeUInt32LE(16,16);head.writeUInt16LE(1,20);head.writeUInt16LE(2,22);head.writeUInt32LE(rate,24);head.writeUInt32LE(rate*4,28);head.writeUInt16LE(4,32);head.writeUInt16LE(16,34);head.write('data',36);head.writeUInt32LE(data.length,40);
 return Buffer.concat([head,data]);
}
const audioFile=path.join(folder,'伴奏 テスト.wav');await fs.writeFile(audioFile,wav());
const real=process.argv[2];

const app=await launchTauri({dataDir:path.join(folder,'data'),env:{TAB_STUDIO_TEST_MUTE:'1'},executable:tauriExecutable(process.env.TAURI_PROFILE||'release')});
const {page}=app;page.setDefaultTimeout(30000);const logs=[];page.on('console',m=>{if(m.type()==='error')logs.push(m.text().slice(0,300));});
const state=()=>page.evaluate(()=>window.tabStudio.getState());
const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!s.loading;},{},{timeout:60000});
const panel=()=>page.evaluate(()=>{const b=window.tabStudio.backing;return {settings:{...b.settings},state:document.querySelector('#backing-state').textContent,info:document.querySelector('#backing-info').textContent,error:document.querySelector('#backing-error').textContent,label:b.label()};});
/** Peak of the backing strip over `ms` (status snapshots reset it each read). */
const backingPeak=ms=>page.evaluate(ms=>new Promise(resolve=>{let peak=0;const t=setInterval(()=>{peak=Math.max(peak,window.tabStudio.backing.peak());},16);setTimeout(()=>{clearInterval(t);resolve(peak);},ms);}),ms);
const play=async()=>{await page.locator('#play').click();await page.waitForFunction(()=>window.tabStudio.getState().playing);};
const pause=async()=>{await page.locator('#play').click();await page.waitForFunction(()=>!window.tabStudio.getState().playing);};
try{
 await page.waitForFunction(()=>!!window.nativeAudio,{},{timeout:30000});
 await page.evaluate(()=>localStorage.setItem('tabstudio-settings',JSON.stringify({nativeAudio:true})));
 await page.reload();await page.waitForLoadState('domcontentloaded');
 await page.locator('#start-demo').click();await ready();
 assert.ok(await page.evaluate(()=>!!window.tabStudio.backing),'the backing panel exists with the native engine');

 // 1. Choose a file (the dialog is native, so the setting is made as its result would be).
 await page.evaluate(file=>{const b=window.tabStudio.backing;Object.assign(b.settings,{source:'file',path:file,name:file.split(/[\\/]/).pop(),offset:0});b.sync();b.open();},audioFile);
 await page.waitForFunction(()=>window.tabStudio.backing.label()!=='なし'&&/^(単体で再生|曲と連動)/.test(document.querySelector('#backing-state').textContent),{},{timeout:30000});
 let p=await panel();console.log('loaded:',p.info);
 assert.match(p.info,/PCM_S16LE 44\.1 kHz · ステレオ · -?\d+\.\d LUFS/);
 assert.equal(await page.locator('#backing-title').textContent(),'音声を再生');
 assert.equal(p.settings.linked,false,'plays on its own by default');

 // 1b. On its own: ▶ plays the file without the score, the waveform seeks, the speed changes,
 // ▶ again pauses.
 await page.locator('#backing-play').click();
 await page.waitForFunction(()=>window.tabStudio.backing.status?.backingPlaying);
 assert.ok(await backingPeak(600)>.05,'the file plays on its own');
 assert.equal((await state()).playing,false,'the score stays stopped');
 const wave1=await page.locator('#backing-wave').boundingBox();
 await page.mouse.click(wave1.x+wave1.width*.5,wave1.y+wave1.height/2);await page.waitForTimeout(300);
 const at=await page.evaluate(()=>window.tabStudio.backing.status.backingPosition);
 assert.ok(at>9.9&&at<11,'clicking the middle of the waveform jumps to ~10 s: '+at);
 assert.match(await page.locator('#backing-time').textContent(),/^0:1\d\.\d \/ 0:20\.0$/);
 await page.locator('#backing-speed').selectOption('0.5');await page.waitForTimeout(1000);
 const a1=await page.evaluate(()=>window.tabStudio.backing.status.backingPosition);await page.waitForTimeout(1000);
 const a2=await page.evaluate(()=>window.tabStudio.backing.status.backingPosition);
 assert.ok(Math.abs(a2-a1-.5)<.1,'50%: half a second of audio per second: '+(a2-a1));
 await page.screenshot({path:path.join(folder,'panel-file.png')});
 await page.locator('#backing-play').click();await page.waitForTimeout(300);
 assert.equal(await backingPeak(400),0,'paused');
 await page.locator('#backing-speed').selectOption('1');

 // 1c. The window moves by its title bar and stays where it was put.
 {const before=await page.locator('#backing-panel').boundingBox(),grip=await page.locator('#backing-grip').boundingBox();
  await page.mouse.move(grip.x+60,grip.y+grip.height/2);await page.mouse.down();await page.mouse.move(grip.x+460,grip.y+grip.height/2-200,{steps:8});await page.mouse.up();
  const moved=await page.locator('#backing-panel').boundingBox();
  assert.ok(Math.abs(moved.x-before.x-400)<2&&Math.abs(moved.y-before.y+200)<2,`moved: ${JSON.stringify(before)} -> ${JSON.stringify(moved)}`);
  assert.ok(before.width<400,'a small window: '+before.width);
  await page.locator('#backing-close').click();await page.evaluate(()=>window.tabStudio.backing.open());
  const again=await page.locator('#backing-panel').boundingBox();assert.ok(Math.abs(again.x-moved.x)<2&&Math.abs(again.y-moved.y)<2,'reopens where it was');}

 // 1e. Space plays the score, also after a click in this window (and does not press the
 // window's buttons); C plays/pauses this audio, wherever the click was.
 {const bplaying=()=>page.evaluate(()=>!!window.tabStudio.backing.status?.backingPlaying);
  await page.locator('#backing-play').click();await page.waitForFunction(()=>window.tabStudio.backing.status?.backingPlaying);
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.tabStudio.getState().playing,{},{timeout:10000});
  assert.ok(await bplaying(),'Space after clicking ▶: the score starts, the audio is not toggled');
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);
  await page.keyboard.press('c');await page.waitForTimeout(400);
  assert.ok(!(await bplaying()),'C pauses the audio');
  await page.locator('#score-scroll').click({position:{x:8,y:8}});await page.keyboard.press('c');await page.waitForTimeout(400);
  assert.ok(await bplaying()&&!(await state()).playing,'C after a click on the score: the audio plays, the score does not');
  await page.keyboard.press('c');await page.waitForTimeout(400);assert.ok(!(await bplaying()),'C again: paused');
  console.log('Space -> score, C -> audio');}

 // 1d. 「曲と一緒に流す」: from now on it follows the score.
 await page.locator('#backing-more summary').click();
 await page.locator('#backing-linked').check();
 assert.equal((await panel()).settings.linked,true);

 // 2. It plays with the score: the strip meter moves while playing and stops after a pause.
 await play();const playing=await backingPeak(800);
 assert.ok(playing>.05,'backing sounds while the score plays: '+playing);
 await pause();await page.waitForTimeout(150);const paused=await backingPeak(400);
 assert.equal(paused,0,'silent once paused');

 // 3. Mute, solo and the leveling trim.
 await page.evaluate(()=>{const b=window.tabStudio.backing;b.settings.mute=true;b.sync();});
 await play();assert.equal(await backingPeak(600),0,'muted');await pause();
 await page.evaluate(()=>{const b=window.tabStudio.backing;b.settings.mute=false;b.settings.solo=true;b.sync();});
 await play();await page.waitForTimeout(300);
 const solo=await page.evaluate(()=>new Promise(resolve=>{let tracks=0,back=0;const t=setInterval(()=>{tracks=Math.max(tracks,...window.tabStudio.mixerAudio.peaks().tracks);back=Math.max(back,window.tabStudio.backing.peak());},16);setTimeout(()=>{clearInterval(t);resolve({tracks,back});},700);}));
 assert.ok(solo.back>0&&solo.tracks===0,'solo: only the backing sounds '+JSON.stringify(solo));
 await pause();await page.evaluate(()=>{const b=window.tabStudio.backing;b.settings.solo=false;b.sync();});

 // 4. Half speed: still playing in step (stretched), and the audio callback keeps up.
 const before=await page.evaluate(()=>window.tabStudio.backing.status?.callbacks??null);
 await page.locator('#speed').selectOption('0.5');await play();const slow=await backingPeak(2500);await pause();
 await page.evaluate(()=>{const b=window.tabStudio.backing;b.settings.semitones=-2;b.sync();});
 await play();const shifted=await backingPeak(1500);await pause();
 await page.locator('#speed').selectOption('1');
 const after=await page.evaluate(()=>window.tabStudio.backing.status?.callbacks??null);
 assert.ok(slow>.05&&shifted>.05,`stretched playback sounds: ${slow} ${shifted}`);
 console.log('audio callbacks before/after the stretched part:',JSON.stringify(before),JSON.stringify(after));
 if(before&&after)assert.equal(after.overloads,before.overloads,'no audio overloads while stretching');
 await page.evaluate(()=>{const b=window.tabStudio.backing;b.settings.semitones=0;b.sync();});

 // 5. Offset: a click on the waveform aligns that point with the cursor; nudges move it.
 const wave=page.locator('#backing-wave');const box=await wave.boundingBox();
 const cursor=await page.evaluate(()=>window.tabStudio.backing.status.position);
 await page.mouse.click(box.x+box.width*.1,box.y+box.height/2);
 p=await panel();assert.ok(Math.abs(p.settings.offset-(2-cursor))<.2,`clicked 10% into 20 s: that point is where the cursor (${cursor.toFixed(2)} s) is: offset ${p.settings.offset}`);
 await page.locator('[data-nudge="0.01"]').click();
 const offset=(await panel()).settings.offset;assert.ok(Math.abs(offset-p.settings.offset-.01)<1e-6,'nudge +10 ms');
 await page.screenshot({path:path.join(folder,'panel-offset.png')});

 // 6. Saved with the score and restored with it (a reopened project finds the file again).
 const saved=await page.evaluate(()=>window.tabStudio.serialize());
 assert.ok(saved.includes('studiobacking')&&saved.includes('伴奏 テスト.wav'),'saved in the project');
 await page.evaluate(()=>{const b=window.tabStudio.backing;Object.assign(b.settings,{source:'none'});b.sync();});
 await page.waitForFunction(()=>window.tabStudio.backing.label()==='なし');
 await page.evaluate(p=>window.tabStudio.load('Backing.tabstudio',new TextEncoder().encode(p)),saved);await ready();
 await page.waitForFunction(()=>/^(単体で再生|曲と連動)/.test(document.querySelector('#backing-state').textContent),{},{timeout:30000});
 p=await panel();assert.ok(p.settings.offset===offset&&p.settings.source==='file','restored: '+JSON.stringify(p.settings));
 // (The offset is now negative: the recording comes in about 2.5 s after the score starts.)
 await play();assert.equal(await backingPeak(1500),0,'silent before the recording starts');assert.ok(await backingPeak(2000)>.05,'the reopened score plays its backing');await pause();

 // 6b. Editing the score keeps its backing: a note edit, undo, redo and switching tabs neither
 // drop nor reload it (settings live with the Score object, which edits can replace).
 {await page.waitForFunction(()=>window.tabStudio.coreActive(),{},{timeout:30000});
  const watch=await page.evaluateHandle(()=>{const seen=new Set();const t=setInterval(()=>seen.add(document.querySelector('#backing-state').textContent),5);return {seen,stop:()=>clearInterval(t)};});
  const expect=async label=>{const now=await panel();assert.ok(now.settings.source==='file'&&now.settings.offset===offset,`${label}: kept ${JSON.stringify(now.settings)}`);};
  // An offset change just before a note edit, then undo of the edit.
  await page.evaluate(()=>{const b=window.tabStudio.backing;b.settings.offset+=.5;b.sync();});
  await page.evaluate(()=>window.tabStudio.selectNote(0,1));await page.locator('#score-scroll').focus();
  await page.keyboard.press('Delete');await ready();
  const edited=(await panel()).settings.offset;
  await page.keyboard.press('Control+z');await ready();
  // Backing settings are not part of the note history: undoing a note edit keeps the offset.
  assert.equal((await panel()).settings.offset,edited,'undo of a note edit keeps the backing offset');
  await page.evaluate(o=>{const b=window.tabStudio.backing;b.settings.offset=o;b.sync();},offset);
  await page.keyboard.press('Delete');await ready();await expect('note edit');
  await page.keyboard.press('Control+z');await ready();await expect('undo');
  await page.keyboard.press('Control+y');await ready();await expect('redo');
  const seen=await page.evaluate(w=>{w.stop();return [...w.seen];},watch);
  assert.ok(!seen.includes('読み込み中…'),'edits never reload it: '+seen.join(' / '));
  const docs=await page.evaluate(()=>window.tabStudio.getState().documents.map(d=>d.id));
  await page.evaluate(id=>window.tabStudio.activateDocument(id),docs[0]);await ready();
  assert.equal((await panel()).settings.source,'none','the first tab has no backing');
  // Each tab has its own backing: back on this one it comes from the decode cache at once.
  const back=Date.now();await page.evaluate(id=>window.tabStudio.activateDocument(id),docs[1]);
  await page.waitForFunction(()=>/^(単体で再生|曲と連動)/.test(document.querySelector('#backing-state').textContent));
  console.log('backing ready after switching back:',Date.now()-back,'ms');await ready();await expect('tab switch');
  await page.evaluate(()=>window.tabStudio.select(0,0));
  await play();await page.waitForTimeout(2600);assert.ok(await backingPeak(800)>.05,'still sounds after edits and tab switches');await pause();}

 // 7. A missing file: an error with a relink button, and the score still plays.
 await page.evaluate(()=>{const b=window.tabStudio.backing;Object.assign(b.settings,{path:'Z:\\gone\\nothing.mp3',name:'nothing.mp3'});b.sync();});
 await page.waitForFunction(()=>!!document.querySelector('#backing-relink'),{},{timeout:15000});
 p=await panel();assert.match(p.error,/見つかりません/);assert.match(p.label,/^⚠/);
 await page.screenshot({path:path.join(folder,'panel-missing.png')});
 await play();await page.waitForTimeout(500);assert.ok((await state()).playing,'the score plays without its backing');await pause();

 // 8. A real recording (optional): decoded, leveled, played.
 if(real){
  await page.evaluate(file=>{const b=window.tabStudio.backing;Object.assign(b.settings,{source:'file',path:file,name:'real',offset:0});b.sync();},real);
  await page.waitForFunction(()=>/^(単体で再生|曲と連動)/.test(document.querySelector('#backing-state').textContent),{},{timeout:60000});
  console.log('real file:',(await panel()).info,(await page.locator('#backing-normalize-text').textContent()));
  await play();assert.ok(await backingPeak(1000)>.05,'the real file plays');await pause();
  await page.screenshot({path:path.join(folder,'panel-real.png')});
 }

 // 9. YouTube: the official player follows the song position (linked).
 if(!process.env.BACKING_NO_YOUTUBE){
  // Muted (the checks keep the speakers silent); stopped with the cursor in bar 3.
  await page.evaluate(()=>{const b=window.tabStudio.backing;b.settings.mute=true;b.sync();window.tabStudio.select(2,0);});
  await page.locator('[data-source="youtube"]').click();
  await page.locator('#backing-url').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');await page.locator('#backing-url-load').click();
  await page.waitForFunction(()=>!!document.querySelector('#backing-video-player iframe'),{},{timeout:30000});
  // While the song is stopped the video never starts by itself (seekTo plays a cued video).
  const states=await page.evaluate(()=>new Promise(resolve=>{const seen=[];const t=setInterval(()=>{try{seen.push(window.tabStudio.backing.youtube.player?.getPlayerState());}catch{}},50);setTimeout(()=>{clearInterval(t);resolve(seen);},3000);}));
  assert.ok(!states.includes(1)&&!states.includes(3),'stopped: the video stays still: '+[...new Set(states)].join(','));
  await page.evaluate(()=>window.tabStudio.select(0,0));await page.waitForTimeout(300);
  await play();await page.waitForTimeout(5000);
  const drift=await page.locator('#backing-state').textContent();
  console.log('YouTube',drift,JSON.stringify(await page.evaluate(()=>{const b=window.tabStudio.backing,y=b.youtube;let p;try{p=y.player&&{state:y.player.getPlayerState(),time:y.player.getCurrentTime(),rate:y.player.getPlaybackRate()};}catch(e){p=String(e);}return {error:y.error,loaded:y.loaded,player:p,song:b.status&&{position:b.status.position,playing:b.status.playing},settings:{...b.settings}};})));
  const ms=Number(drift.match(/ずれ (-?\d+) ms/)?.[1]);
  assert.ok(Number.isFinite(ms)&&Math.abs(ms)<=250,'the video follows the song: '+drift);
  await page.screenshot({path:path.join(folder,'youtube.png')});
  await pause();await page.waitForTimeout(800);
  const stopped=await page.evaluate(()=>document.querySelector('#backing-state').textContent);
  assert.ok(!stopped.includes('ずれ')&&!(await page.evaluate(()=>window.tabStudio.backing.youtube.playing())),'the video stops with the song: '+stopped);
 }
 // 9b. Space plays the score even right after a click on the YouTube player (its frame would
 // otherwise keep the keyboard).
 if(!process.env.BACKING_NO_YOUTUBE){
  await page.locator('#backing-linked').uncheck();
  const frame=await page.locator('#backing-video-player iframe').boundingBox();
  await page.mouse.click(frame.x+frame.width/2,frame.y+frame.height/2);await page.waitForTimeout(1500);
  const ytBefore=await page.evaluate(()=>window.tabStudio.backing.youtube.playing());
  assert.notEqual(await page.evaluate(()=>document.activeElement?.tagName),'IFRAME','the keyboard is back in the app');
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.tabStudio.getState().playing,{},{timeout:10000});
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(()=>window.tabStudio.backing.youtube.playing()),ytBefore,'Space did not reach the YouTube player');
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.tabStudio.getState().playing);
  await page.evaluate(()=>window.tabStudio.backing.youtube.pause());
  console.log('Space after a click on the video: the score, video playing =',ytBefore);
 }
 // 10. YouTube on its own: ▶ plays the video while the score stays stopped; closing the window
 // stops it (it must stay visible).
 if(!process.env.BACKING_NO_YOUTUBE){
  await page.locator('#backing-linked').uncheck();
  await page.locator('#backing-play').click();
  await page.waitForFunction(()=>window.tabStudio.backing.youtube.playing(),{},{timeout:15000});
  assert.equal((await state()).playing,false,'the score stays stopped');
  await page.waitForTimeout(1500);await page.screenshot({path:path.join(folder,'youtube-own.png')});
  await page.locator('#backing-close').click();await page.waitForTimeout(800);
  assert.equal(await page.evaluate(()=>window.tabStudio.backing.youtube.playing()),false,'closing the window stops the video');
 }
 const errors=logs.filter(l=>!/youtube|googlevideo|doubleclick|ytimg/i.test(l));
 assert.deepEqual(errors,[],'no console errors');
 console.log('OK backing tracks',folder);
}finally{await app.close();}
