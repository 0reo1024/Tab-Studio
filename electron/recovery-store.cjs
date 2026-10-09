const fs=require('node:fs/promises');
const path=require('node:path');
const zlib=require('node:zlib');
const {promisify}=require('node:util');
const gunzip=promisify(zlib.gunzip);
/** Unsaved-work recovery, one gzip file per document plus a small manifest.
 * Only documents whose content changed are rewritten; the manifest is written
 * last, so a crash mid-write leaves the previous consistent set readable. */
class RecoveryStore{
 constructor(folder,legacyFile){this.folder=folder;this.legacyFile=legacyFile;this.queue=Promise.resolve();}
 run(task){const next=this.queue.catch(()=>{}).then(task);this.queue=next.catch(()=>{});return next;}
 file(id){return path.join(this.folder,`document-${id}.json.gz`);}
 async atomic(file,data){const temp=file+'.writing';await fs.writeFile(temp,data);await fs.rename(temp,file);}
 async write(payload){
  const {manifest,files,remove}=payload??{};
  if(typeof manifest!=='string'||manifest.length>16*1024*1024||!Array.isArray(files)||!Array.isArray(remove))throw new Error('復旧データが不正です。');
  for(const entry of files)if(!Number.isInteger(entry?.id)||!(entry.bytes instanceof Uint8Array)||entry.bytes.byteLength>512*1024*1024)throw new Error('復旧データが不正です。');
  if(remove.some(id=>!Number.isInteger(id)))throw new Error('復旧データが不正です。');
  return this.run(async()=>{
   await fs.mkdir(this.folder,{recursive:true});
   for(const {id,bytes}of files)await this.atomic(this.file(id),bytes);
   await this.atomic(path.join(this.folder,'manifest.json'),manifest);
   for(const id of remove)await fs.rm(this.file(id),{force:true});
   await fs.rm(this.legacyFile,{force:true});
  });
 }
 /** Returns the same JSON shape the single-file format used, so restore code is shared. */
 read(){return this.run(async()=>{
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(this.folder,'manifest.json'),'utf8'));}catch{try{return await fs.readFile(this.legacyFile,'utf8');}catch{return null;}}
  const documents=[];
  for(const meta of manifest.documents??[]){try{const score=(await gunzip(await fs.readFile(this.file(meta.id)))).toString('utf8');documents.push(JSON.stringify(meta).slice(0,-1)+',"score":'+score+'}');}catch{}}
  if(!documents.length)return null;
  const {documents:ignored,activeDocument,...rest}=manifest;
  const head=JSON.stringify(rest);
  return (head==='{}'?'{':head.slice(0,-1)+',')+'"workspace":{"activeDocument":'+JSON.stringify(activeDocument)+',"documents":['+documents.join(',')+']}}';
 });}
 clear(){return this.run(async()=>{await fs.rm(this.folder,{recursive:true,force:true});await fs.rm(this.legacyFile,{force:true});});}
 /** The single-file format remains readable and writable for older callers. */
 async writeLegacy(json){if(typeof json!=='string'||json.length>512*1024*1024)throw new Error('復旧データが不正です。');return this.run(async()=>{await fs.mkdir(path.dirname(this.legacyFile),{recursive:true});await this.atomic(this.legacyFile,json);await fs.rm(this.folder,{recursive:true,force:true});});}
}
module.exports={RecoveryStore};
