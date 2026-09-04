'use strict';

const engine = require('./game/engine');
const bot = require('./game/bot');
const { serializeStateFor } = require('./game/serialize');
const { listColors } = require('./game/cards');

function randomRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CPU_COLORS = ['red', 'blue', 'green', 'yellow', 'purple'];

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

  createCpuRoom(socket, name, color) {
    let roomId;
    do {
      roomId = randomRoomId();
    } while (this.rooms.has(roomId));

    const human = { socketId: socket.id, id: socket.id, name, color, connected: true };
    const cpuColor = CPU_COLORS[Math.floor(Math.random() * CPU_COLORS.length)];
    const botPlayer = { socketId: null, id: `CPU-${roomId}`, name: 'CPU', color: cpuColor, connected: true, isBot: true };

    const order = Math.random() < 0.5 ? [human, botPlayer] : [botPlayer, human];

    const room = {
      id: roomId,
      players: [human, botPlayer],
      game: engine.createGame(roomId, order[0], order[1]),
      isCpu: true,
      botId: botPlayer.id,
      botTurnCounters: { haikei: 0, mahou: 0 },
      botCountersTurnNumber: -1,
      botLoopRunning: false,
    };
    this.rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;

    this.broadcastState(room);
    this.runBotLoop(room).catch((e) => console.error('bot loop error', e));
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
      if (p.isBot) continue;
      const view = serializeStateFor(room.game, p.id);
      this.io.to(p.socketId).emit('state_update', view);
    }
  }

  async runBotLoop(room) {
    if (room.botLoopRunning) return;
    room.botLoopRunning = true;
    try {
      const game = room.game;
      const botId = room.botId;
      let guard = 0;
      while (game && !game.winner && guard < 200) {
        guard += 1;
        if (engine.activePlayerId(game) === botId && game.phase === 'main') {
          if (room.botCountersTurnNumber !== game.turnNumber) {
            room.botTurnCounters = { haikei: 0, mahou: 0 };
            room.botCountersTurnNumber = game.turnNumber;
          }
          await sleep(500);
          const step = bot.botTakeMainPhaseStep(game, botId, room.botTurnCounters);
          this.broadcastState(room);
          if (!step.done) {
            await sleep(400);
            engine.endTurn(game, botId);
            this.broadcastState(room);
          }
          continue;
        }
        if (game.phase === 'block' && game.pendingBattle && game.pendingBattle.attackerPlayerId !== botId) {
          await sleep(700);
          const assignments = bot.botDecideBlock(game, botId);
          engine.declareBlock(game, botId, { assignments });
          this.broadcastState(room);
          continue;
        }
        break;
      }
    } finally {
      room.botLoopRunning = false;
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
    if (room.isCpu && result.ok && !game.winner) {
      this.runBotLoop(room).catch((e) => console.error('bot loop error', e));
    }
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
      const opponent = room.players.find((p) => p.id !== socket.id && !p.isBot);
      if (opponent) {
        this.io.to(opponent.socketId).emit('opponent_disconnected');
      }
    }
    if (room.players.filter((p) => !p.isBot).every((p) => !p.connected)) {
      this.rooms.delete(roomId);
    }
  }
}

module.exports = { RoomManager };
