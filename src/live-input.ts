import './live-input.css';
import type {EngineHost,NativeEngine} from './audio/native-engine';
import type {NativeFxAPI,NativePlugin} from './platform/bridge';
import {joinFrame} from './platform/frame';
import {readNamLibrary,type NamModel} from './nam-library';
import {namOutputLevel} from './mixer-state';
import {type LiveChain,type LiveConfig,type LiveDevice,type LiveOverview,type LiveStatus,HISTORY_SECONDS,agoLabel,defaultTone,dropsLabel,durationLabel,engineTone,frameAt,latencyLabel,meterFill,peakDb,phraseAt,readChain,selection,songAt,viewRange,xAt} from './live-input-model';

/** The instrument input panel (Tauri, native engine): device and channel, meters, the
 * monitor chain (NAM amp + VST3 plugins), the last five minutes as a timeline to listen
 * back to, and takes. Engine side: src-tauri/src/live_input.rs. */
type Options={
 engine:NativeEngine;host:EngineHost;fx:NativeFxAPI|undefined;
 namModel:(id:string)=>Promise<string>;
 /** The "liveRecording" setting. */
 recording:()=>boolean;
 /** The score's own transport (so its cursor and play button follow): stop it (resolves
  * once the engine has stopped), and start it from a tick. */
 song:{pause:()=>Promise<void>;play:(tick:number)=>void};
 message:(text:string)=>void;
};
const CHAIN_KEY='tabstudio-live-chain',ON_KEY='tabstudio-live-on';
const store={get:(k:string)=>{try{return localStorage.getItem(k);}catch{return null;}},set:(k:string,v:string|null)=>{try{if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v);}catch{}}};
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);

