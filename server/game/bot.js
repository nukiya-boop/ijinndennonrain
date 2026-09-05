'use strict';

/**
 * 簡易CPU(AI)対戦ロジック。
 * 最適な戦略ではなく、破綻しない程度のヒューリスティックで手を選ぶ。
 */

const engine = require('./engine');
const { getCard } = require('./cards');

const HAIKEI_LIMIT_PER_TURN = 3;
const MAHOU_LIMIT_PER_TURN = 2;

function affordableIjin(ps) {
  const candidates = ps.hand.filter((i) => {
    const c = getCard(i.cardId);
    return c.type === 'ijin' && engine.canUseCard(ps, c);
  });
  candidates.sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power);
  return candidates[0] || null;
}

function affordableHaikei(ps, playedThisCall) {
  const candidates = ps.hand.filter((i) => {
    const c = getCard(i.cardId);
    return c.type === 'haikei' && engine.canUseCard(ps, c);
  });
  return candidates[0] || null;
}

function chooseGenericEffectTarget(ps, opp, eff, sourceInstance) {
  if (!eff) return undefined;
  if (Array.isArray(eff)) {
    for (const e of eff) {
      const t = chooseGenericEffectTarget(ps, opp, e, sourceInstance);
      if (t !== undefined) return t;
    }
    return undefined;
  }
  switch (eff.type) {
    case 'generic_destroy_ijin':
    case 'generic_bounce_ijin': {
      const sourcePower = sourceInstance ? engine.effectivePower(sourceInstance, ps) : null;
      const pool = [];
      if (eff.scope === 'own' || eff.scope === 'either') pool.push(...ps.field.ijin.map((i) => ({ owner: ps, inst: i })));
      if (eff.scope === 'opponent' || eff.scope === 'either') pool.push(...opp.field.ijin.map((i) => ({ owner: opp, inst: i })));
      const filtered = pool.filter(({ owner, inst }) => {
        const c = getCard(inst.cardId);
        if (eff.levelMax != null && c.level > eff.levelMax) return false;
        if (eff.powerMax != null) {
          const cap = eff.powerMax === 'self' ? sourcePower : eff.powerMax;
          if (engine.effectivePower(inst, owner) > cap) return false;
        }
        return true;
      });
      if (filtered.length === 0) return null;
      filtered.sort((a, b) => engine.effectivePower(b.inst, b.owner) - engine.effectivePower(a.inst, a.owner));
      const best = eff.scope === 'own' ? filtered[filtered.length - 1] : filtered[0];
      return best.inst.uid;
    }
    case 'bounce_from_graveyard': {
      const pool = ps.graveyard.filter((i) => ['ijin', 'haikei'].includes(getCard(i.cardId).type));
      return pool.length ? pool[0].uid : null;
    }
    case 'bounce_facedown_mana': {
      const owner = eff.scope === 'opponent' ? opp : ps;
      const pool = owner.mana.filter((m) => !m.faceUp);
      return pool.length ? pool[0].uid : null;
    }
    case 'generic_destroy_haikei': {
      const pool = [];
      if (eff.scope === 'own' || eff.scope === 'either') pool.push(...ps.field.haikei);
      if (eff.scope === 'opponent' || eff.scope === 'either') pool.push(...opp.field.haikei);
      return pool.length ? pool[0].uid : null;
    }
    case 'bounce_flexible_ijin_or_haikei': {
      const pool = [];
      if (eff.scope === 'own' || eff.scope === 'either') pool.push(...ps.field.ijin, ...ps.field.haikei);
      if (eff.scope === 'opponent' || eff.scope === 'either') pool.push(...opp.field.ijin, ...opp.field.haikei);
      return pool.length ? pool[0].uid : null;
    }
    case 'tap_target_ijin': {
      const pool = [];
      if (eff.scope === 'own' || eff.scope === 'either') pool.push(...ps.field.ijin.filter((i) => !i.tapped));
      if (eff.scope === 'opponent' || eff.scope === 'either') pool.push(...opp.field.ijin.filter((i) => !i.tapped));
      if (pool.length === 0) return null;
      pool.sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power);
      return pool[0].uid;
    }
    case 'move_flexible_guardian_or_graveyard_to_deck_top': {
      const pool = [...ps.guardians, ...ps.graveyard];
      return pool.length ? pool[0].uid : null;
    }
    case 'flip_flexible_ijin_or_haikei_to_facedown_mana': {
      const pool = [];
      if (eff.scope === 'own' || eff.scope === 'either') pool.push(...ps.field.ijin, ...ps.field.haikei);
      if (eff.scope === 'opponent' || eff.scope === 'either') pool.push(...opp.field.ijin, ...opp.field.haikei);
      return pool.length ? pool[0].uid : null;
    }
    case 'tap_flexible_own_ijin_or_guardian': {
      const pool = [...ps.field.ijin.filter((i) => !i.tapped), ...ps.guardians.filter((g) => !g.tapped)];
      return pool.length ? pool[0].uid : null;
    }
    case 'draw_then_discard_own_hand':
    case 'discard_own_hand': {
      const pool = ps.hand.filter((h) => h.uid !== (sourceInstance && sourceInstance.uid));
      if (pool.length === 0) return null;
      pool.sort((a, b) => getCard(a.cardId).level - getCard(b.cardId).level);
      return pool[0].uid;
    }
    case 'graveyard_card_to_guardian': {
      const pool = ps.graveyard;
      return pool.length ? pool[0].uid : null;
    }
    case 'graveyard_to_deck_bottom_then_draw': {
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type !== 'maryoku');
      return pool.length ? pool[0].uid : null;
    }
    case 'destroy_highest_power_field_ijin': {
      const all = [...ps.field.ijin, ...opp.field.ijin];
      if (all.length === 0) return null;
      const maxPower = Math.max(...all.map((i) => getCard(i.cardId).power));
      const preferred = opp.field.ijin.find((i) => getCard(i.cardId).power === maxPower);
      return (preferred || all.find((i) => getCard(i.cardId).power === maxPower)).uid;
    }
    case 'hand_card_to_deck_bottom_then_draw': {
      const pool = ps.hand.filter((h) => h.uid !== (sourceInstance && sourceInstance.uid));
      if (pool.length === 0) return null;
      pool.sort((a, b) => getCard(a.cardId).level - getCard(b.cardId).level);
      return pool[0].uid;
    }
    case 'haikei_to_deck_top': {
      const pool = ps.field.haikei.filter((h) => {
        if (!eff.trait) return true;
        const kw = getCard(h.cardId).keywords;
        return kw && (kw.trait === eff.trait || (kw.traits || []).includes(eff.trait));
      });
      return pool.length ? pool[0].uid : null;
    }
    default:
      return undefined;
  }
}

