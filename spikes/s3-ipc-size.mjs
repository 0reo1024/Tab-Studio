// Spike S3: find where large binary IPC transfers break, each direction separately.
import fs from 'node:fs/promises';import path from 'node:path';
import {launchTauri} from '../scripts/tauri-app.mjs';
const folder=path.resolve('test-results/s3-'+Date.now());await fs.mkdir(folder,{recursive:true});
const app=await launchTauri({dataDir:path.join(folder,'data')});
const {page}=app;
await page.waitForFunction(()=>!!window.desktop,{},{timeout:30000});
for(const mb of (process.env.SIZES||"1,4,8,16,24,32,38").split(",").map(Number)){
 const file=path.join(folder,`f${mb}.tg`);const b=Buffer.alloc(mb*1024*1024,7);b.write('PK',0);await fs.writeFile(file,b);
 try{
  const r=await page.evaluate(async file=>{let t=performance.now();const f=await window.desktop.openFilePath(file);const read=performance.now()-t;await window.desktop.acceptOpen(f.openToken);return {n:f.bytes.byteLength,read:Math.round(read)};},file);
  console.log(mb,'MB read',r.read,'ms');
  const w=await page.evaluate(async([file,mb])=>{const bytes=new Uint8Array(mb*1024*1024).fill(7);bytes[0]=80;bytes[1]=75;const t=performance.now();await window.desktop.saveScore({name:'x',bytes,path:file});return Math.round(performance.now()-t);},[file,mb]);
  console.log(mb,'MB write',w,'ms');
 }catch(e){console.log(mb,'MB FAILED',e.message.split('\n')[0]);break;}
}
await app.close();
