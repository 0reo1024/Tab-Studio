import type {ScoreFormat} from '../export-score';
import type {PdfOptions} from '../pdf-options';
/** The only place application code reaches the host shell. Electron provides
 * these objects from electron/preload.cjs; a Tauri build supplies the same
 * interfaces, so nothing else needs to know which shell is running. */
export type DesktopFile={name:string;path:string;bytes:Uint8Array;openToken?:string};
export type WorkspaceSession={files:string[];active:string|null};
export type RecentFile={path:string;name:string};
export type RecoveryDocuments={manifest:string;files:{id:number;bytes:Uint8Array}[];remove:number[]};
export type DesktopAPI={
 workspaceSession:()=>Promise<WorkspaceSession>;rememberWorkspace:(session:WorkspaceSession)=>Promise<void>;readWorkspaceFile:(path:string)=>Promise<DesktopFile>;
 openScore:()=>Promise<DesktopFile|null>;saveScore:(args:{name:string;bytes:Uint8Array;saveAs?:boolean;path?:string})=>Promise<{name:string;path:string}|false>;
 exportScore:(args:{name:string;format:ScoreFormat|'pdf';bytes?:Uint8Array;scoreJson?:string;tracks?:number[];pdf?:PdfOptions;trackNames?:string[]})=>Promise<{name:string;path:string}|false>;
 resetSavePath:()=>Promise<void>;activateDocument:(path:string)=>Promise<void>;acceptOpen:(token:string)=>Promise<void>;
 recentFiles:()=>Promise<RecentFile[]>;lastScore:()=>Promise<DesktopFile|null>;openRecent:(path:string)=>Promise<DesktopFile>;openFilePath:(path:string)=>Promise<DesktopFile>;pathForFile:(file:File)=>string;
 onCloseRequest:(handler:()=>void)=>void;finishClose:()=>void;toggleFullscreen:()=>void;onCommand:(handler:(command:string)=>void)=>void;setMenuState:(state:Record<string,boolean>)=>void;
 writeRecovery?:(json:string)=>Promise<void>;writeRecoveryDocuments?:(payload:RecoveryDocuments)=>Promise<void>;readRecovery?:()=>Promise<string|null>;clearRecovery?:()=>Promise<void>;
};
export type NativePlugin={path:string;name:string;format:string};
export type NativeFxAPI={namModel:(id:string)=>Promise<string>;scan:()=>Promise<NativePlugin[]>;folder:()=>Promise<NativePlugin[]>;load:(path:string,state?:string)=>Promise<{id:string;name:string}>;process:(id:string,pcm:Uint8Array,rate:number)=>Promise<Uint8Array>;editor:(id:string)=>Promise<{state:string}>;state:(id:string)=>Promise<{state:string}>;close:(id:string)=>Promise<void>};
export type SamplerAPI={sfzLibrary:()=>Promise<{name:string;path:string}[]>;sfzFile:()=>Promise<string|null>;sfzLoad:(path:string,lanes?:number[],pitches?:Record<string,number[]>)=>Promise<{id:string;name:string}>;sfzPrepare:(id:string,lanes:number[],pitches?:Record<string,number[]>)=>Promise<unknown>;sfzRender:(id:string,frames:number,rate:number,events:unknown[])=>Promise<Uint8Array>;sfzReset:(id:string)=>Promise<unknown>};
declare global{interface Window{desktop?:DesktopAPI;nativeFx?:NativeFxAPI&SamplerAPI;tabStudio:unknown}}
const host=()=>(globalThis as {window?:Window}).window;
/** Read at call time: undefined in a plain browser build and in unit tests. */
export const platform={
 get desktop():DesktopAPI|undefined{return host()?.desktop;},
 get nativeFx():(NativeFxAPI&SamplerAPI)|undefined{return host()?.nativeFx;},
};
