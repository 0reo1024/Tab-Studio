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
type TabEntry={bar:at.rendering.BarBounds;n:number;r:at.rendering.Bounds;gap:number};
type TabSystem={top:number;bottom:number;entries:TabEntry[]};
/** A per-layout cache of data derived from a BoundsLookup. After an edit the render patch
 * merges the redrawn systems into the same lookup and bumps its studioRevision, which
 * makes the cached entry stale. */
export function boundsCache<T>(){
  const map=new WeakMap<at.rendering.BoundsLookup,{revision:number;value:T}>();
  const revision=(lookup:at.rendering.BoundsLookup)=>(lookup as {studioRevision?:number}).studioRevision??0;
  return {
    get(lookup:at.rendering.BoundsLookup){const entry=map.get(lookup);return entry&&entry.revision===revision(lookup)?entry.value:undefined;},
    set(lookup:at.rendering.BoundsLookup,value:T){map.set(lookup,{revision:revision(lookup),value});},
  };
}
const tabIndex=boundsCache<TabSystem[]>();
/** Qualifying TAB bars are resolved once per layout; mousemove only scans systems under the pointer. */
function tabSystems(lookup:at.rendering.BoundsLookup){
  let systems=tabIndex.get(lookup);if(systems)return systems;systems=[];
  for(const system of lookup.staffSystems){const entries:TabEntry[]=[];let top=Infinity,bottom=-Infinity;
    for(const master of system.bars){const last=new Map<at.model.Bar,at.rendering.BarBounds>();
      // Worker bounds omit BarBounds.bar; BeatBounds.beat retains its model graph.
      for(const bar of master.bars){const model=bar.bar??bar.beats[0]?.beat.voice.bar;if(model)last.set(model,bar);}
      for(const bar of master.bars){const model=bar.bar??bar.beats[0]?.beat.voice.bar;if(!model||last.get(model)!==bar)continue;
        const staff=model.staff,n=staff.tuning.length;if(staff.isPercussion||!staff.showTablature||n<2)continue;
        const r=bar.visualBounds,gap=r.h/(n-1);entries.push({bar,n,r,gap});top=Math.min(top,r.y-gap*.6);bottom=Math.max(bottom,r.y+r.h+gap*.6);}}
    systems.push({top,bottom,entries});}
  tabIndex.set(lookup,systems);return systems;
}
/** Tab renderer bounds align with the string lines, even with no notes. */
export function hitTab(lookup:at.rendering.BoundsLookup,x:number,y:number,voice=0){
  for(const system of tabSystems(lookup)){if(y<system.top||y>system.bottom)continue;
    for(const {bar,n,r,gap} of system.entries){if(x<r.x||x>r.x+r.w||y<r.y-gap*.6||y>r.y+r.h+gap*.6)continue;
      const beats=bar.beats.filter(b=>b.beat.voice.index===voice);if(!beats.length)continue;
      const closest=beats.reduce((a,b)=>Math.abs(b.onNotesX-x)<Math.abs(a.onNotesX-x)?b:a);
      return {beat:closest.beat,string:Math.max(1,Math.min(n,n-Math.round((y-r.y)/gap))),bounds:closest};}
  }return null;
}
