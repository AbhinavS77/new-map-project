const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const child_process = require('child_process');
let serverProcess = null;

ipcMain.handle('start-host', () => {
  if (serverProcess) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, 'server.js');
    serverProcess = child_process.spawn('node', [serverPath], { cwd: __dirname });

    serverProcess.stdout.on('data', data => {
      const msg = data.toString();
      console.log(`Server: ${msg}`);
      if (msg.includes('Server running at')) {
        resolve();
      }
    });

    serverProcess.stderr.on('data', data => {
      console.error(`Server Error: ${data.toString()}`);
    });

    serverProcess.on('exit', () => {
      serverProcess = null;
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