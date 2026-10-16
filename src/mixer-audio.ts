import {platform} from './platform/bridge';
import {perfStart} from './perf';
import {diKind,diSound} from './instrument-options';
import * as at from '@coderline/alphatab';
import {trackAudio,masterAudio,NAM_INPUT_TRIM,NAM_OUTPUT_TRIM,namOutputLevel,type TrackAudio} from './mixer-state';
import './native-fx';
import {clickWave,type ClickKind} from './metronome';
import {articulationMap,eventKey,type Articulation} from './sfz-articulations';

type Graph={input:GainNode;gain:GainNode;pan:StereoPannerNode;send:GainNode;meter:AnalyserNode;nodes:AudioNode[];nam?:AudioWorkletNode;namKey?:string;namNorm?:number;signature?:string;sampler?:{id:string;path:string;lanes:number[];pitches:Record<string,number[]>};native:Map<string,{id:string;path:string;state?:string}>;fxNodes?:Map<string,AudioWorkletNode>;namControls?:{input:GainNode;output:GainNode;bass:BiquadFilterNode;mid:BiquadFilterNode;treble:BiquadFilterNode;cabinetHigh:BiquadFilterNode;cabinetLow:BiquadFilterNode};pending:Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>};
export class MixerAudio {
 underrunFrames=0;context?:AudioContext;private score?:at.model.Score;private output:any;private source?:AudioWorkletNode;
 private packets:{stems:[number,Float32Array][];events:any[]}[]=[];private graphs:Graph[]=[];private musicBus?:GainNode;private master?:GainNode;private masterMeter?:AnalyserNode;private reverbInput?:GainNode;private click?:GainNode;private sfzLibrary?:ReturnType<NonNullable<typeof platform.nativeFx>['sfzLibrary']>;private meterBuffers=new WeakMap<AnalyserNode,Float32Array<ArrayBuffer>>();private namBytes?:ArrayBuffer;private module?:Promise<void>;private request=0;private mapping=new Map<number,number>();private playbackGeneration=0;private renderChain=Promise.resolve();
 onError:(error:string)=>void=()=>{};onStatusChange:()=>void=()=>{};private loading=new Set<number>();isLoading(index:number){return this.loading.has(index);}
 private operation:Promise<void>=Promise.resolve();private releasePending=0;private namLoading?:Promise<void>;private clickDelay?:DelayNode;private clickMeter?:AnalyserNode;private sourceEpoch=0;
 private clickState:{on:boolean;kind:ClickKind;volume:number}={on:false,kind:'wood',volume:1.3};private clickVoices:{pcm:Float32Array;position:number}[]=[];
 configureClick(on:boolean,kind:ClickKind,volume:number){this.clickState={on,kind,volume};if(!on)this.clickVoices=[];this.sendRouting();}
 /** The synth worker that renders playback; set once alphaTab's player talks to it. */
 private synthWorker?:Worker;private direct=false;
 setSynthWorker(worker:Worker){this.synthWorker=worker;}
 /** Direct route: worker stems go straight to the output worklet, which also routes
  * channels to track outputs and renders the click. SFZ tracks still need the main
  * thread (IPC), so playback with a sampler keeps the relayed route. */
 /** A sampler added mid-playback needs the relayed route from the next packet on. */
 private useRelay(){if(!this.direct)return;this.direct=false;this.synthWorker?.postMessage({cmd:'studio.port',port:null});this.source?.port.postMessage({cmd:'relay'});}
 private sendRouting(){if(this.direct)this.source?.port.postMessage({cmd:'routing',map:[...this.mapping],clickIndex:this.score?.tracks.length??1,click:this.clickState});}
 resourceStats(){return {graphs:this.graphs.length,nam:this.graphs.filter(g=>!!g.nam).length,samplers:this.graphs.filter(g=>!!g.sampler).length,sfzLanes:this.graphs.reduce((sum,g)=>sum+(g.sampler?.lanes.length??0),0),externalFx:this.graphs.reduce((sum,g)=>sum+g.native.size,0),pendingPacketBytes:this.packets.reduce((sum,p)=>sum+p.stems.reduce((bytes,[,pcm])=>bytes+pcm.byteLength,0),0),wasmBytes:this.namBytes?.byteLength??0,releasing:this.releasePending>0};}
 private clickSamples(frames:number,events:any[]){const pcm=new Float32Array(frames*2),state=this.clickState;if(!state.on||state.kind==='standard')return pcm;for(const e of events)if(e.isMetronome)this.clickVoices.push({pcm:clickWave(state.kind,e.metronomeNumerator===0,this.context!.sampleRate),position:-e.delay});for(const voice of this.clickVoices){for(let i=0;i<frames;i++){const position=voice.position+i;if(position>=0&&position<voice.pcm.length)pcm[i*2]=pcm[i*2+1]+=voice.pcm[position]*state.volume;}voice.position+=frames;}this.clickVoices=this.clickVoices.filter(v=>v.position<v.pcm.length);return pcm;}
 private articulations=new Map<string,Articulation[]>();private requiredLanes=new Map<number,number[]>();private requiredPitches=new Map<number,Record<string,number[]>>();
 setMidiFile(file:at.midi.MidiFile){this.articulations=articulationMap(file);const lanes=new Map<number,Map<number,Set<number>>>();for(const [key,values]of this.articulations){const parts=key.split(':'),index=Number(parts[0]),pitch=Number(parts.at(-1));if(!Number.isInteger(index)||index<0||!Number.isInteger(pitch)||pitch<0||pitch>127)continue;let byLane=lanes.get(index);if(!byLane){byLane=new Map();lanes.set(index,byLane);}for(const value of values)if(value.lane>=1&&value.lane<=12){let keys=byLane.get(value.lane);if(!keys){keys=new Set();byLane.set(value.lane,keys);}keys.add(pitch);}}this.requiredLanes=new Map([...lanes].map(([index,byLane])=>[index,[...byLane.keys()].sort((a,b)=>a-b)]));this.requiredPitches=new Map([...lanes].map(([index,byLane])=>[index,Object.fromEntries([...byLane].map(([lane,keys])=>[lane,[...keys].sort((a,b)=>a-b)]))]));}
 receive(d:any){if(d.cmd==='alphaSynth.output.addSamples'){const counts=new Map<string,number>();const events=(d.studioMidi??[]).map((e:any)=>{const key=eventKey(e),list=this.articulations.get(key),n=counts.get(key)??0;counts.set(key,n+1);return list?{...e,...list[n%list.length]}:e;});this.packets.push({stems:d.studioStems??[],events});}}
 async attach(context:AudioContext){
  if(this.context===context&&this.module)return this.module;
  this.context=context;
  this.module=context.audioWorklet.addModule(new URL('../mixer-output.js',document.baseURI).href).then(()=>{
   this.master=context.createGain();this.masterMeter=context.createAnalyser();this.masterMeter.fftSize=256;this.musicBus=context.createGain();this.musicBus.connect(this.master);
   // Leave headroom for summed instruments; catch peaks after all FX and reverb.
   const limiter=context.createDynamicsCompressor();limiter.threshold.value=-3;limiter.knee.value=0;limiter.ratio.value=20;limiter.attack.value=.003;limiter.release.value=.12;
   this.master.connect(limiter);limiter.connect(this.masterMeter);this.masterMeter.connect(context.destination);
   this.click=context.createGain();this.clickMeter=context.createAnalyser();this.clickMeter.fftSize=256;this.clickDelay=context.createDelay(5);this.click.connect(this.clickMeter);this.clickMeter.connect(this.clickDelay);this.clickDelay.connect(this.master);
   this.reverbInput=context.createGain();const convolver=context.createConvolver(),impulse=context.createBuffer(2,Math.floor(context.sampleRate*1.8),context.sampleRate);
   let seed=871;for(let c=0;c<2;c++){const channel=impulse.getChannelData(c);for(let i=0;i<channel.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;channel[i]=(seed/2147483648*2-1)*Math.pow(1-i/channel.length,3)*.18;}}
   convolver.buffer=impulse;this.reverbInput.connect(convolver);convolver.connect(this.musicBus);
  });
  return this.module;
 }
 attachOutput(output:any){
  if(this.output===output)return;this.output=output;
  const retireSource=()=>{const source=this.source;if(!source)return;this.source=undefined;if(this.direct){this.direct=false;this.synthWorker?.postMessage({cmd:'studio.port',port:null});}source.port.onmessage=null;source.port.postMessage({cmd:'stop'});source.disconnect();source.port.close();};
  output.play=()=>{output.activate();const context=this.context!;retireSource();this.packets=[];this.clickVoices=[];this.playbackGeneration++;this.sourceEpoch=0;this.underrunFrames=0;
   const count=(this.score?.tracks.length??1)+1;
   const source=new AudioWorkletNode(context,'studio-output',{numberOfInputs:0,numberOfOutputs:count,outputChannelCount:Array(count).fill(2)});this.source=source;
   this.graphs.forEach((g,i)=>source.connect(g.input,i));source.connect(this.click!,count-1);
   // Retired/seeked worklets must not advance a subsequent playback's clock.
   source.port.onmessage=({data:d})=>{if(source!==this.source||d.epoch!==this.sourceEpoch)return;if(d.cmd==='underrun')this.underrunFrames+=d.frames;else if(d.cmd==='request')output.sampleRequest.trigger();else if(d.cmd==='played')output.samplesPlayed.trigger(d.frames);};
   if(this.synthWorker&&!this.graphs.some(g=>g.sampler)){const channel=new MessageChannel();this.direct=true;source.port.postMessage({cmd:'direct',port:channel.port1},[channel.port1]);this.sendRouting();this.synthWorker.postMessage({cmd:'studio.port',port:channel.port2},[channel.port2]);}
  };
  output.pause=()=>{retireSource();this.packets=[];this.playbackGeneration++;this.resetSamplers();};
  // On the direct route the worker sends its reset in order with its packets.
  output.resetSamples=()=>{this.packets=[];this.clickVoices=[];if(this.direct){this.playbackGeneration++;this.resetSamplers();return;}this.sourceEpoch++;this.source?.port.postMessage({cmd:'reset',epoch:this.sourceEpoch});this.playbackGeneration++;this.resetSamplers();};
  output.addSamples=(samples:Float32Array)=>{const done=perfStart('audio.packet');try{relay(samples);}finally{done();}};
  const relay=(samples:Float32Array)=>{
   const packet=this.packets.shift()??{stems:[],events:[]},stems=packet.stems;if(!this.source)return;
   const routed=new Map<number,Float32Array>();
   for(const [channel,pcm]of stems){const index=this.mapping.get(channel)??(this.score?.tracks.length??1);let sum=routed.get(index);if(!sum){sum=new Float32Array(pcm.length);routed.set(index,sum);}for(let j=0;j<pcm.length;j++)sum[j]+=pcm[j];}
   const generation=this.playbackGeneration,source=this.source,epoch=this.sourceEpoch,frames=samples.length/2;
   if(this.clickState.kind!=='standard')routed.set(this.score?.tracks.length??1,this.clickSamples(frames,packet.events));
   const send=()=>{if(generation!==this.playbackGeneration||source!==this.source)return;const buffers=[...routed.values()].map(v=>v.buffer);source.port.postMessage({cmd:'add',epoch,frames,stems:[...routed]},buffers);};
   if(this.graphs.some(g=>g.sampler)&&frames){this.renderChain=this.renderChain.catch(()=>{}).then(async()=>{if(generation!==this.playbackGeneration)return;await Promise.all(this.graphs.map(async(g,i)=>{const sampler=g.sampler;if(!sampler)return;const events=packet.events.filter(e=>e.track===i);const raw=await platform.nativeFx!.sfzRender(sampler.id,frames,this.context!.sampleRate,events);routed.set(i,new Float32Array(raw.buffer,raw.byteOffset,raw.byteLength/4));}));send();}).catch(e=>{if(generation!==this.playbackGeneration||source!==this.source)return;output.pause();this.onError(`SFZ再生に失敗しました：${e.message}`);});}else send();
  };
 }
 private graph():Graph{const c=this.context!,input=c.createGain(),gain=c.createGain(),pan=c.createStereoPanner(),send=c.createGain(),meter=c.createAnalyser();meter.fftSize=256;pan.connect(gain);gain.connect(meter);meter.connect(this.musicBus!);gain.connect(send);send.connect(this.reverbInput!);return {input,gain,pan,send,meter,nodes:[],native:new Map(),pending:new Map()};}
 setScore(score:at.model.Score){this.score=score;this.mapping.clear();score.tracks.forEach((t,i)=>{this.mapping.set(-i-1,i);this.mapping.set(t.playbackInfo.primaryChannel,i);this.mapping.set(t.playbackInfo.secondaryChannel,i);});this.sendRouting();}
 prepare(score:at.model.Score){const work=()=>this.prepareNow(score);this.operation=this.operation.catch(()=>{}).then(work);return this.operation;}
 /** Queue the old document's state capture before any graph can be reused by another document. */
 releaseForDocumentSwitch(){const oldScore=this.score;this.releasePending++;this.operation=this.operation.catch(()=>{}).then(async()=>{
  try{if(oldScore)await this.captureExternalStates(oldScore);}finally{
   const obsolete=this.graphs.splice(0);
   try{await Promise.all(obsolete.map(graph=>this.dispose(graph)));}finally{this.releasePending--;}
  }
 });return this.operation;}
 private async prepareNow(score:at.model.Score){
  this.setScore(score);if(!this.context)return;
  await this.module;
  while(this.graphs.length>score.tracks.length)await this.dispose(this.graphs.pop()!);
  while(this.graphs.length<score.tracks.length)this.graphs.push(this.graph());
  for(let i=0;i<this.graphs.length;i++){const p=trackAudio(score.tracks[i]),g=this.graphs[i],oldSound=p.sound.path,busy=p.nam.enabled&&(g.namKey!==(p.nam.modelJson??p.nam.model)||!g.sampler&&score.tracks[i].staves.some(st=>st.tuning.length>0));if(busy){this.loading.add(i);this.onStatusChange();}try{await this.configure(g,p);}finally{this.loading.delete(i);if(busy||oldSound!==p.sound.path)this.onStatusChange();}}if(this.graphs.some(g=>g.sampler))this.useRelay();this.sync();
 }
 private async dispose(g:Graph){g.input.disconnect();g.pan.disconnect();g.gain.disconnect();g.meter.disconnect();g.send.disconnect();for(const node of g.nodes){node.disconnect();if(node instanceof AudioWorkletNode){node.port.postMessage({destroy:true});node.port.close();}}const closing=[...g.native.values()].map(instance=>platform.nativeFx?.close(instance.id));g.native.clear();if(g.sampler)closing.push(platform.nativeFx?.close(g.sampler.id));g.sampler=undefined;if(g.nam){g.nam.port.postMessage({type:'destroy',requestId:++this.request});g.nam.disconnect();g.nam.port.close();g.nam=undefined;}for(const r of g.pending.values())r.reject(new Error('音声設定を更新しました。'));g.pending.clear();await Promise.allSettled(closing);}
 // A sound change may close a sampler while its reset is queued; that reset has nothing left to do.
 private resetSamplers(){this.renderChain=this.renderChain.catch(()=>{}).then(async()=>{for(const g of this.graphs)if(g.sampler)await platform.nativeFx?.sfzReset(g.sampler.id).catch(()=>{});});}
 private async namRequest(g:Graph,value:any){const requestId=++this.request;return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{g.pending.delete(requestId);reject(new Error('NAMの応答がタイムアウトしました。'));},30000);g.pending.set(requestId,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});g.nam!.port.postMessage({...value,requestId});});}
 private async ensureNam(g:Graph,p:TrackAudio){
  const c=this.context!;
  this.namLoading??=Promise.all([c.audioWorklet.addModule(new URL('../nam/nam-worklet.js',document.baseURI).href),fetch(new URL('../nam/nam-engine.wasm',document.baseURI)).then(r=>r.arrayBuffer())]).then(([,bytes])=>{this.namBytes=bytes;});await this.namLoading;
  if(!g.nam){g.nam=new AudioWorkletNode(c,'nam-processor',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:'explicit'});g.nam.port.onmessage=({data:d})=>{const request=g.pending.get(d.requestId);if(!request)return;g.pending.delete(d.requestId);d.ok?request.resolve(d.modelInfo):request.reject(new Error(d.error));};await this.namRequest(g,{type:'init',wasmBytes:this.namBytes});}
  const key=p.nam.modelJson??p.nam.model;
  if(g.namKey!==key){const json=p.nam.modelJson??(p.nam.model==='deluxe-a2'?await (await fetch(new URL('../nam/deluxe-a2.nam',document.baseURI))).text():await platform.nativeFx!.namModel(p.nam.model));await this.namRequest(g,{type:'load-model',json,slimSize:0});g.namKey=key;g.namNorm=namOutputLevel(p.nam);}
 }
 private async configure(g:Graph,p:TrackAudio){
  const index=this.graphs.indexOf(g);
  const listedLanes=this.requiredLanes.get(index),neededLanes=listedLanes?.length?listedLanes:[1],neededPitches=this.requiredPitches.get(index)??{};
  // NAM amplifies the DI of its amp type (Guitar DI / Bass DI), whatever sound the track had;
  // so do GM guitars and basses with insert FX.
  const di=diKind(this.score!.tracks[index],p);
  if(platform.nativeFx&&di){
   this.sfzLibrary??=platform.nativeFx.sfzLibrary().catch(e=>{this.sfzLibrary=undefined;throw e;});const library=await this.sfzLibrary;
   const standard=diSound(di,library,p.sound);if(standard&&(p.sound.kind!=='sfz'||p.sound.path!==standard.path))p.sound={kind:'sfz',...standard};
   else if(!standard&&p.nam.enabled)this.onError(di==='bass'?'ベースのNAMにはBass DI（Fashionbass）の音源が必要ですが、見つかりません。scripts/install-fashionbass.py で登録してください。':'NAMにはStandard Guitar（Guitar DI）の音源が必要ですが、見つかりません。「SFZ音源を読み込む…」で01-Standard Guitar KSOP.sfzを選んでください。');
  }
  const c=this.context!,maxNative=Math.max(0,...(this.score?.tracks.map(t=>trackAudio(t).fx.filter(f=>f.kind==='external').length)??[]));
  const signature=JSON.stringify({sound:p.sound,nam:{enabled:p.nam.enabled},fx:p.fx.map(({state,...settings})=>settings.kind==='external'?{...settings,enabled:undefined}:settings),maxNative});
  // External FX stay loaded while bypassed; ON/OFF only switches the worklet between wet and delayed dry.
  const applyBypass=()=>{for(const fx of p.fx)if(fx.kind==='external')g.fxNodes?.get(fx.id)?.port.postMessage({bypass:!fx.enabled});};
  const updateNam=()=>{const controls=g.namControls;if(!controls)return;for(const key of ['input','output']as const)controls[key].gain.setTargetAtTime(10**((p.nam[key]+(key==='input'?NAM_INPUT_TRIM:NAM_OUTPUT_TRIM+(g.namNorm??0)))/20),c.currentTime,.01);for(const key of ['bass','mid','treble']as const)controls[key].gain.setTargetAtTime(p.nam[key],c.currentTime,.01);controls.cabinetHigh.frequency.setTargetAtTime(p.nam.cabinet?70:0,c.currentTime,.01);controls.cabinetLow.frequency.setTargetAtTime(p.nam.cabinet?6500:c.sampleRate/2,c.currentTime,.01);};
  const currentSampler=g.sampler;if(currentSampler&&currentSampler.path===p.sound.path){const obsolete=currentSampler.lanes.some(lane=>!neededLanes.includes(lane));if(obsolete){await platform.nativeFx!.close(currentSampler.id);g.sampler={...await platform.nativeFx!.sfzLoad(currentSampler.path,neededLanes,neededPitches),path:currentSampler.path,lanes:[...neededLanes],pitches:neededPitches};}else{const missing=neededLanes.filter(lane=>!currentSampler.lanes.includes(lane));if(missing.length||JSON.stringify(currentSampler.pitches)!==JSON.stringify(neededPitches)){await platform.nativeFx!.sfzPrepare(currentSampler.id,neededLanes,neededPitches);currentSampler.lanes=[...neededLanes];currentSampler.pitches=neededPitches;}}}
  const stateChanged=p.fx.some(f=>f.kind==='external'&&(!g.native.has(f.id)||g.native.get(f.id)!.state!==f.state));
  if(signature===g.signature&&!stateChanged){if(p.nam.enabled)await this.ensureNam(g,p);updateNam();applyBypass();return;}

  if(p.nam.enabled)await this.ensureNam(g,p);
  else if(g.nam){await this.namRequest(g,{type:'destroy'});g.nam.disconnect();g.nam.port.close();g.nam=undefined;g.namKey=undefined;}
  // Builds without an SFZ host (Tauri for now) play SFZ tracks with the GM sound; the saved setting stays SFZ.
  if(p.sound.kind==='sfz'&&platform.nativeFx?.features?.sfz!==false){if(!platform.nativeFx||!p.sound.path)throw new Error('SFZ音源が見つかりません。');if(g.sampler?.path!==p.sound.path){if(g.sampler)await platform.nativeFx.close(g.sampler.id);g.sampler={...await platform.nativeFx.sfzLoad(p.sound.path,neededLanes,neededPitches),path:p.sound.path,lanes:[...neededLanes],pitches:neededPitches};}}else if(g.sampler){await platform.nativeFx?.close(g.sampler.id);g.sampler=undefined;}
  for(const fx of p.fx.filter(f=>f.kind==='external')){if(!platform.nativeFx||!fx.path)throw new Error('外部FXホストが利用できません。');const old=g.native.get(fx.id);if(!old||old.path!==fx.path||old.state!==fx.state){if(old)await platform.nativeFx.close(old.id);const instance=await platform.nativeFx.load(fx.path,fx.state);g.native.set(fx.id,{...instance,path:fx.path,state:fx.state});}}
  for(const [key,v]of g.native)if(!p.fx.some(f=>f.id===key&&f.kind==='external')){await platform.nativeFx?.close(v.id);g.native.delete(key);}
  g.input.disconnect();g.nam?.disconnect();for(const n of g.nodes){n.disconnect();if(n instanceof AudioWorkletNode){n.port.postMessage({destroy:true});n.port.close();}}g.nodes=[];g.namControls=undefined;g.fxNodes=new Map();
  let tail:AudioNode=g.input;
  const append=(node:AudioNode)=>{tail.connect(node);tail=node;g.nodes.push(node);};
  if(p.nam.enabled){const input=c.createGain();input.gain.value=10**((p.nam.input+NAM_INPUT_TRIM)/20);append(input);tail.connect(g.nam!);tail=g.nam!;
   const eqs:BiquadFilterNode[]=[];for(const [type,freq,value]of [['lowshelf',150,p.nam.bass],['peaking',800,p.nam.mid],['highshelf',3500,p.nam.treble]]as const){const eq=c.createBiquadFilter();eq.type=type;eq.frequency.value=freq;eq.gain.value=value;append(eq);eqs.push(eq);}
   const high=c.createBiquadFilter();high.type='highpass';high.frequency.value=p.nam.cabinet?70:0;append(high);const low=c.createBiquadFilter();low.type='lowpass';low.frequency.value=p.nam.cabinet?6500:c.sampleRate/2;append(low);
   const output=c.createGain();output.gain.value=10**((p.nam.output+NAM_OUTPUT_TRIM+(g.namNorm??0))/20);append(output);g.namControls={input,output,bass:eqs[0],mid:eqs[1],treble:eqs[2],cabinetHigh:high,cabinetLow:low};
  }
  for(const fx of p.fx.filter(f=>f.enabled||f.kind==='external')){
   if(fx.kind==='external'){await this.loadNativeModule();const instance=g.native.get(fx.id)!;const node=new AudioWorkletNode(c,'studio-native-fx',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});let failed=false;node.port.onmessage=async({data:d})=>{if(!g.nodes.includes(node))return;try{const raw=await platform.nativeFx!.process(instance.id,new Uint8Array(d.pcm.buffer),c.sampleRate);if(!g.nodes.includes(node))return;const pcm=new Float32Array(raw.buffer,raw.byteOffset,raw.byteLength/4);node.port.postMessage({epoch:d.epoch,start:d.start,pcm},[pcm.buffer]);}catch(e){if(!g.nodes.includes(node))return;const reason=e instanceof Error?e.message:String(e);if(/処理が追いつきません|応答がタイムアウト/.test(reason))return;node.port.postMessage({epoch:d.epoch,error:true});if(!failed){failed=true;this.onError(`${fx.name}：${reason}`);}}};g.fxNodes!.set(fx.id,node);append(node);}
   if(fx.kind==='eq'){const eq=c.createBiquadFilter();eq.type='peaking';eq.frequency.value=1200;eq.gain.value=(fx.amount-.5)*24;append(eq);}
   if(fx.kind==='compressor'){const compressor=c.createDynamicsCompressor();compressor.threshold.value=-10-30*fx.amount;compressor.ratio.value=2+6*fx.amount;append(compressor);}
   if(fx.kind==='delay'){const dry=c.createGain(),delay=c.createDelay(2),feedback=c.createGain(),wet=c.createGain(),mix=c.createGain();delay.delayTime.value=.3;feedback.gain.value=.3;wet.gain.value=fx.amount;tail.connect(dry);tail.connect(delay);dry.connect(mix);delay.connect(feedback);feedback.connect(delay);delay.connect(wet);wet.connect(mix);g.nodes.push(dry,delay,feedback,wet,mix);tail=mix;}
  }
  const nativeCount=p.fx.filter(f=>f.kind==='external').length,delay=c.createDelay(5);delay.delayTime.value=(maxNative-nativeCount)*8192/c.sampleRate;append(delay);tail.connect(g.pan);if(this.clickDelay)this.clickDelay.delayTime.value=maxNative*8192/c.sampleRate;g.signature=signature;applyBypass();
 }
 private previewUntil=0;
 private nativeModule?:Promise<void>;
 private loadNativeModule(){return this.nativeModule??=this.context!.audioWorklet.addModule(new URL('../native-fx.js',document.baseURI).href);}
 async update(_index:number){if(this.score)await this.prepare(this.score);}
 async openEditor(index:number,fxId:string){
  const score=this.score;if(!score)return;
  await this.prepare(score);
  const g=this.graphs[index],fx=trackAudio(score.tracks[index]).fx.find(f=>f.id===fxId),instance=g?.native.get(fxId);
  if(!fx||!instance)throw new Error('FXを読み込めませんでした。');
  // Resolves when the editor is hidden again. The plugin keeps running, so its
  // state is only recorded for saving; it is never reloaded here.
  const result=await platform.nativeFx!.editor(instance.id);
  if(g.native.get(fxId)===instance)fx.state=instance.state=result.state;
 }
 async captureExternalStates(target=this.score){if(!target)return;for(let i=0;i<this.graphs.length;i++)for(const [key,instance]of this.graphs[i].native){const t=target.tracks[i];if(!t)continue;const fx=trackAudio(t).fx.find(f=>f.id===key);if(fx)fx.state=instance.state=(await platform.nativeFx!.state(instance.id)).state;}}
 async previewSfz(index:number,pitch:number,note?:at.model.Note,scoreJson?:string){
  const sampler=this.graphs[index]?.sampler;if(!sampler||!platform.nativeFx)return;
  const render=async()=>{
   const file=new at.midi.MidiFile(),handler=new at.midi.AlphaSynthMidiFileHandler(file),settings=new at.Settings();
   if(scoreJson){const score=at.model.JsonConverter.jsonToScore(scoreJson,settings);const generator=new at.midi.MidiFileGenerator(score,settings,handler);generator.applyTranspositionPitches=true;generator.generate();}
   else if(note){const beat=note.beat.playbackDuration>0?note.beat:Object.assign(new at.model.Beat(),note.beat,{playbackDuration:960*4/note.beat.duration*(2-2**(-note.beat.dots))});const isolated=Object.assign(new at.model.Note(),note,{beat,isTieDestination:false,slideOrigin:null});const generator=new at.midi.MidiFileGenerator(beat.voice.bar.staff.track.score,settings,handler);generator.applyTranspositionPitches=true;generator.generateSingleNote(isolated);}
   else {handler.addTempo(0,120);handler.addNote(0,0,480,pitch,100,0);}
   const map=articulationMap(file),events=file.tracks.flatMap(t=>t.events).sort((a,b)=>a.tick-b.tick);
   let tempo=120,tick=0,seconds=0;const timed:any[]=[];
   for(const e of events){seconds+=(e.tick-tick)/960*60/tempo;tick=e.tick;if(e instanceof at.midi.TempoChangeEvent){tempo=e.beatsPerMinute;continue;}if(e instanceof at.midi.ControlChangeEvent&&(e.controller===7||e.controller===10))e.value=e.controller===7?127:63;if([128,144,96,176,224].includes(e.type))timed.push({...e,...map.get(eventKey(e))?.[0],sample:Math.round(seconds*this.context!.sampleRate)});}
   const pitches:Record<string,number[]>={...sampler.pitches};let expanded=false;
   for(const event of timed)if(event.type===128){const lane=String(event.lane??note?.string??1),keys=pitches[lane]??[];if(!keys.includes(event.noteKey)){pitches[lane]=[...keys,event.noteKey].sort((a,b)=>a-b);expanded=true;}}
   if(expanded){const lanes=[...new Set([...sampler.lanes,...Object.keys(pitches).map(Number)])].sort((a,b)=>a-b);await platform.nativeFx!.sfzPrepare(sampler.id,lanes,pitches);sampler.lanes=lanes;sampler.pitches=pitches;}
   const frames=Math.ceil(Math.min(scoreJson?2.5:1,Math.max(.35,seconds+.15))*this.context!.sampleRate),pcm=new Float32Array(frames*2);
   await platform.nativeFx!.sfzReset(sampler.id);
   for(let start=0;start<frames;start+=2048){const count=Math.min(2048,frames-start),block=timed.filter(e=>e.sample>=start&&e.sample<start+count).map(e=>({...e,delay:e.sample-start}));const raw=await platform.nativeFx!.sfzRender(sampler.id,count,this.context!.sampleRate,block);pcm.set(new Float32Array(raw.buffer,raw.byteOffset,raw.byteLength/4),start*2);}
   await platform.nativeFx!.sfzReset(sampler.id);return pcm;
  };
  const result=this.renderChain.catch(()=>{}).then(render);this.renderChain=result.then(()=>{});return result;
 }

 sync(){if(!this.context||!this.score)return;const c=this.context,master=masterAudio(this.score),solo=this.score.tracks.some(t=>t.playbackInfo.isSolo);this.master?.gain.setTargetAtTime(master.mute?0:master.volume,c.currentTime,.01);this.reverbInput?.gain.setTargetAtTime(master.reverb?1:0,c.currentTime,.01);
  // Headroom for every track that can sound, not just the soloed/unmuted ones: solo and mute
  // must not change how loud the remaining tracks are (a soloed bass keeps its mix level).
  const audible=this.score.tracks.filter(t=>t.playbackInfo.volume>0).length;
  this.musicBus?.gain.setTargetAtTime(1/Math.sqrt(Math.max(1,audible)),c.currentTime,.03);
  this.graphs.forEach((g,i)=>{const t=this.score!.tracks[i];if(!t)return;const p=trackAudio(t);const muted=t.playbackInfo.isMute||solo&&!t.playbackInfo.isSolo;g.input.gain.setTargetAtTime(muted?0:1,c.currentTime,.01);g.gain.gain.setTargetAtTime(muted?0:t.playbackInfo.volume/8,c.currentTime,.01);g.pan.pan.setTargetAtTime((t.playbackInfo.balance-8)/8,c.currentTime,.01);g.send.gain.setTargetAtTime(p.reverb?p.send:0,c.currentTime,.01);});
 }
 clickDestination(){return this.click??this.context?.destination;}
 destination(index:number){this.previewUntil=(this.context?.currentTime??0)+2;return this.graphs[index]?.input??this.context?.destination;}
 peaks(){const peak=(meter?:AnalyserNode)=>{if(!meter)return 0;let pcm=this.meterBuffers.get(meter);if(!pcm){pcm=new Float32Array(meter.fftSize);this.meterBuffers.set(meter,pcm);}meter.getFloatTimeDomainData(pcm);let value=0;for(let i=0;i<pcm.length;i++)value=Math.max(value,Math.abs(pcm[i]));return value;};const active=!!this.source||(this.context?.currentTime??0)<this.previewUntil;return {click:active?peak(this.clickMeter):0,tracks:this.graphs.map(g=>active&&g.gain.gain.value>0?peak(g.meter):0),master:active&&(this.master?.gain.value??0)>0?peak(this.masterMeter):0};}
}
