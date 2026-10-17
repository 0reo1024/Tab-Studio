// NAM output levels at the default settings, per model, on the same DI phrase
// (crates/tabstudio-audio/examples/nam_levels.rs): the bundled Deluxe A2, every model in
// native/nam-models.json and any other .nam in native/nam-models (unlisted: they show how
// an imported model fares). Output gain as the app sends it: -6 (the panel default) +
// NAM_OUTPUT_TRIM + namOutputLevel; with --before, the earlier metadata leveling
// (namLoudnessGain). The target is the DI's own loudness, so NAM on or off keeps a track's level.
// Usage: node --import tsx scripts/nam-levels.mjs [--before] [--input-offset dB] [--table] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {NAM_OUTPUT_TRIM,namOutputLevel} from '../src/mixer-state.ts';
/** The earlier leveling (until this table): each model's loudness metadata brought to -18 dB. */
const namLoudnessGain=json=>{const loudness=Number(JSON.parse(json)?.metadata?.loudness);return Number.isFinite(loudness)?Math.max(-30,Math.min(30,-18-loudness)):0;};

const arg=name=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:undefined;};
const before=process.argv.includes('--before'),offset=Number(arg('--input-offset')??0),out=arg('--json');
const native=path.resolve('native'),library=JSON.parse(fs.readFileSync(path.join(native,'nam-models.json'),'utf8'));
const models=[['deluxe-a2',path.resolve('public/nam/deluxe-a2.nam')],...Object.entries(library).map(([id,file])=>[id,path.resolve(native,file)])];
for(const file of fs.readdirSync(path.join(native,'nam-models')).filter(f=>f.endsWith('.nam')).map(f=>path.join(native,'nam-models',f)))
 if(!models.some(([,p])=>path.resolve(p)===file))models.push([`(imported) ${path.basename(file)}`,file]);
const rows=models.map(([id,file])=>{const json=fs.readFileSync(file,'utf8'),kind=id.startsWith('bass-')?'bass':'guitar',norm=before?namLoudnessGain(json):namOutputLevel(id.startsWith('(')?{model:id,kind,modelJson:json}:{model:id,kind});return {id,file,kind,output:-6+NAM_OUTPUT_TRIM+norm,norm};});
fs.mkdirSync('test-results',{recursive:true});const list=path.resolve('test-results/nam-levels.tsv');
fs.writeFileSync(list,rows.map(r=>[r.id,r.kind,r.output,r.file].join('\t')).join('\n'));
const text=execFileSync('cargo',['run','--quiet','--release','--example','nam_levels','--',list,String(offset)],{cwd:'crates/tabstudio-audio',encoding:'utf8',maxBuffer:1<<24});
const di=Object.fromEntries(text.split('\n').filter(l=>l.startsWith('DI ')).map(l=>{const [,kind,,rms,,lufs]=l.trim().split(' ');return [kind,{rms:+rms,lufs:+lufs}];}));
const measured=new Map(text.split('\n').filter(l=>l.startsWith('MODEL\t')).map(l=>{const [,id,,rms,lufs,cabRms,cabLufs]=l.trim().split('\t');return [id,{rms:+rms,lufs:+lufs,cabRms:+cabRms,cabLufs:+cabLufs}];}));
const result=rows.map(r=>{const m=measured.get(r.id);return {...r,...m,raw:m.lufs-r.norm,target:di[r.kind].lufs};});
console.log(`DI loudness (the target): guitar ${di.guitar.lufs} LUFS, bass ${di.bass.lufs} LUFS; amp input offset ${offset} dB`);
console.log(`\n${before?'BEFORE (metadata leveling)':'AFTER (namOutputLevel)'}\nkind   | LUFS   | vs DI  | RMS    | cab LUFS | unleveled | leveling dB | model`);
for(const r of result)console.log(`${r.kind.padEnd(6)} | ${r.lufs.toFixed(2).padStart(6)} | ${(r.lufs-r.target).toFixed(2).padStart(6)} | ${r.rms.toFixed(2).padStart(6)} | ${r.cabLufs.toFixed(2).padStart(8)} | ${r.raw.toFixed(2).padStart(9)} | ${r.norm.toFixed(2).padStart(11)} | ${r.id}`);
const spread=(label,pick,filter)=>{for(const kind of ['guitar','bass']){const v=result.filter(r=>r.kind===kind&&filter(r)).map(pick).sort((a,b)=>a-b);if(v.length)console.log(`${label} ${kind}: ${v.length} models, min ${v[0].toFixed(2)} max ${v.at(-1).toFixed(2)} spread ${(v.at(-1)-v[0]).toFixed(2)} dB`);}};
spread('LUFS',r=>r.lufs,r=>!r.id.startsWith('('));spread('LUFS cabinet on',r=>r.cabLufs,r=>!r.id.startsWith('('));spread('LUFS imported',r=>r.lufs,r=>r.id.startsWith('('));spread('unleveled LUFS',r=>r.raw,r=>!r.id.startsWith('('));
// --table: the leveling that brings each bundled model to its DI's loudness, and for imported
// models the median of their kind (their output without the metadata leveling).
if(process.argv.includes('--table')){
 const listed=result.filter(r=>!r.id.startsWith('('));
 console.log('\nexport const NAM_MODEL_LEVEL={'+listed.map(r=>`'${r.id}':${(r.target-r.raw).toFixed(1)}`).join(',')+'};');
 for(const kind of ['guitar','bass']){const v=listed.filter(r=>r.kind===kind).map(r=>r.target-r.raw).sort((a,b)=>a-b);console.log(`fallback ${kind}: ${((v[(v.length-1)>>1]+v[v.length>>1])/2).toFixed(1)}`);}
}
if(out)fs.writeFileSync(out,JSON.stringify({offset,di,result},null,1));
