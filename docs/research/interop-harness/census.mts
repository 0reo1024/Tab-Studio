// Feature census and round-trip loss measurement through Tab Studio's own import/export code.
// Usage: node --import tsx census.ts <out.json> <file...>   (run with cwd = Tab Studio root)
import {readFileSync,writeFileSync} from 'node:fs';
import {basename,extname} from 'node:path';
const {DOMParser}=(await import('file:///C:/Users/takeu/Desktop/Tab Studio/node_modules/.pnpm/@xmldom+xmldom@0.9.12/node_modules/@xmldom/xmldom/lib/index.js')).default;
Object.assign(globalThis,{DOMParser});
const root='file:///C:/Users/takeu/Desktop/Tab Studio/src/';
const at=await import('file:///C:/Users/takeu/Desktop/Tab Studio/node_modules/.pnpm/@coderline+alphatab@1.8.4/node_modules/@coderline/alphatab/dist/alphaTab.mjs');
const {importGuitarPro}=await import(root+'score.ts');
const {importTg}=await import(root+'tg-reader.ts');
const {exportScore}=await import(root+'export-score.ts');
const ff=await import('file:///C:/Users/takeu/Desktop/Tab Studio/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/index.mjs');
function stripProject(bytes:Uint8Array){const z=ff.unzipSync(bytes);const x=ff.strFromU8(z['content.xml']).replace(/<TabStudioProject>[\s\S]*?<\/TabStudioProject>/,'');z['content.xml']=ff.strToU8(x);return ff.zipSync(z);}

