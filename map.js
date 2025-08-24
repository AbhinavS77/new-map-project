// map.js (full) - collaborative map with RF/pin modes, shapes, and system chat panel

// --- Shared ID state (user-visible group IDs) ---
let currentPinGroupId = "pin-101";   // all normal pins use this until regenerated
let currentRfGroupId  = "rf-201";    // all RF pins use this until regenerated
const usedGroupIds = new Set([currentPinGroupId, currentRfGroupId]); // prevent duplicates

// --- Helpers: marker SVG, shape icons, geodesic math --- //
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

  // Chat UI refs - placed with other DOM refs (these might exist in your HTML)
  const chatBtn = document.getElementById('chat-btn');
  const chatModal = document.getElementById('chat-modal');       // existing small session modal (kept)
  const chatCloseBtn = document.getElementById('chat-close-btn');
  const chatMessages = document.getElementById('chat-messages'); // existing small session message container (kept)
  const chatInput = document.getElementById('chat-input');       // existing small session input (kept)
  const chatSendBtn = document.getElementById('chat-send');     // existing small session send button (kept)

  // Generate button (added in HTML)
  const generateBtn = document.getElementById('generate-ID-btn');

  // RF button ref & state
  const rfBtn = document.getElementById('rf-toggle-btn');
  let isRFMode = false;

  // state
  let map = null, socket = null, serverUrl = null, isHost = false;
  let isUserMode = false, isPinMode = false;
  let userMarker = null, userSidebar = null;
  const pins = {};    // key: `${clientId}_${placementId}`
  const userDots = {}; // clientId -> circleMarker
  const lines = {};   // pinKey -> polyline
  const shapes = {};  // shapeId -> { marker, overlay, meta }
  let selectedClientId = null;
  let currentShapePlacement = null;

  // Track chat IDs we sent (to dedupe server echo)
  const sentChatIds = new Set();
  // Fallback mapping if server doesn't echo id: key `${text}|${ts}` -> id
  const sentChatFallback = new Map();

  // overlays container (host only)
  const overlaysContainer = document.createElement('div');
  overlaysContainer.id = 'overlays-container';
  overlaysContainer.style.marginTop = '12px';

  // hide app until connected/joined
  container.style.display = 'none';
  modal.style.display = 'flex';

  // --- add small CSS for visual highlight used when clicking sidebar entries ---
  const _hlStyle = document.createElement('style');
  _hlStyle.textContent = `
    .pin-highlight {
      transform: scale(1.35);
      transition: transform 240ms ease;
      filter: drop-shadow(0 8px 20px rgba(0,0,0,0.14));
      z-index: 9999 !important;
    }
  `;
  document.head.appendChild(_hlStyle);

  try {
    const hosts = await window.electronAPI.discoverHosts();
    if (hosts && hosts.length === 1) showStatus('Host found — enter name to join.');
  } catch(e){ console.warn(e); }

  // --- System Chat: create small draggable quarter-window panel inside container ---
  // We'll create the DOM on-demand so existing HTML isn't required.
  const systemChat = {
    panel: null,
    header: null,
    messages: null,
    input: null,
    sendBtn: null,
    visible: false,
    pos: { left: 0, top: 0, width: 0, height: 0 }
  };

  // inject CSS for system chat panel
  (function injectSystemChatCSS(){
    const s = document.createElement('style');
    s.textContent = `
      .system-chat-panel {
        position: absolute;
        background: rgba(255,255,255,0.98);
        border: 1px solid rgba(15,23,42,0.06);
        box-shadow: 0 8px 30px rgba(2,6,23,0.12);
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        z-index: 99999;
        overflow: hidden;
        user-select: none;
      }
      .system-chat-header {
        background: linear-gradient(180deg, #fff, #f7fafc);
        padding: 8px 10px;
        font-weight: 700;
        font-size: 13px;
        color: #111827;
        cursor: grab;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:8px;
      }
      .system-chat-close {
        background: transparent;
        border: none;
        font-weight:700;
        cursor:pointer;
        padding:4px 8px;
        border-radius:6px;
      }
      .system-chat-body {
        padding: 8px;
        overflow-y: auto;
        flex: 1 1 auto;
        background: transparent;
      }
      .system-chat-input-wrap {
        display:flex;
        gap:8px;
        padding:8px;
        border-top:1px solid rgba(0,0,0,0.04);
        background: linear-gradient(180deg, #fff, #fbfdff);
      }
      .system-chat-input-wrap input[type="text"] {
        flex:1;
        padding:8px 10px;
        border-radius:8px;
        border:1px solid #e6e9ef;
        font-size:13px;
      }
      .system-chat-send-btn {
        padding:8px 12px;
        border-radius:8px;
        border:none;
        background:#1e88e5;
        color:#fff;
        cursor:pointer;
        font-weight:700;
      }
      .system-chat-msg {
        margin-bottom:8px;
      }
      .system-chat-msg .meta { font-size:11px;color:#6b7280;margin-bottom:4px; }
      .system-chat-msg .text { background:#fff;padding:8px;border-radius:8px;border:1px solid #eef2f7; font-size:13px; color:#111827; }

      /* Host message highlight (clients only) */
      .system-chat-msg.host-msg .text {
        background: #fff9db; /* light yellow */
        border: 1px solid #f0d57a;
      }

      /* small-session chat highlight */
      .chat-wrapper.host-msg .chat-text {
        background: #fff9db;
        border: 1px solid #f0d57a;
        border-radius: 8px;
        padding: 8px;
      }
    `;
    document.head.appendChild(s);
  })();

  function createSystemChatPanel() {
    if (systemChat.panel) return systemChat.panel;
    // panel root
    const panel = document.createElement('div');
    panel.className = 'system-chat-panel';
    // default size: quarter-ish of container
    const cw = container.clientWidth || window.innerWidth;
    const ch = container.clientHeight || window.innerHeight;
    const width = Math.max(320, Math.floor(cw * 0.33));
    const height = Math.max(260, Math.floor(ch * 0.33));
    // default pos bottom-right with some margin
    const left = Math.max(12, cw - width - 12);
    const top = Math.max(12, ch - height - 12);

    panel.style.width = width + 'px';
    panel.style.height = height + 'px';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';

    // header
    const header = document.createElement('div');
    header.className = 'system-chat-header';
    header.innerHTML = `<div style="display:flex;gap:8px;align-items:center"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 6.5C21 4.01 18.99 2 16.5 2h-9C4.51 2 2.5 4.01 2.5 6.5v7C2.5 15.99 4.51 18 6.99 18H9v3l3-3h4.5c2.49 0 4.51-2.01 4.51-4.5v-7z" fill="#1e293b"/></svg><div>System Chat</div></div>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'system-chat-close';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = '&times;';
    header.appendChild(closeBtn);

    // body/messages
    const body = document.createElement('div');
    body.className = 'system-chat-body';
    body.style.background = 'transparent';

    // input wrap
    const inputWrap = document.createElement('div');
    inputWrap.className = 'system-chat-input-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Type a message and press Enter...';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'system-chat-send-btn';
    sendBtn.textContent = 'Send';

    inputWrap.appendChild(input);
    inputWrap.appendChild(sendBtn);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(inputWrap);

    // append inside container so we can clamp to container bounds
    container.appendChild(panel);

    // save refs
    systemChat.panel = panel;
    systemChat.header = header;
    systemChat.messages = body;
    systemChat.input = input;
    systemChat.sendBtn = sendBtn;

    // -- close behavior --
    closeBtn.addEventListener('click', () => {
      panel.style.display = 'none';
      systemChat.visible = false;
      try { (systemChat.input || document.activeElement).blur(); } catch(e){}
    });

    // send behavior
    sendBtn.addEventListener('click', () => sendChatFromInput());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { sendChatFromInput(); e.preventDefault(); }
    });

    // draggable via header -- constrain inside container
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    const clampPosition = (l, t, w, h) => {
      const rect = container.getBoundingClientRect();
      const minLeft = 8;
      const minTop = 8;
      const maxLeft = Math.max(minLeft, rect.width - w - 8);
      const maxTop = Math.max(minTop, rect.height - h - 8);
      return {
        left: Math.min(maxLeft, Math.max(minLeft, l)),
        top: Math.min(maxTop, Math.max(minTop, t))
      };
    };

    // pointer events for mouse + touch
    header.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      dragging = true;
      try { header.setPointerCapture(ev.pointerId); } catch(e){}
      startX = ev.clientX;
      startY = ev.clientY;
      const r = panel.getBoundingClientRect();
      // compute left/top relative to container
      const containerRect = container.getBoundingClientRect();
      startLeft = r.left - containerRect.left;
      startTop = r.top - containerRect.top;
      header.style.cursor = 'grabbing';
    });

    window.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      ev.preventDefault();
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const desiredLeft = startLeft + dx;
      const desiredTop = startTop + dy;
      const clamped = clampPosition(desiredLeft, desiredTop, w, h);
      panel.style.left = clamped.left + 'px';
      panel.style.top = clamped.top + 'px';
    });

    window.addEventListener('pointerup', (ev) => {
      if (!dragging) return;
      dragging = false;
      header.style.cursor = 'grab';
      try { header.releasePointerCapture && header.releasePointerCapture(ev.pointerId); } catch(e){}
      // store pos
      const containerRect = container.getBoundingClientRect();
      const r = panel.getBoundingClientRect();
      systemChat.pos.left = r.left - containerRect.left;
      systemChat.pos.top = r.top - containerRect.top;
      systemChat.pos.width = panel.offsetWidth;
      systemChat.pos.height = panel.offsetHeight;
    });

    // make sure on window resize we keep panel inside bounds
    window.addEventListener('resize', () => {
      if (!systemChat.panel) return;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const clamped = clampPosition(parseInt(panel.style.left,10) || 0, parseInt(panel.style.top,10) || 0, w, h);
      panel.style.left = clamped.left + 'px';
      panel.style.top = clamped.top + 'px';
    });

    // start hidden (we toggle with Chat button)
    panel.style.display = 'none';

    return panel;
  }

  function openSystemChat() {
    createSystemChatPanel();
    if (!systemChat.panel) return;
    // compute default position if not set (pos.x/y === 0 indicates not stored)
    if (!systemChat.pos.left && !systemChat.pos.top) {
      const cw = container.clientWidth || window.innerWidth;
      const ch = container.clientHeight || window.innerHeight;
      const width = Math.max(320, Math.floor(cw * 0.33));
      const height = Math.max(260, Math.floor(ch * 0.33));
      systemChat.panel.style.width = width + 'px';
      systemChat.panel.style.height = height + 'px';
      systemChat.panel.style.left = Math.max(12, cw - width - 12) + 'px';
      systemChat.panel.style.top  = Math.max(12, ch - height - 12) + 'px';
    } else {
      systemChat.panel.style.left = systemChat.pos.left + 'px';
      systemChat.panel.style.top = systemChat.pos.top + 'px';
      if (systemChat.pos.width) systemChat.panel.style.width = systemChat.pos.width + 'px';
      if (systemChat.pos.height) systemChat.panel.style.height = systemChat.pos.height + 'px';
    }
    systemChat.panel.style.display = 'flex';
    systemChat.visible = true;
    // scroll to bottom
    setTimeout(()=> {
      try { systemChat.messages.scrollTop = systemChat.messages.scrollHeight; systemChat.input.focus(); } catch(e){}
    },50);
  }

  function closeSystemChat() {
    if (!systemChat.panel) return;
    systemChat.panel.style.display = 'none';
    systemChat.visible = false;
  }

  // --- Chat helpers (shared) ---
  function formatTime(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Append message to both existing chatMessages (if present) and system chat panel.
  function appendChatMessage(msgObj, opts = {}) {
    // msgObj: { id?, clientId, name, text, ts, fromHost? }
    const name = escapeHtml(msgObj.name || msgObj.clientId || 'Unknown');
    const time = formatTime(msgObj.ts);
    // highlight host messages only on CLIENT UIs (not on the host's own UI)
    const isFromHost = !!msgObj.fromHost;
    const shouldHighlightAsHost = isFromHost && !isHost;

    // append to existing (session) chatMessages DOM if present
    if (chatMessages) {
      try {
        const wrapper = document.createElement('div');
        wrapper.style.marginBottom = '8px';
        wrapper.className = 'chat-wrapper';
        if (shouldHighlightAsHost) wrapper.classList.add('host-msg');

        wrapper.innerHTML = `<div style="font-size:12px;color:#6b7280;margin-bottom:2px">${name} <span style="font-size:11px;color:#9ca3af;margin-left:6px">${time}</span></div>
                             <div class="chat-text" style="background:#fff;padding:8px;border-radius:8px;border:1px solid #eef2f7">${escapeHtml(msgObj.text)}</div>`;
        chatMessages.appendChild(wrapper);
        if (!opts.skipScroll) chatMessages.scrollTop = chatMessages.scrollHeight;
      } catch(e){ console.warn('appendChatMessage (session) error', e); }
    }

    // append to system chat panel if exists
    if (systemChat.messages) {
      try {
        // create DOM node rather than innerHTML concat to keep safe
        const div = document.createElement('div');
        div.className = 'system-chat-msg';
        if (shouldHighlightAsHost) div.classList.add('host-msg');

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = name + ' ';
        const timeSpan = document.createElement('span');
        timeSpan.style.marginLeft = '8px'; timeSpan.style.color = '#9ca3af'; timeSpan.style.fontWeight = 500;
        timeSpan.textContent = time;
        meta.appendChild(timeSpan);

        const txt = document.createElement('div');
        txt.className = 'text';
        txt.textContent = msgObj.text;

        div.appendChild(meta);
        div.appendChild(txt);
        systemChat.messages.appendChild(div);
        if (!opts.skipScroll) systemChat.messages.scrollTop = systemChat.messages.scrollHeight;
      } catch(e){ console.warn('appendChatMessage (system) error', e); }
    }
  }

  function sendChatFromInput() {
    // pick input source: system chat if visible else existing chatInput (session)
    const inputEl = (systemChat.panel && systemChat.visible && systemChat.input) ? systemChat.input : chatInput;
    if (!inputEl || !socket) return;
    const text = (inputEl.value || '').trim();
    if (!text) return;

    // create a small unique id for deduping
    const msgId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,9);
    const tsNow = Date.now();

    const msg = { id: msgId, text, ts: tsNow };
    const name = clientNameInput && clientNameInput.value && clientNameInput.value.trim() ? clientNameInput.value.trim() : (socket && socket.id);
    msg.name = name;

    // remember we sent this id (for dedupe when server echoes)
    sentChatIds.add(msgId);
    sentChatFallback.set(`${text}|${tsNow}`, msgId);

    // optimistic append (user sees immediately)
    // mark local message as fromHost if this client is host (so server and clients can also know)
    const optimistic = { clientId: socket.id, id: msgId, name, text: msg.text, ts: msg.ts, fromHost: !!isHost };
    appendChatMessage(optimistic);

    // send to server
    socket.emit('chatMessage', msg);

    // clear input
    inputEl.value = '';
  }

  // Chat UI events for existing session UI (keeps backward compatibility)
  chatBtn && chatBtn.addEventListener('click', (ev) => {
    // toggle system chat panel instead of opening small modal
    if (!systemChat.panel || !systemChat.visible) openSystemChat();
    else closeSystemChat();
  });
  chatCloseBtn && chatCloseBtn.addEventListener('click', () => {
    // if user has a separate close button, close session modal AND system chat
    if (chatModal) chatModal.style.display = 'none';
    if (systemChat.panel) closeSystemChat();
  });
  chatSendBtn && chatSendBtn.addEventListener('click', sendChatFromInput);
  if (chatInput) chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { sendChatFromInput(); e.preventDefault(); }
  });

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
  rfBtn.addEventListener('click', ()=> {
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
  clearBtn.addEventListener('click', () => {
    if (!socket) return;
    if (isHost) {
      socket.emit('clearAll');
      clearAll();
    } else {
      socket.emit('clearClientPins');
      clearClientData(socket.id);
    }
  });

  // --- Generate ID button logic ---
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
      showStatus(`New Pin group ID: ${newId}`);
    } else {
      const newId = makeNextId('rf', 200);
      currentRfGroupId = newId;
      usedGroupIds.add(newId);
      showStatus(`New RF group ID: ${newId}`);
    }
  });

  // --- init app and socket handlers ---
  function initApp(url, hostFlag=false, clientName=null, colors=null) {
    serverUrl = url; isHost = hostFlag;
    if (!sidebar.querySelector('#overlays-container')) {
      overlaysContainer.innerHTML = `<h3 style="margin:6px 0 8px">Overlays</h3><div id="overlays-list"></div>`;
      sidebar.insertBefore(overlaysContainer, sidebar.firstChild);
    }
    if (!map) {
      map = L.map('map').setView([20.5937,78.9629], 5);
      const tileTemplate = `${serverUrl.replace(/\/$/, '')}/tiles/{z}/{x}/{y}.png`;
      L.tileLayer(tileTemplate, { minZoom:0, maxZoom:18, attribution:'© Local Tiles' }).addTo(map);

      // handle clicks: use a unique placement id for each click; groupId is the selected group
      map.on('click', e => {
        if (currentShapePlacement && isHost) {
          openShapePopupAt(currentShapePlacement, e.latlng);
        } else if (isUserMode) {
          placeUserDot(e.latlng, true);
        } else if (isRFMode) {
          const placementId = Date.now().toString() + '_' + Math.random().toString(36).slice(2,7);
          // specify green pin for RF
          socket && socket.emit('newPin', { id: placementId, groupId: currentRfGroupId, lat: e.latlng.lat, lon: e.latlng.lng, pinColor: '#20c933', rf: true });
          socket && socket.emit('updateRadius', { id: placementId, radius: 5000, color: '#20c933' });
        } else if (isPinMode) {
          const placementId = Date.now().toString() + '_' + Math.random().toString(36).slice(2,7);
          socket && socket.emit('newPin', { id: placementId, groupId: currentPinGroupId, lat: e.latlng.lat, lon: e.latlng.lng });
        }
      });

      setTimeout(()=>map.invalidateSize(),150);
    } else setTimeout(()=>map.invalidateSize(),150);

    // socket setup
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

    // Chat socket listeners
    socket.on('chatHistory', history => {
      if (!Array.isArray(history)) return;
      // Clear both UI locations
      if (chatMessages) chatMessages.innerHTML = '';
      if (systemChat.messages) systemChat.messages.innerHTML = '';
      history.forEach(m => {
        // If server history contains messages we optimistically added, skip them
        if (m && m.id && sentChatIds.has(m.id)) {
          sentChatIds.delete(m.id);
          // also remove any fallback entries that referred to this id
          for (const [key, v] of sentChatFallback.entries()) if (v === m.id) sentChatFallback.delete(key);
          return;
        }
        // fallback: server might not echo id but might echo text+ts; skip if matches our fallback map
        if ((!m.id) && m.text && m.ts && sentChatFallback.has(`${m.text}|${m.ts}`)) {
          const matchedId = sentChatFallback.get(`${m.text}|${m.ts}`);
          sentChatFallback.delete(`${m.text}|${m.ts}`);
          sentChatIds.delete(matchedId);
          return;
        }
        appendChatMessage(m, { skipScroll: true });
      });
      if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
      if (systemChat.messages) systemChat.messages.scrollTop = systemChat.messages.scrollHeight;
    });

    // Deduplicating handler: ignore server echoes for messages we already appended locally
    socket.on('chatMessage', m => {
      if (!m) return;
      if (m.id && sentChatIds.has(m.id)) {
        // server echoed our message; remove id from set and do not append again
        sentChatIds.delete(m.id);
        // also clear fallback entries that referenced this id
        for (const [key, v] of sentChatFallback.entries()) if (v === m.id) sentChatFallback.delete(key);
        return;
      }
      // fallback: server didn't include id but text+ts match
      if ((!m.id) && m.text && m.ts && sentChatFallback.has(`${m.text}|${m.ts}`)) {
        const matchedId = sentChatFallback.get(`${m.text}|${m.ts}`);
        sentChatFallback.delete(`${m.text}|${m.ts}`);
        sentChatIds.delete(matchedId);
        return;
      }
      appendChatMessage(m);
    });

    // server sends updated client list (host only)
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

    // pins events: server should include groupId in the broadcast payload
    socket.on('pinAdded', d => {
      const pinId = `${d.clientId}_${d.id}`; // internal key is clientId + placementId
      addPin(pinId, d.lat, d.lon, d.clientName, d.clientId, d.pinColor, !!d.rf, d.groupId || null);
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
        dot.clientId = d.clientId; dot.bindTooltip(d.clientName, { direction:'top' });
        userDots[d.clientId] = dot;
        if (selectedClientId && selectedClientId !== d.clientId) dot.setStyle({ opacity:0, fillOpacity:0 });
        updateLines();
      }
    });
    socket.on('userDotPlacedAck', d => {
      if (!isHost) placeUserDot(L.latLng(d.lat, d.lon), false, d.clientName, d.userDotColor);
    });

    // shapes sync
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

  // --- Host shape controls & placement (unchanged) ---
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
    const root = document.getElementById('overlays-list');
    if (!root) return;
    root.innerHTML = '';
    Object.values(shapes).forEach(sobj => {
      const meta = sobj.meta;
      const div = document.createElement('div');
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
      root.appendChild(div);
    });
  }

  // --- Pins ---
  function addPin(id, lat, lon, clientName, clientId, pinColor, isRF=false, groupId=null) {
    if (pins[id]) return; // internal placements are unique; ignore duplicates

    // build marker icon (same as before)
    const icon = buildMarkerIcon(pinColor || '#ff4d4f');
    const marker = L.marker([lat, lon], { icon }).addTo(map);
    let radiusCircle = null;

    // store rf flag and groupId on the pin object (groupId is user-visible)
    pins[id] = { marker, radiusCircle, elevation:0, bearing:0, clientId, clientName, pinColor, rf: !!isRF, groupId: groupId || id };

    // --- Hover tooltip: show visible ID and lat/lon on mouseover, hide on mouseout ---
    const visibleIdText = escapeHtml(String(groupId || id));
    const latText = Number(lat).toFixed(6);
    const lonText = Number(lon).toFixed(6);
    const tooltipHtml = `ID: <strong>${visibleIdText}</strong><br/>Lat: ${latText}<br/>Lon: ${lonText}`;

    marker.bindTooltip(tooltipHtml, { direction: 'top', offset: [0, -10], permanent: false, sticky: true });

    marker.on('mouseover', () => {
      try { marker.openTooltip(); }
      catch(e) { /* ignore if something odd */ }
    });
    marker.on('mouseout', () => {
      try { marker.closeTooltip(); }
      catch(e) { /* ignore */ }
    });

    marker.on('click', ()=> showRadiusPopup(id));

    renderSidebarEntry(id);
    if (selectedClientId && clientId !== selectedClientId) marker.setOpacity(0);
    updateLines();
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
        socket.emit('updateRadius', { id: orig, radius: m, color: p.pinColor, ownerClientId: owner });
      } else {
        socket.emit('updateRadius', { id: orig, radius: m, color: p.pinColor });
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
  }

  function applyRemoteBearing(id, bearing) {
    const p = pins[id]; if (!p) return;
    p.bearing = bearing;
    renderSidebarEntry(id);
  }

  function removePin(id) {
    const p = pins[id]; if (!p) return;
    if (p.marker) try { map.removeLayer(p.marker); } catch(e){}
    if (p.radiusCircle) try { map.removeLayer(p.radiusCircle); } catch(e){}
    if (lines[id]) { try { map.removeLayer(lines[id]); } catch(e){} delete lines[id]; }
    delete pins[id];
    const li = sidebar.querySelector(`li[data-id="${id}"]`); if (li) li.remove();
    updateLines();
  }

  // --- Sidebar entry: delete + elevation/bearing edits + clickable highlight ---
  function renderSidebarEntry(id) {
    const p = pins[id];
    if (!p) return;
    const latlng = p.marker.getLatLng();
    let li = sidebar.querySelector(`li[data-id="${id}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.id = id;
      sidebar.appendChild(li);
    }

    const visibleId = escapeHtml(p.groupId || (p.clientId + '_' + id));
    const rfBadge = p.rf ? `<span style="background:#e6ffed;color:#064e2e;padding:2px 6px;border-radius:6px;font-size:11px;margin-left:8px">RF</span>` : '';

    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="pin-info" style="cursor:pointer">
          <div style="font-weight:700">${escapeHtml(p.clientName || p.clientId)} ${rfBadge}</div>
          <div style="font-size:12px;color:#6b7280">ID: <strong>${visibleId}</strong></div>
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
        ev.stopPropagation(); // prevent highlight when deleting
        const parts = id.split('_');
        const owner = parts[0];
        const orig = parts.slice(1).join('_');
        socket.emit('removePin', { id: orig, ownerClientId: owner });
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
            socket.emit('updateElevation', { id: orig, elevation: val, ownerClientId: owner });
          } else {
            socket.emit('updateElevation', { id: orig, elevation: val });
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
            socket.emit('updateBearing', { id: orig, bearing: val, ownerClientId: owner });
          } else {
            socket.emit('updateBearing', { id: orig, bearing: val });
          }
          renderSidebarEntry(id);
        }
      };
    }
  }

  // --- Visual highlight + pan/zoom helper ---
  function highlightPin(id) {
    const p = pins[id];
    if (!p || !p.marker || !p.marker.getLatLng) return;
    try {
      const latlng = p.marker.getLatLng();
      const targetZoom = Math.max(map.getZoom(), 15);
      map.setView(latlng, targetZoom, { animate: true });

      const popupContent = `ID: <strong>${escapeHtml(p.groupId || id)}</strong><br/>Lat: ${latlng.lat.toFixed(4)}<br/>Lon: ${latlng.lng.toFixed(4)}`;
      p.marker.bindPopup(popupContent).openPopup();

      const el = p.marker.getElement && p.marker.getElement();
      if (el) {
        el.classList.add('pin-highlight');
        setTimeout(() => {
          try { el.classList.remove('pin-highlight'); } catch(e){ }
        }, 900);
      }
    } catch (err) {
      console.warn('highlightPin error', err);
    }
  }

  // --- Lines rendering (host and client) ---
  function updateLines() {
    for (const k in lines) { try { map.removeLayer(lines[k]); } catch(e){} delete lines[k]; }
    const LINE_COLOR = '#ff4d4f';
    if (isHost) {
      Object.entries(userDots).forEach(([clientId, dot]) => {
        if (!dot || !dot.getLatLng) return;
        if (selectedClientId && selectedClientId !== clientId) return;
        const dotLL = dot.getLatLng();
        Object.entries(pins).forEach(([pinId, pin]) => {
          if (pin.clientId === clientId) {
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
        if (pinId.startsWith(socket.id)) {
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
        try { if (p.marker) map.removeLayer(p.marker); } catch(e){}
        try { if (p.radiusCircle) map.removeLayer(p.radiusCircle); } catch(e){}
        if (lines[key]) { try { map.removeLayer(lines[key]); } catch(e){} delete lines[key]; }
        const li = sidebar.querySelector(`li[data-id="${key}"]`); if (li) li.remove();
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

  // --- Helpers ---
  function showStatus(msg) { statusBar.textContent = msg; statusBar.classList.add('show'); setTimeout(()=>statusBar.classList.remove('show'),2200); }
  function escapeHtml(s) { return (s+'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function loadSavedPins() {
    const saved = JSON.parse(localStorage.getItem('pins')||'{}');
    for (const id in saved) {
      const s = saved[id];
      addPin(id, s.lat, s.lon);
      if (s.radius) applyRemoteRadius(id, s.radius);
      if (s.elevation) applyRemoteElevation(id, s.elevation);
      if (s.bearing) applyRemoteBearing(id, s.bearing);
    }
  }
  loadSavedPins();

}); // end DOMContentLoaded
