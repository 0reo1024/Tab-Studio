import type * as at from '@coderline/alphatab';
type PreviewReply={pcm?:Float32Array};
/** SoundFont rendering runs off the UI thread; repeated pitches reuse PCM. */
export class NotePreview {
  private context:AudioContext|undefined;
  private source:AudioBufferSourceNode|undefined;
  private generation=0;
  private id=0;
  private inputGeneration=0;
  private inputPending=0;
  private inputChain:Promise<unknown>=Promise.resolve();
  private lastInputStart=0;
  private workerInstance?:Worker;
  private pendingBytes?:Uint8Array;
  private requests=new Map<number,{resolve:(value:PreviewReply)=>void;reject:(error:Error)=>void}>();
  private readyPromise?:Promise<PreviewReply>;
  private audioContext?:()=>Promise<AudioContext>;
  private destination?:(track:number)=>AudioNode;
  private samplerPreview?:(track:number,pitch:number,note?:at.model.Note,scoreJson?:string)=>Promise<Float32Array|undefined>;
  setAudioRouting(context:()=>Promise<AudioContext>,destination:(track:number)=>AudioNode,samplerPreview?:(track:number,pitch:number,note?:at.model.Note,scoreJson?:string)=>Promise<Float32Array|undefined>){this.audioContext=context;this.destination=destination;this.samplerPreview=samplerPreview;}
  /** The SoundFont is decoded on first audition, not at startup beside alphaTab's own copy. */
  constructor(private url:string){}
  private get worker(){
    if(!this.workerInstance){
      const worker=new Worker(new URL('./note-preview.worker.ts',import.meta.url),{type:'module'});this.workerInstance=worker;
      worker.onmessage=({data})=>{const request=this.requests.get(data.id);if(!request)return;this.requests.delete(data.id);if(data.error)request.reject(new Error(data.error));else request.resolve(data);};
      worker.onerror=()=>{for(const request of this.requests.values())request.reject(new Error('試聴用音源を準備できませんでした。'));this.requests.clear();};
      const bytes=this.pendingBytes;this.pendingBytes=undefined;
      this.readyPromise=bytes?this.request('load',{bytes}):this.request('init',{url:this.url});void this.readyPromise.catch(()=>{});
    }
    return this.workerInstance;
  }
  private get ready(){void this.worker;return this.readyPromise!;}
  private request(kind:string,params:Record<string,unknown>){const id=++this.id;const worker=this.worker;return new Promise<PreviewReply>((resolve,reject)=>{this.requests.set(id,{resolve,reject});worker.postMessage({cmd:'tabStudio.preview',id,kind,...params});});}
  load(bytes:Uint8Array){this.stop();if(!this.workerInstance){this.pendingBytes=bytes.slice();return Promise.resolve({});}this.readyPromise=this.request('load',{bytes:bytes.slice()});void this.readyPromise.catch(()=>{});return this.readyPromise;}
  stop(){this.generation++;this.inputGeneration++;this.stopSource();}
  private stopSource(){if(this.source){this.source.stop();this.source.disconnect();this.source=undefined;}}
  async play(note:at.model.Note){
    if(this.inputPending)return this.enqueue(note);
    this.inputGeneration++;const track=note.beat.voice.bar.staff.track;
    return this.render('render',{pitch:note.realValue,program:track.playbackInfo.program,percussion:note.beat.voice.bar.staff.isPercussion,track:track.index},note.realValue,note);
  }
  /** Every typed value plays at once and in order, including rapid 1 → 12 input. No score rebuild. */
  enqueue(note:at.model.Note){
    this.inputPending++;const token=this.inputGeneration,track=note.beat.voice.bar.staff.track,pitch=note.realValue;
    const params={pitch,program:track.playbackInfo.program,percussion:note.beat.voice.bar.staff.isPercussion,track:track.index};
    const task=this.inputChain.catch(()=>{}).then(async()=>{
      if(token!==this.inputGeneration)return;
      const result=await this.render('render',params,pitch,note);
      if(result?.played)this.lastInputStart=performance.now();
      return result;
    }).finally(()=>{this.inputPending--;});
    this.inputChain=task;return task;
  }
  /** Explicit technique preview runs on a detached excerpt in the worker. */
  async playPhrase(scoreJson:string,track=0){this.inputGeneration++;return this.render('phrase',{scoreJson,track},0);}
  private async render(kind:string,params:Record<string,unknown>,pitch:number,note?:at.model.Note){
    const request=++this.generation;if(this.audioContext)this.context=await this.audioContext();else this.context??=new AudioContext();await this.context.resume();await this.ready;
    const override=await this.samplerPreview?.(Number(params.track)||0,pitch,note,kind==='phrase'?String(params.scoreJson):undefined);
    const pcm=override??(await this.request(kind,{...params,rate:this.context.sampleRate})).pcm;if(!pcm?.length)return;
    const frames=pcm.length/2;let peak=0;for(const v of pcm)peak=Math.max(peak,Math.abs(v));
    const result={pitch,peak,frames,played:false};if(request!==this.generation)return result;
    const buffer=this.context.createBuffer(2,frames,this.context.sampleRate),release=Math.min(frames,Math.ceil(this.context.sampleRate*.015));
    for(let channel=0;channel<2;channel++){const data=buffer.getChannelData(channel);for(let i=0;i<frames;i++)data[i]=pcm[i*2+channel];for(let i=0;i<release;i++)data[frames-1-i]*=i/release;}
    this.stopSource();const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.destination?.(Number(params.track)||0)??this.context.destination);source.start();this.source=source;result.played=true;
    source.onended=()=>{source.disconnect();if(this.source===source)this.source=undefined;};return result;
  }
}
