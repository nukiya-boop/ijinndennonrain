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

function createGame(roomId, playerA, playerB) {
  // ダイスロールで先攻・後攻を決める(同じ目が出たら振り直す)。勝った方が先攻になる。
  let diceA, diceB;
  do {
    diceA = 1 + Math.floor(Math.random() * 6);
    diceB = 1 + Math.floor(Math.random() * 6);
  } while (diceA === diceB);
  const aGoesFirst = diceA > diceB;
  const p1 = aGoesFirst ? playerA : playerB;
  const p2 = aGoesFirst ? playerB : playerA;
  const diceRoll = { p1Value: aGoesFirst ? diceA : diceB, p2Value: aGoesFirst ? diceB : diceA };

  const game = {
    roomId,
    players: [p1.id, p2.id],
    turnPlayerIndex: 0,
    turnNumber: 1,
    isVeryFirstTurn: true,
    phase: 'mulligan', // ダイスロール(演出用の結果はdiceRollに保持)→マリガン宣言→main
    diceRoll,
    pendingBattle: null,
    pendingMainStartTrigger: null,
    pendingHaikeiPlacedTrigger: null,
    pendingManaOnPlaceDiscard: null,
    pendingManaCardDestinationChoice: null,
    pendingEffectChoice: null,
    pendingForcedTurnEnd: null,
    pendingLegacyTriggers: [],
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
      game,
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
      isCurrentTurnPlayer: p.id === p1.id,
      clairvoyanceReveal: null,
      elizabethManaLeaveUsedThisTurn: false,
      preventDeckToGraveyardMillThisTurn: false,
      meifuFromHandDiscardUsedThisTurn: false,
      mulliganDeclared: false,
    };
  }

  log(game, `${p1.name} 対 ${p2.name} の対戦を開始します。`);
  log(game, `ダイスロール: ${p1.name}が${diceRoll.p1Value}、${p2.name}が${diceRoll.p2Value}で、${p1.name}の先攻に決まりました。`);
  return game;
}

function activePlayerId(game) {
  return game.players[game.turnPlayerIndex];
}

function opponentId(game, playerId) {
  return game.players.find((id) => id !== playerId);
}

// マリガン: 先攻から順に、初期手札をキープするかシャッフルして引き直すかを宣言する
// (任意。手札が悪ければ引き直せる)。引き直す場合、手札をすべて山札に戻して
// シャッフルし、同じ枚数だけ引き直す。両者が宣言し終えたらメインフェイズへ進む。
function declareMulligan(game, playerId, action) {
  if (game.phase !== 'mulligan') return { ok: false, error: '今はマリガンを宣言できません。' };
  const ps = game.playerStates[playerId];
  if (!ps) return { ok: false, error: 'プレイヤーが見つかりません。' };
  if (ps.mulliganDeclared) return { ok: false, error: 'すでにマリガンを宣言しています。' };
  const firstPlayerId = game.players[0];
  if (playerId !== firstPlayerId && !game.playerStates[firstPlayerId].mulliganDeclared) {
    return { ok: false, error: '先攻のマリガン宣言を待っています。' };
  }

  if (action && action.mulligan) {
    const handSize = ps.hand.length;
    for (const c of ps.hand) c.faceUp = true;
    ps.deck.push(...ps.hand);
    ps.hand = [];
    ps.deck = shuffle(ps.deck);
    ps.hand = ps.deck.splice(0, handSize);
    log(game, `${ps.name}がマリガンして手札を引き直しました。`);
  } else {
    log(game, `${ps.name}は手札をキープしました。`);
  }
  ps.mulliganDeclared = true;

  const allDeclared = game.players.every((id) => game.playerStates[id].mulliganDeclared);
  if (allDeclared) {
    game.phase = 'main';
    log(game, `${game.playerStates[firstPlayerId].name}の先攻でゲームを開始します。`);
  }
  return { ok: true };
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
      if (g.type === 'grant_mana_level_bonus_per_facedown_mana') {
        sum += g.value * playerState.mana.filter((m) => !m.faceUp).length;
      }
    }
  }
  return sum;
}

// 「能力をすべて失う」系の継続効果によって、このインスタンス自身の能力
// (キーワード・トリガー・常在効果)が失われているかどうかを判定する。
// カードの色・レベル・パワー・タイプなど、能力ではない印刷情報は対象外。
// ownerPsはinstanceの持ち主、opponentPsはその相手。
function isAbilitySuppressed(instance, ownerPs, opponentPs) {
  const card = getCard(instance.cardId);
  // 福沢諭吉: 自分と相手の戦場の緑でないイジンは、能力すべてを失う。
  if (card.type === 'ijin' && !card.colors.includes('green')) {
    const hasFukuzawa = [ownerPs, opponentPs].some((side) => side && side.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.suppressNonGreenIjinAbilities;
    }));
    if (hasFukuzawa) return true;
  }
  // 近松門左衛門: 戦場のハイケイは能力すべてを失う。
  if (card.type === 'haikei') {
    const hasChikamatsu = [ownerPs, opponentPs].some((side) => side && side.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.suppressAllHaikeiAbilities;
    }));
    if (hasChikamatsu) return true;
  }
  // 藤原不比等: 相手の戦場のレベル5以下の寝ているイジンは、能力すべてを失う。
  if (card.type === 'ijin' && card.level <= 5 && instance.tapped && opponentPs) {
    const hasFujiwara = opponentPs.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.suppressOpponentLowLevelTappedIjinAbilities;
    });
    if (hasFujiwara) return true;
  }
  // 蝦夷共和国: 自分の戦場の「志願」イジンは、モータルを除く他の能力すべてを失う。
  if (card.type === 'ijin' && ownerPs && ownerPs.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.suppressVolunteerIjinAbilities;
  }) && hasEffectiveTrait(instance, '志願', ownerPs)) {
    return true;
  }
  // ヴォルフガング・アマデウス・モーツァルト: これが戦場にいる間、相手の戦場の「音楽」イジンは
  // 能力すべてを失う(この能力自体は能力によって失われない)。
  if (opponentPs && ownerPs && card.type === 'ijin' && hasEffectiveTrait(instance, '音楽', ownerPs)) {
    const hasMozart = opponentPs.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.suppressOpponentMusicIjinAndGraveyardAbilities;
    });
    if (hasMozart) return true;
  }
  // 熒惑のピラー等: これが自分か相手の魔力ゾーンに表向きである間、両陣営の戦場・魔力ゾーンの
  // 能力すべては発動しない。
  if ([ownerPs, opponentPs].some((side) => side && side.mana.some((m) => m.faceUp && (getCard(m.cardId).keywords || {}).suppressAllFieldAndManaAbilitiesGlobally))) {
    return true;
  }
  // 黒田官兵衛: これが起きているなら戦場で効果を発揮する。相手の戦場のハイケイは
  // 能力すべてを失う。
  if (card.type === 'haikei' && opponentPs) {
    const hasKuroda = opponentPs.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.suppressOpponentHaikeiAbilitiesWhileSelfUntapped && !i.tapped;
    });
    if (hasKuroda) return true;
  }
  // 新井白石: 相手の戦場の寝ているハイケイは、能力すべてを失う。
  if (card.type === 'haikei' && instance.tapped && opponentPs) {
    const hasArai = opponentPs.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.suppressOpponentTappedHaikeiAbilities;
    });
    if (hasArai) return true;
  }
  // 小林虎三郎: 相手の魔力ゾーンに裏のカードがあるなら戦場で効果を発揮する。
  // 相手の戦場の起きているイジンは、能力すべてを失う。
  if (card.type === 'ijin' && !instance.tapped && opponentPs) {
    const hasKobayashi = opponentPs.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.suppressOpponentUntappedIjinIfOwnFacedownMana;
    }) && ownerPs && ownerPs.mana.some((m) => !m.faceUp);
    if (hasKobayashi) return true;
  }
  return false;
}

// 蘆屋道満: これが戦場にいる間、自分の戦場に(能力によって)ガーディアンが置かれる際、
// 寝ている状態で戦場に置かれる(最も一般的な経路である deck_top_to_guardian 系のみを
// 対象とする既存方針の簡略化)。
function newGuardiansEnterTapped(ps) {
  return ps.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.newGuardiansEnterTapped;
  });
}

// 武則天: 能力によって相手のマリョク配置権/イジン召喚権が増えたとき、それぞれ罰則を
// 発動する(最も一般的な2つの汎用効果タイプ経由の増加のみを対象とする既存方針の簡略化)。
function fireWuZetianObserver(game, buffedPs, kind) {
  const oppOfBuffed = game.playerStates[opponentId(game, buffedPs.id)];
  if (!oppOfBuffed) return;
  const wuZetian = oppOfBuffed.field.ijin.find((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.punishOpponentRightIncrease;
  });
  if (!wuZetian || isAbilitySuppressed(wuZetian, oppOfBuffed, buffedPs)) return;
  if (kind === 'mana') {
    if (buffedPs.deck.length === 0) return;
    const milled = buffedPs.deck.shift();
    milled.faceUp = true;
    buffedPs.graveyard.push(milled);
    checkMilledCardForForcedTurnEnd(game, buffedPs, getCard(milled.cardId), milled);
    log(game, `${oppOfBuffed.name}の武則天の効果で、${buffedPs.name}の山札の上から1枚が墓地に置かれました。`);
  } else if (kind === 'summon') {
    if (buffedPs.hand.length === 0) return;
    const discarded = buffedPs.hand[0];
    buffedPs.hand.splice(0, 1);
    discarded.faceUp = true;
    buffedPs.graveyard.push(discarded);
    fireOnDiscardedFromHandTrigger(game, buffedPs, oppOfBuffed, discarded);
    log(game, `${oppOfBuffed.name}の武則天の効果で、${buffedPs.name}の手札1枚が墓地に置かれました。`);
  }
}

// ソクラテス: これが戦場にいる間、相手はマホウ使用とハイケイ使用を、合わせてターンに
// 1回しかできない。
function isSocratesLimitReached(ps, opp) {
  if (!opp.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.limitOpponentHaikeiAndMahouCombinedPerTurn;
  })) return false;
  return (ps.haikeiOrMahouUsedCountThisTurn || 0) >= 1;
}

// 新島八重: これが戦場か墓地にいる間、手札のカードを墓地に置く効果を持つ、戦場の能力
// すべては、発動せず効果を発揮しない(本アプリで実装済みの代表的な「手札破棄」系の
// 汎用効果タイプ・キーワードのみを対象とする既存方針の簡略化)。
function isHandDiscardFieldAbilitySuppressed(game) {
  return game.players.some((id) => {
    const ps = game.playerStates[id];
    return [...ps.field.ijin, ...ps.field.haikei, ...ps.graveyard].some((c) => {
      const kw = getCard(c.cardId).keywords;
      return kw && kw.suppressHandDiscardFieldAbilities;
    });
  });
}

// モーツァルト: 相手の墓地のカードは能力すべてを失う。
// 「戦場から墓地に置かれた際に発動するトリガー」(小野小町の破壊時トリガー等、実装上は
// カードが墓地に移動した後に発動判定を行うもの)は、フィールドを離れる瞬間の状態を参照する
// 能力であるため対象外とし、実際に墓地にあるカードの能力を使う場面(冥府発動・反魂・
// 遺業能力の即時発動など)でのみ用いる、isAbilitySuppressedとは別枠の判定。
function isGraveyardCardAbilitySuppressedByMozart(instance, ownerPs, opponentPs) {
  if (!opponentPs || !ownerPs) return false;
  if (!ownerPs.graveyard.includes(instance)) return false;
  if (opponentPs.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.suppressOpponentMusicIjinAndGraveyardAbilities;
  })) return true;
  // エイブラハム・リンカン: 相手のターンの間、墓地のカードは能力すべてを失う
  // (自分・相手どちらの墓地も対象。この能力自体は能力によって失われない)。
  const game = ownerPs.game;
  if (game && game.players.some((id) => {
    const lincolnOwner = game.playerStates[id];
    return !lincolnOwner.isCurrentTurnPlayer && lincolnOwner.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.suppressAllGraveyardAbilitiesOnOpponentTurn;
    });
  })) return true;
  return false;
}

// 戦場全体(自分・相手どちらも)にある、名前の異なる「音楽」カード(イジン・ハイケイ問わず)の数。
function distinctMusicCardNameCountOnField(ps, opp) {
  const names = new Set();
  for (const side of [ps, opp]) {
    if (!side) continue;
    for (const inst of [...side.field.ijin, ...side.field.haikei]) {
      if (hasEffectiveTrait(inst, '音楽', side)) names.add(getCard(inst.cardId).name);
    }
  }
  return names.size;
}

// 払暁の城壁: これが自分の戦場か墓地にある間、ターンに1回、自分の墓地の「冥府発動」マホウは
// 手札から墓地に置かれていても発動できる(この能力自体は戦場・墓地どちらでも効果を発揮する)。
function canActivateMeifuHatsudou(ps) {
  if (ps.meifuFromHandDiscardUsedThisTurn) return false;
  return [...ps.field.haikei, ...ps.graveyard].some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.allowMeifuFromHandDiscardOncePerTurn;
  });
}

// フランツ・ペーター・シューベルト: 戦場に名前の異なる「音楽」カードが一定数以上ある間、
// 相手(このカードの持ち主から見た相手)は自分の墓地のカードを戦場に置けない。
// ps は墓地のカードを戦場に置こうとしているプレイヤー自身。
function canPlaceFromGraveyardToField(ps) {
  if (!ps || !ps.game) return true;
  const opp = ps.game.playerStates[opponentId(ps.game, ps.id)];
  if (!opp) return true;
  const blocker = opp.field.ijin.find((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.blockOpponentGraveyardToFieldIfDistinctMusicCountAtLeast != null;
  });
  if (!blocker) return true;
  const threshold = getCard(blocker.cardId).keywords.blockOpponentGraveyardToFieldIfDistinctMusicCountAtLeast;
  return distinctMusicCardNameCountOnField(ps, opp) < threshold;
}

// ルートヴィヒ・ヴァン・ベートーヴェン: 戦場に名前の異なる「音楽」カードが一定数以上ある間、
// 相手は自分の墓地のカードを手札に戻せない。ps は墓地のカードを手札に戻そうとしているプレイヤー自身。
function canReturnFromGraveyardToHand(ps) {
  if (!ps || !ps.game) return true;
  const opp = ps.game.playerStates[opponentId(ps.game, ps.id)];
  if (!opp) return true;
  const blocker = opp.field.ijin.find((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.blockOpponentGraveyardToHandIfDistinctMusicCountAtLeast != null;
  });
  if (!blocker) return true;
  const threshold = getCard(blocker.cardId).keywords.blockOpponentGraveyardToHandIfDistinctMusicCountAtLeast;
  return distinctMusicCardNameCountOnField(ps, opp) < threshold;
}

// 二重螺旋階段: この能力は戦場で効果を発揮する。自分と相手の墓地のマホウは、
// 能力によって墓地を離れない。
function isGraveyardMahouProtectedFromAbilityRemoval(ps, opp) {
  return [ps, opp].some((side) => side && side.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.protectGraveyardMahouFromAbilityRemoval;
  }));
}

// 仁王: 能力によってこれを数える際、1つでなく2つと数える。
// 「戦場のハイケイの数」を数える能力すべてに対して、この数え方を適用する。
function haikeiFieldCount(playerState) {
  let count = 0;
  for (const h of playerState.field.haikei) {
    const card = getCard(h.cardId);
    count += (card.keywords && card.keywords.countsAsTwoWhenCounted) ? 2 : 1;
  }
  return count;
}

// 「戦場のイジンすべては、このターンに限り『色：X』/『特性：X』を得る」のような
// 一時的な色・特性付与を反映した実効色・実効特性を返す。
function effectiveColors(instance, ps) {
  const card = getCard(instance.cardId);
  let colors = instance.tempColorsThisTurn ? [...card.colors, ...instance.tempColorsThisTurn] : card.colors;
  if (ps) {
    for (const h of ps.field.haikei) {
      const hCard = getCard(h.cardId);
      if (!Array.isArray(hCard.effect)) continue;
      for (const g of hCard.effect) {
        if (g.type === 'grant_colors_by_color' && effectiveColors(instance).includes(g.color)) {
          colors = [...colors, ...g.grantedColors];
        }
      }
    }
    // カルドロン・プリズム: これが魔力ゾーンに表向きである間、自分の墓地の色すべてを得る。
    if (card.keywords && card.keywords.grantAllOwnGraveyardColorsWhileFaceUpMana && instance.faceUp && ps.mana.includes(instance)) {
      const gyColors = new Set();
      for (const c of ps.graveyard) getCard(c.cardId).colors.forEach((col) => gyColors.add(col));
      colors = [...colors, ...gyColors];
    }
    // 火と氷の大地: これが戦場にある間、相手の戦場のレベル2以下のイジンは「色：赤」を得る。
    const oppOfPs2 = ps.game ? ps.game.playerStates[opponentId(ps.game, ps.id)] : null;
    if (oppOfPs2 && card.level != null) {
      for (const h of oppOfPs2.field.haikei) {
        const hKw = getCard(h.cardId).keywords;
        if (hKw && hKw.grantColorToOpponentLevelAtMost && card.level <= hKw.grantColorToOpponentLevelAtMost.levelMax) {
          colors = [...colors, hKw.grantColorToOpponentLevelAtMost.color];
        }
      }
    }
  }
  return colors;
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
        // 蝦夷共和国: ガーディアンが自分の戦場にいない間、自分の戦場のレベル4以下のイジンは「特性：志願」を得る。
        if (g.type === 'grant_trait_by_level_max_if_no_guardian' && g.trait === trait && card.level <= g.levelMax && ps.guardians.length === 0) return true;
      }
    }
    // ヨハン・ゼバスティアン・バッハ: これが戦場にいる間、戦場のイジンとハイケイ(自分・相手
    // どちらも)は「特性：音楽」を得る。
    const oppOfPs = ps.game ? ps.game.playerStates[opponentId(ps.game, ps.id)] : null;
    for (const side of [ps, oppOfPs]) {
      if (!side) continue;
      for (const i of side.field.ijin) {
        const kw2 = getCard(i.cardId).keywords;
        if (kw2 && kw2.grantTraitToAllFieldBothSides === trait) return true;
      }
    }
  }
  return false;
}

// 「航海」は本アプリのキーワードとしては存在せず、カードテキストの見出しとして表現される
// アビリティカテゴリ(「航海 - アタッカーになったとき、〜」)であるため、見出しの有無を
// テキストから判定する。他カードの「航海」に言及・付与するだけのカード(「航海」を
// 引用符付きで参照するのみ)は対象外とする。
function hasKoukaiAbility(card) {
  return card.type === 'ijin' && /(^|\n)航海\s*-/.test(card.text || '');
}

// 「執筆」(ハイケイが戦場に置かれたとき発動するトリガーの慣用的な扱い。本エンジンでは
// onHaikeiPlacedトリガーを持つカードを広く「執筆」として扱う既存の慣習に合わせる)が、
// これらのカードの継続効果によって発動しないかどうかを判定する。
// instanceOwnerPsは執筆を発動しようとしているカードの持ち主、instanceOwnerOppはその相手。
function isShippitsuSuppressed(instanceOwnerPs, instanceOwnerOpp, instanceCard) {
  // 始皇帝: これが戦場にいる間「執筆」は発動しない(両陣営、無条件)。
  const hasQin = [instanceOwnerPs, instanceOwnerOpp].some((side) => side && side.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.suppressAllShippitsuWhileOnField;
  }));
  if (hasQin) return true;
  // ジャン・カルヴァン: 発動すると、このターンの間「執筆」は発動しない(両陣営)。
  const hasCalvin = [instanceOwnerPs, instanceOwnerOpp].some((side) => side && side.shippitsuSuppressedThisTurn);
  if (hasCalvin) return true;
  // 茅葺き屋根の張出し舞台: 相手のターンの間、黄でないカードの「執筆」は発動しない。
  if (!instanceCard.colors.includes('yellow')) {
    const hasKayabuki = (side, otherSide) => otherSide && otherSide.isCurrentTurnPlayer && side.field.haikei.some((h) => {
      const kw = getCard(h.cardId).keywords;
      return kw && kw.suppressNonYellowShippitsuOnOpponentTurn;
    });
    if (hasKayabuki(instanceOwnerPs, instanceOwnerOpp) || hasKayabuki(instanceOwnerOpp, instanceOwnerPs)) return true;
  }
  return false;
}

// 「モータル」を実際に持っているかどうか(常在効果による付与を含む)を判定する
function hasEffectiveMortal(instance, ps) {
  const card = getCard(instance.cardId);
  if (card.keywords && card.keywords.mortal) return true;
  // 蝦夷共和国: 自分の戦場の「志願」イジンは「モータル」を得る。
  if (ps && ps.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.grantMortalToVolunteerIjin;
  }) && hasEffectiveTrait(instance, '志願', ps)) return true;
  return false;
}

// エリザベス1世: 能力によってカードが自分の魔力ゾーンを離れるたび、相手の戦場のパワー3000以下の
// イジン1体を破壊する(ターンに1回まで)。魔力ゾーンからカードを取り除く全ての汎用効果の実装箇所
// から、取り除いた直後にこれを呼び出す。ownerPsは魔力ゾーンの持ち主、opponentPsはその相手。
function fireOnManaLeftViaAbility(game, ownerPs, opponentPs) {
  if (!ownerPs || !opponentPs) return;
  const hasElizabeth = ownerPs.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.destroyOpponentLowPowerIjinOnManaLeftViaAbility;
  });
  if (!hasElizabeth) return;
  if (ownerPs.elizabethManaLeaveUsedThisTurn) return;
  const candidates = opponentPs.field.ijin.filter((i) => effectivePower(i, opponentPs) <= 3000);
  if (candidates.length === 0) return;
  candidates.sort((a, b) => effectivePower(b, opponentPs) - effectivePower(a, opponentPs));
  const target = candidates[0];
  ownerPs.elizabethManaLeaveUsedThisTurn = true;
  destroyFieldOrGuardian(game, opponentPs, target);
  log(game, `${ownerPs.name}のエリザベス1世の効果で「${getCard(target.cardId).name}」を破壊しました。`);
}

// 遠征軍: 山札から墓地に置かれたときに発動できる。このターンに限り、自分は「自分の山札の
// カードは墓地に置かれない」を得る。その後バトルを中断し、ターンプレイヤーは残りのフェイズを
// 行わずにターンを終了する。ミル系の汎用効果が山札のカードを墓地に置くたび、この判定を呼び出す。
// 実際のバトル中断・ターン終了処理は、呼び出し元(summonIjin等の各アクション関数)の末尾で
// checkAndProcessForcedTurnEndを呼ぶことで、効果解決の途中で再入的にendTurnを呼ばないように
// 安全な位置まで遅延させる。
function checkMilledCardForForcedTurnEnd(game, ps, card, instance) {
  if (card.keywords && card.keywords.forceEndTurnWhenMilledFromDeck) {
    ps.preventDeckToGraveyardMillThisTurn = true;
    game.pendingForcedTurnEnd = ps.id;
    log(game, `${ps.name}の「${card.name}」が山札から墓地に置かれ、バトルを中断してターンを終了します。`);
  }
  // 四面楚歌: 相手のターンに戦場か墓地で効果を発揮する。自分の墓地の遺業能力は
  // 山札から墓地に置かれても発動する(通常、山札からの墓地送りは遺業能力を発動しない)。
  if (!instance || !card.legacy || ps.isCurrentTurnPlayer) return;
  const hasShimenSoka = [...ps.field.haikei, ...ps.graveyard].some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.allowOwnLegacyFromDeckMillOnOpponentTurn;
  });
  if (!hasShimenSoka) return;
  const opp = game.playerStates[opponentId(game, ps.id)];
  // 森閑たる離宮: 「冥府発動」でない遺業能力は発動しない。
  const hasMorikan = game.players.some((id) => game.playerStates[id].field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.suppressNonMeifuLegacyAndPunishFieldDeaths;
  }));
  if (hasMorikan && card.legacyText !== '冥府発動') return;
  // アリストテレス: 自分のターンに戦場で効果を発揮する。相手の墓地の「冥府発動」でない
  // 遺業能力は発動しない。
  const hasAristotleOpposing = opp && opp.isCurrentTurnPlayer && opp.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.suppressOpponentNonMeifuLegacyOnOwnTurn;
  });
  if (hasAristotleOpposing && card.legacyText !== '冥府発動') return;
  if (isAbilitySuppressed(instance, ps, opp) || isGraveyardCardAbilitySuppressedByMozart(instance, ps, opp)) return;
  game.pendingLegacyTriggers.push({ playerId: ps.id, cardUid: instance.uid });
}

function checkAndProcessForcedTurnEnd(game) {
  if (!game.pendingForcedTurnEnd || game.winner) return;
  const playerId = game.pendingForcedTurnEnd;
  game.pendingForcedTurnEnd = null;
  game.pendingBattle = null;
  // バトル中断・ターン強制終了に伴い、まだ解決していない「発動できる」系の保留状態も破棄する。
  game.pendingMainStartTrigger = null;
  game.pendingHaikeiPlacedTrigger = null;
  game.pendingManaOnPlaceDiscard = null;
  game.pendingEffectChoice = null;
  game.pendingLegacyTriggers = [];
  endTurn(game, playerId);
}

// 天下分け目の主戦場: 自分の魔力ゾーンのマリョクは「戦場の能力によって魔力ゾーンを離れない」を得る。
// sourceInstanceは効果の発動元(戦場のイジン・ハイケイの能力ならインスタンス、マホウならnull)。
// マホウによる魔力ゾーンからの除去は「戦場の能力」ではないため対象外とする。
function isManaProtectedFromFieldAbilityRemoval(manaInstance, ownerPs, sourceInstance) {
  if (!sourceInstance) return false;
  const card = getCard(manaInstance.cardId);
  if (card.type !== 'maryoku') return false;
  return ownerPs.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.protectOwnManaFromFieldAbilityRemoval;
  });
}

// 永遠の帝都: 自分の戦場の『ブロック+』能力を持つイジンと、自分の戦場のガーディアンは
// 「能力によって破壊されない」を得る(バトルによる破壊は除く)。
function isIndestructibleByAbility(instance, ps, zone, game) {
  const hasEienTeito = ps.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.protectBlockBonusIjinAndGuardiansFromAbilityDestruction;
  });
  if (hasEienTeito) {
    if (zone === 'guardian') return true;
    if (zone === 'ijin') {
      const card = getCard(instance.cardId);
      if (card.keywords && card.keywords.blockBonus) return true;
      const grant = equippedGrant(instance);
      if (grant && grant.blockBonus) return true;
    }
  }
  // 炎上がる天守閣: 自分の戦場の『アタック+』能力を持つイジンと、自分の戦場のガーディアンは
  // 「戦場の能力によって戦場を離れない」を得る(バトルによる破壊は除く)。
  const hasEnjouTenshukaku = ps.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.protectAttackPlusIjinAndGuardiansFromFieldAbilityRemoval;
  });
  if (hasEnjouTenshukaku) {
    if (zone === 'guardian') return true;
    if (zone === 'ijin') {
      const card = getCard(instance.cardId);
      if (card.keywords && card.keywords.attackBonus) return true;
      const grant = equippedGrant(instance);
      if (grant && grant.attackBonus) return true;
    }
  }
  // ホプロン: 装備している間、バトルの間は自分の戦場のイジンすべてが能力によって
  // 破壊されない。「相手の能力によって」の部分は、破壊を引き起こした主体を汎用的に
  // 追跡する仕組みがないため簡略化し、自分自身の能力による破壊も含めて防ぐものとして扱う。
  if (zone === 'ijin' && game && game.pendingBattle) {
    const hasHoplon = ps.field.ijin.some((i) => {
      const grant = equippedGrant(i);
      return grant && grant.protectAllOwnIjinFromAbilityDestructionDuringBattle;
    });
    if (hasHoplon) return true;
  }
  // アンナ・パブロワ: 「音楽」イジンが自分の戦場にいる間「破壊されない」を得る。
  if (zone === 'ijin' && hasEffectiveTrait(instance, '音楽', ps) && ps.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.grantIndestructibleToMusicIjin;
  })) {
    return true;
  }
  // 親鸞: 自分の墓地にカードが6つ以上ある間「破壊されない」を得る(自分自身のみ)。
  if (zone === 'ijin') {
    const card = getCard(instance.cardId);
    if (card.keywords && card.keywords.indestructibleIfOwnGraveyardCountAtLeast != null
      && ps.graveyard.length >= card.keywords.indestructibleIfOwnGraveyardCountAtLeast) {
      return true;
    }
  }
  // シャルル・ド・モンテスキュー: 相手の戦場に2色以上ある間、自分の戦場の「思想」カードは
  // 「能力によって破壊されない」を得る。
  if ((zone === 'ijin' || zone === 'haikei') && hasEffectiveTrait(instance, '思想', ps) && game) {
    const oppOfPs = game.playerStates[opponentId(game, ps.id)];
    if (oppOfPs) {
      const oppColors = new Set();
      for (const i of [...oppOfPs.field.ijin, ...oppOfPs.field.haikei]) getCard(i.cardId).colors.forEach((c) => oppColors.add(c));
      const hasMontesquieu = ps.field.ijin.some((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && kw.grantIndestructibleToThoughtIfOpponentColorCountAtLeast != null && oppColors.size >= kw.grantIndestructibleToThoughtIfOpponentColorCountAtLeast;
      });
      if (hasMontesquieu) return true;
    }
  }
  // シャルル・ド・モンテスキュー: 相手の戦場に3色以上ある間、自分の戦場の「思想」カードは
  // 「能力によって戦場を離れない」を得る(破壊も含む、より強い保護)。
  if ((zone === 'ijin' || zone === 'haikei') && hasEffectiveTrait(instance, '思想', ps) && game) {
    const oppOfPs2 = game.playerStates[opponentId(game, ps.id)];
    if (oppOfPs2) {
      const oppColors2 = new Set();
      for (const i of [...oppOfPs2.field.ijin, ...oppOfPs2.field.haikei]) getCard(i.cardId).colors.forEach((c) => oppColors2.add(c));
      const hasMontesquieuStrong = ps.field.ijin.some((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && kw.protectThoughtFromLeavingFieldIfOpponentColorCountAtLeast != null && oppColors2.size >= kw.protectThoughtFromLeavingFieldIfOpponentColorCountAtLeast;
      });
      if (hasMontesquieuStrong) return true;
    }
  }
  return false;
}

