import './backing.css';
import type * as at from '@coderline/alphatab';
import type {BackingInfo,EngineStatus,NativeEngine} from './audio/native-engine';
import {YouTubeBacking,youTubeId} from './audio/youtube';
import {backingAudio,type BackingSettings} from './mixer-state';

/** 「音声を再生」 (Tauri, native engine): a small window that plays an audio file through the
 * engine (practice speeds without a pitch change, key change) or a YouTube video. It plays on
 * its own, or, with 「曲と一緒に流す」, in time with the score (aligned by an offset). Settings
 * are saved with the score (studiobacking); the audio file stays where it is (found again next
 * to a moved project). */
type Options={
 engine:NativeEngine;
 score:()=>at.model.Score;
 /** The score's file (relinks audio found next to it). */
 documentPath:()=>string;
 /** The score's practice speed. */
 speed:()=>number;
 /** Starts or pauses the score (play button while linked). */
 togglePlay:()=>void;
 /** A setting changed (the document is now dirty). */
 changed:()=>void;
 message:(text:string)=>void;
};
const clock=(seconds:number)=>{const s=Math.max(0,seconds);return `${Math.floor(s/60)}:${(s%60).toFixed(1).padStart(4,'0')}`;};
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
const PLACE_KEY='tabstudio-audio-window';
const SPEEDS=[.5,.6,.7,.75,.8,.85,.9,.95,1,1.1,1.25,1.5];
const store={get:(k:string)=>{try{return localStorage.getItem(k);}catch{return null;}},set:(k:string,v:string)=>{try{localStorage.setItem(k,v);}catch{}}};

