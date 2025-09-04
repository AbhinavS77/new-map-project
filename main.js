// // main.js
// const { app, BrowserWindow, ipcMain } = require('electron');
// const path = require('path');
// const child_process = require('child_process');
// const dgram = require('dgram');

// let serverProcess = null;

// ipcMain.handle('start-host', () => {
//   if (serverProcess) return Promise.resolve();
//   return new Promise((resolve, reject) => {
//     const serverPath = path.join(__dirname, 'server.js');
//     serverProcess = child_process.spawn('node', [serverPath], { cwd: __dirname, stdio: ['ignore','pipe','pipe'] });

//     serverProcess.stdout.on('data', data => {
//       const msg = data.toString();
//       console.log(`Server: ${msg}`);
//       if (msg.includes('Server running at')) resolve();
//     });

//     serverProcess.stderr.on('data', data => {
//       console.error(`Server Error: ${data.toString()}`);
//     });

//     serverProcess.on('exit', () => {
//       serverProcess = null;
//     });
//   });
// });

// // discovery: listen for UDP broadcasts for a short window and return list
// ipcMain.handle('discover-hosts', () => {
//   return new Promise((resolve) => {
//     const DISCOVERY_PORT = 41234;
//     const found = new Set();
//     const sock = dgram.createSocket('udp4');

//     sock.on('message', (msg, rinfo) => {
//       try {
//         const payload = JSON.parse(msg.toString());
//         if (payload && payload.port === 3000) found.add(rinfo.address);
//       } catch (e) {}
//     });

//     sock.on('error', (err) => {
//       console.error('Discovery socket error:', err);
//       try { sock.close(); } catch(e){}
//       resolve([]);
//     });

//     sock.bind(DISCOVERY_PORT, () => {
//       sock.setBroadcast(true);
//       setTimeout(() => {
//         const arr = Array.from(found);
//         try { sock.close(); } catch(e){}
//         resolve(arr);
//       }, 1400);
//     });
//   });
// });

// function createWindow() {
//   const win = new BrowserWindow({
//     width: 1280, height: 800,
//     webPreferences: {
//       contextIsolation: true,
//       preload: path.join(__dirname, 'preload.js')
//     },
//     icon: path.join(__dirname, 'icon.png')
//   });
//   win.setMenu(null);
//   win.loadFile('index.html');
// }

// app.whenReady().then(createWindow);

// app.on('window-all-closed', () => {
//   if (serverProcess) serverProcess.kill();
//   if (process.platform !== 'darwin') app.quit();
// });

// main.js (updated: add tile cache IPC handlers + existing startHost/discovery)
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const child_process = require('child_process');
const dgram = require('dgram');
const fs = require('fs').promises;
const fsSync = require('fs');
const { pathToFileURL } = require('url');

let serverProcess = null;

ipcMain.handle('start-host', () => {
  if (serverProcess) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, 'server.js');
    serverProcess = child_process.spawn('node', [serverPath], { cwd: __dirname, stdio: ['ignore','pipe','pipe'] });

    serverProcess.stdout.on('data', data => {
      const msg = data.toString();
      console.log(`Server: ${msg}`);
      if (msg.includes('Server running at') || msg.includes('Server running at http')) resolve();
    });

    serverProcess.stderr.on('data', data => {
      console.error(`Server Error: ${data.toString()}`);
    });

    serverProcess.on('exit', () => {
      serverProcess = null;
    });
  });
});

// discovery: listen for UDP broadcasts for a short window and return list
ipcMain.handle('discover-hosts', () => {
  return new Promise((resolve) => {
    const DISCOVERY_PORT = 41234;
    const found = new Set();
    const sock = dgram.createSocket('udp4');

    sock.on('message', (msg, rinfo) => {
      try {
        const payload = JSON.parse(msg.toString());
        if (payload && payload.port === 3000) found.add(rinfo.address);
      } catch (e) {}
    });

    sock.on('error', (err) => {
      console.error('Discovery socket error:', err);
      try { sock.close(); } catch(e){}
      resolve([]);
    });

    sock.bind(DISCOVERY_PORT, () => {
      try { sock.setBroadcast(true); } catch(e){}
      setTimeout(() => {
        const arr = Array.from(found);
        try { sock.close(); } catch(e){}
        resolve(arr);
      }, 1400);
    });
  });
});


// ---------------------- Tile cache IPC handlers ----------------------
// Cache root inside Electron userData to keep it distinct from app bundle.
function getCacheRoot() {
  return path.join(app.getPath('userData'), 'tile-cache');
}

// Ensure directory exists (sync helper)
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (e) { /* ignore */ }
}

// check local tile in packaged app's "India Tiles" folder (developer-provided)
ipcMain.handle('check-local-tile', async (evt, { z, x, y, ext }) => {
  try {
    const candidate = path.join(__dirname, 'India Tiles', String(z), String(x), `${String(y)}.${ext}`);
    if (fsSync.existsSync(candidate)) {
      return { exists: true, path: pathToFileURL(candidate).href };
    }
    return { exists: false };
  } catch (err) {
    console.error('check-local-tile error', err && err.message);
    return { exists: false };
  }
});

// check cache tile (under userData/tile-cache/{z}/{x}/{y}.{ext})
ipcMain.handle('check-cache-tile', async (evt, { z, x, y, ext }) => {
  try {
    const cachePath = path.join(getCacheRoot(), String(z), String(x));
    const filePath = path.join(cachePath, `${String(y)}.${ext}`);
    if (fsSync.existsSync(filePath)) {
      return { exists: true, path: pathToFileURL(filePath).href };
    }
    return { exists: false };
  } catch (err) {
    console.error('check-cache-tile error', err && err.message);
    return { exists: false };
  }
});

// save cache tile: receives base64 string
ipcMain.handle('save-cache-tile', async (evt, { z, x, y, ext, base64 }) => {
  try {
    const cachePath = path.join(getCacheRoot(), String(z), String(x));
    await ensureDir(cachePath);
    const filePath = path.join(cachePath, `${String(y)}.${ext}`);
    const buffer = Buffer.from(base64, 'base64');
    await fs.writeFile(filePath, buffer);
    return { ok: true, path: pathToFileURL(filePath).href };
  } catch (err) {
    console.error('save-cache-tile error', err && err.message);
    return { ok: false, error: err && err.message };
  }
});

// expose path to cache root (file://) if needed by renderer
ipcMain.handle('get-cache-root-url', async () => {
  try {
    const root = getCacheRoot();
    await ensureDir(root);
    return pathToFileURL(root).href;
  } catch (err) {
    console.error('get-cache-root-url error', err && err.message);
    return null;
  }
});

// --------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.png')
  });
  win.setMenu(null);
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});
