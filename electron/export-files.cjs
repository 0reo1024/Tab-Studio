const path=require('node:path');
const fs=require('node:fs/promises');
const formats={gp:{label:'Guitar Pro 7',signature:'PK'},tg:{label:'TuxGuitar',signature:'PK'},mid:{label:'MIDI',signature:'MThd'},pdf:{label:'PDF',signature:'%PDF-'}};
function exportPath(file,format){
  if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('出力先の場所が不正です。');
  return path.extname(file).toLowerCase()==='.'+format?file:path.join(path.dirname(file),path.basename(file,path.extname(file))+'.'+format);
}
function validateExportBytes(bytes,format){
  const spec=formats[format];if(!spec||!(bytes instanceof Uint8Array)||bytes.length>80*1024*1024)throw new Error('書き出しデータが不正です。');
  if(Buffer.from(bytes.subarray(0,spec.signature.length)).toString('ascii')!==spec.signature)throw new Error('出力形式とデータが一致しません。');
}
async function writeExport(file,bytes,format){validateExportBytes(bytes,format);const temp=file+'.writing';await fs.writeFile(temp,bytes);await fs.rename(temp,file);}
module.exports={formats,exportPath,validateExportBytes,writeExport};
