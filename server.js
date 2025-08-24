// server.js (with shapes, chat support, UDP broadcaster, validation)
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const dgram = require('dgram');

const app = express();
const httpServer = createServer(app);

// enable CORS for socket.io (helps Electron clients connecting from file:// or other origins)
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/tiles', express.static(path.join(__dirname, 'India Tiles')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// UDP broadcaster (discovery)
(function startBroadcaster() {
  try {
    const sock = dgram.createSocket('udp4');
    const payload = JSON.stringify({ port: PORT, name: 'CollaborativeMapHost' });
    sock.bind(() => {
      sock.setBroadcast(true);
      setInterval(() => {
        sock.send(payload, 0, payload.length, 41234, '255.255.255.255', (err) => { if (err) console.error(err); });
      }, 1000);
    });
    console.log('UDP broadcaster started (port 41234).');
  } catch (e) {
    console.warn('UDP broadcaster not started:', e);
  }
})();

const clients = new Map();
// shapes: Map shapeId -> shapeObject
const shapes = new Map();

// --- Chat state & limits (in-memory) ---
const chatHistory = [];
const MAX_CHAT_HISTORY = 500;        // keep last N messages
const MAX_MESSAGE_LENGTH = 1000;    // trim/limit message size
const MIN_MS_BETWEEN_MSG = 300;     // simple per-socket anti-spam (ms)

// helper to find host socket (single host design)
function findHostSocket() {
  return Array.from(io.sockets.sockets.values()).find(s => s.handshake.query && s.handshake.query.isHost === 'true');
}

