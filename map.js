// map.js (updated: chat send fix; label sits just above pin tip, black color, adjusts with zoom)

// --- Shared ID state (user-visible group IDs) ---
let currentPinGroupId = "pin-101";   // all normal pins use this until regenerated
let currentRfGroupId  = "rf-201";    // all RF pins use this until regenerated
const usedGroupIds = new Set([currentPinGroupId, currentRfGroupId]); // prevent duplicates
const groupCounters = { [currentPinGroupId]: 0, [currentRfGroupId]: 0 };

// --- Group bookkeeping: pins grouped by groupId, and polylines per group ---
const groupPins = {};   // groupId -> array of internal pin ids (in insertion order)
const groupLines = {};  // groupId -> L.Polyline (dotted)

// --- Helpers: marker SVG, shape icons, geodesic math ---
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
  // Label positioned directly above the pin: bottom: calc(100% + 4px)
  const svgUrl = createSvgIconDataUrl(pinColor || '#ff4d4f', [30,45]);
  const labelHtml = subId ? escapeHtml(String(subId)) : '';
  const html = `
    <div style="position:relative; width:30px; height:60px; pointer-events:auto; display:inline-block;">
      <div style="position:absolute; left:50%; bottom:calc(100% + 4px); transform:translateX(-50%); font-weight:700; font-size:${fontSize}px; color:#000; white-space:nowrap; pointer-events:none;">
        ${labelHtml}
      </div>
      <img src="${svgUrl}" style="position:absolute; left:50%; bottom:0; transform:translateX(-50%); width:30px; height:45px; display:block;" />
    </div>`;
  // icon anchored at bottom center so pin tip corresponds to lat/lng
  return L.divIcon({ html, className: 'labeled-marker-icon', iconSize: [30, 60], iconAnchor: [15, 60], popupAnchor: [0, -60] });
}
function buildMarkerIcon(pinColor) {
  const ICON_SIZE = [30, 45];
  const ICON_BOTTOM_PADDING = -24;
  const svgUrl = createSvgIconDataUrl(pinColor);
  const anchorY = ICON_SIZE[1] + ICON_BOTTOM_PADDING;
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

// --- DOM refs & state ---
document.addEventListener('DOMContentLoaded', async () => {
  // UI refs (same as your original)
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

    // FIXED: call the correct append handler
    if (typeof appendChatMessage === 'function') {
      appendChatMessage(Object.assign({}, msg, { clientName: (clientNameInput && clientNameInput.value) || 'You', fromHost: !!isHost }));
    } else if (typeof appendChatMessageFallback === 'function') {
      appendChatMessageFallback(Object.assign({}, msg, { clientName: (clientNameInput && clientNameInput.value) || 'You', fromHost: !!isHost }));
    }

    chatInput.value = '';
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Chat UI wiring (unchanged)
  if (chatBtn) {
    chatBtn.addEventListener('click', () => {
      if (!chatModal) return;
      const wasOpen = chatModal.style.display === 'block';
      if (!wasOpen) {
        chatModal.style.display = 'block';
        chatModal.style.position = 'fixed';
        chatModal.style.right = '16px';
        chatModal.style.bottom = '16px';
        chatModal.style.width = '32vw';
        chatModal.style.height = '32vh';
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

  // small CSS injection for overlays and chat (unchanged from previous version)
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
        map.setView(pinObj.marker.getLatLng(), Math.max(map.getZoom(), 12), { animate: true });
        showRadiusPopup(internalId);
      } else if (pinObj) {
        map.setView([pinObj.lat, pinObj.lon], Math.max(map.getZoom(), 12), { animate: true });
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
              if (isHost) socket.emit('updateBearing', { id: orig, bearing: val, ownerClientId: owner });
              else socket.emit('updateBearing', { id: orig, bearing: val });
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

        // Host: broadcast server-style so all clients (host + their own clients) get correct behaviour.
        if (isHost && socket && socket.connected) {
          const placementId = Date.now().toString() + '_' + Math.random().toString(36).slice(2,7);
          const color = pinColorInput && pinColorInput.value ? pinColorInput.value : '#ff4d4f';
          socket.emit('newPin', { id: placementId, groupId: currentPinGroupId, lat: lat, lon: lon, pinColor: color, rf: false });
          map.setView([lat, lon], Math.max(map.getZoom(), 12), { animate: true });
          showStatus(`Pinned (broadcast) at ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
          // overlay entry will be created when server echoes 'pinAdded' (socket.on('pinAdded'))
          return;
        }

        // fallback: local overlay pin (client offline / non-host)
        const internalId = `overlay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
        const ownerClientId = (socket && socket.id) ? socket.id : 'local';
        addPin(internalId, lat, lon, (clientNameInput && clientNameInput.value) || 'Local', ownerClientId, '#ff4d4f', false, null, null);
        map.setView([lat, lon], Math.max(map.getZoom(), 12), { animate: true });
        renderOverlayEntry(internalId, lat, lon, 'Pin');
        showStatus(`Pinned at ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
      });
    }

    // resizer (unchanged)
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
    // gentle scaling, clamp between 10 and 16
    const size = Math.round(10 + Math.max(0, Math.min(6, (z - 3) * 0.6)));
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
      // remove polyline if exists
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
    // gather latlngs in stored order; skip pins that are missing (but keep order)
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
    // remove old
    if (groupLines[groupId]) { try { map.removeLayer(groupLines[groupId]); } catch(e){} delete groupLines[groupId]; }
    // dotted style
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
    pinBtn.classList.toggle('active', isPinMode);
    pinBtn.textContent = `Pin Mode ${isPinMode? 'ON':'OFF'}`;
  });

  // RF toggle - ensure mutual exclusivity
  const rfBtn = document.getElementById('rf-toggle-btn');
  let isRFMode = false;
  rfBtn && rfBtn.addEventListener('click', ()=> {
    isRFMode = !isRFMode;
    if (isRFMode) {
      isPinMode = false;
      pinBtn.classList.remove('active'); pinBtn.textContent = 'Pin Mode OFF';
      isUserMode = false;
      userBtn.classList.remove('active'); userBtn.textContent = 'User Mode OFF';
    }
    rfBtn.classList.toggle('active', isRFMode);
    rfBtn.textContent = `RF Mode ${isRFMode ? 'ON' : 'OFF'}`;
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
  generateBtn && generateBtn.addEventListener('click', () => {
    const mode = isPinMode ? 'pin' : (isRFMode ? 'rf' : 'pin');
    function makeNextId(prefix, startNum=100) {
      let current;
      if (prefix === 'pin') current = currentPinGroupId;
      else current = currentRfGroupId;
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
    } else {
      const newId = makeNextId('rf', 200);
      currentRfGroupId = newId;
      usedGroupIds.add(newId);
      groupCounters[newId] = 0;
      showStatus(`New RF group ID: ${newId}`);
    }
  });

  // --- init app and socket handlers ---
  function initApp(url, hostFlag=false, clientName=null, colors=null) {
    serverUrl = url; isHost = hostFlag;
    ensureOverlayUI();

    if (!map) {
      map = L.map('map').setView([20.5937,78.9629], 5);
      const tileTemplate = `${serverUrl.replace(/\/$/, '')}/tiles/{z}/{x}/{y}.png`;
      L.tileLayer(tileTemplate, { minZoom:0, maxZoom:18, attribution:'© Local Tiles' }).addTo(map);

      map.on('click', e => {
        if (currentShapePlacement && isHost) {
          openShapePopupAt(currentShapePlacement, e.latlng);
        } else if (isUserMode) {
          placeUserDot(e.latlng, true);
        } else if (isRFMode) {
          const placementId = Date.now().toString() + '_' + Math.random().toString(36).slice(2,7);
          socket && socket.emit('newPin', { id: placementId, groupId: currentRfGroupId, lat: e.latlng.lat, lon: e.latlng.lng, pinColor: '#20c933', rf: true });
          socket && socket.emit('updateRadius', { id: placementId, radius: 5000, color: '#20c933' });
        } else if (isPinMode) {
          const placementId = Date.now().toString() + '_' + Math.random().toString(36).slice(2,7);
          socket && socket.emit('newPin', { id: placementId, groupId: currentPinGroupId, lat: e.latlng.lat, lon: e.latlng.lng });
        }
      });

      // update labels on zooming
      map.on('zoomend', () => refreshLabelIcons());

      setTimeout(()=>map.invalidateSize(),150);
    } else setTimeout(()=>map.invalidateSize(),150);

    socket = io(serverUrl, { query: { isHost: hostFlag ? 'true' : 'false' } });
    socket.on('connect', () => {
      showStatus('Connected to server');
      if (!hostFlag) {
        const info = {
          name: clientName || clientNameInput.value.trim(),
          pinColor: (colors && colors.pinColor) ? colors.pinColor : pinColorInput.value,
          userDotColor: (colors && colors.userDotColor) ? colors.userDotColor : userDotColorInput.value
        };
        socket.emit('clientInfo', info);
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
      // internal id is clientId + '_' + id (server placement ID)
      const pinId = `${d.clientId}_${d.id}`;

      // VISIBILITY RULE:
      // - Host: receives and displays all pins
      // - Client: only display if it's their own pin
      if (!isHost && socket && socket.id && d.clientId !== socket.id) {
        // not the host and not this client's pin -> ignore (so other clients' pins are hidden)
        return;
      }

      addPin(pinId, d.lat, d.lon, d.clientName, d.clientId, d.pinColor, !!d.rf, d.groupId || null, null);

      // create overlay entry (but addPin will not create overlays entry itself)
      const overlaysListEl = overlaysContainer.querySelector('#overlay-pins');
      if (overlaysListEl) renderOverlayEntry(pinId, d.lat, d.lon, d.rf ? 'RF' : 'Pin');
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
    socket.on('updateBearing', d => {
      const pinId = `${d.clientId}_${d.id}`;
      applyRemoteBearing(pinId, d.bearing);
    });
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

    // when the host assigns sub-ids, clients should update their labels
    socket.on('subIdAssigned', d => {
      // d: { clientId, id, subId }
      if (!d || !d.clientId || !d.id || !d.subId) return;
      const pinId = `${d.clientId}_${d.id}`;
      const p = pins[pinId];
      if (p) {
        p.subId = d.subId;
        if (p.marker && p.marker.setIcon) {
          try { p.marker.setIcon(buildLabeledDivIcon(d.subId, p.pinColor || '#ff4d4f', fontSizeForZoom(map.getZoom()))); } catch(e) {}
        }
        renderSidebarEntry(pinId);
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

  // --- Shapes logic (unchanged) ---
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
      const color = randomPastel();
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
  function addShapeLocal(shape, isUpdate) {
    if (!shape || !shape.id) return;
    if (shapes[shape.id] && !isUpdate) return;
    if (shapes[shape.id]) removeShapeLocal(shape.id, true);
    const marker = L.marker([shape.lat, shape.lon], { icon: buildShapeDivIcon(shape.type, shape.color) }).addTo(map);
    let overlay = null;
    if (shape.type === 'box' || shape.type === 'circle') {
      overlay = L.circle([shape.lat, shape.lon], { radius: shape.radius || 0, color: shape.color, fillColor: shape.color, fillOpacity: 0.22, weight:2 }).addTo(map);
    } else if (shape.type === 'cone') {
      const polygonPoints = buildConePolygonPoints(shape.lat, shape.lon, shape.radius || 0, shape.bearing || 0, shape.spread || 60, 6);
      const arc = polygonPoints.slice(1);
      overlay = L.polygon([ [shape.lat, shape.lon], ...arc ], { color: shape.color, fillColor: shape.color, fillOpacity: 0.22, weight:2 }).addTo(map);
    }
    if (isHost) {
      marker.on('click', () => openHostEditShapePopup(shape));
      overlay && overlay.on('click', () => openHostEditShapePopup(shape));
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
      showBtn.onclick = () => { map.setView([meta.lat, meta.lon], Math.max(map.getZoom(), 12)); showClientData(meta.clientId || null); };
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

    // Choose font size based on zoom (if map not ready, default to 12)
    const fs = map ? fontSizeForZoom(map.getZoom()) : 12;
    const labelText = subId || (groupId ? getGroupDisplayBase(groupId) + '.?' : '');
    const icon = buildLabeledDivIcon(labelText, pinColor || '#ff4d4f', fs);
    const marker = L.marker([lat, lon], { icon }).addTo(map);
    let radiusCircle = null;

    pins[id] = { marker, radiusCircle, elevation:0, bearing:0, clientId, clientName, pinColor, rf: !!isRF, groupId: groupId || null, lat, lon, archived:false, subId: subId || null };

    // tooltip
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

    // Add to group polylines (in insertion order)
    if (pins[id].groupId) addToGroup(pins[id].groupId, id);

    // If this viewer is filtering clients, hide markers not of selected client
    if (selectedClientId && clientId !== selectedClientId) marker.setOpacity(0);
    updateLines();

    // Host: authoritative sub-id assignment if group present and not yet assigned.
    if (isHost && pins[id].groupId && !pins[id].subId) {
      const g = pins[id].groupId;
      if (typeof groupCounters[g] === 'undefined') groupCounters[g] = 0;
      groupCounters[g] = (groupCounters[g] || 0) + 1;
      const assigned = `${getGroupDisplayBase(g)}.${groupCounters[g]}`;
      pins[id].subId = assigned;
      try { marker.setIcon(buildLabeledDivIcon(assigned, pinColor || '#ff4d4f', fs)); } catch(e) { console.warn('setIcon failed', e); }
      renderSidebarEntry(id);
      renderOverlayEntry(id, lat, lon, pins[id].rf ? 'RF' : 'Pin');

      // notify clients so they update their displayed pin labels to match host assignment
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
      p.radiusCircle = L.circle(p.marker.getLatLng(), { radius:m, color:p.pinColor||'#ff4d4f', fillColor:p.pinColor||'#ff4d4f', fillOpacity:0.25 }).addTo(map);
      const parts = id.split('_'); const orig = parts.slice(1).join('_'); const owner = parts[0];
      if (isHost) {
        socket && socket.emit('updateRadius', { id: orig, radius: m, color: p.pinColor, ownerClientId: owner });
      } else {
        socket && socket.emit('updateRadius', { id: orig, radius: m, color: p.pinColor });
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
  }

  function removePin(id) {
    const p = pins[id]; if (!p) return;
    // remove from group first
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
            if (owner !== 'overlay' && owner !== 'local') socket.emit('updateBearing', { id: orig, bearing: val, ownerClientId: owner });
          } else {
            if (owner !== 'overlay' && owner !== 'local') socket.emit('updateBearing', { id: orig, bearing: val });
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
      const targetZoom = Math.max(map.getZoom(), 15);
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
        // archived: temporarily show a popup at latlng
        const tmp = L.popup({ closeOnClick: true }).setLatLng(latlng).setContent(popupContent).openOn(map);
        setTimeout(()=> { try { map.closePopup(tmp); } catch(e){} }, 1600);
      }
    } catch (err) {
      console.warn('highlightPin error', err);
    }
  }

  // --- Lines rendering for user-dot -> pins (unchanged except robust checks) ---
  function updateLines() {
    for (const k in lines) { try { map.removeLayer(lines[k]); } catch(e){} delete lines[k]; }
    const LINE_COLOR = '#ff4d4f';
    if (isHost) {
      Object.entries(userDots).forEach(([clientId, dot]) => {
        if (!dot || !dot.getLatLng) return;
        if (selectedClientId && selectedClientId !== clientId) return;
        const dotLL = dot.getLatLng();
        Object.entries(pins).forEach(([pinId, pin]) => {
          if (pin.clientId === clientId && pin.marker) {
            const poly = L.polyline([dotLL, pin.marker.getLatLng()], { color: LINE_COLOR, weight:2, opacity:0.9 }).addTo(map);
            const dist = (dotLL.distanceTo(pin.marker.getLatLng())/1000).toFixed(2) + ' km';
            poly.bindTooltip(dist, { sticky:true });
            lines[pinId] = poly;
          }
        });
      });
    } else {
      if (!userMarker || !userMarker.getLatLng) return;
      const userLL = userMarker.getLatLng();
      Object.entries(pins).forEach(([pinId, pin]) => {
        if (socket && pinId.startsWith(socket.id) && pin.marker) {
          const poly = L.polyline([userLL, pin.marker.getLatLng()], { color: LINE_COLOR, weight:2, opacity:0.9 }).addTo(map);
          const dist = (userLL.distanceTo(pin.marker.getLatLng())/1000).toFixed(2) + ' km';
          poly.bindTooltip(dist, { sticky:true });
          lines[pinId] = poly;
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
    // tooltip shows lat/lon as requested
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
      socket.emit('userDotPlaced', { lat: latlng.lat, lon: latlng.lng });
      isUserMode = false; userBtn.classList.remove('active'); userBtn.textContent='User Mode OFF';
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
    // re-insert overlays container after clearing
    if (isHost) { sidebar.appendChild(overlaysContainer); renderShapesList(); }
    selectedClientId = null;
    // clear groups & group lines
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
    // also hide groupLines not related to selected client (groupLines belong to pins the viewer has)
    Object.entries(groupLines).forEach(([gId, poly]) => {
      // If this viewer (non-host) has fewer than 2 accessible pins for this group, remove poly
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
