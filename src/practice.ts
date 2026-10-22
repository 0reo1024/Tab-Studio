/** countIn: count in at all; countBeats: how many clicks (1-32). */
export type PracticeSettings={countIn:boolean;countBeats:number;countOnResume:boolean;countEachLoop:boolean};
export const MAX_COUNT_BEATS=32;
export type TrainerSettings={start:number;end:number;step:number;repetitions:number;keepPlaying:boolean};
export const defaultPractice:PracticeSettings={countIn:false,countBeats:4,countOnResume:false,countEachLoop:false};
/** Settings saved before counts were set in clicks gave bars (0-2): four clicks each, on when not 0. */
export function readPractice(text:string|null):PracticeSettings{try{const p=JSON.parse(text||'{}');const valid=(n:unknown):n is number=>Number.isInteger(n)&&(n as number)>=1&&(n as number)<=MAX_COUNT_BEATS,bars=[1,2].includes(p.countBars)?p.countBars*4:null;
 const beats=valid(p.countBeats)?p.countBeats:bars??4,on=typeof p.countIn==='boolean'?p.countIn:valid(p.countBeats)||bars!==null;return {countIn:on,countBeats:beats,countOnResume:p.countOnResume===true,countEachLoop:p.countEachLoop===true};}catch{return {...defaultPractice};}}
/** Clicks to play before starting (0: no count-in). */
export function countClicks(p:PracticeSettings){return p.countIn?p.countBeats:0;}
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
