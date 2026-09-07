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
    sum += m.tempLevelBonusThisTurn || 0;
  }
  for (const i of playerState.field.ijin) {
    const grant = equippedGrant(i);
    if (grant && grant.manaLevelSumBonus) sum += grant.manaLevelSumBonus;
  }
  for (const i of [...playerState.field.ijin, ...playerState.field.haikei]) {
    const card = getCard(i.cardId);
    if (!Array.isArray(card.effect)) continue;
    for (const g of card.effect) {
      if (g.type === 'grant_mana_level_bonus_if_own_stone_mana_present') {
        if (playerState.mana.some((m) => getCard(m.cardId).name.includes('ストーン'))) sum += g.value;
      }
    }
  }
  return sum;
}

// 「戦場のイジンすべては、このターンに限り『色：X』/『特性：X』を得る」のような
// 一時的な色・特性付与を反映した実効色・実効特性を返す。
function effectiveColors(instance) {
  const card = getCard(instance.cardId);
  return instance.tempColorsThisTurn ? [...card.colors, ...instance.tempColorsThisTurn] : card.colors;
}

function hasEffectiveTrait(instance, trait, ps) {
  const card = getCard(instance.cardId);
  const kw = card.keywords;
  const staticHas = kw && (kw.trait === trait || (kw.traits && kw.traits.includes(trait)));
  if (staticHas) return true;
  if (instance.tempTraitsThisTurn && instance.tempTraitsThisTurn.includes(trait)) return true;
  if (ps) {
    for (const h of ps.field.haikei) {
      const hCard = getCard(h.cardId);
      if (!Array.isArray(hCard.effect)) continue;
      for (const g of hCard.effect) {
        if (g.type === 'grant_trait_by_level_max' && g.trait === trait && card.level <= g.levelMax) return true;
      }
    }
  }
  return false;
}

// 「常在: ○○特性のイジンは即応を得る」のような、ハイケイの存在に依存する常時再計算の即応判定
function hasEffectiveRush(instance, ps) {
  const card = getCard(instance.cardId);
  if (card.keywords && card.keywords.rush) return true;
  if (instance.tempRushUntilEndOfTurn) return true;
  const equipGrant = equippedGrant(instance);
  if (equipGrant && equipGrant.rush) return true;
  for (const h of ps.field.haikei) {
    const hCard = getCard(h.cardId);
    if (!Array.isArray(hCard.effect)) continue;
    for (const g of hCard.effect) {
      if (g.type === 'grant_rush_by_trait' && hasEffectiveTrait(instance, g.trait, ps)) return true;
    }
  }
  return false;
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
  for (const i of playerState.field.ijin) {
    const grant = equippedGrant(i);
    if (grant && grant.powerBonusPerOwnHaikeiFieldWide) {
      bonus += grant.powerBonusPerOwnHaikeiFieldWide * playerState.field.haikei.length;
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
  let power = card.power + powerAuraBonus(playerState) + (instance.tempPowerBonusThisTurn || 0);
  const grant = equippedGrant(instance);
  if (grant) {
    if (grant.powerBonus) power += grant.powerBonus;
    if (grant.powerBonusPerOwnMana) power += grant.powerBonusPerOwnMana * playerState.mana.length;
    if (grant.powerBonusPerOwnColor) power += grant.powerBonusPerOwnColor * card.colors.length;
  }
  return power;
}

// アタック+N: アタッカーを選んでいる間だけ加算されるパワー修正
function attackContextPower(instance, playerState) {
  const card = getCard(instance.cardId);
  let bonus = (card.keywords && card.keywords.attackBonus) || 0;
  const grant = equippedGrant(instance);
  if (grant && grant.attackBonus) bonus += grant.attackBonus;
  bonus += instance.tempAttackBonusThisTurn || 0;
  return effectivePower(instance, playerState) + bonus;
}

// ドレイン: これがバトル解決で破壊した相手のカードは、遺業能力が発動しない
function hasEffectiveDrain(instance, ps, opp, game) {
  const card = getCard(instance.cardId);
  if (card.keywords && card.keywords.drain) return true;
  const cond = card.keywords && card.keywords.drainCondition;
  if (cond === 'opponentHandAtLeast3') return opp.hand.length >= 3;
  if (cond === 'ownTurn') return game.players[game.turnPlayerIndex] === ps.id;
  if (cond === 'drewViaManaAbility') return !!ps.drewViaManaAbilityThisTurn;
  return false;
}

// ブロック+N: ブロッカーを選んでいる間だけ加算されるパワー修正
function blockContextPower(instance, playerState) {
  const card = getCard(instance.cardId);
  let bonus = (card.keywords && card.keywords.blockBonus) || 0;
  const grant = equippedGrant(instance);
  if (grant && grant.blockBonus) bonus += grant.blockBonus;
  return effectivePower(instance, playerState) + bonus;
}

// ---------- 装備 ----------

function equippedGrant(instance) {
  if (!instance.equippedCard) return null;
  return getCard(instance.equippedCard.cardId).equipGrant || null;
}

function tryEquip(ps, ijinInstance, equipCardUid) {
  if (!equipCardUid) return;
  const ijinCard = getCard(ijinInstance.cardId);
  let found = ps.mana.find((m) => m.uid === equipCardUid);
  let zone = 'mana';
  if (!found) {
    found = ps.field.haikei.find((h) => h.uid === equipCardUid);
    zone = 'haikei';
  }
  if (!found) return;
  const eqCard = getCard(found.cardId);
  if (!eqCard.equipOffer) return;
  if (eqCard.equipOffer.colorAny && !ijinCard.colors.some((c) => eqCard.equipOffer.colorAny.includes(c))) return;
  if (eqCard.equipOffer.requireText && !(ijinCard.text || '').includes(eqCard.equipOffer.requireText)) return;

  if (zone === 'mana') ps.mana.splice(ps.mana.indexOf(found), 1);
  else ps.field.haikei.splice(ps.field.haikei.indexOf(found), 1);
  found.originZone = zone;
  found.originFaceUp = found.faceUp;
  ijinInstance.equippedCard = found;
}

function detachEquipmentIfAny(playerState, ijinInstance) {
  const eq = ijinInstance.equippedCard;
  if (!eq) return;
  ijinInstance.equippedCard = null;
  eq.faceUp = eq.originFaceUp;
  eq.tapped = false;
  if (eq.originZone === 'mana') playerState.mana.push(eq);
  else playerState.field.haikei.push(eq);
}

// ---------- 墓地移動 / 遺業能力 ----------

function moveToGraveyard(game, playerState, instance, fromZoneList, suppressLegacy) {
  const idx = fromZoneList.indexOf(instance);
  if (idx !== -1) fromZoneList.splice(idx, 1);
  const card = getCard(instance.cardId);
  instance.faceUp = true;
  playerState.graveyard.push(instance);
  log(game, `${playerState.name}の「${card.name}」が墓地に置かれました。`);

  if (card.legacy && !suppressLegacy) {
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
    } else if (card.legacy.type === 'kodama') {
      // 木霊: 自分の手札か墓地の、これより低いレベルを持つイジン1体をイジン召喚権を使わずに戦場に置く。
      // 対象選択が必要な遺業能力だが、戦場から墓地に置かれる処理の途中で同期的に発生するため、
      // このアプリでは最もレベルの高い(強い)候補を自動選択して処理する(公式仕様は対象を自由に選べる)。
      const pool = [...playerState.hand, ...playerState.graveyard].filter(
        (c) => c.uid !== instance.uid && getCard(c.cardId).type === 'ijin' && getCard(c.cardId).level < card.level
      );
      if (pool.length > 0) {
        pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
        const chosen = pool[0];
        const handIdx = playerState.hand.indexOf(chosen);
        if (handIdx !== -1) playerState.hand.splice(handIdx, 1);
        else {
          const gyIdx = playerState.graveyard.indexOf(chosen);
          if (gyIdx !== -1) playerState.graveyard.splice(gyIdx, 1);
        }
        chosen.faceUp = true;
        chosen.tapped = false;
        chosen.sick = true;
        playerState.field.ijin.push(chosen);
        log(game, `${playerState.name}は遺業能力(木霊)で「${getCard(chosen.cardId).name}」を戦場に置きました。`);
      }
    }
  }
}

function destroyFieldOrGuardian(game, playerState, instance, suppressLegacy) {
  if (instance.tempIndestructibleThisTurn) return;
  const found = findInstance(playerState, instance.uid);
  if (!found) return;
  if (found.zone !== 'ijin' && found.zone !== 'haikei' && found.zone !== 'guardian') return;
  const wasEquippedWith = found.zone === 'ijin' ? instance.equippedCard : null;
  if (found.zone === 'ijin') detachEquipmentIfAny(playerState, instance);
  moveToGraveyard(game, playerState, instance, found.list, suppressLegacy);
  fireOnFieldCardDestroyedTriggers(game, instance, playerState, getCard(instance.cardId), found.zone);
  if (wasEquippedWith) {
    const eqGrant = getCard(wasEquippedWith.cardId).equipGrant;
    if (eqGrant && eqGrant.undoOwnDestruction) {
      const idx = playerState.graveyard.indexOf(instance);
      if (idx !== -1) {
        playerState.graveyard.splice(idx, 1);
        instance.faceUp = true;
        instance.tapped = false;
        playerState.field.ijin.push(instance);
        log(game, `${playerState.name}の「${getCard(wasEquippedWith.cardId).name}」の効果で「${getCard(instance.cardId).name}」の破壊が取り消されました。`);
      }
    }
  }
}

function fireOnFieldCardDestroyedTriggers(game, destroyedInstance, destroyedOwnerPs, destroyedCard, destroyedZone) {
  for (const ownerId of game.players) {
    const ownerPs = game.playerStates[ownerId];
    const opp = game.playerStates[opponentId(game, ownerId)];
    const isOwnSide = destroyedOwnerPs.id === ownerPs.id;
    const candidates = [...ownerPs.field.ijin, ...ownerPs.field.haikei];
    if (isOwnSide) candidates.push(destroyedInstance);
    for (const instance of candidates) {
      const card = getCard(instance.cardId);
      const trig = card.triggers && card.triggers.onFieldCardDestroyed;
      if (!trig || trig.needsTarget) continue;
      if (trig.side === 'own' && !isOwnSide) continue;
      if (trig.side === 'opponent' && isOwnSide) continue;
      if (trig.zone && trig.zone !== destroyedZone) continue;
      if (trig.colorFilter && !destroyedCard.colors.includes(trig.colorFilter)) continue;
      if (trig.excludeSelf && instance.uid === destroyedInstance.uid) continue;
      if (trig.oncePerTurn && instance.usedFieldDestroyedTriggerThisTurn) continue;
      if (!checkTriggerCondition(ownerPs, opp, trig.condition, instance)) continue;
      const result = resolveGenericEffectMaybeArray(game, ownerPs, opp, trig.effect, destroyedInstance.uid, instance);
      if (result.ok) {
        if (trig.oncePerTurn) instance.usedFieldDestroyedTriggerThisTurn = true;
        log(game, `${ownerPs.name}の「${card.name}」の能力が発動しました。`);
      }
    }
  }
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
  ps.haikeiPlacedCountThisTurn = 0;
  ps.drewViaManaAbilityThisTurn = false;
  ps.attackerDestroyedThisTurn = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei, ...ps.guardians, ...ps.mana]) {
    inst.tapped = false;
  }
  for (const inst of ps.field.ijin) inst.sick = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei]) inst.usedHaikeiTriggerThisTurn = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei]) inst.usedAllyIjinTriggerThisTurn = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei]) inst.usedAllyAttackerTriggerThisTurn = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei]) inst.usedFieldDestroyedTriggerThisTurn = false;
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
  fireChoboTriggers(game, ps, game.playerStates[opponentId(game, playerId)]);
  if (ps.loseAtNextEndPhase) {
    endGame(game, opponentId(game, playerId), 'ファイナルアタックの代償');
    return;
  }
  for (const inst of ps.field.ijin) {
    inst.unblockableByIjin = false;
    inst.tempRushUntilEndOfTurn = false;
    inst.tempUnblockableAtLeastPowerThisTurn = null;
    inst.tempIndestructibleThisTurn = false;
    inst.tempPowerBonusThisTurn = 0;
    inst.tempPressureOverrideThisTurn = null;
    inst.tempAttackBonusThisTurn = 0;
  }
  for (const m of ps.mana) {
    m.tempLevelBonusThisTurn = 0;
  }
  // 「戦場のイジンすべては、このターンに限り〜を得る」のような両陣営に及ぶ一時付与は、
  // ターンの終わりに(付与した側・された側を問わず)ここでまとめてリセットする。
  for (const otherId of game.players) {
    for (const inst of game.playerStates[otherId].field.ijin) {
      inst.tempColorsThisTurn = null;
      inst.tempTraitsThisTurn = null;
    }
  }
  ps.freeMahouThisTurn = false;
  ps.cannotCastMahouThisTurn = false;
  ps.cannotAttackThisTurn = false;
  ps.manaAbilitiesDisabledThisTurn = false;

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

  if (!ps.manaAbilitiesDisabledThisTurn && action.mode === 'faceup' && card.onPlace && card.onPlace.type === 'draw') {
    drawCards(game, ps, card.onPlace.value);
    ps.drewViaManaAbilityThisTurn = true;
    log(game, `${ps.name}の「${card.name}」の効果で${card.onPlace.value}枚ドローしました。`);
  }
  log(game, `${ps.name}がマリョクを${action.mode === 'faceup' ? '表向き' : '裏向き'}で配置しました。`);
  fireOnManaPlacedTriggers(game, ps, game.playerStates[opponentId(game, playerId)], found.instance);
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
  if (action.equipCardUid) {
    tryEquip(ps, found.instance, action.equipCardUid);
    if (found.instance.equippedCard) {
      log(game, `${ps.name}が「${getCard(found.instance.equippedCard.cardId).name}」を「${card.name}」に装備させました。`);
      const eqGrant = getCard(found.instance.equippedCard.cardId).equipGrant;
      if (eqGrant && eqGrant.onEquipDraw) drawCards(game, ps, eqGrant.onEquipDraw);
    }
  }
  fireOnPlaceTrigger(game, ps, game.playerStates[opponentId(game, playerId)], found.instance, card, action);
  fireOnAllyIjinPlacedTriggers(game, found.instance, ps, card);
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
  ps.haikeiPlacedCountThisTurn = (ps.haikeiPlacedCountThisTurn || 0) + 1;
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
  if (ps.cannotCastMahouThisTurn) return { ok: false, error: 'このターンはマホウを使用できません。' };
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

  const handIdx = ps.hand.indexOf(found.instance);
  if (handIdx !== -1) ps.hand.splice(handIdx, 1);
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

/**
 * 反魂: 自分の戦場のガーディアン1体を山札の下に戻すことを代償に、
 * 墓地のイジンをイジン召喚権を使わずに戦場に置く。
 */
