import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import type {DesktopAPI,DesktopFile,NativeFxAPI,SamplerAPI} from './bridge';
import {joinFrame,splitFrame} from './frame';
/** Tauri implementation of the platform bridge (the Electron one is electron/preload.cjs).
 * Installed as window.desktop / window.nativeFx before the app starts, so the rest of
 * the code does not know which shell is running. Commands live in src-tauri/src/commands.rs. */
type FileHeader={name:string;path:string;openToken?:string}|null;
async function file(command:string,args?:Record<string,unknown>):Promise<DesktopFile|null>{
 const {header,bytes}=splitFrame<FileHeader>(await invoke<ArrayBuffer>(command,args));
 return header?{...header,bytes}:null;
}
async function required(command:string,args?:Record<string,unknown>):Promise<DesktopFile>{
 const result=await file(command,args);if(!result)throw new Error('ファイルを読み込めません。');return result;
}
/** WebView2 drops a single IPC body of ~38MB, so larger bodies go in pieces (upload_chunk). */
export const CHUNK=4*1024*1024;
export async function send<T>(command:string,body:Uint8Array):Promise<T>{
 if(body.byteLength<=CHUNK)return invoke<T>(command,body);
 let id:number|null=null;
 for(let at=0;at<body.byteLength;at+=CHUNK)id=await invoke<number>('upload_chunk',joinFrame({id},[body.subarray(at,at+CHUNK)]));
 return invoke<T>(command,joinFrame({upload:id}));
}
const unsupported=(what:string)=>()=>Promise.reject(new Error(`${what}はこの版ではまだ使えません。`));
export function createTauriDesktop():DesktopAPI{
 return {
  workspaceSession:()=>invoke('workspace_session'),
  rememberWorkspace:value=>invoke('remember_workspace',{value}),
  readWorkspaceFile:path=>required('read_workspace_file',{path}),
  openScore:()=>file('open_score'),
  saveScore:args=>send('save_score',joinFrame({name:args.name,saveAs:!!args.saveAs,hasPath:Object.hasOwn(args,'path'),path:args.path},[args.bytes])),
  exportScore:args=>{const {bytes,scoreJson,...rest}=args;return send('export_score',joinFrame(rest,[bytes??new TextEncoder().encode(scoreJson??'')]));},
  resetSavePath:()=>invoke('reset_save_path'),
  activateDocument:path=>invoke('activate_document',{path:path||null}),
  acceptOpen:token=>invoke('accept_open',{token}),
  recentFiles:()=>invoke('recent_files'),
  lastScore:()=>file('last_score'),
  openRecent:path=>required('open_recent',{path}),
  openFilePath:path=>required('open_file_path',{path}),
  // WebView File objects carry no path; dropped files are read from their bytes instead.
  pathForFile:()=>'',
  onCloseRequest:handler=>{void listen('close-request',()=>handler());},
  finishClose:()=>{void invoke('finish_close');},
  toggleFullscreen:()=>{void invoke('toggle_fullscreen');},
  // The app draws its own menu bar; there is no native menu to send commands or check marks.
  onCommand:()=>{},
  setMenuState:()=>{},
  writeRecoveryDocuments:({manifest,files,remove})=>send('recovery_write_documents',joinFrame({manifest,files:files.map(f=>({id:f.id,length:f.bytes.byteLength})),remove},files.map(f=>f.bytes))),
  readRecovery:()=>invoke('recovery_read'),
  clearRecovery:()=>invoke('recovery_clear'),
 };
}
/** NAM models load from the native folder. SFZ instruments and external plugins need the
 * Python hosts, which the Tauri build does not ship; the native audio engine replaces them. */
export function createTauriNativeFx():NativeFxAPI&SamplerAPI{
 const sfz=unsupported('SFZ音源'),fx=unsupported('外部FX');
 return {
  features:{sfz:false,externalFx:false},
  namModel:id=>invoke('nam_model',{id}),
  scan:async()=>[],folder:async()=>[],load:fx,process:fx,editor:fx,state:fx,close:async()=>{},
  sfzLibrary:async()=>[],sfzFile:async()=>null,sfzLoad:sfz,sfzPrepare:sfz,sfzRender:sfz,sfzReset:async()=>{},
 };
}
export function installTauriBridge(target:Window){
 if(!('__TAURI_INTERNALS__' in target)||target.desktop)return;
 target.desktop=createTauriDesktop();target.nativeFx=createTauriNativeFx();
}
if(typeof window!=='undefined')installTauriBridge(window);
