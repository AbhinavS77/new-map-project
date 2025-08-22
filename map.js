// map.js (complete) - includes host-only shapes (box/cone/circle), outlines, and owner-aware updates

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
  const ICON_BOTTOM_PADDING = -24; // tuned to align tip with click point
  const svgUrl = createSvgIconDataUrl(pinColor);
  const anchorY = ICON_SIZE[1] + ICON_BOTTOM_PADDING;
  return L.icon({
    iconUrl: svgUrl,
    iconSize: ICON_SIZE,
    iconAnchor: [Math.floor(ICON_SIZE[0] / 2), anchorY],
    popupAnchor: [0, -anchorY + 8]
  });
}

// Shape icon with outline/stroke for clarity
function buildShapeDivIcon(type, color) {
  const size = 22;
  let shapeSvg = '';
  const stroke = 'rgba(0,0,0,0.14)';
  const strokeWidth = 1.6;

  if (type === 'box') {
    shapeSvg = `<rect x="3" y="3" width="16" height="16" rx="2" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  } else if (type === 'circle') {
    shapeSvg = `<circle cx="11" cy="11" r="8" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  } else { // cone/triangle
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

// geodesic destination using spherical Earth model
function destinationPoint(lat, lon, bearingDeg, distanceMeters) {
  const R = 6378137; // Earth radius in m
  const bearing = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const dDivR = distanceMeters / R;

  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dDivR) + Math.cos(lat1) * Math.sin(dDivR) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(dDivR) * Math.cos(lat1), Math.cos(dDivR) - Math.sin(lat1) * Math.sin(lat2));

  return [lat2 * 180 / Math.PI, lon2 * 180 / Math.PI];
}

// build cone polygon arc points (center + arc)
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

// --- DOM refs & state --- //
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

  // state
  let map = null, socket = null, serverUrl = null, isHost = false;
  let isUserMode = false, isPinMode = false;
  let userMarker = null, userSidebar = null;
  const pins = {};    // key: `${clientId}_${origId}`
  const userDots = {}; // clientId -> circleMarker
  const lines = {};   // pinKey -> polyline
  const shapes = {};  // shapeId -> { marker, overlay, meta }
  let selectedClientId = null;
  let currentShapePlacement = null;

  // UI: overlays container (host only)
  const overlaysContainer = document.createElement('div');
  overlaysContainer.id = 'overlays-container';
  overlaysContainer.style.marginTop = '12px';

  container.style.display = 'none';
  modal.style.display = 'flex';

  try {
    const hosts = await window.electronAPI.discoverHosts();
    if (hosts && hosts.length === 1) showStatus('Host found — enter name to join.');
  } catch(e){ console.warn(e); }

  // --- Host start --- //
  hostBtn.addEventListener('click', async () => {
    await window.electronAPI.startHost();
    isHost = true; serverUrl = 'http://localhost:3000';
    initApp(serverUrl, true, null, null);
    modal.style.display = 'none'; container.style.display = 'flex';
    serverBtn.style.display = 'block'; serverPanel.style.display = 'block';
    showStatus('Hosting on this machine');
    createHostShapeButtons();
  });

  // --- Client join --- //
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

  // --- init app and socket handlers --- //
  function initApp(url, hostFlag=false, clientName=null, colors=null) {
    serverUrl = url; isHost = hostFlag;

    // add overlays header to sidebar
    if (!sidebar.querySelector('#overlays-container')) {
      overlaysContainer.innerHTML = `<h3 style="margin:6px 0 8px">Overlays</h3><div id="overlays-list"></div>`;
      sidebar.insertBefore(overlaysContainer, sidebar.firstChild);
    }

    if (!map) {
      map = L.map('map').setView([20.5937,78.9629], 5);
      const tileTemplate = `${serverUrl.replace(/\/$/,'')}/tiles/{z}/{x}/{y}.png`;
      L.tileLayer(tileTemplate, { minZoom:0, maxZoom:18, attribution:'© Local Tiles' }).addTo(map);
      map.on('click', e => {
        if (currentShapePlacement && isHost) {
          openShapePopupAt(currentShapePlacement, e.latlng);
        } else if (isUserMode) {
          placeUserDot(e.latlng, true);
        } else if (isPinMode) {
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

    // clients list for host
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

    // pins events
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

  // --- Host shape controls & placement --- //
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

  // --- Pins --- //
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

  // show radius popup (host edits include ownerClientId)
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

  // --- Sidebar entry: delete + elevation/bearing edits --- //
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
    elevInp.onkeydown = e => {
      if (e.key==='Enter') {
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
    const bearInp = li.querySelector('.bear-inp');
    bearInp.onkeydown = e => {
      if (e.key==='Enter') {
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

  // --- Lines rendering (host and client) --- //
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

  // --- User dot --- //
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

  // --- Clearing helpers --- //
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
    // Also hide host-only shapes when filtering? currently leave shapes visible (host-owned).
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

  // --- Helpers --- //
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
});