export class LiveInputPanel{
 private dialog:HTMLDialogElement;private pill:HTMLButtonElement;
 private config:LiveConfig|undefined;private devices:LiveDevice[]=[];private asio=false;
 private status:LiveStatus|undefined;private overview:LiveOverview|undefined;private drawn:[number,number]=[0,0];
 private chain:LiveChain=readChain(store.get(CHAIN_KEY));private ids=new Map<number,string>();private norm=0;
 private models:NamModel[]=[];private plugins:NativePlugin[]=[];
 private selected:[number,number]|null=null;private drag:{from:number;x:number}|null=null;
 private timers:number[]=[];private background=0;private busy=false;private songPlaying=false;
 constructor(private o:Options){
  this.dialog=document.createElement('dialog');this.dialog.id='live-input';this.dialog.className='live-input';this.dialog.setAttribute('aria-labelledby','live-title');
  this.dialog.innerHTML=`<header><h2 id="live-title">楽器入力</h2><span class="live-rec" id="live-rec"></span><button type="button" class="live-close" id="live-close" aria-label="閉じる">×</button></header>
<div class="live-body">
<section class="live-device"><span class="asio-notice live-asio" title="ASIO is a registered trademark of Steinberg Media Technologies GmbH."><img src="asio/asio-compatible.svg" alt="ASIO Compatible" width="40" height="37"><small>ASIO is a registered trademark of<br>Steinberg Media Technologies GmbH.</small></span><label>方式<select id="live-backend"><option value="asio">ASIO</option><option value="wasapi">WASAPI（共有）</option></select></label>
<label>出力 / ドライバ<select id="live-output"></select></label><label id="live-input-row">入力デバイス<select id="live-input-device"></select></label>
<label>入力チャンネル<select id="live-channel"></select></label><label id="live-buffer-row">バッファ<select id="live-buffer"></select></label>
<button type="button" id="live-toggle" class="primary">入力をオン</button></section>
<p class="live-note" id="live-note"></p>
<section class="live-levels"><div class="live-meter" title="入力レベル"><span>入力</span><meter id="live-in-meter" min="0" max="1" low="0.7" high="0.9" optimum="0.5"></meter><output id="live-in-db">-∞</output></div>
<label>入力ゲイン<input id="live-gain" type="range" min="-20" max="30" step="0.5"><output id="live-gain-out"></output></label>
<label class="live-check"><input id="live-monitor" type="checkbox">モニタ</label><label>音量<input id="live-level" type="range" min="0" max="1.5" step="0.01"></label>
<div class="live-meter" title="モニタ出力"><span>出力</span><meter id="live-out-meter" min="0" max="1" low="0.7" high="0.9" optimum="0.5"></meter></div></section>
<div class="live-latency-row"><p class="live-latency" id="live-latency"></p><button type="button" id="live-ping" title="出力から入力へケーブルをつなぐと、実際の往復遅延を測れます。大きめのクリック音が1回鳴ります。">遅延を実測…</button><output id="live-ping-out"></output></div>
<section class="live-chain"><div class="live-amp"><label>アンプ（NAM）<select id="live-nam"></select></label>
<label>Bass<input id="live-bass" type="range" min="-12" max="12" step="0.5"></label><label>Mid<input id="live-mid" type="range" min="-12" max="12" step="0.5"></label><label>Treble<input id="live-treble" type="range" min="-12" max="12" step="0.5"></label><label>Out<input id="live-out" type="range" min="-30" max="12" step="0.5"></label><label class="live-check"><input id="live-cab" type="checkbox">キャビネット</label></div>
<div class="live-plugins"><span>プラグイン</span><ol id="live-plugin-list"></ol><select id="live-plugin-add"><option value="">＋ VST3 を追加…</option></select></div></section>
<section class="live-timeline"><div class="live-timeline-head"><strong>直近5分</strong><span id="live-sel"></span><label class="live-check" title="オフにするとDI（素の音）だけを録音します"><input id="live-wet" type="checkbox">聴いた音も録音</label></div>
<canvas id="live-canvas" height="120" aria-label="直近5分の波形。ドラッグで範囲を選択、クリックでそこから再生、ダブルクリックでフレーズを選択"></canvas>
<div class="live-transport"><button type="button" id="live-play">▶ 再生</button><button type="button" id="live-stop">■ 停止</button><label class="live-check"><input id="live-loop" type="checkbox">ループ</label>
<label>音<select id="live-source"><option value="wet">聴いた音</option><option value="dry">DI（素の音）</option><option value="reamp">DIを今のアンプで</option></select></label><label class="live-check" title="録音したとき譜面を再生していた位置から、譜面も一緒に鳴らします"><input id="live-song" type="checkbox">譜面も一緒に</label>
<span class="live-spacer"></span><button type="button" id="live-save">選択範囲を保存</button><select id="live-back"><option value="30">30秒前から</option><option value="60" selected>1分前から</option><option value="120">2分前から</option><option value="300">5分前から</option></select><button type="button" id="live-take">保存を開始</button><button type="button" id="live-folder">保存フォルダ</button></div></section>
<details class="live-takes" id="live-takes"><summary>保存したテイク</summary><ul id="live-take-list"></ul></details>
</div>`;
  document.body.append(this.dialog);
  this.pill=document.createElement('button');this.pill.type='button';this.pill.className='live-pill';this.pill.hidden=true;this.pill.title='楽器入力を開く';this.pill.onclick=()=>this.open();document.body.append(this.pill);
  this.wire();
 }
 private $<T extends HTMLElement=HTMLElement>(id:string){return this.dialog.querySelector<T>('#'+id)!;}
 private invoke<T>(command:string,args?:Record<string,unknown>){return this.o.host.invoke<T>(command,args);}
 private fail(e:unknown){const text=e instanceof Error?e.message:String(e);this.$('live-note').textContent=text;this.o.message(`楽器入力：${text}`);}
 private run(task:()=>Promise<unknown>){void task().catch(e=>this.fail(e));}

 /** Opens the panel (starting the engine and reading the devices). */
 open(){
  if(!this.dialog.open)this.dialog.show();
  this.run(async()=>{await this.o.engine.start();await this.loadDevices();await this.loadModels();this.renderChain();this.startPolling();void this.refreshTakes();});
 }
 close(){this.dialog.close();this.stopPolling();this.updatePill();}
 /** At startup: turn the input back on if it was on when the app closed. */
 restore(){if(store.get(ON_KEY)==='1')this.run(async()=>{await this.o.engine.start();await this.loadDevices();await this.setEnabled(true);});}
 /** The "liveRecording" setting changed. */
 setRecording(on:boolean){this.run(()=>this.invoke('live_recording',{on}));}

