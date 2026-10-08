import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {FxHost}=createRequire(import.meta.url)('../electron/fx-host.cjs');
test('concurrent editor requests share one window and can reopen after close or failure',async()=>{
 const host=new FxHost('unused');let calls=0,resolve:(v:any)=>void=()=>{},reject:(e:Error)=>void=()=>{};
 host.instances.set('1',{ask:()=>{calls++;return new Promise((yes,no)=>{resolve=yes;reject=no;});}});
 const first=host.command('1','editor'),second=host.command('1','editor');assert.equal(calls,1);resolve({state:'saved'});assert.deepEqual(await first,await second);
 const failure=host.command('1','editor');assert.equal(calls,2);reject(new Error('failed'));await assert.rejects(failure,/failed/);
 const retry=host.command('1','editor');assert.equal(calls,3);resolve({state:'retry'});assert.deepEqual(await retry,{state:'retry'});
});
