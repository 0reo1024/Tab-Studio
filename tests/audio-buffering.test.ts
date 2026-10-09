import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function processor(file:string){let registered:any;const messages:any[]=[];class Base{port={onmessage:null as any,postMessage:(d:any)=>messages.push(d)};}vm.runInNewContext(readFileSync(new URL('../public/'+file,import.meta.url),'utf8'),{AudioWorkletProcessor:Base,sampleRate:48000,Float32Array,Map,registerProcessor:(_:string,c:any)=>registered=c});return {node:new registered(),messages};}
test('external FX retains a stable delay and audible output when IPC responses miss deadlines',()=>{
 const {node,messages}=processor('native-fx.js'),pending:any[]=[];const pcm=new Float32Array(128).fill(.25),output=[new Float32Array(128),new Float32Array(128)];let first=-1,min=1;
 for(let block=0;block<220;block++){
  for(let i=pending.length-1;i>=0;i--)if(pending[i].ready<=node.frame){node.port.onmessage({data:pending[i].data});pending.splice(i,1);}
  node.process([[pcm,pcm]],[output]);
  for(let j=0;j<128;j++){const position=block*128+j;if(output[0][j]>0&&first<0)first=position;if(position>=8192)min=Math.min(min,output[0][j]);}
  for(const d of messages.splice(0)){assert.equal(d.start,node.frame-2048+8192);pending.push({ready:node.frame+(block<90?10000:1024),data:{...d,pcm:new Float32Array(4096).fill(.5)}});}
 }
 assert.equal(first,8192);assert.ok(min>=.249);assert.ok(output[0][127]>.49,'wet FX recovers without shifting its timeline');
});
test('output requests bounded lookahead and resets outstanding requests without deadlocking',()=>{
 const {node,messages}=processor('mixer-output.js'),out=[[new Float32Array(128),new Float32Array(128)]];
 node.process([],out);assert.equal(messages.filter(d=>d.cmd==='request').length,32);
 const add=()=>node.port.onmessage({data:{cmd:'add',frames:2048,stems:[[0,new Float32Array(4096).fill(.5)]]}});
 for(let i=0;i<15;i++)add();node.process([],out);assert.equal(out[0][0][0],0);add();node.process([],out);assert.equal(out[0][0][0],.5);
 node.port.onmessage({data:{cmd:'reset'}});messages.length=0;out[0].forEach(c=>c.fill(0));node.process([],out);assert.equal(messages.filter(d=>d.cmd==='request').length,32);assert.equal(node.played,0);
});
test('a short phrase drains below the startup threshold and reports its final partial block',()=>{
 const {node,messages}=processor('mixer-output.js'),out=[[new Float32Array(128),new Float32Array(128)]];
 node.port.onmessage({data:{cmd:'add',frames:512,stems:[[0,new Float32Array(1024).fill(.5)]]}});
 node.process([],out);assert.equal(out[0][0][0],0);
 node.port.onmessage({data:{cmd:'add',frames:0,stems:[]}});messages.length=0;
 for(let i=0;i<4;i++)node.process([],out);
 assert.equal(messages.filter(d=>d.cmd==='played').reduce((n,d)=>n+d.frames,0),512);assert.equal(out[0][0][0],.5);assert.equal(node.queued,0);assert.equal(messages.filter(d=>d.cmd==='request').length,0);
});
test('seek epochs reject stale audio and keep clock notifications on the current timeline',()=>{
 const {node,messages}=processor('mixer-output.js'),out=[[new Float32Array(128),new Float32Array(128)]];
 node.port.onmessage({data:{cmd:'reset',epoch:7}});
 node.port.onmessage({data:{cmd:'add',epoch:0,frames:512,stems:[[0,new Float32Array(1024).fill(.9)]]}});
 node.port.onmessage({data:{cmd:'add',epoch:0,frames:0}});assert.equal(node.queued,0);assert.equal(node.ended,false);
 node.port.onmessage({data:{cmd:'add',epoch:7,frames:512,stems:[[0,new Float32Array(1024).fill(.5)]]}});node.port.onmessage({data:{cmd:'add',epoch:7,frames:0}});
 for(let i=0;i<4;i++)node.process([],out);
 assert.ok(messages.every(d=>d.epoch===7));assert.equal(messages.find(d=>d.cmd==='played').frames,512);assert.equal(out[0][0][0],.5);
});