 private async loadDevices(){
  const r=await this.invoke<{devices:LiveDevice[];asio:boolean;config:LiveConfig}>('live_devices');this.devices=r.devices;this.asio=r.asio;this.config=r.config;
  if(!this.asio&&this.config.backend==='asio')this.config.backend='wasapi';
  this.renderDevice();
 }
 private async loadModels(){try{this.models=(await readNamLibrary()).models;}catch{this.models=[];}}
 private renderDevice(){
  const c=this.config;if(!c)return;const backend=this.$<HTMLSelectElement>('live-backend');backend.value=c.backend;backend.querySelector<HTMLOptionElement>('option[value=asio]')!.disabled=!this.asio;
  const mine=this.devices.filter(d=>d.backend===c.backend);
  const outputs=mine.filter(d=>d.outputs>0),inputs=mine.filter(d=>d.inputs>0);
  const opts=(list:LiveDevice[],current:string|null,def:string)=>`<option value="">${def}</option>`+list.map(d=>`<option value="${esc(d.name)}"${d.name===current?' selected':''}>${esc(d.name)}</option>`).join('');
  this.$('live-output').innerHTML=opts(outputs,c.output,c.backend==='asio'?'（最初のドライバ）':'既定の出力');
  this.$('live-input-device').innerHTML=opts(inputs,c.input,'既定の入力');
  this.$('live-input-row').hidden=c.backend==='asio';this.$('live-buffer-row').hidden=c.backend!=='asio';
  const device=c.backend==='asio'?outputs.find(d=>d.name===c.output)??outputs[0]:inputs.find(d=>d.name===c.input)??inputs.find(d=>d.defaultInput)??inputs[0];
  const channels=Math.max(1,device?.inputs??this.status?.inputChannels??2);
  this.$('live-channel').innerHTML=Array.from({length:channels},(_,i)=>`<option value="${i}"${i===c.channel?' selected':''}>${i+1}</option>`).join('');
  const lo=Math.max(16,device?.bufferMin??32),hi=Math.min(2048,device?.bufferMax??1024);
  const sizes=[32,48,64,96,128,192,256,384,512,1024].filter(n=>n>=lo&&n<=hi);if(!sizes.includes(c.buffer))sizes.push(c.buffer);sizes.sort((a,b)=>a-b);
  this.$('live-buffer').innerHTML=sizes.map(n=>`<option value="${n}"${n===c.buffer?' selected':''}>${n}（${(n/48).toFixed(1)} ms）</option>`).join('');
  this.$<HTMLInputElement>('live-gain').value=String(c.inputDb);this.$('live-gain-out').textContent=`${c.inputDb>0?'+':''}${c.inputDb} dB`;
  this.$<HTMLInputElement>('live-monitor').checked=c.monitor;this.$<HTMLInputElement>('live-wet').checked=c.recordWet!==false;this.$<HTMLInputElement>('live-level').value=String(c.level);
  this.$('live-note').textContent=c.backend==='wasapi'?'WASAPI（共有）は遅延が大きめです（約40 ms）。練習にはASIOをおすすめします。':'';
 }
 private async configure(next:Partial<LiveConfig>){
  if(!this.config)return;const before=this.config;this.config={...before,...next};
  try{await this.invoke('live_configure',{config:this.config});}catch(e){this.fail(e);}
  this.renderDevice();
 }
 private async setEnabled(on:boolean){
  if(this.busy)return;this.busy=true;const button=this.$<HTMLButtonElement>('live-toggle');button.disabled=true;
  try{
   if(on&&this.config)await this.invoke('live_configure',{config:this.config});
   this.status=await this.invoke<LiveStatus>('live_enable',{on,recording:this.o.recording()});
   store.set(ON_KEY,on?'1':null);
   if(on)await this.applyChain();
   this.$('live-note').textContent=this.status.fallback?`設定したデバイスを開けなかったため既定の出力を使っています：${this.status.fallback}`:'';
  }finally{this.busy=false;button.disabled=false;this.render();this.updatePill();}
  if(on&&!this.dialog.open)this.startBackground();
 }

