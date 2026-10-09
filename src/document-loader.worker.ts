import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
import {importGuitarPro,readProject} from './score';
import {importTg} from './tg-reader';
import {exportTg} from './tg-writer';
import {exportScore,type ScoreFormat} from './export-score';
import {getLayout,hasLayout,setLayout,type LayoutSettings} from './layout-settings';
import {attachAudioData} from './mixer-state';
import {restoreScore} from './edit-snapshot';

// TG ZIP files contain XML; browser workers have no native DOMParser.
Object.assign(globalThis,{DOMParser});
// Every request carries a cmd: alphaTab's own worker handlers also see these messages.
type Request={id:number;cmd:'tabStudio.document';name:string;bytes:Uint8Array}|{id:number;cmd:'tabStudio.export';format:'save'|ScoreFormat;data:unknown;layout:LayoutSettings;sourceName:string;warnings:string[]}|{id:number;cmd:'tabStudio.json';data:unknown};
/** Parsing and file encoding run here, so opening or saving a large score never
 * blocks the editor. Scores cross the thread boundary as snapshot object trees. */
self.onmessage=({data}:{data:Request})=>{
 try{
  if(data.cmd==='tabStudio.export'){
   const score=restoreScore(data.data as Record<string,unknown>);setLayout(score,data.layout);
   const bytes=data.format==='save'?exportTg(score,data.sourceName,data.warnings):exportScore(score,data.format,data.sourceName,data.warnings);
   self.postMessage({id:data.id,bytes},{transfer:[bytes.buffer as ArrayBuffer]});return;
  }
  if(data.cmd==='tabStudio.json'){self.postMessage({id:data.id,json:JSON.stringify(data.data,(_key,item)=>item instanceof Map?Object.fromEntries(item):item)});return;}
  if(data.cmd!=='tabStudio.document')return;
  const ext=data.name.split('.').pop()?.toLowerCase();
  const result=ext==='tg'?importTg(data.bytes):ext==='tabstudio'?readProject(new TextDecoder().decode(data.bytes)):{score:importGuitarPro(data.bytes),warnings:['Guitar Proの特殊な奏法・音色・レイアウトは読み込みライブラリの対応範囲に従います。']};
  self.postMessage({id:data.id,data:attachAudioData(result.score,at.model.JsonConverter.scoreToJsObject(result.score)),warnings:result.warnings,layout:hasLayout(result.score)?getLayout(result.score):undefined});
 }catch(error){self.postMessage({id:data.id,error:error instanceof Error?error.message:String(error)});}
};
