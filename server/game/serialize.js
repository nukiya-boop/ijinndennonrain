'use strict';

const cardsMod = require('./cards');
const engine = require('./engine');

function expandCard(instance, ps) {
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
    equipOffer: card.equipOffer || null,
    meisoEquip: card.meisoEquip || null,
    hasMeiso: !!((card.keywords && card.keywords.meiso) || instance.hasMeiso),
    equippedCardName: instance.equippedCard ? cardsMod.getCard(instance.equippedCard.cardId).name : null,
    equippedCardUid: instance.equippedCard ? instance.equippedCard.uid : null,
    imageUrl: card.imageUrl || null,
    tapped: !!instance.tapped,
    sick: !!instance.sick,
    // 即応(rush)を実際に持っているか(装備・ハイケイ・他カードからの付与や躍進等の
    // 条件付き付与も含めたサーバー側の判定結果)。召喚酔い表示をクライアント側で
    // 正しく出し分けるために使う。
    hasRush: card.type === 'ijin' && ps && ps.field ? engine.hasEffectiveRush(instance, ps) : false,
    unblockableByIjin: !!instance.unblockableByIjin,
    tempRushUntilEndOfTurn: !!instance.tempRushUntilEndOfTurn,
    drawnThisTurn: !!instance.drawnThisTurn,
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
      keywords: card.keywords || {},
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
    hand: isSelf ? ps.hand.map((c) => expandCard(c)) : undefined,
    field: {
      ijin: ps.field.ijin.map((i) => expandCard(i, ps)),
      haikei: ps.field.haikei.map((h) => expandCard(h)),
    },
    mana: ps.mana.map((m) => expandManaCard(m, isSelf)),
    guardianCount: ps.guardians.length,
    guardians: ps.guardians.map(expandGuardian),
    graveyard: ps.graveyard.map((c) => expandCard(c)),
    deckCount: ps.deck.length,
    manaRight: ps.manaRight,
    summonRight: ps.summonRight,
    attackedThisTurn: ps.attackedThisTurn,
    extraBattleAvailable: ps.extraBattleAvailable,
    loseAtNextEndPhase: ps.loseAtNextEndPhase,
    clairvoyanceReveal: isSelf ? (ps.clairvoyanceReveal || null) : undefined,
    mulliganDeclared: !!ps.mulliganDeclared,
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
    firstPlayerId: game.players[0],
    diceRoll: game.diceRoll ? {
      firstPlayerId: game.players[0],
      firstPlayerName: game.playerStates[game.players[0]].name,
      firstValue: game.diceRoll.p1Value,
      secondPlayerId: game.players[1],
      secondPlayerName: game.playerStates[game.players[1]].name,
      secondValue: game.diceRoll.p2Value,
    } : null,
    pendingBattle: game.pendingBattle,
    pendingMainStartTrigger: game.pendingMainStartTrigger && game.pendingMainStartTrigger.playerId === viewerId ? game.pendingMainStartTrigger : null,
    pendingHaikeiPlacedTrigger: game.pendingHaikeiPlacedTrigger && game.pendingHaikeiPlacedTrigger.playerId === viewerId ? game.pendingHaikeiPlacedTrigger : null,
    pendingManaOnPlaceDiscard: game.pendingManaOnPlaceDiscard && game.pendingManaOnPlaceDiscard.playerId === viewerId ? game.pendingManaOnPlaceDiscard : null,
    pendingEffectChoice: game.pendingEffectChoice && game.pendingEffectChoice.playerId === viewerId ? {
      playerId: game.pendingEffectChoice.playerId,
      cardUid: game.pendingEffectChoice.cardUid,
      cardName: game.pendingEffectChoice.cardName,
      pool: game.pendingEffectChoice.pool,
      poolZone: game.pendingEffectChoice.poolZone,
      min: game.pendingEffectChoice.min,
      max: game.pendingEffectChoice.max,
      label: game.pendingEffectChoice.label,
    } : null,
    pendingLegacyTrigger: (() => {
      const head = game.pendingLegacyTriggers && game.pendingLegacyTriggers[0];
      if (!head || head.playerId !== viewerId) return null;
      return engine.describePendingLegacyTrigger(game, head);
    })(),
    opponentHasPendingLegacyTrigger: !!(game.pendingLegacyTriggers && game.pendingLegacyTriggers[0] && game.pendingLegacyTriggers[0].playerId === oppId),
    me: playerPublicView(game.playerStates[viewerId], true),
    opponent: playerPublicView(game.playerStates[oppId], false),
  };
}

module.exports = { serializeStateFor, expandCard };
