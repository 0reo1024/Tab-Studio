// How long "link-closed" ranges are: from an edited measure, extend left and right until
// the boundary between two measures carries no link (ties, slides, hammer-ons, slurs,
// palm-mute/let-ring chains, sustain pedals) in any voice of any staff.
import fs from 'node:fs';
import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
import {importTg} from '../../src/tg-reader';
const score=importTg(new Uint8Array(fs.readFileSync(process.argv[2]))).score;
const linked=(n:at.model.Note)=>n.isTieOrigin||n.isTieDestination||n.isHammerPullOrigin||n.isHammerPullDestination||!!n.slideOrigin||!!n.slideTarget||n.slideOutType!==at.model.SlideOutType.None||n.slideInType!==at.model.SlideInType.None||n.hasEffectSlur||!!n.effectSlurOrigin||n.isEffectSlurOrigin||n.isLetRing||n.isPalmMute||!!n.bendOrigin||n.isContinuedBend;
const beatLinked=(b:at.model.Beat|undefined)=>!!b&&(b.isLetRing||b.isPalmMute||b.hasWhammyBar||b.graceType!==at.model.GraceType.None||b.notes.some(linked));
/** Boundary before master bar i is clean (no link crosses it) in every staff. */
const clean=(i:number)=>score.tracks.every(t=>t.staves.every(st=>{const a=st.bars[i-1],b=st.bars[i];if(!a||!b)return true;if(a.sustainPedals.length||b.sustainPedals.length)return false;return b.voices.every(v=>!beatLinked(v.beats[0])&&!beatLinked(a.voices[v.index]?.beats.at(-1)));}));
const bars=score.masterBars.length,boundaries=[...Array(bars+1).keys()].map(i=>i===0||i===bars||clean(i));
const sizes:number[]=[];for(let b=0;b<bars;b++){let lo=b,hi=b;while(!boundaries[lo])lo--;while(!boundaries[hi+1])hi++;sizes.push(hi-lo+1);}
sizes.sort((a,b)=>a-b);
console.log(`${bars} bars, clean boundaries ${boundaries.filter(Boolean).length-2}/${bars-1}`);
console.log('range size per edited bar: median',sizes[bars>>1],'p90',sizes[Math.floor(bars*.9)],'max',sizes.at(-1));
