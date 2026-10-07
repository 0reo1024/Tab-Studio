import {layoutSettings,type LayoutSettings} from './layout-settings';
export type PdfOptions={start:number;end:number;scale:number;landscape:boolean;separateTracks:boolean;layout?:LayoutSettings};
export function pdfOptions(value:Partial<PdfOptions>|undefined,bars:number):PdfOptions{
  const o={start:1,end:bars,scale:0.9,landscape:false,separateTracks:false,...value};
  if(!Number.isInteger(o.start)||!Number.isInteger(o.end)||o.start<1||o.end<o.start||o.end>bars)throw new Error('PDFの小節範囲を曲の中で指定してください。');
  if(!Number.isFinite(o.scale)||o.scale<0.6||o.scale>1.4)throw new Error('譜面サイズは60〜140%で指定してください。');
  if(o.layout)o.layout=layoutSettings(o.layout);
  return o;
}
