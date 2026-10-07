const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  openScore: () => ipcRenderer.invoke('open-score'),
  saveScore: (args) => ipcRenderer.invoke('save-score', args),
  exportScore: (args) => ipcRenderer.invoke('export-score', args),
  acceptOpen: (token) => ipcRenderer.invoke('accept-open',token),
  recentFiles:()=>ipcRenderer.invoke('recent-files'),
  lastScore:()=>ipcRenderer.invoke('last-score'),
  openRecent:(file)=>ipcRenderer.invoke('open-recent',file),
  openFilePath:(file)=>ipcRenderer.invoke('open-file-path',file),
  pathForFile:(file)=>webUtils.getPathForFile(file),
  onCloseRequest: (handler) => ipcRenderer.on('close-request',()=>handler()),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  finishClose: () => ipcRenderer.send('finish-close'),
  activateDocument:(path)=>ipcRenderer.invoke('activate-document',path),
  resetSavePath: () => ipcRenderer.invoke('reset-save-path'),
  setMenuState: (state) => ipcRenderer.send('menu-state',state),
  onCommand: (handler) => ipcRenderer.on('menu-command',(_event,command)=>{if(typeof command==='string')handler(command);})
});