function reviveHankon(game, playerId, action) {
  const ps = game.playerStates[playerId];
  const found = ps.graveyard.find((c) => c.uid === action.cardUid);
  if (!found) return { ok: false, error: 'カードが墓地にありません。' };
  const card = getCard(found.cardId);
  if (card.type !== 'ijin') return { ok: false, error: 'イジンではありません。' };
  if (card.legacyText !== '反魂') return { ok: false, error: 'このイジンは反魂を持っていません。' };
  const guardian = ps.guardians.find((g) => g.uid === action.guardianUid);
  if (!guardian) return { ok: false, error: '山札の下に戻す自分のガーディアンを指定してください。' };

  ps.guardians.splice(ps.guardians.indexOf(guardian), 1);
  guardian.faceUp = true;
  ps.deck.push(guardian);

  ps.graveyard.splice(ps.graveyard.indexOf(found), 1);
  found.faceUp = true;
  found.tapped = false;
  found.sick = true;
  ps.field.ijin.push(found);
  log(game, `${ps.name}が反魂で「${card.name}」を戦場に置きました。`);
  fireOnPlaceTrigger(game, ps, game.playerStates[opponentId(game, playerId)], found, card, Object.assign({}, action, { viaHankon: true }));
  fireOnAllyIjinPlacedTriggers(game, found, ps, card);
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

function resolveFlexibleIjinOrHaikeiTarget(ps, opp, scope, uid) {
  const pools = [];
  if (scope === 'own' || scope === 'either') {
    pools.push({ owner: ps, zone: 'ijin' });
    pools.push({ owner: ps, zone: 'haikei' });
  }
  if (scope === 'opponent' || scope === 'either') {
    pools.push({ owner: opp, zone: 'ijin' });
    pools.push({ owner: opp, zone: 'haikei' });
  }
  for (const p of pools) {
    const inst = p.owner.field[p.zone].find((c) => c.uid === uid);
    if (inst) return { owner: p.owner, zone: p.zone, inst };
  }
  return null;
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
      detachEquipmentIfAny(target.owner, target.inst);
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
      const owner = eff.scope === 'opponent' ? opp : ps;
      const target = owner.mana.find((m) => m.uid === targetUid && !m.faceUp);
      if (!target) return { ok: false, error: '対象の裏向きマリョクが見つかりません。' };
      owner.mana.splice(owner.mana.indexOf(target), 1);
      target.faceUp = true;
      owner.hand.push(target);
      return { ok: true };
    }
    case 'bounce_self_to_hand': {
      if (!sourceInstance) return { ok: true };
      const idx = ps.field.ijin.indexOf(sourceInstance);
      if (idx !== -1) {
        detachEquipmentIfAny(ps, sourceInstance);
        ps.field.ijin.splice(idx, 1);
        sourceInstance.faceUp = true;
        ps.hand.push(sourceInstance);
      }
      return { ok: true };
    }
    case 'deck_top_and_bottom_to_facedown_mana': {
      if (ps.deck.length > 0) {
        const top = ps.deck.shift();
        top.faceUp = false;
        top.tapped = false;
        ps.mana.push(top);
      }
      if (ps.deck.length > 0) {
        const bottom = ps.deck.pop();
        bottom.faceUp = false;
        bottom.tapped = false;
        ps.mana.push(bottom);
      }
      return { ok: true };
    }
    case 'bounce_flexible_ijin_or_haikei': {
      const found = resolveFlexibleIjinOrHaikeiTarget(ps, opp, eff.scope, targetUid);
      if (!found) return { ok: false, error: '対象が見つかりません。' };
      const arr = found.owner.field[found.zone];
      if (found.zone === 'ijin') detachEquipmentIfAny(found.owner, found.inst);
      arr.splice(arr.indexOf(found.inst), 1);
      found.inst.faceUp = true;
      found.owner.hand.push(found.inst);
      return { ok: true };
    }
    case 'tap_opponent_ijin_power_below_attacker': {
      const attackerInst = ps.field.ijin.find((i) => i.uid === targetUid);
      if (!attackerInst) return { ok: false, error: '対象のアタッカーが見つかりません。' };
      const p = attackContextPower(attackerInst, ps);
      for (const t of opp.field.ijin) if (effectivePower(t, opp) < p) t.tapped = true;
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
        fireOnDiscardedFromHandTrigger(game, ps, opp, discarded);
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
    case 'untap_self':
      if (sourceInstance) sourceInstance.tapped = false;
      return { ok: true };
    case 'tap_self':
      if (sourceInstance) sourceInstance.tapped = true;
      return { ok: true };
    case 'tap_all_other_field_ijin_then_self_to_deck_bottom': {
      for (const inst of ps.field.ijin) if (!sourceInstance || inst.uid !== sourceInstance.uid) inst.tapped = true;
      for (const inst of opp.field.ijin) if (!sourceInstance || inst.uid !== sourceInstance.uid) inst.tapped = true;
      if (sourceInstance) {
        const idx = ps.field.ijin.indexOf(sourceInstance);
        if (idx !== -1) {
          detachEquipmentIfAny(ps, sourceInstance);
          ps.field.ijin.splice(idx, 1);
          sourceInstance.faceUp = true;
          ps.deck.push(sourceInstance);
        }
      }
      return { ok: true };
    }
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
    case 'graveyard_card_to_guardian_auto': {
      if (ps.graveyard.length === 0) return { ok: true };
      const c = ps.graveyard[0];
      ps.graveyard.splice(0, 1);
      c.faceUp = false;
      c.tapped = false;
      ps.guardians.push(c);
      return { ok: true };
    }
    case 'hand_card_to_guardian_by_uid': {
      const idx = ps.hand.findIndex((c) => c.uid === targetUid);
      if (idx === -1) return { ok: false, error: '対象の手札のカードが見つかりません。' };
      const [c] = ps.hand.splice(idx, 1);
      c.faceUp = false;
      c.tapped = false;
      ps.guardians.push(c);
      return { ok: true };
    }
    case 'facedown_mana_to_guardian_by_uid': {
      const idx = ps.mana.findIndex((c) => c.uid === targetUid && !c.faceUp);
      if (idx === -1) return { ok: false, error: '対象の裏向きのマリョクが見つかりません。' };
      const [c] = ps.mana.splice(idx, 1);
      c.tapped = false;
      ps.guardians.push(c);
      return { ok: true };
    }
    case 'reveal_opponent_deck_top_then_move_matching_color_ijin_to_guardian_auto': {
      if (opp.deck.length === 0) return { ok: true };
      const revealed = opp.deck[opp.deck.length - 1];
      const revealedColors = getCard(revealed.cardId).colors;
      for (const i of opp.field.ijin.slice()) {
        if (revealedColors.some((c) => effectiveColors(i).includes(c))) {
          opp.field.ijin.splice(opp.field.ijin.indexOf(i), 1);
          detachEquipmentIfAny(opp, i);
          i.faceUp = false;
          i.tapped = false;
          opp.guardians.push(i);
        }
      }
      return { ok: true };
    }
    case 'move_opponent_ijin_or_haikei_to_their_guardian_by_uid': {
      const ijinIdx = opp.field.ijin.findIndex((i) => i.uid === targetUid);
      if (ijinIdx !== -1) {
        const target = opp.field.ijin[ijinIdx];
        if (eff.ijinLevelMax != null && getCard(target.cardId).level > eff.ijinLevelMax) {
          return { ok: false, error: 'レベル条件を満たしていません。' };
        }
        opp.field.ijin.splice(ijinIdx, 1);
        detachEquipmentIfAny(opp, target);
        target.faceUp = false;
        target.tapped = false;
        opp.guardians.push(target);
        return { ok: true };
      }
      const haikeiIdx = opp.field.haikei.findIndex((h) => h.uid === targetUid);
      if (haikeiIdx !== -1) {
        const [h] = opp.field.haikei.splice(haikeiIdx, 1);
        h.faceUp = false;
        h.tapped = false;
        opp.guardians.push(h);
        return { ok: true };
      }
      return { ok: false, error: '対象が見つかりません。' };
    }
    case 'own_stone_mana_to_guardian_up_to_two_auto': {
      const pool = ps.mana.filter((m) => getCard(m.cardId).name.includes('ストーン'));
      for (const c of pool.slice(0, 2)) {
        ps.mana.splice(ps.mana.indexOf(c), 1);
        c.faceUp = false;
        c.tapped = false;
        ps.guardians.push(c);
      }
      return { ok: true };
    }
    case 'scaled_bonus_by_own_stone_mana_count': {
      const count = ps.mana.filter((m) => getCard(m.cardId).name.includes('ストーン')).length;
      if (count === 1) ps.manaRight += 1;
      else if (count === 2) ps.summonRight += 1;
      else if (count >= 3) drawCards(game, ps, 1);
      return { ok: true };
    }
    case 'grant_temp_level_bonus_own_stone_mana_this_turn': {
      for (const m of ps.mana) {
        if (getCard(m.cardId).name.includes('ストーン')) {
          m.tempLevelBonusThisTurn = (m.tempLevelBonusThisTurn || 0) + (eff.value || 1);
        }
      }
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
        fireOnDiscardedFromHandTrigger(game, opp, ps, c);
      }
      return { ok: true };
    }
    case 'discard_own_hand': {
      const idx = ps.hand.findIndex((h) => h.uid === targetUid);
      if (idx === -1) return { ok: false, error: '対象の手札が見つかりません。' };
      const [c] = ps.hand.splice(idx, 1);
      c.faceUp = true;
      ps.graveyard.push(c);
      fireOnDiscardedFromHandTrigger(game, ps, opp, c);
      return { ok: true };
    }
    case 'bounce_all_tapped_opponent_ijin': {
      for (const t of opp.field.ijin.filter((i) => i.tapped)) {
        detachEquipmentIfAny(opp, t);
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
        detachEquipmentIfAny(opp, t);
        opp.field.ijin.splice(opp.field.ijin.indexOf(t), 1);
        t.faceUp = false;
        t.tapped = false;
        opp.mana.push(t);
      }
      return { ok: true };
    }
    case 'deck_bottom_all_opponent_ijin_without_legacy': {
      for (const t of opp.field.ijin.filter((i) => !getCard(i.cardId).legacy)) {
        detachEquipmentIfAny(opp, t);
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
      detachEquipmentIfAny(owner, target.inst);
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
    case 'grant_temp_rush_self':
      if (sourceInstance) sourceInstance.tempRushUntilEndOfTurn = true;
      return { ok: true };
    case 'flip_own_mana_facedown': {
      const m = ps.mana.find((x) => x.faceUp);
      if (m) m.faceUp = false;
      return { ok: true };
    }
    case 'mill_self_then_temp_rush_self': {
      for (let i = 0; i < (eff.millValue || 0); i++) {
        if (ps.deck.length === 0) break;
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.graveyard.push(c);
      }
      if (sourceInstance) sourceInstance.tempRushUntilEndOfTurn = true;
      return { ok: true };
    }
    case 'own_guardian_to_facedown_mana': {
      const g = ps.guardians[0];
      if (!g) return { ok: true };
      ps.guardians.splice(0, 1);
      g.faceUp = false;
      g.tapped = false;
      ps.mana.push(g);
      return { ok: true };
    }
    case 'opponent_discard_random_non_maryoku': {
      const pool = opp.hand.filter((c) => getCard(c.cardId).type !== 'maryoku');
      for (let i = 0; i < (eff.value || 1) && pool.length > 0; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        const [c] = pool.splice(idx, 1);
        const handIdx = opp.hand.indexOf(c);
        if (handIdx !== -1) opp.hand.splice(handIdx, 1);
        c.faceUp = true;
        opp.graveyard.push(c);
        fireOnDiscardedFromHandTrigger(game, opp, ps, c);
      }
      return { ok: true };
    }
    case 'opponent_discard_random_filtered': {
      const pool = opp.hand.filter((c) => getCard(c.cardId).type === eff.cardType);
      for (let i = 0; i < (eff.value || 1) && pool.length > 0; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        const [c] = pool.splice(idx, 1);
        const handIdx = opp.hand.indexOf(c);
        if (handIdx !== -1) opp.hand.splice(handIdx, 1);
        c.faceUp = true;
        opp.graveyard.push(c);
        fireOnDiscardedFromHandTrigger(game, opp, ps, c);
      }
      return { ok: true };
    }
    case 'destroy_own_guardian': {
      const g = ps.guardians[0];
      if (g) destroyFieldOrGuardian(game, ps, g);
      return { ok: true };
    }
    case 'destroy_all_own_guardians': {
      for (const g of ps.guardians.slice()) destroyFieldOrGuardian(game, ps, g);
      return { ok: true };
    }
    case 'bounce_all_own_guardians': {
      for (const g of ps.guardians.slice()) {
        ps.guardians.splice(ps.guardians.indexOf(g), 1);
        g.faceUp = true;
        ps.hand.push(g);
      }
      return { ok: true };
    }
    case 'bounce_all_guardians_both_sides': {
      for (const g of ps.guardians.slice()) {
        ps.guardians.splice(ps.guardians.indexOf(g), 1);
        g.faceUp = true;
        ps.hand.push(g);
      }
      for (const g of opp.guardians.slice()) {
        opp.guardians.splice(opp.guardians.indexOf(g), 1);
        g.faceUp = true;
        opp.hand.push(g);
      }
      return { ok: true };
    }
    case 'destroy_highest_power_field_ijin': {
      const all = [...ps.field.ijin.map((i) => ({ owner: ps, inst: i })), ...opp.field.ijin.map((i) => ({ owner: opp, inst: i }))];
      const found = all.find((c) => c.inst.uid === targetUid);
      if (!found) return { ok: false, error: '対象が見つかりません。' };
      destroyFieldOrGuardian(game, found.owner, found.inst);
      return { ok: true };
    }
    case 'draw_scaled_by_own_haikei':
      drawCards(game, ps, ps.field.haikei.length);
      return { ok: true };
    case 'summon_right_plus_scaled_by_own_colors': {
      const colors = new Set();
      for (const i of ps.field.ijin) getCard(i.cardId).colors.forEach((c) => colors.add(c));
      ps.summonRight += colors.size;
      return { ok: true };
    }
    case 'draw_scaled_by_own_trait_count': {
      const n = ps.field.ijin.filter((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && (kw.trait === eff.trait || (kw.traits && kw.traits.includes(eff.trait)));
      }).length;
      drawCards(game, ps, n);
      return { ok: true };
    }
    case 'hand_card_to_deck_bottom_then_draw': {
      const idx = ps.hand.findIndex((h) => h.uid === targetUid);
      if (idx !== -1) {
        const [c] = ps.hand.splice(idx, 1);
        ps.deck.push(c);
      }
      drawCards(game, ps, eff.drawValue || 0);
      return { ok: true };
    }
    case 'haikei_to_deck_top': {
      const pool = eff.trait
        ? ps.field.haikei.filter((h) => {
            const kw = getCard(h.cardId).keywords;
            return kw && (kw.trait === eff.trait || (kw.traits && kw.traits.includes(eff.trait)));
          })
        : ps.field.haikei;
      const idx = pool.findIndex((h) => h.uid === targetUid);
      if (idx === -1) return { ok: false, error: '対象のハイケイが見つかりません。' };
      const inst = pool[idx];
      ps.field.haikei.splice(ps.field.haikei.indexOf(inst), 1);
      ps.deck.unshift(inst);
      return { ok: true };
    }
    case 'deck_bottom_all_tapped_opponent_ijin': {
      for (const t of opp.field.ijin.filter((i) => i.tapped)) {
        detachEquipmentIfAny(opp, t);
        opp.field.ijin.splice(opp.field.ijin.indexOf(t), 1);
        opp.deck.push(t);
      }
      return { ok: true };
    }
    case 'destroy_all_opponent_field_level_at_most': {
      for (const t of [...opp.field.ijin, ...opp.field.haikei].filter((i) => getCard(i.cardId).level <= eff.levelMax)) {
        destroyFieldOrGuardian(game, opp, t);
      }
      return { ok: true };
    }
    case 'bounce_all_graveyard_mahou_with_text': {
      for (const c of ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou' && (getCard(c.cardId).text || '').includes(eff.requireText)).slice()) {
        const idx = ps.graveyard.indexOf(c);
        if (idx !== -1) ps.graveyard.splice(idx, 1);
        c.faceUp = true;
        ps.hand.push(c);
      }
      return { ok: true };
    }
    case 'bounce_graveyard_mahou_scaled_by_own_mana_colors': {
      const colors = new Set();
      for (const m of ps.mana) if (m.faceUp) getCard(m.cardId).colors.forEach((c) => colors.add(c));
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou').sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      for (let i = 0; i < colors.size && pool.length > 0; i++) {
        const c = pool.shift();
        const idx = ps.graveyard.indexOf(c);
        if (idx !== -1) ps.graveyard.splice(idx, 1);
        c.faceUp = true;
        ps.hand.push(c);
      }
      return { ok: true };
    }
    case 'opponent_discard_down_to_own_hand_count': {
      while (opp.hand.length > ps.hand.length) {
        const idx = Math.floor(Math.random() * opp.hand.length);
        const [c] = opp.hand.splice(idx, 1);
        c.faceUp = true;
        opp.graveyard.push(c);
        fireOnDiscardedFromHandTrigger(game, opp, ps, c);
      }
      return { ok: true };
    }
    case 'manafy_highest_power_opponent_ijin': {
      if (opp.field.ijin.length === 0) return { ok: true };
      const target = opp.field.ijin.reduce((a, b) => (effectivePower(b, opp) > effectivePower(a, opp) ? b : a));
      detachEquipmentIfAny(opp, target);
      opp.field.ijin.splice(opp.field.ijin.indexOf(target), 1);
      target.faceUp = false;
      target.tapped = false;
      opp.mana.push(target);
      return { ok: true };
    }
    case 'bounce_graveyard_mahou_level_at_most_target_haikei': {
      const haikei = ps.field.haikei.find((h) => h.uid === targetUid);
      if (!haikei) return { ok: false, error: '対象のハイケイが見つかりません。' };
      const levelMax = getCard(haikei.cardId).level;
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou' && getCard(c.cardId).level <= levelMax);
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      const c = pool[0];
      const idx = ps.graveyard.indexOf(c);
      if (idx !== -1) ps.graveyard.splice(idx, 1);
      c.faceUp = true;
      ps.hand.push(c);
      return { ok: true };
    }
    case 'deck_top_n_to_facedown_mana': {
      for (let i = 0; i < (eff.value || 1); i++) {
        if (ps.deck.length === 0) break;
        const c = ps.deck.shift();
        c.faceUp = false;
        c.tapped = false;
        ps.mana.push(c);
      }
      return { ok: true };
    }
    case 'bounce_graveyard_mahou_color': {
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou' && getCard(c.cardId).colors.includes(eff.color));
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      const c = pool[0];
      ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
      c.faceUp = true;
      ps.hand.push(c);
      return { ok: true };
    }
    case 'deck_top_reveal_place_if_haikei': {
      if (ps.deck.length === 0) return { ok: true };
      const c = ps.deck[0];
      if (getCard(c.cardId).type === 'haikei') {
        ps.deck.shift();
        c.faceUp = true;
        c.tapped = false;
        ps.field.haikei.push(c);
      }
      return { ok: true };
    }
    case 'bounce_ijin_matching_color_of_placed_haikei': {
      const placedHaikei = [...ps.field.haikei, ...opp.field.haikei].find((h) => h.uid === targetUid);
      if (!placedHaikei) return { ok: false, error: '対象のハイケイが見つかりません。' };
      const colors = getCard(placedHaikei.cardId).colors;
      const oppMatch = opp.field.ijin.find((i) => getCard(i.cardId).colors.some((c) => colors.includes(c)));
      const ownMatch = ps.field.ijin.find((i) => getCard(i.cardId).colors.some((c) => colors.includes(c)));
      const target = oppMatch ? { owner: opp, inst: oppMatch } : ownMatch ? { owner: ps, inst: ownMatch } : null;
      if (!target) return { ok: true };
      detachEquipmentIfAny(target.owner, target.inst);
      target.owner.field.ijin.splice(target.owner.field.ijin.indexOf(target.inst), 1);
      target.inst.faceUp = true;
      target.owner.hand.push(target.inst);
      return { ok: true };
    }
    case 'tap_all_non_shippitsu_ijin_both_sides': {
      for (const i of ps.field.ijin) if (!(getCard(i.cardId).triggers && getCard(i.cardId).triggers.onHaikeiPlaced)) i.tapped = true;
      for (const i of opp.field.ijin) if (!(getCard(i.cardId).triggers && getCard(i.cardId).triggers.onHaikeiPlaced)) i.tapped = true;
      return { ok: true };
    }
    case 'deck_bottom_highest_power_opponent_ijin': {
      if (opp.field.ijin.length === 0) return { ok: true };
      const target = opp.field.ijin.reduce((a, b) => (effectivePower(b, opp) > effectivePower(a, opp) ? b : a));
      detachEquipmentIfAny(opp, target);
      opp.field.ijin.splice(opp.field.ijin.indexOf(target), 1);
      target.faceUp = true;
      opp.deck.push(target);
      return { ok: true };
    }
    case 'draw_scaled_by_own_color_count_then_destroy_self': {
      const count = [...ps.field.ijin, ...ps.field.haikei].filter((i) => getCard(i.cardId).colors.includes(eff.color)).length;
      drawCards(game, ps, Math.floor(count / (eff.divisor || 1)));
      if (sourceInstance) destroyFieldOrGuardian(game, ps, sourceInstance);
      return { ok: true };
    }
    case 'haikei_to_facedown_mana_by_uid': {
      const idx = ps.field.haikei.findIndex((h) => h.uid === targetUid);
      if (idx === -1) return { ok: false, error: '対象のハイケイが見つかりません。' };
      const inst = ps.field.haikei[idx];
      ps.field.haikei.splice(idx, 1);
      inst.faceUp = false;
      inst.tapped = false;
      ps.mana.push(inst);
      return { ok: true };
    }
    case 'move_flexible_guardian_or_graveyard_to_deck_top': {
      const guardian = ps.guardians.find((g) => g.uid === targetUid);
      if (guardian) {
        ps.guardians.splice(ps.guardians.indexOf(guardian), 1);
        guardian.faceUp = true;
        ps.deck.unshift(guardian);
        return { ok: true };
      }
      const grave = ps.graveyard.find((c) => c.uid === targetUid);
      if (grave) {
        ps.graveyard.splice(ps.graveyard.indexOf(grave), 1);
        grave.faceUp = true;
        ps.deck.unshift(grave);
        return { ok: true };
      }
      return { ok: false, error: '対象が見つかりません。' };
    }
    case 'deck_bottom_highest_power_field_ijin_scaled_by_own_guardians': {
      const n = ps.guardians.length;
      const excludeUid = sourceInstance ? sourceInstance.uid : null;
      for (let i = 0; i < n; i++) {
        const all = [...ps.field.ijin.filter((i) => i.uid !== excludeUid).map((inst) => ({ owner: ps, inst })), ...opp.field.ijin.map((inst) => ({ owner: opp, inst }))];
        if (all.length === 0) break;
        const best = all.reduce((a, b) => (effectivePower(b.inst, b.owner) > effectivePower(a.inst, a.owner) ? b : a));
        detachEquipmentIfAny(best.owner, best.inst);
        best.owner.field.ijin.splice(best.owner.field.ijin.indexOf(best.inst), 1);
        best.inst.faceUp = true;
        best.owner.deck.push(best.inst);
      }
      return { ok: true };
    }
    case 'flip_flexible_ijin_or_haikei_to_facedown_mana': {
      const found = resolveFlexibleIjinOrHaikeiTarget(ps, opp, eff.scope, targetUid);
      if (!found) return { ok: false, error: '対象が見つかりません。' };
      const arr = found.owner.field[found.zone];
      if (found.zone === 'ijin') detachEquipmentIfAny(found.owner, found.inst);
      arr.splice(arr.indexOf(found.inst), 1);
      found.inst.faceUp = false;
      found.inst.tapped = false;
      found.owner.mana.push(found.inst);
      return { ok: true };
    }
    case 'tap_flexible_own_ijin_or_guardian': {
      const ijinTarget = ps.field.ijin.find((i) => i.uid === targetUid);
      if (ijinTarget) {
        ijinTarget.tapped = true;
        return { ok: true };
      }
      const guardianTarget = ps.guardians.find((g) => g.uid === targetUid);
      if (guardianTarget) {
        guardianTarget.tapped = true;
        return { ok: true };
      }
      return { ok: false, error: '対象が見つかりません。' };
    }
    case 'destroy_flexible_tapped_ijin_or_guardian_auto': {
      const excludeUid = sourceInstance ? sourceInstance.uid : null;
      const pool = [
        ...opp.field.ijin.filter((i) => i.tapped && i.uid !== excludeUid).map((inst) => ({ owner: opp, zone: 'ijin', inst })),
        ...opp.guardians.filter((g) => g.tapped && g.uid !== excludeUid).map((inst) => ({ owner: opp, zone: 'guardian', inst })),
        ...ps.field.ijin.filter((i) => i.tapped && i.uid !== excludeUid).map((inst) => ({ owner: ps, zone: 'ijin', inst })),
        ...ps.guardians.filter((g) => g.tapped && g.uid !== excludeUid).map((inst) => ({ owner: ps, zone: 'guardian', inst })),
      ];
      if (pool.length === 0) return { ok: true };
      destroyFieldOrGuardian(game, pool[0].owner, pool[0].inst);
      return { ok: true };
    }
    case 'destroy_all_opponent_ijin_power_at_most': {
      for (const t of opp.field.ijin.filter((i) => effectivePower(i, opp) <= eff.value).slice()) destroyFieldOrGuardian(game, opp, t);
      return { ok: true };
    }
    case 'destroy_all_opponent_field_haikei': {
      for (const h of opp.field.haikei.slice()) destroyFieldOrGuardian(game, opp, h);
      return { ok: true };
    }
    case 'bounce_all_graveyard_haikei_to_hand': {
      for (const c of ps.graveyard.filter((c) => getCard(c.cardId).type === 'haikei').slice()) {
        ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
        c.faceUp = true;
        ps.hand.push(c);
      }
      return { ok: true };
    }
    case 'revive_flexible_ijin_or_haikei_from_graveyard': {
      const idx = ps.graveyard.findIndex((c) => c.uid === targetUid);
      if (idx === -1) return { ok: false, error: '対象の墓地のカードが見つかりません。' };
      const card = getCard(ps.graveyard[idx].cardId);
      if (card.type === 'ijin' && (eff.ijinLevelMax == null || card.level <= eff.ijinLevelMax)) {
        const [inst] = ps.graveyard.splice(idx, 1);
        inst.faceUp = true;
        inst.tapped = false;
        inst.sick = true;
        ps.field.ijin.push(inst);
        return { ok: true };
      }
      if (card.type === 'haikei' && (eff.haikeiLevelMax == null || card.level <= eff.haikeiLevelMax)) {
        const [inst] = ps.graveyard.splice(idx, 1);
        inst.faceUp = true;
        inst.tapped = false;
        ps.field.haikei.push(inst);
        return { ok: true };
      }
      return { ok: false, error: '対象がレベル条件を満たしていません。' };
    }
    case 'bounce_up_to_two_graveyard_haikei_auto': {
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'haikei').sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      for (let i = 0; i < 2 && pool.length > 0; i++) {
        const c = pool.shift();
        ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
        c.faceUp = true;
        ps.hand.push(c);
      }
      return { ok: true };
    }
    case 'destroy_flexible_ijin_or_haikei': {
      const found = resolveFlexibleIjinOrHaikeiTarget(ps, opp, eff.scope, targetUid);
      if (!found) return { ok: false, error: '対象が見つかりません。' };
      if (found.zone === 'ijin' && eff.powerMax != null && effectivePower(found.inst, found.owner) > eff.powerMax) {
        return { ok: false, error: 'パワー条件を満たしていません。' };
      }
      destroyFieldOrGuardian(game, found.owner, found.inst);
      return { ok: true };
    }
    case 'destroy_highest_power_untapped_opponent_ijin': {
      const pool = opp.field.ijin.filter((i) => !i.tapped);
      if (pool.length === 0) return { ok: true };
      const best = pool.reduce((a, b) => (effectivePower(b, opp) > effectivePower(a, opp) ? b : a));
      destroyFieldOrGuardian(game, opp, best);
      return { ok: true };
    }
    case 'bounce_equipped_card_by_uid': {
      const holder = [...ps.field.ijin, ...opp.field.ijin].find((i) => i.equippedCard && i.equippedCard.uid === targetUid);
      if (!holder) return { ok: false, error: '対象の装備カードが見つかりません。' };
      const holderOwner = ps.field.ijin.includes(holder) ? ps : opp;
      const equipInst = holder.equippedCard;
      holder.equippedCard = null;
      equipInst.faceUp = true;
      holderOwner.hand.push(equipInst);
      return { ok: true };
    }
    case 'bounce_own_facedown_cards_scaled_by_haikei_colors': {
      const colors = new Set();
      for (const h of ps.field.haikei) getCard(h.cardId).colors.forEach((c) => colors.add(c));
      const pool = ps.mana.filter((m) => !m.faceUp);
      for (let i = 0; i < colors.size && pool.length > 0; i++) {
        const c = pool.shift();
        ps.mana.splice(ps.mana.indexOf(c), 1);
        c.faceUp = true;
        ps.hand.push(c);
      }
      return { ok: true };
    }
    case 'bounce_all_field_trait_level_at_most': {
      for (const t of [...ps.field.ijin, ...ps.field.haikei].filter((i) => {
        const c = getCard(i.cardId);
        const kw = c.keywords;
        const hasTrait = kw && (kw.trait === eff.trait || (kw.traits && kw.traits.includes(eff.trait)));
        return hasTrait && c.level <= eff.levelMax;
      })) {
        const zone = ps.field.ijin.includes(t) ? 'ijin' : 'haikei';
        if (zone === 'ijin') detachEquipmentIfAny(ps, t);
        ps.field[zone].splice(ps.field[zone].indexOf(t), 1);
        t.faceUp = true;
        ps.hand.push(t);
      }
      for (const t of [...opp.field.ijin, ...opp.field.haikei].filter((i) => {
        const c = getCard(i.cardId);
        const kw = c.keywords;
        const hasTrait = kw && (kw.trait === eff.trait || (kw.traits && kw.traits.includes(eff.trait)));
        return hasTrait && c.level <= eff.levelMax;
      })) {
        const zone = opp.field.ijin.includes(t) ? 'ijin' : 'haikei';
        if (zone === 'ijin') detachEquipmentIfAny(opp, t);
        opp.field[zone].splice(opp.field[zone].indexOf(t), 1);
        t.faceUp = true;
        opp.hand.push(t);
      }
      return { ok: true };
    }
    case 'flip_facedown_mana_haikei_to_field_then_bounce_and_summon_right': {
      const target = ps.mana.find((m) => m.uid === targetUid && !m.faceUp);
      if (!target) return { ok: false, error: '対象の裏向きマリョクが見つかりません。' };
      const card = getCard(target.cardId);
      if (card.type !== 'haikei' || (eff.levelMax != null && card.level > eff.levelMax)) {
        return { ok: false, error: '対象がハイケイ・レベル条件を満たしていません。' };
      }
      ps.mana.splice(ps.mana.indexOf(target), 1);
      target.faceUp = true;
      target.tapped = false;
      ps.field.haikei.push(target);
      if (opp.field.ijin.length > 0) {
        const best = opp.field.ijin.reduce((a, b) => (effectivePower(b, opp) > effectivePower(a, opp) ? b : a));
        detachEquipmentIfAny(opp, best);
        opp.field.ijin.splice(opp.field.ijin.indexOf(best), 1);
        best.faceUp = true;
        opp.deck.push(best);
      }
      ps.summonRight += 1;
      return { ok: true };
    }
    case 'grant_temp_unblockable_and_indestructible_self':
      if (sourceInstance) {
        sourceInstance.unblockableByIjin = true;
        sourceInstance.tempIndestructibleThisTurn = true;
      }
      return { ok: true };
    case 'flexible_haikei_or_equipped_to_deck_bottom': {
      const haikei = [...ps.field.haikei, ...opp.field.haikei].find((h) => h.uid === targetUid);
      if (haikei) {
        const owner = ps.field.haikei.includes(haikei) ? ps : opp;
        owner.field.haikei.splice(owner.field.haikei.indexOf(haikei), 1);
        haikei.faceUp = true;
        owner.deck.push(haikei);
        return { ok: true };
      }
      const holder = [...ps.field.ijin, ...opp.field.ijin].find((i) => i.equippedCard && i.equippedCard.uid === targetUid);
      if (holder) {
        const holderOwner = ps.field.ijin.includes(holder) ? ps : opp;
        const equipInst = holder.equippedCard;
        holder.equippedCard = null;
        equipInst.faceUp = true;
        holderOwner.deck.push(equipInst);
        return { ok: true };
      }
      return { ok: false, error: '対象が見つかりません。' };
    }
    case 'move_self_to_deck_bottom': {
      if (!sourceInstance) return { ok: true };
      const idx = ps.field.ijin.indexOf(sourceInstance);
      if (idx !== -1) {
        detachEquipmentIfAny(ps, sourceInstance);
        ps.field.ijin.splice(idx, 1);
        sourceInstance.faceUp = true;
        ps.deck.push(sourceInstance);
      }
      return { ok: true };
    }
    case 'mill_self_then_graveyard_to_deck_top': {
      for (let i = 0; i < (eff.millValue || 1); i++) {
        if (ps.deck.length === 0) break;
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.graveyard.push(c);
      }
      if (!targetUid) return { ok: true };
      const idx = ps.graveyard.findIndex((c) => c.uid === targetUid);
      if (idx === -1) return { ok: false, error: '対象の墓地のカードが見つかりません。' };
      const [c] = ps.graveyard.splice(idx, 1);
      c.faceUp = true;
      ps.deck.unshift(c);
      return { ok: true };
    }
    case 'mill_self_then_graveyard_to_hand_auto': {
      for (let i = 0; i < (eff.millValue || 1); i++) {
        if (ps.deck.length === 0) break;
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.graveyard.push(c);
      }
      if (ps.graveyard.length === 0) return { ok: true };
      const pool = ps.graveyard.slice().sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      const c = pool[0];
      ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
      c.faceUp = true;
      ps.hand.push(c);
      return { ok: true };
    }
    case 'destroy_target_haikei_and_highest_power_opponent_ijin_at_most': {
      const haikei = ps.field.haikei.find((h) => h.uid === targetUid) || opp.field.haikei.find((h) => h.uid === targetUid);
      if (haikei) {
        const owner = ps.field.haikei.includes(haikei) ? ps : opp;
        destroyFieldOrGuardian(game, owner, haikei);
      }
      const pool = opp.field.ijin.filter((i) => effectivePower(i, opp) <= eff.powerMax);
      if (pool.length > 0) {
        const best = pool.reduce((a, b) => (effectivePower(b, opp) > effectivePower(a, opp) ? b : a));
        destroyFieldOrGuardian(game, opp, best);
      }
      return { ok: true };
    }
    case 'draw_entire_deck_then_optional_free_summon_then_reshuffle': {
      while (ps.deck.length > 0) ps.hand.push(ps.deck.shift());
      if (targetUid) {
        const idx = ps.hand.findIndex((c) => c.uid === targetUid);
        if (idx !== -1) {
          const cardData = getCard(ps.hand[idx].cardId);
          if (cardData.type === 'ijin' && cardData.level <= (eff.levelMax || Infinity)) {
            const [inst] = ps.hand.splice(idx, 1);
            inst.faceUp = true;
            inst.tapped = false;
            inst.sick = true;
            ps.field.ijin.push(inst);
          }
        }
      }
      while (ps.hand.length > 0) ps.deck.push(ps.hand.shift());
      ps.deck = shuffle(ps.deck);
      return { ok: true };
    }
    case 'flip_own_color_matching_ijin_to_mana': {
      const manaColors = new Set();
      for (const m of ps.mana) if (m.faceUp) getCard(m.cardId).colors.forEach((c) => manaColors.add(c));
      const target = ps.field.ijin.find((i) => i.uid === targetUid);
      if (!target || !getCard(target.cardId).colors.some((c) => manaColors.has(c))) {
        return { ok: false, error: '対象は自分の魔力ゾーンと同じ色のイジンである必要があります。' };
      }
      detachEquipmentIfAny(ps, target);
      ps.field.ijin.splice(ps.field.ijin.indexOf(target), 1);
      target.faceUp = false;
      target.tapped = false;
      ps.mana.push(target);
      return { ok: true };
    }
    case 'bounce_opponent_ijin_scaled_by_own_shippitsu_count': {
      const n = [...ps.field.ijin, ...ps.field.haikei].filter((i) => {
        const c = getCard(i.cardId);
        return c.triggers && c.triggers.onHaikeiPlaced;
      }).length;
      const pool = opp.field.ijin.slice(0, n);
      for (const t of pool) {
        detachEquipmentIfAny(opp, t);
        opp.field.ijin.splice(opp.field.ijin.indexOf(t), 1);
        t.faceUp = true;
        opp.hand.push(t);
      }
      return { ok: true };
    }
    case 'buff_or_tap_target_ijin_conditional': {
      const favorable = ps.field.ijin.find((i) => {
        if (sourceInstance && i.uid === sourceInstance.uid) return false;
        const c = getCard(i.cardId);
        const kw = c.keywords;
        return c.colors.includes('green') || (kw && (kw.trait === '思想' || (kw.traits && kw.traits.includes('思想'))));
      });
      if (favorable) {
        favorable.tapped = false;
        favorable.tempPowerBonusThisTurn = (favorable.tempPowerBonusThisTurn || 0) + 3000;
      } else if (opp.field.ijin.length > 0) {
        opp.field.ijin[0].tapped = true;
      }
      return { ok: true };
    }
    case 'bounce_own_haikei_by_uid': {
      const target = ps.field.haikei.find((h) => h.uid === targetUid);
      if (!target) return { ok: false, error: '対象の自分のハイケイが見つかりません。' };
      ps.field.haikei.splice(ps.field.haikei.indexOf(target), 1);
      target.faceUp = true;
      ps.hand.push(target);
      return { ok: true };
    }
    case 'tap_all_field_guardians_both_sides':
      for (const g of ps.guardians) g.tapped = true;
      for (const g of opp.guardians) g.tapped = true;
      return { ok: true };
    case 'tap_all_opponent_guardians':
      for (const g of opp.guardians) g.tapped = true;
      return { ok: true };
    case 'grant_temp_power_bonus_self':
      if (sourceInstance) sourceInstance.tempPowerBonusThisTurn = (sourceInstance.tempPowerBonusThisTurn || 0) + (eff.value || 0);
      return { ok: true };
    case 'grant_temp_power_bonus_target_opponent_ijin_by_uid': {
      const target = opp.field.ijin.find((i) => i.uid === targetUid);
      if (!target) return { ok: false, error: '対象の相手イジンが見つかりません。' };
      target.tempPowerBonusThisTurn = (target.tempPowerBonusThisTurn || 0) + (eff.value || 0);
      return { ok: true };
    }
    case 'move_graveyard_card_to_deck_bottom_by_uid': {
      const psIdx = ps.graveyard.findIndex((c) => c.uid === targetUid);
      if (psIdx !== -1) {
        const [c] = ps.graveyard.splice(psIdx, 1);
        c.faceUp = true;
        ps.deck.push(c);
        return { ok: true };
      }
      const oppIdx = opp.graveyard.findIndex((c) => c.uid === targetUid);
      if (oppIdx !== -1) {
        const [c] = opp.graveyard.splice(oppIdx, 1);
        c.faceUp = true;
        opp.deck.push(c);
        return { ok: true };
      }
      return { ok: true };
    }
    case 'revive_self_from_graveyard_undo_destruction': {
      if (!sourceInstance) return { ok: true };
      const idx = ps.graveyard.indexOf(sourceInstance);
      if (idx === -1) return { ok: true };
      ps.graveyard.splice(idx, 1);
      sourceInstance.faceUp = true;
      sourceInstance.tapped = false;
      const cardData = getCard(sourceInstance.cardId);
      if (cardData.type === 'haikei') ps.field.haikei.push(sourceInstance);
      else ps.field.ijin.push(sourceInstance);
      return { ok: true };
    }
    case 'bounce_graveyard_mahou_up_to_two_auto': {
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou').sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      for (let i = 0; i < 2 && pool.length > 0; i++) {
        const c = pool.shift();
        ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
        c.faceUp = true;
        ps.hand.push(c);
      }
      return { ok: true };
    }
    case 'bounce_graveyard_card_to_hand_by_uid_either_owner': {
      const psIdx = ps.graveyard.findIndex((c) => c.uid === targetUid);
      if (psIdx !== -1) {
        const [c] = ps.graveyard.splice(psIdx, 1);
        c.faceUp = true;
        ps.hand.push(c);
        return { ok: true };
      }
      const oppIdx = opp.graveyard.findIndex((c) => c.uid === targetUid);
      if (oppIdx !== -1) {
        const [c] = opp.graveyard.splice(oppIdx, 1);
        c.faceUp = true;
        opp.hand.push(c);
        return { ok: true };
      }
      return { ok: true };
    }
    case 'sacrifice_own_guardian_then_undo_self_destruction': {
      const g = ps.guardians[0];
      if (!g) return { ok: true };
      ps.guardians.splice(0, 1);
      g.faceUp = true;
      ps.graveyard.push(g);
      if (sourceInstance) {
        const idx = ps.graveyard.indexOf(sourceInstance);
        if (idx !== -1) {
          ps.graveyard.splice(idx, 1);
          sourceInstance.faceUp = true;
          sourceInstance.tapped = false;
          ps.field.ijin.push(sourceInstance);
        }
      }
      return { ok: true };
    }
    case 'place_hand_rush_ijin_free_auto': {
      const pool = ps.hand.filter((c) => {
        const card = getCard(c.cardId);
        return card.type === 'ijin' && card.level <= (eff.levelMax || Infinity) && card.keywords && card.keywords.rush;
      });
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power);
      const c = pool[0];
      ps.hand.splice(ps.hand.indexOf(c), 1);
      c.faceUp = true;
      c.tapped = false;
      c.sick = true;
      ps.field.ijin.push(c);
      return { ok: true };
    }
    case 'flip_destroyed_card_to_own_mana_instead': {
      const idx = ps.graveyard.findIndex((c) => c.uid === targetUid);
      if (idx === -1) return { ok: true };
      const [c] = ps.graveyard.splice(idx, 1);
      c.faceUp = false;
      c.tapped = false;
      ps.mana.push(c);
      return { ok: true };
    }
    case 'destroy_highest_level_field_haikei_auto': {
      const pool = [...opp.field.haikei.map((h) => ({ owner: opp, inst: h })), ...ps.field.haikei.map((h) => ({ owner: ps, inst: h }))];
      if (pool.length === 0) return { ok: true };
      const maxLevel = Math.max(...pool.map((p) => getCard(p.inst.cardId).level));
      const best = pool.find((p) => getCard(p.inst.cardId).level === maxLevel);
      destroyFieldOrGuardian(game, best.owner, best.inst);
      return { ok: true };
    }
    case 'place_highest_level_own_trait_card_from_hand_or_graveyard': {
      const matches = (c) => {
        const card = getCard(c.cardId);
        const kw = card.keywords;
        const hasTrait = kw && (kw.trait === eff.trait || (kw.traits && kw.traits.includes(eff.trait)));
        return hasTrait && card.level <= (eff.levelMax || Infinity);
      };
      const handPool = ps.hand.filter(matches).map((c) => ({ zone: 'hand', inst: c }));
      const gravePool = ps.graveyard.filter(matches).map((c) => ({ zone: 'graveyard', inst: c }));
      const pool = [...handPool, ...gravePool];
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.inst.cardId).level - getCard(a.inst.cardId).level);
      const { zone, inst } = pool[0];
      const list = zone === 'hand' ? ps.hand : ps.graveyard;
      list.splice(list.indexOf(inst), 1);
      inst.faceUp = true;
      inst.tapped = false;
      if (getCard(inst.cardId).type === 'ijin') {
        inst.sick = true;
        ps.field.ijin.push(inst);
      } else {
        ps.field.haikei.push(inst);
      }
      return { ok: true };
    }
    case 'grant_temp_pressure_all_own_ijin':
      for (const i of ps.field.ijin) i.tempPressureOverrideThisTurn = eff.value;
      return { ok: true };
    case 'grant_temp_pressure_self':
      if (sourceInstance) sourceInstance.tempPressureOverrideThisTurn = eff.value;
      return { ok: true };
    case 'tap_all_other_own_ijin_and_guardians_then_grant_temp_attack_bonus_self': {
      let count = 0;
      for (const i of ps.field.ijin) {
        if (sourceInstance && i.uid === sourceInstance.uid) continue;
        if (!i.tapped) { i.tapped = true; count += 1; }
      }
      for (const g of ps.guardians) {
        if (!g.tapped) { g.tapped = true; count += 1; }
      }
      if (sourceInstance && count > 0) sourceInstance.tempPowerBonusThisTurn = (sourceInstance.tempPowerBonusThisTurn || 0) + count * 2000;
      return { ok: true };
    }
    case 'deck_bottom_reveal_place_if_haikei': {
      if (ps.deck.length === 0) return { ok: true };
      const c = ps.deck[ps.deck.length - 1];
      if (getCard(c.cardId).type === 'haikei') {
        ps.deck.pop();
        c.faceUp = true;
        c.tapped = false;
        ps.field.haikei.push(c);
      }
      return { ok: true };
    }
    case 'grant_extra_battle':
      ps.extraBattleAvailable = true;
      return { ok: true };
    case 'bounce_own_guardian_auto': {
      const g = ps.guardians[0];
      if (!g) return { ok: true };
      ps.guardians.splice(0, 1);
      g.faceUp = true;
      ps.hand.push(g);
      return { ok: true };
    }
    case 'destroy_scaled_by_own_hand_music_ijin_level_sum': {
      const musicIjin = ps.hand.filter((c) => {
        const card = getCard(c.cardId);
        if (card.type !== 'ijin') return false;
        const kw = card.keywords;
        return kw && (kw.trait === '音楽' || (kw.traits && kw.traits.includes('音楽')));
      });
      const sum = musicIjin.reduce((s, c) => s + getCard(c.cardId).level, 0);
      if (sum >= (eff.threshold || 6)) {
        for (const t of opp.field.ijin.slice()) destroyFieldOrGuardian(game, opp, t);
      } else if (opp.field.ijin.length > 0) {
        const best = opp.field.ijin.reduce((a, b) => (effectivePower(b, opp) > effectivePower(a, opp) ? b : a));
        destroyFieldOrGuardian(game, opp, best);
      }
      return { ok: true };
    }
    case 'grant_temp_unblockable_at_least_power_self':
      if (sourceInstance) sourceInstance.tempUnblockableAtLeastPowerThisTurn = eff.value;
      return { ok: true };
    case 'draw_scaled_by_opponent_colors_then_untap_all_own_ijin': {
      const colors = new Set();
      for (const i of opp.field.ijin) getCard(i.cardId).colors.forEach((c) => colors.add(c));
      for (const h of opp.field.haikei) getCard(h.cardId).colors.forEach((c) => colors.add(c));
      drawCards(game, ps, colors.size);
      for (const i of ps.field.ijin) i.tapped = false;
      return { ok: true };
    }
    case 'tap_all_own_field_then_tap_opponent_scaled_by_non_attacker_count': {
      const attackerUid = targetUid;
      const nonAttackerCount = [...ps.field.ijin, ...ps.field.haikei].filter((i) => i.uid !== attackerUid).length;
      for (const i of ps.field.ijin) i.tapped = true;
      for (const h of ps.field.haikei) h.tapped = true;
      const oppCards = [...opp.field.ijin, ...opp.field.haikei].filter((c) => !c.tapped);
      for (let i = 0; i < nonAttackerCount && i < oppCards.length; i++) oppCards[i].tapped = true;
      return { ok: true };
    }
    case 'discard_hand_trait_card_then_draw_auto': {
      const pool = ps.hand.filter((c) => {
        const card = getCard(c.cardId);
        const kw = card.keywords;
        return kw && (kw.trait === eff.trait || (kw.traits && kw.traits.includes(eff.trait)));
      });
      if (pool.length === 0) return { ok: true };
      const c = pool[0];
      ps.hand.splice(ps.hand.indexOf(c), 1);
      c.faceUp = true;
      ps.graveyard.push(c);
      fireOnDiscardedFromHandTrigger(game, ps, opp, c);
      drawCards(game, ps, eff.drawValue || 0);
      return { ok: true };
    }
    case 'revive_graveyard_haikei_with_legacy_auto': {
      const pool = ps.graveyard.filter((c) => {
        const card = getCard(c.cardId);
        return card.type === 'haikei' && card.legacy;
      });
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      const c = pool[0];
      ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
      c.faceUp = true;
      c.tapped = false;
      ps.field.haikei.push(c);
      return { ok: true };
    }
    case 'tap_all_own_ijin_then_summon_right_plus_per_tapped_auto': {
      let count = 0;
      for (const i of ps.field.ijin) {
        if (!i.tapped) { i.tapped = true; count += 1; }
      }
      if (count > 0) ps.summonRight += count;
      return { ok: true };
    }
    case 'mill_self_up_to_3_scaled_bonus': {
      let milled = 0;
      for (let i = 0; i < 3; i++) {
        if (ps.deck.length === 0) break;
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.graveyard.push(c);
        milled += 1;
      }
      if (milled >= 1) ps.manaRight += 1;
      if (milled >= 2) ps.summonRight += 1;
      if (milled === 3) drawCards(game, ps, 1);
      return { ok: true };
    }
    case 'tap_own_field_ijin_color_or_trait_then_self_draw_auto': {
      const pool = ps.field.ijin.filter((i) => {
        if (i.tapped) return false;
        const card = getCard(i.cardId);
        const kw = card.keywords;
        const hasTrait = eff.trait && kw && (kw.trait === eff.trait || (kw.traits && kw.traits.includes(eff.trait)));
        return (eff.color && card.colors.includes(eff.color)) || hasTrait;
      });
      if (pool.length === 0) return { ok: true };
      pool[0].tapped = true;
      drawCards(game, ps, 1);
      return { ok: true };
    }
    case 'place_hand_ijin_free_auto_then_bounce_self': {
      const pool = ps.hand.filter((c) => {
        const card = getCard(c.cardId);
        return card.type === 'ijin' && card.level <= (eff.levelMax || Infinity) && card.colors.includes(eff.color);
      });
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      const c = pool[0];
      ps.hand.splice(ps.hand.indexOf(c), 1);
      c.faceUp = true;
      c.tapped = false;
      c.sick = true;
      ps.field.ijin.push(c);
      if (sourceInstance) {
        const idx = ps.field.ijin.indexOf(sourceInstance);
        if (idx !== -1) {
          ps.field.ijin.splice(idx, 1);
          ps.hand.push(sourceInstance);
        }
      }
      return { ok: true };
    }
    case 'flip_opponent_low_power_ijin_to_own_mana_then_bounce_own_ijin_all': {
      for (const t of opp.field.ijin.slice()) {
        if (effectivePower(t, opp) <= (eff.powerMax || 0)) {
          detachEquipmentIfAny(opp, t);
          opp.field.ijin.splice(opp.field.ijin.indexOf(t), 1);
          t.faceUp = false;
          t.tapped = false;
          opp.mana.push(t);
        }
      }
      for (const t of ps.field.ijin.slice()) {
        detachEquipmentIfAny(ps, t);
        ps.field.ijin.splice(ps.field.ijin.indexOf(t), 1);
        ps.hand.push(t);
      }
      return { ok: true };
    }
    case 'draw_scaled_by_own_summon_right':
      drawCards(game, ps, Math.max(0, ps.summonRight));
      return { ok: true };
    case 'graveyard_nonmana_card_to_deck_bottom_auto': {
      const c = ps.graveyard.find((g) => getCard(g.cardId).type !== 'maryoku');
      if (!c) return { ok: true };
      ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
      ps.deck.push(c);
      return { ok: true };
    }
    case 'flip_opponent_highest_power_ijin_to_own_mana_auto': {
      if (opp.field.ijin.length === 0) return { ok: true };
      const best = opp.field.ijin.reduce((a, b) => (effectivePower(b, opp) > effectivePower(a, opp) ? b : a));
      detachEquipmentIfAny(opp, best);
      opp.field.ijin.splice(opp.field.ijin.indexOf(best), 1);
      best.faceUp = false;
      best.tapped = false;
      opp.mana.push(best);
      return { ok: true };
    }
    case 'deck_top2_reveal_place_haikei_rest_to_hand': {
      const revealed = [];
      for (let i = 0; i < 2; i++) {
        if (ps.deck.length === 0) break;
        revealed.push(ps.deck.shift());
      }
      for (const c of revealed) {
        if (getCard(c.cardId).type === 'haikei') {
          c.faceUp = true;
          c.tapped = false;
          ps.field.haikei.push(c);
        } else {
          ps.hand.push(c);
        }
      }
      return { ok: true };
    }
    case 'destroy_self_then_shuffle_own_deck': {
      if (sourceInstance) destroyFieldOrGuardian(game, ps, sourceInstance);
      ps.deck = shuffle(ps.deck);
      return { ok: true };
    }
    case 'bounce_own_ijin_auto_then_draw': {
      const t = ps.field.ijin[0];
      if (!t) return { ok: true };
      detachEquipmentIfAny(ps, t);
      ps.field.ijin.splice(ps.field.ijin.indexOf(t), 1);
      ps.hand.push(t);
      drawCards(game, ps, eff.drawValue || 1);
      return { ok: true };
    }
    case 'discard_own_hand_all': {
      for (const c of ps.hand.slice()) {
        c.faceUp = true;
        ps.graveyard.push(c);
      }
      ps.hand.length = 0;
      return { ok: true };
    }
    case 'revive_graveyard_ijin_or_haikei_auto': {
      const pool = ps.graveyard.filter((c) => {
        const card = getCard(c.cardId);
        return (card.type === 'ijin' && card.level <= (eff.ijinLevelMax || Infinity)) ||
          (card.type === 'haikei' && card.level <= (eff.haikeiLevelMax || Infinity));
      });
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      const c = pool[0];
      ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
      c.faceUp = true;
      c.tapped = false;
      if (getCard(c.cardId).type === 'ijin') {
        c.sick = true;
        ps.field.ijin.push(c);
      } else {
        ps.field.haikei.push(c);
      }
      return { ok: true };
    }
    case 'destroy_highest_power_ijin_either_side_prefer_opponent_auto': {
      const pool = opp.field.ijin.length > 0 ? opp.field.ijin : ps.field.ijin;
      const owner = opp.field.ijin.length > 0 ? opp : ps;
      if (pool.length === 0) return { ok: true };
      const best = pool.reduce((a, b) => (effectivePower(b, owner) > effectivePower(a, owner) ? b : a));
      destroyFieldOrGuardian(game, owner, best);
      return { ok: true };
    }
    case 'bounce_own_hand_cards_to_deck_bottom_then_draw': {
      for (let i = 0; i < (eff.value || 1); i++) {
        if (ps.hand.length === 0) break;
        const c = ps.hand.shift();
        ps.deck.push(c);
      }
      drawCards(game, ps, eff.drawValue || 1);
      return { ok: true };
    }
    case 'bounce_own_ijin_level_max_auto': {
      const t = ps.field.ijin.find((i) => getCard(i.cardId).level <= (eff.levelMax || Infinity));
      if (!t) return { ok: true };
      detachEquipmentIfAny(ps, t);
      ps.field.ijin.splice(ps.field.ijin.indexOf(t), 1);
      ps.hand.push(t);
      return { ok: true };
    }
    case 'haikei_to_own_guardian_by_uid': {
      const idx = ps.field.haikei.findIndex((h) => h.uid === targetUid);
      if (idx === -1) return { ok: true };
      const [h] = ps.field.haikei.splice(idx, 1);
      h.faceUp = false;
      h.tapped = false;
      ps.guardians.push(h);
      return { ok: true };
    }
    case 'draw_then_cannot_attack_this_turn':
      drawCards(game, ps, eff.value || 1);
      ps.cannotAttackThisTurn = true;
      return { ok: true };
    case 'tap_self_then_deck_top_to_own_mana_facedown': {
      if (sourceInstance) sourceInstance.tapped = true;
      if (ps.deck.length === 0) return { ok: true };
      const c = ps.deck.shift();
      c.faceUp = false;
      c.tapped = false;
      ps.mana.push(c);
      return { ok: true };
    }
    case 'mill_opponent_until_ijin_revealed': {
      while (opp.deck.length > 0) {
        const c = opp.deck.shift();
        c.faceUp = true;
        opp.graveyard.push(c);
        if (getCard(c.cardId).type === 'ijin') break;
      }
      return { ok: true };
    }
    case 'discard_opponent_hand_mahou_or_bounce_self': {
      const mahou = opp.hand.find((c) => getCard(c.cardId).type === 'mahou');
      if (mahou) {
        opp.hand.splice(opp.hand.indexOf(mahou), 1);
        mahou.faceUp = true;
        opp.graveyard.push(mahou);
        fireOnDiscardedFromHandTrigger(game, opp, ps, mahou);
      } else if (sourceInstance) {
        const fieldIdx = ps.field.ijin.indexOf(sourceInstance);
        if (fieldIdx !== -1) {
          detachEquipmentIfAny(ps, sourceInstance);
          ps.field.ijin.splice(fieldIdx, 1);
          ps.hand.push(sourceInstance);
        } else {
          const graveIdx = ps.graveyard.indexOf(sourceInstance);
          if (graveIdx !== -1) {
            ps.graveyard.splice(graveIdx, 1);
            ps.hand.push(sourceInstance);
          }
        }
      }
      return { ok: true };
    }
    case 'destroy_or_bounce_based_on_own_mortal_presence': {
      const hasMortal = ps.field.ijin.some((i) => getCard(i.cardId).keywords && getCard(i.cardId).keywords.mortal);
      if (hasMortal) {
        if (opp.field.ijin.length > 0) {
          const best = opp.field.ijin.reduce((a, b) => (effectivePower(b, opp) > effectivePower(a, opp) ? b : a));
          destroyFieldOrGuardian(game, opp, best);
        } else if (opp.guardians.length > 0) {
          destroyFieldOrGuardian(game, opp, opp.guardians[0]);
        }
      } else {
        if (ps.field.ijin.length > 0) {
          const weakest = ps.field.ijin.reduce((a, b) => (effectivePower(b, ps) < effectivePower(a, ps) ? b : a));
          detachEquipmentIfAny(ps, weakest);
          ps.field.ijin.splice(ps.field.ijin.indexOf(weakest), 1);
          ps.hand.push(weakest);
        } else if (ps.guardians.length > 0) {
          const g = ps.guardians[0];
          ps.guardians.splice(0, 1);
          g.faceUp = true;
          ps.hand.push(g);
        }
      }
      return { ok: true };
    }
    case 'grant_temp_indestructible_and_kokai_attack_bonus_all_own_ijin': {
      for (const i of ps.field.ijin) {
        i.tempIndestructibleThisTurn = true;
        if (getCard(i.cardId).text && getCard(i.cardId).text.startsWith('航海')) {
          i.tempAttackBonusThisTurn = (i.tempAttackBonusThisTurn || 0) + 2000;
        }
      }
      return { ok: true };
    }
    case 'reveal_and_discard_non_maryoku_opponent_facedown_mana': {
      for (const m of opp.mana.slice()) {
        if (m.faceUp) continue;
        m.faceUp = true;
        if (getCard(m.cardId).type !== 'maryoku') {
          opp.mana.splice(opp.mana.indexOf(m), 1);
          opp.graveyard.push(m);
        }
      }
      return { ok: true };
    }
    case 'place_hand_or_graveyard_ijin_levelmax_auto': {
      const matches = (c) => getCard(c.cardId).type === 'ijin' && getCard(c.cardId).level <= (eff.levelMax || Infinity);
      const pool = [...ps.hand.filter(matches).map((c) => ({ zone: 'hand', inst: c })), ...ps.graveyard.filter(matches).map((c) => ({ zone: 'graveyard', inst: c }))];
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.inst.cardId).level - getCard(a.inst.cardId).level);
      const { zone, inst } = pool[0];
      const list = zone === 'hand' ? ps.hand : ps.graveyard;
      list.splice(list.indexOf(inst), 1);
      inst.faceUp = true;
      inst.tapped = false;
      inst.sick = true;
      ps.field.ijin.push(inst);
      return { ok: true };
    }
    case 'revive_self_from_graveyard_auto': {
      if (!sourceInstance) return { ok: true };
      const idx = ps.graveyard.indexOf(sourceInstance);
      if (idx === -1) return { ok: true };
      ps.graveyard.splice(idx, 1);
      sourceInstance.faceUp = true;
      sourceInstance.tapped = false;
      sourceInstance.sick = true;
      ps.field.ijin.push(sourceInstance);
      return { ok: true };
    }
    case 'discard_opponent_hand_mahou_or_haikei_auto': {
      const c = opp.hand.find((c) => getCard(c.cardId).type === 'mahou') || opp.hand.find((c) => getCard(c.cardId).type === 'haikei');
      if (!c) return { ok: true };
      opp.hand.splice(opp.hand.indexOf(c), 1);
      c.faceUp = true;
      opp.graveyard.push(c);
      fireOnDiscardedFromHandTrigger(game, opp, ps, c);
      return { ok: true };
    }
    case 'hand_or_graveyard_card_to_guardian_auto': {
      const c = ps.hand[0] || ps.graveyard.find((c) => getCard(c.cardId).type !== 'maryoku') || ps.graveyard[0];
      if (!c) return { ok: true };
      const list = ps.hand.includes(c) ? ps.hand : ps.graveyard;
      list.splice(list.indexOf(c), 1);
      c.faceUp = false;
      c.tapped = false;
      ps.guardians.push(c);
      return { ok: true };
    }
    case 'place_hand_ijin_power_max_free_then_draw_auto': {
      const pool = ps.hand.filter((c) => {
        const card = getCard(c.cardId);
        return card.type === 'ijin' && card.power <= (eff.powerMax || Infinity);
      });
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power);
      const c = pool[0];
      ps.hand.splice(ps.hand.indexOf(c), 1);
      c.faceUp = true;
      c.tapped = false;
      c.sick = true;
      ps.field.ijin.push(c);
      drawCards(game, ps, 1);
      return { ok: true };
    }
    case 'grant_temp_color_all_field_ijin_both_sides': {
      for (const i of [...ps.field.ijin, ...opp.field.ijin]) {
        i.tempColorsThisTurn = [...(i.tempColorsThisTurn || []), eff.color];
      }
      return { ok: true };
    }
    case 'grant_temp_trait_all_own_field_ijin': {
      for (const i of ps.field.ijin) {
        i.tempTraitsThisTurn = [...(i.tempTraitsThisTurn || []), eff.trait];
      }
      return { ok: true };
    }
    case 'revive_graveyard_ijin_levelmax_auto': {
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'ijin' && getCard(c.cardId).level <= (eff.levelMax || Infinity));
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      const c = pool[0];
      ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
      c.faceUp = true;
      c.tapped = false;
      c.sick = true;
      ps.field.ijin.push(c);
      return { ok: true };
    }
    case 'bounce_own_and_opponent_guardian_auto': {
      if (ps.guardians.length > 0) {
        const g = ps.guardians.splice(0, 1)[0];
        g.faceUp = true;
        ps.hand.push(g);
      }
      if (opp.guardians.length > 0) {
        const g = opp.guardians.splice(0, 1)[0];
        g.faceUp = true;
        opp.hand.push(g);
      }
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
      return ps.field.ijin.some((i) => effectiveColors(i).includes(cond.color));
    case 'fieldHasTrait':
      return ps.field.ijin.some((i) => hasEffectiveTrait(i, cond.trait, ps));
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
      return ps.field.ijin.filter((i) => effectiveColors(i).includes(cond.color)).length >= cond.value;
    case 'ownManaCountAtLeast':
      return ps.mana.length >= cond.value;
    case 'opponentHandCountAtLeast':
      return opp.hand.length >= cond.value;
    case 'ownHandHasType':
      return ps.hand.some((c) => getCard(c.cardId).type === cond.cardType);
    case 'ownHandHasEquipCard':
      return ps.hand.some((c) => getCard(c.cardId).equipOffer);
    case 'ownGuardianCountAtMost':
      return ps.guardians.length <= cond.value;
    case 'ownManaColorCountAtLeast': {
      const colors = new Set();
      for (const m of ps.mana) if (m.faceUp) getCard(m.cardId).colors.forEach((c) => colors.add(c));
      return colors.size >= cond.value;
    }
    case 'opponentFacedownManaCountAtLeast':
      return opp.mana.filter((m) => !m.faceUp).length >= cond.value;
    case 'ownFacedownManaCountAtLeast':
      return ps.mana.filter((m) => !m.faceUp).length >= cond.value;
    case 'opponentHandCountGreaterThanOwn':
      return opp.hand.length > ps.hand.length;
    case 'haikeiPlacedCountThisTurnEquals':
      return (ps.haikeiPlacedCountThisTurn || 0) === cond.value;
    case 'ownColorTraitCardCountAtLeast': {
      const count = [...ps.field.ijin, ...ps.field.haikei].filter((i) => effectiveColors(i).includes(cond.color) && hasEffectiveTrait(i, cond.trait, ps)).length;
      return count >= cond.value;
    }
    case 'ownSummonAndManaRightBothZero':
      return ps.summonRight <= 0 && ps.manaRight <= 0;
    case 'opponentAttackedThisTurn':
      return !!opp.attackedThisTurn;
    case 'ownHasNotAttackedThisTurn':
      return !ps.attackedThisTurn;
    case 'ownAttackerDestroyedThisTurn':
      return !!ps.attackerDestroyedThisTurn;
    case 'ownFieldOrGraveyardHasTrait':
      return [...ps.field.ijin, ...ps.field.haikei].some((i) => hasEffectiveTrait(i, cond.trait, ps))
        || ps.graveyard.some((c) => hasEffectiveTrait(c, cond.trait, ps));
    case 'ownHandHasStoneMana':
      return ps.hand.some((c) => getCard(c.cardId).name.includes('ストーン'));
    default:
      return true;
  }
}

