import * as at from '@coderline/alphatab';
import {installEnhancements} from './enhancements';
import {applyTechnique} from './techniques';
import {applyLayout,getLayout,setLayout,hasLayout,transferLayout,type LayoutSettings} from './layout-settings';
import {specialPaste,localPaste,repeatClipboard,type PasteKind} from './special-paste';
import './style.css';
import {readSettings,installSettingsDialog,keyCombo,shortcutCommand,shortcutDefinitions,type AppSettings} from './app-settings';
import { createEditPalette, noteIcon } from './edit-palette';
import {setMeter} from './meter-editor';
import {drumSounds,setDrum} from './drum-editor';
import {transposeScore} from './transpose-score';
import {transposeNote,shiftString} from './note-actions';
import { demoScore, serialize, deserialize, project, readProject, importGuitarPro, settings, beatQ, voiceQ, type Score, type Beat, type Note } from './score';
import { installPlaybackFrame, ScoreFollower } from './playback-ui';
import { ClickAudio, type ClickKind } from './metronome';
import { resizeBeat, splitFullRest, setFret, rests } from './editor';
import { hitTab, tabBounds, adjacentTabRow } from './hit-test';
import { importTg } from './tg-reader';
import { NotePreview } from './note-preview';
import {trackNotation,setTrackNotation,applyNotationDefaults,type TrackNotation} from './track-notation';
import {setSongTempo} from './song-tempo';
import {setTrackInstrument} from './track-instrument';
import {canEditFretLocally,editFretLocally} from './local-fret-edit';
import {FretFeedback} from './fret-feedback';
import { readableLayout } from './score-layout';
import { exportTg } from './tg-writer';
import { restoredVisibility, visibilityKey } from './track-visibility';
import { exportScore as exportScoreBytes, type ScoreFormat } from './export-score';
import {copyBars,pasteBars,insertBars,deleteBars,addTrack,removeTrack,duplicateTrack,moveTrack,configureTrack,tuningPresets,pitchName,parsePitch,checkedRange,type TrackKind,type BarClipboard} from './score-operations';
import {hitStandard,standardBounds,standardY,setPitch,diatonicPitch} from './standard-editor';
import {pasteMeasurePhrase} from './paste-measures';
import {EditSnapshot,normalizeEdit,restoreScore,excerptJson,type ScoreData} from './edit-snapshot';
import {pdfOptions,type PdfOptions} from './pdf-options';
import {copyBeats,pasteBeats,clearBeats,rangeBeats,orderedRange,type BeatRange,type BeatClipboard} from './beat-clipboard';

type DesktopFile={name:string;path:string;bytes:number[];openToken:string};
type RecentFile={path:string;name:string};
declare global { interface Window { desktop?:{openScore:()=>Promise<DesktopFile|null>;saveScore:(args:{name:string;bytes:Uint8Array;saveAs?:boolean;path?:string})=>Promise<{name:string;path:string}|false>;exportScore:(args:{name:string;format:ScoreFormat|'pdf';bytes?:Uint8Array;scoreJson?:string;tracks?:number[];pdf?:PdfOptions;trackNames?:string[]})=>Promise<{name:string;path:string}|false>;resetSavePath:()=>Promise<void>;activateDocument:(path:string)=>Promise<void>;acceptOpen:(token:string)=>Promise<void>;recentFiles:()=>Promise<RecentFile[]>;lastScore:()=>Promise<DesktopFile|null>;openRecent:(path:string)=>Promise<DesktopFile>;openFilePath:(path:string)=>Promise<DesktopFile>;pathForFile:(file:File)=>string;onCloseRequest:(handler:()=>void)=>void;finishClose:()=>void;toggleFullscreen:()=>void;onCommand:(handler:(command:string)=>void)=>void;setMenuState:(state:Record<string,boolean>)=>void}; tabStudio:unknown } }
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const value=(id:string)=>$(id) as HTMLInputElement;
const choose=(id:string)=>$(id) as HTMLSelectElement;
const button=(id:string)=>$(id) as HTMLButtonElement;
const asset=(file:string)=>new URL(`./alphatab/${file}`,document.baseURI).href;
let appSettings=readSettings(localStorage.getItem('tabstudio-settings'));
document.documentElement.dataset.theme=appSettings.theme;
const clickAudio=new ClickAudio();
const notePreview=new NotePreview(asset('soundfont/sonivox.sf2'));
let audioStarting:Promise<void>|null=null;
const audioModules=new WeakMap<AudioContext,Promise<void>>();
function prepareAudio(context:AudioContext){clickAudio.attach(context);let loading=audioModules.get(context);if(!loading){loading=context.audioWorklet.addModule(asset('alphaTab.worklet.mjs'));audioModules.set(context,loading);audioStarting=loading;void loading.then(()=>{if(audioStarting===loading)audioStarting=null;},()=>{audioModules.delete(context);if(audioStarting===loading)audioStarting=null;});}return loading;}
at.Environment.initializeMain(()=>new Worker(asset('alphaTab.worker.mjs'),{type:'module'}),prepareAudio);
const api=new at.AlphaTabApi($('score'),{
  core:{fontDirectory:asset('font/'),includeNoteBounds:true,useWorkers:true,enableLazyLoading:true},
  display:{...readableLayout,scale:1,padding:[20,20,20,20],layoutMode:at.LayoutMode.Page},
  player:{playerMode:at.PlayerMode.EnabledSynthesizer,soundFont:asset('soundfont/sonivox.sf2'),scrollElement:$('score-scroll'),scrollMode:at.ScrollMode.Off,enableUserInteraction:false,enableCursor:true,enableElementHighlighting:false,outputMode:at.PlayerOutputMode.WebAudioAudioWorklets}
});
let score=demoScore(),sourceName='Demo',warnings:string[]=[],visible=new Set([0]),dirty=false,playing=false,rendering=false,lastTick=0,scale=1;
applyNotationDefaults(score,appSettings.notation);
let startupComplete=false;let recentFiles:RecentFile[]=[];let notation:'tab'|'both'|'standard'=appSettings.notation;
scale=appSettings.zoom;api.settings.display.scale=scale;api.updateSettings();$('zoom').textContent=`${Math.round(scale*100)}%`;
let documentPath='';
const trackViews=new Map<string,number[]>();
try{const saved=JSON.parse(localStorage.getItem('tabstudio-track-views')||'[]');if(Array.isArray(saved))for(const entry of saved.slice(-100))if(Array.isArray(entry)&&typeof entry[0]==='string'&&Array.isArray(entry[1]))trackViews.set(entry[0],entry[1]);}catch{}
function viewKey(){return visibilityKey(documentPath||'name:'+sourceName);}
function restoreTrackView(){visible=restoredVisibility(trackViews.get(viewKey()),score.tracks.length);}
function rememberTrackView(){const key=viewKey(),previous=trackViews.get(key),indices=[...visible];if(previous?.length===indices.length&&previous.every((n,i)=>n===indices[i]))return;trackViews.delete(key);trackViews.set(key,indices);while(trackViews.size>100)trackViews.delete(trackViews.keys().next().value!);try{localStorage.setItem('tabstudio-track-views',JSON.stringify([...trackViews]));}catch{}}
function startupLoading(text='前回のファイルを読み込み中…'){$('loading-message').textContent=text;$('status').textContent=text;}
function finishStartupLoading(){$('loading-indicator').hidden=true;for(const element of document.querySelectorAll<HTMLElement>('.workspace,.transport,#menubar'))element.inert=false;}
let audioStatus='同梱音源を準備中…';
let loopConfig={start:1,end:score.masterBars.length,enabled:false},loopInputsDirty=false;
let extras:ReturnType<typeof installEnhancements>|undefined;
let queuedPlay=false,playbackStartTick=0,playRequest=0;
let pendingSeekTick:number|null=null,pauseTarget:number|null=null,parkedTick:number|null=null;
let midiLoadsPending=0;
let reopenInline=false,previewRequest=0;
type NavigationKey=Pick<KeyboardEvent,'key'|'ctrlKey'|'shiftKey'>&{command?:string};
const pendingNavigation:NavigationKey[]=[];
function seekTo(tick:number){parkedTick=tick;pendingSeekTick=tick;if(documentViewport)documentViewport.tick=tick;api.tickPosition=tick;}
type Selection={track:number;staff:number;bar:number;voice:number;beat:number;string:number;surface?:'tab'|'standard';note?:number;pitch?:number};let selected:Selection|null=null,noteSelected=false;
type Range={start:number;end:number;track:number;allTracks:boolean};let selectedRange:Range|null=null,fragmentRange:BeatRange|null=null,clipboard:BarClipboard|BeatClipboard|null=null;
installPlaybackFrame(api);
const follower=new ScoreFollower($('score-scroll'),$('score'),()=>appSettings.follow);
let updatePalette:ReturnType<typeof createEditPalette>|undefined,updateContextPalette:ReturnType<typeof createEditPalette>|undefined;
const editSnapshot=new EditSnapshot();
let editRevision=0;
let softRendering=false,playbackDirty=false,fretRevision=0,drawnFretRevision=0;
let fretDrawTimer:ReturnType<typeof setTimeout>|undefined,pendingFretBar:number|null=null;
const fretFeedback=new FretFeedback($('score'),document.querySelector<HTMLElement>('.paper')!,()=>api.boundsLookup);
function cancelFretDraw(){clearTimeout(fretDrawTimer);pendingFretBar=null;}
function scheduleFretDraw(bar:number){pendingFretBar=Math.min(pendingFretBar??bar,bar);clearTimeout(fretDrawTimer);fretDrawTimer=setTimeout(flushFretDraw,120);}
function flushFretDraw(){clearTimeout(fretDrawTimer);if(pendingFretBar===null)return;if(rendering){fretDrawTimer=setTimeout(flushFretDraw,50);return;}const bar=pendingFretBar;pendingFretBar=null;render(true,Math.max(0,bar-3),true);}

type EditState={data:ScoreData;visible:number[];selected:Selection|null;noteSelected:boolean;range:Range|null;fragment:BeatRange|null;firstChangedBar?:number;layout?:LayoutSettings};
const undo:EditState[]=[],redo:EditState[]=[];
type DocumentState={id:number;score:Score;sourceName:string;documentPath:string;warnings:string[];visible:number[];dirty:boolean;selected:Selection|null;noteSelected:boolean;range:Range|null;fragment:BeatRange|null;undo:EditState[];redo:EditState[];notation:'tab'|'both'|'standard';scale:number;speed:string;tick:number;top:number;left:number;layout?:LayoutSettings};
let activeDocument=1,documentCounter=1,closingDocument:number|null=null;
let documentViewport:{tick:number;top:number;left:number}|null=null;
function documentState():DocumentState{return {id:activeDocument,score,sourceName,documentPath,warnings,visible:[...visible],dirty,selected:structuredClone(selected),noteSelected,range:structuredClone(selectedRange),fragment:structuredClone(fragmentRange),undo:[...undo],redo:[...redo],notation,scale,speed:choose('speed').value,tick:pendingSeekTick??parkedTick??lastTick,top:$('score-scroll').scrollTop,left:$('score-scroll').scrollLeft,layout:{...getLayout(score),scale}};}
const documents:DocumentState[]=[documentState()];
function stashDocument(){const i=documents.findIndex(d=>d.id===activeDocument);if(i>=0)documents[i]=documentState();recoveryWorker.postMessage({cmd:'document',id:activeDocument,data:editSnapshot.get(score)});}
function documentMeta(){return documents.map(d=>{const current=d.id===activeDocument?documentState():d;const {score:ignored,undo:ignoredUndo,redo:ignoredRedo,...meta}=current;return meta;});}
function renderDocumentTabs(){const root=$('document-tabs');root.replaceChildren();for(const doc of documents){const active=doc.id===activeDocument,name=active?sourceName:doc.sourceName,title=active?score.title:doc.score.title,changed=active?dirty:doc.dirty,row=document.createElement('div');row.className='document-tab'+(active?' active':'');const tab=document.createElement('button');tab.role='tab';tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;tab.textContent=(changed?'• ':'')+(name==='New'||name==='Demo'?title||'Untitled':name);tab.title=(active?documentPath:doc.documentPath)||tab.textContent;tab.onclick=()=>activateDocument(doc.id);const close=document.createElement('button');close.className='tab-close';close.textContent='×';close.setAttribute('aria-label',`${tab.textContent}を閉じる`);close.onclick=()=>closeDocument(doc.id);row.append(tab,close);root.append(row);}root.querySelector('.active')?.scrollIntoView({block:'nearest',inline:'nearest'});}
function prepareDocumentSlot(replace=false,stash=true){finishInline(true);if(stash)stashDocument();cancelFretDraw();fretFeedback.clear();if(!replace&&!(documents.length===1&&sourceName==='Demo'&&!dirty)){activeDocument=++documentCounter;documents.push({...documentState(),id:activeDocument});}noteSelected=false;documentViewport=null;}
function activateDocument(id:number){if(id===activeDocument)return;extras?.documentChanged();const doc=documents.find(d=>d.id===id);if(!doc)return;finishInline(true,false,true);pauseHere(api.tickPosition);stashDocument();api.stop();pendingNavigation.length=0;reopenInline=false;activeDocument=id;score=doc.score;sourceName=doc.sourceName;documentPath=doc.documentPath;warnings=doc.warnings;visible=new Set(doc.visible);dirty=doc.dirty;selected=structuredClone(doc.selected);noteSelected=doc.noteSelected;selectedRange=structuredClone(doc.range);fragmentRange=structuredClone(doc.fragment);undo.splice(0,undo.length,...doc.undo);redo.splice(0,redo.length,...doc.redo);notation=doc.notation;scale=doc.scale;choose('speed').value=doc.speed;api.playbackSpeed=Number(doc.speed);api.settings.display.scale=scale;api.updateSettings();$('zoom').textContent=`${Math.round(scale*100)}%`;editSnapshot.invalidate();lastTick=doc.tick;pendingSeekTick=parkedTick=doc.tick;playbackStartTick=doc.tick;documentViewport={tick:doc.tick,top:doc.top,left:doc.left};resetLoop();$('dirty').textContent=dirty?'未保存の変更':'保存済み';updateHistory();clearMessage();void window.desktop?.activateDocument(documentPath).catch(e=>message(`ファイルの場所を確認できません：${e}`));render();if(dirty||documents.some(d=>d.dirty))scheduleRecovery();else{clearTimeout(recoveryTimer);localStorage.removeItem('tabstudio-recovery');rememberCleanProject();}}
function restoreDocumentViewport(){if(!documentViewport||rendering||midiLoadsPending||!api.isReadyForPlayback)return;const view=documentViewport;documentViewport=null;seekTo(view.tick);$('score-scroll').scrollTop=view.top;$('score-scroll').scrollLeft=view.left;}
function removeDocument(id:number){const i=documents.findIndex(d=>d.id===id);if(i<0)return;if(id===activeDocument){const next=documents[i+1]??documents[i-1];if(next)activateDocument(next.id);}documents.splice(i,1);recoveryWorker.postMessage({cmd:'remove',id});if(!documents.length){activeDocument=++documentCounter;documents.push({...documentState(),id:activeDocument});createNewDocument(true);dirty=false;$('dirty').textContent='保存済み';}renderDocumentTabs();if(dirty||documents.some(d=>d.dirty))scheduleRecovery();else{clearTimeout(recoveryTimer);localStorage.removeItem('tabstudio-recovery');}}
function closeDocument(id:number){finishInline(true);stashDocument();const doc=documents.find(d=>d.id===id);if(!doc)return;if(!doc.dirty){removeDocument(id);return;}closingDocument=id;showExitDialog(`「${doc.sourceName==='New'?doc.score.title:doc.sourceName}」に未保存の変更があります。`,'譜面を閉じる');}

function capture():EditState{return {data:editSnapshot.get(score),visible:[...visible],selected:structuredClone(selected),noteSelected,range:structuredClone(selectedRange),fragment:structuredClone(fragmentRange),layout:{...getLayout(score),scale}};}
function restore(state:EditState){score=restoreScore(state.data);if(state.layout){setLayout(score,state.layout);scale=state.layout.scale;api.settings.display.scale=scale;$('zoom').textContent=`${Math.round(scale*100)}%`;}editSnapshot.set(score,state.data,false);visible=restoredVisibility(state.visible,score.tracks.length);selected=structuredClone(state.selected);noteSelected=state.noteSelected;selectedRange=structuredClone(state.range);fragmentRange=structuredClone(state.fragment);}let digitBuffer='',digitTimer:ReturnType<typeof setTimeout>|undefined;
const status=(s:string)=>{if(startupComplete)$('status').textContent=s;};
function message(s:string){$('notice').textContent=s;$('notice').title=s;$('notice').classList.add('visible');status(s);}
function clearMessage(){$('notice').classList.remove('visible');}
function selectedBeat(s=score):Beat|undefined {if(!selected)return undefined;return s.tracks[selected.track]?.staves[selected.staff]?.bars[selected.bar]?.voices[selected.voice]?.beats[selected.beat];}
function selectedNote(s=score):Note|undefined {return selected?.surface==='standard'?selectedBeat(s)?.notes[selected.note??0]:selectedBeat(s)?.notes.find(n=>n.string===selected?.string);}
function markDirty(invalidate=true){editRevision++;if(invalidate)editSnapshot.invalidate();dirty=true;renderDocumentTabs();$('dirty').textContent='未保存の変更';updateHistory();scheduleRecovery();}
function updateContextControls(){for(const b of $('score-context').querySelectorAll<HTMLButtonElement>('[data-command]')){const id=b.dataset.command;b.disabled=id==='undo'?!undo.length||playing:id==='redo'?!redo.length||playing:id?.startsWith('paste')?!clipboard||playing:playing;}}
function updateHistory(){button('undo').disabled=!undo.length||playing;button('redo').disabled=!redo.length||playing;updateContextControls();}
let pendingRender:{reuseViewport:boolean;firstChangedMasterBar?:number;background:boolean}|null=null,lastRenderKey='';
function render(reuseViewport=false,firstChangedMasterBar?:number,background=false){applyLayout(api,score,getLayout(score));api.updateSettings();if(!background)cancelFretDraw();if(reuseViewport&&!documentViewport)documentViewport={tick:pendingSeekTick??parkedTick??lastTick,top:$('score-scroll').scrollTop,left:$('score-scroll').scrollLeft};rememberTrackView();if(rendering){const previous=pendingRender;pendingRender={background:background&&(previous?.background??true),reuseViewport:reuseViewport&&(previous?.reuseViewport??true),firstChangedMasterBar:previous?(previous.firstChangedMasterBar===undefined||firstChangedMasterBar===undefined?undefined:Math.min(previous.firstChangedMasterBar,firstChangedMasterBar)):firstChangedMasterBar};return;}const key=`${[...visible]}:${score.tracks.map(t=>trackNotation(t))}:${scale}`;if(key!==lastRenderKey)firstChangedMasterBar=undefined;lastRenderKey=key;rendering=true;softRendering=background;drawnFretRevision=fretRevision;button('play').disabled=true;api.renderScore(score,[...visible],{reuseViewport,firstChangedMasterBar});if(!background){updateHeader();renderTracks();}updateInspector();}
function updateHeader(){renderDocumentTabs();
  $('title').textContent=score.title||'Untitled';$('subtitle').textContent=`${score.artist?score.artist+' · ':''}${score.tracks.length} tracks · ${score.masterBars.length} measures`;
  $('source').textContent=sourceName==='Demo'?'DEMO':sourceName.split('.').at(-1)?.toUpperCase()||'PROJECT';
  value('loopStart').max=value('loopEnd').max=String(score.masterBars.length);updateTempoDisplay(selected?.bar??0);document.title=`${score.title||'Untitled'} — Tab Studio`;
}
function updateTempoDisplay(bar:number){let bpm=score.tempo;for(let i=0;i<=bar;i++)for(const a of score.masterBars[i]?.tempoAutomations||[])bpm=a.value;
  if(playing){const visit=api.tickCache?.masterBars.find(m=>m.start<=lastTick&&lastTick<m.end);for(const t of visit?.tempoChanges||[])if(t.tick<=lastTick)bpm=t.tempo;}
  if(document.activeElement!==value('song-tempo'))value('song-tempo').value=String(Math.round(score.tempo*100)/100);$('effective').textContent=`♩ = ${Math.round(bpm*api.playbackSpeed*100)/100}`;if(document.activeElement!==value('tempo'))value('tempo').value=String(Math.round(bpm));}
