import type {model} from '@coderline/alphatab';
import {namKind} from './instrument-options';

export type NamSettings={enabled:boolean;preset:string;model:string;modelName:string;/** Guitar or bass amp (bass models play the Bass DI). */kind?:'guitar'|'bass';modelJson?:string;input:number;output:number;bass:number;mid:number;treble:number;cabinet:boolean};
export type FxSettings={id:string;kind:'eq'|'delay'|'compressor'|'external';name:string;enabled:boolean;amount:number;path?:string;state?:string};
export type TrackAudio={sound:{kind:'gm'|'sfz';name:string;path?:string};reverb:boolean;send:number;nam:NamSettings;fx:FxSettings[]};
/** SFZ DIs play at full channel volume (CC7 127, like the click preview), 12 dB above the
 * level NAM settings were made at: the amp input is trimmed back so tones stay the same,
 * and its output follows the DI's rise. */
export const NAM_INPUT_TRIM=-12,NAM_OUTPUT_TRIM=12;
/** Each bundled model's output leveling (dB), measured at the default settings on the same DI
 * phrase (scripts/nam-levels.mjs): every model then plays at its DI's own loudness (guitar
 * -15.9, bass -11.2 LUFS; the bass models re-measured on the Fashionbass Bass DI, leveled to
 * the earlier Growlybass loudness), so turning NAM on keeps a track's level. Models were 21 dB
 * (guitar) and 13 dB (bass) apart unleveled, and 33/34 dB apart with the earlier leveling from the models'
 * loudness metadata, which does not predict their level from a DI. */
export const NAM_MODEL_LEVEL:Readonly<Record<string,number>>={'deluxe-a2':-9.0,'fender-super':1.6,'marshall-jcm800':-7.4,'peavey-5150':-6.2,'mesa-rectifier':-6.2,'victory-sheriff':12.2,'bass-darkglass-b7k':0.3,'bass-fender-rumble':-0.8,'bass-ampeg-svt':7.0,'bass-orange-d200':0.5,'bass-hartke-lh1000':11.6,'bass-ebs':5.5,'bass-gr-cube800':5.7,'bass-eko-super-duke':6.4,'bass-ampeg-portaflex':-1.5};
/** Imported models: the median leveling of their kind (closer than the metadata on held-out models). */
export const NAM_IMPORTED_LEVEL={guitar:-6.2,bass:5.5} as const;
/** The output leveling (dB) the engine adds for a model: a track's NAM and the instrument input
 * alike. A track's imported model (its JSON in the song) is never a bundled one. */
export function namOutputLevel(n:{model:string;kind?:'guitar'|'bass';modelJson?:string}):number{return !n.modelJson&&Object.hasOwn(NAM_MODEL_LEVEL,n.model)?NAM_MODEL_LEVEL[n.model]:NAM_IMPORTED_LEVEL[namKind(n)];}
export type MasterAudio={volume:number;mute:boolean;reverb:boolean};
/** The score's backing track: an audio file played by the engine, or a YouTube video kept in
 * step with it. offset: seconds of the recording where the score starts (negative: the
 * recording starts later); rate: the recording's tempo against the score (fine trim). */
