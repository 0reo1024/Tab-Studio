const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {SessionStore}=require('./session-store.cjs');
const {formats,exportPath,validateExportBytes,writeExport}=require('./export-files.cjs');
protocol.registerSchemesAsPrivileged([{ scheme:'tabstudio', privileges:{standard:true,secure:true,supportFetchAPI:true} }]);
let window;
let savedProjectPath=null;
const documentPaths=new Set();
let pendingOpen=null,openCounter=0,allowClose=false,windowSizeTimer;
if(process.env.TAB_STUDIO_TEST_DATA)app.setPath('userData',process.env.TAB_STUDIO_TEST_DATA);
const session=new SessionStore(path.join(app.getPath('userData'),'workspace-session.json'));
app.setAppUserModelId('jp.tabstudio.desktop');
function makeWindow() {
  // macOS keeps the process alive after its final window is closed.
  allowClose=false;
  const previous=session.state.windowState,area=screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ width:Math.max(Math.min(1024,area.width),Math.min(previous?.width??1440,area.width)), height:Math.max(Math.min(680,area.height),Math.min(previous?.height??950,area.height)), minWidth: Math.min(1024,area.width), minHeight: Math.min(680,area.height), show:process.env.TAB_STUDIO_TEST!=='1',
    title: 'Tab Studio', backgroundColor: '#111820',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling:false } });
  if(previous?.maximized)window.maximize();
  for(const event of ['resize','maximize','unmaximize'])window.on(event,()=>{clearTimeout(windowSizeTimer);windowSizeTimer=setTimeout(()=>{void rememberWindowSize().catch(()=>{});},250);});
  window.on('close',e=>{if(allowClose)return;e.preventDefault();window.webContents.send('close-request');});
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (e, url) => { if (url !== window.webContents.getURL()) e.preventDefault(); });
  // Use the app menu so Windows menu animation never delays opening.
  Menu.setApplicationMenu(null);
  if (process.env.TAB_STUDIO_DEV_URL) window.loadURL(process.env.TAB_STUDIO_DEV_URL);
  else window.loadURL('tabstudio://app/index.html');
}
async function rememberWindowSize(){
  if(!window||window.isDestroyed()||window.isMinimized()||window.isFullScreen())return;
  const {width,height}=window.getNormalBounds();
  await session.rememberWindow({width,height,maximized:window.isMaximized()});
}
async function prepareOpen(file){
  if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('ファイルの場所が不正です。');
  if ((await fs.stat(file)).size > 40 * 1024 * 1024) throw new Error('40MBを超えるファイルは初期版では読み込めません。');
  const bytes=await fs.readFile(file),token=String(++openCounter);pendingOpen={token,file};
  return { name: path.basename(file), path:file, openToken:token, bytes: [...bytes] };
}
ipcMain.handle('recent-files',()=>session.recent());
ipcMain.handle('last-score',async()=>session.state.lastFile?prepareOpen(session.state.lastFile):null);
ipcMain.handle('open-recent',async(_event,file)=>{if(!session.state.recentFiles.includes(file))throw new Error('履歴にないファイルです。');return prepareOpen(file);});
ipcMain.handle('open-file-path',async(_event,file)=>prepareOpen(file));
ipcMain.handle('open-score', async () => {
  const result = await dialog.showOpenDialog(window, { title: '譜面を開く', properties: ['openFile'],
    filters: [{ name: 'TAB / Guitar Pro', extensions: ['tg','gp3','gp4','gp5','gpx','gp','tabstudio'] }, { name: 'すべてのファイル', extensions: ['*'] }] });
  if (result.canceled) return null;
  return prepareOpen(result.filePaths[0]);
});
ipcMain.handle('save-score', async (_event, args) => {
  if (!args || !(args.bytes instanceof Uint8Array) || args.bytes.length > 40 * 1024 * 1024 || args.bytes[0]!==80 || args.bytes[1]!==75) throw new Error('保存データが不正です。');
  const name = String(args.name || 'Untitled').replace(/[\\/:*?"<>|]/g, '_').slice(0,120);
  let file=Object.hasOwn(args,'path')?(typeof args.path==='string'&&documentPaths.has(args.path)&&path.extname(args.path).toLowerCase()==='.tg'?args.path:null):savedProjectPath;
  if(!file||args.saveAs){const result=await dialog.showSaveDialog(window,{title:'TG譜面を保存',defaultPath:file||name+'.tg',filters:[{name:'TuxGuitar',extensions:['tg']}]});if(result.canceled||!result.filePath)return false;file=result.filePath;if(path.extname(file).toLowerCase()!=='.tg')file=path.join(path.dirname(file),path.basename(file,path.extname(file))+'.tg');}
  const temp=file+'.writing';await fs.writeFile(temp,args.bytes);await fs.rename(temp,file);savedProjectPath=file;documentPaths.add(file);
  await session.remember(file);
  return {name:path.basename(file),path:file};
});
let exporting=false;
ipcMain.handle('export-score',async(_event,args)=>{
  if(exporting)throw new Error('書き出しが完了するまでお待ちください。');
  const spec=formats[args?.format];if(!spec)throw new Error('未対応の出力形式です。');
  if(args.format==='pdf'){
    if(typeof args.scoreJson!=='string'||args.scoreJson.length>80*1024*1024||!Array.isArray(args.tracks)||args.tracks.length>128)throw new Error('PDF用の譜面が不正です。');
  }else validateExportBytes(args.bytes,args.format);
  exporting=true;let preview;
  try{
    const name=String(args.name||'Untitled').replace(/[\\/:*?"<>|]/g,'_').slice(0,120);
    const result=await dialog.showSaveDialog(window,{title:spec.label+'を書き出し',defaultPath:name+'.'+args.format,filters:[{name:spec.label,extensions:[args.format]}]});
    if(result.canceled||!result.filePath)return false;
    const file=exportPath(result.filePath,args.format);
    if(args.format!=='pdf'){await writeExport(file,args.bytes,args.format);return {name:path.basename(file),path:file};}
    const pdf={start:1,end:undefined,scale:0.9,landscape:false,separateTracks:false,...args.pdf};
    if(!Number.isFinite(pdf.scale)||pdf.scale<0.6||pdf.scale>1.4||!Number.isInteger(pdf.start)||pdf.start<1||(pdf.end!==undefined&&(!Number.isInteger(pdf.end)||pdf.end<pdf.start)))throw new Error('PDF設定が不正です。');
    const tracks=[...new Set(args.tracks)];if(!tracks.length||tracks.some(i=>!Number.isInteger(i)||i<0))throw new Error('表示するトラックを選択してください。');
    const groups=pdf.separateTracks?tracks.map(i=>[i]):[tracks];
    const outputs=groups.map(group=>pdf.separateTracks?path.join(path.dirname(file),path.basename(file,'.pdf')+' - '+String(group[0]+1).padStart(2,'0')+' '+String(args.trackNames?.[group[0]]||'Track').replace(/[\\/:*?"<>|]/g,'_').slice(0,80)+'.pdf'):file);
    if(pdf.separateTracks){const existing=[];for(const output of outputs)try{await fs.access(output);existing.push(path.basename(output));}catch{}if(existing.length){const choice=await dialog.showMessageBox(window,{type:'question',message:'同名のPDFを上書きしますか？',detail:existing.join('\n'),buttons:['キャンセル','上書き'],defaultId:0,cancelId:0});if(choice.response!==1)return false;}}
    const generated=[];
    for(const group of groups){
      preview=new BrowserWindow({show:false,width:pdf.landscape?1140:820,height:pdf.landscape?820:1120,backgroundColor:'#ffffff',parent:window,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
      preview.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      const url=process.env.TAB_STUDIO_DEV_URL?new URL('print.html',process.env.TAB_STUDIO_DEV_URL).href:'tabstudio://app/print.html';
      await preview.loadURL(url);
      await preview.webContents.executeJavaScript(`window.renderPrintScore(${JSON.stringify({scoreJson:args.scoreJson,tracks:group,pdf})})`);
      generated.push(await preview.webContents.printToPDF({printBackground:true,pageSize:pdf.layout?.paper||'A4',landscape:!!pdf.landscape,preferCSSPageSize:true,displayHeaderFooter:pdf.layout?.pageNumbers!==false,headerTemplate:'<span></span>',footerTemplate:'<div style="font-size:9px;width:100%;text-align:center;color:#555"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',margins:{top:(pdf.layout?.margin||12)/25.4,bottom:(pdf.layout?.margin||12)/25.4,left:(pdf.layout?.margin||12)/25.4,right:(pdf.layout?.margin||12)/25.4}}));
      preview.destroy();preview=null;
    }
    for(let i=0;i<outputs.length;i++)await writeExport(outputs[i],generated[i],'pdf');
    return {name:pdf.separateTracks?`${outputs.length}個のPDF`:path.basename(file),path:outputs[0]};
  }finally{if(preview&&!preview.isDestroyed())preview.destroy();exporting=false;}
});
ipcMain.handle('accept-open',async(_event,token)=>{if(pendingOpen?.token!==token)return;const file=pendingOpen.file;documentPaths.add(file);savedProjectPath=path.extname(file).toLowerCase()==='.tg'?file:null;pendingOpen=null;await session.remember(file);});
ipcMain.handle('activate-document',async(_event,file)=>{if(file){if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('ファイルの場所が不正です。');if(!documentPaths.has(file)){if(!(await fs.stat(file)).isFile())throw new Error('譜面ファイルがありません。');documentPaths.add(file);}}savedProjectPath=file&&path.extname(file).toLowerCase()==='.tg'?file:null;if(file)await session.remember(file);else await session.clearLast();});
ipcMain.handle('reset-save-path',async()=>{savedProjectPath=null;pendingOpen=null;await session.clearLast();});
ipcMain.on('toggle-fullscreen',()=>{window.setFullScreen(!window.isFullScreen());});
ipcMain.on('finish-close',async()=>{clearTimeout(windowSizeTimer);try{await rememberWindowSize();await session.pending;}catch{}allowClose=true;window.close();});
ipcMain.on('menu-state',(_event,state)=>{const menu=Menu.getApplicationMenu();for(const id of ['tracks','noteEditor','transport','follow','click']){const item=menu?.getMenuItemById(id);if(item&&typeof state?.[id]==='boolean')item.checked=state[id];}});
app.whenReady().then(async() => {
  await session.initialize();
  protocol.handle('tabstudio', request => {
    const url = new URL(request.url), root = path.resolve(__dirname, '../dist');
    if(url.hostname !== 'app') return new Response('Not found', {status:404});
    const localPath = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if(localPath !== root && !localPath.startsWith(root + path.sep)) return new Response('Forbidden', {status:403});
    return net.fetch(pathToFileURL(localPath).toString());
  });
  makeWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) makeWindow(); });
