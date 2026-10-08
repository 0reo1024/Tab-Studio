const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('nativeFx',{
 namModel:id=>ipcRenderer.invoke('nam-model',id),
 sfzLibrary:()=>ipcRenderer.invoke('sfz-library'),
 sfzFile:()=>ipcRenderer.invoke('sfz-file'),sfzLoad:(path,lanes,pitches)=>ipcRenderer.invoke('sfz-load',path,lanes,pitches),sfzPrepare:(id,lanes,pitches)=>ipcRenderer.invoke('sfz-prepare',id,lanes,pitches),sfzRender:(id,frames,rate,events)=>ipcRenderer.invoke('sfz-render',id,frames,rate,events),sfzReset:id=>ipcRenderer.invoke('sfz-reset',id),
 scan:()=>ipcRenderer.invoke('fx-scan'),folder:()=>ipcRenderer.invoke('fx-folder'),load:(path,state)=>ipcRenderer.invoke('fx-load',path,state),process:(id,pcm,rate)=>ipcRenderer.invoke('fx-process',id,pcm,rate),editor:id=>ipcRenderer.invoke('fx-editor',id),state:id=>ipcRenderer.invoke('fx-state',id),close:id=>ipcRenderer.invoke('fx-close',id)
});
contextBridge.exposeInMainWorld('desktop', {
  openScore: () => ipcRenderer.invoke('open-score'),
  saveScore: (args) => ipcRenderer.invoke('save-score', args),
  exportScore: (args) => ipcRenderer.invoke('export-score', args),
  acceptOpen: (token) => ipcRenderer.invoke('accept-open',token),
  recentFiles:()=>ipcRenderer.invoke('recent-files'),
  lastScore:()=>ipcRenderer.invoke('last-score'),
  workspaceSession:()=>ipcRenderer.invoke('workspace-session'),
  rememberWorkspace:value=>ipcRenderer.invoke('remember-workspace',value),
  readWorkspaceFile:file=>ipcRenderer.invoke('read-workspace-file',file),
  openRecent:(file)=>ipcRenderer.invoke('open-recent',file),
  openFilePath:(file)=>ipcRenderer.invoke('open-file-path',file),
  pathForFile:(file)=>webUtils.getPathForFile(file),
  onCloseRequest: (handler) => ipcRenderer.on('close-request',()=>handler()),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  finishClose: () => ipcRenderer.send('finish-close'),
  activateDocument:(path)=>ipcRenderer.invoke('activate-document',path),
  resetSavePath: () => ipcRenderer.invoke('reset-save-path'),
  setMenuState: (state) => ipcRenderer.send('menu-state',state),
  writeRecovery:(json)=>ipcRenderer.invoke('recovery-write',json),
  readRecovery:()=>ipcRenderer.invoke('recovery-read'),
  clearRecovery:()=>ipcRenderer.invoke('recovery-clear'),
  onCommand: (handler) => ipcRenderer.on('menu-command',(_event,command)=>{if(typeof command==='string')handler(command);})
});
