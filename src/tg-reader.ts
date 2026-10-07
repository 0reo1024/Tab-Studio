/* SPDX-License-Identifier: LGPL-2.1-or-later
 * TG wire-format reader adapted from TuxGuitar's TGStream/TGSongReaderImpl.
 * Copyright TuxGuitar contributors (Julian Casadesus, guiv42, helge17).
 * Original corresponding source and license: ../licenses/.
 * TypeScript adaptation: Tab Studio contributors, 2026.
 */
import * as at from '@coderline/alphatab';
import { unzipSync, strFromU8 } from 'fflate';
import { settings, readProject, type Score } from './score';

type Dur = { value: number; dots: number; enters: number; times: number };
type Effects = { bits: number; bend?: number[][]; whammy?: number[][]; harmonic?: number; harmonicData?: number };
type TNote = { fret: number; string: number; tied: boolean; velocity: number; effects: Effects };
type TBeat = { dur: Dur; notes: TNote[]; text?: string; startQ?: number };
type Header = { numerator: number; denominator: number; bpm: number; open: boolean; close: number; alternatives: number; marker: string; swing: number };
type TTrack = { name: string; channel: number; solo: boolean; mute: boolean; tuning: number[]; offset: number; measures: TBeat[][][] };
type TSong = { title: string; artist: string; headers: Header[]; tracks: TTrack[]; channels: Map<number, {program:number;bank:number;volume:number;balance:number}>; warnings: string[]; native?:{score:Score;warnings:string[]} };
const duration = (): Dur => ({value:4,dots:0,enters:1,times:1});
const q = (d: Dur) => 4/d.value * (2-1/2**d.dots) * d.times/d.enters;
function checkedCount(n:number, max:number, what:string) { if (!Number.isInteger(n)||n<0||n>max) throw new Error(`TGの${what}が不正です。`); return n; }

class Binary {
  p=0; view:DataView;
  constructor(private bytes:Uint8Array) { this.view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength); }
  need(n:number) { if(n<0||this.p+n>this.bytes.length) throw new Error(`TGファイルが途中で切れています（位置${this.p}）。`); }
  u8() { this.need(1); return this.view.getUint8(this.p++); }
  i8() { this.need(1); return this.view.getInt8(this.p++); }
  i16() { this.need(2); const v=this.view.getInt16(this.p);this.p+=2;return v; }
  i32() { this.need(4); const v=this.view.getInt32(this.p);this.p+=4;return v; }
  text(long=false) { const n=checkedCount(long?this.i32():this.u8(),1_000_000,'文字数'); this.need(n*2); let s='';for(let i=0;i<n;i++){s+=String.fromCharCode(this.view.getUint16(this.p));this.p+=2;}return s; }
  skip(n:number) { this.need(n);this.p+=n; }
  dur():Dur { const f=this.u8(), value=this.u8();if(![1,2,4,8,16,32,64,128].includes(value))throw new Error('未対応のTG音価です。');
    const d={value,dots:f&2?2:f&1?1:0,enters:1,times:1};if(f&4){d.enters=this.u8();d.times=this.u8();if(!d.enters||!d.times)throw new Error('TG連符が不正です。');}return d; }
  points(whammy=false) { const n=checkedCount(this.u8(),128,'ベンド点');const a:number[][]=[];for(let i=0;i<n;i++)a.push([this.u8(),this.u8()-(whammy?12:0)]);return a; }
  effect(warnings:Set<string>):Effects { const bits=this.u8()*65536+this.u8()*256+this.u8(), e:Effects={bits};
    if(bits&1)e.bend=this.points();if(bits&2)e.whammy=this.points(true);
    if(bits&4){e.harmonic=this.u8();if(e.harmonic!==1)e.harmonicData=this.i8();}
    if(bits&8){this.skip(5);warnings.add('TGの装飾音（grace）は初期版では省略しています。');}
    if(bits&16){this.skip(2);warnings.add('TGのトリルは初期版では省略しています。');}
    if(bits&32){this.skip(1);warnings.add('TGのトレモロピッキングは初期版では省略しています。');}
    return e;
  }
}

