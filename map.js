// map.js
// Helper function to convert hex color to hue rotation
function getHueRotation(hexColor) {
  // Convert hex to RGB
  const r = parseInt(hexColor.substring(1,3), 16) / 255;
  const g = parseInt(hexColor.substring(3,5), 16) / 255;
  const b = parseInt(hexColor.substring(5,7), 16) / 255;
  
  // Get HSL
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  
  if (max === min) h = 0;
  else if (max === r) h = 60 * ((g - b) / (max - min));
  else if (max === g) h = 60 * (2 + (b - r) / (max - min));
  else h = 60 * (4 + (r - g) / (max - min));
  
  if (h < 0) h += 360;
  
  // Default marker is blue (240 degrees), so subtract that
  return h - 240;
}

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
  const userDots = {}; // clientName -> dot marker (host only)

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
    serverPanel.classList.toggle('open');
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
        // Completely hide other clients' pins
        p.marker.setOpacity(0);
        if (p.radiusCircle) p.radiusCircle.setStyle({ opacity: 0, fillOpacity: 0 });
      } else {
        p.marker.setOpacity(1);
        if (p.radiusCircle) p.radiusCircle.setStyle({ opacity: 1, fillOpacity: 0.3 });
      }
    });
    
    // Hide other clients' user dots
    Object.entries(userDots).forEach(([name, dot]) => {
      const dotClientId = dot.clientId;
      if (dotClientId !== clientId) {
        dot.setOpacity(0);
      } else {
        dot.setOpacity(1);
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

    socket = io(serverUrl, {
      query: { isHost }
    });
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
      if (isHost) {
        // For host: maintain separate dots for each client
        if (userDots[d.clientId]) {
          map.removeLayer(userDots[d.clientId]);
        }
        const dot = L.circleMarker(L.latLng(d.lat, d.lon), {
          radius: 8,
          color: 'white',
          weight: 3,
          fillColor: d.userDotColor || '#2196F3',
          fillOpacity: 1,
          interactive: true
        }).addTo(map);
        
        dot.clientId = d.clientId;
        dot.bindTooltip(d.clientName, {
          permanent: false,
          direction: 'top',
          className: 'user-dot-tooltip'
        });
        
        userDots[d.clientId] = dot;
        
        // Update visibility based on selected client
        if (selectedClientId && selectedClientId !== d.clientId) {
          dot.setOpacity(0);
        }
        updateLines();
      } else if (!selectedClientId || selectedClientId === d.clientId) {
        // For clients: only show their own dot
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
  function addPin(id, lat, lon, clientName, clientId, pinColor) {
    if (pins[id]) return;
    
    // Set custom icon path for all markers
    L.Icon.Default.prototype.options.imagePath = 'public/images/';
    
    const marker = L.marker([lat,lon]).addTo(map);
    // Apply pin color by tinting the icon
    if (pinColor) {
      marker.getElement().style.filter = `hue-rotate(${getHueRotation(pinColor)}deg)`;
    }
    let radiusCircle = null;
    
    pins[id] = { 
      marker, 
      radiusCircle, 
      elevation: 0, 
      bearing: 0,
      clientId,
      clientName,
      pinColor 
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
      const pinColor = pins[id].pinColor || 'red';
      pins[id].radiusCircle = L.circle(marker.getLatLng(),{
        radius:m, 
        color: pinColor,
        fillColor: pinColor,
        fillOpacity:0.3, 
        interactive:false,
        opacity: pins[id].marker.options.opacity || 1
      }).addTo(map);
      socket.emit('updateRadius',{id, radius:m, color: pinColor});
      renderSidebarEntry(id);
      marker.closePopup();
      updateLines();
    });
    marker.bindPopup(ui).openPopup();
  }

  function applyRemoteRadius(id, radius, color) {
    const p = pins[id];
    if (!p) return;
    if (p.radiusCircle) map.removeLayer(p.radiusCircle);
    const pinColor = color || p.pinColor || 'red';
    p.radiusCircle = L.circle(p.marker.getLatLng(), {
      radius,
      color: pinColor,
      fillColor: pinColor,
      fillOpacity: 0.3,
      interactive: false,
      opacity: p.marker.options.opacity || 1
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
    // clear existing lines
    for (const id in lines) {
      map.removeLayer(lines[id]);
      delete lines[id];
    }

    if (isHost) {
      // In host mode, connect each user dot to their pins
      Object.entries(userDots).forEach(([clientName, dot]) => {
        if (!dot.getLatLng()) return;
        
        const dotClientId = dot.clientId;
        // Skip if we're filtering and this isn't the selected client
        if (selectedClientId && dotClientId !== selectedClientId) return;
        
        Object.entries(pins).forEach(([pinId, pin]) => {
          if (pinId.split('_')[0] === dotClientId) {
            const poly = L.polyline([dot.getLatLng(), pin.marker.getLatLng()], {
              color: pin.pinColor || 'red',
              opacity: pin.marker.options.opacity // Match pin visibility
            }).addTo(map);
            
            const dist = (dot.getLatLng().distanceTo(pin.marker.getLatLng())/1000).toFixed(2)+' km';
            poly.bindTooltip(dist, {sticky: true});
            poly.on('mouseover', () => poly.openTooltip());
            poly.on('mouseout', () => poly.closeTooltip());
            lines[pinId] = poly;
          }
        });
      });
    } else {
      // In client mode, connect user dot to own pins
      if (!userMarker || !userMarker.getLatLng()) return;
      
      const userLatLng = userMarker.getLatLng();
      Object.entries(pins).forEach(([id, pin]) => {
        // Check if this pin belongs to the current client
        if (id.startsWith(socket.id)) {
          const poly = L.polyline([userLatLng, pin.marker.getLatLng()], {
            color: pin.pinColor || 'red',
            opacity: pin.marker.options.opacity || 1
          }).addTo(map);
          
          const dist = (userLatLng.distanceTo(pin.marker.getLatLng())/1000).toFixed(2)+' km';
          poly.bindTooltip(dist, {sticky: true});
          poly.on('mouseover', () => poly.openTooltip());
          poly.on('mouseout', () => poly.closeTooltip());
          lines[id] = poly;
        }
      });
    }
  }

    // --- User dot ---
  function placeUserDot(latlng, renderOnly, clientName, userDotColor = null) {
    if (!isHost && userMarker) {
      map.removeLayer(userMarker);
      userMarker = null;
      if (userSidebar) {
        userSidebar.remove();
        userSidebar = null;
      }
    }

    const dotColor = userDotColor || '#2196F3';
    const dot = L.circleMarker(latlng, {
      radius: 8,
      color: 'white',
      weight: 3,
      fillColor: dotColor,
      fillOpacity: 1,
      interactive: true,
      clientId: socket.id // Store client ID with the dot
    }).addTo(map);    if (isHost) {
      dot.bindTooltip(clientName, {
        permanent: false,
        direction: 'top',
        className: 'user-dot-tooltip'
      });
    }

    if (!isHost) {
      userMarker = dot;
    } else {
      userDots[clientName] = dot;
    }
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