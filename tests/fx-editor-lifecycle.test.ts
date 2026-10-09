import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {FxHost}=createRequire(import.meta.url)('../electron/fx-host.cjs');
test('every editor request reaches the host so a hidden editor can be shown again',async()=>{
 const host=new FxHost('unused'),asked:{cmd:string;timeout:number;resolve:(v:any)=>void;reject:(e:Error)=>void}[]=[];
 host.instances.set('1',{ask:(cmd:string,_args:unknown,timeout:number)=>new Promise((resolve,reject)=>{asked.push({cmd,timeout,resolve,reject});})});
 const first=host.command('1','editor'),second=host.command('1','editor');
 assert.deepEqual(asked.map(a=>[a.cmd,a.timeout]),[['editor',0],['editor',0]]);
 // The host answers every waiting request with the state captured when the window is hidden.
 for(const a of asked)a.resolve({state:'saved'});
 assert.deepEqual(await first,{state:'saved'});assert.deepEqual(await second,{state:'saved'});
 const failure=host.command('1','editor');asked[2].reject(new Error('failed'));await assert.rejects(failure,/failed/);
 const retry=host.command('1','editor');asked[3].resolve({state:'retry'});assert.deepEqual(await retry,{state:'retry'});
});
