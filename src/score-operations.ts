import * as at from '@coderline/alphatab';
import {serialize,deserialize,type Score} from './score';
import {cleanEditJson} from './edit-json';
import {excerptJson,editData,restoreScore} from './edit-snapshot';
import {planRetuning,RetuningError,retuningIssue,type RetuningIssue} from './retuning';

type Json=Record<string,any>;
export type BarClipboard={version:1;allTracks:boolean;masterbars:Json[];tracks:Json[]};
const data=(score:Score):Json=>editData(score);
const clone=<T>(value:T):T=>structuredClone(value);
function finish(json:Json):Score{cleanEditJson(json);return restoreScore(json);}
export function checkedRange(score:Score,start:number,end:number){if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>=score.masterBars.length)throw new Error('小節範囲を曲の中で指定してください。');return {start,end,count:end-start+1};}
function blankBar(template:Json={}){return {clef:template.clef??4,clefottava:template.clefottava??2,keysignature:template.keysignature??0,keysignaturetype:template.keysignaturetype??0,voices:Array.from({length:Math.max(1,template.voices?.length??1)},()=>({beats:[{duration:1,isempty:false,notes:[]}]}))};}
function blankMaster(template:Json):Json{return {timesignaturenumerator:template.timesignaturenumerator,timesignaturedenominator:template.timesignaturedenominator,tripletfeel:template.tripletfeel??0,tempoautomations:[]};}
export function copyBars(score:Score,start:number,end:number,track:number|null):BarClipboard{
  checkedRange(score,start,end);if(track!==null&&!score.tracks[track])throw new Error('トラックを選択してください。');const json=excerptJson(score,start,end,track);
  return {version:1,allTracks:track===null,masterbars:json.masterbars,tracks:json.tracks};
}
function mergeChords(source:Json,target:Json,bars:Json[]){if(!source.chords)return;target.chords??={};for(const [id,chord]of Object.entries(source.chords)){let next=id;while(target.chords[next]&&JSON.stringify(target.chords[next])!==JSON.stringify(chord))next+='-copy';target.chords[next]=clone(chord);if(next!==id)for(const b of bars)for(const v of b.voices)for(const beat of v.beats)if(beat.chordid===id)beat.chordid=next;}}
export function pasteBars(score:Score,clip:BarClipboard,index:number,track:number,insert:boolean):Score{
  if(clip.version!==1||!clip.masterbars.length||!clip.tracks.length)throw new Error('コピーした小節がありません。');
  if(!Number.isInteger(index)||index<0||index>score.masterBars.length)throw new Error('貼り付け位置が不正です。');
  const j=data(score),count=clip.masterbars.length;
  const pairs=clip.allTracks?clip.tracks.map((source,i)=>({source,target:j.tracks[i]})):[{source:clip.tracks[0],target:j.tracks[track]}];
  if(clip.allTracks&&clip.tracks.length!==j.tracks.length)throw new Error('全トラックの貼り付けには同じトラック数が必要です。');
  for(const {source,target}of pairs){if(!target||source.staves.length!==target.staves.length)throw new Error('貼り付け先の段数がコピー元と異なります。');for(let i=0;i<source.staves.length;i++){const a=source.staves[i],b=target.staves[i],strings=b.stringtuning?.tunings?.length??0;if(!!a.ispercussion!==!!b.ispercussion||!!a.stringtuning?.tunings?.length!==!!strings)throw new Error('コピー元と貼り付け先の楽器の種類が異なります。');for(const bar of a.bars)for(const v of bar.voices)for(const beat of v.beats)for(const note of beat.notes??[])if(note.string>strings)throw new Error('貼り付け先の弦数が足りません。');}}
  if(!insert&&index+count>j.masterbars.length)throw new Error('曲の末尾を超えます。「新しい小節として挿入」を選んでください。');
  if(!insert&&!clip.allTracks)for(let i=0;i<count;i++){const a=clip.masterbars[i],b=j.masterbars[index+i];if(a.timesignaturenumerator!==b.timesignaturenumerator||a.timesignaturedenominator!==b.timesignaturedenominator)throw new Error('拍子が異なります。「新しい小節として挿入」を選んでください。');}
  if(insert){j.masterbars.splice(index,0,...clone(clip.masterbars));for(const t of j.tracks)for(const s of t.staves)s.bars.splice(index,0,...Array.from({length:count},()=>blankBar(s.bars[Math.max(0,index-1)])));}
  else if(clip.allTracks)j.masterbars.splice(index,count,...clone(clip.masterbars));
  for(const {source,target}of pairs)for(let i=0;i<source.staves.length;i++){const bars=clone(source.staves[i].bars);cleanEditJson(bars,true);mergeChords(source.staves[i],target.staves[i],bars);target.staves[i].bars.splice(index,count,...bars);}
  return finish(j);
}
export function insertBars(score:Score,index:number,count:number):Score{
  if(!Number.isInteger(index)||index<0||index>score.masterBars.length||!Number.isInteger(count)||count<1||count>128)throw new Error('挿入する小節数は1〜128で指定してください。');
  const j=data(score),master=j.masterbars[Math.max(0,index-1)],newBars=Array.from({length:count},()=>blankMaster(master));if(index===0)newBars[0].tempoautomations=[{type:0,value:score.tempo,ratioposition:0,islinear:false,isvisible:true}];j.masterbars.splice(index,0,...newBars);
  for(const t of j.tracks)for(const s of t.staves)s.bars.splice(index,0,...Array.from({length:count},()=>blankBar(s.bars[Math.max(0,index-1)])));
  return finish(j);
}
export function deleteBars(score:Score,start:number,end:number):Score{
  const {count}=checkedRange(score,start,end),j=data(score);if(count===j.masterbars.length)throw new Error('曲には最低1小節を残してください。');
  let tempo=score.tempo;for(let i=0;i<=end+1;i++)for(const a of score.masterBars[i]?.tempoAutomations??[])if(i<=end||a.ratioPosition===0)tempo=a.value;
  j.masterbars.splice(start,count);if(!j.masterbars[start]?.tempoautomations.some((a:Json)=>a.ratioposition===0)&&j.masterbars[start])j.masterbars[start].tempoautomations.unshift({type:0,value:tempo,ratioposition:0,islinear:false,isvisible:true});for(const t of j.tracks)for(const s of t.staves)s.bars.splice(start,count);return finish(j);
}
export function sliceScore(score:Score,start:number,end:number):Score{
  checkedRange(score,start,end);const j=data(score);let tempo=score.tempo;for(let i=0;i<=start;i++)for(const a of score.masterBars[i].tempoAutomations)if(i<start||a.ratioPosition===0)tempo=a.value;
  j.masterbars=j.masterbars.slice(start,end+1);if(!j.masterbars[0].tempoautomations?.some((a:Json)=>a.ratioposition===0))j.masterbars[0].tempoautomations.unshift({type:0,value:tempo,ratioposition:0,islinear:false,isvisible:true});
  for(const t of j.tracks)for(const s of t.staves)s.bars=s.bars.slice(start,end+1);return finish(j);
}
export const tuningPresets:Record<string,number[]>={standard:[64,59,55,50,45,40],dropD:[64,59,55,50,45,38],halfDown:[63,58,54,49,44,39],guitar7:[64,59,55,50,45,40,35],bass4:[43,38,33,28],bass5:[43,38,33,28,23]};
const names=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export function pitchName(pitch:number){return names[(pitch%12+12)%12]+(Math.floor(pitch/12)-1);}
export function parsePitch(text:string):number{const m=/^([A-Ga-g])([#b]?)(-?\d)$/.exec(text.trim());if(!m)throw new Error('音名はE4、F#3、Bb2のように入力してください。');const pitch=(Number(m[3])+1)*12+({C:0,D:2,E:4,F:5,G:7,A:9,B:11}[m[1].toUpperCase()]!)+(m[2]==='#'?1:m[2]==='b'?-1:0);if(pitch<0||pitch>127)throw new Error('音高はMIDIの0〜127の範囲で指定してください。');return pitch;}
export type TrackConfig={name:string;tuning:number[];capo:number};
export function configureTrack(score:Score,index:number,config:TrackConfig):Score{
  const j=data(score),track=j.tracks[index];if(!track)throw new Error('トラックを選択してください。');if(!config.name.trim()||config.name.length>80)throw new Error('トラック名は1〜80文字で指定してください。');
  if(!Number.isInteger(config.capo)||config.capo<0||config.capo>12)throw new Error('カポは0〜12で指定してください。');
  if(!config.tuning.length||config.tuning.length>12||config.tuning.some(p=>!Number.isInteger(p)||p<0||p>127))throw new Error('弦数は1〜12、チューニングは有効な音名で指定してください。');
  const retuned=new Map<number,ReturnType<typeof planRetuning>>(),issues:RetuningIssue[]=[];track.name=track.shortname=config.name.trim();for(const [i,s]of track.staves.entries()){
    if(s.ispercussion||!s.stringtuning?.tunings?.length)continue;
    const staff=score.tracks[index].staves[i];
    if(staff.tuning.length!==config.tuning.length||staff.tuning.some((p,k)=>p!==config.tuning[k])){
      const plan=planRetuning(staff,config.tuning,config.capo);
      retuned.set(i,plan);issues.push(...plan.issues);
      for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes){
        const raw=s.bars[bar.index].voices[voice.index].beats[beat.index].notes[note.index],p=plan.positions.get(note);if(!p)continue;raw.string=p.string;raw.fret=p.fret;if(p.harmonicValue!==undefined)raw.harmonicvalue=p.harmonicValue;
      }
      for(const [id,frets]of plan.chords){const chord=s.chords[id];chord.strings=frets;chord.barrefrets=[];chord.firstfret=frets.some(f=>f>0)?Math.min(...frets.filter(f=>f>0)):1;}
    }
    s.stringtuning={tunings:[...config.tuning],name:'Custom',isstandard:false};s.capo=config.capo;
  }
  const next=finish(j);
  // finish() reconstructs ties and may inherit frets. Reject any altered pitch atomically.
  for(const [i,plan]of retuned)for(const bar of score.tracks[index].staves[i].bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes){
    if(plan.positions.has(note)&&next.tracks[index].staves[i].bars[bar.index].voices[voice.index].beats[beat.index].notes[note.index].realValue!==note.realValue)issues.push(retuningIssue(beat,'タイや奏法のつながりを再構築すると音程が変わるため、音程を維持できません。',note));
  }
  if(issues.length)throw new RetuningError(issues);
  return next;
}
function assignChannels(j:Json){let channel=0;for(const t of j.tracks){if(t.staves.some((s:Json)=>s.ispercussion)){t.playbackinfo.primarychannel=t.playbackinfo.secondarychannel=9;continue;}if(channel===9)channel++;if(channel>15)throw new Error('音程楽器のトラックは最大15までです。');t.playbackinfo.primarychannel=t.playbackinfo.secondarychannel=channel++;}}
export type TrackKind='guitar'|'guitar7'|'bass'|'bass5'|'drums'|'keyboard';
export function addTrack(score:Score,kind:TrackKind|boolean=false):Score{
 const type=typeof kind==='boolean'?(kind?'bass':'guitar'):kind,bass=type==='bass'||type==='bass5',drums=type==='drums',keyboard=type==='keyboard',j=data(score),t=new at.model.Track();t.name=drums?'Drums':keyboard?'Keyboard':bass?'Bass':'Guitar '+(score.tracks.length+1);t.shortName=t.name;t.playbackInfo.program=keyboard||drums?0:bass?33:27;
 for(let i=0;i<(keyboard?2:1);i++){const staff=new at.model.Staff();staff.isPercussion=drums;staff.stringTuning.tunings=drums||keyboard?[]:[...(type==='bass5'?tuningPresets.bass5:bass?tuningPresets.bass4:type==='guitar7'?tuningPresets.guitar7:tuningPresets.standard)];staff.displayTranspositionPitch=drums||keyboard?0:-12;staff.showTablature=!drums&&!keyboard;staff.showStandardNotation=true;t.addStaff(staff);}
 const empty=new at.model.Score();empty.addTrack(t);const raw=data(empty).tracks[0];for(const [i,staff]of raw.staves.entries())staff.bars=j.masterbars.map((m:Json)=>blankBar({clef:drums?at.model.Clef.Neutral:bass||keyboard&&i===1?at.model.Clef.F4:at.model.Clef.G2,keysignature:drums?0:m.keysignature??0}));j.tracks.push(raw);assignChannels(j);return finish(j);
}

export function removeTrack(score:Score,index:number):Score{if(score.tracks.length===1)throw new Error('最低1トラックを残してください。');const j=data(score);if(!j.tracks[index])throw new Error('トラックを選択してください。');j.tracks.splice(index,1);assignChannels(j);return finish(j);}
export function duplicateTrack(score:Score,index:number):Score{const j=data(score);if(!j.tracks[index])throw new Error('トラックを選択してください。');const copy=clone(j.tracks[index]);cleanEditJson(copy,true);copy.name=copy.shortname=(copy.name||'Track')+' コピー';j.tracks.splice(index+1,0,copy);assignChannels(j);return finish(j);}
export function moveTrack(score:Score,index:number,destination:number):Score{const j=data(score);if(!j.tracks[index]||!j.tracks[destination])throw new Error('トラックの移動先が不正です。');j.tracks.splice(destination,0,j.tracks.splice(index,1)[0]);assignChannels(j);return finish(j);}
