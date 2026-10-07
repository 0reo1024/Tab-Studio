import type * as at from '@coderline/alphatab';
type PreviewReply={pcm?:Float32Array};
/** SoundFont rendering runs off the UI thread; repeated pitches reuse PCM. */
export class NotePreview {
  private context:AudioContext|undefined;
  private source:AudioBufferSourceNode|undefined;
  private generation=0;
  private id=0;
  private worker=new Worker(new URL('./note-preview.worker.ts',import.meta.url),{type:'module'});
  private requests=new Map<number,{resolve:(value:PreviewReply)=>void;reject:(error:Error)=>void}>();
  private ready:Promise<PreviewReply>;
  constructor(url:string){
    this.worker.onmessage=({data})=>{const request=this.requests.get(data.id);if(!request)return;this.requests.delete(data.id);if(data.error)request.reject(new Error(data.error));else request.resolve(data);};
    this.worker.onerror=()=>{for(const request of this.requests.values())request.reject(new Error('試聴用音源を準備できませんでした。'));this.requests.clear();};
    this.ready=this.request('init',{url});void this.ready.catch(()=>{});
  }
  private request(kind:string,params:Record<string,unknown>){const id=++this.id;return new Promise<PreviewReply>((resolve,reject)=>{this.requests.set(id,{resolve,reject});this.worker.postMessage({cmd:'tabStudio.preview',id,kind,...params});});}
  load(bytes:Uint8Array){this.stop();this.ready=this.request('load',{bytes:bytes.slice()});void this.ready.catch(()=>{});return this.ready;}
  stop(){this.generation++;if(this.source){this.source.stop();this.source.disconnect();this.source=undefined;}}
  async play(note:at.model.Note){
    const track=note.beat.voice.bar.staff.track;
    return this.render('render',{pitch:note.realValue,program:track.playbackInfo.program,percussion:note.beat.voice.bar.staff.isPercussion},note.realValue);
  }
  /** Explicit technique preview runs on a detached excerpt in the worker. */
  async playPhrase(scoreJson:string){return this.render('phrase',{scoreJson},0);}
  private async render(kind:string,params:Record<string,unknown>,pitch:number){
    const request=++this.generation;this.context??=new AudioContext();await this.context.resume();await this.ready;
    const {pcm}=await this.request(kind,{...params,rate:this.context.sampleRate});if(!pcm?.length)return;
    const frames=pcm.length/2;let peak=0;for(const v of pcm)peak=Math.max(peak,Math.abs(v));
    const result={pitch,peak,frames};if(request!==this.generation)return result;
    const buffer=this.context.createBuffer(2,frames,this.context.sampleRate),release=Math.min(frames,Math.ceil(this.context.sampleRate*.015));
    for(let channel=0;channel<2;channel++){const data=buffer.getChannelData(channel);for(let i=0;i<frames;i++)data[i]=pcm[i*2+channel];for(let i=0;i<release;i++)data[frames-1-i]*=i/release;}
    this.stop();const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);source.start();this.source=source;
    source.onended=()=>{source.disconnect();if(this.source===source)this.source=undefined;};return result;
  }
}