function fillInstrumentSelector(select:HTMLSelectElement,track:at.model.Track){
 const choices=new Map([[0,'Acoustic Grand Piano'],[1,'Bright Piano'],[4,'Electric Piano'],[5,'Electric Piano 2'],[16,'Organ'],[24,'Nylon Acoustic'],[25,'Steel Acoustic'],[26,'Jazz Clean'],[27,'Electric Clean'],[28,'Muted Guitar'],[29,'Overdrive'],[30,'Distortion'],[32,'Acoustic Bass'],[33,'Finger Bass'],[34,'Pick Bass']]);
 if(track.isPercussion){choices.clear();choices.set(track.playbackInfo.program,'Standard Drum Kit');}if(!choices.has(track.playbackInfo.program))choices.set(track.playbackInfo.program,`Original · GM ${track.playbackInfo.program+1}`);
 select.replaceChildren(...[...choices].map(([program,label])=>new Option(label,String(program))));select.value=String(track.playbackInfo.program);select.disabled=track.isPercussion;
}
function renderTracks(){
  const root=$('tracks');root.replaceChildren();
  score.tracks.forEach((track,index)=>{
    const card=document.createElement('div');card.className='track'+(selected?.track===index?' selected':'');
    const top=document.createElement('div');top.className='track-top';const shown=document.createElement('input');shown.type='checkbox';shown.checked=visible.has(index);shown.title='このトラックを譜面に表示';
    shown.onchange=()=>{if(playing){shown.checked=!shown.checked;return message('表示トラックの変更は停止中に行ってください。');}if(shown.checked)visible.add(index);else visible.delete(index);if(!visible.size){visible.add(index);shown.checked=true;}if(!visible.has(index)){if(fragmentRange?.anchor.track===index)fragmentRange=null;if(selectedRange?.track===index&&!selectedRange.allTracks)selectedRange=null;}render();};
    const name=document.createElement('span');name.className='track-name';name.textContent=track.name||`Track ${index+1}`;name.title=name.textContent;top.append(shown,name);card.append(top);
    const controls=document.createElement('div');controls.className='track-controls';
    for(const [label,field]of [['MUTE','isMute'],['SOLO','isSolo']]as const){const l=document.createElement('label');l.className='toggle';const c=document.createElement('input');c.type='checkbox';c.checked=track.playbackInfo[field];c.onchange=()=>{track.playbackInfo[field]=c.checked;if(field==='isMute')api.changeTrackMute([track],c.checked);else api.changeTrackSolo([track],c.checked);markDirty();};l.append(c,document.createTextNode(label));controls.append(l);}card.append(controls);
    const volume=document.createElement('input');volume.type='range';volume.min='0';volume.max='16';volume.value=String(track.playbackInfo.volume);volume.title='トラック音量';volume.oninput=()=>{track.playbackInfo.volume=Number(volume.value);api.changeTrackVolume([track],Number(volume.value)/8);markDirty();};controls.append(volume);
    const instrument=document.createElement('select');instrument.title='音色';fillInstrumentSelector(instrument,track);
    instrument.onchange=()=>commit(s=>setTrackInstrument(s,index,Number(instrument.value)),'音色を変更しました');card.append(instrument);const config=document.createElement('button');config.className='track-settings';config.textContent='⚙';config.title='トラック設定';config.setAttribute('aria-label',`${name.textContent}の設定`);config.onclick=()=>openTrackDialog(index);top.append(config);root.append(card);
  });
}
function updateInspector(){
  extras?.refresh();updateTempoDisplay(selected?.bar??0);showSelection();showRange();updatePalette?.(selectedBeat(),selectedNote(),playing);updateContextPalette?.(selectedBeat(),selectedNote(),playing);
}
function showSelection(){document.querySelector('.paper')!.classList.toggle('note-selected',(noteSelected||!$('score-context').hidden)&&!playing&&!fragmentRange&&!selectedRange);const marker=$('selection-marker'),b=selectedBeat();if(!b||!api.boundsLookup){marker.style.display='none';return;}if(rendering&&!softRendering){if(!noteSelected)marker.style.display='none';return;}const bounds=selected?.surface==='standard'?standardBounds(api.boundsLookup,b):tabBounds(api.boundsLookup,b);if(!bounds)return;
  const r=bounds.barBounds.visualBounds,n=b.voice.bar.staff.tuning.length,gap=n>1?r.h/(n-1):13;
  if(selected?.surface==='standard'){const y=standardY(bounds,selectedNote()?.realValueWithoutHarmonic??selected.pitch??60,selectedNote());marker.style.display='block';marker.style.left=`${bounds.onNotesX+$('score').offsetLeft-10}px`;marker.style.top=`${y+$('score').offsetTop-10}px`;return;}
  marker.style.display='block';marker.style.left=`${bounds.onNotesX+$('score').offsetLeft-10}px`;marker.style.top=`${r.y+(n-(selected?.string??n))*gap+$('score').offsetTop-10}px`;marker.style.width='20px';marker.style.height='20px';syncInlineMarker();
}
function flushDigits(){if(!digitBuffer)return;clearTimeout(digitTimer);const digits=digitBuffer;digitBuffer='';applyFret(Number(digits));}
function selectBeat(b:Beat,n?:Note,string?:number,surface:'tab'|'standard'=(b.voice.bar.staff.tuning.length&&!b.voice.bar.staff.isPercussion&&b.voice.bar.staff.showTablature?'tab':'standard'),pitch?:number,movePlayback=true){
  flushDigits();noteSelected=!!n;const ref={track:b.voice.bar.staff.track.index,staff:b.voice.bar.staff.index,bar:b.voice.bar.index,voice:b.voice.index,beat:b.index,string:string??n?.string??b.notes[0]?.string??b.voice.bar.staff.tuning.length};selected={...ref,surface,note:n?b.notes.findIndex(a=>a.id===n.id):surface==='standard'?-1:0,pitch:pitch??n?.realValueWithoutHarmonic??b.notes[0]?.realValueWithoutHarmonic??60};selectedRange=null;fragmentRange=null;updateInspector();for(const [i,card]of [...$('tracks').children].entries())card.classList.toggle('selected',selected.track===i);
  if(!movePlayback)return;
  const current=selectedBeat()!,visits=api.tickCache?.masterBars.filter(m=>m.masterBar.index===ref.bar)||[];
  const visit=(playing?visits.find(m=>m.start<=lastTick&&lastTick<m.end)??visits.find(m=>m.start>=lastTick):undefined)??visits[0];
  const tick=(visit?.start??current.voice.bar.masterBar.start)+current.playbackStart;
  if(playing&&api.playbackRange&&(tick<api.playbackRange.startTick||tick>=api.playbackRange.endTick)){extras?.normal();setLoop({...loopConfig,enabled:false});}
  extras?.manualSeek();seekTo(tick);

}
function commitIndependent(fn:(s:Score)=>void,text:string){const beat=selectedBeat();return beat&&canEditFretLocally(beat)?commitBeats([beat],()=>fn(score),text):commitLocal(fn,text);}
function commitLocal(fn:(s:Score)=>Score|void,success:string){return commit(fn,success,Math.max(0,(selected?.bar??0)-3));}
/** Independent beat edits share the fret path: no full-song reconstruction. */
function commitBeats(beats:Beat[],fn:()=>void,text:string){
 if(playing){message('一時停止してから編集してください。');return false;}if(!beats.length)return false;
 const before=capture();before.firstChangedBar=Math.max(0,Math.min(...beats.map(b=>b.voice.bar.index))-3);
 try{fn();for(const b of beats){b.finish(settings);editSnapshot.patchBeat(score,b);}undo.push(before);if(undo.length>60)undo.shift();redo.length=0;playbackDirty=true;markDirty(false);scheduleFretDraw(Math.min(...beats.map(b=>b.voice.bar.index)));updateInspector();status(text);return true;}catch(e){restore(before);render(true,before.firstChangedBar);message(e instanceof Error?e.message:String(e));return false;}
}
function commit(fn:(s:Score)=>Score|void, success:string,firstChangedBar?:number):boolean{
  if(playing){message('一時停止してから編集してください。');return false;}const before=capture();before.firstChangedBar=firstChangedBar;try{clearMessage();const result=fn(score),normalized=result?null:normalizeEdit(score),next=result??normalized!.score;undo.push(before);if(undo.length>60)undo.shift();redo.length=0;transferLayout(score,next);score=next;visible=restoredVisibility([...visible],score.tracks.length);if(selected){selected.bar=Math.min(selected.bar,score.masterBars.length-1);selected.track=Math.min(selected.track,score.tracks.length-1);}markDirty();if(normalized)editSnapshot.set(score,normalized.data);render(true,firstChangedBar);status(success);return true;}catch(error){restore(before);render(true,firstChangedBar);message(error instanceof Error?error.message:String(error));return false;}
}
function applyFret(fret:number){if(!selected||selectedNote()?.fret===fret)return;const string=selected.string;if(!Number.isInteger(fret)||fret<0||fret>36)return message('フレットは0〜36の整数で入力してください。');
  const beat=selectedBeat();
  if(!playing&&(!rendering||softRendering)&&beat&&canEditFretLocally(beat)){
    const before=capture();before.firstChangedBar=Math.max(0,beat.voice.bar.index-3);
    try{clearMessage();const note=editFretLocally(beat,string,fret);editSnapshot.patchBeat(score,beat);undo.push(before);if(undo.length>60)undo.shift();redo.length=0;noteSelected=true;playbackDirty=true;markDirty(false);fretFeedback.show(note,++fretRevision);scheduleFretDraw(beat.voice.bar.index);updateInspector();status('フレットを更新しました');return;}catch(error){restore(before);render(true,before.firstChangedBar);message(String(error));return;}
  }
  commitLocal(s=>{const b=selectedBeat(s)!;if(b.isFullBarRest){splitFullRest(b);selected!.beat=0;}setFret(selectedBeat(s)!,string,fret);noteSelected=true;},'フレットを更新しました');}
function deleteNote(){if(!selected)return;commitLocal(s=>{const b=selectedBeat(s);if(!b)return;b.notes=b.notes.filter((n,i)=>selected?.surface==='standard'?i!==(selected.note??0):n.string!==selected!.string);b.isEmpty=false;},'音符を削除しました');}
function applyDuration(duration:number){commitLocal(s=>{const b=selectedBeat(s);if(!b)throw new Error('音符を選択してください。');resizeBeat(b,duration,b.dots,b.tupletNumerator,b.tupletDenominator);},'音価を変更しました');}
let editingSongTempo=false;
function openTempoDialog(song=false){if(playing)return message('テンポの変更は停止中に行ってください。');finishInline(true);flushDigits();editingSongTempo=song;$('tempo-title').textContent=song?'曲のテンポ':`${(selected?.bar??0)+1}小節のテンポ`;$('tempo-hint').textContent=song?'曲の開始テンポを変更します。途中の小節に設定したテンポ変更は保持します。':'この小節の先頭からテンポを変更します。';$('tempo-error').textContent='';updateTempoDisplay(selected?.bar??0);if(song)value('tempo').value=String(score.tempo);$<HTMLDialogElement>('tempoDialog').showModal();value('tempo').focus();value('tempo').select();}
function commitSongTempoInput(){
 const bpm=Number(value('song-tempo').value);
 if(!value('song-tempo').value||!Number.isFinite(bpm)||bpm<20||bpm>400){message('テンポは20〜400で入力してください。');value('song-tempo').value=String(score.tempo);return false;}
 if(bpm===score.tempo)return true;
 if(playing){value('song-tempo').value=String(score.tempo);return false;}
 finishInline(true);return commit(s=>setSongTempo(s,bpm),'曲のテンポを変更しました');
}
value('song-tempo').onchange=commitSongTempoInput;value('song-tempo').onblur=commitSongTempoInput;
value('song-tempo').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();if(commitSongTempoInput())$('score-scroll').focus({preventScroll:true});}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();value('song-tempo').value=String(score.tempo);$('score-scroll').focus({preventScroll:true});}});
button('applyTempo').onclick=()=>{const bpm=Number(value('tempo').value);if(!Number.isFinite(bpm)||bpm<20||bpm>400){$('tempo-error').textContent='テンポは20〜400で入力してください。';return;}const index=selected?.bar??0;if(commit(s=>{if(editingSongTempo)setSongTempo(s,bpm);else s.masterBars[index].tempoAutomations=[at.model.Automation.buildTempoAutomation(false,0,bpm,2)];},editingSongTempo?'曲のテンポを変更しました':`${index+1}小節のテンポを設定しました`)){$<HTMLDialogElement>('tempoDialog').close();$('score-scroll').focus({preventScroll:true});}};
value('tempo').oninput=()=>{$('tempo-error').textContent='';};
function history(back:boolean){if(playing)return;const from=back?undo:redo,to=back?redo:undo;if(!from.length)return;const state=from.pop()!;to.push({...capture(),firstChangedBar:state.firstChangedBar});restore(state);resetLoop();markDirty();editSnapshot.set(score,state.data,false);render(true,state.firstChangedBar);}
button('undo').onclick=()=>history(true);button('redo').onclick=()=>history(false);

async function load(name:string,bytes:Uint8Array,openToken?:string,filePath=''){
  if(bytes.length>40*1024*1024)return message('40MBを超えるファイルは初期版では読み込めません。');
  try{finishInline(true);stashDocument();const existing=filePath&&documents.find(d=>(d.id===activeDocument?documentPath:d.documentPath).toLowerCase()===filePath.toLowerCase());if(existing){if(openToken)await window.desktop?.acceptOpen(openToken);activateDocument(existing.id);return true;}pendingNavigation.length=0;reopenInline=false;pauseHere();api.stop();pauseTarget=null;pendingSeekTick=null;parkedTick=null;playbackStartTick=0;status('読み込んでいます…');const ext=name.split('.').at(-1)?.toLowerCase();let result:{score:Score;warnings:string[]};
    if(ext==='tg')result=importTg(bytes);else if(ext==='tabstudio')result=readProject(new TextDecoder().decode(bytes));else result={score:importGuitarPro(bytes),warnings:['Guitar Proの特殊な奏法・音色・レイアウトは読み込みライブラリの対応範囲に従います。元ソフトと完全に同じ再生は保証していません。']};
    if(openToken)await window.desktop?.acceptOpen(openToken);else await window.desktop?.resetSavePath();prepareDocumentSlot(!startupComplete,false);clearTimeout(recoveryTimer);extras?.documentChanged();score=result.score;if(!/\.(tg|tabstudio)$/i.test(name))applyNotationDefaults(score,appSettings.notation);notation=appSettings.notation;scale=hasLayout(score)?getLayout(score).scale:appSettings.zoom;api.settings.display.scale=scale;api.updateSettings();$('zoom').textContent=`${Math.round(scale*100)}%`;warnings=result.warnings;sourceName=name;documentPath=filePath;restoreTrackView();selected=null;selectedRange=null;fragmentRange=null;undo.length=redo.length=0;dirty=false;$('dirty').textContent='読み込み済み';lastTick=0;resetLoop();if(startupComplete)render();clearMessage();if(warnings.length)message(`読み込みました。変換について${warnings.length}件の情報があります。「読み込み情報」で確認できます。`);else status('譜面を読み込みました');rememberCleanProject();if(documents.some(d=>d.id!==activeDocument&&d.dirty))scheduleRecovery();else localStorage.removeItem('tabstudio-recovery');await refreshRecentFiles();return true;
  }catch(error){message(`読み込みに失敗しました：${error instanceof Error?error.message:String(error)}`);}
}
button('open').onclick=async()=>{try{if(window.desktop){const file=await window.desktop.openScore();if(file)await load(file.name,new Uint8Array(file.bytes),file.openToken,file.path);}else value('fileInput').click();}catch(e){message(String(e));}};
async function loadFile(file:File){
  try{const path=window.desktop?.pathForFile(file);if(path){const opened=await window.desktop!.openFilePath(path);await load(opened.name,new Uint8Array(opened.bytes),opened.openToken,opened.path);}else await load(file.name,new Uint8Array(await file.arrayBuffer()));}catch(error){message(`ファイルを開けませんでした：${error}`);}
}
value('fileInput').onchange=async()=>{const file=value('fileInput').files?.[0];if(file)await loadFile(file);value('fileInput').value='';};
async function saveScore(saveAs=false):Promise<boolean>{try{flushDigits();finishInline(true);const bytes=exportTg(score,sourceName,warnings);let saved=false;if(window.desktop){const result=await window.desktop.saveScore({name:score.title||'Untitled',bytes,saveAs,path:documentPath});if(result){documentPath=result.path;sourceName=result.name;rememberTrackView();updateHeader();saved=true;}}else{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer],{type:'application/x-tuxguitar'}));a.download=(score.title||'Untitled')+'.tg';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);saved=true;}if(saved){clearTimeout(recoveryTimer);localStorage.removeItem('tabstudio-recovery');dirty=false;renderDocumentTabs();$('dirty').textContent='保存済み';status('TG譜面を保存しました');rememberCleanProject();stashDocument();if(documents.some(d=>d.dirty))scheduleRecovery();await refreshRecentFiles();}return saved;}catch(e){message(`保存できませんでした：${e}`);return false;}}
button('save').onclick=()=>saveScore();
function exportDescription(){const format=choose('export-format').value;$('pdf-settings').hidden=format!=='pdf';$('export-description').textContent=format==='pdf'?'表示中のトラックと譜面表示設定で、指定範囲をPDFに出力します。用紙・余白などは「レイアウト」で設定できます。':format==='mid'?'全トラックを曲本来のテンポでMIDIに出力します。練習速度・ループ範囲・クリック音は含みません。':'全トラックを出力します。GPはGuitar Pro 7形式、TGはTuxGuitar 2.0形式です。';}
function openExport(format?:'pdf'){
  finishInline(true);flushDigits();if(playing)pauseHere(api.tickPosition);
  if(format)choose('export-format').value=format;const layout=getLayout(score);if(![...choose('pdf-scale').options].some(o=>Number(o.value)===layout.scale))choose('pdf-scale').add(new Option(`${Math.round(layout.scale*100)}%`,String(layout.scale)));choose('pdf-scale').value=String(layout.scale);choose('pdf-orientation').value=layout.landscape?'landscape':'portrait';value('pdf-start').value=String((selectedRange?.start??0)+1);value('pdf-end').value=String((selectedRange?.end??score.masterBars.length-1)+1);value('pdf-start').max=value('pdf-end').max=String(score.masterBars.length);
  $('export-error').textContent='';exportDescription();$<HTMLDialogElement>('exportDialog').showModal();
}
const pdfLayoutButton=document.createElement('button');pdfLayoutButton.type='button';pdfLayoutButton.textContent='用紙・譜面レイアウト…';pdfLayoutButton.id='pdf-layout';$('pdf-settings').append(pdfLayoutButton);pdfLayoutButton.onclick=()=>{$<HTMLDialogElement>('exportDialog').close();extras?.open('scoreLayout');$<HTMLDialogElement>('layout-settings').addEventListener('close',()=>openExport('pdf'),{once:true});};
$<HTMLDialogElement>('exportDialog').addEventListener('cancel',e=>{if(button('export-apply').disabled)e.preventDefault();});
choose('export-format').onchange=()=>{exportDescription();$('export-error').textContent='';};
button('export-apply').onclick=async()=>{
  const format=choose('export-format').value as ScoreFormat|'pdf';
  button('export-apply').disabled=button('export-cancel').disabled=choose('export-format').disabled=true;
  $('export-error').textContent='書き出し中…';
  try{
    const name=score.title||'Untitled';let result:{name:string;path:string}|false;
    if(window.desktop)result=await window.desktop.exportScore(format==='pdf'?{name,format,scoreJson:serialize(score),tracks:[...visible],trackNames:score.tracks.map(t=>t.name),pdf:pdfOptions({...getLayout(score),layout:getLayout(score),start:Number(value('pdf-start').value),end:Number(value('pdf-end').value),scale:Number(choose('pdf-scale').value),landscape:choose('pdf-orientation').value==='landscape',separateTracks:value('pdf-separate').checked},score.masterBars.length)}:{name,format,bytes:exportScoreBytes(score,format,sourceName,warnings)});
    else{
      if(format==='pdf')throw new Error('PDF出力はデスクトップ版で利用できます。');
      const bytes=exportScoreBytes(score,format,sourceName,warnings),a=document.createElement('a');a.href=URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer]));a.download=name+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);result={name:a.download,path:a.download};
    }
    if(result){$<HTMLDialogElement>('exportDialog').close();status(`${result.name}を書き出しました`);}else $('export-error').textContent='書き出しをキャンセルしました。';
  }catch(error){$('export-error').textContent=`書き出せませんでした：${error instanceof Error?error.message:String(error)}`;}
  finally{button('export-apply').disabled=button('export-cancel').disabled=choose('export-format').disabled=false;}
};
function createNewDocument(replace=false){extras?.documentChanged();prepareDocumentSlot(replace);pendingNavigation.length=0;reopenInline=false;pauseHere();api.stop();pauseTarget=null;pendingSeekTick=null;parkedTick=null;playbackStartTick=0;window.desktop?.resetSavePath();score=at.importer.ScoreLoader.loadAlphaTex('\\title "Untitled" \\tempo 120 \\track "Guitar" \\instrument 27 . :4 r r r r | r r r r | r r r r | r r r r',settings);applyNotationDefaults(score,appSettings.notation);sourceName='New';notation=appSettings.notation;scale=hasLayout(score)?getLayout(score).scale:appSettings.zoom;api.settings.display.scale=scale;api.updateSettings();$('zoom').textContent=`${Math.round(scale*100)}%`;documentPath='';warnings=[];visible=new Set([0]);selected=null;selectedRange=null;fragmentRange=null;undo.length=redo.length=0;resetLoop();markDirty();render();clearMessage();rememberCleanProject();}
button('new').onclick=()=>createNewDocument();
button('addBar').onclick=()=>{if(commit(s=>insertBars(s,s.masterBars.length,1),'小節を追加しました'))resetLoop();};
button('addTrack').onclick=openAddTrack;


