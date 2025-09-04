// package.js
// Use: node package.js
// This script runs electron-packager excluding "India Tiles", then (if needed) copies
// the local India Tiles folder into the packaged app resources/app/India Tiles only
// if it does not already exist there (so subsequent packaging runs skip the big copy).

const packager = require('electron-packager');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

const APP_NAME = 'CollaborativeMap';
const OUT_DIR = path.join(__dirname, 'release-builds');
const SRC_DIR = __dirname; // project root
const LOCAL_TILES_DIR = process.env.TILES_SOURCE_DIR ? path.resolve(process.env.TILES_SOURCE_DIR) : path.join(__dirname, 'India Tiles');
// Note: you can set environment variable TILES_SOURCE_DIR to point to an external tiles folder.

const PLATFORM = 'win32';
const ARCH = 'x64';

function log(...args) { console.log('[packager]', ...args); }

async function copyDirRecursive(src, dest) {
  // copy directory recursively (preserve structure). Avoid overwriting existing files for speed.
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      // if dest exists, skip (prevents overwriting)
      if (fsSync.existsSync(destPath)) continue;
      await fs.copyFile(srcPath, destPath);
    }
  }
}

(async () => {
  try {
    log('Starting packaging (India Tiles will be ignored during pack) ...');

    // Packager options: ignore India Tiles to speed up packaging.
    const opts = {
      dir: SRC_DIR,
      out: OUT_DIR,
      overwrite: true,
      platform: PLATFORM,
      arch: ARCH,
      name: APP_NAME,
      asar: false,           // easier to copy files into resources/app
      prune: true,           // remove devDependencies from packaged app
      // ignore Indian Tiles folder (match common variants). Use regex to be safe.
      ignore: [
        /India Tiles($|\/|\\)/i,
        /.*India Tiles.*/i
      ],
      // you can pass other options as needed (icon, etc.)
    };

    const appPaths = await packager(opts);
    log('Packaging complete. Packaged paths:', appPaths);

    if (!fsSync.existsSync(LOCAL_TILES_DIR)) {
      log('Local India Tiles source not found at:', LOCAL_TILES_DIR);
      log('Skipping post-package tile copy. If you want to include tiles, set TILES_SOURCE_DIR env var or ensure India Tiles exists in project root.');
      return;
    }

    // For each packaged app (usually one), copy tiles if they are not already present
    for (const appPath of appPaths) {
      // Typical Windows packaged app structure:
      // <out>/CollaborativeMap-win32-x64/CollaborativeMap.exe
      // resources/app/  <-- application files live here when asar=false
      const resourcesApp = path.join(appPath, 'resources', 'app');
      const destTilesPath = path.join(resourcesApp, 'India Tiles');

      // If destination already exists, skip copying to save time
      if (fsSync.existsSync(destTilesPath)) {
        log('Destination already has India Tiles at:', destTilesPath, '-- skipping copy.');
        continue;
      }

      log('Copying India Tiles from', LOCAL_TILES_DIR, 'to', destTilesPath, ' (this may take time once)...');
      await copyDirRecursive(LOCAL_TILES_DIR, destTilesPath);
      log('Copy finished for', destTilesPath);
    }

    log('Done. Packaged builds are in', OUT_DIR);
  } catch (err) {
    console.error('Packaging failed:', err && (err.stack || err.message || err));
    process.exit(1);
  }
})();
