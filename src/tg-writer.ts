/* SPDX-License-Identifier: LGPL-2.1-or-later
 * TG 2.0 XML serialization adapted from TuxGuitar's TGSongWriterImpl/TGStream.
 * Copyright TuxGuitar contributors (Julian Casadesus, guiv42, helge17).
 * Corresponding source and license: ../licenses/.
 * TypeScript adaptation: Tab Studio contributors, 2026.
 */
import * as at from '@coderline/alphatab';
import {zipSync,strToU8} from 'fflate';
import {beatQ,project,type Score,type Beat,type Note} from './score';

// lcm(64, 1,3,5,6,7,9,10,11,12,13), the TG 2.0 precise quarter unit.
export const TG_QUARTER=2882880;
const esc=(value:unknown)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
const tag=(name:string,value:unknown='')=>`<${name}>${esc(value)}</${name}>`;
const clamp=(n:number,max:number)=>Math.max(0,Math.min(max,Math.round(n)));
function duration(b:Beat){
  let value=Number(b.duration),dots=b.dots,enters=b.hasTuplet?b.tupletNumerator:1,times=b.hasTuplet?b.tupletDenominator:1;
  // A full-bar rest must last the complete meter, including e.g. 3/4 and 6/8.
  if(b.isFullBarRest){const q=beatQ(b);value=1;dots=0;enters=4;times=q;while(!Number.isInteger(times)){times*=2;enters*=2;}}
  if(value<1){times*=-value;value=1;}
  const division=enters!==times?`<divisionType enters="${enters}" times="${times}"/>`:'';
  return `<duration value="${value}"${dots?` dotted="${dots===2?'doubleDotted':'dotted'}"`:''}>${division}</duration>`;
}
function noteXml(n:Note,b:Beat,tuning:number[],percussion:boolean){
  let string=tuning.length-n.string+1,fret=n.fret;
  if(percussion){string=1;fret=n.percussionArticulation;}
  else if(!n.isStringed){string=1;fret=n.realValue-tuning[0];}
  const flags:[string,boolean][]=[['vibrato',!!n.vibrato],['deadNote',n.isDead],['slide',!!n.slideOutType||!!n.slideInType],['hammer',n.isHammerPullOrigin],['ghostNote',n.isGhost],['accentuatedNote',n.accentuated===at.model.AccentuationType.Normal],['heavyAccentuatedNote',n.accentuated===at.model.AccentuationType.Heavy],['palmMute',n.isPalmMute],['staccato',n.isStaccato],['letRing',n.isLetRing],['tapping',b.tap],['slapping',b.slap],['popping',b.pop],['fadeIn',b.fade===at.model.FadeType.FadeIn]];
  let effects=flags.filter(([,on])=>on).map(([name])=>`<${name}/>`).join('');
  for(const [name,points]of [['bend',n.bendPoints],['tremoloBar',b.whammyBarPoints]]as const)if(points?.length)effects+=`<${name}>${points.map(p=>`<point position="${Math.round(p.offset/5)}" value="${Math.round(p.value/2)}"/>`).join('')}</${name}>`;
  if(n.harmonicType){const type=({[at.model.HarmonicType.Natural]:'N.H',[at.model.HarmonicType.Artificial]:'A.H',[at.model.HarmonicType.Tap]:'T.H',[at.model.HarmonicType.Pinch]:'P.H',[at.model.HarmonicType.Semi]:'S.H'}as Record<number,string>)[n.harmonicType]||'A.H';effects+=`<harmonic type="${type}" data="${Math.round(n.harmonicValue)}"/>`;}
  if(n.trillValue>=0)effects+=`<trill fret="${n.trillFret}" duration="${n.trillSpeed}"/>`;
  if(b.tremoloPicking)effects+=`<tremoloPicking duration="${4*2**b.tremoloPicking.marks}"/>`;
  return `<note value="${fret}" string="${string}" velocity="${clamp(15+16*b.dynamics,127)}"${n.isTieDestination?' tiedNote="true"':''}>${effects}</note>`;
}
function measureXml(staff:at.model.Staff,index:number,start:number,tuning:number[],voiceOffset:number){
  const bar=staff.bars[index];const events=new Map<number,Map<number,Beat>>();
  for(const voice of bar.voices.slice(voiceOffset,voiceOffset+2)){let offset=0;for(const beat of voice.beats){const tick=Math.round((start+offset)*TG_QUARTER);if(!beat.isEmpty){if(!events.has(tick))events.set(tick,new Map());events.get(tick)!.set(voice.index-voiceOffset,beat);}offset+=beatQ(beat);}}
  let xml='<TGMeasure>'+tag('clef',bar.clef===at.model.Clef.F4?'bass':'treble')+tag('keySignature',bar.keySignature>=0?bar.keySignature:7-bar.keySignature);
  if(!events.size)xml+=`<TGBeat>${tag('preciseStart',Math.round(start*TG_QUARTER))}<voice empty="false"><duration value="4"><divisionType enters="${bar.masterBar.timeSignatureDenominator}" times="${bar.masterBar.timeSignatureNumerator*4}"/></duration></voice><voice empty="true"><duration value="4"/></voice></TGBeat>`;
  for(const [tick,voices]of [...events].sort(([a],[b])=>a-b)){
    const first=[...voices.values()][0];xml+=`<TGBeat>${tag('preciseStart',tick)}`;
    if(first.text)xml+=tag('text',first.text);
    if(first.brushType)xml+=`<stroke direction="${first.brushType===at.model.BrushType.BrushUp||first.brushType===at.model.BrushType.ArpeggioUp?'up':'down'}" value="${first.brushDuration<=120?32:8}"/>`;
    for(let vi=0;vi<2;vi++){const b=voices.get(vi);xml+=b?`<voice empty="false">${duration(b)}${b.notes.map(n=>noteXml(n,b,tuning,staff.isPercussion)).join('')}</voice>`:'<voice empty="true"><duration value="4"/></voice>';}
    xml+='</TGBeat>';
  }
  return xml+'</TGMeasure>';
}
export function exportTg(score:Score,sourceName='',warnings:string[]=[]):Uint8Array{
  let xml='<?xml version="1.0" encoding="UTF-8"?><TuxGuitarFile><TGVersion major="2" minor="0" revision="0"/><TGSong>';
  for(const [name,value]of [['name',score.title],['artist',score.artist],['album',score.album],['author',score.music],['date',''],['copyright',score.copyright],['writer',score.words],['transcriber',score.tab],['comments',score.notices]])xml+=tag(name,value);
  const staves=score.tracks.flatMap(track=>track.staves.flatMap(staff=>{
    const count=Math.max(1,...staff.bars.flatMap(b=>b.voices.filter(v=>v.beats.some(b=>!b.isEmpty)).map(v=>v.index+1)));
    return Array.from({length:Math.ceil(count/2)},(_,group)=>({track,staff,voiceOffset:group*2}));
  }));
  for(const [index,{track,staff}]of staves.entries()){
    const p=track.playbackInfo;xml+='<TGChannel>'+tag('id',index)+tag('bank',staff.isPercussion?128:0)+tag('program',p.program)+tag('volume',clamp(p.volume/16*127,127))+tag('balance',clamp(p.balance/16*127,127));
    for(const name of ['chorus','reverb','phaser','tremolo'])xml+=tag(name,0);xml+=tag('name',track.name)+'</TGChannel>';
  }
  let tempo=score.tempo;
  for(const bar of score.masterBars){for(const change of bar.tempoAutomations)if(change.ratioPosition===0)tempo=change.value;xml+=`<TGMeasureHeader><timeSignature numerator="${bar.timeSignatureNumerator}" denominator="${bar.timeSignatureDenominator}"/>${tag('tempo',Math.round(tempo))}`;
    if(bar.isRepeatStart)xml+='<repeatOpen/>';if(bar.repeatCount>1)xml+=tag('repeatClose',bar.repeatCount-1);
    if(bar.alternateEndings){xml+='<repeatAlternative>';for(let i=0;i<8;i++)if(bar.alternateEndings&(1<<i))xml+=tag('alternative',i+1);xml+='</repeatAlternative>';}
    if(bar.section)xml+=`<marker R="220" G="50" B="50">${esc(bar.section.text)}</marker>`;
    if(bar.tripletFeel===at.model.TripletFeel.Triplet8th)xml+=tag('tripletFeel','eighth');else if(bar.tripletFeel===at.model.TripletFeel.Triplet16th)xml+=tag('tripletFeel','sixteenth');xml+='</TGMeasureHeader>';
  }
  for(const [index,{track,staff,voiceOffset}]of staves.entries()){
    const tuning=staff.tuning.length?staff.tuning:[0];
    xml+=`<TGTrack maxFret="127">${tag('name',track.name+(track.staves.length>1?` (${staff.index+1})`:'')+(voiceOffset?` (声部${voiceOffset+1}–${voiceOffset+2})`:''))}${tag('channelId',index)}`;
    if(track.playbackInfo.isMute)xml+=tag('soloMute','mute');else if(track.playbackInfo.isSolo)xml+=tag('soloMute','solo');
    xml+=tag('offset',staff.capo-staff.transpositionPitch)+`<color R="${track.color.r}" G="${track.color.g}" B="${track.color.b}"/>`+tuning.map(n=>tag('TGString',n)).join('');
    let start=1;for(let i=0;i<score.masterBars.length;i++){xml+=measureXml(staff,i,start,tuning,voiceOffset);start+=score.masterBars[i].timeSignatureNumerator*4/score.masterBars[i].timeSignatureDenominator;}xml+='</TGTrack>';
  }
  xml+='</TGSong></TuxGuitarFile>';
  // An ignored XML element preserves alphaTab details without adding ZIP entries
  // (TG's official reader requires exactly version.txt and content.xml).
  // Use it only while the TG content still exactly matches this saved snapshot.
  const extra=tag('TabStudioProject',JSON.stringify({contentXml:xml,project:JSON.parse(project(score,sourceName,warnings))}));
  const content=xml.replace('</TuxGuitarFile>',extra+'</TuxGuitarFile>');
  const bytes=strToU8(content);if(bytes.length>40*1024*1024)throw new Error('TGの保存データが40MBを超えています。');
  return zipSync({'version.txt':strToU8('TuxGuitar_file_format 2.0.0'),'content.xml':bytes},{level:6});
}
