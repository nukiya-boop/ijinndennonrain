'use strict';

const { getCard, buildStarterDeckIds } = require('./cards');

let uidCounter = 1;
function nextUid() {
  return `c${uidCounter++}`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeInstance(cardId, extra) {
  return Object.assign({ uid: nextUid(), cardId, tapped: false, sick: true, faceUp: true, unblockableByIjin: false }, extra || {});
}

function log(game, text) {
  game.log.push(text);
  if (game.log.length > 200) game.log.shift();
}

// ---------- ゲーム生成 ----------

function createGame(roomId, p1, p2) {
  const game = {
    roomId,
    players: [p1.id, p2.id],
    turnPlayerIndex: 0,
    turnNumber: 1,
    isVeryFirstTurn: true,
    phase: 'main', // start/draw は自動処理してmainで止める
    pendingBattle: null,
    winner: null,
    log: [],
    playerStates: {},
  };

  for (const p of [p1, p2]) {
    const deckIds = p.deckIds && p.deckIds.length ? p.deckIds : buildStarterDeckIds(p.color);
    const shuffled = shuffle(deckIds);
    const deck = shuffled.map((id) => makeInstance(id, { sick: false }));
    const hand = deck.splice(0, 6);
    const guardians = deck.splice(0, 4).map((inst) => Object.assign(inst, { faceUp: false, tapped: false }));

    game.playerStates[p.id] = {
      id: p.id,
      name: p.name,
      color: p.color,
      deckName: p.deckName || null,
      deck,
      hand,
      field: { ijin: [], haikei: [] },
      mana: [],
      guardians,
      graveyard: [],
      manaRight: 1,
      summonRight: 1,
      attackedThisTurn: false,
      extraBattleAvailable: false,
      loseAtNextEndPhase: false,
    };
  }

  log(game, `${p1.name} 対 ${p2.name} の対戦を開始します。先攻: ${p1.name}`);
  return game;
}

function activePlayerId(game) {
  return game.players[game.turnPlayerIndex];
}

function opponentId(game, playerId) {
  return game.players.find((id) => id !== playerId);
}

function findInstance(playerState, uid) {
  const zones = [
    ['hand', playerState.hand],
    ['ijin', playerState.field.ijin],
    ['haikei', playerState.field.haikei],
    ['mana', playerState.mana],
    ['guardian', playerState.guardians],
    ['graveyard', playerState.graveyard],
  ];
  for (const [zone, list] of zones) {
    const idx = list.findIndex((i) => i.uid === uid);
    if (idx !== -1) return { zone, list, idx, instance: list[idx] };
  }
  return null;
}

// ---------- 魔力ゾーン計算 ----------

function levelSum(playerState) {
  let sum = 0;
  for (const m of playerState.mana) {
    if (m.faceUp) sum += getCard(m.cardId).level;
    else sum += 1;
  }
  return sum;
}

function hasColorInMana(playerState, color) {
  return playerState.mana.some((m) => m.faceUp && getCard(m.cardId).colors.includes(color));
}

function satisfiesColorCondition(playerState, card) {
  if (!card.colors || card.colors.length === 0) return true; // 無色カードは色条件なし
  return card.colors.some((color) => hasColorInMana(playerState, color));
}

function canUseCard(playerState, card) {
  if (!satisfiesColorCondition(playerState, card)) return false;
  if (levelSum(playerState) < card.level) return false;
  return true;
}

function powerAuraBonus(playerState) {
  let bonus = 0;
  for (const h of playerState.field.haikei) {
    const card = getCard(h.cardId);
    if (card.effect && (card.effect.type === 'power_aura' || card.effect.type === 'power_aura_untap_end')) {
      bonus += card.effect.value;
    }
  }
  return bonus;
}

function manaRightBonus(playerState) {
  let bonus = 0;
  for (const h of playerState.field.haikei) {
    const card = getCard(h.cardId);
    if (card.effect && card.effect.type === 'mana_right_bonus') bonus += card.effect.value;
  }
  return bonus;
}

function effectivePower(instance, playerState) {
  const card = getCard(instance.cardId);
  return card.power + powerAuraBonus(playerState);
}

// ---------- 墓地移動 / 遺業能力 ----------

function moveToGraveyard(game, playerState, instance, fromZoneList) {
  const idx = fromZoneList.indexOf(instance);
  if (idx !== -1) fromZoneList.splice(idx, 1);
  const card = getCard(instance.cardId);
  instance.faceUp = true;
  playerState.graveyard.push(instance);
  log(game, `${playerState.name}の「${card.name}」が墓地に置かれました。`);

  if (card.legacy) {
    if (card.legacy.type === 'draw') {
      drawCards(game, playerState, card.legacy.value);
      log(game, `${playerState.name}は遺業能力で${card.legacy.value}枚ドローしました。`);
    } else if (card.legacy.type === 'revive_mana_faceup') {
      const gIdx = playerState.graveyard.indexOf(instance);
      if (gIdx !== -1) playerState.graveyard.splice(gIdx, 1);
      instance.faceUp = true;
      instance.tapped = false;
      playerState.mana.push(instance);
      log(game, `${playerState.name}は遺業能力(復元)で「${card.name}」を魔力ゾーンに表向きで置きました。`);
    } else if (card.legacy.type === 'revive_mana_facedown') {
      const gIdx = playerState.graveyard.indexOf(instance);
      if (gIdx !== -1) playerState.graveyard.splice(gIdx, 1);
      instance.faceUp = false;
      instance.tapped = false;
      playerState.mana.push(instance);
      log(game, `${playerState.name}は遺業能力(魔力化)で「${card.name}」を魔力ゾーンに裏向きで置きました。`);
    } else if (card.legacy.type === 'bounce_self_hand') {
      const gIdx = playerState.graveyard.indexOf(instance);
      if (gIdx !== -1) playerState.graveyard.splice(gIdx, 1);
      instance.faceUp = true;
      playerState.hand.push(instance);
      log(game, `${playerState.name}は遺業能力で「${card.name}」を手札に戻しました。`);
    }
  }
}

function destroyFieldOrGuardian(game, playerState, instance) {
  const found = findInstance(playerState, instance.uid);
  if (!found) return;
  if (found.zone !== 'ijin' && found.zone !== 'haikei' && found.zone !== 'guardian') return;
  moveToGraveyard(game, playerState, instance, found.list);
}

function drawCards(game, playerState, n) {
  for (let i = 0; i < n; i++) {
    if (playerState.deck.length === 0) break;
    playerState.hand.push(playerState.deck.shift());
  }
}

// ---------- 勝敗判定 ----------

function endGame(game, winnerId, reason) {
  game.winner = winnerId;
  game.phase = 'gameover';
  log(game, `${game.playerStates[winnerId].name}の勝利！ (${reason})`);
}

// ---------- フェイズ進行 ----------

function startTurnFor(game, playerId) {
  const ps = game.playerStates[playerId];
  ps.manaRight = 1 + manaRightBonus(ps);
  ps.summonRight = 1;
  ps.attackedThisTurn = false;
  ps.extraBattleAvailable = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei, ...ps.guardians, ...ps.mana]) {
    inst.tapped = false;
  }
  for (const inst of ps.field.ijin) inst.sick = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei]) inst.usedHaikeiTriggerThisTurn = false;
  for (const inst of ps.graveyard) inst.usedMeifuThisTurn = false;
  log(game, `${ps.name}のスタートフェイズ。`);

  const skipDraw = game.isVeryFirstTurn && game.turnPlayerIndex === 0;
  if (!skipDraw) {
    drawCards(game, ps, 1);
    log(game, `${ps.name}が1枚ドローしました。(手札${ps.hand.length}枚)`);
  }
  game.isVeryFirstTurn = false;
  game.phase = 'main';

  fireFieldStartTriggers(game, ps, game.playerStates[opponentId(game, playerId)], 'onMainStart', 'メインフェイズ開始時');
}

