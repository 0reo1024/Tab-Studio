import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {demoScore,serialize,settings} from '../src/score';
import {EditSnapshot,restoreScore,normalizeEdit} from '../src/edit-snapshot';
import {canEditFretLocally,editFretLocally} from '../src/local-fret-edit';
test('local fret snapshot retains history immutably and matches full score serialization',()=>{
 const score=demoScore(),snapshots=new EditSnapshot(),before=snapshots.get(score)!,beat=score.tracks[0].staves[0].bars[2].voices[0].beats[2],original=serialize(score),tracks=before.get('tracks') as Map<string,any>[];
 assert.ok(canEditFretLocally(beat));editFretLocally(beat,2,12);snapshots.patchBeat(score,beat);const after=snapshots.get(score)!;assert.equal(serialize(restoreScore(before)),original);assert.deepEqual(after,at.model.JsonConverter.scoreToJsObject(score));assert.equal(serialize(restoreScore(after)),serialize(normalizeEdit(score).score));assert.equal((after.get('tracks') as Map<string,any>[])[0].get('staves')[0].get('bars')[0],tracks[0].get('staves')[0].get('bars')[0]);
 editFretLocally(beat,2,14);snapshots.patchBeat(score,beat);assert.equal(restoreScore(after).tracks[0].staves[0].bars[2].voices[0].beats[2].notes.find(n=>n.string===2)?.fret,12);assert.equal(restoreScore(snapshots.get(score)).tracks[0].staves[0].bars[2].voices[0].beats[2].notes.find(n=>n.string===2)?.fret,14);
});
test('rest input and chord extrema update locally without changing durations or note IDs',()=>{
 const score=at.importer.ScoreLoader.loadAlphaTex('\\track "Guitar" . :4 r (3.1 5.2) r r',settings),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0],snapshots=new EditSnapshot();snapshots.get(score);const start=beat.playbackStart,duration=beat.playbackDuration;assert.ok(canEditFretLocally(beat));editFretLocally(beat,1,7);snapshots.patchBeat(score,beat);assert.equal(beat.playbackStart,start);assert.equal(beat.playbackDuration,duration);assert.equal(restoreScore(snapshots.get(score)).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret,7);
 const chord=beat.nextBeat!,string=chord.notes[1].string;editFretLocally(chord,string,30);assert.equal(chord.maxNote?.string,string);assert.equal(chord.notes.length,2);
});
test('whole-bar rests, ties, linked hammering and bends retain structural normalization',()=>{
 const score=demoScore(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0];assert.ok(canEditFretLocally(beat));beat.notes[0].isTieDestination=true;assert.equal(canEditFretLocally(beat),false);beat.notes[0].isTieDestination=false;beat.notes[0].isHammerPullOrigin=true;assert.equal(canEditFretLocally(beat),false);const rest=at.importer.ScoreLoader.loadAlphaTex('. :1 r',settings).tracks[0].staves[0].bars[0].voices[0].beats[0];assert.equal(canEditFretLocally(rest),false);
});
