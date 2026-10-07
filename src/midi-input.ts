type Port={id:string;name?:string;state:string;onmidimessage:((event:{data:Uint8Array})=>void)|null};
type Access={inputs:Map<string,Port>;onstatechange:(()=>void)|null};
/** Step input closes a chord only when all its keys have been released. */
export class MidiStepInput{
 private access:Access|undefined;private port:Port|undefined;private held=new Set<string>();private chord=new Set<number>();private target:unknown;channel=0;preview=false;
 constructor(private capture:()=>unknown,private commit:(pitches:number[],target:unknown)=>void,private audition:(pitch:number)=>void,private silence:()=>void,private changed:()=>void){}
 async devices(){const nav=navigator as unknown as {requestMIDIAccess?:()=>Promise<Access>};if(!nav.requestMIDIAccess)throw new Error('この環境ではMIDI入力を利用できません。');const access=this.access??=await nav.requestMIDIAccess();access.onstatechange=()=>{if(this.port?.state==='disconnected')this.disconnect();this.changed();};return [...access.inputs.values()].filter(p=>p.state!=='disconnected');}
 connect(id:string){this.disconnect();this.port=this.access?.inputs.get(id);if(!this.port)throw new Error('MIDI機器を選択してください。');this.port.onmidimessage=e=>this.message(e.data);}
 message(data:Uint8Array){const status=data[0]&0xf0,channel=(data[0]&15)+1;if(this.channel&&channel!==this.channel)return;if(status===0xb0&&[120,123].includes(data[1])){this.cancel();return;}if(status!==0x90&&status!==0x80)return;const pitch=data[1],key=`${channel}:${pitch}`;if(status===0x90&&data[2]>0){if(!this.held.size){this.target=this.capture();this.chord.clear();}if(this.target==null)return;this.held.add(key);this.chord.add(pitch);if(this.preview)this.audition(pitch);}else if(this.held.delete(key)&&!this.held.size){const pitches=[...this.chord].sort((a,b)=>a-b),target=this.target;this.cancel();this.commit(pitches,target);}}
 cancel(){this.held.clear();this.chord.clear();this.target=null;this.silence();}
 disconnect(){if(this.port)this.port.onmidimessage=null;this.port=undefined;this.cancel();}
 get connected(){return !!this.port;}
}
