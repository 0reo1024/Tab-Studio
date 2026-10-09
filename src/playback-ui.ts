import type * as at from '@coderline/alphatab';
export const CURSOR_WIDTH=20;
/** One stable vertical span per system, regardless of which track supplies a beat. */
export function playbackFrameArea(b:at.rendering.BeatBounds){
  const system=b.barBounds.masterBarBounds.staffSystemBounds;
  if(!system)return b.barBounds.masterBarBounds.lineAlignedBounds;
  const staves=new Map<string,at.rendering.BarBounds>();
  for(const master of system.bars)for(const bar of master.bars){
    const model=bar.bar??bar.beats[0]?.beat.voice.bar;if(!model)continue;
    // Standard notation precedes TAB: the final bounds for a staff are its TAB.
    staves.set(`${model.staff.track.index}:${model.staff.index}`,bar);
  }
  const areas=[...staves.values()].map(bar=>bar.visualBounds);
  if(!areas.length)return b.barBounds.masterBarBounds.lineAlignedBounds;
  const y=Math.min(...areas.map(r=>r.y));
  return {y,h:Math.max(...areas.map(r=>r.y+r.h))-y};
}
/** Beat cursor geometry in score coordinates, including an in-flight transition. */
export type CursorPosition={x:number;toX:number;y:number;h:number;start:number;duration:number};
/** alphaTab computes duration from the audio clock, tempo, tuplets and speed. */
export function installPlaybackFrame(api:at.AlphaTabApi,onCursor:(position:CursorPosition|undefined)=>void=()=>{}){
  let last:{x:number;y:number;h:number}|undefined;
  const area=playbackFrameArea;
  function place(c:at.platform.IContainer,r:{y:number;h:number},x:number){
    // alphaTab's scalable container divides bounds by 100. Position its DOM
    // element directly to keep a full-size frame and a constant 2px outline.
    const element=(c as unknown as {element?:HTMLElement}).element;
    c.stopAnimation();
    if(element){
      element.style.width=`${CURSOR_WIDTH}px`;element.style.height=`${r.h+24}px`;
      element.style.transform=`translate(${x-CURSOR_WIDTH/2}px, ${r.y-12}px)`;
    }else c.setBounds(x-CURSOR_WIDTH/2,r.y-12,CURSOR_WIDTH,r.h+24);
  }
  api.customCursorHandler={
    onAttach(){last=undefined;onCursor(undefined);},onDetach(){last=undefined;onCursor(undefined);},placeBarCursor(c,b){const r=b.barBounds.masterBarBounds.lineAlignedBounds;c.setBounds(r.x,r.y,r.w,r.h);},
    placeBeatCursor(c,b,x){const r=area(b);place(c,r,x);last={x,y:r.y,h:r.h};onCursor({x,toX:x,y:r.y,h:r.h,start:performance.now(),duration:0});},
    transitionBeatCursor(c,b,x,next,duration){
      const r=area(b);
      // A row/repeat jump is instantaneous; never sweep across unrelated notation.
      if(!last||last.y!==r.y||last.h!==r.h){place(c,r,x);}
      const element=(c as unknown as {element?:HTMLElement}).element;
      if(element){
        // Commit placement before starting the next audio-timed movement.
        element.getBoundingClientRect();
        element.style.transition=`transform ${Math.max(0,duration)}ms linear`;
        element.style.transform=`translate(${next-CURSOR_WIDTH/2}px, ${r.y-12}px)`;
      }else c.transitionToX(Math.max(0,duration),next-CURSOR_WIDTH/2);
      onCursor({x:last&&last.y===r.y&&last.h===r.h?last.x:x,toX:next,y:r.y,h:r.h,start:performance.now(),duration:Math.max(0,duration)});
      last={x:next,y:r.y,h:r.h};
    }
  };
}
export function smoothStep(current:number,target:number,dt:number){return current+(target-current)*(1-Math.exp(-Math.min(dt,64)/150));}
export class ScoreFollower{
  private active=false;private manual=false;private frame=0;private last=0;private until=0;private target:{x:number;y:number}|undefined;
  private cursor:CursorPosition|undefined;private geometry:{top:number;left:number;width:number;height:number;scrollHeight:number;scrollWidth:number}|undefined;
  constructor(private scroll:HTMLElement,private sheet:HTMLElement,private enabled:()=>boolean){
    scroll.addEventListener('wheel',()=>this.suspend(),{passive:true});scroll.addEventListener('touchstart',()=>this.suspend(),{passive:true});
    scroll.addEventListener('pointerdown',e=>{if(e.target===scroll)this.suspend();});
    globalThis.addEventListener?.('resize',()=>{this.geometry=undefined;});
  }
  /** Fed by the cursor handler, so following never queries or measures the cursor element. */
  cursorMoved(position:CursorPosition|undefined){this.cursor=position;if(!position)this.geometry=undefined;}
  suspend(){this.until=performance.now()+3000;this.target=undefined;}
  setPlaying(value:boolean){this.geometry=undefined;this.active=value;this.manual=false;this.target=undefined;if(value)this.start();else{cancelAnimationFrame(this.frame);this.frame=0;}}
  focus(){this.geometry=undefined;this.until=0;this.manual=true;this.target=undefined;this.findTarget(true);this.start();}
  private start(){if(!this.frame){this.last=performance.now();this.frame=requestAnimationFrame(t=>this.step(t));}}
  /** The sheet offset and scroll extents are fixed during playback (editing and zoom are locked). */
  private measure(){
    if(!this.geometry){const s=this.sheet.getBoundingClientRect(),v=this.scroll.getBoundingClientRect();this.geometry={top:s.top-v.top+this.scroll.scrollTop,left:s.left-v.left+this.scroll.scrollLeft,width:v.width,height:v.height,scrollHeight:this.scroll.scrollHeight,scrollWidth:this.scroll.scrollWidth};}
    return this.geometry;
  }
  private cursorRect(){
    const c=this.cursor;
    if(!c){const cursor=this.sheet.querySelector('.at-cursor-beat') as HTMLElement|null;if(!cursor)return;const r=cursor.getBoundingClientRect(),v=this.scroll.getBoundingClientRect();return {top:r.top-v.top,bottom:r.bottom-v.top,left:r.left-v.left,right:r.right-v.left,height:r.height,width:v.width,viewHeight:v.height,scrollHeight:this.scroll.scrollHeight,scrollWidth:this.scroll.scrollWidth};}
    const g=this.measure(),progress=c.duration>0?Math.min(1,(performance.now()-c.start)/c.duration):1,x=c.x+(c.toX-c.x)*progress;
    const top=g.top+c.y-12-this.scroll.scrollTop,left=g.left+x-CURSOR_WIDTH/2-this.scroll.scrollLeft;
    return {top,bottom:top+c.h+24,left,right:left+CURSOR_WIDTH,height:c.h+24,width:g.width,viewHeight:g.height,scrollHeight:g.scrollHeight,scrollWidth:g.scrollWidth};
  }
  private findTarget(force=false){
    const r=this.cursorRect();if(!r?.height)return;const v={height:r.viewHeight,width:r.width,left:0,right:r.width};
    const top=r.top,bottom=r.bottom;
    const y=top<70||bottom>v.height*.78||force?Math.max(0,Math.min(r.scrollHeight-this.scroll.clientHeight,this.scroll.scrollTop+top-Math.max(70,(v.height-r.height)*.35))):this.target?.y??this.scroll.scrollTop;
    const x=r.left<v.left+30||r.right>v.right-40?Math.max(0,Math.min(r.scrollWidth-this.scroll.clientWidth,this.scroll.scrollLeft+r.left-v.left-v.width*.55)):this.target?.x??this.scroll.scrollLeft;
    this.target={x,y};
  }
  private step(time:number){
    this.frame=0;const dt=time-this.last;this.last=time;
    if((this.active&&this.enabled()||this.manual&&this.target||!this.active&&this.target)&&time>=this.until){this.findTarget();if(this.target){this.scroll.scrollTop=smoothStep(this.scroll.scrollTop,this.target.y,dt);this.scroll.scrollLeft=smoothStep(this.scroll.scrollLeft,this.target.x,dt);}}
    const pending=this.target&&(Math.abs(this.scroll.scrollTop-this.target.y)>1||Math.abs(this.scroll.scrollLeft-this.target.x)>1);
    if(this.manual&&!pending)this.manual=false;
    if(this.active||pending)this.frame=requestAnimationFrame(t=>this.step(t));else this.target=undefined;
  }
}
