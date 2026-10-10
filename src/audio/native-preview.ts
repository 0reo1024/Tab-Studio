import * as at from '@coderline/alphatab';
import {eventListFromMidi} from './event-list';
import {joinFrame} from '../platform/frame';
import type {EngineHost} from './native-engine';
type Result={pitch:number;peak:number;frames:number;played:boolean};
/** Note and phrase previews through the native engine: the same MIDI the preview worker
 * renders (src/note-preview.worker.ts) is sent as an event list; the engine renders it
 * offline and plays it through the track's mix. Same interface as NotePreview, without a
 * second SoundFont copy in a worker. */
export class NativeNotePreview{
 private generation=0;private inputGeneration=0;private inputPending=0;private inputChain:Promise<unknown>=Promise.resolve();private lastInputStart=0;
 constructor(private host:EngineHost,private started:()=>Promise<void>){}
 /** One note: 120 bpm, a quarter note at velocity 100 on channel 0 (9 for drums). */
 static noteEvents(pitch:number,program:number,percussion:boolean){
  const midi=new at.midi.MidiFile(),handler=new at.midi.AlphaSynthMidiFileHandler(midi),channel=percussion?9:0;
  handler.addTempo(0,120);handler.addProgramChange(0,0,channel,program);handler.addNote(0,0,960,pitch,100,channel);
  return eventListFromMidi(midi);
 }
 /** A detached excerpt (technique preview), with transposition pitches applied. */
 static phraseEvents(scoreJson:string){
  const settings=new at.Settings(),score=at.model.JsonConverter.jsonToScore(scoreJson,settings),midi=new at.midi.MidiFile();
  const generator=new at.midi.MidiFileGenerator(score,settings,new at.midi.AlphaSynthMidiFileHandler(midi));generator.applyTranspositionPitches=true;generator.generate();
  return eventListFromMidi(midi);
 }
 setAudioRouting(){}
 /** A user-chosen SoundFont is not used by the native engine yet. */
 async load(){return {};}
 stop(){this.generation++;this.inputGeneration++;void this.host.invoke('audio_preview_stop').catch(()=>{});}
 private params(note:at.model.Note){const track=note.beat.voice.bar.staff.track;return {pitch:note.realValue,program:track.playbackInfo.program,percussion:note.beat.voice.bar.staff.isPercussion,track:track.index};}
 async play(note:at.model.Note){if(this.inputPending)return this.enqueue(note);this.inputGeneration++;const p=this.params(note);return this.render(NativeNotePreview.noteEvents(p.pitch,p.program,p.percussion),p.track,p.pitch);}
 /** Keeps every typed value (rapid 1 -> 12) in order; each plays as soon as it is rendered. */
 enqueue(note:at.model.Note){
  this.inputPending++;const token=this.inputGeneration,p=this.params(note);
  const task=this.inputChain.catch(()=>{}).then(async()=>{
   if(token!==this.inputGeneration)return;
   const result=await this.render(NativeNotePreview.noteEvents(p.pitch,p.program,p.percussion),p.track,p.pitch);
   if(result?.played)this.lastInputStart=performance.now();
   return result;
  }).finally(()=>{this.inputPending--;});
  this.inputChain=task;return task;
 }
 async playPhrase(scoreJson:string,track=0){this.inputGeneration++;return this.render(NativeNotePreview.phraseEvents(scoreJson),track,0);}
 private async render(events:Uint8Array,track:number,pitch:number):Promise<Result|undefined>{
  const request=++this.generation;await this.started();if(request!==this.generation)return;
  const reply=await this.host.send<{frames:number;peak:number;played:boolean}>('audio_preview',joinFrame({track},[events]));
  return {pitch,peak:reply.peak,frames:reply.frames,played:reply.played};
 }
}