io.on('connection', socket => {
  console.log('Connected:', socket.id, socket.handshake.query);

  // Send existing shapes to newly connected socket
  socket.emit('shapesUpdated', Array.from(shapes.values()));
  // Send chat history to newly connected socket
  socket.emit('chatHistory', chatHistory);

  // init per-socket rate-limit state
  socket._lastChatTs = 0;

  socket.on('clientInfo', info => {
    clients.set(socket.id, info || {});
    io.emit('clientsUpdated', Array.from(clients.entries()));
  });

  // NEW PIN: prefer client-sent pinColor (so RF green stays green)
  socket.on('newPin', d => {
    const info = clients.get(socket.id) || {};
    const payload = {
      ...d,
      clientId: socket.id,
      clientName: info.name,
      // prefer client-specified color; fallback to saved client preference
      pinColor: (d && d.pinColor) ? d.pinColor : info.pinColor
    };
    // broadcast to everyone (host + all clients)
    io.emit('pinAdded', payload);
  });

  // --- CHAT: incoming messages ---
  socket.on('chatMessage', incoming => {
    try {
      if (!incoming || typeof incoming.text !== 'string') return;
      const now = Date.now();

      // rate-limit (simple)
      if (now - (socket._lastChatTs || 0) < MIN_MS_BETWEEN_MSG) {
        console.warn(`Rate limited chat from ${socket.id}`);
        return;
      }
      socket._lastChatTs = now;

      // normalize message
      const text = incoming.text.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) return;

      const info = clients.get(socket.id) || {};
      const msg = {
        clientId: socket.id,
        name: info.name || socket.id,
        text,
        ts: incoming.ts || now
      };

      // push to history (sliding window)
      chatHistory.push(msg);
      if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();

      // broadcast to all connected clients
      io.emit('chatMessage', msg);
    } catch (err) {
      console.error('chatMessage handler error', err);
    }
  });

  // optional: allow host to clear chat history
  socket.on('clearChat', () => {
    if (socket.handshake.query && socket.handshake.query.isHost === 'true') {
      chatHistory.length = 0;
      io.emit('chatHistory', chatHistory);
    } else {
      console.warn(`Non-host attempted clearChat: ${socket.id}`);
    }
  });

  // SHAPE EVENTS (host-only)
  socket.on('newShape', shape => {
    if (!socket.handshake.query || socket.handshake.query.isHost !== 'true') {
      console.warn(`Non-host attempted newShape: ${socket.id}`);
      return;
    }
    if (!shape || !shape.id) return;
    shapes.set(shape.id, shape);
    io.emit('shapeAdded', shape);
  });

  socket.on('updateShape', shape => {
    if (!socket.handshake.query || socket.handshake.query.isHost !== 'true') {
      console.warn(`Non-host attempted updateShape: ${socket.id}`);
      return;
    }
    if (!shape || !shape.id) return;
    shapes.set(shape.id, shape);
    io.emit('shapeUpdated', shape);
  });

  socket.on('removeShape', shapeId => {
    if (!socket.handshake.query || socket.handshake.query.isHost !== 'true') {
      console.warn(`Non-host attempted removeShape: ${socket.id}`);
      return;
    }
    if (!shapeId) return;
    shapes.delete(shapeId);
    io.emit('shapeRemoved', shapeId);
  });

  // removePin (owner + host)
  socket.on('removePin', (payload) => {
    const data = (typeof payload === 'string') ? { id: payload } : (payload || {});
    const ownerId = data.ownerClientId || socket.id;
    const requesterIsHost = socket.handshake.query && socket.handshake.query.isHost === 'true';
    if (!requesterIsHost && ownerId !== socket.id) {
      console.warn(`Unauthorized removePin attempt by ${socket.id} for owner ${ownerId}`);
      return;
    }

    const hostSocket = findHostSocket();
    const ownerSocket = io.sockets.sockets.get(ownerId);

    if (hostSocket) hostSocket.emit('pinRemoved', { id: data.id, clientId: ownerId });
    if (ownerSocket) ownerSocket.emit('pinRemoved', { id: data.id, clientId: ownerId });

    io.emit('pinRemoved', { id: data.id, clientId: ownerId });
  });

  socket.on('clearClientPins', () => {
    const hostSocket = findHostSocket();
    if (hostSocket) hostSocket.emit('clientCleared', { clientId: socket.id });
    socket.emit('clientCleared', { clientId: socket.id });
    io.emit('clientCleared', { clientId: socket.id });
  });

  socket.on('clearAll', () => {
    shapes.clear(); // clear shapes too when host clears all
    io.emit('allCleared');
  });

  // Forwarding updates for radius/elevation/bearing with ownerClientId support
  function forwardToHostAndOwner(eventName, payload) {
    const ownerId = payload.ownerClientId || socket.id; // if host is sender, ownerClientId must be included
    const hostSocket = findHostSocket();
    const ownerSocket = io.sockets.sockets.get(ownerId);

    const out = Object.assign({}, payload);
    delete out.ownerClientId;

    if (hostSocket) hostSocket.emit(eventName, { ...out, clientId: ownerId });
    if (ownerSocket) ownerSocket.emit(eventName, { ...out, clientId: ownerId });
    socket.emit(eventName, { ...out, clientId: ownerId });
  }

  socket.on('updateRadius', d => forwardToHostAndOwner('updateRadius', d || {}));
  socket.on('updateElevation', d => forwardToHostAndOwner('updateElevation', d || {}));
  socket.on('updateBearing', d => forwardToHostAndOwner('updateBearing', d || {}));

  socket.on('userDotPlaced', d => {
    const info = clients.get(socket.id) || {};
    const hostSocket = findHostSocket();
    const payload = { ...d, clientId: socket.id, clientName: info.name, userDotColor: info.userDotColor };
    if (hostSocket) hostSocket.emit('userDotPlaced', payload);
    socket.emit('userDotPlacedAck', payload);
    io.emit('userDotPlaced', payload);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    clients.delete(socket.id);
    io.emit('clientsUpdated', Array.from(clients.entries()));
    io.emit('clientDisconnected', socket.id);
    const hostSocket = findHostSocket();
    if (hostSocket) hostSocket.emit('clientDisconnected', socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
