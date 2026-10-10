import test from 'node:test';
import assert from 'node:assert/strict';
import {createFretDrawScheduler,mergeRenderRequests} from '../src/app/render-scheduler';

test('render requests queued during a render merge to the widest one', ()=>{
 assert.deepEqual(mergeRenderRequests(null,{background:true,reuseViewport:true,firstChangedMasterBar:5}),{background:true,reuseViewport:true,firstChangedMasterBar:5});
 assert.deepEqual(mergeRenderRequests({background:true,reuseViewport:true,firstChangedMasterBar:5},{background:false,reuseViewport:true,firstChangedMasterBar:2}),{background:false,reuseViewport:true,firstChangedMasterBar:2});
 assert.equal(mergeRenderRequests({background:true,reuseViewport:false,firstChangedMasterBar:5},{background:true,reuseViewport:true,firstChangedMasterBar:9}).reuseViewport,false);
 assert.equal(mergeRenderRequests({background:true,reuseViewport:true},{background:true,reuseViewport:true,firstChangedMasterBar:9}).firstChangedMasterBar,undefined,'a full render stays full');
});

test('fret redraws wait for typing to pause, start three bars early and retry while busy', async()=>{
 const drawn:number[]=[];let busy=false;
 const s=createFretDrawScheduler(bar=>drawn.push(bar),()=>busy,20,5);
 s.schedule(10);s.schedule(7);assert.ok(s.pending());
 await new Promise(r=>setTimeout(r,40));
 assert.deepEqual(drawn,[4]);assert.ok(!s.pending());
 busy=true;s.schedule(1);await new Promise(r=>setTimeout(r,40));assert.deepEqual(drawn,[4],'not while a render runs');
 busy=false;await new Promise(r=>setTimeout(r,20));assert.deepEqual(drawn,[4,0]);
 s.schedule(3);s.cancel();await new Promise(r=>setTimeout(r,40));assert.deepEqual(drawn,[4,0]);
});
