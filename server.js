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
    io.emit('pinAdded', { ...d, clientId: socket.id, clientName: clientInfo?.name });
  });

  socket.on('removePin', id => io.emit('pinRemoved', { id, clientId: socket.id }));
  socket.on('clearPins', () => io.emit('pinsCleared', { clientId: socket.id }));
  socket.on('updateRadius', d => io.emit('updateRadius', { ...d, clientId: socket.id }));
  socket.on('updateElevation', d => io.emit('updateElevation', { ...d, clientId: socket.id }));
  socket.on('updateBearing', d => io.emit('updateBearing', { ...d, clientId: socket.id }));
  socket.on('userDotPlaced', d => {
    const clientInfo = clients.get(socket.id);
    socket.broadcast.emit('userDotPlaced', { ...d, clientId: socket.id, clientName: clientInfo?.name });
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