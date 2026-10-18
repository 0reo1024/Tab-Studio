import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { demoScore, serialize, deserialize, project, readProject, importGuitarPro, beatQ, voiceQ } from '../src/score';
import { importTg } from '../src/tg-reader';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
const file=(name:string)=>new Uint8Array(readFileSync(new URL(`./fixtures/${name}`,import.meta.url)));

test('demo score and native project preserve guitar fingering and rhythm',()=>{
  const s=demoScore();assert.equal(s.masterBars.length,4);assert.equal(s.tracks.length,1);
  for(const bar of s.tracks[0].staves[0].bars)assert.ok(Math.abs(voiceQ(bar.voices[0])-4)<1e-8);
  const r=readProject(project(s,'demo',[])).score;assert.deepEqual(JSON.parse(serialize(r)),JSON.parse(serialize(s)));
});
for(const ext of ['gp3','gp4','gp5','gpx','gp'])test(`official alphaTab fixture loads: ${ext}`,()=>{
  const s=importGuitarPro(file(`notes.${ext}`));assert.ok(s.masterBars.length>0);assert.ok(s.tracks.length>0);
  const notes=s.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(b=>b.notes)))));
  assert.ok(notes.length>0);assert.ok(notes.every(n=>n.fret>=0||!n.isStringed));
  const rt=deserialize(serialize(s));assert.equal(rt.masterBars.length,s.masterBars.length);
});
for(const version of ['v15','v2'])test(`TG ${version} preserves strings, tempo, effects and duration`,()=>{
  const {score:s}=importTg(file(`tg-${version}.tg`));assert.equal(s.title,'TG Reader Test');assert.equal(s.tracks.length,1);assert.equal(s.masterBars.length,2);
  const first=s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];assert.equal(first.fret,3);assert.equal(first.string,6);assert.equal(first.realValue,67);assert.equal(first.isPalmMute,true);
  assert.equal(s.tempo,120);assert.equal(s.masterBars[1].timeSignatureNumerator,6);assert.equal(s.masterBars[1].timeSignatureDenominator,8);
  assert.equal(s.masterBars[1].tempoAutomations[0].value,version==='v2'?45:90);
  assert.equal(voiceQ(s.tracks[0].staves[0].bars[0].voices[0]),4);assert.equal(voiceQ(s.tracks[0].staves[0].bars[1].voices[0]),3);
});
test('truncated binary TG fails explicitly instead of inventing notes',()=>assert.throws(()=>importTg(file('tg-v15.tg').slice(0,160)),/途中/));
test('editing fret is preserved on save/reopen, including imported effects',()=>{
  const s=importTg(file('tg-v15.tg')).score;s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret=12;
  const reopened=readProject(project(s,'tg-v15.tg',[])).score;const n=reopened.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];assert.equal(n.fret,12);assert.equal(n.realValue,76);assert.ok(n.isPalmMute);
});
test('triplets and dotted durations have expected quarter-unit lengths',()=>{
  const b=demoScore().tracks[0].staves[0].bars[0].voices[0].beats[0];b.duration=8;b.dots=0;b.tupletNumerator=3;b.tupletDenominator=2;assert.ok(Math.abs(beatQ(b)*3-1)<1e-10);
  b.duration=4;b.dots=1;b.tupletNumerator=b.tupletDenominator=1;assert.equal(beatQ(b),1.5);
});

