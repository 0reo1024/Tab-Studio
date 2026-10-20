import test from 'node:test';
import assert from 'node:assert/strict';
import {detectPitch,noteOf,steady} from '../src/tuner';

const rate=48000;
/** A plucked-string-like tone: fundamental plus decaying harmonics (the 2nd stronger, as on a bass). */
function tone(hz:number,frames=4096,noise=0){return Float32Array.from({length:frames},(_,i)=>{const t=i/rate;return 0.2*Math.sin(2*Math.PI*hz*t)+0.3*Math.sin(2*Math.PI*2*hz*t)+0.1*Math.sin(2*Math.PI*3*hz*t)+noise*(Math.random()*2-1);});}

test('detects open strings of guitar and 5-string bass within a cent',()=>{
 for(const hz of [30.87,41.2,55,73.42,82.41,110,146.83,196,246.94,329.63,659.26,987.77]){
  const p=detectPitch(tone(hz),rate);assert.ok(p,`${hz} Hz detected`);
  const cents=1200*Math.log2(p.hz/hz);assert.ok(Math.abs(cents)<1,`${hz} Hz: ${p.hz.toFixed(3)} (${cents.toFixed(2)} cents)`);
 }
});
test('a strong second harmonic does not read an octave up, and noise is tolerated',()=>{
 const p=detectPitch(tone(55,4096,0.02),rate);assert.ok(p&&Math.abs(1200*Math.log2(p.hz/55))<3,JSON.stringify(p));
});
test('silence and noise give no pitch',()=>{
 assert.equal(detectPitch(new Float32Array(4096),rate),null);
 assert.equal(detectPitch(Float32Array.from({length:4096},()=>0.0005*(Math.random()*2-1)),rate),null);
});
test('note names, octaves and cents follow the reference pitch',()=>{
 assert.deepEqual(noteOf(440),{name:'A',octave:4,midi:69,cents:0});
 const e=noteOf(82.41);assert.equal(e.name,'E');assert.equal(e.octave,2);assert.ok(Math.abs(e.cents)<1);
 const b=noteOf(30.87);assert.equal(b.name,'B');assert.equal(b.octave,0);
 const sharp=noteOf(446,440);assert.equal(sharp.name,'A');assert.ok(Math.abs(sharp.cents-23.45)<0.1,String(sharp.cents));
 assert.ok(Math.abs(noteOf(442,442).cents)<1e-9,'A4 = 442 Hz reads in tune');
});
test('the steady reading ignores one stray value',()=>{assert.equal(steady([110,220,110.2]),110.2);assert.ok(Number.isNaN(steady([])));});