export class BackingPanel{
 readonly dialog:HTMLDialogElement;
 private youtube:YouTubeBacking;
 /** What the engine has: the file loaded (path asked for) and its decoded info. */
 private loadedPath:string|null=null;private info:BackingInfo|null=null;private loading:Promise<void>=Promise.resolve();
 private loadError='';private generation=0;private mixSent='';
 private status:EngineStatus|undefined;private lastFollow=0;private drawn='';
 constructor(private o:Options){
  this.dialog=document.createElement('dialog');this.dialog.id='backing-panel';this.dialog.className='backing-panel';this.dialog.setAttribute('aria-labelledby','backing-title');
  this.dialog.innerHTML=`<header id="backing-grip" title="ドラッグで移動"><h2 id="backing-title">音声を再生</h2><span class="backing-state" id="backing-state"></span><button type="button" class="backing-close" id="backing-close" aria-label="閉じる">×</button></header>
<div class="backing-body">
<div class="backing-sources" role="radiogroup" aria-label="音声の種類"><button type="button" role="radio" data-source="file">音声ファイル</button><button type="button" role="radio" data-source="youtube">YouTube</button><button type="button" role="radio" data-source="none">なし</button></div>
<section class="backing-file" id="backing-file"><div class="backing-row"><button type="button" id="backing-pick">ファイルを選択…</button><span class="backing-name" id="backing-name"></span></div>
<p class="backing-info" id="backing-info"></p><p class="backing-error" id="backing-error" role="alert"></p>
<canvas id="backing-wave"></canvas></section>
<section class="backing-youtube" id="backing-youtube"><div class="backing-row"><input type="url" id="backing-url" placeholder="YouTubeのURL" aria-label="YouTubeのURL"><button type="button" id="backing-url-load">読み込む</button></div>
<p class="backing-error" id="backing-yt-error" role="alert"></p><div id="backing-video-player" class="backing-video"></div></section>
<section class="backing-transport" id="backing-transport"><button type="button" id="backing-play" class="backing-play" aria-label="再生">▶</button><output id="backing-time"></output>
<label id="backing-speed-row">速度<select id="backing-speed" aria-label="再生速度"></select></label>
<label class="backing-check backing-link"><input type="checkbox" id="backing-linked">曲と一緒に流す</label></section>
<details class="backing-more" id="backing-more"><summary>詳細設定</summary>
<div class="backing-row" id="backing-align-row"><label>譜面の先頭<input type="number" id="backing-offset" step="0.01" aria-label="譜面の先頭（秒）"><span>秒</span></label>
<span class="backing-nudge"><button type="button" data-nudge="-0.1">−0.1</button><button type="button" data-nudge="-0.01">−0.01</button><button type="button" data-nudge="0.01">+0.01</button><button type="button" data-nudge="0.1">+0.1</button></span>
<label title="録音のテンポが譜面とわずかに違うときに合わせます">テンポ補正<input type="number" id="backing-rate" step="0.1" min="80" max="125"><span>%</span></label></div>
<div class="backing-row"><label>音量<input type="range" id="backing-gain" min="0" max="2" step="0.01"><output id="backing-gain-value"></output></label>
<button type="button" id="backing-mute" aria-pressed="false">ミュート</button><button type="button" id="backing-solo" aria-pressed="false" title="この音声だけを鳴らします（譜面の音を止めます）">ソロ</button></div>
<div class="backing-row"><label id="backing-pitch-row">キー<select id="backing-pitch" aria-label="キー（半音）"></select></label>
<label class="backing-check" id="backing-normalize-row"><input type="checkbox" id="backing-normalize"><span id="backing-normalize-text">音量を自動調整</span></label></div>
<p class="backing-hint" id="backing-hint"></p></details>
</div>`;
  document.body.append(this.dialog);
  this.youtube=new YouTubeBacking(this.$('backing-video-player'));this.youtube.onChange=()=>this.render();
  const pitch=this.$<HTMLSelectElement>('backing-pitch');for(let s=12;s>=-12;s--)pitch.add(new Option(s===0?'原曲':`${s>0?'+':'−'}${Math.abs(s)}`,String(s)));
  const speed=this.$<HTMLSelectElement>('backing-speed');for(const v of SPEEDS)speed.add(new Option(`${Math.round(v*100)}%`,String(v)));
  this.$('backing-close').onclick=()=>this.close();
  for(const b of this.dialog.querySelectorAll<HTMLButtonElement>('[data-source]'))b.onclick=()=>this.setSource(b.dataset.source as BackingSettings['source']);
  this.$('backing-pick').onclick=()=>void this.pick();
  this.$('backing-url-load').onclick=()=>this.useUrl();
  this.$<HTMLInputElement>('backing-url').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();this.useUrl();}};
  this.$('backing-play').onclick=()=>this.togglePlay();
  speed.onchange=()=>this.update({speed:Number(speed.value)});
  this.$<HTMLInputElement>('backing-linked').onchange=e=>this.update({linked:(e.target as HTMLInputElement).checked});
  this.$<HTMLInputElement>('backing-offset').onchange=e=>{const v=Number((e.target as HTMLInputElement).value);if(Number.isFinite(v))this.update({offset:Math.round(v*1000)/1000});};
  for(const b of this.dialog.querySelectorAll<HTMLButtonElement>('[data-nudge]'))b.onclick=()=>this.update({offset:Math.round((this.settings.offset+Number(b.dataset.nudge))*1000)/1000});
  this.$<HTMLInputElement>('backing-rate').onchange=e=>{const v=Number((e.target as HTMLInputElement).value);if(Number.isFinite(v))this.update({rate:Math.max(.8,Math.min(1.25,v/100))});};
  pitch.onchange=()=>this.update({semitones:Number(pitch.value)});
  this.$<HTMLInputElement>('backing-gain').oninput=e=>this.update({gain:Number((e.target as HTMLInputElement).value)});
  this.$('backing-mute').onclick=()=>this.update({mute:!this.settings.mute});
  this.$('backing-solo').onclick=()=>this.update({solo:!this.settings.solo});
  this.$<HTMLInputElement>('backing-normalize').onchange=e=>this.update({normalize:(e.target as HTMLInputElement).checked});
  const wave=this.$<HTMLCanvasElement>('backing-wave');
  wave.onclick=e=>{
   if(!this.info)return;const r=wave.getBoundingClientRect(),t=(e.clientX-r.left)/r.width*this.info.seconds;
   // On its own: jump there. With the score: that point of the recording is where the score's cursor is now.
   if(this.settings.linked)this.update({offset:Math.round((t-(this.status?.position??0)*this.settings.rate)*1000)/1000});
   else this.run(this.o.engine.command({kind:'backingSeek',seconds:t}));
  };
  this.movable();
  this.spaceKey();
  o.engine.onStatus(status=>this.follow(status));
  new ResizeObserver(()=>{this.drawn='';this.draw();}).observe(wave);
 }
 private $<T extends HTMLElement=HTMLElement>(id:string){return this.dialog.querySelector(`#${id}`) as T;}
 private run(action:Promise<unknown>){void action.catch(e=>this.o.message(`音声を再生：${e instanceof Error?e.message:String(e)}`));}
 get settings(){return backingAudio(this.o.score());}
 /** Space always plays the score (the app's shortcut), also after a click in this window: a
  * Space released on one of its buttons or checkboxes must not press that control too. */
 private spaceKey(){
  window.addEventListener('keyup',e=>{if(e.code==='Space'&&this.dialog.contains(e.target as Node)&&!(e.target instanceof HTMLInputElement&&['text','url','number','search'].includes(e.target.type)))e.preventDefault();},true);
  // A click on the YouTube player moves the keyboard into its frame (another site), where the
  // app never sees Space: the click still reaches the player, then the keyboard comes back.
  window.addEventListener('blur',()=>setTimeout(()=>{
   const frame=document.activeElement;
   if(frame instanceof HTMLIFrameElement&&this.dialog.contains(frame)){frame.blur();this.$('backing-play').focus({preventScroll:true});}
  },0));
 }
 /** Dragged by its title bar; the place is remembered and kept on screen. */
 private movable(){
  const grip=this.$('backing-grip');
  grip.onpointerdown=e=>{
   if((e.target as HTMLElement).closest('button'))return;
   const r=this.dialog.getBoundingClientRect(),dx=e.clientX-r.left,dy=e.clientY-r.top;grip.setPointerCapture(e.pointerId);
   grip.onpointermove=m=>this.place(m.clientX-dx,m.clientY-dy);
   const end=()=>{grip.onpointermove=null;const r=this.dialog.getBoundingClientRect();store.set(PLACE_KEY,JSON.stringify({x:Math.round(r.left),y:Math.round(r.top)}));};
   grip.onpointerup=end;grip.onpointercancel=end;e.preventDefault();
  };
  window.addEventListener('resize',()=>{if(this.dialog.open){const r=this.dialog.getBoundingClientRect();this.place(r.left,r.top);this.keepOnScreen();}});
  new ResizeObserver(()=>this.keepOnScreen()).observe(this.dialog);
 }
 private place(x:number,y:number){
  const r=this.dialog.getBoundingClientRect();
  this.dialog.style.left=`${Math.max(0,Math.min(window.innerWidth-r.width,x))}px`;
  this.dialog.style.top=`${Math.max(0,Math.min(window.innerHeight-Math.min(r.height,80),y))}px`;
 }
 open(){
  if(!this.dialog.open){
   this.dialog.show();this.render();
   let saved:{x?:number;y?:number}={};try{saved=JSON.parse(store.get(PLACE_KEY)??'{}');}catch{}
   const r=this.dialog.getBoundingClientRect();
   this.place(saved.x??16,saved.y??window.innerHeight-r.height-40);
  }
  this.render();
 }
 /** Closing hides the window; a YouTube video stops with it (it must stay visible to play). */
 close(){this.dialog.close();this.youtube.pause();}
 /** Resolves once the file the score asks for reached the engine (playback waits for it). */
 ready(){return this.loading.catch(()=>{});}
 /** Peak of the audio strip since the last call (mixer meter). */
 peak(){return this.status?.backingPeak??0;}
 /** A label for the mixer strip. */
 label(){const s=this.settings;return s.source==='file'?(this.loadError?'⚠ '+(s.name??'ファイル'):s.name??'ファイル'):s.source==='youtube'?'YouTube · '+(this.youtube.title()||s.title||s.videoId):'なし';}
 /** The score changed (document switch, load, track edits): engine and player follow its settings. */
 setScore(_score:at.model.Score){this.sync();}
 private update(patch:Partial<BackingSettings>){Object.assign(this.settings,patch);this.o.changed();this.sync();}
 private setSource(source:BackingSettings['source']){
  if(source==='file'&&!this.settings.path){void this.pick();return;}
  if(source==='youtube'&&!this.settings.videoId){this.settings.source='youtube';this.render();this.$<HTMLInputElement>('backing-url').focus();return;}
  this.update({source});
 }
 private async pick(){
  try{const path=await this.o.engine.backingFile();if(!path)return;
   const name=path.split(/[\\/]/).pop()!;
   this.update({source:'file',path,name,offset:this.settings.path===path?this.settings.offset:0});
  }catch(e){this.o.message(`ファイルを選べません：${e instanceof Error?e.message:String(e)}`);}
 }
 private useUrl(){
  const input=this.$<HTMLInputElement>('backing-url'),id=youTubeId(input.value);
  if(!id){this.$('backing-yt-error').textContent='YouTubeの動画のURLを入力してください。';return;}
  this.update({source:'youtube',videoId:id,title:undefined,offset:this.settings.videoId===id?this.settings.offset:0});
 }
 /** ▶ (and its shortcut, C): on its own the audio plays or pauses; linked, the score does (and
  * the audio with it). Without any audio chosen yet, the window opens. */
 togglePlay(){
  if(this.settings.source==='none'){this.open();return;}
  const s=this.settings;
  if(s.linked){this.o.togglePlay();return;}
  if(s.source==='file'&&this.info)this.run(this.o.engine.command({kind:this.status?.backingPlaying?'backingPause':'backingPlay'}));
  else if(s.source==='youtube'){this.youtube.setRate(s.speed);this.youtube.toggle();}
 }
 /** Engine and player follow the settings. */
 sync(){
  const s=this.settings;
  const wantFile=s.source==='file'&&s.path?s.path:null;
  if(wantFile!==this.loadedPath){
   const generation=++this.generation;this.loadedPath=wantFile;this.info=null;this.loadError='';this.mixSent='';this.drawn='';
   this.loading=(async()=>{
    try{
     if(!wantFile){await this.o.engine.backingClear();return;}
     const info=await this.o.engine.backingLoad(wantFile,this.o.documentPath());
     if(generation!==this.generation)return;
     this.info=info;
     // Found next to a moved project: remember where it is now.
     if(info.path!==wantFile&&this.settings.path===wantFile){this.settings.path=info.path;this.settings.name=info.name;this.loadedPath=info.path;this.o.changed();}
     this.sendMix(true);
    }catch(e){if(generation===this.generation){this.loadError=e instanceof Error?e.message:String(e);}}
    finally{if(generation===this.generation)this.render();}
   })();
  }else this.sendMix();
  if(s.source==='youtube'&&s.videoId){void this.youtube.load(s.videoId).then(()=>this.youtube.volume(s.gain,s.mute)).catch(()=>{});this.youtube.volume(s.gain,s.mute);if(!s.linked)this.youtube.setRate(s.speed);}
  else if(this.youtube.loaded)this.youtube.unload();
  this.render();
 }
 private sendMix(force=false){
  if(!this.info)return;
  const s=this.settings,mix={kind:'backing' as const,gain:s.gain,mute:s.mute,solo:s.solo,offset:s.offset,semitones:s.semitones,rate:s.rate,normalize:s.normalize,linked:s.linked,speed:s.speed},key=JSON.stringify(mix);
  if(!force&&key===this.mixSent)return;this.mixSent=key;
  this.run(this.o.engine.command(mix));
 }
 /** Engine status (about 60 a second): a linked YouTube video follows the score; the time,
  * play button and waveform playhead update. */
 private follow(status:EngineStatus){
  this.status=status;const s=this.settings;
  const now=performance.now();
  if(now-this.lastFollow>=100){
   this.lastFollow=now;
   if(s.source==='youtube'&&this.youtube.loaded){
    this.youtube.volume(s.gain,s.mute);
    if(s.linked&&this.dialog.open)this.youtube.follow(status.playing&&!status.counting,s.offset+status.position*s.rate,this.o.speed()*s.rate);
    else this.youtube.follower.drift=null;
   }
   if(this.dialog.open)this.showTime();
  }
  if(this.dialog.open&&this.info)this.draw();
 }
 /** The file (or video) position, and whether it plays now. */
 private now(){
  const s=this.settings,st=this.status;
  if(s.source==='youtube')return {at:this.youtube.currentTime(),length:this.youtube.duration(),playing:s.linked?!!st?.playing:this.youtube.playing()};
  return {at:st?.backingPosition??0,length:this.info?.seconds??0,playing:s.linked?!!st?.playing:!!st?.backingPlaying};
 }
 private showTime(){
  const n=this.now(),play=this.$<HTMLButtonElement>('backing-play');
  this.$('backing-time').textContent=n.length?`${clock(n.at)} / ${clock(n.length)}`:'';
  play.textContent=n.playing?'❚❚':'▶';play.setAttribute('aria-label',n.playing?'一時停止':'再生');
  const drift=this.youtube.follower.drift;
  this.$('backing-state').textContent=this.stateText()+(drift!==null&&this.settings.source==='youtube'?` · ずれ ${Math.round(drift*1000)} ms`:'');
 }
 private stateText(){const s=this.settings;return s.source==='file'?(this.loadError?'ファイルが見つかりません':this.info?(s.linked?'曲と連動':'単体で再生'):'読み込み中…'):s.source==='youtube'?(this.youtube.error?'再生できません':s.linked?'曲と連動':'単体で再生'):'';}
 /** Waveform: the whole recording, the score's start (linked) and the playhead. */
 private draw(){
  const canvas=this.$<HTMLCanvasElement>('backing-wave'),info=this.info;if(!info||canvas.hidden)return;
  const width=Math.max(1,Math.round(canvas.clientWidth*devicePixelRatio)),height=Math.max(1,Math.round(canvas.clientHeight*devicePixelRatio));
  const s=this.settings,heard=this.status?.backingPosition??0,key=`${width}x${height}:${s.linked}:${s.offset}:${Math.round(heard*50)}:${info.path}`;
  if(key===this.drawn)return;this.drawn=key;
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  const g=canvas.getContext('2d');if(!g)return;const style=getComputedStyle(this.dialog);
  g.clearRect(0,0,width,height);g.fillStyle=style.getPropertyValue('--muted').trim()||'#889';
  const peaks=info.peaks,per=peaks.length/width,mid=height/2;
  for(let x=0;x<width;x++){let m=0;for(let i=Math.floor(x*per),end=Math.max(i+1,Math.floor((x+1)*per));i<end&&i<peaks.length;i++)m=Math.max(m,peaks[i]);const h=m/255*mid;g.fillRect(x,mid-h,1,Math.max(1,h*2));}
  const at=(t:number)=>t/info.seconds*width;
  if(s.linked){
   if(s.offset>0){g.fillStyle='#0006';g.fillRect(0,0,at(s.offset),height);}
   g.fillStyle=style.getPropertyValue('--accent').trim()||'#4a9eff';g.fillRect(Math.round(at(s.offset)),0,Math.max(1,devicePixelRatio*2),height);
  }
  g.fillStyle='#fff';g.fillRect(Math.round(at(heard)),0,Math.max(1,devicePixelRatio),height);
 }
 render(){
  const s=this.settings,file=s.source==='file',youtube=s.source==='youtube';
  for(const b of this.dialog.querySelectorAll<HTMLButtonElement>('[data-source]'))b.setAttribute('aria-checked',String(b.dataset.source===s.source));
  this.$('backing-file').hidden=!file;this.$('backing-youtube').hidden=!youtube;
  this.$('backing-transport').hidden=this.$('backing-more').hidden=s.source==='none';
  this.$('backing-name').textContent=file?s.name??'':'';
  const info=this.info;
  this.$('backing-info').textContent=file&&info?`${info.codec.toUpperCase()} ${(info.sourceRate/1000).toFixed(1)} kHz · ${info.channels===1?'モノラル':'ステレオ'}${info.lufs!==null?` · ${info.lufs.toFixed(1)} LUFS`:''}`:file&&this.loadedPath&&!this.loadError?'読み込んでいます…':'';
  this.$('backing-error').innerHTML=file&&this.loadError?`${esc(this.loadError)} <button type="button" id="backing-relink">ファイルを指定し直す…</button>`:'';
  this.dialog.querySelector<HTMLButtonElement>('#backing-relink')?.addEventListener('click',()=>void this.pick());
  this.$('backing-yt-error').textContent=youtube?this.youtube.error:'';
  if(youtube&&s.videoId&&document.activeElement!==this.$('backing-url'))this.$<HTMLInputElement>('backing-url').value=`https://www.youtube.com/watch?v=${s.videoId}`;
  const title=this.youtube.title();if(youtube&&title&&title!==s.title)s.title=title;
  const canvas=this.$<HTMLCanvasElement>('backing-wave');canvas.hidden=!file||!info;
  canvas.title=s.linked?'クリックした位置を譜面の現在位置（カーソル）に合わせます':'クリックした位置から再生します';
  this.$<HTMLInputElement>('backing-linked').checked=s.linked;
  this.$('backing-speed-row').hidden=s.linked;this.$<HTMLSelectElement>('backing-speed').value=String(SPEEDS.reduce((b,v)=>Math.abs(v-s.speed)<Math.abs(b-s.speed)?v:b));
  this.$('backing-align-row').hidden=!s.linked;
  const offset=this.$<HTMLInputElement>('backing-offset');if(document.activeElement!==offset)offset.value=s.offset.toFixed(3);
  const rate=this.$<HTMLInputElement>('backing-rate');if(document.activeElement!==rate)rate.value=(s.rate*100).toFixed(1);
  this.$<HTMLSelectElement>('backing-pitch').value=String(s.semitones);this.$('backing-pitch-row').hidden=!file;
  this.$<HTMLInputElement>('backing-gain').value=String(s.gain);this.$('backing-gain-value').textContent=`${Math.round(s.gain*100)}%`;
  this.$('backing-mute').setAttribute('aria-pressed',String(s.mute));
  const solo=this.$<HTMLButtonElement>('backing-solo');solo.setAttribute('aria-pressed',String(s.solo));solo.hidden=!file;
  this.$('backing-normalize-row').hidden=!file;this.$<HTMLInputElement>('backing-normalize').checked=s.normalize;
  this.$('backing-normalize-text').textContent=info&&info.lufs!==null?`音量を自動調整（${info.trimDb>=0?'+':''}${info.trimDb.toFixed(1)} dB）`:'音量を自動調整';
  const what=file?'録音':'動画',start=s.offset>=0?`譜面の先頭 = ${what}の ${clock(s.offset)}。`:`${what}は譜面の ${clock(-s.offset)} から始まります。`;
  this.$('backing-hint').textContent=(s.linked?`${start}再生・停止・ループ・練習速度は譜面に連動します。${file?'波形をクリックすると、その位置を譜面のカーソル位置に合わせます。':''}`:file?'速度を変えても音程は変わりません。':'')
   +(youtube?'YouTubeは公式の埋め込みプレーヤーで再生します（音声のダウンロードはしません）。ミキサーのFX・ソロ・キーは使えず、速度は ×0.25 刻みです。このウィンドウを閉じると止まります。ASIOで同じ機器を使っていると鳴らない場合があります。':'');
  this.showTime();
  this.drawn='';this.draw();
  this.keepOnScreen();
 }
 /** The window stays inside the app when its content grows (a file loads, settings open). */
 private keepOnScreen(){
  if(!this.dialog.open)return;const r=this.dialog.getBoundingClientRect();
  if(r.bottom>window.innerHeight||r.right>window.innerWidth)this.place(r.left,Math.min(r.top,window.innerHeight-r.height));
 }
}
