const socket = io();

const map = L.map('map').setView([20.5937, 78.9629], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

const pins = {};  // Track pins by ID
const uiElements = {};
const circles = {};

function createRadiusUI(marker, id, latlng) {
  const ui = document.createElement('div');
  ui.className = 'radius-ui';
  ui.innerHTML = `
    Radius (m): <input type="number" value="1000" style="width: 60px" />
    <button>OK</button>
  `;
  document.body.appendChild(ui);

  // Position it relative to the map container
  const updatePosition = () => {
    const pos = map.latLngToContainerPoint(latlng);
    ui.style.left = `${pos.x}px`;
    ui.style.top = `${pos.y}px`;
  };
  updatePosition();

  map.on('move zoom', updatePosition);

  let circle = null;
  const input = ui.querySelector('input');
  const button = ui.querySelector('button');

  button.addEventListener('click', () => {
    const radius = parseFloat(input.value);
    if (circles[id]) {
      map.removeLayer(circles[id]);
    }
    circle = L.circle(latlng, { radius, color: 'blue' }).addTo(map);
    circles[id] = circle;

    socket.emit('update-radius', { id, radius });
  });

  uiElements[id] = ui;
}

function removeUIAndCircle(id) {
  if (uiElements[id]) {
    uiElements[id].remove();
    delete uiElements[id];
  }
  if (circles[id]) {
    map.removeLayer(circles[id]);
    delete circles[id];
  }
}

function addPin(latlng, id = Date.now().toString()) {
  const marker = L.marker(latlng).addTo(map);
  pins[id] = marker;

  let uiVisible = false;

  marker.on('click', () => {
    if (uiVisible) {
      removeUIAndCircle(id);
      uiVisible = false;
    } else {
      removeUIAndCircle(id);  // remove if already shown before
      createRadiusUI(marker, id, latlng);
      uiVisible = true;
    }
  });

  marker.on('contextmenu', () => {
    map.removeLayer(marker);
    removeUIAndCircle(id);
    socket.emit('remove-pin', id);
  });

  return id;
}

// Client adds pin
map.on('click', e => {
  const id = addPin(e.latlng);
  socket.emit('add-pin', { latlng: e.latlng, id });
});

// Handle incoming pins
socket.on('add-pin', data => {
  if (!pins[data.id]) addPin(data.latlng, data.id);
});

socket.on('update-radius', ({ id, radius }) => {
  const marker = pins[id];
  if (!marker) return;
  const latlng = marker.getLatLng();

  if (circles[id]) {
    map.removeLayer(circles[id]);
  }

  const circle = L.circle(latlng, { radius, color: 'blue' }).addTo(map);
  circles[id] = circle;
});

socket.on('remove-pin', id => {
  if (pins[id]) {
    map.removeLayer(pins[id]);
    delete pins[id];
  }
  removeUIAndCircle(id);
});
