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
\t\t\t\t\tconst merged = data.studioFrom !== undefined && this._studioBoundsScore === this._api.score && studioMergeBounds(this.boundsLookup, BoundsLookup.fromJson(data.boundsLookup, this._api.score), data.studioFrom, data.studioKeep);
\t\t\t\t\t// A partial message that cannot be merged is dropped (the next render sends everything).
\t\t\t\t\tif (!merged && data.studioFrom === undefined) {
\t\t\t\t\t\tthis.boundsLookup = BoundsLookup.fromJson(data.boundsLookup, this._api.score);
\t\t\t\t\t\tthis.boundsLookup?.finish();
\t\t\t\t\t}
\t\t\t\t\tif (merged || data.studioFrom === undefined) this._studioBoundsScore = this._api.score;
\t\t\t\t\t// Check mode (tests): each merge is compared with the whole lookup the worker also sent.
\t\t\t\t\tif (merged && data.studioFull) { const full = BoundsLookup.fromJson(data.studioFull, this._api.score); full.finish(); (this.studioBoundsChecks ??= []).push(studioSameBounds(this.boundsLookup, full)); }
\t\t\t\t}`);
 // Placeholders (one per system): an unchanged system laid out again keeps its drawing, and
 // one that was on screen is drawn again at once instead of after the next visibility check.
 replace('\t\t\tplaceholder.style.zIndex = "1";\n',`\t\t\tif (renderResult.reuseViewport && placeholder.renderedResultId === renderResult.id && (placeholder.resultState === 2 || placeholder.resultState === 3)) {
\t\t\t\tplaceholder.style.left = renderResult.x + "px";
\t\t\t\tplaceholder.style.top = renderResult.y + "px";
\t\t\t\tplaceholder.style.width = renderResult.width + "px";
\t\t\t\tplaceholder.style.height = renderResult.height + "px";
\t\t\t\tplaceholder.layoutResultId = renderResult.id;
\t\t\t\tthis._resultIdToElementLookup.set(renderResult.id, placeholder);
\t\t\t\tfor (let i = renderResult.firstMasterBarIndex; i <= renderResult.lastMasterBarIndex; i++) if (i >= 0) this._barToElementLookup.set(i, placeholder);
\t\t\t\tthis._totalResultCount++;
\t\t\t\treturn;
\t\t\t}
\t\t\tconst studioOnScreen = !!renderResult.reuseViewport && placeholder.resultState === 2;
\t\t\tplaceholder.style.zIndex = "1";
`);
 replace('\t\t\t\tthis._intersectionObserver.observe(placeholder);\n\t\t\t}\n\t\t\tthis._totalResultCount++;',`\t\t\t\tthis._intersectionObserver.observe(placeholder);
\t\t\t\tif (studioOnScreen) {
\t\t\t\t\tplaceholder.resultState = 1;
\t\t\t\t\tthis._api.renderer.renderResult(renderResult.id);
\t\t\t\t}
\t\t\t}
\t\t\tthis._totalResultCount++;`);
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
\t\t\tscore: jsObject, studioPatch, studioPartialBounds, studioCheckBounds: !!this.studioCheckBounds,`);
}
/** Worker side (public/alphatab/alphaTab.core.mjs, loaded by alphaTab.worker.mjs). The
 * worker keeps its Score between renders and rebuilds only the measures a patch changed,
 * and sends back only the bounds of the systems it laid out again when it can. */
