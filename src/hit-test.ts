import type * as at from '@coderline/alphatab';
export function tabBounds(lookup:at.rendering.BoundsLookup,b:at.model.Beat){
  // Worker rendering reconstructs models; match stable indexes rather than object identity.
  return lookup.findBeats(b)?.at(-1)??lookup.findBeat(b);
}
/** Move to the nearest horizontal position in the preceding/following score row. */
export function adjacentTabRow(lookup:at.rendering.BoundsLookup,beat:at.model.Beat,direction:-1|1){
  const current=tabBounds(lookup,beat);if(!current)return null;
  const system=current.barBounds.masterBarBounds.staffSystemBounds;
  const index=lookup.staffSystems.indexOf(system!);if(index<0)return null;
  for(let i=index+direction;i>=0&&i<lookup.staffSystems.length;i+=direction){
    const candidates=lookup.staffSystems[i].bars.flatMap(m=>m.bars.flatMap(b=>b.beats)).filter(b=>{
      const other=b.beat;return other.voice.bar.staff.track.index===beat.voice.bar.staff.track.index&&other.voice.bar.staff.index===beat.voice.bar.staff.index&&other.voice.index===beat.voice.index;
    });
    if(candidates.length)return candidates.reduce((a,b)=>Math.abs(b.onNotesX-current.onNotesX)<Math.abs(a.onNotesX-current.onNotesX)?b:a).beat;
  }
  return null;
}
/** Tab renderer bounds align with the string lines, even with no notes. */
export function hitTab(lookup:at.rendering.BoundsLookup,x:number,y:number,voice=0){
  for(const system of lookup.staffSystems)for(const master of system.bars)for(const bar of master.bars){
    // Worker bounds omit BarBounds.bar; BeatBounds.beat retains its model graph.
    const model=bar.bar??bar.beats[0]?.beat.voice.bar;if(!model)continue;
    const staff=model.staff,n=staff.tuning.length;if(staff.isPercussion||!staff.showTablature||n<2)continue;
    if(master.bars.filter(a=>(a.bar??a.beats[0]?.beat.voice.bar)===model).at(-1)!==bar)continue;
    const r=bar.visualBounds,gap=r.h/(n-1);if(x<r.x||x>r.x+r.w||y<r.y-gap*.6||y>r.y+r.h+gap*.6)continue;
    const beats=bar.beats.filter(b=>b.beat.voice.index===voice);if(!beats.length)continue;
    const closest=beats.reduce((a,b)=>Math.abs(b.onNotesX-x)<Math.abs(a.onNotesX-x)?b:a);
    return {beat:closest.beat,string:Math.max(1,Math.min(n,n-Math.round((y-r.y)/gap))),bounds:closest};
  }return null;
}
