/** Pure helpers for the instrument input panel (src/live-input.ts): timeline geometry,
 * labels and the saved chain. The engine side is src-tauri/src/live_input.rs. */
export type LiveConfig={backend:'wasapi'|'asio';output:string|null;input:string|null;channel:number;buffer:number;inputDb:number;level:number;monitor:boolean;diskMb:number;recordWet:boolean};
export type LiveDevice={backend:'wasapi'|'asio';name:string;inputs:number;outputs:number;sampleRate:number;bufferMin:number;bufferMax:number;defaultInput:boolean;defaultOutput:boolean};
export type LiveStatus={
 enabled:boolean;recording:boolean;backend:string|null;output:string|null;input:string|null;inputChannels:number;buffer:number;fallback:string|null;sampleRate:number;
 inputPeak:number;monitorPeak:number;
 latency:{totalMs:number;driverInMs:number;driverOutMs:number;heldMs:number;pluginsMs:number};
 drops:{overflows:number;underruns:number;trimmed:number;recorder:number;fxLate:number;overloads:number};
 inputCallbacks:number;timeline:{oldest:number;end:number};take:number|null;replay:number|null;error:string|null;deviceLost:string|null;xruns:number;
};
export type LiveOverview={dry:number[];wet:number[];phrases:[number,number][];marks:[number,number,number|null][];rate?:number};
export type LiveTone={input:number;output:number;bass:number;mid:number;treble:number;cabinet:boolean};
export type LivePlugin={path:string;name:string;enabled:boolean;state?:string};
export type LiveChain={nam:{model:string;name:string}|null;tone:LiveTone;plugins:LivePlugin[]};
export const HISTORY_SECONDS=300;
export const defaultTone=():LiveTone=>({input:0,output:-6,bass:0,mid:0,treble:0,cabinet:true});
export const defaultChain=():LiveChain=>({nam:null,tone:defaultTone(),plugins:[]});

/** The saved chain, repaired: unknown fields dropped, numbers clamped. */
export function readChain(raw:string|null):LiveChain{
 const chain=defaultChain();
 try{
  const saved=JSON.parse(raw||'null');if(!saved||typeof saved!=='object')return chain;
  if(saved.nam&&typeof saved.nam.model==='string')chain.nam={model:saved.nam.model,name:String(saved.nam.name??saved.nam.model)};
  const t=saved.tone??{};const num=(v:unknown,lo:number,hi:number,d:number)=>typeof v==='number'&&Number.isFinite(v)?Math.min(hi,Math.max(lo,v)):d;
  chain.tone={input:num(t.input,-24,24,0),output:num(t.output,-40,12,-6),bass:num(t.bass,-12,12,0),mid:num(t.mid,-12,12,0),treble:num(t.treble,-12,12,0),cabinet:t.cabinet!==false};
  if(Array.isArray(saved.plugins))chain.plugins=saved.plugins.filter((p:LivePlugin)=>p&&typeof p.path==='string').slice(0,8).map((p:LivePlugin)=>({path:p.path,name:String(p.name??p.path),enabled:p.enabled!==false,...(typeof p.state==='string'?{state:p.state}:{})}));
 }catch{}
 return chain;
}

/** dBFS of a peak (floor -60). */
export const peakDb=(peak:number)=>peak>0?Math.max(-60,20*Math.log10(peak)):-60;
/** Meter fill 0..1 for -60..0 dBFS. */
export const meterFill=(peak:number)=>(peakDb(peak)+60)/60;

/** "-1:05" style label for seconds before now. */
export function agoLabel(seconds:number){
 const s=Math.max(0,Math.round(seconds));if(s===0)return '今';
 return `-${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}
/** "1:05.3" for a duration. */
export function durationLabel(seconds:number){
 const s=Math.max(0,seconds);return `${Math.floor(s/60)}:${(s%60).toFixed(1).padStart(4,'0')}`;
}

/** The visible window: the last HISTORY_SECONDS ending now (the start is negative while
 * less than that has been recorded). */
export function viewRange(end:number,rate:number):[number,number]{return [end-HISTORY_SECONDS*rate,end];}
/** x (0..width) <-> frame within the view. */
export const frameAt=(x:number,width:number,view:[number,number])=>Math.round(view[0]+(Math.min(width,Math.max(0,x))/Math.max(1,width))*(view[1]-view[0]));
export const xAt=(frame:number,width:number,view:[number,number])=>(frame-view[0])/Math.max(1,view[1]-view[0])*width;

/** A selection made by dragging from a to b, kept inside what is recorded; null when empty. */
export function selection(a:number,b:number,oldest:number,end:number):[number,number]|null{
 const from=Math.max(oldest,Math.min(a,b)),to=Math.min(end,Math.max(a,b));return to-from>0?[from,to]:null;
}

/** The phrase under a frame (double click selects it). */
export const phraseAt=(phrases:[number,number][],frame:number)=>phrases.find(([s,e])=>frame>=s&&frame<e)??null;

/** Where the song was at a frame, from the marks (frame, unixMs, song seconds or null). */
export function songAt(marks:[number,number,number|null][],frame:number,rate:number):number|null{
 let best:[number,number,number|null]|undefined;for(const m of marks){if(m[0]<=frame)best=m;else break;}
 return best&&best[2]!==null?best[2]+(frame-best[0])/rate:null;
}

/** "合計 8.1 ms（入力 2.8 + 出力 4.5 + 待ち 0.7 + プラグイン 0.0）" */
export function latencyLabel(l:LiveStatus['latency']){
 const f=(v:number)=>v.toFixed(1);
 return `合計 ${f(l.totalMs)} ms（入力 ${f(l.driverInMs)} + 出力 ${f(l.driverOutMs)} + 待ち ${f(l.heldMs)}${l.pluginsMs>0?` + プラグイン ${f(l.pluginsMs)}`:''}）`;
}

/** Drops worth showing, as one line ('' when everything kept up). */
export function dropsLabel(d:LiveStatus['drops'],rate:number){
 const parts:string[]=[];const ms=(frames:number)=>`${(frames/rate*1000).toFixed(0)} ms`;
 if(d.overflows)parts.push(`入力のあふれ ${ms(d.overflows)}`);if(d.underruns)parts.push(`入力の不足 ${ms(d.underruns)}`);
 if(d.recorder)parts.push(`録音の取りこぼし ${ms(d.recorder)}`);if(d.fxLate)parts.push(`プラグインの遅れ ${ms(d.fxLate)}`);if(d.overloads)parts.push(`処理落ち ${d.overloads} 回`);
 return parts.join(' · ');
}

/** The NAM knobs the engine gets: the panel's tone plus the model's loudness leveling. */
export const engineTone=(tone:LiveTone,norm:number):LiveTone=>({...tone,output:tone.output+norm});
