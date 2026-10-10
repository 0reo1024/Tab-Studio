import * as at from '@coderline/alphatab';
import {serialize,deserialize,beatQ,type Score} from './score';
import {rests} from './editor';
import {insertBars} from './score-operations';
import {cleanEditJson} from './edit-json';
import {excerptJson,editData,restoreScore} from './edit-snapshot';

type Json=Record<string,any>;
export type BeatPoint={track:number;staff:number;voice:number;bar:number;beat:number};
export type BeatRange={anchor:BeatPoint;focus:BeatPoint};
type Event={start:number;end:number;raw:Json};
export type BeatClipboard={version:2;events:Event[];length:number;count:number;strings:number;percussion:boolean;chords:Json;tuning:number[];capo:number;transposition:number};
const eps=1e-7;
const capacity=(s:Score,i:number)=>s.masterBars[i].timeSignatureNumerator*4/s.masterBars[i].timeSignatureDenominator;
const length=(b:at.model.Beat)=>b.graceType===at.model.GraceType.None?beatQ(b):0;
export function orderedRange(s:Score,r:BeatRange){
  const a=r.anchor,b=r.focus;
  if(a.track!==b.track||a.staff!==b.staff||a.voice!==b.voice)throw new Error('同じトラック・段・声部で範囲を選択してください。');
  for(const p of [a,b])if(!s.tracks[p.track]?.staves[p.staff]?.bars[p.bar]?.voices[p.voice]?.beats[p.beat])throw new Error('音符または休符を選択してください。');
  return a.bar<b.bar||a.bar===b.bar&&a.beat<=b.beat?{start:a,end:b}:{start:b,end:a};
}
export function rangeBeats(s:Score,r:BeatRange){const {start,end}=orderedRange(s,r),staff=s.tracks[start.track].staves[start.staff];return staff.bars.slice(start.bar,end.bar+1).flatMap(bar=>(bar.voices[start.voice]?.beats??[]).filter(b=>(bar.index!==start.bar||b.index>=start.beat)&&(bar.index!==end.bar||b.index<=end.beat)));}
function position(s:Score,p:BeatPoint){let q=0;for(let i=0;i<p.bar;i++)q+=capacity(s,i);for(const b of s.tracks[p.track].staves[p.staff].bars[p.bar].voices[p.voice].beats.slice(0,p.beat))q+=length(b);return q;}
function finish(j:Json){cleanEditJson(j);return restoreScore(j);}
function rhythm(q:number){return rests(q).map(b=>({duration:b.duration,dots:b.dots,tupletnumerator:b.tupletNumerator,tupletdenominator:b.tupletDenominator}));}
function pieces(e:Event,start:number,end:number):Json[]{
  if(e.end-e.start<eps)return [structuredClone(e.raw)];
  const raw=e.raw,q=end-start,rawQ=4/raw.duration*(2-1/2**(raw.dots??0))*((raw.tupletnumerator??-1)>0?(raw.tupletdenominator/raw.tupletnumerator):1);
  const whole=Math.abs(q-(e.end-e.start))<eps&&Math.abs(rawQ-q)<eps;
  const durations=whole?[{duration:raw.duration,dots:raw.dots,tupletnumerator:raw.tupletnumerator,tupletdenominator:raw.tupletdenominator}]:rhythm(q);
  return durations.map((d,i)=>{const b:Json={...structuredClone(raw),...d,isempty:false};if(i||start>e.start+eps){delete b.text;delete b.chordid;b.automations=[];b.brushtype=0;b.fade=0;for(const n of b.notes??[]){n.istiedestination=true;n.ishammerpullorigin=false;n.slideouttype=0;n.accentuated=0;}}return b;});
}
function timeline(s:Score,j:Json,p:BeatPoint,startBar=0,endBar=s.masterBars.length-1,rawOffset=0,rawTrack=p.track){const events:Event[]=[];let offset=position(s,{...p,bar:startBar,beat:0});const staff=s.tracks[p.track].staves[p.staff],rawStaff=j.tracks[rawTrack].staves[p.staff];for(let i=startBar;i<=endBar;i++){let q=0;const beats=staff.bars[i].voices[p.voice]?.beats??[],raw=rawStaff.bars[i-rawOffset].voices[p.voice]?.beats??[];for(let k=0;k<beats.length;k++){const d=length(beats[k]);events.push({start:offset+q,end:offset+q+d,raw:raw[k]});q+=d;}const cap=capacity(s,i);if(q>cap+eps)throw new Error('小節の音価が拍子を超えています。先に音価を調整してください。');if(q<cap-eps)for(const d of rhythm(cap-q)){const n=4/d.duration*(d.tupletnumerator>0?d.tupletdenominator/d.tupletnumerator:1);events.push({start:offset+q,end:offset+q+n,raw:{...d,notes:[],isempty:false}});q+=n;}offset+=cap;}return {events,total:offset};}
export function copyBeats(s:Score,r:BeatRange):BeatClipboard{
  const {start,end}=orderedRange(s,r),j=excerptJson(s,start.bar,end.bar,start.track),from=position(s,start),last=s.tracks[end.track].staves[end.staff].bars[end.bar].voices[end.voice].beats[end.beat],to=position(s,end)+length(last),staff=s.tracks[start.track].staves[start.staff];
  const chosen=rangeBeats(s,r),ids=new Set(chosen.map(b=>b.id)),all=timeline(s,j,start,start.bar,end.bar,start.bar,0).events,events=all.filter(e=>to-from<eps?ids.has(e.raw.id):e.end>from+eps&&e.start<to-eps||e.start===e.end&&e.start>=from-eps&&e.start<to-eps).map(e=>({...e,start:e.start-from,end:e.end-from}));
  // A tie from outside the copied phrase cannot be retained at a new destination.
  for(const n of events.find(e=>e.end>e.start)?.raw.notes??[])n.istiedestination=false;
  return {version:2,events,length:to-from,count:chosen.length,strings:staff.tuning.length,percussion:staff.isPercussion,chords:structuredClone(j.tracks[0].staves[start.staff].chords??{}),tuning:[...staff.tuning],capo:staff.capo,transposition:staff.transpositionPitch};
}
export function clearBeats(s:Score,r:BeatRange):Score{const j=editData(s),touched=new Map<Json,Set<number>>();for(const b of rangeBeats(s,r)){const voice=j.tracks[b.voice.bar.staff.track.index].staves[b.voice.bar.staff.index].bars[b.voice.bar.index].voices[b.voice.index],raw=voice.beats[b.index];raw.notes=[];raw.isempty=false;delete raw.chordid;delete raw.text;if(b.graceType===at.model.GraceType.None){if(!touched.has(voice))touched.set(voice,new Set());touched.get(voice)!.add(b.index);}}
  for(const [voice,indices]of touched)voice.beats=simplifyRests(voice.beats,indices);return finish(j);}
