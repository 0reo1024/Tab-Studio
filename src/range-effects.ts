import * as at from '@coderline/alphatab';
import type {Beat,Note,Score} from './score';
import {rangeBeats,type BeatRange} from './beat-clipboard';

export type MeasureRange={start:number;end:number;track:number;allTracks:boolean};
export function effectRangeBeats(score:Score,fragment:BeatRange|null,range:MeasureRange|null):Beat[]|null{
 if(fragment)return rangeBeats(score,fragment);
 if(!range)return null;
 return (range.allTracks?score.tracks:[score.tracks[range.track]]).flatMap(t=>t.staves.flatMap(st=>st.bars.slice(range.start,range.end+1).flatMap(b=>b.voices.flatMap(v=>v.beats))));
}
export const rangeEffects=['palm','deadNote','ghost','hammer','vibrato','ring','bend','halfBend','slide','harmonic','accent','heavyAccent','staccato','trill','tremolo','tap','slap','pop','fade','brush','brushUp'];
export const isRangeEffect=(id:string)=>/^dynamic[0-7]$/.test(id)||rangeEffects.includes(id);
export const linkedRangeEffect=(id:string)=>['hammer','bend','halfBend','slide','harmonic'].includes(id);
const beatEffects=['tremolo','tap','slap','pop','fade','brush','brushUp'];
function eligible(n:Note,id:string){
 if(['bend','halfBend','slide','harmonic','hammer','trill'].includes(id)&&n.isPercussion)return false;
 if(['harmonic','hammer','slide'].includes(id)&&!n.isStringed)return false;
 if(['hammer','slide'].includes(id)&&!n.beat.nextBeat?.notes.some(next=>next.string===n.string))return false;
 return true;
}
function noteActive(n:Note,id:string):boolean{
 switch(id){
 case 'palm':return n.isPalmMute;case 'deadNote':return n.isDead;case 'ghost':return n.isGhost;
 case 'hammer':return n.isHammerPullOrigin;case 'vibrato':return n.vibrato!==at.model.VibratoType.None;
 case 'ring':return n.isLetRing;case 'harmonic':return n.harmonicType!==at.model.HarmonicType.None;
 case 'slide':return n.slideOutType!==at.model.SlideOutType.None;case 'staccato':return n.isStaccato;
 case 'trill':return n.trillValue>=0;case 'accent':return n.accentuated===at.model.AccentuationType.Normal;
 case 'heavyAccent':return n.accentuated===at.model.AccentuationType.Heavy;
 case 'bend':case 'halfBend':return n.hasBend&&Math.max(...(n.bendPoints??[]).map(p=>p.value))===(id==='halfBend'?2:4);
 default:return false;
 }
}
function beatActive(b:Beat,id:string){if(id==='tremolo')return !!b.tremoloPicking;if(id==='fade')return !!b.fade;if(id==='brush')return b.brushType===at.model.BrushType.BrushDown;if(id==='brushUp')return b.brushType===at.model.BrushType.BrushUp;return !!b[id as 'tap'|'slap'|'pop'];}
export function rangeEffectActive(beats:Beat[],id:string){
 if(id.startsWith('dynamic'))return beats.length>0&&beats.every(b=>b.dynamics===Number(id.slice(7)));
 if(beatEffects.includes(id)){const targets=beats.filter(b=>b.notes.length);return targets.length>0&&targets.every(b=>beatActive(b,id));}
 const notes=beats.flatMap(b=>b.notes).filter(n=>eligible(n,id));return notes.length>0&&notes.every(n=>noteActive(n,id));
}
/** Mixed states converge to ON; a uniformly active selection toggles OFF. */
export function applyRangeEffect(beats:Beat[],id:string){
 if(!isRangeEffect(id))throw new Error('一括適用できない操作です。');
 if(id.startsWith('dynamic')){const dynamics=Number(id.slice(7));for(const b of beats){b.dynamics=dynamics;for(const n of b.notes)n.dynamics=dynamics;}return beats.length;}
 const enabled=!rangeEffectActive(beats,id);
 if(beatEffects.includes(id)){const targets=beats.filter(b=>b.notes.length);for(const b of targets){
  if(id==='tremolo'){b.tremoloPicking=enabled?new at.model.TremoloPickingEffect():undefined;if(b.tremoloPicking)b.tremoloPicking.marks=2;}
  else if(id==='fade')b.fade=enabled?at.model.FadeType.FadeIn:at.model.FadeType.None;
  else if(id==='brush'||id==='brushUp'){b.brushType=enabled?(id==='brush'?at.model.BrushType.BrushDown:at.model.BrushType.BrushUp):at.model.BrushType.None;b.brushDuration=120;b.pickStroke=enabled?(id==='brush'?at.model.PickStroke.Down:at.model.PickStroke.Up):at.model.PickStroke.None;}
  else b[id as 'tap'|'slap'|'pop']=enabled;
 }return targets.length;}
 const notes=beats.flatMap(b=>b.notes).filter(n=>eligible(n,id));for(const n of notes){
  switch(id){
  case 'palm':n.isPalmMute=enabled;break;case 'deadNote':n.isDead=enabled;break;case 'ghost':n.isGhost=enabled;break;
  case 'hammer':n.isHammerPullOrigin=enabled;break;case 'ring':n.isLetRing=enabled;break;
  case 'vibrato':n.vibrato=enabled?at.model.VibratoType.Slight:at.model.VibratoType.None;break;
  case 'harmonic':n.harmonicType=enabled?at.model.HarmonicType.Natural:at.model.HarmonicType.None;n.harmonicValue=n.fret;break;
  case 'accent':case 'heavyAccent':n.accentuated=enabled?(id==='accent'?at.model.AccentuationType.Normal:at.model.AccentuationType.Heavy):at.model.AccentuationType.None;break;
  case 'slide':n.slideOutType=enabled?at.model.SlideOutType.Shift:at.model.SlideOutType.None;break;
  case 'staccato':n.isStaccato=enabled;break;case 'trill':n.trillValue=enabled?Math.min(127,n.realValue+2):-1;n.trillSpeed=at.model.Duration.Sixteenth;break;
  case 'bend':case 'halfBend':n.bendPoints=null;n.bendType=at.model.BendType.None;if(enabled)for(const [offset,value]of [[0,0],[30,id==='halfBend'?2:4],[60,id==='halfBend'?2:4]])n.addBendPoint(new at.model.BendPoint(offset,value));break;
  }
 }return notes.length;
}
