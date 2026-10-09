// Tauri build: the native audio engine through its commands (P2-8a). Starts the engine
// (master muted so nothing is heard), loads an event list, plays, seeks, loops, and
// checks the published position. Usage: node scripts/tauri-audio-check.mjs [events.tsev]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import {settings,demoScore} from '../src/score.ts';
import {eventListFromMidi} from '../src/audio/event-list.ts';
import {launchTauri} from './tauri-app.mjs';
const score=demoScore(),midi=new at.midi.MidiFile();new at.midi.MidiFileGenerator(score,settings,new at.midi.AlphaSynthMidiFileHandler(midi)).generate();
const events=process.argv[2]?await fs.readFile(process.argv[2]):eventListFromMidi(midi);
const app=await launchTauri({dataDir:path.resolve(`test-results/tauri-audio-${Date.now()}`)});
try{
 const {page}=app;
 const invoke=(cmd,args)=>page.evaluate(([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args),[cmd,args]);
 const started=Date.now();
 const info=await invoke('audio_start');console.log('engine',info,'in',Date.now()-started,'ms');
 await invoke('audio_command',{request:{kind:'master',gain:0}});
 const loaded=await page.evaluate(b=>window.__TAURI_INTERNALS__.invoke('audio_load',new Uint8Array(b)),[...events]);console.log('loaded',loaded);
 const status=()=>invoke('audio_status');
 await invoke('audio_command',{request:{kind:'play'}});
 await page.waitForTimeout(1000);
 let s=await status();console.log('after 1s',s.position.toFixed(3),s.playing,s.peaks);
 assert.ok(s.playing&&s.position>0.8&&s.position<1.3,'position advances in real time');
 assert.ok(s.peaks.some(p=>p>0),'tracks sound (meters), master muted');
 await invoke('audio_command',{request:{kind:'seek',seconds:4}});await page.waitForTimeout(100);
 s=await status();assert.ok(s.position>=4&&s.position<4.3,'seek '+s.position);
 await invoke('audio_command',{request:{kind:'speed',value:0.5}});await page.waitForTimeout(1000);
 s=await status();assert.ok(s.position>4.35&&s.position<4.75,'half speed '+s.position);
 await invoke('audio_command',{request:{kind:'speed',value:1}});
 await invoke('audio_command',{request:{kind:'loop',start:1,end:1.5}});await invoke('audio_command',{request:{kind:'seek',seconds:1}});
 await page.waitForTimeout(1300);s=await status();assert.ok(s.wraps>=2&&s.position>=1&&s.position<1.5,'loop '+JSON.stringify(s));
 await invoke('audio_command',{request:{kind:'loop',start:null,end:null}});
 await invoke('audio_command',{request:{kind:'pause'}});await page.waitForTimeout(100);
 s=await status();const paused=s.position;await page.waitForTimeout(300);s=await status();assert.ok(!s.playing&&s.position===paused,'paused');
 await invoke('audio_command',{request:{kind:'metronome',enabled:true,sound:1,volume:0.6}});
 await invoke('audio_command',{request:{kind:'countIn',ticks:[[0,true],[0.25,false]],duration:0.5}});await page.waitForTimeout(150);
 s=await status();assert.ok(s.counting&&s.clickPeak>0,'counting '+JSON.stringify(s));
 await page.waitForTimeout(600);s=await status();assert.ok(s.playing&&!s.counting,'starts after the count');
 await invoke('audio_stop');
 assert.deepEqual(app.errors,[]);
 console.log('PASS tauri-audio-check');
}finally{await app.close();}
