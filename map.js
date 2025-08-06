document.addEventListener('DOMContentLoaded', () => {
  const modal       = document.getElementById('connection-modal');
  const hostBtn     = document.getElementById('host-btn');
  const clientBtn   = document.getElementById('client-btn');
  const ipInput     = document.getElementById('ip-address-input');
  const pinToggle   = document.getElementById('pin-toggle-btn');
  const clearBtn    = document.getElementById('clear-btn');
  const panelToggle = document.getElementById('panel-toggle-btn');
  const sidebar     = document.getElementById('pinned-locations');
  const rightPanel  = document.getElementById('right-panel');
  const container   = document.getElementById('main-container');
  const statusBar   = document.getElementById('status-popup');

  let map, socket, isPinning = false;
  const pins = {};

  hostBtn.addEventListener('click', async () => {
    await window.electronAPI.startHost();
    initApp('http://localhost:3000');
  });

  clientBtn.addEventListener('click', () => {
    const ip = ipInput.value.trim();
    if (!ip) return alert('Enter Host IP.');
    initApp(`http://${ip}:3000`);
  });

  pinToggle.addEventListener('click', () => {
    isPinning = !isPinning;
    pinToggle.textContent = `Pin Mode ${isPinning ? 'ON' : 'OFF'}`;
    pinToggle.classList.toggle('active', isPinning);
  });

  clearBtn.addEventListener('click', () => {
    if (!socket) return;
    socket.emit('clearPins');
  });

  panelToggle.addEventListener('click', () => {
    const open = rightPanel.classList.toggle('open');
    panelToggle.classList.toggle('open', open);
    // no map.invalidateSize() needed—overlay doesn’t affect map
  });

  function initApp(serverUrl) {
    modal.style.display = 'none';
    container.classList.add('active');

    if (!map) {
      map = L.map('map').setView([20.59, 78.96], 5);
      L.tileLayer('India Tiles/{z}/{x}/{y}.png', {
        minZoom: 0, maxZoom: 18, attribution: '© OSM'
      }).addTo(map);

      map.on('click', e => {
        if (!isPinning || !socket) return;
        const id = Date.now().toString();
        socket.emit('newPin', { id, lat: e.latlng.lat, lon: e.latlng.lng });
      });
    }

    setTimeout(() => map.invalidateSize(), 200);

    socket = io(serverUrl);
    socket.on('connect',      ()    => showStatus('Connected!'));
    socket.on('pinAdded',     d     => addPin(d.lat, d.lon, d.id));
    socket.on('pinRemoved',   id    => removePin(id));
    socket.on('pinsCleared',         clearAllPins);
    socket.on('connect_error', e     => {
      alert('Connection failed: ' + e.message);
      location.reload();
    });

    loadSavedPins();
  }

  function addPin(lat, lon, id) {
    if (pins[id]) return;
    pins[id] = L.marker([lat, lon]).addTo(map);

    const li = document.createElement('li');
    li.dataset.id = id;
    li.innerHTML = `
      <span>Lat:${lat.toFixed(4)}, Lon:${lon.toFixed(4)}</span>
      <button class="delete-btn">&times;</button>`;
    sidebar.appendChild(li);
    li.querySelector('button').onclick = () => socket.emit('removePin', id);

    savePins();
  }

  function removePin(id) {
    if (!pins[id]) return;
    map.removeLayer(pins[id]);
    delete pins[id];
    const li = sidebar.querySelector(`li[data-id="${id}"]`);
    if (li) li.remove();
    savePins();
  }

  function clearAllPins() {
    for (const id in pins) map.removeLayer(pins[id]);
    Object.keys(pins).forEach(key => delete pins[key]);
    sidebar.innerHTML = '';
    localStorage.removeItem('pins');
  }

  function savePins() {
    const out = {};
    for (const id in pins) {
      const { lat, lng } = pins[id].getLatLng();
      out[id] = { lat, lon: lng };
    }
    localStorage.setItem('pins', JSON.stringify(out));
  }

  function loadSavedPins() {
    const saved = JSON.parse(localStorage.getItem('pins') || '{}');
    for (const id in saved) addPin(saved[id].lat, saved[id].lon, id);
  }

  function showStatus(msg) {
    statusBar.textContent = msg;
    statusBar.style.bottom = '20px';
    setTimeout(() => (statusBar.style.bottom = '-80px'), 3000);
  }
});
