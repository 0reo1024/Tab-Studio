export type MenuItem={id:string;label:string;shortcut?:string;check?:()=>boolean;title?:string;disabled?:boolean;children?:(MenuItem|null)[];icon?:string};
export type MenuBarHost={
 run:(id:string)=>void;
 /** Live state that decides how an item is drawn each time a menu opens. */
 disabled:(item:MenuItem)=>boolean;label:(item:MenuItem)=>string;shortcut:(item:MenuItem)=>string|undefined;
 items:(menu:{label:string;items:(MenuItem|null)[]})=>(MenuItem|null)[];
 /** Called before a top-level menu opens, to close every other popup. */
 closeAll:()=>void;
};
/** Menu popups are rebuilt on open, so checks, labels and shortcuts are always current. */
export function createMenuBar(bar:HTMLElement,menus:{label:string;items:(MenuItem|null)[]}[],host:MenuBarHost){
 function button(item:MenuItem):HTMLElement{
  const b=document.createElement('button');b.type='button';b.className='menu-item';b.role='menuitem';b.disabled=host.disabled(item);if(item.title)b.title=item.title;
  const icon=document.createElement('span');icon.className='menu-icon';icon.setAttribute('aria-hidden','true');if(item.icon)icon.innerHTML=item.icon;else if(item.check?.())icon.textContent='✓';
  const label=document.createElement('span');label.className='menu-label';label.textContent=host.label(item);b.append(icon,label);
  const shortcut=host.shortcut(item);if(shortcut){const k=document.createElement('kbd');k.textContent=shortcut;k.setAttribute('aria-hidden','true');b.append(k);}if(item.check?.())b.classList.add('checked');
  if(item.children){
   b.setAttribute('aria-haspopup','menu');b.setAttribute('aria-expanded','false');const arrow=document.createElement('span');arrow.className='submenu-arrow';arrow.setAttribute('aria-hidden','true');arrow.textContent='›';b.append(arrow);
   const node=document.createElement('div');node.className='menu-node';const p=document.createElement('div');p.className='menu-popup submenu-popup';p.role='menu';p.hidden=true;
   const open=()=>{for(const sibling of [...node.parentElement?.children??[]])if(sibling!==node)for(const popup of sibling.querySelectorAll<HTMLElement>('.submenu-popup'))popup.hidden=true;populate(p,item.children!);p.hidden=false;b.setAttribute('aria-expanded','true');p.classList.remove('opens-left');const r=p.getBoundingClientRect();if(r.right>innerWidth-8)p.classList.add('opens-left');p.style.top='0px';const v=p.getBoundingClientRect();if(v.bottom>innerHeight-8)p.style.top=`${innerHeight-8-v.bottom}px`;};
   node.onpointerenter=open;node.onpointerleave=()=>{p.hidden=true;b.setAttribute('aria-expanded','false');};b.onclick=open;b.onkeydown=e=>{if(e.key==='Enter'||e.key==='ArrowRight'){e.preventDefault();open();p.querySelector<HTMLButtonElement>('button')?.focus();}};node.append(b,p);return node;
  }
  b.onclick=()=>host.run(item.id);return b;
 }
 function populate(p:HTMLElement,items:(MenuItem|null)[]){p.replaceChildren();for(const item of items)p.append(item?button(item):document.createElement('hr'));}
 function close(){document.querySelectorAll<HTMLElement>('.menu-popup').forEach(p=>p.hidden=true);document.querySelectorAll('.menu-root').forEach(p=>{p.classList.remove('open');p.querySelector('button')?.setAttribute('aria-expanded','false');});}
 for(const menu of menus){
  const root=document.createElement('div');root.className='menu-root';
  const trigger=document.createElement('button');trigger.textContent=menu.label;trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
  const popup=document.createElement('div');popup.className='menu-popup';popup.role='menu';popup.hidden=true;
  const open=()=>{host.closeAll();populate(popup,host.items(menu));popup.hidden=false;root.classList.add('open');trigger.setAttribute('aria-expanded','true');};
  trigger.onclick=()=>{if(popup.hidden)open();else host.closeAll();};
  trigger.onpointerenter=()=>{if(popup.hidden&&document.querySelector('.menu-root.open'))open();};
  root.onpointerleave=e=>{const next=e.relatedTarget;if(!(next instanceof Element&&next.closest('.menu-root')))host.closeAll();};
  root.append(trigger,popup);bar.append(root);
 }
 return {close};
}
