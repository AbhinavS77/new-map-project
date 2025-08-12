// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startHost: () => ipcRenderer.invoke('start-host'),
  discoverHosts: () => ipcRenderer.invoke('discover-hosts')
});
