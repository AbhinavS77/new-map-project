// server.js (with shapes, chat support, UDP broadcaster, validation)
// Run: npm install express socket.io
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const dgram = require('dgram');

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, { cors: { origin: "*", methods: ["GET","POST"] } });

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/tiles', express.static(path.join(__dirname, 'India Tiles')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// UDP broadcaster for discovery
(function startBroadcaster() {
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => console.warn('Discovery socket error:', err && err.message));
    const payload = Buffer.from(JSON.stringify({ port: PORT, name: 'CollaborativeMapHost' }));

    function getBroadcastAddresses() {
      const out = new Set();
      out.add('255.255.255.255');
      const nifs = os.networkInterfaces();
      for (const iface of Object.keys(nifs)) {
        for (const entry of nifs[iface]) {
          if (entry.family === 'IPv4' && !entry.internal) {
            try {
              const a = entry.address.split('.').map(n => parseInt(n,10));
              const m = entry.netmask.split('.').map(n => parseInt(n,10));
              const bc = a.map((p,i) => (p & m[i]) | (~m[i] & 0xFF));
              out.add(bc.join('.'));
            } catch(e){}
          }
        }
      }
      return Array.from(out);
    }

    sock.bind(() => {
      try { sock.setBroadcast(true); } catch(e){}
      const addrs = getBroadcastAddresses();
      console.log('Discovery broadcaster will send to', addrs);
      setInterval(()=> {
        for (const addr of addrs) {
          sock.send(payload, 0, payload.length, 41234, addr, (err) => { if (err) console.debug('Discovery send err', err && err.message); });
        }
      }, 1000);
    });
    console.log('UDP discovery started on port 41234');
  } catch (e) { console.warn('UDP broadcaster not started:', e && e.message); }
})();

const clients = new Map(); // socketId -> { name, pinColor, userDotColor, isHost }
const shapes = new Map();
const pins = new Map(); // key `${clientId}_${placementId}` -> pin object
const chatHistory = [];
const MAX_CHAT_HISTORY = 1000;

function makeMsgId(prefix='srv') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
}

