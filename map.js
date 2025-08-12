// map.js (updated: pin anchor adjusted with bottom padding to fix offset)
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

// Build marker icon with extra bottom padding so the visible tip aligns with click point.
// Adjust ICON_BOTTOM_PADDING to fine-tune vertical alignment (pixels).
function buildMarkerIcon(pinColor) {
  const ICON_SIZE = [30, 45];
  const ICON_BOTTOM_PADDING = -20; // <--- increase to push icon further down, decrease to pull up
  const svgUrl = createSvgIconDataUrl(pinColor);

  // iconAnchor Y is icon height + bottom padding so the anchor point is below the visible SVG,
  // causing the tip to land exactly at the clicked lat/lng pixel.
  const anchorY = ICON_SIZE[1] + ICON_BOTTOM_PADDING;

  return L.icon({
    iconUrl: svgUrl,
    iconSize: ICON_SIZE,
    iconAnchor: [Math.floor(ICON_SIZE[0] / 2), anchorY],
    popupAnchor: [0, -anchorY + 8]
  });
}

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

  // state
  let map = null, socket = null, serverUrl = null, isHost = false;
  let isUserMode = false, isPinMode = false;
  let userMarker = null, userSidebar = null;
  const pins = {};    // key: `${clientId}_${origId}`
  const userDots = {}; // clientId -> circleMarker
  const lines = {};   // pinKey -> polyline
  let selectedClientId = null;

  container.style.display = 'none';
  modal.style.display = 'flex';

  try {
    const hosts = await window.electronAPI.discoverHosts();
    if (hosts && hosts.length === 1) showStatus('Host found — enter name to join.');
  } catch(e){ console.warn(e); }

  hostBtn.addEventListener('click', async () => {
    await window.electronAPI.startHost();
    isHost = true; serverUrl = 'http://localhost:3000';
    initApp(serverUrl, true, null, null);
    modal.style.display = 'none'; container.style.display = 'flex';
    serverBtn.style.display = 'block'; serverPanel.style.display = 'block';
    showStatus('Hosting on this machine');
  });

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

  // Clear: host clears all; client clears only itself
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

  // init / socket / handlers
  function initApp(url, hostFlag=false, clientName=null, colors=null) {
    serverUrl = url; isHost = hostFlag;

    if (!map) {
      map = L.map('map').setView([20.5937,78.9629], 5);
      const tileTemplate = `${serverUrl.replace(/\/$/,'')}/tiles/{z}/{x}/{y}.png`;
      L.tileLayer(tileTemplate, { minZoom:0, maxZoom:18, attribution:'© Local Tiles' }).addTo(map);
      map.on('click', e => {
        if (isUserMode) placeUserDot(e.latlng, true);
        else if (isPinMode) {
          const id = Date.now().toString();
          socket && socket.emit('newPin', { id, lat: e.latlng.lat, lon: e.latlng.lng });
        }
      });
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

    socket.on('pinAdded', d => {
      const pinId = `${d.clientId}_${d.id}`;
      addPin(pinId, d.lat, d.lon, d.clientName, d.clientId, d.pinColor);
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

    socket.on('clientDisconnected', clientId => {
      clearClientData(clientId);
      if (selectedClientId === clientId) { selectedClientId = null; showAllClients(); }
    });

    socket.on('connect_error', e => {
      alert('Connection failed: ' + (e && e.message));
      container.style.display='none'; modal.style.display='flex';
    });
  }

  // addPin uses icon built with bottom padding anchor
  function addPin(id, lat, lon, clientName, clientId, pinColor) {
    if (pins[id]) return;
    const icon = buildMarkerIcon(pinColor || '#ff4d4f');
    const marker = L.marker([lat, lon], { icon }).addTo(map);
    let radiusCircle = null;
    pins[id] = { marker, radiusCircle, elevation:0, bearing:0, clientId, clientName, pinColor };
    marker.on('click', ()=> showRadiusPopup(id));
    renderSidebarEntry(id);
    if (selectedClientId && clientId !== selectedClientId) marker.setOpacity(0);
    updateLines();
  }

  function showRadiusPopup(id) {
    const p = pins[id]; if (!p) return;
    p.marker.closePopup(); p.marker.unbindPopup();
    const ui = L.DomUtil.create('div','pin-popup');
    ui.innerHTML = `<input type="number" placeholder="Distance in km" style="width:120px;margin-bottom:6px"/><br/><button>OK</button>`;
    const inp = ui.querySelector('input'), btn = ui.querySelector('button');
    btn.addEventListener('click', ()=> {
      const km = parseFloat(inp.value); if (isNaN(km) || km<=0) return alert('Enter valid kilometers');
      const m = km*1000; if (p.radiusCircle) map.removeLayer(p.radiusCircle);
      p.radiusCircle = L.circle(p.marker.getLatLng(), { radius:m, color:p.pinColor||'#ff4d4f', fillColor:p.pinColor||'#ff4d4f', fillOpacity:0.25 }).addTo(map);
      const parts = id.split('_'); const orig = parts.slice(1).join('_');
      socket.emit('updateRadius', { id: orig, radius: m, color: p.pinColor });
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

  function removePin(id) {
    const p = pins[id]; if (!p) return;
    if (p.marker) try { map.removeLayer(p.marker); } catch(e){}
    if (p.radiusCircle) try { map.removeLayer(p.radiusCircle); } catch(e){}
    if (lines[id]) { try { map.removeLayer(lines[id]); } catch(e){} delete lines[id]; }
    delete pins[id];
    const li = sidebar.querySelector(`li[data-id="${id}"]`); if (li) li.remove();
    updateLines();
  }

  // sidebar entry: delete emits owner info (so server can route removal to owner)
  function renderSidebarEntry(id) {
    const p = pins[id]; if (!p) return;
    const latlng = p.marker.getLatLng();
    let li = sidebar.querySelector(`li[data-id="${id}"]`);
    if (!li) { li = document.createElement('li'); li.dataset.id = id; sidebar.appendChild(li); }
    li.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:700">${escapeHtml(p.clientName || p.clientId)}</div>
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
    const delBtn = li.querySelector('.delete-btn');
    if (delBtn) {
      delBtn.onclick = () => {
        const parts = id.split('_');
        const owner = parts[0];
        const orig = parts.slice(1).join('_');
        socket.emit('removePin', { id: orig, ownerClientId: owner });
        removePin(id);
      };
    }
    const elevInp = li.querySelector('.elev-inp');
    elevInp.onkeydown = e => { if (e.key==='Enter') { const val = parseFloat(elevInp.value)||0; p.elevation=val; const parts=id.split('_'); socket.emit('updateElevation',{id:parts.slice(1).join('_'), elevation:val}); } };
    const bearInp = li.querySelector('.bear-inp');
    bearInp.onkeydown = e => { if (e.key==='Enter') { const val = parseFloat(bearInp.value)||0; p.bearing=val; const parts=id.split('_'); socket.emit('updateBearing',{id:parts.slice(1).join('_'), bearing:val}); } };
  }

  // LINES & filtering
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

  // user dot
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

  // clearing helpers
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
    if (userMarker) { try { map.removeLayer(userMarker); } catch(e){} userMarker=null; }
    sidebar.innerHTML = '';
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

  // helpers
  function showStatus(msg) { statusBar.textContent = msg; statusBar.classList.add('show'); setTimeout(()=>statusBar.classList.remove('show'),2200); }
  function escapeHtml(s) { return (s+'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // optional saved load
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
});
