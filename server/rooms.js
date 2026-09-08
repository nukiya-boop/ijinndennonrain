'use strict';

const engine = require('./game/engine');
const bot = require('./game/bot');
const { serializeStateFor } = require('./game/serialize');
const { listColors, validateCustomDeck } = require('./game/cards');
const { pickRandomPremadeDeck } = require('./game/premade_decks');

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

// CPUの手番演出の間隔(基準値。以前よりゆっくりめに設定)に、プレイヤーが選んだ
// 速度に応じた倍率をかけて使う。
const CPU_BASE_DELAYS = { mainStep: 1600, endTurn: 1200, block: 2000 };
const CPU_SPEED_MULTIPLIERS = { slow: 1.5, normal: 1, fast: 0.55 };
function resolveCpuSpeedMultiplier(cpuSpeed) {
  return CPU_SPEED_MULTIPLIERS[cpuSpeed] || CPU_SPEED_MULTIPLIERS.normal;
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomId -> room
  }

  buildPlayer(socket, name, color, deckSpec) {
    const player = { socketId: socket.id, id: socket.id, name, color, connected: true };
    if (deckSpec) {
      const result = validateCustomDeck(deckSpec);
      if (!result.ok) return { error: result.error };
      player.deckIds = result.ids;
    }
    return { player };
  }

  createRoom(socket, name, color, deckSpec) {
    const built = this.buildPlayer(socket, name, color, deckSpec);
    if (built.error) return { ok: false, error: built.error };

    let roomId;
    do {
      roomId = randomRoomId();
    } while (this.rooms.has(roomId));

    const room = {
      id: roomId,
      players: [built.player],
      game: null,
    };
    this.rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    return { ok: true, roomId };
  }

  joinRoom(socket, roomId, name, color, deckSpec) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: '部屋が見つかりません。' };
    if (room.players.length >= 2) return { ok: false, error: '部屋は満員です。' };
    if (room.players.some((p) => p.id === socket.id)) return { ok: false, error: 'すでに参加しています。' };

    const built = this.buildPlayer(socket, name, color, deckSpec);
    if (built.error) return { ok: false, error: built.error };

    room.players.push(built.player);
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

  createCpuRoom(socket, name, color, deckSpec, cpuSpeed) {
    const built = this.buildPlayer(socket, name, color, deckSpec);
    if (built.error) return { ok: false, error: built.error };
    const human = built.player;

    let roomId;
    do {
      roomId = randomRoomId();
    } while (this.rooms.has(roomId));

    const premade = pickRandomPremadeDeck();
    const botPlayer = {
      socketId: null,
      id: `CPU-${roomId}`,
      name: 'CPU',
      color: premade.colors[0] || CPU_COLORS[Math.floor(Math.random() * CPU_COLORS.length)],
      deckIds: premade.cardIds,
      deckName: premade.name,
      connected: true,
      isBot: true,
    };

    const room = {
      id: roomId,
      players: [human, botPlayer],
      // 先攻・後攻はengine.createGame内のダイスロールで決まるため、ここでの順序は問わない。
      game: engine.createGame(roomId, human, botPlayer),
      isCpu: true,
      botId: botPlayer.id,
      botTurnCounters: { haikei: 0, mahou: 0 },
      botCountersTurnNumber: -1,
      botLoopRunning: false,
      cpuSpeedMultiplier: resolveCpuSpeedMultiplier(cpuSpeed),
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
      const speed = room.cpuSpeedMultiplier || 1;
      let guard = 0;
      while (game && !game.winner && guard < 200) {
        guard += 1;
        if (game.pendingLegacyTriggers && game.pendingLegacyTriggers.length > 0) {
          const pending = game.pendingLegacyTriggers[0];
          if (pending.playerId !== botId) break; // 人間側の未解決の遺業能力を待つ
          await sleep(CPU_BASE_DELAYS.endTurn * speed);
          const legacyAction = bot.decideLegacyTrigger(game, botId, pending);
          engine.resolveLegacyTrigger(game, botId, legacyAction);
          this.broadcastState(room);
          continue;
        }
        if (game.pendingManaOnPlaceDiscard) {
          const pending = game.pendingManaOnPlaceDiscard;
          if (pending.playerId !== botId) break; // 人間側の未解決の選択を待つ
          await sleep(CPU_BASE_DELAYS.mainStep * speed);
          const targetUids = bot.decideManaOnPlaceDiscard(game, botId, pending);
          engine.resolveManaOnPlaceDiscard(game, botId, { targetUids });
          this.broadcastState(room);
          continue;
        }
        if (game.pendingManaCardDestinationChoice) {
          const pending = game.pendingManaCardDestinationChoice;
          if (pending.playerId !== botId) break; // 人間側の未解決の選択を待つ
          await sleep(CPU_BASE_DELAYS.mainStep * speed);
          const destination = bot.decideManaCardDestinationChoice(game, botId, pending);
          engine.resolveManaCardDestinationChoice(game, botId, { destination });
          this.broadcastState(room);
          continue;
        }
        if (game.pendingEffectChoice) {
          const pending = game.pendingEffectChoice;
          if (pending.playerId !== botId) break; // 人間側の未解決の選択を待つ
          await sleep(CPU_BASE_DELAYS.mainStep * speed);
          const targetUids = bot.decideEffectChoice(game, botId, pending);
          engine.resolveEffectChoice(game, botId, { targetUids });
          this.broadcastState(room);
          continue;
        }
        if (game.phase === 'mulligan') {
          const botPs = game.playerStates[botId];
          if (botPs.mulliganDeclared) break; // 人間側の宣言を待つ
          const firstPlayerId = game.players[0];
          if (botId !== firstPlayerId && !game.playerStates[firstPlayerId].mulliganDeclared) break; // 先攻の宣言を待つ
          await sleep(CPU_BASE_DELAYS.endTurn * speed);
          const mulligan = bot.decideMulligan(game, botId);
          engine.declareMulligan(game, botId, { mulligan });
          this.broadcastState(room);
          continue;
        }
        if (engine.activePlayerId(game) === botId && game.phase === 'main') {
          if (room.botCountersTurnNumber !== game.turnNumber) {
            room.botTurnCounters = { haikei: 0, mahou: 0 };
            room.botCountersTurnNumber = game.turnNumber;
          }
          await sleep(CPU_BASE_DELAYS.mainStep * speed);
          const step = bot.botTakeMainPhaseStep(game, botId, room.botTurnCounters);
          this.broadcastState(room);
          if (!step.done) {
            await sleep(CPU_BASE_DELAYS.endTurn * speed);
            const endTriggerTargets = bot.chooseEndTurnTriggerTargets(game, botId);
            engine.endTurn(game, botId, { endTriggerTargets });
            this.broadcastState(room);
          }
          continue;
        }
        if (game.phase === 'block' && game.pendingBattle && game.pendingBattle.attackerPlayerId !== botId) {
          await sleep(CPU_BASE_DELAYS.block * speed);
          const { assignments, blockerTriggerTargets, eiketsuHaikeiUid, eiketsuTargetAttackerUid } = bot.botDecideBlock(game, botId);
          engine.declareBlock(game, botId, { assignments, blockerTriggerTargets, eiketsuHaikeiUid, eiketsuTargetAttackerUid });
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

    if (action.type !== 'resolve_legacy_trigger' && game.pendingLegacyTriggers && game.pendingLegacyTriggers.length > 0) {
      return { ok: false, error: '未処理の遺業能力があります。先にそちらを解決してください。' };
    }
    if (action.type !== 'resolve_mana_discard_choice' && game.pendingManaOnPlaceDiscard && game.pendingManaOnPlaceDiscard.playerId === playerId) {
      return { ok: false, error: '捨てるカードを選んでください。' };
    }
    if (action.type !== 'resolve_mana_card_destination_choice' && game.pendingManaCardDestinationChoice && game.pendingManaCardDestinationChoice.playerId === playerId) {
      return { ok: false, error: '効果を選んでください。' };
    }
    if (action.type !== 'resolve_effect_choice' && game.pendingEffectChoice && game.pendingEffectChoice.playerId === playerId) {
      return { ok: false, error: '対象を選んでください。' };
    }

    let result;
    try {
      switch (action.type) {
        case 'declare_mulligan':
          if (game.phase !== 'mulligan') return { ok: false, error: '今は操作できません。' };
          result = engine.declareMulligan(game, playerId, action);
          break;
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
        case 'cast_mahou_from_graveyard':
          if (!isMyTurn || game.phase !== 'main') return { ok: false, error: '今は操作できません。' };
          result = engine.castMahouFromGraveyard(game, playerId, action);
          break;
        case 'revive_hankon':
          if (!isMyTurn || game.phase !== 'main') return { ok: false, error: '今は操作できません。' };
          result = engine.reviveHankon(game, playerId, action);
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
          engine.endTurn(game, playerId, action);
          result = { ok: true };
          break;
        case 'resolve_main_start_trigger':
          if (!isMyTurn || game.phase !== 'main') return { ok: false, error: '今は操作できません。' };
          result = engine.resolveMainStartTrigger(game, playerId, action);
          break;
        case 'resolve_haikei_placed_trigger':
          if (!isMyTurn || game.phase !== 'main') return { ok: false, error: '今は操作できません。' };
          result = engine.resolveHaikeiPlacedTrigger(game, playerId, action);
          break;
        case 'resolve_legacy_trigger':
          result = engine.resolveLegacyTrigger(game, playerId, action);
          break;
        case 'resolve_mana_discard_choice':
          result = engine.resolveManaOnPlaceDiscard(game, playerId, action);
          break;
        case 'resolve_mana_card_destination_choice':
          result = engine.resolveManaCardDestinationChoice(game, playerId, action);
          break;
        case 'resolve_effect_choice':
          result = engine.resolveEffectChoice(game, playerId, action);
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
