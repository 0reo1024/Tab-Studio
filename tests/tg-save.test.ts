import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DOMParser} from '@xmldom/xmldom';
import {zipSync,unzipSync,strFromU8,strToU8} from 'fflate';
import * as at from '@coderline/alphatab';
import {demoScore,serialize,importGuitarPro,settings,voiceQ} from '../src/score';
import {exportTg,TG_QUARTER} from '../src/tg-writer';
import {importTg} from '../src/tg-reader';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
const fixture=(name:string)=>new Uint8Array(readFileSync(new URL(`./fixtures/${name}`,import.meta.url)));
function standardOnly(bytes:Uint8Array){const files=unzipSync(bytes);files['content.xml']=strToU8(strFromU8(files['content.xml']).replace(/<TabStudioProject>[\s\S]*?<\/TabStudioProject>/,''));return zipSync(files);}
for(const name of ['demo','tg-v15.tg','tg-v2.tg','notes.gp3','notes.gp4','notes.gp5','notes.gpx','notes.gp'])test(`TG save/reopen preserves complete score: ${name}`,()=>{
  const score=name==='demo'?demoScore():name.endsWith('.tg')?importTg(fixture(name)).score:importGuitarPro(fixture(name));
  const bytes=exportTg(score,name,['fixture']);assert.deepEqual(Object.keys(unzipSync(bytes)).sort(),['content.xml','version.txt']);
  const result=importTg(bytes);assert.deepEqual(JSON.parse(serialize(result.score)),JSON.parse(serialize(score)));assert.deepEqual(result.warnings,['fixture']);
});
test('ordinary TG content preserves frets, rhythm, repeats, tempo, effects and two voices without supplemental data',()=>{
  const score=at.importer.ScoreLoader.loadAlphaTex('\\title "日本語 & <TAB>" \\tempo 120 . :8 12.6{pm} 14.5{v} r r :2 r | \\ts 6 8 :1 r',settings);
  const bar=score.tracks[0].staves[0].bars[0];const voice=new at.model.Voice();bar.addVoice(voice);const b=new at.model.Beat();b.duration=at.model.Duration.Whole;b.addNote(Object.assign(new at.model.Note(),{string:1,fret:7}));voice.addBeat(b);const nextVoice=new at.model.Voice();score.tracks[0].staves[0].bars[1].addVoice(nextVoice);const rest=new at.model.Beat();rest.duration=at.model.Duration.Whole;nextVoice.addBeat(rest);
  score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.masterBars[1].tempoAutomations.push(at.model.Automation.buildTempoAutomation(false,0,90,2));score.finish(settings);
  const bytes=exportTg(score),files=unzipSync(bytes),xml=strFromU8(files['content.xml']);assert.ok(xml.includes(`<preciseStart>${TG_QUARTER}</preciseStart>`));
  const reopened=importTg(standardOnly(bytes)).score;assert.equal(reopened.title,score.title);assert.equal(reopened.masterBars[1].repeatCount,2);assert.equal(reopened.masterBars[1].tempoAutomations[0].value,90);
  const bars=reopened.tracks[0].staves[0].bars;assert.equal(bars[0].voices[0].beats[0].notes[0].string,bar.voices[0].beats[0].notes[0].string);assert.equal(bars[0].voices[0].beats[0].notes[0].fret,12);assert.ok(bars[0].voices[0].beats[0].notes[0].isPalmMute);assert.equal(bars[0].voices[1].beats[0].notes[0].fret,7);assert.equal(voiceQ(bars[1].voices[0]),3);
});
test('TG edits from another editor invalidate the supplemental snapshot',()=>{
  const files=unzipSync(exportTg(demoScore()));files['content.xml']=strToU8(strFromU8(files['content.xml']).replace('<name>First Session</name>','<name>External edit</name>'));
  assert.equal(importTg(zipSync(files)).score.title,'External edit');
});
