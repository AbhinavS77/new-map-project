// map.js (merged part1 + part2 + part3) - updated per user requests
// --- Shared ID state (user-visible group IDs) ---
let currentPinGroupId = "pin-101";   // all normal pins use this until regenerated
let currentRfGroupId  = "rf-201";    // all RF pins use this until regenerated
let currentRadarGroupId = "radar-301"; // radar parent group id starts at 301
const usedGroupIds = new Set([currentPinGroupId, currentRfGroupId, currentRadarGroupId]); // prevent duplicates
const groupCounters = { [currentPinGroupId]: 0, [currentRfGroupId]: 0, [currentRadarGroupId]: 0 };

// --- Group bookkeeping: pins grouped by groupId, and polylines per group ---
const groupPins = {};   // groupId -> array of internal pin ids (in insertion order)
const groupLines = {};  // groupId -> L.Polyline (dotted)

// ---------- geodesic helpers, icons, escape etc. ----------
function createSvgIconDataUrl(hexColor='#ff4d4f', size=[24,38]) {
  const w = size[0], h = size[1];
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 24 38" >
    <defs>
      <filter id="s" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.25"/>
      </filter>
    </defs>
    <g filter="url(#s)">
      <path d="M12 1C8.13 1 5 4.13 5 8c0 5.5 7 12.5 7 12.5S19 13.5 19 8c0-3.87-3.13-7-7-7z" fill="${hexColor}"/>
      <circle cx="12" cy="8" r="2.6" fill="#fff" />
    </g>
  </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}