function binarySong(bytes:Uint8Array):TSong {
  const r=new Binary(bytes),version=r.text();
  if(version!=='TuxGuitar File Format - 1.5')throw new Error(`このTGバージョンは未対応です：${version || '不明'}。対応は1.5互換形式と2.x形式です。`);
  const s:TSong={title:r.text(),artist:r.text(),headers:[],tracks:[],channels:new Map(),warnings:[]};
  for(let i=0;i<6;i++)r.text();r.text(true);
  for(let i=0,n=checkedCount(r.u8(),128,'チャンネル数');i<n;i++){
    const id=r.i16(),bank=r.u8(),program=r.u8(),volume=r.u8(),balance=r.u8();r.skip(4);r.text();
    for(let j=0,n=checkedCount(r.i16(),4096,'パラメータ数');j<n;j++){r.text();r.text(true);}
    s.channels.set(id,{bank,program,volume,balance});
  }
  for(let i=0,n=checkedCount(r.i16(),10000,'小節数');i<n;i++){
    const f=r.u8(),prev=s.headers.at(-1),h:Header={numerator:prev?.numerator||4,denominator:prev?.denominator||4,bpm:prev?.bpm||120,open:!!(f&4),close:0,alternatives:0,marker:'',swing:prev?.swing||0};
    if(f&1){h.numerator=r.u8();h.denominator=r.dur().value;}if(f&2)h.bpm=r.i16();if(f&8)h.close=r.i16();if(f&16)h.alternatives=r.u8();if(f&32){h.marker=r.text();r.skip(3);}if(f&64)h.swing=r.u8();s.headers.push(h);
  }
  const warn=new Set<string>();
  for(let ti=0,n=checkedCount(r.u8(),128,'トラック数');ti<n;ti++){
    const f=r.u8(),t:TTrack={name:r.text(),channel:r.i16(),solo:!!(f&1),mute:!!(f&2),tuning:[],offset:0,measures:[]};
    for(let mi=0;mi<s.headers.length;mi++){
      const mf=r.u8(),voices:TBeat[][]=[[],[]],state=[{flags:0,dur:duration(),vel:95},{flags:0,dur:duration(),vel:95}];let count=0,more=true;
      while(more){if(++count>100000)throw new Error('TGの拍数が上限を超えています。');const bf=r.u8();more=!!(bf&1);
        const created:TBeat[]=[];
        for(let vi=0;vi<2;vi++){
          if(!(bf&(16<<(vi*2))))continue;const st=state[vi];if(bf&(32<<(vi*2)))st.flags=r.u8();if(st.flags&2)st.dur=r.dur();
          const beat:TBeat={dur:{...st.dur},notes:[]};
          if(st.flags&1){let nm=true,nc=0;while(nm){if(++nc>128)throw new Error('TG和音の音数が不正です。');const nf=r.u8();nm=!!(nf&1);const nn:TNote={fret:r.i8(),string:r.i8(),tied:!!(nf&2),velocity:st.vel,effects:{bits:0}};if(nf&8)st.vel=r.u8();nn.velocity=st.vel;if(nf&4)nn.effects=r.effect(warn);beat.notes.push(nn);}}
          voices[vi].push(beat);created.push(beat);
        }
        if(bf&2){r.skip(2);warn.add('TGのブラシストロークは初期版では省略しています。');}
        if(bf&4){const strings=r.u8();r.text();r.skip(1+strings);warn.add('TGのコードダイアグラムは初期版では省略しています。');}
        if(bf&8){const text=r.text();created.forEach(b=>b.text=text);}
      }
      if(mf&1)r.skip(1);if(mf&2)r.skip(1);t.measures.push(voices);
    }
    for(let i=0,n=checkedCount(r.u8(),12,'弦数');i<n;i++)t.tuning.push(r.u8());t.offset=r.i8()-24;r.skip(3);
    if(f&4){r.i16();r.text(true);warn.add('TGの歌詞は初期版では省略しています。');}
    s.tracks.push(t);
  }
  s.warnings=[...warn];return s;
}

