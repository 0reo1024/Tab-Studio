/** Encodes alphaTab's generated MIDI (after the app's midiLoad adjustments) as the
 * native audio engine's event list. Layout: crates/tabstudio-audio/src/song.rs —
 * "TSEV", u32 version 1, u32 division, u32 count, then 16-byte records:
 * u32 tick, u8 kind, u8 channel, u8 data1, u8 data2, u32 value, u16 track,
 * u16 articulation (SFZ: lane | continued << 7 | keyswitch << 8; a note bend's
 * reference key goes in data2). */
import {eventKey,type Articulation} from '../sfz-articulations';
export type MidiLikeEvent={type:number;tick:number;track:number;channel?:number;noteKey?:number;noteVelocity?:number;controller?:number;value?:number;program?:number;beatsPerMinute?:number;numerator?:number;denominatorIndex?:number;data1?:number;data2?:number};
export const enum EventKind{NoteOff=0x80,NoteOn=0x90,KeyPressure=0xA0,Control=0xB0,Program=0xC0,ChannelPressure=0xD0,PitchBend=0xE0,NoteBend=0x60,Tempo=0x51,TimeSignature=0x58,End=0x2F,TickShift=0x7E}
const RECORD=16;
type Record=[tick:number,kind:number,channel:number,data1:number,data2:number,value:number,track:number,articulation?:number];
/** alphaTab's MidiEventType numbers NoteOn as 128 and NoteOff as 144, the reverse of
 * MIDI status bytes; every other channel type uses the MIDI value. */
const AlphaTabNoteOn=128,AlphaTabNoteOff=144;
function record(e:MidiLikeEvent):Record|null{
 const channel=(e.channel??0)&15;
 switch(e.type){
  case AlphaTabNoteOn:return [e.tick,EventKind.NoteOn,channel,e.noteKey??e.data1??0,e.noteVelocity??e.data2??0,0,e.track];
  case AlphaTabNoteOff:return [e.tick,EventKind.NoteOff,channel,e.noteKey??e.data1??0,e.noteVelocity??e.data2??0,0,e.track];
  case EventKind.Control:return [e.tick,e.type,channel,e.controller??e.data1??0,e.value??e.data2??0,0,e.track];
  case EventKind.Program:return [e.tick,e.type,channel,e.program??e.data1??0,0,0,e.track];
  case EventKind.KeyPressure:case EventKind.ChannelPressure:return [e.tick,e.type,channel,e.data1??0,e.data2??0,0,e.track];
  case EventKind.PitchBend:return [e.tick,e.type,channel,0,0,e.value??(((e.data2??64)<<7)|(e.data1??0)),e.track];
  case EventKind.NoteBend:return [e.tick,e.type,channel,e.noteKey??0,0,e.value??0x80000000,e.track];
  case EventKind.Tempo:return [e.tick,e.type,0,0,0,Math.round((e.beatsPerMinute??120)*1000),e.track];
  case EventKind.TimeSignature:return [e.tick,e.type,0,e.numerator??4,e.denominatorIndex??2,0,e.track];
  case EventKind.End:return [e.tick,e.type,0,0,0,0,e.track];
  case EventKind.TickShift:return [0,e.type,0,0,0,e.value??0,0];
  default:return null;
 }
}
/** Articulations per event key, consumed in event order like MixerAudio.receive does. */
type Articulations=Map<string,Articulation[]>;
export function encodeEventList(division:number,events:Iterable<MidiLikeEvent>,articulations?:Articulations):Uint8Array{
 const records:Record[]=[],seen=new Map<string,number>();
 for(const e of events){const r=record(e);if(!r)continue;
  const list=articulations&&[AlphaTabNoteOn,AlphaTabNoteOff,EventKind.NoteBend].includes(e.type)?articulations.get(eventKey(e)):undefined;
  if(list?.length){const key=eventKey(e),n=seen.get(key)??0;seen.set(key,n+1);const a=list[n%list.length];r[7]=(a.lane&0x7f)|(a.continued?0x80:0)|((a.keyswitch&0x7f)<<8);if(e.type===EventKind.NoteBend)r[4]=a.reference&0x7f;}
  records.push(r);
 }
 const out=new Uint8Array(16+records.length*RECORD),view=new DataView(out.buffer);
 out.set([84,83,69,86]);view.setUint32(4,1,true);view.setUint32(8,division,true);view.setUint32(12,records.length,true);
 records.forEach(([tick,kind,channel,data1,data2,value,track,articulation],i)=>{const at=16+i*RECORD;view.setUint32(at,tick,true);out[at+4]=kind;out[at+5]=channel;out[at+6]=data1&127;out[at+7]=data2&127;view.setUint32(at+8,value>>>0,true);view.setUint16(at+12,track,true);view.setUint16(at+14,articulation??0,true);});
 return out;
}
/** alphaTab MidiFile -> event list (format 0 keeps everything in tracks[0]; each event still carries its score track). */
export function eventListFromMidi(midi:{division:number;tickShift?:number;tracks:{events:MidiLikeEvent[]}[]},articulations?:Articulations):Uint8Array{
 // The tick shift places the metronome like alphaTab's sequencer does.
 const shift:MidiLikeEvent[]=midi.tickShift?[{type:EventKind.TickShift,tick:0,track:0,value:midi.tickShift}]:[];
 return encodeEventList(midi.division,[...shift,...midi.tracks.flatMap(t=>t.events)],articulations);
}
