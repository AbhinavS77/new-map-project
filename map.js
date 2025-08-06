// map.js
document.addEventListener('DOMContentLoaded', () => {
  // UI refs
  const modal       = document.getElementById('connection-modal');
  const hostBtn     = document.getElementById('host-btn');
  const clientBtn   = document.getElementById('client-btn');
  const ipInput     = document.getElementById('ip-address-input');
  const clientFields = document.getElementById('client-fields');
  const clientNameInput = document.getElementById('client-name-input');
  const pinColorInput = document.getElementById('pin-color-input');
  const userDotColorInput = document.getElementById('user-dot-color-input');
  const serverBtn = document.getElementById('server-btn');
  const serverPanel = document.getElementById('server-panel');
  const clientButtons = document.getElementById('client-buttons');
  const allIndiaBtn = document.getElementById('all-india-btn');
  const userBtn     = document.getElementById('user-toggle-btn');
  const pinBtn      = document.getElementById('pin-toggle-btn');
  const clearBtn    = document.getElementById('clear-btn');
  const panelToggle = document.getElementById('panel-toggle-btn');
  const sidebar     = document.getElementById('pinned-locations');
  const rightPanel  = document.getElementById('right-panel');
  const container   = document.getElementById('main-container');
  const statusBar   = document.getElementById('status-popup');

  // State
  let map, socket;
  let isUserMode = false, isPinMode = false;
  let userMarker = null, userSidebar = null;
  const pins = {};   // id -> { marker, radiusCircle, elevation, bearing }
  const lines = {};  // id -> polyline

  // Session control
  let isHost = false;
  let selectedClientId = null;

  hostBtn.addEventListener('click', async () => {
    await window.electronAPI.startHost();
    isHost = true;
    initApp('http://localhost:3000');
    serverBtn.classList.add('visible');
  });

  clientBtn.addEventListener('click', () => {
    clientFields.style.display = 'block';
    hostBtn.style.display = 'none';
    
    if (!clientNameInput.value.trim()) {
      return alert('Please enter your name');
    }
    
    const ip = ipInput.value.trim();
    if (!ip) return alert('Enter Host IP.');
    
    isHost = false;
    initApp(`http://${ip}:3000`);
    
    // Send client info to server
    socket.emit('clientInfo', {
      name: clientNameInput.value.trim(),
      pinColor: pinColorInput.value,
      userDotColor: userDotColorInput.value
    });
  });

  // Server panel controls
  serverBtn.addEventListener('click', () => {
    serverPanel.classList.add('open');
  });

  document.addEventListener('click', e => {
    if (!serverPanel.contains(e.target) && e.target !== serverBtn) {
      serverPanel.classList.remove('open');
    }
  });

  allIndiaBtn.addEventListener('click', () => {
    selectedClientId = null;
    showAllClients();
    serverPanel.classList.remove('open');
  });

  function showAllClients() {
    // Show all pins and user dots
    Object.values(pins).forEach(p => {
      p.marker.setOpacity(1);
      if (p.radiusCircle) p.radiusCircle.setStyle({ opacity: 1, fillOpacity: 0.3 });
    });
    updateLines();
  }

  function showClientData(clientId) {
    selectedClientId = clientId;
    // Hide all pins first
    Object.entries(pins).forEach(([id, p]) => {
      if (id.split('_')[0] !== clientId) {
        p.marker.setOpacity(0.2);
        if (p.radiusCircle) p.radiusCircle.setStyle({ opacity: 0.2, fillOpacity: 0.1 });
      } else {
        p.marker.setOpacity(1);
        if (p.radiusCircle) p.radiusCircle.setStyle({ opacity: 1, fillOpacity: 0.3 });
      }
    });
    updateLines();
  }

  // Mode toggles
  userBtn.addEventListener('click', () => {
    isUserMode = !isUserMode;
    if (isUserMode) { isPinMode = false; pinBtn.classList.remove('active'); pinBtn.textContent = 'Pin Mode OFF'; }
    userBtn.classList.toggle('active', isUserMode);
    userBtn.textContent = `User Mode ${isUserMode? 'ON':'OFF'}`;
  });
  pinBtn.addEventListener('click', () => {
    isPinMode = !isPinMode;
    if (isPinMode) { isUserMode = false; userBtn.classList.remove('active'); userBtn.textContent = 'User Mode OFF'; }
    pinBtn.classList.toggle('active', isPinMode);
    pinBtn.textContent = `Pin Mode ${isPinMode? 'ON':'OFF'}`;
  });

  // Clear all
  clearBtn.addEventListener('click', () => {
    if (!socket) return;
    socket.emit('clearPins');
    clearAll();
  });

  panelToggle.addEventListener('click', () => {
    const open = rightPanel.classList.toggle('open');
    panelToggle.classList.toggle('open', open);
  });

  // Initialize
  function initApp(serverUrl) {
    modal.style.display = 'none';
    container.classList.add('active');

    if (!map) {
      map = L.map('map').setView([20.5937,78.9629],5);
      L.tileLayer('India Tiles/{z}/{x}/{y}.png',{
        minZoom:0,maxZoom:18,attribution:'© Your Tiles'
      }).addTo(map);

      map.on('click', e => {
        if (isUserMode) {
          placeUserDot(e.latlng, true);
        } else if (isPinMode) {
          const id = Date.now().toString();
          socket.emit('newPin', { id, lat: e.latlng.lat, lon: e.latlng.lng });
        }
      });
    }
    setTimeout(()=>map.invalidateSize(),200);

    socket = io(serverUrl);
    socket.on('connect', ()=>showStatus('Connected!'));
    
    socket.on('clientsUpdated', clients => {
      if (isHost) {
        // Update client buttons
        clientButtons.innerHTML = '';
        clients.forEach(([clientId, info]) => {
          const btn = document.createElement('button');
          btn.className = 'client-btn';
          btn.textContent = info.name;
          btn.onclick = () => {
            showClientData(clientId);
            serverPanel.classList.remove('open');
          };
          clientButtons.appendChild(btn);
        });
      }
    });

    socket.on('pinAdded', d => { 
      const pinId = `${d.clientId}_${d.id}`;
      addPin(pinId, d.lat, d.lon, d.clientName, d.clientId); 
    });
    
    socket.on('pinRemoved', d => { 
      const pinId = `${d.clientId}_${d.id}`;
      removePin(pinId); 
    });
    
    socket.on('pinsCleared', d => { 
      if (!selectedClientId || selectedClientId === d.clientId) {
        clearAll(d.clientId); 
      }
    });
    
    socket.on('updateRadius', d => { 
      const pinId = `${d.clientId}_${d.id}`;
      applyRemoteRadius(pinId, d.radius); 
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
      if (!selectedClientId || selectedClientId === d.clientId) {
        placeUserDot(L.latLng(d.lat, d.lon), false, d.clientName, d.userDotColor);
      }
    });
    
    socket.on('clientDisconnected', clientId => {
      if (selectedClientId === clientId) {
        selectedClientId = null;
        showAllClients();
      }
    });
    
    socket.on('connect_error', e => {
      alert('Connection failed: '+e.message);
      location.reload();
    });
  }

  // --- Pin logic ---
  function addPin(id, lat, lon, clientName, clientId) {
    if (pins[id]) return;
    
    const marker = L.marker([lat,lon]).addTo(map);
    let radiusCircle = null;
    
    pins[id] = { 
      marker, 
      radiusCircle, 
      elevation: 0, 
      bearing: 0,
      clientId,
      clientName 
    };
    
    marker.on('click',()=>showRadiusPopup(id));
    renderSidebarEntry(id);
    
    if (selectedClientId && clientId !== selectedClientId) {
      marker.setOpacity(0.2);
    }
    
    updateLines();
  }

  function showRadiusPopup(id) {
    const { marker, radiusCircle } = pins[id];
    marker.closePopup(); marker.unbindPopup();
    const ui = L.DomUtil.create('div','pin-popup');
    ui.innerHTML=      `<input type="number" placeholder="Distance in km" style="width:120px;margin-bottom:5px;"/>
      <br><button>OK</button>`
    ;    const inp=ui.querySelector('input'), btn=ui.querySelector('button');
    btn.addEventListener('click',()=>{
      const km=parseFloat(inp.value);
      if(isNaN(km)||km<=0)return alert('Enter valid kilometers');
      const m=km*1000;
      if(pins[id].radiusCircle) map.removeLayer(pins[id].radiusCircle);
      pins[id].radiusCircle = L.circle(marker.getLatLng(),{
        radius:m, color:'red', fillColor:'red', fillOpacity:0.3, interactive:false
      }).addTo(map);
      socket.emit('updateRadius',{id, radius:m});
      renderSidebarEntry(id);
      marker.closePopup();
      updateLines();
    });
    marker.bindPopup(ui).openPopup();
  }

  function applyRemoteRadius(id, radius) {
    const p = pins[id];
    if (!p) return;
    if (p.radiusCircle) map.removeLayer(p.radiusCircle);
    p.radiusCircle = L.circle(p.marker.getLatLng(),{
      radius, color:'red', fillColor:'red', fillOpacity:0.3, interactive:false
    }).addTo(map);
    renderSidebarEntry(id);
    updateLines();
  }

  function applyRemoteElevation(id, elevation) {
    const p = pins[id];
    if (!p) return;
    p.elevation = elevation;
    renderSidebarEntry(id);
  }
  function applyRemoteBearing(id, bearing) {
    const p = pins[id];
    if (!p) return;
    p.bearing = bearing;
    renderSidebarEntry(id);
  }

  function removePin(id) {
    const p = pins[id];
    if (!p) return;
    map.removeLayer(p.marker);
    if (p.radiusCircle) map.removeLayer(p.radiusCircle);
    delete pins[id];
    const li = sidebar.querySelector(`li[data-id="${id}"]`);
    if (li) li.remove();
    updateLines();
  }

  // --- Sidebar rendering ---
  function renderSidebarEntry(id) {
    const p = pins[id];
    const latlng = p.marker.getLatLng();
    let li = sidebar.querySelector(`li[data-id="${id}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.id = id;
      sidebar.appendChild(li);
    }
    li.innerHTML = `
      <div class="top-row">
        <span class="pin-data">Lat:${latlng.lat.toFixed(4)}, Lon:${latlng.lng.toFixed(4)}</span>
        <button class="delete-btn">&times;</button>
      </div>
      <div class="pin-data">Radius: ${(p.radiusCircle? (p.radiusCircle.getRadius()/1000).toFixed(2)+' km' : '0.00 km')}</div>
      <div class="pin-data">
        <label>Elevation:</label>
        <input type="number" value="${p.elevation}" />
      </div>
      <div class="pin-data">
        <label>Bearing Units:</label>
        <input type="number" value="${p.bearing}" />
      </div>
    `;
    // delete
    li.querySelector('.delete-btn').onclick = ()=>socket.emit('removePin', id);
    // elevation input
    const elevInp = li.querySelector('div:nth-of-type(3) input');
    elevInp.onkeydown = e => {
      if (e.key === 'Enter') {
        const val = parseFloat(elevInp.value) || 0;
        p.elevation = val;
        socket.emit('updateElevation', {id, elevation: val});
      }
    };
    // bearing input
    const bearInp = li.querySelector('div:nth-of-type(4) input');
    bearInp.onkeydown = e => {
      if (e.key === 'Enter') {
        const val = parseFloat(bearInp.value) || 0;
        p.bearing = val;
        socket.emit('updateBearing', {id, bearing: val});
      }
    };
  }

  // Save & load local pins (optional)
  function savePins() {
    const out = {};
    for (const id in pins) {
      const p = pins[id];
      out[id] = {
        lat: p.marker.getLatLng().lat,
        lon: p.marker.getLatLng().lng,
        radius: p.radiusCircle ? p.radiusCircle.getRadius() : 0,
        elevation: p.elevation,
        bearing: p.bearing
      };
    }
    localStorage.setItem('pins', JSON.stringify(out));
  }
  function loadSavedPins() {
    const saved = JSON.parse(localStorage.getItem('pins')||'{}');
    for (const id in saved) {
      const s = saved[id];
      addPin(id, s.lat, s.lon);
      if (s.radius) applyRemoteRadius(id, s.radius);
      if (s.elevation) applyRemoteElevation(id, s.elevation);
      if (s.bearing)   applyRemoteBearing(id, s.bearing);
    }
  }

  // --- Lines ---
  function updateLines() {
    // clear
    for (const id in lines) {
      map.removeLayer(lines[id]);
      delete lines[id];
    }
    if (!userMarker) return;
    const u = userMarker.getLatLng();
    for (const id in pins) {
      const p = pins[id].marker.getLatLng();
      const poly = L.polyline([u,p],{color:'red'}).addTo(map);
      const dist = (u.distanceTo(p)/1000).toFixed(2)+' km';
      poly.bindTooltip(dist,{sticky:true});
      poly.on('mouseover',()=>poly.openTooltip());
      poly.on('mouseout', ()=>poly.closeTooltip());
      lines[id]=poly;
    }
  }

  // --- User dot ---
  function placeUserDot(latlng, renderOnly, clientName, userDotColor = null) {
    if (userMarker) { map.removeLayer(userMarker); userMarker=null; }
    if (userSidebar){ userSidebar.remove(); userSidebar=null; }
    userMarker = L.circleMarker(latlng,{
      radius:8, color:'white', weight:3,
      fillColor:'blue', fillOpacity:1, interactive:true
    }).addTo(map);
    userMarker.on('click',()=>{
      const c=`Lat:${latlng.lat.toFixed(4)}<br>Lon:${latlng.lng.toFixed(4)}`;
      userMarker.bindPopup(c).openPopup();
      setTimeout(()=>userMarker.closePopup(),3000);
    });
    userSidebar = document.createElement('li');
    userSidebar.classList.add('user-dot');
    userSidebar.innerHTML=`
      <span>Lat:${latlng.lat.toFixed(4)}, Lon:${latlng.lng.toFixed(4)}</span>
      <button class="delete-btn">&times;</button>
    `;
    userSidebar.querySelector('button').onclick=()=>{
      map.removeLayer(userMarker);userMarker=null;
      userSidebar.remove(); updateLines();
    };
    sidebar.appendChild(userSidebar);
    if (renderOnly) {
      socket.emit('userDotPlaced',{lat:latlng.lat,lon:latlng.lng});
      isUserMode=false; userBtn.classList.remove('active'); userBtn.textContent='User Mode OFF';
    }
    updateLines();
  }

  // --- Clear all ---
  function clearAll() {
    Object.values(pins).forEach(p=>{
      map.removeLayer(p.marker);
      if(p.radiusCircle)map.removeLayer(p.radiusCircle);
    });
    Object.keys(pins).forEach(k=>delete pins[k]);
    if(userMarker){map.removeLayer(userMarker);userMarker=null;}
    if(userSidebar){userSidebar.remove();userSidebar=null;}
    sidebar.innerHTML='';
    updateLines();
  }

  // --- Status popup ---
  function showStatus(msg) {
    statusBar.textContent = msg;
    statusBar.style.bottom = '20px';
    setTimeout(()=>statusBar.style.bottom='-80px',3000);
  }

  // Load from localStorage if desired
  loadSavedPins();
});