function fireOnPlaceTrigger(game, ps, opp, instance, card, action) {
  const trig = card.triggers && card.triggers.onPlace;
  if (!trig) return;
  if (trig.requireViaHankon && !(action && action.viaHankon)) return;
  if (!checkTriggerCondition(ps, opp, trig.condition, instance)) return;
  const targetUid = action && action.triggerTargetUid;
  let effect = trig.effect;
  if (trig.effectChoices) {
    const idx = action && action.triggerChoiceIndex === 1 ? 1 : 0;
    effect = trig.effectChoices[idx];
  }
  const result = resolveGenericEffectMaybeArray(game, ps, opp, effect, targetUid, instance);
  if (result.ok) {
    log(game, `${ps.name}の「${card.name}」の能力が発動しました。`);
  }
}

function fireOnAttackerTrigger(game, ps, opp, instance, card, targetUid) {
  const trig = card.triggers && card.triggers.onAttacker;
  if (trig && checkTriggerCondition(ps, opp, trig.condition, instance)) {
    const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, targetUid, instance);
    if (result.ok) {
      log(game, `${ps.name}の「${card.name}」の能力(アタッカーになったとき)が発動しました。`);
    }
  }
  const equipGrant = equippedGrant(instance);
  const equipTrig = equipGrant && equipGrant.onAttackerTrigger;
  if (equipTrig && !equipTrig.needsTarget && checkTriggerCondition(ps, opp, equipTrig.condition, instance)) {
    const result = resolveGenericEffectMaybeArray(game, ps, opp, equipTrig.effect, null, instance);
    if (result.ok) {
      log(game, `${ps.name}の「${getCard(instance.equippedCard.cardId).name}」の装備効果(アタッカーになったとき)が発動しました。`);
    }
  }
}

