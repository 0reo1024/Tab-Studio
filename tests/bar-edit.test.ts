import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {serialize,settings} from '../src/score';
import {EditSnapshot,normalizeEdit,restoreScore,editData} from '../src/edit-snapshot';
import {canRefinishBar,refinishBar,restoreBars} from '../src/bar-edit';
import {resizeBeat,rests} from '../src/editor';
const tex='\\track "Guitar" . :4 3.1 5.1 7.1 9.1 | :8 3.1 5.1 7.1 9.1 r r :4 (3.2 5.3) | :4 {tu 3} 3.1 {tu 3} 5.1 {tu 3} 7.1 :2 9.1 | :4 3.1 r r r \\track "Bass" \\tuning G2 D2 A1 E1 . :1 3.4 | 5.4 | 7.4 | 8.4';
const fresh=()=>at.importer.ScoreLoader.loadAlphaTex(tex,settings);
const beatAt=(s:at.model.Score,bar:number,beat:number)=>s.tracks[0].staves[0].bars[bar].voices[0].beats[beat];
/** Everything finish() derives, independent of object identity and note IDs. */
function derived(s:at.model.Score){
 return s.tracks.map(t=>t.staves.map(st=>st.bars.map(bar=>({empty:bar.isEmpty,restOnly:bar.isRestOnly,shortest:(bar as any).shortestDuration,filled:[...bar.filledVoices],voices:bar.voices.map(v=>({empty:v.isEmpty,restOnly:v.isRestOnly,shortest:(v as any).shortestDuration,beats:v.beats.map(b=>({i:b.index,ps:b.playbackStart,pd:b.playbackDuration,ds:b.displayStart,dd:b.displayDuration,prev:b.previousBeat?`${b.previousBeat.voice.bar.index}:${b.previousBeat.index}`:null,next:b.nextBeat?`${b.nextBeat.voice.bar.index}:${b.nextBeat.index}`:null,tuplet:b.tupletGroup?b.tupletGroup.beats.map(x=>x.index):null,min:b.minNote?.string??null,max:b.maxNote?.string??null,lookup:[...b.noteValueLookup.keys()].sort()}))}))}))));
}
const stripIds=(json:string)=>JSON.stringify(JSON.parse(json,(key,value)=>key==='id'?undefined:value));
const edits:[string,number,number,(b:at.model.Beat)=>void][]=[
 ['shorten',0,1,b=>resizeBeat(b,8,0,1,1)],
 ['lengthen into rests',1,3,b=>resizeBeat(b,4,0,1,1)],
 ['dot',3,0,b=>resizeBeat(b,4,1,1,1)],
 ['triplet',0,2,b=>resizeBeat(b,b.duration,b.dots,3,2)],
 ['quintuplet',3,0,b=>resizeBeat(b,16,0,5,4)],
 ['shorten inside tuplet',2,0,b=>resizeBeat(b,8,0,3,2)],
 ['insert rest',1,0,b=>{const v=b.voice,rest=v.beats.find(x=>x.isRest)!,q=0.5;v.beats.splice(v.beats.indexOf(rest),1,...rests(0.5-q));v.beats.splice(0,0,...rests(q));}],
 ['clean beat',1,6,b=>{b.notes=[];b.isEmpty=false;}],
 ['delete chord note',1,6,b=>{b.notes=b.notes.filter(n=>n.string!==2);b.isEmpty=false;}],
 ['stroke',0,0,b=>{b.pickStroke=at.model.PickStroke.Down;}],
 ['dynamics',0,3,b=>{b.dynamics=at.model.DynamicValue.FF;}],
];
for(const [name,bar,beat,edit]of edits)test(`bar-local refinish matches whole-song normalization: ${name}`,()=>{
 const local=fresh(),normal=fresh();
 const target=beatAt(local,bar,beat).voice.bar;assert.ok(canRefinishBar(target));
 const snapshot=new EditSnapshot(),before=snapshot.get(local);
 edit(beatAt(local,bar,beat));for(const b of target.voices[0].beats)b.voice=target.voices[0];refinishBar(target);snapshot.patchBar(local,target);
 const voice=normal.tracks[0].staves[0].bars[bar].voices[0];edit(beatAt(normal,bar,beat));for(const b of voice.beats)b.voice=voice;const normalized=normalizeEdit(normal).score;
 assert.equal(stripIds(serialize(local)),stripIds(serialize(normalized)));
 assert.deepEqual(derived(local),derived(normalized));
 // The patched snapshot equals a full re-serialization and leaves history untouched.
 assert.deepEqual(JSON.parse(JSON.stringify(snapshot.get(local),(_k,v)=>v instanceof Map?Object.fromEntries(v):v)),editData(local));
 assert.equal(serialize(restoreScore(before)),serialize(fresh()));
 // Unchanged measures keep sharing their snapshot nodes.
 const tracks=(m:any)=>m.get('tracks');assert.equal(tracks(snapshot.get(local))[1],tracks(before)[1]);
});
test('linked or pedal measures are left to whole-song normalization',()=>{
 const s=at.importer.ScoreLoader.loadAlphaTex('. :4 3.1 3.1{-} 5.1{h} 7.1 | 3.1 5.1 7.1 9.1{lr} | 3.1 5.1 7.1 9.1 | 3.1 5.1 7.1 9.1{sl} | 1.1 2.1 3.1 4.1',settings),bars=s.tracks[0].staves[0].bars;
 assert.equal(canRefinishBar(bars[0]),false,'tie and hammer-on');
 assert.equal(canRefinishBar(bars[1]),false,'let ring');
 assert.equal(canRefinishBar(bars[2]),false,'neighbours a let-ring measure');
 assert.equal(canRefinishBar(bars[3]),false,'slide origin');
 assert.equal(canRefinishBar(bars[4]),false,'slide target');
 const plain=at.importer.ScoreLoader.loadAlphaTex('. :4 1.1 2.1 3.1 4.1 | 1.1 2.1 3.1 4.1',settings);assert.equal(canRefinishBar(plain.tracks[0].staves[0].bars[1]),true);
});
for(const [name,bar,beat,edit]of edits)test(`bar-local undo and redo swap only the edited measure: ${name}`,()=>{
 const live=fresh(),snapshot=new EditSnapshot(),before=snapshot.get(live),original=stripIds(serialize(live)),originalDerived=derived(live);
 const target=beatAt(live,bar,beat).voice.bar;edit(beatAt(live,bar,beat));for(const b of target.voices[0].beats)b.voice=target.voices[0];refinishBar(target);snapshot.patchBar(live,target);
 const after=snapshot.get(live),edited=stripIds(serialize(live)),editedDerived=derived(live),untouched=live.tracks[1].staves[0].bars[bar];
 assert.equal(restoreBars(live,before,[[0,0,bar]]),true);
 assert.equal(stripIds(serialize(live)),original);assert.deepEqual(derived(live),originalDerived);assert.equal(live.tracks[1].staves[0].bars[bar],untouched,'other tracks keep their objects');
 assert.equal(restoreBars(live,after,[[0,0,bar]]),true);assert.equal(stripIds(serialize(live)),edited);assert.deepEqual(derived(live),editedDerived);
});
test('bar-local undo declines linked measures without touching the score',()=>{
 const s=at.importer.ScoreLoader.loadAlphaTex('\\track "G" . :4 3.1 3.1{-} 5.1 7.1 | 1.1 2.1 3.1 4.1',settings),data=new EditSnapshot().get(s),before=serialize(s);
 assert.equal(restoreBars(s,data,[[0,0,1],[0,0,0]]),false);assert.equal(serialize(s),before);
});
test('making a beat a triplet fills its group with triplet rests and undoing it restores plain time',()=>{
 const shape=(s:at.model.Score)=>s.tracks[0].staves[0].bars[0].voices[0].beats.map(b=>`${b.duration}${b.hasTuplet?`/${b.tupletNumerator}`:''}${b.isRest?'r':''}`);
 const s=at.importer.ScoreLoader.loadAlphaTex('. :8 3.1 r :4 r r r',settings),b=s.tracks[0].staves[0].bars[0].voices[0].beats[0];
 resizeBeat(b,8,0,3,2);let n=normalizeEdit(s).score;assert.deepEqual(shape(n),['8/3','8/3r','8/3r','4r','4r','4r']);
 const t=n.tracks[0].staves[0].bars[0].voices[0].beats[0];resizeBeat(t,8,0,1,1);n=normalizeEdit(n).score;assert.deepEqual(shape(n),['8','8r','4r','4r','4r']);
 // With notes right after, the time given up stays as triplet rests (no 24:1 fragments).
 const u=at.importer.ScoreLoader.loadAlphaTex('. :4 3.1 5.1 7.1 9.1',settings);resizeBeat(u.tracks[0].staves[0].bars[0].voices[0].beats[0],4,0,3,2);assert.deepEqual(shape(normalizeEdit(u).score),['4/3','8/3r','4','4','4']);
});
