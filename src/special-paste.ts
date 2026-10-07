import * as at from '@coderline/alphatab';
import {copyBeats,pasteBeats,type BeatClipboard,type BeatPoint} from './beat-clipboard';
import {beatQ,type Score} from './score';
import {excerptJson,restoreScore,normalizeEdit} from './edit-snapshot';
import {canEditFretLocally} from './local-fret-edit';
import {cleanEditJson} from './edit-json';
export type PasteKind='all'|'rhythm'|'technique'|'text';
const noteFields=['bendpoints','bendtype','bendstyle','slideintype','slideouttype','harmonictype','harmonicvalue','vibrato','trillvalue','trillspeed','ispalmmute','isletring','isghost','isdead','isstaccato','accentuated','ishammerpullorigin'];
const beatFields=['dynamics','fade','brushtype','brushduration','pickstroke','tap','slap','pop','vibrato','tremolopicking'];
function sounding(n:any,strings:number,tuning:number[],capo:number,transposition:number){return strings?tuning[strings-n.string]+n.fret+capo-transposition:n.octave*12+n.tone-transposition;}
export function repeatClipboard(clip:BeatClipboard,count:number):BeatClipboard{if(!Number.isInteger(count)||count<1||count>128||clip.length<=0)throw new Error('反復回数は1〜128で指定し、音価のある範囲をコピーしてください。');return {...structuredClone(clip),length:clip.length*count,count:clip.count*count,events:Array.from({length:count},(_,i)=>clip.events.map(e=>({...structuredClone(e),start:e.start+i*clip.length,end:e.end+i*clip.length}))).flat()};}
/** Common overwrite case: identical timing, independent notes, same tuning.
 * Prepare a detached excerpt before touching the live score; structural or
 * linked phrases fall back to the existing general paste operation. */
