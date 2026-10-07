import type {Score} from './score';
import type * as at from '@coderline/alphatab';
type Track=at.model.Track;
export type TrackNotation='tab'|'both'|'standard';
export function trackNotation(track:Track):TrackNotation{
 const staff=track.staves[0];return !staff.showTablature?'standard':staff.showStandardNotation?'both':'tab';
}
export function setTrackNotation(track:Track,mode:TrackNotation){
 if(mode!=='standard'&&track.staves.some(s=>s.isPercussion||!s.tuning.length))throw new Error('この楽器は五線譜で表示します。');
 for(const staff of track.staves){staff.showTablature=mode!=='standard';staff.showStandardNotation=mode!=='tab';}
}
export function applyNotationDefaults(score:Score,mode:TrackNotation){
 for(const track of score.tracks)setTrackNotation(track,track.staves.some(s=>s.isPercussion||!s.tuning.length)?'standard':mode);
}
