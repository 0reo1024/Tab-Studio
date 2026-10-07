import {createRequire} from 'node:module';
import {execFile as callbackExecFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const execFile=promisify(callbackExecFile),require=createRequire(import.meta.resolve('electron-builder'));
const seven=await require('app-builder-lib/out/toolsets/7zip').getPath7za();
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const installer=path.resolve(process.env.TAB_STUDIO_TEST_INSTALLER||`release/${version}/Tab-Studio-${version}-Setup.exe`),output=path.resolve('test-results/installer-'+Date.now());
const header=await fs.open(installer,'r');try{const magic=Buffer.alloc(2);await header.read(magic,0,2,0);assert.equal(magic.toString(),'MZ');}finally{await header.close();}
await execFile(seven,['t',installer],{timeout:60000});
await execFile(seven,['x',installer,'-y','-o'+output],{timeout:60000});
const exe=path.join(output,'Tab Studio.exe');assert.ok((await fs.stat(exe)).size>100_000_000);
await fs.access(path.join(output,'resources/app.asar.unpacked/licenses/tuxguitar-corresponding-source.zip'));
const result=await execFile(process.execPath,['scripts/package-check.mjs'],{env:{...process.env,TAB_STUDIO_TEST_EXE:exe},timeout:60000});process.stdout.write(result.stdout);
console.log('WINDOWS INSTALLER VERIFIED: PE executable / embedded archive CRC / extracted app launch / audio ready / app menu / Space and arrows / close dialog');
