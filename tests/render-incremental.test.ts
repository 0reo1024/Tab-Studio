import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {settings} from '../src/score';
import {EditSnapshot,editData,restoreScore,normalizeEdit} from '../src/edit-snapshot';
import {snapshotDiff} from '../src/snapshot-diff';
import {boundsCache} from '../src/hit-test';
// @ts-expect-error plain JS module shared with the alphaTab worker patch
import {studioScoreFor,studioBarEdits,studioMergeBounds,studioSameBounds} from '../scripts/render-incremental.mjs';

const song=()=>at.importer.ScoreLoader.loadAlphaTex(String.raw`\track "A" \tuning E4 B3 G3 D3 A2 E2
:4 0.6 1.6 2.6 3.6 | 5.6 7.6 8.6 r | 0.5 2.5 3.5{h} 5.5 | 7.5 5.4 r r | 3.4 5.4 7.4 5.4`,settings);
/** What the worker renders, compared as verifySnapshot does (ids and studio data aside). */
const notation=(score:at.model.Score)=>JSON.stringify(editData(restoreScore(editData(score))),(k,v)=>k.startsWith('studio')?undefined:v);
/** The worker's state: the snapshot it holds and its Score. */
function worker(first:unknown){const self:Record<string,unknown>={};studioScoreFor(self,{score:first},settings,at.model.JsonConverter);return self;}
function send(self:Record<string,unknown>,prev:unknown,next:unknown){return studioScoreFor(self,{studioPatch:snapshotDiff(prev,next)},settings,at.model.JsonConverter) as at.model.Score;}

test('measure edits are patched into the worker score, which equals a full rebuild', ()=>{
 const score=song(),snapshot=new EditSnapshot();let prev=snapshot.get(score);
 const self=worker(prev),model=self._studioModel;
 // A fret change in a link-free measure.
 const beat=score.tracks[0].staves[0].bars[1].voices[0].beats[2];beat.notes[0].fret=10;beat.finish(settings);snapshot.patchBeat(score,beat);
 let next=snapshot.get(score);
 assert.deepEqual(studioBarEdits(prev,snapshotDiff(prev,next)),[[0,0,1]]);
 let worked=send(self,prev,next);prev=next;
 assert.equal(worked,model,'the same Score object, patched');
 assert.equal(worked.tracks[0].staves[0].bars[1].voices[0].beats[2].notes[0].fret,10);
 assert.equal(notation(worked),notation(score));
 // A measure joined to the next by a hammer-on: both rebuilt, links intact.
 const linked=score.tracks[0].staves[0].bars[2];linked.voices[0].beats[0].notes[0].fret=4;snapshot.patchBar(score,linked);
 next=snapshot.get(score);worked=send(self,prev,next);prev=next;
 assert.equal(worked,model);
 const bars=worked.tracks[0].staves[0].bars;
 assert.equal(bars[2].voices[0].beats[2].notes[0].hammerPullDestination,bars[2].voices[0].beats[3].notes[0]);
 assert.equal(bars[3].previousBar,bars[2]);assert.equal(bars[3].voices[0].beats[0].previousBeat,bars[2].voices[0].beats[3]);
 assert.equal(notation(worked),notation(restoreScore(editData(score))));
});

test('anything beyond measures (a track rename, a new measure) rebuilds the worker score', ()=>{
 const score=song(),snapshot=new EditSnapshot();let prev=snapshot.get(score);
 const self=worker(prev),model=self._studioModel;
 score.tracks[0].name='Lead';snapshot.patchTracks(score);let next=snapshot.get(score);
 assert.equal(studioBarEdits(prev,snapshotDiff(prev,next)),null);
 let worked=send(self,prev,next);prev=next;
 assert.notEqual(worked,model);assert.equal(worked.tracks[0].name,'Lead');
 const normalized=normalizeEdit(score);snapshot.set(normalized.score,normalized.data);next=snapshot.get(normalized.score);
 worked=send(self,prev,next);
 assert.equal(notation(worked),notation(normalized.score));
 // A render with nothing changed keeps the Score.
 assert.equal(send(self,next,next),worked);
});

/** Bounds JSON as the worker sends it: one system of (up to) two bars per [first bar, y]. */
function boundsJson(score:at.model.Score,systems:[number,number][]){
 const map=(entries:Record<string,unknown>)=>new Map(Object.entries(entries));
 const box=(x:number,y:number,w:number,h:number)=>map({x,y,w,h});
 const beatJson=(beat:at.model.Beat,x:number,y:number)=>map({visualBounds:box(x,y+10,20,60),realBounds:box(x,y,90,100),onNotesX:x+10,beatIndex:beat.index,voiceIndex:0,barIndex:beat.voice.bar.index,staffIndex:0,trackIndex:0,
  notes:beat.notes.map(n=>map({index:n.index,noteHeadBounds:box(x,y+20+n.index*10,10,10)}))});
 const barJson=(index:number,first:number,y:number)=>{const x=(index-first)*400,beats=score.tracks[0].staves[0].bars[index].voices[0].beats;
  return map({lineAlignedBounds:box(x,y,400,100),visualBounds:box(x,y,400,90),realBounds:box(x,y,400,100),index,isFirstOfLine:index===first,
   bars:[map({visualBounds:box(x,y,400,90),realBounds:box(x,y,400,100),beats:beats.map((beat,i)=>beatJson(beat,x+i*90,y))})]});};
 return map({staffSystems:systems.map(([first,y])=>map({visualBounds:box(0,y,800,90),realBounds:box(0,y,800,100),bars:[first,first+1].filter(index=>index<score.masterBars.length).map(index=>barJson(index,first,y))}))});
}

test('partial bounds merge: changed systems replaced, kept systems moved by dy', ()=>{
 const score=song(),from=(json:Map<string,unknown>)=>{const l=at.rendering.BoundsLookup.fromJson(json,score)!;l.finish();return l;};
 // Five bars in three systems; bar 2 changed and its system grew by 15, so the next one moved down.
 const lookup=from(boundsJson(score,[[0,0],[2,100],[4,200]]));
 const part=at.rendering.BoundsLookup.fromJson(boundsJson(score,[[2,100]]),score)!;
 // The editor caches hit-testing data per lookup; a merge into the same object drops it.
 const cache=boundsCache<string>();cache.set(lookup,'before');assert.equal(cache.get(lookup),'before');
 assert.equal(studioMergeBounds(lookup,part,2,{bar:4,dy:15}),true);
 assert.equal(cache.get(lookup),undefined,'stale after a merge');cache.set(lookup,'after');assert.equal(cache.get(lookup),'after');
 const whole=from(boundsJson(score,[[0,0],[2,100],[4,215]]));
 assert.equal(studioSameBounds(lookup,whole),true);
 assert.deepEqual(lookup.staffSystems.map(s=>s.index),[0,1,2]);
 const beat=score.tracks[0].staves[0].bars[4].voices[0].beats[1];
 assert.equal(lookup.findBeat(beat)?.realBounds.y,215);
 assert.equal(lookup.getBeatAtPos(95,230),beat);
 // The kept system must start where the worker says, or nothing is merged.
 assert.equal(studioMergeBounds(from(boundsJson(score,[[0,0],[2,100],[4,200]])),part,2,{bar:3,dy:0}),false);
 assert.notEqual(studioSameBounds(from(boundsJson(score,[[0,0]])),whole),true);
});