// シャルル・ド・モンテスキュー用: 対象が「戦場を離れない」保護を受けているかどうか
// (generic_bounce_ijin等、破壊以外の手段で戦場を離れる効果から対象を守るために使う)。
function isProtectedFromLeavingFieldByThought(instance, ps, opp) {
  if (!hasEffectiveTrait(instance, '思想', ps)) return false;
  const oppColors = new Set();
  for (const i of [...opp.field.ijin, ...opp.field.haikei]) getCard(i.cardId).colors.forEach((c) => oppColors.add(c));
  return ps.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.protectThoughtFromLeavingFieldIfOpponentColorCountAtLeast != null && oppColors.size >= kw.protectThoughtFromLeavingFieldIfOpponentColorCountAtLeast;
  });
}

// 「常在: ○○特性のイジンは即応を得る」のような、ハイケイの存在に依存する常時再計算の即応判定
function hasEffectiveRush(instance, ps) {
  const card = getCard(instance.cardId);
  // エイブラハム・リンカン: 「即応」を得ることができない(いかなる手段でも即応を得ない)。
  if (card.keywords && card.keywords.cannotGainRush) return false;
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
  // ジョージ・ワシントン: これが戦場にいる間、自分の戦場の『アタック+』能力を持つイジンは即応を得る。
  if (card.type === 'ijin' && ps.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.grantRushToOwnAttackBonusIjin;
  })) {
    const grant = equippedGrant(instance);
    const hasAttackBonus = !!((card.keywords && card.keywords.attackBonus) || (grant && grant.attackBonus));
    if (hasAttackBonus) return true;
  }
  // ジョン・ハンター: これのパワーが7000以上なら「即応」を得る。
  if (card.keywords && card.keywords.rushIfSelfPowerAtLeast != null && effectivePower(instance, ps) >= card.keywords.rushIfSelfPowerAtLeast) return true;
  // 前田利家: 躍進 - このターンに魔力ゾーンの能力によって山札からカードを引いているなら、
  // 「即応」を得る。
  if (card.keywords && card.keywords.rushIfYakushin && ps.drewViaManaAbilityThisTurn) return true;
  // 姜維: これが戦場にいる間、自分の戦場の他の黄のイジンは即応を得る。
  if (card.colors.includes('yellow') && ps.field.ijin.some((i) => i.uid !== instance.uid && (getCard(i.cardId).keywords || {}).grantRushWatcherPowerToOtherYellowIjin)) {
    return true;
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

// 大日本沿海輿地全図: これのハイケイ使用に際し、これのレベルは、自分の戦場のハイケイの
// レベルの合計と同じだけ下がる。
function ownHaikeiFieldLevelSum(playerState) {
  return playerState.field.haikei.reduce((sum, h) => sum + getCard(h.cardId).level, 0);
}

function canUseCard(playerState, card) {
  if (!satisfiesColorCondition(playerState, card)) return false;
  let effectiveLevel = card.level;
  if (card.type === 'haikei' && card.keywords && card.keywords.levelReducedByOwnFieldHaikeiLevelSum) {
    effectiveLevel -= ownHaikeiFieldLevelSum(playerState);
  }
  if (levelSum(playerState) < effectiveLevel) return false;
  return true;
}

// アルケミーストーン: これが自分の魔力ゾーンに表向きである間、自分はイジン召喚に際し、
// 色条件を満たしていなくても手札のカードを使える。
function canUseCardForSummon(playerState, card) {
  const ignoreColor = playerState.mana.some((m) => m.faceUp && (getCard(m.cardId).keywords || {}).ignoreColorConditionForSummon);
  if (ignoreColor) return levelSum(playerState) >= card.level;
  return canUseCard(playerState, card);
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
      bonus += grant.powerBonusPerOwnHaikeiFieldWide * haikeiFieldCount(playerState);
    }
    const card = getCard(i.cardId);
    // 太田道灌: このターンに魔力ゾーンの能力によって山札からカードを引いているなら、
    // 自分の戦場のイジンはパワー+Nを得る(躍進)。
    if (card.effect && card.effect.type === 'power_aura_if_drew_via_mana_ability' && playerState.drewViaManaAbilityThisTurn) {
      bonus += card.effect.value;
    }
    // 董仲舒: 自分のターンなら、自分の戦場のイジンはマリョク配置権1つにつきパワー+Nを得る。
    if (card.effect && card.effect.type === 'power_aura_per_mana_right_if_own_turn' && playerState.isCurrentTurnPlayer) {
      bonus += card.effect.value * playerState.manaRight;
    }
  }
  // 殿: 相手の手札のカードが自分の手札のカードよりも多いなら、自分のターンに戦場で
  // 効果を発揮する。自分の戦場のイジンはパワー+Nを得る。
  if (playerState.isCurrentTurnPlayer && playerState.game) {
    const oppOfPlayerState4 = playerState.game.playerStates[opponentId(playerState.game, playerState.id)];
    if (oppOfPlayerState4 && oppOfPlayerState4.hand.length > playerState.hand.length) {
      for (const h of playerState.field.haikei) {
        const hCard = getCard(h.cardId);
        if (hCard.effect && hCard.effect.type === 'power_aura_if_opponent_hand_greater_and_own_turn') bonus += hCard.effect.value;
      }
    }
  }
  return bonus;
}

function manaRightBonus(playerState, opponentState) {
  let bonus = 0;
  for (const i of [...playerState.field.ijin, ...playerState.field.haikei]) {
    const card = getCard(i.cardId);
    if (card.effect && card.effect.type === 'mana_right_bonus') bonus += card.effect.value;
  }
  // 水野忠邦: これが(自分・相手どちらの)戦場にいる間、マリョク配置権は戦場の能力によって増えない。
  const hasMizuno = (state) => state && state.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.suppressManaRightBonusGlobally;
  });
  if (hasMizuno(playerState) || hasMizuno(opponentState)) return 0;
  return bonus;
}

function effectivePower(instance, playerState) {
  const card = getCard(instance.cardId);
  let power = card.power + powerAuraBonus(playerState) + (instance.tempPowerBonusThisTurn || 0);
  // ジャン・カルヴァン: 相手のターンの間「パワー+2000」を得る(自分自身のみ)。
  if (card.keywords && card.keywords.powerBonusOnOpponentTurn && playerState && !playerState.isCurrentTurnPlayer) {
    power += card.keywords.powerBonusOnOpponentTurn;
  }
  // 黄金時代: 相手の手札のカードが3つ以下なら、相手の戦場のイジンはパワー-2000を得る。
  // (playerStateは対象イジンの持ち主。playerState.gameから相手を求め、相手が黄金時代を
  // 持ち、playerState自身の手札が3枚以下かどうかを判定する)
  if (playerState && playerState.game) {
    const oppOfPlayerState = playerState.game.playerStates[opponentId(playerState.game, playerState.id)];
    if (oppOfPlayerState && playerState.hand.length <= 3 && oppOfPlayerState.field.haikei.some((h) => {
      const kw = getCard(h.cardId).keywords;
      return kw && kw.debuffOpponentIjinIfOpponentHandAtMost3;
    })) {
      power -= 2000;
    }
    // ニッコロ・マキャヴェッリ: 相手の戦場のレベルX以下のイジンは「パワー-N」を得る。
    if (oppOfPlayerState && card.level != null && oppOfPlayerState.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.debuffOpponentIjinLevelAtMost && card.level <= kw.debuffOpponentIjinLevelAtMost.levelMax;
    })) {
      const source = oppOfPlayerState.field.ijin.find((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && kw.debuffOpponentIjinLevelAtMost && card.level <= kw.debuffOpponentIjinLevelAtMost.levelMax;
      });
      power += getCard(source.cardId).keywords.debuffOpponentIjinLevelAtMost.value;
    }
    // ジェームズ・クラーク・マクスウェル: 相手の戦場のイジンは、その相手の戦場のアタッカー
    // 1体につき「パワー-N」を得る。
    if (oppOfPlayerState && playerState.game && playerState.game.pendingBattle && playerState.game.pendingBattle.attackerPlayerId === oppOfPlayerState.id) {
      const maxwell = oppOfPlayerState.field.ijin.find((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && kw.debuffOpponentPerOwnAttackerCount;
      });
      if (maxwell) power += getCard(maxwell.cardId).keywords.debuffOpponentPerOwnAttackerCount * playerState.game.pendingBattle.attackers.length;
    }
    // 北里柴三郎: 躍進 - このターンに魔力ゾーンの能力によって山札からカードを引いているなら、
    // 相手の戦場のイジンは「パワー-N」を得る。
    if (oppOfPlayerState && oppOfPlayerState.drewViaManaAbilityThisTurn) {
      const kitasato = oppOfPlayerState.field.ijin.find((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && kw.debuffOpponentAllIfYakushin;
      });
      if (kitasato) power += getCard(kitasato.cardId).keywords.debuffOpponentAllIfYakushin;
    }
  }
  // トマス・モア: これが戦場にいる間、自分の戦場のハイケイ1つにつき「パワー+N」を得る
  // (自分自身のみ)。
  if (card.keywords && card.keywords.powerBonusPerOwnHaikeiCount && playerState) {
    power += card.keywords.powerBonusPerOwnHaikeiCount * haikeiFieldCount(playerState);
  }
  // エカチェリーナ2世: 相手の魔力ゾーンにあるマリョク1つにつき「パワー+N」を得る
  // (自分自身のみ)。
  if (card.keywords && card.keywords.powerBonusPerOpponentManaCount && playerState && playerState.game) {
    const oppOfPs = playerState.game.playerStates[opponentId(playerState.game, playerState.id)];
    if (oppOfPs) power += card.keywords.powerBonusPerOpponentManaCount * oppOfPs.mana.length;
  }
  // 武帝: 自分の戦場のイジン1体につき「パワー+1000」を得る(自分自身のみ)。
  if (card.keywords && card.keywords.powerBonusPerOwnFieldIjinCount && playerState) {
    power += card.keywords.powerBonusPerOwnFieldIjinCount * playerState.field.ijin.length;
  }
  // 岡田以蔵: 相手の墓地のイジン1体につき「パワー+2000」を得る(自分自身のみ)。
  if (card.keywords && card.keywords.powerBonusPerOpponentGraveyardIjinCount && playerState && playerState.game) {
    const oppOfPlayerState2 = playerState.game.playerStates[opponentId(playerState.game, playerState.id)];
    if (oppOfPlayerState2) {
      const count = oppOfPlayerState2.graveyard.filter((c) => getCard(c.cardId).type === 'ijin').length;
      power += card.keywords.powerBonusPerOpponentGraveyardIjinCount * count;
    }
  }
  // ジョン・ハンター: 躍進 - このターンに魔力ゾーンの能力によって山札からカードを引いているなら、
  // 自分と相手の墓地のイジン1体につき「パワー+2000」を得る(自分自身のみ)。
  if (card.keywords && card.keywords.powerBonusPerBothGraveyardIjinIfYakushin && playerState && playerState.drewViaManaAbilityThisTurn && playerState.game) {
    const oppOfPlayerState3 = playerState.game.playerStates[opponentId(playerState.game, playerState.id)];
    let count = playerState.graveyard.filter((c) => getCard(c.cardId).type === 'ijin').length;
    if (oppOfPlayerState3) count += oppOfPlayerState3.graveyard.filter((c) => getCard(c.cardId).type === 'ijin').length;
    power += card.keywords.powerBonusPerBothGraveyardIjinIfYakushin * count;
  }
  // 姜維: これが戦場にいる間、自分の戦場の他の黄のイジンはパワー+3000を得る。
  if (card.colors.includes('yellow') && playerState) {
    const jiangWei = playerState.field.ijin.find((i) => i.uid !== instance.uid && (getCard(i.cardId).keywords || {}).grantRushWatcherPowerToOtherYellowIjin);
    if (jiangWei) power += getCard(jiangWei.cardId).keywords.grantRushWatcherPowerToOtherYellowIjin;
  }
  const grant = equippedGrant(instance);
  if (grant) {
    if (grant.powerBonus) power += grant.powerBonus;
    if (grant.powerBonusPerOwnMana) power += grant.powerBonusPerOwnMana * playerState.mana.length;
    if (grant.powerBonusPerOwnColor) power += grant.powerBonusPerOwnColor * card.colors.length;
  }
  return power;
}

// アタック+N: アタッカーを選んでいる間だけ加算されるパワー修正
function attackContextPower(instance, playerState, opponentState) {
  const card = getCard(instance.cardId);
  let bonus = (card.keywords && card.keywords.attackBonus) || 0;
  const grant = equippedGrant(instance);
  if (grant && grant.attackBonus) bonus += grant.attackBonus;
  bonus += instance.tempAttackBonusThisTurn || 0;
  // オリバー・クロムウェル: 相手の魔力ゾーンの裏のカード1つにつき「アタック+1000」を得る。
  if (card.keywords && card.keywords.attackBonusPerOpponentFacedownMana && opponentState) {
    bonus += card.keywords.attackBonusPerOpponentFacedownMana * opponentState.mana.filter((m) => !m.faceUp).length;
  }
  // 天下分け目の主戦場: カードが魔力ゾーンに5つ以上ある間、自分の戦場のイジンはアタック+2000を得る。
  if (playerState.mana.length >= 5 && playerState.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.attackBonusIfOwnManaAtLeast5;
  })) {
    bonus += 2000;
  }
  // 西郷隆盛: イジンが相手の戦場にいる間「アタック+3000」を得る。
  if (card.keywords && card.keywords.attackBonusIfOpponentHasIjin && opponentState && opponentState.field.ijin.length > 0) {
    bonus += card.keywords.attackBonusIfOpponentHasIjin;
  }
  // 直江兼続: これが戦場にいる間、自分の戦場の特定特性のイジンは「アタック+N」を得る。
  for (const i of playerState.field.ijin) {
    if (i.uid === instance.uid) continue;
    const grantKw = getCard(i.cardId).keywords;
    if (grantKw && grantKw.grantAttackBonusToTraitIjin && hasEffectiveTrait(instance, grantKw.grantAttackBonusToTraitIjin.trait, playerState)) {
      bonus += grantKw.grantAttackBonusToTraitIjin.value;
    }
    // 足利義満: これが戦場にいる間、自分の戦場の他のイジンは「アタック+N」を得る。
    if (grantKw && grantKw.grantAttackBonusToOtherOwnIjin) {
      bonus += grantKw.grantAttackBonusToOtherOwnIjin;
    }
  }
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
  // 永遠の帝都: 自分の戦場のレベル3以下のイジンはブロック+1000を得る。
  if (card.level <= 3 && playerState.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.blockBonusForLowLevelIjin;
  })) {
    bonus += 1000;
  }
  // 李舜臣: 「即応」を持つイジンが相手の戦場にいる間「ブロック+4000」を得る。
  if (card.keywords && card.keywords.blockBonusIfOpponentHasRushIjin && playerState.game) {
    const oppOfPlayerState = playerState.game.playerStates[opponentId(playerState.game, playerState.id)];
    if (oppOfPlayerState && oppOfPlayerState.field.ijin.some((i) => hasEffectiveRush(i, oppOfPlayerState))) {
      bonus += card.keywords.blockBonusIfOpponentHasRushIjin;
    }
  }
  // 伊達政宗: 戦場の「剣術」イジン1体につき「ブロック+1000」を得る。
  if (card.keywords && card.keywords.blockBonusPerOwnTraitCount) {
    const { trait, value } = card.keywords.blockBonusPerOwnTraitCount;
    const count = playerState.field.ijin.filter((i) => hasEffectiveTrait(i, trait, playerState)).length;
    bonus += value * count;
  }
  // 孔子: これが戦場にいる間、自分の戦場のイジンは「ブロック+N」を得る。
  for (const i of playerState.field.ijin) {
    if (i.uid === instance.uid) continue;
    const grantKw = getCard(i.cardId).keywords;
    if (grantKw && grantKw.grantBlockBonusToAllOwnIjin) bonus += grantKw.grantBlockBonusToAllOwnIjin;
  }
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
  if (!found) {
    found = ps.graveyard.find((g) => g.uid === equipCardUid);
    zone = 'graveyard';
  }
  if (!found) return;
  const eqCard = getCard(found.cardId);

  if (zone === 'graveyard') {
    // 冥装: 墓地にある間だけ装備品として提供できるカード(常に冥装を持つものと、
    // マホウ使用によって墓地に置かれた際に限り冥装を得るものの両方に対応)。
    const hasMeiso = (eqCard.keywords && eqCard.keywords.meiso) || found.hasMeiso;
    if (!hasMeiso || !eqCard.meisoEquip) return;
    const offer = eqCard.meisoEquip;
    if (offer.colorAny && !ijinCard.colors.some((c) => offer.colorAny.includes(c))) return;
    if (offer.requireTrait && !hasEffectiveTrait(ijinInstance, offer.requireTrait, ps)) return;
  } else {
    if (!eqCard.equipOffer) return;
    if (eqCard.equipOffer.colorAny && !ijinCard.colors.some((c) => eqCard.equipOffer.colorAny.includes(c))) return;
    if (eqCard.equipOffer.requireText && !(ijinCard.text || '').includes(eqCard.equipOffer.requireText)) return;
  }

  if (zone === 'mana') ps.mana.splice(ps.mana.indexOf(found), 1);
  else if (zone === 'haikei') ps.field.haikei.splice(ps.field.haikei.indexOf(found), 1);
  else ps.graveyard.splice(ps.graveyard.indexOf(found), 1);
  found.originZone = zone;
  found.originFaceUp = found.faceUp;
  ijinInstance.equippedCard = found;
}

function detachEquipmentIfAny(playerState, ijinInstance) {
  const eq = ijinInstance.equippedCard;
  if (!eq) return;
  ijinInstance.equippedCard = null;
  eq.tapped = false;
  if (eq.originZone === 'mana') {
    eq.faceUp = eq.originFaceUp;
    playerState.mana.push(eq);
  } else if (eq.originZone === 'graveyard') {
    eq.faceUp = true;
    playerState.graveyard.push(eq);
  } else {
    eq.faceUp = eq.originFaceUp;
    playerState.field.haikei.push(eq);
  }
}

// ---------- 墓地移動 / 遺業能力 ----------

function moveToGraveyard(game, playerState, instance, fromZoneList, suppressLegacy, fromZone) {
  const idx = fromZoneList.indexOf(instance);
  if (idx !== -1) fromZoneList.splice(idx, 1);
  const card = getCard(instance.cardId);
  instance.faceUp = true;
  playerState.graveyard.push(instance);
  log(game, `${playerState.name}の「${card.name}」が墓地に置かれました。`);

  // 森閑たる離宮: (自分・相手どちらの戦場にあっても)「冥府発動」でない遺業能力は発動しない。
  // カードが戦場から墓地に置かれるたび、そのカードが「冥府発動」を持っていないなら、
  // そのカードのプレイヤーの手札1枚を墓地に置く。
  const hasMorikan = game.players.some((id) => game.playerStates[id].field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.suppressNonMeifuLegacyAndPunishFieldDeaths;
  }));

  // 渋沢栄一: この能力はターンに1回だけ、戦場で発動する。自分か相手の墓地にハイケイが
  // 置かれたとき、自分と相手の戦場のガーディアンを合わせて3体まで指定して発動できる。
  // そのガーディアンすべてを手札に戻す(簡略化として、対象は自動選択・戦場から墓地に
  // 置かれた場合のみを対象とする)。
  if (card.type === 'haikei') {
    for (const ownerId of game.players) {
      const shibusawaPs = game.playerStates[ownerId];
      const shibusawaOpp = game.playerStates[opponentId(game, ownerId)];
      const shibusawa = shibusawaPs.field.ijin.find((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && kw.bounceUpToThreeGuardiansCombinedOnHaikeiGraveyardOncePerTurn;
      });
      if (!shibusawa || shibusawaPs.usedShibusawaTriggerThisTurn || isAbilitySuppressed(shibusawa, shibusawaPs, shibusawaOpp)) continue;
      const pool = [
        ...shibusawaPs.guardians.map((g) => ({ side: shibusawaPs, g })),
        ...shibusawaOpp.guardians.map((g) => ({ side: shibusawaOpp, g })),
      ].slice(0, 3);
      if (pool.length === 0) continue;
      shibusawaPs.usedShibusawaTriggerThisTurn = true;
      for (const { side, g } of pool) {
        side.guardians.splice(side.guardians.indexOf(g), 1);
        g.faceUp = true;
        side.hand.push(g);
      }
      log(game, `${shibusawaPs.name}の渋沢栄一の効果でガーディアン${pool.length}体が手札に戻りました。`);
    }
  }
  if (hasMorikan) {
    suppressLegacy = suppressLegacy || card.legacyText !== '冥府発動';
    if ((fromZone === 'ijin' || fromZone === 'haikei') && card.legacyText !== '冥府発動' && playerState.hand.length > 0) {
      const discarded = playerState.hand[0];
      playerState.hand.splice(0, 1);
      discarded.faceUp = true;
      playerState.graveyard.push(discarded);
      log(game, `${playerState.name}は森閑たる離宮の効果で手札1枚を墓地に置きました。`);
      fireOnDiscardedFromHandTrigger(game, playerState, game.playerStates[opponentId(game, playerState.id)], discarded);
    }
  }

  // アリストテレス: 自分のターンに戦場で効果を発揮する。相手の墓地の「冥府発動」でない
  // 遺業能力は発動しない。
  const opponentOfPlayerState = game.playerStates[opponentId(game, playerState.id)];
  const hasAristotleOpposing = opponentOfPlayerState && opponentOfPlayerState.isCurrentTurnPlayer && opponentOfPlayerState.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.suppressOpponentNonMeifuLegacyOnOwnTurn;
  });
  if (hasAristotleOpposing) suppressLegacy = suppressLegacy || card.legacyText !== '冥府発動';

  // 遺業能力はルール上「発動できる(任意)」ため、この場では発動せず、プレイヤーが
  // resolveLegacyTrigger で発動するか(発動する場合は対象等も指定して)決めるまで、
  // 保留状態としてキューに積んでおく(pendingLegacyTriggers)。
  if (card.legacy && !suppressLegacy && !isAbilitySuppressed(instance, playerState, opponentOfPlayerState) && !isGraveyardCardAbilitySuppressedByMozart(instance, playerState, opponentOfPlayerState)) {
    game.pendingLegacyTriggers.push({ playerId: playerState.id, cardUid: instance.uid });
  }
}

// 遺業能力の実際の効果適用(resolveLegacyTriggerから、発動が選ばれた場合のみ呼ばれる)。
function applyLegacyEffect(game, playerState, instance, card, action) {
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
  } else if (card.legacy.type === 'bounce_self_hand' && canReturnFromGraveyardToHand(playerState)) {
    const gIdx = playerState.graveyard.indexOf(instance);
    if (gIdx !== -1) playerState.graveyard.splice(gIdx, 1);
    instance.faceUp = true;
    playerState.hand.push(instance);
    log(game, `${playerState.name}は遺業能力で「${card.name}」を手札に戻しました。`);
  } else if (card.legacy.type === 'kodama') {
    // 木霊: 自分の手札か墓地の、これより低いレベルを持つイジン1体をイジン召喚権を使わずに戦場に置く。
    // action.targetUid でプレイヤーが指定した対象を戦場に置く(未指定/不正なら発動しない)。
    const pool = kodamaTargetPool(playerState, instance, card);
    const chosen = pool.find((c) => c.uid === action.targetUid);
    if (chosen) {
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
  } else if (card.legacy.type === 'remove_one_attacker_from_battle') {
    // 喪神: 現在バトル中のアタッカー1体を、アタッカーでない状態にする。
    // バトル解決ループの内側(このカード自身がブロッカーとして倒れた場合等)で発動した場合、
    // 既に取得済みのループ用配列参照までは書き換えられないため、その場合は次の解決ステップ
    // 以降には影響しない、という簡略化を許容する(配列を直接破壊的に操作しないための安全策)。
    if (game.pendingBattle && game.pendingBattle.attackers.length > 0) {
      const removed = game.pendingBattle.attackers[0];
      game.pendingBattle.attackers = game.pendingBattle.attackers.filter((e) => e.uid !== removed.uid);
      log(game, `${playerState.name}は遺業能力(喪神)でアタッカー1体をアタッカーでない状態にしました。`);
    }
  } else if (card.legacy.type === 'return_to_deck_top_or_bottom') {
    // action.position: 'top' | 'bottom'(未指定ならtop扱い)。
    const gIdx = playerState.graveyard.indexOf(instance);
    if (gIdx !== -1) playerState.graveyard.splice(gIdx, 1);
    instance.faceUp = false;
    instance.tapped = false;
    if (action.position === 'bottom') playerState.deck.push(instance);
    else playerState.deck.unshift(instance);
    log(game, `${playerState.name}は遺業能力で「${card.name}」を山札の${action.position === 'bottom' ? '下' : '上'}に戻しました。`);
  }
}

// 木霊: 対象になり得る候補(自分の手札・墓地の、これより低いレベルを持つイジン)。
function kodamaTargetPool(playerState, instance, card) {
  const canFromGraveyard = canPlaceFromGraveyardToField(playerState);
  return [...playerState.hand, ...(canFromGraveyard ? playerState.graveyard : [])].filter(
    (c) => c.uid !== instance.uid && getCard(c.cardId).type === 'ijin' && getCard(c.cardId).level < card.level
  );
}

// クライアント表示用: pendingLegacyTriggersの先頭にあるエントリの詳細
// (カード名・遺業テキスト・対象選択が必要な場合の候補一覧)を返す。
function describePendingLegacyTrigger(game, pending) {
  const playerState = game.playerStates[pending.playerId];
  const instance = playerState.graveyard.find((c) => c.uid === pending.cardUid);
  if (!instance) return null;
  const card = getCard(instance.cardId);
  const info = { playerId: pending.playerId, cardUid: pending.cardUid, cardName: card.name, legacyText: card.legacyText, legacyType: card.legacy ? card.legacy.type : null };
  if (card.legacy && card.legacy.type === 'kodama') {
    info.choices = kodamaTargetPool(playerState, instance, card).map((c) => ({ uid: c.uid, name: getCard(c.cardId).name, level: getCard(c.cardId).level }));
  } else if (card.legacy && card.legacy.type === 'return_to_deck_top_or_bottom') {
    info.choices = [{ value: 'top', label: '山札の上' }, { value: 'bottom', label: '山札の下' }];
  }
  return info;
}

/**
 * 遺業能力(pendingLegacyTriggersの先頭)を、発動する/しないを含めて解決する。
 * ルール上「発動できる(任意)」ため、プレイヤーが都度選べるようにするための入り口。
 * action.skip が true なら発動せず破棄する。
 */