function endTurn(game, playerId) {
  const ps = game.playerStates[playerId];
  fireFieldStartTriggers(game, ps, game.playerStates[opponentId(game, playerId)], 'onEndStart', 'エンドフェイズ開始時');
  if (ps.loseAtNextEndPhase) {
    endGame(game, opponentId(game, playerId), 'ファイナルアタックの代償');
    return;
  }
  for (const inst of ps.field.ijin) { inst.unblockableByIjin = false; inst.tempRushUntilEndOfTurn = false; }
  ps.freeMahouThisTurn = false;

  if (ps.deck.length === 0) {
    endGame(game, opponentId(game, playerId), '山札切れ');
    return;
  }

  game.turnPlayerIndex = 1 - game.turnPlayerIndex;
  game.turnNumber += 1;
  const nextId = activePlayerId(game);
  startTurnFor(game, nextId);
}

// ---------- アクション ----------

function placeMana(game, playerId, action) {
  const ps = game.playerStates[playerId];
  if (ps.manaRight <= 0) return { ok: false, error: 'マリョク配置権がありません。' };
  const found = findInstance(ps, action.cardUid);
  if (!found || found.zone !== 'hand') return { ok: false, error: 'カードが手札にありません。' };
  const card = getCard(found.instance.cardId);

  if (action.mode === 'faceup') {
    if (card.type !== 'maryoku') return { ok: false, error: 'マリョク以外は表向きに置けません。' };
  }
  ps.hand.splice(found.idx, 1);
  found.instance.faceUp = action.mode === 'faceup';
  found.instance.tapped = false;
  ps.mana.push(found.instance);
  ps.manaRight -= 1;

  if (action.mode === 'faceup' && card.onPlace && card.onPlace.type === 'draw') {
    drawCards(game, ps, card.onPlace.value);
    log(game, `${ps.name}の「${card.name}」の効果で${card.onPlace.value}枚ドローしました。`);
  }
  log(game, `${ps.name}がマリョクを${action.mode === 'faceup' ? '表向き' : '裏向き'}で配置しました。`);
  fireOnManaPlacedTriggers(game, ps, game.playerStates[opponentId(game, playerId)]);
  return { ok: true };
}

function summonIjin(game, playerId, action) {
  const ps = game.playerStates[playerId];
  if (ps.summonRight <= 0) return { ok: false, error: 'イジン召喚権がありません。' };
  const found = findInstance(ps, action.cardUid);
  if (!found || found.zone !== 'hand') return { ok: false, error: 'カードが手札にありません。' };
  const card = getCard(found.instance.cardId);
  if (card.type !== 'ijin') return { ok: false, error: 'イジンではありません。' };
  if (!canUseCard(ps, card)) return { ok: false, error: '色条件またはレベル条件を満たしていません。' };

  ps.hand.splice(found.idx, 1);
  found.instance.tapped = false;
  found.instance.sick = true;
  ps.field.ijin.push(found.instance);
  ps.summonRight -= 1;
  log(game, `${ps.name}が「${card.name}」を召喚しました。`);
  fireOnPlaceTrigger(game, ps, game.playerStates[opponentId(game, playerId)], found.instance, card, action);
  return { ok: true };
}

function playHaikei(game, playerId, action) {
  const ps = game.playerStates[playerId];
  const found = findInstance(ps, action.cardUid);
  if (!found || found.zone !== 'hand') return { ok: false, error: 'カードが手札にありません。' };
  const card = getCard(found.instance.cardId);
  if (card.type !== 'haikei') return { ok: false, error: 'ハイケイではありません。' };
  if (!canUseCard(ps, card)) return { ok: false, error: '色条件またはレベル条件を満たしていません。' };

  ps.hand.splice(found.idx, 1);
  found.instance.tapped = false;
  ps.field.haikei.push(found.instance);
  log(game, `${ps.name}が「${card.name}」を設置しました。`);
  fireOnPlaceTrigger(game, ps, game.playerStates[opponentId(game, playerId)], found.instance, card, action);
  fireOnHaikeiPlacedTriggers(game, found.instance, ps, card);
  return { ok: true };
}

function castMahou(game, playerId, action) {
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[opponentId(game, playerId)];
  const found = findInstance(ps, action.cardUid);
  if (!found || found.zone !== 'hand') return { ok: false, error: 'カードが手札にありません。' };
  const card = getCard(found.instance.cardId);
  if (card.type !== 'mahou') return { ok: false, error: 'マホウではありません。' };
  if (!canUseCard(ps, card)) return { ok: false, error: '色条件またはレベル条件を満たしていません。' };

  const effectiveCost = ps.freeMahouThisTurn ? 0 : card.magicCost;
  const payUids = action.payManaUids || [];
  if (payUids.length !== effectiveCost) return { ok: false, error: `魔力コスト${effectiveCost}枚を選んでください。` };
  const payInstances = [];
  for (const uid of payUids) {
    const m = ps.mana.find((x) => x.uid === uid);
    if (!m) return { ok: false, error: '魔力ゾーンのカードが見つかりません。' };
    payInstances.push(m);
  }

  const result = resolveMahouEffect(game, ps, opp, card, action);
  if (!result.ok) return result;

  for (const m of payInstances) {
    const idx = ps.mana.indexOf(m);
    ps.mana.splice(idx, 1);
    m.faceUp = true;
    ps.graveyard.push(m);
  }

  ps.hand.splice(found.idx, 1);
  ps.graveyard.push(found.instance);
  log(game, `${ps.name}が「${card.name}」を発動しました。`);
  return { ok: true };
}

