import * as at from '@coderline/alphatab';
import {deserialize,serialize,type Score} from './score';
import {exportTg} from './tg-writer';
import {transferLayout} from './layout-settings';

export type ScoreFormat='gp'|'tg'|'mid';
export function exportScore(score:Score,format:ScoreFormat,sourceName='',warnings:string[]=[]):Uint8Array{
  // Exporters can set calculated fields; isolate them from the editable score.
  const copy=deserialize(serialize(score));
  transferLayout(score,copy);
  if(format==='tg')return exportTg(copy,sourceName,warnings);
  const settings=new at.Settings();
  if(format==='gp')return new at.exporter.Gp7Exporter().export(copy,settings);
  if(format!=='mid')throw new Error('未対応の出力形式です。');
  const midi=new at.midi.MidiFile();midi.format=at.midi.MidiFileFormat.MultiTrack;
  const handler=new at.midi.AlphaSynthMidiFileHandler(midi,true);
  const generator=new at.midi.MidiFileGenerator(copy,settings,handler);
  generator.applyTranspositionPitches=true;generator.generate();
  return midi.toBinary();
}
