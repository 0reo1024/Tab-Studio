import * as at from '@coderline/alphatab';
import {deserialize} from './score';
import {readableLayout} from './score-layout';
import {pdfOptions,type PdfOptions} from './pdf-options';
import {applyLayout,defaultLayout} from './layout-settings';
import './print.css';

type PrintRequest={scoreJson:string;tracks:number[];pdf?:PdfOptions};
declare global{interface Window{renderPrintScore:(request:PrintRequest)=>Promise<void>}}
window.renderPrintScore=async request=>{
  const score=deserialize(request.scoreJson);
  score.stylesheet.firstSystemTrackNameOrientation=at.model.TrackNameOrientation.Horizontal;
  score.stylesheet.otherSystemsTrackNameOrientation=at.model.TrackNameOrientation.Horizontal;
  for(const track of score.tracks){if(track.name.length>30)track.name=track.name.slice(0,29)+'…';if(track.shortName.length>30)track.shortName=track.shortName.slice(0,29)+'…';}
  const options=pdfOptions(request.pdf,score.masterBars.length);
  const layout={...defaultLayout,...options.layout,scale:options.scale,landscape:options.landscape};
  const dimensions=layout.paper==='A3'?[297,420]:layout.paper==='Letter'?[215.9,279.4]:[210,297];
  const width=dimensions[layout.landscape?1:0]-layout.margin*2,height=dimensions[layout.landscape?0:1]-layout.margin*2;
  document.getElementById('print-score')!.style.width=width+'mm';
  const pageStyle=document.createElement('style');pageStyle.textContent=`@page{size:${layout.paper} ${layout.landscape?'landscape':'portrait'};margin:${layout.margin}mm}`;document.head.append(pageStyle);
  const tracks=[...new Set(request.tracks)].filter(i=>Number.isInteger(i)&&i>=0&&i<score.tracks.length);
  if(!tracks.length)throw new Error('PDFに出力するトラックがありません。');
  document.title=score.title||'Untitled';
  const api=new at.AlphaTabApi(document.getElementById('print-score')!,{
    core:{engine:'svg',fontDirectory:new URL('./alphatab/font/',document.baseURI).href,useWorkers:false,enableLazyLoading:false},
    display:{...readableLayout,scale:options.scale,startBar:options.start,barCount:options.end-options.start+1,padding:[12,0,12,0],layoutMode:at.LayoutMode.Page},
    player:{playerMode:at.PlayerMode.Disabled,enableCursor:false,enableUserInteraction:false,enableElementHighlighting:false}
  });
  applyLayout(api,score,layout,true);api.updateSettings();
  const partials:{y:number;first:number}[]=[];
  api.renderer.partialRenderFinished.on(e=>{if(e.firstMasterBarIndex>=0)partials.push({y:e.y,first:e.firstMasterBarIndex});});
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('PDF用の譜面の準備が時間内に完了しませんでした。')),60000);
    api.error.on(error=>{clearTimeout(timer);reject(error);});
    api.postRenderFinished.on(()=>{clearTimeout(timer);resolve();});
    api.renderScore(score,tracks);
  });
  await document.fonts.ready;
  // A system taller than a printable page is scaled as one unit, never sliced.
  const maxHeight=(height-19)*96/25.4;
  for(const chunk of document.querySelectorAll<HTMLElement>('.at-surface > div')){
    const svg=chunk.querySelector('svg');if(!svg)continue;
    const top=parseFloat(chunk.style.top),partial=partials.find(p=>Math.abs(p.y-top)<2);
    if(partial&&layout.pageBreaks.includes(partial.first)&&partial.first>options.start-1)chunk.style.breakBefore='page';
    const height=parseFloat(svg.getAttribute('height')||''),width=parseFloat(svg.getAttribute('width')||'');
    if(height>maxHeight&&width>0){if(!svg.hasAttribute('viewBox'))svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('height',String(maxHeight));svg.setAttribute('width',String(width*maxHeight/height));}
  }
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
};