/**
 * 冥府発動: 色条件・レベル条件・魔力コストを無視して、墓地のマホウを発動する。
 * (ルールテキストに書かれている対象指定などの条件は満たす必要がある)
 * 公式のQ&A等で明言された回数制限がないため、無制限連打による事実上の壊れを避けるため、
 * このアプリでは同じカードの発動を1ターンに1回までとして扱う(ローカルルール)。
 */
function castMahouFromGraveyard(game, playerId, action) {
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[opponentId(game, playerId)];
  const found = ps.graveyard.find((c) => c.uid === action.cardUid);
  if (!found) return { ok: false, error: 'カードが墓地にありません。' };
  const card = getCard(found.cardId);
  if (card.type !== 'mahou') return { ok: false, error: 'マホウではありません。' };
  if (card.legacyText !== '冥府発動') return { ok: false, error: 'このマホウは冥府発動を持っていません。' };
  if (found.usedMeifuThisTurn) return { ok: false, error: 'このカードは今ターンすでに冥府発動しています。' };

  const result = resolveMahouEffect(game, ps, opp, card, action);
  if (!result.ok) return result;

  found.usedMeifuThisTurn = true;
  log(game, `${ps.name}が冥府発動で「${card.name}」を発動しました。`);
  return { ok: true };
}

function resolveScopedIjinTarget(ps, opp, scope, uid, levelMax, powerMax, sourcePower) {
  const candidates = [];
  if (scope === 'own' || scope === 'either') candidates.push({ owner: ps, inst: ps.field.ijin.find((i) => i.uid === uid) });
  if (scope === 'opponent' || scope === 'either') candidates.push({ owner: opp, inst: opp.field.ijin.find((i) => i.uid === uid) });
  const found = candidates.find((c) => c.inst);
  if (!found) return null;
  if (levelMax != null && getCard(found.inst.cardId).level > levelMax) return null;
  if (powerMax != null) {
    const cap = powerMax === 'self' ? sourcePower : powerMax;
    if (effectivePower(found.inst, found.owner) > cap) return null;
  }
  return found;
}

function resolveScopedGuardianTarget(ps, opp, scope, uid) {
  const candidates = [];
  if (scope === 'own' || scope === 'either') candidates.push({ owner: ps, inst: ps.guardians.find((g) => g.uid === uid) });
  if (scope === 'opponent' || scope === 'either') candidates.push({ owner: opp, inst: opp.guardians.find((g) => g.uid === uid) });
  return candidates.find((c) => c.inst) || null;
}

// ---------- 汎用トリガー効果(戦場に置かれたとき/アタッカーになったとき等) ----------

