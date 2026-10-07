import * as at from '@coderline/alphatab';
import {getLayout,setLayout} from './layout-settings';
export const settings = new at.Settings();
export type Score = at.model.Score;
export type Beat = at.model.Beat;
export type Note = at.model.Note;
export const serialize = (score: Score) => at.model.JsonConverter.scoreToJson(score);
export const deserialize = (json: string) => at.model.JsonConverter.jsonToScore(json, settings);
export function demoScore(): Score {
  return at.importer.ScoreLoader.loadAlphaTex(`\\title "First Session" \\artist "Tab Studio" \\tempo 110
\\track "Guitar" \\instrument 27 \\tuning E4 B3 G3 D3 A2 E2 .
:8 0.6 2.5 2.4 0.3 2.4 2.5 3.6 2.5 |
:4 (0.6 2.5 2.4) (3.6 2.5 0.4) (0.5 2.4 2.3) (2.5 4.4 4.3) |
:8 5.2 7.2 8.2 7.2 5.2 7.3 5.3 7.3 |
:2 (0.6 2.5 2.4 0.3 0.2 0.1) r`, settings);
}
export function beatQ(b: Beat): number {
  if (b.isFullBarRest) return b.voice.bar.masterBar.timeSignatureNumerator * 4 / b.voice.bar.masterBar.timeSignatureDenominator;
  return 4 / b.duration * (2 - 1 / 2 ** b.dots) * (b.hasTuplet ? b.tupletDenominator / b.tupletNumerator : 1);
}
export function voiceQ(v: at.model.Voice): number { return v.beats.reduce((a,b) => a + beatQ(b),0); }
export function project(score: Score, sourceName: string, warnings: string[]) {
  return JSON.stringify({ format: 'TabStudio', version: 1, sourceName, warnings, studio:{layout:getLayout(score)}, score: JSON.parse(serialize(score)) });
}
export function readProject(text: string): {score: Score; warnings: string[]; sourceName: string} {
  const p = JSON.parse(text);
  if (p.format !== 'TabStudio' || p.version !== 1 || !p.score) throw new Error('未対応のTab Studioファイルです。');
  const score = deserialize(JSON.stringify(p.score));
  if(p.studio?.layout)try{setLayout(score,p.studio.layout);}catch{}
  if (!score.tracks.length || !score.masterBars.length) throw new Error('譜面データが空です。');
  return {score, warnings: Array.isArray(p.warnings) ? p.warnings.map(String) : [], sourceName: String(p.sourceName || '')};
}
export function importGuitarPro(bytes: Uint8Array): Score {
  const score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  if (!score.tracks.length || !score.masterBars.length) throw new Error('トラックまたは小節がありません。');
  return score;
}
