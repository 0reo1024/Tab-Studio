import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {namLoudnessGain,NAM_TARGET_LOUDNESS} from '../src/mixer-state';

test('NAM models are brought to the same output loudness',()=>{
 assert.equal(namLoudnessGain('{"metadata":{"loudness":-26.5},"weights":[1,2]}'),NAM_TARGET_LOUDNESS+26.5);
 assert.equal(namLoudnessGain('{"metadata":{"loudness":-1.2e1}}'),NAM_TARGET_LOUDNESS+12);
 // Models without a loudness keep their level; extreme values are limited.
 assert.equal(namLoudnessGain('{"metadata":{}}'),0);
 assert.equal(namLoudnessGain('{"metadata":{"loudness":-90}}'),30);
 // The bundled model carries its loudness.
 const bundled=namLoudnessGain(fs.readFileSync('public/nam/deluxe-a2.nam','utf8'));
 assert.ok(Math.abs(bundled-(NAM_TARGET_LOUDNESS+26.3839))<1e-3,String(bundled));
});
