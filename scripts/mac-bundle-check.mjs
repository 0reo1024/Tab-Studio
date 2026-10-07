import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.resolve('@electron/packager')),asar=await import(pathToFileURL(require.resolve('@electron/asar')).href);
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
for(const arch of ['arm64','x64']){
 const resources=path.resolve('release/'+version+'/mac-bundles/Tab Studio-darwin-'+arch+'/Tab Studio.app/Contents/Resources'),file=path.join(resources,'app.asar');
 const pkg=JSON.parse(asar.extractFile(file,'package.json').toString());assert.equal(pkg.version,version);assert.equal(pkg.main,'electron/main.cjs');
 const files=asar.listPackage(file).map(f=>f.replace(/\\/g,'/'));for(const required of ['/dist/index.html','/dist/alphatab/alphaTab.worker.mjs','/dist/alphatab/alphaTab.worklet.mjs','/dist/alphatab/soundfont/sonivox.sf2','/electron/preload.cjs','/electron/session-store.cjs'])assert.ok(files.includes(required),required);
 assert.ok(asar.extractFile(file,'electron/main.cjs').toString().includes('allowClose=false;'));
 await fs.access(path.join(resources,'licenses/tuxguitar-corresponding-source.zip'));
 for(const source of ['dist/index.html','electron/main.cjs','electron/preload.cjs'])assert.deepEqual(asar.extractFile(file,source),await fs.readFile(source),source);
 const index=await fs.readFile('dist/index.html','utf8');const main=index.match(/src="([^"]+main-[^"]+\.js)"/)[1].replace(/^\.\//,'');assert.deepEqual(asar.extractFile(file,path.normalize('dist/'+main)),await fs.readFile('dist/'+main),'latest renderer');
 console.log('MAC BUNDLE CONTENTS VERIFIED:',arch,'/ version / renderer / SoundFont / workers / preload / session / licenses');
}
