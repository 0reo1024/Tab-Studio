import type {Score} from './score';
export type SectionEntry={start:number;end:number;text:string;marker:string};
export function sections(score:Score):SectionEntry[]{const rows:SectionEntry[]=[];for(const bar of score.masterBars)if(bar.section)rows.push({start:bar.index,end:score.masterBars.length-1,text:bar.section.text||bar.section.marker||'名称なし',marker:bar.section.marker});if(!rows.length||rows[0].start>0)rows.unshift({start:0,end:score.masterBars.length-1,text:'冒頭',marker:''});for(let i=0;i<rows.length-1;i++)rows[i].end=rows[i+1].start-1;return rows;}