 // The monitor chain.
 private renderChain(){
  const c=this.chain,nam=this.$<HTMLSelectElement>('live-nam');
  nam.innerHTML='<option value="">なし</option>'+this.models.map(m=>`<option value="${esc(m.id)}"${m.id===c.nam?.model?' selected':''}>${esc(m.name)}</option>`).join('');
  if(c.nam&&!this.models.some(m=>m.id===c.nam!.model))nam.insertAdjacentHTML('beforeend',`<option value="${esc(c.nam.model)}" selected>${esc(c.nam.name)}</option>`);
  for(const [id,key] of [['live-bass','bass'],['live-mid','mid'],['live-treble','treble'],['live-out','output']] as const)this.$<HTMLInputElement>(id).value=String(c.tone[key]);
  this.$<HTMLInputElement>('live-cab').checked=c.tone.cabinet;
  this.$('live-plugin-list').innerHTML=c.plugins.map((p,i)=>`<li><span>${esc(p.name)}</span><button type="button" data-edit="${i}" title="プラグインの画面を開く">編集</button><button type="button" data-on="${i}" aria-pressed="${p.enabled}">${p.enabled?'オン':'オフ'}</button><button type="button" data-remove="${i}" aria-label="外す">×</button></li>`).join('')||'<li class="live-empty">なし</li>';
 }
 private saveChain(){store.set(CHAIN_KEY,JSON.stringify(this.chain));}
 private async namJson(id:string){const model=this.models.find(m=>m.id===id);return model?.json??await this.o.namModel(id);}
 private async sendNam(){
  const nam=this.chain.nam;
  if(!nam){this.norm=0;await this.o.host.send('live_nam',joinFrame({key:null},[]));return;}
  const json=await this.namJson(nam.model);this.norm=namOutputLevel({model:nam.model,kind:this.models.find(m=>m.id===nam.model)?.kind});
  await this.invoke('live_nam_tone',engineTone(this.chain.tone,this.norm));
  await this.o.host.send('live_nam',joinFrame({key:nam.model},[new TextEncoder().encode(json)]));
 }
 private sendTone(){return this.invoke('live_nam_tone',engineTone(this.chain.tone,this.norm));}
 private async loadPlugin(index:number){
  const p=this.chain.plugins[index];if(this.ids.has(index)||!this.o.fx)return;
  const loaded=await this.o.fx.load(p.path,p.state);this.ids.set(index,loaded.id);
 }
 private async sendFx(){
  if(!this.o.fx){await this.invoke('live_fx',{fx:[]});return;}
  for(let i=0;i<this.chain.plugins.length;i++)await this.loadPlugin(i);
  const fx=this.chain.plugins.map((p,i)=>({kind:'external',id:this.ids.get(i)!,enabled:p.enabled,amount:0}));
  await this.invoke('live_fx',{fx});
 }
 private async applyChain(){await this.sendNam();await this.sendFx();}
 private async removePlugin(index:number){
  const id=this.ids.get(index);this.chain.plugins.splice(index,1);
  const ids=[...this.ids.entries()].filter(([i])=>i!==index).map(([i,v])=>[i>index?i-1:i,v] as [number,string]);this.ids=new Map(ids);
  this.saveChain();this.renderChain();await this.sendFx();if(id&&this.o.fx)await this.o.fx.close(id);
 }

