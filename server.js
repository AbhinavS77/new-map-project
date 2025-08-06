const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = 3000;

app.use(express.static(path.join(__dirname)));

io.on('connection', socket => {
  console.log(`User connected: ${socket.id}`);

  socket.on('newPin',    data => io.emit('pinAdded', data));
  socket.on('removePin', id   => io.emit('pinRemoved', id));
  socket.on('clearPins',      ()  => io.emit('pinsCleared'));

  socket.on('disconnect', ()   => console.log(`User disconnected: ${socket.id}`));
});

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
