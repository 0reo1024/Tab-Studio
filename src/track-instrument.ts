import * as at from '@coderline/alphatab';
import type {Score} from './score';
/** The track picker sets one sound for the entire track. Beat-level instrument
 * events (including alphaTab's automatic first-beat event) otherwise override
 * playbackInfo.program when MIDI playback starts or seeks. */
export function setTrackInstrument(score:Score,index:number,program:number){
 const track=score.tracks[index];if(!track)throw new Error('トラックを選択してください。');
 if(!Number.isInteger(program)||program<0||program>127)throw new Error('音色が不正です。');
 track.playbackInfo.program=program;
 for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const automation of beat.automations)if(automation.type===at.model.AutomationType.Instrument)automation.value=program;
}