test('output lookahead absorbs a half-second sampler handoff stall without a silent gap',()=>{
 const {node,messages}=processor('mixer-output.js'),out=[[new Float32Array(128),new Float32Array(128)]],requests:number[]=[];let started=false;
 for(let block=0;block<850;block++){
  const frame=block*128;
  while(requests.length&&!(frame>=32768&&frame<56768)){
   requests.shift();node.port.onmessage({data:{cmd:'add',frames:2048,stems:[[0,new Float32Array(4096).fill(.5)]]}});
  }
  out[0].forEach(c=>c.fill(0));node.process([],out);
  if(out[0][0][0]>.1)started=true;
  if(started)assert.equal(out[0][0][0],.5,`silent handoff at frame ${frame}`);
  for(const d of messages.splice(0))if(d.cmd==='request')requests.push(frame);
 }
 assert.ok(started);
});
test('direct worker route sums channels per track, renders the click and talks to the worker port',()=>{
 const {node,messages}=processor('mixer-output.js'),worker:any[]=[],port={onmessage:null as any,postMessage:(d:any)=>worker.push(d),close(){}};
 node.port.onmessage({data:{cmd:'direct',port}});
 // Track 0 owns channels 0 and 1; channel 9 (metronome) falls back to the click output (2).
 node.port.onmessage({data:{cmd:'routing',map:[[0,0],[1,0],[2,1]],clickIndex:2,click:{on:true,kind:'wood',volume:1}}});
 const outputs=()=>[0,1,2].map(()=>[new Float32Array(128),new Float32Array(128)]);
 let out=outputs();node.process([],out);
 assert.ok(worker.filter(d=>d.cmd==='request').length>0,'requests go to the worker port');assert.equal(messages.filter(d=>d.cmd==='request').length,0,'not through the main thread');
 const frames=40000,stem=(v:number)=>new Float32Array(frames*2).fill(v);
 port.onmessage({data:{cmd:'add',frames,stems:[[0,stem(.25)],[1,stem(.5)],[2,stem(.125)],[9,stem(.9)]],midi:[{isMetronome:true,metronomeNumerator:0,delay:64}]}});
 out=outputs();node.process([],out);
 assert.equal(out[0][0][0],.75);assert.equal(out[1][1][5],.125);
 assert.equal(out[2][0][10],0,'click starts at its packet offset; the synth metronome stem is replaced');assert.ok(Math.abs(out[2][0][80])>0);assert.equal(out[2][0][80],out[2][1][80]);
 for(let i=0;i<10;i++)node.process([],outputs());assert.ok(worker.some(d=>d.cmd==='played'),'played counts feed the worker clock');
 port.onmessage({data:{cmd:'reset'}});out=outputs();node.process([],out);assert.equal(out[0][0][0],0,'reset from the worker drops queued audio');
 // Standard click keeps the synthesized metronome channel.
 node.port.onmessage({data:{cmd:'routing',map:[[0,0]],clickIndex:2,click:{on:true,kind:'standard',volume:1}}});
 port.onmessage({data:{cmd:'add',frames,stems:[[9,stem(.3)]],midi:[]}});out=outputs();node.process([],out);assert.ok(Math.abs(out[2][0][0]-.3)<1e-6);
 // Switching back to the relayed route sends requests through the main thread again.
 node.port.onmessage({data:{cmd:'relay'}});messages.length=0;port.onmessage({data:{cmd:'reset'}});node.port.onmessage({data:{cmd:'reset',epoch:3}});node.process([],outputs());assert.ok(messages.some(d=>d.cmd==='request'&&d.epoch===3));
});
