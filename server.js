// server.js
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = 3000;

app.use(express.static(path.join(__dirname)));

// Track connected clients and their data
const clients = new Map();

io.on('connection', socket => {
  console.log(`User connected: ${socket.id}`);

  socket.on('clientInfo', info => {
    clients.set(socket.id, info);
    io.emit('clientsUpdated', Array.from(clients.entries()));
  });

  socket.on('newPin', d => {
    const clientInfo = clients.get(socket.id);
    // Send to host only
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => 
      s.handshake.query.isHost === 'true'
    );
    if (hostSocket) {
      hostSocket.emit('pinAdded', { 
        ...d, 
        clientId: socket.id, 
        clientName: clientInfo?.name,
        pinColor: clientInfo?.pinColor 
      });
    }
    // Send back to same client
    socket.emit('pinAdded', { 
      ...d, 
      clientId: socket.id, 
      clientName: clientInfo?.name,
      pinColor: clientInfo?.pinColor 
    });
  });

  socket.on('removePin', id => {
    // Send to host
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => 
      s.handshake.query.isHost === 'true'
    );
    if (hostSocket) {
      hostSocket.emit('pinRemoved', { id, clientId: socket.id });
    }
    // Send back to same client
    socket.emit('pinRemoved', { id, clientId: socket.id });
  });

  socket.on('clearPins', () => {
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => 
      s.handshake.query.isHost === 'true'
    );
    if (hostSocket) {
      hostSocket.emit('pinsCleared', { clientId: socket.id });
    }
    socket.emit('pinsCleared', { clientId: socket.id });
  });

  socket.on('updateRadius', d => {
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => 
      s.handshake.query.isHost === 'true'
    );
    if (hostSocket) {
      hostSocket.emit('updateRadius', { ...d, clientId: socket.id });
    }
    socket.emit('updateRadius', { ...d, clientId: socket.id });
  });

  socket.on('updateElevation', d => {
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => 
      s.handshake.query.isHost === 'true'
    );
    if (hostSocket) {
      hostSocket.emit('updateElevation', { ...d, clientId: socket.id });
    }
    socket.emit('updateElevation', { ...d, clientId: socket.id });
  });

  socket.on('updateBearing', d => {
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => 
      s.handshake.query.isHost === 'true'
    );
    if (hostSocket) {
      hostSocket.emit('updateBearing', { ...d, clientId: socket.id });
    }
    socket.emit('updateBearing', { ...d, clientId: socket.id });
  });

  socket.on('userDotPlaced', d => {
    const clientInfo = clients.get(socket.id);
    // Send only to host
    const hostSocket = Array.from(io.sockets.sockets.values()).find(s => 
      s.handshake.query.isHost === 'true'
    );
    if (hostSocket) {
      hostSocket.emit('userDotPlaced', { 
        ...d, 
        clientId: socket.id, 
        clientName: clientInfo?.name,
        userDotColor: clientInfo?.userDotColor 
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    clients.delete(socket.id);
    io.emit('clientsUpdated', Array.from(clients.entries()));
    io.emit('clientDisconnected', socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});