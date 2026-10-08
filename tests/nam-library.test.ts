import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addNamModel,saveNamPreset,useNamPreset,selectNamModel,moveNamItem,type NamLibrary} from '../src/nam-library';
import {defaultTrackAudio,namPresets} from '../src/mixer-state';
const library=():NamLibrary=>({models:namPresets.map(p=>({id:p.id,name:p.name,builtin:true})),presets:[]});
test('two settings presets use the same NAM model without duplicating model bytes',()=>{
 const l=library(),n=defaultTrackAudio().nam;
 const model=addNamModel(l,'My amp.nam',JSON.stringify({architecture:'SlimmableContainer',config:{submodels:[]}}));selectNamModel(n,model);
 n.input=4;n.bass=-2;const first=saveNamPreset(l,'Rhythm',n);n.input=12;n.bass=3;n.cabinet=true;const second=saveNamPreset(l,'Lead',n);
 assert.equal(l.models.length,6);assert.equal(first.settings.modelJson,undefined);assert.equal(second.settings.model,first.settings.model);
 useNamPreset(n,first,l);assert.equal(n.input,4);assert.equal(n.bass,-2);assert.equal(n.cabinet,false);assert.equal(n.modelJson,model.json);
 useNamPreset(n,second,l);assert.equal(n.input,12);assert.equal(n.bass,3);assert.equal(n.cabinet,true);
});
test('NAM library order and presets survive serialization and reject incompatible models',()=>{
 const l=library(),n=defaultTrackAudio().nam;selectNamModel(n,l.models[0]);saveNamPreset(l,'Clean',n);moveNamItem(l.models,0,1);const restored=JSON.parse(JSON.stringify(l));assert.equal(restored.models[1].id,'fender-super');useNamPreset(n,restored.presets[0],restored);assert.equal(n.model,'fender-super');assert.equal(n.enabled,true);
 assert.throws(()=>addNamModel(l,'bad.nam','{}'),/A2 Lite/);assert.throws(()=>saveNamPreset(l,' ',n),/名前|名/);
 moveNamItem(l.models,0,-1);assert.equal(l.models[0].id,'marshall-jcm800');
});
