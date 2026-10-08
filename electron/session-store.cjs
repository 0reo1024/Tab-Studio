const fs=require('node:fs/promises');
const path=require('node:path');
class SessionStore{
  constructor(file){this.file=file;this.state={lastFile:null,recentFiles:[],windowState:null,workspace:null};this.pending=Promise.resolve();}
  async initialize(){
    try{const data=JSON.parse(await fs.readFile(this.file,'utf8'));
      this.state.recentFiles=Array.isArray(data.recentFiles)?data.recentFiles.filter(f=>typeof f==='string'&&path.isAbsolute(f)).slice(0,8):[];
      this.state.lastFile=typeof data.lastFile==='string'&&path.isAbsolute(data.lastFile)?data.lastFile:null;
      this.state.workspace=data.workspace?this.normalizeWorkspace(data.workspace):null;
      const size=data.windowState;
      if(size&&Number.isInteger(size.width)&&Number.isInteger(size.height)&&size.width>=320&&size.width<=32000&&size.height>=240&&size.height<=32000)this.state.windowState={width:size.width,height:size.height,maximized:size.maximized===true};
    }catch{}
  }
  recent(){return this.state.recentFiles.map(file=>({path:file,name:path.basename(file)}));}
  normalizeWorkspace(value){
    const files=[],seen=new Set();
    for(const file of Array.isArray(value?.files)?value.files:[]){
      if(typeof file!=='string'||!path.isAbsolute(file)||file.length>32768)continue;
      const resolved=path.resolve(file),key=process.platform==='win32'?resolved.toLowerCase():resolved;
      if(!seen.has(key)){seen.add(key);files.push(resolved);}
    }
    const active=typeof value?.active==='string'?files.find(file=>process.platform==='win32'?file.toLowerCase()===value.active.toLowerCase():file===value.active):null;
    return {files,active:active||files[0]||null};
  }
  workspace(){return this.state.workspace??this.normalizeWorkspace({files:this.state.lastFile?[this.state.lastFile]:[],active:this.state.lastFile});}
  async rememberWorkspace(value){const next=this.normalizeWorkspace(value);if(JSON.stringify(next)===JSON.stringify(this.state.workspace))return;this.state.workspace=next;await this.persist();}
  async remember(file){const resolved=path.resolve(file);this.state.lastFile=resolved;this.state.recentFiles=[resolved,...this.state.recentFiles.filter(f=>f.toLowerCase()!==resolved.toLowerCase())].slice(0,8);await this.persist();}
  async clearLast(){this.state.lastFile=null;await this.persist();}
  async rememberWindow(size){this.state.windowState=size;await this.persist();}
  persist(){const content=JSON.stringify(this.state);this.pending=this.pending.catch(()=>{}).then(async()=>{await fs.mkdir(path.dirname(this.file),{recursive:true});await fs.writeFile(this.file+'.writing',content,'utf8');await fs.rename(this.file+'.writing',this.file);});return this.pending;}
}
module.exports={SessionStore};