function resolveGenericEffect(game, ps, opp, eff, targetUid, sourceInstance) {
  switch (eff.type) {
    case 'draw':
      drawCards(game, ps, eff.value);
      return { ok: true };
    case 'both_draw':
      drawCards(game, ps, eff.selfValue || 0);
      drawCards(game, opp, eff.oppValue || 0);
      return { ok: true };
    case 'summon_right_plus':
      ps.summonRight += eff.value;
      return { ok: true };
    case 'mana_right_plus':
      ps.manaRight += eff.value;
      return { ok: true };
    case 'generic_destroy_ijin': {
      const sourcePower = sourceInstance ? effectivePower(sourceInstance, ps) : null;
      const target = resolveScopedIjinTarget(ps, opp, eff.scope, targetUid, eff.levelMax, eff.powerMax, sourcePower);
      if (!target) return { ok: false, error: '対象が見つかりません(パワー・レベル条件を確認してください)。' };
      destroyFieldOrGuardian(game, target.owner, target.inst);
      return { ok: true };
    }
    case 'generic_bounce_ijin': {
      const sourcePower = sourceInstance ? effectivePower(sourceInstance, ps) : null;
      const target = resolveScopedIjinTarget(ps, opp, eff.scope, targetUid, eff.levelMax, eff.powerMax, sourcePower);
      if (!target) return { ok: false, error: '対象が見つかりません(パワー・レベル条件を確認してください)。' };
      target.owner.field.ijin.splice(target.owner.field.ijin.indexOf(target.inst), 1);
      target.owner.hand.push(target.inst);
      return { ok: true };
    }
    case 'generic_destroy_guardian': {
      const target = resolveScopedGuardianTarget(ps, opp, eff.scope, targetUid);
      if (!target) return { ok: false, error: '対象のガーディアンが見つかりません。' };
      destroyFieldOrGuardian(game, target.owner, target.inst);
      return { ok: true };
    }
    case 'bounce_own_guardian_to_hand': {
      const g = ps.guardians[0];
      if (!g) return { ok: true };
      ps.guardians.splice(0, 1);
      g.faceUp = true;
      ps.hand.push(g);
      return { ok: true };
    }
    case 'bounce_from_graveyard': {
      const allowedTypes = eff.cardType ? [eff.cardType] : ['ijin', 'haikei'];
      const target = ps.graveyard.find((i) => i.uid === targetUid && allowedTypes.includes(getCard(i.cardId).type));
      if (!target) return { ok: false, error: '対象の墓地のカードが見つかりません。' };
      ps.graveyard.splice(ps.graveyard.indexOf(target), 1);
      target.faceUp = true;
      ps.hand.push(target);
      return { ok: true };
    }
    case 'bounce_facedown_mana': {
      const target = ps.mana.find((m) => m.uid === targetUid && !m.faceUp);
      if (!target) return { ok: false, error: '対象の裏向きマリョクが見つかりません。' };
      ps.mana.splice(ps.mana.indexOf(target), 1);
      target.faceUp = true;
      ps.hand.push(target);
      return { ok: true };
    }
    case 'generic_destroy_haikei': {
      const candidates = [];
      if (eff.scope === 'own' || eff.scope === 'either') candidates.push({ owner: ps, inst: ps.field.haikei.find((h) => h.uid === targetUid) });
      if (eff.scope === 'opponent' || eff.scope === 'either') candidates.push({ owner: opp, inst: opp.field.haikei.find((h) => h.uid === targetUid) });
      const found = candidates.find((c) => c.inst);
      if (!found) return { ok: false, error: '対象のハイケイが見つかりません。' };
      destroyFieldOrGuardian(game, found.owner, found.inst);
      return { ok: true };
    }
    case 'tap_target_ijin': {
      const target = resolveScopedIjinTarget(ps, opp, eff.scope, targetUid);
      if (!target) return { ok: false, error: '対象が見つかりません。' };
      target.inst.tapped = true;
      return { ok: true };
    }
    case 'draw_scaled_by_opponent_haikei':
      drawCards(game, ps, opp.field.haikei.length);
      return { ok: true };
    case 'draw_then_discard_own_hand': {
      drawCards(game, ps, eff.drawValue || 0);
      const idx = ps.hand.findIndex((h) => h.uid === targetUid);
      if (idx !== -1) {
        const [discarded] = ps.hand.splice(idx, 1);
        discarded.faceUp = true;
        ps.graveyard.push(discarded);
      }
      return { ok: true };
    }
    case 'draw_then_destroy_self':
      drawCards(game, ps, eff.drawValue || 0);
      if (sourceInstance) destroyFieldOrGuardian(game, ps, sourceInstance);
      return { ok: true };
    case 'deck_top_to_guardian': {
      if (ps.deck.length === 0) return { ok: true };
      const c = ps.deck.shift();
      c.faceUp = false;
      c.tapped = false;
      ps.guardians.push(c);
      return { ok: true };
    }
    case 'deck_top_to_facedown_mana': {
      if (ps.deck.length === 0) return { ok: true };
      const c = ps.deck.shift();
      c.faceUp = false;
      c.tapped = false;
      ps.mana.push(c);
      return { ok: true };
    }
    case 'mill_opponent': {
      for (let i = 0; i < eff.value; i++) {
        if (opp.deck.length === 0) break;
        const c = opp.deck.shift();
        c.faceUp = true;
        opp.graveyard.push(c);
      }
      return { ok: true };
    }
    case 'untap_all_own_field':
      for (const inst of [...ps.field.ijin, ...ps.field.haikei]) inst.tapped = false;
      return { ok: true };
    case 'destroy_self':
      if (sourceInstance) destroyFieldOrGuardian(game, ps, sourceInstance);
      return { ok: true };
    case 'destroy_own_guardian_then_draw': {
      const g = ps.guardians[0];
      if (g) destroyFieldOrGuardian(game, ps, g);
      drawCards(game, ps, eff.drawValue || 0);
      return { ok: true };
    }
    case 'win_game':
      endGame(game, ps.id, `「${sourceInstance ? getCard(sourceInstance.cardId).name : '不明なカード'}」の効果`);
      return { ok: true };
    case 'own_guardian_to_deck_top': {
      const g = ps.guardians[0];
      if (!g) return { ok: true };
      ps.guardians.splice(0, 1);
      g.faceUp = true;
      ps.deck.unshift(g);
      return { ok: true };
    }
    case 'all_facedown_mana_to_guardian': {
      const facedown = ps.mana.filter((m) => !m.faceUp);
      for (const m of facedown) {
        ps.mana.splice(ps.mana.indexOf(m), 1);
        m.tapped = false;
        ps.guardians.push(m);
      }
      return { ok: true };
    }
    case 'graveyard_card_to_guardian': {
      const idx = ps.graveyard.findIndex((c) => c.uid === targetUid);
      if (idx === -1) return { ok: false, error: '対象の墓地のカードが見つかりません。' };
      const [c] = ps.graveyard.splice(idx, 1);
      c.faceUp = false;
      c.tapped = false;
      ps.guardians.push(c);
      return { ok: true };
    }
    case 'mill_self': {
      for (let i = 0; i < eff.value; i++) {
        if (ps.deck.length === 0) break;
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.graveyard.push(c);
      }
      return { ok: true };
    }
    case 'graveyard_to_deck_bottom_then_draw': {
      const idx = ps.graveyard.findIndex((c) => c.uid === targetUid && getCard(c.cardId).type !== 'maryoku');
      if (idx !== -1) {
        const [c] = ps.graveyard.splice(idx, 1);
        ps.deck.push(c);
      }
      drawCards(game, ps, eff.drawValue || 0);
      return { ok: true };
    }
    case 'opponent_discard_random': {
      for (let i = 0; i < (eff.value || 1); i++) {
        if (opp.hand.length === 0) break;
        const idx = Math.floor(Math.random() * opp.hand.length);
        const [c] = opp.hand.splice(idx, 1);
        c.faceUp = true;
        opp.graveyard.push(c);
      }
      return { ok: true };
    }
    case 'discard_own_hand': {
      const idx = ps.hand.findIndex((h) => h.uid === targetUid);
      if (idx === -1) return { ok: false, error: '対象の手札が見つかりません。' };
      const [c] = ps.hand.splice(idx, 1);
      c.faceUp = true;
      ps.graveyard.push(c);
      return { ok: true };
    }
    case 'bounce_all_tapped_opponent_ijin': {
      for (const t of opp.field.ijin.filter((i) => i.tapped)) {
        opp.field.ijin.splice(opp.field.ijin.indexOf(t), 1);
        t.faceUp = true;
        opp.hand.push(t);
      }
      return { ok: true };
    }
    case 'all_guardians_to_facedown_mana_then_draw_guardians': {
      for (const g of ps.guardians.slice()) {
        ps.guardians.splice(ps.guardians.indexOf(g), 1);
        g.faceUp = false;
        g.tapped = false;
        ps.mana.push(g);
      }
      for (let i = 0; i < (eff.count || 0); i++) {
        if (ps.deck.length === 0) break;
        const c = ps.deck.shift();
        c.faceUp = false;
        c.tapped = false;
        ps.guardians.push(c);
      }
      return { ok: true };
    }
    case 'destroy_all_opponent_ijin_pow_at_most_and_all_haikei': {
      for (const t of opp.field.ijin.filter((i) => effectivePower(i, opp) <= eff.powerMax)) destroyFieldOrGuardian(game, opp, t);
      for (const h of opp.field.haikei.slice()) destroyFieldOrGuardian(game, opp, h);
      return { ok: true };
    }
    case 'manafy_all_tapped_opponent_ijin': {
      for (const t of opp.field.ijin.filter((i) => i.tapped)) {
        opp.field.ijin.splice(opp.field.ijin.indexOf(t), 1);
        t.faceUp = false;
        t.tapped = false;
        opp.mana.push(t);
      }
      return { ok: true };
    }
    case 'deck_bottom_all_opponent_ijin_without_legacy': {
      for (const t of opp.field.ijin.filter((i) => !getCard(i.cardId).legacy)) {
        opp.field.ijin.splice(opp.field.ijin.indexOf(t), 1);
        opp.deck.push(t);
      }
      return { ok: true };
    }
    case 'flip_opponent_mana_facedown': {
      const target = opp.mana.find((m) => m.uid === targetUid && m.faceUp);
      if (!target) return { ok: false, error: '対象の表向きマリョクが見つかりません。' };
      target.faceUp = false;
      return { ok: true };
    }
    case 'bounce_or_deck_top_based_on_tapped': {
      const target = resolveScopedIjinTarget(ps, opp, 'either', targetUid);
      if (!target) return { ok: false, error: '対象が見つかりません。' };
      const owner = target.owner;
      owner.field.ijin.splice(owner.field.ijin.indexOf(target.inst), 1);
      if (target.inst.tapped) {
        target.inst.faceUp = false;
        owner.deck.unshift(target.inst);
      } else {
        target.inst.faceUp = true;
        owner.hand.push(target.inst);
      }
      return { ok: true };
    }
    case 'revive_ijin_to_field_from_graveyard': {
      const cap = eff.levelMax != null ? eff.levelMax : Infinity;
      const idx = ps.graveyard.findIndex((c) => c.uid === targetUid && getCard(c.cardId).type === 'ijin' && getCard(c.cardId).level <= cap);
      if (idx === -1) return { ok: false, error: '対象の墓地のイジンが見つかりません。' };
      const [inst] = ps.graveyard.splice(idx, 1);
      inst.faceUp = true;
      inst.tapped = false;
      inst.sick = true;
      ps.field.ijin.push(inst);
      return { ok: true };
    }
    case 'bounce_highest_level_field_card': {
      const allCards = [
        ...ps.field.ijin.map((i) => ({ owner: ps, list: ps.field.ijin, inst: i })),
        ...ps.field.haikei.map((i) => ({ owner: ps, list: ps.field.haikei, inst: i })),
        ...opp.field.ijin.map((i) => ({ owner: opp, list: opp.field.ijin, inst: i })),
        ...opp.field.haikei.map((i) => ({ owner: opp, list: opp.field.haikei, inst: i })),
      ];
      const found = allCards.find((c) => c.inst.uid === targetUid);
      if (!found) return { ok: false, error: '対象が見つかりません。' };
      found.list.splice(found.list.indexOf(found.inst), 1);
      found.inst.faceUp = true;
      found.owner.hand.push(found.inst);
      return { ok: true };
    }
    case 'bounce_tapped_card_to_deck_bottom': {
      const pools = [
        { owner: ps, list: ps.field.ijin }, { owner: ps, list: ps.field.haikei },
        { owner: opp, list: opp.field.ijin }, { owner: opp, list: opp.field.haikei },
      ];
      for (const p of pools) {
        const inst = p.list.find((i) => i.uid === targetUid && i.tapped);
        if (inst) {
          p.list.splice(p.list.indexOf(inst), 1);
          p.owner.deck.push(inst);
          return { ok: true };
        }
      }
      return { ok: false, error: '対象の寝ているカードが見つかりません。' };
    }
    case 'grant_temp_rush': {
      const target = resolveScopedIjinTarget(ps, opp, 'own', targetUid, eff.levelMax);
      if (!target) return { ok: false, error: '対象が見つかりません。' };
      target.inst.tempRushUntilEndOfTurn = true;
      return { ok: true };
    }
    case 'summon_hand_ijin_with_temp_rush': {
      const cap = eff.levelMax != null ? eff.levelMax : Infinity;
      const idx = ps.hand.findIndex((h) => h.uid === targetUid && getCard(h.cardId).type === 'ijin' && getCard(h.cardId).level <= cap);
      if (idx === -1) return { ok: false, error: '対象の手札のイジンが見つかりません。' };
      const [inst] = ps.hand.splice(idx, 1);
      inst.tapped = false;
      inst.sick = true;
      inst.tempRushUntilEndOfTurn = true;
      ps.field.ijin.push(inst);
      return { ok: true };
    }
    case 'destroy_all_field_haikei': {
      for (const h of ps.field.haikei.slice()) destroyFieldOrGuardian(game, ps, h);
      for (const h of opp.field.haikei.slice()) destroyFieldOrGuardian(game, opp, h);
      return { ok: true };
    }
    case 'tap_opponent_guardians_scaled_by_opponent_ijin': {
      const n = Math.min(opp.field.ijin.length, opp.guardians.filter((g) => !g.tapped).length);
      const untapped = opp.guardians.filter((g) => !g.tapped);
      for (let i = 0; i < n; i++) untapped[i].tapped = true;
      return { ok: true };
    }
    case 'grant_free_mahou_this_turn':
      ps.freeMahouThisTurn = true;
      return { ok: true };
    case 'move_self_to_facedown_mana': {
      if (!sourceInstance) return { ok: true };
      const found = findInstance(ps, sourceInstance.uid);
      if (!found || (found.zone !== 'ijin' && found.zone !== 'haikei')) return { ok: true };
      found.list.splice(found.idx, 1);
      sourceInstance.faceUp = false;
      sourceInstance.tapped = false;
      ps.mana.push(sourceInstance);
      return { ok: true };
    }
    case 'graveyard_mana_to_deck_then_facedown_mana_scaled': {
      const manaInGY = ps.graveyard.filter((c) => getCard(c.cardId).type === 'maryoku');
      if (manaInGY.length === 0) return { ok: false, error: '墓地にマリョクがありません。' };
      const n = manaInGY.length;
      for (let i = 0; i < n; i++) {
        if (ps.deck.length === 0) break;
        const c = ps.deck.shift();
        c.faceUp = false;
        c.tapped = false;
        ps.mana.push(c);
      }
      for (const c of manaInGY) {
        const idx = ps.graveyard.indexOf(c);
        if (idx !== -1) ps.graveyard.splice(idx, 1);
        ps.deck.push(c);
      }
      ps.deck = shuffle(ps.deck);
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

function resolveGenericEffectMaybeArray(game, ps, opp, eff, targetUid, sourceInstance) {
  if (!eff) return { ok: true };
  if (Array.isArray(eff)) {
    for (const e of eff) {
      const r = resolveGenericEffect(game, ps, opp, e, targetUid, sourceInstance);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  return resolveGenericEffect(game, ps, opp, eff, targetUid, sourceInstance);
}

function checkTriggerCondition(ps, opp, cond, sourceInstance) {
  if (!cond) return true;
  switch (cond.type) {
    case 'fieldHasColorIjin':
      return ps.field.ijin.some((i) => getCard(i.cardId).colors.includes(cond.color));
    case 'fieldHasTrait':
      return ps.field.ijin.some((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && (kw.trait === cond.trait || (kw.traits && kw.traits.includes(cond.trait)));
      });
    case 'ownIjinCountAtMost':
      return ps.field.ijin.length <= cond.value;
    case 'ownIjinCountAtLeast':
      return ps.field.ijin.length >= cond.value;
    case 'selfPowerAtLeast':
      return sourceInstance ? effectivePower(sourceInstance, ps) >= cond.value : false;
    case 'selfTapped':
      return !!(sourceInstance && sourceInstance.tapped);
    case 'ownGuardianCountAtLeast':
      return ps.guardians.length >= cond.value;
    case 'fieldHasIjinPowerAtLeast':
      return ps.field.ijin.some((i) => effectivePower(i, ps) >= cond.value);
    case 'ownDistinctHaikeiNamesAtLeast':
      return new Set(ps.field.haikei.map((h) => getCard(h.cardId).name)).size >= cond.value;
    case 'fieldColorIjinCountAtLeast':
      return ps.field.ijin.filter((i) => getCard(i.cardId).colors.includes(cond.color)).length >= cond.value;
    case 'ownManaCountAtLeast':
      return ps.mana.length >= cond.value;
    default:
      return true;
  }
}

function fireOnPlaceTrigger(game, ps, opp, instance, card, action) {
  const trig = card.triggers && card.triggers.onPlace;
  if (!trig) return;
  if (!checkTriggerCondition(ps, opp, trig.condition, instance)) return;
  const targetUid = action && action.triggerTargetUid;
  const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, targetUid, instance);
  if (result.ok) {
    log(game, `${ps.name}の「${card.name}」の能力が発動しました。`);
  }
}

function fireOnAttackerTrigger(game, ps, opp, instance, card, targetUid) {
  const trig = card.triggers && card.triggers.onAttacker;
  if (!trig) return;
  if (!checkTriggerCondition(ps, opp, trig.condition, instance)) return;
  const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, targetUid, instance);
  if (result.ok) {
    log(game, `${ps.name}の「${card.name}」の能力(アタッカーになったとき)が発動しました。`);
  }
}

function fireOnManaPlacedTriggers(game, ps, opp) {
  for (const instance of [...ps.field.ijin, ...ps.field.haikei]) {
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onManaPlaced;
    if (!trig || trig.needsTarget) continue;
    if (!checkTriggerCondition(ps, opp, trig.condition, instance)) continue;
    const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, null, instance);
    if (result.ok) {
      log(game, `${ps.name}の「${card.name}」の能力(決起)が発動しました。`);
    }
  }
}

function fireOnHaikeiPlacedTriggers(game, placedInstance, placedOwnerPs, placedCard) {
  for (const ownerId of game.players) {
    const ownerPs = game.playerStates[ownerId];
    const opp = game.playerStates[opponentId(game, ownerId)];
    for (const instance of [...ownerPs.field.ijin, ...ownerPs.field.haikei]) {
      const card = getCard(instance.cardId);
      const trig = card.triggers && card.triggers.onHaikeiPlaced;
      if (!trig || trig.needsTarget) continue;
      const isOwnSide = placedOwnerPs.id === ownerPs.id;
      if (trig.side === 'own' && !isOwnSide) continue;
      if (trig.colorFilter && !placedCard.colors.includes(trig.colorFilter)) continue;
      if (trig.oncePerTurn && instance.usedHaikeiTriggerThisTurn) continue;
      if (!checkTriggerCondition(ownerPs, opp, trig.condition, instance)) continue;
      const result = resolveGenericEffectMaybeArray(game, ownerPs, opp, trig.effect, null, instance);
      if (result.ok) {
        if (trig.oncePerTurn) instance.usedHaikeiTriggerThisTurn = true;
        log(game, `${ownerPs.name}の「${card.name}」の能力(執筆)が発動しました。`);
      }
    }
  }
}

function fireFieldStartTriggers(game, ps, opp, triggerKey, logSuffix) {
  for (const instance of [...ps.field.ijin, ...ps.field.haikei]) {
    if (game.winner) break;
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers[triggerKey];
    if (!trig || trig.needsTarget) continue;
    if (!checkTriggerCondition(ps, opp, trig.condition, instance)) continue;
    const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, null, instance);
    if (result.ok) {
      log(game, `${ps.name}の「${card.name}」の能力(${logSuffix})が発動しました。`);
    }
  }
}

function resolveMahouEffect(game, ps, opp, card, action) {
  const eff = card.effect;
  if (!eff) return { ok: true };
  if (Array.isArray(eff)) {
    return resolveGenericEffectMaybeArray(game, ps, opp, eff, action.targetUid, null);
  }

  switch (eff.type) {
    case 'unblockable_by_ijin': {
      const target = ps.field.ijin.find((i) => i.uid === action.targetUid);
      if (!target) return { ok: false, error: '対象の自分のイジンを指定してください。' };
      target.unblockableByIjin = true;
      return { ok: true };
    }
    case 'final_attack': {
      for (const i of ps.field.ijin) i.tapped = false;
      ps.extraBattleAvailable = true;
      ps.loseAtNextEndPhase = true;
      return { ok: true };
    }
    case 'bounce': {
      const targetPs = ps.field.ijin.find((i) => i.uid === action.targetUid) ? ps : opp;
      const target = targetPs.field.ijin.find((i) => i.uid === action.targetUid);
      if (!target) return { ok: false, error: '対象のイジンが見つかりません。' };
      targetPs.field.ijin.splice(targetPs.field.ijin.indexOf(target), 1);
      targetPs.hand.push(target);
      return { ok: true };
    }
    case 'revive_from_graveyard': {
      const target = ps.graveyard.find((i) => i.uid === action.targetUid);
      if (!target) return { ok: false, error: '対象の墓地のカードが見つかりません。' };
      const tCard = getCard(target.cardId);
      const okType = (tCard.type === 'ijin' && tCard.level <= 6) || (tCard.type === 'haikei' && tCard.level <= 5);
      if (!okType) return { ok: false, error: '対象はレベル6以下のイジン、またはレベル5以下のハイケイである必要があります。' };
      ps.graveyard.splice(ps.graveyard.indexOf(target), 1);
      ps.hand.push(target);
      return { ok: true };
    }
    case 'manafy_target': {
      const target = opp.field.ijin.find((i) => i.uid === action.targetUid);
      if (!target) return { ok: false, error: '対象の相手イジンが見つかりません。' };
      opp.field.ijin.splice(opp.field.ijin.indexOf(target), 1);
      target.faceUp = false;
      target.tapped = false;
      opp.mana.push(target);
      return { ok: true };
    }
    case 'loyalty': {
      if (action.sacrificeUid) {
        const kenjutsu = ps.field.ijin.find((i) => i.uid === action.sacrificeUid && getCard(i.cardId).keywords && getCard(i.cardId).keywords.trait === '剣術');
        if (kenjutsu) {
          destroyFieldOrGuardian(game, ps, kenjutsu);
        } else if (ps.guardians.length > 0) {
          const gd = ps.guardians.find((g) => g.uid === action.sacrificeUid) || ps.guardians[0];
          ps.guardians.splice(ps.guardians.indexOf(gd), 1);
          ps.deck.unshift(gd);
        }
      }
      drawCards(game, ps, 3);
      return { ok: true };
    }
    case 'destroy_own_ijin_and_opponent_guardian': {
      const own = ps.field.ijin.find((i) => i.uid === action.targetUid);
      const gUid = action.guardianUid;
      const guardian = opp.guardians.find((g) => g.uid === gUid);
      if (!own || !guardian) return { ok: false, error: '自分のイジンと相手のガーディアンを指定してください。' };
      destroyFieldOrGuardian(game, ps, own);
      destroyFieldOrGuardian(game, opp, guardian);
      return { ok: true };
    }
    case 'draw':
      return resolveGenericEffect(game, ps, opp, eff, action.targetUid, null);
    case 'refresh_guardians': {
      for (const g of ps.guardians.slice()) {
        ps.guardians.splice(ps.guardians.indexOf(g), 1);
        g.faceUp = true;
        ps.hand.push(g);
      }
      for (let i = 0; i < eff.value; i++) {
        if (ps.deck.length === 0) break;
        const c = ps.deck.shift();
        c.faceUp = false;
        c.tapped = false;
        ps.guardians.push(c);
      }
      return { ok: true };
    }
    case 'destroy_own_and_opponent_ijin': {
      const own = ps.field.ijin.find((i) => i.uid === action.targetUid);
      const enemy = opp.field.ijin.find((i) => i.uid === action.targetUid2);
      if (!own || !enemy) return { ok: false, error: '自分と相手のイジンをそれぞれ指定してください。' };
      destroyFieldOrGuardian(game, ps, own);
      destroyFieldOrGuardian(game, opp, enemy);
      return { ok: true };
    }
    case 'duel_ijin': {
      const own = ps.field.ijin.find((i) => i.uid === action.targetUid);
      const enemy = opp.field.ijin.find((i) => i.uid === action.targetUid2);
      if (!own || !enemy) return { ok: false, error: '自分の起きているイジンと相手のイジンをそれぞれ指定してください。' };
      if (own.tapped) return { ok: false, error: '自分のイジンは起きている必要があります。' };
      const ownPow = effectivePower(own, ps);
      const enemyPow = effectivePower(enemy, opp);
      if (ownPow === enemyPow) {
        own.tapped = true;
        enemy.tapped = true;
      } else if (ownPow > enemyPow) {
        own.tapped = true;
        destroyFieldOrGuardian(game, opp, enemy);
      } else {
        enemy.tapped = true;
        destroyFieldOrGuardian(game, ps, own);
      }
      return { ok: true };
    }
    case 'summon_right_plus':
    case 'mana_right_plus':
    case 'generic_destroy_ijin':
    case 'generic_bounce_ijin':
    case 'generic_destroy_guardian':
    case 'bounce_from_graveyard':
    case 'bounce_all_tapped_opponent_ijin':
    case 'all_guardians_to_facedown_mana_then_draw_guardians':
    case 'destroy_all_opponent_ijin_pow_at_most_and_all_haikei':
    case 'manafy_all_tapped_opponent_ijin':
    case 'deck_bottom_all_opponent_ijin_without_legacy':
    case 'flip_opponent_mana_facedown':
    case 'bounce_or_deck_top_based_on_tapped':
    case 'revive_ijin_to_field_from_graveyard':
    case 'bounce_highest_level_field_card':
    case 'bounce_tapped_card_to_deck_bottom':
    case 'grant_temp_rush':
    case 'summon_hand_ijin_with_temp_rush':
    case 'graveyard_mana_to_deck_then_facedown_mana_scaled':
    case 'deck_top_to_facedown_mana':
    case 'deck_top_to_guardian':
    case 'mill_opponent':
    case 'draw_then_discard_own_hand':
      return resolveGenericEffect(game, ps, opp, eff, action.targetUid, null);
    default:
      return { ok: true };
  }
}

// ---------- バトル ----------

function declareAttack(game, playerId, action) {
  const ps = game.playerStates[playerId];
  if (ps.attackedThisTurn && !ps.extraBattleAvailable) return { ok: false, error: 'このターンはすでにバトルを行いました。' };
  const uids = action.attackerUids || [];
  if (uids.length === 0) return { ok: false, error: 'アタッカーを1体以上選んでください。' };

  const attackers = [];
  for (const uid of uids) {
    const inst = ps.field.ijin.find((i) => i.uid === uid);
    if (!inst) return { ok: false, error: '対象のイジンが見つかりません。' };
    if (inst.tapped) return { ok: false, error: '寝ているイジンはアタッカーになれません。' };
    const card = getCard(inst.cardId);
    const rush = (card.keywords && card.keywords.rush) || inst.tempRushUntilEndOfTurn;
    if (inst.sick && !rush) return { ok: false, error: 'このターンに出したばかりのイジンはアタッカーになれません(即応を除く)。' };
    if (effectivePower(inst, ps) <= 0) return { ok: false, error: 'パワー0以下のイジンはアタッカーになれません。' };
    attackers.push(inst);
  }
  for (const a of attackers) a.tapped = true;

  const opp = game.playerStates[opponentId(game, playerId)];
  const attackerTriggerTargets = action.attackerTriggerTargets || {};
  for (const a of attackers) {
    const aCard = getCard(a.cardId);
    fireOnAttackerTrigger(game, ps, opp, a, aCard, attackerTriggerTargets[a.uid]);
  }

  if (ps.extraBattleAvailable) ps.extraBattleAvailable = false;
  else ps.attackedThisTurn = true;

  game.pendingBattle = {
    attackerPlayerId: playerId,
    attackers: attackers.map((a) => ({ uid: a.uid, blockers: [] })),
  };
  game.phase = 'block';
  log(game, `${ps.name}が${attackers.length}体でアタックしました。`);
  return { ok: true };
}

function declareBlock(game, playerId, action) {
  if (!game.pendingBattle) return { ok: false, error: 'バトル中ではありません。' };
  const defenderId = playerId;
  if (game.pendingBattle.attackerPlayerId === defenderId) return { ok: false, error: '防御側ではありません。' };
  const defender = game.playerStates[defenderId];
  const attackerPs = game.playerStates[game.pendingBattle.attackerPlayerId];

  const assignments = action.assignments || {};
  const usedBlockers = new Set();

  for (const entry of game.pendingBattle.attackers) {
    const blockerUids = assignments[entry.uid] || [];
    const blockers = [];
    for (const buid of blockerUids) {
      if (usedBlockers.has(buid)) return { ok: false, error: '同じブロッカーを複数回使うことはできません。' };
      let inst = defender.field.ijin.find((i) => i.uid === buid);
      let isGuardian = false;
      if (!inst) {
        inst = defender.guardians.find((i) => i.uid === buid);
        isGuardian = true;
      }
      if (!inst) return { ok: false, error: 'ブロッカーが見つかりません。' };
      const card = isGuardian ? null : getCard(inst.cardId);
      const watcher = card && card.keywords && card.keywords.watcher;
      if (inst.tapped && !watcher) return { ok: false, error: '寝ているカードはブロッカーになれません(ウォッチャーを除く)。' };
      if (card && card.static && card.static.cannotBlock) return { ok: false, error: `「${card.name}」はブロッカーになれません。` };
      usedBlockers.add(buid);
      blockers.push({ uid: buid, isGuardian, card });
    }

    const attackerInst = attackerPs.field.ijin.find((i) => i.uid === entry.uid);
    if (!attackerInst) {
      // アタッカーになった後の能力等ですでに戦場を離れている場合、このアタッカーは戦闘に参加しない
      entry.blockers = [];
      continue;
    }
    const attackerCard = getCard(attackerInst.cardId);
    if (attackerCard.static && attackerCard.static.unblockableBelowPower != null) {
      const threshold = attackerCard.static.unblockableBelowPower;
      const blockedByLowPowerIjin = blockers.some((b) => !b.isGuardian && effectivePower(defender.field.ijin.find((i) => i.uid === b.uid), defender) <= threshold);
      if (blockedByLowPowerIjin) return { ok: false, error: `このアタッカーはパワー${threshold}以下のイジンにブロックされません。` };
    }
    if (attackerCard.keywords && attackerCard.keywords.pressure) {
      if (blockers.length < attackerCard.keywords.pressure) {
        entry.blockers = [];
        continue;
      }
    }
    if (attackerInst.unblockableByIjin) {
      const nonGuardian = blockers.some((b) => !b.isGuardian);
      if (nonGuardian) return { ok: false, error: 'このアタッカーはイジンにブロックされません。ガーディアンのみ指定できます。' };
    }
    entry.blockers = blockers;
  }

  return resolveBattle(game);
}

function resolveBattle(game) {
  const battle = game.pendingBattle;
  const attackerId = battle.attackerPlayerId;
  const defenderId = opponentId(game, attackerId);
  const attackerPs = game.playerStates[attackerId];
  const defenderPs = game.playerStates[defenderId];

  for (const entry of battle.attackers) {
    const attackerInst = attackerPs.field.ijin.find((i) => i.uid === entry.uid);
    if (!attackerInst) continue; // 既に破壊済み等
    const atkPower = effectivePower(attackerInst, attackerPs);
    if (atkPower <= 0) continue; // 途中でパワー0以下になったアタッカーは対象から除外

    if (entry.blockers.length === 0) {
      endGame(game, attackerId, `${getCard(attackerInst.cardId).name}の攻撃が防がれなかったため`);
      game.pendingBattle = null;
      return { ok: true };
    }

    let blockersSum = 0;
    const blockerDetails = [];
    for (const b of entry.blockers) {
      if (b.isGuardian) {
        blockerDetails.push({ b, power: 0, isGuardian: true });
      } else {
        const inst = defenderPs.field.ijin.find((i) => i.uid === b.uid);
        if (!inst) continue;
        blockerDetails.push({ b, power: effectivePower(inst, defenderPs), isGuardian: false });
      }
      blockersSum += blockerDetails[blockerDetails.length - 1] ? blockerDetails[blockerDetails.length - 1].power : 0;
    }

    const attackerDies = blockersSum >= atkPower;
    if (attackerDies) destroyFieldOrGuardian(game, attackerPs, attackerInst);

    for (const bd of blockerDetails) {
      let blockerDies;
      if (bd.isGuardian) {
        blockerDies = atkPower > 0;
      } else {
        blockerDies = atkPower >= bd.power;
      }
      if (blockerDies) {
        const inst = bd.isGuardian
          ? defenderPs.guardians.find((g) => g.uid === bd.b.uid)
          : defenderPs.field.ijin.find((i) => i.uid === bd.b.uid);
        if (inst) destroyFieldOrGuardian(game, defenderPs, inst);
      }
    }
  }

  game.pendingBattle = null;
  game.phase = 'main';
  return { ok: true };
}

module.exports = {
  createGame,
  activePlayerId,
  opponentId,
  placeMana,
  summonIjin,
  playHaikei,
  castMahou,
  castMahouFromGraveyard,
  declareAttack,
  declareBlock,
  endTurn,
  levelSum,
  hasColorInMana,
  canUseCard,
  effectivePower,
  findInstance,
};
