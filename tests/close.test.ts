import test from 'node:test';
import assert from 'node:assert/strict';
import { saveAndClose } from '../src/close-flow';
test('close waits for the write to finish before authorizing window destruction',async()=>{
 const events:string[]=[];let resolve!:(v:boolean)=>void;
 const saving=saveAndClose(()=>new Promise<boolean>(r=>{resolve=r;events.push('saving');}),()=>events.push('closed'));
 assert.deepEqual(events,['saving']);resolve(true);assert.equal(await saving,true);assert.deepEqual(events,['saving','closed']);
});
test('save cancellation and disk failure both keep the window open',async()=>{
 let closed=0;assert.equal(await saveAndClose(async()=>false,()=>closed++),false);
 assert.equal(await saveAndClose(async()=>{throw new Error('disk full');},()=>closed++),false);assert.equal(closed,0);
});
