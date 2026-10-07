import * as at from '@coderline/alphatab';
const natural=[0,2,4,5,7,9,11];
export function diatonicPitch(pitch:number,direction:-1|1){let next=pitch+direction;while(!natural.includes((next%12+12)%12))next+=direction;return next;}
export function setPitch(beat:at.model.Beat,pitch:number,noteIndex:number,add=false,preferredString=0){
  if(!Number.isInteger(pitch)||pitch<0||pitch>127)throw new Error('音高が範囲外です。');const staff=beat.voice.bar.staff;if(staff.isPercussion)throw new Error('この操作は音程のある楽器で利用できます。');
  const old=add?undefined:beat.notes[noteIndex];let note=old??new at.model.Note();
  if(staff.tuning.length){const occupied=new Set(beat.notes.filter(n=>n!==old).map(n=>n.string));const positions=staff.tuning.map((open,i)=>({string:staff.tuning.length-i,fret:pitch+staff.transpositionPitch-open-staff.capo})).filter(p=>p.fret>=0&&p.fret<=36&&!occupied.has(p.string));
    const position=preferredString?positions.find(p=>p.string===preferredString):positions.find(p=>p.string===old?.string)??positions.sort((a,b)=>a.fret-b.fret)[0];if(!position)throw new Error('この音高を指定した弦または空いている弦で演奏できません。別の音高または弦を選んでください。');note.string=position.string;note.fret=position.fret;
  }else{note.string=-1;note.fret=-1;note.octave=Math.floor((pitch+staff.transpositionPitch)/12);note.tone=(pitch+staff.transpositionPitch)%12;}
  if(!old)beat.addNote(note);beat.isEmpty=false;return {string:note.string,index:beat.notes.indexOf(note),pitch};
}
export function standardBounds(lookup:at.rendering.BoundsLookup,beat:at.model.Beat){return lookup.findBeats(beat)?.find(b=>!b.beat.voice.bar.staff.showTablature||b!==lookup.findBeats(beat)?.at(-1))??lookup.findBeat(beat);}
export function standardY(bounds:at.rendering.BeatBounds,pitch:number,note?:at.model.Note){
  const head=bounds.notes?.find(n=>n.note.id===note?.id);if(head)return head.noteHeadBounds.y+head.noteHeadBounds.h/2;
  if(bounds.beat.voice.bar.staff.isPercussion)return bounds.barBounds.visualBounds.y+bounds.barBounds.visualBounds.h/2;
  const bar=bounds.beat.voice.bar,displayed=pitch-bar.staff.displayTranspositionPitch;
  const tone=((displayed%12)+12)%12,degree=natural.reduce((a,b)=>Math.abs(b-tone)<Math.abs(a-tone)?b:a),steps=[38,32,30,26,38][bar.clef]-((Math.floor(displayed/12)-1)*7+natural.indexOf(degree));
  return bounds.barBounds.visualBounds.y+steps*bounds.barBounds.visualBounds.h/8;
}
/** Standard staff bounds describe its five lines; individual heads include ledger lines. */
export function hitStandard(lookup:at.rendering.BoundsLookup,x:number,y:number,voice=0){
  for(const system of lookup.staffSystems)for(const master of system.bars)for(const bar of master.bars){const model=bar.bar??bar.beats[0]?.beat.voice.bar;if(!model||!model.staff.showStandardNotation)continue;
    const matching=master.bars.filter(b=>{const m=b.bar??b.beats[0]?.beat.voice.bar;return m?.staff.track.index===model.staff.track.index&&m.staff.index===model.staff.index;});if(matching[0]!==bar)continue;
    const r=bar.visualBounds,gap=r.h/4;if(x<r.x||x>r.x+r.w)continue;
    const heads=bar.beats.flatMap(b=>b.notes??[]),direct=heads.find(h=>{const r=h.noteHeadBounds;return x>=r.x-4&&x<=r.x+r.w+4&&y>=r.y-3&&y<=r.y+r.h+3;});
    if(direct)return {beat:direct.beatBounds.beat,note:direct.note,pitch:direct.note.realValueWithoutHarmonic,bounds:direct.beatBounds,y:direct.noteHeadBounds.y+direct.noteHeadBounds.h/2};
    if(y<r.y-gap*3||y>r.y+r.h+gap*3)continue;
    const beats=bar.beats.filter(b=>b.beat.voice.index===voice);if(!beats.length)continue;const bounds=beats.reduce((a,b)=>Math.abs(b.onNotesX-x)<Math.abs(a.onNotesX-x)?b:a);
    if(model.staff.isPercussion)return {beat:bounds.beat,note:undefined,pitch:38,bounds,y:r.y+r.h/2};
    const head=bounds.notes?.reduce<at.rendering.NoteBounds|null>((a,b)=>!a||Math.abs(b.noteHeadBounds.y+b.noteHeadBounds.h/2-y)<Math.abs(a.noteHeadBounds.y+a.noteHeadBounds.h/2-y)?b:a,null);
    if(head&&Math.abs(head.noteHeadBounds.y+head.noteHeadBounds.h/2-y)<gap*.55&&Math.abs(bounds.onNotesX-x)<18)return {beat:bounds.beat,note:head.note,pitch:head.note.realValueWithoutHarmonic,bounds,y:head.noteHeadBounds.y+head.noteHeadBounds.h/2};
    const offsets=[38,32,30,26,38],step=Math.round((y-r.y)/(gap/2)),degree=offsets[model.clef]-step,octave=Math.floor(degree/7),tone=natural[((degree%7)+7)%7];
    let displayed=(octave+1)*12+tone;const key=model.keySignature;const order=key>=0?[5,0,7,2,9,4,11]:[11,4,9,2,7,0,5];if(order.slice(0,Math.abs(key)).includes(tone))displayed+=key>=0?1:-1;
    const ottava=(v:at.model.Ottavia)=>v===at.model.Ottavia._8va?-12:v===at.model.Ottavia._15ma?-24:v===at.model.Ottavia._8vb?12:v===at.model.Ottavia._15mb?24:0;
    return {beat:bounds.beat,note:undefined,pitch:displayed+model.staff.displayTranspositionPitch-ottava(bounds.beat.ottava)-ottava(model.clefOttava),bounds,y:r.y+step*gap/2};
  }return null;
}
