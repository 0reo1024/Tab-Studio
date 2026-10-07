import type * as at from '@coderline/alphatab';
import {tabBounds} from './hit-test';
/** Immediate committed digits while the notation worker redraws in batches. */
export class FretFeedback{
 private edits=new Map<number,{note:at.model.Note;revision:number;label:HTMLSpanElement}>();
 constructor(private sheet:HTMLElement,private parent:HTMLElement,private lookup:()=>at.rendering.BoundsLookup|null){}
 show(note:at.model.Note,revision:number){let item=this.edits.get(note.id);if(!item){const label=document.createElement('span');label.className='fret-feedback';label.setAttribute('aria-hidden','true');this.parent.append(label);item={note,revision,label};this.edits.set(note.id,item);}item.revision=revision;item.label.textContent=String(note.fret);this.place(item);}
 private place(item:{note:at.model.Note;label:HTMLSpanElement}){const lookup=this.lookup(),bb=lookup&&tabBounds(lookup,item.note.beat);if(!bb)return;const staff=item.note.beat.voice.bar.staff,r=bb.barBounds.visualBounds;item.label.style.left=`${bb.onNotesX+this.sheet.offsetLeft}px`;item.label.style.top=`${r.y+(staff.tuning.length-item.note.string)*r.h/(staff.tuning.length-1)+this.sheet.offsetTop}px`;}
 drawn(revision:number){for(const [id,item]of this.edits){if(item.revision<=revision){item.label.remove();this.edits.delete(id);}else this.place(item);}}
 clear(){for(const item of this.edits.values())item.label.remove();this.edits.clear();}
}
