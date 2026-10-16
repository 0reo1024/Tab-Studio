import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diSound,soundName} from '../src/instrument-options';

test('a bass NAM keeps the Bass DI the track chose: Fashion (first), Standard or Growly',()=>{
 const library=[{name:'Guitar DI',path:'C:/g/01-Standard Guitar KSOP.sfz'},{name:'Bass DI (Fashion)',path:'C:/n/Fashionbass/Tab Studio Bass DI Fashion.sfz'},{name:'Bass DI (Standard)',path:'C:/n/Ui_Standard_Bass_V2/Standard_Bass_V2_KSOP/Tab Studio Bass DI Finger.sfz'},{name:'Bass DI (Growly)',path:'C:/n/Growlybass/Tab Studio Bass DI Growly.sfz'}];
 const [guitar,fashion,standard,growly]=library;
 assert.equal(diSound('bass',library)?.path,fashion.path);
 assert.equal(diSound('bass',library,{path:standard.path})?.path,standard.path);
 assert.equal(diSound('bass',library,{path:growly.path})?.path,growly.path);
 // The Standard Bass pick program is no longer offered: a song saved with it plays the default.
 assert.equal(diSound('bass',library,{path:'C:/n/Ui_Standard_Bass_V2/Standard_Bass_V2_KSOP/#Standard_Bass_V2_KSOP.sfz'})?.path,fashion.path);
 assert.equal(diSound('bass',library,{path:guitar.path})?.path,fashion.path,'a guitar sound falls back to the default');
 assert.equal(diSound('guitar',library)?.path,guitar.path);
 assert.deepEqual(library.map(soundName),['Guitar DI (Standard)','Bass DI (Fashion)','Bass DI (Standard)','Bass DI (Growly)']);
 // Names come from the file too (songs store the path).
 assert.equal(soundName({name:'',path:growly.path}),'Bass DI (Growly)');
 assert.equal(soundName({name:'',path:standard.path}),'Bass DI (Standard)');
 assert.equal(soundName({name:'',path:'C:/n/Ui_Standard_Bass_V2/x/#Standard_Bass_V2_KSOP.sfz'}),'Bass DI (Standard pick)');
});

test('a guitar NAM keeps the Guitar DI the track chose: Standard (first), LP Neck or LP Bridge',()=>{
 const library=[{name:'Guitar DI',path:'C:/g/01-Standard Guitar KSOP.sfz'},{name:'Guitar DI (LP Neck)',path:'C:/n/FlameStudios_LesPaul_Neck/Tab Studio Guitar DI LP Neck.sfz'},{name:'Guitar DI (LP Bridge)',path:'C:/n/FlameStudios_LesPaul_Bridge/Tab Studio Guitar DI LP Bridge.sfz'},{name:'Bass DI (Fashion)',path:'C:/n/Fashionbass/Tab Studio Bass DI Fashion.sfz'}];
 assert.equal(diSound('guitar',library)?.path,library[0].path);
 assert.equal(diSound('guitar',library,{path:library[2].path})?.path,library[2].path);
 assert.equal(diSound('guitar',library,{path:library[3].path})?.path,library[0].path,'a bass sound falls back to the Standard');
 assert.deepEqual(library.map(soundName),['Guitar DI (Standard)','Guitar DI (LP Neck)','Guitar DI (LP Bridge)','Bass DI (Fashion)']);
 assert.equal(soundName({name:'',path:library[1].path}),'Guitar DI (LP Neck)');
 assert.equal(soundName({name:'',path:'C:/n/Trummer_LesPaul/Tab Studio Guitar DI Trummer LP Bridge.sfz'}),'Guitar DI (Trummer LP Bridge)');
 assert.equal(soundName({name:'Guitar DI (Trummer LP Neck)',path:'C:/n/Trummer_LesPaul/Tab Studio Guitar DI Trummer LP Neck.sfz'}),'Guitar DI (Trummer LP Neck)');
});