function fireOnAllyAttackerTriggers(game, ps, opp, attackerInstance, attackerCard) {
  for (const instance of [...ps.field.ijin, ...ps.field.haikei]) {
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onAllyAttacker;
    if (!trig || trig.needsTarget || trig.side === 'opponent') continue;
    if (trig.colorFilter && !attackerCard.colors.includes(trig.colorFilter)) continue;
    if (trig.requireRush && !hasEffectiveRush(attackerInstance, ps)) continue;
    if (trig.oncePerTurn && instance.usedAllyAttackerTriggerThisTurn) continue;
    if (!checkTriggerCondition(ps, opp, trig.condition, instance)) continue;
    const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, attackerInstance.uid, instance);
    if (result.ok) {
      if (trig.oncePerTurn) instance.usedAllyAttackerTriggerThisTurn = true;
      log(game, `${ps.name}の「${card.name}」の能力が発動しました。`);
    }
  }
  // 「相手の戦場の...がアタッカーになったとき」: カードの持ち主(opp)から見て相手(=攻撃側ps)の
  // イジンがアタッカーになったときに発動するもの。効果はカードの持ち主(opp)基準で解決する。
  for (const instance of [...opp.field.ijin, ...opp.field.haikei]) {
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onAllyAttacker;
    if (!trig || trig.needsTarget || trig.side !== 'opponent') continue;
    if (trig.colorFilter && !attackerCard.colors.includes(trig.colorFilter)) continue;
    if (trig.requireRush && !hasEffectiveRush(attackerInstance, ps)) continue;
    if (trig.oncePerTurn && instance.usedAllyAttackerTriggerThisTurn) continue;
    if (!checkTriggerCondition(opp, ps, trig.condition, instance)) continue;
    const result = resolveGenericEffectMaybeArray(game, opp, ps, trig.effect, attackerInstance.uid, instance);
    if (result.ok) {
      if (trig.oncePerTurn) instance.usedAllyAttackerTriggerThisTurn = true;
      log(game, `${opp.name}の「${card.name}」の能力が発動しました。`);
    }
  }
}