function resolveLegacyTrigger(game, playerId, action) {
  const queue = game.pendingLegacyTriggers;
  if (!queue || queue.length === 0) return { ok: false, error: '発動できる遺業能力がありません。' };
  const pending = queue[0];
  if (pending.playerId !== playerId || pending.cardUid !== action.cardUid) {
    return { ok: false, error: '今は別の遺業能力の処理を先に済ませる必要があります。' };
  }
  queue.shift();
  const playerState = game.playerStates[playerId];
  const instance = playerState.graveyard.find((c) => c.uid === pending.cardUid);
  if (!action.skip && instance) {
    const card = getCard(instance.cardId);
    applyLegacyEffect(game, playerState, instance, card, action);
    fireOnLegacyTriggeredObservers(game, playerState, game.playerStates[opponentId(game, playerId)], instance);
  }
  checkAndProcessForcedTurnEnd(game);
  return { ok: true };
}

// 足利義教: 自分の墓地の「遺業能力」が発動したとき、自分の戦場の該当カードで発動できる観測型能力。
function fireOnLegacyTriggeredObservers(game, playerState, opp, sourceInstance) {
  for (const instance of playerState.field.ijin) {
    if (instance.uid === sourceInstance.uid) continue;
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onOwnLegacyTriggered;
    if (!trig) continue;
    if (isAbilitySuppressed(instance, playerState, opp)) continue;
    if (trig.oncePerTurn && instance.usedOwnLegacyObserverThisTurn) continue;
    if (!checkTriggerCondition(playerState, opp, trig.condition, instance)) continue;
    const result = resolveGenericEffectMaybeArray(game, playerState, opp, trig.effect, null, instance);
    if (result.ok) {
      if (trig.oncePerTurn) instance.usedOwnLegacyObserverThisTurn = true;
      log(game, `${playerState.name}の「${card.name}」の能力(遺業能力の発動を見て)が発動しました。`);
    }
  }
}

function destroyFieldOrGuardian(game, playerState, instance, suppressLegacy, viaBattle) {
  if (instance.tempIndestructibleThisTurn) return;
  const found = findInstance(playerState, instance.uid);
  if (!found) return;
  if (found.zone !== 'ijin' && found.zone !== 'haikei' && found.zone !== 'guardian') return;
  if (!viaBattle && isIndestructibleByAbility(instance, playerState, found.zone, game)) return;
  const wasEquippedWith = found.zone === 'ijin' ? instance.equippedCard : null;
  if (found.zone === 'ijin') detachEquipmentIfAny(playerState, instance);
  moveToGraveyard(game, playerState, instance, found.list, suppressLegacy, found.zone);
  fireOnFieldCardDestroyedTriggers(game, instance, playerState, getCard(instance.cardId), found.zone, viaBattle);
  if (wasEquippedWith) {
    const eqGrant = getCard(wasEquippedWith.cardId).equipGrant;
    // トマス・ニューコメン: これが戦場にいる間、自分の戦場の装備しているイジンは
    // 「破壊されたとき、自分の魔力ゾーンのマリョク1つを手札に戻して発動できる。
    // これを破壊されていない状態にする」を得る(コストとして手札に戻すマリョクを
    // 自動選択する)。
    const newcomen = playerState.field.ijin.find((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.grantEquippedUndoOwnDestructionViaManaCost;
    });
    const newcomenManaIdx = newcomen ? playerState.mana.findIndex((m) => getCard(m.cardId).type === 'maryoku') : -1;
    if ((eqGrant && eqGrant.undoOwnDestruction || newcomenManaIdx !== -1) && canPlaceFromGraveyardToField(playerState)) {
      const idx = playerState.graveyard.indexOf(instance);
      if (idx !== -1) {
        if (!(eqGrant && eqGrant.undoOwnDestruction) && newcomenManaIdx !== -1) {
          const [paid] = playerState.mana.splice(newcomenManaIdx, 1);
          paid.faceUp = true;
          playerState.hand.push(paid);
        }
        playerState.graveyard.splice(idx, 1);
        instance.faceUp = true;
        instance.tapped = false;
        playerState.field.ijin.push(instance);
        log(game, `${playerState.name}の効果で「${getCard(instance.cardId).name}」の破壊が取り消されました。`);
      }
    }
  }
}

function fireOnFieldCardDestroyedTriggers(game, destroyedInstance, destroyedOwnerPs, destroyedCard, destroyedZone, viaBattle) {
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
      if (isAbilitySuppressed(instance, ownerPs, opp)) continue;
      if (trig.side === 'own' && !isOwnSide) continue;
      if (trig.side === 'opponent' && isOwnSide) continue;
      if (trig.zone && trig.zone !== destroyedZone) continue;
      if (trig.colorFilter && !destroyedCard.colors.includes(trig.colorFilter)) continue;
      // アダム・ラクスマン: 能力によって「航海」を持つイジンが自分の戦場を離れたとき
      // (バトルによる破壊は対象外)。
      if (trig.traitFilter && !hasEffectiveTrait(destroyedInstance, trig.traitFilter, destroyedOwnerPs)) continue;
      if (trig.koukaiOnly && !hasKoukaiAbility(destroyedCard)) continue;
      if (trig.viaAbilityOnly && viaBattle) continue;
      if (trig.excludeSelf && instance.uid === destroyedInstance.uid) continue;
      if (trig.onlySelf && instance.uid !== destroyedInstance.uid) continue;
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

function drawCards(game, playerState, n, opts) {
  // タマル王: 相手の手札のカードが3つ以上なら、戦場で効果を発揮する。相手は
  // 「カードを引けない」を得る。
  const oppOfDrawer = game.playerStates[opponentId(game, playerState.id)];
  if (n > 0 && playerState.hand.length >= 3 && oppOfDrawer && oppOfDrawer.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.forbidOpponentDrawIfOpponentHandAtLeast3;
  })) {
    return;
  }
  // 米百俵: 自分が能力によってカードを引く際、カードを引く代わりに同じ数だけ
  // マリョク配置権を増やしてもよい(簡略化として、この効果を持つ限り常に変換する)。
  if (n > 0 && !(opts && opts.isNormalTurnDraw) && playerState.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.convertAbilityDrawToManaRight;
  })) {
    playerState.manaRight += n;
    return;
  }
  // モダンアートの殿堂: 自分と相手は『ドロー』効果で山札からカードを引く際、1つだけ多く引く。
  const hasModernArt = n > 0 && game.players.some((id) => game.playerStates[id].field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.bonusDrawPerDrawEffect;
  }));
  const effectiveN = hasModernArt ? n + 1 : n;
  let drawn = 0;
  for (let i = 0; i < effectiveN; i++) {
    if (playerState.deck.length === 0) break;
    const card = playerState.deck.shift();
    card.drawnThisTurn = true;
    playerState.hand.push(card);
    drawn += 1;
  }

  // 徳川慶喜: 戦場の能力によって相手がドローしたとき、相手の手札のカード1つを墓地に置く。
  const isNormalTurnDraw = opts && opts.isNormalTurnDraw;
  if (!isNormalTurnDraw && drawn > 0 && !isHandDiscardFieldAbilitySuppressed(game)) {
    const opp = game.playerStates[opponentId(game, playerState.id)];
    if (opp && opp.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.discardOpponentHandOnAbilityDraw;
    }) && playerState.hand.length > 0) {
      // 捨てるカードはドローした本人(playerState)が選ぶ。
      const chosenArr = chooseFromPool(game, playerState, playerState.hand, null, {
        cardName: '徳川慶喜', poolZone: 'hand', label: '墓地に置く手札',
        eff: { type: 'discard_own_hand_multi_by_uids' }, min: 1, max: 1,
      });
      if (chosenArr !== null && chosenArr.length > 0) {
        const discarded = chosenArr[0];
        const idx = playerState.hand.indexOf(discarded);
        if (idx !== -1) playerState.hand.splice(idx, 1);
        discarded.faceUp = true;
        playerState.graveyard.push(discarded);
        log(game, `${playerState.name}は徳川慶喜の効果で手札1枚を墓地に置きました。`);
        fireOnDiscardedFromHandTrigger(game, playerState, opp, discarded);
      }
    }
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
  const oppPs = game.playerStates[opponentId(game, playerId)];
  ps.isCurrentTurnPlayer = true;
  oppPs.isCurrentTurnPlayer = false;

  // 手札の「今引いた」マークは、自分の新しいターンが始まったらリセットする。
  for (const inst of ps.hand) inst.drawnThisTurn = false;

  // 喀血の流行り病: メインフェイズが開始したとき、ターンプレイヤーの戦場にイジンがいないなら
  // これ自身を破壊する。そうでなければターンプレイヤーの戦場のイジン1体を破壊する。
  const plagueOwner = [ps, oppPs].find((side) => side.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.destroySelfOrIjinAtMainStart;
  }));
  if (plagueOwner) {
    const plague = plagueOwner.field.haikei.find((h) => {
      const kw = getCard(h.cardId).keywords;
      return kw && kw.destroySelfOrIjinAtMainStart;
    });
    if (ps.field.ijin.length === 0) {
      destroyFieldOrGuardian(game, plagueOwner, plague);
    } else {
      // そのイジンはターンプレイヤーが選ぶ。
      const chosenArr = chooseFromPool(game, ps, ps.field.ijin, null, {
        cardName: getCard(plague.cardId).name, poolZone: 'field_ijin', label: '破壊する自分のイジン(喀血の流行り病)',
        sourceInstance: plague, eff: { type: 'generic_destroy_ijin', scope: 'own' }, min: 1, max: 1,
      });
      if (chosenArr && chosenArr.length > 0) destroyFieldOrGuardian(game, ps, chosenArr[0]);
    }
  }

  ps.manaRight = 1 + manaRightBonus(ps, oppPs);
  ps.summonRight = 1;
  ps.attackedThisTurn = false;
  ps.extraBattleAvailable = false;
  ps.haikeiPlacedCountThisTurn = 0;
  ps.drewViaManaAbilityThisTurn = false;
  ps.attackerDestroyedThisTurn = false;
  ps.elizabethManaLeaveUsedThisTurn = false;
  ps.shippitsuSuppressedThisTurn = false;
  ps.preventDeckToGraveyardMillThisTurn = false;
  ps.meifuFromHandDiscardUsedThisTurn = false;
  ps.usedTokugawaTappedTriggerThisTurn = false;
  ps.usedShibusawaTriggerThisTurn = false;
  ps.koukaiTriggersOnPlaceThisTurn = false;
  ps.haikeiOrMahouUsedCountThisTurn = 0;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei, ...ps.guardians, ...ps.mana]) {
    // ピーコック(青魔導): このターンと次のターンの間起きない、を1回分の起こし処理
    // スキップとして扱う。
    if (inst.skipNextUntap) {
      inst.skipNextUntap = false;
      continue;
    }
    inst.tapped = false;
  }
  // 消耗: 「これが表向きの間、自分のスタートフェイズに裏にする」を持つ魔力ゾーンの
  // カードは、自分のスタートフェイズに自動で裏向きになる。
  for (const inst of ps.mana) {
    if (!inst.faceUp) continue;
    const kw = getCard(inst.cardId).keywords;
    if (kw && kw.flipSelfFacedownAtOwnStartPhase) {
      inst.faceUp = false;
      log(game, `${ps.name}の「${getCard(inst.cardId).name}」が消耗し、裏向きになりました。`);
    }
  }
  for (const inst of ps.field.ijin) inst.sick = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei]) inst.usedHaikeiTriggerThisTurn = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei]) inst.usedAllyIjinTriggerThisTurn = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei]) inst.usedAllyAttackerTriggerThisTurn = false;
  for (const inst of [...ps.field.ijin, ...ps.field.haikei]) inst.usedFieldDestroyedTriggerThisTurn = false;
  for (const inst of ps.field.ijin) inst.usedOwnLegacyObserverThisTurn = false;
  for (const inst of ps.graveyard) inst.usedMeifuThisTurn = false;
  log(game, `${ps.name}のスタートフェイズ。`);

  // アイザック・ニュートン: 自分のドローフェイズの間、自分は山札からカードを引くことが
  // できない。自分のドローフェイズが開始したとき、自分の手札が10枚以上なら発動する。
  // ゲームに勝利する。
  const hasNewton = ps.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.cannotDrawDuringOwnDrawPhase;
  });
  if (hasNewton && ps.hand.length >= 10) {
    endGame(game, playerId, 'アイザック・ニュートン');
    return;
  }

  // ルール上、先攻の最初のターンはドローなし。後攻の最初のターンは2枚ドロー
  // (turnNumberはP1の最初のターンを1として1ずつ増えるので、後攻の最初のターンは
  // 必ずturnNumber===2になる)。それ以降は通常通り毎ターン1枚ドロー。
  const skipDraw = game.isVeryFirstTurn && game.turnPlayerIndex === 0;
  const isSecondPlayerFirstTurn = game.turnNumber === 2 && game.turnPlayerIndex === 1;
  if (!skipDraw && hasNewton) {
    log(game, `${ps.name}はアイザック・ニュートンの効果によりドローできません。`);
  } else if (!skipDraw) {
    const drawCount = isSecondPlayerFirstTurn ? 2 : 1;
    drawCards(game, ps, drawCount, { isNormalTurnDraw: true });
    log(game, `${ps.name}が${drawCount}枚ドローしました。(手札${ps.hand.length}枚)`);
  }
  game.isVeryFirstTurn = false;
  game.phase = 'main';

  fireFieldStartTriggers(game, ps, game.playerStates[opponentId(game, playerId)], 'onMainStart', 'メインフェイズ開始時');

  // 阿弥陀堂など: 対象選択を伴うメインフェイズ開始時トリガーは自動発動できないため、
  // プレイヤーが任意のタイミングで発動/スキップを選べる「保留中」の状態として持ち越す。
  game.pendingMainStartTrigger = null;
  const pendingInstance = [...ps.field.ijin, ...ps.field.haikei, ...ps.mana.filter((m) => m.faceUp)].find((instance) => {
    const c = getCard(instance.cardId);
    const trig = c.triggers && c.triggers.onMainStart;
    return trig && trig.needsTarget;
  });
  if (pendingInstance) {
    game.pendingMainStartTrigger = { playerId, cardUid: pendingInstance.uid };
  }
}

function resolveMainStartTrigger(game, playerId, action) {
  const pending = game.pendingMainStartTrigger;
  if (!pending || pending.playerId !== playerId || pending.cardUid !== action.cardUid) {
    return { ok: false, error: '発動できる能力がありません。' };
  }
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[opponentId(game, playerId)];
  const found = findInstance(ps, pending.cardUid);
  game.pendingMainStartTrigger = null;
  if (action.skip || !found) return { ok: true };
  const card = getCard(found.instance.cardId);
  const trig = card.triggers && card.triggers.onMainStart;
  if (!trig) return { ok: true };
  const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, action.targetUid, found.instance);
  if (result.ok) {
    log(game, `${ps.name}の「${card.name}」の能力(メインフェイズ開始時)が発動しました。`);
  }
  checkAndProcessForcedTurnEnd(game);
  return { ok: true };
}

function endTurn(game, playerId, action) {
  const ps = game.playerStates[playerId];
  fireFieldStartTriggers(game, ps, game.playerStates[opponentId(game, playerId)], 'onEndStart', 'エンドフェイズ開始時', action && action.endTriggerTargets);
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
    inst.untapsWhenBlockedByGuardianThisTurn = false;
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
    // チャルカ: 魔力ゾーンのマリョクへの一時的な色付与も、ターンの終わりにリセットする。
    for (const m of game.playerStates[otherId].mana) {
      m.tempColorsThisTurn = null;
    }
  }
  ps.freeMahouThisTurn = false;
  ps.cannotCastMahouThisTurn = false;
  ps.cannotAttackThisTurn = false;
  ps.manaAbilitiesDisabledThisTurn = false;

  if (ps.deck.length === 0) {
    // 精霊の島々: 自分の山札が0枚になったとき(戦場か墓地で)発動できる。
    // 自分の手札すべてを山札に戻してシャッフルし、相手の手札すべてを墓地に置く。
    const hasSpiritIslands = [...ps.field.haikei, ...ps.graveyard].some((c) => {
      const kw = getCard(c.cardId).keywords;
      return kw && kw.rescueFromEmptyDeckLoss;
    });
    if (hasSpiritIslands) {
      while (ps.hand.length > 0) ps.deck.push(ps.hand.shift());
      ps.deck = shuffle(ps.deck);
      const oppPsForRescue = game.playerStates[opponentId(game, playerId)];
      while (oppPsForRescue.hand.length > 0) {
        const c = oppPsForRescue.hand.shift();
        c.faceUp = true;
        oppPsForRescue.graveyard.push(c);
        fireOnDiscardedFromHandTrigger(game, oppPsForRescue, ps, c);
      }
      log(game, `${ps.name}は精霊の島々の効果で山札切れを免れました。`);
    } else {
      endGame(game, opponentId(game, playerId), '山札切れ');
      return;
    }
  }

  game.turnPlayerIndex = 1 - game.turnPlayerIndex;
  game.turnNumber += 1;
  const nextId = activePlayerId(game);
  startTurnFor(game, nextId);
  checkAndProcessForcedTurnEnd(game);
}

// ---------- アクション ----------

// ルイス・キャロル: イジン召喚権とマリョク配置権を、互いの代わりに使ってもよい。
function hasSwapSummonManaRights(playerState) {
  return playerState.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.swapSummonAndManaRights;
  });
}

// 和宮: 相手は、自分と相手の墓地にあるカードと同じ名前のカードを、手札から使えない。
function isBlockedByGraveyardNameBan(ps, opp, card) {
  const hasWakanomiya = opp.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.restrictHandUseByGraveyardName;
  });
  if (!hasWakanomiya) return false;
  return ps.graveyard.some((c) => getCard(c.cardId).name === card.name) || opp.graveyard.some((c) => getCard(c.cardId).name === card.name);
}

function placeMana(game, playerId, action) {
  const ps = game.playerStates[playerId];
  const useSummonRightInstead = ps.manaRight <= 0 && ps.summonRight > 0 && hasSwapSummonManaRights(ps);
  if (ps.manaRight <= 0 && !useSummonRightInstead) return { ok: false, error: 'マリョク配置権がありません。' };
  const found = findInstance(ps, action.cardUid);
  if (!found) return { ok: false, error: 'カードが見つかりません。' };
  const card = getCard(found.instance.cardId);

  if (found.zone === 'graveyard') {
    // 地上の紫微垣: 表向きで置く限り、自分の墓地のマリョクも選べる。
    const allowsGraveyardMana = ps.field.haikei.some((h) => {
      const hCard = getCard(h.cardId);
      return hCard.keywords && hCard.keywords.allowFaceupManaFromGraveyard;
    });
    if (action.mode !== 'faceup' || card.type !== 'maryoku' || !allowsGraveyardMana) {
      return { ok: false, error: 'カードが手札にありません。' };
    }
  } else if (found.zone !== 'hand') {
    return { ok: false, error: 'カードが手札にありません。' };
  }

  if (action.mode === 'faceup') {
    if (card.type !== 'maryoku') return { ok: false, error: 'マリョク以外は表向きに置けません。' };
    // エカチェリーナ2世: マリョクが自分の魔力ゾーンに3つ以上ある間、相手(エカチェリーナ2世の
    // 持ち主から見た相手)は表向きでマリョク配置できない。
    if (ps.mana.length >= 3) {
      const oppOfPs = game.playerStates[opponentId(game, playerId)];
      if (oppOfPs.field.ijin.some((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && kw.forbidOpponentFaceupManaIfOwnManaAtLeast3;
      })) {
        return { ok: false, error: 'エカチェリーナ2世の効果により、表向きでマリョクを配置できません。' };
      }
    }
  }
  found.list.splice(found.idx, 1);
  found.instance.faceUp = action.mode === 'faceup';
  found.instance.tapped = false;
  ps.mana.push(found.instance);
  if (useSummonRightInstead) ps.summonRight -= 1;
  else ps.manaRight -= 1;

  const opp = game.playerStates[opponentId(game, playerId)];
  if (!ps.manaAbilitiesDisabledThisTurn && action.mode === 'faceup' && card.onPlace && card.onPlace.type === 'draw') {
    drawCards(game, ps, card.onPlace.value);
    ps.drewViaManaAbilityThisTurn = true;
    log(game, `${ps.name}の「${card.name}」の効果で${card.onPlace.value}枚ドローしました。`);
  }
  log(game, `${ps.name}がマリョクを${action.mode === 'faceup' ? '表向き' : '裏向き'}で配置しました。`);
  if (!ps.manaAbilitiesDisabledThisTurn && action.mode === 'faceup' && card.onPlace && card.onPlace.type === 'draw_then_discard_n_own_hand') {
    // ヒエロスガモス等: まずドローだけ即座に行い、どのカードを捨てるかはプレイヤーに
    // 選ばせる(pendingManaOnPlaceDiscardとして保留し、resolveManaOnPlaceDiscardで確定する)。
    const eff = card.onPlace;
    drawCards(game, ps, eff.drawValue || 0);
    log(game, `${ps.name}の「${card.name}」の効果で${eff.drawValue || 0}枚ドローしました。`);
    const requiredCount = Math.min(eff.discardCount || 0, ps.hand.length);
    if (requiredCount > 0) {
      game.pendingManaOnPlaceDiscard = { playerId, cardUid: found.instance.uid, cardName: card.name, count: requiredCount };
    }
  } else if (!ps.manaAbilitiesDisabledThisTurn && action.mode === 'faceup' && card.onPlace && card.onPlace.type !== 'draw') {
    applyManaOnPlaceEffect(game, ps, opp, card, found.instance, undefined, action);
  }
  fireOnManaPlacedTriggers(game, ps, opp, found.instance);
  return { ok: true };
}

// ヒエロスガモス等(draw_then_discard_n_own_hand)のドロー後、実際にどのカードを
// 墓地に置くかをプレイヤーが選んで確定する。
function resolveManaOnPlaceDiscard(game, playerId, action) {
  const pending = game.pendingManaOnPlaceDiscard;
  if (!pending || pending.playerId !== playerId) return { ok: false, error: '選択できるものがありません。' };
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[opponentId(game, playerId)];
  const requested = Array.isArray(action.targetUids) ? action.targetUids : [];
  const uids = [...new Set(requested)].filter((uid) => ps.hand.some((c) => c.uid === uid));
  if (uids.length !== pending.count) {
    return { ok: false, error: `手札から${pending.count}枚選んでください。` };
  }
  game.pendingManaOnPlaceDiscard = null;
  for (const uid of uids) {
    const idx = ps.hand.findIndex((c) => c.uid === uid);
    if (idx === -1) continue;
    const [discarded] = ps.hand.splice(idx, 1);
    discarded.faceUp = true;
    ps.graveyard.push(discarded);
    fireOnDiscardedFromHandTrigger(game, ps, opp, discarded);
  }
  log(game, `${ps.name}が「${pending.cardName}」の効果で手札${uids.length}枚を墓地に置きました。`);
  checkAndProcessForcedTurnEnd(game);
  return { ok: true };
}

// カルドロン等(hand_card_to_graveyard_or_facedown_mana_choice)で、指定した手札を
// 「墓地に置く」か「裏向きで魔力ゾーンに置く」かをプレイヤーが選んで確定する。
function resolveManaCardDestinationChoice(game, playerId, action) {
  const pending = game.pendingManaCardDestinationChoice;
  if (!pending || pending.playerId !== playerId) return { ok: false, error: '選択できるものがありません。' };
  if (action.destination !== 'graveyard' && action.destination !== 'facedown_mana') {
    return { ok: false, error: '発揮する効果を選んでください。' };
  }
  game.pendingManaCardDestinationChoice = null;
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[opponentId(game, playerId)];
  const idx = ps.hand.findIndex((c) => c.uid === pending.targetUid);
  if (idx === -1) return { ok: true };
  const [c] = ps.hand.splice(idx, 1);
  if (action.destination === 'graveyard') {
    c.faceUp = true;
    ps.graveyard.push(c);
    fireOnDiscardedFromHandTrigger(game, ps, opp, c);
    log(game, `${ps.name}が「${pending.cardName}」の効果で「${pending.targetCardName}」を墓地に置きました。`);
  } else {
    c.faceUp = false;
    c.tapped = false;
    ps.mana.push(c);
    log(game, `${ps.name}が「${pending.cardName}」の効果で「${pending.targetCardName}」を裏向きで魔力ゾーンに置きました。`);
  }
  checkAndProcessForcedTurnEnd(game);
  return { ok: true };
}

