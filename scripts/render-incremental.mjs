/** MPL-2.0 (part of the alphaTab render patch, see render-patch.mjs): the layout worker
 * keeps its Score between renders and rebuilds only the measures a snapshot patch
 * changed, instead of the whole song from JSON on every render (130-240 ms on a
 * 600-bar, 8-track song).
 *
 * These functions are injected into alphaTab's worker by their source text, so they use
 * no imports or closures: alphaTab's JsonConverter is passed in. They are also exported
 * for tests. Like the document core's adapter (src/core/adapter.ts), a changed measure is
 * widened to the range of its track that no link (tie, slide, hammer-on, slur, palm mute,
 * let ring, bend, grace, fermata, pedal) crosses; that range is rebuilt as a small song
 * behind a copy of its first measure and swapped in, and the boundary beats rejoined.
 */

/** The measures [track, staff, bar] a snapshot patch changes, when it changes nothing
 * else and keeps every list length; null otherwise (the worker then rebuilds the song). */
export function studioBarEdits(old, patch) {
 if (!old || !patch || 'r' in patch || !patch.m || patch.d.length) return null;
 const out = [];
 for (const [key, tp] of patch.m) {
  if (key !== 'tracks' || 'r' in tp || tp.m) return null;
  const tracks = old.get('tracks');
  if (!Array.isArray(tracks) || tp.n !== tracks.length) return null;
  for (const [t, tr] of tp.a) {
   if (!tracks[t] || 'r' in tr || !tr.m || tr.d.length) return null;
   for (const [key2, sp] of tr.m) {
    const staves = tracks[t].get('staves');
    if (key2 !== 'staves' || 'r' in sp || sp.m || sp.n !== staves.length) return null;
    for (const [s, st] of sp.a) {
     if (!staves[s] || 'r' in st || !st.m || st.d.length) return null;
     for (const [key3, bp] of st.m) {
      if (key3 !== 'bars' || 'r' in bp || bp.m || bp.n !== staves[s].get('bars').length) return null;
      for (const [b] of bp.a) out.push([t, s, b]);
     }
    }
   }
  }
 }
 return out;
}

export function studioLinkedNote(n) {
 return n.isTieOrigin || n.isTieDestination || n.isHammerPullOrigin || n.isHammerPullDestination || !!n.slideOrigin || !!n.slideTarget || n.slideOutType !== 0 || n.slideInType !== 0 || n.hasEffectSlur || !!n.effectSlurOrigin || n.isEffectSlurOrigin || n.isLetRing || n.isPalmMute || !!n.bendOrigin || n.isContinuedBend;
}

export function studioLinkedBeat(b) {
 return !!b && (b.isLetRing || b.isPalmMute || b.hasWhammyBar || b.isContinuedWhammy || b.graceType !== 0 || !!b.fermata || b.notes.some(studioLinkedNote));
}

/** No link crosses the boundary before measure i of this track. */
export function studioCleanBoundary(track, i) {
 return track.staves.every(st => {
  const a = st.bars[i - 1], b = st.bars[i];
  if (!a || !b) return true;
  if (a.sustainPedals.length || b.sustainPedals.length) return false;
  return b.voices.every(v => !studioLinkedBeat(v.beats[0])) && a.voices.every(v => !studioLinkedBeat(v.beats[v.beats.length - 1]));
 });
}

/** Rebuilds measures lo..hi of track t from the snapshot `data` and swaps them into `score`. */
export function studioSwapRange(score, data, t, lo, hi, settings, JsonConverter) {
 const prefix = lo > 0 ? 1 : 0, masterbars = data.get('masterbars');
 const mini = new Map(data);
 mini.set('masterbars', [...(prefix ? [masterbars[lo]] : []), ...masterbars.slice(lo, hi + 1)]);
 const track = new Map(data.get('tracks')[t]);
 track.set('staves', track.get('staves').map(st => { const c = new Map(st), bars = st.get('bars').slice(lo, hi + 1); c.set('bars', prefix ? [bars[0], ...bars] : bars); return c; }));
 mini.set('tracks', [track]);
 const built = JsonConverter.jsObjectToScore(mini, settings).tracks[0], live = score.tracks[t];
 if (built.staves.length !== live.staves.length) throw new Error('staff count');
 for (const [s, staff] of live.staves.entries()) {
  const fresh = built.staves[s].bars.slice(prefix);
  if (fresh.length !== hi - lo + 1 || fresh.some((bar, k) => bar.voices.length !== staff.bars[lo + k].voices.length)) throw new Error('voice count');
  fresh.forEach((bar, k) => { bar.staff = staff; bar.index = lo + k; staff.bars[lo + k] = bar; });
  for (let i = lo; i <= hi; i++) { const bar = staff.bars[i]; bar.previousBar = staff.bars[i - 1] ?? null; bar.nextBar = staff.bars[i + 1] ?? null; }
  const before = staff.bars[lo - 1], after = staff.bars[hi + 1];
  if (before) before.nextBar = staff.bars[lo];
  if (after) after.previousBar = staff.bars[hi];
  for (const v of staff.bars[lo].voices) { const last = before?.voices[v.index]?.beats[before.voices[v.index].beats.length - 1], first = v.beats[0]; if (first) first.previousBeat = last ?? null; if (last) last.nextBeat = first ?? null; }
  for (const v of staff.bars[hi].voices) { const first = after?.voices[v.index]?.beats[0], last = v.beats[v.beats.length - 1]; if (last) last.nextBeat = first ?? null; if (first) first.previousBeat = last ?? null; }
 }
}