export type BackingSettings={source:'none'|'file'|'youtube';path?:string;name?:string;videoId?:string;title?:string;offset:number;gain:number;mute:boolean;solo:boolean;semitones:number;rate:number;normalize:boolean;/** Plays with the score (offset/rate apply); otherwise on its own. */linked:boolean;/** Its own playback speed. */speed:number};
export type MixerView={height:number;width:number;tracks:number};
export const namPresets=[
 {id:'fender-super',name:'Fender Super Reverb 1965 · Edge of Breakup',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'marshall-jcm800',name:'Marshall JCM800 · V30 1960',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'peavey-5150',name:'Peavey 5150 · 4×12 MESA',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'mesa-rectifier',name:'Mesa Dual Rectifier · Red Modern Full Rig',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'victory-sheriff',name:'Victory VS100 Super Sheriff · Hot Rod',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'bass-darkglass-b7k',name:'Darkglass B7K Ultra · Aguilar DB 751 / DG412',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'bass-fender-rumble',name:'Fender Rumble 800 · 2×10 (City Pop)',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'bass-ampeg-svt',name:'Ampeg SVT Classic · 6×10 MD 421',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'bass-orange-d200',name:'Orange D200 · 4×10',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'bass-hartke-lh1000',name:'Hartke LH1000 · GK 4×10 Clean',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'bass-ebs',name:'EBS · Punchy Clean',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'bass-gr-cube800',name:'GR Bass NF Cube800',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'bass-eko-super-duke',name:'Eko Super Duke · Harley Benton G212',input:0,output:-6,bass:0,mid:0,treble:0},
 {id:'bass-ampeg-portaflex',name:'Ampeg Portaflex SB-12 · Timmy (Black Keys)',input:0,output:-6,bass:0,mid:0,treble:0}
] as const;
const legacyPresets=[{id:'clean',input:-14,output:0,bass:0,mid:0,treble:1},{id:'edge',input:-5,output:-3,bass:-1,mid:1,treble:0},{id:'crunch',input:3,output:-8,bass:-2,mid:2,treble:-1},{id:'lead',input:9,output:-12,bass:-3,mid:3,treble:-2}];
const tracks=new WeakMap<model.Track,TrackAudio>(),masters=new WeakMap<model.Score,MasterAudio>();
const mixerViews=new WeakMap<model.Score,MixerView>(),backings=new WeakMap<model.Score,BackingSettings>();
const number=(v:unknown,d:number,min:number,max:number)=>typeof v==='number'&&Number.isFinite(v)?Math.max(min,Math.min(max,v)):d;
export function defaultTrackAudio():TrackAudio{return {sound:{kind:'gm',name:'GeneralUser GS'},reverb:false,send:.25,nam:{enabled:false,preset:'fender-super',model:'fender-super',modelName:'Fender Super Reverb 1965 · Edge of Breakup',input:0,output:-6,bass:0,mid:0,treble:0,cabinet:false},fx:[]};}
export function sanitizeTrackAudio(value:any):TrackAudio{
 const d=defaultTrackAudio(),n=value?.nam;
 if(!value||typeof value!=='object')return d;
 if(value.sound?.kind==='sfz'&&typeof value.sound.path==='string')d.sound={kind:'sfz',name:String(value.sound.name||'SFZ').slice(0,120),path:value.sound.path};else if(typeof value.sound?.name==='string')d.sound.name=value.sound.name.slice(0,120);
 d.reverb=value.reverb===true;d.send=number(value.send,.25,0,1);
 if(n&&typeof n==='object')d.nam={enabled:n.enabled===true,preset:typeof n.preset==='string'?n.preset:d.nam.preset,model:typeof n.model==='string'?n.model:d.nam.model,modelName:typeof n.modelName==='string'?n.modelName:d.nam.modelName,...(n.kind==='bass'||n.kind==='guitar'?{kind:n.kind}:{}),modelJson:typeof n.modelJson==='string'&&n.modelJson.length<=8*1024*1024?n.modelJson:undefined,input:number(n.input,d.nam.input,-30,24),output:number(n.output,d.nam.output,-40,12),bass:number(n.bass,0,-12,12),mid:number(n.mid,0,-12,12),treble:number(n.treble,d.nam.treble,-12,12),cabinet:typeof n.cabinet==='boolean'?n.cabinet:d.nam.cabinet};
 if(Array.isArray(value.fx))d.fx=value.fx.slice(0,16).filter((f:any)=>f&&['eq','delay','compressor','external'].includes(f.kind)).map((f:any,i:number)=>({id:typeof f.id==='string'?f.id:`fx-${i}`,kind:f.kind,name:String(f.name||f.kind).slice(0,100),enabled:f.enabled!==false,amount:number(f.amount,.25,0,1),path:typeof f.path==='string'?f.path:undefined,state:typeof f.state==='string'&&f.state.length<4*1024*1024?f.state:undefined}));
 return d;
}
export function trackAudio(t:model.Track){let p=tracks.get(t);if(!p){p=defaultTrackAudio();tracks.set(t,p);}return p;}
export function masterAudio(s:model.Score){let p=masters.get(s);if(!p){p={volume:1,mute:false,reverb:true};masters.set(s,p);}return p;}
/** Zero dimensions follow the content; explicit dimensions belong to this score. */
export function mixerView(s:model.Score){let view=mixerViews.get(s);if(!view){view={height:0,width:0,tracks:s.tracks.length};mixerViews.set(s,view);}return view;}
export function defaultBacking():BackingSettings{return {source:'none',offset:0,gain:1,mute:false,solo:false,semitones:0,rate:1,normalize:true,linked:false,speed:1};}
export function sanitizeBacking(value:any):BackingSettings{
 const d=defaultBacking();if(!value||typeof value!=='object')return d;
 const text=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max?v:undefined;
 const videoId=typeof value.videoId==='string'&&/^[\w-]{11}$/.test(value.videoId)?value.videoId:undefined;
 const optional=Object.fromEntries(Object.entries({path:text(value.path,4096),name:text(value.name,300),videoId,title:text(value.title,300)}).filter(e=>e[1]!==undefined));
 return {source:value.source==='file'&&text(value.path,4096)?'file':value.source==='youtube'&&videoId?'youtube':'none',...optional,offset:number(value.offset,0,-3600,3600),gain:number(value.gain,1,0,2),mute:value.mute===true,solo:value.solo===true,semitones:Math.round(number(value.semitones,0,-12,12)),rate:number(value.rate,1,.8,1.25),normalize:value.normalize!==false,linked:value.linked===true,speed:number(value.speed,1,.25,2)};
}
export function backingAudio(s:model.Score){let p=backings.get(s);if(!p){p=defaultBacking();backings.set(s,p);}return p;}
export function applyNamPreset(n:NamSettings,id:string){const p=namPresets.find(p=>p.id===id);if(p){const {id:preset,name,...values}=p;Object.assign(n,values,{preset,model:preset,modelName:name,modelJson:undefined,enabled:true,cabinet:false,kind:preset.startsWith('bass-')?'bass':'guitar'});return;}const old=legacyPresets.find(p=>p.id===id);if(!old)throw new Error('NAMプリセットが見つかりません。');const {id:_,...values}=old;Object.assign(n,values,{preset:id,model:'deluxe-a2',modelName:'Deluxe A2',modelJson:undefined,enabled:true,cabinet:true,kind:'guitar'});}

