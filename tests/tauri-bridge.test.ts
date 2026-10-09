import test from 'node:test';
import assert from 'node:assert/strict';
import {joinFrame,splitFrame} from '../src/platform/frame';
import {installTauriBridge,send,CHUNK} from '../src/platform/tauri';

type Call={cmd:string;args:unknown};
function fakeTauri(reply:(call:Call)=>unknown){
 const calls:Call[]=[];
 const target={__TAURI_INTERNALS__:{invoke:async(cmd:string,args:unknown)=>{const call={cmd,args};calls.push(call);return reply(call);}}} as unknown as Window;
 (globalThis as {window?:unknown}).window=target;
 return {target,calls};
}
const copy=(bytes:Uint8Array)=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;

test('frames carry a JSON header and raw bytes both ways', ()=>{
 const framed=joinFrame({name:'曲.tg',n:1},[new Uint8Array([80,75]),new Uint8Array([3])]);
 const {header,bytes}=splitFrame<{name:string}>(copy(framed));
 assert.equal(header.name,'曲.tg');assert.deepEqual([...bytes],[80,75,3]);
 assert.equal(splitFrame(copy(joinFrame(null))).header,null);
});

test('the bridge is installed only inside Tauri and never replaces Electron', ()=>{
 const plain={} as Window;installTauriBridge(plain);assert.equal(plain.desktop,undefined);
 const electron={__TAURI_INTERNALS__:{},desktop:{marker:true}} as unknown as Window;installTauriBridge(electron);
 assert.deepEqual(electron.desktop,{marker:true});assert.equal(electron.nativeFx,undefined);
 const {target}=fakeTauri(()=>null);installTauriBridge(target);
 assert.ok(target.desktop);assert.deepEqual(target.nativeFx?.features,{sfz:true,externalFx:false});
});

test('files arrive as bytes and saves send the score as a raw body', async()=>{
 const {target,calls}=fakeTauri(({cmd})=>{
  if(cmd==='open_score')return copy(joinFrame({name:'a.tg',path:'C:\\a.tg',openToken:'1'},[new Uint8Array([80,75,9])]));
  if(cmd==='last_score')return copy(joinFrame(null));
  if(cmd==='save_score')return {name:'a.tg',path:'C:\\a.tg'};
  return undefined;
 });
 installTauriBridge(target);const desktop=target.desktop!;
 const opened=await desktop.openScore();
 assert.equal(opened?.openToken,'1');assert.ok(opened?.bytes instanceof Uint8Array);assert.deepEqual([...opened!.bytes],[80,75,9]);
 assert.equal(await desktop.lastScore(),null);
 assert.deepEqual(await desktop.saveScore({name:'a',bytes:new Uint8Array([80,75]),path:''}),{name:'a.tg',path:'C:\\a.tg'});
 const sent=calls.find(c=>c.cmd==='save_score')!.args as Uint8Array;assert.ok(sent instanceof Uint8Array);
 const {header,bytes}=splitFrame<{hasPath:boolean;path:string;saveAs:boolean}>(copy(sent));
 assert.deepEqual(header,{name:'a',saveAs:false,hasPath:true,path:''});assert.deepEqual([...bytes],[80,75]);
 await desktop.activateDocument('');assert.deepEqual(calls.at(-1),{cmd:'activate_document',args:{path:null}});
});

test('recovery documents are packed back to back after the header', async()=>{
 const {target,calls}=fakeTauri(()=>undefined);installTauriBridge(target);
 await target.desktop!.writeRecoveryDocuments!({manifest:'{}',files:[{id:4,bytes:new Uint8Array([1,2])},{id:5,bytes:new Uint8Array([3])}],remove:[2]});
 const {header,bytes}=splitFrame(copy(calls[0].args as Uint8Array));
 assert.deepEqual(header,{manifest:'{}',files:[{id:4,length:2},{id:5,length:1}],remove:[2]});assert.deepEqual([...bytes],[1,2,3]);
});

test('large bodies are sent in pieces and named by upload id', async()=>{
 const received:number[]=[];
 const {calls}=fakeTauri(({cmd,args})=>{if(cmd==='upload_chunk'){const {header,bytes}=splitFrame<{id:number|null}>(copy(args as Uint8Array));received.push(bytes.byteLength);return header.id??7;}return 'done';});
 const body=new Uint8Array(CHUNK*2+5);body[CHUNK*2+4]=9;
 assert.equal(await send('save_score',body),'done');
 assert.deepEqual(received,[CHUNK,CHUNK,5]);
 assert.deepEqual(calls.slice(0,3).map(c=>splitFrame<{id:number|null}>(copy(c.args as Uint8Array)).header.id),[null,7,7]);
 const last=calls.at(-1)!;assert.equal(last.cmd,'save_score');assert.deepEqual(splitFrame(copy(last.args as Uint8Array)).header,{upload:7});
 assert.equal(await send('save_score',new Uint8Array(3)),'done');assert.equal(calls.at(-1)!.args instanceof Uint8Array,true);
});

test('SFZ calls reach the Rust sampler and rendered audio arrives as bytes; external FX stay unavailable', async()=>{
 const pcm=new Float32Array([0.5,-0.5]);
 const {target,calls}=fakeTauri(({cmd})=>{
  if(cmd==='sfz_library')return [{name:'Guitar DI',path:'C:/g.sfz'}];
  if(cmd==='sfz_load')return {id:'1',name:'g'};
  if(cmd==='sfz_render')return pcm.buffer.slice(0);
  return undefined;
 });
 installTauriBridge(target);const fx=target.nativeFx!;
 assert.deepEqual(await fx.sfzLibrary(),[{name:'Guitar DI',path:'C:/g.sfz'}]);
 assert.deepEqual(await fx.sfzLoad('C:/g.sfz',[1,2]),{id:'1',name:'g'});
 assert.deepEqual(calls.at(-1),{cmd:'sfz_load',args:{path:'C:/g.sfz',lanes:[1,2],pitches:{}}});
 const out=await fx.sfzRender('1',1,48000,[{type:128,noteKey:40}]);
 assert.ok(out instanceof Uint8Array);assert.deepEqual([...new Float32Array(out.buffer)],[0.5,-0.5]);
 await fx.close('1');assert.deepEqual(calls.at(-1),{cmd:'fx_close',args:{id:'1'}});
 assert.deepEqual(await fx.scan(),[]);
 await assert.rejects(fx.load('x.vst3'),/外部FXはこの版ではまだ使えません/);
 delete (globalThis as {window?:unknown}).window;
});
