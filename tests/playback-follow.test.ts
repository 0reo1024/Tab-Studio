import test from 'node:test';
import assert from 'node:assert/strict';
import {ScoreFollower} from '../src/playback-ui';
test('following uses cursor-handler coordinates instead of measuring the DOM every frame',()=>{
 const oldRequest=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame,frames=new Map<number,FrameRequestCallback>();let counter=0,time=performance.now(),queries=0,measures=0;
 globalThis.requestAnimationFrame=fn=>{frames.set(++counter,fn);return counter;};globalThis.cancelAnimationFrame=id=>{frames.delete(id);};
 const viewport={scrollTop:0,scrollLeft:0,scrollHeight:3000,scrollWidth:1200,clientHeight:600,clientWidth:1000,addEventListener(){},getBoundingClientRect:()=>{measures++;return {top:0,left:0,right:1000,bottom:600,height:600,width:1000};}};
 const sheet={querySelector:()=>{queries++;return null;},getBoundingClientRect:()=>{measures++;return {top:40-viewport.scrollTop,left:0};}};
 const advance=()=>{for(let i=0;i<100;i++){const current=[...frames];frames.clear();time+=16;for(const [,fn]of current)fn(time);}};
 try{
  const follower=new ScoreFollower(viewport as unknown as HTMLElement,sheet as unknown as HTMLElement,()=>true);
  follower.cursorMoved({x:210,toX:210,y:1000,h:65,start:performance.now(),duration:0});follower.setPlaying(true);advance();
  // Cursor top = 40 + 1000 - 12; it is brought to 35% of the viewport height.
  assert.ok(Math.abs(viewport.scrollTop-(1028-Math.max(70,(600-89)*.35)))<2,String(viewport.scrollTop));
  assert.equal(queries,0);assert.ok(measures<=2,`measured ${measures} times`);
  follower.setPlaying(false);
 }finally{globalThis.requestAnimationFrame=oldRequest;globalThis.cancelAnimationFrame=oldCancel;}
});
