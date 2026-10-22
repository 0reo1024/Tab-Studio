/** countBeats: clicks before the music starts (0: no count-in). */
export type PracticeSettings={countBeats:number;countOnResume:boolean;countEachLoop:boolean};
export const MAX_COUNT_BEATS=32;
export type TrainerSettings={start:number;end:number;step:number;repetitions:number;keepPlaying:boolean};
export const defaultPractice:PracticeSettings={countBeats:0,countOnResume:false,countEachLoop:false};
/** Settings saved before counts were set in clicks gave bars (1 or 2): four clicks each. */
export function readPractice(text:string|null):PracticeSettings{try{const p=JSON.parse(text||'{}');const beats=Number.isInteger(p.countBeats)&&p.countBeats>=0&&p.countBeats<=MAX_COUNT_BEATS?p.countBeats:[1,2].includes(p.countBars)?p.countBars*4:0;return {countBeats:beats,countOnResume:p.countOnResume===true,countEachLoop:p.countEachLoop===true};}catch{return {...defaultPractice};}}
export function trainerSettings(p:TrainerSettings){if(![p.start,p.end,p.step,p.repetitions].every(Number.isInteger)||p.start<20||p.end>200||p.end<p.start||p.step<1||p.step>100||p.repetitions<1||p.repetitions>100)throw new Error('速度は20〜200%、開始≦終了、上昇幅と反復回数は1〜100で指定してください。');return {...p};}
/** Count engine completion events, never cursor jumps (repeats and seeks). */
export class SpeedTrainer{
 settings:TrainerSettings;speed:number;completed=0;finished=false;private interrupted=false;
 constructor(p:TrainerSettings){this.settings=trainerSettings(p);this.speed=p.start;}
 interrupt(){this.interrupted=true;}
 complete(){if(this.finished)return;if(this.interrupted){this.interrupted=false;return;}this.completed++;if(this.completed<this.settings.repetitions)return;this.completed=0;if(this.speed===this.settings.end){if(!this.settings.keepPlaying)this.finished=true;return;}this.speed=Math.min(this.settings.end,this.speed+this.settings.step);}
}
/** `count` clicks, one per beat of the starting meter (an 8th in 6/8), ending one beat before the
 * music; accented where a bar would begin counting back from the start. */
export function countPattern(numerator:number,denominator:number,bpm:number,speed:number,count:number){if(!Number.isFinite(bpm)||bpm<=0||speed<=0)throw new Error('テンポを確認してください。');const interval=60/bpm/speed*4/denominator;return {duration:count*interval,ticks:Array.from({length:count},(_,i)=>({offset:i*interval,accent:(count-i)%numerator===0,remaining:count-i}))};}
