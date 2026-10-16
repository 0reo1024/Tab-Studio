import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NAM_MODEL_LEVEL,NAM_IMPORTED_LEVEL,namOutputLevel,namPresets,NAM_OUTPUT_TRIM} from '../src/mixer-state';
import {engineTone,defaultTone} from '../src/live-input-model';

test('every bundled NAM model has a measured output leveling (scripts/nam-levels.mjs)',()=>{
 for(const id of ['deluxe-a2',...namPresets.map(p=>p.id)])assert.ok(Object.hasOwn(NAM_MODEL_LEVEL,id),id);
 assert.equal(namOutputLevel({model:'fender-super'}),NAM_MODEL_LEVEL['fender-super']);
 assert.equal(namOutputLevel({model:'bass-ebs',kind:'bass'}),NAM_MODEL_LEVEL['bass-ebs']);
});

test('imported NAM models get their kind\'s median leveling, even under a bundled id',()=>{
 assert.equal(namOutputLevel({model:'m-123',kind:'guitar'}),NAM_IMPORTED_LEVEL.guitar);
 assert.equal(namOutputLevel({model:'m-456',kind:'bass'}),NAM_IMPORTED_LEVEL.bass);
 assert.equal(namOutputLevel({model:'bass-imported'}),NAM_IMPORTED_LEVEL.bass,'kind from the id');
 assert.equal(namOutputLevel({model:'fender-super',modelJson:'{}'}),NAM_IMPORTED_LEVEL.guitar,'a song\'s own JSON is not the bundled model');
});

test('a model plays at the same output offset on a track and on the instrument input',()=>{
 for(const model of ['fender-super','bass-darkglass-b7k','m-1']){
  const kind=model.startsWith('bass-')?'bass' as const:'guitar' as const;
  // Track: panel output (default -6) + NAM_OUTPUT_TRIM + leveling (native-playback.ts / mixer-audio.ts).
  const track=-6+NAM_OUTPUT_TRIM+namOutputLevel({model,kind});
  // Instrument input: panel output (default -6) + leveling (live-input.ts engineTone); no DI trim.
  const live=engineTone(defaultTone(),namOutputLevel({model,kind})).output;
  assert.equal(track-NAM_OUTPUT_TRIM,live,model);
 }
});
