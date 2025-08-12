// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const child_process = require('child_process');
const dgram = require('dgram');

let serverProcess = null;

ipcMain.handle('start-host', () => {
  if (serverProcess) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, 'server.js');
    serverProcess = child_process.spawn('node', [serverPath], { cwd: __dirname, stdio: ['ignore','pipe','pipe'] });

    serverProcess.stdout.on('data', data => {
      const msg = data.toString();
      console.log(`Server: ${msg}`);
      if (msg.includes('Server running at')) resolve();
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
      sock.setBroadcast(true);
      setTimeout(() => {
        const arr = Array.from(found);
        try { sock.close(); } catch(e){}
        resolve(arr);
      }, 1400);
    });
  });
});

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
