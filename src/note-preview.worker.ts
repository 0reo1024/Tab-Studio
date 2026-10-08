import * as at from '@coderline/alphatab';
import {installPlaybackTechniques} from './playback-techniques';
installPlaybackTechniques();
function signal<T=void>(){const listeners=new Set<(value:T)=>void>();return {on(fn:(value:T)=>void){listeners.add(fn);return ()=>listeners.delete(fn);},off(fn:(value:T)=>void){listeners.delete(fn);},trigger(value:T){for(const fn of listeners)fn(value);}};}
const ready=signal(),output:at.synth.ISynthOutput={sampleRate:44100,open(){ready.trigger();},play(){},pause(){},destroy(){},addSamples(){},resetSamples(){},activate(){},ready,sampleRequest:signal(),samplesPlayed:signal<number>(),enumerateOutputDevices:async()=>[],setOutputDevice:async()=>{},getOutputDevice:async()=>null};
const synth=new at.synth.AlphaSynth(output,100),cache=new Map<string,Float32Array>();
let soundfontGeneration=0;
const bridge=globalThis as unknown as {onmessage:(e:MessageEvent)=>void;postMessage:(value:unknown,transfer?:Transferable[])=>void};
bridge.onmessage=async({data:d})=>{try{
  if(d.kind==='init'||d.kind==='load'){const generation=++soundfontGeneration,bytes=d.bytes??new Uint8Array(await (await fetch(d.url)).arrayBuffer());if(generation===soundfontGeneration){synth.loadSoundFont(bytes,false);cache.clear();}bridge.postMessage({id:d.id});return;}
  if(d.kind==='phrase'){const settings=new at.Settings(),score=at.model.JsonConverter.jsonToScore(d.scoreJson,settings),midi=new at.midi.MidiFile(),handler=new at.midi.AlphaSynthMidiFileHandler(midi),generator=new at.midi.MidiFileGenerator(score,settings,handler);generator.applyTranspositionPitches=true;generator.generate();synth.loadMidiFile(midi);const options=new at.synth.AudioExportOptions();options.sampleRate=d.rate;options.metronomeVolume=0;const pcm=synth.exportAudio(options,midi,[],new Map()).render(2500)?.samples;if(!pcm?.length)throw new Error('奏法の試聴音を生成できませんでした。');bridge.postMessage({id:d.id,pcm},[pcm.buffer]);return;}
  const key=`${d.pitch}:${d.program}:${d.percussion}:${d.rate}`;let pcm=cache.get(key);
  if(!pcm){const midi=new at.midi.MidiFile(),handler=new at.midi.AlphaSynthMidiFileHandler(midi),channel=d.percussion?9:0;handler.addTempo(0,120);handler.addProgramChange(0,0,channel,d.program);handler.addNote(0,0,960,d.pitch,100,channel);synth.loadMidiFile(midi);const options=new at.synth.AudioExportOptions();options.sampleRate=d.rate;options.metronomeVolume=0;pcm=synth.exportAudio(options,midi,[],new Map()).render(350)?.samples;if(!pcm?.length)throw new Error('試聴音を生成できませんでした。');cache.set(key,pcm);if(cache.size>128)cache.delete(cache.keys().next().value!);}
  const copy=pcm.slice();bridge.postMessage({id:d.id,pcm:copy},[copy.buffer]);
}catch(e){bridge.postMessage({id:d.id,error:String(e instanceof Error?e.message:e)});}};
