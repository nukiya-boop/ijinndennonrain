'use strict';

const cardsMod = require('./cards');
const engine = require('./engine');

function expandCard(instance) {
  const card = cardsMod.getCard(instance.cardId);
  return {
    uid: instance.uid,
    id: card.id,
    name: card.name,
    type: card.type,
    colors: card.colors,
    color: card.colors[0] || 'colorless',
    level: card.level,
    power: card.power,
    magicCost: card.magicCost,
    rarity: card.rarity,
    text: card.text,
    legacyText: card.legacyText,
    keywords: card.keywords || {},
    effect: card.effect || null,
    triggers: card.triggers || null,
    imageUrl: card.imageUrl || null,
    tapped: !!instance.tapped,
    sick: !!instance.sick,
    unblockableByIjin: !!instance.unblockableByIjin,
  };
}

function expandManaCard(instance, revealed) {
  if (!revealed && !instance.faceUp) {
    return { uid: instance.uid, hidden: true, tapped: !!instance.tapped };
  }
  if (!instance.faceUp) {
    // 自分だけが見られる裏向きマリョク
    const card = cardsMod.getCard(instance.cardId);
    return {
      uid: instance.uid,
      hidden: false,
      faceDown: true,
      name: card.name,
      type: card.type,
      colors: card.colors,
      color: card.colors[0] || 'colorless',
      level: card.level,
      imageUrl: card.imageUrl || null,
      tapped: !!instance.tapped,
    };
  }
  return Object.assign({ faceDown: false }, expandCard(instance));
}

function expandGuardian(instance) {
  return { uid: instance.uid, tapped: !!instance.tapped };
}

function playerPublicView(ps, isSelf) {
  const view = {
    id: ps.id,
    name: ps.name,
    color: ps.color,
    deckName: ps.deckName || null,
    handCount: ps.hand.length,
    hand: isSelf ? ps.hand.map(expandCard) : undefined,
    field: {
      ijin: ps.field.ijin.map(expandCard),
      haikei: ps.field.haikei.map(expandCard),
    },
    mana: ps.mana.map((m) => expandManaCard(m, isSelf)),
    guardianCount: ps.guardians.length,
    guardians: ps.guardians.map(expandGuardian),
    graveyard: ps.graveyard.map(expandCard),
    deckCount: ps.deck.length,
    manaRight: ps.manaRight,
    summonRight: ps.summonRight,
    attackedThisTurn: ps.attackedThisTurn,
    extraBattleAvailable: ps.extraBattleAvailable,
    loseAtNextEndPhase: ps.loseAtNextEndPhase,
  };
  return view;
}

function serializeStateFor(game, viewerId) {
  const oppId = engine.opponentId(game, viewerId);
  return {
    roomId: game.roomId,
    turnNumber: game.turnNumber,
    activePlayerId: engine.activePlayerId(game),
    phase: game.phase,
    winner: game.winner,
    log: game.log.slice(-40),
    pendingBattle: game.pendingBattle,
    me: playerPublicView(game.playerStates[viewerId], true),
    opponent: playerPublicView(game.playerStates[oppId], false),
  };
}

module.exports = { serializeStateFor, expandCard };
