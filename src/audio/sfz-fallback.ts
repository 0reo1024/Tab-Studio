import type {Score} from '../score';
import {trackAudio} from '../mixer-state';
/** GM program that stands in for the Guitar DI SFZ when the build has no SFZ host:
 * a clean electric guitar is the closest GM sound to a DI signal feeding NAM. */
export const SFZ_FALLBACK_PROGRAM=27;
type ProgramEvent={type:number;track:number;program?:number};
/** Tracks set to an SFZ sound keep whatever GM program the file had (often unrelated,
 * e.g. muted guitar or e-piano, because SFZ playback ignores it). Without SFZ they would
 * play that program, so their program changes are replaced in the generated MIDI only. */
export function applySfzFallback(file:{tracks:{events:ProgramEvent[]}[]},score:Score,sfzAvailable:boolean):number{
 if(sfzAvailable)return 0;
 const sfzTracks=new Set(score.tracks.filter(t=>trackAudio(t).sound.kind==='sfz').map(t=>t.index));
 let changed=0;
 if(!sfzTracks.size)return 0;
 for(const track of file.tracks)for(const event of track.events)if(event.type===192&&sfzTracks.has(event.track)&&event.program!==SFZ_FALLBACK_PROGRAM){event.program=SFZ_FALLBACK_PROGRAM;changed++;}
 return changed;
}