/** Brings `score` (the worker's Score for the previous snapshot) up to `data` for the
 * changed measures `edits`; returns false when the song must be rebuilt instead. */
export function studioPatchScore(score, data, edits, settings, JsonConverter) {
 const ranges = new Map();
 for (const [t, , b] of edits) {
  const track = score.tracks[t];
  if (!track) return false;
  const count = track.staves[0]?.bars.length ?? 0;
  let lo = b, hi = b;
  while (lo > 0 && !studioCleanBoundary(track, lo)) lo--;
  while (hi + 1 < count && !studioCleanBoundary(track, hi + 1)) hi++;
  const list = ranges.get(t) ?? [];
  list.push([lo, hi]);
  ranges.set(t, list);
 }
 for (const [t, list] of ranges) {
  list.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of list) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]); }
  for (const [lo, hi] of merged) studioSwapRange(score, data, t, lo, hi, settings, JsonConverter);
 }
 return true;
}

/** The worker's Score for this render message: patched in place when only measures
 * changed, otherwise rebuilt from the snapshot. `self` keeps _studioScore (the snapshot)
 * and _studioModel (its Score). */
export function studioScoreFor(self, data, settings, JsonConverter) {
 const previous = self._studioScore;
 self._studioScore = data.studioPatch ? studioApplyPatch(previous, data.studioPatch) : data.score;
 if (self._studioScore == null) { self._studioModel = null; return null; }
 const edits = data.studioPatch && self._studioModel ? studioBarEdits(previous, data.studioPatch) : null;
 if (edits) {
  try {
   if (!edits.length || studioPatchScore(self._studioModel, self._studioScore, edits, settings, JsonConverter)) return self._studioModel;
  } catch { /* rebuild below */ }
 }
 self._studioModel = JsonConverter.jsObjectToScore(self._studioScore, settings);
 return self._studioModel;
}

/** Applies a snapshot patch: {r} replaces, {m,d} edits a Map, {a,n} edits an array. Untouched subtrees are shared. */
export function studioApplyPatch(old, patch) {
 if ('r' in patch) return patch.r;
 if (patch.m) { const next = new Map(old instanceof Map ? old : []); for (const key of patch.d) next.delete(key); for (const [key, child] of patch.m) next.set(key, studioApplyPatch(next.get(key), child)); return next; }
 const next = (Array.isArray(old) ? old : []).slice(0, patch.n); for (const [i, child] of patch.a) next[i] = studioApplyPatch(next[i], child); return next;
}

/** The bounds (note positions) the worker sends after a render. alphaTab sends the whole
 * BoundsLookup every time and the main thread rebuilds it (about 240 ms, 140 ms of it
 * blocking, on a 600-bar, 8-track song). When the main thread said it can merge
 * (self._studioPartial = the render's first changed master bar) and the layout really
 * kept the systems before it (same objects as at the previous send), only the systems
 * from the one containing that bar are sent, with `studioFrom` = their first bar. */
export function studioBoundsMessage(self) {
 const lookup = self._renderer.boundsLookup, first = self._studioPartial, previous = self._studioSystems;
 self._studioPartial = undefined;
 if (!lookup) { self._studioSystems = undefined; return { boundsLookup: null }; }
 const systems = lookup.staffSystems;
 self._studioSystems = systems.slice();
 if (first !== undefined && previous) {
  const from = systems.findIndex(s => s.bars.length && s.bars[s.bars.length - 1].index >= first);
  if (from > 0 && systems.slice(0, from).every((s, i) => s === previous[i])) {
   return { boundsLookup: lookup.toJson.call({ staffSystems: systems.slice(from) }), studioFrom: systems[from].bars[0].index };
  }
 }
 return { boundsLookup: lookup.toJson() };
}

/** Main thread: merges the systems of a partial bounds message into the current lookup
 * (systems before `from` stay). Returns false when it cannot (no current lookup). */
export function studioMergeBounds(lookup, part, from) {
 if (!lookup || !part) return false;
 lookup.resetForPartialUpdate();
 lookup.clearFromMasterBar(from);
 for (const system of part.staffSystems) {
  lookup.addStaffSystem(system);
  for (const masterBar of system.bars) {
   lookup._masterBarLookup.set(masterBar.index, masterBar);
   for (const bar of masterBar.bars) for (const beat of bar.beats) lookup.addBeat(beat);
  }
 }
 lookup.finish();
 return true;
}

/** All worker functions above, as source text for the worker. */
export const studioWorkerSource = [studioBarEdits, studioLinkedNote, studioLinkedBeat, studioCleanBoundary, studioSwapRange, studioPatchScore, studioScoreFor, studioApplyPatch, studioBoundsMessage].map(f => f.toString()).join('\n');
/** Main-thread functions, as source text for alphaTab's main module. */
export const studioMainSource = [studioMergeBounds].map(f => f.toString()).join('\n');
