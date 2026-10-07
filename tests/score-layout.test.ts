import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {readableLayout} from '../src/score-layout';

const dense=':32 '+Array.from({length:32},(_,i)=>`${10+i%8}.1`).join(' ');
const light=':4 3.1 5.1 7.1 5.1';
function render(bars:string[],fixed=false,secondTrack=false){
  const tex='\\track "Lead" . '+bars.join(' | ')+(secondTrack?' \\track "Rhythm" '+bars.map(()=>light).join(' | '):'');
  const settings=new at.Settings();Object.assign(settings.core,{engine:'svg',useWorkers:false,includeNoteBounds:true,enableLazyLoading:false});Object.assign(settings.display,readableLayout,{padding:[20,20,20,20]});if(fixed){settings.display.barsPerRow=4;settings.display.stretchForce=1;}
  const score=at.importer.ScoreLoader.loadAlphaTex(tex,settings);for(const t of score.tracks)t.staves[0].showStandardNotation=false;
  score.defaultSystemsLayout=4;score.systemsLayout=[4,4];for(const t of score.tracks){t.defaultSystemsLayout=4;t.systemsLayout=[4,4];}
  const renderer=new at.rendering.ScoreRenderer(settings);renderer.width=1060;renderer.renderScore(score,score.tracks.map(t=>t.index));return {score,lookup:renderer.boundsLookup!};
}
function gap(result:ReturnType<typeof render>,bar:number){const beats=result.score.tracks[0].staves[0].bars[bar].voices[0].beats.map(b=>result.lookup.findBeats(b)!.at(-1)!);return Math.min(...beats.slice(1).map((b,i)=>b.onNotesX-beats[i].onNotesX));}

test('dense two-digit frets get wider spacing and fewer bars per row',()=>{
  const bars=[light,light,dense,dense,light,dense,dense,light],old=render(bars,true),adaptive=render(bars);
  assert.ok(gap(adaptive,2)>24);assert.ok(gap(adaptive,2)>gap(old,2)*2);
  assert.ok(adaptive.lookup.staffSystems.some(s=>s.bars.length<4));
  const sparse=render(Array(16).fill(':1 3.1'));assert.ok(sparse.lookup.staffSystems.some(s=>s.bars.length>4));
});
test('automatic rows align all tracks and ignore imported four-bar row layouts',()=>{
  const result=render([light,dense,light,dense,light,dense],false,true);
  for(const row of result.lookup.staffSystems)for(const master of row.bars){
    const lead=master.bars.find(b=>b.beats[0].beat.voice.bar.staff.track.index===0)!,rhythm=master.bars.find(b=>b.beats[0].beat.voice.bar.staff.track.index===1)!;
    assert.equal(lead.visualBounds.x,rhythm.visualBounds.x);assert.equal(lead.visualBounds.w,rhythm.visualBounds.w);
  }
  assert.ok(gap(result,1)>24);
  assert.ok(result.lookup.staffSystems.some(s=>s.bars.length<4));
});
