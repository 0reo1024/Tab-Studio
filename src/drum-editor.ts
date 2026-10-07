import * as at from '@coderline/alphatab';
export const drumSounds:[number,string][]=[[36,'バスドラム'],[35,'アコースティック・バスドラム'],[38,'スネア'],[40,'エレクトリック・スネア'],[37,'サイドスティック'],[42,'クローズ・ハイハット'],[46,'オープン・ハイハット'],[44,'ペダル・ハイハット'],[49,'クラッシュ'],[57,'クラッシュ2'],[51,'ライド'],[59,'ライド2'],[53,'ライド・ベル'],[41,'ロー・フロアタム'],[43,'ハイ・フロアタム'],[45,'ロータム'],[47,'ローミッド・タム'],[48,'ハイミッド・タム'],[50,'ハイタム'],[39,'ハンドクラップ'],[54,'タンバリン'],[56,'カウベル'],[55,'スプラッシュ'],[52,'チャイナ・シンバル']];
export function setDrum(beat:at.model.Beat,articulation:number,index:number,add=false){
 if(!beat.voice.bar.staff.isPercussion||!drumSounds.some(([id])=>id===articulation))throw new Error('ドラムの音を選択してください。');
 const old=add?undefined:beat.notes[index],same=beat.notes.find(n=>n!==old&&n.percussionArticulation===articulation);if(same)throw new Error('同じ拍にそのドラム音があります。');
 const note=old??new at.model.Note();note.string=-1;note.fret=-1;note.percussionArticulation=articulation;if(!old)beat.addNote(note);beat.isEmpty=false;return beat.notes.indexOf(note);
}
