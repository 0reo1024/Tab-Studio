import test from 'node:test';
import assert from 'node:assert/strict';
import {agoLabel,durationLabel,dropsLabel,engineTone,frameAt,latencyLabel,meterFill,peakDb,phraseAt,readChain,selection,songAt,viewRange,xAt} from '../src/live-input-model';
test('the timeline shows the last five minutes and maps clicks to frames both ways',()=>{
 const rate=48000;assert.deepEqual(viewRange(10*rate,rate),[-290*rate,10*rate]);assert.deepEqual(viewRange(400*rate,rate),[100*rate,400*rate]);
 const view=viewRange(400*rate,rate);assert.equal(frameAt(0,1000,view),100*rate);assert.equal(frameAt(1000,1000,view),400*rate);assert.equal(frameAt(5000,1000,view),400*rate);
 assert.equal(Math.round(xAt(frameAt(333,1000,view),1000,view)),333);
 assert.equal(agoLabel(0),'今');assert.equal(agoLabel(65),'-1:05');assert.equal(durationLabel(65.25),'1:05.3');
});
test('selections stay inside what is recorded and phrases are found under the pointer',()=>{
 assert.deepEqual(selection(500,100,200,1000),[200,500]);assert.equal(selection(50,100,200,1000),null);assert.deepEqual(selection(900,2000,0,1000),[900,1000]);
 assert.deepEqual(phraseAt([[0,10],[20,30]],25),[20,30]);assert.equal(phraseAt([[0,10]],15),null);
});
test('song positions follow the marks and stop where the score was not playing',()=>{
 const marks:[number,number,number|null][]=[[0,0,null],[100,1,4],[300,2,null]];
 assert.equal(songAt(marks,50,100),null);assert.equal(songAt(marks,150,100),4.5);assert.equal(songAt(marks,350,100),null);
});
test('meters, latency and drops read in dB and milliseconds',()=>{
 assert.equal(peakDb(0),-60);assert.equal(Math.round(peakDb(0.5)),-6);assert.equal(meterFill(1),1);assert.equal(meterFill(0),0);
 assert.equal(latencyLabel({totalMs:8.06,driverInMs:2.83,driverOutMs:4.5,heldMs:0.67,pluginsMs:0}),'合計 8.1 ms（入力 2.8 + 出力 4.5 + 待ち 0.7）');
 assert.match(latencyLabel({totalMs:13,driverInMs:2.8,driverOutMs:4.5,heldMs:0.7,pluginsMs:5.3}),/プラグイン 5\.3/);
 assert.equal(dropsLabel({overflows:0,underruns:0,trimmed:900,recorder:0,fxLate:0,overloads:0},48000),'');
 assert.equal(dropsLabel({overflows:480,underruns:0,trimmed:0,recorder:0,fxLate:0,overloads:2},48000),'入力のあふれ 10 ms · 処理落ち 2 回');
});
test('the saved chain is repaired and the amp output is leveled per model',()=>{
 assert.deepEqual(readChain('{bad').plugins,[]);
 const chain=readChain(JSON.stringify({nam:{model:'m1',name:'Amp'},tone:{bass:99,output:'x',cabinet:false},plugins:[{path:'a.vst3',name:'A',enabled:false,state:'s'},{name:'no path'}]}));
 assert.deepEqual(chain.nam,{model:'m1',name:'Amp'});assert.equal(chain.tone.bass,12);assert.equal(chain.tone.output,-6);assert.equal(chain.tone.cabinet,false);
 assert.deepEqual(chain.plugins,[{path:'a.vst3',name:'A',enabled:false,state:'s'}]);
 assert.equal(engineTone(chain.tone,3).output,-3);
});