function get(data:any,key:string){return data instanceof Map?data.get(key):data?.[key];}
function put(data:any,key:string,value:any){if(data instanceof Map)data.set(key,value);else data[key]=value;}
/** Keep audio on track records, so reorder/copy/delete naturally preserves it. */
export function attachAudioData(s:model.Score,data:any){const list=get(data,'tracks');if(Array.isArray(list))s.tracks.forEach((t,i)=>{if(list[i]&&tracks.has(t))put(list[i],'studioaudio',structuredClone(tracks.get(t)!));});if(masters.has(s))put(data,'studiomaster',structuredClone(masters.get(s)!));if(mixerViews.has(s))put(data,'studiomixer',structuredClone(mixerViews.get(s)!));if(backings.has(s))put(data,'studiobacking',structuredClone(backings.get(s)!));return data;}
export function restoreAudioData(s:model.Score,data:any){const list=get(data,'tracks');s.tracks.forEach((t,i)=>{const value=get(list?.[i],'studioaudio');if(value)tracks.set(t,sanitizeTrackAudio(value));});const m=get(data,'studiomaster');if(m)masters.set(s,{volume:number(m.volume,1,0,2),mute:m.mute===true,reverb:m.reverb!==false});const view=get(data,'studiomixer');if(view)mixerViews.set(s,{height:number(view.height,0,0,10000),width:number(view.width,0,0,100000),tracks:Math.round(number(view.tracks,s.tracks.length,1,10000))});const backing=get(data,'studiobacking');if(backing)backings.set(s,sanitizeBacking(backing instanceof Map?Object.fromEntries(backing):backing));return s;}
