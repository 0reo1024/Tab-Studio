// Why measures of a song cannot be patched alone: counts the reasons per bar.
import fs from 'node:fs';
import {DOMParser} from '@xmldom/xmldom';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
import {importTg} from '../../src/tg-reader';
import {canEditFretLocally} from '../../src/local-fret-edit';
const score=importTg(new Uint8Array(fs.readFileSync(process.argv[2]))).score;
const reasons=new Map<string,number>();const add=(r:string)=>reasons.set(r,(reasons.get(r)??0)+1);
for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars){
 const why=new Set<string>();
 if(bar.sustainPedals.length)why.add('sustain pedal');
 for(const v of bar.voices)for(const b of v.beats){
  if(!canEditFretLocally(b))why.add('not locally editable (tie/slide/hammer/grace/whammy...)');
  if(b.fermata)why.add('fermata');if(b.isLetRing||b.notes.some(n=>n.isLetRing))why.add('let ring');if(b.isPalmMute||b.notes.some(n=>n.isPalmMute))why.add('palm mute');
  if(b.notes.some(n=>n.hasEffectSlur||n.effectSlurOrigin||n.isEffectSlurOrigin))why.add('effect slur');
 }
 if(!why.size)add('free');for(const w of why)add(w);
}
console.log([...reasons].sort((a,b)=>b[1]-a[1]).map(([r,n])=>`${n}\t${r}`).join('\n'));
