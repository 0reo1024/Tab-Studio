import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {demoScore,serialize,deserialize,voiceQ} from '../src/score';
import {copyBars,pasteBars,insertBars,deleteBars,addTrack,removeTrack,moveTrack,configureTrack,sliceScore,parsePitch,tuningPresets} from '../src/score-operations';
import {setPitch,hitStandard,diatonicPitch} from '../src/standard-editor';
import {pdfOptions} from '../src/pdf-options';
import {exportTg} from '../src/tg-writer';
import {importTg} from '../src/tg-reader';
import {DOMParser} from '@xmldom/xmldom';
globalThis.DOMParser=DOMParser as unknown as typeof globalThis.DOMParser;
const make=()=>at.importer.ScoreLoader.loadAlphaTex('\\tempo 110 \\track "Lead" . :4 3.1 5.1 7.1 9.1 | 1.1 3.1 5.1 7.1 | 5.1 7.1 9.1 11.1 \\track "Bass" \\instrument 33 \\tuning G2 D2 A1 E1 . :4 0.4 2.4 3.4 5.4 | 0.4 2.4 3.4 5.4 | 5.4 3.4 2.4 0.4',new at.Settings());
test('insert/delete across all tracks keeps meter, offsets, lengths and source unchanged',()=>{
  const s=make(),before=serialize(s);s.masterBars[1].timeSignatureNumerator=3;for(const t of s.tracks)t.staves[0].bars[1].voices[0].beats.pop();
  const inserted=insertBars(s,2,2);assert.equal(inserted.masterBars.length,5);assert.equal(inserted.masterBars[2].timeSignatureNumerator,3);
  for(const t of inserted.tracks){assert.equal(t.staves[0].bars.length,5);assert.ok(t.staves[0].bars[2].voices[0].beats[0].isFullBarRest);assert.equal(t.staves[0].bars[4].index,4);}
  assert.equal(inserted.masterBars[3].start,inserted.masterBars[2].start+2880);
  const deleted=deleteBars(inserted,2,3);assert.equal(deleted.masterBars.length,3);assert.equal(deleted.tracks[0].staves[0].bars[2].voices[0].beats[0].notes[0].fret,5);assert.throws(()=>deleteBars(s,0,2),/最低1小節/);assert.equal(deserialize(before).masterBars.length,3);
});
test('all-track copy/paste preserves effects, tempo and independent unique note IDs',()=>{
  const s=make(),n=s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];n.isPalmMute=true;s.masterBars[1].tempoAutomations=[at.model.Automation.buildTempoAutomation(false,0,140,2)];const before=serialize(s);
  const pasted=pasteBars(s,copyBars(s,0,1,null),3,0,true);assert.equal(pasted.masterBars.length,5);assert.equal(pasted.masterBars[4].tempoAutomations[0].value,140);assert.ok(pasted.tracks[0].staves[0].bars[3].voices[0].beats[0].notes[0].isPalmMute);
  const ids=pasted.tracks.flatMap(t=>t.staves.flatMap(st=>st.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(b=>b.notes.map(n=>n.id))))));assert.equal(new Set(ids).size,ids.length);assert.equal(serialize(s),before);
  assert.equal(pasted.tracks[1].staves[0].bars[4].voices[0].beats[1].notes[0].fret,2);
});
test('single-track paste only changes its content and rejects unsafe meter/string mismatch',()=>{
  const s=make(),clip=copyBars(s,0,0,0),pasted=pasteBars(s,clip,1,0,false);assert.equal(pasted.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].fret,3);assert.equal(pasted.tracks[1].staves[0].bars[1].voices[0].beats[0].notes[0].fret,0);
  const inserted=pasteBars(s,clip,1,0,true);assert.ok(inserted.tracks[1].staves[0].bars[1].voices[0].beats[0].isRest);s.masterBars[1].timeSignatureNumerator=3;assert.throws(()=>pasteBars(s,clip,1,0,false),/拍子/);assert.throws(()=>pasteBars(s,clip,3,0,false),/末尾/);
  const six=demoScore();assert.throws(()=>pasteBars(s,copyBars(six,3,3,0),0,1,false),/弦数/);
});
test('track configuration, bass creation, reorder and removal preserve scores and channels',()=>{
  const s=addTrack(demoScore(),true);assert.deepEqual(s.tracks[1].staves[0].tuning,tuningPresets.bass4);assert.equal(s.tracks[1].staves[0].bars[0].clef,at.model.Clef.F4);
  const configured=configureTrack(s,0,{name:'Drop D guitar',tuning:tuningPresets.dropD,capo:0});assert.equal(configured.tracks[0].name,'Drop D guitar');assert.equal(configured.tracks[0].staves[0].capo,0);assert.equal(configured.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].realValue,40);assert.equal(configured.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret,2);
  assert.throws(()=>configureTrack(s,0,{name:'Short',tuning:tuningPresets.bass4,capo:0}),/音程を保ったまま/); // Six-note chords cannot fit four strings.
  const moved=moveTrack(configured,1,0);assert.equal(moved.tracks[0].name,'Bass');assert.equal(moved.tracks[1].staves[0].bars[0].voices[0].beats[1].notes[0].fret,2);assert.notEqual(moved.tracks[0].playbackInfo.primaryChannel,moved.tracks[1].playbackInfo.primaryChannel);
  assert.equal(removeTrack(moved,0).tracks[0].name,'Drop D guitar');assert.throws(()=>removeTrack(demoScore(),0),/最低1/);assert.equal(parsePitch('Bb2'),46);assert.equal(parsePitch('F#3'),54);assert.throws(()=>parsePitch('H2'));
});
test('standard note editing maps sound pitch to TAB, preserves other chord notes and fails atomically',()=>{
  const s=demoScore(),b=s.tracks[0].staves[0].bars[1].voices[0].beats[0],old=b.notes.map(n=>n.realValueWithoutHarmonic);setPitch(b,42,0);assert.equal(b.notes[0].fret,2);assert.equal(b.notes[0].realValueWithoutHarmonic,42);assert.deepEqual(b.notes.slice(1).map(n=>n.realValueWithoutHarmonic),old.slice(1));
  const count=b.notes.length;setPitch(b,64,0,true);assert.equal(b.notes.length,count+1);assert.equal(b.notes.at(-1)!.realValueWithoutHarmonic,64);const before=serialize(s);assert.throws(()=>setPitch(b,0,0));assert.equal(serialize(s),before);assert.equal(diatonicPitch(64,1),65);assert.equal(diatonicPitch(64,-1),62);
});
test('standard staff hit testing matches actual note heads, rest pitch and worker bounds',()=>{
  const s=demoScore(),st=s.tracks[0].staves[0];st.showStandardNotation=true;st.showTablature=true;const settings=new at.Settings();settings.core.engine='svg';settings.core.useWorkers=false;settings.core.includeNoteBounds=true;const r=new at.rendering.ScoreRenderer(settings);r.width=1000;r.renderScore(s,[0]);
  const bounds=r.boundsLookup!,b=st.bars[0].voices[0].beats[0],bb=bounds.findBeats(b)![0],head=bb.notes![0];const hit=hitStandard(bounds,bb.onNotesX,head.noteHeadBounds.y+head.noteHeadBounds.h/2)!;assert.ok(hit);assert.equal(hit.note?.fret,0);assert.equal(hit.pitch,40);
  const rest=st.bars[3].voices[0].beats[1],rb=bounds.findBeats(rest)![0],top=rb.barBounds.visualBounds.y;const space=hitStandard(bounds,rb.onNotesX,top)!;assert.equal(space.pitch,65); // F5 written, F4 sounding guitar.
  for(const sys of bounds.staffSystems)for(const m of sys.bars)for(const bar of m.bars)(bar as unknown as {bar:undefined}).bar=undefined;assert.equal(hitStandard(bounds,bb.onNotesX,head.noteHeadBounds.y+head.noteHeadBounds.h/2)?.pitch,40);
});
test('piano notes can be created and edited without strings',()=>{
  const s=at.importer.ScoreLoader.loadAlphaTex('\\track "Piano" \\instrument 0 . :4 C4 D4 E4 F4',new at.Settings()),b=s.tracks[0].staves[0].bars[0].voices[0].beats[0];setPitch(b,61,0);assert.equal(b.notes[0].realValueWithoutHarmonic,61);assert.equal(b.notes[0].tone,1);
});
test('PDF range and size validate and a score slice retains starting tempo',()=>{
  const s=make();s.masterBars[1].tempoAutomations=[at.model.Automation.buildTempoAutomation(false,0,150,2)];const slice=sliceScore(s,2,2);assert.equal(slice.masterBars[0].tempoAutomations[0].value,150);assert.equal(slice.tracks[0].staves[0].bars.length,1);assert.equal(voiceQ(slice.tracks[0].staves[0].bars[0].voices[0]),4);
  assert.equal(pdfOptions({start:2,end:3,landscape:true,scale:1.2},3).start,2);assert.throws(()=>pdfOptions({end:4},3),/範囲/);assert.throws(()=>pdfOptions({scale:2},3),/サイズ/);
});
test('adding an intro and removing a tempo-bearing bar preserves the following playback tempo',()=>{
  const s=make();s.masterBars[1].tempoAutomations=[at.model.Automation.buildTempoAutomation(false,0,150,2)];assert.equal(insertBars(s,0,2).tempo,110);const removed=deleteBars(s,0,1);assert.equal(removed.tempo,150);assert.equal(removed.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret,5);
});
test('edited arrangement, seven strings, capo and standard pitch survive genuine TG save/reopen',()=>{
  let s=addTrack(demoScore(),true);s=configureTrack(s,0,{name:'Seven-string',tuning:tuningPresets.guitar7,capo:2});s=pasteBars(s,copyBars(s,0,1,null),2,0,true);s=moveTrack(s,1,0);setPitch(s.tracks[1].staves[0].bars[0].voices[0].beats[0],57,0);s=deserialize(serialize(s));assert.deepEqual(JSON.parse(serialize(importTg(exportTg(s)).score)),JSON.parse(serialize(s)));
});
