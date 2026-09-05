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
      const pool = ps.mana.filter((m) => !m.faceUp);
      return pool.length ? pool[0].uid : null;
    }
    default:
      return undefined;
  }
}

function chooseMahouAction(ps, opp, card) {
  const eff = card.effect;
  if (!eff) return null;
  switch (eff.type) {
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
      engine.summonIjin(game, botId, payload);
      return { done: true, attacked: false };
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

  const usedGuardians = new Set();
  const usedIjin = new Set();
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
    if (chosen.length >= required) {
      assignments[entry.uid] = chosen;
    }
  }

  return assignments;
}

module.exports = { botTakeMainPhaseStep, botDecideBlock };
