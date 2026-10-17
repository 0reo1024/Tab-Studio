import test from 'node:test';
import assert from 'node:assert/strict';
import {createPositionStore} from '../src/document-positions';
import {readSettings} from '../src/app-settings';

function memory(){const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},data};}

test('positions survive a restart and match Windows paths regardless of case and slashes',()=>{
 const storage=memory();
 createPositionStore(storage).remember([{path:'C:\\Songs\\Riff.gp5',position:{tick:3840,top:900,left:12,selected:{track:1,staff:0,bar:4,voice:0,beat:2,string:3}}}]);
 const restarted=createPositionStore(storage);
 assert.deepEqual(restarted.get('c:/songs/riff.gp5'),{tick:3840,top:900,left:12,selected:{track:1,staff:0,bar:4,voice:0,beat:2,string:3}});
 assert.equal(restarted.get('C:\\Songs\\Other.gp5'),undefined);
});

test('unsaved documents and broken entries are ignored',()=>{
 const storage=memory();const store=createPositionStore(storage);
 store.remember([{path:'',position:{tick:1,top:0,left:0,selected:null}}]);
 assert.equal(storage.data.size,0);
 storage.setItem('tabstudio-positions',JSON.stringify([['a.gp',{tick:-1,top:0,left:0}],['b.gp',{tick:10,top:5,left:0,selected:{bar:'x'}}]]));
 const reread=createPositionStore(storage);
 assert.equal(reread.get('a.gp'),undefined);
 assert.deepEqual(reread.get('b.gp'),{tick:10,top:5,left:0,selected:null});
});

test('only the 100 most recent files are kept',()=>{
 const storage=memory();const store=createPositionStore(storage);
 for(let i=0;i<105;i++)store.remember([{path:`f${i}.gp`,position:{tick:i,top:0,left:0,selected:null}}]);
 const reread=createPositionStore(storage);
 assert.equal(reread.get('f0.gp'),undefined);assert.equal(reread.get('f104.gp')?.tick,104);
});

test('resume position setting defaults on and can be turned off',()=>{
 assert.equal(readSettings(null).resumePosition,true);
 assert.equal(readSettings(JSON.stringify({resumePosition:false})).resumePosition,false);
});