function fireOnManaPlacedTriggers(game, ps, opp, placedInstance) {
  for (const instance of [...ps.field.ijin, ...ps.field.haikei]) {
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onManaPlaced;
    if (!trig || trig.needsTarget) continue;
    if (trig.requireStoneManaName && !(placedInstance && getCard(placedInstance.cardId).name.includes('ストーン'))) continue;
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
      if (trig.levelMin != null && placedCard.level < trig.levelMin) continue;
      if (trig.levelMax != null && placedCard.level > trig.levelMax) continue;
      if (trig.oncePerTurn && instance.usedHaikeiTriggerThisTurn) continue;
      if (!checkTriggerCondition(ownerPs, opp, trig.condition, instance)) continue;
      const result = resolveGenericEffectMaybeArray(game, ownerPs, opp, trig.effect, placedInstance.uid, instance);
      if (result.ok) {
        if (trig.oncePerTurn) instance.usedHaikeiTriggerThisTurn = true;
        log(game, `${ownerPs.name}の「${card.name}」の能力(執筆)が発動しました。`);
      }
    }
  }
}

function fireOnAllyIjinPlacedTriggers(game, placedInstance, placedOwnerPs, placedCard) {
  for (const ownerId of game.players) {
    const ownerPs = game.playerStates[ownerId];
    const opp = game.playerStates[opponentId(game, ownerId)];
    for (const instance of [...ownerPs.field.ijin, ...ownerPs.field.haikei]) {
      const card = getCard(instance.cardId);
      const trig = card.triggers && card.triggers.onAllyIjinPlaced;
      if (!trig || trig.needsTarget) continue;
      const isOwnSide = placedOwnerPs.id === ownerPs.id;
      if (trig.side === 'own' && !isOwnSide) continue;
      if (trig.colorFilter && !placedCard.colors.includes(trig.colorFilter)) continue;
      if (trig.excludeColorFilter && placedCard.colors.includes(trig.excludeColorFilter)) continue;
      if (trig.traitFilter) {
        const kw = placedCard.keywords;
        const hasTrait = kw && (kw.trait === trig.traitFilter || (kw.traits && kw.traits.includes(trig.traitFilter)));
        if (!hasTrait) continue;
      }
      if (trig.requireHasShippitsu && !(placedCard.triggers && placedCard.triggers.onHaikeiPlaced)) continue;
      if (trig.requireKokaiText && !(placedCard.text && placedCard.text.startsWith('航海'))) continue;
      if (trig.levelMin != null && placedCard.level < trig.levelMin) continue;
      if (trig.levelMax != null && placedCard.level > trig.levelMax) continue;
      if (trig.oncePerTurn && instance.usedAllyIjinTriggerThisTurn) continue;
      if (!checkTriggerCondition(ownerPs, opp, trig.condition, instance)) continue;
      const effect = trig.effectChoices ? trig.effectChoices[0] : trig.effect;
      const result = resolveGenericEffectMaybeArray(game, ownerPs, opp, effect, placedInstance.uid, instance);
      if (result.ok) {
        if (trig.oncePerTurn) instance.usedAllyIjinTriggerThisTurn = true;
        log(game, `${ownerPs.name}の「${card.name}」の能力が発動しました。`);
      }
    }
  }
}

