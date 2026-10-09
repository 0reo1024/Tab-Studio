/** MPL-2.0: reproducible source patch to alphaTab 1.8.4's worker score transfer.
 * alphaTab serializes the whole score on the main thread for every render. The
 * editor already keeps an identity-shared snapshot of the score, so the main
 * thread sends that snapshot, or only the paths that changed since the previous
 * render, and the layout worker rebuilds its copy.
 *
 * Contract: globalThis.__tabStudioRenderData = {data(score) -> snapshot | undefined,
 * diff(previous, next) -> patch}. Without it alphaTab behaves as shipped.
 */
function patcher(source,label){return (a,b)=>{if(!source.includes(a))throw new Error(`alphaTab ${label} patch mismatch: `+a.slice(0,65));source=source.replace(a,b);return source;};}
/** Main-thread side (bundled by Vite from node_modules). */
export function renderTransferMain(source){
 const replace=patcher(source,'render transfer');
 return replace('\trenderScore(score, trackIndexes, renderHints) {\n\t\tconst jsObject = score == null ? null : JsonConverter.scoreToJsObject(Environment.prepareForPostMessage(score));\n\t\tthis._worker.postMessage({\n\t\t\tcmd: "alphaTab.renderScore",\n\t\t\tscore: jsObject,',`\trenderScore(score, trackIndexes, renderHints) {
  const studio = score == null ? undefined : globalThis.__tabStudioRenderData?.data(score);
  let jsObject = null, studioPatch;
  if (studio !== undefined && this._studioSent !== undefined) studioPatch = globalThis.__tabStudioRenderData.diff(this._studioSent, studio);
  else jsObject = studio ?? (score == null ? null : JsonConverter.scoreToJsObject(Environment.prepareForPostMessage(score)));
  this._studioSent = studio;
\t\tthis._worker.postMessage({
\t\t\tcmd: "alphaTab.renderScore",
\t\t\tscore: jsObject, studioPatch,`);
}
/** Worker side (public/alphatab/alphaTab.core.mjs, loaded by alphaTab.worker.mjs). */
export function renderTransferWorker(source){
 const replace=patcher(source,'render transfer worker');
 replace('class AlphaTabWebWorker {',`/** Applies a snapshot patch: {r} replaces, {m,d} edits a Map, {a,n} edits an array. Untouched subtrees are shared. */
function studioApplyPatch(old, patch) {
 if ('r' in patch) return patch.r;
 if (patch.m) { const next = new Map(old instanceof Map ? old : []); for (const key of patch.d) next.delete(key); for (const [key, child] of patch.m) next.set(key, studioApplyPatch(next.get(key), child)); return next; }
 const next = (Array.isArray(old) ? old : []).slice(0, patch.n); for (const [i, child] of patch.a) next[i] = studioApplyPatch(next[i], child); return next;
}
class AlphaTabWebWorker {`);
 return replace('\t\t\t\tconst score = data.score == null ? null : JsonConverter.jsObjectToScore(data.score, this._renderer.settings);',`    this._studioScore = data.studioPatch ? studioApplyPatch(this._studioScore, data.studioPatch) : data.score;
\t\t\t\tconst score = this._studioScore == null ? null : JsonConverter.jsObjectToScore(this._studioScore, this._renderer.settings);`);
}
