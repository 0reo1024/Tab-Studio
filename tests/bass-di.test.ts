import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diSound,soundName} from '../src/instrument-options';

test('Growlybass is the only Bass DI, also for songs saved with an earlier bass DI',()=>{
 const library=[{name:'Guitar DI',path:'C:/g/01-Standard Guitar KSOP.sfz'},{name:'Bass DI',path:'C:/n/Growlybass/Tab Studio Bass DI Growly.sfz'}];
 const growly=library[1];
 assert.equal(diSound('bass',library)?.path,growly.path);
 for(const saved of ['C:/n/Ui_Standard_Bass_V2/Standard_Bass_V2_KSOP/Tab Studio Bass DI Finger.sfz','C:/n/Ui_Standard_Bass_V2/Standard_Bass_V2_KSOP/#Standard_Bass_V2_KSOP.sfz'])
  assert.equal(diSound('bass',library,{path:saved})?.path,growly.path,saved);
 assert.equal(diSound('guitar',library)?.path,library[0].path);
 assert.equal(soundName(growly),'Bass DI');
 assert.equal(soundName({name:'',path:'C:/n/Ui_Standard_Bass_V2/x/#Standard_Bass_V2_KSOP.sfz'}),'Bass DI');
});
