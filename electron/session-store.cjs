const fs=require('node:fs/promises');
const path=require('node:path');
class SessionStore{
  constructor(file){this.file=file;this.state={lastFile:null,recentFiles:[],windowState:null};this.pending=Promise.resolve();}
  async initialize(){
    try{const data=JSON.parse(await fs.readFile(this.file,'utf8'));
      this.state.recentFiles=Array.isArray(data.recentFiles)?data.recentFiles.filter(f=>typeof f==='string'&&path.isAbsolute(f)).slice(0,8):[];
      this.state.lastFile=typeof data.lastFile==='string'&&path.isAbsolute(data.lastFile)?data.lastFile:null;
      const size=data.windowState;
      if(size&&Number.isInteger(size.width)&&Number.isInteger(size.height)&&size.width>=320&&size.width<=32000&&size.height>=240&&size.height<=32000)this.state.windowState={width:size.width,height:size.height,maximized:size.maximized===true};
    }catch{}
  }
  recent(){return this.state.recentFiles.map(file=>({path:file,name:path.basename(file)}));}
  async remember(file){const resolved=path.resolve(file);this.state.lastFile=resolved;this.state.recentFiles=[resolved,...this.state.recentFiles.filter(f=>f.toLowerCase()!==resolved.toLowerCase())].slice(0,8);await this.persist();}
  async clearLast(){this.state.lastFile=null;await this.persist();}
  async rememberWindow(size){this.state.windowState=size;await this.persist();}
  persist(){const content=JSON.stringify(this.state);this.pending=this.pending.catch(()=>{}).then(async()=>{await fs.mkdir(path.dirname(this.file),{recursive:true});await fs.writeFile(this.file+'.writing',content,'utf8');await fs.rename(this.file+'.writing',this.file);});return this.pending;}
}
module.exports={SessionStore};
