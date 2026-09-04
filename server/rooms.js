'use strict';

const engine = require('./game/engine');
const { serializeStateFor } = require('./game/serialize');
const { listColors } = require('./game/cards');

function randomRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomId -> room
  }

  createRoom(socket, name, color) {
    let roomId;
    do {
      roomId = randomRoomId();
    } while (this.rooms.has(roomId));

    const room = {
      id: roomId,
      players: [{ socketId: socket.id, id: socket.id, name, color, connected: true }],
      game: null,
    };
    this.rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    return { ok: true, roomId };
  }

  joinRoom(socket, roomId, name, color) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: '部屋が見つかりません。' };
    if (room.players.length >= 2) return { ok: false, error: '部屋は満員です。' };
    if (room.players.some((p) => p.id === socket.id)) return { ok: false, error: 'すでに参加しています。' };

    room.players.push({ socketId: socket.id, id: socket.id, name, color, connected: true });
    socket.join(roomId);
    socket.data.roomId = roomId;

    if (room.players.length === 2) {
      room.game = engine.createGame(roomId, room.players[0], room.players[1]);
      this.broadcastState(room);
    } else {
      this.broadcastLobby(room);
    }
    return { ok: true, roomId };
  }

  broadcastLobby(room) {
    this.io.to(room.id).emit('lobby_update', {
      roomId: room.id,
      players: room.players.map((p) => ({ name: p.name, color: p.color })),
      colors: listColors(),
    });
  }

  broadcastState(room) {
    if (!room.game) return;
    for (const p of room.players) {
      const view = serializeStateFor(room.game, p.id);
      this.io.to(p.socketId).emit('state_update', view);
    }
  }

  handleAction(socket, action) {
    const roomId = socket.data.roomId;
    const room = this.rooms.get(roomId);
    if (!room || !room.game) return { ok: false, error: 'ゲームが開始されていません。' };
    const game = room.game;
    if (game.winner) return { ok: false, error: 'ゲームは終了しています。' };

    const playerId = socket.id;
    const isMyTurn = engine.activePlayerId(game) === playerId;

    let result;
    try {
      switch (action.type) {
        case 'place_mana':
          if (!isMyTurn || game.phase !== 'main') return { ok: false, error: '今は操作できません。' };
          result = engine.placeMana(game, playerId, action);
          break;
        case 'summon_ijin':
          if (!isMyTurn || game.phase !== 'main') return { ok: false, error: '今は操作できません。' };
          result = engine.summonIjin(game, playerId, action);
          break;
        case 'play_haikei':
          if (!isMyTurn || game.phase !== 'main') return { ok: false, error: '今は操作できません。' };
          result = engine.playHaikei(game, playerId, action);
          break;
        case 'cast_mahou':
          if (!isMyTurn || game.phase !== 'main') return { ok: false, error: '今は操作できません。' };
          result = engine.castMahou(game, playerId, action);
          break;
        case 'declare_attack':
          if (!isMyTurn || game.phase !== 'main') return { ok: false, error: '今は操作できません。' };
          result = engine.declareAttack(game, playerId, action);
          break;
        case 'declare_block':
          if (game.phase !== 'block') return { ok: false, error: '今はブロックできません。' };
          result = engine.declareBlock(game, playerId, action);
          break;
        case 'end_turn':
          if (!isMyTurn || game.phase !== 'main') return { ok: false, error: '今は操作できません。' };
          engine.endTurn(game, playerId);
          result = { ok: true };
          break;
        default:
          result = { ok: false, error: '不明な操作です。' };
      }
    } catch (e) {
      result = { ok: false, error: `内部エラー: ${e.message}` };
    }

    this.broadcastState(room);
    return result;
  }

  handleDisconnect(socket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (player) player.connected = false;

    if (room.game && !room.game.winner) {
      const opponent = room.players.find((p) => p.id !== socket.id);
      if (opponent) {
        this.io.to(opponent.socketId).emit('opponent_disconnected');
      }
    }
    if (room.players.every((p) => !p.connected)) {
      this.rooms.delete(roomId);
    }
  }
}

module.exports = { RoomManager };
