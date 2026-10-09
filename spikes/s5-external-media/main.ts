// Spike S5: alphaTab PlayerMode.EnabledExternalMedia without a backing track.
// A fake engine reports song time; we record what alphaTab does with it.
import * as at from '@coderline/alphatab';
const base=new URL('../../public/alphatab/',location.href).href;
const log:any={handler:[],positions:[],beats:[],midi:null,errors:[]};
(window as any).s5=log;
const api=new at.AlphaTabApi(document.getElementById('score')!,{
 core:{fontDirectory:base+'font/',useWorkers:false,includeNoteBounds:true},
 player:{playerMode:at.PlayerMode.EnabledExternalMedia,enableCursor:true,enableUserInteraction:false,scrollMode:at.ScrollMode.Off}
} as any);
(window as any).api=api;
let clock=0,running=false,rate=1,last=0;
const handler={
 get backingTrackDuration(){return log.endTime??0;},
 get playbackRate(){return rate;},set playbackRate(v:number){rate=v;log.handler.push(['rate',v]);},
 masterVolume:1,
 seekTo(t:number){clock=t;log.handler.push(['seek',Math.round(t)]);},
 play(){running=true;last=performance.now();log.handler.push(['play']);},
 pause(){running=false;log.handler.push(['pause']);},
};
api.error.on(e=>log.errors.push(String(e)));
api.midiLoad.on(m=>{log.midi={events:m.tracks.reduce((n:number,t:any)=>n+t.events.length,0)+(m.events?.length??0),division:m.division};});
api.playerReady.on(()=>{log.ready=true;});
api.playerPositionChanged.on(e=>{log.positions.push([Math.round(e.currentTime),e.currentTick,Math.round(e.endTime),e.isSeek]);log.endTime=e.endTime;});
api.playedBeatChanged.on(b=>log.beats.push(b.absolutePlaybackStart));
api.playerStateChanged.on(e=>log.handler.push(['state',e.state,e.stopped]));
api.renderFinished.on(()=>{log.rendered=true;});
(api.player as any).output; 
const attach=()=>{const out=(api as any).player?.output??(api as any)._player?.instance?.output;if(out&&!out.handler){out.handler=handler;log.attached=true;}};
setInterval(()=>{attach();if(running){const now=performance.now();clock+=now-last;/* alphaTab time axis is already scaled by playbackSpeed */last=now;((api as any).player.output).updatePosition(clock);}},20);
// Demo score plus a tempo change (120 -> 60) at bar 3 to check time<->tick mapping.
import('../../src/score').then(({demoScore})=>{const score=demoScore();score.masterBars[0].tempoAutomations=[at.model.Automation.buildTempoAutomation(false,0,120,0)];score.masterBars[2].tempoAutomations=[at.model.Automation.buildTempoAutomation(false,0,60,0)];score.finish(api.settings);api.renderScore(score,[0]);});
