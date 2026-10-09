import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {serialize,settings} from '../src/score';
import {EditSnapshot,normalizeEdit,restoreScore,editData,excerptJson} from '../src/edit-snapshot';
import {cleanEditJson} from '../src/edit-json';
import {copyBeats,pasteBeats} from '../src/beat-clipboard';
const score=()=>at.importer.ScoreLoader.loadAlphaTex('\\track "Guitar" . :4 3.1{h} 5.1 7.1{sl} 9.1 | 9.1{t} 2.1 4.1 6.1 | 8.1 10.1 12.1 14.1 \\track "Bass" \\tuning G2 D2 A1 E1 . :1 3.4 | 5.4 | 7.4',settings);
test('object snapshots restore linked effects independently and reuse only the current revision',()=>{
 const s=score(),cache=new EditSnapshot(),before=cache.get(s);assert.equal(cache.get(s),before);
 const original=serialize(s);s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret=12;cache.invalidate();assert.notEqual(cache.get(s),before);
 const restored=restoreScore(before);assert.equal(serialize(restored),original);restored.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret=20;assert.equal(serialize(restoreScore(before)),original);
 const replacement=restoreScore(before);assert.equal(serialize(restoreScore(cache.get(replacement))),original);cache.set(replacement,before,false);assert.equal(cache.get(replacement),before);
});
test('map normalization repairs deletion links and pads a newly added voice',()=>{
 const s=score(),bar=s.tracks[0].staves[0].bars[0];bar.voices[0].beats[1].notes=[];const voice=new at.model.Voice(),rest=new at.model.Beat();rest.duration=at.model.Duration.Whole;voice.addBeat(rest);bar.addVoice(voice);
 const normalized=normalizeEdit(s);assert.equal(normalized.score.tracks[0].staves[0].bars[0].voices[0].beats[1].isRest,true);assert.ok(normalized.score.tracks[0].staves[0].bars.every(b=>b.voices.length===2));assert.doesNotThrow(()=>restoreScore(normalized.data));assert.doesNotThrow(()=>normalizeEdit(normalized.score));
});
test('plain edit objects match JSON conversion and selective excerpts preserve metadata without modifying the source',()=>{
 const s=score(),before=serialize(s);assert.deepEqual(editData(s),JSON.parse(before));const excerpt=excerptJson(s,1,2,1);assert.equal(excerpt.masterbars.length,2);assert.equal(excerpt.tracks.length,1);assert.equal(excerpt.tracks[0].name,'Bass');assert.equal(excerpt.tracks[0].staves[0].bars.length,2);assert.equal(excerpt.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret,5);assert.equal(serialize(s),before);
 const all=excerptJson(s,1,1,null);assert.equal(all.tracks.length,2);assert.equal(all.tracks[0].staves[0].bars.length,1);
});
test('copying a local phrase does not inspect or reject an unrelated overflowing bar',()=>{
 const s=score(),bar=s.tracks[0].staves[0].bars[2];bar.voices[0].beats[0].duration=at.model.Duration.Whole;const point={track:0,staff:0,voice:0,bar:0,beat:0};const clip=copyBeats(s,{anchor:point,focus:{...point,beat:1}});assert.equal(clip.count,2);assert.equal(clip.length,2);assert.deepEqual(clip.events.map(e=>e.raw.notes[0].fret),[3,5]);
});
test('large insert sweep keeps every shifted onset and unchanged track aligned',()=>{
 const notes=Array(100).fill(':16 1.1 2.1 3.1 4.1 5.1 6.1 7.1 8.1 9.1 10.1 11.1 12.1 13.1 14.1 15.1 16.1').join(' | '),s=at.importer.ScoreLoader.loadAlphaTex('. '+notes,settings),p={track:0,staff:0,voice:0,bar:1,beat:0},clip=copyBeats(s,{anchor:{...p,bar:0},focus:{...p,bar:0,beat:15}}),original=serialize(s),result=pasteBeats(s,clip,p,true).score;
 assert.equal(result.masterBars.length,101);for(let i=0;i<101;i++)assert.deepEqual(result.tracks[0].staves[0].bars[i].voices[0].beats.map(b=>b.notes[0].fret),Array.from({length:16},(_,k)=>k+1));assert.equal(serialize(s),original);assert.equal(new Set(result.tracks[0].staves[0].bars.flatMap(b=>b.voices[0].beats.flatMap(b=>b.notes.map(n=>n.id)))).size,1616);
});
test('map relationship cleanup does not remove numeric chord keys',()=>{const data=new Map<any,any>([[1,new Map<string,any>([['tieoriginnoteid',123],['ishammerpullorigin',true],['id',45]])]]);cleanEditJson(data,true);assert.equal(data.get(1).has('tieoriginnoteid'),false);assert.equal(data.get(1).has('id'),false);assert.equal(data.get(1).get('ishammerpullorigin'),true);});
test('history shares unchanged track data while retaining separate edited notes',()=>{
 const s=score(),cache=new EditSnapshot(),before=cache.get(s),tracks=before!.get('tracks') as Map<string,any>[];s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret=12;cache.invalidate();const next=cache.get(s),after=next!.get('tracks') as Map<string,any>[];assert.equal(after[1],tracks[1]);assert.notEqual(after[0],tracks[0]);assert.equal(restoreScore(before).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret,3);assert.equal(restoreScore(next).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret,12);
});
test('a local paste assigns fresh IDs only to rebuilt bars and keeps unrelated note identities',()=>{const s=score(),p={track:0,staff:0,voice:0,bar:0,beat:0},clip=copyBeats(s,{anchor:p,focus:{...p,beat:1}}),result=pasteBeats(s,clip,{...p,bar:2}).score;assert.equal(result.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0].id,s.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0].id);assert.equal(result.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].id,s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].id);assert.notEqual(result.tracks[0].staves[0].bars[2].voices[0].beats[0].notes[0].id,pasteBeats(s,clip,{...p,bar:2}).score.tracks[0].staves[0].bars[2].voices[0].beats[0].notes[0].id);});
test('track header patches refresh playback and audio settings while sharing every staff',async()=>{
 const {trackAudio}=await import('../src/mixer-state');
 const s=score(),cache=new EditSnapshot(),before=cache.get(s),staves=(d:any,i:number)=>d.get('tracks')[i].get('staves');
 s.tracks[1].playbackInfo.isMute=true;s.tracks[1].playbackInfo.volume=5;s.tracks[0].name='Lead';trackAudio(s.tracks[0]).reverb=!trackAudio(s.tracks[0]).reverb;
 cache.patchTracks(s);const next=cache.get(s);
 assert.equal(staves(next,0),staves(before,0));assert.equal(staves(next,1),staves(before,1));
 const plain=(v:unknown)=>JSON.parse(JSON.stringify(v,(_k,x)=>x instanceof Map?Object.fromEntries(x):x));
 assert.deepEqual(plain(next),editData(s));assert.equal(restoreScore(before).tracks[1].playbackInfo.isMute,false);
});
