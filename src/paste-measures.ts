import {deserialize,serialize,type Score} from './score';
import {cleanEditJson} from './edit-json';
import {editData,restoreScore} from './edit-snapshot';
import {copyBeats,pasteBeats,type BeatPoint} from './beat-clipboard';
import type {BarClipboard} from './score-operations';
/** Fit a single-track measure clipboard into the destination meter instead of
 * changing the meter for every track or refusing the paste. */
export function pasteMeasurePhrase(score:Score,clip:BarClipboard,target:BeatPoint):Score{
  const raw={masterbars:structuredClone(clip.masterbars),tracks:[structuredClone(clip.tracks[0])],tempo:score.tempo};cleanEditJson(raw,true);const source=restoreScore(raw);let result=score;
  const src=source.tracks[0],dest=score.tracks[target.track];if(src.staves.length>dest.staves.length)throw new Error('コピーした段数が貼り付け先より多いです。段ごとにコピーしてください。');
  for(const staff of src.staves)for(let voice=0;voice<staff.bars[0].voices.length;voice++){
    const json=editData(result),bars=json.tracks[target.track].staves[staff.index].bars;for(const bar of bars)while(bar.voices.length<=voice)bar.voices.push({beats:[{duration:1,notes:[],isempty:false}]});cleanEditJson(json);result=restoreScore(json);
    const first=staff.bars[0].voices[voice].beats[0],last=staff.bars.at(-1)!.voices[voice].beats.at(-1)!;
    const point=(b:typeof first):BeatPoint=>({track:0,staff:staff.index,voice,bar:b.voice.bar.index,beat:b.index});const clipboard=copyBeats(source,{anchor:point(first),focus:point(last)});
    result=pasteBeats(result,clipboard,{...target,staff:staff.index,voice,beat:0}).score;
  }
  return result;
}