function elements(node:Node,tag:string):Element[]{return Array.from(node.childNodes).filter(n=>n.nodeType===1&&(n as Element).tagName===tag) as Element[];}
const child=(node:Node,tag:string)=>elements(node,tag)[0];
const text=(node:Node,tag:string, fallback='')=>child(node,tag)?.textContent??fallback;
const num=(node:Node,tag:string,fallback=0)=>Number(text(node,tag,String(fallback)));
const attr=(e:Element,name:string,fallback=0)=>Number(e.getAttribute(name)??fallback);
function xmlSong(bytes:Uint8Array):TSong {
  // Filter before decompression to cap expansion of the content entry.
  let expanded=0;
  const files=unzipSync(bytes,{filter:file=>{if(!['content.xml','version.txt'].includes(file.name))return false;expanded+=file.originalSize;if(expanded>40*1024*1024)throw new Error('TGの展開サイズが上限を超えています。');return true;}});
  if(!files['content.xml']||!files['version.txt'])throw new Error('TGのcontent.xmlまたはversion.txtがありません。');
  const version=strFromU8(files['version.txt']).trim();if(!/^TuxGuitar_file_format\s+2\./.test(version))throw new Error(`未対応のTG形式です：${version}`);
  const xml=strFromU8(files['content.xml']);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('外部エンティティを含むXMLは読み込めません。');
  const doc=new DOMParser().parseFromString(xml,'application/xml');if(doc.getElementsByTagName('parsererror').length)throw new Error('TGのXMLが不正です。');
  const root=doc.getElementsByTagName('TGSong')[0];if(!root)throw new Error('TGSongがありません。');
  const s:TSong={title:text(root,'name'),artist:text(root,'artist'),headers:[],tracks:[],channels:new Map(),warnings:[]};const warn=new Set<string>();
  const extra=doc.getElementsByTagName('TabStudioProject');
  if(extra.length===1)try{
    const saved=JSON.parse(extra[0].textContent||'');
    const originalXml=xml.replace(/<TabStudioProject>[\s\S]*?<\/TabStudioProject>/,'');
    if(saved.contentXml===originalXml)s.native=readProject(JSON.stringify(saved.project));
  }catch{} // External editors may remove or change supplemental data.
  for(const c of elements(root,'TGChannel'))s.channels.set(num(c,'id'),{bank:num(c,'bank'),program:num(c,'program'),volume:num(c,'volume',100),balance:num(c,'balance',64)});
  let numerator=4,denominator=4,bpm=120;
  for(const hh of elements(root,'TGMeasureHeader')){
    const sig=child(hh,'timeSignature');if(sig){numerator=attr(sig,'numerator');denominator=attr(sig,'denominator');}
    const te=child(hh,'tempo');if(te)bpm=Number(te.textContent)*(4/attr(te,'base',4))*(te.getAttribute('dotted')==='true'?1.5:1);
    let alternatives=0;const aa=child(hh,'repeatAlternative');if(aa)for(const a of elements(aa,'alternative'))alternatives|=1<<(Number(a.textContent)-1);
    const swing=text(hh,'tripletFeel');s.headers.push({numerator,denominator,bpm,open:!!child(hh,'repeatOpen'),close:num(hh,'repeatClose',0),alternatives,marker:text(hh,'marker'),swing:swing==='eighth'?1:swing==='sixteenth'?2:0});
  }
  checkedCount(s.headers.length,10000,'小節数');
  const first=root.getElementsByTagName('TGBeat')[0];const unit=first?num(first,'preciseStart'):0;
  if(!Number.isFinite(unit)||unit<=0)throw new Error('TGの時間単位を読み取れません。');
  for(const tr of elements(root,'TGTrack')){
    const t:TTrack={name:text(tr,'name'),channel:num(tr,'channelId'),solo:text(tr,'soloMute')==='solo',mute:text(tr,'soloMute')==='mute',tuning:elements(tr,'TGString').map(n=>Number(n.textContent)),offset:num(tr,'offset'),measures:[]};let barStart=0;
    const mm=elements(tr,'TGMeasure');if(mm.length!==s.headers.length)throw new Error('TGのトラック間で小節数が一致しません。');
    for(let mi=0;mi<mm.length;mi++){
      const voices:TBeat[][]=[[],[]];
      for(const bb of elements(mm[mi],'TGBeat')){
        for(const [vi,vv] of elements(bb,'voice').entries()){
          if(vi>1){warn.add('TGの3声以上の声部は省略しています。');continue;}if(vv.getAttribute('empty')==='true')continue;
          const dd=child(vv,'duration');if(!dd)throw new Error('TGの音価がありません。');const div=child(dd,'divisionType'),dot=dd.getAttribute('dotted');
          const beat:TBeat={dur:{value:attr(dd,'value'),dots:dot==='doubleDotted'?2:dot==='dotted'?1:0,enters:div?attr(div,'enters',1):1,times:div?attr(div,'times',1):1},notes:[],text:text(bb,'text'),startQ:num(bb,'preciseStart')/unit-1-barStart};
          let velocity=95;
          for(const nn of elements(vv,'note')){
            velocity=attr(nn,'velocity',velocity);let bits=0;
            const flags:Record<string,number>={vibrato:64,deadNote:128,slide:256,hammer:512,ghostNote:1024,accentuatedNote:2048,heavyAccentuatedNote:4096,palmMute:8192,staccato:16384,tapping:32768,slapping:65536,popping:131072,fadeIn:262144,letRing:524288};
            for(const [name,flag]of Object.entries(flags))if(child(nn,name))bits|=flag;
            const effect:Effects={bits};
            for(const [name,key]of [['bend','bend'],['tremoloBar','whammy']] as const){const e=child(nn,name);if(e)effect[key]=elements(e,'point').map(p=>[attr(p,'position'),attr(p,'value')]);}
            const harmonic=child(nn,'harmonic');if(harmonic){effect.harmonic=({'N.H':1,'A.H':2,'T.H':3,'P.H':4,'S.H':5}as Record<string,number>)[harmonic.getAttribute('type')||''];effect.harmonicData=attr(harmonic,'data');}
            for(const tag of ['grace','trill','tremoloPicking','alternativeEnharmonic'])if(child(nn,tag))warn.add(`TGの${tag}は初期版では省略しています。`);
            beat.notes.push({fret:attr(nn,'value'),string:attr(nn,'string'),tied:nn.getAttribute('tiedNote')==='true',velocity,effects:effect});
          }
          if(child(bb,'chord'))warn.add('TGのコードダイアグラムは初期版では省略しています。');if(child(bb,'stroke'))warn.add('TGのブラシストロークは初期版では省略しています。');voices[vi].push(beat);
        }
      }
      t.measures.push(voices);barStart+=s.headers[mi].numerator*4/s.headers[mi].denominator;
    }
    if(child(tr,'TGLyric'))warn.add('TGの歌詞は初期版では省略しています。');s.tracks.push(t);
  }
  s.warnings=[...warn];return s;
}