function fireFieldStartTriggers(game, ps, opp, triggerKey, logSuffix) {
  for (const instance of [...ps.field.ijin, ...ps.field.haikei]) {
    if (game.winner) break;
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers[triggerKey];
    if (!trig || trig.needsTarget || trig.side === 'opponent') continue;
    if (!checkTriggerCondition(ps, opp, trig.condition, instance)) continue;
    const effect = trig.effectChoices ? trig.effectChoices[0] : trig.effect;
    const result = resolveGenericEffectMaybeArray(game, ps, opp, effect, null, instance);
    if (result.ok) {
      log(game, `${ps.name}の「${card.name}」の能力(${logSuffix})が発動しました。`);
    }
  }
  // 「相手のメイン/エンドフェイズが開始したとき」: カードの持ち主(opp)から見て
  // 相手(=このフェイズを開始したps)のフェイズ開始時に発動するもの。効果はカードの
  // 持ち主(opp)を基準に解決するため、ps/oppを入れ替えて呼び出す。
  for (const instance of [...opp.field.ijin, ...opp.field.haikei]) {
    if (game.winner) break;
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers[triggerKey];
    if (!trig || trig.needsTarget || trig.side !== 'opponent') continue;
    if (!checkTriggerCondition(opp, ps, trig.condition, instance)) continue;
    const effect = trig.effectChoices ? trig.effectChoices[0] : trig.effect;
    const result = resolveGenericEffectMaybeArray(game, opp, ps, effect, null, instance);
    if (result.ok) {
      log(game, `${opp.name}の「${card.name}」の能力(${logSuffix})が発動しました。`);
    }
  }
}