// マリョクゾーンに表向きで置かれたときの固有効果(onPlace)を適用する。対象選択を伴う
// ものは、対象選択UIを新設する代わりに、既存の *_auto 系トリガーと同様の方針で
// 妥当な対象を自動選択して発動する(本アプリの既存の簡略化方針に合わせる)。
function applyManaOnPlaceEffect(game, ps, opp, card, instance, providedTarget, action) {
  let eff = card.onPlace;
  if (!eff) return { ok: true };
  // ピクシーダスト: 自分の魔力ゾーンのカードが相手より多いなら発動しない。
  if (eff.blockedIfOwnManaCountGreater && ps.mana.length > opp.mana.length) return { ok: true };
  // トランスポーター等: 複数の効果から1つを選んで発動する(選択は配置時に確定済み)。
  if (eff.effectChoices) {
    eff = eff.effectChoices[action && action.triggerChoiceIndex === 1 ? 1 : 0];
  }
  switch (eff.type) {
    case 'draw': {
      drawCards(game, ps, eff.value || 0);
      log(game, `${ps.name}の「${card.name}」の効果で${eff.value || 0}枚ドローしました。`);
      return { ok: true };
    }
    case 'place_hand_ijin_levelmax_free_by_uid': {
      const targetUid = (action && action.triggerTargetUid) || providedTarget;
      if (!targetUid) return { ok: true };
      const idx = ps.hand.findIndex((c) => c.uid === targetUid);
      if (idx === -1) return { ok: false, error: '対象の手札のイジンが見つかりません。' };
      const targetCard = getCard(ps.hand[idx].cardId);
      if (targetCard.type !== 'ijin' || targetCard.level > (eff.levelMax || Infinity)) {
        return { ok: false, error: 'レベル条件を満たしていません。' };
      }
      const [inst] = ps.hand.splice(idx, 1);
      inst.faceUp = true;
      inst.sick = true;
      ps.field.ijin.push(inst);
      log(game, `${ps.name}の「${card.name}」の効果で「${targetCard.name}」が戦場に置かれました。`);
      return { ok: true };
    }
    case 'deck_top_to_facedown_mana':
    case 'deck_top_n_to_facedown_mana': {
      const result = resolveGenericEffect(game, ps, opp, eff, null, instance);
      if (result.ok) log(game, `${ps.name}の「${card.name}」の効果が発動しました。`);
      return result;
    }
    case 'conditional_own_guardian_to_deck_top_if_no_other_mana_color': {
      const hasOtherColorMana = ps.mana.some((m) => m !== instance && m.faceUp && getCard(m.cardId).colors.some((c) => eff.colors.includes(c)));
      if (hasOtherColorMana || ps.guardians.length === 0) return { ok: true };
      resolveGenericEffect(game, ps, opp, { type: 'own_guardian_to_deck_top' }, null, instance);
      log(game, `${ps.name}の「${card.name}」の効果でガーディアン1体が山札の上に戻りました。`);
      return { ok: true };
    }
    case 'choose_color_self_this_turn': {
      const counts = {};
      for (const c of ps.hand) for (const col of getCard(c.cardId).colors || []) counts[col] = (counts[col] || 0) + 1;
      const chosen = eff.colors.slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0];
      instance.tempColorsThisTurn = [chosen];
      log(game, `${ps.name}の「${card.name}」がこのターンの間「色：${chosen}」を得ました。`);
      return { ok: true };
    }
    case 'hand_card_to_graveyard_or_facedown_mana_choice': {
      const chosen = chooseFromPool(game, ps, ps.hand, providedTarget, {
        cardName: card.name, poolZone: 'hand', label: '墓地に置くか裏向きの魔力ゾーンに置く手札(任意)',
        sourceInstance: instance, eff, min: 0, max: 1, resumeFn: 'applyManaOnPlaceEffect',
      });
      if (chosen === null) return { ok: true, pending: true };
      if (chosen.length === 0) return { ok: true };
      const [c] = chosen;
      game.pendingManaCardDestinationChoice = {
        playerId: ps.id,
        cardUid: instance.uid,
        cardName: card.name,
        targetUid: c.uid,
        targetCardName: getCard(c.cardId).name,
      };
      return { ok: true, pending: true };
    }
    case 'deck_bottom_target_field_ijin_then_cannot_battle': {
      const pool = opp.field.ijin.filter((i) => (eff.levelMax == null || getCard(i.cardId).level <= eff.levelMax) && (eff.powerMax == null || effectivePower(i, opp) <= eff.powerMax));
      const target = pool.sort((a, b) => effectivePower(b, opp) - effectivePower(a, opp))[0];
      if (!target) return { ok: true };
      detachEquipmentIfAny(opp, target);
      opp.field.ijin.splice(opp.field.ijin.indexOf(target), 1);
      target.faceUp = true;
      opp.deck.push(target);
      ps.cannotAttackThisTurn = true;
      log(game, `${ps.name}の「${card.name}」の効果で相手のイジン1体が山札の下に戻り、このターンはバトルできなくなりました。`);
      return { ok: true };
    }
    case 'reveal_own_circle_facedown_mana': {
      const pool = ps.mana.filter((m) => m !== instance && !m.faceUp && (getCard(m.cardId).name || '').includes('サークル'));
      for (const m of pool) m.faceUp = true;
      if (pool.length > 0) log(game, `${ps.name}の「${card.name}」の効果でサークルマリョク${pool.length}枚が表になりました。`);
      return { ok: true };
    }
    case 'move_hand_or_graveyard_maryoku_to_own_mana': {
      const handPool = ps.hand.filter((c) => getCard(c.cardId).type === 'maryoku');
      const gyPool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'maryoku');
      const pool = handPool.length > 0 ? handPool : gyPool;
      const chosenArr = chooseFromPool(game, ps, pool, providedTarget, {
        cardName: card.name, poolZone: handPool.length > 0 ? 'hand' : 'graveyard', label: '魔力ゾーンに表向きで置くマリョク',
        sourceInstance: instance, eff, min: 0, max: 1, resumeFn: 'applyManaOnPlaceEffect',
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const chosen = chosenArr[0];
      const found = findInstance(ps, chosen.uid);
      if (!found) return { ok: true };
      found.list.splice(found.idx, 1);
      chosen.faceUp = true;
      chosen.tapped = false;
      ps.mana.push(chosen);
      log(game, `${ps.name}の「${card.name}」の効果でマリョク1つが魔力ゾーンに置かれました。`);
      return { ok: true };
    }
    case 'mill_self': {
      if (ps.deck.length === 0) return { ok: true };
      const c = ps.deck.shift();
      c.faceUp = true;
      ps.graveyard.push(c);
      checkMilledCardForForcedTurnEnd(game, ps, getCard(c.cardId), c);
      log(game, `${ps.name}の「${card.name}」の効果で山札の上から1枚が墓地に置かれました。`);
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

function summonIjin(game, playerId, action) {
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[opponentId(game, playerId)];
  const found = findInstance(ps, action.cardUid);
  if (!found || found.zone !== 'hand') return { ok: false, error: 'カードが手札にありません。' };
  const card = getCard(found.instance.cardId);
  if (card.type !== 'ijin') return { ok: false, error: 'イジンではありません。' };
  if (isBlockedByGraveyardNameBan(ps, opp, card)) return { ok: false, error: '和宮の効果により、このカードは使用できません。' };

  // ピエール＝シモン・ラプラス: 自分のイジン召喚において「躍進」を持つイジンを選ぶ限り、
  // イジン召喚権は減らず、イジン召喚権がなくてもイジン召喚できる。
  const isYakushin = (card.text || '').startsWith('躍進');
  const hasFreeYakushinSummon = isYakushin && ps.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.freeSummonYakushinIjin;
  });
  // 玄奘: 躍進 - このターンに魔力ゾーンの能力によって山札からカードを引いていて、
  // 自分の戦場のイジンが4体以下なら、イジン召喚権が0でもイジン召喚できる
  // (召喚するカード自体が躍進を持つ必要はない)。
  const hasXuanzangFreeSummon = ps.drewViaManaAbilityThisTurn && ps.field.ijin.length <= 4 && ps.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.freeSummonIfYakushinAndFieldAtMostFour;
  });

  const useManaRightInstead = !hasFreeYakushinSummon && !hasXuanzangFreeSummon && ps.summonRight <= 0 && ps.manaRight > 0 && hasSwapSummonManaRights(ps);
  if (!hasFreeYakushinSummon && !hasXuanzangFreeSummon && ps.summonRight <= 0 && !useManaRightInstead) return { ok: false, error: 'イジン召喚権がありません。' };

  // 水野忠邦: これのイジン召喚に際し、これのレベルは、相手の魔力ゾーンのマリョク1つにつき1だけ下がる。
  // 遣外使節団: 自分がイジン召喚する際、そのイジンのレベルは、相手の戦場の色1つにつき1だけ下がる。
  let effectiveLevel = card.level;
  if (card.keywords && card.keywords.levelReducedByOpponentManaAtSummon) {
    effectiveLevel -= opp.mana.length;
  }
  // 姜維: これのイジン召喚に際し、これのレベルは自分の墓地の「反魂」を持つカードの
  // 最も高いレベルと同じだけ下がる。
  if (card.keywords && card.keywords.levelReducedByOwnGraveyardHankonMaxLevel) {
    const hankonLevels = ps.graveyard.filter((c) => getCard(c.cardId).legacyText === '反魂').map((c) => getCard(c.cardId).level);
    if (hankonLevels.length > 0) effectiveLevel -= Math.max(...hankonLevels);
  }
  // アルキメデス: これのイジン召喚に際し、これのレベルは、自分の墓地の「魔導」能力を
  // 持つマホウ1つにつき1だけ下がる。
  if (card.keywords && card.keywords.levelReducedByOwnGraveyardMagicTextMahouCount) {
    effectiveLevel -= ps.graveyard.filter((c) => {
      const gc = getCard(c.cardId);
      return gc.type === 'mahou' && gc.text && gc.text.includes('魔導');
    }).length;
  }
  if (ps.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.reduceSummonLevelByOpponentColorCount;
  })) {
    const oppColors = new Set();
    for (const i of [...opp.field.ijin, ...opp.field.haikei]) getCard(i.cardId).colors.forEach((c) => oppColors.add(c));
    effectiveLevel -= oppColors.size;
  }
  // 各色サークル: これが魔力ゾーンに表向きである間、自分のイジン召喚のレベルは3だけ下がる。
  for (const m of ps.mana) {
    if (!m.faceUp) continue;
    const mKw = getCard(m.cardId).keywords;
    if (mKw && mKw.levelReducedBySelfIfFaceUpMana) effectiveLevel -= mKw.levelReducedBySelfIfFaceUpMana;
  }
  // 劉備: 自分のイジン召喚に際し、自分の戦場のイジンを3体まで寝かせてもよい。
  // 寝かせた1体につき、手札のイジンは「レベル-1」される(簡略化として、レベル条件を
  // 満たすために必要な最小限の体数だけ、自動的に未タップの他のイジンを寝かせる)。
  const liuBei = ps.field.ijin.find((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.tapUpToThreeOwnIjinForSummonLevelDiscount;
  });
  const liuBeiTapped = [];
  if (liuBei) {
    const untappedOthers = ps.field.ijin.filter((i) => !i.tapped);
    for (const i of untappedOthers) {
      if (liuBeiTapped.length >= 3) break;
      if (canUseCardForSummon(ps, Object.assign({}, card, { level: Math.max(0, effectiveLevel - liuBeiTapped.length) }))) break;
      liuBeiTapped.push(i);
    }
    for (const i of liuBeiTapped) i.tapped = true;
  }
  effectiveLevel -= liuBeiTapped.length;
  // 蘇る青の都: 自分のイジン召喚において、自分の手札の「プレッシャー」能力を持つイジンの
  // レベルは、自分と相手の戦場のイジン1体につき1だけ下がる。
  if (card.keywords && card.keywords.pressure != null && ps.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.reduceSummonLevelForPressureIjinByFieldCount;
  })) {
    effectiveLevel -= (ps.field.ijin.length + opp.field.ijin.length);
  }
  let summonLevelCheckCard = effectiveLevel === card.level ? card : Object.assign({}, card, { level: Math.max(0, effectiveLevel) });
  // 空海: これが戦場か墓地にいる間、自分の手札のレベル6以下のイジンは、色すべてを失う。
  if ([...ps.field.ijin, ...ps.graveyard].some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.loseAllColorsInHandIfLevelAtMost != null && card.level <= kw.loseAllColorsInHandIfLevelAtMost;
  })) {
    summonLevelCheckCard = Object.assign({}, summonLevelCheckCard, { colors: [] });
  }
  if (!canUseCardForSummon(ps, summonLevelCheckCard)) return { ok: false, error: '色条件またはレベル条件を満たしていません。' };

  ps.hand.splice(found.idx, 1);
  found.instance.tapped = false;
  found.instance.sick = true;
  ps.field.ijin.push(found.instance);
  if (hasFreeYakushinSummon || hasXuanzangFreeSummon) {
    // 召喚権を消費しない
  } else if (useManaRightInstead) {
    ps.manaRight -= 1;
  } else {
    ps.summonRight -= 1;
  }
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

  // エンリケ航海王子: このターンの間、自分の戦場の「航海」は戦場に置かれたときでも発動する。
  if (ps.koukaiTriggersOnPlaceThisTurn && hasKoukaiAbility(card)) {
    fireOnAttackerTrigger(game, ps, opp, found.instance, card, null);
  }

  // 各色サークル: イジンが自分の戦場に置かれたとき、これ自身を裏にする。
  for (const m of ps.mana) {
    if (!m.faceUp) continue;
    const mKw = getCard(m.cardId).keywords;
    if (mKw && mKw.flipSelfOnAllyIjinPlaced) m.faceUp = false;
  }

  // 玄宗: イジンが相手の戦場に置かれるたび、自分の山札の上から1枚をガーディアンにして戦場に置く。
  for (const i of opp.field.ijin) {
    const kw = getCard(i.cardId).keywords;
    if (kw && kw.deckTopToGuardianOnOpponentIjinPlaced && opp.deck.length > 0) {
      const g = opp.deck.shift();
      g.faceUp = false;
      g.tapped = newGuardiansEnterTapped(opp);
      opp.guardians.push(g);
      log(game, `${opp.name}の「${getCard(i.cardId).name}」の能力で山札の上から1枚がガーディアンになりました。`);
    }
  }
  checkAndProcessForcedTurnEnd(game);
  return { ok: true };
}

function playHaikei(game, playerId, action) {
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[opponentId(game, playerId)];
  const found = findInstance(ps, action.cardUid);
  if (!found || found.zone !== 'hand') return { ok: false, error: 'カードが手札にありません。' };
  const card = getCard(found.instance.cardId);
  if (card.type !== 'haikei') return { ok: false, error: 'ハイケイではありません。' };
  if (isBlockedByGraveyardNameBan(ps, opp, card)) return { ok: false, error: '和宮の効果により、このカードは使用できません。' };
  if (!canUseCard(ps, card)) return { ok: false, error: '色条件またはレベル条件を満たしていません。' };
  // ソクラテス: 相手はマホウ使用とハイケイ使用を、合わせてターンに1回しかできない。
  if (isSocratesLimitReached(ps, opp)) return { ok: false, error: 'ソクラテスの効果により、このターンはハイケイを使用できません。' };

  ps.hand.splice(found.idx, 1);
  // 新井白石: ハイケイが相手の戦場に置かれる際、そのハイケイは寝ている状態で戦場に置かれる。
  const forceTappedByAraiHakuseki = opp.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.forceOpponentHaikeiTappedOnPlace;
  });
  found.instance.tapped = forceTappedByAraiHakuseki;
  ps.field.haikei.push(found.instance);
  ps.haikeiPlacedCountThisTurn = (ps.haikeiPlacedCountThisTurn || 0) + 1;
  ps.haikeiOrMahouUsedCountThisTurn = (ps.haikeiOrMahouUsedCountThisTurn || 0) + 1;
  log(game, `${ps.name}が「${card.name}」を設置しました。`);
  fireOnPlaceTrigger(game, ps, game.playerStates[opponentId(game, playerId)], found.instance, card, action);
  fireOnHaikeiPlacedTriggers(game, found.instance, ps, card);

  // 清少納言・小野小町など: 対象選択を伴う執筆(ハイケイが戦場に置かれたときのトリガー)は
  // 自動発動できないため、プレイヤーが任意のタイミングで発動/スキップを選べる
  // 「保留中」の状態として持ち越す(pendingMainStartTriggerと同様の仕組み)。
  game.pendingHaikeiPlacedTrigger = null;
  const pendingHaikeiHolder = [...ps.field.ijin, ...ps.field.haikei].find((instance) => {
    const c = getCard(instance.cardId);
    const trig = c.triggers && c.triggers.onHaikeiPlaced;
    return trig && trig.needsTarget && !isAbilitySuppressed(instance, ps, opp) && !isShippitsuSuppressed(ps, opp, c);
  });
  if (pendingHaikeiHolder) {
    game.pendingHaikeiPlacedTrigger = { playerId, cardUid: pendingHaikeiHolder.uid };
  }
  checkAndProcessForcedTurnEnd(game);
  return { ok: true };
}

function resolveHaikeiPlacedTrigger(game, playerId, action) {
  const pending = game.pendingHaikeiPlacedTrigger;
  if (!pending || pending.playerId !== playerId || pending.cardUid !== action.cardUid) {
    return { ok: false, error: '発動できる能力がありません。' };
  }
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[opponentId(game, playerId)];
  const found = findInstance(ps, pending.cardUid);
  game.pendingHaikeiPlacedTrigger = null;
  if (action.skip || !found) return { ok: true };
  const card = getCard(found.instance.cardId);
  const trig = card.triggers && card.triggers.onHaikeiPlaced;
  if (!trig) return { ok: true };
  const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, action.targetUid, found.instance);
  if (result.ok) {
    log(game, `${ps.name}の「${card.name}」の能力(執筆)が発動しました。`);
  }
  checkAndProcessForcedTurnEnd(game);
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
  // 熒惑のピラー等: これが自分の魔力ゾーンに表向きである間、自分はマホウを使用できない。
  if (ps.mana.some((m) => m.faceUp && (getCard(m.cardId).keywords || {}).selfCannotCastMahouWhileFaceUp)) {
    return { ok: false, error: 'このカードの能力により、マホウを使用できません。' };
  }
  // ソクラテス: 相手はマホウ使用とハイケイ使用を、合わせてターンに1回しかできない。
  if (isSocratesLimitReached(ps, opp)) return { ok: false, error: 'ソクラテスの効果により、このターンはマホウを使用できません。' };
  if (isBlockedByGraveyardNameBan(ps, opp, card)) return { ok: false, error: '和宮の効果により、このカードは使用できません。' };
  // 聖人の蹄鉄: これが自分の魔力ゾーンに表向きである間、自分の手札のマホウはレベルが2だけ増える。
  const mahouLevelPenalty = ps.mana.filter((m) => m.faceUp).reduce((sum, m) => {
    const kw = getCard(m.cardId).keywords;
    return sum + ((kw && kw.grantHandMahouLevelPenaltyWhileFaceUp) || 0);
  }, 0);
  const mahouLevelCheckCard = mahouLevelPenalty === 0 ? card : Object.assign({}, card, { level: card.level + mahouLevelPenalty });
  if (!canUseCard(ps, mahouLevelCheckCard)) return { ok: false, error: '色条件またはレベル条件を満たしていません。' };

  // 二重螺旋階段: 自分と相手の墓地にマホウが合わせて2つ以上あるなら、自分と相手の
  // 手札のマホウは魔力コストが1だけ増える。
  const combinedGraveyardMahouCount = [ps, opp].reduce((sum, side) => sum + side.graveyard.filter((c) => getCard(c.cardId).type === 'mahou').length, 0);
  const hasDoubleHelix = [ps, opp].some((side) => side.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.raiseHandMahouCostIfCombinedGraveyardMahouAtLeast != null && combinedGraveyardMahouCount >= kw.raiseHandMahouCostIfCombinedGraveyardMahouAtLeast;
  }));
  let costPenalty = hasDoubleHelix ? 1 : 0;
  // プラトン: 自分と相手は、自分のマホウ使用に際し、自分の手札のマホウの魔力コストは、
  // 自分の墓地の色1つにつき2つだけ増える(プラトンの持ち主・相手のどちらの場にあっても
  // 両者に及ぶ)。
  if ([ps, opp].some((side) => side.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.raiseHandMahouCostByOwnGraveyardColorCount;
  }))) {
    const gyColors = new Set();
    for (const c of ps.graveyard) getCard(c.cardId).colors.forEach((col) => gyColors.add(col));
    costPenalty += gyColors.size * 2;
  }
  // 千利休: 自分はマホウ使用に際し、自分の手札をすきなだけ墓地に置いてもよい。
  // 墓地に置いた1枚につき、手札のマホウの魔力コストは1減る。
  const hasSenNoRikyu = ps.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.reduceHandMahouCostByOwnHandDiscard;
  });
  const costDiscardUids = hasSenNoRikyu ? [...new Set(action.costDiscardHandUids || [])].filter((uid) => uid !== action.cardUid && ps.hand.some((h) => h.uid === uid)) : [];
  const effectiveCost = ps.freeMahouThisTurn ? 0 : Math.max(0, card.magicCost + costPenalty - costDiscardUids.length);
  const payUids = action.payManaUids || [];
  if (payUids.length !== effectiveCost) return { ok: false, error: `魔力コスト${effectiveCost}枚を選んでください。` };
  const payInstances = [];
  for (const uid of payUids) {
    const m = ps.mana.find((x) => x.uid === uid);
    if (!m) return { ok: false, error: '魔力ゾーンのカードが見つかりません。' };
    payInstances.push(m);
  }
  // マルティン・ルター: 相手はマホウ使用に際し、魔力ゾーンの裏のカードを墓地に置くことができない。
  if (opp.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.forbidOpponentFacedownManaAsMahouCost;
  }) && payInstances.some((m) => !m.faceUp)) {
    return { ok: false, error: 'マルティン・ルターの効果により、裏向きのマリョクをマホウのコストにできません。' };
  }

  const result = resolveMahouEffect(game, ps, opp, card, action);
  if (!result.ok) return result;
  ps.haikeiOrMahouUsedCountThisTurn = (ps.haikeiOrMahouUsedCountThisTurn || 0) + 1;

  for (const m of payInstances) {
    const idx = ps.mana.indexOf(m);
    ps.mana.splice(idx, 1);
    m.faceUp = true;
    ps.graveyard.push(m);
  }
  for (const uid of costDiscardUids) {
    const idx = ps.hand.findIndex((h) => h.uid === uid);
    if (idx === -1) continue;
    const [c] = ps.hand.splice(idx, 1);
    c.faceUp = true;
    ps.graveyard.push(c);
    fireOnDiscardedFromHandTrigger(game, ps, opp, c);
  }

  const handIdx = ps.hand.indexOf(found.instance);
  if (handIdx !== -1) ps.hand.splice(handIdx, 1);
  if (card.keywords && card.keywords.meisoOnCast) found.instance.hasMeiso = true;
  const selfToFacedownManaThenEndTurn = card.keywords && card.keywords.selfToFacedownManaThenEndTurn;
  // ソリッドビジョンΩ等: 緑魔導のように、ターンを終了せず自分自身を裏向きで魔力ゾーンに
  // 置くだけの場合はresolveMahouEffectの戻り値で伝える。
  const selfToFacedownMana = selfToFacedownManaThenEndTurn || result.selfToFacedownMana;
  if (selfToFacedownMana) {
    found.instance.faceUp = false;
    found.instance.tapped = false;
    ps.mana.push(found.instance);
  } else {
    ps.graveyard.push(found.instance);
  }
  log(game, `${ps.name}が「${card.name}」を発動しました。`);
  if (selfToFacedownManaThenEndTurn) {
    // タイムディレイション: バトルを中断し、ターンプレイヤーは残りのフェイズを行わずにターンを終了する。
    game.pendingBattle = null;
    endTurn(game, playerId);
  }
  checkAndProcessForcedTurnEnd(game);
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
  if (isAbilitySuppressed(found, ps, opp) || isGraveyardCardAbilitySuppressedByMozart(found, ps, opp)) return { ok: false, error: '相手の効果により、このカードは能力を失っています。' };
  if (found.discardedFromHand && !canActivateMeifuHatsudou(ps)) {
    return { ok: false, error: '手札から墓地に置かれたカードの冥府発動は、払暁の城壁の効果なしには発動できません。' };
  }

  const result = resolveMahouEffect(game, ps, opp, card, action);
  if (!result.ok) return result;
  if (found.discardedFromHand) ps.meifuFromHandDiscardUsedThisTurn = true;

  const selfToFacedownMana = card.keywords && card.keywords.selfToFacedownManaThenEndTurn;
  if (selfToFacedownMana) {
    ps.graveyard.splice(ps.graveyard.indexOf(found), 1);
    found.faceUp = false;
    found.tapped = false;
    ps.mana.push(found);
  } else {
    found.usedMeifuThisTurn = true;
  }
  log(game, `${ps.name}が冥府発動で「${card.name}」を発動しました。`);
  if (selfToFacedownMana) {
    // タイムディレイション: バトルを中断し、ターンプレイヤーは残りのフェイズを行わずにターンを終了する。
    game.pendingBattle = null;
    endTurn(game, playerId);
  }
  checkAndProcessForcedTurnEnd(game);
  return { ok: true };
}

/**
 * 反魂: 自分の戦場のガーディアン1体を山札の下に戻すことを代償に、
 * 墓地のイジンをイジン召喚権を使わずに戦場に置く。
 */
function reviveHankon(game, playerId, action) {
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[opponentId(game, playerId)];
  const found = ps.graveyard.find((c) => c.uid === action.cardUid);
  if (!found) return { ok: false, error: 'カードが墓地にありません。' };
  const card = getCard(found.cardId);
  if (card.type !== 'ijin') return { ok: false, error: 'イジンではありません。' };
  if (card.legacyText !== '反魂') return { ok: false, error: 'このイジンは反魂を持っていません。' };
  if (isAbilitySuppressed(found, ps, opp) || isGraveyardCardAbilitySuppressedByMozart(found, ps, opp)) return { ok: false, error: '相手の効果により、このカードは能力を失っています。' };
  if (!canPlaceFromGraveyardToField(ps)) return { ok: false, error: '相手の効果により、墓地のカードを戦場に置けません。' };

  if (action.altCostHaikeiUid) {
    const altHaikei = ps.field.haikei.find((h) => h.uid === action.altCostHaikeiUid);
    const altHaikeiCard = altHaikei && getCard(altHaikei.cardId);
    if (!altHaikeiCard || !(altHaikeiCard.keywords && altHaikeiCard.keywords.hankonAltCostSelf)) return { ok: false, error: '指定されたハイケイは代償にできません。' };
    ps.field.haikei.splice(ps.field.haikei.indexOf(altHaikei), 1);
    altHaikei.faceUp = true;
    ps.deck.push(altHaikei);
  } else {
    const guardian = ps.guardians.find((g) => g.uid === action.guardianUid);
    if (!guardian) return { ok: false, error: '山札の下に戻す自分のガーディアンを指定してください。' };
    ps.guardians.splice(ps.guardians.indexOf(guardian), 1);
    guardian.faceUp = true;
    ps.deck.push(guardian);
  }

  ps.graveyard.splice(ps.graveyard.indexOf(found), 1);
  found.faceUp = true;
  found.tapped = false;
  found.sick = true;
  ps.field.ijin.push(found);
  log(game, `${ps.name}が反魂で「${card.name}」を戦場に置きました。`);
  fireOnPlaceTrigger(game, ps, game.playerStates[opponentId(game, playerId)], found, card, Object.assign({}, action, { viaHankon: true }));
  fireOnAllyIjinPlacedTriggers(game, found, ps, card);
  checkAndProcessForcedTurnEnd(game);
  return { ok: true };
}

