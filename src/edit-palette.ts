import type * as at from '@coderline/alphatab';
type Action={id:string;label:string;icon:string};
export function noteIcon(duration:number){
 const filled=duration>=4, flags=duration>=8?Math.log2(duration/4):0;
 let shape=duration===1?'<ellipse cx="12" cy="17" rx="5" ry="3" fill="none" stroke="currentColor" stroke-width="2"/>':`<ellipse cx="9" cy="19" rx="4" ry="2.6" transform="rotate(-20 9 19)" fill="${filled?'currentColor':'none'}" stroke="currentColor" stroke-width="1.4"/><path d="M12.5 18V3" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
 for(let i=0;i<flags;i++)shape+=`<path d="M13 ${3+i*4}q9 5 3 11q3-6-3-7" fill="currentColor"/>`;
 return `<svg viewBox="0 0 26 26" aria-hidden="true">${shape}</svg>`;
}
const sections:{label:string;actions:Action[]}[]=[
 {label:'編集',actions:[{id:'select',label:'音符を選択',icon:'♪↖'},{id:'inline',label:'フレットを直接入力 (Enter)',icon:'✎'},{id:'clean',label:'拍を休符にする',icon:'♮'},{id:'voice1',label:'第1声部',icon:'♪₁'},{id:'voice2',label:'第2声部',icon:'♪₂'}]},
 {label:'拍子',actions:[{id:'signature',label:'拍子を変更',icon:'⁴⁄₄'},{id:'tempo',label:'テンポを変更',icon:'◷'},{id:'repeatStart',label:'繰り返し開始',icon:'𝄆'},{id:'repeatEnd',label:'繰り返し終了（2回）',icon:'𝄇'},{id:'barText',label:'小節マーカー',icon:'⚑'}]},
 {label:'音価',actions:[...[1,2,4,8,16,32,64].map(d=>({id:`duration${d}`,label:`${d===1?'全':d+'分'}音符`,icon:noteIcon(d)})),{id:'dotted',label:'付点 (*)',icon:'♩·'},{id:'doubleDot',label:'複付点',icon:'♩··'},{id:'tie',label:'前の音符とタイで結ぶ',icon:'⌒'},{id:'triplet',label:'3連符 (/)',icon:'₃♫'}]},
 {label:'強弱記号',actions:['ppp','pp','p','mp','mf','f','ff','fff'].map((v,i)=>({id:`dynamic${i}`,label:`強弱 ${v}`,icon:`<i>${v}</i>`}))},
 {label:'エフェクト/テクニック',actions:[{id:'vibrato',label:'ビブラート (V)',icon:'∿'},{id:'bend',label:'ベンド（全音）',icon:'⤴'},{id:'deadNote',label:'デッドノート (X)',icon:'×'},{id:'triplet',label:'3連符',icon:'⅓'},{id:'ghost',label:'ゴーストノート (O)',icon:'( )'},{id:'harmonic',label:'ナチュラルハーモニクス',icon:'H○'},{id:'hammer',label:'ハンマリング / プリング (H)',icon:'⌒'},{id:'accent',label:'アクセント',icon:'>'},{id:'heavyAccent',label:'強いアクセント',icon:'∧'},{id:'ring',label:'レットリング',icon:'L.R'},{id:'slide',label:'スライド',icon:'╱'},{id:'staccato',label:'スタッカート',icon:'•'},{id:'trill',label:'トリル（2フレット上）',icon:'tr'},{id:'tremolo',label:'トレモロピッキング',icon:'≋'},{id:'palm',label:'パームミュート (P)',icon:'P.M'},{id:'tap',label:'タッピング',icon:'T'},{id:'slap',label:'スラップ',icon:'S'},{id:'pop',label:'ポッピング',icon:'P'},{id:'fade',label:'フェードイン',icon:'<'},{id:'brush',label:'ダウンストローク',icon:'↓'}]},
 {label:'音符/エフェクト',actions:[{id:'inline',label:'フレットを入力',icon:'▦'},{id:'text',label:'音符のテキスト',icon:'T'},{id:'transposeDown',label:'フレットを半音下げる',icon:'↓'},{id:'transposeUp',label:'フレットを半音上げる',icon:'↑'},{id:'deleteNote',label:'選択弦の音符を削除',icon:'⌫'}]}
];
export function createEditPalette(root:HTMLElement,run:(id:string)=>void){
 for(const section of sections){
  const block=document.createElement('section');block.className='palette-section';
  const title=document.createElement('h2');title.textContent=section.label;
  const buttons=document.createElement('div');buttons.className='palette-buttons';
  for(const action of section.actions){const b=document.createElement('button');b.type='button';b.dataset.action=action.id;b.title=action.label;b.setAttribute('aria-label',action.label);b.innerHTML=action.icon;b.onclick=()=>run(action.id);buttons.append(b);}
  block.append(title,buttons);root.append(block);
 }
 return (beat:at.model.Beat|undefined,note:at.model.Note|undefined,playing:boolean)=>{
  const active=new Set(['select',`voice${(beat?.voice.index??0)+1}`]);
  if(beat){active.add(`duration${beat.duration}`);active.add(`dynamic${beat.dynamics}`);if(beat.dots===1)active.add('dotted');if(beat.dots===2)active.add('doubleDot');if(beat.hasTuplet)active.add('triplet');if(beat.tap)active.add('tap');if(beat.slap)active.add('slap');if(beat.pop)active.add('pop');if(beat.fade)active.add('fade');if(beat.brushType)active.add('brush');if(beat.tremoloPicking)active.add('tremolo');}
  if(note){for(const [id,value] of Object.entries({vibrato:note.vibrato,palm:note.isPalmMute,deadNote:note.isDead,ghost:note.isGhost,hammer:note.isHammerPullOrigin,ring:note.isLetRing,tie:note.isTieDestination,bend:note.hasBend,harmonic:note.harmonicType,slide:note.slideOutType,staccato:note.isStaccato,trill:note.trillValue>=0,accent:note.accentuated===1,heavyAccent:note.accentuated===2}))if(value)active.add(id);}
  for(const b of root.querySelectorAll<HTMLButtonElement>('button')){const id=b.dataset.action!;b.classList.toggle('active',active.has(id));b.setAttribute('aria-pressed',String(active.has(id)));b.disabled=playing||(!beat&&!['select','signature','tempo','repeatStart','repeatEnd','barText'].includes(id));}
 };
}
