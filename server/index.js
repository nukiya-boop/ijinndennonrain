'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { RoomManager } = require('./rooms');
const { listColors, listAllCardsForBuilder } = require('./game/cards');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- PINコード認証(個人利用向け。APP_PIN未設定時は認証なしで動作) ----------
const APP_PIN = process.env.APP_PIN || '';
const SESSION_COOKIE = 'lb_session';
const validSessions = new Set();

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function hasValidSession(req) {
  if (!APP_PIN) return true;
  const cookies = parseCookies(req.headers.cookie);
  return !!(cookies[SESSION_COOKIE] && validSessions.has(cookies[SESSION_COOKIE]));
}

app.use(express.json());

app.post('/api/login', (req, res) => {
  if (!APP_PIN) return res.json({ ok: true });
  const pin = String((req.body && req.body.pin) || '');
  const a = Buffer.from(pin.padEnd(32, ' '));
  const b = Buffer.from(APP_PIN.padEnd(32, ' '));
  if (pin.length !== APP_PIN.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'PINが違います。' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  validSessions.add(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (hasValidSession(req)) return next();
  if (req.path === '/login.html' || req.path.startsWith('/css/') || req.path === '/api/login') return next();
  if (req.path === '/' || req.path === '/index.html') {
    return res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  }
  return res.status(401).end();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const roomManager = new RoomManager(io);
const CARD_LIST = listAllCardsForBuilder();

io.use((socket, next) => {
  if (hasValidSession(socket.handshake)) return next();
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  socket.emit('colors', listColors());
  socket.emit('card_list', CARD_LIST);

  socket.on('create_room', ({ name, color, deck }, cb) => {
    const result = roomManager.createRoom(socket, sanitizeName(name), color, deck);
    if (cb) cb(result);
  });

  socket.on('join_room', ({ roomId, name, color, deck }, cb) => {
    const result = roomManager.joinRoom(socket, String(roomId || '').toUpperCase(), sanitizeName(name), color, deck);
    if (cb) cb(result);
  });

  socket.on('create_cpu_game', ({ name, color, deck }, cb) => {
    const result = roomManager.createCpuRoom(socket, sanitizeName(name), color, deck);
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
  console.log(`レキシバトルオンライン起動: http://localhost:${PORT}`);
});