import * as at from '@coderline/alphatab';
import { resizeBeat, splitFullRest, setFret } from '../src/editor';
import { hitTab, tabBounds } from '../src/hit-test';
import { installPlaybackFrame, playbackFrameArea, smoothStep } from '../src/playback-ui';
import { clickWave } from '../src/metronome';
function makeScore(tex:string){return at.importer.ScoreLoader.loadAlphaTex(tex,new at.Settings());}
function renderBounds(s:at.model.Score){const settings=new at.Settings();settings.core.engine='svg';settings.core.includeNoteBounds=true;settings.core.useWorkers=false;settings.core.enableLazyLoading=false;const r=new at.rendering.ScoreRenderer(settings);r.width=1060;r.renderScore(s,[0]);assert.ok(r.boundsLookup?.isFinished);return r.boundsLookup!;}
test('click empty string line and a rest returns correct TAB editing position',()=>{
  const s=makeScore('. :4 3.1 r r r'),bounds=renderBounds(s),beat=s.tracks[0].staves[0].bars[0].voices[0].beats[1],bb=tabBounds(bounds,beat)!,r=bb.barBounds.visualBounds;
  for(let string=1;string<=6;string++){const h=hitTab(bounds,bb.onNotesX,r.y+(6-string)*r.h/5);assert.equal(h?.beat,beat);assert.equal(h?.string,string);}
  assert.equal(hitTab(bounds,bb.onNotesX,r.y-100),null);
  // Browser-worker JSON omits the direct bar link. It must still hit empty TAB strings.
  for(const system of bounds.staffSystems)for(const master of system.bars)for(const bar of master.bars)(bar as unknown as {bar:undefined}).bar=undefined;
  const hit=hitTab(bounds,bb.onNotesX,r.y);assert.equal(hit?.beat,beat);assert.equal(hit?.string,6);
});
test('duration growth consumes adjacent rests and preserves following note onset',()=>{
  const s=makeScore('. :4 3.1 r 5.1 r'),v=s.tracks[0].staves[0].bars[0].voices[0],b=v.beats[0];resizeBeat(b,2,0,1,1);
  const rebuilt=deserialize(serialize(s)),out=rebuilt.tracks[0].staves[0].bars[0].voices[0];assert.equal(out.beats[1].notes[0].fret,5);assert.equal(out.beats[1].playbackStart,1920);assert.equal(voiceQ(out),4);
});
test('duration shrink inserts rests rather than moving following note earlier',()=>{
  const s=makeScore('. :2 3.1 5.1'),b=s.tracks[0].staves[0].bars[0].voices[0].beats[0];resizeBeat(b,4,0,1,1);const v=deserialize(serialize(s)).tracks[0].staves[0].bars[0].voices[0];assert.equal(v.beats[2].notes[0].fret,5);assert.equal(v.beats[2].playbackStart,1920);assert.equal(voiceQ(v),4);
});
test('growing into an existing following note is rejected without losing the note',()=>{
  const s=makeScore('. :4 3.1 5.1 r r'),b=s.tracks[0].staves[0].bars[0].voices[0].beats[0],before=serialize(s);assert.throws(()=>resizeBeat(b,2,0,1,1),/休符/);assert.equal(serialize(s),before);
});
test('whole-measure rest splits into metrical beats and supports empty-string note insertion',()=>{
  const s=makeScore('\\ts 6 8 . :1 r'),v=s.tracks[0].staves[0].bars[0].voices[0];assert.ok(splitFullRest(v.beats[0]));assert.equal(v.beats.length,6);setFret(v.beats[3],2,12);const out=deserialize(serialize(s)).tracks[0].staves[0].bars[0].voices[0];assert.equal(voiceQ(out),3);assert.equal(out.beats[3].notes[0].fret,12);assert.equal(out.beats[3].notes[0].string,2);
});
test('playback frame uses tempo-derived duration without overriding it or animating row jumps',()=>{
  const s=makeScore('. :4 3.1 r r r'),bounds=renderBounds(s),b=bounds.findBeat(s.tracks[0].staves[0].bars[0].voices[0].beats[0])!;let handler:NonNullable<at.AlphaTabApi['customCursorHandler']>;const calls:unknown[][]=[];const c={element:{style:{width:'',height:'',transform:'',transition:''},getBoundingClientRect:()=>({})},stopAnimation:()=>calls.push(['stop']),transitionToX:(d:number,x:number)=>calls.push(['move',d,x]),setBounds:(...a:number[])=>calls.push(['bounds',...a])};
  const mock={set customCursorHandler(h:NonNullable<at.AlphaTabApi['customCursorHandler']>){handler=h;}} as at.AlphaTabApi;installPlaybackFrame(mock);
  handler!.placeBeatCursor(c as never,b,100);handler!.transitionBeatCursor(c as never,b,100,200,375,at.midi.MidiTickLookupFindBeatResultCursorMode.ToNextBext);assert.equal(c.element.style.transition,'transform 375ms linear');assert.ok(c.element.style.transform.startsWith('translate(190px,'));assert.ok(!c.element.style.transform.includes('scale'));assert.equal(c.element.style.width,'20px');
  const before=calls.length;for(const m of b.barBounds.masterBarBounds.staffSystemBounds!.bars)for(const bar of m.bars)bar.visualBounds.y+=200;handler!.transitionBeatCursor(c as never,b,30,100,500,at.midi.MidiTickLookupFindBeatResultCursorMode.ToNextBext);assert.ok(calls.slice(before).some(a=>a[0]==='stop'));
});
test('a frozen playback frame ignores the rewind of a MIDI reload and keeps its place',()=>{
  const s=makeScore('. :4 3.1 r r r'),b=renderBounds(s).findBeat(s.tracks[0].staves[0].bars[0].voices[0].beats[0])!;let handler:NonNullable<at.AlphaTabApi['customCursorHandler']>;const c={element:{style:{width:'',height:'',transform:'',transition:''},getBoundingClientRect:()=>({})},stopAnimation:()=>{},transitionToX:()=>{},setBounds:()=>{}};
  const mock={set customCursorHandler(h:NonNullable<at.AlphaTabApi['customCursorHandler']>){handler=h;}} as at.AlphaTabApi;let frozen=false;const moved:unknown[]=[];installPlaybackFrame(mock,p=>moved.push(p),()=>false,()=>frozen);
  handler!.placeBeatCursor(c as never,b,300);const at300=c.element.style.transform;frozen=true;
  handler!.placeBeatCursor(c as never,b,10);handler!.transitionBeatCursor(c as never,b,10,50,100,at.midi.MidiTickLookupFindBeatResultCursorMode.ToNextBext);assert.equal(c.element.style.transform,at300);assert.equal(moved.length,1);
  frozen=false;handler!.placeBeatCursor(c as never,b,10);assert.notEqual(c.element.style.transform,at300);
});
test('different rhythms on two tracks share one playback frame area, including worker bounds',()=>{
 const s=makeScore('\\track "Lead" . :4 3.1 5.1 7.1 5.1 | 3.1 5.1 7.1 5.1 \\track "Rhythm" :8 r 0.6 r 2.5 r 0.6 r 3.5 | r 0.6 r 2.5 r 0.6 r 3.5');
 assert.equal(s.tracks.length,2);const settings=new at.Settings();settings.core.engine='svg';settings.core.useWorkers=false;settings.core.includeNoteBounds=true;
 const renderer=new at.rendering.ScoreRenderer(settings);renderer.width=1060;renderer.renderScore(s,[0,1]);const bounds=renderer.boundsLookup!;
 for(const system of bounds.staffSystems)for(const master of system.bars)for(const bar of master.bars)(bar as unknown as {bar:undefined}).bar=undefined;
 const first=bounds.findBeat(s.tracks[0].staves[0].bars[0].voices[0].beats[0])!,area=playbackFrameArea(first);
 for(const tr of s.tracks)for(const bar of tr.staves[0].bars)for(const beat of bar.voices[0].beats)assert.deepEqual(playbackFrameArea(bounds.findBeat(beat)!),area);
 assert.ok(area.h>150);
});
test('smooth scroll is frame-rate independent and never overshoots its target',()=>{
  const a=smoothStep(smoothStep(0,500,16),500,16),b=smoothStep(0,500,32);assert.ok(Math.abs(a-b)<1e-8);assert.ok(b>0&&b<500);assert.ok(smoothStep(500,0,16)>0);
});
test('four new metronome timbres are distinct, bounded PCM with stronger first beats',()=>{
  const waves=['wood','rim','hat','beep'].map(k=>{const a=clickWave(k as never,true,44100),b=clickWave(k as never,false,44100);assert.ok(a.every(v=>Number.isFinite(v)&&Math.abs(v)<=1));assert.ok(a.some(v=>Math.abs(v)>.1));assert.notDeepEqual(a,b);return a;});for(let i=1;i<waves.length;i++)assert.notDeepEqual(waves[0],waves[i]);
});
