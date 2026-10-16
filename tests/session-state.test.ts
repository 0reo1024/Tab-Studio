import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {restoredVisibility,visibilityKey} from '../src/track-visibility';
const {SessionStore}=createRequire(import.meta.url)('../electron/session-store.cjs');
test('track preferences reject stale indices, preserve order and keep one track displayed',()=>{
  assert.deepEqual([...restoredVisibility([2,1,90,-1,'0'],3)],[1,2]);assert.deepEqual([...restoredVisibility([],2)],[0,1]);assert.deepEqual([...restoredVisibility([4],2)],[0,1]);
  assert.equal(visibilityKey('C:\\Scores\\Song.tg'),visibilityKey('c:/scores/song.tg'));assert.notEqual(visibilityKey('/Scores/A.tg'),visibilityKey('/Scores/a.tg'));
});
test('window state persists alongside file history with concurrent writes and survives restart',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'tabstudio-session-')),file=path.join(folder,'session.json'),score=path.join(folder,'song.tg');const store=new SessionStore(file);
  await Promise.all([store.remember(score),store.rememberWindow({width:1280,height:800,maximized:true})]);
  const restored=new SessionStore(file);await restored.initialize();assert.equal(restored.state.lastFile,score);assert.deepEqual(restored.state.windowState,{width:1280,height:800,maximized:true});assert.equal(JSON.parse(await readFile(file,'utf8')).recentFiles.length,1);
  await writeFile(file,JSON.stringify({windowState:{width:-3,height:Infinity},lastFile:score}));const invalid=new SessionStore(file);await invalid.initialize();assert.equal(invalid.state.windowState,null);assert.equal(invalid.state.lastFile,score);
});
test('workspace preserves tab order and active file beyond the recent-file limit',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'tabstudio-tabs-')),file=path.join(folder,'session.json');
 const store=new SessionStore(file),files=Array.from({length:12},(_,i)=>path.join(folder,`song-${i}.tg`));
 await Promise.all([store.rememberWorkspace({files,active:files[7]}),store.remember(files[7]),store.rememberWindow({width:1300,height:900,maximized:false})]);
 const restored=new SessionStore(file);await restored.initialize();assert.deepEqual(restored.workspace(),{files,active:files[7]});assert.equal(restored.state.lastFile,files[7]);
 await restored.rememberWorkspace({files:[files[2],files[0],files[2],'relative.tg',null],active:'missing.tg'});
 assert.deepEqual(restored.workspace(),{files:[files[2],files[0]],active:files[2]});
 await restored.rememberWorkspace({files:[],active:null});await restored.remember(files[3]);
 const empty=new SessionStore(file);await empty.initialize();assert.deepEqual(empty.workspace(),{files:[],active:null});
});
test('legacy sessions migrate only the last file, leaving recent history out of open tabs',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'tabstudio-legacy-')),file=path.join(folder,'session.json'),last=path.join(folder,'last.tg');
 await writeFile(file,JSON.stringify({lastFile:last,recentFiles:[last,path.join(folder,'closed.tg')]}));
 const store=new SessionStore(file);await store.initialize();assert.deepEqual(store.workspace(),{files:[last],active:last});
});
