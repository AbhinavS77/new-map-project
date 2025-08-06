// map.js
document.addEventListener('DOMContentLoaded', () => {
  // UI refs
  const modal       = document.getElementById('connection-modal');
  const hostBtn     = document.getElementById('host-btn');
  const clientBtn   = document.getElementById('client-btn');
  const ipInput     = document.getElementById('ip-address-input');
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
  hostBtn.addEventListener('click', async () => {
    await window.electronAPI.startHost();
    initApp('http://localhost:3000');
  });
  clientBtn.addEventListener('click', () => {
    const ip = ipInput.value.trim();
    if (!ip) return alert('Enter Host IP.');
    initApp(`http://${ip}:3000`);
  });

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
    socket.on('connect',      ()=>showStatus('Connected!'));
    socket.on('pinAdded',     d=>{ addPin(d.id,d.lat,d.lon); });
    socket.on('pinRemoved',   id=>{ removePin(id); });
    socket.on('pinsCleared',  ()=>{ clearAll(); });
    socket.on('updateRadius', d=>{ applyRemoteRadius(d.id,d.radius); });
    socket.on('updateElevation', d=>{ applyRemoteElevation(d.id,d.elevation); });
    socket.on('updateBearing', d=>{ applyRemoteBearing(d.id,d.bearing); });
    socket.on('userDotPlaced',d=>{ placeUserDot(L.latLng(d.lat,d.lon),false); });
    socket.on('connect_error', e=>{
      alert('Connection failed: '+e.message);
      location.reload();
    });
  }

  // --- Pin logic ---
  function addPin(id, lat, lon) {
    if (pins[id]) return;
    const marker = L.marker([lat,lon]).addTo(map);
    let radiusCircle = null;
    pins[id] = { marker, radiusCircle, elevation: 0, bearing: 0 };
    marker.on('click',()=>showRadiusPopup(id));
    renderSidebarEntry(id);
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
  function placeUserDot(latlng, renderOnly) {
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