function resolveScopedIjinTarget(ps, opp, scope, uid, levelMax, powerMax, sourcePower, traitFilter) {
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
  if (traitFilter && !hasEffectiveTrait(found.inst, traitFilter, found.owner)) return null;
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

// ---------- 汎用の「対象選択が必要な自動選択」置き換え機構 ----------
//
// 「自動選択」で妥当な対象を選んで発動していた効果のうち、対象が自分自身のカード
// (手札・墓地・ガーディアン・魔力ゾーン等)である場合に、プレイヤーが実際にどれを
// 選ぶか決められるようにするための共通の仕組み。
//
// 使い方: 各case内で、targetUid(s)が未指定(=初回呼び出し)の場合に
// chooseFromPool(...)を呼ぶ。戻り値がnullなら「保留状態を作った」ことを示すので、
// その場でreturnする。戻り値が配列(1件以上)ならそのまま選ばれた対象として処理を
// 続行する(選択の余地がない場合は自動的に確定して返す)。保留はresolveEffectChoiceで
// 解決され、同じeff/sourceInstanceを使って同じ関数を選ばれた対象付きで再度呼び出す。
function chooseFromPool(game, ps, pool, providedUid, config) {
  if (providedUid != null) {
    const uids = Array.isArray(providedUid) ? providedUid : [providedUid];
    const chosen = uids.map((uid) => pool.find((c) => c.uid === uid)).filter(Boolean);
    return chosen.length > 0 ? chosen : null;
  }
  if (pool.length === 0) return [];
  const min = config.min != null ? config.min : 1;
  if (pool.length <= min) return pool.slice();
  game.pendingEffectChoice = {
    playerId: ps.id,
    cardUid: config.sourceInstance ? config.sourceInstance.uid : null,
    cardName: config.cardName,
    pool: pool.map((c) => c.uid),
    // 「相手の手札を見て～」系: 通常は隠されている相手の手札等を、この選択の間だけ
    // 選ぶ側のプレイヤーにカード名を公開する(pendingEffectChoiceはplayerId一致の
    // 閲覧者にしか送られないため、情報が漏れることはない)。
    poolReveal: config.revealNames ? pool.map((c) => ({ uid: c.uid, name: getCard(c.cardId).name })) : null,
    poolZone: config.poolZone,
    min,
    max: config.max != null ? config.max : min,
    label: config.label,
    sourceInstance: config.sourceInstance,
    eff: config.eff,
    card: config.card || null,
    resumeFn: config.resumeFn || 'resolveGenericEffect',
  };
  return null;
}

// pendingEffectChoiceで保留した選択をプレイヤーの指定した対象で確定し、
// 元の効果解決関数を対象付きで再実行する。
function resolveEffectChoice(game, playerId, action) {
  const pending = game.pendingEffectChoice;
  if (!pending || pending.playerId !== playerId) return { ok: false, error: '選択できるものがありません。' };
  const requested = Array.isArray(action.targetUids) ? action.targetUids : (action.targetUid != null ? [action.targetUid] : []);
  const uids = [...new Set(requested)].filter((uid) => pending.pool.includes(uid));
  if (uids.length < pending.min || uids.length > pending.max) {
    const range = pending.min === pending.max ? `${pending.min}個` : `${pending.min}〜${pending.max}個`;
    return { ok: false, error: `${range}選んでください。` };
  }
  game.pendingEffectChoice = null;
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[opponentId(game, playerId)];
  const targetParam = pending.max > 1 || pending.min > 1 ? uids : uids[0];
  let result;
  if (pending.resumeFn === 'applyManaOnPlaceEffect') {
    result = applyManaOnPlaceEffect(game, ps, opp, getCard(pending.sourceInstance.cardId), pending.sourceInstance, targetParam);
  } else if (pending.resumeFn === 'resolveGenericEffectMaybeArray') {
    result = resolveGenericEffectMaybeArray(game, ps, opp, pending.eff, targetParam, pending.sourceInstance);
  } else if (pending.resumeFn === 'resolveMahouEffect') {
    result = resolveMahouEffect(game, ps, opp, pending.card, { targetUid: targetParam });
  } else {
    result = resolveGenericEffect(game, ps, opp, pending.eff, targetParam, pending.sourceInstance);
  }
  checkAndProcessForcedTurnEnd(game);
  return result || { ok: true };
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
    case 'mana_right_plus': {
      ps.manaRight += eff.value;
      fireWuZetianObserver(game, ps, 'mana');
      return { ok: true };
    }
    case 'summon_right_plus': {
      ps.summonRight += eff.value;
      fireWuZetianObserver(game, ps, 'summon');
      return { ok: true };
    }
    case 'generic_destroy_ijin': {
      const sourcePower = sourceInstance ? effectivePower(sourceInstance, ps) : null;
      const target = resolveScopedIjinTarget(ps, opp, eff.scope, targetUid, eff.levelMax, eff.powerMax, sourcePower, eff.traitFilter);
      if (!target) return { ok: false, error: '対象が見つかりません(パワー・レベル条件を確認してください)。' };
      destroyFieldOrGuardian(game, target.owner, target.inst);
      return { ok: true };
    }
    case 'generic_bounce_ijin': {
      // 禁制の御殿: 自分と相手の戦場のイジンは、能力によって手札に戻らない
      // (最も汎用的なこの効果タイプのみを対象とする既存方針の簡略化)。
      if ([ps, opp].some((side) => side.field.haikei.some((h) => {
        const kw = getCard(h.cardId).keywords;
        return kw && kw.forbidIjinBounceToHandGlobally;
      }))) {
        return { ok: false, error: '禁制の御殿の効果により、イジンは能力によって手札に戻りません。' };
      }
      const sourcePower = sourceInstance ? effectivePower(sourceInstance, ps) : null;
      const target = resolveScopedIjinTarget(ps, opp, eff.scope, targetUid, eff.levelMax, eff.powerMax, sourcePower, eff.traitFilter);
      if (!target) return { ok: false, error: '対象が見つかりません(パワー・レベル条件を確認してください)。' };
      // 炎上がる天守閣: 自分の戦場の『アタック+』能力を持つイジンは能力によって戦場を離れない。
      if (target.owner.field.haikei.some((h) => {
        const kw = getCard(h.cardId).keywords;
        return kw && kw.protectAttackPlusIjinAndGuardiansFromFieldAbilityRemoval;
      })) {
        const targetCard = getCard(target.inst.cardId);
        const targetGrant = equippedGrant(target.inst);
        if ((targetCard.keywords && targetCard.keywords.attackBonus) || (targetGrant && targetGrant.attackBonus)) {
          return { ok: false, error: '炎上がる天守閣の効果により、このイジンは能力によって戦場を離れません。' };
        }
      }
      // シャルル・ド・モンテスキュー: 相手の戦場に3色以上ある間、自分の戦場の「思想」カードは
      // 能力によって戦場を離れない。
      const targetOwnerOpp = target.owner === ps ? opp : ps;
      if (isProtectedFromLeavingFieldByThought(target.inst, target.owner, targetOwnerOpp)) {
        return { ok: false, error: 'シャルル・ド・モンテスキューの効果により、このイジンは能力によって戦場を離れません。' };
      }
      detachEquipmentIfAny(target.owner, target.inst);
      target.owner.field.ijin.splice(target.owner.field.ijin.indexOf(target.inst), 1);
      target.owner.hand.push(target.inst);
      return { ok: true };
    }
    case 'generic_destroy_guardian': {
      const target = resolveScopedGuardianTarget(ps, opp, eff.scope, targetUid);
      if (!target) return { ok: false, error: '対象のガーディアンが見つかりません。' };
      destroyFieldOrGuardian(game, target.owner, target.inst);
      // スペクター(黄魔導): 黄のカードが自分の戦場か魔力ゾーンにあるなら、これの能力で
      // 破壊されたガーディアンは、墓地に置かれず山札の下に戻される。
      if (eff.magicColor && hasColorInFieldOrMana(ps, eff.magicColor)) {
        const gyIdx = target.owner.graveyard.indexOf(target.inst);
        if (gyIdx !== -1) {
          target.owner.graveyard.splice(gyIdx, 1);
          target.inst.faceUp = false;
          target.inst.tapped = false;
          target.owner.deck.push(target.inst);
        }
      }
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
      if (!canReturnFromGraveyardToHand(ps)) return { ok: false, error: '相手の効果により、墓地のカードを手札に戻せません。' };
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
      if (isManaProtectedFromFieldAbilityRemoval(target, owner, sourceInstance)) return { ok: false, error: '天下分け目の主戦場の効果により、このマリョクは魔力ゾーンを離れません。' };
      owner.mana.splice(owner.mana.indexOf(target), 1);
      target.faceUp = true;
      owner.hand.push(target);
      fireOnManaLeftViaAbility(game, owner, owner === ps ? opp : ps);
      return { ok: true };
    }
    // 紡績工場: エンドフェイズが開始したとき、裏のカードが魔力ゾーンにないなら、これを破壊する。
    // そうでなければ、魔力ゾーンの裏のカード1つを手札に戻す(強制効果)。
    case 'destroy_self_or_bounce_own_facedown_mana': {
      const allFacedown = ps.mana.filter((m) => !m.faceUp);
      if (allFacedown.length === 0) {
        if (sourceInstance) destroyFieldOrGuardian(game, ps, sourceInstance);
        return { ok: true };
      }
      const pool = allFacedown.filter((m) => !isManaProtectedFromFieldAbilityRemoval(m, ps, sourceInstance));
      if (pool.length === 0) return { ok: true };
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'mana_facedown', label: '手札に戻す裏向きのマリョク',
        sourceInstance, eff, min: 1, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const target = chosenArr[0];
      ps.mana.splice(ps.mana.indexOf(target), 1);
      target.faceUp = true;
      ps.hand.push(target);
      fireOnManaLeftViaAbility(game, ps, opp);
      return { ok: true };
    }
    // 清少納言: 執筆 - ハイケイが戦場に置かれるたび、魔力ゾーンのカード1つを指定して発動できる。
    // そのカードを手札に戻す(表裏を問わない)。
    case 'bounce_own_mana_by_uid': {
      const target = ps.mana.find((m) => m.uid === targetUid);
      if (!target) return { ok: false, error: '対象の魔力ゾーンのカードが見つかりません。' };
      if (isManaProtectedFromFieldAbilityRemoval(target, ps, sourceInstance)) return { ok: false, error: '天下分け目の主戦場の効果により、このマリョクは魔力ゾーンを離れません。' };
      ps.mana.splice(ps.mana.indexOf(target), 1);
      target.faceUp = true;
      ps.hand.push(target);
      fireOnManaLeftViaAbility(game, ps, opp);
      return { ok: true };
    }
    // ジャン・カルヴァン: メインフェイズが開始したとき、自分の魔力ゾーンのマリョク1つを裏にして
    // 発動できる。このターンの間「執筆」は発動しない。
    case 'suppress_shippitsu_this_turn_by_flipping_mana': {
      const target = ps.mana.find((m) => m.uid === targetUid && m.faceUp);
      if (!target) return { ok: false, error: '対象の表向きのマリョクが見つかりません。' };
      target.faceUp = false;
      ps.shippitsuSuppressedThisTurn = true;
      return { ok: true };
    }
    // 小野小町: 執筆 - 戦場にハイケイが置かれたとき、戦場のイジン1体を指定して発動できる。
    // そのイジンは、このターンに限り「特性：美術 音楽」を得る。
    case 'grant_temp_traits_to_target_ijin': {
      const target = [...ps.field.ijin, ...opp.field.ijin].find((i) => i.uid === targetUid);
      if (!target) return { ok: false, error: '対象のイジンが見つかりません。' };
      target.tempTraitsThisTurn = [...(target.tempTraitsThisTurn || []), ...eff.traits];
      return { ok: true };
    }
    // 小野小町: これが破壊されたとき、戦場の「美術」イジンと「音楽」イジンすべてを
    // 裏向きで魔力ゾーンに置く(自分・相手どちらの戦場も対象)。
    case 'flip_all_bijutsu_ongaku_ijin_to_mana_both_sides': {
      for (const side of [ps, opp]) {
        const targets = side.field.ijin.filter((i) => hasEffectiveTrait(i, '美術', side) || hasEffectiveTrait(i, '音楽', side));
        for (const t of targets) {
          detachEquipmentIfAny(side, t);
          side.field.ijin.splice(side.field.ijin.indexOf(t), 1);
          t.faceUp = false;
          t.tapped = false;
          side.mana.push(t);
        }
      }
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
    // 阿弥陀堂: 自分の戦場のカード1つか、自分の魔力ゾーンのカード1つを指定して、手札に戻す。
    case 'bounce_own_field_or_mana_by_uid': {
      const ijinInst = ps.field.ijin.find((i) => i.uid === targetUid);
      if (ijinInst) {
        detachEquipmentIfAny(ps, ijinInst);
        ps.field.ijin.splice(ps.field.ijin.indexOf(ijinInst), 1);
        ijinInst.faceUp = true;
        ps.hand.push(ijinInst);
        return { ok: true };
      }
      const haikeiInst = ps.field.haikei.find((h) => h.uid === targetUid);
      if (haikeiInst) {
        ps.field.haikei.splice(ps.field.haikei.indexOf(haikeiInst), 1);
        haikeiInst.faceUp = true;
        ps.hand.push(haikeiInst);
        return { ok: true };
      }
      const manaInst = ps.mana.find((m) => m.uid === targetUid);
      if (manaInst) {
        if (isManaProtectedFromFieldAbilityRemoval(manaInst, ps, sourceInstance)) return { ok: false, error: '天下分け目の主戦場の効果により、このマリョクは魔力ゾーンを離れません。' };
        ps.mana.splice(ps.mana.indexOf(manaInst), 1);
        manaInst.faceUp = true;
        ps.hand.push(manaInst);
        fireOnManaLeftViaAbility(game, ps, opp);
        return { ok: true };
      }
      return { ok: false, error: '対象が見つかりません。' };
    }
    case 'tap_opponent_ijin_power_below_attacker': {
      const attackerInst = ps.field.ijin.find((i) => i.uid === targetUid);
      if (!attackerInst) return { ok: false, error: '対象のアタッカーが見つかりません。' };
      const p = attackContextPower(attackerInst, ps, opp);
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
    // 山田長政: 航海 - アタッカーになったとき、相手の戦場のイジン1体を指定して発動できる。
    // 次のブロックステップに際し、そのイジンは、これをブロックする(強制ブロック)。
    case 'force_target_ijin_to_block_self_next_step': {
      const target = opp.field.ijin.find((i) => i.uid === targetUid);
      if (!target) return { ok: false, error: '対象の相手のイジンを指定してください。' };
      target.forcedToBlockAttackerUid = sourceInstance ? sourceInstance.uid : null;
      return { ok: true };
    }
    case 'tap_target_ijin': {
      const target = resolveScopedIjinTarget(ps, opp, eff.scope, targetUid);
      if (!target) return { ok: false, error: '対象が見つかりません。' };
      target.inst.tapped = true;
      return { ok: true };
    }
    case 'draw_scaled_by_opponent_haikei':
      drawCards(game, ps, haikeiFieldCount(opp));
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
    case 'draw_then_discard_n_own_hand': {
      drawCards(game, ps, eff.drawValue || 0);
      const uids = (Array.isArray(targetUid) ? targetUid : []).slice(0, eff.discardCount || 0);
      for (const uid of uids) {
        const idx = ps.hand.findIndex((h) => h.uid === uid);
        if (idx === -1) continue;
        const [discarded] = ps.hand.splice(idx, 1);
        discarded.faceUp = true;
        ps.graveyard.push(discarded);
        fireOnDiscardedFromHandTrigger(game, ps, opp, discarded);
      }
      return { ok: true };
    }
    case 'draw_then_untap_self':
      drawCards(game, ps, eff.drawValue || 0);
      if (sourceInstance) sourceInstance.tapped = false;
      return { ok: true };
    case 'bounce_opponent_guardian_to_own_mana_facedown_auto': {
      if (opp.guardians.length === 0) return { ok: true };
      const g = opp.guardians.shift();
      g.faceUp = false;
      g.tapped = false;
      opp.mana.push(g);
      return { ok: true };
    }
    case 'deck_top_to_guardian': {
      if (ps.deck.length === 0) return { ok: true };
      const c = ps.deck.shift();
      c.faceUp = false;
      c.tapped = newGuardiansEnterTapped(ps);
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
        if (opp.deck.length === 0 || opp.preventDeckToGraveyardMillThisTurn) break;
        const c = opp.deck.shift();
        c.faceUp = true;
        opp.graveyard.push(c);
        checkMilledCardForForcedTurnEnd(game, opp, getCard(c.cardId), c);
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
      const facedown = ps.mana.filter((m) => !m.faceUp && !isManaProtectedFromFieldAbilityRemoval(m, ps, sourceInstance));
      for (const m of facedown) {
        ps.mana.splice(ps.mana.indexOf(m), 1);
        m.tapped = false;
        ps.guardians.push(m);
      }
      if (facedown.length > 0) fireOnManaLeftViaAbility(game, ps, opp);
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
      const chosenArr = chooseFromPool(game, ps, ps.graveyard, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'graveyard', label: 'ガーディアンにする墓地のカード',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
      ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
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
      if (isManaProtectedFromFieldAbilityRemoval(ps.mana[idx], ps, sourceInstance)) return { ok: false, error: '天下分け目の主戦場の効果により、このマリョクは魔力ゾーンを離れません。' };
      const [c] = ps.mana.splice(idx, 1);
      c.tapped = false;
      ps.guardians.push(c);
      fireOnManaLeftViaAbility(game, ps, opp);
      return { ok: true };
    }
    case 'reveal_opponent_deck_top_then_move_matching_color_ijin_to_guardian_auto': {
      if (opp.deck.length === 0) return { ok: true };
      const revealed = opp.deck[opp.deck.length - 1];
      const revealedColors = getCard(revealed.cardId).colors;
      for (const i of opp.field.ijin.slice()) {
        if (revealedColors.some((c) => effectiveColors(i, opp).includes(c))) {
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
      const pool = ps.mana.filter((m) => getCard(m.cardId).name.includes('ストーン') && !isManaProtectedFromFieldAbilityRemoval(m, ps, sourceInstance));
      const chosen = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'mana', label: 'ガーディアンにする「ストーン」マリョク',
        sourceInstance, eff, min: 0, max: 2,
      });
      if (chosen === null) return { ok: true, pending: true };
      const moved = chosen;
      for (const c of moved) {
        ps.mana.splice(ps.mana.indexOf(c), 1);
        c.faceUp = false;
        c.tapped = false;
        ps.guardians.push(c);
      }
      if (moved.length > 0) fireOnManaLeftViaAbility(game, ps, opp);
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
        if (ps.deck.length === 0 || ps.preventDeckToGraveyardMillThisTurn) break;
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.graveyard.push(c);
        checkMilledCardForForcedTurnEnd(game, ps, getCard(c.cardId), c);
      }
      return { ok: true };
    }
    case 'graveyard_to_deck_bottom_then_draw': {
      // 松平容保: 「墓地のカードを山札の下に戻して発動できる」ため、対象がなければ
      // (=発動しないなら)ドローも行わない。
      const idx = ps.graveyard.findIndex((c) => c.uid === targetUid && getCard(c.cardId).type !== 'maryoku');
      if (idx === -1) return { ok: true };
      const [c] = ps.graveyard.splice(idx, 1);
      ps.deck.push(c);
      drawCards(game, ps, eff.drawValue || 0);
      return { ok: true };
    }
    // フェルディナンド・マゼラン、芹沢鴨: 相手の手札のカードを墓地に置く。そのカードは
    // 相手が選ぶ(名前とは異なり、実際はランダムではない)。芹沢鴨のonPlaceは配列効果
    // 内で他の効果とtargetUidを共有するため、このtargetUidは使わずopp自身の選択として扱う。
    case 'opponent_discard_random': {
      if (isHandDiscardFieldAbilitySuppressed(game)) return { ok: true };
      const min = Math.min(eff.value || 1, opp.hand.length);
      if (min === 0) return { ok: true };
      const chosenArr = chooseFromPool(game, opp, opp.hand, null, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '墓地に置く手札を選んでください',
        sourceInstance, eff: { type: 'discard_own_hand_multi_by_uids' }, min, max: min,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      for (const c of chosenArr) {
        const idx = opp.hand.indexOf(c);
        if (idx !== -1) opp.hand.splice(idx, 1);
        c.faceUp = true;
        opp.graveyard.push(c);
        fireOnDiscardedFromHandTrigger(game, opp, ps, c);
      }
      return { ok: true };
    }
    // 阿頼耶識: 自分の魔力ゾーンのマリョク1つを裏にして発動できる。相手の手札のカード1つを
    // 墓地に置く。そのカードは相手が選ぶ。
    case 'flip_own_mana_optional_then_opponent_discards_own_choice': {
      const manaPool = ps.mana.filter((m) => m.faceUp);
      const chosenMana = chooseFromPool(game, ps, manaPool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'mana_faceup', label: '裏にする自分のマリョク(発動しない場合は選ばない)',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenMana === null) return { ok: true, pending: true };
      if (chosenMana.length === 0) return { ok: true };
      chosenMana[0].faceUp = false;
      if (opp.hand.length === 0 || isHandDiscardFieldAbilitySuppressed(game)) return { ok: true };
      const oppChosen = chooseFromPool(game, opp, opp.hand, null, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '墓地に置く手札を選んでください(阿頼耶識の効果)',
        sourceInstance, eff: { type: 'discard_own_hand' }, min: 1, max: 1,
      });
      if (oppChosen === null) return { ok: true, pending: true };
      const c = oppChosen[0];
      opp.hand.splice(opp.hand.indexOf(c), 1);
      c.faceUp = true;
      opp.graveyard.push(c);
      fireOnDiscardedFromHandTrigger(game, opp, ps, c);
      return { ok: true };
    }
    case 'discard_own_hand': {
      if (isHandDiscardFieldAbilitySuppressed(game)) return { ok: true };
      const idx = ps.hand.findIndex((h) => h.uid === targetUid);
      if (idx === -1) return { ok: false, error: '対象の手札が見つかりません。' };
      const [c] = ps.hand.splice(idx, 1);
      c.faceUp = true;
      ps.graveyard.push(c);
      fireOnDiscardedFromHandTrigger(game, ps, opp, c);
      return { ok: true };
    }
    // 相手が選ぶ系の効果(阿頼耶識・フェルディナンド・マゼラン等)がpendingEffectChoiceで
    // 保留され、後から選ぶ側のプレイヤー自身がresolveEffectChoiceで再開すると、その時点の
    // psは「選ぶ側(=手札を捨てる本人)」になる。この専用タイプはその前提で常にps自身の
    // 手札から複数枚(1枚でも可)を捨てるため、保留の再開先として安全に使える。
    case 'discard_own_hand_multi_by_uids': {
      const uids = Array.isArray(targetUid) ? targetUid : (targetUid != null ? [targetUid] : []);
      for (const uid of uids) {
        const idx = ps.hand.findIndex((h) => h.uid === uid);
        if (idx === -1) continue;
        const [c] = ps.hand.splice(idx, 1);
        c.faceUp = true;
        ps.graveyard.push(c);
        fireOnDiscardedFromHandTrigger(game, ps, opp, c);
      }
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
    case 'destroy_all_opponent_untapped_ijin': {
      for (const t of opp.field.ijin.filter((i) => !i.tapped)) destroyFieldOrGuardian(game, opp, t);
      return { ok: true };
    }
    case 'bounce_all_tapped_ijin_both_sides': {
      for (const side of [ps, opp]) {
        for (const t of side.field.ijin.filter((i) => i.tapped)) {
          detachEquipmentIfAny(side, t);
          side.field.ijin.splice(side.field.ijin.indexOf(t), 1);
          t.faceUp = true;
          side.hand.push(t);
        }
      }
      return { ok: true };
    }
    case 'remove_all_attackers_from_battle': {
      if (game.pendingBattle) game.pendingBattle.attackers = [];
      return { ok: true };
    }
    case 'remove_one_attacker_from_battle': {
      if (game.pendingBattle && game.pendingBattle.attackers.length > 0) {
        const removed = game.pendingBattle.attackers[0];
        game.pendingBattle.attackers = game.pendingBattle.attackers.filter((e) => e.uid !== removed.uid);
      }
      return { ok: true };
    }
    case 'bounce_current_battle_attacker_to_hand': {
      // ジョン・ロック: 自分の戦場のガーディアンが破壊されるたびに発動できる。アタッカー1体を
      // 手札に戻す(複数同時破壊時は、簡略化として先頭のアタッカーを対象とする)。
      if (!game.pendingBattle || game.pendingBattle.attackers.length === 0) return { ok: true };
      const entry = game.pendingBattle.attackers[0];
      if (entry.isGuardianAttacker) return { ok: true };
      const attackerPs = game.playerStates[game.pendingBattle.attackerPlayerId];
      const attackerInst = attackerPs.field.ijin.find((i) => i.uid === entry.uid);
      if (!attackerInst) return { ok: true };
      detachEquipmentIfAny(attackerPs, attackerInst);
      attackerPs.field.ijin.splice(attackerPs.field.ijin.indexOf(attackerInst), 1);
      attackerInst.faceUp = true;
      attackerPs.hand.push(attackerInst);
      game.pendingBattle.attackers = game.pendingBattle.attackers.filter((e) => e.uid !== entry.uid);
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
      if (!canPlaceFromGraveyardToField(ps)) return { ok: false, error: '相手の効果により、墓地のカードを戦場に置けません。' };
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
        if (ps.deck.length === 0 || ps.preventDeckToGraveyardMillThisTurn) break;
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.graveyard.push(c);
        checkMilledCardForForcedTurnEnd(game, ps, getCard(c.cardId), c);
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
    // メアリー1世: 相手の手札を見てマリョクでないカード1つを墓地に置く(発動者が選ぶ)。
    case 'opponent_discard_random_non_maryoku': {
      const pool = opp.hand.filter((c) => getCard(c.cardId).type !== 'maryoku');
      const min = Math.min(eff.value || 1, pool.length);
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'opponent_hand', label: '墓地に置く相手の手札(マリョク以外)',
        sourceInstance, eff, min, max: min, revealNames: true,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      for (const c of chosenArr) {
        const handIdx = opp.hand.indexOf(c);
        if (handIdx !== -1) opp.hand.splice(handIdx, 1);
        c.faceUp = true;
        opp.graveyard.push(c);
        fireOnDiscardedFromHandTrigger(game, opp, ps, c);
      }
      return { ok: true };
    }
    // 愛姫: 相手の手札を見て、マホウ2つまでを墓地に置く(発動者が選ぶ)。
    case 'opponent_discard_random_filtered': {
      const pool = opp.hand.filter((c) => getCard(c.cardId).type === eff.cardType);
      const max = Math.min(eff.value || 1, pool.length);
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'opponent_hand', label: `墓地に置く相手の手札(${eff.cardType})`,
        sourceInstance, eff, min: 0, max, revealNames: true,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      for (const c of chosenArr) {
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
      drawCards(game, ps, haikeiFieldCount(ps));
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
      if (!canReturnFromGraveyardToHand(ps) || isGraveyardMahouProtectedFromAbilityRemoval(ps, opp)) return { ok: true };
      for (const c of ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou' && (getCard(c.cardId).text || '').includes(eff.requireText)).slice()) {
        const idx = ps.graveyard.indexOf(c);
        if (idx !== -1) ps.graveyard.splice(idx, 1);
        c.faceUp = true;
        ps.hand.push(c);
      }
      return { ok: true };
    }
    case 'bounce_graveyard_mahou_scaled_by_own_mana_colors': {
      if (!canReturnFromGraveyardToHand(ps) || isGraveyardMahouProtectedFromAbilityRemoval(ps, opp)) return { ok: true };
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
    // マリ・キュリー: 相手の手札を自分の手札と同じ枚数になるように墓地に置く。
    // 墓地に置く手札は相手が選ぶ。
    case 'opponent_discard_down_to_own_hand_count': {
      const discardCount = Math.max(0, opp.hand.length - ps.hand.length);
      if (discardCount === 0) return { ok: true };
      const chosenArr = chooseFromPool(game, opp, opp.hand, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '墓地に置く手札',
        sourceInstance, eff: { type: 'discard_own_hand_multi_by_uids' }, min: discardCount, max: discardCount,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      for (const c of chosenArr) {
        const idx = opp.hand.indexOf(c);
        if (idx !== -1) opp.hand.splice(idx, 1);
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
      if (!canReturnFromGraveyardToHand(ps) || isGraveyardMahouProtectedFromAbilityRemoval(ps, opp)) return { ok: true };
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
      if (!canReturnFromGraveyardToHand(ps) || isGraveyardMahouProtectedFromAbilityRemoval(ps, opp)) return { ok: true };
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
      const count = [...ps.field.ijin, ...ps.field.haikei].filter((i) => effectiveColors(i, ps).includes(eff.color)).length;
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
    // 岡田以蔵: イジンかガーディアンを1体破壊する(自由選択の能力だが、木霊等と同様の理由で
    // 本アプリでは相手側を優先して自動選択する)。
    case 'destroy_flexible_ijin_or_guardian_auto': {
      const excludeUid = sourceInstance ? sourceInstance.uid : null;
      const pool = [
        ...opp.field.ijin.filter((i) => i.uid !== excludeUid).map((inst) => ({ owner: opp, inst })),
        ...opp.guardians.filter((g) => g.uid !== excludeUid).map((inst) => ({ owner: opp, inst })),
        ...ps.field.ijin.filter((i) => i.uid !== excludeUid).map((inst) => ({ owner: ps, inst })),
        ...ps.guardians.filter((g) => g.uid !== excludeUid).map((inst) => ({ owner: ps, inst })),
      ];
      if (pool.length === 0) return { ok: true };
      destroyFieldOrGuardian(game, pool[0].owner, pool[0].inst);
      return { ok: true };
    }
    // 孫権: 自分の手札1枚を墓地に置いて、1ドローする(自由選択の捨てる1枚は、
    // 木霊等と同様の理由で本アプリではレベルの最も低い候補を自動選択する)。
    case 'discard_one_then_draw_one_auto': {
      const chosenArr = chooseFromPool(game, ps, ps.hand, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '墓地に置く手札',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
      ps.hand.splice(ps.hand.indexOf(c), 1);
      c.faceUp = true;
      ps.graveyard.push(c);
      fireOnDiscardedFromHandTrigger(game, ps, opp, c);
      drawCards(game, ps, 1);
      return { ok: true };
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
    // 宮本武蔵: パワー2000以下の相手の戦場のイジン1体を破壊する
    // (自由選択の能力だが、他の同様の自動選択効果と同じくパワーの最も高い候補を選ぶ)。
    case 'destroy_opponent_ijin_power_at_most_auto': {
      const pool = opp.field.ijin.filter((i) => effectivePower(i, opp) <= eff.value);
      if (pool.length === 0) return { ok: true };
      const best = pool.reduce((a, b) => (effectivePower(b, opp) > effectivePower(a, opp) ? b : a));
      destroyFieldOrGuardian(game, opp, best);
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
      if (!canReturnFromGraveyardToHand(ps)) return { ok: true };
      for (const c of ps.graveyard.filter((c) => getCard(c.cardId).type === 'haikei').slice()) {
        ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
        c.faceUp = true;
        ps.hand.push(c);
      }
      return { ok: true };
    }
    case 'revive_flexible_ijin_or_haikei_from_graveyard': {
      if (!canPlaceFromGraveyardToField(ps)) return { ok: false, error: '相手の効果により、墓地のカードを戦場に置けません。' };
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
      if (!canReturnFromGraveyardToHand(ps)) return { ok: true };
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'haikei');
      const chosen = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'graveyard', label: '手札に戻す墓地のハイケイ',
        sourceInstance, eff, min: 0, max: 2,
      });
      if (chosen === null) return { ok: true, pending: true };
      for (const c of chosen) {
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
      const pool = ps.mana.filter((m) => !m.faceUp && !isManaProtectedFromFieldAbilityRemoval(m, ps, sourceInstance));
      let movedAny = false;
      for (let i = 0; i < colors.size && pool.length > 0; i++) {
        const c = pool.shift();
        ps.mana.splice(ps.mana.indexOf(c), 1);
        c.faceUp = true;
        ps.hand.push(c);
        movedAny = true;
      }
      if (movedAny) fireOnManaLeftViaAbility(game, ps, opp);
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
      fireOnManaLeftViaAbility(game, ps, opp);
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
    // 遠征軍: 自分のエンドフェイズが開始したときに発動できる。これを山札の上に戻す。
    // (戦場・墓地いずれにあっても発動できる徴募として扱う)
    case 'move_self_to_deck_top_from_field_or_graveyard': {
      if (!sourceInstance) return { ok: true };
      const haikeiIdx = ps.field.haikei.indexOf(sourceInstance);
      if (haikeiIdx !== -1) {
        ps.field.haikei.splice(haikeiIdx, 1);
        sourceInstance.faceUp = true;
        ps.deck.unshift(sourceInstance);
        return { ok: true };
      }
      const graveIdx = ps.graveyard.indexOf(sourceInstance);
      if (graveIdx !== -1) {
        ps.graveyard.splice(graveIdx, 1);
        sourceInstance.faceUp = true;
        ps.deck.unshift(sourceInstance);
        return { ok: true };
      }
      // ギルデッドグース: 魔力ゾーンにある間にこの効果を使うカードにも対応する。
      const manaIdx = ps.mana.indexOf(sourceInstance);
      if (manaIdx !== -1) {
        ps.mana.splice(manaIdx, 1);
        sourceInstance.faceUp = true;
        ps.deck.unshift(sourceInstance);
      }
      return { ok: true };
    }
    case 'mill_self_then_graveyard_to_deck_top': {
      // 落日の王宮: この能力自体が「発動できる」(任意)なので、コスト(山札を落とす)は
      // fireOnPlaceTrigger側でconfirmBeforeCost+triggerActivateにより発動が確定してから
      // 初回(targetUid未指定)にのみ行う。戻すカードの選択はchooseFromPoolで任意(0〜1枚)に。
      if (targetUid == null) {
        for (let i = 0; i < (eff.millValue || 1); i++) {
          if (ps.deck.length === 0 || ps.preventDeckToGraveyardMillThisTurn) break;
          const c = ps.deck.shift();
          c.faceUp = true;
          ps.graveyard.push(c);
          checkMilledCardForForcedTurnEnd(game, ps, getCard(c.cardId), c);
        }
      }
      const chosenArr = chooseFromPool(game, ps, ps.graveyard, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'graveyard', label: '山札の上に戻す墓地のカード(任意)',
        sourceInstance, eff, min: 0, max: 1, resumeFn: 'resolveGenericEffectMaybeArray',
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const [c] = chosenArr;
      ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
      c.faceUp = true;
      ps.deck.unshift(c);
      return { ok: true };
    }
    case 'mill_self_then_graveyard_to_hand_auto': {
      // 山札を落とす処理は選択の保留を挟むと二重実行になるため、初回呼び出し時
      // (targetUid未指定)にのみ行う。
      if (targetUid == null) {
        for (let i = 0; i < (eff.millValue || 1); i++) {
          if (ps.deck.length === 0 || ps.preventDeckToGraveyardMillThisTurn) break;
          const c = ps.deck.shift();
          c.faceUp = true;
          ps.graveyard.push(c);
          checkMilledCardForForcedTurnEnd(game, ps, getCard(c.cardId), c);
        }
      }
      if (ps.graveyard.length === 0 || !canReturnFromGraveyardToHand(ps)) return { ok: true };
      const chosenArr = chooseFromPool(game, ps, ps.graveyard, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'graveyard', label: '手札に戻す墓地のカード',
        sourceInstance, eff,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
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
      if (!sourceInstance || !canPlaceFromGraveyardToField(ps)) return { ok: true };
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
      if (!canReturnFromGraveyardToHand(ps) || isGraveyardMahouProtectedFromAbilityRemoval(ps, opp)) return { ok: true };
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou');
      const chosen = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'graveyard', label: '手札に戻す墓地のマホウ',
        sourceInstance, eff, min: 0, max: 2,
      });
      if (chosen === null) return { ok: true, pending: true };
      for (const c of chosen) {
        ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
        c.faceUp = true;
        ps.hand.push(c);
      }
      return { ok: true };
    }
    // 相馬義胤: 勝鬨 - 自分の墓地のマホウ1つを手札に戻す。
    case 'bounce_own_graveyard_mahou_highest_level_auto': {
      if (!canReturnFromGraveyardToHand(ps) || isGraveyardMahouProtectedFromAbilityRemoval(ps, opp)) return { ok: true };
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou');
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'graveyard', label: '手札に戻す墓地のマホウ',
        sourceInstance, eff,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
      ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
      c.faceUp = true;
      ps.hand.push(c);
      return { ok: true };
    }
    // 真田信繁: 勝鬨 - 自分と相手の戦場の指定特性を持たないイジンすべてを破壊する。
    case 'destroy_all_non_trait_ijin_both_sides': {
      for (const side of [ps, opp]) {
        for (const i of side.field.ijin.filter((i) => !hasEffectiveTrait(i, eff.trait, side)).slice()) {
          destroyFieldOrGuardian(game, side, i);
        }
      }
      return { ok: true };
    }
    case 'bounce_graveyard_card_to_hand_by_uid_either_owner': {
      const psIdx = ps.graveyard.findIndex((c) => c.uid === targetUid);
      if (psIdx !== -1) {
        if (!canReturnFromGraveyardToHand(ps)) return { ok: true };
        const [c] = ps.graveyard.splice(psIdx, 1);
        c.faceUp = true;
        ps.hand.push(c);
        return { ok: true };
      }
      const oppIdx = opp.graveyard.findIndex((c) => c.uid === targetUid);
      if (oppIdx !== -1) {
        if (!canReturnFromGraveyardToHand(opp)) return { ok: true };
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
      if (sourceInstance && canPlaceFromGraveyardToField(ps)) {
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
    // アダム・ラクスマン: 自分の手札のレベルN以下の指定色のイジン1体を戦場に置く
    // (対象選択が必要な能力だが、木霊等と同様の理由で本アプリではパワーの最も高い候補を
    // 自動選択して処理する)。
    case 'place_hand_ijin_level_at_most_color_auto': {
      const pool = ps.hand.filter((c) => {
        const card = getCard(c.cardId);
        return card.type === 'ijin' && card.level <= (eff.levelMax || Infinity) && card.colors.includes(eff.color);
      });
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '戦場に出す手札のイジン',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
      ps.hand.splice(ps.hand.indexOf(c), 1);
      c.faceUp = true;
      c.tapped = false;
      c.sick = true;
      ps.field.ijin.push(c);
      return { ok: true };
    }
    case 'place_hand_rush_ijin_free_auto': {
      const pool = ps.hand.filter((c) => {
        const card = getCard(c.cardId);
        return card.type === 'ijin' && card.level <= (eff.levelMax || Infinity) && card.keywords && card.keywords.rush;
      });
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '戦場に出す手札の「即応」イジン',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
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
      const pool = [...ps.hand.filter(matches), ...ps.graveyard.filter(matches)];
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '戦場に出す手札・墓地のカード',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const inst = chosenArr[0];
      const found = findInstance(ps, inst.uid);
      if (!found) return { ok: true };
      found.list.splice(found.idx, 1);
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
    // ガーディアンは自分自身にも裏向き(内容不明)のため、どれを選んでも見た目上の
    // 違いがない。実質的な選択にならないため自動選択のままにする。
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
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '墓地に置く手札',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
      ps.hand.splice(ps.hand.indexOf(c), 1);
      c.faceUp = true;
      ps.graveyard.push(c);
      fireOnDiscardedFromHandTrigger(game, ps, opp, c);
      drawCards(game, ps, eff.drawValue || 0);
      return { ok: true };
    }
    case 'revive_graveyard_haikei_with_legacy_auto': {
      if (!canPlaceFromGraveyardToField(ps)) return { ok: true };
      const pool = ps.graveyard.filter((c) => {
        const card = getCard(c.cardId);
        return card.type === 'haikei' && card.legacy;
      });
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'graveyard', label: '戦場に出す墓地のハイケイ',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
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
        if (ps.deck.length === 0 || ps.preventDeckToGraveyardMillThisTurn) break;
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.graveyard.push(c);
        checkMilledCardForForcedTurnEnd(game, ps, getCard(c.cardId), c);
        milled += 1;
      }
      if (milled >= 1) ps.manaRight += 1;
      if (milled >= 2) ps.summonRight += 1;
      if (milled === 3) drawCards(game, ps, 1);
      return { ok: true };
    }
    case 'tap_own_field_ijin_color_or_trait_then_self_draw_auto': {
      // 商館並ぶ人工島: 対象は「戦場の」イジン(自分・相手いずれも可)で、寝かせたイジンの
      // 持ち主が1ドローする(発動者が引くとは限らない)。
      const matchesCard = (i) => {
        if (i.tapped) return false;
        const card = getCard(i.cardId);
        const kw = card.keywords;
        const hasTrait = eff.trait && kw && (kw.trait === eff.trait || (kw.traits && kw.traits.includes(eff.trait)));
        return (eff.color && card.colors.includes(eff.color)) || hasTrait;
      };
      const pool = [...ps.field.ijin.filter(matchesCard), ...opp.field.ijin.filter(matchesCard)];
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'field_ijin_either', label: '寝かせるイジン(自分・相手いずれも可)',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const chosen = chosenArr[0];
      chosen.tapped = true;
      const owner = ps.field.ijin.includes(chosen) ? ps : opp;
      drawCards(game, owner, 1);
      return { ok: true };
    }
    case 'place_hand_ijin_free_auto_then_bounce_self': {
      const pool = ps.hand.filter((c) => {
        const card = getCard(c.cardId);
        return card.type === 'ijin' && card.level <= (eff.levelMax || Infinity) && card.colors.includes(eff.color);
      });
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '戦場に出す手札のイジン',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
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
      const pool = ps.graveyard.filter((g) => getCard(g.cardId).type !== 'maryoku');
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'graveyard', label: '山札の下に戻す墓地のカード',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
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
    // 井伊直弼: 自分の山札の下から2枚を見る。レベル7以下のイジンをすきなだけ戦場に置いて、
    // 残りを手札に加える(無償で置ける以上、置ける限り置くのが常に最善手であるため、
    // 蒸気機関車の同種処理と同様に自動で全て配置する)。
    case 'deck_bottom2_reveal_place_ijin_level_max_rest_to_hand': {
      const revealed = [];
      for (let i = 0; i < 2; i++) {
        if (ps.deck.length === 0) break;
        revealed.push(ps.deck.pop());
      }
      for (const c of revealed) {
        const cc = getCard(c.cardId);
        if (cc.type === 'ijin' && cc.level <= (eff.levelMax || Infinity)) {
          c.faceUp = true;
          c.sick = true;
          c.tapped = false;
          ps.field.ijin.push(c);
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
      if (!canPlaceFromGraveyardToField(ps)) return { ok: true };
      const pool = ps.graveyard.filter((c) => {
        const card = getCard(c.cardId);
        return (card.type === 'ijin' && card.level <= (eff.ijinLevelMax || Infinity)) ||
          (card.type === 'haikei' && card.level <= (eff.haikeiLevelMax || Infinity));
      });
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'graveyard', label: '戦場に出す墓地のカード',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
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
      // クリスタル・パレス: 自分の手札のカード2つをすきな順番で山札の下に戻す
      // (選んだ順=山札に積む順とすることで「すきな順番」を反映する)。
      const min = Math.min(eff.value || 1, ps.hand.length);
      const chosenArr = chooseFromPool(game, ps, ps.hand, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '山札の下に戻す手札(選んだ順に山札の下へ)',
        sourceInstance, eff, min, max: min,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      for (const c of chosenArr) {
        const idx = ps.hand.indexOf(c);
        if (idx !== -1) ps.hand.splice(idx, 1);
        ps.deck.push(c);
      }
      drawCards(game, ps, eff.drawValue || 1);
      return { ok: true };
    }
    case 'bounce_own_ijin_level_max_auto': {
      const pool = ps.field.ijin.filter((i) => getCard(i.cardId).level <= (eff.levelMax || Infinity));
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'field_ijin', label: '手札に戻す自分のイジン',
        sourceInstance, eff,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const t = chosenArr[0];
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
      while (opp.deck.length > 0 && !opp.preventDeckToGraveyardMillThisTurn) {
        const c = opp.deck.shift();
        c.faceUp = true;
        opp.graveyard.push(c);
        checkMilledCardForForcedTurnEnd(game, opp, getCard(c.cardId), c);
        if (getCard(c.cardId).type === 'ijin') break;
      }
      return { ok: true };
    }
    // 日蓮: 相手の手札を見てマホウ1つを墓地に置く(発動者が選ぶ)。それができないなら自分を戻す。
    case 'discard_opponent_hand_mahou_or_bounce_self': {
      const mahouPool = opp.hand.filter((c) => getCard(c.cardId).type === 'mahou');
      if (mahouPool.length > 0) {
        const chosenArr = chooseFromPool(game, ps, mahouPool, targetUid, {
          cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'opponent_hand', label: '墓地に置く相手の手札(マホウ)',
          sourceInstance, eff, min: 1, max: 1, revealNames: true,
        });
        if (chosenArr === null) return { ok: true, pending: true };
        const mahou = chosenArr[0];
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
        } else if (canReturnFromGraveyardToHand(ps)) {
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
      const hasMortal = ps.field.ijin.some((i) => hasEffectiveMortal(i, ps));
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
      let discardedAny = false;
      for (const m of opp.mana.slice()) {
        if (m.faceUp) continue;
        m.faceUp = true;
        if (getCard(m.cardId).type !== 'maryoku') {
          opp.mana.splice(opp.mana.indexOf(m), 1);
          opp.graveyard.push(m);
          discardedAny = true;
        }
      }
      if (discardedAny) fireOnManaLeftViaAbility(game, opp, ps);
      return { ok: true };
    }
    // ミューテイション: 戦場のガーディアン1体か、魔力ゾーンの裏のカード1つを指定して発動できる。
    // そのカードを墓地に置き、レベル6以下のイジンなら戦場に置く。
    case 'flip_own_guardian_or_facedown_mana_by_uid': {
      let list = ps.guardians;
      let target = list.find((c) => c.uid === targetUid);
      if (!target) {
        list = ps.mana;
        target = list.find((c) => c.uid === targetUid && !c.faceUp);
      }
      if (!target) return { ok: false, error: '対象のガーディアンか、魔力ゾーンの裏のカードを指定してください。' };
      const wasMana = list === ps.mana;
      list.splice(list.indexOf(target), 1);
      target.faceUp = true;
      if (wasMana) fireOnManaLeftViaAbility(game, ps, opp);
      const tCard = getCard(target.cardId);
      if (tCard.type === 'ijin' && tCard.level <= 6) {
        target.tapped = false;
        target.sick = true;
        ps.field.ijin.push(target);
        log(game, `${ps.name}がミューテイションで「${tCard.name}」を戦場に置きました。`);
      } else {
        ps.graveyard.push(target);
        log(game, `${ps.name}がミューテイションで「${tCard.name}」を墓地に置きました。`);
      }
      return { ok: true };
    }
    // クリアボヤンス: 相手の戦場と相手の魔力ゾーンの、裏のカードすべての表を見る。
    // (このエンジンではガーディアンは所有者からも常に伏せられているため、
    // 「相手の戦場」は相手のガーディアンゾーンとして扱う)
    // 篤姫: 戦場に置かれたとき、戦場の裏のカード1つの表を見る(このエンジンでは
    // ガーディアンが「戦場の裏のカード」に相当する。自動選択として相手のガーディアンを
    // 優先し、なければ自分のガーディアンを対象とする)。
    // エンリケ航海王子: 自分の魔力ゾーンのマリョク1つを墓地に置いて発動できる。このターンに
    // 限り「これが戦場にいる間、自分の戦場の「航海」は、戦場に置かれたときでも発動する」を得る。
    case 'bury_own_mana_then_koukai_triggers_on_place_this_turn': {
      const maryokuIdx = ps.mana.findIndex((m) => getCard(m.cardId).type === 'maryoku');
      if (maryokuIdx === -1) return { ok: true };
      const [buried] = ps.mana.splice(maryokuIdx, 1);
      buried.faceUp = true;
      ps.graveyard.push(buried);
      ps.koukaiTriggersOnPlaceThisTurn = true;
      return { ok: true };
    }
    case 'reveal_one_field_facedown_card': {
      const target = opp.guardians[0] || ps.guardians[0];
      if (!target) return { ok: true };
      ps.clairvoyanceReveal = [{ uid: target.uid, name: getCard(target.cardId).name }];
      log(game, `${ps.name}が戦場の裏向きのカード1つを確認しました。`);
      return { ok: true };
    }
    case 'reveal_opponent_guardians_and_facedown_mana': {
      const revealed = [
        ...opp.guardians.map((g) => ({ uid: g.uid, name: getCard(g.cardId).name })),
        ...opp.mana.filter((m) => !m.faceUp).map((m) => ({ uid: m.uid, name: getCard(m.cardId).name })),
      ];
      ps.clairvoyanceReveal = revealed;
      log(game, `${ps.name}がクリアボヤンスで相手の裏向きのカードをすべて確認しました。`);
      return { ok: true };
    }
    case 'place_hand_or_graveyard_ijin_levelmax_auto': {
      const matches = (c) => getCard(c.cardId).type === 'ijin' && getCard(c.cardId).level <= (eff.levelMax || Infinity);
      const pool = [...ps.hand.filter(matches), ...ps.graveyard.filter(matches)];
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '戦場に出す手札・墓地のイジン',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const inst = chosenArr[0];
      const found = findInstance(ps, inst.uid);
      if (!found) return { ok: true };
      found.list.splice(found.idx, 1);
      inst.faceUp = true;
      inst.tapped = false;
      inst.sick = true;
      ps.field.ijin.push(inst);
      return { ok: true };
    }
    // ホムンクルス: 自分のメインフェイズが開始したとき、自分の手札のレベルN以下のイジン1体を
    // 指定して発動できる。そのイジンを戦場に置いて(イジン召喚権を使わない)、これを墓地に置く。
    case 'summon_hand_ijin_free_then_bury_self': {
      const target = ps.hand.find((c) => c.uid === targetUid);
      if (!target) return { ok: false, error: '対象の手札のイジンが見つかりません。' };
      const tCard = getCard(target.cardId);
      if (tCard.type !== 'ijin' || (eff.levelMax != null && tCard.level > eff.levelMax)) {
        return { ok: false, error: 'レベル条件を満たしていません。' };
      }
      ps.hand.splice(ps.hand.indexOf(target), 1);
      target.faceUp = true;
      target.tapped = false;
      target.sick = true;
      ps.field.ijin.push(target);
      if (sourceInstance) {
        const found = findInstance(ps, sourceInstance.uid);
        if (found) {
          found.list.splice(found.idx, 1);
          sourceInstance.faceUp = true;
          ps.graveyard.push(sourceInstance);
        }
      }
      return { ok: true };
    }
    case 'revive_self_from_graveyard_auto': {
      if (!sourceInstance || !canPlaceFromGraveyardToField(ps)) return { ok: true };
      const idx = ps.graveyard.indexOf(sourceInstance);
      if (idx === -1) return { ok: true };
      ps.graveyard.splice(idx, 1);
      sourceInstance.faceUp = true;
      sourceInstance.tapped = false;
      sourceInstance.sick = true;
      ps.field.ijin.push(sourceInstance);
      return { ok: true };
    }
    // 洪秀全: 相手の手札を見てマホウかハイケイ1つを墓地に置く(発動者が相手の手札を見て選ぶ)。
    case 'discard_opponent_hand_mahou_or_haikei_auto': {
      const pool = opp.hand.filter((c) => ['mahou', 'haikei'].includes(getCard(c.cardId).type));
      const min = Math.min(1, pool.length);
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'opponent_hand', label: '墓地に置く相手の手札(マホウ/ハイケイ)',
        sourceInstance, eff, min, max: 1, revealNames: true,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
      opp.hand.splice(opp.hand.indexOf(c), 1);
      c.faceUp = true;
      opp.graveyard.push(c);
      fireOnDiscardedFromHandTrigger(game, opp, ps, c);
      return { ok: true };
    }
    case 'hand_or_graveyard_card_to_guardian_auto': {
      const pool = [...ps.hand, ...ps.graveyard];
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: 'ガーディアンにする手札・墓地のカード',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
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
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'hand', label: '戦場に出す手札のイジン',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
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
      if (!canPlaceFromGraveyardToField(ps)) return { ok: true };
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'ijin' && getCard(c.cardId).level <= (eff.levelMax || Infinity));
      const chosenArr = chooseFromPool(game, ps, pool, targetUid, {
        cardName: sourceInstance ? getCard(sourceInstance.cardId).name : '', poolZone: 'graveyard', label: '戦場に出す墓地のイジン',
        sourceInstance, eff, min: 0, max: 1,
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
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
    // ミシェル・ノストラダムス: カード名を宣言し、相手の山札の一番上をめくって一致するなら
    // 戦場のイジン・ハイケイすべてをそれぞれの持ち主の山札に戻してシャッフルし、
    // 相手の山札の上から5枚を墓地に置く。
    case 'declare_name_reveal_opponent_deck_top_then_bounce_all_field_to_deck_and_mill5': {
      const declaredName = typeof targetUid === 'string' ? targetUid : targetUid && targetUid.name;
      if (!declaredName) return { ok: false, error: 'カード名を宣言してください。' };
      if (opp.deck.length === 0) return { ok: true };
      const revealed = opp.deck[0];
      if (getCard(revealed.cardId).name !== declaredName) return { ok: true };
      for (const side of [ps, opp]) {
        for (const inst of [...side.field.ijin]) {
          detachEquipmentIfAny(side, inst);
          side.field.ijin.splice(side.field.ijin.indexOf(inst), 1);
          inst.faceUp = true;
          inst.tapped = false;
          inst.sick = false;
          side.deck.push(inst);
        }
        for (const inst of [...side.field.haikei]) {
          side.field.haikei.splice(side.field.haikei.indexOf(inst), 1);
          inst.faceUp = true;
          inst.tapped = false;
          side.deck.push(inst);
        }
        side.deck = shuffle(side.deck);
      }
      for (let i = 0; i < 5 && opp.deck.length > 0 && !opp.preventDeckToGraveyardMillThisTurn; i++) {
        const c = opp.deck.shift();
        c.faceUp = true;
        opp.graveyard.push(c);
        checkMilledCardForForcedTurnEnd(game, opp, getCard(c.cardId), c);
      }
      return { ok: true };
    }
    // 賀茂保憲: カード名を宣言し、相手のガーディアン1体を指定して発動。そのガーディアンをめくって
    // 一致するなら、相手の戦場のカードすべて(イジン・ハイケイ)を墓地に置く。
    case 'declare_name_reveal_target_guardian_then_destroy_all_opponent_field': {
      const declaredName = targetUid && targetUid.name;
      const guardianUid = targetUid && targetUid.targetUid;
      if (!declaredName || !guardianUid) return { ok: false, error: 'カード名の宣言と対象のガーディアンの指定が必要です。' };
      const guardian = opp.guardians.find((g) => g.uid === guardianUid);
      if (!guardian) return { ok: false, error: '対象のガーディアンが見つかりません。' };
      if (getCard(guardian.cardId).name !== declaredName) return { ok: true };
      for (const inst of [...opp.field.ijin]) destroyFieldOrGuardian(game, opp, inst);
      for (const inst of [...opp.field.haikei]) destroyFieldOrGuardian(game, opp, inst);
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

// 「○魔導」マホウ共通条件: 指定した色のカードが自分の戦場(イジン・ハイケイ)か
// 自分の魔力ゾーン(表向き)にあるかどうか。
function hasColorInFieldOrMana(ps, color) {
  const inField = [...ps.field.ijin, ...ps.field.haikei].some((i) => effectiveColors(i, ps).includes(color));
  if (inField) return true;
  return ps.mana.some((m) => m.faceUp && getCard(m.cardId).colors.includes(color));
}

function checkTriggerCondition(ps, opp, cond, sourceInstance) {
  if (!cond) return true;
  switch (cond.type) {
    case 'fieldHasColorIjin':
      return ps.field.ijin.some((i) => effectiveColors(i, ps).includes(cond.color));
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
      return ps.field.ijin.filter((i) => effectiveColors(i, ps).includes(cond.color)).length >= cond.value;
    case 'ownManaCountAtLeast': {
      // 張角: 自分の戦場にある「決起」は、自分の魔力ゾーンのマリョクが3つ以上でも発動する
      // (通常4以上が条件の決起の閾値を1下げる)。
      const hasZhangJiao = ps.field.ijin.some((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && kw.lowerKekkiManaThreshold;
      });
      const threshold = hasZhangJiao ? cond.value - 1 : cond.value;
      return ps.mana.length >= threshold;
    }
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
      const count = [...ps.field.ijin, ...ps.field.haikei].filter((i) => effectiveColors(i, ps).includes(cond.color) && hasEffectiveTrait(i, cond.trait, ps)).length;
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
  if (isAbilitySuppressed(instance, ps, opp)) return;
  if (trig.requireViaHankon && !(action && action.viaHankon)) return;
  if (!checkTriggerCondition(ps, opp, trig.condition, instance)) return;
  // 落日の王宮等: コストを払う前に「発動できる」の任意性を確認する必要がある能力
  // (対象を事前に選べず、コストを払った後の状態から選ぶ必要があるもの)は、
  // 配置時にプレイヤーが明示的に発動を選んだ場合のみ発動する。
  if (trig.confirmBeforeCost && !(action && action.triggerActivate)) return;
  const targetUid = action && action.triggerTargetUid;
  let effect = trig.effect;
  if (trig.effectChoices) {
    const idx = action && action.triggerChoiceIndex === 1 ? 1 : 0;
    effect = trig.effectChoices[idx];
  }
  // ジャン＝ジャック・ルソー: 自分の手札1枚を墓地に置いて発動する(コスト)。
  if (effect && effect.type === 'destroy_highest_power_field_ijin') {
    const costIdx = ps.hand.findIndex((h) => h.uid === (action && action.costHandUid));
    if (costIdx === -1) return;
    const [discarded] = ps.hand.splice(costIdx, 1);
    discarded.faceUp = true;
    ps.graveyard.push(discarded);
    fireOnDiscardedFromHandTrigger(game, ps, opp, discarded);
  }
  const result = resolveGenericEffectMaybeArray(game, ps, opp, effect, targetUid, instance);
  if (result.ok) {
    log(game, `${ps.name}の「${card.name}」の能力が発動しました。`);
  }
}

function fireOnAttackerTrigger(game, ps, opp, instance, card, targetUid) {
  const trig = card.triggers && card.triggers.onAttacker;
  if (trig && !isAbilitySuppressed(instance, ps, opp) && checkTriggerCondition(ps, opp, trig.condition, instance)) {
    const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, targetUid, instance);
    if (result.ok) {
      log(game, `${ps.name}の「${card.name}」の能力(アタッカーになったとき)が発動しました。`);
      if ((card.text || '').startsWith('航海')) fireOnKokaiActivatedObservers(game, ps, opp, instance);
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

// 「航海」が発動したとき、を観測する能力(阿倍仲麻呂、角倉了以など)
function fireOnKokaiActivatedObservers(game, ps, opp, sourceInstance) {
  for (const instance of ps.field.ijin) {
    if (instance.uid === sourceInstance.uid) continue;
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onKokaiActivated;
    if (!trig) continue;
    if (isAbilitySuppressed(instance, ps, opp)) continue;
    if (!checkTriggerCondition(ps, opp, trig.condition, instance)) continue;
    const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, null, instance);
    if (result.ok) {
      log(game, `${ps.name}の「${card.name}」の能力(「航海」の発動を見て)が発動しました。`);
    }
  }
}

function fireOnAllyAttackerTriggers(game, ps, opp, attackerInstance, attackerCard) {
  for (const instance of [...ps.field.ijin, ...ps.field.haikei]) {
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onAllyAttacker;
    if (!trig || trig.needsTarget || trig.side === 'opponent') continue;
    if (isAbilitySuppressed(instance, ps, opp)) continue;
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
    if (isAbilitySuppressed(instance, opp, ps)) continue;
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
  // ハースストーンなど、魔力ゾーンに表向きで置かれている間だけ発動する能力も対象に含める。
  for (const instance of [...ps.field.ijin, ...ps.field.haikei, ...ps.mana.filter((m) => m.faceUp)]) {
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onManaPlaced;
    if (!trig || trig.needsTarget) continue;
    if (isAbilitySuppressed(instance, ps, opp)) continue;
    if (trig.requireStoneManaName && !(placedInstance && getCard(placedInstance.cardId).name.includes('ストーン'))) continue;
    if (trig.requireFacedown && !(placedInstance && !placedInstance.faceUp)) continue;
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
      if (isAbilitySuppressed(instance, ownerPs, opp)) continue;
      if (isShippitsuSuppressed(ownerPs, opp, card)) continue;
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
      if (isAbilitySuppressed(instance, ownerPs, opp)) continue;
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

function fireFieldStartTriggers(game, ps, opp, triggerKey, logSuffix, triggerTargets) {
  // ホムンクルスなど、魔力ゾーンに表向きで置かれている間だけ発動する能力も対象に含める。
  for (const instance of [...ps.field.ijin, ...ps.field.haikei, ...ps.mana.filter((m) => m.faceUp)]) {
    if (game.winner) break;
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers[triggerKey];
    if (!trig || trig.side === 'opponent') continue;
    if (isAbilitySuppressed(instance, ps, opp)) continue;
    if (trig.needsTarget) {
      // カード名宣言等、対象選択を伴うものは「発動できる」の任意能力として扱い、
      // プレイヤー(またはCPU)が対象情報を提示した場合のみ発動する。
      const targetData = triggerTargets && triggerTargets[instance.uid];
      if (!targetData) continue;
      if (!checkTriggerCondition(ps, opp, trig.condition, instance)) continue;
      const effect = trig.effectChoices ? trig.effectChoices[0] : trig.effect;
      const result = resolveGenericEffectMaybeArray(game, ps, opp, effect, targetData, instance);
      if (result.ok) {
        log(game, `${ps.name}の「${card.name}」の能力(${logSuffix})が発動しました。`);
      }
      continue;
    }
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
  for (const instance of [...opp.field.ijin, ...opp.field.haikei, ...opp.mana.filter((m) => m.faceUp)]) {
    if (game.winner) break;
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers[triggerKey];
    if (!trig || trig.needsTarget || trig.side !== 'opponent') continue;
    if (isAbilitySuppressed(instance, opp, ps)) continue;
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
    if (isAbilitySuppressed(inst, ps, opp)) continue;
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
    if (isAbilitySuppressed(instance, ps, opp)) continue;
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
      // 自分の戦場に「美術」イジンがいるなら、手札に戻す代わりに戦場に置いてもよい。
      const hasArtIjin = ps.field.ijin.some((i) => hasEffectiveTrait(i, '美術', ps));
      if (hasArtIjin && action.placeOnField) {
        if (!canPlaceFromGraveyardToField(ps)) return { ok: false, error: '相手の効果により、墓地のカードを戦場に置けません。' };
        ps.graveyard.splice(ps.graveyard.indexOf(target), 1);
        target.faceUp = true;
        if (tCard.type === 'ijin') {
          target.sick = true;
          ps.field.ijin.push(target);
        } else {
          target.tapped = false;
          ps.field.haikei.push(target);
        }
        return { ok: true };
      }
      if (!canReturnFromGraveyardToHand(ps)) return { ok: false, error: '相手の効果により、墓地のカードを手札に戻せません。' };
      ps.graveyard.splice(ps.graveyard.indexOf(target), 1);
      target.faceUp = true;
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
    case 'draw': {
      const result = resolveGenericEffect(game, ps, opp, eff, action.targetUid, null);
      if (!result.ok) return result;
      // ソリッドビジョン系: 指定色が自分の戦場か魔力ゾーンにあるなら、追加の効果を
      // 発揮してもよい(任意。プレイヤーがmagicActivateで発動を選んだ場合のみ)。
      if (eff.magicColor && eff.magicBonusType && action.magicActivate && hasColorInFieldOrMana(ps, eff.magicColor)) {
        switch (eff.magicBonusType) {
          case 'destroy_field_haikei': {
            const found = [...ps.field.haikei, ...opp.field.haikei].find((h) => h.uid === action.magicTargetUid);
            if (found) destroyFieldOrGuardian(game, ps.field.haikei.includes(found) ? ps : opp, found);
            break;
          }
          case 'draw_then_discard_2_own_hand': {
            drawCards(game, ps, 1);
            const pool = ps.hand.filter((c) => c.uid !== action.cardUid);
            const uids = [...new Set(action.magicTargetUids || [])].filter((uid) => pool.some((c) => c.uid === uid)).slice(0, Math.min(2, pool.length));
            for (const uid of uids) {
              const idx = ps.hand.findIndex((c) => c.uid === uid);
              if (idx === -1) continue;
              const [c] = ps.hand.splice(idx, 1);
              c.faceUp = true;
              ps.graveyard.push(c);
              fireOnDiscardedFromHandTrigger(game, ps, opp, c);
            }
            break;
          }
          case 'self_to_facedown_mana':
            result.selfToFacedownMana = true;
            break;
          case 'graveyard_nonmana_to_deck_top_or_bottom': {
            const idx = ps.graveyard.findIndex((c) => c.uid === action.magicTargetUid && getCard(c.cardId).type !== 'maryoku');
            if (idx !== -1) {
              const [c] = ps.graveyard.splice(idx, 1);
              c.faceUp = true;
              if (action.magicPosition === 'bottom') ps.deck.push(c);
              else ps.deck.unshift(c);
            }
            break;
          }
          case 'bounce_own_guardian': {
            const g = ps.guardians[0];
            if (g) {
              ps.guardians.splice(0, 1);
              g.faceUp = true;
              ps.hand.push(g);
            }
            break;
          }
          default:
            break;
        }
      }
      return result;
    }
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
    // ドロレス: 相手の手札を見てレベル3以上のカード1つを墓地に置く(発動者が選ぶ)。
    case 'discard_opponent_hand_card_level_at_least': {
      const pool = opp.hand.filter((c) => getCard(c.cardId).level >= eff.value);
      const chosenArr = chooseFromPool(game, ps, pool, action.targetUid, {
        cardName: card.name, poolZone: 'opponent_hand', label: '墓地に置く相手の手札',
        eff, card, min: Math.min(1, pool.length), max: 1, revealNames: true, resumeFn: 'resolveMahouEffect',
      });
      if (chosenArr === null) return { ok: true, pending: true };
      if (chosenArr.length === 0) return { ok: true };
      const c = chosenArr[0];
      opp.hand.splice(opp.hand.indexOf(c), 1);
      c.faceUp = true;
      opp.graveyard.push(c);
      fireOnDiscardedFromHandTrigger(game, opp, ps, c);
      return { ok: true };
    }
    case 'draw_then_discard_scaled_by_own_mana_colors': {
      drawCards(game, ps, 1);
      const colors = new Set();
      for (const m of ps.mana) if (m.faceUp) getCard(m.cardId).colors.forEach((c) => colors.add(c));
      const pool = ps.hand.filter((c) => c.uid !== action.cardUid);
      const requiredCount = Math.min(colors.size, pool.length);
      const uids = [...new Set(action.targetUids || [])].filter((uid) => pool.some((c) => c.uid === uid));
      if (uids.length !== requiredCount) {
        return { ok: false, error: `墓地に置く手札を${requiredCount}枚選んでください。` };
      }
      for (const uid of uids) {
        const idx = ps.hand.findIndex((c) => c.uid === uid);
        if (idx === -1) continue;
        const [target] = ps.hand.splice(idx, 1);
        target.faceUp = true;
        ps.graveyard.push(target);
        fireOnDiscardedFromHandTrigger(game, ps, opp, target);
      }
      return { ok: true };
    }
    case 'conditional_graveyard_mahou_level_sum_at_least': {
      const sum = ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou').reduce((s, c) => s + getCard(c.cardId).level, 0);
      if (sum >= eff.value) {
        const pool = ps.hand.filter((c) => c.uid !== action.cardUid);
        if (pool.length === 0) return { ok: true };
        const idx = ps.hand.findIndex((c) => c.uid === action.targetUid && c.uid !== action.cardUid);
        if (idx === -1) return { ok: false, error: '墓地に置く手札を選んでください。' };
        const [target] = ps.hand.splice(idx, 1);
        target.faceUp = true;
        ps.graveyard.push(target);
        fireOnDiscardedFromHandTrigger(game, ps, opp, target);
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
        fireOnDiscardedFromHandTrigger(game, ps, opp, c);
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
      let destroyedCount = 0;
      for (const uid of uids) {
        const own = ps.field.haikei.find((h) => h.uid === uid);
        const target = own || opp.field.haikei.find((h) => h.uid === uid);
        const owner = own ? ps : opp;
        if (target) { destroyFieldOrGuardian(game, owner, target); destroyedCount += 1; }
      }
      // 赤魔導: 赤のカードが自分の戦場か魔力ゾーンにあるなら、破壊したハイケイ1つにつき1ドロー。
      if (eff.magicColor && destroyedCount > 0 && hasColorInFieldOrMana(ps, eff.magicColor)) {
        drawCards(game, ps, destroyedCount);
      }
      return { ok: true };
    }
    case 'multi_tap_field_ijin_scaled_by_own_colors': {
      const uids = action.targetUids || [];
      const colors = new Set();
      for (const i of ps.field.ijin) getCard(i.cardId).colors.forEach((c) => colors.add(c));
      if (uids.length > colors.size) return { ok: false, error: `イジンは最大${colors.size}体まで指定できます。` };
      // 青魔導: 青のカードが自分の戦場か魔力ゾーンにあるなら、寝かされたイジンはこの
      // ターンと次のターンの間起きない(次回の起こし処理を1回スキップする)。
      const magicActive = eff.magicColor && hasColorInFieldOrMana(ps, eff.magicColor);
      for (const uid of uids) {
        const target = [...ps.field.ijin, ...opp.field.ijin].find((i) => i.uid === uid);
        if (target) {
          target.tapped = true;
          if (magicActive) target.skipNextUntap = true;
        }
      }
      return { ok: true };
    }
    case 'multi_bounce_graveyard_mana_scaled_by_own_colors': {
      const uids = action.targetUids || [];
      const colors = new Set();
      for (const i of ps.field.ijin) getCard(i.cardId).colors.forEach((c) => colors.add(c));
      if (uids.length > colors.size) return { ok: false, error: `マリョクは最大${colors.size}つまで指定できます。` };
      // 緑魔導: 緑のカードが自分の戦場か魔力ゾーンにあるなら、手札に戻す代わりに
      // 魔力ゾーンに表向きで置く。
      const magicActive = eff.magicColor && hasColorInFieldOrMana(ps, eff.magicColor);
      if (!magicActive && !canReturnFromGraveyardToHand(ps)) return { ok: true };
      for (const uid of uids) {
        const idx = ps.graveyard.findIndex((c) => c.uid === uid && getCard(c.cardId).type === 'maryoku');
        if (idx !== -1) {
          const [c] = ps.graveyard.splice(idx, 1);
          c.faceUp = true;
          if (magicActive) {
            c.tapped = false;
            ps.mana.push(c);
          } else {
            ps.hand.push(c);
          }
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
        const idx = ps.hand.findIndex((c) => c.uid === action.targetUid && c.uid !== action.cardUid);
        if (idx === -1) return { ok: false, error: '墓地に置く手札を選んでください。' };
        const [target] = ps.hand.splice(idx, 1);
        target.faceUp = true;
        ps.graveyard.push(target);
        fireOnDiscardedFromHandTrigger(game, ps, opp, target);
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
      fireOnManaLeftViaAbility(game, owner, owner === ps ? opp : ps);
      ps.cannotCastMahouThisTurn = true;
      return { ok: true };
    }
    case 'discard_hand_then_graveyard_to_hand_then_cannot_cast_mahou': {
      for (const c of ps.hand.filter((c) => c.uid !== action.cardUid).slice()) {
        ps.hand.splice(ps.hand.indexOf(c), 1);
        c.faceUp = true;
        ps.graveyard.push(c);
        fireOnDiscardedFromHandTrigger(game, ps, opp, c);
      }
      if (canReturnFromGraveyardToHand(ps)) {
        // クライアントは「捨てる直前の手札+現在の墓地」の合算プールから4枚を選ばせる
        // (それらの手札はこの時点で全て墓地に移動済みなので、同じuidで引ける)。
        const requestedUids = [...new Set(action.targetUids || [])];
        const requiredCount = Math.min(4, ps.graveyard.length);
        const uids = requestedUids.filter((uid) => ps.graveyard.some((c) => c.uid === uid)).slice(0, requiredCount);
        if (uids.length !== requiredCount) {
          return { ok: false, error: `手札に加える墓地のカードを${requiredCount}枚選んでください。` };
        }
        for (const uid of uids) {
          const c = ps.graveyard.find((cc) => cc.uid === uid);
          if (!c) continue;
          ps.graveyard.splice(ps.graveyard.indexOf(c), 1);
          c.faceUp = true;
          ps.hand.push(c);
        }
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
      // 赤魔導: 赤のカードが自分の戦場か魔力ゾーンにあるなら、相手の墓地のマリョクでない
      // カード3つまでを山札の下に戻す(自由選択・任意)。
      if (eff.magicColor && hasColorInFieldOrMana(ps, eff.magicColor)) {
        const oppPool = opp.graveyard.filter((c) => getCard(c.cardId).type !== 'maryoku');
        const uids = [...new Set(action.magicTargetUids || [])].filter((uid) => oppPool.some((c) => c.uid === uid)).slice(0, 3);
        for (const uid of uids) {
          const c = opp.graveyard.find((cc) => cc.uid === uid);
          if (!c) continue;
          opp.graveyard.splice(opp.graveyard.indexOf(c), 1);
          c.faceUp = true;
          opp.deck.push(c);
        }
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
          fireOnDiscardedFromHandTrigger(game, opp, ps, c);
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
      const loserOpp = loser === ps ? opp : ps;
      for (const c of loser.hand.filter((c) => c.uid !== action.cardUid).slice()) {
        loser.hand.splice(loser.hand.indexOf(c), 1);
        c.faceUp = true;
        loser.graveyard.push(c);
        fireOnDiscardedFromHandTrigger(game, loser, loserOpp, c);
      }
      return { ok: true };
    }
    case 'mill_opponent_scaled_by_tapped_field_both_sides_times3': {
      const tappedCount = [...ps.field.ijin, ...ps.field.haikei, ...opp.field.ijin, ...opp.field.haikei].filter((c) => c.tapped).length;
      const n = tappedCount * 3;
      for (let i = 0; i < n; i++) {
        if (opp.deck.length === 0 || opp.preventDeckToGraveyardMillThisTurn) break;
        const c = opp.deck.shift();
        c.faceUp = true;
        opp.graveyard.push(c);
        checkMilledCardForForcedTurnEnd(game, opp, getCard(c.cardId), c);
      }
      return { ok: true };
    }
    case 'bounce_all_mana_both_sides_to_hand': {
      const psMoved = ps.mana.length > 0;
      for (const m of ps.mana.slice()) {
        ps.mana.splice(ps.mana.indexOf(m), 1);
        m.faceUp = true;
        ps.hand.push(m);
      }
      const oppMoved = opp.mana.length > 0;
      for (const m of opp.mana.slice()) {
        opp.mana.splice(opp.mana.indexOf(m), 1);
        m.faceUp = true;
        opp.hand.push(m);
      }
      if (psMoved) fireOnManaLeftViaAbility(game, ps, opp);
      if (oppMoved) fireOnManaLeftViaAbility(game, opp, ps);
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
        if (ps.deck.length === 0 || ps.preventDeckToGraveyardMillThisTurn) break;
        const c = ps.deck.shift();
        c.faceUp = true;
        ps.graveyard.push(c);
        checkMilledCardForForcedTurnEnd(game, ps, getCard(c.cardId), c);
      }
      if (!action.targetUid) return { ok: true };
      if (!canPlaceFromGraveyardToField(ps)) return { ok: false, error: '相手の効果により、墓地のカードを戦場に置けません。' };
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
    case 'move_opponent_ijin_or_haikei_to_their_guardian_by_uid': {
      const result = resolveGenericEffect(game, ps, opp, eff, action.targetUid, null);
      if (!result.ok) return result;
      // 青魔導: 青のカードが自分の戦場か魔力ゾーンにあるなら、相手の戦場のガーディアン
      // 1体を相手の手札に戻してもよい(任意)。
      if (eff.magicColor && hasColorInFieldOrMana(ps, eff.magicColor) && action.magicTargetUid) {
        const g = opp.guardians.find((gg) => gg.uid === action.magicTargetUid);
        if (g) {
          opp.guardians.splice(opp.guardians.indexOf(g), 1);
          g.faceUp = true;
          opp.hand.push(g);
        }
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
    case 'flip_own_guardian_or_facedown_mana_by_uid':
    case 'reveal_opponent_guardians_and_facedown_mana':
      return resolveGenericEffect(game, ps, opp, eff, action.targetUid, null);
    default:
      return { ok: true };
  }
}

// ---------- バトル ----------

// オリーブの枝: これが自分か相手の魔力ゾーンに表向きである間、自分と相手の戦場の
// レベルX以上でないイジンは、アタッカーにもブロッカーにもなれない。両陣営とも同じ
// カードなので、最も高い閾値を1つだけ返す(通常は同時に複数存在しない想定)。
function attackBlockLevelRestriction(ps, opp) {
  let threshold = null;
  for (const side of [ps, opp]) {
    for (const m of side.mana) {
      if (!m.faceUp) continue;
      const kw = getCard(m.cardId).keywords;
      if (kw && kw.forbidAttackBlockBelowLevelGlobally != null) {
        threshold = threshold == null ? kw.forbidAttackBlockBelowLevelGlobally : Math.max(threshold, kw.forbidAttackBlockBelowLevelGlobally);
      }
    }
  }
  return threshold;
}

function declareAttack(game, playerId, action) {
  const ps = game.playerStates[playerId];
  if (ps.cannotAttackThisTurn) return { ok: false, error: 'このターンはバトルを開始できません。' };
  if (ps.attackedThisTurn && !ps.extraBattleAvailable) return { ok: false, error: 'このターンはすでにバトルを行いました。' };
  const uids = action.attackerUids || [];
  if (uids.length === 0) return { ok: false, error: 'アタッカーを1体以上選んでください。' };

  const opp = game.playerStates[opponentId(game, playerId)];

  // 安宅船: 「これをアタッカーに選ぶ限り、寝ているイジンもアタッカーに選べる」
  const allowTappedAttackers = uids.some((uid) => {
    const inst = ps.field.ijin.find((i) => i.uid === uid);
    const grant = inst && equippedGrant(inst);
    return !!(inst && !inst.tapped && grant && grant.allowTappedAlliesToAttack);
  });

  // 円形闘技場: 自分のターンの間、自分の戦場のガーディアンは「即応」を持つパワー3000の
  // イジンでもある。ガーディアンは元のカードの能力・特性・レベル等を一切持たない、
  // パワー3000固定の匿名の攻撃者として扱う(本来のカードは伏せられたまま)。
  const hasColosseum = ps.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.guardiansCanAttackAsPower3000Ijin;
  });

  const attackBlockLevelMin = attackBlockLevelRestriction(ps, opp);

  const attackers = [];
  const guardianAttackerUids = new Set();
  for (const uid of uids) {
    let inst = ps.field.ijin.find((i) => i.uid === uid);
    if (inst) {
      if (inst.tapped && !allowTappedAttackers) return { ok: false, error: '寝ているイジンはアタッカーになれません。' };
      const rush = hasEffectiveRush(inst, ps);
      if (inst.sick && !rush) return { ok: false, error: 'このターンに出したばかりのイジンはアタッカーになれません(即応を除く)。' };
      if (attackContextPower(inst, ps, opp) <= 0) return { ok: false, error: 'パワー0以下のイジンはアタッカーになれません。' };
      if (attackBlockLevelMin != null && getCard(inst.cardId).level < attackBlockLevelMin) return { ok: false, error: `レベル${attackBlockLevelMin}以上でないイジンはアタッカーになれません。` };
      attackers.push(inst);
      continue;
    }
    if (hasColosseum) {
      inst = ps.guardians.find((g) => g.uid === uid);
      if (inst) {
        if (inst.tapped) return { ok: false, error: '寝ているガーディアンはアタッカーになれません。' };
        attackers.push(inst);
        guardianAttackerUids.add(uid);
        continue;
      }
    }
    return { ok: false, error: '対象のイジンが見つかりません。' };
  }
  for (const a of attackers) a.tapped = true;
  fireOnIjinTappedByAttackTriggers(game, ps, opp, attackers.filter((a) => !guardianAttackerUids.has(a.uid)));

  // 大久保利通: 自分がイジン1体だけでアタックし、そのイジンがレベル6以上なら、
  // アタッカーすべてはこのターンに限り「イジンにブロックされない」を得る。
  // (円形闘技場のガーディアンアタッカーには本来のレベルがないため対象外)
  if (attackers.length === 1 && !guardianAttackerUids.has(attackers[0].uid) && getCard(attackers[0].cardId).level >= 6) {
    const hasOkubo = ps.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.grantUnblockableByIjinIfSoloHighLevelAttacker;
    });
    if (hasOkubo) for (const a of attackers) a.unblockableByIjin = true;
  }

  // 淀殿: 自分が1体だけでアタックしたとき、戦場のハイケイ3つまでを指定して発動できる。
  // それらのハイケイすべてを破壊する(簡略化として、相手のハイケイを優先して自動選択する)。
  if (attackers.length === 1 && !guardianAttackerUids.has(attackers[0].uid) && ps.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.destroyUpToThreeFieldHaikeiOnSoloAttack;
  })) {
    const pool = [...opp.field.haikei, ...ps.field.haikei].slice(0, 3);
    for (const h of pool) destroyFieldOrGuardian(game, opp.field.haikei.includes(h) ? opp : ps, h);
  }

  // 純白の塔: 自分が3体以上でアタックしたとき、アタッカー1体を指定して発動できる。
  // そのアタッカーは、このターンの間「イジンにブロックされない」を得る
  // (対象は最もパワーの高いアタッカーを自動選択する)。
  if (attackers.length >= 3 && ps.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.grantUnblockableByIjinIfThreeOrMoreAttackers;
  })) {
    const nonGuardianAttackers = attackers.filter((a) => !guardianAttackerUids.has(a.uid));
    const best = nonGuardianAttackers.sort((a, b) => effectivePower(b, ps) - effectivePower(a, ps))[0];
    if (best) best.unblockableByIjin = true;
  }

  // 円形闘技場のガーディアンアタッカーは本来の能力を持たないため、アタッカーになったとき系の
  // トリガーは発動しない。
  const attackerTriggerTargets = action.attackerTriggerTargets || {};
  for (const a of attackers) {
    if (guardianAttackerUids.has(a.uid)) continue;
    const aCard = getCard(a.cardId);
    fireOnAttackerTrigger(game, ps, opp, a, aCard, attackerTriggerTargets[a.uid]);
    fireOnAllyAttackerTriggers(game, ps, opp, a, aCard);
  }

  // ニコライ・レザノフ: 航海 - アタッカーになったときに発動する。『ブロック+』能力を持つ
  // アタッカーすべては、このターンに限り「ガーディアンにブロックされたとき、これを起こす」を得る。
  const nicolaySource = attackers.find((a) => !guardianAttackerUids.has(a.uid) && (() => { const kw = getCard(a.cardId).keywords; return kw && kw.grantGuardianUntapToBlockBonusAttackers; })());
  if (nicolaySource) {
    for (const a of attackers) {
      if (guardianAttackerUids.has(a.uid)) continue;
      const grant = equippedGrant(a);
      const hasBlockBonus = !!((getCard(a.cardId).keywords && getCard(a.cardId).keywords.blockBonus) || (grant && grant.blockBonus));
      if (hasBlockBonus) a.untapsWhenBlockedByGuardianThisTurn = true;
    }
    fireOnKokaiActivatedObservers(game, ps, opp, nicolaySource);
  }

  if (ps.extraBattleAvailable) ps.extraBattleAvailable = false;
  else ps.attackedThisTurn = true;

  game.pendingBattle = {
    attackerPlayerId: playerId,
    attackers: attackers.map((a) => ({ uid: a.uid, blockers: [], isGuardianAttacker: guardianAttackerUids.has(a.uid) })),
  };
  game.phase = 'block';
  log(game, `${ps.name}が${attackers.length}体でアタックしました。`);
  fireManaBlockStepRevealTriggers(game, opp, ps);

  // リヴァイアサン: 相手がアタックしたとき、自分の戦場のイジンをすきなだけ起こして、
  // ガーディアンにする(簡略化として、寝ているイジンすべてを対象に自動発動する)。
  if (opp.field.haikei.some((h) => {
    const kw = getCard(h.cardId).keywords;
    return kw && kw.untapOwnIjinToGuardianOnOpponentAttack;
  })) {
    for (const inst of opp.field.ijin.filter((i) => i.tapped).slice()) {
      detachEquipmentIfAny(opp, inst);
      opp.field.ijin.splice(opp.field.ijin.indexOf(inst), 1);
      inst.tapped = false;
      inst.faceUp = false;
      opp.guardians.push(inst);
    }
  }
  checkAndProcessForcedTurnEnd(game);
  return { ok: true };
}

// 遁甲盤・遁甲式烈火/水鏡/木蓮: 相手のターンのブロックステップが開始したとき、魔力ゾーンに
// 裏で置かれているこれを表にして発動できる能力。「発動できる」だが常に防御側に有利な
// 効果のみのため、本アプリの既存方針(アンリ4世等)に合わせて自動発動とする。
function fireManaBlockStepRevealTriggers(game, defenderPs, attackerPs) {
  for (const instance of defenderPs.mana.filter((m) => !m.faceUp)) {
    if (game.winner) break;
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onOpponentBlockStepStart;
    if (!trig) continue;
    instance.faceUp = true;
    const result = resolveGenericEffectMaybeArray(game, defenderPs, attackerPs, trig.effect, null, instance);
    if (result.ok) {
      log(game, `${defenderPs.name}の「${card.name}」の能力が発動しました。`);
    }
  }
  // 高野長英: 相手のターンのブロックステップが開始したとき、自分の魔力ゾーンのカード1つを
  // 墓地に置いて発動できる。自分の戦場のカードすべてを起こす(魔力ゾーンにカードがある
  // 限り自動発動する)。
  for (const instance of defenderPs.field.ijin) {
    if (game.winner) break;
    const card = getCard(instance.cardId);
    const trig = card.triggers && card.triggers.onOpponentBlockStepStartPayMana;
    if (!trig) continue;
    if (isAbilitySuppressed(instance, defenderPs, attackerPs)) continue;
    if (defenderPs.mana.length === 0) continue;
    const paid = defenderPs.mana.shift();
    paid.faceUp = true;
    defenderPs.graveyard.push(paid);
    const result = resolveGenericEffectMaybeArray(game, defenderPs, attackerPs, trig.effect, null, instance);
    if (result.ok) {
      log(game, `${defenderPs.name}の「${card.name}」の能力が発動しました。`);
    }
  }
}

function declareBlock(game, playerId, action) {
  if (!game.pendingBattle) return { ok: false, error: 'バトル中ではありません。' };
  const defenderId = playerId;
  if (game.pendingBattle.attackerPlayerId === defenderId) return { ok: false, error: '防御側ではありません。' };
  const defender = game.playerStates[defenderId];
  const attackerPs = game.playerStates[game.pendingBattle.attackerPlayerId];

  // 英傑集う大河: 相手が3体以上でアタックしたとき、アタッカー1体を指定して発動できる。
  // そのアタッカーをアタッカーでない状態にして、これを破壊する。
  if (action.eiketsuHaikeiUid && action.eiketsuTargetAttackerUid && game.pendingBattle.attackers.length >= 3) {
    const eiketsu = defender.field.haikei.find((h) => {
      if (h.uid !== action.eiketsuHaikeiUid) return false;
      const kw = getCard(h.cardId).keywords;
      return kw && kw.removeAttackerAndDestroySelfIfThreeOrMoreAttackers;
    });
    const idx = game.pendingBattle.attackers.findIndex((e) => e.uid === action.eiketsuTargetAttackerUid);
    if (eiketsu && idx !== -1) {
      game.pendingBattle.attackers.splice(idx, 1);
      destroyFieldOrGuardian(game, defender, eiketsu);
      log(game, `${defender.name}の英傑集う大河の効果で、相手のアタッカー1体をアタッカーでない状態にしました。`);
    }
  }

  const assignments = action.assignments || {};
  const usedBlockers = new Set();

  // 山田長政: 前のアタック宣言で「次のブロックステップに際しこれをブロックする」を
  // 強制されたイジンがいれば、そのブロック指定を自動的に追加する
  // (未タップ・存命であれば、プレイヤーの選択に上書きではなく追加する)。
  for (const entry of game.pendingBattle.attackers) {
    const forcedBlocker = defender.field.ijin.find((i) => i.forcedToBlockAttackerUid === entry.uid && !i.tapped);
    if (forcedBlocker) {
      const list = assignments[entry.uid] ? assignments[entry.uid].slice() : [];
      if (!list.includes(forcedBlocker.uid)) list.push(forcedBlocker.uid);
      assignments[entry.uid] = list;
    }
  }
  for (const i of defender.field.ijin) i.forcedToBlockAttackerUid = null;

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
            fireOnManaLeftViaAbility(game, defender, attackerPs);
            log(game, `${defender.name}がスタンドで「${mCard.name}」を戦場に置き、ブロッカーにしました。`);
          }
        }
      }
      if (!inst) return { ok: false, error: 'ブロッカーが見つかりません。' };
      const card = isGuardian ? null : getCard(inst.cardId);
      const instEquipGrant = isGuardian ? null : equippedGrant(inst);
      // 一遍: 自分の墓地にカードがない間「ウォッチャー」を得る。
      const watcherFromIchihen = !!(card && card.keywords && card.keywords.watcherIfOwnGraveyardEmpty && defender.graveyard.length === 0);
      // 姜維: これが戦場にいる間、自分の戦場の他の黄のイジンは「ウォッチャー」を得る。
      const watcherFromJiangWei = !!(card && card.colors.includes('yellow') && defender.field.ijin.some((i) => i.uid !== inst.uid && (getCard(i.cardId).keywords || {}).grantRushWatcherPowerToOtherYellowIjin));
      // 仁王: イジンが自分の戦場にちょうど2体いる間、自分の戦場のイジンは「ウォッチャー」を得る。
      const watcherFromNiou = !!(card && defender.field.ijin.length === 2 && defender.field.haikei.some((h) => {
        const kw = getCard(h.cardId).keywords;
        return kw && kw.grantWatcherIfOwnFieldIjinCountExactlyTwo;
      }));
      const watcher = card && ((card.keywords && card.keywords.watcher) || (instEquipGrant && instEquipGrant.watcher) || watcherFromIchihen || watcherFromJiangWei || watcherFromNiou);
      if (inst.tapped && !watcher) return { ok: false, error: '寝ているカードはブロッカーになれません(ウォッチャーを除く)。' };
      if (card && card.static && card.static.cannotBlock) return { ok: false, error: `「${card.name}」はブロッカーになれません。` };
      // オリーブの枝: レベルX以上でないイジンはブロッカーになれない(ガーディアンは対象外)。
      const blockLevelMin = attackBlockLevelRestriction(defender, attackerPs);
      if (card && blockLevelMin != null && card.level < blockLevelMin) {
        return { ok: false, error: `レベル${blockLevelMin}以上でないイジンはブロッカーになれません。` };
      }
      // 伊達政宗: 装備していない間、ブロッカーになれない。
      if (card && card.keywords && card.keywords.cannotBlockIfUnequipped && !inst.equippedCard) {
        return { ok: false, error: `「${card.name}」は装備していないためブロッカーになれません。` };
      }
      usedBlockers.add(buid);
      blockers.push({ uid: buid, isGuardian, card });
    }

    const attackerInst = entry.isGuardianAttacker
      ? attackerPs.guardians.find((g) => g.uid === entry.uid)
      : attackerPs.field.ijin.find((i) => i.uid === entry.uid);
    if (!attackerInst) {
      // アタッカーになった後の能力等ですでに戦場を離れている場合、このアタッカーは戦闘に参加しない
      entry.blockers = [];
      continue;
    }
    // 円形闘技場のガーディアンアタッカーは本来のカードの能力・静的効果を一切持たない
    // (伏せられたままの匿名の攻撃者)ため、空のカード情報として扱う。
    const attackerCard = entry.isGuardianAttacker ? { keywords: {}, static: null } : getCard(attackerInst.cardId);
    const attackerPower = entry.isGuardianAttacker ? 3000 : attackContextPower(attackerInst, attackerPs, defender);
    // 玄宗: これが戦場にいる間、自分の戦場のガーディアンはパワー6000以上のアタッカーを
    // 指定してブロッカーになれない。
    if (defender.field.ijin.some((i) => {
      const kw = getCard(i.cardId).keywords;
      return kw && kw.forbidGuardianBlockAgainstHighPowerAttacker;
    }) && attackerPower >= 6000) {
      const blockedByGuardian = blockers.some((b) => b.isGuardian);
      if (blockedByGuardian) return { ok: false, error: 'このアタッカーはパワー6000以上のため、ガーディアンはブロッカーになれません。' };
    }
    if (attackerCard.static && attackerCard.static.unblockableBelowPower != null) {
      const threshold = attackerCard.static.unblockableBelowPower;
      const blockedByLowPowerIjin = blockers.some((b) => !b.isGuardian && blockContextPower(defender.field.ijin.find((i) => i.uid === b.uid), defender) <= threshold);
      if (blockedByLowPowerIjin) return { ok: false, error: `このアタッカーはパワー${threshold}以下のイジンにブロックされません。` };
    }
    // クリストファー・コロンブス等: イジンからブロックされない(パワーを問わない絶対的な不可)。
    if (attackerCard.static && attackerCard.static.unblockableByIjin) {
      const blockedByIjin = blockers.some((b) => !b.isGuardian);
      if (blockedByIjin) return { ok: false, error: 'このアタッカーはイジンにブロックされません。' };
    }
    // ロベルト・コッホ: これが戦場にいる間、自分の戦場の特定特性のイジンは
    // 「パワーX以下のイジンからブロックされない」を得る。
    if (!entry.isGuardianAttacker) {
      const kochGrant = attackerPs.field.ijin.find((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && kw.grantUnblockableByPowerAtMostToTraitIjin && hasEffectiveTrait(attackerInst, kw.grantUnblockableByPowerAtMostToTraitIjin.trait, attackerPs);
      });
      if (kochGrant) {
        const threshold = getCard(kochGrant.cardId).keywords.grantUnblockableByPowerAtMostToTraitIjin.value;
        const blockedByLowPowerIjin = blockers.some((b) => !b.isGuardian && blockContextPower(defender.field.ijin.find((i) => i.uid === b.uid), defender) <= threshold);
        if (blockedByLowPowerIjin) return { ok: false, error: `このアタッカーはパワー${threshold}以下のイジンにブロックされません。` };
      }
    }
    if (attackerInst.tempUnblockableAtLeastPowerThisTurn != null) {
      const threshold = attackerInst.tempUnblockableAtLeastPowerThisTurn;
      const blockedByHighPowerIjin = blockers.some((b) => !b.isGuardian && blockContextPower(defender.field.ijin.find((i) => i.uid === b.uid), defender) >= threshold);
      if (blockedByHighPowerIjin) return { ok: false, error: `このアタッカーはパワー${threshold}以上のイジンにブロックされません。` };
    }
    const attackerEquipGrant = equippedGrant(attackerInst);
    let dynamicPressure = 0;
    const akw = attackerCard.keywords;
    // 武帝・ジョン・ハンター: 自身のパワーが一定以上ならプレッシャーを得る。
    if (akw && akw.pressureIfOwnPowerAtLeast && attackerPower >= akw.pressureIfOwnPowerAtLeast.threshold) {
      dynamicPressure = Math.max(dynamicPressure, akw.pressureIfOwnPowerAtLeast.value);
    }
    // 北条時宗: ガーディアンが相手の戦場に一定数以上いる間プレッシャーを得る。
    if (akw && akw.pressureIfOpponentGuardianCountAtLeast && defender.guardians.length >= akw.pressureIfOpponentGuardianCountAtLeast.threshold) {
      dynamicPressure = Math.max(dynamicPressure, akw.pressureIfOpponentGuardianCountAtLeast.value);
    }
    // 一遍: 相手の墓地にカードがない間、プレッシャーを得る。
    if (akw && akw.pressureIfOpponentGraveyardEmpty && defender.graveyard.length === 0) {
      dynamicPressure = Math.max(dynamicPressure, akw.pressureIfOpponentGraveyardEmpty);
    }
    // アントワーヌ・ラヴォアジエ: 躍進 - このターンに魔力ゾーンの能力によって山札から
    // カードを引いているなら、ダブルプレッシャーを得る。
    if (akw && akw.pressureIfYakushin && attackerPs.drewViaManaAbilityThisTurn) {
      dynamicPressure = Math.max(dynamicPressure, akw.pressureIfYakushin);
    }
    const effectivePressure = attackerInst.tempPressureOverrideThisTurn != null
      ? attackerInst.tempPressureOverrideThisTurn
      : ((akw && akw.pressure) || (attackerEquipGrant && attackerEquipGrant.pressure) || dynamicPressure);
    if (effectivePressure) {
      if (blockers.length < effectivePressure) {
        entry.blockers = [];
        continue;
      }
    }
    // ティムール: これは赤のイジンにも青のイジンにもブロックされない。
    if (akw && akw.unblockableByColors) {
      const blockedByForbiddenColor = blockers.some((b) => {
        if (b.isGuardian) return false;
        const bInst = defender.field.ijin.find((i) => i.uid === b.uid);
        return bInst && akw.unblockableByColors.some((c) => effectiveColors(bInst, defender).includes(c));
      });
      if (blockedByForbiddenColor) return { ok: false, error: `このアタッカーは${akw.unblockableByColors.join('・')}のイジンにブロックされません。` };
    }
    // 火と氷の大地: これが戦場にある間、自分の戦場の青のイジンは「赤のイジンにブロックされない」を得る。
    if (!entry.isGuardianAttacker) {
      const grantedUnblockable = attackerPs.field.haikei.find((h) => {
        const kw = getCard(h.cardId).keywords;
        return kw && kw.grantAllyColorUnblockableByColor && effectiveColors(attackerInst, attackerPs).includes(kw.grantAllyColorUnblockableByColor.allyColor);
      });
      if (grantedUnblockable) {
        const enemyColor = getCard(grantedUnblockable.cardId).keywords.grantAllyColorUnblockableByColor.enemyColor;
        const blockedByEnemyColor = blockers.some((b) => {
          if (b.isGuardian) return false;
          const bInst = defender.field.ijin.find((i) => i.uid === b.uid);
          return bInst && effectiveColors(bInst, defender).includes(enemyColor);
        });
        if (blockedByEnemyColor) return { ok: false, error: `このアタッカーは${enemyColor}のイジンにブロックされません。` };
      }
    }
    if (attackerInst.unblockableByIjin) {
      const nonGuardian = blockers.some((b) => !b.isGuardian);
      if (nonGuardian) return { ok: false, error: 'このアタッカーはイジンにブロックされません。ガーディアンのみ指定できます。' };
    }
    // マルコ＝ポーロ: 躍進(このターンに魔力ゾーンの能力によって山札からカードを引いていて、
    // 自分と相手の戦場にハイケイが合計4つ以上あるなら)を満たす間、ガーディアンにブロックされない。
    if (attackerCard.keywords && attackerCard.keywords.unblockableByGuardianIfYakushinCondition
      && attackerPs.drewViaManaAbilityThisTurn
      && haikeiFieldCount(attackerPs) + haikeiFieldCount(defender) >= 4) {
      const blockedByGuardian = blockers.some((b) => b.isGuardian);
      if (blockedByGuardian) return { ok: false, error: 'このアタッカーはガーディアンにブロックされません。' };
    }
    entry.blockers = blockers;
    // 演出用: どのアタッカーが何体でブロックされたかをログに残す(クライアント側の
    // バトル演出が、この行を見て「ブロック成立」を表示できるようにするため)。
    if (blockers.length > 0) {
      const atkName = entry.isGuardianAttacker ? 'ガーディアン' : attackerCard.name;
      log(game, `${defender.name}が「${atkName}」を${blockers.length}体でブロックしました。`);
    }
  }

  const blockerTriggerTargets = action.blockerTriggerTargets || {};
  for (const entry of game.pendingBattle.attackers) {
    for (const b of entry.blockers) {
      if (b.isGuardian) continue;
      const bInst = defender.field.ijin.find((i) => i.uid === b.uid);
      if (bInst) fireOnBecomeBlockerTrigger(game, defender, attackerPs, bInst, b.card, blockerTriggerTargets[b.uid]);
    }
  }

  // アンリ4世: これがブロックされたときに発動できる。イジン召喚権+1して、これとこれを
  // ブロックしているブロッカーすべてを手札に戻す(発動すると、このアタッカーはバトル解決から
  // 除外される。「発動できる」の任意選択は、ほぼ常に有利な効果であるため本アプリでは自動発動とする)。
  for (const entry of game.pendingBattle.attackers) {
    if (entry.isGuardianAttacker || entry.blockers.length === 0) continue;
    const attackerInst = attackerPs.field.ijin.find((i) => i.uid === entry.uid);
    if (!attackerInst) continue;
    const attackerCard = getCard(attackerInst.cardId);
    if (!(attackerCard.keywords && attackerCard.keywords.onSelfBlockedBounceSelfAndBlockersPlusSummonRight)) continue;
    if (isAbilitySuppressed(attackerInst, attackerPs, defender)) continue;
    attackerPs.summonRight += 1;
    detachEquipmentIfAny(attackerPs, attackerInst);
    attackerPs.field.ijin.splice(attackerPs.field.ijin.indexOf(attackerInst), 1);
    attackerInst.faceUp = true;
    attackerPs.hand.push(attackerInst);
    for (const b of entry.blockers) {
      if (b.isGuardian) {
        const gInst = defender.guardians.find((g) => g.uid === b.uid);
        if (!gInst) continue;
        defender.guardians.splice(defender.guardians.indexOf(gInst), 1);
        gInst.faceUp = true;
        defender.hand.push(gInst);
      } else {
        const bInst = defender.field.ijin.find((i) => i.uid === b.uid);
        if (!bInst) continue;
        detachEquipmentIfAny(defender, bInst);
        defender.field.ijin.splice(defender.field.ijin.indexOf(bInst), 1);
        bInst.faceUp = true;
        defender.hand.push(bInst);
      }
    }
    entry.blockers = [];
    log(game, `${attackerPs.name}の「${attackerCard.name}」の能力で、これとブロッカーすべてが手札に戻りました。`);
  }

  const battleResult = resolveBattle(game);
  checkAndProcessForcedTurnEnd(game);
  return battleResult;
}

function fireOnBecomeBlockerTrigger(game, ps, opp, instance, card, targetUid) {
  const trig = card.triggers && card.triggers.onBecomeBlocker;
  if (!trig) return;
  if (isAbilitySuppressed(instance, ps, opp)) return;
  if (!checkTriggerCondition(ps, opp, trig.condition, instance)) return;
  const result = resolveGenericEffectMaybeArray(game, ps, opp, trig.effect, targetUid, instance);
  if (result.ok) {
    log(game, `${ps.name}の「${card.name}」の能力(ブロッカーになったとき)が発動しました。`);
  }
}

// 岡田以蔵・孫権: 「(自分/味方が)寝たとき」系の能力。
// タップされる経路は多数存在するが(アタック宣言・能力によるタップ等)、本アプリでは
// 最も一般的かつルール上重要な「アタック宣言によるタップ」のタイミングでのみ発動する
// 簡略化を採用する(能力による強制タップは対象外)。
function fireOnIjinTappedByAttackTriggers(game, ps, opp, tappedInstances) {
  for (const inst of tappedInstances) {
    const card = getCard(inst.cardId);
    if (card.type !== 'ijin') continue;
    if (isAbilitySuppressed(inst, ps, opp)) continue;
    // 松永久秀: これが寝たとき、自分と相手それぞれの山札の上からカード1つずつを墓地に
    // 置いて発動できる。そのカードのレベルが高い方のプレイヤーの戦場のガーディアン1体を
    // 手札に戻す(簡略化として、アタック宣言によるタップのみを対象とする)。
    if (card.keywords && card.keywords.compareDeckTopLevelsOnSelfTapBounceGuardian) {
      if (ps.deck.length > 0 && opp.deck.length > 0) {
        const psCard = ps.deck.shift();
        psCard.faceUp = true;
        ps.graveyard.push(psCard);
        checkMilledCardForForcedTurnEnd(game, ps, getCard(psCard.cardId), psCard);
        const oppCard = opp.deck.shift();
        oppCard.faceUp = true;
        opp.graveyard.push(oppCard);
        checkMilledCardForForcedTurnEnd(game, opp, getCard(oppCard.cardId), oppCard);
        const winnerSide = getCard(psCard.cardId).level >= getCard(oppCard.cardId).level ? ps : opp;
        if (winnerSide.guardians.length > 0) {
          const g = winnerSide.guardians[0];
          winnerSide.guardians.splice(0, 1);
          g.faceUp = true;
          winnerSide.hand.push(g);
        }
        log(game, `${ps.name}の「${card.name}」の効果が発動しました。`);
      }
    }
    // 朱舜水: 能力によって自分の戦場のカードが寝たとき、自分の魔力ゾーンのカード1つを
    // 指定して発動できる。そのカードを手札に戻す(簡略化として、アタック宣言による
    // タップのみを対象とし、対象は最もレベルの高い魔力ゾーンのカードを自動選択する)。
    for (const shushunsui of ps.field.ijin) {
      const shushunsuiKw = getCard(shushunsui.cardId).keywords;
      if (!(shushunsuiKw && shushunsuiKw.bounceOwnManaOnAnyOwnFieldCardTapped)) continue;
      if (isAbilitySuppressed(shushunsui, ps, opp)) continue;
      if (ps.mana.length === 0) continue;
      const chosen = ps.mana.slice().sort((a, b) => (b.faceUp ? getCard(b.cardId).level : 1) - (a.faceUp ? getCard(a.cardId).level : 1))[0];
      ps.mana.splice(ps.mana.indexOf(chosen), 1);
      chosen.faceUp = true;
      ps.hand.push(chosen);
      log(game, `${ps.name}の「${getCard(shushunsui.cardId).name}」の効果でマリョク1つが手札に戻りました。`);
    }
    // 岡田以蔵: パワー6000以上の間「寝たとき、イジンかガーディアンを1体を破壊する」を得る。
    if (card.keywords && card.keywords.destroyOnSelfTapIfPowerAtLeast != null
      && effectivePower(inst, ps) >= card.keywords.destroyOnSelfTapIfPowerAtLeast) {
      const result = resolveGenericEffect(game, ps, opp, { type: 'destroy_flexible_ijin_or_guardian_auto' }, null, inst);
      if (result.ok) log(game, `${ps.name}の「${card.name}」が寝たことで能力が発動しました。`);
    }
    // 孫権: 自分の戦場の指定色のイジンが寝るたびに発動できる観測型能力。
    for (const observer of ps.field.ijin) {
      const observerCard = getCard(observer.cardId);
      const obsTrig = observerCard.triggers && observerCard.triggers.onAllyIjinTappedByAttack;
      if (!obsTrig) continue;
      if (isAbilitySuppressed(observer, ps, opp)) continue;
      if (!effectiveColors(inst, ps).includes(obsTrig.color)) continue;
      const result = resolveGenericEffectMaybeArray(game, ps, opp, obsTrig.effect, null, observer);
      if (result.ok) log(game, `${ps.name}の「${observerCard.name}」が味方のイジンが寝たことで発動しました。`);
    }
  }
  // 徳川斉昭: この能力はターンに1回しか発動しない。戦場のイジンが寝たときに発動できる。
  // ターンプレイヤーは1ドローする(簡略化として、アタック宣言によるタップのみを対象とする)。
  if (tappedInstances.length > 0) {
    for (const side of [ps, opp]) {
      const tokugawa = side.field.ijin.find((i) => {
        const kw = getCard(i.cardId).keywords;
        return kw && kw.drawTurnPlayerOnceOnAnyIjinTapped;
      });
      if (tokugawa && !side.usedTokugawaTappedTriggerThisTurn && !isAbilitySuppressed(tokugawa, side, side === ps ? opp : ps)) {
        side.usedTokugawaTappedTriggerThisTurn = true;
        drawCards(game, ps, 1);
        log(game, `${side.name}の徳川斉昭の効果で、${ps.name}が1ドローしました。`);
      }
    }
  }
}

// 手札から墓地に置かれたとき(自分自身が効果で捨てられた場合も含む)に発動するトリガー。
// カードの持ち主(ps)から見た視点で解決する(捨てさせた側ではなく、捨てられた側の能力として発動する)。
function fireOnDiscardedFromHandTrigger(game, ps, opp, instance) {
  // 払暁の城壁: 手札から墓地に置かれたマホウは、本来「冥府発動」を使えない
  // (詳しくは canActivateMeifuHatsudou を参照)。
  instance.discardedFromHand = true;
  const card = getCard(instance.cardId);
  // 杉田玄白: 能力によって手札から墓地にイジンでないカードが置かれるたび(自分・相手問わず)、
  // そのカードのプレイヤーの山札の上から1枚を墓地に置く。
  if (card.type !== 'ijin') {
    for (const observerId of game.players) {
      const observerPs = game.playerStates[observerId];
      const observerOpp = game.playerStates[opponentId(game, observerId)];
      for (const observer of observerPs.field.ijin) {
        const observerCard = getCard(observer.cardId);
        if (!(observerCard.keywords && observerCard.keywords.millDiscardingPlayerOnNonIjinHandDiscard)) continue;
        if (isAbilitySuppressed(observer, observerPs, observerOpp)) continue;
        if (ps.deck.length === 0) continue;
        const milled = ps.deck.shift();
        milled.faceUp = true;
        ps.graveyard.push(milled);
        checkMilledCardForForcedTurnEnd(game, ps, getCard(milled.cardId), milled);
        log(game, `${observerPs.name}の「${observerCard.name}」の効果で、${ps.name}の山札の上から1枚が墓地に置かれました。`);
      }
    }
  } else {
    // 緒方洪庵: 能力によって手札から墓地にイジンが置かれるたび、そのカードの
    // プレイヤーは1ドローする。
    for (const observerId of game.players) {
      const observerPs = game.playerStates[observerId];
      const observerOpp = game.playerStates[opponentId(game, observerId)];
      for (const observer of observerPs.field.ijin) {
        const observerCard = getCard(observer.cardId);
        if (!(observerCard.keywords && observerCard.keywords.drawDiscardingPlayerOnIjinHandDiscard)) continue;
        if (isAbilitySuppressed(observer, observerPs, observerOpp)) continue;
        drawCards(game, ps, 1);
        log(game, `${observerPs.name}の「${observerCard.name}」の効果で、${ps.name}が1ドローしました。`);
      }
    }
  }
  // 虎狼痢: 能力によって手札から墓地にカードが置かれたときに発動できる。自分と相手の
  // 手札のカードを1つずつ同時に見せて、レベルが高い方を墓地に置き、低い方を山札の上に
  // 戻す(両者の手札が0枚でなければ、対象選択は本アプリの既存方針に合わせて先頭カードを自動選択)。
  for (const ownerId of game.players) {
    const ownerPs = game.playerStates[ownerId];
    const ownerOpp = game.playerStates[opponentId(game, ownerId)];
    const hasKorori = ownerPs.field.haikei.some((h) => {
      const kw = getCard(h.cardId).keywords;
      return kw && kw.compareHandCardsDiscardHigherLevel;
    });
    if (!hasKorori || ownerPs.hand.length === 0 || ownerOpp.hand.length === 0) continue;
    const ownerCard = ownerPs.hand[0];
    const oppCard = ownerOpp.hand[0];
    const ownerLevel = getCard(ownerCard.cardId).level;
    const oppLevel = getCard(oppCard.cardId).level;
    const [higherSide, higherCard, lowerSide, lowerCard] = ownerLevel >= oppLevel
      ? [ownerPs, ownerCard, ownerOpp, oppCard]
      : [ownerOpp, oppCard, ownerPs, ownerCard];
    higherSide.hand.splice(higherSide.hand.indexOf(higherCard), 1);
    higherCard.faceUp = true;
    higherSide.graveyard.push(higherCard);
    // fireOnDiscardedFromHandTrigger自身の内部処理のため、再帰呼び出しはせずフラグのみ直接立てる。
    higherCard.discardedFromHand = true;
    lowerSide.hand.splice(lowerSide.hand.indexOf(lowerCard), 1);
    lowerCard.faceUp = true;
    lowerSide.deck.unshift(lowerCard);
    log(game, `${ownerPs.name}の虎狼痢の効果が発動しました。`);
  }
  const trig = card.triggers && card.triggers.onDiscardedFromHand;
  if (!trig) return;
  if (isAbilitySuppressed(instance, ps, opp)) return;
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

  // 前田慶次: 自分のターンのバトル解決ステップが開始したとき、自分と相手の戦場の
  // パワー10000未満のイジンすべてとハイケイすべてを破壊できる(戦場で効果を発揮)。
  const maedaWipe = attackerPs.field.ijin.some((i) => {
    const kw = getCard(i.cardId).keywords;
    return kw && kw.wipeLowPowerFieldAtBattleStart;
  });
  if (maedaWipe) {
    for (const side of [attackerPs, defenderPs]) {
      for (const inst of side.field.ijin.filter((i) => effectivePower(i, side) < 10000)) destroyFieldOrGuardian(game, side, inst);
      for (const inst of [...side.field.haikei]) destroyFieldOrGuardian(game, side, inst);
    }
  }

  const survivingMortals = [];

  for (const entry of battle.attackers) {
    const attackerInst = entry.isGuardianAttacker
      ? attackerPs.guardians.find((g) => g.uid === entry.uid)
      : attackerPs.field.ijin.find((i) => i.uid === entry.uid);
    if (!attackerInst) continue; // 既に破壊済み等
    // 円形闘技場のガーディアンアタッカーは、伏せられたままの匿名のパワー3000固定の
    // 攻撃者として扱い、本来のカードの能力(ドレイン・モータル・特性等)は一切持たない。
    const atkPower = entry.isGuardianAttacker ? 3000 : attackContextPower(attackerInst, attackerPs, defenderPs);
    if (atkPower <= 0) continue; // 途中でパワー0以下になったアタッカーは対象から除外
    const attackerHasDrain = entry.isGuardianAttacker ? false : hasEffectiveDrain(attackerInst, attackerPs, defenderPs, game);
    const attackerName = entry.isGuardianAttacker ? 'ガーディアン' : getCard(attackerInst.cardId).name;

    if (entry.blockers.length === 0) {
      endGame(game, attackerId, `${attackerName}の攻撃が防がれなかったため`);
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

    // ニコライ・レザノフ: 『ブロック+』能力を持つアタッカーは、ガーディアンにブロックされたとき、これを起こす。
    if (attackerInst.untapsWhenBlockedByGuardianThisTurn && blockerDetails.some((bd) => bd.isGuardian)) {
      attackerInst.tapped = false;
    }

    // 魔除けの社: 自分の戦場のガーディアンがブロッカーに含まれているなら、
    // パワーX以下のアタッカーは(ブロック力の合計に関わらず)破壊される。
    let mayokeThreshold = null;
    for (const h of defenderPs.field.haikei) {
      const kw = getCard(h.cardId).keywords;
      if (kw && kw.destroyAttackerPowerAtMostIfGuardianBlocked != null) {
        mayokeThreshold = mayokeThreshold == null ? kw.destroyAttackerPowerAtMostIfGuardianBlocked : Math.max(mayokeThreshold, kw.destroyAttackerPowerAtMostIfGuardianBlocked);
      }
    }
    const guardianBlocked = blockerDetails.some((bd) => bd.isGuardian);
    const attackerDies = (blockersSum >= atkPower) || (mayokeThreshold != null && guardianBlocked && atkPower <= mayokeThreshold);
    if (attackerDies) {
      const aBlockerHasDrain = blockerDetails.some((bd) => {
        if (bd.isGuardian) return false;
        const inst = defenderPs.field.ijin.find((i) => i.uid === bd.b.uid);
        return inst && hasEffectiveDrain(inst, defenderPs, attackerPs, game);
      });
      destroyFieldOrGuardian(game, attackerPs, attackerInst, aBlockerHasDrain, true);
      attackerPs.attackerDestroyedThisTurn = true;
    } else if (!entry.isGuardianAttacker) {
      const attackerCard = getCard(attackerInst.cardId);
      if (hasEffectiveMortal(attackerInst, attackerPs)) {
        survivingMortals.push(attackerInst.uid);
        log(game, `${attackerPs.name}の「${attackerCard.name}」はモータルによりバトル解決で勝ってもアタッカーのままです。`);
      }
      // 風林火山: 自分の戦場の「剣術」イジンは「勝鬨」を得る。アタッカーがバトル解決で勝ったとき、
      // 1ドローしてイジン召喚権+1する。
      if (hasEffectiveTrait(attackerInst, '剣術', attackerPs) && attackerPs.field.haikei.some((h) => {
        const kw = getCard(h.cardId).keywords;
        return kw && kw.grantKachidokiToKenjutsuIjin;
      })) {
        drawCards(game, attackerPs, 1);
        attackerPs.summonRight += 1;
        log(game, `${attackerPs.name}の「${attackerCard.name}」が勝鬨で1ドローし、イジン召喚権+1しました。`);
      }
      // 相馬義胤・真田信繁: 自分自身の「勝鬨」- アタッカーがバトル解決で勝ったときに発動する。
      const kachidokiTrig = attackerCard.triggers && attackerCard.triggers.onSelfBattleWon;
      if (kachidokiTrig && !isAbilitySuppressed(attackerInst, attackerPs, defenderPs)
        && checkTriggerCondition(attackerPs, defenderPs, kachidokiTrig.condition, attackerInst)) {
        const kResult = resolveGenericEffectMaybeArray(game, attackerPs, defenderPs, kachidokiTrig.effect, null, attackerInst);
        if (kResult.ok) log(game, `${attackerPs.name}の「${attackerCard.name}」の勝鬨が発動しました。`);
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
        if (inst) destroyFieldOrGuardian(game, defenderPs, inst, attackerHasDrain, true);
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
  attackContextPower,
  blockContextPower,
  findInstance,
  destroyFieldOrGuardian,
  resolveMainStartTrigger,
  effectiveColors,
  hasEffectiveTrait,
  hasEffectiveMortal,
  hasEffectiveRush,
  isAbilitySuppressed,
  isGraveyardCardAbilitySuppressedByMozart,
  fireOnDiscardedFromHandTrigger,
  canPlaceFromGraveyardToField,
  canReturnFromGraveyardToHand,
  canActivateMeifuHatsudou,
  fireOnManaLeftViaAbility,
  resolveHaikeiPlacedTrigger,
  resolveManaOnPlaceDiscard,
  resolveManaCardDestinationChoice,
  resolveEffectChoice,
  resolveGenericEffect,
  declareMulligan,
  findInstance,
  checkAndProcessForcedTurnEnd,
  resolveLegacyTrigger,
  describePendingLegacyTrigger,
};
