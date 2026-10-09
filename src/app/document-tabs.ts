export type DocumentTab={id:number;label:string;hint:string;active:boolean};
/** Tabs are keyed by document id; a render only touches rows whose label or
 * state changed, and scrolls only when the active tab changes. */
export function createDocumentTabs(root:HTMLElement,actions:{activate:(id:number)=>void;close:(id:number)=>void}){
 let rows:{id:number;row:HTMLDivElement;tab:HTMLButtonElement;close:HTMLButtonElement;key:string}[]=[],shown=-1;
 return (tabs:DocumentTab[])=>{
  if(rows.length!==tabs.length||rows.some((r,i)=>r.id!==tabs[i].id)){
   root.replaceChildren();shown=-1;
   rows=tabs.map(({id})=>{const row=document.createElement('div'),tab=document.createElement('button'),close=document.createElement('button');tab.role='tab';tab.onclick=()=>actions.activate(id);close.className='tab-close';close.textContent='×';close.onclick=()=>actions.close(id);row.append(tab,close);root.append(row);return {id,row,tab,close,key:''};});
  }
  for(const [i,t]of tabs.entries()){
   const r=rows[i],key=`${t.active}|${t.label}|${t.hint}`;if(key===r.key)continue;r.key=key;
   r.row.className='document-tab'+(t.active?' active':'');r.tab.setAttribute('aria-selected',String(t.active));r.tab.tabIndex=t.active?0:-1;r.tab.textContent=t.label;r.tab.title=t.hint;r.close.setAttribute('aria-label',`${t.label}を閉じる`);
  }
  const active=tabs.find(t=>t.active)?.id??-1;
  if(active!==shown){shown=active;root.querySelector('.active')?.scrollIntoView({block:'nearest',inline:'nearest'});}
 };
}