function buildLabeledDivIcon(subId, pinColor, fontSize = 12) {
  const svgUrl = createSvgIconDataUrl(pinColor || '#ff4d4f', [30,45]);
  const labelHtml = subId ? escapeHtml(String(subId)) : '';
  const html = `
    <div style="position:relative; width:30px; height:60px; pointer-events:auto; display:inline-block;">
      <div style="position:absolute; left:50%; bottom:calc(100% + 4px); transform:translateX(-50%); font-weight:700; font-size:${fontSize}px; color:#000; white-space:nowrap; pointer-events:none;">
        ${labelHtml}
      </div>
      <img src="${svgUrl}" style="position:absolute; left:50%; bottom:0; transform:translateX(-50%); width:30px; height:45px; display:block;" />
    </div>`;
  return L.divIcon({ html, className: 'labeled-marker-icon', iconSize: [30, 60], iconAnchor: [15, 40], popupAnchor: [0, -40] });
}
function buildMarkerIcon(pinColor) {
  const ICON_SIZE = [30, 45];
  const svgUrl = createSvgIconDataUrl(pinColor);
  const anchorY = ICON_SIZE[1];
  return L.icon({
    iconUrl: svgUrl,
    iconSize: ICON_SIZE,
    iconAnchor: [Math.floor(ICON_SIZE[0] / 2), anchorY],
    popupAnchor: [0, -anchorY + 8]
  });
}
function buildShapeDivIcon(type, color) {
  const size = 22;
  let shapeSvg = '';
  const stroke = 'rgba(0,0,0,0.14)';
  const strokeWidth = 1.6;
  if (type === 'box') {
    shapeSvg = `<rect x="3" y="3" width="16" height="16" rx="2" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  } else if (type === 'circle') {
    shapeSvg = `<circle cx="11" cy="11" r="8" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  } else {
    shapeSvg = `<polygon points="11,3 19,19 3,19" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>${shapeSvg}</svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [size, size],
    iconAnchor: [Math.floor(size/2), Math.floor(size/2)]
  });
}
function destinationPoint(lat, lon, bearingDeg, distanceMeters) {
  const R = 6378137;
  const bearing = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const dDivR = distanceMeters / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dDivR) + Math.cos(lat1) * Math.sin(dDivR) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(dDivR) * Math.cos(lat1), Math.cos(dDivR) - Math.sin(lat1) * Math.sin(lat2));
  return [lat2 * 180 / Math.PI, lon2 * 180 / Math.PI];
}
function buildConePolygonPoints(centerLat, centerLon, radiusMeters, bearingDeg, spreadDeg, stepDeg=6) {
  const start = bearingDeg - spreadDeg/2;
  const end = bearingDeg + spreadDeg/2;
  const pts = [];
  for (let a = start; a <= end + 1e-6; a += stepDeg) {
    pts.push(destinationPoint(centerLat, centerLon, a, radiusMeters));
  }
  return [ [centerLat, centerLon], ...pts ];
}
function randomPastel() {
  const h = Math.floor(Math.random()*360);
  const s = 60 + Math.floor(Math.random()*20);
  const l = 70 + Math.floor(Math.random()*8);
  return `hsl(${h} ${s}% ${l}%)`;
}
function escapeHtml(s) { return (s+'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ---------- geodesic bearing helper (degrees from North clockwise) ----------
function bearingFromLatLon(lat1, lon1, lat2, lon2) {
  // returns degrees in [0,360)
  const toRad = Math.PI/180;
  const toDeg = 180/Math.PI;
  const φ1 = lat1 * toRad;
  const φ2 = lat2 * toRad;
  const Δλ = (lon2 - lon1) * toRad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  let θ = Math.atan2(y, x);
  let deg = (θ * toDeg + 360) % 360;
  return deg;
}
function formatBearing(b) {
  if (typeof b !== 'number' || !isFinite(b)) return '—';
  return (Math.round(b*10)/10).toFixed(1);
}
// ---------- END helpers ----------

// --- DOM refs & state ---
document.addEventListener('DOMContentLoaded', async () => {
  // UI refs
  const modal = document.getElementById('connection-modal');
  const hostBtn = document.getElementById('host-btn');
  const clientBtn = document.getElementById('client-btn');
  const ipInput = document.getElementById('ip-address-input');
  const clientNameInput = document.getElementById('client-name-input');
  const pinColorInput = document.getElementById('pin-color-input');
  const userDotColorInput = document.getElementById('user-dot-color-input');
  const serverBtn = document.getElementById('server-btn');
  const serverPanel = document.getElementById('server-panel');
  const userBtn = document.getElementById('user-toggle-btn');
  const pinBtn = document.getElementById('pin-toggle-btn');
  const clearBtn = document.getElementById('clear-btn');
  const container = document.getElementById('main-container');
  const statusBar = document.getElementById('status-popup');
  const sidebar = document.getElementById('pinned-locations');
  const floating = document.getElementById('floating-buttons');

  // new Radar button
  const radarBtn = document.getElementById('radar-toggle-btn');

  // Chat UI refs
  const chatBtn = document.getElementById('chat-btn');
  const chatModal = document.getElementById('chat-modal');
  const chatCloseBtn = document.getElementById('chat-close-btn');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send');

  // Chat-related helpers (dedupe, append fallback)
  const sentChatIds = new Set();
  const sentChatFallback = new Map();

  function sendChatFromInput() {
    if (!chatInput) return;
    const text = chatInput.value.trim();
    if (!text) return;
    const timestamp = Date.now();
    const localId = 'local_' + timestamp + '_' + Math.random().toString(36).slice(2,6);
    const msg = { text, ts: timestamp, id: localId };

    sentChatIds.add(localId);
    sentChatFallback.set(`${msg.text}|${msg.ts}`, localId);

    if (typeof socket !== 'undefined' && socket && socket.connected) {
      try { socket.emit('chatMessage', msg); } catch(e){ console.warn('chat emit failed', e); }
    }

    if (typeof appendChatMessage === 'function') {
      appendChatMessage(Object.assign({}, msg, { clientName: (clientNameInput && clientNameInput.value) || 'You', fromHost: !!isHost }));
    } else if (typeof appendChatMessageFallback === 'function') {
      appendChatMessageFallback(Object.assign({}, msg, { clientName: (clientNameInput && clientNameInput.value) || 'You', fromHost: !!isHost }));
    }

    chatInput.value = '';
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Chat UI wiring
  if (chatBtn) {
    chatBtn.addEventListener('click', () => {
      if (!chatModal) return;
      const wasOpen = chatModal.style.display === 'block';
      if (!wasOpen) {
        const clearRect = (clearBtn && typeof clearBtn.getBoundingClientRect === 'function')
          ? clearBtn.getBoundingClientRect()
          : null;

        chatModal.style.display = 'block';
        chatModal.style.position = 'fixed';
        chatModal.style.right = '18px';

        if (clearRect) {
          chatModal.style.top = (clearRect.bottom + 8) + 'px';
          chatModal.style.bottom = 'auto';
        } else {
          chatModal.style.bottom = '16px';
          chatModal.style.top = 'auto';
        }

        chatModal.style.width = '360px';
        chatModal.style.height = '420px';
        chatModal.style.minWidth = '300px';
        chatModal.style.minHeight = '260px';
        chatModal.style.zIndex = '99999';
        chatModal.style.borderRadius = '10px';
        chatModal.style.boxShadow = '0 12px 30px rgba(0,0,0,0.18)';
        chatModal.style.overflow = 'hidden';

        if (chatMessages) {
          chatMessages.style.overflowY = 'auto';
          chatMessages.style.height = 'calc(100% - 110px)';
          chatMessages.style.boxSizing = 'border-box';
          setTimeout(()=> { chatMessages.scrollTop = chatMessages.scrollHeight; }, 40);
        }
      } else {
        chatModal.style.display = 'none';
      }
      if (chatModal.style.display === 'block' && chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }
  if (chatCloseBtn) chatCloseBtn.addEventListener('click', ()=> { if (chatModal) chatModal.style.display='none'; });
  if (chatSendBtn) chatSendBtn.addEventListener('click', sendChatFromInput);
  if (chatInput) chatInput.addEventListener('keydown', (e) => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendChatFromInput(); } });

  if (typeof appendChatMessage !== 'function') {
    window.appendChatMessage = undefined;
    function appendChatMessageFallback(m, opts) {
      if (!chatMessages) return;
      const wrapper = document.createElement('div');
      wrapper.style.padding = '6px 8px';
      wrapper.style.marginBottom = '6px';
      wrapper.style.borderRadius = '6px';
      const isHostMsg = !!(m && (m.fromHost === true || m.fromHost === 'true'));
      wrapper.style.background = isHostMsg ? '#fff9c4' : '#f8fafc'; // highlight host msg with light yellow
      wrapper.innerHTML = `<div style="font-weight:700;font-size:13px">${escapeHtml(m.clientName || m.name || 'Unknown')}</div>
                           <div style="font-size:13px;margin-top:4px">${escapeHtml(m.text || '')}</div>
                           <div style="font-size:11px;color:#909090;margin-top:6px">${new Date(m.ts||Date.now()).toLocaleTimeString()}</div>`;
      chatMessages.appendChild(wrapper);
      if (!(opts && opts.skipScroll)) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    window.appendChatMessageFallback = appendChatMessageFallback;
  }

  // overlay UI container & insertion (keeps single instance)
  let overlaysContainer = document.getElementById('overlays-container');
  if (!overlaysContainer) {
    overlaysContainer = document.createElement('div');
    overlaysContainer.id = 'overlays-container';
    overlaysContainer.style.marginTop = '12px';
  }

  // small CSS injection for overlays and chat
  const _hlStyle = document.createElement('style');
  _hlStyle.id = 'map-overlays-style';
  _hlStyle.textContent = `
    .pin-highlight { transform: scale(1.35); transition: transform 240ms ease; filter: drop-shadow(0 8px 20px rgba(0,0,0,0.14)); z-index:9999 !important; }
    #overlays-container { position: relative; overflow: auto; min-height: 80px; max-height: 60vh; background:#fff; border:1px solid #eef2f7; border-radius:8px; padding:10px; }
    #overlays-container .resizer { width: 14px; height: 14px; position: absolute; right:8px; bottom:8px; cursor: se-resize; border-radius: 3px; background: linear-gradient(135deg,#e6eefb,#cfe3ff); box-shadow:0 1px 3px rgba(0,0,0,0.08); display:flex;align-items:center;justify-content:center; z-index: 20; }
    #overlays-container .resizer:after { content:''; width:8px; height:8px; border-right:2px solid rgba(0,0,0,0.12); border-bottom:2px solid rgba(0,0,0,0.12); transform:rotate(45deg); }
    #overlays-container .row { display:flex; gap:8px; align-items:center; }
    #overlays-container input[type="text"], #overlays-container input[type="number"] { padding:8px; border-radius:8px; border:1px solid #e6e9ef; font-size:13px; min-width:0; }
    #overlays-container .overlay-pin { background:#1e90ff; color:#fff; padding:8px 10px; border-radius:8px; cursor:pointer; border:none; }
    #overlays-container .overlay-entry { padding:8px; border-radius:8px; border:1px solid #eef2f7; margin-bottom:8px; display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
    #overlays-container .overlay-entry .left { flex:1; }
    #overlays-container .overlay-entry .right { display:flex; flex-direction:column; gap:6px; align-items:flex-end; }
    #overlays-container .overlay-entry .meta { font-size:12px; color:#6b7280; margin-top:6px; }
    #overlays-container .overlay-entry input[type="number"] { padding:6px; border-radius:6px; border:1px solid #e6e9ef; width:90px; }
    #overlays-container .btn { padding:6px 8px; border-radius:8px; border:1px solid #e6eef7; background:#fff; cursor:pointer; }
    #overlays-container .btn.danger { background:#ef4444; color:#fff; border:none; }
    #overlays-container .btn.secondary { background:#f8fafc; }
    .shape-entry { }
    .labeled-marker-icon img { pointer-events:auto; }  /* allow marker interactions */
    .line-tooltip { background: rgba(255,255,255,0.92); padding:4px 8px; border-radius:6px; border:1px solid rgba(0,0,0,0.08); font-size:12px; color:#111; }
  `;
  document.head.appendChild(_hlStyle);

  const _chatStyle = document.createElement('style');
  _chatStyle.id = 'map-chat-style';
  _chatStyle.textContent = `
    #chat-modal { display:none; position: fixed; right:16px; bottom:16px; width:32vw; height:32vh; min-width:300px; min-height:260px; background:#fff; border-radius:10px; box-shadow:0 12px 30px rgba(0,0,0,0.18); z-index:99999; overflow:hidden; }
    #chat-modal .chat-header{ display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-bottom:1px solid #eef2f7; font-weight:700;}
    #chat-messages { padding:10px; overflow-y:auto; height: calc(100% - 115px); box-sizing:border-box; }
    #chat-input-row { display:flex; gap:8px; padding:8px 10px; border-top:1px solid #eef2f7; align-items:center; box-sizing:border-box; }
    #chat-input { flex:1; min-height:36px; max-height:90px; resize:none; padding:8px; border-radius:6px; border:1px solid #e6e9ef; box-sizing:border-box; }
    #chat-send { padding:8px 12px; border-radius:8px; border:1px solid #e6e9ef; background:#1e88e5; color:#fff; cursor:pointer; }
  `;
  document.head.appendChild(_chatStyle);

  // ---------- Inserted from partial: tile/cache/prefetch helpers ----------
  // tile fetching configuration
  const SEA_BACKGROUND = '#87CEEB';
  const TILE_EXTENSIONS = ['png', 'jpg'];
  const FETCH_CONCURRENCY = 6;

  // small transparent gif fallback
  const TRANSPARENT_1PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  // helper convert ArrayBuffer -> base64 string
  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // ---------- Custom TileLayer implementation ----------
  // Create a custom Leaflet tile layer that will:
  // 1) check local app 'India Tiles' (packaged)
  // 2) check client's cache (userData/tile-cache)
  // 3) fetch from host /tiles/{z}/{x}/{y}.{ext} then save to cache
  const CustomTileLayer = L.TileLayer.extend({
    createTile: function(coords, done) {
      const tile = document.createElement('img');
      tile.alt = '';
      tile.setAttribute('role','presentation');
      // sizing
      const size = this.getTileSize();
      tile.width = size.x; tile.height = size.y;
      tile.style.background = SEA_BACKGROUND;
      tile.decoded = false;

      const z = coords.z, x = coords.x, y = coords.y;
      const self = this;

      // completed callback for Leaflet
      function finish(ok) {
        if (ok) done(null, tile); else done(null, tile);
      }

      (async () => {
        try {
          // 1) try local packaged tiles
          for (const ext of TILE_EXTENSIONS) {
            const resLocal = await window.electronAPI.checkLocalTile(z, x, y, ext);
            if (resLocal && resLocal.exists && resLocal.path) {
              tile.src = resLocal.path;
              return finish(true);
            }
          }

          // 2) try client cache
          for (const ext of TILE_EXTENSIONS) {
            const resCache = await window.electronAPI.checkCacheTile(z, x, y, ext);
            if (resCache && resCache.exists && resCache.path) {
              tile.src = resCache.path;
              return finish(true);
            }
          }

          // 3) fetch from host (try png then jpg)
          if (!serverUrl) {
            // no server URL available; show transparent tile
            tile.src = TRANSPARENT_1PX;
            return finish(false);
          }
          for (const ext of TILE_EXTENSIONS) {
            const tileUrl = `${serverUrl.replace(/\/$/,'')}/tiles/${z}/${x}/${y}.${ext}`;
            try {
              const resp = await fetch(tileUrl, { cache: 'no-cache' });
              if (!resp.ok) {
                // try next ext
                continue;
              }
              const arrayBuffer = await resp.arrayBuffer();
              // convert to base64 to send to main
              const base64 = arrayBufferToBase64(arrayBuffer);
              const saveRes = await window.electronAPI.saveCacheTile(z, x, y, ext, base64);
              if (saveRes && saveRes.ok && saveRes.path) {
                tile.src = saveRes.path;
                return finish(true);
              } else {
                // fallback: create blob url to show immediately
                const blob = new Blob([arrayBuffer], { type: resp.headers.get('content-type') || `image/${ext}` });
                tile.src = URL.createObjectURL(blob);
                // attempt saving in background (best-effort)
                window.electronAPI.saveCacheTile(z, x, y, ext, base64).catch(()=>{});
                return finish(true);
              }
            } catch (err) {
              // try next ext
              continue;
            }
          }

          // no tile found anywhere -> use transparent placeholder; background will show SEA_BACKGROUND
          tile.src = TRANSPARENT_1PX;
          return finish(false);
        } catch (err) {
          console.error('createTile error', err);
          tile.src = TRANSPARENT_1PX;
          return finish(false);
        }
      })();

      // handle generic image load errors
      tile.onerror = () => {
        tile.src = TRANSPARENT_1PX;
        finish(false);
      };

      return tile;
    }
  });

  // instantiate the tile layer (we set maxNativeZoom to 13 and maxZoom to 15)
  function createCustomTileLayer(urlForLog) {
    const opts = {
      minZoom: 3,
      maxNativeZoom: 13, // tiles provided up to 13
      maxZoom: 15,
      tileSize: 256,
      // keep default attribution etc.
      attribution: '© Local Tiles'
    };
    return new CustomTileLayer('', opts);
  }

  // ---------- Prefetch logic (for zooms 0..5 inside current viewport) ----------
  // concurrency-limited queue
  function TaskQueue(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }
  TaskQueue.prototype.push = function(task) {
    this.queue.push(task);
    this.next();
  };
  TaskQueue.prototype.next = function() {
    if (this.running >= this.concurrency) return;
    const task = this.queue.shift();
    if (!task) return;
    this.running++;
    const p = Promise.resolve().then(task);
    p.finally(() => {
      this.running--;
      this.next();
    });
  };

  // lat/lon to XYZ tile calculation (Web Mercator)
  function long2tile(lon, zoom) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
  }
  function lat2tile(lat, zoom) {
    const rad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(rad) + 1/Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, zoom));
  }
  function latLngToTile(lat, lon, z) {
    return { x: long2tile(lon, z), y: lat2tile(lat, z) };
  }

  // prefetch tiles for zooms 0..5 for current map view (small margin)
  async function prefetchZoomRange(mapInstance, serverUrlToUse, onProgress) {
    if (!mapInstance || !serverUrlToUse) return;
    const zMin = 0, zMax = 5;
    const q = new TaskQueue(FETCH_CONCURRENCY);
    const tasks = [];
    let total = 0, done = 0;

    for (let z = zMin; z <= zMax; z++) {
      // compute tile range for current map bounds at zoom z
      const bounds = mapInstance.getBounds();
      const nw = bounds.getNorthWest();
      const se = bounds.getSouthEast();

      const nwTile = latLngToTile(nw.lat, nw.lng, z);
      const seTile = latLngToTile(se.lat, se.lng, z);

      // clamp x,y ranges
      const xMin = Math.max(0, Math.min(nwTile.x, seTile.x));
      const xMax = Math.max(nwTile.x, seTile.x);
      const yMin = Math.max(0, Math.min(nwTile.y, seTile.y));
      const yMax = Math.max(nwTile.y, seTile.y);

      // expand by 1 tile margin to make panning smooth
      const margin = 1;
      for (let x = Math.max(0, xMin - margin); x <= xMax + margin; x++) {
        for (let y = Math.max(0, yMin - margin); y <= yMax + margin; y++) {
          total++;
          const task = async () => {
            // check local & cache first
            for (const ext of TILE_EXTENSIONS) {
              const loc = await window.electronAPI.checkLocalTile(z, x, y, ext);
              if (loc && loc.exists) {
                done++; if (onProgress) onProgress(done, total); return;
              }
              const cache = await window.electronAPI.checkCacheTile(z, x, y, ext);
              if (cache && cache.exists) {
                done++; if (onProgress) onProgress(done, total); return;
              }
            }
            // fetch from host (png then jpg)
            for (const ext of TILE_EXTENSIONS) {
              const url = `${serverUrlToUse.replace(/\/$/,'')}/tiles/${z}/${x}/${y}.${ext}`;
              try {
                const resp = await fetch(url, { cache: 'no-cache' });
                if (!resp.ok) continue;
                const ab = await resp.arrayBuffer();
                const b64 = arrayBufferToBase64(ab);
                await window.electronAPI.saveCacheTile(z, x, y, ext, b64);
                break; // success for this tile
              } catch (err) {
                // ignore & try next ext
              }
            }
            done++; if (onProgress) onProgress(done, total);
          };
          q.push(task);
        }
      }
    }

    // return promise that resolves when queue empties
    return new Promise(resolve => {
      const poll = () => {
        if (q.running === 0 && q.queue.length === 0) return resolve();
        setTimeout(poll, 300);
      };
      poll();
    });
  }

  // small prefetch progress UI
  function createPrefetchProgressUI() {
    const wrap = document.createElement('div');
    wrap.style.position = 'absolute';
    wrap.style.left = '50%';
    wrap.style.top = '12px';
    wrap.style.transform = 'translateX(-50%)';
    wrap.style.background = 'rgba(255,255,255,0.96)';
    wrap.style.padding = '8px 12px';
    wrap.style.borderRadius = '8px';
    wrap.style.boxShadow = '0 8px 20px rgba(0,0,0,0.12)';
    wrap.style.zIndex = 4000;
    wrap.innerHTML = `<div class="pf-text" style="font-size:13px;font-weight:700;margin-bottom:6px">Prefetching tiles...</div>
      <div style="width:260px;height:8px;background:#eef2f7;border-radius:6px;overflow:hidden">
        <div class="pf-bar-inner" style="width:0;height:100%;background:#1e88e5"></div>
      </div>
      <div style="font-size:12px;color:#6b7280;margin-top:6px">Downloading tiles for current view (0–5). You can continue using the app.</div>`;
    const containerEl = document.getElementById('map-container') || document.body;
    containerEl.appendChild(wrap);
    wrap.style.display = 'none';
    return wrap;
  }
  // ---------- End inserted partial helpers ----------

  try {
    const hosts = await window.electronAPI.discoverHosts();
    if (hosts && hosts.length === 1) showStatus('Host found — enter name to join.');
  } catch(e){ console.warn(e); }

  // --- renderOverlayEntry now targets overlay-pins only ---
  function renderOverlayEntry(internalId, lat, lon, title='Pin') {
    const pinsContainer = overlaysContainer.querySelector('#overlay-pins');
    if (!pinsContainer) return;
    let existing = pinsContainer.querySelector(`div[data-id="${internalId}"]`);
    const p = pins[internalId]; // may exist by now
    const elevVal = p ? (p.elevation || 0) : 0;
    const bearVal = p ? (p.bearing || 0) : 0;
    const content = document.createElement('div');
    content.className = 'overlay-entry';
    content.dataset.id = internalId;
    content.innerHTML = `
      <div class="left">
        <div style="font-weight:700">${escapeHtml(p && p.subId ? p.subId : title)}</div>
        <div class="meta">Lat:${Number(lat).toFixed(6)}, Lon:${Number(lon).toFixed(6)}</div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <label style="font-size:13px">Elevation:</label>
          <input class="ov-elev" type="number" value="${elevVal}" />
          <label style="font-size:13px">Bearing:</label>
          <input class="ov-bear" type="number" value="${bearVal}" />
        </div>
      </div>
      <div class="right">
        <button class="btn overlay-show">Show</button>
        <button class="btn danger overlay-del">&times;</button>
      </div>
    `;
    if (existing) {
      existing.replaceWith(content);
      existing = content;
    } else {
      pinsContainer.appendChild(content);
    }

    content.querySelector('.overlay-show').onclick = () => {
      const pinObj = pins[internalId];
      if (pinObj && pinObj.marker) {
        const targetZoom = map ? Math.max(map.getZoom(), 10) : 10;
        map.setView(pinObj.marker.getLatLng(), targetZoom, { animate: true });
        showRadiusPopup(internalId);
      } else if (pinObj) {
        const targetZoom = map ? Math.max(map.getZoom(), 10) : 10;
        map.setView([pinObj.lat, pinObj.lon], targetZoom, { animate: true });
      }
    };
    content.querySelector('.overlay-del').onclick = () => {
      removePin(internalId);
      content.remove();
    };

    const elevInp = content.querySelector('.ov-elev');
    elevInp.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const val = parseFloat(elevInp.value) || 0;
        if (pins[internalId]) {
          pins[internalId].elevation = val;
          if (socket && socket.connected) {
            const parts = internalId.split('_');
            const orig = parts.slice(1).join('_');
            const owner = parts[0];
            if (owner !== 'overlay' && owner !== 'local') {
              if (isHost) socket.emit('updateElevation', { id: orig, elevation: val, ownerClientId: owner });
              else socket.emit('updateElevation', { id: orig, elevation: val });
            }
          }
          renderSidebarEntry(internalId);
        }
      }
    };

    const bearInp = content.querySelector('.ov-bear');
    bearInp.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const val = parseFloat(bearInp.value) || 0;
        if (pins[internalId]) {
          pins[internalId].bearing = val;
          if (socket && socket.connected) {
            const parts = internalId.split('_');
            const orig = parts.slice(1).join('_');
            const owner = parts[0];
            if (owner !== 'overlay' && owner !== 'local') {
              // emit to host: include clientId so host maps to correct internal id
              if (isHost) socket.emit('updateBearing', { id: orig, bearing: val, ownerClientId: owner, clientId: owner });
              else socket.emit('updateBearing', { id: orig, bearing: val, clientId: socket.id });
            }
          }
          renderSidebarEntry(internalId);
        }
      }
    };
  }

  // overlay UI (pins + shapes separate)
  function ensureOverlayUI() {
    if (!overlaysContainer) return;
    if (!overlaysContainer.querySelector('#overlay-lat-input')) {
      overlaysContainer.innerHTML = `
        <h3 style="margin:6px 0 8px">Overlays</h3>
        <div class="row" style="margin-bottom:8px">
          <input id="overlay-lat-input" type="text" placeholder="Latitude (e.g. 28.6139)" />
          <input id="overlay-lon-input" type="text" placeholder="Longitude (e.g. 77.2090)" />
          <button id="overlay-pin-btn" class="overlay-pin">Pin</button>
        </div>
        <div style="font-size:13px;color:#6b7280;margin-bottom:6px">Enter lat & long, then click Pin to center the map on that coordinate.</div>
        <div id="overlays-list" style="margin-top:6px">
          <div id="overlay-pins"></div>
          <div id="overlay-shapes"></div>
        </div>
        <div class="resizer" title="Drag to resize"></div>
      `;
    }
    if (!sidebar.querySelector('#overlays-container')) {
      sidebar.insertBefore(overlaysContainer, sidebar.firstChild);
    }

    const pinBtnEl = overlaysContainer.querySelector('#overlay-pin-btn');
    if (pinBtnEl && !pinBtnEl.dataset.attached) {
      pinBtnEl.dataset.attached = '1';
      pinBtnEl.addEventListener('click', () => {
        const latInp = overlaysContainer.querySelector('#overlay-lat-input');
        const lonInp = overlaysContainer.querySelector('#overlay-lon-input');
        const latStr = (latInp && latInp.value || '').trim();
        const lonStr = (lonInp && lonInp.value || '').trim();
        const lat = parseFloat(latStr);
        const lon = parseFloat(lonStr);
        if (!isFinite(lat) || !isFinite(lon)) {
          showStatus('Invalid coordinates — check values');
          return;
        }

        if (isHost && socket && socket.connected) {
          const placementId = Date.now().toString() + '_' + Math.random().toString(36).slice(2,7);
          const color = pinColorInput && pinColorInput.value ? pinColorInput.value : '#ff4d4f';
          socket.emit('newPin', { id: placementId, groupId: currentPinGroupId, lat: lat, lon: lon, pinColor: color, rf: false });
          // programmatic center: cap to zoom 10 for consistency with native tiles
          map.setView([lat, lon], Math.max(map.getZoom(), 10), { animate: true });
          showStatus(`Pinned (broadcast) at ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
          return;
        }

        const internalId = `overlay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
        const ownerClientId = (socket && socket.id) ? socket.id : 'local';
        addPin(internalId, lat, lon, (clientNameInput && clientNameInput.value) || 'Local', ownerClientId, '#ff4d4f', false, null, null);

        // ---------- NEW: compute bearing for offline overlay pin if user dot exists ----------
        try {
          if (!isHost && userMarker && pins[internalId]) {
            const u = userMarker.getLatLng();
            const deg = bearingFromLatLon(u.lat, u.lng, lat, lon);
            pins[internalId].bearing = deg;
            // update overlay + sidebar
            renderOverlayEntry(internalId, lat, lon, 'Pin');
            renderSidebarEntry(internalId);
          } else {
            renderOverlayEntry(internalId, lat, lon, 'Pin');
          }
        } catch(e) { renderOverlayEntry(internalId, lat, lon, 'Pin'); }
        // ----------------------------------------------------------------------------------

        map.setView([lat, lon], Math.max(map.getZoom(), 10), { animate: true });
        showStatus(`Pinned at ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
      });
    }

    // resizer
    const resizer = overlaysContainer.querySelector('.resizer');
    if (resizer && !overlaysContainer.dataset.resizerAttached) {
      overlaysContainer.dataset.resizerAttached = '1';
      let dragging = false, startX = 0, startY = 0, startW = 0, startH = 0, rafId = null;
      const MIN_W = 220, MIN_H = 80, MAX_W = 900, MAX_H = window.innerHeight - 120;
      function onDown(e) {
        dragging = true; startX = e.clientX; startY = e.clientY;
        const rect = overlaysContainer.getBoundingClientRect();
        startW = rect.width; startH = rect.height;
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.body.style.userSelect = 'none';
      }
      function onMove(e) {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(()=> {
          let newW = Math.min(Math.max(MIN_W, startW + dx), MAX_W);
          let newH = Math.min(Math.max(MIN_H, startH + dy), MAX_H);
          overlaysContainer.style.width = newW + 'px';
          overlaysContainer.style.height = newH + 'px';
        });
      }
      function onUp() {
        dragging = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.userSelect = '';
      }
      resizer.addEventListener('pointerdown', onDown);
    }
  }

  // --- State ---
  let map = null, socket = null, serverUrl = null, isHost = false;
  let isUserMode = false, isPinMode = false;
  let userMarker = null, userSidebar = null;
  const pins = {};    // key: `${clientId}_${placementId}` or overlay_internal id
  const userDots = {}; // clientId -> circleMarker
  const lines = {};   // pinKey -> polyline (distance lines)
  const hitLines = {}; // pinKey -> invisible wide polyline used to increase hover target
  let selectedClientId = null;
  let currentShapePlacement = null;

  // helper: extract numeric base from group id "pin-101" -> "101"
  function getGroupDisplayBase(groupId) {
    if (!groupId) return '';
    const m = String(groupId).match(/-(\d+)$/);
    return m ? m[1] : String(groupId);
  }

  // helper: compute font size from map zoom (tweak mapping as desired)
  function fontSizeForZoom(z) {
    if (typeof z === 'undefined' || z === null) z = 5;
    const zClamped = Math.max(3, Math.min(10, z)); // clamp to 3..10 for sizing
    const size = Math.round(10 + Math.max(0, Math.min(6, (zClamped - 3) * 0.6)));
    return Math.max(10, Math.min(16, size));
  }

  // refresh all labeled icons to reflect current zoom
  function refreshLabelIcons() {
    if (!map) return;
    const fs = fontSizeForZoom(map.getZoom());
    Object.entries(pins).forEach(([id,p]) => {
      if (!p) return;
      if (p.marker && p.marker.setIcon) {
        try {
          const label = p.subId || (p.groupId ? getGroupDisplayBase(p.groupId) + '.?' : '');
          p.marker.setIcon(buildLabeledDivIcon(label, p.pinColor || '#ff4d4f', fs));
        } catch (e) { /* ignore */ }
      }
    });
  }

  // helper: add id to group array and redraw group line
  function addToGroup(groupId, internalId) {
    if (!groupId) return;
    if (!groupPins[groupId]) groupPins[groupId] = [];
    if (!groupPins[groupId].includes(internalId)) {
      groupPins[groupId].push(internalId);

      // ARCHIVE: keep at most 5 visible pins on map for each group
      const MAX_VISIBLE = 5;
      while (groupPins[groupId].length > MAX_VISIBLE) {
        const firstId = groupPins[groupId].shift();
        const firstPin = pins[firstId];
        if (firstPin) {
          firstPin.archived = true;
          try { if (firstPin.marker) map.removeLayer(firstPin.marker); } catch(e){}
          firstPin.marker = null;
          try { if (firstPin.radiusCircle) map.removeLayer(firstPin.radiusCircle); } catch(e){}
          firstPin.radiusCircle = null;
          if (lines[firstId]) { try { map.removeLayer(lines[firstId]); } catch(e){} delete lines[firstId]; }
          renderSidebarEntry(firstId);
          renderOverlayEntry(firstId, firstPin.lat, firstPin.lon, firstPin.rf ? 'RF' : 'Pin');

          // If we are host, also request removal so clients remove the oldest pin from the group.
          try {
            if (isHost) {
              const parts = firstId.split('_');
              const owner = parts[0];
              const orig = parts.slice(1).join('_');
              if (owner !== 'overlay' && owner !== 'local' && socket && socket.connected) {
                socket.emit('removePin', { id: orig, ownerClientId: owner });
              }
            }
          } catch(e) { console.warn('emit removePin for archived first failed', e); }
        }
      }

      redrawGroupLine(groupId);
    }
  }

  // helper: remove id from group and redraw or remove
  function removeFromGroup(groupId, internalId) {
    if (!groupId || !groupPins[groupId]) return;
    groupPins[groupId] = groupPins[groupId].filter(x => x !== internalId);
    if (groupPins[groupId].length < 2) {
      if (groupLines[groupId]) { try { map.removeLayer(groupLines[groupId]); } catch(e){} delete groupLines[groupId]; }
      if (groupPins[groupId].length === 0) delete groupPins[groupId];
    } else {
      redrawGroupLine(groupId);
    }
  }
  // actually build/replace the polyline for a group (in insertion order)
  function redrawGroupLine(groupId) {
    if (!groupPins[groupId] || groupPins[groupId].length < 2) {
      if (groupLines[groupId]) { try { map.removeLayer(groupLines[groupId]); } catch(e){} delete groupLines[groupId]; }
      return;
    }
    const latlngs = [];
    let lineColor = null;
    for (const internalId of groupPins[groupId]) {
      const p = pins[internalId];
      if (!p || !p.marker || typeof p.marker.getLatLng !== 'function') continue;
      const ll = p.marker.getLatLng();
      latlngs.push([ll.lat, ll.lng]);
      if (!lineColor && p.pinColor) lineColor = p.pinColor;
    }
    if (latlngs.length < 2) {
      if (groupLines[groupId]) { try { map.removeLayer(groupLines[groupId]); } catch(e){} delete groupLines[groupId]; }
      return;
    }
    if (groupLines[groupId]) { try { map.removeLayer(groupLines[groupId]); } catch(e){} delete groupLines[groupId]; }
    // Radar groups should use purple for their group dotted line
    if (String(groupId).startsWith('radar')) lineColor = lineColor || '#800080';
    const poly = L.polyline(latlngs, { color: lineColor || '#333', weight:2, opacity:0.9, dashArray: '6,6' }).addTo(map);
    groupLines[groupId] = poly;
  }

  // --- Host start ---
  hostBtn.addEventListener('click', async () => {
    await window.electronAPI.startHost();
    isHost = true; serverUrl = 'http://localhost:3000';
    initApp(serverUrl, true, null, null);
    modal.style.display = 'none'; container.style.display = 'flex';
    serverBtn.style.display = 'block'; serverPanel.style.display = 'block';
    showStatus('Hosting on this machine');
    createHostShapeButtons();
    // per request: remove/hide User Mode button on host so host cannot place user-dot
    try { if (userBtn) userBtn.style.display = 'none'; } catch(e){}
  });

  // --- Client join ---
  clientBtn.addEventListener('click', async () => {
    const name = clientNameInput.value.trim();
    if (!name) return alert('Please enter your name (required).');
    const manualIP = ipInput.value.trim();
    if (manualIP) {
      serverUrl = `http://${manualIP}:3000`;
      initApp(serverUrl, false, name, { pinColor: pinColorInput.value, userDotColor: userDotColorInput.value });
      modal.style.display = 'none'; container.style.display = 'flex';
      return;
    }
    try {
      const hosts = await window.electronAPI.discoverHosts();
      if (hosts && hosts.length === 1) {
        serverUrl = `http://${hosts[0]}:3000`;
        initApp(serverUrl, false, name, { pinColor: pinColorInput.value, userDotColor: userDotColorInput.value });
        modal.style.display = 'none'; container.style.display = 'flex';
        showStatus('Connected to host ' + hosts[0]);
        return;
      }
      if (!hosts || hosts.length === 0) return alert('No host found. Enter IP or start host.');
      return alert('Multiple hosts found — enter IP manually.');
    } catch(e){ return alert('Discovery failed — enter IP manually.'); }
  });

  serverBtn.addEventListener('click', ()=> serverPanel.style.display = serverPanel.style.display === 'block' ? 'none' : 'block');

  // --- toggle mode buttons ---
  userBtn.addEventListener('click', ()=> {
    isUserMode = !isUserMode;
    if (isUserMode) { isPinMode = false; pinBtn.classList.remove('active'); pinBtn.textContent = 'Pin Mode OFF'; }
    userBtn.classList.toggle('active', isUserMode);
    userBtn.textContent = `User Mode ${isUserMode? 'ON' : 'OFF'}`;
  });
  pinBtn.addEventListener('click', ()=> {
    isPinMode = !isPinMode;
    if (isPinMode) { isUserMode = false; userBtn.classList.remove('active'); userBtn.textContent = 'User Mode OFF'; }
    // turning pin mode on should disable radar & rf
    if (isPinMode) {
      if (radarBtn) { radarBtn.classList.remove('active'); }
      if (typeof isRadarMode !== 'undefined') isRadarMode = false;
      if (rfBtn) { rfBtn.classList.remove('active'); }
      isRFMode = false;
    }
    pinBtn.classList.toggle('active', isPinMode);
    pinBtn.textContent = `Pin Mode ${isPinMode? 'ON':'OFF'}`;
  });

 // RF toggle - ensure mutual exclusivity (replace existing rfBtn listener with this)
 const rfBtn = document.getElementById('rf-toggle-btn');
 let isRFMode = false;
 rfBtn && rfBtn.addEventListener('click', ()=> {
   isRFMode = !isRFMode;

   if (isRFMode) {
     // Turn off Radar if it was on
     isRadarMode = false;
     if (radarBtn) {
       radarBtn.classList.remove('active');
       radarBtn.textContent = 'Radar Mode OFF';
     }

     // Also turn off Pin/User modes to avoid confusion
     isPinMode = false;
     pinBtn.classList.remove('active');
     pinBtn.textContent = 'Pin Mode OFF';

     isUserMode = false;
     userBtn.classList.remove('active');
     userBtn.textContent = 'User Mode OFF';
   }

   rfBtn.classList.toggle('active', isRFMode);
   rfBtn.textContent = `RF Mode ${isRFMode ? 'ON' : 'OFF'}`;
 });

 // Radar toggle - ensure mutual exclusivity with Pin & RF (replace existing radarBtn listener with this)
 let isRadarMode = false;
 radarBtn && radarBtn.addEventListener('click', ()=> {
   isRadarMode = !isRadarMode;

   if (isRadarMode) {
     // Turn off RF if it was on
     isRFMode = false;
     if (rfBtn) {
       rfBtn.classList.remove('active');
       rfBtn.textContent = 'RF Mode OFF';
     }

     // Also turn off Pin/User modes to avoid confusion
     isPinMode = false;
     pinBtn.classList.remove('active');
     pinBtn.textContent = 'Pin Mode OFF';

     isUserMode = false;
     userBtn.classList.remove('active');
     userBtn.textContent = 'User Mode OFF';
   }

   radarBtn.classList.toggle('active', isRadarMode);
   radarBtn.textContent = `Radar Mode ${isRadarMode ? 'ON' : 'OFF'}`;
 });

  // Clear
  clearBtn && clearBtn.addEventListener('click', () => {
    if (!socket) return;
    if (isHost) {
      socket.emit('clearAll');
      clearAll();
    } else {
      socket.emit('clearClientPins');
      clearClientData(socket.id);
    }
  });

  // Generate ID
  const generateBtn = document.getElementById('generate-ID-btn');
  // create a dropdown to show/store which generate id is in use
  if (generateBtn) {
    let genSelect = document.getElementById('generate-id-select');
    if (!genSelect) {
      genSelect = document.createElement('select');
      genSelect.id = 'generate-id-select';
      genSelect.style.marginLeft = '8px';
      genSelect.style.padding = '6px';
      const optPin = document.createElement('option'); optPin.value='pin'; optPin.textContent = currentPinGroupId;
      const optRf = document.createElement('option'); optRf.value='rf'; optRf.textContent = currentRfGroupId;
      const optRadar = document.createElement('option'); optRadar.value='radar'; optRadar.textContent = currentRadarGroupId;
      genSelect.appendChild(optPin); genSelect.appendChild(optRf); genSelect.appendChild(optRadar);
      generateBtn.parentNode && generateBtn.parentNode.insertBefore(genSelect, generateBtn.nextSibling);
    }

    generateBtn.addEventListener('click', () => {
      const sel = document.getElementById('generate-id-select');
      const selectedMode = sel ? sel.value : (isRadarMode ? 'radar' : (isPinMode ? 'pin' : (isRFMode ? 'rf' : 'pin')));
      // prefer radar if radar mode is on; otherwise pin, then rf (fallback kept for compatibility)
      const mode = selectedMode || (isRadarMode ? 'radar' : (isPinMode ? 'pin' : (isRFMode ? 'rf' : 'pin')));
      function makeNextId(prefix, startNum=100) {
        let current;
        if (prefix === 'pin') current = currentPinGroupId;
        else if (prefix === 'rf') current = currentRfGroupId;
        else if (prefix === 'radar') current = currentRadarGroupId;
        else current = null;
        const m = (current || '').match(/-(\d+)$/);
        let n = m ? parseInt(m[1],10) : startNum;
        do {
          n++;
          const candidate = `${prefix}-${n}`;
          if (!usedGroupIds.has(candidate)) return candidate;
        } while (true);
      }
      if (mode === 'pin') {
        const newId = makeNextId('pin', 100);
        currentPinGroupId = newId;
        usedGroupIds.add(newId);
        groupCounters[newId] = 0;
        showStatus(`New Pin group ID: ${newId}`);
        // update dropdown label
        const o = document.querySelector('#generate-id-select option[value="pin"]'); if (o) o.textContent = newId; if (sel) sel.value='pin';
      } else if (mode === 'rf') {
        const newId = makeNextId('rf', 200);
        currentRfGroupId = newId;
        usedGroupIds.add(newId);
        groupCounters[newId] = 0;
        showStatus(`New RF group ID: ${newId}`);
        const o = document.querySelector('#generate-id-select option[value="rf"]'); if (o) o.textContent = newId; if (sel) sel.value='rf';
      } else if (mode === 'radar') {
        const newId = makeNextId('radar', 300);
        currentRadarGroupId = newId;
        usedGroupIds.add(newId);
        groupCounters[newId] = 0;
        showStatus(`New Radar group ID: ${newId}`);
        const o = document.querySelector('#generate-id-select option[value="radar"]'); if (o) o.textContent = newId; if (sel) sel.value='radar';
      }
    });
  }

  // --- init app and socket handlers ---
  function initApp(url, hostFlag=false, clientName=null, colors=null) {
    serverUrl = url; isHost = hostFlag;
    ensureOverlayUI();

    if (!map) {
      // Map init: minZoom 3, maxZoom 15, but tiles are only native up to zoom 10.
      map = L.map('map', {
        minZoom: 3,
        maxZoom: 15,
      }).setView([20.5937,78.9629], 5);

      // create custom tile layer that uses our fallback/cache logic
      const customTiles = createCustomTileLayer(url);
      // add to map
      customTiles.addTo(map);

      // style map container background for sea color
      const mapEl = document.getElementById('map');
      if (mapEl) mapEl.style.background = SEA_BACKGROUND;

      map.on('click', e => {
        if (currentShapePlacement && isHost) {
          openShapePopupAt(currentShapePlacement, e.latlng);
        } else if (isUserMode) {
          placeUserDot(e.latlng, true);
        } else if (isRadarMode) {
          // Radar placement: optimistic local subId assignment when connected
          const placementId = Date.now().toString() + '_' + Math.random().toString(36).slice(2,7);
          const radarColor = '#800080';
          if (socket && socket.connected && socket.id) {
            const internalId = `${socket.id}_${placementId}`;
            if (typeof groupCounters[currentRadarGroupId] === 'undefined') groupCounters[currentRadarGroupId] = 0;
            groupCounters[currentRadarGroupId] = (groupCounters[currentRadarGroupId] || 0) + 1;
            const assigned = `${getGroupDisplayBase(currentRadarGroupId)}.${groupCounters[currentRadarGroupId]}`;
            addPin(internalId, e.latlng.lat, e.latlng.lng, (clientNameInput && clientNameInput.value) || clientName || 'Local', socket.id, radarColor, false, currentRadarGroupId, assigned);
            // update overlay list immediately
            try { renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'Radar'); } catch(e){/*ignore*/}

            // notify server (server will also add and emit canonical assignments)
            socket.emit('newPin', { id: placementId, groupId: currentRadarGroupId, lat: e.latlng.lat, lon: e.latlng.lng, pinColor: radarColor, rf: false });
          } else {
            // offline/local add (unchanged)
            const internalId = `local_${placementId}`;
            addPin(internalId, e.latlng.lat, e.latlng.lng, (clientNameInput && clientNameInput.value) || 'Local', 'local', '#FFEB3B', false, currentRadarGroupId, null);
            renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'Radar');
          }
        } else if (isRFMode) {
          const placementId = Date.now().toString() + '_' + Math.random().toString(36).slice(2,7);
          const rfColor = '#20c933';
          if (socket && socket.connected && socket.id) {
            const internalId = `${socket.id}_${placementId}`;
            if (typeof groupCounters[currentRfGroupId] === 'undefined') groupCounters[currentRfGroupId] = 0;
            groupCounters[currentRfGroupId] = (groupCounters[currentRfGroupId] || 0) + 1;
            const assigned = `${getGroupDisplayBase(currentRfGroupId)}.${groupCounters[currentRfGroupId]}`;
            // optimistic add + show radius immediately for better UX
            addPin(internalId, e.latlng.lat, e.latlng.lng, (clientNameInput && clientNameInput.value) || clientName || 'Local', socket.id, rfColor, true, currentRfGroupId, assigned);
            applyRemoteRadius(internalId, 5000, rfColor);
            try { renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'RF'); } catch(e){/*ignore*/}

            // ---------- NEW: compute bearing client-side for RF pins (same behavior as normal pins)
            try {
              if (!isHost && userMarker && pins[internalId]) {
                const u = userMarker.getLatLng();
                const deg = bearingFromLatLon(u.lat, u.lng, e.latlng.lat, e.latlng.lng);
                pins[internalId].bearing = deg;
                // inform host by emitting updateBearing using the original placementId and clientId
                socket.emit('updateBearing', { id: placementId, bearing: deg, clientId: socket.id });
                // update overlay/sidebar UI locally
                try { renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'RF'); } catch(e){}
                try { renderSidebarEntry(internalId); } catch(e){}
              }
            } catch(e) { /* ignore bearing errors */ }
            // ----------------------------------------------------------------------------------

            // notify server (server will echo and also update radius)
            socket.emit('newPin', { id: placementId, groupId: currentRfGroupId, lat: e.latlng.lat, lon: e.latlng.lng, pinColor: rfColor, rf: true });
            socket.emit('updateRadius', { id: placementId, radius: 5000, color: rfColor });
          } else {
            // offline/local behavior unchanged
            const internalId = `local_${placementId}`;
            addPin(internalId, e.latlng.lat, e.latlng.lng, (clientNameInput && clientNameInput.value) || clientName || 'Local', 'local', '#20c933', true, currentRfGroupId, null);
            // offline: compute bearing if userMarker exists
            try {
              if (!isHost && userMarker && pins[internalId]) {
                const u = userMarker.getLatLng();
                const deg = bearingFromLatLon(u.lat, u.lng, e.latlng.lat, e.latlng.lng);
                pins[internalId].bearing = deg;
                renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'RF');
                renderSidebarEntry(internalId);
              } else {
                applyRemoteRadius(internalId, 5000, '#20c933');
                try { renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'RF'); } catch(e){/*ignore*/}
              }
            } catch(e) { applyRemoteRadius(internalId, 5000, '#20c933'); try { renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'RF'); } catch(e){} }
          }
        } else if (isPinMode) {
          const placementId = Date.now().toString() + '_' + Math.random().toString(36).slice(2,7);
          const userPinColor = (pinColorInput && pinColorInput.value) ? pinColorInput.value : '#ff4d4f';
          if (socket && socket.connected && socket.id) {
            const internalId = `${socket.id}_${placementId}`;
            if (typeof groupCounters[currentPinGroupId] === 'undefined') groupCounters[currentPinGroupId] = 0;
            groupCounters[currentPinGroupId] = (groupCounters[currentPinGroupId] || 0) + 1;
            const assigned = `${getGroupDisplayBase(currentPinGroupId)}.${groupCounters[currentPinGroupId]}`;
            addPin(internalId, e.latlng.lat, e.latlng.lng, (clientNameInput && clientNameInput.value) || clientName || 'Local', socket.id, userPinColor, false, currentPinGroupId, assigned);

            // ---------- NEW: compute bearing client-side (geodesic) and emit updateBearing ----------
            try {
              if (!isHost && userMarker && pins[internalId]) {
                const u = userMarker.getLatLng();
                const deg = bearingFromLatLon(u.lat, u.lng, e.latlng.lat, e.latlng.lng);
                pins[internalId].bearing = deg;
                // inform host by emitting updateBearing using the original placementId and clientId
                socket.emit('updateBearing', { id: placementId, bearing: deg, clientId: socket.id });
              }
            } catch(e) { /* ignore bearing errors */ }
            // -------------------------------------------------------------------------------------

            try { renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'Pin'); } catch(e){/*ignore*/}

            // emit to server (server will also add and announce subIdAssigned back)
            socket.emit('newPin', { id: placementId, groupId: currentPinGroupId, lat: e.latlng.lat, lon: e.latlng.lng, pinColor: userPinColor });
          } else {
            const internalId = `local_${placementId}`;
            addPin(internalId, e.latlng.lat, e.latlng.lng, (clientNameInput && clientNameInput.value) || clientName || 'Local', 'local', '#ff4d4f', false, null, null);

            // ---------- NEW: offline/local pin bearing computed if user dot exists ----------
            try {
              if (!isHost && userMarker && pins[internalId]) {
                const u = userMarker.getLatLng();
                const deg = bearingFromLatLon(u.lat, u.lng, e.latlng.lat, e.latlng.lng);
                pins[internalId].bearing = deg;
                renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'Pin');
                renderSidebarEntry(internalId);
              } else {
                renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'Pin');
              }
            } catch(e) { renderOverlayEntry(internalId, e.latlng.lat, e.latlng.lng, 'Pin'); }
            // ---------------------------------------------------------------------------------
          }
        }
      });

      // update labels on zooming
      map.on('zoomend', () => refreshLabelIcons());

      setTimeout(()=>map.invalidateSize(),150);
    } else setTimeout(()=>map.invalidateSize(),150);

    // connect socket.io
    socket = io(serverUrl, { query: { isHost: hostFlag ? 'true' : 'false' } });

    // debug logs for connection
    socket.on('connect', async () => {
      console.log('socket connected', socket.id, 'isHost=', hostFlag);
      showStatus('Connected to server');
      if (!hostFlag) {
        const info = {
          name: clientName || clientNameInput.value.trim(),
          pinColor: (colors && colors.pinColor) ? colors.pinColor : pinColorInput.value,
          userDotColor: (colors && colors.userDotColor) ? colors.userDotColor : userDotColorInput.value
        };
        socket.emit('clientInfo', info);

        // Kick off prefetch of zoom levels 0..5 in viewport using cache strategy
        // Show small progress if it takes >1s
        const progressEl = createPrefetchProgressUI();
        let progressShown = false, timer = setTimeout(()=>{ progressShown = true; progressEl.style.display='block'; }, 900);
        await prefetchZoomRange(map, serverUrl, (done, total) => {
          if (progressShown) {
            progressEl.querySelector('.pf-text').textContent = `Prefetching tiles: ${done}/${total}`;
            const pct = total ? Math.round(done/total*100) : 0;
            progressEl.querySelector('.pf-bar-inner').style.width = pct + '%';
          }
        });
        clearTimeout(timer);
        progressEl.remove();
        showStatus('Initial tiles prefetched (viewport 0..5)');
      }
    });

    // Chat handlers (same as before — server sets name and fromHost)
    socket.on('chatHistory', history => {
      if (!Array.isArray(history)) return;
      if (chatMessages) chatMessages.innerHTML = '';
      history.forEach(m => {
        if (m && m.id && sentChatIds.has(m.id)) {
          sentChatIds.delete(m.id);
          for (const [key, v] of sentChatFallback.entries()) if (v === m.id) sentChatFallback.delete(key);
          return;
        }
        if ((!m.id) && m.text && m.ts && sentChatFallback.has(`${m.text}|${m.ts}`)) {
          const matchedId = sentChatFallback.get(`${m.text}|${m.ts}`);
          sentChatFallback.delete(`${m.text}|${m.ts}`);
          sentChatIds.delete(matchedId);
          return;
        }
        if (typeof appendChatMessage === 'function') appendChatMessage(m, { skipScroll: true });
        else if (typeof appendChatMessageFallback === 'function') appendChatMessageFallback(m, { skipScroll: true });
      });
      if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    });

    socket.on('chatMessage', m => {
      if (!m) return;
      if (m.id && sentChatIds.has(m.id)) {
        sentChatIds.delete(m.id);
        for (const [key, v] of sentChatFallback.entries()) if (v === m.id) sentChatFallback.delete(key);
        return;
      }
      if ((!m.id) && m.text && m.ts && sentChatFallback.has(`${m.text}|${m.ts}`)) {
        const matchedId = sentChatFallback.get(`${m.text}|${m.ts}`);
        sentChatFallback.delete(`${m.text}|${m.ts}`);
        sentChatIds.delete(matchedId);
        return;
      }
      if (typeof appendChatMessage === 'function') appendChatMessage(m);
      else if (typeof appendChatMessageFallback === 'function') appendChatMessageFallback(m);
    });

    socket.on('clientsUpdated', clientsArr => {
      if (!isHost) return;
      serverPanel.innerHTML = '<h4 style="margin:6px 0 10px">Connected Clients</h4>';
      clientsArr.forEach(([clientId, info]) => {
        const div = document.createElement('div');
        div.style.display='flex'; div.style.justifyContent='space-between'; div.style.alignItems='center';
        div.style.padding='8px'; div.style.marginBottom='8px'; div.style.borderRadius='8px'; div.style.border='1px solid #eef2f7';
        const name = info && info.name ? info.name : clientId;
        const left = document.createElement('div');
        left.innerHTML = `<div style="font-weight:700">${escapeHtml(name)}</div><div style="font-size:12px;color:#6b7280">${clientId}</div>`;
        const btn = document.createElement('button');
        btn.textContent = 'Show'; btn.className='btn';
        btn.onclick = () => { showClientData(clientId); };
        div.appendChild(left); div.appendChild(btn);
        serverPanel.appendChild(div);
      });
      const allBtn = document.createElement('button'); allBtn.textContent='All India'; allBtn.className='btn'; allBtn.style.marginTop='8px';
      allBtn.onclick = () => { selectedClientId = null; showAllClients(); };
      serverPanel.appendChild(allBtn);
    });

    // pins: IMPORTANT visibility logic below
    socket.on('pinAdded', d => {
      // d: { id, groupId, lat, lon, clientId, clientName, pinColor, rf }
      const pinId = `${d.clientId}_${d.id}`;

      // VISIBILITY RULE:
      // - Host: receives and displays all pins
      // - Client: only display if it's their own pin
      if (!isHost && socket && socket.id && d.clientId !== socket.id) {
        return;
      }

      // decide color
      const pinColor = d.pinColor || (d.groupId && String(d.groupId).startsWith('radar') ? '#800080' : '#ff4d4f');

      addPin(pinId, d.lat, d.lon, d.clientName, d.clientId, pinColor, !!d.rf, d.groupId || null, null);

      const overlaysListEl = overlaysContainer.querySelector('#overlay-pins');
      if (overlaysListEl) renderOverlayEntry(pinId, d.lat, d.lon, d.rf ? 'RF' : (d.groupId && String(d.groupId).startsWith('radar') ? 'Radar' : 'Pin'));
    });

    socket.on('pinRemoved', d => {
      const pinId = `${d.clientId}_${d.id}`;
      removePin(pinId);
    });
    socket.on('clientCleared', d => {
      if (!d || !d.clientId) return;
      clearClientData(d.clientId);
    });
    socket.on('allCleared', () => clearAll());
    socket.on('updateRadius', d => {
      const pinId = `${d.clientId}_${d.id}`;
      applyRemoteRadius(pinId, d.radius, d.color);
    });
    socket.on('updateElevation', d => {
      const pinId = `${d.clientId}_${d.id}`;
      applyRemoteElevation(pinId, d.elevation);
    });

    // ---------- IMPORTANT: host receives updateBearing and applies it ----------
    socket.on('updateBearing', d => {
      // expecting { clientId, id, bearing } or { ownerClientId, id, bearing }
      try {
        if (!d || typeof d.id === 'undefined') return;
        const clientId = d.clientId || d.ownerClientId || d.client;
        if (!clientId) return;
        const pinId = `${clientId}_${d.id}`;
        applyRemoteBearing(pinId, d.bearing);
      } catch (e) { console.warn('updateBearing handler failed', e); }
    });

    // userDotPlaced: host retains userDots; client receives ack to place local userMarker
    socket.on('userDotPlaced', d => {
      if (isHost) {
        if (userDots[d.clientId]) { try { map.removeLayer(userDots[d.clientId]); } catch(e){} delete userDots[d.clientId]; }
        const dot = L.circleMarker([d.lat, d.lon], { radius:8, color:'#fff', weight:3, fillColor:d.userDotColor||'#1e88e5', fillOpacity:1 }).addTo(map);
        dot.clientId = d.clientId;
        dot.bindTooltip(`${escapeHtml(d.clientName||'User')}<br/>Lat: ${Number(d.lat).toFixed(6)}<br/>Lon: ${Number(d.lon).toFixed(6)}`, { direction:'top' });
        dot.on('mouseover', ()=> { try { dot.openTooltip(); } catch(e){} });
        dot.on('mouseout', ()=> { try { dot.closeTooltip(); } catch(e){} });
        userDots[d.clientId] = dot;
        if (selectedClientId && selectedClientId !== d.clientId) dot.setStyle({ opacity:0, fillOpacity:0 });
        updateLines();
      }
    });
    socket.on('userDotPlacedAck', d => {
      if (!isHost) placeUserDot(L.latLng(d.lat, d.lon), false, d.clientName, d.userDotColor);
    });

    socket.on('subIdAssigned', d => {
      if (!d || !d.clientId || !d.id || !d.subId) return;
      const pinId = `${d.clientId}_${d.id}`;
      const p = pins[pinId];
      if (p) {
        p.subId = d.subId;
        const currentZoom = (map && typeof map.getZoom === 'function') ? map.getZoom() : 5;
        const fs = fontSizeForZoom(currentZoom);
        if (p.marker && p.marker.setIcon) {
          try { p.marker.setIcon(buildLabeledDivIcon(d.subId, p.pinColor || '#ff4d4f', fs)); } catch(e) {}
        }
        renderSidebarEntry(pinId);
        try { renderOverlayEntry(pinId, p.lat, p.lon, p.rf ? 'RF' : 'Pin'); } catch(e) {}
      }
    });



    // shapes
    socket.on('shapesUpdated', sArr => { sArr.forEach(s => addShapeLocal(s, false)); });
    socket.on('shapeAdded', s => addShapeLocal(s, false));
    socket.on('shapeUpdated', s => addShapeLocal(s, true));
    socket.on('shapeRemoved', id => removeShapeLocal(id, false));
    socket.on('clientDisconnected', clientId => {
      clearClientData(clientId);
      if (selectedClientId === clientId) { selectedClientId = null; showAllClients(); }
    });
    socket.on('connect_error', e => {
      alert('Connection failed: ' + (e && e.message));
      container.style.display='none'; modal.style.display='flex';
    });
  }

  // --- Shapes logic (unchanged except added contextmenu color UI for boxes) ---
  function createHostShapeButtons() {
    if (document.getElementById('host-shape-controls')) return;
    const wrap = document.createElement('div');
    wrap.id = 'host-shape-controls';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'row';
    wrap.style.gap = '8px';
    wrap.style.alignItems = 'center';
    const makeBtn = (label, type) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = 'btn';
      b.style.padding = '8px 10px';
      b.style.borderRadius = '10px';
      b.onclick = () => {
        currentShapePlacement = currentShapePlacement === type ? null : type;
        Array.from(wrap.querySelectorAll('button')).forEach(x => x.style.background = '#fff');
        if (currentShapePlacement === type) b.style.background = '#f1f5f9';
      };
      return b;
    };
    const boxBtn = makeBtn('▭ Box', 'box');
    const coneBtn = makeBtn('▲ Cone', 'cone');
    const circleBtn = makeBtn('○ Circle', 'circle');
    wrap.appendChild(boxBtn);
    wrap.appendChild(coneBtn);
    wrap.appendChild(circleBtn);
    floating.insertBefore(wrap, floating.firstChild);
  }

  function openShapePopupAt(type, latlng) {
    const popup = L.popup({ closeOnClick: false, autoClose: false })
      .setLatLng(latlng);
    let html = `<div style="min-width:200px">`;
    html += `<div style="font-weight:700;margin-bottom:6px">Add ${type}</div>`;
    html += `<div style="margin-bottom:6px"><label>Radius (m):</label><br><input id="shape-radius" type="number" value="500" style="width:100%"/></div>`;
    if (type === 'cone') {
      html += `<div style="margin-bottom:6px"><label>Bearing ° (from north):</label><br><input id="shape-bearing" type="number" value="0" style="width:100%"/></div>`;
      html += `<div style="margin-bottom:6px"><label>Spread °:</label><br><input id="shape-spread" type="number" value="60" style="width:100%"/></div>`;
    }
    html += `<div style="display:flex;gap:8px;justify-content:flex-end"><button id="shape-cancel" class="btn">Cancel</button><button id="shape-ok" class="btn" style="background:#1e88e5;color:#fff">Add</button></div>`;
    html += `</div>`;
    popup.setContent(html).openOn(map);

    document.getElementById('shape-cancel').onclick = () => {
      map.closePopup(popup);
      currentShapePlacement = null;
      const wrap = document.getElementById('host-shape-controls');
      if (wrap) Array.from(wrap.querySelectorAll('button')).forEach(x => x.style.background = '#fff');
    };

    document.getElementById('shape-ok').onclick = () => {
      const r = parseFloat(document.getElementById('shape-radius').value) || 0;
      let bearing = 0, spread = 60;
      if (type === 'cone') {
        bearing = parseFloat(document.getElementById('shape-bearing').value) || 0;
        spread = parseFloat(document.getElementById('shape-spread').value) || 60;
      }
      const id = `shape_${Date.now()}`;
      // default color logic: for box -> yellow as requested; others random pastel
      const color = (type === 'box') ? '#FFEB3B' : randomPastel();
      const shapeObj = {
        id, type,
        lat: latlng.lat, lon: latlng.lng,
        radius: r,
        bearing: bearing,
        spread: spread,
        color,
        createdAt: Date.now()
      };
      addShapeLocal(shapeObj, false);
      socket && socket.emit('newShape', shapeObj);
      map.closePopup(popup);
      currentShapePlacement = null;
      const wrap = document.getElementById('host-shape-controls');
      if (wrap) Array.from(wrap.querySelectorAll('button')).forEach(x => x.style.background = '#fff');
    };
  }

  const shapes = {};

  // helper: open color chooser popup for box markers (host only)
  function openBoxColorPopup(shapeMeta, marker, overlay) {
    if (!shapeMeta || !marker) return;
    const latlng = marker.getLatLng ? marker.getLatLng() : [shapeMeta.lat, shapeMeta.lon];
    const popup = L.popup({ closeOnClick: true, autoClose: true }).setLatLng(latlng);
    const html = `<div style="min-width:140px;padding:6px">
      <div style="font-weight:700;margin-bottom:6px">Change color</div>
      <div style="display:flex;gap:8px;justify-content:center">
        <button id="color-red" class="btn" style="background:#ef4444;color:#fff">Red</button>
        <button id="color-green" class="btn" style="background:#10b981;color:#fff">Green</button>
      </div>
    </div>`;
    popup.setContent(html).openOn(map);

    // event bindings
    setTimeout(()=> {
      const red = document.getElementById('color-red');
      const green = document.getElementById('color-green');
      if (red) red.onclick = () => {
        try {
          shapeMeta.color = '#ef4444';
          if (overlay && overlay.setStyle) overlay.setStyle({ color: shapeMeta.color, fillColor: shapeMeta.color });
          if (marker && marker.setIcon) marker.setIcon(buildShapeDivIcon(shapeMeta.type, shapeMeta.color));
          socket && socket.emit('updateShape', Object.assign({}, shapeMeta));
          map.closePopup(popup);
        } catch(e){ console.warn(e); map.closePopup(popup); }
      };
      if (green) green.onclick = () => {
        try {
          shapeMeta.color = '#10b981';
          if (overlay && overlay.setStyle) overlay.setStyle({ color: shapeMeta.color, fillColor: shapeMeta.color });
          if (marker && marker.setIcon) marker.setIcon(buildShapeDivIcon(shapeMeta.type, shapeMeta.color));
          socket && socket.emit('updateShape', Object.assign({}, shapeMeta));
          map.closePopup(popup);
        } catch(e){ console.warn(e); map.closePopup(popup); }
      };
    }, 20);
  }

  function addShapeLocal(shape, isUpdate) {
    if (!shape || !shape.id) return;
    if (shapes[shape.id] && !isUpdate) return;
    if (shapes[shape.id]) removeShapeLocal(shape.id, true);

    // create marker
    const marker = L.marker([shape.lat, shape.lon], { icon: buildShapeDivIcon(shape.type, shape.color) }).addTo(map);
    let overlay = null;
    if (shape.type === 'box' || shape.type === 'circle') {
      overlay = L.circle([shape.lat, shape.lon], { radius: shape.radius || 0, color: shape.color, fillColor: shape.color, fillOpacity: 0.22, weight:2 }).addTo(map);
    } else if (shape.type === 'cone') {
      const polygonPoints = buildConePolygonPoints(shape.lat, shape.lon, shape.radius || 0, shape.bearing || 0, shape.spread || 60, 6);
      const arc = polygonPoints.slice(1);
      overlay = L.polygon([ [shape.lat, shape.lon], ...arc ], { color: shape.color, fillColor: shape.color, fillOpacity: 0.22, weight:2 }).addTo(map);
    }

    // host edit behavior remains
    if (isHost) {
      marker.on('click', () => openHostEditShapePopup(shape));
      overlay && overlay.on('click', () => openHostEditShapePopup(shape));
      // specifically for box: support right-click color chooser
      if (shape.type === 'box') {
        marker.on('contextmenu', (ev) => {
          // open color chooser popup at marker
          openBoxColorPopup(shape, marker, overlay);
        });
      }
    }

    shapes[shape.id] = { marker, overlay, meta: shape };
    renderShapesList();
  }
  function removeShapeLocal(shapeId, silent) {
    const s = shapes[shapeId];
    if (!s) return;
    if (s.marker) try { map.removeLayer(s.marker); } catch(e){}
    if (s.overlay) try { map.removeLayer(s.overlay); } catch(e){}
    delete shapes[shapeId];
    renderShapesList();
  }


  function openHostEditShapePopup(shapeMeta) {
    if (!isHost) return;
    const latlng = [shapeMeta.lat, shapeMeta.lon];
    const popup = L.popup({ closeOnClick:false, autoClose:false }).setLatLng(latlng);
    let html = `<div style="min-width:230px"><div style="font-weight:700;margin-bottom:6px">Edit ${shapeMeta.type}</div>`;
    html += `<div style="margin-bottom:6px"><label>Radius (m):</label><br><input id="edit-radius" type="number" value="${shapeMeta.radius||0}" style="width:100%"/></div>`;
    if (shapeMeta.type === 'cone') {
      html += `<div style="margin-bottom:6px"><label>Bearing °:</label><br><input id="edit-bearing" type="number" value="${shapeMeta.bearing||0}" style="width:100%"/></div>`;
      html += `<div style="margin-bottom:6px"><label>Spread °:</label><br><input id="edit-spread" type="number" value="${shapeMeta.spread||60}" style="width:100%"/></div>`;
    }
    html += `<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><button id="shape-del" class="btn" style="background:#ef4444;color:#fff">Delete</button><button id="shape-save" class="btn" style="background:#1e88e5;color:#fff">Save</button></div></div>`;
    popup.setContent(html).openOn(map);
    document.getElementById('shape-del').onclick = () => {
      map.closePopup(popup);
      socket && socket.emit('removeShape', shapeMeta.id);
      removeShapeLocal(shapeMeta.id, false);
    };
    document.getElementById('shape-save').onclick = () => {
      const newR = parseFloat(document.getElementById('edit-radius').value) || 0;
      let newB = shapeMeta.bearing || 0, newS = shapeMeta.spread || 60;
      if (shapeMeta.type === 'cone') {
        newB = parseFloat(document.getElementById('edit-bearing').value) || 0;
        newS = parseFloat(document.getElementById('edit-spread').value) || 60;
      }
      const updated = Object.assign({}, shapeMeta, { radius: newR, bearing: newB, spread: newS });
      addShapeLocal(updated, true);
      socket && socket.emit('updateShape', updated);
      map.closePopup(popup);
    };
  }
  function renderShapesList() {
    const shapesRoot = overlaysContainer.querySelector('#overlay-shapes');
    if (!shapesRoot) return;
    Array.from(shapesRoot.querySelectorAll('.shape-entry')).forEach(el => el.remove());

    const shapeEntries = Object.values(shapes).map(sobj => sobj.meta).sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
    shapeEntries.forEach(meta => {
      const div = document.createElement('div');
      div.className = 'shape-entry';
      div.style.display='flex'; div.style.justifyContent='space-between'; div.style.alignItems='center';
      div.style.padding='8px'; div.style.marginBottom='8px'; div.style.border='1px solid #eef2f7'; div.style.borderRadius='8px';
      div.innerHTML = `<div><div style="font-weight:700">${meta.type.toUpperCase()}</div><div style="font-size:12px;color:#6b7280">Lat:${meta.lat.toFixed(4)}, Lon:${meta.lon.toFixed(4)}</div></div>`;
      const btns = document.createElement('div');
      const showBtn = document.createElement('button'); showBtn.textContent='Show'; showBtn.className='btn';
      showBtn.onclick = () => { map.setView([meta.lat, meta.lon], Math.max(map.getZoom(), 10)); showClientData(meta.clientId || null); };
      const editBtn = document.createElement('button'); editBtn.textContent='Edit'; editBtn.className='btn';
      editBtn.onclick = () => openHostEditShapePopup(meta);
      btns.appendChild(showBtn); btns.appendChild(editBtn);
      div.appendChild(btns);
      shapesRoot.appendChild(div);
    });
  }

  // --- Pins ---
  function addPin(id, lat, lon, clientName, clientId, pinColor, isRF=false, groupId=null, subId=null) {
    if (pins[id]) return; // prevent duplicates

    const fs = map ? fontSizeForZoom(map.getZoom()) : 12;
    const labelText = subId || (groupId ? getGroupDisplayBase(groupId) + '.?' : '');
    const icon = buildLabeledDivIcon(labelText, pinColor || '#ff4d4f', fs);
    const marker = L.marker([lat, lon], { icon }).addTo(map);
    let radiusCircle = null;

    pins[id] = { marker, radiusCircle, elevation:0, bearing:0, clientId, clientName, pinColor, rf: !!isRF, groupId: groupId || null, lat, lon, archived:false, subId: subId || null };

    const latText = Number(lat).toFixed(6);
    const lonText = Number(lon).toFixed(6);
    let tooltipHtml = `Lat: ${latText}<br/>Lon: ${lonText}`;
    if (pins[id].groupId) {
      const visibleIdText = escapeHtml(String(getGroupDisplayBase(pins[id].groupId)));
      tooltipHtml = `ID: <strong>${visibleIdText}</strong><br/>` + tooltipHtml;
    }

    marker.bindTooltip(tooltipHtml, { direction: 'top', offset: [0, -10], permanent: false, sticky: true });
    marker.on('mouseover', () => { try { marker.openTooltip(); } catch(e){} });
    marker.on('mouseout', () => { try { marker.closeTooltip(); } catch(e){} });
    marker.on('click', ()=> showRadiusPopup(id));

    renderSidebarEntry(id);

    if (pins[id].groupId) addToGroup(pins[id].groupId, id);

    if (selectedClientId && clientId !== selectedClientId) marker.setOpacity(0);
    updateLines();

    if (isHost && pins[id].groupId && !pins[id].subId) {
      const g = pins[id].groupId;
      if (typeof groupCounters[g] === 'undefined') groupCounters[g] = 0;
      groupCounters[g] = (groupCounters[g] || 0) + 1;
      const assigned = `${getGroupDisplayBase(g)}.${groupCounters[g]}`;
      pins[id].subId = assigned;
      try { marker.setIcon(buildLabeledDivIcon(assigned, pinColor || '#ff4d4f', fs)); } catch(e) { console.warn('setIcon failed', e); }
      renderSidebarEntry(id);
      renderOverlayEntry(id, lat, lon, pins[id].rf ? 'RF' : 'Pin');

      try {
        const parts = id.split('_');
        const orig = parts.slice(1).join('_');
        socket && socket.emit('subIdAssigned', { clientId, id: orig, subId: assigned });
      } catch(e) { console.warn('emit subIdAssigned failed', e); }
    }
  }

  function showRadiusPopup(id) {
    const p = pins[id];
    if (!p) return;
    p.marker.closePopup(); p.marker.unbindPopup();
    const ui = L.DomUtil.create('div','pin-popup');
    ui.innerHTML = `<input type="number" placeholder="Distance in km" style="width:120px;margin-bottom:6px"/><br/><button>OK</button>`;
    const inp = ui.querySelector('input'), btn = ui.querySelector('button');
    btn.addEventListener('click', ()=> {
      const km = parseFloat(inp.value); if (isNaN(km) || km<=0) return alert('Enter valid kilometers');
      const m = km*1000; if (p.radiusCircle) map.removeLayer(p.radiusCircle);
      // choose color depending on group / RF / pin
      let circleColor = p.pinColor || '#ff4d4f';
      if (p.groupId && String(p.groupId).startsWith('radar')) circleColor = '#800080'; // purple for radar
      else if (p.rf) circleColor = '#20c933'; // green for RF
      else circleColor = p.pinColor || '#ff4d4f'; // red for normal pins

      p.radiusCircle = L.circle(p.marker.getLatLng(), { radius:m, color:circleColor, fillColor:circleColor, fillOpacity:0.25 }).addTo(map);
      const parts = id.split('_'); const orig = parts.slice(1).join('_'); const owner = parts[0];
      if (isHost) {
        socket && socket.emit('updateRadius', { id: orig, radius: m, color: circleColor, ownerClientId: owner });
      } else {
        socket && socket.emit('updateRadius', { id: orig, radius: m, color: circleColor });
      }
      renderSidebarEntry(id); p.marker.closePopup(); updateLines();
    });
    p.marker.bindPopup(ui).openPopup();
  }

  function applyRemoteRadius(id, radius, color) {
    const p = pins[id]; if (!p) return;
    if (p.radiusCircle) map.removeLayer(p.radiusCircle);
    p.radiusCircle = L.circle(p.marker.getLatLng(), { radius, color: color || p.pinColor || '#ff4d4f', fillColor: color || p.pinColor || '#ff4d4f', fillOpacity:0.25 }).addTo(map);
    renderSidebarEntry(id); updateLines();
  }

  function applyRemoteElevation(id, elevation) {
    const p = pins[id]; if (!p) return;
    p.elevation = elevation;
    renderSidebarEntry(id);
    const ov = overlaysContainer.querySelector(`#overlay-pins div[data-id="${id}"]`);
    if (ov) {
      const inp = ov.querySelector('.ov-elev');
      if (inp) inp.value = elevation;
    }
  }

  function applyRemoteBearing(id, bearing) {
    const p = pins[id]; if (!p) return;
    p.bearing = bearing;
    renderSidebarEntry(id);
    const ov = overlaysContainer.querySelector(`#overlay-pins div[data-id="${id}"]`);
    if (ov) {
      const inp = ov.querySelector('.ov-bear');
      if (inp) inp.value = bearing;
    }
    updateLines();
  }

  function removePin(id) {
    const p = pins[id]; if (!p) return;
    if (p.groupId) removeFromGroup(p.groupId, id);

    if (p.marker) try { map.removeLayer(p.marker); } catch(e){}
    if (p.radiusCircle) try { map.removeLayer(p.radiusCircle); } catch(e){}
    if (lines[id]) { try { map.removeLayer(lines[id]); } catch(e){} delete lines[id]; }
    delete pins[id];
    const li = sidebar.querySelector(`li[data-id="${id}"]`); if (li) li.remove();
    const el = overlaysContainer.querySelector(`#overlay-pins div[data-id="${id}"]`);
    if (el) el.remove();
    updateLines();
  }

  // --- Sidebar entry ---
  function renderSidebarEntry(id) {
    const p = pins[id];
    if (!p) return;
    const latlng = p.marker && p.marker.getLatLng ? p.marker.getLatLng() : { lat: p.lat, lng: p.lon };
    let li = sidebar.querySelector(`li[data-id="${id}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.id = id;
      sidebar.appendChild(li);
    }

    const visibleId = p.subId ? escapeHtml(p.subId) : (p.groupId ? escapeHtml(getGroupDisplayBase(p.groupId)) + '.?' : '');
    const rfBadge = p.rf ? `<span style="background:#e6ffed;color:#064e2e;padding:2px 6px;border-radius:6px;font-size:11px;margin-left:8px">RF</span>` : '';
    const archivedBadge = p.archived ? `<span style="background:#f3f4f6;color:#6b7280;padding:2px 6px;border-radius:6px;font-size:11px;margin-left:8px">Archived</span>` : '';

    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="pin-info" style="cursor:pointer">
          <div style="font-weight:700">${visibleId} ${rfBadge} ${archivedBadge}</div>
          ${ p.groupId ? `<div style="font-size:12px;color:#6b7280">Parent: ${escapeHtml(getGroupDisplayBase(p.groupId))}</div>` : '' }
        </div>
        <button class="delete-btn" style="background:#ef4444;color:#fff;border:none;border-radius:6px;padding:4px 8px">&times;</button>
      </div>
      <div style="font-size:13px;color:#374151">Lat:${latlng.lat.toFixed(4)}, Lon:${latlng.lng.toFixed(4)}</div>
      <div style="font-size:13px;color:#374151">Radius: ${(p.radiusCircle? (p.radiusCircle.getRadius()/1000).toFixed(2)+' km' : '0.00 km')}</div>

      <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
        <label>Elevation:</label>
        <input class="elev-inp" type="number" value="${p.elevation}" style="width:80px;padding:4px;border-radius:6px;border:1px solid #e6e9ef" />
      </div>

      <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
        <label>Bearing:</label>
        <input class="bear-inp" type="number" value="${p.bearing}" style="width:80px;padding:4px;border-radius:6px;border:1px solid #e6e9ef" />
      </div>`;

    const infoBlock = li.querySelector('.pin-info');
    if (infoBlock) {
      infoBlock.onclick = (ev) => {
        ev.stopPropagation();
        highlightPin(id);
      };
    }

    const delBtn = li.querySelector('.delete-btn');
    if (delBtn) {
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        const parts = id.split('_');
        const owner = parts[0];
        const orig = parts.slice(1).join('_');
        if (owner !== 'overlay' && owner !== 'local') {
          socket && socket.emit('removePin', { id: orig, ownerClientId: owner });
        }
        removePin(id);
      };
    }

    const elevInp = li.querySelector('.elev-inp');
    if (elevInp) {
      elevInp.onkeydown = e => {
        if (e.key === 'Enter') {
          const val = parseFloat(elevInp.value) || 0;
          p.elevation = val;
          const parts = id.split('_');
          const orig = parts.slice(1).join('_');
          const owner = parts[0];
          if (isHost) {
            if (owner !== 'overlay' && owner !== 'local') socket.emit('updateElevation', { id: orig, elevation: val, ownerClientId: owner });
          } else {
            if (owner !== 'overlay' && owner !== 'local') socket.emit('updateElevation', { id: orig, elevation: val });
          }
          const ov = overlaysContainer.querySelector(`#overlay-pins div[data-id="${id}"]`);
          if (ov) {
            const ovInp = ov.querySelector('.ov-elev');
            if (ovInp) ovInp.value = val;
          }
          renderSidebarEntry(id);
        }
      };
    }

    const bearInp = li.querySelector('.bear-inp');
    if (bearInp) {
      bearInp.onkeydown = e => {
        if (e.key === 'Enter') {
          const val = parseFloat(bearInp.value) || 0;
          p.bearing = val;
          const parts = id.split('_');
          const orig = parts.slice(1).join('_');
          const owner = parts[0];
          if (isHost) {
            if (owner !== 'overlay' && owner !== 'local') socket.emit('updateBearing', { id: orig, bearing: val, ownerClientId: owner, clientId: owner });
          } else {
            if (owner !== 'overlay' && owner !== 'local') socket.emit('updateBearing', { id: orig, bearing: val, clientId: socket.id });
          }
          const ov = overlaysContainer.querySelector(`#overlay-pins div[data-id="${id}"]`);
          if (ov) {
            const ovInp = ov.querySelector('.ov-bear');
            if (ovInp) ovInp.value = val;
          }
          renderSidebarEntry(id);
        }
      };
    }
  }

  // highlight pin (visual)
  function highlightPin(id) {
    const p = pins[id];
    if (!p) return;
    try {
      const latlng = (p.marker && p.marker.getLatLng) ? p.marker.getLatLng() : L.latLng(p.lat, p.lon);
      // cap highlight zoom to 10 so we do not programmatically zoom into levels where tiles are scaled
      const targetZoom = Math.max(map.getZoom(), 10);
      map.setView(latlng, targetZoom, { animate: true });

      const popupContent = `Lat: ${latlng.lat.toFixed(4)}<br/>Lon: ${latlng.lng.toFixed(4)}`;
      if (p.marker) {
        p.marker.bindPopup(popupContent).openPopup();

        const el = p.marker.getElement && p.marker.getElement();
        if (el) {
          el.classList.add('pin-highlight');
          setTimeout(() => {
            try { el.classList.remove('pin-highlight'); } catch(e){ }
          }, 900);
        }
      } else {
        const tmp = L.popup({ closeOnClick: true }).setLatLng(latlng).setContent(popupContent).openOn(map);
        setTimeout(()=> { try { map.closePopup(tmp); } catch(e){} }, 1600);
      }
    } catch (err) {
      console.warn('highlightPin error', err);
    }
  }

  // --- Lines rendering for user-dot -> pins ---
 function updateLines() {
  // remove existing visible lines + hit lines
  for (const k in lines) { try { map.removeLayer(lines[k]); } catch(e){} delete lines[k]; }
  for (const k in hitLines) { try { map.removeLayer(hitLines[k]); } catch(e){} delete hitLines[k]; }

  const LINE_COLOR = '#ff4d4f';
  const VISIBLE_WEIGHT = 2;   // what the user sees
  const HIT_WEIGHT = 14;      // how wide the hover target is (increase to be more tolerant)

  // Helper to create a visible polyline + invisible wide 'hit' line bound to hover
  function createHoverableLine(latlngs, labelText) {
    // visible slim polyline
    const vis = L.polyline(latlngs, { color: LINE_COLOR, weight: VISIBLE_WEIGHT, opacity: 0.9 }).addTo(map);
    // invisible but interactive wide polyline (captures hover)
    const hit = L.polyline(latlngs, { color: LINE_COLOR, weight: HIT_WEIGHT, opacity: 0.0, interactive: true }).addTo(map);

    // ensure visible line sits above the hit-target visually
    try { vis.bringToFront(); } catch(e){}

    // Attach tooltip to the visible line (so the tooltip appears centered on the visible line)
    vis.bindTooltip(labelText, { permanent: false, direction: 'center', className: 'line-tooltip' });

    // When user moves pointer near the line (i.e. over the hit polyline) show/hide the tooltip on the visible polyline
    let closeTimer = null;
    hit.on('mouseover', function() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      try { vis.openTooltip(); } catch(e) {}
    });
    // small delay on mouseout helps prevent flicker if pointer moves briefly
    hit.on('mouseout', function() {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => { try { vis.closeTooltip(); } catch(e){} }, 70);
    });

    return { visible: vis, hit: hit };
  }

  if (isHost) {
    Object.entries(userDots).forEach(([clientId, dot]) => {
      if (!dot || !dot.getLatLng) return;
      if (selectedClientId && selectedClientId !== clientId) return;
      const dotLL = dot.getLatLng();
      Object.entries(pins).forEach(([pinId, pin]) => {
        if (pin.clientId === clientId && pin.marker) {
          const pll = pin.marker.getLatLng();
          const latlngs = [dotLL, pll];
          const dist = (dotLL.distanceTo(pll)/1000).toFixed(2) + ' km';
          // show bearing if available, else compute
          let bearingVal = (typeof pin.bearing === 'number' && !isNaN(pin.bearing)) ? pin.bearing : null;
          if (bearingVal === null) bearingVal = bearingFromLatLon(dotLL.lat, dotLL.lng, pll.lat, pll.lng);
          const label = `${dist} • ${formatBearing(bearingVal)}°`;

          const { visible, hit } = createHoverableLine(latlngs, label);
          // store visible as before for compatibility; also track hit for cleanup
          lines[pinId] = visible;
          hitLines[pinId] = hit;
        }
      });
    });
  } else {
    if (!userMarker || !userMarker.getLatLng) return;
    const userLL = userMarker.getLatLng();
    Object.entries(pins).forEach(([pinId, pin]) => {
      if (socket && pinId.startsWith(socket.id) && pin.marker) {
        const pll = pin.marker.getLatLng();
        const latlngs = [userLL, pll];
        const dist = (userLL.distanceTo(pll)/1000).toFixed(2) + ' km';
        // prefer stored bearing; if not present compute
        let bearingVal = (typeof pin.bearing === 'number' && !isNaN(pin.bearing)) ? pin.bearing : null;
        if (bearingVal === null) {
          bearingVal = bearingFromLatLon(userLL.lat, userLL.lng, pll.lat, pll.lng);
          try { pin.bearing = bearingVal; } catch(e){}
        }
        const label = `${dist} • ${formatBearing(bearingVal)}°`;

        const { visible, hit } = createHoverableLine(latlngs, label);
        lines[pinId] = visible;
        hitLines[pinId] = hit;
      }
    });
  }
}

  // --- User dot ---
  function placeUserDot(latlng, renderOnly, clientName, userDotColor=null) {
    if (!isHost && userMarker) { try { map.removeLayer(userMarker); } catch(e){} userMarker = null; if (userSidebar) { userSidebar.remove(); userSidebar = null; } }
    const dotColor = userDotColor || '#1e88e5';
    const dot = L.circleMarker(latlng, { radius:8, color:'#fff', weight:3, fillColor:dotColor, fillOpacity:1 }).addTo(map);
    if (isHost) dot.bindTooltip(clientName, { direction:'top' });
    const tooltipHtml = `${escapeHtml(clientName || 'You')}<br/>Lat: ${Number(latlng.lat).toFixed(6)}<br/>Lon: ${Number(latlng.lng).toFixed(6)}`;
    dot.bindTooltip(tooltipHtml, { direction:'top' });
    dot.on('mouseover', ()=> { try { dot.openTooltip(); } catch(e){} });
    dot.on('mouseout', ()=> { try { dot.closeTooltip(); } catch(e){} });

    if (!isHost) userMarker = dot;
    dot.on('click', ()=> { dot.bindPopup(`Lat:${latlng.lat.toFixed(4)}<br>Lon:${latlng.lng.toFixed(4)}`).openPopup(); setTimeout(()=>dot.closePopup(),2000); });
    if (!isHost) {
      userSidebar = document.createElement('li');
      userSidebar.classList.add('user-dot');
      userSidebar.innerHTML = `<div style="font-weight:700">You</div><div style="font-size:13px">Lat:${latlng.lat.toFixed(4)}, Lon:${latlng.lng.toFixed(4)}</div>`;
      sidebar.insertBefore(userSidebar, sidebar.firstChild);
    }
    if (renderOnly) {
      // emit userDotPlaced as before
      socket.emit('userDotPlaced', { lat: latlng.lat, lon: latlng.lng });
      isUserMode = false; userBtn.classList.remove('active'); userBtn.textContent='User Mode OFF';

      // ---------- NEW: compute bearings for all client's own pins and emit updateBearing ----------
      try {
        if (!isHost && socket && socket.connected && socket.id) {
          Object.entries(pins).forEach(([pinId, pin]) => {
            if (!pin) return;
            if (pinId.startsWith(socket.id)) {
              // compute geodesic bearing from user -> pin
              const deg = bearingFromLatLon(latlng.lat, latlng.lng, pin.lat, pin.lon);
              pin.bearing = deg;
              // emit updateBearing for this pin (orig id)
              const parts = pinId.split('_');
              const orig = parts.slice(1).join('_');
              if (orig) {
                // include clientId so host can map it back to the right client
                socket.emit('updateBearing', { id: orig, bearing: deg, clientId: socket.id });
              }

              // update overlay + sidebar UI
              try { renderOverlayEntry(pinId, pin.lat, pin.lon, pin.rf ? 'RF' : 'Pin'); } catch(e){}
              try { renderSidebarEntry(pinId); } catch(e){}
            }
          });
        } else {
          // offline: update overlays locally
          Object.entries(pins).forEach(([pinId, pin]) => {
            if (!pin) return;
            if (pinId.startsWith('local_') || (userMarker && pinId.startsWith((socket && socket.id)||'local'))) {
              const deg = bearingFromLatLon(latlng.lat, latlng.lng, pin.lat, pin.lon);
              pin.bearing = deg;
              try { renderOverlayEntry(pinId, pin.lat, pin.lon, pin.rf ? 'RF' : 'Pin'); } catch(e){}
              try { renderSidebarEntry(pinId); } catch(e){}
            }
          });
        }
      } catch(e) { console.warn('user-dot bearing compute failed', e); }
      // ---------------------------------------------------------------------------------------
    }
    updateLines();
  }

  // --- Clearing helpers ---
  function clearClientData(clientId) {
    Object.entries(pins).forEach(([key,p]) => {
      if (p.clientId === clientId) {
        if (p.groupId) removeFromGroup(p.groupId, key);
        try { if (p.marker) map.removeLayer(p.marker); } catch(e){}
        try { if (p.radiusCircle) map.removeLayer(p.radiusCircle); } catch(e){}
        if (lines[key]) { try { map.removeLayer(lines[key]); } catch(e){} delete lines[key]; }
        const li = sidebar.querySelector(`li[data-id="${key}"]`); if (li) li.remove();
        const ov = overlaysContainer.querySelector(`#overlay-pins div[data-id="${key}"]`); if (ov) ov.remove();
        delete pins[key];
      }
    });
    if (userDots[clientId]) { try { map.removeLayer(userDots[clientId]); } catch(e){} delete userDots[clientId]; }
    if (!isHost && socket && socket.id === clientId) {
      if (userMarker) { try { map.removeLayer(userMarker); } catch(e){} userMarker = null; }
      if (userSidebar) { userSidebar.remove(); userSidebar = null; }
    }
    updateLines();
  }
  function clearAll() {
    Object.values(pins).forEach(p => { try { if (p.marker) map.removeLayer(p.marker); } catch(e){} try { if (p.radiusCircle) map.removeLayer(p.radiusCircle); } catch(e){} });
    Object.keys(pins).forEach(k => delete pins[k]);
    Object.values(userDots).forEach(d => { try { if (d) map.removeLayer(d); } catch(e){} });
    Object.keys(userDots).forEach(k => delete userDots[k]);
    Object.values(lines).forEach(l => { try { if (l) map.removeLayer(l); } catch(e){} });
    Object.keys(lines).forEach(k => delete lines[k]);
    Object.keys(shapes).forEach(sid => removeShapeLocal(sid, true));
    if (userMarker) { try { map.removeLayer(userMarker); } catch(e){} userMarker=null; }
    sidebar.innerHTML = '';
    if (isHost) { sidebar.appendChild(overlaysContainer); renderShapesList(); }
    selectedClientId = null;
    Object.keys(groupLines).forEach(g => { try { map.removeLayer(groupLines[g]); } catch(e){} });
    Object.keys(groupLines).forEach(k => delete groupLines[k]);
    Object.keys(groupPins).forEach(k => delete groupPins[k]);
    updateLines();
  }
  function showClientData(clientId) {
    selectedClientId = clientId;
    Object.entries(pins).forEach(([key,p]) => {
      if (p.clientId === clientId) {
        if (p.marker) p.marker.setOpacity(1);
        if (p.radiusCircle) p.radiusCircle.setStyle({ opacity:1, fillOpacity:0.25 });
      } else {
        if (p.marker) p.marker.setOpacity(0);
        if (p.radiusCircle) p.radiusCircle.setStyle({ opacity:0, fillOpacity:0 });
      }
    });
    Object.entries(userDots).forEach(([cid, dot]) => {
      if (!dot) return;
      if (cid === clientId) dot.setStyle({ opacity:1, fillOpacity:1 });
      else dot.setStyle({ opacity:0, fillOpacity:0 });
    });
    for (const k in lines) { try { map.removeLayer(lines[k]); } catch(e){} delete lines[k]; }
    Object.entries(groupLines).forEach(([gId, poly]) => {
      if (!isHost) {
        const accessibleCount = (groupPins[gId] || []).filter(id => id.startsWith(socket.id)).length;
        if (accessibleCount < 2) {
          try { map.removeLayer(poly); } catch(e){} delete groupLines[gId];
        }
      }
    });
    updateLines();
  }

  function showAllClients() {
    selectedClientId = null;
    Object.entries(pins).forEach(([k,p]) => {
      if (p.marker) p.marker.setOpacity(1);
      if (p.radiusCircle) p.radiusCircle.setStyle({ opacity:1, fillOpacity:0.25 });
    });
    Object.entries(userDots).forEach(([cid,d]) => {
      if (d) d.setStyle({ opacity:1, fillOpacity:1 });
    });
    for (const k in lines) { try { map.removeLayer(lines[k]); } catch(e){} delete lines[k]; }
    updateLines();
  }

  // --- misc helpers ---
  function showStatus(msg) { statusBar.textContent = msg; statusBar.classList.add('show'); setTimeout(()=>statusBar.classList.remove('show'),2200); }

  // Load persisted pins (if you keep this) - treat as local overlay pins and also attach them to groups if they have group stored
  function loadSavedPins() {
    const saved = JSON.parse(localStorage.getItem('pins')||'{}');
    for (const id in saved) {
      const s = saved[id];
      addPin(id, s.lat, s.lon, s.clientName||'Saved', s.clientId||'local', s.pinColor||'#ff4d4f', !!s.rf, s.groupId || null, s.subId || null);
      if (s.radius) applyRemoteRadius(id, s.radius);
      if (s.elevation) applyRemoteElevation(id, s.elevation);
      if (s.bearing) applyRemoteBearing(id, s.bearing);
      const pinsContainer = overlaysContainer.querySelector('#overlay-pins');
      if (pinsContainer) renderOverlayEntry(id, s.lat, s.lon, 'Saved');
    }
  }
  loadSavedPins();

}); // DOMContentLoaded end
