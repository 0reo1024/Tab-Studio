import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {gzipSync} from 'fflate';
const {RecoveryStore}=createRequire(import.meta.url)('../electron/recovery-store.cjs');
const pack=(value:unknown)=>gzipSync(new TextEncoder().encode(JSON.stringify(value)),{level:1});
const manifest=(documents:{id:number;dirty:boolean}[],activeDocument=documents[0].id)=>JSON.stringify({format:'TabStudio',version:1,sourceName:'a.tg',warnings:[],activeDocument,documents});
test('per-document recovery rewrites only changed documents and reads back the workspace shape',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tabstudio-recovery-')),store=new RecoveryStore(path.join(root,'recovery'),path.join(root,'recovery.json'));
 try{
  assert.equal(await store.read(),null);
  await store.write({manifest:manifest([{id:1,dirty:true},{id:2,dirty:false}]),files:[{id:1,bytes:pack({title:'one'})},{id:2,bytes:pack({title:'two'})}],remove:[]});
  let raw=JSON.parse(await store.read());assert.equal(raw.format,'TabStudio');assert.equal(raw.workspace.activeDocument,1);assert.deepEqual(raw.workspace.documents.map((d:any)=>[d.id,d.dirty,d.score.title]),[[1,true,'one'],[2,false,'two']]);
  const before=(await fs.stat(path.join(root,'recovery','document-2.json.gz'))).mtimeMs;
  await store.write({manifest:manifest([{id:1,dirty:true},{id:2,dirty:true}],2),files:[{id:1,bytes:pack({title:'one edited'})}],remove:[]});
  raw=JSON.parse(await store.read());assert.equal(raw.workspace.activeDocument,2);assert.deepEqual(raw.workspace.documents.map((d:any)=>d.score.title),['one edited','two']);
  assert.equal((await fs.stat(path.join(root,'recovery','document-2.json.gz'))).mtimeMs,before,'unchanged document is not rewritten');
  await store.write({manifest:manifest([{id:2,dirty:true}]),files:[],remove:[1]});
  raw=JSON.parse(await store.read());assert.deepEqual(raw.workspace.documents.map((d:any)=>d.id),[2]);await assert.rejects(fs.stat(path.join(root,'recovery','document-1.json.gz')));
  await assert.rejects(()=>store.write({manifest:1,files:[],remove:[]}),/不正/);
  await store.clear();assert.equal(await store.read(),null);
  // The previous single-file format is still restored and replaced by the next write.
  await fs.writeFile(path.join(root,'recovery.json'),'{"legacy":true}');assert.equal(await store.read(),'{"legacy":true}');
  await store.write({manifest:manifest([{id:3,dirty:true}]),files:[{id:3,bytes:pack({title:'three'})}],remove:[]});await assert.rejects(fs.stat(path.join(root,'recovery.json')));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
