// server.js (with shapes support + UDP broadcaster + validation)
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const dgram = require('dgram');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
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

io.on('connection', socket => {
  console.log('Connected:', socket.id, socket.handshake.query);

  // Send existing shapes to newly connected socket
  socket.emit('shapesUpdated', Array.from(shapes.values()));

  socket.on('clientInfo', info => {
    clients.set(socket.id, info || {});
    io.emit('clientsUpdated', Array.from(clients.entries()));
  });

  socket.on('newPin', d => {
    const info = clients.get(socket.id) || {};
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    if (hostSocket) hostSocket.emit('pinAdded', { ...d, clientId: socket.id, clientName: info.name, pinColor: info.pinColor });
    socket.emit('pinAdded', { ...d, clientId: socket.id, clientName: info.name, pinColor: info.pinColor });
  });

  // SHAPE EVENTS (host-only)
  socket.on('newShape', shape => {
    if (socket.handshake.query.isHost !== 'true') {
      console.warn(`Non-host attempted newShape: ${socket.id}`);
      return;
    }
    if (!shape || !shape.id) return;
    shapes.set(shape.id, shape);
    io.emit('shapeAdded', shape);
  });

  socket.on('updateShape', shape => {
    if (socket.handshake.query.isHost !== 'true') {
      console.warn(`Non-host attempted updateShape: ${socket.id}`);
      return;
    }
    if (!shape || !shape.id) return;
    shapes.set(shape.id, shape);
    io.emit('shapeUpdated', shape);
  });

  socket.on('removeShape', shapeId => {
    if (socket.handshake.query.isHost !== 'true') {
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
    const requesterIsHost = socket.handshake.query.isHost === 'true';
    if (!requesterIsHost && ownerId !== socket.id) {
      console.warn(`Unauthorized removePin attempt by ${socket.id} for owner ${ownerId}`);
      return;
    }

    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    const ownerSocket = io.sockets.sockets.get(ownerId);

    if (hostSocket) hostSocket.emit('pinRemoved', { id: data.id, clientId: ownerId });
    if (ownerSocket) ownerSocket.emit('pinRemoved', { id: data.id, clientId: ownerId });

    socket.emit('pinRemoved', { id: data.id, clientId: ownerId });
  });

  socket.on('clearClientPins', () => {
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    if (hostSocket) hostSocket.emit('clientCleared', { clientId: socket.id });
    socket.emit('clientCleared', { clientId: socket.id });
  });

  socket.on('clearAll', () => {
    shapes.clear(); // clear shapes too when host clears all
    io.emit('allCleared');
  });

  // Forwarding updates for radius/elevation/bearing with ownerClientId support
  // The payload may include ownerClientId when the host edits a client's pin.
  function forwardToHostAndOwner(eventName, payload) {
    const ownerId = payload.ownerClientId || socket.id; // if host is sender, ownerClientId must be included
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    const ownerSocket = io.sockets.sockets.get(ownerId);

    const out = Object.assign({}, payload);
    // remove ownerClientId from out when forwarding; server will include clientId
    delete out.ownerClientId;

    if (hostSocket) hostSocket.emit(eventName, { ...out, clientId: ownerId });
    if (ownerSocket) ownerSocket.emit(eventName, { ...out, clientId: ownerId });
    // also acknowledge to the requester
    socket.emit(eventName, { ...out, clientId: ownerId });
  }

  socket.on('updateRadius', d => forwardToHostAndOwner('updateRadius', d || {}));
  socket.on('updateElevation', d => forwardToHostAndOwner('updateElevation', d || {}));
  socket.on('updateBearing', d => forwardToHostAndOwner('updateBearing', d || {}));

  socket.on('userDotPlaced', d => {
    const info = clients.get(socket.id) || {};
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    if (hostSocket) hostSocket.emit('userDotPlaced', { ...d, clientId: socket.id, clientName: info.name, userDotColor: info.userDotColor });
    socket.emit('userDotPlacedAck', { ...d, clientId: socket.id, clientName: info.name, userDotColor: info.userDotColor });
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    clients.delete(socket.id);
    io.emit('clientsUpdated', Array.from(clients.entries()));
    io.emit('clientDisconnected', socket.id);
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    if (hostSocket) hostSocket.emit('clientDisconnected', socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