// 徴募: 通常は戦場にいる間だけ発動するエンドフェイズ能力だが、「徴募」を持つカードは
// 自分の墓地にある間もこの能力を発動できる。対象選択(needsTarget)は他の観測系トリガーと
// 同様にサポートしないため、常に自動選択で解決する。
function fireChoboTriggers(game, ps, opp) {
  const sources = [
    ...ps.field.ijin.map((inst) => ({ inst, fromGraveyard: false })),
    ...ps.field.haikei.map((inst) => ({ inst, fromGraveyard: false })),
    ...ps.graveyard.map((inst) => ({ inst, fromGraveyard: true })),
  ];
  for (const { inst, fromGraveyard } of sources) {
    if (game.winner) break;
    const card = getCard(inst.cardId);
    const trig = card.triggers && card.triggers.chobo;
    if (!trig) continue;
    if (trig.graveyardOnly && !fromGraveyard) continue;
    if (!checkTriggerCondition(ps, opp, trig.condition, inst)) continue;
    const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, inst.uid, inst);
    if (result.ok) {
      log(game, `${ps.name}の「${card.name}」の能力(徴募${fromGraveyard ? '・墓地' : ''})が発動しました。`);
      fireOnChoboFromGraveyardTriggers(game, ps, opp, fromGraveyard);
    }
  }
}

function fireOnChoboFromGraveyardTriggers(game, ps, opp, wasFromGraveyard) {
  if (!wasFromGraveyard) return;
  for (const instance of [...ps.field.ijin, ...ps.field.haikei]) {
    if (game.winner) break;
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onChoboFromGraveyard;
    if (!trig || trig.needsTarget) continue;
    if (!checkTriggerCondition(ps, opp, trig.condition, instance)) continue;
    const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, null, instance);
    if (result.ok) {
      log(game, `${ps.name}の「${card.name}」の能力が発動しました。`);
    }
  }
}

