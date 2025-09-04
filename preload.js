
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startHost: () => ipcRenderer.invoke('start-host'),
  discoverHosts: () => ipcRenderer.invoke('discover-hosts'),

  // Tile cache/local checks & save
  checkLocalTile: (z, x, y, ext) => ipcRenderer.invoke('check-local-tile', { z, x, y, ext }),
  checkCacheTile: (z, x, y, ext) => ipcRenderer.invoke('check-cache-tile', { z, x, y, ext }),
  saveCacheTile: (z, x, y, ext, base64) => ipcRenderer.invoke('save-cache-tile', { z, x, y, ext, base64 }),
  getCacheRootUrl: () => ipcRenderer.invoke('get-cache-root-url')
});