type C=Record<string,number>;
function census(score:any){
 const c:C={};const inc=(k:string,n=1)=>{c[k]=(c[k]??0)+n;};
 const notes:string[]=[];
 c.tracks=score.tracks.length;c.masterBars=score.masterBars.length;
 for(const k of ['title','artist','album','words','music','copyright','tab','instructions','notices'])if(score[k])inc('meta.'+k);
 let prevTs='',prevKey='';
 for(const mb of score.masterBars){
  if(mb.section)inc('mb.section');if(mb.isRepeatStart)inc('mb.repeatStart');if(mb.repeatCount>0)inc('mb.repeatEnd');
  if(mb.alternateEndings>0)inc('mb.alternateEnding');if(mb.tempoAutomations?.length)inc('mb.tempoChange',mb.tempoAutomations.length);
  if(mb.directions?.size)inc('mb.direction(DS/Coda等)',mb.directions.size);if(mb.tripletFeel)inc('mb.tripletFeel');
  if(mb.isFreeTime)inc('mb.freeTime');if(mb.isAnacrusis)inc('mb.anacrusis');if(mb.fermata?.size)inc('mb.fermata',mb.fermata.size);
  const ts=mb.timeSignatureNumerator+'/'+mb.timeSignatureDenominator;if(prevTs&&ts!==prevTs)inc('mb.timeSigChange');prevTs=ts;
  const key=String(mb.keySignature);if(prevKey&&key!==prevKey)inc('mb.keyChange');prevKey=key;
 }
 for(const t of score.tracks){
  if(t.staves.length>1)inc('track.multiStaff');
  for(const s of t.staves){
   if(s.isPercussion)inc('staff.percussion');if(s.capo)inc('staff.capo');if(s.transpositionPitch)inc('staff.transposition');
   if(s.chords?.size)inc('staff.chordDiagrams',s.chords.size);
   const std=[64,59,55,50,45,40];if(s.tuning?.length&&!s.isPercussion&&s.tuning.join()!==std.join()&&s.tuning.length===6)inc('staff.altTuning6');
   for(const bar of s.bars){
    if(bar.simileMark)inc('bar.simile');
    const used=bar.voices.filter((v:any)=>!v.isEmpty&&v.beats.some((b:any)=>!b.isEmpty&&(b.notes.length||!b.isRest)));
    if(used.length>1)inc('bar.multiVoice');
    for(const v of bar.voices)for(const b of v.beats){
     if(b.isEmpty)continue;
     if(b.graceType)inc('beat.grace');if(b.hasTuplet)inc('beat.tuplet');if(b.hasTuplet&&b.tupletNumerator!==3)inc('beat.tupletNon3');
     if(b.isTremolo)inc('beat.tremoloPicking');if(b.whammyBarType)inc('beat.whammy');if(b.fade)inc('beat.fade');
     if(b.slap)inc('beat.slap');if(b.pop)inc('beat.pop');if(b.tap)inc('beat.tap');if(b.lyrics?.some((l:string)=>l))inc('beat.lyrics');
     if(b.chordId)inc('beat.chord');if(b.text)inc('beat.text');if(b.brushType)inc('beat.brush/arpeggio');if(b.pickStroke)inc('beat.pickStroke');
     if(b.fermata)inc('beat.fermata');if(b.crescendo)inc('beat.hairpin');if(b.vibrato)inc('beat.wideVibrato');if(b.ottava!==undefined&&b.ottava!==at.model.Ottavia.Regular)inc('beat.ottava');
     if(b.deadSlapped)inc('beat.deadSlapped');if(b.golpe)inc('beat.golpe');if(b.wahPedal)inc('beat.wah');if(b.dots)inc('beat.dotted');if(b.isRest)inc('beat.rest');
     if(b.rasgueado)inc('beat.rasgueado');if(b.isLegatoOrigin)inc('beat.legatoSlur');
     inc('beat.dyn.'+b.dynamics);
     for(const n of b.notes){
      inc('notes');notes.push([t.index,s.index,bar.index,v.index,b.playbackStart,b.duration,b.dots,n.string,n.fret,n.octave,n.tone,n.isTieDestination?1:0].join(':'));
      if(n.bendType){inc('note.bend');inc('note.bendType.'+n.bendType+'/pts'+(n.bendPoints?.length??0));}if(n.slideOutType)inc('note.slideOut');if(n.slideInType)inc('note.slideIn');
      if(n.harmonicType)inc('note.harmonic');if(n.isPalmMute)inc('note.palmMute');if(n.vibrato)inc('note.vibrato');if(n.isLetRing)inc('note.letRing');
      if(n.isDead)inc('note.dead');if(n.isGhost)inc('note.ghost');if(n.accentuated)inc('note.accent');if(n.isTieDestination)inc('note.tie');
      if(n.isHammerPullOrigin)inc('note.hammerPull');if(n.leftHandFinger>=0)inc('note.lhFinger');if(n.rightHandFinger>=0)inc('note.rhFinger');
      if(n.isStaccato)inc('note.staccato');if(n.isTrill)inc('note.trill');if(n.isLeftHandTapped)inc('note.lhTap');if(n.ornament)inc('note.ornament');
      if(n.accidentalMode)inc('note.accidentalMode');if(n.isSlurOrigin)inc('note.slur');if(n.isPercussion)inc('note.percussion');
     }
    }
   }
  }
 }
 return {c,notes};
}
function load(name:string,bytes:Uint8Array){const e=extname(name).toLowerCase();if(e==='.tg')return importTg(bytes).score;return importGuitarPro(bytes);}
function compare(a:ReturnType<typeof census>,b:ReturnType<typeof census>){
 const lost:C={},gained:C={};
 for(const k of new Set([...Object.keys(a.c),...Object.keys(b.c)])){const d=(b.c[k]??0)-(a.c[k]??0);if(d<0)lost[k]=-d;else if(d>0)gained[k]=d;}
 const bag=new Map<string,number>();for(const x of a.notes)bag.set(x,(bag.get(x)??0)+1);let same=0;for(const x of b.notes){const n=bag.get(x)??0;if(n>0){same++;bag.set(x,n-1);}}
 return {lost,gained,noteMatch:a.notes.length?same/a.notes.length:1};
}
const out:any[]=[];
for(const file of process.argv.slice(3)){
 const row:any={file:basename(file)};
 try{
  const raw=new Uint8Array(readFileSync(file));row.srcBytes=raw.length;const s=load(file,raw);const base=census(s);row.census=base.c;
  for(const fmt of ['gp','tg','mid'] as const){
   try{const bytes=exportScore(s,fmt,basename(file),[]);row[fmt+'Bytes']=bytes.length;
    if(fmt==='mid'){continue;}
    const back=fmt==='tg'?importTg(bytes).score:importGuitarPro(bytes);row[fmt]=compare(base,census(back));
    if(fmt==='tg'){try{const nat=importTg(stripProject(bytes));row.tgNative=compare(base,census(nat.score));row.tgNative.warnings=nat.warnings;}catch(e:any){row.tgNative={error:String(e?.message??e)}}}
   }catch(e:any){row[fmt]={error:String(e?.message??e)}}
  }
 }catch(e:any){row.error=String(e?.message??e);}
 out.push(row);process.stderr.write('.');
}
writeFileSync(process.argv[2],JSON.stringify(out,null,1));
