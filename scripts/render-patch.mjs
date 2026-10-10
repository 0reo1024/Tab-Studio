/** MPL-2.0: reproducible source patch to alphaTab 1.8.4's worker score transfer.
 * alphaTab serializes the whole score on the main thread for every render. The
 * editor already keeps an identity-shared snapshot of the score, so the main
 * thread sends that snapshot, or only the paths that changed since the previous
 * render, and the layout worker updates its copy. After the render the worker sends
 * back only the note bounds of the systems it laid out again, when the main thread
 * can merge them (render-incremental.mjs).
 *
 * Contract: globalThis.__tabStudioRenderData = {data(score) -> snapshot | undefined,
 * diff(previous, next) -> patch}. Without it alphaTab behaves as shipped.
 */
import {studioWorkerSource,studioMainSource} from './render-incremental.mjs';
function patcher(source,label){return (a,b)=>{if(!source.includes(a))throw new Error(`alphaTab ${label} patch mismatch: `+a.slice(0,65));source=source.replace(a,b);return source;};}
/** Main-thread side (bundled by Vite from node_modules). */
export function renderTransferMain(source){
 const replace=patcher(source,'render transfer');
 replace('class BoundsLookup {',studioMainSource+'\nclass BoundsLookup {');
 replace('\t\t\tcase "alphaTab.postRenderFinished":\n\t\t\t\tif (this._api.score && data.boundsLookup) {\n\t\t\t\t\tthis.boundsLookup = BoundsLookup.fromJson(data.boundsLookup, this._api.score);\n\t\t\t\t\tthis.boundsLookup?.finish();\n\t\t\t\t}',`\t\t\tcase "alphaTab.postRenderFinished":
\t\t\t\tif (this._api.score && data.boundsLookup) {
\t\t\t\t\tconst merged = data.studioFrom !== undefined && this._studioBoundsScore === this._api.score && studioMergeBounds(this.boundsLookup, BoundsLookup.fromJson(data.boundsLookup, this._api.score), data.studioFrom);
\t\t\t\t\t// A partial message that cannot be merged is dropped (the next render sends everything).
\t\t\t\t\tif (!merged && data.studioFrom === undefined) {
\t\t\t\t\t\tthis.boundsLookup = BoundsLookup.fromJson(data.boundsLookup, this._api.score);
\t\t\t\t\t\tthis.boundsLookup?.finish();
\t\t\t\t\t}
\t\t\t\t\tif (merged || data.studioFrom === undefined) this._studioBoundsScore = this._api.score;
\t\t\t\t}`);
 return replace('\trenderScore(score, trackIndexes, renderHints) {\n\t\tconst jsObject = score == null ? null : JsonConverter.scoreToJsObject(Environment.prepareForPostMessage(score));\n\t\tthis._worker.postMessage({\n\t\t\tcmd: "alphaTab.renderScore",\n\t\t\tscore: jsObject,',`\trenderScore(score, trackIndexes, renderHints) {
  const studio = score == null ? undefined : globalThis.__tabStudioRenderData?.data(score);
  let jsObject = null, studioPatch;
  if (studio !== undefined && this._studioSent !== undefined) studioPatch = globalThis.__tabStudioRenderData.diff(this._studioSent, studio);
  else jsObject = studio ?? (score == null ? null : JsonConverter.scoreToJsObject(Environment.prepareForPostMessage(score)));
  this._studioSent = studio;
  // Bounds can be merged when the same Score is rendered for the same tracks from a known first changed bar.
  const studioTracks = JSON.stringify(trackIndexes ?? null);
  const studioPartialBounds = !!this.boundsLookup && this._studioBoundsScore === score && this._studioTracks === studioTracks && renderHints?.firstChangedMasterBar !== undefined;
  this._studioTracks = studioTracks;
  if (!studioPartialBounds) this._studioBoundsScore = undefined;
\t\tthis._worker.postMessage({
\t\t\tcmd: "alphaTab.renderScore",
\t\t\tscore: jsObject, studioPatch, studioPartialBounds,`);
}
/** Worker side (public/alphatab/alphaTab.core.mjs, loaded by alphaTab.worker.mjs). The
 * worker keeps its Score between renders and rebuilds only the measures a patch changed,
 * and sends back only the bounds of the systems it laid out again when it can. */
export function renderTransferWorker(source){
 const replace=patcher(source,'render transfer worker');
 replace('class AlphaTabWebWorker {',studioWorkerSource+'\nclass AlphaTabWebWorker {');
 replace('\t\t\t\t\t\tcmd: "alphaTab.postRenderFinished",\n\t\t\t\t\t\tboundsLookup: this._renderer.boundsLookup?.toJson() ?? null','\t\t\t\t\t\tcmd: "alphaTab.postRenderFinished",\n\t\t\t\t\t\t...studioBoundsMessage(this)');
 replace('\t\t\t\tconst renderHints = data.renderHints;\n','\t\t\t\tconst renderHints = data.renderHints;\n\t\t\t\tthis._studioPartial = data.studioPartialBounds ? renderHints?.firstChangedMasterBar : undefined;\n');
 return replace('\t\t\t\tconst score = data.score == null ? null : JsonConverter.jsObjectToScore(data.score, this._renderer.settings);','\t\t\t\tconst score = studioScoreFor(this, data, this._renderer.settings, JsonConverter);');
}
