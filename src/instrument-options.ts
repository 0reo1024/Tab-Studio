import type {model} from '@coderline/alphatab';
const names=[
 'Acoustic Grand Piano|Bright Acoustic Piano|Electric Grand Piano|Honky-tonk Piano|Electric Piano 1|Electric Piano 2|Harpsichord|Clavinet',
 'Celesta|Glockenspiel|Music Box|Vibraphone|Marimba|Xylophone|Tubular Bells|Dulcimer',
 'Drawbar Organ|Percussive Organ|Rock Organ|Church Organ|Reed Organ|Accordion|Harmonica|Tango Accordion',
 'Nylon Classic|Steel Acoustic|Jazz Clean|Electric Clean|Muted Guitar|Overdrive|Distortion|Guitar Harmonics',
 'Acoustic Bass|Finger Bass|Pick Bass|Fretless Bass|Slap Bass 1|Slap Bass 2|Synth Bass 1|Synth Bass 2',
 'Violin|Viola|Cello|Contrabass|Tremolo Strings|Pizzicato Strings|Orchestral Harp|Timpani',
 'String Ensemble 1|String Ensemble 2|Synth Strings 1|Synth Strings 2|Choir Aahs|Voice Oohs|Synth Voice|Orchestra Hit',
 'Trumpet|Trombone|Tuba|Muted Trumpet|French Horn|Brass Section|Synth Brass 1|Synth Brass 2',
 'Soprano Sax|Alto Sax|Tenor Sax|Baritone Sax|Oboe|English Horn|Bassoon|Clarinet',
 'Piccolo|Flute|Recorder|Pan Flute|Blown Bottle|Shakuhachi|Whistle|Ocarina',
 'Lead 1 (Square)|Lead 2 (Sawtooth)|Lead 3 (Calliope)|Lead 4 (Chiff)|Lead 5 (Charang)|Lead 6 (Voice)|Lead 7 (Fifths)|Lead 8 (Bass + Lead)',
 'Pad 1 (New Age)|Pad 2 (Warm)|Pad 3 (Polysynth)|Pad 4 (Choir)|Pad 5 (Bowed)|Pad 6 (Metallic)|Pad 7 (Halo)|Pad 8 (Sweep)',
 'FX 1 (Rain)|FX 2 (Soundtrack)|FX 3 (Crystal)|FX 4 (Atmosphere)|FX 5 (Brightness)|FX 6 (Goblins)|FX 7 (Echoes)|FX 8 (Sci-fi)',
 'Sitar|Banjo|Shamisen|Koto|Kalimba|Bagpipe|Fiddle|Shanai',
 'Tinkle Bell|Agogo|Steel Drums|Woodblock|Taiko Drum|Melodic Tom|Synth Drum|Reverse Cymbal',
 'Guitar Fret Noise|Breath Noise|Seashore|Bird Tweet|Telephone Ring|Helicopter|Applause|Gunshot'
].flatMap(row=>row.split('|'));
let gmTemplate:HTMLOptionElement[]|undefined;
function gmOptions(){gmTemplate??=names.map((name,program)=>new Option(name,String(program)));return gmTemplate.map(o=>o.cloneNode(true) as HTMLOptionElement);}
export function fillGmSelector(select:HTMLSelectElement,track:model.Track){select.replaceChildren(...(track.isPercussion?[new Option('Standard Drum Kit',String(track.playbackInfo.program))]:gmOptions()));select.value=String(track.playbackInfo.program);select.disabled=track.isPercussion;}
export function isGuitarDI(sound:{name?:string;path?:string}){return /Standard[ _-]?Guitar|Standard DI|Guitar DI/i.test(`${sound.name??''} ${sound.path??''}`);}
export function isBassDI(sound:{name?:string;path?:string}){return /Bass DI|Standard[ _-]?Bass/i.test(`${sound.name??''} ${sound.path??''}`);}
export function soundName(sound:{name:string;path?:string}){return isGuitarDI(sound)?'Guitar DI':isBassDI(sound)?'Bass DI':sound.name;}
export type DiKind='guitar'|'bass';
type DiTrack={playbackInfo:{program:number};staves:{tuning:number[]}[]};
type DiAudio={sound:{kind:string;path?:string};nam:{enabled:boolean;kind?:DiKind;model:string};fx:{enabled:boolean}[]};
/** The amp type of a NAM model: imported models carry it; built-in bass amps are named bass-*. */
export function namKind(n:{kind?:DiKind;model:string}):DiKind{return n.kind??(n.model.startsWith('bass-')?'bass':'guitar');}
/** Which DI a track plays: NAM follows its amp (guitar or bass), and a GM guitar or bass
 * with insert FX gets the matching DI; otherwise null (the track's own sound). */
export function diKind(track:DiTrack,audio:DiAudio):DiKind|null{
 if(audio.nam.enabled)return namKind(audio.nam);
 const program=track.playbackInfo.program;
 if(!track.staves.some(st=>st.tuning.length>0)||audio.sound.kind!=='gm'||!audio.fx.some(f=>f.enabled))return null;
 return program>=24&&program<=31?'guitar':program>=32&&program<=39?'bass':null;
}
/** The library entry for a DI: the Bass DI (Growlybass; a sound saved with an earlier bass DI
 * such as Standard Bass V2 finger/pick falls back to it), or the Guitar DI. */
export function diSound<T extends {name:string;path:string}>(kind:DiKind,library:T[],current?:{path?:string}):T|undefined{
 if(kind==='guitar')return library.find(isGuitarDI);
 const basses=library.filter(isBassDI);return basses.find(s=>s.path===current?.path)??basses[0];
}
