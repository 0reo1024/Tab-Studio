/** The render-scheduler seam (migration P0-4/P3-0): how render requests that arrive
 * while alphaTab is still laying out are combined, and the short delay before redrawing
 * after fret entry. The document core (P3) feeds its change-sets through here. */
export type RenderRequest={reuseViewport:boolean;firstChangedMasterBar?:number;background:boolean};
/** A request queued behind another: background only if both are, keep the viewport only
 * if both do, and redraw from the earlier changed bar (undefined = everything). */
export function mergeRenderRequests(previous:RenderRequest|null|undefined,next:RenderRequest):RenderRequest{
 return {
  background:next.background&&(previous?.background??true),
  reuseViewport:next.reuseViewport&&(previous?.reuseViewport??true),
  firstChangedMasterBar:previous?(previous.firstChangedMasterBar===undefined||next.firstChangedMasterBar===undefined?undefined:Math.min(previous.firstChangedMasterBar,next.firstChangedMasterBar)):next.firstChangedMasterBar,
 };
}
/** Fret entry redraws once typing pauses (delay ms), from three bars before the earliest
 * edited bar, as a background render; while a render runs it retries every `retry` ms. */
export function createFretDrawScheduler(draw:(firstBar:number)=>void,busy:()=>boolean,delay=120,retry=50){
 let timer:ReturnType<typeof setTimeout>|undefined,pending:number|null=null;
 function flush(){clearTimeout(timer);if(pending===null)return;if(busy()){timer=setTimeout(flush,retry);return;}const bar=pending;pending=null;draw(Math.max(0,bar-3));}
 return {
  schedule(bar:number){pending=Math.min(pending??bar,bar);clearTimeout(timer);timer=setTimeout(flush,delay);},
  flush,
  cancel(){clearTimeout(timer);pending=null;},
  /** A fret redraw is waiting. */
  pending(){return pending!==null;},
 };
}
