import {plain,type ScoreData} from '../edit-snapshot';
import {cleanEditJson} from '../edit-json';
import {Core,type Changes,type EditOp} from './index';
import {snapshotOps} from './sync';
/** One open document's link to the core (migration P3-6, behind the "new edit engine"
 * setting). The core holds the undo log; every recorded edit becomes one core
 * transaction, made from the difference between edit snapshots:
 *
 * - record(label) marks that an edit happened; the difference is sent at the next
 *   flush(), which runs before the next edit captures its "before" state and before
 *   undo/redo, so each edit is exactly one transaction even when the snapshot is only
 *   brought up to date after record() (the normalize path);
 * - editBars() sends a measure edited in the live score (links not yet re-finished)
 *   directly, so the adapter can rebuild it with its linked neighbours instead of the
 *   whole song being normalized.
 *
 * Any core failure turns the session off (failed): the document keeps working on the
 * snapshot history, as without the setting. */
export class CoreSession{
 private core:Core|undefined;
 /** The snapshot the core currently equals. */
 private synced:ScoreData|undefined;
 private pending:string|null=null;
 failed=false;
 constructor(private report:(error:unknown)=>void=()=>{}){}
 get active(){return !this.failed&&!!this.core;}
 /** Starts the core from the current snapshot (once per document, on its first edit). */
 ensure(data:ScoreData){
  if(this.failed||this.core)return;
  try{this.core=Core.fromData(plain(data));this.synced=data;}catch(error){this.fail(error);}
 }
 /** An edit was recorded; its difference is sent at the next flush. */
 record(label:string){if(this.active)this.pending=label;}
 /** Sends the pending edit (data: the snapshot now). */
 flush(data:ScoreData){
  if(!this.active||this.pending===null)return;
  const label=this.pending;this.pending=null;
  try{this.core!.edit(label,snapshotOps(this.synced!,data));this.synced=data;}catch(error){this.fail(error);}
 }
 /** Replaces measures with their current JSON from `data` (measures edited in place
  * whose links are not re-finished): stale link ids are dropped, as normalizeEdit does. */
 editBars(label:string,data:ScoreData):Changes|undefined{
  if(!this.active)return undefined;
  try{
   const ops=snapshotOps(this.synced!,data).map(op=>{if(op.op==='replace'||op.op==='insert')cleanEditJson(op.node,false);return op;}) as EditOp[];
   const changes=this.core!.edit(label,ops);this.synced=data;this.pending=null;return changes;
  }catch(error){this.fail(error);return undefined;}
 }
 /** After the view was brought up to date from the core (adapter), the snapshot again
  * equals the core. */
 synchronized(data:ScoreData){if(this.active)this.synced=data;}
 /** Undo (back) or redo in the core; undefined when there is nothing to do or it failed. */
 history(back:boolean):Changes|undefined{
  if(!this.active)return undefined;
  try{return back?this.core!.undo():this.core!.redo();}catch(error){this.fail(error);return undefined;}
 }
 get coreForAdapter(){return this.core;}
 /** The core no longer matches the history (a step it did not record was undone on the
  * snapshot history): start it again from the current snapshot on the next edit. */
 reset(reason?:unknown){if(reason!==undefined)this.lastError=`reset: ${reason instanceof Error?`${reason.message}
${reason.stack??''}`:String(reason)}`;this.free();}
 /** Why the session stopped (for diagnostics). */
 lastError:string|undefined;
 private fail(error:unknown){this.failed=true;this.lastError=error instanceof Error?`${error.message}
${error.stack??''}`:String(error);this.report(error);this.free();}
 free(){this.core?.free();this.core=undefined;this.synced=undefined;this.pending=null;}
}