export function localPaste(s:Score,clip:BeatClipboard,p:BeatPoint):{beats:at.model.Beat[];apply:()=>void}|null{
 const staff=s.tracks[p.track]?.staves[p.staff];if(!staff||staff.isPercussion!==clip.percussion||staff.capo!==clip.capo||staff.transpositionPitch!==clip.transposition||staff.tuning.join(',')!==clip.tuning.join(',')||Object.keys(clip.chords).length)return null;
 const target=destination(s,p,clip.length);if(target.beats.length!==clip.events.length||target.beats.some(b=>!canEditFretLocally(b)))return null;
 let q=0;for(let i=0;i<target.beats.length;i++){const e=clip.events[i],b=target.beats[i],d=beatQ(b);if(Math.abs(e.start-q)>1e-7||Math.abs(e.end-e.start-d)>1e-7||e.raw.gracetype||e.raw.whammybarpoints?.length||e.raw.notes?.some((n:any)=>n.istiedestination||n.ishammerpullorigin||n.isslurorigin||n.slideouttype||n.bendpoints?.length))return null;q+=d;}if(Math.abs(q-clip.length)>1e-7)return null;
 const j=excerptJson(s,p.bar,target.beats.at(-1)!.voice.bar.index,p.track),raw=j.tracks[0].staves[p.staff];for(let i=0;i<target.beats.length;i++){const b=target.beats[i],fresh=structuredClone(clip.events[i].raw);cleanEditJson([fresh],true);raw.bars[b.voice.bar.index-p.bar].voices[p.voice].beats[b.index]=fresh;}
 cleanEditJson(j);const rebuilt=restoreScore(j).tracks[0].staves[p.staff],prepared=target.beats.map(b=>rebuilt.bars[b.voice.bar.index-p.bar].voices[p.voice].beats[b.index]);
 return {beats:target.beats,apply:()=>{const keep=new Set(['voice','index','id','previousBeat','nextBeat','playbackStart','displayStart']);for(let i=0;i<target.beats.length;i++){const b=target.beats[i],fresh=prepared[i];for(const key of Object.keys(fresh))if(!keep.has(key))(b as any)[key]=(fresh as any)[key];for(const n of b.notes)n.beat=b;}}};
}
function destination(s:Score,p:BeatPoint,length:number){const staff=s.tracks[p.track].staves[p.staff],beats:at.model.Beat[]=[];let q=0;for(let i=p.bar;i<staff.bars.length&&q<length+1e-7;i++){const v=staff.bars[i].voices[p.voice];if(!v)continue;for(const b of v.beats.slice(i===p.bar?p.beat:0)){beats.push(b);q+=b.graceType===at.model.GraceType.None?beatQ(b):0;if(q>=length-1e-7)break;}}if(!beats.length)throw new Error('貼り付け先を選択してください。');return {beats,clip:copyBeats(s,{anchor:p,focus:{...p,bar:beats.at(-1)!.voice.bar.index,beat:beats.at(-1)!.index}})};}
/** Build and validate once, then apply the entire operation in one history unit. */
export function specialPaste(s:Score,clip:BeatClipboard,p:BeatPoint,kind:PasteKind,count=1,insert=false){const source=repeatClipboard(clip,count);if(kind==='all')return pasteBeats(s,source,p,insert);const target=destination(s,p,source.length),staff=s.tracks[p.track].staves[p.staff];
 if(kind==='rhythm'){source.strings=staff.tuning.length;source.percussion=staff.isPercussion;source.tuning=[...staff.tuning];source.capo=staff.capo;source.transposition=staff.transpositionPitch;source.chords={};for(const e of source.events){const active=target.clip.events.find(d=>d.start<=e.start+1e-7&&d.end>e.start+1e-7);e.raw={duration:e.raw.duration,dots:e.raw.dots,tupletnumerator:e.raw.tupletnumerator,tupletdenominator:e.raw.tupletdenominator,gracetype:e.raw.gracetype,notes:e.raw.notes?.length?structuredClone(active?.raw.notes??[]):[],isempty:false};}return pasteBeats(s,source,p,insert);}
 if(insert)throw new Error('奏法・強弱とコード・テキストは上書きで貼り付けてください。');
 if(source.events.some(e=>e.end===e.start))throw new Error('装飾音を含む範囲は「すべて」または「リズムのみ」で貼り付けてください。');
 const j=excerptJson(s,p.bar,Math.min(s.masterBars.length-1,target.beats.at(-1)!.voice.bar.index+1),p.track),rawStaff=j.tracks[0].staves[p.staff];rawStaff.chords??={};const chordIds=new Map<string,string>();for(const [id,chord]of Object.entries(source.chords)){let key=id;while(rawStaff.chords[key]&&JSON.stringify(rawStaff.chords[key])!==JSON.stringify(chord))key+='-copy';rawStaff.chords[key]=structuredClone(chord);chordIds.set(id,key);}
 const edits:{beat:at.model.Beat;raw:any}[]=[];let q=0;
 for(const beat of target.beats){const e=source.events.find(e=>Math.abs(e.start-q)<1e-7);if(e){const raw=rawStaff.bars[beat.voice.bar.index-p.bar].voices[p.voice].beats[beat.index];if(kind==='text'){raw.text=e.raw.text??'';raw.chordid=chordIds.get(e.raw.chordid)??null;}else{for(const key of beatFields)raw[key]=structuredClone(e.raw[key]);for(const n of e.raw.notes??[]){const to=raw.notes?.find((d:any)=>source.percussion?d.percussionarticulation===n.percussionarticulation:source.strings===staff.tuning.length&&source.strings>0?d.string===n.string:sounding(d,staff.tuning.length,staff.tuning,staff.capo,staff.transpositionPitch)===sounding(n,source.strings,source.tuning,source.capo,source.transposition));if(!to)throw new Error('同じ拍位置に対応する音符がありません。音価または音高・弦を合わせてください。');for(const key of noteFields)to[key]=structuredClone(n[key]);}}edits.push({beat,raw});}q+=beatQ(beat);}
 if(!edits.length)throw new Error('一致する拍位置がありません。');
 if(edits.length!==source.events.length)throw new Error('コピー元と貼り付け先の拍位置が一致しません。先に「リズムのみ」で音価を合わせてください。');
 if(kind==='technique')for(const {beat,raw}of edits)for(const n of raw.notes??[])if((n.ishammerpullorigin||[1,2].includes(n.slideouttype))&&!beat.nextBeat?.notes.some(v=>v.string===n.string))throw new Error('次の拍の同じ弦に奏法の接続先が必要です。');
 // The converter is used on detached beats, not the entire song.
 cleanEditJson(j);const rebuilt=restoreScore(j).tracks[0].staves[p.staff],prepared=edits.map(e=>({...e,next:rebuilt.bars[e.beat.voice.bar.index-p.bar].voices[p.voice].beats[e.beat.index]}));
 if(kind==='text')for(const [id,chord]of rebuilt.chords??[])staff.addChord(id,chord);
 const structural=kind==='technique'&&prepared.some(({beat,next})=>!canEditFretLocally(beat)||!canEditFretLocally(next)||next.notes.some(n=>n.harmonicType));
 for(const {beat,next}of prepared){if(kind==='text'){beat.text=next.text;beat.chordId=next.chordId;}else{for(const key of ['dynamics','fade','brushType','brushDuration','pickStroke','tap','slap','pop','vibrato','tremoloPicking'] as const)(beat as any)[key]=next[key];for(let i=0;i<beat.notes.length;i++){const n=beat.notes[i],v=next.notes[i];for(const key of ['bendPoints','bendType','bendStyle','slideInType','slideOutType','harmonicType','harmonicValue','vibrato','trillValue','trillSpeed','isPalmMute','isLetRing','isGhost','isDead','isStaccato','accentuated','isHammerPullOrigin'] as const)(n as any)[key]=v[key];}}}
 if(!structural&&kind==='technique')for(const {beat}of prepared)beat.finish(new at.Settings());
 return {score:structural?normalizeEdit(s).score:s,range:{anchor:p,focus:{...p,bar:prepared.at(-1)!.beat.voice.bar.index,beat:prepared.at(-1)!.beat.index}},changed:prepared.map(e=>e.beat)};
}
