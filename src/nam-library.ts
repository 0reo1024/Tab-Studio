import {namPresets,applyNamPreset,type NamSettings} from './mixer-state';

export type NamModel={id:string;name:string;json?:string;builtin:boolean};
export type NamPreset={id:string;name:string;settings:NamSettings};
export type NamLibrary={models:NamModel[];presets:NamPreset[]};
const builtins=()=>namPresets.map(p=>({id:p.id,name:p.name,builtin:true}));
let database:Promise<IDBDatabase>|undefined;
function db(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('tabstudio-nam-library',1);request.onupgradeneeded=()=>request.result.createObjectStore('library');request.onsuccess=()=>resolve(request.result);request.onerror=()=>{database=undefined;reject(request.error);};});}
export async function readNamLibrary():Promise<NamLibrary>{const database=await db();return new Promise((resolve,reject)=>{const request=database.transaction('library').objectStore('library').get('current');request.onsuccess=()=>{const data=request.result as NamLibrary|undefined;const models=data?.models??[];resolve({models:[...models,...builtins().filter(b=>!models.some(m=>m.id===b.id))],presets:data?.presets??[]});};request.onerror=()=>reject(request.error);});}
export async function writeNamLibrary(library:NamLibrary){const database=await db();return new Promise<void>((resolve,reject)=>{const transaction=database.transaction('library','readwrite');transaction.objectStore('library').put(structuredClone(library),'current');transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error??new Error('NAMライブラリを保存できませんでした。'));});}
export function addNamModel(library:NamLibrary,name:string,json:string){
 if(new TextEncoder().encode(json).length>8*1024*1024)throw new Error('NAMモデルは8MB以下を選んでください。');
 const data=JSON.parse(json);if(data.architecture!=='SlimmableContainer'||!Array.isArray(data.config?.submodels))throw new Error('A2 Lite対応のNAMモデルを選んでください。');
 const existing=library.models.find(m=>m.json===json);if(existing)return existing;
 const model={id:`user:${crypto.randomUUID()}`,name:name.replace(/\.nam$/i,''),json,builtin:false};library.models.push(model);return model;
}
export function selectNamModel(settings:NamSettings,model:NamModel){
 if(model.id==='deluxe-a2'){Object.assign(settings,{model:model.id,modelName:model.name,modelJson:undefined,preset:'custom',enabled:true});return;}
 if(model.builtin){applyNamPreset(settings,model.id);settings.modelName=model.name;return;}
 Object.assign(settings,{model:model.id,modelName:model.name,modelJson:model.json,preset:'custom',enabled:true});
}
export function saveNamPreset(library:NamLibrary,name:string,settings:NamSettings){
 const title=name.trim();if(!title)throw new Error('プリセット名を入力してください。');
 // Store model bytes once in the library; projects still carry their own bytes.
 if(settings.modelJson&&!library.models.some(m=>m.id===settings.model)){
  const model=addNamModel(library,settings.modelName,settings.modelJson);settings.model=model.id;
 }
 if(!library.models.some(m=>m.id===settings.model)){if(settings.model==='deluxe-a2')library.models.push({id:'deluxe-a2',name:settings.modelName,builtin:true});else throw new Error('NAMモデルを追加してから保存してください。');}
 const preset={id:crypto.randomUUID(),name:title.slice(0,100),settings:{...structuredClone(settings),modelJson:undefined}};
 library.presets.push(preset);return preset;
}
export function useNamPreset(settings:NamSettings,preset:NamPreset,library:NamLibrary){
 const model=library.models.find(m=>m.id===preset.settings.model);if(!model)throw new Error('プリセットのNAMモデルが見つかりません。');
 Object.assign(settings,structuredClone(preset.settings),{modelJson:model.json,preset:preset.id,enabled:true});
}
export function moveNamItem<T>(items:T[],index:number,direction:number){const target=index+direction;if(target<0||target>=items.length)return;[items[index],items[target]]=[items[target],items[index]];}