function pauseHere(target?:number){extras?.cancelCount();extras?.paused();notePreview.stop();const request=++playRequest;previewRequest++;queuedPlay=false;pauseTarget=target??null;
  // alphaTab starts its source after addModule resolves. Pause after that start
  // when Ctrl+Space arrives during the first few milliseconds of playback.
  if(audioStarting)void audioStarting.then(()=>{if(request===playRequest)api.pause();}).catch(e=>message(String(e)));else api.pause();
  if(!playing&&pauseTarget!==null){const tick=pauseTarget;pauseTarget=null;seekTo(tick);}}
function stopAtPlaybackStart(){extras?.normal();pauseHere(playbackStartTick);}

async function togglePlayback(){if(extras?.counting){pauseHere(playbackStartTick);return;}if(document.activeElement?.matches('#song-tempo,#loop-from,#loop-to'))(document.activeElement as HTMLElement).blur();finishInline(true);flushDigits();flushFretDraw();if(playing){pauseHere(api.tickPosition);return;}if(rendering||midiLoadsPending){queuedPlay=!queuedPlay;return;}if(!api.isReadyForPlayback)return message('音源と譜面の準備ができるまでお待ちください。');if(playbackDirty){documentViewport??={tick:pendingSeekTick??parkedTick??lastTick,top:$('score-scroll').scrollTop,left:$('score-scroll').scrollLeft};queuedPlay=true;api.loadMidiForScore();return;}clearMessage();$('hover-note').hidden=true;const request=++playRequest;api.player?.output.activate();const context=(api.player?.output as unknown as {context?:AudioContext})?.context;if(context)await prepareAudio(context);await clickAudio.resume();if(request!==playRequest)return;playbackStartTick=pendingSeekTick??parkedTick??api.tickPosition;notePreview.stop();if(extras)try{if(!await extras.beforePlay())return;}catch(e){message(e instanceof Error?e.message:String(e));return;}if(request!==playRequest)return;extras?.started();api.play();}
// User playback always leaves loop mode; queued and explicit loop starts keep it.
function toggleNormalPlayback(){if(extras?.counting){extras.normal();if(loopConfig.enabled||api.isLooping)setLoop({...loopConfig,enabled:false});pauseHere(playbackStartTick);return;}extras?.normal();if(document.activeElement?.matches('#song-tempo,#loop-from,#loop-to'))(document.activeElement as HTMLElement).blur();if(loopConfig.enabled||api.isLooping)setLoop({...loopConfig,enabled:false});void togglePlayback();}
button('play').onclick=toggleNormalPlayback;
button('stop').onclick=stopAtPlaybackStart;button('home').onclick=()=>{extras?.normal();pendingNavigation.length=0;reopenInline=false;pauseHere();api.stop();pauseTarget=null;pendingSeekTick=null;parkedTick=null;playbackStartTick=0;seekTo(0);$('score-scroll').scrollTo({top:0,left:0});};
choose('speed').onchange=()=>{extras?.normal();api.playbackSpeed=Number(choose('speed').value);updateTempoDisplay(selected?.bar??0);};
function updateClick(){const kind=choose('clickKind').value as ClickKind,volume=Number(value('clickVolume').value)/100,on=value('click').checked;api.metronomeVolume=on&&kind==='standard'?volume:0;clickAudio.configure(on,kind,volume);$('clickLevel').textContent=`${Math.round(volume*100)}%`;localStorage.setItem('tabstudio-click',JSON.stringify({kind,volume,on}));window.desktop?.setMenuState({click:on});}
value('click').onchange=updateClick;choose('clickKind').onchange=updateClick;value('clickVolume').oninput=updateClick;
api.midiEventsPlayedFilter=[at.midi.MidiEventType.AlphaTabMetronome];api.midiEventsPlayed.on(e=>{if(!playing)return;for(const ev of e.events)if(ev instanceof at.midi.AlphaTabMetronomeEvent)clickAudio.tick(ev.metronomeNumerator===0);});
function setLoop(config=loopConfig){
  const start=config.start-1,end=config.end-1;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>=score.masterBars.length){$('loop-error').textContent='開始・終了小節を曲の範囲内で指定してください。';return false;}
  if(config.enabled){const visits=api.tickCache?.masterBars||[],a=visits.find(m=>m.masterBar.index===start),b=visits.find(m=>m.masterBar.index===end&&m.start>=(a?.start??0));if(!a||!b){$('loop-error').textContent='再生データの準備ができるまでお待ちください。';return false;}api.playbackRange={startTick:a.start,endTick:b.end};api.isLooping=true;}
  else{api.isLooping=false;api.playbackRange=null;}
  loopConfig={...config};loopInputsDirty=false;value('loop').checked=config.enabled;value('loopStart').value=String(config.start);value('loopEnd').value=String(config.end);updateLoopControls();return true;
}
function resetLoop(){loopInputsDirty=false;loopConfig={start:1,end:score.masterBars.length,enabled:false};api.playbackRange=null;api.isLooping=false;value('loop').checked=false;value('loopStart').value='1';value('loopEnd').value=String(score.masterBars.length);updateLoopControls();}
function updateLoopControls(){
 const active=loopConfig.enabled&&playing;
 for(const id of ['loop-from','loop-to'])value(id).max=String(score.masterBars.length);if(!loopInputsDirty){value('loop-from').value=String(loopConfig.start);value('loop-to').value=String(loopConfig.end);for(const id of ['loop-from','loop-to'])value(id).removeAttribute('aria-invalid');}
 button('loop-play').textContent=active?'■ ループ停止':'↻ ループ再生';
 button('loop-play').setAttribute('aria-pressed',String(active));
 button('loop-play').setAttribute('aria-label',active?'ループ範囲の再生を停止':'ループ範囲を再生');
 button('loop-play').disabled=rendering||midiLoadsPending>0||!startupComplete||!api.isReadyForPlayback;
}
async function startLoopPlayback(){extras?.loopStarted();
 finishInline(true);flushDigits();if(!commitLoopInputs(true))return;
 if(rendering||midiLoadsPending||!api.isReadyForPlayback)return message('譜面の準備ができるまでお待ちください。');
 if(!setLoop({...loopConfig,enabled:true}))return message($('loop-error').textContent||'ループ範囲を確認してください。');
 const tick=api.playbackRange!.startTick;seekTo(tick);playbackStartTick=tick;
 if(!playing)await togglePlayback();else follower.focus();
 updateLoopControls();
}
function toggleLoopPlayback(){if(loopConfig.enabled&&playing){pauseHere(api.tickPosition);setLoop({...loopConfig,enabled:false});}else void startLoopPlayback();}
function commitLoopInputs(report=false){
 const from=value('loop-from'),to=value('loop-to'),start=Number(from.value),end=Number(to.value);
 const valid=!!from.value&&!!to.value&&Number.isInteger(start)&&Number.isInteger(end)&&start>=1&&end>=start&&end<=score.masterBars.length;
 for(const input of [from,to])input.setAttribute('aria-invalid',String(!valid));
 if(!valid){if(report)message('ループ範囲は開始・終了小節を曲の範囲内で入力してください。');return false;}
 if(start===loopConfig.start&&end===loopConfig.end){loopInputsDirty=false;return true;}
 return setLoop({...loopConfig,start,end});
}
for(const id of ['loop-from','loop-to']){
 const input=value(id);input.oninput=()=>{loopInputsDirty=true;input.removeAttribute('aria-invalid');};input.onchange=()=>commitLoopInputs();input.onblur=()=>commitLoopInputs();
 input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();if(commitLoopInputs(true))$('score-scroll').focus({preventScroll:true});}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();loopInputsDirty=false;updateLoopControls();$('score-scroll').focus({preventScroll:true});}});
}
button('loop-play').onclick=toggleLoopPlayback;
function openLoopDialog(){finishInline(true);flushDigits();value('loopStart').value=String(loopConfig.start);value('loopEnd').value=String(loopConfig.end);value('loop').checked=loopConfig.enabled;$('loop-error').textContent='';$<HTMLDialogElement>('loopDialog').showModal();}
button('loop-apply').onclick=()=>{if(setLoop({start:Number(value('loopStart').value),end:Number(value('loopEnd').value),enabled:value('loop').checked})){$<HTMLDialogElement>('loopDialog').close();if(loopConfig.enabled)void startLoopPlayback();$('score-scroll').focus({preventScroll:true});}};
for(const id of ['loopStart','loopEnd','loop'])value(id).oninput=()=>{$('loop-error').textContent='';};
button('current').onclick=()=>follower.focus();
function zoom(change:number){if(playing)return message('倍率の変更は停止中に行ってください。');scale=Math.max(.5,Math.min(1.5,Math.round((scale+change)*10)/10));api.settings.display.scale=scale;api.updateSettings();$('zoom').textContent=`${Math.round(scale*100)}%`;render();}
button('zoomIn').onclick=()=>zoom(.1);button('zoomOut').onclick=()=>zoom(-.1);
button('soundfont').onclick=()=>{if(playing)return message('一時停止してから音源を交換してください。');value('sfInput').click();};value('sfInput').onchange=async()=>{const file=value('sfInput').files?.[0];if(!file)return;if(file.size>200*1024*1024)return message('音源は200MB以下を選んでください。');const bytes=new Uint8Array(await file.arrayBuffer());api.loadSoundFont(bytes,false);notePreview.load(bytes);audioStatus=`読み込み中：${file.name}`;value('sfInput').value='';};
button('report').onclick=()=>{const dialog=$('reportDialog')as HTMLDialogElement;$('reportSource').textContent=sourceName;const ul=$('warnings');ul.replaceChildren();for(const warning of warnings.length?warnings:['読み込み時の警告はありません。']){const li=document.createElement('li');li.textContent=warning;ul.append(li);}dialog.showModal();};button('closeReport').onclick=()=>($('reportDialog')as HTMLDialogElement).close();$('reportDialog').onclick=e=>{if(e.target===$('reportDialog'))($('reportDialog')as HTMLDialogElement).close();};