export function renderTransferWorker(source){
 const replace=patcher(source,'render transfer worker');
 replace('class AlphaTabWebWorker {',studioWorkerSource+'\nclass AlphaTabWebWorker {');
 replace('\t\t\t\t\t\tcmd: "alphaTab.postRenderFinished",\n\t\t\t\t\t\tboundsLookup: this._renderer.boundsLookup?.toJson() ?? null','\t\t\t\t\t\tcmd: "alphaTab.postRenderFinished",\n\t\t\t\t\t\t...studioBoundsMessage(this)');
 replace('\t\t\t\tconst renderHints = data.renderHints;\n','\t\t\t\tconst renderHints = data.renderHints;\n\t\t\t\tthis._studioPartial = data.studioPartialBounds ? renderHints?.firstChangedMasterBar : undefined;\n\t\t\t\tthis._studioCheck = data.studioCheckBounds;\n');
 replace('\t\t\t\tconst score = data.score == null ? null : JsonConverter.jsObjectToScore(data.score, this._renderer.settings);','\t\t\t\tconst score = studioScoreFor(this, data, this._renderer.settings, JsonConverter);');
 // When the Score was patched in place, layout may keep the systems after the last changed bar.
 replace('\t\t\t\tthis._renderMultiple(score, data.trackIndexes, renderHints);','\t\t\t\tthis._renderMultiple(score, data.trackIndexes, renderHints && this._studioRebuilt ? { ...renderHints, studioRebuilt: this._studioRebuilt } : renderHints);');
 // Layout starts at the first measure the worker rebuilt when that is later than the main
 // thread's hint (the editor asks from 3 bars before an edit); the measures before it are
 // the same objects. Not with multi-bar rests, which group measures across that point.
 replace('\t\tconst firstModifiedMasterBar = renderHints.firstChangedMasterBar;','\t\tconst studioFirst = renderHints.studioRebuilt && (!this.multiBarRestInfo || this.multiBarRestInfo.size === 0) && renderHints.studioRebuilt[0] !== Infinity ? Math.max(renderHints.firstChangedMasterBar, renderHints.studioRebuilt[0]) : undefined;\n\t\tthis.studioFirst = studioFirst;\n\t\tconst firstModifiedMasterBar = studioFirst ?? renderHints.firstChangedMasterBar;');
 replace('\t\tthis.renderer.boundsLookup.clearFromMasterBar(firstRebuiltBarIndex);','\t\tconst studioOldBounds = this.renderer.boundsLookup.staffSystems.filter((s) => s.bars.length > 0 && s.bars[0].index >= firstRebuiltBarIndex);\n\t\tthis.renderer.boundsLookup.clearFromMasterBar(firstRebuiltBarIndex);');
 replace('\t\tthis._systemPartialIds.splice(systemIndex, this._systemPartialIds.length - systemIndex);','\t\tconst studioOldIds = this._systemPartialIds.splice(systemIndex, this._systemPartialIds.length - systemIndex);');
 replace('\t\ty = this._layoutAndRenderScore(y, firstBarIndex);\n\t\ty = this.layoutAndRenderBottomScoreInfo(y);','\t\ty = this._studioLayoutFrom(y, firstBarIndex, removeSystems, renderHints.studioRebuilt?.[1], studioOldIds, studioOldBounds);\n\t\ty = this.layoutAndRenderBottomScoreInfo(y);');
 return replace('\t_layoutAndRenderScore(y, startIndex) {',`\t/** Tab Studio: _layoutAndRenderScore for a partial update. Once layout has passed the
\t * last changed bar (reuseAfter, known when the worker patched its Score in place), an old
\t * system that starts exactly there, at the same system index, is kept with all systems
\t * after it instead of being laid out again: moved to the new y under its old partial id,
\t * so the page keeps its drawing. oldIds: the partial ids of the old systems; the ones not
\t * kept are dropped (alphaTab keeps every partial it ever laid out otherwise). */
\t_studioLayoutFrom(y, startIndex, old, reuseAfter, oldIds, oldBounds) {
\t\tconst drop = (ids) => { for (const id of ids) this._lazyPartials.delete(id); };
\t\tlet currentBarIndex = startIndex;
\t\tconst endBarIndex = this.lastBarIndex;
\t\tthis.studioReused = 0;
\t\tthis.studioKeep = undefined;
\t\tconst canReuse = reuseAfter !== undefined && (!this.multiBarRestInfo || this.multiBarRestInfo.size === 0) && old.length > 0 && old[old.length - 1].lastBarIndex === endBarIndex;
\t\twhile (currentBarIndex <= endBarIndex) {
\t\t\tif (canReuse && currentBarIndex > reuseAfter) {
\t\t\t\tconst k = old.findIndex((s) => s.firstBarIndex === currentBarIndex);
\t\t\t\t// A slur still open towards the kept systems would have been completed by their layout.
\t\t\t\t// (One that ends before them, or in a staff not shown, is never completed: no matter.)
\t\t\t\tconst openSlur = [...this.slurRegistry._staffLookup.values()].some((c) => [...c.startedSlurs.values()].some((i) => {
\t\t\t\t\tif (i.endGlyph) return false;
\t\t\t\t\tconst end = (i.startGlyph.endNote?.beat ?? i.startGlyph.endBeat)?.voice.bar.masterBar.index;
\t\t\t\t\treturn end === undefined || end >= currentBarIndex;
\t\t\t\t}));
\t\t\t\tif (k >= 0 && old[k].index === this._systems.length && !openSlur) {
\t\t\t\t\tthis.studioReused = old.length - k;
\t\t\t\t\tthis.studioKeep = { bar: currentBarIndex, dy: y - old[k].y };
\t\t\t\t\t// Bars carried over from the last system start the kept one; they are laid out there already.
\t\t\t\t\tthis._barsFromPreviousSystem = [];
\t\t\t\t\tdrop(oldIds.slice(0, k));
\t\t\t\t\tconst scale = this.renderer.settings.display.scale;
\t\t\t\t\tfor (const [j, system] of old.slice(k).entries()) {
\t\t\t\t\t\tfor (const staff of system.allStaves) for (const renderer of staff.barRenderers) this.registerBarRenderer(staff.staffId, renderer);
\t\t\t\t\t\tthis._systems.push(system);
\t\t\t\t\t\tsystem.y = y;
\t\t\t\t\t\tconst id = oldIds[k + j], args = id === undefined ? undefined : this.getExistingPartialArgs(id);
\t\t\t\t\t\tif (args) {
\t\t\t\t\t\t\t// Its drawing is relative to the system, so only the place changes (the paint
\t\t\t\t\t\t\t// callback reads args.y when it runs).
\t\t\t\t\t\t\t// Its bounds too: the old ones, moved, as the main thread does (built again they
\t\t\t\t\t\t\t// can differ once the system has been drawn).
\t\t\t\t\t\t\tconst bounds = oldBounds.find((b) => b.bars[0].index === system.firstBarIndex);
\t\t\t\t\t\t\tif (bounds) studioAddSystemBounds(this.renderer.boundsLookup, bounds, y * scale - args.y);
\t\t\t\t\t\t\telse system.buildBoundingsLookup(0, 0);
\t\t\t\t\t\t\targs.y = y * scale;
\t\t\t\t\t\t\tthis.reregisterPartial(id);
\t\t\t\t\t\t\tthis._systemPartialIds.push(id);
\t\t\t\t\t\t\ty += Math.floor(system.height);
\t\t\t\t\t\t} else y += this._paintSystem(system, y);
\t\t\t\t\t}
\t\t\t\t\treturn y;
\t\t\t\t}
\t\t\t}
\t\t\tconst system = this._createStaffSystem(currentBarIndex, endBarIndex);
\t\t\tthis._systems.push(system);
\t\t\tsystem.x = this.pagePadding[0];
\t\t\tsystem.y = y;
\t\t\tcurrentBarIndex = system.lastBarIndex + 1;
\t\t\tthis._fitSystem(system);
\t\t\ty += this._paintSystem(system, y);
\t\t}
\t\tdrop(oldIds);
\t\treturn y;
\t}
\t_layoutAndRenderScore(y, startIndex) {`);
}