function chooseMahouAction(ps, opp, card) {
  const eff = card.effect;
  if (!eff) return null;
  if (Array.isArray(eff)) {
    const payload = {};
    for (const e of eff) {
      const t = chooseGenericEffectTarget(ps, opp, e, null);
      if (t) Object.assign(payload, { targetUid: t });
    }
    return payload;
  }
  switch (eff.type) {
    case 'deck_top_to_facedown_mana':
    case 'deck_top_to_guardian':
    case 'bounce_all_tapped_opponent_ijin':
    case 'all_guardians_to_facedown_mana_then_draw_guardians':
    case 'manafy_all_tapped_opponent_ijin':
    case 'deck_bottom_all_opponent_ijin_without_legacy':
      return {};
    case 'destroy_all_opponent_ijin_pow_at_most_and_all_haikei': {
      const hasTarget = opp.field.ijin.some((i) => engine.effectivePower(i, opp) <= eff.powerMax) || opp.field.haikei.length > 0;
      return hasTarget ? {} : null;
    }
    case 'graveyard_mana_to_deck_then_facedown_mana_scaled':
      return ps.graveyard.some((c) => getCard(c.cardId).type === 'maryoku') ? {} : null;
    case 'draw_then_discard_own_hand': {
      const t = chooseGenericEffectTarget(ps, opp, eff, null);
      return t ? { targetUid: t } : {};
    }
    case 'destroy_own_and_opponent_ijin': {
      if (ps.field.ijin.length === 0 || opp.field.ijin.length === 0) return null;
      const own = ps.field.ijin.slice().sort((a, b) => getCard(a.cardId).power - getCard(b.cardId).power)[0];
      const enemy = opp.field.ijin.slice().sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power)[0];
      return { targetUid: own.uid, targetUid2: enemy.uid };
    }
    case 'duel_ijin': {
      const ownCandidates = ps.field.ijin.filter((i) => !i.tapped);
      if (ownCandidates.length === 0 || opp.field.ijin.length === 0) return null;
      const own = ownCandidates.slice().sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power)[0];
      const enemy = opp.field.ijin.slice().sort((a, b) => getCard(a.cardId).power - getCard(b.cardId).power)[0];
      if (getCard(own.cardId).power < getCard(enemy.cardId).power) return null; // AIは負ける決闘は仕掛けない
      return { targetUid: own.uid, targetUid2: enemy.uid };
    }
    case 'bounce_or_deck_top_based_on_tapped': {
      const best = opp.field.ijin.slice().sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power)[0];
      return best ? { targetUid: best.uid } : null;
    }
    case 'revive_ijin_to_field_from_graveyard': {
      const best = ps.graveyard.find((i) => getCard(i.cardId).type === 'ijin' && (eff.levelMax == null || getCard(i.cardId).level <= eff.levelMax));
      return best ? { targetUid: best.uid } : null;
    }
    case 'bounce_highest_level_field_card': {
      const all = [...ps.field.ijin, ...ps.field.haikei, ...opp.field.ijin, ...opp.field.haikei];
      if (all.length === 0) return null;
      const maxLevel = Math.max(...all.map((i) => getCard(i.cardId).level));
      const oppOnly = [...opp.field.ijin, ...opp.field.haikei].filter((i) => getCard(i.cardId).level === maxLevel);
      const target = oppOnly[0] || all.find((i) => getCard(i.cardId).level === maxLevel);
      return target ? { targetUid: target.uid } : null;
    }
    case 'bounce_tapped_card_to_deck_bottom': {
      const oppTapped = [...opp.field.ijin, ...opp.field.haikei].filter((i) => i.tapped);
      const target = oppTapped[0];
      return target ? { targetUid: target.uid } : null;
    }
    case 'flip_opponent_mana_facedown': {
      const target = opp.mana.find((m) => m.faceUp);
      return target ? { targetUid: target.uid } : null;
    }
    case 'grant_temp_rush': {
      const pool = ps.field.ijin.filter((i) => eff.levelMax == null || getCard(i.cardId).level <= eff.levelMax);
      pool.sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power);
      return pool.length ? { targetUid: pool[0].uid } : null;
    }
    case 'summon_hand_ijin_with_temp_rush': {
      const pool = ps.hand.filter((h) => getCard(h.cardId).type === 'ijin' && (eff.levelMax == null || getCard(h.cardId).level <= eff.levelMax));
      pool.sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power);
      return pool.length ? { targetUid: pool[0].uid } : null;
    }
    case 'draw':
    case 'summon_right_plus':
    case 'mana_right_plus':
    case 'refresh_guardians':
      return {};
    case 'loyalty':
      return {};
    case 'unblockable_by_ijin': {
      const best = ps.field.ijin.slice().sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power)[0];
      return best ? { targetUid: best.uid } : null;
    }
    case 'bounce': {
      const best = opp.field.ijin.slice().sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power)[0];
      return best ? { targetUid: best.uid } : null;
    }
    case 'manafy_target': {
      const best = opp.field.ijin.slice().sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power)[0];
      return best ? { targetUid: best.uid } : null;
    }
    case 'revive_from_graveyard': {
      const best = ps.graveyard.find((i) => {
        const c = getCard(i.cardId);
        return (c.type === 'ijin' && c.level <= 6) || (c.type === 'haikei' && c.level <= 5);
      });
      return best ? { targetUid: best.uid } : null;
    }
    case 'generic_destroy_ijin':
    case 'generic_bounce_ijin': {
      if (eff.scope === 'own') return null;
      const pool = opp.field.ijin.filter((i) => eff.levelMax == null || getCard(i.cardId).level <= eff.levelMax);
      if (pool.length === 0) return null;
      pool.sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power);
      return { targetUid: pool[0].uid };
    }
    case 'generic_destroy_guardian': {
      if (eff.scope === 'own') return null;
      if (opp.guardians.length === 0) return null;
      return { targetUid: opp.guardians[0].uid };
    }
    case 'final_attack':
    case 'destroy_own_ijin_and_opponent_guardian':
      return null; // AIは自己犠牲を伴う効果を使わない
    default:
      return null;
  }
}

