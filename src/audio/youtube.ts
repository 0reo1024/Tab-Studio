/** YouTube as a backing track, through the official IFrame Player API: the video plays in its
 * own visible player and the app keeps it in step with the engine's song position (seeking
 * when it drifts). Nothing is downloaded or extracted, as YouTube's terms require, so its sound
 * does not pass through the engine: no mixer effects, practice speeds only in YouTube's steps,
 * and the alignment is good to tens of milliseconds, not to the sample like an audio file. */

/** The video id in a YouTube link (watch, youtu.be, embed, shorts, live, music) or a bare id. */
export function youTubeId(text:string):string|null{
 const value=text.trim();
 if(/^[\w-]{11}$/.test(value))return value;
 let url:URL;try{url=new URL(/^https?:\/\//i.test(value)?value:`https://${value}`);}catch{return null;}
 const host=url.hostname.replace(/^(www|m|music)\./,'');
 const id=host==='youtu.be'?url.pathname.split('/')[1]:host==='youtube.com'||host==='youtube-nocookie.com'?url.searchParams.get('v')??url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/)?.[1]:undefined;
 return id&&/^[\w-]{11}$/.test(id)?id:null;
}

/** The available rate closest to the one wanted. */
export function nearestRate(rates:number[],wanted:number){return rates.length?rates.reduce((best,r)=>Math.abs(r-wanted)<Math.abs(best-wanted)?r:best):1;}

/** Why a video cannot play (the player's onError codes). */
export function youTubeError(code:number){
 return code===2?'動画のIDが正しくありません。':code===5?'この動画はアプリ内のプレーヤーで再生できません。':code===100?'動画が見つかりません（削除または非公開）。':code===101||code===150?'この動画は投稿者が埋め込み再生を許可していないため、アプリ内では再生できません。':code===153?'YouTubeの埋め込み設定のエラーです（153）。':`YouTubeのエラーです（${code}）。`;
}

/** The player's states (YT.PlayerState). */
export const YT_STATE={unstarted:-1,ended:0,playing:1,paused:2,buffering:3,cued:5} as const;
export type FollowInput={
 /** The song plays (not counting in). */
 playing:boolean;
 /** Where the video should be now (seconds). */
 target:number;
 /** Where it is, and its state and length. */
 current:number;state:number;duration:number;
 /** A clock in milliseconds. */
 now:number;
};
export type FollowAction={play?:boolean;pause?:boolean;seek?:number};

/** Keeps the video on the song position. A seek makes YouTube buffer for a moment while the
 * song goes on, so seeks aim ahead by `lead` seconds, learned from where the video lands. */
export class YouTubeFollower{
 /** Drift tolerated before a seek (frequent seeks rebuffer and sound worse than a small lag). */
 static readonly TOLERANCE=.15;
 lead=.2;
 private lastSeek=-Infinity;private measuring=false;
 /** The last drift seen while playing (seconds, positive: the video is ahead). */
 drift:number|null=null;
 decide(i:FollowInput):FollowAction{
  const running=i.state===YT_STATE.playing||i.state===YT_STATE.buffering;
  if(!i.playing||i.target<0||i.duration>0&&i.target>=i.duration){
   this.drift=null;this.measuring=false;
   const parked=Math.max(0,Math.min(i.target,i.duration>0?i.duration:Infinity));
   if(running)return {pause:true};
   // Stopped: a paused video follows the cursor, so playback starts from the right frame.
   // (Only paused: from cued or unstarted, seekTo starts playback.)
   if(i.state===YT_STATE.paused&&Math.abs(i.current-parked)>.25&&i.now-this.lastSeek>300){this.lastSeek=i.now;return {seek:parked};}
   return {};
  }
  if(!running){this.lastSeek=i.now;this.measuring=true;return Math.abs(i.current-i.target)>.05?{seek:i.target+this.lead,play:true}:{play:true};}
  if(i.state===YT_STATE.buffering)return {};
  const drift=i.current-i.target;this.drift=drift;
  if(this.measuring&&i.now-this.lastSeek>800){
   // Where a seek landed tells how far ahead the next one should aim (a jump of the song
   // since then is not a landing error).
   this.measuring=false;if(Math.abs(drift)<.5)this.lead=Math.max(0,Math.min(1.5,this.lead-drift*.7));
  }
  // Small drifts are corrected at most every 1.5 s (seeks rebuffer); a jump (loop wrap, seek)
  // at once.
  if(Math.abs(drift)>YouTubeFollower.TOLERANCE&&(i.now-this.lastSeek>1500||Math.abs(drift)>.5&&i.now-this.lastSeek>300)){this.lastSeek=i.now;this.measuring=true;return {seek:i.target+this.lead};}
  return {};
 }
}

type YTPlayer={
 playVideo():void;pauseVideo():void;seekTo(seconds:number,allowSeekAhead:boolean):void;cueVideoById(id:string):void;
 getCurrentTime():number;getDuration():number;getPlayerState():number;getAvailablePlaybackRates():number[];setPlaybackRate(rate:number):void;getPlaybackRate():number;
 setVolume(volume:number):void;mute():void;unMute():void;destroy():void;getVideoData?():{title?:string};
};
type YTNamespace={Player:new(element:HTMLElement,options:unknown)=>YTPlayer};
let api:Promise<YTNamespace>|undefined;
/** Loads the IFrame Player API once. */
function loadApi(){
 return api??=new Promise<YTNamespace>((resolve,reject)=>{
  const w=window as unknown as {YT?:YTNamespace&{loaded?:number};onYouTubeIframeAPIReady?:()=>void};
  if(w.YT?.Player&&w.YT.loaded){resolve(w.YT);return;}
  const previous=w.onYouTubeIframeAPIReady;
  w.onYouTubeIframeAPIReady=()=>{previous?.();resolve(w.YT!);};
  const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.async=true;
  script.onerror=()=>{api=undefined;reject(new Error('YouTubeに接続できません（インターネット接続を確認してください）。'));};
  document.head.append(script);
  setTimeout(()=>{if(!w.YT?.Player){api=undefined;reject(new Error('YouTubeの読み込みがタイムアウトしました。'));}},20000);
 });
}

/** The embedded player and its following of the song. */
export class YouTubeBacking{
 private player:YTPlayer|undefined;private ready:Promise<YTPlayer>|undefined;private videoId='';
 readonly follower=new YouTubeFollower();
 /** The rate set on the player and the one the song wanted. */
 rate=1;wanted=1;
 error='';
 onChange=()=>{};
 constructor(private host:HTMLElement){}
 get loaded(){return this.videoId;}
 title(){try{return this.player?.getVideoData?.()?.title??'';}catch{return '';}}
 duration(){try{return this.player?.getDuration()??0;}catch{return 0;}}
 /** Puts a video in the player (cued: it starts with the song). */
 load(videoId:string){
  if(videoId===this.videoId&&this.ready)return this.ready;
  this.videoId=videoId;this.error='';
  if(this.player){const player=this.player;player.cueVideoById(videoId);this.onChange();return this.ready=Promise.resolve(player);}
  const element=document.createElement('div');this.host.replaceChildren(element);
  this.ready=loadApi().then(YT=>new Promise<YTPlayer>((resolve,reject)=>{
   const player=new YT.Player(element,{width:340,height:200,videoId,playerVars:{playsinline:1,rel:0,origin:location.origin},events:{
    onReady:()=>{this.player=player;resolve(player);this.onChange();},
    onError:(e:{data:number})=>{this.error=youTubeError(e.data);this.onChange();reject(new Error(this.error));},
    onStateChange:()=>this.onChange(),
   }});
  }));
  this.ready.catch(()=>{});
  return this.ready;
 }
 unload(){this.videoId='';this.ready=undefined;this.volumeSet='';try{this.player?.destroy();}catch{}this.player=undefined;this.host.replaceChildren();this.follower.drift=null;}
 private volumeSet='';
 volume(gain:number,mute:boolean){const p=this.player,key=`${mute}:${Math.round(Math.max(0,Math.min(1,gain))*100)}`;if(!p||key===this.volumeSet)return;this.volumeSet=key;if(mute)p.mute();else{p.unMute();p.setVolume(Math.round(Math.max(0,Math.min(1,gain))*100));}}
 /** Its own transport (not following the song). */
 playing(){try{const s=this.player?.getPlayerState();return s===YT_STATE.playing||s===YT_STATE.buffering;}catch{return false;}}
 currentTime(){try{return this.player?.getCurrentTime()??0;}catch{return 0;}}
 toggle(){const p=this.player;if(!p||this.error)return;if(this.playing())p.pauseVideo();else p.playVideo();}
 pause(){try{if(this.playing())this.player?.pauseVideo();}catch{}}
 seek(seconds:number){try{this.player?.seekTo(Math.max(0,seconds),true);}catch{}}
 setRate(speed:number){const p=this.player;if(!p)return;this.wanted=speed;const rate=nearestRate(p.getAvailablePlaybackRates(),speed);if(Math.abs(p.getPlaybackRate()-rate)>1e-3)p.setPlaybackRate(rate);this.rate=rate;}
 /** One step of following: `target` is where the video should be, `speed` its rate. */
 follow(playing:boolean,target:number,speed:number){
  const p=this.player;if(!p||this.error)return;
  this.wanted=speed;
  if(Math.abs(p.getPlaybackRate()-speed)>1e-3){const rate=nearestRate(p.getAvailablePlaybackRates(),speed);if(Math.abs(p.getPlaybackRate()-rate)>1e-3)p.setPlaybackRate(rate);this.rate=rate;}else this.rate=speed;
  const action=this.follower.decide({playing,target,current:p.getCurrentTime(),state:p.getPlayerState(),duration:p.getDuration(),now:performance.now()});
  if(action.pause)p.pauseVideo();
  if(action.seek!==undefined)p.seekTo(Math.max(0,action.seek),true);
  if(action.play)p.playVideo();
 }
}
