// server.js (updated removePin semantics + clearClientPins / clearAll)
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

// UDP broadcaster
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

io.on('connection', socket => {
  console.log('Connected:', socket.id, socket.handshake.query);

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

  // removePin now accepts an object: { id: <origId>, ownerClientId?: <ownerId> }
  socket.on('removePin', (payload) => {
    // backward compatibility: payload might be string id
    const data = (typeof payload === 'string') ? { id: payload } : (payload || {});
    // owner is provided or fallback to socket.id
    const ownerId = data.ownerClientId || socket.id;

    // Validation: if requester is not host and not the owner, reject
    const requesterIsHost = socket.handshake.query.isHost === 'true';
    if (!requesterIsHost && ownerId !== socket.id) {
      // ignore invalid request
      console.warn(`Unauthorized removePin attempt by ${socket.id} for owner ${ownerId}`);
      return;
    }

    // Notify host (if present) and the owner
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    const ownerSocket = io.sockets.sockets.get(ownerId);

    if (hostSocket) hostSocket.emit('pinRemoved', { id: data.id, clientId: ownerId });
    if (ownerSocket) ownerSocket.emit('pinRemoved', { id: data.id, clientId: ownerId });

    // also confirm to requester (host or client)
    socket.emit('pinRemoved', { id: data.id, clientId: ownerId });
  });

  socket.on('clearClientPins', () => {
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    if (hostSocket) hostSocket.emit('clientCleared', { clientId: socket.id });
    socket.emit('clientCleared', { clientId: socket.id });
  });

  socket.on('clearAll', () => {
    io.emit('allCleared');
  });

  socket.on('updateRadius', d => {
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    if (hostSocket) hostSocket.emit('updateRadius', { ...d, clientId: socket.id });
    socket.emit('updateRadius', { ...d, clientId: socket.id });
  });

  socket.on('updateElevation', d => {
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    if (hostSocket) hostSocket.emit('updateElevation', { ...d, clientId: socket.id });
    socket.emit('updateElevation', { ...d, clientId: socket.id });
  });

  socket.on('updateBearing', d => {
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.handshake.query.isHost === 'true');
    if (hostSocket) hostSocket.emit('updateBearing', { ...d, clientId: socket.id });
    socket.emit('updateBearing', { ...d, clientId: socket.id });
  });

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