/**
 * メインフェイズでCPUが1つだけアクションを行う。
 * 戻り値: { done: bool, attacked: bool } done=falseならもう打つ手がない(ターン終了すべき)。
 */
function botTakeMainPhaseStep(game, botId, turnCounters) {
  const ps = game.playerStates[botId];
  const oppId = engine.opponentId(game, botId);
  const opp = game.playerStates[oppId];

  if (ps.manaRight > 0) {
    const maryokuInHand = ps.hand.find((i) => getCard(i.cardId).type === 'maryoku');
    if (maryokuInHand) {
      engine.placeMana(game, botId, { cardUid: maryokuInHand.uid, mode: 'faceup' });
      return { done: true, attacked: false };
    }
    if (ps.hand.length > 6) {
      const filler = ps.hand[0];
      engine.placeMana(game, botId, { cardUid: filler.uid, mode: 'facedown' });
      return { done: true, attacked: false };
    }
  }

  if (ps.summonRight > 0) {
    const ijin = affordableIjin(ps);
    if (ijin) {
      const card = getCard(ijin.cardId);
      const payload = { cardUid: ijin.uid };
      const onPlace = card.triggers && card.triggers.onPlace;
      if (onPlace && onPlace.needsTarget) {
        const t = chooseGenericEffectTarget(ps, opp, onPlace.effect, ijin);
        if (t) payload.triggerTargetUid = t;
      }
      if (onPlace && onPlace.effectChoices) payload.triggerChoiceIndex = 0;
      const equipCandidate = [...ps.mana.filter((m) => m.faceUp), ...ps.field.haikei].find((eq) => {
        const eqCard = getCard(eq.cardId);
        if (!eqCard.equipOffer) return false;
        if (eqCard.equipOffer.colorAny && !card.colors.some((c) => eqCard.equipOffer.colorAny.includes(c))) return false;
        if (eqCard.equipOffer.requireText && !(card.text || '').includes(eqCard.equipOffer.requireText)) return false;
        return true;
      });
      if (equipCandidate) payload.equipCardUid = equipCandidate.uid;
      engine.summonIjin(game, botId, payload);
      return { done: true, attacked: false };
    }
  }

  if (ps.guardians.length > 0) {
    const hankonCandidate = ps.graveyard.find((c) => {
      const card = getCard(c.cardId);
      return card.type === 'ijin' && card.legacyText === '反魂';
    });
    if (hankonCandidate) {
      const result = engine.reviveHankon(game, botId, { cardUid: hankonCandidate.uid, guardianUid: ps.guardians[0].uid });
      if (result.ok) return { done: true, attacked: false };
    }
  }

  if (turnCounters.haikei < HAIKEI_LIMIT_PER_TURN) {
    const haikei = affordableHaikei(ps);
    if (haikei) {
      const card = getCard(haikei.cardId);
      const payload = { cardUid: haikei.uid };
      const onPlace = card.triggers && card.triggers.onPlace;
      if (onPlace && onPlace.needsTarget) {
        const t = chooseGenericEffectTarget(ps, opp, onPlace.effect, haikei);
        if (t) payload.triggerTargetUid = t;
      }
      if (onPlace && onPlace.effectChoices) payload.triggerChoiceIndex = 0;
      engine.playHaikei(game, botId, payload);
      turnCounters.haikei += 1;
      return { done: true, attacked: false };
    }
  }

  if (turnCounters.mahou < MAHOU_LIMIT_PER_TURN) {
    const mahouCandidates = ps.hand.filter((i) => {
      const c = getCard(i.cardId);
      return c.type === 'mahou' && c.effect && engine.canUseCard(ps, c);
    });
    for (const inst of mahouCandidates) {
      const card = getCard(inst.cardId);
      const payload = chooseMahouAction(ps, opp, card);
      if (payload === null) continue;
      const payManaUids = ps.mana.slice(0, card.magicCost).map((m) => m.uid);
      if (payManaUids.length < card.magicCost) continue;
      const result = engine.castMahou(game, botId, Object.assign({ cardUid: inst.uid, payManaUids }, payload));
      if (result.ok) {
        turnCounters.mahou += 1;
        return { done: true, attacked: false };
      }
    }

    const meifuCandidates = ps.graveyard.filter((i) => {
      const c = getCard(i.cardId);
      return c.type === 'mahou' && c.effect && c.legacyText === '冥府発動' && !i.usedMeifuThisTurn;
    });
    for (const inst of meifuCandidates) {
      const card = getCard(inst.cardId);
      const payload = chooseMahouAction(ps, opp, card);
      if (payload === null) continue;
      const result = engine.castMahouFromGraveyard(game, botId, Object.assign({ cardUid: inst.uid }, payload));
      if (result.ok) {
        turnCounters.mahou += 1;
        return { done: true, attacked: false };
      }
    }
  }

  if (!ps.attackedThisTurn || ps.extraBattleAvailable) {
    const attackers = ps.field.ijin.filter((i) => {
      if (i.tapped) return false;
      const c = getCard(i.cardId);
      if (i.sick && !(c.keywords && c.keywords.rush)) return false;
      return engine.effectivePower(i, ps) > 0;
    });
    if (attackers.length > 0) {
      const attackerTriggerTargets = {};
      for (const a of attackers) {
        const card = getCard(a.cardId);
        const onAttacker = card.triggers && card.triggers.onAttacker;
        if (onAttacker && onAttacker.needsTarget) {
          const t = chooseGenericEffectTarget(ps, opp, onAttacker.effect, a);
          if (t) attackerTriggerTargets[a.uid] = t;
        }
      }
      engine.declareAttack(game, botId, { attackerUids: attackers.map((a) => a.uid), attackerTriggerTargets });
      return { done: true, attacked: true };
    }
  }

  return { done: false, attacked: false };
}

