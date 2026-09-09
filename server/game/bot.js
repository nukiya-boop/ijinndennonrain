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
        if (eff.levelMin != null && c.level < eff.levelMin) return false;
        if (eff.powerMax != null) {
          const cap = eff.powerMax === 'self' ? sourcePower : eff.powerMax;
          if (engine.effectivePower(inst, owner) > cap) return false;
        }
        if (eff.traitFilter && !engine.hasEffectiveTrait(inst, eff.traitFilter, owner)) return false;
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
    case 'hand_card_to_guardian_by_uid': {
      const pool = ps.hand.filter((h) => h.uid !== (sourceInstance && sourceInstance.uid));
      if (pool.length === 0) return null;
      pool.sort((a, b) => getCard(a.cardId).level - getCard(b.cardId).level);
      return pool[0].uid;
    }
    case 'facedown_mana_to_guardian_by_uid': {
      const pool = ps.mana.filter((m) => !m.faceUp);
      return pool.length ? pool[0].uid : null;
    }
    case 'move_opponent_ijin_or_haikei_to_their_guardian_by_uid': {
      const pool = [
        ...opp.field.ijin.filter((i) => eff.ijinLevelMax == null || getCard(i.cardId).level <= eff.ijinLevelMax),
        ...opp.field.haikei,
      ];
      if (pool.length === 0) return null;
      pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      return pool[0].uid;
    }
    case 'graveyard_to_deck_bottom_then_draw': {
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type !== 'maryoku');
      return pool.length ? pool[0].uid : null;
    }
    case 'grant_temp_power_bonus_target_opponent_ijin_by_uid': {
      if (opp.field.ijin.length === 0) return null;
      const best = opp.field.ijin.reduce((a, b) => (engine.effectivePower(b, opp) > engine.effectivePower(a, opp) ? b : a));
      return best.uid;
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
    case 'flip_opponent_mana_facedown': {
      const target = opp.mana.find((m) => m.faceUp);
      return target ? target.uid : null;
    }
    case 'revive_flexible_ijin_or_haikei_from_graveyard': {
      const pool = ps.graveyard.filter((c) => {
        const card = getCard(c.cardId);
        if (card.type === 'ijin') return eff.ijinLevelMax == null || card.level <= eff.ijinLevelMax;
        if (card.type === 'haikei') return eff.haikeiLevelMax == null || card.level <= eff.haikeiLevelMax;
        return false;
      });
      if (pool.length === 0) return null;
      pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
      return pool[0].uid;
    }
    case 'destroy_flexible_ijin_or_haikei': {
      const pool = [];
      if (eff.scope === 'own' || eff.scope === 'either') pool.push(...ps.field.ijin.filter((i) => eff.powerMax == null || engine.effectivePower(i, ps) <= eff.powerMax), ...ps.field.haikei);
      if (eff.scope === 'opponent' || eff.scope === 'either') pool.push(...opp.field.ijin.filter((i) => eff.powerMax == null || engine.effectivePower(i, opp) <= eff.powerMax), ...opp.field.haikei);
      return pool.length ? pool[0].uid : null;
    }
    case 'bounce_equipped_card_by_uid': {
      const holder = [...ps.field.ijin, ...opp.field.ijin].find((i) => i.equippedCard);
      return holder ? holder.equippedCard.uid : null;
    }
    case 'flip_facedown_mana_haikei_to_field_then_bounce_and_summon_right': {
      const pool = ps.mana.filter((m) => !m.faceUp && getCard(m.cardId).type === 'haikei' && (eff.levelMax == null || getCard(m.cardId).level <= eff.levelMax));
      return pool.length ? pool[0].uid : null;
    }
    case 'mill_self_then_graveyard_to_deck_top': {
      const pool = ps.graveyard.slice().sort((a, b) => getCard(a.cardId).level - getCard(b.cardId).level);
      return pool.length ? pool[0].uid : null;
    }
    case 'flexible_haikei_or_equipped_to_deck_bottom': {
      const haikei = opp.field.haikei[0];
      if (haikei) return haikei.uid;
      const holder = [...ps.field.ijin, ...opp.field.ijin].find((i) => i.equippedCard);
      return holder ? holder.equippedCard.uid : null;
    }
    case 'draw_entire_deck_then_optional_free_summon_then_reshuffle': {
      const pool = ps.hand.filter((h) => getCard(h.cardId).type === 'ijin' && h.uid !== (sourceInstance && sourceInstance.uid) && (eff.levelMax == null || getCard(h.cardId).level <= eff.levelMax));
      pool.sort((a, b) => getCard(b.cardId).power - getCard(a.cardId).power);
      return pool.length ? pool[0].uid : undefined;
    }
    case 'flip_own_color_matching_ijin_to_mana': {
      const manaColors = new Set();
      for (const m of ps.mana) if (m.faceUp) getCard(m.cardId).colors.forEach((c) => manaColors.add(c));
      const pool = ps.field.ijin.filter((i) => i.uid !== (sourceInstance && sourceInstance.uid) && getCard(i.cardId).colors.some((c) => manaColors.has(c)));
      return pool.length ? pool[0].uid : null;
    }
    case 'bounce_own_haikei_by_uid': {
      return ps.field.haikei.length ? ps.field.haikei[0].uid : null;
    }
    default:
      return undefined;
  }
}