/** Plain rests filling [start,end) of a bar, each starting on its own grid:
 * an 8th rest on the off-beat, then quarters — never a rest straddling a beat. */
export function alignedRests(start:number,end:number){
  const out:{duration:number;dots:number;tupletnumerator:number;tupletdenominator:number}[]=[];let p=start;
  while(end-p>eps){const d=[1,2,4,8,16,32,64].find(d=>{const q=4/d;return q<=end-p+eps&&Math.abs(p/q-Math.round(p/q))<1e-6;});if(!d)break;out.push({duration:d,dots:0,tupletnumerator:-1,tupletdenominator:-1});p+=4/d;}
  return out;
}
const rawQ=(b:Json)=>4/b.duration*(2-1/2**(b.dots??0))*((b.tupletnumerator??-1)>0?b.tupletdenominator/b.tupletnumerator:1);
const onGrid=(q:number)=>Math.abs(q*16-Math.round(q*16))<1e-6;
/** Cleared beats (and the rests touching them) become the simplest plain rests:
 * dotted/tuplet leftovers merge into whole beats. A stretch that does not start
 * and end on the 64th grid (an unfinished tuplet) keeps its outer beats as-is. */
export function simplifyRests(beats:Json[],touched:Set<number>):Json[]{
  const starts:number[]=[];let q=0;for(const b of beats){starts.push(q);if(!b.gracetype)q+=rawQ(b);}
  const rest=(b:Json)=>!b.gracetype&&!b.notes?.length&&!b.text&&!b.chordid;
  // A beat carrying automations (instrument/tempo events) may only open a stretch, so its event keeps its time.
  const out:Json[]=[];let i=0;
  while(i<beats.length){
    if(!rest(beats[i])){out.push(beats[i++]);continue;}
    let k=i;while(k+1<beats.length&&rest(beats[k+1])&&!beats[k+1].automations?.length)k++;
    let from=i,to=k;const hit=[...touched].some(t=>t>=i&&t<=k);
    while(hit&&from<=to&&!onGrid(starts[from]))from++;
    while(hit&&to>=from&&!onGrid(starts[to]+rawQ(beats[to])))to--;
    const target=hit&&from<=to?alignedRests(starts[from],starts[to]+rawQ(beats[to])):[];
    const same=target.length===to-from+1&&target.every((d,n)=>{const b=beats[from+n];return b.duration===d.duration&&!(b.dots>0)&&!((b.tupletnumerator??-1)>0);});
    if(!target.length||same){out.push(...beats.slice(i,k+1));i=k+1;continue;}
    out.push(...beats.slice(i,from));
    target.forEach((d,n)=>out.push({...structuredClone(beats[from]),...d,notes:[],isempty:false,...(n?{automations:[]}:{})}));
    out.push(...beats.slice(to+1,k+1));i=k+1;
  }
  return out;
}
export function pasteBeats(s:Score,clip:BeatClipboard,p:BeatPoint,insert=false):{score:Score;range:BeatRange}{
  orderedRange(s,{anchor:p,focus:p});const staff=s.tracks[p.track].staves[p.staff];if(staff.isPercussion!==clip.percussion)throw new Error('打楽器と音程楽器の間では音符を貼り付けできません。');const copied=structuredClone(clip.events);
  if(staff.tuning.length!==clip.strings)for(const e of copied){const occupied=new Set<number>();for(const n of e.raw.notes??[]){const pitch=clip.strings?clip.tuning[clip.strings-n.string]+n.fret+clip.capo-clip.transposition:n.octave*12+n.tone-clip.transposition;if(!staff.tuning.length){n.string=-1;n.fret=-1;n.octave=Math.floor((pitch+staff.transpositionPitch)/12);n.tone=(pitch+staff.transpositionPitch)%12;continue;}
    const sourceOpen=clip.strings?clip.tuning[clip.strings-n.string]+clip.capo-clip.transposition:pitch,candidates=staff.tuning.map((open,i)=>({string:staff.tuning.length-i,fret:pitch+staff.transpositionPitch-open-staff.capo,open:open+staff.capo-staff.transpositionPitch})).filter(pos=>pos.fret>=0&&pos.fret<=36&&!occupied.has(pos.string)).sort((a,b)=>Math.abs(a.open-sourceOpen)-Math.abs(b.open-sourceOpen)||a.fret-b.fret),pos=candidates[0];if(!pos)throw new Error('この和音を貼り付け先の弦で演奏できません。弦数の多いトラックへ貼り付けてください。');n.string=pos.string;n.fret=pos.fret;occupied.add(pos.string);}}
  const from=position(s,p),to=from+clip.length;let total=s.masterBars.reduce((a,_,i)=>a+capacity(s,i),0),next=s;const originalTotal=total,needed=insert?total+clip.length:to;
  // Extend all tracks together, keeping their existing music and time alignment.
  if(needed>total+eps){const cap=capacity(s,s.masterBars.length-1),count=Math.ceil((needed-total-eps)/cap);for(let n=0;n<count;n+=128)next=insertBars(next,next.masterBars.length,Math.min(128,count-n));}
  const j=editData(next),target=j.tracks[p.track].staves[p.staff],old=timeline(next,j,p).events;
  const crop=(lo:number,hi:number)=>old.filter(e=>e.end>lo+eps&&e.start<hi-eps||e.end===e.start&&e.start>=lo-eps&&e.start<hi-eps).flatMap(e=>{const start=Math.max(lo,e.start),end=Math.min(hi,e.end);if(start===e.start&&end===e.end)return [e];const raw=pieces(e,start,end);let at=start;return raw.map((b,i)=>{const q=4/b.duration*(2-1/2**(b.dots??0))*(b.tupletnumerator>0?b.tupletdenominator/b.tupletnumerator:1),out={start:at,end:at+q,raw:b};if(lo===to&&!i)for(const n of b.notes??[])n.istiedestination=false;at+=q;return out;});});
  total=next.masterBars.reduce((a,_,i)=>a+capacity(next,i),0);
  const pasted=copied.map(e=>({...e,start:e.start+from,end:e.end+from}));target.chords??={};for(const [id,chord]of Object.entries(clip.chords)){let key=id;while(target.chords[key]&&JSON.stringify(target.chords[key])!==JSON.stringify(chord))key+='-copy';target.chords[key]=structuredClone(chord);if(key!==id)for(const e of pasted)if(e.raw.chordid===id)e.raw.chordid=key;}
  const tail=insert?[...crop(from,originalTotal).map(e=>({...e,start:e.start+clip.length,end:e.end+clip.length})),...crop(needed,total)]:crop(to,total);
  const firstTail=tail.find(e=>e.end>e.start),refreshTail=firstTail?.raw.notes?.some((n:Json)=>n.istiedestination);
  for(const n of firstTail?.raw.notes??[])n.istiedestination=false;
  const events=[...crop(0,from),...pasted,...tail];let offset=0,cursor=0;
  for(let i=0;i<next.masterBars.length;i++){const cap=capacity(next,i),end=offset+cap;if(end>from+eps&&(offset<(insert?total:refreshTail?Math.max(to,firstTail!.end):to)-eps||clip.length<eps&&i===p.bar)){const bar=target.bars[i];while(bar.voices.length<=p.voice)bar.voices.push({beats:rhythm(cap).map(d=>({...d,notes:[],isempty:false}))});while(cursor<events.length&&(events[cursor].start===events[cursor].end?events[cursor].start<offset-eps:events[cursor].end<=offset+eps))cursor++;const intersecting:Event[]=[];for(let k=cursor;k<events.length&&events[k].start<end-eps;k++){const e=events[k];if(e.end>offset+eps||e.start===e.end&&e.start>=offset-eps)intersecting.push(e);}const beats=intersecting.flatMap(e=>pieces(e,Math.max(e.start,offset),Math.min(e.end,end)));cleanEditJson(beats,true);bar.voices[p.voice].beats=beats;}offset=end;}
  const result=finish(j);function pointAt(q:number,last=false):BeatPoint{let offset=0;for(const bar of result.tracks[p.track].staves[p.staff].bars){let beatOffset=offset;for(const b of bar.voices[p.voice]?.beats??[]){const end=beatOffset+length(b);if(last?end>=q-eps&&beatOffset<q-eps:beatOffset>=q-eps)return {...p,bar:bar.index,beat:b.index};beatOffset=end;}offset+=capacity(result,bar.index);}return {...p};}
  const anchor=pointAt(from);return {score:result,range:{anchor,focus:clip.length<eps?{...anchor,beat:anchor.beat+clip.events.length-1}:pointAt(to,true)}};
}
