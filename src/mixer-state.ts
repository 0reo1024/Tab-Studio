import type {model} from '@coderline/alphatab';

export type NamSettings={enabled:boolean;preset:string;model:string;modelName:string;modelJson?:string;input:number;output:number;bass:number;mid:number;treble:number;cabinet:boolean};
export type FxSettings={id:string;kind:'eq'|'delay'|'compressor'|'external';name:string;enabled:boolean;amount:number;path?:string;state?:string};
export type TrackAudio={sound:{kind:'gm'|'sfz';name:string;path?:string};reverb:boolean;send:number;nam:NamSettings;fx:FxSettings[]};
export type MasterAudio={volume:number;mute:boolean;reverb:boolean};
export type MixerView={height:number;width:number;tracks:number};
export const namPresets=[
 {id:'fender-super',name:'Fender Super Reverb 1965 · Edge of Breakup',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'marshall-jcm800',name:'Marshall JCM800 · V30 1960',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'peavey-5150',name:'Peavey 5150 · 4×12 MESA',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'mesa-rectifier',name:'Mesa Dual Rectifier · Red Modern Full Rig',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'victory-sheriff',name:'Victory VS100 Super Sheriff · Hot Rod',input:0,output:-6,bass:0,mid:0,treble:0}
] as const;
const legacyPresets=[{id:'clean',input:-14,output:0,bass:0,mid:0,treble:1},{id:'edge',input:-5,output:-3,bass:-1,mid:1,treble:0},{id:'crunch',input:3,output:-8,bass:-2,mid:2,treble:-1},{id:'lead',input:9,output:-12,bass:-3,mid:3,treble:-2}];
const tracks=new WeakMap<model.Track,TrackAudio>(),masters=new WeakMap<model.Score,MasterAudio>();
const mixerViews=new WeakMap<model.Score,MixerView>();
const number=(v:unknown,d:number,min:number,max:number)=>typeof v==='number'&&Number.isFinite(v)?Math.max(min,Math.min(max,v)):d;
export function defaultTrackAudio():TrackAudio{return {sound:{kind:'gm',name:'GeneralUser GS'},reverb:false,send:.25,nam:{enabled:false,preset:'fender-super',model:'fender-super',modelName:'Fender Super Reverb 1965 · Edge of Breakup',input:0,output:-6,bass:0,mid:0,treble:0,cabinet:false},fx:[]};}
export function sanitizeTrackAudio(value:any):TrackAudio{
 const d=defaultTrackAudio(),n=value?.nam;
 if(!value||typeof value!=='object')return d;
 if(value.sound?.kind==='sfz'&&typeof value.sound.path==='string')d.sound={kind:'sfz',name:String(value.sound.name||'SFZ').slice(0,120),path:value.sound.path};else if(typeof value.sound?.name==='string')d.sound.name=value.sound.name.slice(0,120);
 d.reverb=value.reverb===true;d.send=number(value.send,.25,0,1);
 if(n&&typeof n==='object')d.nam={enabled:n.enabled===true,preset:typeof n.preset==='string'?n.preset:d.nam.preset,model:typeof n.model==='string'?n.model:d.nam.model,modelName:typeof n.modelName==='string'?n.modelName:d.nam.modelName,modelJson:typeof n.modelJson==='string'&&n.modelJson.length<=8*1024*1024?n.modelJson:undefined,input:number(n.input,d.nam.input,-30,24),output:number(n.output,d.nam.output,-40,12),bass:number(n.bass,0,-12,12),mid:number(n.mid,0,-12,12),treble:number(n.treble,d.nam.treble,-12,12),cabinet:typeof n.cabinet==='boolean'?n.cabinet:d.nam.cabinet};
 if(Array.isArray(value.fx))d.fx=value.fx.slice(0,16).filter((f:any)=>f&&['eq','delay','compressor','external'].includes(f.kind)).map((f:any,i:number)=>({id:typeof f.id==='string'?f.id:`fx-${i}`,kind:f.kind,name:String(f.name||f.kind).slice(0,100),enabled:f.enabled!==false,amount:number(f.amount,.25,0,1),path:typeof f.path==='string'?f.path:undefined,state:typeof f.state==='string'&&f.state.length<4*1024*1024?f.state:undefined}));
 return d;
}
export function trackAudio(t:model.Track){let p=tracks.get(t);if(!p){p=defaultTrackAudio();tracks.set(t,p);}return p;}
export function masterAudio(s:model.Score){let p=masters.get(s);if(!p){p={volume:1,mute:false,reverb:true};masters.set(s,p);}return p;}
/** Zero dimensions follow the content; explicit dimensions belong to this score. */
export function mixerView(s:model.Score){let view=mixerViews.get(s);if(!view){view={height:0,width:0,tracks:s.tracks.length};mixerViews.set(s,view);}return view;}
export function applyNamPreset(n:NamSettings,id:string){const p=namPresets.find(p=>p.id===id);if(p){const {id:preset,name,...values}=p;Object.assign(n,values,{preset,model:preset,modelName:name,modelJson:undefined,enabled:true,cabinet:false});return;}const old=legacyPresets.find(p=>p.id===id);if(!old)throw new Error('NAMプリセットが見つかりません。');const {id:_,...values}=old;Object.assign(n,values,{preset:id,model:'deluxe-a2',modelName:'Deluxe A2',modelJson:undefined,enabled:true,cabinet:true});}

function get(data:any,key:string){return data instanceof Map?data.get(key):data?.[key];}
function put(data:any,key:string,value:any){if(data instanceof Map)data.set(key,value);else data[key]=value;}
/** Keep audio on track records, so reorder/copy/delete naturally preserves it. */
export function attachAudioData(s:model.Score,data:any){const list=get(data,'tracks');if(Array.isArray(list))s.tracks.forEach((t,i)=>{if(list[i]&&tracks.has(t))put(list[i],'studioaudio',structuredClone(tracks.get(t)!));});if(masters.has(s))put(data,'studiomaster',structuredClone(masters.get(s)!));if(mixerViews.has(s))put(data,'studiomixer',structuredClone(mixerViews.get(s)!));return data;}
export function restoreAudioData(s:model.Score,data:any){const list=get(data,'tracks');s.tracks.forEach((t,i)=>{const value=get(list?.[i],'studioaudio');if(value)tracks.set(t,sanitizeTrackAudio(value));});const m=get(data,'studiomaster');if(m)masters.set(s,{volume:number(m.volume,1,0,2),mute:m.mute===true,reverb:m.reverb!==false});const view=get(data,'studiomixer');if(view)mixerViews.set(s,{height:number(view.height,0,0,10000),width:number(view.width,0,0,100000),tracks:Math.round(number(view.tracks,s.tracks.length,1,10000))});return s;}