function resolveMahouEffect(game, ps, opp, card, action) {
  let eff = card.effect;
  if (!eff) return { ok: true };
  if (eff.effectChoices) {
    eff = eff.effectChoices[action.triggerChoiceIndex === 1 ? 1 : 0];
  }
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
      detachEquipmentIfAny(targetPs, target);
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
      detachEquipmentIfAny(opp, target);
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
    case 'field_card_to_guardian_by_uid': {
      const found = resolveFlexibleIjinOrHaikeiTarget(ps, opp, 'either', action.targetUid);
      if (!found) return { ok: false, error: '対象が見つかりません。' };
      if (found.zone === 'ijin' && eff.levelMax != null && getCard(found.inst.cardId).level > eff.levelMax) {
        return { ok: false, error: 'レベル条件を満たしていません。' };
      }
      if (found.zone === 'ijin') detachEquipmentIfAny(found.owner, found.inst);
      found.owner.field[found.zone].splice(found.owner.field[found.zone].indexOf(found.inst), 1);
      found.inst.faceUp = false;
      found.inst.tapped = false;
      found.owner.guardians.push(found.inst);
      return { ok: true };
    }
    case 'discard_opponent_hand_card_level_at_least': {
      const pool = opp.hand.filter((c) => getCard(c.cardId).level >= eff.value);
      if (pool.length === 0) return { ok: true };
      pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      const c = pool[0];
      opp.hand.splice(opp.hand.indexOf(c), 1);
      c.faceUp = true;
      opp.graveyard.push(c);
      return { ok: true };
    }
    case 'draw_then_discard_scaled_by_own_mana_colors': {
      drawCards(game, ps, 1);
      const colors = new Set();
      for (const m of ps.mana) if (m.faceUp) getCard(m.cardId).colors.forEach((c) => colors.add(c));
      for (let i = 0; i < colors.size; i++) {
        const pool = ps.hand.filter((c) => c.uid !== action.cardUid);
        if (pool.length === 0) break;
        const target = pool[Math.floor(Math.random() * pool.length)];
        ps.hand.splice(ps.hand.indexOf(target), 1);
        target.faceUp = true;
        ps.graveyard.push(target);
      }
      return { ok: true };
    }
    case 'conditional_graveyard_mahou_level_sum_at_least': {
      const sum = ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou').reduce((s, c) => s + getCard(c.cardId).level, 0);
      if (sum >= eff.value) {
        const pool = ps.hand.filter((c) => c.uid !== action.cardUid);
        if (pool.length === 0) return { ok: true };
        const target = pool[Math.floor(Math.random() * pool.length)];
        ps.hand.splice(ps.hand.indexOf(target), 1);
        target.faceUp = true;
        ps.graveyard.push(target);
      } else {
        drawCards(game, ps, 1);
      }
      return { ok: true };
    }
    case 'multi_hand_to_facedown_mana': {
      const uids = action.targetUids || [];
      if (uids.length === 0) return { ok: false, error: '手札から1つ以上指定してください。' };
      for (const uid of uids) {
        const idx = ps.hand.findIndex((c) => c.uid === uid);
        if (idx === -1) continue;
        const [c] = ps.hand.splice(idx, 1);
        c.faceUp = false;
        c.tapped = false;
        ps.mana.push(c);
      }
      return { ok: true };
    }
    case 'multi_bounce_own_ijin_scaled_summon_right': {
      const uids = action.targetUids || [];
      if (uids.length === 0) return { ok: false, error: '自分のイジンを1体以上指定してください。' };
      let count = 0;
      for (const uid of uids) {
        const inst = ps.field.ijin.find((i) => i.uid === uid);
        if (!inst) continue;
        detachEquipmentIfAny(ps, inst);
        ps.field.ijin.splice(ps.field.ijin.indexOf(inst), 1);
        inst.faceUp = true;
        ps.hand.push(inst);
        count += 1;
      }
      ps.summonRight += count;
      return { ok: true };
    }
    case 'multi_discard_hand_haikei_draw_scaled': {
      const uids = action.targetUids || [];
      if (uids.length === 0) return { ok: false, error: '手札のハイケイを1つ以上指定してください。' };
      let levelSum = 0;
      for (const uid of uids) {
        const idx = ps.hand.findIndex((c) => c.uid === uid && getCard(c.cardId).type === 'haikei');
        if (idx === -1) continue;
        const [c] = ps.hand.splice(idx, 1);
        levelSum += getCard(c.cardId).level;
        c.faceUp = true;
        ps.graveyard.push(c);
      }
      drawCards(game, ps, Math.floor(levelSum / 5));
      return { ok: true };
    }
    case 'multi_graveyard_to_deck_bottom_then_draw': {
      const uids = action.targetUids || [];
      if (uids.length < (eff.minCount || 1)) return { ok: false, error: `墓地のマリョクでないカードを${eff.minCount}つ以上指定してください。` };
      const pools = eff.scope === 'either' ? [ps, opp] : [ps];
      for (const uid of uids) {
        for (const owner of pools) {
          const idx = owner.graveyard.findIndex((c) => c.uid === uid && getCard(c.cardId).type !== 'maryoku');
          if (idx !== -1) {
            const [c] = owner.graveyard.splice(idx, 1);
            c.faceUp = true;
            owner.deck.push(c);
            break;
          }
        }
      }
      drawCards(game, ps, 1);
      return { ok: true };
    }
    case 'carbonize_flexible_destroy_to_deck_bottom': {
      const haikei = [...ps.field.haikei, ...opp.field.haikei].find((h) => h.uid === action.targetUid);
      if (haikei) {
        const owner = ps.field.haikei.includes(haikei) ? ps : opp;
        owner.field.haikei.splice(owner.field.haikei.indexOf(haikei), 1);
        haikei.faceUp = true;
        owner.deck.push(haikei);
        return { ok: true };
      }
      const holder = [...ps.field.ijin, ...opp.field.ijin].find((i) => i.equippedCard && i.equippedCard.uid === action.targetUid);
      if (holder) {
        const holderOwner = ps.field.ijin.includes(holder) ? ps : opp;
        const equipInst = holder.equippedCard;
        holder.equippedCard = null;
        equipInst.faceUp = true;
        holderOwner.deck.push(equipInst);
        return { ok: true };
      }
      return { ok: false, error: '対象が見つかりません。' };
    }
    case 'catastrophe_own_guardian_to_deck_bottom_destroy_all_ijin': {
      const g = ps.guardians.find((x) => x.uid === action.targetUid);
      if (!g) return { ok: false, error: '対象の自分のガーディアンを指定してください。' };
      ps.guardians.splice(ps.guardians.indexOf(g), 1);
      g.faceUp = true;
      ps.deck.push(g);
      const allIjin = [...ps.field.ijin.map((inst) => ({ owner: ps, inst })), ...opp.field.ijin.map((inst) => ({ owner: opp, inst }))];
      for (const { owner, inst } of allIjin) destroyFieldOrGuardian(game, owner, inst);
      return { ok: true };
    }
    case 'multi_destroy_field_haikei_scaled_by_own_colors': {
      const uids = action.targetUids || [];
      const colors = new Set();
      for (const i of ps.field.ijin) getCard(i.cardId).colors.forEach((c) => colors.add(c));
      if (uids.length > colors.size) return { ok: false, error: `ハイケイは最大${colors.size}つまで指定できます。` };
      for (const uid of uids) {
        const own = ps.field.haikei.find((h) => h.uid === uid);
        const target = own || opp.field.haikei.find((h) => h.uid === uid);
        const owner = own ? ps : opp;
        if (target) destroyFieldOrGuardian(game, owner, target);
      }
      return { ok: true };
    }
    case 'multi_tap_field_ijin_scaled_by_own_colors': {
      const uids = action.targetUids || [];
      const colors = new Set();
      for (const i of ps.field.ijin) getCard(i.cardId).colors.forEach((c) => colors.add(c));
      if (uids.length > colors.size) return { ok: false, error: `イジンは最大${colors.size}体まで指定できます。` };
      for (const uid of uids) {
        const target = [...ps.field.ijin, ...opp.field.ijin].find((i) => i.uid === uid);
        if (target) target.tapped = true;
      }
      return { ok: true };
    }
    case 'multi_bounce_graveyard_mana_scaled_by_own_colors': {
      const uids = action.targetUids || [];
      const colors = new Set();
      for (const i of ps.field.ijin) getCard(i.cardId).colors.forEach((c) => colors.add(c));
      if (uids.length > colors.size) return { ok: false, error: `マリョクは最大${colors.size}つまで指定できます。` };
      for (const uid of uids) {
        const idx = ps.graveyard.findIndex((c) => c.uid === uid && getCard(c.cardId).type === 'maryoku');
        if (idx !== -1) {
          const [c] = ps.graveyard.splice(idx, 1);
          c.faceUp = true;
          ps.hand.push(c);
        }
      }
      return { ok: true };
    }
    case 'pressure_ijin_deck_bottom_if_attacker_else_tap': {
      const found = resolveScopedIjinTarget(ps, opp, 'either', action.targetUid);
      if (!found) return { ok: false, error: '対象が見つかりません。' };
      const targetCard = getCard(found.inst.cardId);
      if (!targetCard.keywords || !targetCard.keywords.pressure) return { ok: false, error: '「プレッシャー」を持つイジンを指定してください。' };
      const isAttacker = !!(game.pendingBattle && game.pendingBattle.attackers.some((a) => a.uid === found.inst.uid));
      if (isAttacker) {
        detachEquipmentIfAny(found.owner, found.inst);
        found.owner.field.ijin.splice(found.owner.field.ijin.indexOf(found.inst), 1);
        found.inst.faceUp = true;
        found.owner.deck.push(found.inst);
      } else {
        found.inst.tapped = true;
      }
      return { ok: true };
    }
    case 'discard_own_hand_then_draw': {
      const pool = ps.hand.filter((c) => c.uid !== action.cardUid);
      if (pool.length > 0) {
        const target = pool[Math.floor(Math.random() * pool.length)];
        ps.hand.splice(ps.hand.indexOf(target), 1);
        target.faceUp = true;
        ps.graveyard.push(target);
      }
      drawCards(game, ps, 1);
      return { ok: true };
    }
    case 'grant_opponent_mana_abilities_disabled_this_turn':
      opp.manaAbilitiesDisabledThisTurn = true;
      return { ok: true };
    case 'destroy_own_ijin_or_guardian_and_opponent_field_card': {
      const ownIjin = ps.field.ijin.find((i) => i.uid === action.targetUid);
      const ownGuardian = ps.guardians.find((g) => g.uid === action.targetUid);
      const ownTarget = ownIjin || ownGuardian;
      const oppTarget = [...opp.field.ijin, ...opp.field.haikei].find((c) => c.uid === action.targetUid2);
      if (!ownTarget || !oppTarget) return { ok: false, error: '自分のイジンかガーディアンと、相手の戦場のカードをそれぞれ指定してください。' };
      destroyFieldOrGuardian(game, ps, ownTarget);
      destroyFieldOrGuardian(game, opp, oppTarget);
      return { ok: true };
    }
    case 'bounce_flexible_mana_then_cannot_cast_mahou': {
      const own = ps.mana.find((m) => m.uid === action.targetUid);
      const oppMana = opp.mana.find((m) => m.uid === action.targetUid);
      const target = own || oppMana;
      const owner = own ? ps : opp;
      if (!target) return { ok: false, error: '対象が見つかりません。' };
      owner.mana.splice(owner.mana.indexOf(target), 1);
      target.faceUp = true;
      owner.hand.push(target);
      ps.cannotCastMahouThisTurn = true;
      return { ok: true };
    }
    case 'discard_hand_then_graveyard_to_hand_then_cannot_cast_mahou': {
      for (const c of ps.hand.filter((c) => c.uid !== action.cardUid).slice()) {
        ps.hand.splice(ps.hand.indexOf(c), 1);
        c.faceUp = true;
        ps.graveyard.push(c);
      }
      const pool = ps.graveyard.slice().sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      for (let i = 0; i < 4 && pool.length > 0; i++) {
        const c = pool.shift();
        ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
        c.faceUp = true;
        ps.hand.push(c);
      }
      ps.cannotCastMahouThisTurn = true;
      return { ok: true };
    }
    case 'destroy_all_field_ijin_both_sides_no_legacy_then_cannot_attack': {
      for (const i of ps.field.ijin.slice()) {
        detachEquipmentIfAny(ps, i);
        ps.field.ijin.splice(ps.field.ijin.indexOf(i), 1);
        i.faceUp = true;
        ps.graveyard.push(i);
      }
      for (const i of opp.field.ijin.slice()) {
        detachEquipmentIfAny(opp, i);
        opp.field.ijin.splice(opp.field.ijin.indexOf(i), 1);
        i.faceUp = true;
        opp.graveyard.push(i);
      }
      ps.cannotAttackThisTurn = true;
      return { ok: true };
    }
    case 'bounce_other_hand_to_deck_shuffle_draw7_then_cannot_cast_mahou': {
      for (const c of ps.hand.filter((c) => c.uid !== action.cardUid).slice()) {
        ps.hand.splice(ps.hand.indexOf(c), 1);
        ps.deck.push(c);
      }
      ps.deck = shuffle(ps.deck);
      drawCards(game, ps, 7);
      ps.cannotCastMahouThisTurn = true;
      return { ok: true };
    }
    case 'deck_top_reveal_take_if_haikei_or_mahou_else_facedown_mana': {
      if (ps.deck.length === 0) return { ok: true };
      const c = ps.deck.shift();
      const cardData = getCard(c.cardId);
      if (cardData.type === 'haikei' || cardData.type === 'mahou') {
        c.faceUp = true;
        ps.hand.push(c);
      } else {
        c.faceUp = false;
        c.tapped = false;
        ps.mana.push(c);
      }
      return { ok: true };
    }
    case 'shuffle_graveyard_ijin_into_deck_then_reveal_top_take_if_ijin': {
      for (const c of ps.graveyard.filter((c) => getCard(c.cardId).type === 'ijin').slice()) {
        ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
        ps.deck.push(c);
      }
      ps.deck = shuffle(ps.deck);
      if (ps.deck.length > 0 && getCard(ps.deck[0].cardId).type === 'ijin') {
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.hand.push(c);
      }
      return { ok: true };
    }
    case 'destroy_opponent_duplicate_named_non_mana_cards': {
      const pool = [...opp.hand, ...opp.field.ijin, ...opp.field.haikei, ...opp.graveyard].filter((c) => getCard(c.cardId).type !== 'maryoku');
      const nameCounts = {};
      for (const c of pool) {
        const n = getCard(c.cardId).name;
        nameCounts[n] = (nameCounts[n] || 0) + 1;
      }
      const dupNames = new Set(Object.keys(nameCounts).filter((n) => nameCounts[n] >= 2));
      for (const c of opp.hand.slice()) {
        if (dupNames.has(getCard(c.cardId).name)) {
          opp.hand.splice(opp.hand.indexOf(c), 1);
          c.faceUp = true;
          opp.graveyard.push(c);
        }
      }
      for (const c of opp.field.ijin.slice()) {
        if (dupNames.has(getCard(c.cardId).name)) destroyFieldOrGuardian(game, opp, c);
      }
      for (const c of opp.field.haikei.slice()) {
        if (dupNames.has(getCard(c.cardId).name)) destroyFieldOrGuardian(game, opp, c);
      }
      return { ok: true };
    }
    case 'compare_hand_level_sum_discard_lower': {
      const ownSum = ps.hand.filter((c) => c.uid !== action.cardUid).reduce((s, c) => s + getCard(c.cardId).level, 0);
      const oppSum = opp.hand.reduce((s, c) => s + getCard(c.cardId).level, 0);
      if (ownSum === oppSum) return { ok: true };
      const loser = ownSum < oppSum ? ps : opp;
      for (const c of loser.hand.filter((c) => c.uid !== action.cardUid).slice()) {
        loser.hand.splice(loser.hand.indexOf(c), 1);
        c.faceUp = true;
        loser.graveyard.push(c);
      }
      return { ok: true };
    }
    case 'mill_opponent_scaled_by_tapped_field_both_sides_times3': {
      const tappedCount = [...ps.field.ijin, ...ps.field.haikei, ...opp.field.ijin, ...opp.field.haikei].filter((c) => c.tapped).length;
      const n = tappedCount * 3;
      for (let i = 0; i < n; i++) {
        if (opp.deck.length === 0) break;
        const c = opp.deck.shift();
        c.faceUp = true;
        opp.graveyard.push(c);
      }
      return { ok: true };
    }
    case 'bounce_all_mana_both_sides_to_hand': {
      for (const m of ps.mana.slice()) {
        ps.mana.splice(ps.mana.indexOf(m), 1);
        m.faceUp = true;
        ps.hand.push(m);
      }
      for (const m of opp.mana.slice()) {
        opp.mana.splice(opp.mana.indexOf(m), 1);
        m.faceUp = true;
        opp.hand.push(m);
      }
      return { ok: true };
    }
    case 'draw_scaled_by_opponent_hand_excess_then_cannot_attack': {
      const ownHandCount = ps.hand.filter((c) => c.uid !== action.cardUid).length;
      const diff = opp.hand.length - ownHandCount;
      if (diff <= 0) return { ok: false, error: '相手の手札が自分より多い場合のみ発動できます。' };
      drawCards(game, ps, diff);
      ps.cannotAttackThisTurn = true;
      return { ok: true };
    }
    case 'mill_self_then_place_graveyard_card_level_at_most_mana_level': {
      for (let i = 0; i < 5; i++) {
        if (ps.deck.length === 0) break;
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.graveyard.push(c);
      }
      if (!action.targetUid) return { ok: true };
      const idx = ps.graveyard.findIndex((c) => c.uid === action.targetUid);
      if (idx === -1) return { ok: false, error: '対象の墓地のカードが見つかりません。' };
      const targetCard = getCard(ps.graveyard[idx].cardId);
      if (targetCard.type !== 'ijin' && targetCard.type !== 'haikei') return { ok: false, error: 'イジンかハイケイを指定してください。' };
      if (targetCard.level > levelSum(ps)) return { ok: false, error: '自分の魔力レベル以下のカードを指定してください。' };
      const [inst] = ps.graveyard.splice(idx, 1);
      inst.faceUp = true;
      inst.tapped = false;
      if (targetCard.type === 'ijin') {
        inst.sick = true;
        ps.field.ijin.push(inst);
      } else {
        ps.field.haikei.push(inst);
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
    case 'grant_temp_indestructible_and_kokai_attack_bonus_all_own_ijin':
    case 'reveal_and_discard_non_maryoku_opponent_facedown_mana':
    case 'move_opponent_ijin_or_haikei_to_their_guardian_by_uid':
      return resolveGenericEffect(game, ps, opp, eff, action.targetUid, null);
    default:
      return { ok: true };
  }
}

// ---------- バトル ----------

function declareAttack(game, playerId, action) {
  const ps = game.playerStates[playerId];
  if (ps.cannotAttackThisTurn) return { ok: false, error: 'このターンはバトルを開始できません。' };
  if (ps.attackedThisTurn && !ps.extraBattleAvailable) return { ok: false, error: 'このターンはすでにバトルを行いました。' };
  const uids = action.attackerUids || [];
  if (uids.length === 0) return { ok: false, error: 'アタッカーを1体以上選んでください。' };

  const attackers = [];
  for (const uid of uids) {
    const inst = ps.field.ijin.find((i) => i.uid === uid);
    if (!inst) return { ok: false, error: '対象のイジンが見つかりません。' };
    if (inst.tapped) return { ok: false, error: '寝ているイジンはアタッカーになれません。' };
    const rush = hasEffectiveRush(inst, ps);
    if (inst.sick && !rush) return { ok: false, error: 'このターンに出したばかりのイジンはアタッカーになれません(即応を除く)。' };
    if (attackContextPower(inst, ps) <= 0) return { ok: false, error: 'パワー0以下のイジンはアタッカーになれません。' };
    attackers.push(inst);
  }
  for (const a of attackers) a.tapped = true;

  const opp = game.playerStates[opponentId(game, playerId)];
  const attackerTriggerTargets = action.attackerTriggerTargets || {};
  for (const a of attackers) {
    const aCard = getCard(a.cardId);
    fireOnAttackerTrigger(game, ps, opp, a, aCard, attackerTriggerTargets[a.uid]);
    fireOnAllyAttackerTriggers(game, ps, opp, a, aCard);
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
      if (!inst) {
        // スタンド: 色条件を満たしていれば、裏向きの魔力ゾーンのカードを表にして戦場に置き、ブロッカーにできる
        const manaCard = defender.mana.find((m) => m.uid === buid && !m.faceUp);
        if (manaCard) {
          const mCard = getCard(manaCard.cardId);
          const hasMatchingColorMana = mCard.type === 'ijin' && mCard.keywords && mCard.keywords.stand
            && defender.mana.some((m) => m.faceUp && mCard.colors.some((c) => getCard(m.cardId).colors.includes(c)));
          if (hasMatchingColorMana) {
            defender.mana.splice(defender.mana.indexOf(manaCard), 1);
            manaCard.faceUp = true;
            manaCard.tapped = false;
            manaCard.sick = false;
            defender.field.ijin.push(manaCard);
            inst = manaCard;
            log(game, `${defender.name}がスタンドで「${mCard.name}」を戦場に置き、ブロッカーにしました。`);
          }
        }
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
      const blockedByLowPowerIjin = blockers.some((b) => !b.isGuardian && blockContextPower(defender.field.ijin.find((i) => i.uid === b.uid), defender) <= threshold);
      if (blockedByLowPowerIjin) return { ok: false, error: `このアタッカーはパワー${threshold}以下のイジンにブロックされません。` };
    }
    if (attackerInst.tempUnblockableAtLeastPowerThisTurn != null) {
      const threshold = attackerInst.tempUnblockableAtLeastPowerThisTurn;
      const blockedByHighPowerIjin = blockers.some((b) => !b.isGuardian && blockContextPower(defender.field.ijin.find((i) => i.uid === b.uid), defender) >= threshold);
      if (blockedByHighPowerIjin) return { ok: false, error: `このアタッカーはパワー${threshold}以上のイジンにブロックされません。` };
    }
    const attackerEquipGrant = equippedGrant(attackerInst);
    const effectivePressure = attackerInst.tempPressureOverrideThisTurn != null
      ? attackerInst.tempPressureOverrideThisTurn
      : ((attackerCard.keywords && attackerCard.keywords.pressure) || (attackerEquipGrant && attackerEquipGrant.pressure));
    if (effectivePressure) {
      if (blockers.length < effectivePressure) {
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

  const blockerTriggerTargets = action.blockerTriggerTargets || {};
  for (const entry of game.pendingBattle.attackers) {
    for (const b of entry.blockers) {
      if (b.isGuardian) continue;
      const bInst = defender.field.ijin.find((i) => i.uid === b.uid);
      if (bInst) fireOnBecomeBlockerTrigger(game, defender, attackerPs, bInst, b.card, blockerTriggerTargets[b.uid]);
    }
  }

  return resolveBattle(game);
}

function fireOnBecomeBlockerTrigger(game, ps, opp, instance, card, targetUid) {
  const trig = card.triggers && card.triggers.onBecomeBlocker;
  if (!trig) return;
  if (!checkTriggerCondition(ps, opp, trig.condition, instance)) return;
  const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, targetUid, instance);
  if (result.ok) {
    log(game, `${ps.name}の「${card.name}」の能力(ブロッカーになったとき)が発動しました。`);
  }
}

// 手札から墓地に置かれたとき(自分自身が効果で捨てられた場合も含む)に発動するトリガー。
// カードの持ち主(ps)から見た視点で解決する(捨てさせた側ではなく、捨てられた側の能力として発動する)。
function fireOnDiscardedFromHandTrigger(game, ps, opp, instance) {
  const card = getCard(instance.cardId);
  const trig = card.triggers && card.triggers.onDiscardedFromHand;
  if (!trig) return;
  if (!checkTriggerCondition(ps, opp, trig.condition, instance)) return;
  const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, null, instance);
  if (result.ok) {
    log(game, `${ps.name}の「${card.name}」の能力(手札から墓地に置かれたとき)が発動しました。`);
  }
}

function resolveBattle(game) {
  const battle = game.pendingBattle;
  const attackerId = battle.attackerPlayerId;
  const defenderId = opponentId(game, attackerId);
  const attackerPs = game.playerStates[attackerId];
  const defenderPs = game.playerStates[defenderId];
  const survivingMortals = [];

  for (const entry of battle.attackers) {
    const attackerInst = attackerPs.field.ijin.find((i) => i.uid === entry.uid);
    if (!attackerInst) continue; // 既に破壊済み等
    const atkPower = attackContextPower(attackerInst, attackerPs);
    if (atkPower <= 0) continue; // 途中でパワー0以下になったアタッカーは対象から除外
    const attackerHasDrain = hasEffectiveDrain(attackerInst, attackerPs, defenderPs, game);

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
        blockerDetails.push({ b, power: blockContextPower(inst, defenderPs), isGuardian: false });
      }
      blockersSum += blockerDetails[blockerDetails.length - 1] ? blockerDetails[blockerDetails.length - 1].power : 0;
    }

    const attackerDies = blockersSum >= atkPower;
    if (attackerDies) {
      const aBlockerHasDrain = blockerDetails.some((bd) => {
        if (bd.isGuardian) return false;
        const inst = defenderPs.field.ijin.find((i) => i.uid === bd.b.uid);
        return inst && hasEffectiveDrain(inst, defenderPs, attackerPs, game);
      });
      destroyFieldOrGuardian(game, attackerPs, attackerInst, aBlockerHasDrain);
      attackerPs.attackerDestroyedThisTurn = true;
    } else {
      const attackerCard = getCard(attackerInst.cardId);
      if (attackerCard.keywords && attackerCard.keywords.mortal) {
        survivingMortals.push(attackerInst.uid);
        log(game, `${attackerPs.name}の「${attackerCard.name}」はモータルによりバトル解決で勝ってもアタッカーのままです。`);
      }
    }

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
        if (inst) destroyFieldOrGuardian(game, defenderPs, inst, attackerHasDrain);
      }
    }
  }

  if (survivingMortals.length > 0) {
    game.pendingBattle = {
      attackerPlayerId: attackerId,
      attackers: survivingMortals.map((uid) => ({ uid, blockers: [] })),
    };
    game.phase = 'block';
    return { ok: true };
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
  reviveHankon,
  declareAttack,
  declareBlock,
  endTurn,
  levelSum,
  hasColorInMana,
  canUseCard,
  effectivePower,
  findInstance,
  destroyFieldOrGuardian,
};
