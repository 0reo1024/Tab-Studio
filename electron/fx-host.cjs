const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const readline=require('node:readline');

class FxHost {
 constructor(base){this.base=base;this.plugins=new Map();this.instances=new Map();this.counter=0;}
 async scan(extra=[]){
  const roots=process.platform==='darwin'?['/Library/Audio/Plug-Ins/VST3','/Library/Audio/Plug-Ins/Components',path.join(process.env.HOME||'','Library/Audio/Plug-Ins/VST3'),path.join(process.env.HOME||'','Library/Audio/Plug-Ins/Components')]:[path.join(process.env.CommonProgramFiles||'C:/Program Files/Common Files','VST3')];
  const found=[];const visited=new Set();
  const walk=async(dir,depth=0)=>{if(depth>5||found.length>2000)return;let real;try{real=await fs.realpath(dir);}catch{return;}if(visited.has(real))return;visited.add(real);let entries;try{entries=await fs.readdir(real,{withFileTypes:true});}catch{return;}for(const entry of entries){const file=path.join(real,entry.name);if(/\.(vst3|component)$/i.test(entry.name)){found.push({path:file,name:entry.name.replace(/\.(vst3|component)$/i,''),format:entry.name.endsWith('.component')?'AU':'VST3'});}else if(entry.isDirectory()&&!entry.isSymbolicLink())await walk(file,depth+1);}};
  for(const root of [...roots,...extra])await walk(root);
  for(const p of found)this.plugins.set(p.path,p);return found.sort((a,b)=>a.name.localeCompare(b.name));
 }
 async load(file,state,sampler=false,lanes=[],pitches={}){
  if(sampler){if(!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.sfz'||!(await fs.stat(file)).isFile())throw new Error('SFZ音源を選択してください。');}
  else if(!this.plugins.has(file))throw new Error('プラグイン一覧から選択してください。');
  const python=path.join(this.base,'runtime',process.platform==='win32'?'python.exe':'bin/python3');
  const child=spawn(python,[path.join(this.base,sampler?'sfz-host.py':'fx-host.py'),file,...(sampler?[JSON.stringify(lanes),JSON.stringify(pitches)]:[])],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const id=String(++this.counter),pending=new Map();let request=0,backpressured=false;
  child.stdin.on('drain',()=>{backpressured=false;});
  const ask=(cmd,args={},timeout=10000)=>new Promise((resolve,reject)=>{
   if(cmd==='process'&&(backpressured||[...pending.values()].filter(p=>p.cmd==='process').length>=24)){reject(new Error('外部FXの処理が追いつきません。'));return;}
   const n=++request;const timer=timeout?setTimeout(()=>{pending.delete(n);reject(new Error('プラグイン応答がタイムアウトしました。'));},timeout):null;
   pending.set(n,{resolve,reject,timer,cmd});try{if(!child.stdin.write(JSON.stringify({id:n,cmd,...args})+'\n'))backpressured=true;}catch(error){pending.delete(n);clearTimeout(timer);reject(error);}
  });
  let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});const readyTimer=setTimeout(()=>readyReject(new Error('音源・プラグインの読み込みがタイムアウトしました。')),sampler?120000:20000);
  const fail=error=>{readyReject(error);for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();this.instances.delete(id);};
  child.on('error',fail);child.on('exit',code=>fail(new Error(`FXホストが終了しました (${code})`)));child.stderr.on('data',()=>{});
  readline.createInterface({input:child.stdout}).on('line',line=>{if(!line.startsWith('TABSTUDIO:'))return;let d;try{d=JSON.parse(line.slice(10));}catch{return;}if(d.id===0){d.error?readyReject(new Error(d.error)):readyResolve(d);return;}const p=pending.get(d.id);if(!p)return;pending.delete(d.id);clearTimeout(p.timer);d.error?p.reject(new Error(d.error)):p.resolve(d);});
  this.instances.set(id,{child,ask});
  try{const result=await ready;clearTimeout(readyTimer);if(state)await ask('restore',{state});return {id,name:result.name};}catch(error){clearTimeout(readyTimer);child.kill();throw error;}
 }
 async command(id,cmd,args={}){const instance=this.instances.get(id);if(!instance)throw new Error('FXが読み込まれていません。');if(cmd==='editor'){if(instance.editor)return instance.editor;const opening=instance.ask(cmd,args,0);instance.editor=opening;try{return await opening;}finally{if(instance.editor===opening)instance.editor=undefined;}}return instance.ask(cmd,args,10000);}
 async process(id,pcm,rate){if(!(pcm instanceof Uint8Array)||pcm.length>1024*1024||pcm.length%8||!Number.isFinite(rate)||rate<22050||rate>192000)throw new Error('音声ブロックが不正です。');const result=await this.command(id,'process',{pcm:Buffer.from(pcm).toString('base64'),rate});return new Uint8Array(Buffer.from(result.pcm,'base64'));}
 close(id){const instance=this.instances.get(id);if(instance){instance.child.kill();this.instances.delete(id);}}
 stats(){return [...this.instances.entries()].map(([id,instance])=>({id,pid:instance.child.pid}));}
 destroy(){for(const id of this.instances.keys())this.close(id);}
}
module.exports={FxHost};
