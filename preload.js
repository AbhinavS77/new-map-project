const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startHost: () => ipcRenderer.invoke('start-host')
});