function restForQ(value:number):at.model.Beat {
  const b=new at.model.Beat();b.duration=at.model.Duration.Quarter;
  // Arbitrary rational duration expressed as quarter-note tuplet. Allows exact gaps.
  const denom=720720;const n=Math.round(value*denom);function gcd(a:number,b:number):number{return b?gcd(b,a%b):a;}const g=gcd(n,denom);
  b.tupletNumerator=denom/g;b.tupletDenominator=n/g;return b;
}
function toAlpha(s:TSong):Score {
  if(!s.headers.length||!s.tracks.length)throw new Error('TGファイルに小節またはトラックがありません。');
  const score=new at.model.Score();score.title=s.title;score.artist=s.artist;
  s.headers.forEach((h,i)=>{
    if(h.numerator<=0||h.denominator<=0||h.bpm<=0)throw new Error(`TGの${i+1}小節の拍子またはテンポが不正です。`);
    const mb=new at.model.MasterBar();mb.timeSignatureNumerator=h.numerator;mb.timeSignatureDenominator=h.denominator;mb.isRepeatStart=h.open;mb.repeatCount=h.close>0?h.close+1:0;mb.alternateEndings=h.alternatives;
    mb.tripletFeel=h.swing===1?at.model.TripletFeel.Triplet8th:h.swing===2?at.model.TripletFeel.Triplet16th:at.model.TripletFeel.NoTripletFeel;
    if(i===0||h.bpm!==s.headers[i-1].bpm)mb.tempoAutomations.push(at.model.Automation.buildTempoAutomation(false,0,h.bpm,2));
    if(h.marker){const section=new at.model.Section();section.text=h.marker;section.marker=String(i+1);mb.section=section;}score.addMasterBar(mb);
  });
  s.tracks.forEach((tt,ti)=>{
    const track=new at.model.Track();track.name=tt.name;const channel=s.channels.get(tt.channel);track.playbackInfo.program=channel?.program??27;track.playbackInfo.volume=Math.round((channel?.volume??100)/127*16);track.playbackInfo.balance=Math.round((channel?.balance??64)/127*16);track.playbackInfo.isMute=tt.mute;track.playbackInfo.isSolo=tt.solo;
    track.playbackInfo.primaryChannel=ti>=9?ti+1:ti;track.playbackInfo.secondaryChannel=Math.min(15,track.playbackInfo.primaryChannel);const st=new at.model.Staff();st.stringTuning.tunings=tt.tuning;st.capo=Math.max(0,tt.offset);st.transpositionPitch=-Math.min(0,tt.offset);st.isPercussion=channel?.bank===128;st.showTablature=!st.isPercussion&&tt.tuning.length>0;st.showStandardNotation=true;track.addStaff(st);score.addTrack(track);
    tt.measures.forEach((voices,mi)=>{
      const bar=new at.model.Bar();st.addBar(bar);
      for(const vb of voices){const v=new at.model.Voice();bar.addVoice(v);let currentQ=0;
        for(const tb of vb){
          if(tb.startQ!==undefined&&tb.startQ>currentQ+1e-7){v.addBeat(restForQ(tb.startQ-currentQ));currentQ=tb.startQ;}
          const b=new at.model.Beat();b.duration=tb.dur.value;b.dots=tb.dur.dots;b.tupletNumerator=tb.dur.enters;b.tupletDenominator=tb.dur.times;b.text=tb.text||null;b.dynamics=tb.notes.length?Math.max(0,Math.min(7,Math.round((tb.notes[0].velocity-15)/16))):at.model.DynamicValue.MF;
          if(tb.notes.some(n=>n.velocity!==tb.notes[0]?.velocity))s.warnings.push(`${tt.name}・${mi+1}小節：同時音の強弱を拍単位へまとめています。`);
          for(const tn of tb.notes){const n=new at.model.Note();n.fret=tn.fret;n.string=tt.tuning.length-tn.string+1;n.isTieDestination=tn.tied;
            if(st.isPercussion){n.percussionArticulation=tn.fret;n.string=-1;n.fret=-1;}
            const e=tn.effects, f=e.bits;n.isDead=!!(f&128);n.isGhost=!!(f&1024);n.isHammerPullOrigin=!!(f&512);n.isPalmMute=!!(f&8192);n.isStaccato=!!(f&16384);n.isLetRing=!!(f&524288);n.vibrato=f&64?at.model.VibratoType.Slight:at.model.VibratoType.None;n.slideOutType=f&256?at.model.SlideOutType.Shift:at.model.SlideOutType.None;
            n.accentuated=f&4096?at.model.AccentuationType.Heavy:f&2048?at.model.AccentuationType.Normal:at.model.AccentuationType.None;
            if(e.bend)for(const [position,value]of e.bend)n.addBendPoint(new at.model.BendPoint(position*5,value*2));
            if(e.whammy&&!b.hasWhammyBar)for(const [position,value]of e.whammy)b.addWhammyBarPoint(new at.model.BendPoint(position*5,value*2));
            if(e.harmonic){n.harmonicType=e.harmonic===3?at.model.HarmonicType.Tap:e.harmonic===4?at.model.HarmonicType.Pinch:e.harmonic;n.harmonicValue=tn.fret;if(e.harmonic!==1)s.warnings.push(`${tt.name}・${mi+1}小節：人工ハーモニクスの実音は近似です。`);}
            if(f&262144)b.fade=at.model.FadeType.FadeIn;b.addNote(n);
          }
          v.addBeat(b);currentQ+=q(tb.dur);
        }
        if(!v.beats.length){const rest=new at.model.Beat();rest.duration=at.model.Duration.Whole;rest.isEmpty=false;v.addBeat(rest);}
      }
    });
  });score.finish(settings);return score;
}

export function importTg(bytes:Uint8Array):{score:Score;warnings:string[]} {
  if(bytes.length>40*1024*1024)throw new Error('TGファイルが40MBを超えています。');
  const song=bytes[0]===80&&bytes[1]===75?xmlSong(bytes):binarySong(bytes);
  if(song.native)return song.native;
  const score=toAlpha(song);return {score,warnings:[...new Set(song.warnings)]};
}
