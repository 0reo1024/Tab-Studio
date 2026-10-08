import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
import {importGuitarPro,readProject} from './score';
import {importTg} from './tg-reader';
import {getLayout,hasLayout} from './layout-settings';
import {attachAudioData} from './mixer-state';

// TG ZIP files contain XML; browser workers have no native DOMParser.
Object.assign(globalThis,{DOMParser});
self.onmessage=({data}:{data:{id:number;name:string;bytes:Uint8Array}})=>{
 try{
  const ext=data.name.split('.').pop()?.toLowerCase();
  const result=ext==='tg'?importTg(data.bytes):ext==='tabstudio'?readProject(new TextDecoder().decode(data.bytes)):{score:importGuitarPro(data.bytes),warnings:['Guitar Proの特殊な奏法・音色・レイアウトは読み込みライブラリの対応範囲に従います。']};
  self.postMessage({id:data.id,data:attachAudioData(result.score,at.model.JsonConverter.scoreToJsObject(result.score)),warnings:result.warnings,layout:hasLayout(result.score)?getLayout(result.score):undefined});
 }catch(error){self.postMessage({id:data.id,error:error instanceof Error?error.message:String(error)});}
};