/**
 * CPUが防御側のときのブロック割り当てを決定する(engine.declareBlockへ渡すassignments)。
 */
function botDecideBlock(game, botId) {
  const ps = game.playerStates[botId];
  const battle = game.pendingBattle;
  const attackerPs = game.playerStates[battle.attackerPlayerId];

  const availableGuardians = ps.guardians.filter((g) => !g.tapped).map((g) => g.uid);
  const availableIjin = ps.field.ijin
    .filter((i) => {
      const c = getCard(i.cardId);
      const watcher = c.keywords && c.keywords.watcher;
      return !i.tapped || watcher;
    })
    .sort((a, b) => getCard(a.cardId).power - getCard(b.cardId).power)
    .map((i) => i.uid);

  const availableStandMana = ps.mana
    .filter((m) => {
      if (m.faceUp) return false;
      const c = getCard(m.cardId);
      if (!(c.type === 'ijin' && c.keywords && c.keywords.stand)) return false;
      return ps.mana.some((m2) => m2.faceUp && c.colors.some((col) => getCard(m2.cardId).colors.includes(col)));
    })
    .map((m) => m.uid);

  const usedGuardians = new Set();
  const usedIjin = new Set();
  const usedStandMana = new Set();
  const assignments = {};

  for (const entry of battle.attackers) {
    const attackerInst = attackerPs.field.ijin.find((i) => i.uid === entry.uid);
    if (!attackerInst) continue;
    const attackerCard = getCard(attackerInst.cardId);
    const required = (attackerCard.keywords && attackerCard.keywords.pressure) || 1;

    const chosen = [];
    for (const gUid of availableGuardians) {
      if (chosen.length >= required) break;
      if (usedGuardians.has(gUid)) continue;
      chosen.push(gUid);
      usedGuardians.add(gUid);
    }
    if (chosen.length < required) {
      for (const iUid of availableIjin) {
        if (chosen.length >= required) break;
        if (usedIjin.has(iUid)) continue;
        chosen.push(iUid);
        usedIjin.add(iUid);
      }
    }
    if (chosen.length < required) {
      for (const sUid of availableStandMana) {
        if (chosen.length >= required) break;
        if (usedStandMana.has(sUid)) continue;
        chosen.push(sUid);
        usedStandMana.add(sUid);
      }
    }
    if (chosen.length >= required) {
      assignments[entry.uid] = chosen;
    }
  }

  return assignments;
}

module.exports = { botTakeMainPhaseStep, botDecideBlock };
