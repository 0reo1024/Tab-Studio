import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,readSettings,keyCombo,bindingError,shortcutCommand} from '../src/app-settings';
import {duplicateTrack,addTrack,removeTrack} from '../src/score-operations';
import {demoScore,serialize} from '../src/score';
import {ScoreFollower} from '../src/playback-ui';
test('settings retain false choices, themes and bindings across storage and reject damaged data',()=>{
 const settings=defaultSettings();assert.equal(bindingError(settings.shortcuts),'');settings.follow=false;settings.preview=false;settings.startup='home';settings.theme='paper';settings.notation='both';settings.zoom=1.25;settings.shortcuts.play='F6';assert.deepEqual(readSettings(JSON.stringify(settings)),settings);assert.deepEqual(readSettings(JSON.stringify({...settings,theme:'sand'})),{...settings,theme:'graphite'});assert.equal(shortcutCommand(settings.shortcuts,'Space'),undefined);assert.equal(shortcutCommand(settings.shortcuts,'F6'),'play');assert.deepEqual(readSettings('{invalid'),defaultSettings());assert.equal(readSettings('{"zoom":999,"theme":"other","follow":"no"}').zoom,1);
});
test('bindings reject duplicate commands and preserve numeric and arrow entry',()=>{
 const keys=defaultSettings().shortcuts;assert.match(bindingError({...keys,stop:keys.play}),/同じキー/);for(const combo of ['3','Left','Alt+F4'])assert.ok(bindingError({...keys,play:combo}));assert.equal(bindingError({...keys,play:'F6',stop:'F7'}),'');assert.equal(bindingError({...keys,play:''}),'');assert.equal(keyCombo({code:'Space',key:' ',ctrlKey:true,metaKey:false,shiftKey:false,altKey:false}),'Ctrl+Space');assert.equal(keyCombo({code:'KeyS',key:'S',ctrlKey:true,metaKey:false,shiftKey:true,altKey:false}),'Ctrl+Shift+S');assert.equal(keyCombo({code:'NumpadMultiply',key:'*',ctrlKey:false,metaKey:false,shiftKey:false,altKey:false}),'Shift+8');assert.equal(keyCombo({code:'ArrowRight',key:'ArrowRight',ctrlKey:false,metaKey:false,shiftKey:true,altKey:false}),'Shift+Right');
});
test('preview defaults audition changed digits and clicks; legacy preferences and timing survive restart',()=>{
 assert.equal(defaultSettings().previewTiming,'input');assert.equal(defaultSettings().previewClick,true);
 const legacy=readSettings('{"preview":false}');assert.equal(legacy.preview,false);assert.equal(legacy.previewTiming,'input');assert.equal(legacy.previewClick,true);
 const custom={...defaultSettings(),previewTiming:'commit' as const,previewClick:false};assert.deepEqual(readSettings(JSON.stringify(custom)),custom);
 assert.equal(readSettings('{"previewTiming":"unknown","previewClick":"false"}').previewTiming,'input');assert.equal(readSettings('{"previewClick":"false"}').previewClick,true);
});
test('track duplication keeps notes and effects independent and assigns distinct melodic channels',()=>{
 const original=demoScore(),note=original.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];note.isPalmMute=true;const before=serialize(original),copy=duplicateTrack(original,0);assert.equal(copy.tracks.length,2);assert.equal(copy.tracks[1].name,original.tracks[0].name+' コピー');const copied=copy.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0];assert.equal(copied.fret,note.fret);assert.equal(copied.isPalmMute,true);assert.notEqual(copied.id,copy.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].id);assert.notEqual(copy.tracks[0].playbackInfo.primaryChannel,copy.tracks[1].playbackInfo.primaryChannel);copied.fret=29;assert.notEqual(copy.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret,29);assert.equal(serialize(original),before);assert.equal(removeTrack(copy,1).tracks.length,1);assert.throws(()=>removeTrack(original,0),/最低1/);
});
test('duplication preserves keyboard staves and percussion channel without sharing note IDs',()=>{
 let score=addTrack(demoScore(),'keyboard');score=duplicateTrack(score,1);assert.equal(score.tracks[2].staves.length,2);assert.notEqual(score.tracks[1].playbackInfo.primaryChannel,score.tracks[2].playbackInfo.primaryChannel);score=addTrack(score,'drums');score=duplicateTrack(score,3);assert.ok(score.tracks[4].isPercussion);assert.equal(score.tracks[4].playbackInfo.primaryChannel,9);assert.equal(score.tracks[3].playbackInfo.primaryChannel,9);
});
test('following actually scrolls when enabled, stays fixed when disabled and permits a manual jump',()=>{
 const oldRequest=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame,frames=new Map<number,FrameRequestCallback>();let counter=0,time=performance.now(),enabled=false;
 globalThis.requestAnimationFrame=fn=>{frames.set(++counter,fn);return counter;};globalThis.cancelAnimationFrame=id=>{frames.delete(id);};
 const viewport={scrollTop:0,scrollLeft:0,scrollHeight:3000,scrollWidth:1200,clientHeight:600,clientWidth:1000,addEventListener(){},getBoundingClientRect:()=>({top:0,left:0,right:1000,bottom:600,height:600,width:1000})};
 const cursor={getBoundingClientRect:()=>({top:1000-viewport.scrollTop,bottom:1089-viewport.scrollTop,height:89,left:200,right:220})},sheet={querySelector:()=>cursor};
 const advance=()=>{for(let i=0;i<100;i++){const current=[...frames];frames.clear();time+=16;for(const [,fn]of current)fn(time);}};
 try{const follower=new ScoreFollower(viewport as unknown as HTMLElement,sheet as unknown as HTMLElement,()=>enabled);follower.setPlaying(true);advance();assert.equal(viewport.scrollTop,0);enabled=true;advance();assert.ok(viewport.scrollTop>500);enabled=false;viewport.scrollTop=0;advance();assert.equal(viewport.scrollTop,0);follower.focus();advance();assert.ok(viewport.scrollTop>500);follower.setPlaying(false);}finally{globalThis.requestAnimationFrame=oldRequest;globalThis.cancelAnimationFrame=oldCancel;}
});
test('instrument recording is off by default and the choice survives restart',()=>{
 assert.equal(defaultSettings().liveRecording,false);assert.equal(readSettings(JSON.stringify({...defaultSettings(),liveRecording:true})).liveRecording,true);assert.equal(readSettings('{"liveRecording":"yes"}').liveRecording,false);
});
