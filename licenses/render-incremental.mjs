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
 * changed measures `edits`. Returns the first and last master bars rebuilt ([Infinity, -1]
 * when none), or false when the song must be rebuilt instead. */
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
 let first = Infinity, last = -1;
 for (const [t, list] of ranges) {
  list.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of list) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]); }
  for (const [lo, hi] of merged) { studioSwapRange(score, data, t, lo, hi, settings, JsonConverter); first = Math.min(first, lo); last = Math.max(last, hi); }
 }
 return [first, last];
}

/** The worker's Score for this render message: patched in place when only measures
 * changed, otherwise rebuilt from the snapshot. `self` keeps _studioScore (the snapshot)
 * and _studioModel (its Score). When the Score was patched, _studioRebuilt is set to the
 * first and last master bars rebuilt: layout can start at the first (the measures before it
 * are the same objects) and may keep the systems after the last. */
export function studioScoreFor(self, data, settings, JsonConverter) {
 const previous = self._studioScore;
 self._studioRebuilt = undefined;
 self._studioScore = data.studioPatch ? studioApplyPatch(previous, data.studioPatch) : data.score;
 if (self._studioScore == null) { self._studioModel = null; return null; }
 const edits = data.studioPatch && self._studioModel ? studioBarEdits(previous, data.studioPatch) : null;
 if (edits) {
  try {
   const rebuilt = edits.length ? studioPatchScore(self._studioModel, self._studioScore, edits, settings, JsonConverter) : [Infinity, -1];
   if (rebuilt !== false) { self._studioRebuilt = rebuilt; return self._studioModel; }
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
 * from the one containing that bar are sent, with `studioFrom` = their first bar. When
 * layout also kept the old systems after the change (layout.studioKeep = {bar, dy}: from
 * that first bar on, moved down by dy), those are not sent either: `studioKeep` tells the
 * main thread to keep its own bounds of them, moved by dy. */
export function studioBoundsMessage(self) {
 const message = studioBoundsOf(self), layout = self._renderer.layout;
 // How many systems layout kept (diagnostics for tests and profiling).
 message.studioReused = layout?.studioReused;
 if (layout) layout.studioReused = undefined;
 return message;
}

export function studioBoundsOf(self) {
 const lookup = self._renderer.boundsLookup, previous = self._studioSystems, layout = self._renderer.layout;
 // Layout may have started later than the main thread asked (layout.studioFirst).
 const first = self._studioPartial === undefined ? undefined : Math.max(self._studioPartial, layout?.studioFirst ?? -1);
 // Bounds are sent scaled (finish(scale)), so dy is too.
 const keep = layout?.studioKeep && { bar: layout.studioKeep.bar, dy: layout.studioKeep.dy * self._renderer.settings.display.scale };
 self._studioPartial = undefined;
 if (layout) { layout.studioKeep = undefined; layout.studioFirst = undefined; }
 if (!lookup) { self._studioSystems = undefined; return { boundsLookup: null }; }
 const systems = lookup.staffSystems;
 self._studioSystems = systems.slice();
 if (first !== undefined && previous) {
  const from = systems.findIndex(s => s.bars.length && s.bars[s.bars.length - 1].index >= first);
  const kept = keep ? systems.findIndex(s => s.bars.length && s.bars[0].index === keep.bar) : -1;
  if (from >= 0 && (from > 0 || kept > 0) && systems.slice(0, from).every((s, i) => s === previous[i])) {
   const message = { boundsLookup: lookup.toJson.call({ staffSystems: systems.slice(from, kept > from ? kept : undefined) }), studioFrom: systems[from].bars[0].index };
   if (kept > from) message.studioKeep = keep;
   // Check mode (tests): the whole lookup too, to compare with the merge.
   if (self._studioCheck) message.studioFull = lookup.toJson();
   return message;
  }
 }
 return { boundsLookup: lookup.toJson() };
}

/** Adds the bounds of one system to a lookup, moved down by dy (both threads: a system that
 * layout kept keeps its bounds, moved, on the main thread and in the worker alike). */
export function studioAddSystemBounds(lookup, system, dy) {
 if (dy) { system.visualBounds.y += dy; system.realBounds.y += dy; }
 lookup.addStaffSystem(system);
 for (const masterBar of system.bars) {
  if (dy) { masterBar.lineAlignedBounds.y += dy; masterBar.visualBounds.y += dy; masterBar.realBounds.y += dy; }
  lookup._masterBarLookup.set(masterBar.index, masterBar);
  for (const bar of masterBar.bars) {
   if (dy) { bar.visualBounds.y += dy; bar.realBounds.y += dy; }
   for (const beat of bar.beats) {
    if (dy) { beat.visualBounds.y += dy; beat.realBounds.y += dy; for (const note of beat.notes ?? []) note.noteHeadBounds.y += dy; }
    lookup.addBeat(beat);
   }
  }
 }
}

/** Main thread: merges the systems of a partial bounds message into the current lookup
 * (systems before `from` stay; with `keep`, its own systems from keep.bar on stay too,
 * moved down by keep.dy). Returns false when it cannot (no current lookup). */
export function studioMergeBounds(lookup, part, from, keep) {
 if (!lookup || !part) return false;
 const kept = keep ? lookup.staffSystems.filter(s => s.bars.length && s.bars[0].index >= keep.bar) : [];
 if (keep && kept[0]?.bars[0].index !== keep.bar) return false;
 lookup.resetForPartialUpdate();
 lookup.clearFromMasterBar(from);
 // The same lookup object changes: caches of it (the editor's hit testing) check this.
 lookup.studioRevision = (lookup.studioRevision ?? 0) + 1;
 for (const system of part.staffSystems) studioAddSystemBounds(lookup, system, 0);
 for (const system of kept) studioAddSystemBounds(lookup, system, keep.dy);
 lookup.finish();
 return true;
}

/** Check mode (tests): true when a merged lookup equals the whole lookup the worker sent
 * with it (to 1/1000 px: kept systems are moved by adding dy, which can differ in the last
 * bits), otherwise the first difference. */
export function studioSameBounds(merged, full) {
 const json = x => JSON.parse(JSON.stringify(x.toJson(), (k, v) => v instanceof Map ? Object.fromEntries(v) : v));
 const first = (a, b, path) => {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
   for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = first(a[key], b[key], path + '.' + key); if (d) return d; }
   return null;
  }
  if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-3) return null;
  return JSON.stringify(a) === JSON.stringify(b) ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`.slice(0, 300);
 };
 const m = json(merged), f = json(full), d = first(m, f, '');
 const bars = x => x.staffSystems.map(s => s.bars[0]?.index).join(',');
 return d ? `systems ${m.staffSystems.length}/${f.staffSystems.length} ${d} | ${bars(m)} || ${bars(f)}`.slice(0, 2000) : true;
}

/** All worker functions above, as source text for the worker. */
export const studioWorkerSource = [studioBarEdits, studioLinkedNote, studioLinkedBeat, studioCleanBoundary, studioSwapRange, studioPatchScore, studioScoreFor, studioApplyPatch, studioBoundsMessage, studioBoundsOf, studioAddSystemBounds].map(f => f.toString()).join('\n');
/** Main-thread functions, as source text for alphaTab's main module. */
export const studioMainSource = [studioAddSystemBounds, studioMergeBounds, studioSameBounds].map(f => f.toString()).join('\n');