 // Polling and drawing.
 private startPolling(){
  this.stopPolling();window.clearInterval(this.background);this.background=0;
  this.timers.push(window.setInterval(()=>this.run(async()=>{this.status=await this.invoke<LiveStatus>('live_status');this.render();}),70));
  this.timers.push(window.setInterval(()=>this.run(()=>this.refreshOverview()),1000));
  this.run(()=>this.refreshOverview());
 }
 private stopPolling(){for(const t of this.timers)window.clearInterval(t);this.timers=[];if(this.status?.enabled)this.startBackground();}
 /** While the panel is closed: a slow poll for the recording indicator. */
 private startBackground(){if(this.background||this.dialog.open)return;this.background=window.setInterval(()=>this.run(async()=>{this.status=await this.invoke<LiveStatus>('live_status');this.updatePill();}),1000);}
 private async refreshOverview(){
  const s=this.status;if(!s)return;const rate=s.sampleRate||48000,view=viewRange(s.timeline.end,rate);
  const canvas=this.$<HTMLCanvasElement>('live-canvas');const width=Math.max(100,canvas.clientWidth);
  const from=Math.max(0,view[0]),to=Math.max(from+1,view[1]),buckets=Math.max(1,Math.round(width*(to-from)/(view[1]-view[0])));
  this.overview=await this.invoke<LiveOverview>('live_overview',{from,to,buckets});this.drawn=[from,to];this.draw();
 }
 private updatePill(){
  const s=this.status,on=!!s?.enabled;this.pill.hidden=!on||this.dialog.open;
  // Always-on recording is "Rewind" (the last five minutes to go back to), shown without alarm red.
  this.pill.textContent=s?.recording?(s.take!==null?'⟲ Rewind ・ テイク保存中':'⟲ Rewind'):'楽器入力';this.pill.classList.toggle('recording',!!s?.recording);
 }
 private render(){
  const s=this.status;if(!s)return;const on=s.enabled;
  const toggle=this.$<HTMLButtonElement>('live-toggle');toggle.textContent=on?'入力をオフ':'入力をオン';toggle.classList.toggle('primary',!on);
  const rec=this.$('live-rec');rec.textContent=!on?'入力オフ':s.recording?(s.take!==null?'⟲ Rewind ・ テイク保存中':'⟲ Rewind（直近5分）'):'Rewindオフ（設定→楽器入力）';rec.className='live-rec'+(on&&s.recording?' on':'');
  const inMeter=this.$<HTMLMeterElement>('live-in-meter');inMeter.value=meterFill(s.inputPeak);inMeter.classList.toggle('clip',s.inputPeak>=0.98);
  const db=peakDb(s.inputPeak);this.$('live-in-db').textContent=db<=-60?'-∞':`${db.toFixed(0)} dB`;
  this.$<HTMLMeterElement>('live-out-meter').value=meterFill(s.monitorPeak);
  const drops=dropsLabel(s.drops,s.sampleRate||48000);
  if(s.deviceLost)this.$('live-note').textContent=s.deviceLost;
  this.$('live-latency').textContent=on?`遅延 ${latencyLabel(s.latency)} ・ ${s.backend==='asio'?'ASIO':'WASAPI'} ${s.output??''} / バッファ ${s.buffer}${drops?` ・ ${drops}`:''}${s.error?` ・ 録音エラー：${s.error}`:''}`:'';
  this.$<HTMLButtonElement>('live-take').textContent=s.take!==null?'保存を終了':'保存を開始';
  this.$<HTMLButtonElement>('live-take').classList.toggle('primary',s.take!==null);
  if(this.overview)this.draw();
  this.updatePill();
 }
 private draw(){
  const s=this.status,o=this.overview;const canvas=this.$<HTMLCanvasElement>('live-canvas');if(!s||!o)return;
  const dpr=window.devicePixelRatio||1,w=canvas.clientWidth,h=canvas.clientHeight||120;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
  const g=canvas.getContext('2d');if(!g)return;g.setTransform(dpr,0,0,dpr,0,0);
  const css=getComputedStyle(this.dialog),color=(n:string,d:string)=>css.getPropertyValue(n).trim()||d;
  const accent=color('--accent','#79dfc0'),muted=color('--muted','#9cb4c4'),line=color('--line','#344553');
  const rate=s.sampleRate||48000,view=viewRange(s.timeline.end,rate);g.clearRect(0,0,w,h);
  // Phrases, then where the score was playing (top strip).
  g.fillStyle=accent+'22';for(const [a,b] of o.phrases){const x=xAt(a,w,view);g.fillRect(x,0,xAt(b,w,view)-x,h);}
  g.fillStyle=accent;for(let i=0;i<o.marks.length;i++){const m=o.marks[i];if(m[2]===null)continue;const x=xAt(m[0],w,view),x2=i+1<o.marks.length?xAt(o.marks[i+1][0],w,view):x+2;g.fillRect(x,0,Math.max(1,x2-x),3);}
  // What is recorded: from the oldest frame kept.
  const oldestX=xAt(s.timeline.oldest,w,view);if(oldestX>0){g.fillStyle=line+'55';g.fillRect(0,0,oldestX,h);}
  const mid=h/2+4,amp=(h-12)/2,n=o.dry.length,[from,to]=this.drawn,step=(to-from)/Math.max(1,n);
  for(let i=0;i<n;i++){const x=xAt(from+i*step,w,view),bw=Math.max(1,xAt(from+(i+1)*step,w,view)-x);const d=Math.min(1,o.dry[i]*2),wv=Math.min(1,(o.wet[i]??0)*2);
   g.fillStyle=muted+'99';g.fillRect(x,mid-d*amp,bw,d*amp*2);
   if(wv>0){g.fillStyle=accent+'aa';g.fillRect(x,mid-wv*amp*0.8,bw,wv*amp*1.6);}}
  // Minute ticks.
  g.fillStyle=muted;g.font='10px system-ui';for(let sec=0;sec<=HISTORY_SECONDS;sec+=60){const x=xAt(view[1]-sec*rate,w,view);g.fillRect(x,h-4,1,4);g.fillText(agoLabel(sec),Math.min(w-22,Math.max(0,x-10)),h-6);}
  if(this.selected){const [a,b]=this.selected;const x=xAt(a,w,view);g.fillStyle=accent+'33';g.fillRect(x,0,xAt(b,w,view)-x,h);g.strokeStyle=accent;g.strokeRect(x+0.5,0.5,xAt(b,w,view)-x-1,h-1);}
  if(s.take!==null){const x=xAt(s.take,w,view);g.fillStyle='#ef746b';g.fillRect(x,0,2,h);}
  if(s.replay!==null){const x=xAt(s.replay,w,view);g.fillStyle=color('--text','#fff');g.fillRect(x,0,2,h);}
  const sel=this.selected;this.$('live-sel').textContent=sel?`選択 ${agoLabel((s.timeline.end-sel[0])/rate)} 〜 ${agoLabel((s.timeline.end-sel[1])/rate)}（${durationLabel((sel[1]-sel[0])/rate)}）${songAt(o.marks,sel[0],rate)!==null?' ・ 譜面再生中に録音':''}`:'ドラッグで範囲を選択 ・ クリックでそこから再生 ・ ダブルクリックでフレーズを選択';
 }

