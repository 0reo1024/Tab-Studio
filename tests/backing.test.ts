import test from 'node:test';
import assert from 'node:assert/strict';
import {nearestRate,youTubeId,YouTubeFollower,YT_STATE} from '../src/audio/youtube';
import {backingAudio,sanitizeBacking} from '../src/mixer-state';
import {demoScore,serialize,deserialize} from '../src/score';
import {exportTg} from '../src/tg-writer';
import {importTg} from '../src/tg-reader';
import {DOMParser} from '@xmldom/xmldom';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;

test('YouTube links of every kind give the video id; anything else is refused', ()=>{
 const id='dQw4w9WgXcQ';
 for(const link of [id,`https://www.youtube.com/watch?v=${id}&t=42s`,`youtube.com/watch?list=x&v=${id}`,`https://youtu.be/${id}?si=abc`,`https://m.youtube.com/watch?v=${id}`,`https://music.youtube.com/watch?v=${id}`,`https://www.youtube.com/embed/${id}`,`https://www.youtube.com/shorts/${id}`,`https://www.youtube.com/live/${id}`,`https://www.youtube-nocookie.com/embed/${id}`])
  assert.equal(youTubeId(link),id,link);
 for(const bad of ['','hello world','https://vimeo.com/123456789','https://www.youtube.com/watch?v=short','https://example.com/watch?v=dQw4w9WgXcQ'])assert.equal(youTubeId(bad),null,bad);
});

test('the YouTube rate is the nearest one the player offers', ()=>{
 const rates=[.25,.5,.75,1,1.25,1.5,1.75,2];
 assert.equal(nearestRate(rates,.8),.75);assert.equal(nearestRate(rates,.9),1);assert.equal(nearestRate(rates,1),1);assert.equal(nearestRate([],.5),1);
});

test('the follower starts, keeps and stops the video on the song position, aiming seeks ahead by what it learned', ()=>{
 const f=new YouTubeFollower(),base={duration:300,now:0};
 // Stopped: a cued or unstarted video is left alone (seekTo would start it playing); a paused
 // one is parked at the cursor.
 assert.deepEqual(f.decide({...base,playing:false,target:10,current:0,state:YT_STATE.cued}),{});
 assert.deepEqual(f.decide({...base,playing:false,target:10,current:0,state:YT_STATE.unstarted}),{});
 assert.deepEqual(f.decide({...base,playing:false,target:10,current:0,state:YT_STATE.paused}),{seek:10});
 // The song starts: seek a little ahead (YouTube buffers) and play.
 const start=f.decide({...base,playing:true,target:10,current:0,state:YT_STATE.paused,now:1000});
 assert.equal(start.play,true);assert.ok(start.seek!>10&&start.seek!<10.5);
 // Playing within tolerance: nothing to do. The landing teaches the lead: it was 120 ms late.
 assert.deepEqual(f.decide({...base,playing:true,target:12,current:11.88,state:YT_STATE.playing,now:2000}),{});
 assert.ok(f.lead>.2,'a late landing makes the next seek aim further ahead: '+f.lead);
 assert.ok(Math.abs(f.drift!+.12)<1e-9);
 // Drifted 400 ms behind: one seek, then none again for a while (no seek storms).
 const fix=f.decide({...base,playing:true,target:20,current:19.6,state:YT_STATE.playing,now:5000});
 assert.ok(fix.seek!>20);
 assert.deepEqual(f.decide({...base,playing:true,target:20.2,current:19.7,state:YT_STATE.playing,now:5500}),{});
 // A loop wrap (the song jumped back 4 s) is followed at once.
 assert.ok(f.decide({...base,playing:true,target:16,current:20,state:YT_STATE.playing,now:5900}).seek!>16);
 // Buffering: wait.
 assert.deepEqual(f.decide({...base,playing:true,target:21,current:20,state:YT_STATE.buffering,now:7000}),{});
 // Before the video's start (negative offset) it waits paused at 0; past its end it stops.
 assert.deepEqual(f.decide({...base,playing:true,target:-2,current:21,state:YT_STATE.playing,now:8000}),{pause:true});
 assert.deepEqual(f.decide({...base,playing:true,target:-1.9,current:21,state:YT_STATE.paused,now:8400}),{seek:0});
 assert.equal(f.decide({...base,playing:true,target:301,current:299,state:YT_STATE.playing,now:9000}).pause,true);
 // Paused: the video pauses.
 assert.equal(f.decide({...base,playing:false,target:30,current:30,state:YT_STATE.playing,now:10000}).pause,true);
});

test('backing settings are saved with the score and sanitized when read', ()=>{
 const score=demoScore();
 Object.assign(backingAudio(score),{source:'file',path:'C:\\Music\\take.mp3',name:'take.mp3',offset:2.35,gain:.8,semitones:-2,rate:1.004,solo:true});
 const again=deserialize(serialize(score));
 assert.deepEqual({...backingAudio(again)},{...backingAudio(score)});
 assert.deepEqual(sanitizeBacking({source:'youtube',videoId:'<script>',offset:'x',gain:9,semitones:40,rate:3}),{source:'none',offset:0,gain:2,mute:false,solo:false,semitones:12,rate:1.25,normalize:true,linked:false,speed:1});
 assert.equal(sanitizeBacking({source:'file'}).source,'none','a file source needs its path');
 // A score without backing settings writes none.
 assert.ok(!serialize(demoScore()).includes('studiobacking'));
});

test('backing settings survive the .tg file the app saves', ()=>{
 const score=demoScore();
 Object.assign(backingAudio(score),{source:'youtube',videoId:'M7lc1UVf-VE',title:'Video',offset:-1.25,gain:.5,mute:true,rate:.995});
 const again=importTg(exportTg(score,'Demo',[])).score;
 assert.deepEqual({...backingAudio(again)},{...backingAudio(score)});
});
