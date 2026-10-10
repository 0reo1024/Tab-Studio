// Measures per-track meter peaks while playing a real song (default: Desktop\Virtual Insanity.tg).
// Usage: node scripts/mix-balance-probe.mjs [file] [track]
import {_electron as electron} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const file=process.argv[2]||path.join(process.env.USERPROFILE,'Desktop','Virtual Insanity.tg'),probe=Number(process.argv[3]??3);
const folder=path.resolve('test-results/mix-balance-'+Date.now());await fs.mkdir(folder,{recursive:true});let app;
try{
 app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],env:{...process.env,TAB_STUDIO_TEST_DATA:path.join(folder,'profile')}});
 const page=await app.firstWindow();page.setDefaultTimeout(120000);await page.locator('#start-demo').click();
 const ready=()=>page.waitForFunction(()=>{const s=window.tabStudio?.getState();return s?.ready&&!s.rendering&&!document.querySelector('#play')?.classList.contains('nam-loading')&&!document.querySelector('#play')?.disabled;});
 await ready();
 const bytes=[...await fs.readFile(file)];
 await page.evaluate(async({bytes,name,file})=>{await window.tabStudio.load(name,new Uint8Array(bytes),undefined,file);},{bytes,name:path.basename(file),file});
 await ready();
 const names=await page.evaluate(()=>window.tabStudio.getScore().tracks.map(t=>t.name.split('|')[0].trim()));
 async function measure(label,setup){
  await page.evaluate(setup);await ready();
  await page.evaluate(probe=>{const s=window.tabStudio.getScore(),bars=s.tracks[probe].staves[0].bars,has=b=>b.voices.some(v=>v.beats.some(x=>x.notes.length));let bar=bars.findIndex((b,i)=>i>=8&&has(b)&&has(bars[i+1]??b)&&has(bars[i+2]??b));if(bar<0)bar=0;window.probeBar=bar;window.tabStudio.select(bar,0,probe);},probe);
  await page.evaluate(()=>document.querySelector('#play').click());
  await page.waitForFunction(()=>window.tabStudio.getState().playing);
  // Peak meters, plus (WebAudio engine only) RMS and the share of energy below 150 Hz per track.
  await page.evaluate(()=>{const m=window.tabStudio.mixerAudio;window.probeEnergy=(m.graphs??[]).map(()=>({sum:0,n:0,low:0,all:0}));});
  const samples=[];for(let i=0;i<60;i++){await page.waitForTimeout(100);samples.push(await page.evaluate(()=>{const m=window.tabStudio.mixerAudio;(m.graphs??[]).forEach((g,i)=>{const a=g.meter,t=new Float32Array(a.fftSize),f=new Float32Array(a.frequencyBinCount);a.getFloatTimeDomainData(t);a.getFloatFrequencyData(f);const e=window.probeEnergy[i];for(const v of t){e.sum+=v*v;e.n++;}const hz=a.context.sampleRate/a.fftSize;f.forEach((db,k)=>{const p=10**(db/10);e.all+=p;if(k*hz<150)e.low+=p;});});return m.peaks();}));}
  const energy=await page.evaluate(()=>window.probeEnergy.map(e=>({rms:e.n?Math.round(10*Math.log10(e.sum/e.n))*1:null,low:e.all?Math.round(100*e.low/e.all):null})));
  await page.evaluate(()=>document.querySelector('#play').click());await page.waitForFunction(()=>!window.tabStudio.getState().playing);
  const db=v=>v>1e-6?Math.round(20*Math.log10(v)*10)/10:-120;
  const tracks=names.map((_,i)=>db(Math.max(...samples.map(s=>s.tracks[i]??0))));
  const master=db(Math.max(...samples.map(s=>s.master)));
  console.log('state',JSON.stringify(await page.evaluate(()=>({notice:document.querySelector('#notice')?.textContent,stats:window.tabStudio.mixerAudio.resourceStats?.(),tick:window.tabStudio.getState().lastTick,bar:window.probeBar,loading:window.tabStudio.getScore().tracks.map((_,i)=>window.tabStudio.mixerAudio.isLoading?.(i)),namNorm:(window.tabStudio.mixerAudio.graphs??[]).map(g=>g.namNorm).filter(v=>v!==undefined),nativeNorm:[...(window.tabStudio.mixerAudio.namNorm??new Map())]}))));
  console.log(`\n== ${label}  master peak ${master} dB`);names.forEach((n,i)=>console.log(`${String(i).padStart(2)} ${n.padEnd(22)} peak ${tracks[i]} dB`+(energy[i]?.rms!=null?` | rms ${energy[i].rms} dB | below 150 Hz ${energy[i].low}%`:'')));
  return {tracks,master};
 }
 const unsolo=()=>{const s=window.tabStudio.getScore();for(const t of s.tracks){t.playbackInfo.isSolo=false;window.tabStudio.api.changeTrackSolo([t],false);}window.tabStudio.mixerAudio.sync();};
 const all=await measure('all tracks',unsolo);
 const solo=await measure('bass solo',`(()=>{const s=window.tabStudio.getScore();for(const t of s.tracks){t.playbackInfo.isSolo=t.index===${probe};window.tabStudio.api.changeTrackSolo([t],t.index===${probe});}window.tabStudio.mixerAudio.sync();})()`);
 // Moves the track's NAM output knob in the mixer's NAM dialog, as a user would.
 const knob=`(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));document.querySelector('[aria-label="ミキサーを表示"]')?.click();await wait(500);document.querySelector('[data-nam-track="${probe}"]')?.click();await wait(500);const s=document.querySelector('input[data-nam="output"]');if(!s)throw new Error('NAM output knob not found');s.value=String(Math.min(12,Number(s.value)+12));s.dispatchEvent(new Event('input'));await wait(300);document.querySelector('dialog[open]')?.close();await wait(300);})()`;
 const louder=await measure('bass solo, NAM output +12 dB',knob);
 console.log(`\nNAM output knob +12 dB changed the bass by ${Math.round((louder.tracks[probe]-solo.tracks[probe])*10)/10} dB`);
 console.log('\nQA_FOLDER='+folder);
}finally{if(app)await app.evaluate(()=>process.exit(0)).catch(()=>{});}