// 単一の効果(配列でまとめられた複数効果も含む)に対して、対象があれば対象付きの
// payloadを組み立てる簡易ヒューリスティック。ソーラーフレア/コーザリティ等、
// effectChoicesの各選択肢を評価するのに使う。
function resolveChoicePayload(ps, opp, choiceEff) {
  const items = Array.isArray(choiceEff) ? choiceEff : [choiceEff];
  const payload = {};
  for (const e of items) {
    if (e.type === 'discard_own_hand_then_draw' || e.type === 'conditional_graveyard_mahou_level_sum_at_least') {
      const pool = ps.hand.slice().sort((a, b) => getCard(a.cardId).level - getCard(b.cardId).level);
      if (pool.length > 0) payload.targetUid = pool[0].uid;
      continue;
    }
    const t = chooseGenericEffectTarget(ps, opp, e, null);
    if (t) Object.assign(payload, { targetUid: t });
  }
  return payload;
}

function chooseMahouAction(ps, opp, card) {
  let eff = card.effect;
  if (!eff) return null;
  if (eff.effectChoices) {
    // 常に最初の選択肢を選ぶ簡易ヒューリスティック(対象が必要な場合は対象も算出する)。
    return Object.assign({ triggerChoiceIndex: 0 }, resolveChoicePayload(ps, opp, eff.effectChoices[0]));
  }
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
    case 'move_opponent_ijin_or_haikei_to_their_guardian_by_uid': {
      const t = chooseGenericEffectTarget(ps, opp, eff, null);
      return t ? { targetUid: t } : null;
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
    case 'field_card_to_guardian_by_uid': {
      const pool = [...opp.field.ijin, ...opp.field.haikei].filter((i) => eff.levelMax == null || getCard(i.cardId).level <= eff.levelMax);
      return pool.length ? { targetUid: pool[0].uid } : null;
    }
    case 'discard_opponent_hand_card_level_at_least':
      return {};
    case 'draw_then_discard_scaled_by_own_mana_colors': {
      const colors = new Set();
      for (const m of ps.mana) if (m.faceUp) getCard(m.cardId).colors.forEach((c) => colors.add(c));
      const pool = ps.hand.slice().sort((a, b) => getCard(a.cardId).level - getCard(b.cardId).level);
      const uids = pool.slice(0, Math.min(colors.size, pool.length)).map((c) => c.uid);
      return { targetUids: uids };
    }
    case 'conditional_graveyard_mahou_level_sum_at_least': {
      const sum = ps.graveyard.filter((c) => getCard(c.cardId).type === 'mahou').reduce((s, c) => s + getCard(c.cardId).level, 0);
      if (sum < eff.value) return {};
      const pool = ps.hand.slice().sort((a, b) => getCard(a.cardId).level - getCard(b.cardId).level);
      return pool.length ? { targetUid: pool[0].uid } : {};
    }
    case 'multi_hand_to_facedown_mana': {
      const pool = ps.hand.slice(0, 1);
      return pool.length ? { targetUids: pool.map((c) => c.uid) } : null;
    }
    case 'multi_bounce_own_ijin_scaled_summon_right': {
      const pool = ps.field.ijin.slice().sort((a, b) => getCard(a.cardId).power - getCard(b.cardId).power).slice(0, 1);
      return pool.length ? { targetUids: pool.map((c) => c.uid) } : null;
    }
    case 'multi_discard_hand_haikei_draw_scaled': {
      const pool = ps.hand.filter((c) => getCard(c.cardId).type === 'haikei');
      return pool.length ? { targetUids: pool.map((c) => c.uid) } : null;
    }
    case 'multi_graveyard_to_deck_bottom_then_draw': {
      const pools = eff.scope === 'either' ? [...ps.graveyard, ...opp.graveyard] : ps.graveyard;
      const pool = pools.filter((c) => getCard(c.cardId).type !== 'maryoku');
      if (pool.length < eff.minCount) return null;
      return { targetUids: pool.slice(0, eff.minCount).map((c) => c.uid) };
    }
    case 'carbonize_flexible_destroy_to_deck_bottom': {
      const haikei = opp.field.haikei[0];
      if (haikei) return { targetUid: haikei.uid };
      const holder = opp.field.ijin.find((i) => i.equippedCard);
      return holder ? { targetUid: holder.equippedCard.uid } : null;
    }
    case 'catastrophe_own_guardian_to_deck_bottom_destroy_all_ijin': {
      if (ps.guardians.length === 0 || opp.field.ijin.length === 0) return null;
      return { targetUid: ps.guardians[0].uid };
    }
    case 'multi_destroy_field_haikei_scaled_by_own_colors': {
      const colors = new Set();
      for (const i of ps.field.ijin) getCard(i.cardId).colors.forEach((c) => colors.add(c));
      const pool = opp.field.haikei.slice(0, colors.size);
      return pool.length ? { targetUids: pool.map((c) => c.uid) } : null;
    }
    case 'multi_tap_field_ijin_scaled_by_own_colors': {
      const colors = new Set();
      for (const i of ps.field.ijin) getCard(i.cardId).colors.forEach((c) => colors.add(c));
      const pool = opp.field.ijin.filter((i) => !i.tapped).slice(0, colors.size);
      return pool.length ? { targetUids: pool.map((c) => c.uid) } : null;
    }
    case 'multi_bounce_graveyard_mana_scaled_by_own_colors': {
      const colors = new Set();
      for (const i of ps.field.ijin) getCard(i.cardId).colors.forEach((c) => colors.add(c));
      const pool = ps.graveyard.filter((c) => getCard(c.cardId).type === 'maryoku').slice(0, colors.size);
      return pool.length ? { targetUids: pool.map((c) => c.uid) } : null;
    }
    case 'pressure_ijin_deck_bottom_if_attacker_else_tap': {
      const pool = opp.field.ijin.filter((i) => getCard(i.cardId).keywords && getCard(i.cardId).keywords.pressure);
      return pool.length ? { targetUid: pool[0].uid } : null;
    }
    case 'grant_opponent_mana_abilities_disabled_this_turn':
    case 'discard_own_hand_then_draw':
      return {};
    case 'destroy_own_ijin_or_guardian_and_opponent_field_card': {
      const ownPool = ps.field.ijin.slice().sort((a, b) => getCard(a.cardId).power - getCard(b.cardId).power);
      const oppPool = [...opp.field.ijin, ...opp.field.haikei];
      if (ownPool.length === 0 || oppPool.length === 0) return null;
      return { targetUid: ownPool[0].uid, targetUid2: oppPool[0].uid };
    }
    case 'bounce_flexible_mana_then_cannot_cast_mahou': {
      const target = opp.mana.find((m) => m.faceUp) || opp.mana[0];
      return target ? { targetUid: target.uid } : null;
    }
    case 'discard_hand_then_graveyard_to_hand_then_cannot_cast_mahou':
    case 'destroy_all_field_ijin_both_sides_no_legacy_then_cannot_attack':
      return null; // AIはこれらの重い自傷的効果を自発的には使わない
    case 'bounce_other_hand_to_deck_shuffle_draw7_then_cannot_cast_mahou':
    case 'deck_top_reveal_take_if_haikei_or_mahou_else_facedown_mana':
    case 'shuffle_graveyard_ijin_into_deck_then_reveal_top_take_if_ijin':
    case 'destroy_opponent_duplicate_named_non_mana_cards':
    case 'compare_hand_level_sum_discard_lower':
    case 'mill_opponent_scaled_by_tapped_field_both_sides_times3':
      return {};
    case 'bounce_all_mana_both_sides_to_hand':
      return null; // AIは自分のマナも失うこの効果を自発的には使わない
    case 'draw_scaled_by_opponent_hand_excess_then_cannot_attack':
      return opp.hand.length > ps.hand.length ? {} : null;
    case 'mill_self_then_place_graveyard_card_level_at_most_mana_level':
    case 'grant_temp_indestructible_and_kokai_attack_bonus_all_own_ijin':
    case 'reveal_and_discard_non_maryoku_opponent_facedown_mana':
    case 'reveal_opponent_guardians_and_facedown_mana':
      return {};
    case 'flip_own_guardian_or_facedown_mana_by_uid': {
      // レベル6以下のイジンに化ける可能性のある候補(パワーが高そうなもの)を優先しつつ、
      // 候補があれば適当に選ぶ(公式は完全ランダム性を持つ効果)。
      const pool = [...ps.guardians, ...ps.mana.filter((m) => !m.faceUp)];
      return pool.length ? { targetUid: pool[0].uid } : null;
    }
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
      const meisoCandidate = !equipCandidate && ps.graveyard.find((g) => {
        const eqCard = getCard(g.cardId);
        const hasMeiso = (eqCard.keywords && eqCard.keywords.meiso) || g.hasMeiso;
        if (!hasMeiso || !eqCard.meisoEquip) return false;
        if (eqCard.meisoEquip.colorAny && !card.colors.some((c) => eqCard.meisoEquip.colorAny.includes(c))) return false;
        if (eqCard.meisoEquip.requireTrait) {
          const kw = card.keywords;
          const hasTrait = kw && (kw.trait === eqCard.meisoEquip.requireTrait || (kw.traits && kw.traits.includes(eqCard.meisoEquip.requireTrait)));
          if (!hasTrait) return false;
        }
        return true;
      });
      if (equipCandidate) payload.equipCardUid = equipCandidate.uid;
      else if (meisoCandidate) payload.equipCardUid = meisoCandidate.uid;
      engine.summonIjin(game, botId, payload);
      return { done: true, attacked: false };
    }
  }

  const hankonAltHaikei = ps.field.haikei.find((h) => {
    const c = getCard(h.cardId);
    return c.keywords && c.keywords.hankonAltCostSelf;
  });
  if (ps.guardians.length > 0 || hankonAltHaikei) {
    const hankonCandidate = ps.graveyard.find((c) => {
      const card = getCard(c.cardId);
      return card.type === 'ijin' && card.legacyText === '反魂';
    });
    if (hankonCandidate) {
      const payload = { cardUid: hankonCandidate.uid };
      if (ps.guardians.length > 0) payload.guardianUid = ps.guardians[0].uid;
      else payload.altCostHaikeiUid = hankonAltHaikei.uid;
      const result = engine.reviveHankon(game, botId, payload);
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

  // 英傑集う大河: 相手が3体以上でアタックしてきたら、最もパワーの高いアタッカー1体を
  // アタッカーでない状態にして、これを破壊する(常に有利なので使えるなら必ず使う)。
  let eiketsuExtra = {};
  let effectiveAttackers = battle.attackers;
  if (battle.attackers.length >= 3) {
    const eiketsu = ps.field.haikei.find((h) => {
      const kw = getCard(h.cardId).keywords;
      return kw && kw.removeAttackerAndDestroySelfIfThreeOrMoreAttackers;
    });
    if (eiketsu) {
      const withPower = battle.attackers
        .map((entry) => attackerPs.field.ijin.find((i) => i.uid === entry.uid))
        .filter(Boolean);
      if (withPower.length > 0) {
        const target = withPower.reduce((a, b) => (engine.effectivePower(b, attackerPs) > engine.effectivePower(a, attackerPs) ? b : a));
        eiketsuExtra = { eiketsuHaikeiUid: eiketsu.uid, eiketsuTargetAttackerUid: target.uid };
        effectiveAttackers = battle.attackers.filter((e) => e.uid !== target.uid);
      }
    }
  }

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

  for (const entry of effectiveAttackers) {
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
      // 好太王・クリストファー・コロンブス等: イジンにブロックされない(パワー条件つき/絶対)。
      const ijinBlockersAllowed = availableIjin.filter((iUid) => {
        if (!attackerCard.static) return true;
        if (attackerCard.static.unblockableByIjin) return false;
        if (attackerCard.static.unblockableBelowPower != null) {
          const blockerInst = ps.field.ijin.find((i) => i.uid === iUid);
          if (blockerInst && engine.blockContextPower(blockerInst, ps) <= attackerCard.static.unblockableBelowPower) return false;
        }
        return true;
      });
      for (const iUid of ijinBlockersAllowed) {
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

  const opp = attackerPs;
  const blockerTriggerTargets = {};
  for (const uid of usedIjin) {
    const inst = ps.field.ijin.find((i) => i.uid === uid);
    if (!inst) continue;
    const card = getCard(inst.cardId);
    const onBecomeBlocker = card.triggers && card.triggers.onBecomeBlocker;
    if (onBecomeBlocker && onBecomeBlocker.needsTarget) {
      const t = chooseGenericEffectTarget(ps, opp, onBecomeBlocker.effect, inst);
      if (t) blockerTriggerTargets[uid] = t;
    }
  }

  return Object.assign({ assignments, blockerTriggerTargets }, eiketsuExtra);
}

// カード名宣言型の誘発型能力(ミシェル・ノストラダムス、賀茂保憲): 実際の相手の山札・
// ガーディアンの中身は覗かず、自分の山札に含まれるカードの名前を「宣言」する簡易ロジック。
function chooseEndTurnTriggerTargets(game, playerId) {
  const ps = game.playerStates[playerId];
  const opp = game.playerStates[engine.opponentId(game, playerId)];
  const endTriggerTargets = {};
  for (const inst of [...ps.field.ijin, ...ps.field.haikei]) {
    const card = getCard(inst.cardId);
    const trig = card.triggers && card.triggers.onEndStart;
    if (!trig || !trig.needsTarget) continue;
    const guessPool = ps.deck.length > 0 ? ps.deck : ps.field.ijin.concat(ps.field.haikei);
    if (guessPool.length === 0) continue;
    const guessName = getCard(guessPool[Math.floor(Math.random() * guessPool.length)].cardId).name;
    if (trig.needsTarget === 'declareCardName') {
      endTriggerTargets[inst.uid] = { name: guessName };
    } else if (trig.needsTarget === 'declareCardNameAndOpponentGuardian') {
      if (opp.guardians.length === 0) continue;
      endTriggerTargets[inst.uid] = { name: guessName, targetUid: opp.guardians[0].uid };
    }
  }
  return endTriggerTargets;
}

// 遺業能力(発動できる/任意)の解決。CPUは基本的に常に発動する
// (これまでの自動発動時の挙動・強さを踏襲する簡易ヒューリスティック)。
function decideLegacyTrigger(game, botId, pending) {
  const ps = game.playerStates[botId];
  const instance = ps.graveyard.find((c) => c.uid === pending.cardUid);
  if (!instance) return { cardUid: pending.cardUid, skip: true };
  const card = getCard(instance.cardId);
  if (!card.legacy) return { cardUid: pending.cardUid, skip: true };
  if (card.legacy.type === 'kodama') {
    const canFromGraveyard = engine.canPlaceFromGraveyardToField(ps);
    const pool = [...ps.hand, ...(canFromGraveyard ? ps.graveyard : [])].filter(
      (c) => c.uid !== instance.uid && getCard(c.cardId).type === 'ijin' && getCard(c.cardId).level < card.level
    );
    if (pool.length === 0) return { cardUid: pending.cardUid, skip: true };
    pool.sort((a, b) => getCard(b.cardId).level - getCard(a.cardId).level);
    return { cardUid: pending.cardUid, skip: false, targetUid: pool[0].uid };
  }
  if (card.legacy.type === 'return_to_deck_top_or_bottom') {
    return { cardUid: pending.cardUid, skip: false, position: 'top' };
  }
  return { cardUid: pending.cardUid, skip: false };
}

// ヒエロスガモス等: ドロー後に捨てる手札を選ぶ。レベルの低いカードから優先して捨てる
// 簡易ヒューリスティック(このカード自身は対象から除く)。
function decideManaOnPlaceDiscard(game, botId, pending) {
  const ps = game.playerStates[botId];
  const pool = ps.hand
    .filter((c) => c.uid !== pending.cardUid)
    .slice()
    .sort((a, b) => getCard(a.cardId).level - getCard(b.cardId).level);
  return pool.slice(0, pending.count).map((c) => c.uid);
}

// 汎用のpendingEffectChoice向け簡易ヒューリスティック。プールの由来ゾーンに応じて、
// 手札からの選択(捨てる/裏にする等)ならレベルの低いカードを優先し、墓地からの選択
// (蘇生/回収等)ならレベルの高いカードを優先する。
function decideEffectChoice(game, botId, pending) {
  const ps = game.playerStates[botId];
  const instances = pending.pool.map((uid) => engine.findInstance(ps, uid)).filter(Boolean).map((f) => f.instance);
  const preferHigh = pending.poolZone === 'graveyard';
  instances.sort((a, b) => {
    const diff = getCard(a.cardId).level - getCard(b.cardId).level;
    return preferHigh ? -diff : diff;
  });
  const count = Math.min(Math.max(pending.min, 1), instances.length);
  return instances.slice(0, count).map((c) => c.uid);
}

// マリガンするかどうかの簡易ヒューリスティック。初手にレベル2以下の低コストカードが
// 2枚未満(≒序盤に何もできない事故手札)なら引き直す。
function decideMulligan(game, botId) {
  const ps = game.playerStates[botId];
  const lowCostCount = ps.hand.filter((c) => getCard(c.cardId).level <= 2).length;
  return lowCostCount < 2;
}

// カルドロン等: 選んだ手札を墓地に置くか裏向き魔力にするかの簡易ヒューリスティック。
// マリョクが不足気味なら裏向き魔力にして加速し、足りていれば墓地へ送る。
function decideManaCardDestinationChoice(game, botId) {
  const ps = game.playerStates[botId];
  return ps.mana.length < 4 ? 'facedown_mana' : 'graveyard';
}

module.exports = {
  botTakeMainPhaseStep,
  botDecideBlock,
  chooseEndTurnTriggerTargets,
  decideLegacyTrigger,
  decideManaOnPlaceDiscard,
  decideEffectChoice,
  decideMulligan,
  decideManaCardDestinationChoice,
};
