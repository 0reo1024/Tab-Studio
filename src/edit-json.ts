/** Relationships are reconstructed from musical flags by alphaTab.finish().
 * Keeping the serialized reference IDs after a clone, cut or delete leaves
 * dangling links, even when the surviving note IDs have not changed. */
export function cleanEditJson(value:any,resetIds=false):void{
  if(!value||typeof value!=='object')return;
  if(value instanceof Map){
    const tracks=value.get('tracks');if(Array.isArray(tracks))for(const track of tracks)for(const staff of track.get('staves')??[]){const bars=staff.get('bars')??[],count=Math.max(1,...bars.map((b:any)=>b.get('voices')?.length??1));for(const bar of bars){const voices=bar.get('voices')??[];bar.set('voices',voices);while(voices.length<count)voices.push(new Map([['beats',[new Map<string,any>([['duration',1],['notes',[]],['isempty',false]])]]]));}}
    for(const [key,item]of value){if(typeof key==='string'&&(key.endsWith('noteid')||resetIds&&['id','start','displaystart','playbackstart','displayduration','playbackduration'].includes(key)))value.delete(key);else cleanEditJson(item,resetIds);}return;
  }
  if(Array.isArray(value.tracks))for(const track of value.tracks)for(const staff of track.staves??[]){const count=Math.max(1,...(staff.bars??[]).map((b:any)=>b.voices?.length??1));for(const bar of staff.bars??[]){bar.voices??=[];while(bar.voices.length<count)bar.voices.push({beats:[{duration:1,notes:[],isempty:false}]});}}
  for(const key of Object.keys(value)){
    if(key.endsWith('noteid')||resetIds&&['id','start','displaystart','playbackstart','displayduration','playbackduration'].includes(key))delete value[key];
    else cleanEditJson(value[key],resetIds);
  }
}
