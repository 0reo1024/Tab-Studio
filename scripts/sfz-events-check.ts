import * as at from '@coderline/alphatab';
import {DOMParser} from '@xmldom/xmldom';
import {settings} from '../src/score';
import {installSfzCapture,articulationMap,eventKey} from '../src/sfz-articulations';
import {writeFileSync} from 'node:fs';
Object.assign(globalThis,{DOMParser});installSfzCapture();
const out:any={};
for(const kind of ['grace','slide','arm','bend','harmonic','pinch','slide-in','palm','hammer','trill','tremolo']){
 const score=at.importer.ScoreLoader.loadAlphaTex('\\tempo 120 \\track "Guitar" \\tuning E4 B3 G3 D3 A2 E2 . :4 7.1 9.1 5.1 r',settings);
 const beats=score.tracks[0].staves[0].bars[0].voices[0].beats,n=beats[0].notes[0];
 if(kind==='slide'||kind==='grace')n.slideOutType=at.model.SlideOutType.Legato;
 if(kind==='grace')beats[0].graceType=at.model.GraceType.OnBeat;
 if(kind==='arm'){beats[0].addWhammyBarPoint(new at.model.BendPoint(0,0));beats[0].addWhammyBarPoint(new at.model.BendPoint(60,-10));}
 if(kind==='bend'){n.addBendPoint(new at.model.BendPoint(0,0));n.addBendPoint(new at.model.BendPoint(60,4));const other=new at.model.Note();other.string=2;other.fret=5;beats[0].addNote(other);}
 if(kind==='harmonic'){n.fret=12;n.harmonicType=at.model.HarmonicType.Natural;n.harmonicValue=12;}
 if(kind==='pinch'){n.fret=7;n.harmonicType=at.model.HarmonicType.Pinch;n.harmonicValue=12;}
 if(kind==='slide-in'){n.fret=9;n.slideInType=at.model.SlideInType.IntoFromBelow;}
 if(kind==='palm')n.isPalmMute=true;
 if(kind==='hammer')n.isHammerPullOrigin=true;
 if(kind==='trill')n.trillValue=73;
 if(kind==='tremolo')beats[0].tremoloSpeed=at.model.Duration.Sixteenth;
 score.finish(settings);
 const file=new at.midi.MidiFile(),handler=new at.midi.AlphaSynthMidiFileHandler(file);new at.midi.MidiFileGenerator(score,settings,handler).generate();const map=articulationMap(file);
 out[kind]=file.tracks.flatMap(t=>t.events).filter((e:any)=>[128,144,96,176,224].includes(e.type)).map((e:any)=>({...e,...map.get(eventKey(e))?.[0]})).sort((a:any,b:any)=>a.tick-b.tick);
 console.log(kind,out[kind].filter((e:any)=>e.type===128).map((e:any)=>[e.tick,e.noteKey,e.lane,e.keyswitch]));
}
writeFileSync('test-results/sfz-events.json',JSON.stringify(out));