api.error.on(error=>{rendering=false;softRendering=false;cancelFretDraw();fretFeedback.clear();midiLoadsPending=0;pendingRender=null;if(startupComplete)finishStartupLoading();message(`処理エラー：${error.message}`);});
api.renderStarted.on(()=>{rendering=true;button('play').disabled=true;updateLoopControls();});
api.postRenderFinished.on(()=>{rendering=false;softRendering=false;fretFeedback.drawn(drawnFretRevision);if(pendingRender){const pending=pendingRender;pendingRender=null;render(pending.reuseViewport,pending.firstChangedMasterBar,pending.background);return;}if(startupComplete)finishStartupLoading();if(pendingNavigation.length){ensureNavigationSelection();for(const key of pendingNavigation.splice(0)){if(rendering){pendingNavigation.push(key);continue;}if(/^[0-9]$/.test(key.key))enterDigit(key.key);else if(key.key==='Enter'){if(inline.hidden)beginInline();else{reopenInline=false;finishInline(true,true,true);}}else moveInScore(key);}}if(rendering)return;if(reopenInline){reopenInline=false;if(inline.hidden)beginInline();}button('play').disabled=!api.isReadyForPlayback||!startupComplete||midiLoadsPending>0;restoreDocumentViewport();updateLoopControls();showSelection();showRange();selectionStatus();if(queuedPlay&&!midiLoadsPending){queuedPlay=false;void togglePlayback();}});
// MIDI loading resets the synth position asynchronously. Restore only after
// both MIDI and layout finish; newer seeks update the pending viewport target.
api.midiLoad.on(()=>{playbackDirty=false;midiLoadsPending++;button('play').disabled=true;updateLoopControls();});
// Use alphaTab's DOM event: its 1.8.4 midiLoaded subscription invokes a recursive
// loadedMidiInfo getter on the Web Worker player.
$('score').addEventListener('alphaTab.midiFileLoaded',()=>{midiLoadsPending=Math.max(0,midiLoadsPending-1);if(loopConfig.enabled)setLoop();restoreDocumentViewport();updateLoopControls();button('play').disabled=rendering||!startupComplete||midiLoadsPending>0||!api.isReadyForPlayback;if(queuedPlay&&!rendering&&!midiLoadsPending){queuedPlay=false;void togglePlayback();}});
api.playerReady.on(()=>{restoreDocumentViewport();updateLoopControls();button('play').disabled=rendering||!startupComplete||midiLoadsPending>0;});
api.soundFontLoaded.on(()=>{audioStatus='音源の準備ができました';button('play').disabled=rendering||!startupComplete||midiLoadsPending>0||!api.isReadyForPlayback;});
api.playerStateChanged.on(args=>{playing=args.state===at.synth.PlayerState.Playing;document.querySelector('.paper')!.classList.toggle('playing',playing);if(!playing&&pauseTarget!==null){const tick=pauseTarget;pauseTarget=null;seekTo(tick);}if(playing){$('hover-note').hidden=true;}follower.setPlaying(playing);if(!playing)clickAudio.stop();button('play').textContent=playing?'Ⅱ 一時停止':'▶ 再生';button('play').setAttribute('aria-pressed',String(playing));updateInspector();updateHistory();button('addBar').disabled=button('addTrack').disabled=value('song-tempo').disabled=playing;updateLoopControls();status(playing?'再生中':'停止中');});
// TAB selection is handled by our string hit test, including empty string lines.
api.playedBeatChanged.on(beat=>{updateTempoDisplay(beat.voice.bar.index);});
function clock(milliseconds:number){const seconds=Math.floor(milliseconds/1000);return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
api.playerPositionChanged.on(args=>{if(playing&&!args.isSeek)parkedTick=null;if(args.isSeek&&pendingSeekTick!==null&&Math.abs(args.currentTick-pendingSeekTick)<2)pendingSeekTick=null;lastTick=args.currentTick;extras?.refresh();$('time').textContent=`${clock(args.currentTime)} / ${clock(args.endTime)}`;});

function noteEffect(field:'isPalmMute'|'isDead'|'isLetRing'|'isGhost'|'isHammerPullOrigin'|'vibrato'){(field==='isHammerPullOrigin'?commitLocal:commitIndependent)(s=>{const n=selectedNote(s);if(!n)throw new Error('音符を選択してください。');if(field==='vibrato')n.vibrato=n.vibrato===at.model.VibratoType.None?at.model.VibratoType.Slight:at.model.VibratoType.None;else n[field]=!n[field];},'奏法を更新しました');}
function changeDuration(longer:boolean){const b=selectedBeat();if(!b)return;const d=Math.max(1,Math.min(64,b.duration*(longer?.5:2)));commitLocal(s=>resizeBeat(selectedBeat(s)!,d,b.dots,b.tupletNumerator,b.tupletDenominator),'音価を変更しました');}
function dotted(){const b=selectedBeat();if(b)commitLocal(s=>resizeBeat(selectedBeat(s)!,b.duration,(b.dots+1)%3,b.tupletNumerator,b.tupletDenominator),'付点を変更しました');}
function triplet(){const b=selectedBeat();if(b)commitLocal(s=>resizeBeat(selectedBeat(s)!,b.duration,b.dots,b.hasTuplet?1:3,b.hasTuplet?1:2),'連符を変更しました');}
function cleanBeat(){commitLocal(s=>{const b=selectedBeat(s);if(b){b.notes=[];b.isEmpty=false;}},'拍を休符にしました');}
function insertRest(){commitLocal(s=>{const b=selectedBeat(s);if(!b)return;const voice=b.voice,i=b.index,following=voice.beats.slice(i),rest=following.find(x=>x.isRest);if(!rest)throw new Error('小節内に休符の余地がありません。');const q=beatQ(b),r=beatQ(rest);if(r<q)throw new Error('挿入する音価分の休符が足りません。');voice.beats.splice(voice.beats.indexOf(rest),1,...rests(r-q));voice.beats.splice(i,0,...rests(q));for(const x of voice.beats)x.voice=voice;},'休符を挿入しました');}
const inline=$('inline-fret')as HTMLInputElement;
let editingBarText=false;
function openTextDialog(barText:boolean){if(playing)return message('一時停止してからテキストを編集してください。');editingBarText=barText;$('text-title').textContent=barText?'小節マーカー':'音符のテキスト';value('text-value').value=barText?score.masterBars[selected?.bar??0].section?.text??'':selectedBeat()?.text??'';$<HTMLDialogElement>('textDialog').showModal();value('text-value').focus();}
button('text-apply').onclick=()=>{const text=value('text-value').value;if(commit(s=>{if(editingBarText){const m=s.masterBars[selected?.bar??0];m.section=text?Object.assign(new at.model.Section(),{text,marker:text}):null;}else{const beat=selectedBeat(s);if(beat)beat.text=text||null;}},'テキストを更新しました'))$<HTMLDialogElement>('textDialog').close();};
function activeRange():Range{if(selectedRange)return selectedRange;if(fragmentRange){const r=orderedRange(score,fragmentRange);return {start:r.start.bar,end:r.end.bar,track:r.start.track,allTracks:false};}return {start:selected?.bar??0,end:selected?.bar??0,track:selected?.track??[...visible][0],allTracks:false};}
function selectionStatus(){const text=fragmentRange?`${rangeBeats(score,fragmentRange).length}拍を選択 · Ctrl+C コピー / Ctrl+X 切り取り / Delete 休符化`:selectedRange?`${selectedRange.start+1}〜${selectedRange.end+1}小節を選択 · Ctrl+C コピー`:noteSelected?'Shift＋左右：半音上下 · Shift＋上下：弦を移動 · ドラッグ：範囲選択':'ドラッグ / Shift＋方向キー：拍の範囲選択 · Ctrl+C / X / V：コピー / 切り取り / 貼り付け';$('selection-summary').textContent=text;status(text);}
function showRange(){const root=$('range-highlight');root.replaceChildren();document.querySelector('.paper')!.classList.toggle('range-selected',!!(selectedRange||fragmentRange));if(rendering&&!softRendering||!api.boundsLookup)return;
  const offsetLeft=$('score').offsetLeft,offsetTop=$('score').offsetTop,rows=new Map<string,{left:number;right:number;top:number;height:number}>();
  const add=(left:number,right:number,top:number,height:number)=>{const key=`${top}:${height}`,old=rows.get(key);rows.set(key,{left:Math.min(left,old?.left??left),right:Math.max(right,old?.right??right),top,height});};
  if(fragmentRange){try{for(const b of rangeBeats(score,fragmentRange))for(const bb of api.boundsLookup.findBeats(b)??[]){const r=bb.barBounds.visualBounds,next=bb.barBounds.beats.filter(x=>x.beat.voice.index===b.voice.index&&x.onNotesX>bb.onNotesX+1).sort((a,b)=>a.onNotesX-b.onNotesX)[0],left=bb.onNotesX-10,right=next?next.onNotesX-10:r.x+r.w;add(left,Math.max(left+20,right),r.y-10,r.h+20);}}catch{fragmentRange=null;document.querySelector('.paper')!.classList.remove('range-selected');}}
  else if(selectedRange){const {start,end,track,allTracks}=selectedRange;for(const system of api.boundsLookup.staffSystems)for(const master of system.bars.filter(m=>m.index>=start&&m.index<=end))for(const bar of master.bars){const b=bar.bar??bar.beats[0]?.beat.voice.bar;if(!b||(!allTracks&&b.staff.track.index!==track))continue;const r=bar.visualBounds;add(r.x,r.x+r.w,r.y-5,r.h+10);}}
  for(const r of rows.values()){const el=document.createElement('div');el.style.left=`${r.left+offsetLeft}px`;el.style.top=`${r.top+offsetTop}px`;el.style.width=`${r.right-r.left}px`;el.style.height=`${r.height}px`;root.append(el);}selectionStatus();
}
function fineRange():BeatRange|null{ensureNavigationSelection();return fragmentRange??(selected?{anchor:{...selected},focus:{...selected}}:null);}
function extendRange(anchor:Selection|BeatRange['anchor']|null){if(!anchor||!selected||anchor.track!==selected.track||anchor.staff!==selected.staff||anchor.voice!==selected.voice)return;noteSelected=false;selectedRange=null;fragmentRange={anchor:{...anchor},focus:{...selected}};showSelection();showRange();}
function openRangeDialog(){finishInline(true);const r=activeRange();value('range-start').value=String(r.start+1);value('range-end').value=String(r.end+1);choose('range-scope').value=r.allTracks?'all':'current';$('range-error').textContent='';$<HTMLDialogElement>('rangeDialog').showModal();}
button('range-apply').onclick=()=>{try{const start=Number(value('range-start').value)-1,end=Number(value('range-end').value)-1;checkedRange(score,start,end);fragmentRange=null;selectedRange={start,end,track:selected?.track??[...visible][0],allTracks:choose('range-scope').value==='all'};showRange();$<HTMLDialogElement>('rangeDialog').close();$('score-scroll').focus();status(`${start+1}〜${end+1}小節を選択しました`);}catch(e){$('range-error').textContent=String(e instanceof Error?e.message:e);}};
function copySelection(){finishInline(true);flushDigits();try{if(selectedRange){const r=selectedRange;clipboard=copyBars(score,r.start,r.end,r.allTracks?null:r.track);status(`${r.start+1}〜${r.end+1}小節をコピーしました · ${r.allTracks?'全トラック':'選択トラック'}`);}else{const r=fineRange();if(!r)return;clipboard=copyBeats(score,r);status(`${clipboard.count}拍をコピーしました · Ctrl+Vで選択位置へ貼り付け`);}return true;}catch(e){message(String(e instanceof Error?e.message:e));return false;}}
function clearSelection(){finishInline(true);flushDigits();const r=selectedRange?{anchor:{track:selectedRange.track,staff:0,voice:0,bar:selectedRange.start,beat:0},focus:{track:selectedRange.track,staff:0,voice:0,bar:selectedRange.end,beat:score.tracks[selectedRange.track].staves[0].bars[selectedRange.end].voices[0].beats.length-1}}:fineRange();if(!r)return;
  commit(s=>{if(selectedRange){const tracks=selectedRange.allTracks?s.tracks:[s.tracks[selectedRange.track]];for(const t of tracks)for(const staff of t.staves)for(const bar of staff.bars.slice(selectedRange.start,selectedRange.end+1))for(const v of bar.voices)for(const b of v.beats){b.notes=[];b.isEmpty=false;b.chordId=null;b.text=null;}return;}return clearBeats(s,r);},'選択範囲を休符にしました');}
function cutSelection(){if(playing)return message('一時停止してから切り取ってください。');if(copySelection())clearSelection();}
function pasteSelection(insert=false){if(playing)return message('一時停止してから貼り付けてください。');if(!clipboard)return message('先に音符・休符または小節をコピーしてください。');finishInline(true);flushDigits();ensureNavigationSelection();if(!selected)return;const clip=clipboard,target={...selected,...(fragmentRange?orderedRange(score,fragmentRange).start:{}),note:0};
  if(clip.version===2){if(!insert){const fast=localPaste(score,clip,target);if(fast){commitBeats(fast.beats,()=>{fast.apply();fragmentRange={anchor:target,focus:{...target,bar:fast.beats.at(-1)!.voice.bar.index,beat:fast.beats.at(-1)!.index}};selectedRange=null;},'音符を貼り付けました');return;}}if(commit(s=>{const result=pasteBeats(s,clip,target,insert);fragmentRange=result.range;selectedRange=null;selected={...target,...result.range.anchor};return result.score;},insert?'音符を挿入して貼り付けました':'音符を貼り付けました',Math.max(0,target.bar-3)))resetLoop();return;}
  const index=selectedRange?.start??target.bar,track=selectedRange?.track??target.track;
  if(commit(s=>{if(!insert&&clip.allTracks&&index+clip.masterbars.length>s.masterBars.length)s=insertBars(s,s.masterBars.length,index+clip.masterbars.length-s.masterBars.length);const flexible=!insert&&!clip.allTracks&&(clip.masterbars.some((m,i)=>m.timesignaturenumerator!==s.masterBars[index+i]?.timeSignatureNumerator||m.timesignaturedenominator!==s.masterBars[index+i]?.timeSignatureDenominator)||clip.tracks[0].staves.some((staff:any,i:number)=>(staff.stringtuning?.tunings?.length??0)!==s.tracks[track].staves[i]?.tuning.length));const next=flexible?pasteMeasurePhrase(s,clip,{...target,track,bar:index,beat:0}):pasteBars(s,clip,index,track,insert);let end=index+clip.masterbars.length-1;if(flexible){let remaining=clip.masterbars.reduce((q,m)=>q+m.timesignaturenumerator*4/m.timesignaturedenominator,0);end=index;while(end<next.masterBars.length-1&&remaining>next.masterBars[end].timeSignatureNumerator*4/next.masterBars[end].timeSignatureDenominator+1e-7){remaining-=next.masterBars[end].timeSignatureNumerator*4/next.masterBars[end].timeSignatureDenominator;end++;}}selected={...target,bar:index,beat:0};fragmentRange=null;selectedRange={start:index,end,track,allTracks:clip.allTracks};return next;},insert?'小節を挿入して貼り付けました':'小節を貼り付けました',Math.max(0,index-3)))resetLoop();
}
function structureDone(index:number,track=selected?.track??0){selectedRange=null;fragmentRange=null;selected={track,staff:0,voice:0,bar:Math.max(0,Math.min(score.masterBars.length-1,index)),beat:0,string:score.tracks[track].staves[0].tuning.length,surface:selected?.surface??'tab'};resetLoop();updateInspector();}
function openBarDialog(){if(playing)return message('一時停止してから小節を挿入してください。');finishInline(true);$('bar-error').textContent='';$<HTMLDialogElement>('barDialog').showModal();}
button('bar-apply').onclick=()=>{const r=activeRange(),index=choose('bar-position').value==='before'?r.start:choose('bar-position').value==='after'?r.end+1:score.masterBars.length;if(commit(s=>insertBars(s,index,Number(value('bar-count').value)),'小節を挿入しました')){structureDone(index);$<HTMLDialogElement>('barDialog').close();}else $('bar-error').textContent=$('notice').textContent;};
function duplicateSelection(){finishInline(true);flushDigits();const r=activeRange();if(commit(s=>pasteBars(s,copyBars(s,r.start,r.end,r.allTracks?null:r.track),r.end+1,r.track,true),'選択小節を複製しました'))structureDone(r.end+1,r.track);}
function deleteSelection(){if(playing)return message('一時停止してから小節を削除してください。');finishInline(true);const r=activeRange();if(!confirm(`${r.start+1}〜${r.end+1}小節を全トラックから削除しますか？ Ctrl+Zで取り消せます。`))return;if(commit(s=>deleteBars(s,r.start,r.end),'小節を削除しました'))structureDone(r.start,r.track);}
function createTrack(kind:TrackKind|boolean){finishInline(true);const label=kind===true||kind==='bass'||kind==='bass5'?'ベース':kind==='drums'?'ドラム':kind==='keyboard'?'キーボード':'ギター';if(commit(s=>{const next=addTrack(s,kind);const track=next.tracks.at(-1)!;setTrackNotation(track,track.isPercussion||!track.staves[0].tuning.length?'standard':appSettings.notation);visible.add(next.tracks.length-1);return next;},label+'トラックを追加しました')){selectedRange=null;fragmentRange=null;}}

function openAddTrack(){if(playing)return message('一時停止してからトラックを追加してください。');finishInline(true,false,true);choose('add-track-kind').value='guitar';$<HTMLDialogElement>('addTrackDialog').showModal();}
button('add-track-apply').onclick=()=>{$<HTMLDialogElement>('addTrackDialog').close();createTrack(choose('add-track-kind').value as TrackKind);};
function currentTrackIndex(){return selected?.track??[...visible][0]??0;}
function openDuplicateTrack(){if(playing)return message('一時停止してからトラックを複製してください。');finishInline(true,false,true);const select=choose('duplicate-track-source');select.replaceChildren();for(const track of score.tracks)select.add(new Option(`${track.index+1}: ${track.name||'Track'}`,String(track.index)));select.value=String(currentTrackIndex());$('duplicate-track-error').textContent='';$<HTMLDialogElement>('duplicateTrackDialog').showModal();}
function duplicateCurrentTrack(index:number){finishInline(true);return commit(s=>{const next=duplicateTrack(s,index);visible=new Set([...visible].map(i=>i>index?i+1:i));visible.add(index+1);const staff=next.tracks[index+1].staves[0],bar=Math.min(selected?.bar??0,next.masterBars.length-1),note=staff.bars[bar].voices[0].beats[0].notes[0];selected={track:index+1,staff:0,bar,voice:0,beat:0,string:note?.string??staff.tuning.length,surface:staff.isPercussion||!staff.tuning.length||!staff.showTablature?'standard':'tab',note:0,pitch:note?.realValueWithoutHarmonic??60};noteSelected=false;selectedRange=null;fragmentRange=null;return next;},'トラックを複製しました');}
button('duplicate-track-apply').onclick=()=>{if(duplicateCurrentTrack(Number(choose('duplicate-track-source').value)))$<HTMLDialogElement>('duplicateTrackDialog').close();else $('duplicate-track-error').textContent=$('notice').textContent;};
function deleteCurrentTrack(){finishInline(true);const index=currentTrackIndex();commit(s=>{const next=removeTrack(s,index);visible=new Set([...visible].filter(i=>i!==index).map(i=>i>index?i-1:i));if(!visible.size)visible.add(Math.min(index,next.tracks.length-1));selected=null;noteSelected=false;selectedRange=null;fragmentRange=null;return next;},'トラックを削除しました。取り消しで戻せます。');}
let editingTrackIndex=0;
function openTrackDialog(index:number){if(playing)return message('一時停止してからトラック設定を開いてください。');finishInline(true);editingTrackIndex=index;fillTrackDialog();$<HTMLDialogElement>('trackDialog').showModal();}
function fillTrackDialog(){const index=editingTrackIndex,t=score.tracks[index],staff=t.staves[0];$('track-title').textContent=`トラック設定 — ${t.name||`Track ${index+1}`}`;value('track-name').value=t.name||`Track ${index+1}`;fillInstrumentSelector(choose('track-instrument'),t);const mode=choose('track-notation');for(const option of mode.options)option.disabled=option.value!=='standard'&&(t.isPercussion||!staff.tuning.length);mode.value=trackNotation(t);value('track-string-count').value=String(staff.tuning.length);value('track-tuning').value=staff.tuning.map(pitchName).join(' ');value('track-capo').value=String(staff.capo);choose('track-preset').value='custom';$('track-strings').hidden=!staff.tuning.length||t.isPercussion;button('track-up').disabled=index===0;button('track-down').disabled=index===score.tracks.length-1;button('track-delete').disabled=score.tracks.length===1;$('track-error').textContent='';}
choose('track-preset').onchange=()=>{const tuning=tuningPresets[choose('track-preset').value];if(tuning){value('track-string-count').value=String(tuning.length);value('track-tuning').value=tuning.map(pitchName).join(' ');}};
value('track-string-count').onchange=()=>{try{const count=Number(value('track-string-count').value);if(!Number.isInteger(count)||count<1||count>12)throw new Error('弦数は1〜12です。');let pitches=value('track-tuning').value.trim().split(/\s+/).map(parsePitch);pitches=pitches.slice(0,count);while(pitches.length<count)pitches.push(Math.max(0,(pitches.at(-1)??45)-5));value('track-tuning').value=pitches.map(pitchName).join(' ');choose('track-preset').value='custom';$('track-error').textContent='';}catch(e){$('track-error').textContent=String(e instanceof Error?e.message:e);}};
button('track-apply').onclick=()=>{try{const index=editingTrackIndex,staff=score.tracks[index].staves[0],tuning=staff.tuning.length?value('track-tuning').value.trim().split(/\s+/).map(parsePitch):[60];if(staff.tuning.length&&tuning.length!==Number(value('track-string-count').value))throw new Error('弦数とチューニングの音名の数を合わせてください。');if(commit(s=>{const next=configureTrack(s,index,{name:value('track-name').value,tuning,capo:Number(value('track-capo').value)}),program=Number(choose('track-instrument').value);if(program!==s.tracks[index].playbackInfo.program)setTrackInstrument(next,index,program);const mode=choose('track-notation').value as TrackNotation;setTrackNotation(next.tracks[index],mode);if(selected?.track===index){const note=selectedNote(next);selected.note=note?next.tracks[index].staves[selected.staff].bars[selected.bar].voices[selected.voice].beats[selected.beat].notes.indexOf(note):0;selected.surface=mode==='standard'?'standard':mode==='tab'?'tab':selected.surface;selected.pitch=note?.realValueWithoutHarmonic??selected.pitch??60;}return next;},'トラック設定を適用しました')){openTrackDialogRefresh(index);$('track-error').textContent='適用しました';}else $('track-error').textContent=$('notice').textContent;}catch(e){$('track-error').textContent=String(e instanceof Error?e.message:e);}};
function openTrackDialogRefresh(index:number){editingTrackIndex=index;fillTrackDialog();}
function reorderTrack(direction:-1|1){const index=editingTrackIndex,destination=index+direction;const remap=(i:number)=>i===index?destination:i===destination?index:i;if(commit(s=>{const next=moveTrack(s,index,destination);visible=new Set([...visible].map(remap));if(selected)selected.track=remap(selected.track);if(selectedRange)selectedRange.track=remap(selectedRange.track);if(fragmentRange){fragmentRange.anchor.track=remap(fragmentRange.anchor.track);fragmentRange.focus.track=remap(fragmentRange.focus.track);}return next;},'トラックを並べ替えました'))openTrackDialogRefresh(destination);else $('track-error').textContent=$('notice').textContent;}
button('track-up').onclick=()=>reorderTrack(-1);button('track-down').onclick=()=>reorderTrack(1);
button('track-delete').onclick=()=>{const index=editingTrackIndex;if(!confirm(`「${score.tracks[index].name}」を削除しますか？ Ctrl+Zで取り消せます。`))return;if(commit(s=>{const next=removeTrack(s,index);visible=new Set([...visible].filter(i=>i!==index).map(i=>i>index?i-1:i));selected=null;selectedRange=null;fragmentRange=null;return next;},'トラックを削除しました'))$<HTMLDialogElement>('trackDialog').close();else $('track-error').textContent=$('notice').textContent;};
function changePitch(pitch:number,add=false,string=0,accidental?:number){if(!selected)return;const reference=selected.note??0;if(commitIndependent(s=>{let beat=selectedBeat(s)!;if(beat.isFullBarRest){splitFullRest(beat);selected!.beat=0;beat=selectedBeat(s)!;}const result=setPitch(beat,pitch,reference,add,string);if(accidental!==undefined)beat.notes[result.index].accidentalMode=accidental<0?at.model.NoteAccidentalMode.ForceFlat:accidental>0?at.model.NoteAccidentalMode.ForceSharp:at.model.NoteAccidentalMode.ForceNatural;selected!.note=result.index;selected!.string=result.string;selected!.pitch=pitch;noteSelected=true;},'音高を変更しました')){const note=selectedNote();if(note)void auditionNote(note);return true;}return false;}
function openPitchDialog(){if(!selected||playing)return;const pitch=selectedNote()?.realValueWithoutHarmonic??selected.pitch??60,name=pitchName(pitch),m=/^([A-G])(#?)(-?\d+)$/.exec(name)!;choose('pitch-name').value=m[1];choose('pitch-accidental').value=m[2]? '1':'0';value('pitch-octave').value=m[3];value('pitch-add').checked=selected.note===-1&&!!selectedBeat()?.notes.length;const staff=selectedBeat()!.voice.bar.staff,strings=choose('pitch-string');strings.replaceChildren(new Option('自動','0'));for(let i=staff.tuning.length;i>=1;i--)strings.add(new Option(`${staff.tuning.length-i+1}弦 (${pitchName(staff.tuning[staff.tuning.length-i])})`,String(i)));strings.value=String(selectedNote()?.string??0);$('pitch-string-label').hidden=!staff.tuning.length;$('pitch-error').textContent='';$<HTMLDialogElement>('pitchDialog').showModal();}
button('pitch-apply').onclick=()=>{try{const natural=({C:0,D:2,E:4,F:5,G:7,A:9,B:11}[choose('pitch-name').value]!),pitch=(Number(value('pitch-octave').value)+1)*12+natural+Number(choose('pitch-accidental').value);if(changePitch(pitch,value('pitch-add').checked,Number(choose('pitch-string').value),Number(choose('pitch-accidental').value)))$<HTMLDialogElement>('pitchDialog').close();else $('pitch-error').textContent=$('notice').textContent;}catch(e){$('pitch-error').textContent=String(e);}};
function openDrumDialog(){const n=selectedNote(),list=choose('drum-sound');list.replaceChildren(...drumSounds.map(([id,label])=>new Option(label,String(id))));list.value=String(n?.percussionArticulation??38);if(!list.value)list.value='38';value('drum-add').checked=!n&&!!selectedBeat()?.notes.length;$('drum-error').textContent='';$<HTMLDialogElement>('drumDialog').showModal();}
button('drum-apply').onclick=()=>{if(commitLocal(s=>{let b=selectedBeat(s)!;if(b.isFullBarRest){splitFullRest(b);selected!.beat=0;b=selectedBeat(s)!;}selected!.note=setDrum(b,Number(choose('drum-sound').value),selected!.note??0,value('drum-add').checked);selected!.string=-1;selected!.pitch=Number(choose('drum-sound').value);noteSelected=true;},'ドラム音を更新しました')){$<HTMLDialogElement>('drumDialog').close();const note=selectedNote();if(note)void auditionNote(note);}else $('drum-error').textContent=$('notice').textContent;};
// Keep native keyboard/IME handling invisible; only the score position is painted.
function syncInlineMarker(){
  const input=$('inline-fret')as HTMLInputElement,visual=$('fret-entry-marker');
  visual.hidden=input.hidden;if(input.hidden)return;
  const position=$('selection-marker');
  input.style.left=visual.style.left=position.style.left;
  input.style.top=visual.style.top=position.style.top;
  visual.textContent=input.value;
  visual.classList.toggle('invalid',input.getAttribute('aria-invalid')==='true');
}
function beginInline(){if(playing||rendering&&!softRendering||!selected)return;noteSelected=!!selectedNote();selectedRange=null;fragmentRange=null;showRange();if(selectedBeat()?.voice.bar.staff.isPercussion){openDrumDialog();return;}if(selected.surface==='standard'){openPitchDialog();return;}flushDigits();showSelection();const m=$('selection-marker');if(m.style.display==='none')return;inline.value=selectedNote()?String(selectedNote()!.fret):'';inline.removeAttribute('aria-invalid');inline.hidden=false;syncInlineMarker();inline.focus({preventScroll:true});inline.select();inline.scrollIntoView({block:'nearest',inline:'nearest'});}
function enterDigit(key:string){if(rendering&&!softRendering){pendingNavigation.push({key,ctrlKey:false,shiftKey:false});return;}if(inline.hidden){beginInline();if(inline.hidden)return;inline.value=key;}else inline.value=(inline.value+key).slice(-2);inline.dispatchEvent(new Event('input',{bubbles:true}));}
function openInlineWhenReady(){if(rendering&&!softRendering)reopenInline=true;else beginInline();}
function finishInline(apply:boolean,emptyAsRest=false,audition=false){if(inline.hidden)return;clearTimeout(digitTimer);const fret=inline.value.trim();inline.hidden=true;syncInlineMarker();previewRequest++;if(apply&&emptyAsRest&&!fret){notePreview.stop();if(selectedBeat()?.notes.length)cleanBeat();}else if(apply&&/^\d{1,2}$/.test(fret)&&Number(fret)<=36){applyFret(Number(fret));const note=selectedNote();if(audition&&note?.fret===Number(fret))void auditionNote(note);}$('score-scroll').focus({preventScroll:true});}
async function auditionNote(note:Note){if(playing||!appSettings.preview)return;const request=++previewRequest;await clickAudio.resume();if(request!==previewRequest||playing)return;try{await notePreview.play(note);}catch(error){message(`音の試聴に失敗しました：${error}`);}}
inline.addEventListener('beforeinput',e=>{if(e.data!==null&&/\D/.test(e.data))e.preventDefault();});
inline.addEventListener('paste',e=>{if(/\D/.test(e.clipboardData?.getData('text/plain')??''))e.preventDefault();});
inline.addEventListener('drop',e=>e.preventDefault());
inline.addEventListener('input',()=>{
  // Non-cancelable IME/autofill events also pass through the digit-only boundary.
  const raw=inline.value,start=inline.selectionStart??raw.length,digits=raw.replace(/\D/g,'').slice(0,2);
  if(raw!==digits){inline.value=digits;const caret=Math.min(digits.length,raw.slice(0,start).replace(/\D/g,'').length);inline.setSelectionRange(caret,caret);}
  const valid=/^\d{1,2}$/.test(digits)&&Number(digits)<=36;
  inline.setAttribute('aria-invalid',String(!!digits&&!valid));syncInlineMarker();
});
function ensureNavigationSelection(){
  if(selected&&!playing&&visible.has(selected.track))return;
  const tracks=selected&&visible.has(selected.track)?new Set([selected.track]):visible;
  const beat=api.tickCache?.findBeat(tracks,pendingSeekTick??parkedTick??api.tickPosition)?.beat??score.tracks[[...tracks][0]]?.staves[0].bars[0].voices[0].beats[0];
  if(!beat)return;const staff=beat.voice.bar.staff;
  selected={track:staff.track.index,staff:staff.index,bar:beat.voice.bar.index,voice:beat.voice.index,beat:beat.index,string:selected?.string??beat.notes[0]?.string??staff.tuning.length,surface:!staff.showTablature?'standard':staff.showStandardNotation?selected?.surface??'tab':'tab',note:0,pitch:beat.notes[0]?.realValueWithoutHarmonic??selected?.pitch??60};updateInspector();
}
function moveInScore(e:NavigationKey){
 const action=e.command??shortcutCommand(appSettings.shortcuts,[e.ctrlKey&&'Ctrl',e.shiftKey&&'Shift',e.key.replace('Arrow','')].filter(Boolean).join('+'));
 if(['transposeUp','transposeDown','stringUp','stringDown'].includes(action??'')&&!playing&&noteSelected&&!fragmentRange&&!selectedRange&&selectedNote()){
  const wasEditing=!inline.hidden;finishInline(true);if(wasEditing)reopenInline=true;if(rendering){pendingNavigation.push({...e,key:e.key,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey});return;}
  transformSelected(action!);return;
 }
 if(['stemUp','stemDown'].includes(action??'')&&!playing&&noteSelected){finishInline(true);if(rendering){pendingNavigation.push({...e});return;}setStem(action==='stemUp'?1:-1);return;}

  const reopen=!e.shiftKey&&(selected?.surface??(selectedBeat()?.voice.bar.staff.showTablature?'tab':'standard'))!=='standard'&&(!inline.hidden||!playing);
  finishInline(true,false,true);flushDigits();
  if(rendering&&!softRendering){pendingNavigation.push({key:e.key,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey});if(reopen)reopenInline=true;return;}
  ensureNavigationSelection();const anchor=fragmentRange?.anchor??(selected?{...selected}:null);
  if(e.shiftKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){const b=selectedBeat(),next=b&&api.boundsLookup&&adjacentTabRow(api.boundsLookup,b,e.key==='ArrowUp'?-1:1);if(next)selectNavigationBeat(next,false);}
  else navigateSelection(e);
  if(e.shiftKey)extendRange(anchor);else{fragmentRange=null;selectedRange=null;showRange();}
  const b=selectedBeat(),bb=b&&api.boundsLookup&&(selected?.surface==='standard'?standardBounds(api.boundsLookup,b):tabBounds(api.boundsLookup,b));if(bb){const scroll=$('score-scroll'),viewport=scroll.getBoundingClientRect(),sheet=$('score').getBoundingClientRect(),top=sheet.top+bb.barBounds.visualBounds.y;if(top<viewport.top+30||top+bb.barBounds.visualBounds.h>viewport.bottom-30)scroll.scrollTop+=top-viewport.top-viewport.height*.35;}
  if(documentViewport){documentViewport.top=$('score-scroll').scrollTop;documentViewport.left=$('score-scroll').scrollLeft;}
  if(reopen&&!playing)openInlineWhenReady();
}
function selectNavigationBeat(b:Beat,movePlayback=true){selectBeat(b,selected?.surface==='standard'?b.notes[0]:noteSelected?b.notes.find(n=>n.string===selected?.string):undefined,selected?.string,selected?.surface,selected?.pitch,movePlayback);}
function navigateSelection(e:NavigationKey){
  const b=selectedBeat();if(!b||!selected)return;const movePlayback=!e.shiftKey;
  if(playing&&(e.key==='ArrowUp'||e.key==='ArrowDown')){const next=api.boundsLookup&&adjacentTabRow(api.boundsLookup,b,e.key==='ArrowUp'?-1:1);if(next)selectNavigationBeat(next,movePlayback);return;}
  if(e.ctrlKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){const i=e.shiftKey?(e.key==='ArrowLeft'?0:score.masterBars.length-1):Math.max(0,Math.min(score.masterBars.length-1,selected.bar+(e.key==='ArrowLeft'?-1:1)));const next=b.voice.bar.staff.bars[i].voices[selected.voice]?.beats[0];if(next)selectNavigationBeat(next,movePlayback);return;}
  if(e.key==='ArrowLeft'&&b.previousBeat)selectNavigationBeat(b.previousBeat,movePlayback);if(e.key==='ArrowRight'&&b.nextBeat)selectNavigationBeat(b.nextBeat,movePlayback);
  if(selected.surface==='standard'&&(e.key==='ArrowUp'||e.key==='ArrowDown')){if(b.voice.bar.staff.isPercussion)return;changePitch(diatonicPitch(selectedNote()?.realValueWithoutHarmonic??selected.pitch??60,e.key==='ArrowUp'?1:-1));return;}
  if(e.key==='ArrowUp'||e.key==='ArrowDown'){selected.string=Math.max(1,Math.min(b.voice.bar.staff.tuning.length,selected.string+(e.key==='ArrowUp'?1:-1)));updateInspector();}
}
inline.addEventListener('keydown',e=>{
  e.stopPropagation();
  if(e.key==='Enter'){e.preventDefault();finishInline(true,true,true);}if(e.key==='Escape'){e.preventDefault();finishInline(false);}
});
inline.addEventListener('blur',()=>finishInline(true,false,true));
$('score').addEventListener('mousemove',e=>{
  const marker=$('hover-note');marker.hidden=true;if(playing||rendering||!api.boundsLookup)return;
  const rect=$('score').getBoundingClientRect(),hit=hitTab(api.boundsLookup,e.clientX-rect.left,e.clientY-rect.top,selected?.voice??0);
  if(!hit){const h=hitStandard(api.boundsLookup,e.clientX-rect.left,e.clientY-rect.top,selected?.voice??0);if(h&&Math.abs(e.clientX-rect.left-h.bounds.onNotesX)<=16){marker.style.left=`${h.bounds.onNotesX+$('score').offsetLeft-12}px`;marker.style.top=`${h.y+$('score').offsetTop-10}px`;marker.hidden=false;}return;}const r=hit.bounds.barBounds.visualBounds,n=hit.beat.voice.bar.staff.tuning.length,y=r.y+(n-hit.string)*r.h/(n-1);
  if(Math.abs(e.clientX-rect.left-hit.bounds.onNotesX)>16)return;
  marker.style.left=`${hit.bounds.onNotesX+$('score').offsetLeft-12}px`;marker.style.top=`${y+$('score').offsetTop-10}px`;marker.hidden=false;
});
$('score').addEventListener('mouseleave',()=>{$('hover-note').hidden=true;});
// Commands use one configurable binding table, before focused controls consume keys.
window.addEventListener('keydown',e=>{
 if(!$('loading-indicator').hidden){if(!(e.altKey&&e.key==='F4')){e.preventDefault();e.stopImmediatePropagation();}return;}
 if(e.isComposing||document.querySelector('dialog[open]'))return;
 const command=shortcutCommand(appSettings.shortcuts,keyCombo(e)),target=e.target as HTMLElement;
 // Clipboard shortcuts edit the active fret value; score shortcuts remain global elsewhere.
 if(target===inline&&(e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&/^[acvx]$/i.test(e.key))return;
 const typing=target.matches('textarea,input:not([type=range]):not([type=checkbox]):not([type=button])')&&target!==inline;
 if(command&&(!typing||['play','stop'].includes(command))){
  // Plain characters continue to edit fret values; playback and navigation stay global.
  if(target===inline&&e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.key.startsWith('Arrow')&&!['play','stop'].includes(command))return;
  e.preventDefault();e.stopImmediatePropagation();if(e.repeat&&['play','stop','trackAdd','trackDuplicate','trackDelete'].includes(command))return;closeMenus();
  if(['transposeUp','transposeDown','stringUp','stringDown','stemUp','stemDown'].includes(command)){
   const keys:Record<string,string>={transposeUp:'ArrowRight',transposeDown:'ArrowLeft',stringUp:'ArrowUp',stringDown:'ArrowDown',stemUp:'ArrowUp',stemDown:'ArrowDown'};
   moveInScore({key:keys[command],ctrlKey:command.startsWith('stem'),shiftKey:!command.startsWith('stem'),command});
  }else runCommand(command);
  return;
 }
 if(!typing&&!e.altKey&&!e.metaKey&&e.key.startsWith('Arrow')){e.preventDefault();e.stopImmediatePropagation();closeMenus();moveInScore(e);if(inline.hidden)$('score-scroll').focus({preventScroll:true});return;}
 if(e.altKey&&!selectedBeat()?.voice.bar.staff.isPercussion&&selected?.surface==='standard'&&(e.key==='ArrowUp'||e.key==='ArrowDown')&&!typing){e.preventDefault();e.stopImmediatePropagation();changePitch((selectedNote()?.realValueWithoutHarmonic??selected.pitch??60)+(e.key==='ArrowUp'?1:-1));}
},true);
function pickScore(e:MouseEvent){if(rendering&&!softRendering||!api.boundsLookup)return false;const rect=$('score').getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
  const tab=hitTab(api.boundsLookup,x,y,selected?.voice??0),staff=tab?null:hitStandard(api.boundsLookup,x,y,selected?.voice??0),hit=tab??staff;if(!hit)return false;
  const anchor=fragmentRange?.anchor??(selected?{...selected}:null);finishInline(true,false,true);
  const surface=staff?'standard':'tab',string=tab?.string;
  const extending=e.shiftKey&&e.type!=='dblclick'&&(!anchor||anchor.track===hit.beat.voice.bar.staff.track.index&&anchor.staff===hit.beat.voice.bar.staff.index&&anchor.voice===hit.beat.voice.index);
  const tabNote=tab&&Math.abs(x-tab.bounds.onNotesX)<14?hit.beat.notes.find(n=>n.string===string):undefined;selectBeat(hit.beat,staff?.note??tabNote,string,surface,staff?.pitch,!extending);
  if(e.shiftKey&&e.type!=='dblclick'){extendRange(anchor??selected);$('score-scroll').focus({preventScroll:true});return true;}
  if(playing)return true;
  $('score-scroll').focus({preventScroll:true});return true;
}
let popupArmedKey:string|null=null,popupCandidate:{x:number;y:number}|null=null;
function selectedPositionKey(){return selected?`${activeDocument}:${selected.track}:${selected.staff}:${selected.bar}:${selected.voice}:${selected.beat}:${selected.string}:${selected.surface}:${selected.note}`:'';}
let dragSelection:{anchor:Selection;playbackTick:number;x:number;y:number;currentX:number;currentY:number;active:boolean}|null=null,dragFrame=0,dragNeedsUpdate=false;
const dragCandidates=new WeakMap<at.rendering.BoundsLookup,Map<string,at.rendering.BeatBounds[]>>();
function updateDrag(){const d=dragSelection;if(!d?.active||playing||rendering||!api.boundsLookup)return;const rect=$('score').getBoundingClientRect(),viewport=$('score-scroll').getBoundingClientRect(),x=Math.max(viewport.left+8,Math.min(viewport.right-8,d.currentX))-rect.left,y=Math.max(viewport.top+8,Math.min(viewport.bottom-8,d.currentY))-rect.top;
  const lookup=api.boundsLookup,key=`${d.anchor.track}:${d.anchor.staff}:${d.anchor.voice}:${d.anchor.surface}`;let lanes=dragCandidates.get(lookup);if(!lanes){lanes=new Map();dragCandidates.set(lookup,lanes);}let candidates=lanes.get(key);if(!candidates){candidates=score.tracks[d.anchor.track].staves[d.anchor.staff].bars.flatMap(bar=>(bar.voices[d.anchor.voice]?.beats??[]).flatMap(b=>{const bb=d.anchor.surface==='standard'?standardBounds(lookup,b):tabBounds(lookup,b);return bb?[bb]:[];}));lanes.set(key,candidates);}
  const distance=(b:typeof candidates[number])=>{const r=b.barBounds.visualBounds,dy=Math.max(r.y-y,0,y-r.y-r.h);return dy*dy*16+(b.onNotesX-x)**2;};const bb=candidates.reduce<typeof candidates[number]|undefined>((a,b)=>!a||distance(b)<distance(a)?b:a,undefined);if(!bb)return;
  const p=bb.beat;if(fragmentRange&&selected?.bar===p.voice.bar.index&&selected?.beat===p.index)return;if(selected?.bar!==p.voice.bar.index||selected?.beat!==p.index){selectBeat(p,d.anchor.surface==='standard'?p.notes[0]:undefined,d.anchor.string,d.anchor.surface,d.anchor.pitch,false);}extendRange(d.anchor);$('hover-note').hidden=true;
}
function dragScroll(){dragFrame=0;const d=dragSelection;if(!d?.active)return;const scroll=$('score-scroll'),r=scroll.getBoundingClientRect(),delta=d.currentY<r.top+48?-Math.min(20,(r.top+48-d.currentY)*.4):d.currentY>r.bottom-48?Math.min(20,(d.currentY-r.bottom+48)*.4):0;const dx=d.currentX<r.left+32?-Math.min(16,(r.left+32-d.currentX)*.4):d.currentX>r.right-32?Math.min(16,(d.currentX-r.right+32)*.4):0;if(delta||dx){scroll.scrollTop+=delta;scroll.scrollLeft+=dx;dragNeedsUpdate=true;}if(dragNeedsUpdate){dragNeedsUpdate=false;updateDrag();}dragFrame=requestAnimationFrame(dragScroll);}
function scorePointerDown(e:MouseEvent){if(e.button!==0)return;const armed=popupArmedKey,playbackTick=pendingSeekTick??parkedTick??api.tickPosition;if(pickScore(e)){e.preventDefault();e.stopImmediatePropagation();const same=armed&&armed===selectedPositionKey();popupCandidate=same&&!e.shiftKey&&!playing?{x:e.clientX,y:e.clientY}:null;if(!same)popupArmedKey=null;if(!playing&&selected){dragSelection={anchor:{...selected,...(e.shiftKey?fragmentRange?.anchor:{})},playbackTick,x:e.clientX,y:e.clientY,currentX:e.clientX,currentY:e.clientY,active:false};}}}
$('score').addEventListener('mousedown',scorePointerDown,true);inline.addEventListener('mousedown',e=>{if(popupArmedKey===selectedPositionKey())scorePointerDown(e);});
window.addEventListener('mousemove',e=>{const d=dragSelection;if(!d)return;if(!(e.buttons&1)){dragSelection=null;cancelAnimationFrame(dragFrame);return;}d.currentX=e.clientX;d.currentY=e.clientY;if(!d.active&&Math.hypot(e.clientX-d.x,e.clientY-d.y)>=5){d.active=true;popupCandidate=null;popupArmedKey=null;finishInline(true);seekTo(d.playbackTick);dragFrame=requestAnimationFrame(dragScroll);}if(d.active){e.preventDefault();dragNeedsUpdate=true;}});
window.addEventListener('mouseup',()=>{const popup=popupCandidate&&!dragSelection?.active?popupCandidate:null;popupCandidate=null;if(dragSelection?.active)updateDrag();if(dragSelection?.active)$('score-scroll').focus({preventScroll:true});dragSelection=null;cancelAnimationFrame(dragFrame);if(popup)showContext(popup.x,popup.y);});
window.addEventListener('blur',()=>{dragSelection=null;cancelAnimationFrame(dragFrame);});
$('score').addEventListener('dblclick',e=>{if(pickScore(e)){e.preventDefault();if(!playing)popupArmedKey=selectedPositionKey();if(selected?.surface!=='standard'||!selectedNote())openInlineWhenReady();}},true);
function scoreContextMenu(e:MouseEvent){let inside=false;if(api.boundsLookup){const rect=$('score').getBoundingClientRect(),hit=hitTab(api.boundsLookup,e.clientX-rect.left,e.clientY-rect.top,selected?.voice??0)??hitStandard(api.boundsLookup,e.clientX-rect.left,e.clientY-rect.top,selected?.voice??0),b=hit?.beat;if(b){inside=!!(fragmentRange&&rangeBeats(score,fragmentRange).some(n=>n.id===b.id)||selectedRange&&b.voice.bar.index>=selectedRange.start&&b.voice.bar.index<=selectedRange.end&&(selectedRange.allTracks||b.voice.bar.staff.track.index===selectedRange.track));}}if(!inside&&!pickScore(e))return;e.preventDefault();popupArmedKey=selectedPositionKey();showContext(e.clientX,e.clientY);}
$('score').addEventListener('contextmenu',scoreContextMenu);inline.addEventListener('contextmenu',scoreContextMenu);
window.addEventListener('keydown',e=>{
 if(document.querySelector('dialog[open]')||e.isComposing)return;
 const form=(e.target as HTMLElement).matches('input,select,textarea');if(form)return;
 if(e.key==='Escape'){selectedRange=null;fragmentRange=null;showRange();finishInline(false);pauseHere();closeMenus();return;}
 if(e.ctrlKey||e.metaKey||e.altKey||!selected||playing)return;
 const key=e.key.toLowerCase();
 if(selected.surface==='standard'&&!selectedBeat()?.voice.bar.staff.isPercussion&&e.shiftKey&&/^[a-g]$/.test(key)){e.preventDefault();const old=selectedNote()?.realValueWithoutHarmonic??selected.pitch??60;changePitch((Math.floor(old/12)*12)+({c:0,d:2,e:4,f:5,g:7,a:9,b:11}[key]!));return;}
 if(selected.surface==='standard'&&/^[0-9]$/.test(e.key)){e.preventDefault();return;}
 if(/^[0-9]$/.test(e.key)){e.preventDefault();enterDigit(e.key);return;}
 if(rendering&&!softRendering&&e.key==='Enter'){e.preventDefault();pendingNavigation.push({key:e.key,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey});return;}
 flushDigits();if(e.key==='Enter'){e.preventDefault();beginInline();}
});
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',async e=>{e.preventDefault();const f=e.dataTransfer?.files[0];if(f)await loadFile(f);});
let recoveryTimer:ReturnType<typeof setTimeout>|undefined,recoveryRevision=0;
const recoveryWorker=new Worker(new URL('./recovery.worker.ts',import.meta.url),{type:'module'});
recoveryWorker.onmessage=(event:MessageEvent<{revision:number;json:string}>)=>{if(!(dirty||documents.some(d=>d.dirty))||event.data.revision!==recoveryRevision)return;try{localStorage.setItem('tabstudio-recovery',event.data.json);localStorage.setItem('tabstudio-recovery-path',documentPath);}catch{}};
function scheduleRecovery(){clearTimeout(recoveryTimer);const revision=++recoveryRevision;const persist=()=>{if(revision!==recoveryRevision||!(dirty||documents.some(d=>d.dirty)))return;if(rendering){recoveryTimer=setTimeout(persist,100);return;}recoveryWorker.postMessage({revision,data:editSnapshot.get(score),sourceName,warnings,activeDocument,documents:documentMeta()});};recoveryTimer=setTimeout(persist,700);}
window.addEventListener('beforeunload',e=>{if(dirty&&!window.desktop){e.preventDefault();e.returnValue='';}});
window.tabStudio={api,preview:notePreview,getScore:()=>score,getState:()=>({title:score.title,tracks:score.tracks.length,bars:score.masterBars.length,playing,rendering:rendering||pendingFretBar!==null,ready:api.isReadyForPlayback&&startupComplete&&midiLoadsPending===0,dirty,lastTick,warnings,selected,editMode:true,notation,visibleTracks:[...visible],selectedRange,fragmentRange,noteSelected,documents:documents.map(d=>({id:d.id,name:d.id===activeDocument?sourceName:d.sourceName,dirty:d.id===activeDocument?dirty:d.dirty,active:d.id===activeDocument})),loading:!$('loading-indicator').hidden,settings:structuredClone(appSettings)}),load,serialize:()=>cachedProject(),select:(bar:number,beat:number,track=0)=>selectBeat(score.tracks[track].staves[0].bars[bar].voices[0].beats[beat]),selectNote:(bar:number,beat:number,track=0)=>{const b=score.tracks[track].staves[0].bars[bar].voices[0].beats[beat];selectBeat(b,b.notes[0]);},activateDocument,closeDocument};
api.metronomeVolume=0;updateClick();


function transformSelected(id:string){if(!selectedNote())return message('音符を選択してください。');const reopen=!inline.hidden;finishInline(true);const ok=commitIndependent(s=>{const n=selectedNote(s)!;if(id==='stringUp'||id==='stringDown')shiftString(n,id==='stringUp'?1:-1);else transposeNote(n,id==='transposeUp'?1:-1);selected!.string=n.string;selected!.note=n.index;selected!.pitch=n.realValueWithoutHarmonic;noteSelected=true;},'音符を移動しました');if(!ok)return;const n=selectedNote();if(n){selected!.note=selectedBeat()!.notes.indexOf(n);selected!.pitch=n.realValueWithoutHarmonic;noteSelected=true;showSelection();void auditionNote(n);}if(reopen)reopenInline=true;}
function setStem(direction:number){commitIndependent(s=>{const b=selectedBeat(s);if(!b)throw new Error('音符を選択してください。');b.preferredBeamDirection=direction===0?null:direction>0?at.rendering.BeamDirection.Up:at.rendering.BeamDirection.Down;},'符尾の向きを更新しました');}
function moveNote(direction:-1|1){commit(s=>{const note=selectedNote(s),beat=selectedBeat(s),to=direction<0?beat?.previousBeat:beat?.nextBeat;if(!note||!beat||!to)throw new Error('移動先の拍がありません。');if(to.notes.some(n=>n.string===note.string&&note.string>0))throw new Error('移動先の弦には音符があります。');beat.notes.splice(beat.notes.indexOf(note),1);beat.isEmpty=false;note.isTieDestination=false;note.tieOrigin=null;to.addNote(note);to.isEmpty=false;selected={...selected!,bar:to.voice.bar.index,beat:to.index,note:note.index};noteSelected=true;},'音符を1拍移動しました');}
let notationKind='';
function openNotation(kind:string){finishInline(true);if(playing)return message('一時停止してから編集してください。');ensureNavigationSelection();notationKind=kind;const m=score.masterBars[selected?.bar??0],b=selectedBeat()?.voice.bar,root=$('notation-fields');root.replaceChildren();const field=(label:string,id:string,options:[string,number][],current:number)=>{const l=document.createElement('label'),select=document.createElement('select');l.textContent=label;select.id=id;for(const [name,n]of options)select.add(new Option(name,String(n)));select.value=String(current);l.append(select);root.append(l);};const number=(label:string,id:string,current:number,min:number,max:number)=>{const l=document.createElement('label'),input=document.createElement('input');l.textContent=label;input.id=id;input.type='number';input.min=String(min);input.max=String(max);input.value=String(current);l.append(input);root.append(l);};
 $('notation-title').textContent=({clef:'音部記号',key:'調号',swing:'スウィング・フィール',repeatEnd:'リピート終了',endings:'カッコ'} as Record<string,string>)[kind];choose('notation-scope').parentElement!.hidden=kind==='repeatEnd'||kind==='endings';choose('notation-scope').value='following';
 if(kind==='clef')field('音部記号','clef-value',[['ト音記号',4],['ヘ音記号',3],['ハ音記号（アルト）',1],['ハ音記号（テナー）',2],['打楽器',0]],b?.clef??4);
 if(kind==='key'){field('調号','key-value',[['♭7 C♭ / A♭m',-7],['♭6 G♭ / E♭m',-6],['♭5 D♭ / B♭m',-5],['♭4 A♭ / Fm',-4],['♭3 E♭ / Cm',-3],['♭2 B♭ / Gm',-2],['♭1 F / Dm',-1],['なし C / Am',0],['♯1 G / Em',1],['♯2 D / Bm',2],['♯3 A / F♯m',3],['♯4 E / C♯m',4],['♯5 B / G♯m',5],['♯6 F♯ / D♯m',6],['♯7 C♯ / A♯m',7]],b?.keySignature??0);field('種類','key-mode',[['長調',0],['短調',1]],b?.keySignatureType??0);}
 if(kind==='swing')field('フィール','swing-value',[['ストレート',0],['16分音符スウィング',1],['8分音符スウィング',2],['16分音符・付点',3],['8分音符・付点',4],['16分音符・逆付点',5],['8分音符・逆付点',6]],m.tripletFeel);
 if(kind==='repeatEnd')number('繰り返す回数（0で解除）','repeat-count',m.repeatCount||2,0,32);
 if(kind==='endings'){const group=document.createElement('div');group.className='ending-options';for(let i=0;i<8;i++){const label=document.createElement('label'),c=document.createElement('input');label.className='toggle';c.type='checkbox';c.value=String(1<<i);c.checked=!!(m.alternateEndings&(1<<i));label.append(c,document.createTextNode(String(i+1)+'番'));group.append(label);}root.append(group);}
 $('notation-error').textContent='';$<HTMLDialogElement>('notationDialog').showModal();
}
button('notation-apply').onclick=()=>{const index=selected?.bar??0,last=choose('notation-scope').value==='following'?score.masterBars.length-1:index,kind=notationKind;const ok=commit(s=>{if(kind==='repeatEnd'){const count=Number(value('repeat-count').value);if(!Number.isInteger(count)||count<0||count>32||count===1)throw new Error('繰り返し回数は2〜32、解除は0で指定してください。');s.masterBars[index].repeatCount=count;return;}if(kind==='endings'){s.masterBars[index].alternateEndings=[...document.querySelectorAll<HTMLInputElement>('.ending-options input:checked')].reduce((sum,c)=>sum|Number(c.value),0);return;}for(let i=index;i<=last;i++){if(kind==='swing')s.masterBars[i].tripletFeel=Number(choose('swing-value').value);else{const bar=s.tracks[selected?.track??0].staves[selected?.staff??0].bars[i];if(kind==='clef')bar.clef=Number(choose('clef-value').value);else{bar.keySignature=Number(choose('key-value').value);bar.keySignatureType=Number(choose('key-mode').value);}}}},'譜面の記号を更新しました');if(ok)$<HTMLDialogElement>('notationDialog').close();else $('notation-error').textContent=$('notice').textContent;};
function openSignature(){finishInline(true);ensureNavigationSelection();const m=score.masterBars[selected?.bar??0];value('signature-numerator').value=String(m.timeSignatureNumerator);choose('signature-denominator').value=String(m.timeSignatureDenominator);$('signature-error').textContent='';$<HTMLDialogElement>('signatureDialog').showModal();}

function openTranspose(){finishInline(true);const r=activeRange();choose('transpose-scope').value=selectedRange||fragmentRange?'selected':'all';value('transpose-semitones').value='0';value('transpose-all-tracks').checked=true;value('transpose-chords').checked=true;value('transpose-strings').checked=true;$('transpose-selection').textContent=`選択した小節：${r.start+1}${r.end!==r.start?'〜'+(r.end+1):''}小節`;$('transpose-error').textContent='';$<HTMLDialogElement>('transposeDialog').showModal();}
button('transpose-apply').onclick=()=>{const r=activeRange(),all=choose('transpose-scope').value==='all',semitones=Number(value('transpose-semitones').value);if(semitones===0){$<HTMLDialogElement>('transposeDialog').close();return;}const ok=commit(s=>{transposeScore(s,{semitones,start:all?0:r.start,end:all?s.masterBars.length-1:r.end,track:r.track,allTracks:value('transpose-all-tracks').checked,chords:value('transpose-chords').checked,keepStrings:value('transpose-strings').checked});if(selected){const n=selectedNote(s);if(n)selected.pitch=n.realValueWithoutHarmonic;}},'移調しました');if(ok)$<HTMLDialogElement>('transposeDialog').close();else $('transpose-error').textContent=$('notice').textContent;};

function openChord(){finishInline(true);ensureNavigationSelection();const b=selectedBeat();if(!b)return;const chord=b.chord;value('chord-name').value=chord?.name??'';value('chord-frets').value=chord?.strings.map(n=>n<0?'x':String(n)).join(' ')??Array(b.voice.bar.staff.tuning.length).fill('x').join(' ');value('chord-diagram').checked=chord?.showDiagram??true;$('chord-error').textContent='';$<HTMLDialogElement>('chordDialog').showModal();}
button('chord-apply').onclick=()=>{if(commitLocal(s=>{const b=selectedBeat(s);if(!b)throw new Error('音符を選択してください。');const name=value('chord-name').value.trim(),frets=value('chord-frets').value.trim().split(/\s+/).filter(Boolean).map(v=>v.toLowerCase()==='x'?-1:Number(v));if(!name)throw new Error('コード名を入力してください。');if(frets.length!==b.voice.bar.staff.tuning.length||frets.some(n=>!Number.isInteger(n)||n< -1||n>36))throw new Error('上の弦から各弦のフレットを指定してください。ミュートはxです。');const chord=new at.model.Chord();chord.name=name;chord.strings=frets;chord.showName=true;chord.showDiagram=value('chord-diagram').checked;chord.firstFret=(frets.some(n=>n>0)?Math.min(...frets.filter(n=>n>0)):1);const id='studio-'+Date.now();b.voice.bar.staff.addChord(id,chord);b.chordId=id;},'コードを更新しました'))$<HTMLDialogElement>('chordDialog').close();else $('chord-error').textContent=$('notice').textContent;};
button('chord-remove').onclick=()=>{if(commitLocal(s=>{const b=selectedBeat(s);if(b)b.chordId=null;},'コード表示を削除しました'))$<HTMLDialogElement>('chordDialog').close();};
type MenuItem={id:string;label:string;shortcut?:string;check?:()=>boolean;title?:string;disabled?:boolean;children?:(MenuItem|null)[];icon?:string};
const viewState={tracks:true,noteEditor:true,transport:true,titleInfo:true,statusbar:true};
try{Object.assign(viewState,JSON.parse(localStorage.getItem('tabstudio-view')||'{}'));}catch{}
function updateView(){
  $('tracks-panel').hidden=!viewState.tracks;$('note-panel').hidden=!viewState.noteEditor;$('left-dock').hidden=!viewState.tracks&&!viewState.noteEditor;document.querySelector('.workspace')!.classList.toggle('dock-hidden',$('left-dock').hidden);(document.querySelector('.transport')as HTMLElement).hidden=!viewState.transport;
  (document.querySelector('.document-toolbar')as HTMLElement).hidden=!viewState.titleInfo;(document.querySelector('.statusbar')as HTMLElement).hidden=!viewState.statusbar;
  localStorage.setItem('tabstudio-view',JSON.stringify(viewState));window.desktop?.setMenuState({...viewState,follow:appSettings.follow,click:value('click').checked});
}
const durationItems:MenuItem[]=[1,2,4,8,16,32,64].map((d,i)=>({id:`duration${d}`,label:d===1?'全音符':`${d}分音符`,icon:noteIcon(d),shortcut:`Ctrl+${[1,2,4,5,6,7,8][i]}`,check:()=>selectedBeat()?.duration===d}));
const effectItems:MenuItem[]=[['palm','パームミュート','P'],['deadNote','デッドノート','X'],['ghost','ゴーストノート','O'],['hammer','ハンマリング / プリング','H'],['vibrato','ビブラート','V'],['ring','レットリング',''],['bend','ベンド',''],['slide','スライド',''],['harmonic','ナチュラルハーモニクス',''],['staccato','スタッカート',''],['trill','トリル',''],['tremolo','トレモロピッキング',''],['tap','タッピング',''],['slap','スラップ',''],['pop','ポッピング',''],['fade','フェードイン',''],['brush','ブラッシング','']].map(([id,label,shortcut])=>({id,label,shortcut}));
const noteMenuItems:(MenuItem|null)[]=[{id:'duration-menu',label:'音価',children:[...durationItems,null,{id:'dotted',label:'付点',shortcut:'*',check:()=>selectedBeat()?.dots===1},{id:'doubleDot',label:'複付点',check:()=>selectedBeat()?.dots===2},{id:'tie',label:'タイ',shortcut:'L',check:()=>!!selectedNote()?.isTieDestination},{id:'tuplets',label:'連符',children:[{id:'tuplet1',label:'なし'},...[2,3,5,6,7,9,10,11,12].map(n=>({id:`tuplet${n}`,label:`${n}連符`,check:()=>selectedBeat()?.tupletNumerator===n}))]}]},
 {id:'dynamics-menu',label:'強弱記号',children:['ppp','pp','p','mp','mf','f','ff','fff'].map((label,i)=>({id:`dynamic${i}`,label,check:()=>selectedBeat()?.dynamics===i}))},{id:'effects-menu',label:'エフェクト/テクニック',children:effectItems},{id:'chord-menu',label:'コード',children:[{id:'chord',label:'コードを編集…'},{id:'chordRemove',label:'コードを削除'}]},null,
 {id:'text',label:'テキスト挿入',shortcut:'T'},{id:'stemAuto',label:'符尾の向きの自動調整'},{id:'stemUp',label:'符尾の向きを上にする',shortcut:'Ctrl+Up'},{id:'stemDown',label:'符尾の向きを下にする',shortcut:'Ctrl+Down'},null,{id:'strokeUp',label:'アップストローク',icon:'↑'},{id:'strokeDown',label:'ダウンストローク',icon:'↓'},null,
 {id:'transposeUp',label:'半音上げる',shortcut:'Shift+Right'},{id:'transposeDown',label:'半音下げる',shortcut:'Shift+Left'},{id:'stringUp',label:'上弦にシフト',shortcut:'Shift+Up'},{id:'stringDown',label:'下弦にシフト',shortcut:'Shift+Down'},null,{id:'moveBefore',label:'1拍左へ移動する'},{id:'moveAfter',label:'1拍右へ移動する'}];
const menus:{label:string;items:(MenuItem|null)[]}[]=[
 {label:'ファイル',items:[{id:'new',label:'新規譜面',shortcut:'Ctrl+N'},{id:'open',label:'開く…',shortcut:'Ctrl+O'},null,{id:'save',label:'保存',shortcut:'Ctrl+S'},{id:'saveAs',label:'名前を付けて保存…',shortcut:'Ctrl+Shift+S'},null,{id:'export',label:'書き出し…'},{id:'exportPdf',label:'PDFに出力…'},null,{id:'report',label:'読み込み情報…'},{id:'closeDocument',label:'譜面を閉じる',shortcut:'Ctrl+W'},null,{id:'exit',label:'終了',shortcut:'Alt+F4'}]},
 {label:'編集',items:[{id:'undo',label:'取り消し',shortcut:'Ctrl+Z'},{id:'redo',label:'やり直し',shortcut:'Ctrl+Y'},null,{id:'range',label:'小節の範囲選択…'},{id:'copyBars',label:'コピー',shortcut:'Ctrl+C'},{id:'cut',label:'切り取り',shortcut:'Ctrl+X'},{id:'pasteBars',label:'貼り付け',shortcut:'Ctrl+V'},{id:'pasteInsert',label:'挿入して貼り付け',shortcut:'Ctrl+Shift+V'},{id:'specialPaste',label:'形式を選んで貼り付け…'},null,{id:'inline',label:'選択音符を編集',shortcut:'Enter'},{id:'deleteNote',label:'音符を削除',shortcut:'Delete'},{id:'clean',label:'拍を休符にする',shortcut:'Ctrl+Delete'},{id:'rest',label:'休符を挿入',shortcut:'Insert'}]},
 {label:'表示',items:[{id:'sectionNavigator',label:'曲構成'},{id:'noteInput',label:'鍵盤・ドラム入力'},{id:'scoreLayout',label:'譜面・印刷レイアウト…'},null,{id:'noteEditor',label:'編集',check:()=>viewState.noteEditor},{id:'tracks',label:'トラック',check:()=>viewState.tracks},{id:'transport',label:'再生コントロール',check:()=>viewState.transport},{id:'titleInfo',label:'曲の情報',check:()=>viewState.titleInfo},{id:'statusbar',label:'ステータスバー',check:()=>viewState.statusbar},null,{id:'resetPanels',label:'パネル表示を標準に戻す'},null,{id:'zoomIn',label:'拡大'},{id:'zoomOut',label:'縮小'},{id:'zoomReset',label:'100%に戻す'},null,{id:'showAllTracks',label:'すべてのトラックを表示'},{id:'showCurrentTrack',label:'選択トラックのみ表示'},null,{id:'scoreTop',label:'譜面の先頭を表示'},{id:'current',label:'現在位置を表示'},{id:'fullscreen',label:'全画面',shortcut:'F11'}]},
 {label:'拍子・小節',items:[{id:'songTempo',label:'曲のテンポ…'},{id:'tempo',label:'選択小節のテンポ…'},{id:'signature',label:'拍子記号…'},{id:'clef',label:'音部記号…'},{id:'key',label:'調号…'},{id:'swing',label:'スウィング・フィール…'},null,{id:'repeatStart',label:'リピート開始'},{id:'repeatEnd',label:'リピート終了…'},{id:'endings',label:'カッコ…'},null,{id:'addBar',label:'末尾に小節を追加'},{id:'insertBars',label:'小節を挿入…'},{id:'duplicateBars',label:'選択小節を複製'},{id:'deleteBars',label:'選択小節を削除…'}]},
 {label:'トラック',items:[{id:'trackAdd',label:'トラック追加',icon:'＋',children:[{id:'addGuitar',label:'6弦ギター'},{id:'addGuitar7',label:'7弦ギター'},{id:'addBass',label:'4弦ベース'},{id:'addBass5',label:'5弦ベース'},{id:'addDrums',label:'ドラム'},{id:'addKeyboard',label:'キーボード'}]},{id:'trackDuplicate',label:'トラック複製',icon:'⧉'},{id:'trackDelete',label:'トラック削除',icon:'−'}]},
 {label:'音符',items:noteMenuItems},
 {label:'エフェクト',items:[{id:'techniqueDetails',label:'奏法の詳細…'},null,{id:'palm',label:'パームミュート',shortcut:'P'},{id:'deadNote',label:'デッドノート',shortcut:'X'},{id:'ghost',label:'ゴーストノート',shortcut:'O'},{id:'hammer',label:'ハンマリング / プリング',shortcut:'H'},{id:'vibrato',label:'ビブラート',shortcut:'V'},{id:'ring',label:'Let ring'}]},
 {label:'プレーヤー',items:[{id:'play',label:'再生 / 一時停止',shortcut:'Space'},{id:'stop',label:'再生開始位置に戻って停止',shortcut:'Ctrl+Space'},{id:'home',label:'先頭に戻る'},null,{id:'practiceSettings',label:'練習設定…'},{id:'speedTrainer',label:'スピードトレーナー…'},{id:'practiceLoop',label:'ループ範囲…'},{id:'loopToggle',label:'ループ範囲を再生',check:()=>loopConfig.enabled&&playing},null,{id:'click',label:'クリック',check:()=>value('click').checked},{id:'current',label:'現在位置を表示'}]},
 {label:'ツール',items:[{id:'appSettings',label:'設定…'},{id:'transposeScore',label:'移調…'},null,{id:'audio-heading',label:'音源',disabled:true},{id:'audio-status',label:'',disabled:true},{id:'soundfont',label:'SoundFontを交換…'}]},
 {label:'ヘルプ',items:[{id:'help',label:'操作・ショートカット',shortcut:'F1'},{id:'about',label:'Tab Studioについて'}]}
];
function runCommand(id:string){if(['practiceSettings','speedTrainer','techniqueDetails','sectionNavigator','noteInput','specialPaste','scoreLayout'].includes(id)){closeMenus();extras?.open(id);return;}
 if(id==='appSettings'){closeMenus();finishInline(true,false,true);openAppSettings();return;}
 if(id==='trackAdd'){closeMenus();openAddTrack();return;}
 if(id==='trackDuplicate'){closeMenus();openDuplicateTrack();return;}
 if(id==='trackDelete'){closeMenus();deleteCurrentTrack();return;}
 if(id==='selectAll'){fragmentRange=null;selectedRange={start:0,end:score.masterBars.length-1,track:selected?.track??0,allTracks:selectedRange?.allTracks??false};showRange();return;}
 if(id==='nextDocument'||id==='previousDocument'){const index=documents.findIndex(d=>d.id===activeDocument);activateDocument(documents[(index+(id==='nextDocument'?1:-1)+documents.length)%documents.length].id);return;}

 if(id==='transposeScore'){closeMenus();openTranspose();return;}
 if(id==='closeDocument'){closeDocument(activeDocument);return;}
 if(['clef','key','swing','repeatEnd','endings'].includes(id)){closeMenus();openNotation(id);return;}
 if(id==='chord'||id==='chordRemove'){closeMenus();if(id==='chord')openChord();else button('chord-remove').click();return;}
 if(['transposeUp','transposeDown','stringUp','stringDown'].includes(id)){closeMenus();transformSelected(id);return;}
 if(id==='stemAuto'||id==='stemUp'||id==='stemDown'){closeMenus();setStem(id==='stemAuto'?0:id==='stemUp'?1:-1);return;}
 if(id==='moveBefore'||id==='moveAfter'){closeMenus();moveNote(id==='moveBefore'?-1:1);return;}
 if(id==='strokeUp'||id==='strokeDown'){closeMenus();commitLocal(s=>{const b=selectedBeat(s);if(b)b.pickStroke=b.pickStroke===(id==='strokeUp'?at.model.PickStroke.Up:at.model.PickStroke.Down)?at.model.PickStroke.None:id==='strokeUp'?at.model.PickStroke.Up:at.model.PickStroke.Down;},'ストロークを更新しました');return;}
 if(id.startsWith('tuplet')){closeMenus();const n=Number(id.slice(6));commitLocal(s=>{const b=selectedBeat(s);if(b)resizeBeat(b,b.duration,b.dots,n,n===1?1:n===2?3:n===3?2:n<8?4:8);},'連符を更新しました');return;}
 if(id.startsWith('duration')||id.startsWith('dynamic')||['doubleDot','tie','text','repeatStart','bend','slide','harmonic','accent','heavyAccent','staccato','trill','tremolo','tap','slap','pop','fade','brush'].includes(id)){closeMenus();paletteAction(id);return;}

  const commands:Record<string,()=>void>={range:openRangeDialog,copyBars:copySelection,pasteBars:()=>pasteSelection(),pasteInsert:()=>pasteSelection(true),cut:cutSelection,insertBars:openBarDialog,duplicateBars:duplicateSelection,deleteBars:deleteSelection,trackSettings:()=>openTrackDialog(selected?.track??0),addGuitar:()=>createTrack('guitar'),addGuitar7:()=>createTrack('guitar7'),addBass:()=>createTrack('bass'),addBass5:()=>createTrack('bass5'),addDrums:()=>createTrack('drums'),addKeyboard:()=>createTrack('keyboard')};if(commands[id]){closeMenus();commands[id]();return;}
  if(id==='export'||id==='exportPdf'){closeMenus();openExport(id==='exportPdf'?'pdf':undefined);return;}
  if(id==='songTempo'){closeMenus();openTempoDialog(true);return;}
   if(id==='tempo'){closeMenus();openTempoDialog();return;}
  if(id==='signature'){closeMenus();openSignature();return;}
  if(id==='practiceLoop'){closeMenus();openLoopDialog();return;}
  if(id==='loopToggle'){closeMenus();toggleLoopPlayback();return;}
  if(id==='resetPanels'){Object.assign(viewState,{tracks:true,noteEditor:true,transport:true,titleInfo:true,statusbar:true});closeMenus();updateView();return;}
  if(id==='zoomReset'){closeMenus();zoom(1-scale);return;}
  if(id==='scoreTop'){closeMenus();$('score-scroll').scrollTo({top:0,left:0});return;}
  if(id==='showAllTracks'||id==='showCurrentTrack'){closeMenus();if(playing)return message('表示トラックの変更は停止中に行ってください。');finishInline(true);visible=id==='showAllTracks'?new Set(score.tracks.map(t=>t.index)):new Set([currentTrackIndex()]);if(selected&&!visible.has(selected.track))selected=null;selectedRange=null;fragmentRange=null;render(true);return;}
  closeMenus();if(id.startsWith('recent:')){void openRecentFile(id.slice(7));return;}if(id in viewState){const field=id as keyof typeof viewState;viewState[field]=!viewState[field];updateView();return;}
  if(id==='deleteNote'){if(fragmentRange||selectedRange)clearSelection();else deleteNote();return;}if(id==='saveAs'){void saveScore(true);return;}if(id==='inline'){beginInline();return;}if(id==='clean'){clearSelection();return;}if(id==='rest'){insertRest();return;}
  if(id==='longer'||id==='shorter'){changeDuration(id==='longer');return;}if(id==='dotted'){dotted();return;}if(id==='triplet'){triplet();return;}
  const effects:Record<string,'isPalmMute'|'isDead'|'isGhost'|'isHammerPullOrigin'|'vibrato'|'isLetRing'>={palm:'isPalmMute',deadNote:'isDead',ghost:'isGhost',hammer:'isHammerPullOrigin',vibrato:'vibrato',ring:'isLetRing'};if(effects[id]){noteEffect(effects[id]);return;}
  if(id==='help'||id==='about'){($(`${id}Dialog`)as HTMLDialogElement).showModal();return;}
  if(id==='exit'){requestClose();return;}
  if(id==='fullscreen'){if(window.desktop){window.desktop.toggleFullscreen();return;}if(!document.fullscreenElement)void document.documentElement.requestFullscreen();else void document.exitFullscreen();return;}
  if(id==='click'){value(id).checked=!value(id).checked;updateClick();updateView();return;}
  const control=document.getElementById(id)as HTMLButtonElement|null;control?.click();
}
function menuButton(item:MenuItem){const b=document.createElement('button');b.type='button';b.className='menu-item';b.role='menuitem';b.disabled=!!item.disabled||(['trackAdd','trackDuplicate','trackDelete','addGuitar','addGuitar7','addBass','addBass5','addDrums','addKeyboard'].includes(item.id)&&playing)||(item.id==='trackDelete'&&score.tracks.length===1);if(item.title)b.title=item.title;const icon=document.createElement('span');icon.className='menu-icon';icon.setAttribute('aria-hidden','true');if(item.icon)icon.innerHTML=item.icon;else if(item.check?.())icon.textContent='✓';const label=document.createElement('span');label.className='menu-label';label.textContent=item.id==='audio-status'?audioStatus:item.label;b.append(icon,label);const shortcut=shortcutDefinitions.some(([id])=>id===item.id)?appSettings.shortcuts[item.id]:item.shortcut;if(shortcut){const k=document.createElement('kbd');k.textContent=shortcut;k.setAttribute('aria-hidden','true');b.append(k);}if(item.check?.())b.classList.add('checked');if(item.children){b.setAttribute('aria-haspopup','menu');b.setAttribute('aria-expanded','false');const arrow=document.createElement('span');arrow.className='submenu-arrow';arrow.setAttribute('aria-hidden','true');arrow.textContent='›';b.append(arrow);const node=document.createElement('div');node.className='menu-node';const p=document.createElement('div');p.className='menu-popup submenu-popup';p.role='menu';p.hidden=true;const open=()=>{for(const sibling of [...node.parentElement?.children??[]])if(sibling!==node)for(const popup of sibling.querySelectorAll<HTMLElement>('.submenu-popup'))popup.hidden=true;populatePopup(p,item.children!);p.hidden=false;b.setAttribute('aria-expanded','true');p.classList.remove('opens-left');const r=p.getBoundingClientRect();if(r.right>innerWidth-8)p.classList.add('opens-left');p.style.top='0px';const v=p.getBoundingClientRect();if(v.bottom>innerHeight-8)p.style.top=`${innerHeight-8-v.bottom}px`;};node.onpointerenter=open;node.onpointerleave=()=>{p.hidden=true;b.setAttribute('aria-expanded','false');};b.onclick=open;b.onkeydown=e=>{if(e.key==='Enter'||e.key==='ArrowRight'){e.preventDefault();open();p.querySelector<HTMLButtonElement>('button')?.focus();}};node.append(b,p);return node;}b.onclick=()=>runCommand(item.id);return b;}

function closeMenus(){document.querySelectorAll('.menu-popup').forEach(p=>(p as HTMLElement).hidden=true);document.querySelectorAll('.menu-root').forEach(p=>{p.classList.remove('open');p.querySelector('button')?.setAttribute('aria-expanded','false');});const context=$('score-context'),wasOpen=!context.hidden;context.hidden=true;if(wasOpen)showSelection();}
function populatePopup(p:HTMLElement,items:(MenuItem|null)[]){p.replaceChildren();for(const item of items)p.append(item?menuButton(item):document.createElement('hr'));}
for(const menu of menus){
 const root=document.createElement('div');root.className='menu-root';
 const trigger=document.createElement('button');trigger.textContent=menu.label;trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
 const popup=document.createElement('div');popup.className='menu-popup';popup.role='menu';popup.hidden=true;
 const open=()=>{closeMenus();populatePopup(popup,menu.label==='ファイル'?fileMenuItems(menu.items):menu.items);popup.hidden=false;root.classList.add('open');trigger.setAttribute('aria-expanded','true');};
 trigger.onclick=()=>{if(popup.hidden)open();else closeMenus();};
 trigger.onpointerenter=()=>{if(popup.hidden&&document.querySelector('.menu-root.open'))open();};
 root.onpointerleave=e=>{const next=e.relatedTarget;if(!(next instanceof Element&&next.closest('.menu-root')))closeMenus();};
 root.append(trigger,popup);$('menubar').append(root);
}
function showContext(x:number,y:number){
 finishInline(true,false,true);closeMenus();const p=$('score-context');p.classList.add('note-popover');p.setAttribute('role','dialog');p.setAttribute('aria-label','音符の編集');
 if(!updateContextPalette){
  p.replaceChildren();const header=document.createElement('header'),caption=document.createElement('strong'),close=document.createElement('button');caption.textContent='音符の編集';close.textContent='×';close.title='閉じる';close.setAttribute('aria-label','音符の編集を閉じる');close.onclick=()=>{closeMenus();$('score-scroll').focus({preventScroll:true});};header.append(caption,close);
  const palette=document.createElement('div');palette.className='context-palette';p.append(header,palette);
  updateContextPalette=createEditPalette(palette,id=>{paletteAction(id);if(document.querySelector('dialog[open]')||id==='inline'||id==='select'){closeMenus();return;}p.hidden=false;updateContextPalette?.(selectedBeat(),selectedNote(),playing);});
  const durationSection=palette.querySelector('[data-action=duration1]')!.closest('.palette-section')!;palette.prepend(durationSection);
  const row=document.createElement('div');row.className='context-clipboard';
  for(const [id,label,icon]of [['undo','取り消し','↶'],['redo','やり直し','↷'],['cut','切り取り','✂'],['copyBars','コピー','⧉'],['pasteBars','貼り付け','▣'],['pasteInsert','挿入して貼り付け','＋▣']]){const b=document.createElement('button');b.type='button';b.dataset.command=id;b.title=label;b.setAttribute('aria-label',label);b.textContent=icon;b.onclick=()=>runCommand(id);row.append(b);}p.append(row);
 }
 updateContextPalette(selectedBeat(),selectedNote(),playing);
 updateContextControls();
 p.hidden=false;$('hover-note').hidden=true;showSelection();const gap=32,width=p.offsetWidth,left=x+gap+width<=innerWidth-8?x+gap:x-width-gap;p.style.left=`${Math.max(8,Math.min(left,innerWidth-width-8))}px`;p.style.top=`${Math.max(8,Math.min(y+gap,innerHeight-p.offsetHeight-8))}px`;
}
document.addEventListener('pointerdown',e=>{if(!(e.target as HTMLElement).closest('.menu-root,.context-menu'))closeMenus();});
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',e=>{if(e.target===dialog&&!(dialog.id==='exportDialog'&&button('export-apply').disabled))dialog.close();});for(const b of document.querySelectorAll<HTMLButtonElement>('[data-close]'))b.onclick=()=>($<HTMLDialogElement>(b.dataset.close!)).close();
if(window.desktop){window.desktop.onCommand(runCommand);window.desktop.onCloseRequest(requestClose);}
const openAppSettings=installSettingsDialog(()=>appSettings,(next:AppSettings)=>{try{localStorage.setItem('tabstudio-settings',JSON.stringify(next));}catch{message('設定を保存できませんでした。');return false;}const enableFollow=!appSettings.follow&&next.follow;appSettings=next;document.documentElement.dataset.theme=next.theme;if(enableFollow)follower.focus();if(!next.preview){previewRequest++;notePreview.stop();}updateShortcutHints();updateView();status('設定を保存しました');});
function updateShortcutHints(){button('play').title=`再生 / その場で停止${appSettings.shortcuts.play?'（'+appSettings.shortcuts.play+'）':''}`;button('stop').title=`再生開始位置に戻って停止${appSettings.shortcuts.stop?'（'+appSettings.shortcuts.stop+'）':''}`;}
updateShortcutHints();updateView();

function showExitDialog(text:string,title='Tab Studioを終了'){$('exit-title').textContent=title;$('exit-message').textContent=text;$('exit-error').textContent='';button('exit-save').disabled=button('exit-discard').disabled=button('exit-cancel').disabled=false;const dialog=$<HTMLDialogElement>('exitDialog');if(!dialog.open)dialog.showModal();}
function requestClose(){flushDigits();finishInline(true);pauseHere();stashDocument();closingDocument=null;const changed=documents.filter(d=>d.dirty);if(!changed.length){window.desktop?.finishClose();return;}showExitDialog(`${changed.length}件の譜面に未保存の変更があります。保存して終了する場合、すべての譜面を保存します。`);}
button('exit-save').onclick=async()=>{
 button('exit-save').disabled=button('exit-discard').disabled=button('exit-cancel').disabled=true;$('exit-error').textContent='保存しています…';
 const tab=closingDocument;stashDocument();const targets=tab===null?documents.filter(d=>d.dirty).map(d=>d.id):[tab];let saved=true;
 for(const id of targets){activateDocument(id);if(!await saveScore()){saved=false;break;}}
 if(saved){$<HTMLDialogElement>('exitDialog').close();if(tab===null)window.desktop?.finishClose();else{closingDocument=null;removeDocument(tab);}}
 else{$('exit-error').textContent='保存を完了していないため、譜面を開いたままにしています。';button('exit-save').disabled=button('exit-discard').disabled=button('exit-cancel').disabled=false;}
};
button('exit-discard').onclick=()=>{const tab=closingDocument;$<HTMLDialogElement>('exitDialog').close();closingDocument=null;if(tab!==null){removeDocument(tab);return;}clearTimeout(recoveryTimer);localStorage.removeItem('tabstudio-recovery');window.desktop?.finishClose();};
button('exit-cancel').onclick=()=>{closingDocument=null;$<HTMLDialogElement>('exitDialog').close();};

function paletteAction(id:string){
 flushDigits();if(id==='select'){status('譜面の弦をクリックして編集位置を選択してください');return;}
 if(id.startsWith('duration')){applyDuration(Number(id.slice(8)));return;}
 if(id.startsWith('dynamic')){commitIndependent(s=>{const b=selectedBeat(s);if(b)b.dynamics=Number(id.slice(7));},'強弱記号を変更しました');return;}
 if(id==='doubleDot'){const b=selectedBeat();if(b)commitLocal(s=>resizeBeat(selectedBeat(s)!,b.duration,b.dots===2?0:2,b.tupletNumerator,b.tupletDenominator),'複付点を変更しました');return;}
 if(id==='tempo'){openTempoDialog();return;}
 if(id==='signature'){openSignature();return;}
 if(id==='repeatStart'||id==='repeatEnd'){commitLocal(s=>{const m=s.masterBars[selected?.bar??0];if(id==='repeatStart')m.isRepeatStart=!m.isRepeatStart;else m.repeatCount=m.repeatCount?0:2;},'繰り返しを更新しました');return;}
 if(id==='barText'||id==='text'){openTextDialog(id==='barText');return;}
 if(id==='voice1'||id==='voice2'){if(!selected)return;const index=id==='voice1'?0:1;const ref={...selected};if(!selectedBeat()?.voice.bar.voices[index])commit(s=>{const bar=s.tracks[ref.track].staves[ref.staff].bars[ref.bar];const v=new at.model.Voice();bar.addVoice(v);for(const r of rests(bar.masterBar.timeSignatureNumerator*4/bar.masterBar.timeSignatureDenominator))v.addBeat(r);},'声部を追加しました');const beat=score.tracks[ref.track].staves[ref.staff].bars[ref.bar].voices[index].beats[0];selectBeat(beat,undefined,ref.string);return;}
 const specials=['tie','bend','harmonic','accent','heavyAccent','slide','staccato','trill','tremolo','tap','slap','pop','fade','brush','transposeUp','transposeDown'];
 if(!specials.includes(id)){runCommand(id);return;}
 (['tie','bend','harmonic','slide'].includes(id)?commitLocal:commitIndependent)(s=>{const b=selectedBeat(s),n=selectedNote(s);if(!b)throw new Error('譜面の編集位置を選択してください。');
  if(id==='tap'||id==='slap'||id==='pop'){b[id]=!b[id];return;}
  if(id==='fade'){b.fade=b.fade?at.model.FadeType.None:at.model.FadeType.FadeIn;return;}
  if(id==='brush'){b.brushType=b.brushType?at.model.BrushType.None:at.model.BrushType.BrushDown;b.brushDuration=120;return;}
  if(id==='tremolo'){b.tremoloPicking=b.tremoloPicking?undefined:new at.model.TremoloPickingEffect();if(b.tremoloPicking)b.tremoloPicking.marks=2;return;}
  if(!n)throw new Error('奏法を設定する音符を選択してください。');
  if(id==='transposeUp'||id==='transposeDown'){setFret(b,n.string,n.fret+(id==='transposeUp'?1:-1));return;}
  if(id==='tie'){if(!n.isTieDestination&&!b.previousBeat?.notes.some(p=>p.string===n.string&&p.fret===n.fret))throw new Error('タイは前の拍の同じ弦・フレットの音符と結びます。');n.isTieDestination=!n.isTieDestination;}
  if(id==='bend'){if(n.hasBend){n.bendPoints=null;n.bendType=at.model.BendType.None;}else{n.addBendPoint(new at.model.BendPoint(0,0));n.addBendPoint(new at.model.BendPoint(60,4));}}
  if(id==='harmonic'){n.harmonicType=n.harmonicType?at.model.HarmonicType.None:at.model.HarmonicType.Natural;n.harmonicValue=n.fret;}
  if(id==='accent'||id==='heavyAccent'){const target=id==='accent'?at.model.AccentuationType.Normal:at.model.AccentuationType.Heavy;n.accentuated=n.accentuated===target?at.model.AccentuationType.None:target;}
  if(id==='slide')n.slideOutType=n.slideOutType?at.model.SlideOutType.None:at.model.SlideOutType.Shift;
  if(id==='staccato')n.isStaccato=!n.isStaccato;
  if(id==='trill'){n.trillValue=n.trillValue>=0?-1:n.realValue+2;n.trillSpeed=at.model.Duration.Sixteenth;}
 },'音符・奏法を更新しました');
}
button('signature-apply').onclick=()=>{const numerator=Number(value('signature-numerator').value),denominator=Number(choose('signature-denominator').value);if(!Number.isInteger(numerator)||numerator<1||numerator>32){$('signature-error').textContent='分子は1〜32で指定してください。';return;}const index=selected?.bar??0,capacity=numerator*4/denominator;
 const ok=commit(s=>setMeter(s,index,numerator,denominator),'拍子を更新しました');if(ok)$<HTMLDialogElement>('signatureDialog').close();else $('signature-error').textContent=$('notice').textContent;};
updatePalette=createEditPalette($('edit-palette'),paletteAction);
function enhancementNotes(){if(fragmentRange)return rangeBeats(score,fragmentRange).flatMap(b=>b.notes);if(selectedRange){const r=selectedRange;return (r.allTracks?score.tracks:[score.tracks[r.track]]).flatMap(t=>t.staves.flatMap(st=>st.bars.slice(r.start,r.end+1).flatMap(bar=>bar.voices.flatMap(v=>v.beats.flatMap(b=>b.notes)))));}const n=selectedNote();return n?[n]:[];}
function enhancementClipboard():BeatClipboard|null{if(!clipboard)return null;if(clipboard.version===2)return clipboard;const s=restoreScore({masterbars:structuredClone(clipboard.masterbars),tracks:structuredClone(clipboard.tracks),tempo:score.tempo});const st=s.tracks[0].staves[0],last=st.bars.at(-1)!;return copyBeats(s,{anchor:{track:0,staff:0,voice:0,bar:0,beat:0},focus:{track:0,staff:0,voice:0,bar:last.index,beat:last.voices[0].beats.length-1}});}
function enhancedInput(pitches:number[],add:boolean,advance:boolean){
 if(!selected||!selectedBeat())return message('入力する拍を選択してください。'),false;const b=selectedBeat()!,ref={...selected};
 const apply=()=>{let beat=selectedBeat()!;if(beat.isFullBarRest){splitFullRest(beat);selected!.beat=0;beat=selectedBeat()!;}if(!add)beat.notes=[];for(const pitch of [...new Set(pitches)]){if(beat.voice.bar.staff.isPercussion){if(!drumSounds.some(([id])=>id===pitch))throw new Error('対応するドラム音がありません。');selected!.note=setDrum(beat,pitch,0,true);selected!.string=-1;selected!.surface='standard';}else{const result=setPitch(beat,pitch,0,true);selected!.note=result.index;selected!.string=result.string;selected!.pitch=pitch;}noteSelected=true;}selectedRange=null;fragmentRange=null;};
 const ok=!b.isFullBarRest&&canEditFretLocally(b)?commitBeats([b],apply,'音符を入力しました'):commitLocal(()=>apply(),'音符を入力しました');
 if(ok){if(!extras?.midiPreview)for(const n of selectedBeat()?.notes??[])void auditionNote(n);if(advance)navigateSelection({key:'ArrowRight',ctrlKey:false,shiftKey:false});}else selected=ref;return ok;
}
extras=installEnhancements({
 state:()=>({score,beat:selectedBeat(),note:selectedNote(),get notes(){return enhancementNotes();},point:selected?{...selected}:null,playing,document:activeDocument,revision:editRevision,tick:pendingSeekTick??parkedTick??lastTick,loop:loopConfig,selectedTicks:()=>{let first:Beat|undefined,last:Beat|undefined;if(fragmentRange){const beats=rangeBeats(score,fragmentRange);first=beats[0];last=beats.at(-1);}else if(selectedRange){const staff=score.tracks[selectedRange.track].staves[0];first=staff.bars[selectedRange.start].voices[0].beats[0];last=staff.bars[selectedRange.end].voices[0].beats.at(-1);}if(!first||!last)return null;const visits=api.tickCache?.masterBars??[],a=visits.find(v=>v.masterBar.index===first!.voice.bar.index),b=visits.find(v=>v.masterBar.index===last!.voice.bar.index&&v.start>=(a?.start??0));return a&&b?{startTick:a.start+first.playbackStart,endTick:b.start+last.playbackStart+last.playbackDuration}:null;}}),
 api,click:clickAudio,finish:()=>{finishInline(true);flushDigits();},message,status,pause:()=>pauseHere(api.tickPosition),play:togglePlayback,seek:seekTo,
 loop:(start,end,enabled)=>setLoop({start,end,enabled}),local:commitBeats,structural:(fn,text)=>commitLocal(fn,text),
 jump:bar=>{const track=selected?.track??[...visible][0]??0,beat=score.tracks[track].staves[0].bars[bar].voices[0].beats[0];selectBeat(beat);follower.focus();},
 select:(start,end)=>{selectedRange={start,end,track:selected?.track??0,allTracks:false};fragmentRange=null;showRange();updateInspector();},
 rename:(bar,text)=>{commit(s=>{const m=s.masterBars[bar];if(!text.trim())m.section=null;else{m.section??=new at.model.Section();m.section.text=text.trim();}},'区間の名前を変更しました');},
 paste:(kind,count,insert)=>{const clip=enhancementClipboard();if(!clip)return false;ensureNavigationSelection();const p={...selected!};if(kind==='technique'||kind==='text'){let changed:Beat[]=[];const before=capture();try{const result=specialPaste(score,clip,p,kind,count,insert);changed='changed' in result?result.changed:[];if(!changed.length)return false;if(result.score!==score){transferLayout(score,result.score);score=result.score;before.firstChangedBar=Math.max(0,p.bar-3);undo.push(before);redo.length=0;fragmentRange=result.range;selectedRange=null;markDirty();render(true,before.firstChangedBar);return true;}for(const b of changed)editSnapshot.patchBeat(score,b);before.firstChangedBar=Math.max(0,p.bar-3);undo.push(before);redo.length=0;fragmentRange=result.range;selectedRange=null;if(kind==='technique')playbackDirty=true;markDirty(false);scheduleFretDraw(p.bar);updateInspector();return true;}catch(e){restore(before);render(true);message(e instanceof Error?e.message:String(e));return false;}}if(kind==='all'&&!insert){const fast=localPaste(score,repeatClipboard(clip,count),p);if(fast)return commitBeats(fast.beats,()=>{fast.apply();fragmentRange={anchor:p,focus:{...p,bar:fast.beats.at(-1)!.voice.bar.index,beat:fast.beats.at(-1)!.index}};selectedRange=null;},'音符を貼り付けました');}return commit(s=>{const result=specialPaste(s,clip,p,kind,count,insert);fragmentRange=result.range;selectedRange=null;return result.score;},'指定した内容を貼り付けました',Math.max(0,p.bar-3));},
 clipboard:enhancementClipboard,input:enhancedInput,
 preview:pitch=>{const b=selectedBeat();if(!b)return;const temp=new at.model.Beat();temp.voice=b.voice;temp.duration=b.duration;try{const r=b.voice.bar.staff.isPercussion?{index:setDrum(temp,pitch,0,true)}:setPitch(temp,pitch,0,true);void auditionNote(temp.notes[r.index]);}catch{}},silence:()=>notePreview.stop(),previewTechnique:async(note,patch)=>{const bar=note.beat.voice.bar,staff=bar.staff,j=excerptJson(score,bar.index,Math.min(bar.index+1,score.masterBars.length-1),staff.track.index),s=restoreScore(j),st=s.tracks[0].staves[staff.index],b=st.bars[0].voices[note.beat.voice.index].beats[note.beat.index],n=b.notes[note.index];applyTechnique([n],patch);for(const t of s.tracks)for(const a of t.staves)for(const v of a.bars.flatMap(bar=>bar.voices))if(v!==b.voice&&v!==b.nextBeat?.voice)for(const beat of v.beats)beat.notes=[];b.voice.beats=b.voice.beats.slice(b.index);s.finish(settings);await notePreview.playPhrase(serialize(s));},
 layout:p=>{const before=capture();setLayout(score,p);undo.push(before);redo.length=0;scale=p.scale;api.settings.display.scale=scale;$('zoom').textContent=`${Math.round(scale*100)}%`;markDirty(false);render(true);},focus:()=>$('score-scroll').focus({preventScroll:true})
});

function cachedProject(){return JSON.stringify({format:'TabStudio',version:1,sourceName,warnings,studio:{layout:getLayout(score)},score:editSnapshot.get(score)},(_key,item)=>item instanceof Map?Object.fromEntries(item):item);}
function rememberCleanProject(){try{localStorage.setItem('tabstudio-last-project',cachedProject());localStorage.setItem('tabstudio-last-path',documentPath);}catch{}}
async function refreshRecentFiles(){if(window.desktop)try{recentFiles=await window.desktop.recentFiles();}catch{}}
async function openRecentFile(path:string){try{const file=await window.desktop?.openRecent(path);if(file)await load(file.name,new Uint8Array(file.bytes),file.openToken,file.path);}catch(error){message(`ファイルを開けませんでした：${error}`);}}
function fileMenuItems(items:(MenuItem|null)[]):(MenuItem|null)[]{
 const recent:MenuItem[]=recentFiles.length?recentFiles.map(file=>({id:'recent:'+file.path,label:file.name,title:file.path})):[{id:'recent-empty',label:'履歴はまだありません',disabled:true}];
 return [...items.slice(0,-2),null,{id:'recent-heading',label:'最近開いたファイル',disabled:true},...recent,null,...items.slice(-1)];
}
function restoreRecoveryScore(d:any){const s=deserialize(JSON.stringify(d.score));if(d.layout)try{setLayout(s,d.layout);}catch{}return s;}
async function initializeWorkspace(){
 startupLoading(appSettings.reopenLast?undefined:'譜面を準備中…');for(const element of document.querySelectorAll<HTMLElement>('.workspace,.transport,#menubar'))element.inert=true;
 const recovery=localStorage.getItem('tabstudio-recovery'),lastProject=appSettings.reopenLast?localStorage.getItem('tabstudio-last-project'):null;let restored=false,restoreError='';
 try{await refreshRecentFiles();if(window.desktop&&appSettings.reopenLast){const file=await window.desktop.lastScore();if(file){startupLoading(`読み込み中：${file.name}`);await new Promise<void>(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));restored=!!await load(file.name,new Uint8Array(file.bytes),file.openToken,file.path);}}}catch(error){restoreError=`前回のファイルを開けませんでした：${error}`;}
 if(!restored&&lastProject)try{const last=readProject(lastProject);score=last.score;sourceName=last.sourceName;warnings=last.warnings;documentPath=localStorage.getItem('tabstudio-last-path')||'';}catch{}
 if(recovery){if(confirm('前回の未保存の譜面を復元しますか？'))try{const raw=JSON.parse(recovery);if(raw.workspace?.documents?.length){documents.splice(0,documents.length,...raw.workspace.documents.map((d:any)=>({...d,score:restoreRecoveryScore(d),undo:[],redo:[]})));const active=documents.find(d=>d.id===raw.workspace.activeDocument)??documents[0];activeDocument=active.id;documentCounter=Math.max(...documents.map(d=>d.id));score=active.score;sourceName=active.sourceName;warnings=active.warnings;documentPath=active.documentPath;visible=new Set(active.visible);selected=active.selected;noteSelected=active.noteSelected;notation=active.notation;scale=active.scale;api.settings.display.scale=scale;api.updateSettings();choose('speed').value=active.speed;api.playbackSpeed=Number(active.speed);documentViewport={tick:active.tick,top:active.top,left:active.left};dirty=active.dirty;for(const doc of documents)recoveryWorker.postMessage({cmd:'document',id:doc.id,data:at.model.JsonConverter.scoreToJsObject(doc.score)});}else{const last=readProject(recovery);score=last.score;sourceName=last.sourceName;warnings=last.warnings;documentPath=localStorage.getItem('tabstudio-recovery-path')||'';dirty=true;}editSnapshot.invalidate();$('dirty').textContent=dirty?'未保存の変更':'保存済み';renderDocumentTabs();scheduleRecovery();}catch{}else localStorage.removeItem('tabstudio-recovery');}
 restoreTrackView();resetLoop();startupLoading('譜面を読み込み中…');startupComplete=true;render();if(restoreError)message(restoreError);
}
void initializeWorkspace();
Object.assign(window.tabStudio as object,{requestClose,paletteAction,extras});