 // Listening back and saving.
 private range():[number,number]|null{
  const s=this.status;if(!s)return null;if(this.selected)return this.selected;
  const last=this.overview?.phrases.at(-1);if(last)return [last[0],last[1]];
  return selection(s.timeline.end-30*(s.sampleRate||48000),s.timeline.end,s.timeline.oldest,s.timeline.end);
 }
 private async play(from?:number){
  const s=this.status;if(!s)return;const r=from!==undefined?[from,s.timeline.end] as [number,number]:this.range();if(!r)return;
  const withSong=this.$<HTMLInputElement>('live-song').checked;
  // A replay with the score waits for it to start fresh: stop it first.
  if(withSong)await this.o.song.pause();
  const result=await this.invoke<{song:number|null;tick:number|null}>('live_replay',{from:r[0],to:r[1],looping:this.$<HTMLInputElement>('live-loop').checked&&from===undefined,source:this.$<HTMLSelectElement>('live-source').value,withSong});
  // The replay waits in the engine for the score to start, then both begin together.
  if(result.tick!==null){this.songPlaying=true;this.o.song.play(result.tick);}
  else if(withSong)this.o.message('この範囲は譜面の再生中に録音されていないため、録音だけ再生します。');
 }
 private extra(){return {amp:this.chain.nam?.name??null,plugins:this.chain.plugins.filter(p=>p.enabled).map(p=>p.name)};}
 private label(){return this.chain.nam?.name.split('·')[0].trim()??'';}
 private async refreshTakes(){
  let takes:{name:string;path:string;seconds?:number;amp?:string|null}[]=[];try{takes=await this.invoke('live_takes');}catch{return;}
  this.$('live-take-list').innerHTML=takes.length?takes.slice(0,30).map(t=>`<li><span>${esc(t.name)}</span><small>${t.seconds?durationLabel(t.seconds):''}${t.amp?` ・ ${esc(String(t.amp))}`:''}</small><button type="button" data-reveal="${esc(t.path)}">フォルダで表示</button></li>`).join(''):'<li class="live-empty">まだありません</li>';
 }

