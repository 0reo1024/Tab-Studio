// View preferences belong to the document, independently of its saved music.
export function visibilityKey(file:string){return /^[a-z]:[\\/]/i.test(file)?file.replaceAll('\\','/').toLowerCase():file;}
export function restoredVisibility(indices:unknown,count:number):Set<number>{
  const valid=Array.isArray(indices)?indices.filter((i):i is number=>Number.isInteger(i)&&i>=0&&i<count):[];
  return new Set(valid.length?valid.sort((a,b)=>a-b):Array.from({length:Math.min(4,count)},(_,i)=>i));
}
