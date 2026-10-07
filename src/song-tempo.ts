import * as at from '@coderline/alphatab';
import type {Score} from './score';
export function setSongTempo(score:Score,bpm:number){
 if(!Number.isFinite(bpm)||bpm<20||bpm>400)throw new Error('テンポは20〜400で入力してください。');
 const first=score.masterBars[0];if(!first)throw new Error('小節がありません。');
 const initial=first.tempoAutomations.filter(a=>a.ratioPosition===0);
 if(initial.length)for(const automation of initial)automation.value=bpm;
 else first.tempoAutomations.unshift(at.model.Automation.buildTempoAutomation(false,0,bpm,2));
}
