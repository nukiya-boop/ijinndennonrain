'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { RoomManager } = require('./rooms');
const { listColors } = require('./game/cards');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

const roomManager = new RoomManager(io);

io.on('connection', (socket) => {
  socket.emit('colors', listColors());

  socket.on('create_room', ({ name, color }, cb) => {
    const result = roomManager.createRoom(socket, sanitizeName(name), color);
    if (cb) cb(result);
  });

  socket.on('join_room', ({ roomId, name, color }, cb) => {
    const result = roomManager.joinRoom(socket, String(roomId || '').toUpperCase(), sanitizeName(name), color);
    if (cb) cb(result);
  });

  socket.on('create_cpu_game', ({ name, color }, cb) => {
    const result = roomManager.createCpuRoom(socket, sanitizeName(name), color);
    if (cb) cb(result);
  });

  socket.on('action', (action, cb) => {
    const result = roomManager.handleAction(socket, action || {});
    if (cb) cb(result);
  });

  socket.on('disconnect', () => {
    roomManager.handleDisconnect(socket);
  });
});

function sanitizeName(name) {
  const n = String(name || 'プレイヤー').trim().slice(0, 16);
  return n.length > 0 ? n : 'プレイヤー';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`イジンデンオンライン起動: http://localhost:${PORT}`);
});