 private wire(){
  const d=this.dialog,$=<T extends HTMLElement>(id:string)=>this.$<T>(id);
  $('live-close').onclick=()=>this.close();d.addEventListener('cancel',e=>{e.preventDefault();this.close();});
  // A click anywhere outside the panel (and its pill) closes it; the input keeps running.
  document.addEventListener('pointerdown',e=>{const target=e.target as Node|null;if(this.dialog.open&&target&&!this.dialog.contains(target)&&!this.pill.contains(target))this.close();},true);
  $('live-toggle').onclick=()=>this.run(()=>this.setEnabled(!this.status?.enabled));
  $<HTMLSelectElement>('live-backend').onchange=e=>this.run(()=>this.configure({backend:(e.target as HTMLSelectElement).value as LiveConfig['backend'],output:null}));
  $<HTMLSelectElement>('live-output').onchange=e=>this.run(()=>this.configure({output:(e.target as HTMLSelectElement).value||null}));
  $<HTMLSelectElement>('live-input-device').onchange=e=>this.run(()=>this.configure({input:(e.target as HTMLSelectElement).value||null}));
  $<HTMLSelectElement>('live-channel').onchange=e=>this.run(()=>this.configure({channel:Number((e.target as HTMLSelectElement).value)}));
  $<HTMLSelectElement>('live-buffer').onchange=e=>this.run(()=>this.configure({buffer:Number((e.target as HTMLSelectElement).value)}));
  let levelTimer=0;const levels=()=>{window.clearTimeout(levelTimer);levelTimer=window.setTimeout(()=>this.run(()=>this.configure({})),120);};
  $<HTMLInputElement>('live-gain').oninput=e=>{const v=Number((e.target as HTMLInputElement).value);if(this.config)this.config.inputDb=v;$('live-gain-out').textContent=`${v>0?'+':''}${v} dB`;levels();};
  $<HTMLInputElement>('live-level').oninput=e=>{if(this.config)this.config.level=Number((e.target as HTMLInputElement).value);levels();};
  $<HTMLInputElement>('live-wet').onchange=e=>this.run(()=>this.configure({recordWet:(e.target as HTMLInputElement).checked}));
  $<HTMLInputElement>('live-monitor').onchange=e=>{if(this.config)this.config.monitor=(e.target as HTMLInputElement).checked;levels();};
  $<HTMLSelectElement>('live-nam').onchange=e=>{const id=(e.target as HTMLSelectElement).value;const model=this.models.find(m=>m.id===id);this.chain.nam=id?{model:id,name:model?.name??id}:null;if(!id)this.chain.tone={...defaultTone(),cabinet:this.chain.tone.cabinet};this.saveChain();this.run(()=>this.sendNam());};
  let toneTimer=0;const tone=()=>{this.saveChain();window.clearTimeout(toneTimer);toneTimer=window.setTimeout(()=>this.run(()=>this.sendTone()),60);};
  for(const [id,key] of [['live-bass','bass'],['live-mid','mid'],['live-treble','treble'],['live-out','output']] as const)$<HTMLInputElement>(id).oninput=e=>{this.chain.tone[key]=Number((e.target as HTMLInputElement).value);tone();};
  $<HTMLInputElement>('live-cab').onchange=e=>{this.chain.tone.cabinet=(e.target as HTMLInputElement).checked;tone();};
  const add=$<HTMLSelectElement>('live-plugin-add');
  add.onfocus=()=>{if(this.plugins.length||!this.o.fx)return;this.run(async()=>{this.plugins=(await this.o.fx!.scan()).filter(p=>/vst3/i.test(p.format));add.innerHTML='<option value="">＋ VST3 を追加…</option>'+this.plugins.map(p=>`<option value="${esc(p.path)}">${esc(p.name)}</option>`).join('');});};
  add.onchange=()=>{const plugin=this.plugins.find(p=>p.path===add.value);add.value='';if(!plugin||this.chain.plugins.length>=8)return;this.chain.plugins.push({path:plugin.path,name:plugin.name,enabled:true});this.saveChain();this.renderChain();this.run(()=>this.sendFx());};
  $('live-plugin-list').onclick=e=>{
   const b=(e.target as HTMLElement).closest('button');if(!b)return;
   if(b.dataset.remove)this.run(()=>this.removePlugin(Number(b.dataset.remove)));
   if(b.dataset.on){const p=this.chain.plugins[Number(b.dataset.on)];p.enabled=!p.enabled;this.saveChain();this.renderChain();this.run(()=>this.sendFx());}
   if(b.dataset.edit){const i=Number(b.dataset.edit);this.run(async()=>{await this.loadPlugin(i);const id=this.ids.get(i);if(!id||!this.o.fx)return;const r=await this.o.fx.editor(id);if(this.chain.plugins[i]){this.chain.plugins[i].state=r.state;this.saveChain();}});}
  };
  // Timeline: drag selects, click plays from there, double click selects a phrase.
  const canvas=$<HTMLCanvasElement>('live-canvas');
  const frame=(e:PointerEvent|MouseEvent)=>{const s=this.status;if(!s)return 0;const r=canvas.getBoundingClientRect();return frameAt(e.clientX-r.left,r.width,viewRange(s.timeline.end,s.sampleRate||48000));};
  canvas.onpointerdown=e=>{canvas.setPointerCapture(e.pointerId);this.drag={from:frame(e),x:e.clientX};};
  canvas.onpointermove=e=>{if(!this.drag||!this.status||Math.abs(e.clientX-this.drag.x)<3)return;this.selected=selection(this.drag.from,frame(e),this.status.timeline.oldest,this.status.timeline.end);this.draw();};
  canvas.onpointerup=e=>{const drag=this.drag;this.drag=null;if(!drag||!this.status)return;if(Math.abs(e.clientX-drag.x)<3){if(e.detail<2)this.run(()=>this.play(Math.max(drag.from,this.status!.timeline.oldest)));}else this.draw();};
  canvas.ondblclick=e=>{const p=this.overview&&phraseAt(this.overview.phrases,frame(e));if(p){this.selected=[p[0],p[1]];this.run(()=>this.invoke('live_replay_stop'));this.draw();}};
  $('live-play').onclick=()=>this.run(()=>this.play());
  $('live-stop').onclick=()=>this.run(async()=>{await this.invoke('live_replay_stop');if(this.songPlaying){this.songPlaying=false;await this.o.song.pause();}});
  $('live-save').onclick=()=>this.run(async()=>{const r=this.range();if(!r)return;const saved=await this.invoke<{path:string}>('live_save',{from:r[0],to:r[1],label:this.label(),extra:this.extra()});this.o.message(`保存しました：${saved.path}`);await this.refreshTakes();});
  $('live-take').onclick=()=>this.run(async()=>{
   if(this.status?.take!==null&&this.status?.take!==undefined){const r=await this.invoke<{path:string;seconds:number}|null>('live_take_stop');if(r)this.o.message(`保存しました（${durationLabel(r.seconds)}）：${r.path}`);await this.refreshTakes();return;}
   await this.invoke('live_take_start',{back:Number($<HTMLSelectElement>('live-back').value),label:this.label(),extra:this.extra()});
  });
  // Two presses: the first explains (cable, volume), the second measures.
  let armed=0;
  $('live-ping').onclick=()=>this.run(async()=>{
   const out=$('live-ping-out'),button=$('live-ping');
   if(!armed){out.textContent='出力→入力をケーブルでつなぎ（ギターは外す）、音量を下げてから、もう一度押してください。大きめのクリック音が1回鳴ります。';button.textContent='測る';armed=window.setTimeout(()=>{armed=0;button.textContent='遅延を実測…';if(out.textContent?.startsWith('出力→入力'))out.textContent='';},10000);return;}
   window.clearTimeout(armed);armed=0;button.textContent='遅延を実測…';out.textContent='測定中…';
   try{const r=await this.invoke<{ms:number}>('live_ping');out.textContent=`実測 ${r.ms.toFixed(1)} ms（入力→出力の往復、プラグインを除く）`;}catch(e){out.textContent='';throw e;}
  });
  $('live-folder').onclick=()=>this.run(()=>this.invoke('live_reveal',{path:null}));
  $('live-take-list').onclick=e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button[data-reveal]');if(b)this.run(()=>this.invoke('live_reveal',{path:b.dataset.reveal}));};
  window.addEventListener('resize',()=>{if(this.dialog.open)this.draw();});
 }
}
