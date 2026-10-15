import type {Score} from './score';
import {orderedRange,type BeatRange} from './beat-clipboard';

export type LoopConfig={start:number;end:number;enabled:boolean;beats?:BeatRange};
type BarVisit={masterBar:{index:number};start:number;end:number};

/** Resolve score selections against the performed timeline, including repeats. */
export function loopPlaybackRange(score:Score,visits:readonly BarVisit[],config:LoopConfig){
  let start=config.start-1,end=config.end-1;
  let first:ReturnType<typeof orderedRange>['start']|undefined,last:typeof first;
  if(config.beats){try{({start:first,end:last}=orderedRange(score,config.beats));}catch{return null;}start=first.bar;end=last.bar;}
  const a=visits.find(v=>v.masterBar.index===start),b=visits.find(v=>v.masterBar.index===end&&v.start>=(a?.start??0));
  if(!a||!b)return null;
  const beat=(p:NonNullable<typeof first>)=>score.tracks[p.track].staves[p.staff].bars[p.bar].voices[p.voice].beats[p.beat];
  const startTick=first?a.start+beat(first).playbackStart:a.start;
  const endTick=last?b.start+beat(last).playbackStart+beat(last).playbackDuration:b.end;
  return endTick>startTick?{startTick,endTick}:null;
}