io.on('connection', socket => {
  console.log('Connected', socket.id, 'query=', socket.handshake.query);
  const isHost = !!(socket.handshake.query && socket.handshake.query.isHost === 'true');
  clients.set(socket.id, { name: isHost ? 'Host' : socket.id, pinColor: '#ff4d4f', userDotColor: '#1e88e5', isHost });

  // send existing shapes, chat, pins
  socket.emit('shapesUpdated', Array.from(shapes.values()));
  socket.emit('chatHistory', chatHistory.slice(-MAX_CHAT_HISTORY));
  for (const p of pins.values()) {
    socket.emit('pinAdded', {
      clientId: p.clientId,
      clientName: (clients.get(p.clientId) ? clients.get(p.clientId).name : p.clientId),
      id: p.id,
      lat: p.lat,
      lon: p.lon,
      pinColor: p.pinColor,
      rf: !!p.rf,
      groupId: p.groupId || null
    });
    if (p.radius) socket.emit('updateRadius', { clientId: p.clientId, id: p.id, radius: p.radius, color: p.pinColor });
    if (typeof p.elevation !== 'undefined') socket.emit('updateElevation', { clientId: p.clientId, id: p.id, elevation: p.elevation });
    if (typeof p.bearing !== 'undefined') socket.emit('updateBearing', { clientId: p.clientId, id: p.id, bearing: p.bearing });
  }

  socket.on('clientInfo', info => {
    const safe = info && typeof info === 'object' ? info : {};
    const current = clients.get(socket.id) || {};
    const name = safe.name || current.name || (isHost ? 'Host' : socket.id);
    const pinColor = safe.pinColor || current.pinColor || '#ff4d4f';
    const userDotColor = safe.userDotColor || current.userDotColor || '#1e88e5';
    clients.set(socket.id, { name, pinColor, userDotColor, isHost });
    io.emit('clientsUpdated', Array.from(clients.entries()));
    socket.emit('chatHistory', chatHistory.slice(-MAX_CHAT_HISTORY));
    socket.emit('shapesUpdated', Array.from(shapes.values()));
  });

  socket.on('newPin', d => {
    if (!d || typeof d.id === 'undefined') return;
    const info = clients.get(socket.id) || {};
    const entry = {
      clientId: socket.id, id: d.id, lat: d.lat, lon: d.lon,
      pinColor: d.pinColor || info.pinColor || '#ff4d4f',
      rf: !!d.rf, groupId: d.groupId || null, createdAt: Date.now()
    };
    pins.set(`${socket.id}_${d.id}`, entry);
    io.emit('pinAdded', {
      clientId: entry.clientId, clientName: info.name || entry.clientId,
      id: entry.id, lat: entry.lat, lon: entry.lon, pinColor: entry.pinColor, rf: entry.rf, groupId: entry.groupId
    });
  });

  socket.on('removePin', (payload) => {
    const data = (typeof payload === 'string') ? { id: payload } : (payload || {});
    const ownerId = data.ownerClientId || socket.id;
    const requesterIsHost = !!(socket.handshake.query && socket.handshake.query.isHost === 'true');
    if (!requesterIsHost && ownerId !== socket.id) {
      console.warn('Unauthorized removePin by', socket.id, 'for', ownerId);
      return;
    }
    const key = `${ownerId}_${data.id}`;
    if (pins.has(key)) pins.delete(key);
    io.emit('pinRemoved', { clientId: ownerId, id: data.id });
  });

  socket.on('updateRadius', d => {
    const ownerId = (d && d.ownerClientId) ? d.ownerClientId : socket.id;
    const key = `${ownerId}_${d.id}`;
    if (pins.has(key)) { const p = pins.get(key); p.radius = d.radius; pins.set(key, p); }
    io.emit('updateRadius', { clientId: ownerId, id: d.id, radius: d.radius, color: d.color });
  });

  socket.on('updateElevation', d => {
    const ownerId = (d && d.ownerClientId) ? d.ownerClientId : socket.id;
    const key = `${ownerId}_${d.id}`;
    if (pins.has(key)) { const p = pins.get(key); p.elevation = d.elevation; pins.set(key, p); }
    io.emit('updateElevation', { clientId: ownerId, id: d.id, elevation: d.elevation });
  });

  socket.on('updateBearing', d => {
    const ownerId = (d && d.ownerClientId) ? d.ownerClientId : socket.id;
    const key = `${ownerId}_${d.id}`;
    if (pins.has(key)) { const p = pins.get(key); p.bearing = d.bearing; pins.set(key, p); }
    io.emit('updateBearing', { clientId: ownerId, id: d.id, bearing: d.bearing });
  });

  // chat
  socket.on('chatMessage', incoming => {
    try {
      if (!incoming || typeof incoming.text !== 'string') return;
      const now = Date.now();
      const info = clients.get(socket.id) || {};
      const id = (incoming.id && typeof incoming.id === 'string') ? incoming.id : makeMsgId('chat');
      const text = incoming.text.trim().slice(0, 2000);
      if (!text) return;
      const isSenderHost = !!(socket.handshake.query && socket.handshake.query.isHost === 'true');
      const msg = {
        id,
        clientId: socket.id,
        clientName: info.name || socket.id,
        name: info.name || socket.id,
        text,
        ts: incoming.ts || now,
        serverTs: now,
        fromHost: isSenderHost
      };
      chatHistory.push(msg);
      if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();
      io.emit('chatMessage', msg);
    } catch (err) {
      console.error('chatMessage handler error', err && err.message ? err.message : err);
    }
  });

  socket.on('clearChat', () => {
    const requesterIsHost = !!(socket.handshake.query && socket.handshake.query.isHost === 'true');
    if (!requesterIsHost) { console.warn('clearChat attempted by non-host', socket.id); return; }
    chatHistory.length = 0;
    io.emit('chatHistory', chatHistory);
  });

  // shapes (host only)
  socket.on('newShape', shape => {
    const requesterIsHost = !!(socket.handshake.query && socket.handshake.query.isHost === 'true');
    if (!requesterIsHost) return console.warn('Non-host attempted newShape');
    if (!shape || !shape.id) return;
    shapes.set(shape.id, shape);
    io.emit('shapeAdded', shape);
  });
  socket.on('updateShape', shape => {
    const requesterIsHost = !!(socket.handshake.query && socket.handshake.query.isHost === 'true');
    if (!requesterIsHost) return console.warn('Non-host attempted updateShape');
    if (!shape || !shape.id) return;
    shapes.set(shape.id, shape);
    io.emit('shapeUpdated', shape);
  });
  socket.on('removeShape', shapeId => {
    const requesterIsHost = !!(socket.handshake.query && socket.handshake.query.isHost === 'true');
    if (!requesterIsHost) return console.warn('Non-host attempted removeShape');
    if (!shapeId) return;
    shapes.delete(shapeId);
    io.emit('shapeRemoved', shapeId);
  });

  socket.on('userDotPlaced', d => {
    const info = clients.get(socket.id) || {};
    const payload = { clientId: socket.id, clientName: info.name || socket.id, lat: d.lat, lon: d.lon, userDotColor: info.userDotColor };
    socket.emit('userDotPlacedAck', payload);
    io.emit('userDotPlaced', payload);
  });

  socket.on('clearClientPins', () => {
    for (const key of Array.from(pins.keys())) {
      if (key.startsWith(socket.id + '_')) {
        const id = pins.get(key).id;
        pins.delete(key);
        io.emit('pinRemoved', { clientId: socket.id, id });
      }
    }
    io.emit('clientCleared', { clientId: socket.id });
  });

  socket.on('clearAll', () => {
    pins.clear();
    shapes.clear();
    chatHistory.length = 0;
    io.emit('allCleared');
  });

  socket.on('disconnect', () => {
    console.log('Disconnected', socket.id);
    clients.delete(socket.id);
    io.emit('clientsUpdated', Array.from(clients.entries()));
    io.emit('clientDisconnected', socket.id);
    for (const key of Array.from(pins.keys())) {
      if (key.startsWith(socket.id + '_')) {
        const id = pins.get(key).id;
        pins.delete(key);
        io.emit('pinRemoved', { clientId: socket.id, id });
      }
    }
  });

  io.emit('clientsUpdated', Array.from(clients.entries()));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}/`);
});
