import * as at from '@coderline/alphatab';
import {settings} from './score';
import {setSongTempo} from './song-tempo';
import {addTrack,removeTrack,type TrackKind} from './score-operations';

export type NewScoreOptions={title:string;tempo:number;instrument:TrackKind};
export function newScore(options:NewScoreOptions){
 if(!Number.isInteger(options.tempo)||options.tempo<20||options.tempo>400)throw new Error('テンポは20〜400で入力してください。');
 if(!['guitar','guitar7','bass','bass5','keyboard','drums'].includes(options.instrument))throw new Error('楽器を選択してください。');
 let score=at.importer.ScoreLoader.loadAlphaTex('\\tempo 120 \\track "Guitar" \\instrument 27 . :4 r r r r | r r r r | r r r r | r r r r',settings);
 if(options.instrument!=='guitar')score=removeTrack(addTrack(score,options.instrument),0);
 score.title=options.title.trim()||'Untitled';setSongTempo(score,options.tempo);
 return score;
}
type Recent={name:string;path:string};
type StartChoice={kind:'new';options:NewScoreOptions}|{kind:'opened'}|{kind:'demo'};
export function showStartScreen(recent:Recent[],hooks:{open:(path?:string)=>Promise<boolean>;settings:()=>void}):Promise<StartChoice>{
 const dialog=document.createElement('dialog');dialog.id='start-screen';dialog.className='start-screen';dialog.setAttribute('aria-labelledby','start-title');
 dialog.innerHTML=`<header class="start-header"><div><span class="start-brand">TAB STUDIO</span><h1 id="start-title">譜面をはじめる</h1><p>新しい譜面を作成、または最近のファイルを開く</p></div><button type="button" id="start-settings">設定</button></header><div class="start-columns"><section class="start-new"><h2>新規作成</h2><form id="start-form"><label>曲名<input id="start-name" type="text" value="Untitled" maxlength="200" autocomplete="off"></label><label>楽器<select id="start-instrument"><option value="guitar">6弦ギター</option><option value="guitar7">7弦ギター</option><option value="bass">4弦ベース</option><option value="bass5">5弦ベース</option><option value="keyboard">キーボード</option><option value="drums">ドラム</option></select></label><label>テンポ<div class="start-tempo"><input id="start-tempo" type="number" value="120" min="20" max="400" step="1"><span>BPM</span></div></label><p class="start-note">4小節の空の譜面から始めます。</p><button type="submit" id="start-create" class="primary">作成</button></form><button type="button" id="start-demo" class="start-demo">デモ譜面を試す</button></section><section class="start-recent"><h2>最近開いた譜面</h2><div id="start-recents" role="listbox" aria-label="最近開いた譜面"></div><div class="start-recent-actions"><button type="button" id="start-browse">ファイルを開く…</button><button type="button" id="start-open" class="primary" disabled>開く</button></div></section></div><footer><p id="start-error" role="status" aria-live="polite"></p><span>起動時の画面は「設定 → 一般」で変更できます。</span></footer>`;
 document.body.append(dialog);
 const find=<T extends HTMLElement>(id:string)=>dialog.querySelector<T>('#'+id)!;
 let selected=-1,busy=false;
 return new Promise(resolve=>{
  const finish=(choice:StartChoice)=>{dialog.close();dialog.remove();resolve(choice);};
  const error=(message:string)=>{find('start-error').textContent=message;};
  const rows:HTMLButtonElement[]=[];
  function pick(index:number){selected=index;for(const [i,row]of rows.entries()){row.setAttribute('aria-selected',String(i===selected));row.tabIndex=i===selected?0:-1;}find<HTMLButtonElement>('start-open').disabled=busy||selected<0;}
  async function open(path?:string){if(busy)return;busy=true;error('読み込み中…');dialog.setAttribute('aria-busy','true');for(const b of dialog.querySelectorAll<HTMLButtonElement>('button'))b.disabled=true;
   try{if(await hooks.open(path)){finish({kind:'opened'});return;}error('');}catch(e){error(e instanceof Error?e.message:String(e));}
   finally{busy=false;dialog.removeAttribute('aria-busy');for(const b of dialog.querySelectorAll<HTMLButtonElement>('button'))b.disabled=false;find<HTMLButtonElement>('start-open').disabled=selected<0;}
  }
  for(const [i,file]of recent.entries()){const row=document.createElement('button');row.type='button';row.role='option';row.className='start-recent-row';row.title=file.path;const name=document.createElement('strong'),location=document.createElement('span');name.textContent=file.name;location.textContent=file.path;row.append(name,location);row.onclick=()=>pick(i);row.ondblclick=()=>{pick(i);void open(file.path);};row.onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();pick(Math.max(0,Math.min(rows.length-1,i+(e.key==='ArrowDown'?1:-1))));rows[selected].focus();}else if(e.key==='Enter'){e.preventDefault();void open(file.path);}};rows.push(row);find('start-recents').append(row);}
  if(rows.length)pick(0);else{const empty=document.createElement('p');empty.className='start-empty';empty.textContent='最近開いた譜面はありません。';find('start-recents').append(empty);}
  find<HTMLFormElement>('start-form').onsubmit=e=>{e.preventDefault();if(busy)return;const options={title:find<HTMLInputElement>('start-name').value,tempo:Number(find<HTMLInputElement>('start-tempo').value),instrument:find<HTMLSelectElement>('start-instrument').value as TrackKind};if(!Number.isInteger(options.tempo)||options.tempo<20||options.tempo>400){error('テンポは20〜400で入力してください。');return;}finish({kind:'new',options});};
  find('start-open').onclick=()=>{if(selected>=0)void open(recent[selected].path);};find('start-browse').onclick=()=>void open();find('start-settings').onclick=hooks.settings;find('start-demo').onclick=()=>finish({kind:'demo'});
  dialog.addEventListener('cancel',e=>e.preventDefault());dialog.showModal();find<HTMLInputElement>('start-name').focus();find<HTMLInputElement>('start-name').select();
 });
}
