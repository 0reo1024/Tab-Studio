import * as at from '@coderline/alphatab';
import {settings} from './score';
import {setFret} from './editor';
/** Pitch-only edits keep beat timing and indexes stable. Cross-beat effects
 * and whole-measure rests use the structural transaction instead. */
export function canEditFretLocally(beat:at.model.Beat){
 return !beat.isFullBarRest&&beat.graceType===at.model.GraceType.None&&!beat.hasWhammyBar&&!beat.notes.some(n=>n.isTieOrigin||n.isTieDestination||n.tieOrigin||n.tieDestination||n.isHammerPullOrigin||n.isHammerPullDestination||n.hammerPullOrigin||n.hammerPullDestination||n.slideOrigin||n.slideTarget||n.hasBend||n.isSlurOrigin||n.isSlurDestination);
}
export function editFretLocally(beat:at.model.Beat,string:number,fret:number){setFret(beat,string,fret);beat.finish(settings);return beat.notes.find(n=>n.string===string)!;}
