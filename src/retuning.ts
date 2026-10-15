import * as at from '@coderline/alphatab';

type Position={string:number;fret:number;harmonicValue?:number};
type Group={notes:at.model.Note[];candidates:{positions:Position[];moves:number;distance:number}[];neighbors:Set<Group>;chosen?:number};
const nodes=[{value:12,pitch:12},{value:7,pitch:19},{value:5,pitch:24},{value:4,pitch:28},{value:3.2,pitch:31},{value:2.7,pitch:34},{value:2.4,pitch:36}];
export type RetuningIssue={staff:number;bar:number;voice:number;beat:number;note:number;message:string};
const pitchName=(p:number)=>['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][(p%12+12)%12]+(Math.floor(p/12)-1);
export function retuningIssue(beat:at.model.Beat,reason:string,note?:at.model.Note):RetuningIssue{
  const bar=beat.voice.bar,staff=bar.staff;
  const location=`${staff.index?`${staff.index+1}段目・`:''}第${bar.index+1}小節・${beat.index+1}番目の拍${beat.voice.index?`・第${beat.voice.index+1}声部`:''}`;
  const tone=note?`・${staff.tuning.length-note.string+1}弦 ${note.fret}フレット（${pitchName(note.realValue)}）`:'';
  return {staff:staff.index,bar:bar.index,voice:beat.voice.index,beat:beat.index,note:note?.index??-1,message:`${location}${tone}：${reason}`};
}
export class RetuningError extends Error{
  readonly issues:RetuningIssue[];
  constructor(issues:RetuningIssue[]){
    const ordered=[...new Map(issues.map(i=>[JSON.stringify(i),i])).values()].sort((a,b)=>a.staff-b.staff||a.bar-b.bar||a.voice-b.voice||a.beat-b.beat||a.note-b.note);
    super(`チューニングを変更できません（${ordered.length}件）。\n音程を保ったまま配置できない箇所：\n${ordered.map(i=>'・'+i.message).join('\n')}`);
    this.name='RetuningError';this.issues=ordered;
  }
}

/** Plan first: no score changes until every note, relationship and diagram fits. */
export function planRetuning(staff:at.model.Staff,tuning:readonly number[],capo:number){
  const beats=staff.bars.flatMap(b=>b.voices.flatMap(v=>v.beats)),notes=beats.flatMap(b=>b.notes);
  const issues:RetuningIssue[]=[],failed=new Set<Group>();
  const parents=new Map(notes.map(n=>[n,n]));
  function root(n:at.model.Note):at.model.Note{let r=n;while(parents.get(r)!==r)r=parents.get(r)!;while(n!==r){const next=parents.get(n)!;parents.set(n,r);n=next;}return r;}
  // These techniques require both ends on the same string when alphaTab rebuilds links.
  for(const n of notes)for(const origin of [n.tieOrigin,n.hammerPullOrigin,n.slideOrigin])if(origin&&parents.has(origin))parents.set(root(n),root(origin));
  const groups=new Map<at.model.Note,Group>(),owners=new Map<at.model.Note,Group>();
  for(const n of notes){const key=root(n);let g=groups.get(key);if(!g){g={notes:[],candidates:[],neighbors:new Set()};groups.set(key,g);}g.notes.push(n);owners.set(n,g);}
  function position(n:at.model.Note,i:number):Position|null{
    const string=tuning.length-i,open=tuning[i]+capo-staff.transpositionPitch;
    if(n.harmonicType===at.model.HarmonicType.Natural){
      if(open+n.harmonicPitch===n.realValue)return {string,fret:n.fret};
      const node=nodes.find(h=>open+h.pitch===n.realValue);
      return node?{string,fret:Math.round(node.value),harmonicValue:node.value}:null;
    }
    const fret=n.realValueWithoutHarmonic-open;
    return Number.isInteger(fret)&&fret>=0&&fret<=36?{string,fret}:null;
  }
  for(const g of groups.values()){
    for(let i=0;i<tuning.length;i++){
      const positions=g.notes.map(n=>position(n,i));if(positions.some(p=>!p))continue;
      g.candidates.push({positions:positions as Position[],moves:g.notes.filter(n=>staff.tuning.length-n.string!==i).length,distance:g.notes.reduce((sum,n,k)=>sum+Math.abs(n.fret-positions[k]!.fret),0)});
    }
    g.candidates.sort((a,b)=>a.moves-b.moves||a.distance-b.distance);
    if(!g.candidates.length){
      failed.add(g);const blocked=g.notes.filter(n=>!tuning.some((_,i)=>position(n,i)));
      if(blocked.length)for(const n of blocked)issues.push(retuningIssue(n.beat,n.harmonicType===at.model.HarmonicType.Natural?'同じ音程のナチュラルハーモニクスを作れる弦がありません。':'新しいチューニングの0〜36フレットに同じ音程がありません。',n));
      else for(const n of g.notes)issues.push(retuningIssue(n.beat,'タイ・スライド・ハンマリングのつながりを保って、同じ弦に配置できません。',n));
    }
  }
  for(const b of beats)for(let i=0;i<b.notes.length;i++)for(let j=i+1;j<b.notes.length;j++){
    const a=owners.get(b.notes[i])!,c=owners.get(b.notes[j])!;if(a===c){failed.add(a);issues.push(retuningIssue(b,'つながった音符が同時に鳴るため、別々の弦に配置できません。'));continue;}a.neighbors.add(c);c.neighbors.add(a);
  }
  // Assign connected chords together. Iterative backtracking also handles long scores.
  const unseen=new Set([...groups.values()].filter(g=>!failed.has(g)));
  while(unseen.size){
    const component:Group[]=[],pending=[unseen.values().next().value!];unseen.delete(pending[0]);
    while(pending.length){const g=pending.pop()!;component.push(g);for(const n of g.neighbors)if(unseen.delete(n))pending.push(n);}
    component.sort((a,b)=>a.candidates.length-b.candidates.length||b.neighbors.size-a.neighbors.size);
    const next=component.map(()=>0);let i=0,solved=true;
    while(i<component.length){
      const g=component[i];let found=false;
      while(next[i]<g.candidates.length){const k=next[i]++,string=g.candidates[k].positions[0].string;
        if([...g.neighbors].every(n=>n.chosen===undefined||n.candidates[n.chosen].positions[0].string!==string)){g.chosen=k;found=true;break;}
      }
      if(found){i++;if(i<component.length)next[i]=0;}
      else{g.chosen=undefined;next[i]=0;if(--i<0){solved=false;break;}component[i].chosen=undefined;}
    }
    if(!solved){for(const g of component){failed.add(g);g.chosen=undefined;}
      const affected=new Set(component.flatMap(g=>g.notes.map(n=>n.beat)));
      for(const b of affected)issues.push(retuningIssue(b,affected.size===1?'和音の各音を別々の弦に配置できません。':'和音とタイ・スライド・ハンマリングを同時に保つ弦の組み合わせがありません。'));
    }
  }
  const positions=new Map<at.model.Note,Position>();for(const g of groups.values())if(!failed.has(g))g.notes.forEach((n,i)=>positions.set(n,g.candidates[g.chosen!].positions[i]));
  const chords=new Map<string,number[]>();
  for(const id of new Set(beats.map(b=>b.chordId).filter((id):id is string=>!!id))){
    const chord=staff.chords?.get(id);if(!chord?.strings.length)continue;
    const tones=chord.strings.flatMap((f,i)=>f<0?[]:[{pitch:staff.tuning[i]+staff.capo-staff.transpositionPitch+f,index:i,fret:f}]);
    const candidates=tones.map(t=>tuning.map((open,i)=>({index:i,fret:t.pitch+staff.transpositionPitch-open-capo})).filter(p=>Number.isInteger(p.fret)&&p.fret>=0&&p.fret<=36).sort((a,b)=>Number(b.index===t.index)-Number(a.index===t.index)||Math.abs(a.fret-t.fret)-Math.abs(b.fret-t.fret)));
    const order=tones.map((_,i)=>i).sort((a,b)=>candidates[a].length-candidates[b].length),frets=tuning.map(()=>-1);
    function assign(i:number):boolean{if(i===order.length)return true;const k=order[i];for(const p of candidates[k])if(frets[p.index]<0){frets[p.index]=p.fret;if(assign(i+1))return true;frets[p.index]=-1;}return false;}
    if(!assign(0)){
      const missing=tones.filter((_,i)=>!candidates[i].length).map(t=>pitchName(t.pitch));
      const reason=missing.length?`${missing.join('、')}を0〜36フレットに配置できません。`:'構成音を別々の弦に配置できません。';
      for(const b of beats.filter(b=>b.chordId===id))issues.push(retuningIssue(b,`コード図「${chord.name||id}」：${reason}`));
    }else chords.set(id,frets);
  }
  return {positions,chords,issues};
}
