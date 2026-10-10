/** The document core (crates/tabstudio-core, migration P3) as WASM: the score model with
 * undoable edit ops. Load once with loadCore(); in Node (tests) pass the wasm bytes.
 * Rebuild the wasm with `node scripts/build-core-wasm.mjs`. */
import init,{initSync,CoreDocument} from './wasm/tabstudio_core.js';

let loading:Promise<void>|undefined;
/** Instantiates the module (fetching tabstudio_core_bg.wasm next to the glue), or from bytes. */
export function loadCore(bytes?:BufferSource):Promise<void>{
 if(bytes){initSync({module:bytes});loading=Promise.resolve();return loading;}
 return loading??=init().then(()=>undefined);
}
/** A node position; the deepest given index names the node ({} = the score). */
export type At={masterbar?:number;track?:number;staff?:number;bar?:number;voice?:number;beat?:number;note?:number};
export type ListName='masterbars'|'tracks'|'bars'|'voices'|'beats'|'notes';
export type EditOp=
 /** Sets a field of the node at `at` (value null/undefined removes it). */
 {op:'set';at:At;key:string;value?:unknown}|
 /** Inserts a node (alphaTab JSON) into a list of the node at `at`. */
 {op:'insert';at:At;list:ListName;index:number;node:unknown}|
 {op:'remove';at:At;list:ListName;index:number}|
 /** Replaces item `index` of a list with `node` (a content change, e.g. an edited measure). */
 {op:'replace';at:At;list:ListName;index:number;node:unknown}|
 /** Replaces the whole score (structure changes): undoable like any edit. */
 {op:'replaceScore';score:unknown};
/** What an edit, undo or redo changed: bars to refresh, or a rebuild (structure/song). */
export type Changes={bars:[number,number,number][];structure:boolean;song:boolean};
/** One open document in the core. Call free() when it is closed. */
export class Core{
 private constructor(private doc:CoreDocument){}
 /** From the app's alphaTab JSON (editData / JsonConverter + studio data). */
 static fromData(data:unknown){return new Core(CoreDocument.fromJson(JSON.stringify(data)));}
 /** One user action (one undo step); positions in later ops see the earlier ones applied. */
 edit(label:string,ops:EditOp[]):Changes{return JSON.parse(this.doc.edit(label,JSON.stringify(ops)));}
 undo():Changes|undefined{const r=this.doc.undo();return r===undefined?undefined:JSON.parse(r);}
 redo():Changes|undefined{const r=this.doc.redo();return r===undefined?undefined:JSON.parse(r);}
 get canUndo(){return this.doc.canUndo();}
 get canRedo(){return this.doc.canRedo();}
 /** The alphaTab JSON of the node at `at` ({} = the whole score). */
 node(at:At={}):any{return JSON.parse(this.doc.nodeJson(JSON.stringify(at)));}
 /** A track with its staves but no bars, or a staff without its bars. */
 header(at:{track:number;staff?:number}):any{return JSON.parse(this.doc.headerJson(JSON.stringify(at)));}
 data():any{return JSON.parse(this.doc.toJson());}
 free(){this.doc.free();}
}
