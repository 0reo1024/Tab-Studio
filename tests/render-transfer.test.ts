import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import {readFileSync} from 'node:fs';
import {settings,serialize} from '../src/score';
import {EditSnapshot} from '../src/edit-snapshot';
import {snapshotDiff} from '../src/snapshot-diff';
import {refinishBar} from '../src/bar-edit';
import {resizeBeat} from '../src/editor';
import {renderTransferMain,renderTransferWorker} from '../scripts/render-patch.mjs';
const patchSource=readFileSync(new URL('../scripts/render-patch.mjs',import.meta.url),'utf8');
// The worker-side apply function as it is injected into alphaTab.
const body=/function studioApplyPatch\(old, patch\) \{([\s\S]*?)\n\}\nclass AlphaTabWebWorker/.exec(patchSource)![1];
const apply=new Function('old','patch',`const studioApplyPatch=(o,p)=>f(o,p);function f(old,patch){${body}}return f(old,patch);`) as (old:unknown,patch:unknown)=>unknown;
const plain=(v:unknown)=>JSON.stringify(v,(_k,x)=>x instanceof Map?Object.fromEntries(x):x);
test('a render transfer patch rebuilds the edited snapshot in the layout worker',()=>{
 const score=at.importer.ScoreLoader.loadAlphaTex('\\track "Guitar" . :4 3.1 5.1 7.1 9.1 | 3.1 5.1 7.1 9.1 | 1.1 2.1 3.1 4.1 \\track "Bass" \\tuning G2 D2 A1 E1 . :1 3.4 | 5.4 | 7.4',settings);
 const snapshot=new EditSnapshot(),sent=snapshot.get(score),workerCopy=structuredClone(sent);
 const bar=score.tracks[0].staves[0].bars[1];resizeBeat(bar.voices[0].beats[0],8,0,1,1);refinishBar(bar);snapshot.patchBar(score,bar);
 const next=snapshot.get(score),patch=snapshotDiff(sent,next);
 assert.ok(plain(patch).length<plain(next).length/4,'only the edited path is sent');
 const rebuilt=apply(workerCopy,patch);assert.equal(plain(rebuilt),plain(next));
 // jsObjectToScore reads its input without modifying it, so the worker may keep it for the next patch.
 const before=plain(rebuilt),restored=at.model.JsonConverter.jsObjectToScore(rebuilt as any,settings);assert.equal(plain(rebuilt),before);assert.equal(serialize(restored),serialize(score));
 assert.deepEqual(apply(workerCopy,snapshotDiff(sent,sent)),workerCopy,'an empty patch keeps the copy');
});
test('both halves of the alphaTab render-transfer patch apply to the shipped source',()=>{
 const source=readFileSync(new URL('../node_modules/@coderline/alphatab/dist/alphaTab.core.mjs',import.meta.url),'utf8');
 assert.match(renderTransferMain(source),/__tabStudioRenderData\?\.data\(score\)/);assert.match(renderTransferWorker(source),/studioApplyPatch\(this\._studioScore, data\.studioPatch\)/);
 assert.match(readFileSync(new URL('../public/alphatab/alphaTab.core.mjs',import.meta.url),'utf8'),/studioApplyPatch\(this\._studioScore/,'public worker copy is regenerated');
});
