import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
import {demoScore,importGuitarPro,serialize,settings} from '../src/score';
import {exportScore} from '../src/export-score';
import {importTg} from '../src/tg-reader';
const {exportPath,validateExportBytes}=createRequire(import.meta.url)('../electron/export-files.cjs');
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;

function musicalNotes(score:at.model.Score){return score.tracks.map(t=>t.staves.map(s=>s.bars.map(b=>b.voices.map(v=>v.beats.map(b=>({duration:b.duration,dots:b.dots,tuplet:[b.tupletNumerator,b.tupletDenominator],notes:b.notes.map(n=>[n.string,n.fret,n.isPalmMute,n.isTieDestination])}))))));}
for(const format of ['gp','tg']as const)test(`${format} export reopens with frets, rhythm, effects and hidden tracks intact`,()=>{
  const score=at.importer.ScoreLoader.loadAlphaTex('\\title "日本語の譜面" \\tempo 180 \\track "Lead" . :4 12.1{pm} 14.2 r r | :8 10.1 12.1 14.1 12.1 r r r r \\track "Bass" \\instrument 33 . :2 0.4 3.4 | :1 r',settings);
  score.tracks[1].isVisibleOnMultiTrack=false;const before=serialize(score),bytes=exportScore(score,format);
  const reopened=format==='gp'?importGuitarPro(bytes):importTg(bytes).score;
  assert.equal(reopened.title,score.title);assert.equal(reopened.tempo,score.tempo);assert.equal(reopened.tracks.length,2);assert.deepEqual(musicalNotes(reopened),musicalNotes(score));assert.equal(serialize(score),before);
});

// Independent SMF parser checks actual bytes, rather than exporter internals.
export function parseMidi(bytes:Uint8Array){
  const b=Buffer.from(bytes);assert.equal(b.subarray(0,4).toString(),'MThd');assert.equal(b.readUInt32BE(4),6);const format=b.readUInt16BE(8),trackCount=b.readUInt16BE(10),division=b.readUInt16BE(12),events:{track:number;tick:number;status:number;data:number[];meta?:number}[]=[];
  let p=14;
  for(let track=0;track<trackCount;track++){
    assert.equal(b.subarray(p,p+4).toString(),'MTrk');const end=p+8+b.readUInt32BE(p+4);p+=8;let tick=0,running=0;
    const variable=()=>{let n=0,c=0;do{assert.ok(p<end);c=b[p++];n=n*128+(c&127);}while(c&128);return n;};
    while(p<end){tick+=variable();let status=b[p++];if(status<128){p--;status=running;}else if(status<240)running=status;
      assert.ok(status>=128);if(status===255){const meta=b[p++],len=variable(),data=[...b.subarray(p,p+len)];p+=len;events.push({track,tick,status,meta,data});}
      else if(status===240||status===247){p+=variable();}
      else{const length=(status&240)===192||(status&240)===208?1:2;const data=[...b.subarray(p,p+length)];p+=length;events.push({track,tick,status,data});}
      assert.ok(p<=end);
    }
    assert.ok(events.some(e=>e.track===track&&e.meta===47));
  }
  assert.equal(p,b.length);return {format,trackCount,division,events};
}
test('MIDI is standard type 1 with pitches, paired note offs, program, tempo and meter',()=>{
  const score=demoScore(),before=serialize(score),midi=parseMidi(exportScore(score,'mid'));assert.equal(midi.format,1);assert.ok(midi.division>0);
  const on=midi.events.filter(e=>(e.status&240)===144&&e.data[1]>0),off=midi.events.filter(e=>(e.status&240)===128||((e.status&240)===144&&e.data[1]===0));
  assert.equal(on.length,34);assert.equal(off.length,on.length);assert.ok(on.some(e=>e.data[0]===40));assert.ok(midi.events.some(e=>(e.status&240)===192&&e.data[0]===27));
  const tempo=midi.events.find(e=>e.meta===81)!;assert.ok(Math.abs(60000000/(tempo.data[0]*65536+tempo.data[1]*256+tempo.data[2])-110)<0.01);assert.deepEqual(midi.events.find(e=>e.meta===88)!.data.slice(0,2),[4,2]);assert.equal(serialize(score),before);
});
test('output extensions and binary signatures agree, including canceled-dialog paths',()=>{
  for(const format of ['gp','tg','mid','pdf'])assert.equal(exportPath('C:\\Scores\\Song.other',format),`C:\\Scores\\Song.${format}`);
  assert.equal(exportPath('C:\\Scores\\Song.GP','gp'),'C:\\Scores\\Song.GP');assert.throws(()=>validateExportBytes(new Uint8Array([80,75]),'mid'),/一致/);assert.throws(()=>exportPath('relative.tg','tg'),/不正/);
});
