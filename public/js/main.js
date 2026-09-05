(function () {
  'use strict';

  const socket = io();
  let gs = null; // 最新の state_update
  let attackMode = false;
  let selectedAttackers = new Set();
  let blockAssignments = {}; // attackerUid -> Set(blockerUid)
  let selectedColor = 'red';
  let cardList = []; // 全カードデータ(デッキ編集用)
  let cardById = {};
  let customDeck = loadCustomDeck(); // { cardId: count }
  const dbFilter = { color: 'all', type: 'all', search: '' };

  const $ = (id) => document.getElementById(id);

  // ---------------- 自分のデッキ(ローカル保存) ----------------

  function loadCustomDeck() {
    try {
      const raw = localStorage.getItem('ijinden_custom_deck_v1');
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function saveCustomDeck() {
    try { localStorage.setItem('ijinden_custom_deck_v1', JSON.stringify(customDeck)); } catch (e) { /* noop */ }
  }
  function customDeckTotal() {
    return Object.values(customDeck).reduce((a, b) => a + b, 0);
  }
  function customDeckSpec() {
    return Object.entries(customDeck).filter(([, n]) => n > 0).map(([cardId, count]) => ({ cardId, count }));
  }
  function updateMyDeckStatusUI() {
    const total = customDeckTotal();
    const el = $('my-deck-status-text');
    if (!el) return;
    if (total >= 40) el.textContent = `自分のデッキ: 使用中(${total}枚)`;
    else if (total > 0) el.textContent = `自分のデッキ: 作成中(${total}枚、40枚以上で使用可能)`;
    else el.textContent = '自分のデッキ: 未作成(上の簡易デッキを使用します)';
  }

  // ---------------- ロビー ----------------

  socket.on('colors', (colors) => {
    const wrap = $('color-select');
    wrap.innerHTML = '';
    colors.forEach((c, i) => {
      const div = document.createElement('div');
      div.className = 'color-opt ' + c.color + (i === 0 ? ' selected' : '');
      div.textContent = c.label;
      div.dataset.color = c.color;
      div.addEventListener('click', () => {
        document.querySelectorAll('.color-opt').forEach((el) => el.classList.remove('selected'));
        div.classList.add('selected');
        selectedColor = c.color;
      });
      wrap.appendChild(div);
    });
    if (colors.length) selectedColor = colors[0].color;
  });

  socket.on('card_list', (list) => {
    cardList = list;
    cardById = {};
    list.forEach((c) => { cardById[c.id] = c; });
    renderDeckBuilder();
  });

  updateMyDeckStatusUI();

  function currentDeckPayload() {
    return customDeckTotal() >= 40 ? { deck: customDeckSpec() } : {};
  }

  $('btn-create').addEventListener('click', () => {
    const name = $('input-name').value.trim() || 'プレイヤー';
    socket.emit('create_room', Object.assign({ name, color: selectedColor }, currentDeckPayload()), (res) => {
      if (!res.ok) { setLobbyStatus(res.error); return; }
      $('room-code-display').textContent = res.roomId;
      $('lobby-waiting').classList.remove('hidden');
      setLobbyStatus('');
    });
  });

  $('btn-cpu').addEventListener('click', () => {
    const name = $('input-name').value.trim() || 'プレイヤー';
    setLobbyStatus('CPU対戦を準備しています…');
    socket.emit('create_cpu_game', Object.assign({ name, color: selectedColor }, currentDeckPayload()), (res) => {
      if (!res.ok) { setLobbyStatus(res.error); return; }
      setLobbyStatus('');
    });
  });

  $('btn-join').addEventListener('click', () => {
    const name = $('input-name').value.trim() || 'プレイヤー';
    const roomId = $('input-room-code').value.trim().toUpperCase();
    if (!roomId) { setLobbyStatus('部屋コードを入力してください。'); return; }
    socket.emit('join_room', Object.assign({ roomId, name, color: selectedColor }, currentDeckPayload()), (res) => {
      if (!res.ok) { setLobbyStatus(res.error); return; }
      setLobbyStatus('参加しました。対戦を開始します…');
    });
  });

  function setLobbyStatus(text) { $('lobby-status').textContent = text || ''; }

  // ---------------- デッキ編集 ----------------

  $('btn-open-deckbuilder').addEventListener('click', () => {
    $('screen-lobby').classList.add('hidden');
    $('screen-deckbuilder').classList.remove('hidden');
    renderDeckBuilder();
  });

  $('btn-db-save').addEventListener('click', () => {
    if (customDeckTotal() < 40) { alert('デッキは40枚以上必要です。'); return; }
    saveCustomDeck();
    updateMyDeckStatusUI();
    $('screen-deckbuilder').classList.add('hidden');
    $('screen-lobby').classList.remove('hidden');
  });

  $('btn-db-cancel').addEventListener('click', () => {
    customDeck = loadCustomDeck();
    $('screen-deckbuilder').classList.add('hidden');
    $('screen-lobby').classList.remove('hidden');
  });

  $('btn-db-clear').addEventListener('click', () => {
    if (!confirm('採用カードを全て削除します。よろしいですか？')) return;
    customDeck = {};
    renderDeckBuilder();
  });

  const COLOR_FILTER_OPTS = [
    { key: 'all', label: '全色' }, { key: 'red', label: '赤' }, { key: 'blue', label: '青' },
    { key: 'green', label: '緑' }, { key: 'yellow', label: '黄' }, { key: 'purple', label: '紫' },
    { key: 'colorless', label: '無色' },
  ];
  const TYPE_FILTER_OPTS = [
    { key: 'all', label: '全種別' }, { key: 'ijin', label: 'イジン' }, { key: 'mahou', label: 'マホウ' },
    { key: 'haikei', label: 'ハイケイ' }, { key: 'maryoku', label: 'マリョク' },
  ];

  function buildFilterRow(containerId, opts, stateKey) {
    const el = $(containerId);
    el.innerHTML = '';
    opts.forEach((o) => {
      const btn = document.createElement('button');
      btn.textContent = o.label;
      btn.className = dbFilter[stateKey] === o.key ? 'active' : '';
      btn.addEventListener('click', () => {
        dbFilter[stateKey] = o.key;
        renderDeckBuilder();
      });
      el.appendChild(btn);
    });
  }

  $('db-search').addEventListener('input', (e) => {
    dbFilter.search = e.target.value.trim();
    renderDeckBuilder();
  });

  function cardMatchesFilter(c) {
    if (dbFilter.type !== 'all' && c.type !== dbFilter.type) return false;
    if (dbFilter.color === 'colorless' && c.colors.length !== 0) return false;
    if (dbFilter.color !== 'all' && dbFilter.color !== 'colorless' && !c.colors.includes(dbFilter.color)) return false;
    if (dbFilter.search && !c.name.includes(dbFilter.search)) return false;
    return true;
  }

  function dbCardTile(card, count, onClick) {
    const div = document.createElement('div');
    div.className = 'db-card-tile' + (count > 0 ? ' selected' : '');
    const typeLabel = { ijin: 'イジン', mahou: 'マホウ', haikei: 'ハイケイ', maryoku: 'マリョク' }[card.type] || '';
    let titleText = `${card.name} / ${typeLabel} / Lv${card.level}`;
    if (card.power != null) titleText += ` / パワー${card.power}`;
    if (card.magicCost != null) titleText += ` / 魔力コスト${card.magicCost}`;
    if (card.text) titleText += `\n${card.text}`;
    div.title = titleText;

    const nameLabel = document.createElement('div');
    nameLabel.className = 'db-name-label';
    nameLabel.textContent = card.name;
    if (card.imageUrl) {
      const img = document.createElement('img');
      img.src = card.imageUrl;
      img.loading = 'lazy';
      img.alt = card.name;
      img.onerror = () => { img.style.display = 'none'; div.classList.add('img-fallback'); };
      div.appendChild(img);
      div.appendChild(nameLabel);
    } else {
      div.classList.add('img-fallback');
      div.appendChild(nameLabel);
    }
    if (count > 0) {
      const badge = document.createElement('div');
      badge.className = 'db-qty-badge';
      badge.textContent = `x${count}`;
      div.appendChild(badge);
    }
    if (onClick) div.addEventListener('click', onClick);
    return div;
  }

  function renderDeckBuilder() {
    if (!cardList.length) return;
    buildFilterRow('db-color-filters', COLOR_FILTER_OPTS, 'color');
    buildFilterRow('db-type-filters', TYPE_FILTER_OPTS, 'type');

    const listEl = $('db-card-list');
    listEl.innerHTML = '';
    cardList.filter(cardMatchesFilter).forEach((c) => {
      const count = customDeck[c.id] || 0;
      const cap = c.anyNumCopies ? Infinity : 4;
      const el = dbCardTile(c, count, () => {
        const cur = customDeck[c.id] || 0;
        if (cur >= cap) return;
        customDeck[c.id] = cur + 1;
        renderDeckBuilder();
      });
      listEl.appendChild(el);
    });

    const deckListEl = $('db-deck-list');
    deckListEl.innerHTML = '';
    const entries = Object.entries(customDeck).filter(([, n]) => n > 0)
      .map(([id, n]) => ({ card: cardById[id], count: n }))
      .filter((e) => e.card)
      .sort((a, b) => a.card.type.localeCompare(b.card.type) || a.card.level - b.card.level);
    entries.forEach(({ card, count }) => {
      const row = document.createElement('div');
      row.className = 'db-deck-row';
      const typeLabel = { ijin: 'イジン', mahou: 'マホウ', haikei: 'ハイケイ', maryoku: 'マリョク' }[card.type] || '';
      row.innerHTML = `<span class="ddr-name">${escapeHtml(card.name)} <span style="color:#6b7280">(${typeLabel} Lv${card.level})</span></span><span>x${count}</span>`;
      const minusBtn = document.createElement('button');
      minusBtn.className = 'secondary-btn';
      minusBtn.textContent = '-1';
      minusBtn.addEventListener('click', () => {
        customDeck[card.id] = Math.max(0, (customDeck[card.id] || 0) - 1);
        if (customDeck[card.id] === 0) delete customDeck[card.id];
        renderDeckBuilder();
      });
      row.appendChild(minusBtn);
      deckListEl.appendChild(row);
    });

    const total = customDeckTotal();
    $('db-deck-count').textContent = total;
    const statusEl = $('db-deck-status');
    if (total >= 40) { statusEl.textContent = 'OK(40枚以上)'; statusEl.className = 'db-deck-status ok'; }
    else { statusEl.textContent = `あと${40 - total}枚必要`; statusEl.className = 'db-deck-status bad'; }
  }

  // ---------------- ゲーム状態受信 ----------------

  socket.on('state_update', (state) => {
    gs = state;
    if (gs.phase !== 'block') { blockAssignments = {}; }
    if (!(gs.phase === 'main' && gs.activePlayerId === gs.me.id)) { attackMode = false; selectedAttackers.clear(); }
    $('screen-lobby').classList.add('hidden');
    $('screen-game').classList.remove('hidden');
    render();
  });

  socket.on('opponent_disconnected', () => {
    appendSystemLog('相手が切断しました。');
  });

  function appendSystemLog(text) {
    const panel = $('log-panel');
    const div = document.createElement('div');
    div.textContent = '⚠ ' + text;
    panel.appendChild(div);
    panel.scrollTop = panel.scrollHeight;
  }

  function sendAction(action, cb) {
    socket.emit('action', action, (res) => {
      const result = res || { ok: true };
      if (!result.ok && !cb) alert(result.error || '操作に失敗しました。');
      if (cb) cb(result);
    });
  }

  function showModalError(text) {
    let el = document.querySelector('#modal-content .modal-error');
    if (!el) {
      el = document.createElement('div');
      el.className = 'modal-error';
      el.style.color = '#ff8080';
      el.style.fontSize = '12px';
      el.style.marginTop = '8px';
      $('modal-content').appendChild(el);
    }
    el.textContent = text;
  }

  // ---------------- カード描画 ----------------

  function colorClass(c) { return c || 'none'; }

  function cardEl(card, opts) {
    opts = opts || {};
    const div = document.createElement('div');
    const classes = ['card', colorClass(card.color)];
    if (opts.small) classes.push('small');
    if (card.tapped) classes.push('tapped');
    if (card.sick) classes.push('sick');
    if (opts.selected) classes.push('selected');
    if (opts.targetable) classes.push('targetable');
    if (card.hidden) classes.push('hidden-card');
    if (card.faceDown) classes.push('facedown');
    if (card.type) div.dataset.cardType = card.type;
    if (card.name) div.dataset.cardName = card.name;

    if (card.hidden) {
      div.className = classes.join(' ');
      div.title = '相手の裏向きカード';
    } else if (card.imageUrl) {
      classes.push('has-image');
      div.className = classes.join(' ');
      const img = document.createElement('img');
      img.src = card.imageUrl;
      img.alt = card.name || '';
      img.loading = 'lazy';
      img.onerror = () => { img.style.display = 'none'; div.classList.add('img-fallback'); };
      div.appendChild(img);
      if (card.faceDown) {
        const badge = document.createElement('div');
        badge.className = 'c-facedown-badge';
        badge.textContent = '裏';
        div.appendChild(badge);
      }
      const nameLabel = document.createElement('div');
      nameLabel.className = 'c-name-label';
      nameLabel.textContent = card.name || '';
      div.appendChild(nameLabel);
      div.title = card.name + (card.text ? '\n' + card.text : '');
    } else {
      div.className = classes.join(' ');
      const top = document.createElement('div');
      top.className = 'c-top';
      const typeLabel = { ijin: 'イジン', mahou: 'マホウ', haikei: 'ハイケイ', maryoku: 'マリョク' }[card.type] || '';
      top.innerHTML = `<span>${typeLabel}${card.faceDown ? '(裏)' : ''}</span><span>Lv${card.level != null ? card.level : ''}</span>`;
      div.appendChild(top);

      const name = document.createElement('div');
      name.className = 'c-name';
      name.textContent = card.name || '';
      div.appendChild(name);

      const bottom = document.createElement('div');
      bottom.className = 'c-power';
      if (card.type === 'ijin' && card.power != null) bottom.textContent = card.power;
      else if (card.type === 'mahou' && card.magicCost != null) bottom.textContent = 'コスト' + card.magicCost;
      div.appendChild(bottom);

      div.title = card.name + (card.text ? '\n' + card.text : '');
    }

    if (opts.onClick) div.addEventListener('click', (e) => { e.stopPropagation(); opts.onClick(card); });
    return div;
  }

  function guardianEl(g, opts) {
    opts = opts || {};
    const div = document.createElement('div');
    div.className = 'guardian-card' + (g.tapped ? ' tapped' : '') + (opts.selected ? ' selected' : '') + (opts.targetable ? ' targetable' : '');
    div.title = 'ガーディアン';
    if (opts.onClick) div.addEventListener('click', (e) => { e.stopPropagation(); opts.onClick(g); });
    return div;
  }

  function fillZone(elId, cards, opts) {
    const el = $(elId);
    el.innerHTML = '';
    cards.forEach((c) => el.appendChild(cardEl(c, opts && opts(c))));
  }

  // ---------------- メイン描画 ----------------

  function render() {
    if (!gs) return;

    $('opp-name').textContent = gs.opponent.name;
    $('opp-color').textContent = gs.opponent.color;
    $('opp-color').className = 'badge ' + gs.opponent.color;
    $('opp-deckname').textContent = gs.opponent.deckName ? `『${gs.opponent.deckName}』` : '';
    $('opp-deck-count').textContent = gs.opponent.deckCount;
    $('opp-hand-count').textContent = gs.opponent.handCount;
    $('opp-guardian-count').textContent = gs.opponent.guardianCount;

    $('my-name').textContent = gs.me.name;
    $('my-color').textContent = gs.me.color;
    $('my-color').className = 'badge ' + gs.me.color;
    $('my-deckname').textContent = gs.me.deckName ? `『${gs.me.deckName}』` : '';
    $('my-deck-count').textContent = gs.me.deckCount;
    $('my-mana-right').textContent = gs.me.manaRight;
    $('my-summon-right').textContent = gs.me.summonRight;

    const isMyTurn = gs.activePlayerId === gs.me.id;
    const isMainAndMine = gs.phase === 'main' && isMyTurn;

    // 相手フィールド
    fillZone('opp-field-ijin', gs.opponent.field.ijin, () => ({ onClick: (c) => onOpponentIjinClick(c) }));
    fillZone('opp-field-haikei', gs.opponent.field.haikei, () => ({ onClick: (c) => showCardDetail(c) }));
    fillZone('opp-mana', gs.opponent.mana, () => ({ small: true, onClick: (c) => { if (!c.hidden) showCardDetail(c); } }));
    fillZone('opp-graveyard', gs.opponent.graveyard, () => ({ small: true, onClick: (c) => showCardDetail(c) }));
    const oppGuardEl = $('opp-guardians');
    oppGuardEl.innerHTML = '';
    (gs.opponent.guardians || []).forEach((g) => oppGuardEl.appendChild(guardianEl(g, { onClick: () => onOpponentGuardianClick(g) })));

    // 自分フィールド
    const isBlockerAssigned = (uid) => Object.values(blockAssignments).some((set) => set.has(uid));
    const iAmDefender = gs.phase === 'block' && gs.pendingBattle && gs.pendingBattle.attackerPlayerId !== gs.me.id;
    fillZone('my-field-ijin', gs.me.field.ijin, (c) => ({
      selected: (attackMode && selectedAttackers.has(c.uid)) || isBlockerAssigned(c.uid),
      onClick: (card) => onMyIjinFieldClick(card),
    }));
    fillZone('my-field-haikei', gs.me.field.haikei, () => ({ onClick: (c) => showCardDetail(c) }));
    fillZone('my-mana', gs.me.mana, (c) => {
      const canStandBlock = iAmDefender && c.faceDown && c.type === 'ijin' && c.keywords && c.keywords.stand
        && gs.me.mana.some((m) => !m.faceDown && !m.hidden && c.colors.some((col) => (m.colors || []).includes(col)));
      if (canStandBlock) {
        return { small: true, selected: isBlockerAssigned(c.uid), targetable: true, onClick: () => toggleGuardianBlocker(c.uid) };
      }
      return { small: true, onClick: (card) => showCardDetail(card) };
    });
    fillZone('my-graveyard', gs.me.graveyard, () => ({ small: true, onClick: (c) => onMyGraveyardClick(c) }));
    const myGuardEl = $('my-guardians');
    myGuardEl.innerHTML = '';
    (gs.me.guardians || []).forEach((g) => myGuardEl.appendChild(guardianEl(g, {
      targetable: iAmDefender && !g.tapped,
      onClick: iAmDefender && !g.tapped ? () => toggleGuardianBlocker(g.uid) : undefined,
    })));

    // 手札
    fillZone('my-hand', gs.me.hand, () => ({ onClick: (c) => onMyHandClick(c) }));

    renderTurnIndicator();
    renderActionButtons(isMainAndMine);
    renderBattlePanel();
    renderLog();

    if (gs.winner) showGameOver();
    else $('game-over-overlay').classList.add('hidden');
  }

  function renderTurnIndicator() {
    const el = $('turn-indicator');
    if (gs.phase === 'gameover') { el.textContent = 'ゲーム終了'; return; }
    const isMyTurn = gs.activePlayerId === gs.me.id;
    const phaseLabel = { main: 'メインフェイズ', block: 'バトル中' }[gs.phase] || gs.phase;
    el.textContent = `ターン${gs.turnNumber} - ${isMyTurn ? 'あなたの番' : `${gs.opponent.name}の番`} (${phaseLabel})`;
  }

  function renderActionButtons(isMainAndMine) {
    const btnAttack = $('btn-attack');
    const btnEnd = $('btn-end-turn');
    const btnCancel = $('btn-cancel-select');

    if (gs.phase === 'block') {
      btnAttack.classList.add('hidden');
      btnEnd.classList.add('hidden');
      btnCancel.classList.add('hidden');
      return;
    }

    if (!isMainAndMine) {
      btnAttack.classList.add('hidden');
      btnEnd.classList.add('hidden');
      btnCancel.classList.add('hidden');
      return;
    }

    btnEnd.classList.remove('hidden');
    btnEnd.disabled = false;

    const canAttack = gs.me.field.ijin.length > 0 && (!gs.me.attackedThisTurn || gs.me.extraBattleAvailable);
    if (attackMode) {
      btnAttack.textContent = `アタック確定(${selectedAttackers.size}体)`;
      btnAttack.classList.remove('hidden');
      btnAttack.disabled = selectedAttackers.size === 0;
      btnCancel.classList.remove('hidden');
    } else {
      btnAttack.textContent = 'アタック宣言';
      btnAttack.classList.toggle('hidden', !canAttack);
      btnAttack.disabled = false;
      btnCancel.classList.add('hidden');
    }
  }

  $('btn-attack').addEventListener('click', () => {
    if (!attackMode) {
      attackMode = true;
      selectedAttackers.clear();
      render();
    } else {
      if (selectedAttackers.size === 0) return;
      const attackerUids = Array.from(selectedAttackers);
      const needTargetCards = attackerUids
        .map((uid) => gs.me.field.ijin.find((c) => c.uid === uid))
        .filter((c) => c && c.triggers && c.triggers.onAttacker && c.triggers.onAttacker.needsTarget);
      const finish = (attackerTriggerTargets) => {
        sendAction(Object.assign({ type: 'declare_attack', attackerUids }, attackerTriggerTargets ? { attackerTriggerTargets } : {}));
        attackMode = false;
        selectedAttackers.clear();
      };
      if (needTargetCards.length > 0) {
        openAttackTriggerTargetModal(needTargetCards, 0, {}, finish);
      } else {
        finish(null);
      }
    }
  });

  function openAttackTriggerTargetModal(cards, index, acc, onDone) {
    if (index >= cards.length) { closeModal(); onDone(acc); return; }
    const card = cards[index];
    const wrap = document.createElement('div');
    wrap.innerHTML = `<h3>${escapeHtml(card.name)}の能力</h3><div class="select-hint">アタッカーになったとき: ${describeTriggerEffect(card.triggers.onAttacker.effect)}</div>`;
    const built = buildTargetUI(card.triggers.onAttacker.effect, card);
    if (built) wrap.appendChild(built.el);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const ok = document.createElement('button');
    ok.textContent = index === cards.length - 1 ? 'アタック確定' : '次へ';
    ok.onclick = () => {
      const payload = built ? built.getPayload() : {};
      if (payload.targetUid) acc[card.uid] = payload.targetUid;
      openAttackTriggerTargetModal(cards, index + 1, acc, onDone);
    };
    actions.appendChild(ok);
    wrap.appendChild(actions);
    openModal(wrap);
  }

  $('btn-cancel-select').addEventListener('click', () => {
    attackMode = false;
    selectedAttackers.clear();
    render();
  });

  $('btn-end-turn').addEventListener('click', () => {
    sendAction({ type: 'end_turn' });
  });

  function onMyIjinFieldClick(card) {
    if (attackMode) {
      if (card.tapped) return;
      const rush = (card.keywords && card.keywords.rush) || card.tempRushUntilEndOfTurn;
      if (card.sick && !rush) { appendSystemLog('このターンに出したイジンはアタッカーになれません(即応を除く)。'); return; }
      if (selectedAttackers.has(card.uid)) selectedAttackers.delete(card.uid);
      else selectedAttackers.add(card.uid);
      render();
      return;
    }
    if (gs.phase === 'block' && gs.pendingBattle && gs.pendingBattle.attackerPlayerId !== gs.me.id) {
      toggleBlocker(card.uid);
      return;
    }
    showCardDetail(card);
  }

  function onOpponentIjinClick(card) {
    // 相手フィールドは常に詳細表示のみ(ターゲット選択はモーダル内のセレクトで行う)
    showCardDetail(card);
  }
  function onOpponentGuardianClick() {
    appendSystemLog('相手のガーディアンは裏向きのため、内容は確認できません。');
  }

  // ---------------- 手札クリック → アクションモーダル ----------------

  function onMyHandClick(card) {
    const isMainAndMine = gs.phase === 'main' && gs.activePlayerId === gs.me.id;
    if (!isMainAndMine) { showCardDetail(card); return; }

    if (card.type === 'maryoku') {
      openModal(buildManaModal(card));
    } else if (card.type === 'ijin') {
      openModal(buildPlacementModal(card, '召喚', (payload, cb) => sendAction(Object.assign({ type: 'summon_ijin', cardUid: card.uid }, payload), cb)));
    } else if (card.type === 'haikei') {
      openModal(buildPlacementModal(card, '設置', (payload, cb) => sendAction(Object.assign({ type: 'play_haikei', cardUid: card.uid }, payload), cb)));
    } else if (card.type === 'mahou') {
      openModal(buildMahouModal(card));
    } else {
      showCardDetail(card);
    }
  }

  function onMyGraveyardClick(card) {
    const isMainAndMine = gs.phase === 'main' && gs.activePlayerId === gs.me.id;
    if (isMainAndMine && card.type === 'mahou' && card.legacyText === '冥府発動') {
      openModal(buildMeifuModal(card));
      return;
    }
    if (isMainAndMine && card.type === 'ijin' && card.legacyText === '反魂') {
      openModal(buildHankonModal(card));
      return;
    }
    showCardDetail(card);
  }

  function buildHankonModal(card) {
    const wrap = document.createElement('div');
    wrap.innerHTML = cardDetailHtml(card);
    const hint = document.createElement('div');
    hint.className = 'select-hint';
    hint.textContent = '反魂: 自分のガーディアン1体を山札の下に戻すことで、イジン召喚権を使わずに戦場に置けます。';
    wrap.appendChild(hint);

    const opts = gs.me.guardians.map((g, i) => ({ value: g.uid, label: `ガーディアン${i + 1}` }));
    const sel = selectEl(opts, '山札の下に戻すガーディアンを選択');
    wrap.appendChild(sel);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const ok = document.createElement('button');
    ok.textContent = '反魂';
    ok.onclick = () => {
      if (!sel.value) { alert('ガーディアンを選んでください。'); return; }
      sendAction({ type: 'revive_hankon', cardUid: card.uid, guardianUid: sel.value }, (res) => { if (res.ok) closeModal(); else showModalError(res.error); });
    };
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'キャンセル';
    cancel.onclick = closeModal;
    actions.appendChild(ok);
    actions.appendChild(cancel);
    wrap.appendChild(actions);
    return wrap;
  }

  function buildMeifuModal(card) {
    const wrap = document.createElement('div');
    wrap.innerHTML = cardDetailHtml(card);
    const hint = document.createElement('div');
    hint.className = 'select-hint';
    hint.textContent = '冥府発動: 色条件・レベル条件・魔力コストを無視して、墓地から発動できます(1ターンに1回まで)。';
    wrap.appendChild(hint);

    let targetGetter = () => ({});
    if (card.effect) {
      const built = buildTargetUI(card.effect, card);
      if (built) {
        wrap.appendChild(built.el);
        targetGetter = built.getPayload;
      }
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const ok = document.createElement('button');
    ok.textContent = '冥府発動';
    ok.onclick = () => {
      sendAction(Object.assign({ type: 'cast_mahou_from_graveyard', cardUid: card.uid }, targetGetter()), (res) => { if (res.ok) closeModal(); else showModalError(res.error); });
    };
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'キャンセル';
    cancel.onclick = closeModal;
    actions.appendChild(ok);
    actions.appendChild(cancel);
    wrap.appendChild(actions);
    return wrap;
  }

  function cardDetailHtml(card) {
    const typeLabel = { ijin: 'イジン', mahou: 'マホウ', haikei: 'ハイケイ', maryoku: 'マリョク' }[card.type] || '';
    const colorLabel = card.colors && card.colors.length ? card.colors.join('/') : '無色';
    let statLine = `${typeLabel} / ${colorLabel} / Lv${card.level}`;
    if (card.type === 'ijin') statLine += ` / パワー${card.power}`;
    if (card.type === 'mahou') statLine += ` / 魔力コスト${card.magicCost}`;
    const kw = [];
    if (card.keywords) {
      if (card.keywords.rush) kw.push('即応');
      if (card.keywords.pressure === 2) kw.push('ダブルプレッシャー');
      if (card.keywords.pressure === 3) kw.push('トリプルプレッシャー');
      if (card.keywords.watcher) kw.push('ウォッチャー');
      if (card.keywords.trait) kw.push('特性:' + card.keywords.trait);
    }
    return `
      <h3>${card.name}</h3>
      <div class="select-hint">${statLine}${kw.length ? ' / ' + kw.join(' ') : ''}</div>
      <p class="card-detail-text">${escapeHtml(card.text || '(テキストなし)')}</p>
      ${card.legacyText && card.legacyText !== '-' ? `<p class="card-detail-text">${escapeHtml(card.legacyText)}</p>` : ''}
    `;
  }

  function showCardDetail(card) {
    const wrap = document.createElement('div');
    wrap.innerHTML = cardDetailHtml(card);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const close = document.createElement('button');
    close.className = 'secondary';
    close.textContent = '閉じる';
    close.onclick = closeModal;
    actions.appendChild(close);
    wrap.appendChild(actions);
    openModal(wrap);
  }

  function describeTriggerEffect(eff) {
    const list = Array.isArray(eff) ? eff : [eff];
    return list.map((e) => {
      switch (e.type) {
        case 'draw': return `${e.value}ドローする`;
        case 'both_draw': return `自分が${e.selfValue}枚、相手が${e.oppValue}枚ドローする`;
        case 'summon_right_plus': return `イジン召喚権+${e.value}する`;
        case 'mana_right_plus': return `マリョク配置権+${e.value}する`;
        case 'bounce_own_guardian_to_hand': return '自分のガーディアン1体を手札に戻す';
        case 'generic_destroy_ijin': return '対象のイジンを破壊する(下で選択)';
        case 'generic_bounce_ijin': return '対象のイジンを手札に戻す(下で選択)';
        case 'bounce_from_graveyard': return '自分の墓地のイジン/ハイケイ1つを手札に戻す(下で選択)';
        case 'bounce_facedown_mana': return '自分の裏向きマリョク1つを手札に戻す(下で選択)';
        case 'generic_destroy_haikei': return '対象のハイケイを破壊する(下で選択)';
        case 'tap_target_ijin': return '対象のイジンを寝かせる(下で選択)';
        case 'draw_scaled_by_opponent_haikei': return '相手の戦場のハイケイ1つにつき1ドローする';
        case 'draw_then_discard_own_hand': return `${e.drawValue}ドローして、自分の手札1枚を墓地に置く(下で選択)`;
        case 'draw_then_destroy_self': return `${e.drawValue}ドローして、これを破壊する`;
        case 'deck_top_to_guardian': return '自分の山札の上から1枚をガーディアンにして戦場に置く';
        case 'deck_top_to_facedown_mana': return '自分の山札の上から1枚を裏のまま魔力ゾーンに置く';
        case 'mill_opponent': return `相手の山札の上から${e.value}枚を墓地に置く`;
        case 'own_guardian_to_deck_top': return '自分のガーディアン1体を山札の上に戻す';
        case 'all_facedown_mana_to_guardian': return '自分の魔力ゾーンの裏のカードすべてをガーディアンにして戦場に置く';
        case 'graveyard_card_to_guardian': return '自分の墓地のカード1つをガーディアンにする(下で選択)';
        case 'mill_self': return `自分の山札の上から${e.value}枚を墓地に置く`;
        case 'graveyard_to_deck_bottom_then_draw': return `自分の墓地のカード1つを山札の下に戻して${e.drawValue}ドローする(下で選択)`;
        case 'opponent_discard_random': return `相手の手札${e.value}枚を墓地に置く`;
        case 'discard_own_hand': return '自分の手札1枚を墓地に置く(下で選択)';
        case 'mill_self_then_temp_rush_self': return `自分の山札の上から${e.millValue}枚を墓地に置いて、このターンの間「即応」を得る`;
        case 'own_guardian_to_facedown_mana': return '自分のガーディアン1体を裏向きで魔力ゾーンに置く';
        case 'opponent_discard_random_non_maryoku': return `相手の手札のマリョクでないカード${e.value}枚を墓地に置く`;
        case 'opponent_discard_random_filtered': return `相手の手札の${e.cardType}${e.value}枚までを墓地に置く`;
        case 'destroy_own_guardian': return '自分のガーディアン1体を破壊する';
        case 'destroy_all_own_guardians': return '自分のガーディアンすべてを墓地に置く';
        case 'bounce_all_own_guardians': return '自分のガーディアンすべてを手札に戻す';
        case 'bounce_all_guardians_both_sides': return '自分と相手のガーディアンすべてを手札に戻す';
        case 'destroy_highest_power_field_ijin': return '場で最もパワーが高いイジン1体を破壊する(下で選択)';
        case 'draw_scaled_by_own_haikei': return '自分の戦場のハイケイ1つにつき1ドローする';
        case 'summon_right_plus_scaled_by_own_colors': return '自分の魔力ゾーンを裏にして、自分の戦場にある色1つにつきイジン召喚権+1する';
        case 'draw_scaled_by_own_trait_count': return `自分の戦場の「${e.trait}」イジン1体につき1ドローする`;
        case 'hand_card_to_deck_bottom_then_draw': return `自分の手札1枚を山札の下に戻して${e.drawValue}ドローする(下で選択)`;
        case 'haikei_to_deck_top': return `自分の戦場の${e.trait ? `「${e.trait}」` : ''}ハイケイ1つを山札の上に戻す(下で選択)`;
        case 'deck_bottom_all_tapped_opponent_ijin': return '相手の戦場の寝ているイジンすべてを山札の下に戻す';
        case 'destroy_all_opponent_field_level_at_most': return `相手の戦場のレベル${e.levelMax}以下のカードすべてを破壊する`;
        case 'bounce_all_graveyard_mahou_with_text': return `自分の墓地の「${e.requireText}」を持つマホウすべてを手札に戻す`;
        case 'flip_own_mana_facedown': return '自分の魔力ゾーンのマリョク1つを裏にする';
        case 'grant_temp_rush_self': return 'このターンの間「即応」を得る';
        case 'untap_self': return 'これを起こす';
        case 'tap_self': return 'これを寝かせる';
        case 'tap_all_other_field_ijin_then_self_to_deck_bottom': return '戦場の他のイジンすべてを寝かせて、これを山札の下に戻す';
        case 'bounce_graveyard_mahou_scaled_by_own_mana_colors': return '自分の魔力ゾーンの色1つにつき、自分の墓地のマホウ1つを手札に戻す';
        case 'opponent_discard_down_to_own_hand_count': return '相手の手札を自分の手札と同じ枚数になるまで墓地に置く';
        case 'manafy_highest_power_opponent_ijin': return '相手の戦場のパワーが最も高いイジン1体を裏にして相手の魔力ゾーンに置く';
        case 'bounce_graveyard_mahou_level_at_most_target_haikei': return 'このハイケイのレベル以下の自分の墓地のマホウ1つを手札に戻す';
        case 'bounce_self_to_hand': return 'これを手札に戻す';
        case 'deck_top_and_bottom_to_facedown_mana': return '自分の山札の上から1枚と下から1枚を裏のまま魔力ゾーンに置く';
        case 'tap_opponent_ijin_power_below_attacker': return 'このイジンのパワーより低いパワーを持つ、相手の戦場のイジンすべてを寝かせる';
        case 'deck_top_n_to_facedown_mana': return `自分の山札の上から${e.value}枚を裏のまま魔力ゾーンに置く`;
        case 'bounce_graveyard_mahou_color': return `自分の墓地の${e.color}のマホウ1つを手札に戻す`;
        case 'deck_top_reveal_place_if_haikei': return '自分の山札の上から1枚をめくって、ハイケイなら戦場に置く';
        case 'bounce_ijin_matching_color_of_placed_haikei': return 'このハイケイと同じ色を持つイジン1体を手札に戻す';
        case 'tap_all_non_shippitsu_ijin_both_sides': return '「執筆」を持たないイジンすべてを寝かせる';
        case 'deck_bottom_highest_power_opponent_ijin': return '相手の戦場のパワーが最も高いイジン1体を山札の下に戻す';
        case 'draw_scaled_by_own_color_count_then_destroy_self': return `自分の戦場の${e.color}のカード${e.divisor}つにつき1ドローして、これを破壊する`;
        case 'haikei_to_facedown_mana_by_uid': return 'このハイケイを裏にして魔力ゾーンに置く';
        case 'move_flexible_guardian_or_graveyard_to_deck_top': return '自分のガーディアン1体か墓地のカード1つを山札の上に戻す(下で選択)';
        case 'deck_bottom_highest_power_field_ijin_scaled_by_own_guardians': return '自分のガーディアン1体につき、戦場のイジン1体を山札の下に戻す';
        case 'flip_flexible_ijin_or_haikei_to_facedown_mana': return '対象のイジンかハイケイを裏にして魔力ゾーンに置く(下で選択)';
        case 'tap_flexible_own_ijin_or_guardian': return '自分の戦場のイジン1体かガーディアン1体を寝かせる(下で選択)';
        case 'destroy_flexible_tapped_ijin_or_guardian_auto': return '戦場の寝ているイジン1体か寝ているガーディアン1体を墓地に置く';
        case 'revive_flexible_ijin_or_haikei_from_graveyard': return `自分の墓地のレベル${e.ijinLevelMax}以下のイジン1体かレベル${e.haikeiLevelMax}以下のハイケイ1つを戦場に置く(下で選択)`;
        case 'bounce_up_to_two_graveyard_haikei_auto': return '自分の墓地のハイケイ最大2つを手札に戻す';
        case 'destroy_flexible_ijin_or_haikei': return '対象のイジンかハイケイを破壊する(下で選択)';
        case 'destroy_highest_power_untapped_opponent_ijin': return '相手の戦場の起きているイジンのうちパワーが最も高い1体を破壊する';
        case 'bounce_equipped_card_by_uid': return '対象の装備カードを手札に戻す(下で選択)';
        case 'bounce_own_facedown_cards_scaled_by_haikei_colors': return '自分の戦場のハイケイの色1つにつき、自分の魔力ゾーンの裏向きカード1つを手札に戻す';
        case 'bounce_all_field_trait_level_at_most': return `戦場のレベル${e.levelMax}以下の「${e.trait}」カードすべてを手札に戻す`;
        case 'flip_facedown_mana_haikei_to_field_then_bounce_and_summon_right': return `自分の魔力ゾーンの裏向きカード(レベル${e.levelMax}以下のハイケイ)を表向きで戦場に置いて、相手の戦場のパワーが最も高いイジン1体を山札の下に戻し、イジン召喚権+1する(下で選択)`;
        case 'deck_bottom_reveal_place_if_haikei': return '自分の山札の下から1枚をめくって、ハイケイなら戦場に置く';
        case 'grant_extra_battle': return '追加でバトルする';
        case 'bounce_own_guardian_auto': return '自分のガーディアン1体を手札に戻す';
        case 'destroy_scaled_by_own_hand_music_ijin_level_sum': return `自分の手札の「音楽」イジンのレベル合計が${e.threshold}以上なら相手の戦場のイジンすべてを、そうでなければ1体を破壊する`;
        case 'grant_temp_unblockable_at_least_power_self': return `このターンの間「パワー${e.value}以上のイジンにブロックされない」を得る`;
        case 'draw_scaled_by_opponent_colors_then_untap_all_own_ijin': return '相手の戦場の色1つにつき1ドローして、自分の戦場のイジンすべてを起こす';
        case 'tap_all_own_field_then_tap_opponent_scaled_by_non_attacker_count': return '自分の戦場のカードすべてを寝かせて、アタッカーでないカード1つにつき相手の戦場のカードを寝かせる';
        case 'catastrophe_own_guardian_to_deck_bottom_destroy_all_ijin': return '自分のガーディアン1体を山札の下に戻して、イジンすべてを破壊する(下で選択)';
        case 'multi_destroy_field_haikei_scaled_by_own_colors': return '自分の戦場にある色1つにつき1つまで、戦場のハイケイを破壊する(下で選択)';
        case 'multi_tap_field_ijin_scaled_by_own_colors': return '自分の戦場にある色1つにつき1つまで、戦場のイジンを寝かせる(下で選択)';
        case 'multi_bounce_graveyard_mana_scaled_by_own_colors': return '自分の戦場にある色1つにつき1つまで、墓地のマリョクを手札に戻す(下で選択)';
        case 'pressure_ijin_deck_bottom_if_attacker_else_tap': return '「プレッシャー」を持つイジン1体を指定し、アタッカーなら山札の下へ、そうでなければ寝かせる(下で選択)';
        case 'grant_opponent_mana_abilities_disabled_this_turn': return '相手はこのターンの間「自分の魔力ゾーンの能力は発動しない」を得る';
        case 'discard_own_hand_then_draw': return '自分の手札の他のカード1つを墓地に置いて、1ドローする';
        case 'destroy_own_ijin_or_guardian_and_opponent_field_card': return '自分のイジンかガーディアン1体と、相手の戦場のカード1つを破壊する(下で選択)';
        case 'bounce_flexible_mana_then_cannot_cast_mahou': return '自分か相手の魔力ゾーンのカード1つを手札に戻して、このターンの間マホウを使用できなくなる(下で選択)';
        case 'discard_hand_then_graveyard_to_hand_then_cannot_cast_mahou': return '自分の手札の他のカードすべてを墓地に置いて、自分の墓地のカード4つを手札に加え、このターンの間マホウを使用できなくなる';
        case 'destroy_all_field_ijin_both_sides_no_legacy_then_cannot_attack': return '自分と相手の戦場のイジンすべてを遺業能力なしで破壊し、このターンの間バトルを開始できなくなる';
        case 'bounce_other_hand_to_deck_shuffle_draw7_then_cannot_cast_mahou': return '自分の他の手札すべてを山札に戻してシャッフルし、7ドローする。その後このターンの間マホウを使用できなくなる';
        case 'deck_top_reveal_take_if_haikei_or_mahou_else_facedown_mana': return '自分の山札の上から1枚を見て、ハイケイかマホウなら手札に、そうでなければ裏のまま魔力ゾーンに置く';
        case 'shuffle_graveyard_ijin_into_deck_then_reveal_top_take_if_ijin': return '自分の墓地のイジンすべてを山札に戻してシャッフルし、山札の上から1枚をめくって、イジンなら手札に加える';
        case 'destroy_opponent_duplicate_named_non_mana_cards': return '相手の手札・戦場・墓地で同じカード名を持つマリョクでないカードすべてを破壊する';
        case 'compare_hand_level_sum_discard_lower': return '自分と相手の手札のレベル合計を比べ、低い方の手札すべてを墓地に置く';
        case 'mill_opponent_scaled_by_tapped_field_both_sides_times3': return '自分と相手の戦場の寝ているカード1つにつき3つ、相手の山札の上からカードを墓地に置く';
        case 'bounce_all_mana_both_sides_to_hand': return '自分と相手の魔力ゾーンのマリョクすべてを手札に戻す';
        case 'draw_scaled_by_opponent_hand_excess_then_cannot_attack': return '相手の手札が自分より多い分だけドローして、このターンの間バトルを開始できなくなる';
        case 'mill_self_then_place_graveyard_card_level_at_most_mana_level': return '自分の山札の上から5枚を墓地に置いて、自分の魔力レベル以下のレベルの墓地のイジンかハイケイ1つを戦場に置く(下で選択、任意)';
        case 'grant_temp_unblockable_and_indestructible_self': return 'このターンの間「イジンにブロックされず、破壊されない」を得る';
        case 'flexible_haikei_or_equipped_to_deck_bottom': return '対象のハイケイか装備されているカードを山札の下に戻す(下で選択)';
        case 'move_self_to_deck_bottom': return 'これを山札の下に戻す';
        case 'mill_self_then_graveyard_to_deck_top': return `自分の山札の上から${e.millValue}枚を墓地に置いて、墓地のカード1つを山札の上に戻す(下で選択)`;
        case 'mill_self_then_graveyard_to_hand_auto': return `自分の山札の上から${e.millValue}枚を墓地に置いて、自分の墓地のカード1つを手札に戻す`;
        case 'destroy_target_haikei_and_highest_power_opponent_ijin_at_most': return `このハイケイと、相手の戦場のパワー${e.powerMax}以下のイジン1体を破壊する`;
        case 'draw_entire_deck_then_optional_free_summon_then_reshuffle': return '自分の山札のカードすべてを手札に加え、任意でイジン1体を無償で戦場に置いた後、手札すべてを山札に戻してシャッフルする(下で選択)';
        case 'flip_own_color_matching_ijin_to_mana': return '自分の魔力ゾーンと同じ色を持つ自分のイジン1体を裏にして魔力ゾーンに置く(下で選択)';
        case 'bounce_opponent_ijin_scaled_by_own_shippitsu_count': return '自分の戦場の「執筆」を持つカード1つにつき1体まで、相手の戦場のイジンを手札に戻す';
        case 'buff_or_tap_target_ijin_conditional': return '自分の緑か「思想」のイジンを起こしてパワー+3000を得るか、なければ相手のイジン1体を寝かせる';
        case 'bounce_own_haikei_by_uid': return '自分の戦場のハイケイ1つを手札に戻す(下で選択)';
        case 'grant_temp_pressure_all_own_ijin': return `自分の戦場のイジンは、このターンの間「プレッシャー${e.value}」を得る`;
        case 'grant_temp_pressure_self': return `このターンの間「プレッシャー${e.value}」を得る`;
        case 'tap_all_other_own_ijin_and_guardians_then_grant_temp_attack_bonus_self': return '自分の戦場の他のイジンとガーディアンをすべて寝かせて、寝かせた数だけこのターンの間アタック+2000を得る';
        default: return '';
      }
    }).filter(Boolean).join(' / ');
  }

  function buildPlacementModal(card, actionLabel, onConfirm) {
    const wrap = document.createElement('div');
    wrap.innerHTML = cardDetailHtml(card);

    let targetGetter = () => ({});
    const trig = card.triggers && card.triggers.onPlace;
    if (trig && trig.effectChoices) {
      const hint = document.createElement('div');
      hint.className = 'select-hint';
      hint.textContent = '能力: 次のどちらかを選んで発動できます';
      wrap.appendChild(hint);
      const opts = trig.effectChoices.map((eff, i) => ({ value: String(i), label: describeTriggerEffect(eff) }));
      const sel = selectEl(opts, null);
      wrap.appendChild(sel);
      targetGetter = () => ({ triggerChoiceIndex: Number(sel.value) });
    } else if (trig && trig.effect) {
      const hint = document.createElement('div');
      hint.className = 'select-hint';
      hint.textContent = `能力: ${describeTriggerEffect(trig.effect)}`;
      wrap.appendChild(hint);
      if (trig.needsTarget) {
        const built = buildTargetUI(trig.effect, card);
        if (built) {
          wrap.appendChild(built.el);
          targetGetter = () => {
            const p = built.getPayload();
            return p.targetUid ? { triggerTargetUid: p.targetUid } : {};
          };
        }
      }
    }

    let equipSel = null;
    if (card.type === 'ijin') {
      const equipCandidates = [
        ...gs.me.mana.filter((m) => !m.hidden && !m.faceDown && m.equipOffer),
        ...gs.me.field.haikei.filter((h) => h.equipOffer),
      ].filter((eq) => equipEligible(eq.equipOffer, card));
      if (equipCandidates.length > 0) {
        const equipHint = document.createElement('div');
        equipHint.className = 'select-hint';
        equipHint.textContent = '装備させますか？(任意)';
        wrap.appendChild(equipHint);
        equipSel = selectEl(equipCandidates.map((eq) => ({ value: eq.uid, label: eq.name })), '装備しない');
        wrap.appendChild(equipSel);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const ok = document.createElement('button');
    ok.textContent = actionLabel;
    ok.onclick = () => {
      const payload = Object.assign({}, targetGetter());
      if (equipSel && equipSel.value) payload.equipCardUid = equipSel.value;
      onConfirm(payload, (res) => { if (res.ok) closeModal(); else showModalError(res.error || '操作に失敗しました。'); });
    };
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'キャンセル';
    cancel.onclick = closeModal;
    actions.appendChild(ok);
    actions.appendChild(cancel);
    wrap.appendChild(actions);
    return wrap;
  }

  function equipEligible(equipOffer, ijinCard) {
    if (equipOffer.colorAny && !(ijinCard.colors || []).some((c) => equipOffer.colorAny.includes(c))) return false;
    if (equipOffer.requireText && !(ijinCard.text || '').includes(equipOffer.requireText)) return false;
    return true;
  }

  function buildManaModal(card) {
    const wrap = document.createElement('div');
    wrap.innerHTML = cardDetailHtml(card);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const up = document.createElement('button');
    up.textContent = '表向きで配置';
    up.onclick = () => { sendAction({ type: 'place_mana', cardUid: card.uid, mode: 'faceup' }, (res) => { if (res.ok) closeModal(); else showModalError(res.error); }); };
    const down = document.createElement('button');
    down.textContent = '裏向きで配置';
    down.onclick = () => { sendAction({ type: 'place_mana', cardUid: card.uid, mode: 'facedown' }, (res) => { if (res.ok) closeModal(); else showModalError(res.error); }); };
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'キャンセル';
    cancel.onclick = closeModal;
    actions.appendChild(up);
    actions.appendChild(down);
    actions.appendChild(cancel);
    wrap.appendChild(actions);
    return wrap;
  }

  // ---------------- マホウ ----------------

  function buildMahouModal(card) {
    const wrap = document.createElement('div');
    wrap.innerHTML = cardDetailHtml(card);

    const payWrap = document.createElement('div');
    payWrap.innerHTML = `<div class="select-hint">魔力コスト${card.magicCost}枚を魔力ゾーンから選択してください</div>`;
    const payRow = document.createElement('div');
    payRow.className = 'hand-row';
    const selectedMana = new Set();
    gs.me.mana.forEach((m) => {
      const label = m.hidden ? '?' : (m.faceDown ? '(裏)' + m.name : m.name);
      const el = cardEl(Object.assign({}, m, { name: label, type: m.type || 'maryoku', color: m.color || 'none' }), {
        small: true,
        onClick: () => {
          if (selectedMana.has(m.uid)) selectedMana.delete(m.uid);
          else selectedMana.add(m.uid);
          el.classList.toggle('selected');
        },
      });
      payRow.appendChild(el);
    });
    payWrap.appendChild(payRow);
    wrap.appendChild(payWrap);

    const effect = card.effect;
    let targetGetter = () => ({});
    if (effect && effect.effectChoices) {
      const hint = document.createElement('div');
      hint.className = 'select-hint';
      hint.textContent = '次のどちらかを選んで発動します';
      wrap.appendChild(hint);
      const opts = effect.effectChoices.map((e, i) => ({ value: String(i), label: describeTriggerEffect(e) }));
      const sel = selectEl(opts, null);
      wrap.appendChild(sel);
      targetGetter = () => ({ triggerChoiceIndex: Number(sel.value) });
    } else if (effect) {
      const built = buildMahouTargetUI(effect, card);
      if (built) {
        wrap.appendChild(built.el);
        targetGetter = built.getPayload;
      }
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const ok = document.createElement('button');
    ok.textContent = '発動';
    ok.onclick = () => {
      if (selectedMana.size !== card.magicCost) { alert(`魔力コスト分(${card.magicCost}枚)を選んでください。`); return; }
      const payload = Object.assign({ type: 'cast_mahou', cardUid: card.uid, payManaUids: Array.from(selectedMana) }, targetGetter());
      sendAction(payload, (res) => { if (res.ok) closeModal(); else showModalError(res.error); });
    };
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'キャンセル';
    cancel.onclick = closeModal;
    actions.appendChild(ok);
    actions.appendChild(cancel);
    wrap.appendChild(actions);
    return wrap;
  }

  function selectEl(options, placeholder) {
    const sel = document.createElement('select');
    sel.style.width = '100%';
    sel.style.padding = '8px';
    sel.style.marginTop = '6px';
    if (placeholder) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = placeholder;
      sel.appendChild(opt);
    }
    options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    return sel;
  }

  function buildMahouTargetUI(effect, card) {
    const div = document.createElement('div');
    div.className = 'select-hint';

    if (effect.type === 'unblockable_by_ijin') {
      div.innerHTML = '対象: 自分のイジン';
      const opts = gs.me.field.ijin.map((c) => ({ value: c.uid, label: `${c.name} (Pow${c.power})` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'bounce') {
      div.innerHTML = '対象: イジン(自分/相手)';
      const opts = [
        ...gs.me.field.ijin.map((c) => ({ value: c.uid, label: `[自分] ${c.name}` })),
        ...gs.opponent.field.ijin.map((c) => ({ value: c.uid, label: `[相手] ${c.name}` })),
      ];
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'revive_from_graveyard') {
      div.innerHTML = '対象: 自分の墓地(イジンLv6以下 / ハイケイLv5以下)';
      const opts = gs.me.graveyard
        .filter((c) => (c.type === 'ijin' && c.level <= 6) || (c.type === 'haikei' && c.level <= 5))
        .map((c) => ({ value: c.uid, label: `${c.name} (${c.type} Lv${c.level})` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'manafy_target') {
      div.innerHTML = '対象: 相手のイジン';
      const opts = gs.opponent.field.ijin.map((c) => ({ value: c.uid, label: `${c.name} (Pow${c.power})` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'loyalty') {
      div.innerHTML = '生贄(任意): 剣術イジンを破壊 または ガーディアンを山札に戻す。3ドローします。';
      const opts = [
        ...gs.me.field.ijin.filter((c) => c.keywords && c.keywords.trait === '剣術').map((c) => ({ value: c.uid, label: `[破壊]${c.name}` })),
        ...gs.me.guardians.map((g, i) => ({ value: g.uid, label: `[山札へ]ガーディアン${i + 1}` })),
      ];
      const sel = selectEl(opts, 'なし');
      div.appendChild(sel);
      return { el: div, getPayload: () => (sel.value ? { sacrificeUid: sel.value } : {}) };
    }
    if (effect.type === 'destroy_own_ijin_and_opponent_guardian') {
      div.innerHTML = '対象: 自分のイジン1体 + 相手のガーディアン1体';
      const selA = selectEl(gs.me.field.ijin.map((c) => ({ value: c.uid, label: c.name })), '自分のイジンを選択');
      const selB = selectEl(gs.opponent.guardians.map((g, i) => ({ value: g.uid, label: `相手のガーディアン${i + 1}` })), '相手のガーディアンを選択');
      div.appendChild(selA);
      div.appendChild(selB);
      return { el: div, getPayload: () => ({ targetUid: selA.value, guardianUid: selB.value }) };
    }
    if (effect.type === 'final_attack') {
      div.textContent = '自分のイジンを全て起こし、追加でバトルできます。次のエンドフェイズ開始時に敗北します。';
      return { el: div, getPayload: () => ({}) };
    }
    if (effect.type === 'refresh_guardians') {
      div.textContent = 'ガーディアンを全て手札に戻し、山札の上から2枚を新たなガーディアンにします。';
      return { el: div, getPayload: () => ({}) };
    }
    if (effect.type === 'draw') {
      div.textContent = `${effect.value}枚ドローします。`;
      return { el: div, getPayload: () => ({}) };
    }
    if (effect.type === 'summon_right_plus') {
      div.textContent = `イジン召喚権+${effect.value}します。`;
      return { el: div, getPayload: () => ({}) };
    }
    if (effect.type === 'grant_temp_indestructible_and_kokai_attack_bonus_all_own_ijin') {
      div.textContent = 'このターン、自分のイジンはすべて破壊されません。「航海」を持つイジンはさらにアタック+2000を得ます。';
      return { el: div, getPayload: () => ({}) };
    }
    if (effect.type === 'reveal_and_discard_non_maryoku_opponent_facedown_mana') {
      div.textContent = '相手の魔力ゾーンの裏向きカードをすべて表にし、マリョクでないカードを墓地に置きます。';
      return { el: div, getPayload: () => ({}) };
    }
    if (effect.type === 'mana_right_plus') {
      div.textContent = `マリョク配置権+${effect.value}します。`;
      return { el: div, getPayload: () => ({}) };
    }
    if (effect.type === 'generic_destroy_ijin' || effect.type === 'generic_bounce_ijin') {
      const verb = effect.type === 'generic_destroy_ijin' ? '破壊' : '手札に戻す';
      const scopeLabel = { own: '自分', opponent: '相手', either: '自分/相手' }[effect.scope];
      const lvLabel = effect.levelMax != null ? `レベル${effect.levelMax}以下の` : '';
      const selfPower = card ? card.power : null;
      const powCap = effect.powerMax === 'self' ? selfPower : effect.powerMax;
      const pwLabel = powCap != null ? `パワー${powCap}以下の` : '';
      div.innerHTML = `対象: ${scopeLabel}の戦場の${lvLabel}${pwLabel}イジン1体(${verb})`;
      const opts = scopedIjinOptions(effect.scope, effect.levelMax, powCap);
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'generic_destroy_guardian') {
      const scopeLabel = { own: '自分', opponent: '相手', either: '自分/相手' }[effect.scope];
      div.innerHTML = `対象: ${scopeLabel}のガーディアン1体`;
      const opts = scopedGuardianOptions(effect.scope);
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'bounce_from_graveyard') {
      div.innerHTML = '対象: 自分の墓地のイジンかハイケイ1つ(手札に戻す)';
      const opts = gs.me.graveyard
        .filter((c) => c.type === 'ijin' || c.type === 'haikei')
        .map((c) => ({ value: c.uid, label: `${c.name} (${c.type === 'ijin' ? 'イジン' : 'ハイケイ'})` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'bounce_facedown_mana') {
      const isOpp = effect.scope === 'opponent';
      const pool = isOpp ? gs.opponent.mana : gs.me.mana;
      div.innerHTML = `対象: ${isOpp ? '相手' : '自分'}の魔力ゾーンの裏向きカード1つ(手札に戻す)`;
      const opts = pool
        .filter((m) => m.hidden || m.faceDown)
        .map((m) => ({ value: m.uid, label: m.name || '裏向きカード' }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'bounce_flexible_ijin_or_haikei') {
      const scopeLabel = { own: '自分', opponent: '相手', either: '自分/相手' }[effect.scope];
      div.innerHTML = `対象: ${scopeLabel}の戦場のイジン1体かハイケイ1つ(手札に戻す)`;
      const opts = [];
      if (effect.scope === 'own' || effect.scope === 'either') {
        gs.me.field.ijin.forEach((c) => opts.push({ value: c.uid, label: `[自分/イジン] ${c.name}` }));
        gs.me.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[自分/ハイケイ] ${c.name}` }));
      }
      if (effect.scope === 'opponent' || effect.scope === 'either') {
        gs.opponent.field.ijin.forEach((c) => opts.push({ value: c.uid, label: `[相手/イジン] ${c.name}` }));
        gs.opponent.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[相手/ハイケイ] ${c.name}` }));
      }
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'move_flexible_guardian_or_graveyard_to_deck_top') {
      div.innerHTML = '対象: 自分のガーディアン1体か墓地のカード1つ(山札の上へ)';
      const opts = [
        ...gs.me.guardians.map((c) => ({ value: c.uid, label: `[ガーディアン] ${c.hidden ? '裏向きカード' : c.name}` })),
        ...gs.me.graveyard.map((c) => ({ value: c.uid, label: `[墓地] ${c.name}` })),
      ];
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'flip_flexible_ijin_or_haikei_to_facedown_mana') {
      const scopeLabel = { own: '自分', opponent: '相手', either: '自分/相手' }[effect.scope];
      div.innerHTML = `対象: ${scopeLabel}の戦場のイジン1体かハイケイ1つ(裏にして魔力ゾーンへ)`;
      const opts = [];
      if (effect.scope === 'own' || effect.scope === 'either') {
        gs.me.field.ijin.forEach((c) => opts.push({ value: c.uid, label: `[自分/イジン] ${c.name}` }));
        gs.me.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[自分/ハイケイ] ${c.name}` }));
      }
      if (effect.scope === 'opponent' || effect.scope === 'either') {
        gs.opponent.field.ijin.forEach((c) => opts.push({ value: c.uid, label: `[相手/イジン] ${c.name}` }));
        gs.opponent.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[相手/ハイケイ] ${c.name}` }));
      }
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'tap_flexible_own_ijin_or_guardian') {
      div.innerHTML = '対象: 自分の戦場のイジン1体かガーディアン1体(寝かせる)';
      const opts = [
        ...gs.me.field.ijin.map((c) => ({ value: c.uid, label: `[イジン] ${c.name}` })),
        ...gs.me.guardians.map((c) => ({ value: c.uid, label: `[ガーディアン] ${c.hidden ? '裏向きカード' : c.name}` })),
      ];
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'generic_destroy_haikei') {
      const scopeLabel = { own: '自分', opponent: '相手', either: '自分/相手' }[effect.scope];
      div.innerHTML = `対象: ${scopeLabel}の戦場のハイケイ1つ(破壊)`;
      const opts = [];
      if (effect.scope === 'own' || effect.scope === 'either') gs.me.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[自分] ${c.name}` }));
      if (effect.scope === 'opponent' || effect.scope === 'either') gs.opponent.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[相手] ${c.name}` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'tap_target_ijin') {
      const scopeLabel = { own: '自分', opponent: '相手', either: '自分/相手' }[effect.scope];
      div.innerHTML = `対象: ${scopeLabel}の戦場のイジン1つ(寝かせる)`;
      const opts = scopedIjinOptions(effect.scope, null, null);
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'draw_then_discard_own_hand' || effect.type === 'discard_own_hand') {
      div.innerHTML = '対象: 自分の手札1枚(墓地に置く)';
      const opts = gs.me.hand.filter((c) => c.uid !== (card && card.uid)).map((c) => ({ value: c.uid, label: c.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'graveyard_card_to_guardian') {
      div.innerHTML = '対象: 自分の墓地のカード1つ(ガーディアンにする)';
      const opts = gs.me.graveyard.map((c) => ({ value: c.uid, label: `${c.name} (${c.type})` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'graveyard_to_deck_bottom_then_draw') {
      div.innerHTML = '対象: 自分の墓地のマリョクでないカード1つ(山札の下へ)';
      const opts = gs.me.graveyard.filter((c) => c.type !== 'maryoku').map((c) => ({ value: c.uid, label: `${c.name} (${c.type})` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'destroy_highest_power_field_ijin') {
      const allCards = [
        ...gs.me.field.ijin.map((c) => Object.assign({ side: '自分' }, c)),
        ...gs.opponent.field.ijin.map((c) => Object.assign({ side: '相手' }, c)),
      ];
      const maxPower = allCards.reduce((m, c) => Math.max(m, c.power || 0), 0);
      div.innerHTML = `対象: 場で最もパワーが高いイジン1体(パワー${maxPower}、破壊)`;
      const opts = allCards.filter((c) => c.power === maxPower).map((c) => ({ value: c.uid, label: `[${c.side}] ${c.name} (Pow${c.power})` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'hand_card_to_deck_bottom_then_draw') {
      div.innerHTML = `対象: 自分の手札1枚(山札の下へ / ${effect.drawValue}ドロー後)`;
      const opts = gs.me.hand.filter((c) => c.uid !== (card && card.uid)).map((c) => ({ value: c.uid, label: c.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'haikei_to_deck_top') {
      const pool = gs.me.field.haikei.filter((h) => !effect.trait || (h.keywords && (h.keywords.trait === effect.trait || (h.keywords.traits || []).includes(effect.trait))));
      div.innerHTML = `対象: 自分の戦場の${effect.trait ? `「${effect.trait}」` : ''}ハイケイ1つ(山札の上へ)`;
      const opts = pool.map((c) => ({ value: c.uid, label: c.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'destroy_own_and_opponent_ijin') {
      div.innerHTML = '対象: 自分のイジン1体 + 相手のイジン1体(どちらも破壊)';
      const selA = selectEl(gs.me.field.ijin.map((c) => ({ value: c.uid, label: c.name })), '自分のイジンを選択');
      const selB = selectEl(gs.opponent.field.ijin.map((c) => ({ value: c.uid, label: c.name })), '相手のイジンを選択');
      div.appendChild(selA);
      div.appendChild(selB);
      return { el: div, getPayload: () => ({ targetUid: selA.value, targetUid2: selB.value }) };
    }
    if (effect.type === 'duel_ijin') {
      div.innerHTML = '対象: 自分の起きているイジン1体 + 相手のイジン1体(パワー比べ)';
      const selA = selectEl(gs.me.field.ijin.filter((c) => !c.tapped).map((c) => ({ value: c.uid, label: `${c.name} (Pow${c.power})` })), '自分のイジンを選択');
      const selB = selectEl(gs.opponent.field.ijin.map((c) => ({ value: c.uid, label: `${c.name} (Pow${c.power})` })), '相手のイジンを選択');
      div.appendChild(selA);
      div.appendChild(selB);
      return { el: div, getPayload: () => ({ targetUid: selA.value, targetUid2: selB.value }) };
    }
    if (effect.type === 'bounce_or_deck_top_based_on_tapped') {
      div.innerHTML = '対象: 自分/相手のイジン1体(寝ていれば裏で山札の上へ、起きていれば手札へ)';
      const opts = [
        ...gs.me.field.ijin.map((c) => ({ value: c.uid, label: `[自分] ${c.name}${c.tapped ? '(寝)' : ''}` })),
        ...gs.opponent.field.ijin.map((c) => ({ value: c.uid, label: `[相手] ${c.name}${c.tapped ? '(寝)' : ''}` })),
      ];
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'revive_ijin_to_field_from_graveyard') {
      div.innerHTML = `対象: 自分の墓地の${effect.levelMax != null ? `レベル${effect.levelMax}以下の` : ''}イジン1体(戦場に置く)`;
      const opts = gs.me.graveyard
        .filter((c) => c.type === 'ijin' && (effect.levelMax == null || c.level <= effect.levelMax))
        .map((c) => ({ value: c.uid, label: `${c.name} (Lv${c.level})` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'bounce_highest_level_field_card') {
      const allCards = [
        ...gs.me.field.ijin.map((c) => Object.assign({ side: '自分' }, c)),
        ...gs.me.field.haikei.map((c) => Object.assign({ side: '自分' }, c)),
        ...gs.opponent.field.ijin.map((c) => Object.assign({ side: '相手' }, c)),
        ...gs.opponent.field.haikei.map((c) => Object.assign({ side: '相手' }, c)),
      ];
      const maxLevel = allCards.reduce((m, c) => Math.max(m, c.level || 0), 0);
      div.innerHTML = `対象: 場で最もレベルが高いカード1つ(レベル${maxLevel}、手札に戻す)`;
      const opts = allCards.filter((c) => c.level === maxLevel).map((c) => ({ value: c.uid, label: `[${c.side}] ${c.name} (Lv${c.level})` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'bounce_tapped_card_to_deck_bottom') {
      div.innerHTML = '対象: 寝ているカード1つ(山札の下に戻す)';
      const opts = [
        ...gs.me.field.ijin.filter((c) => c.tapped).map((c) => ({ value: c.uid, label: `[自分] ${c.name}` })),
        ...gs.me.field.haikei.filter((c) => c.tapped).map((c) => ({ value: c.uid, label: `[自分] ${c.name}` })),
        ...gs.opponent.field.ijin.filter((c) => c.tapped).map((c) => ({ value: c.uid, label: `[相手] ${c.name}` })),
        ...gs.opponent.field.haikei.filter((c) => c.tapped).map((c) => ({ value: c.uid, label: `[相手] ${c.name}` })),
      ];
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'flip_opponent_mana_facedown') {
      div.innerHTML = '対象: 相手の魔力ゾーンの表向きカード1つ(裏にする)';
      const opts = gs.opponent.mana.filter((m) => !m.hidden && !m.faceDown).map((m) => ({ value: m.uid, label: m.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'revive_flexible_ijin_or_haikei_from_graveyard') {
      div.innerHTML = `対象: 自分の墓地のレベル${effect.ijinLevelMax}以下のイジン1体かレベル${effect.haikeiLevelMax}以下のハイケイ1つ(戦場に置く)`;
      const opts = gs.me.graveyard
        .filter((c) => (c.type === 'ijin' && c.level <= effect.ijinLevelMax) || (c.type === 'haikei' && c.level <= effect.haikeiLevelMax))
        .map((c) => ({ value: c.uid, label: `[${c.type === 'ijin' ? 'イジン' : 'ハイケイ'}] ${c.name}` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'destroy_flexible_ijin_or_haikei') {
      const scopeLabel = { own: '自分', opponent: '相手', either: '自分/相手' }[effect.scope];
      const pwLabel = effect.powerMax != null ? `パワー${effect.powerMax}以下の` : '';
      div.innerHTML = `対象: ${scopeLabel}の戦場の${pwLabel}イジン1体かハイケイ1つ(破壊)`;
      const opts = [];
      const pushSide = (side, label) => {
        side.field.ijin.filter((c) => effect.powerMax == null || c.power <= effect.powerMax).forEach((c) => opts.push({ value: c.uid, label: `[${label}/イジン] ${c.name}` }));
        side.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[${label}/ハイケイ] ${c.name}` }));
      };
      if (effect.scope === 'own' || effect.scope === 'either') pushSide(gs.me, '自分');
      if (effect.scope === 'opponent' || effect.scope === 'either') pushSide(gs.opponent, '相手');
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'bounce_equipped_card_by_uid') {
      div.innerHTML = '対象: 場のイジンに装備されているカード1つ(手札に戻す)';
      const opts = [];
      gs.me.field.ijin.filter((c) => c.equippedCardUid).forEach((c) => opts.push({ value: c.equippedCardUid, label: `[自分/${c.name}に装備] ${c.equippedCardName}` }));
      gs.opponent.field.ijin.filter((c) => c.equippedCardUid).forEach((c) => opts.push({ value: c.equippedCardUid, label: `[相手/${c.name}に装備] ${c.equippedCardName}` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'flip_facedown_mana_haikei_to_field_then_bounce_and_summon_right') {
      div.innerHTML = `対象: 自分の魔力ゾーンの裏向きカードで、表がレベル${effect.levelMax}以下のハイケイのもの1つ(戦場に置く)`;
      const opts = gs.me.mana.filter((m) => !m.hidden && m.faceDown && m.type === 'haikei' && m.level <= effect.levelMax).map((m) => ({ value: m.uid, label: m.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'grant_temp_rush') {
      div.innerHTML = `対象: 自分の${effect.levelMax != null ? `レベル${effect.levelMax}以下の` : ''}イジン1体(このターン即応を得る)`;
      const opts = gs.me.field.ijin.filter((c) => effect.levelMax == null || c.level <= effect.levelMax).map((c) => ({ value: c.uid, label: c.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'summon_hand_ijin_with_temp_rush') {
      div.innerHTML = `対象: 自分の手札の${effect.levelMax != null ? `レベル${effect.levelMax}以下の` : ''}イジン1体(即応を得て戦場に置く)`;
      const opts = gs.me.hand
        .filter((c) => c.type === 'ijin' && c.uid !== (card && card.uid) && (effect.levelMax == null || c.level <= effect.levelMax))
        .map((c) => ({ value: c.uid, label: c.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'field_card_to_guardian_by_uid') {
      div.innerHTML = `対象: 戦場の${effect.levelMax != null ? `レベル${effect.levelMax}以下の` : ''}カード1つ(ガーディアンにする)`;
      const opts = [];
      gs.me.field.ijin.filter((c) => effect.levelMax == null || c.level <= effect.levelMax).forEach((c) => opts.push({ value: c.uid, label: `[自分/イジン] ${c.name}` }));
      gs.me.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[自分/ハイケイ] ${c.name}` }));
      gs.opponent.field.ijin.filter((c) => effect.levelMax == null || c.level <= effect.levelMax).forEach((c) => opts.push({ value: c.uid, label: `[相手/イジン] ${c.name}` }));
      gs.opponent.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[相手/ハイケイ] ${c.name}` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'multi_hand_to_facedown_mana') {
      div.innerHTML = '対象: 自分の手札(このカード以外)1枚以上(裏にして魔力ゾーンへ)';
      const pool = gs.me.hand.filter((c) => c.uid !== (card && card.uid));
      const built = buildMultiSelectRow(pool);
      div.appendChild(built.el);
      return { el: div, getPayload: () => ({ targetUids: built.getSelected() }) };
    }
    if (effect.type === 'multi_bounce_own_ijin_scaled_summon_right') {
      div.innerHTML = '対象: 自分の戦場のイジン1体以上(手札に戻して、戻した数だけイジン召喚権+)';
      const built = buildMultiSelectRow(gs.me.field.ijin);
      div.appendChild(built.el);
      return { el: div, getPayload: () => ({ targetUids: built.getSelected() }) };
    }
    if (effect.type === 'multi_discard_hand_haikei_draw_scaled') {
      div.innerHTML = '対象: 自分の手札のハイケイ1つ以上(墓地に置いて、レベル合計5につき1ドロー)';
      const pool = gs.me.hand.filter((c) => c.type === 'haikei');
      const built = buildMultiSelectRow(pool);
      div.appendChild(built.el);
      return { el: div, getPayload: () => ({ targetUids: built.getSelected() }) };
    }
    if (effect.type === 'multi_graveyard_to_deck_bottom_then_draw') {
      div.innerHTML = `対象: ${effect.scope === 'either' ? '自分か相手の' : '自分の'}墓地のマリョクでないカード${effect.minCount}つ以上(山札の下へ、その後1ドロー)`;
      const pool = (effect.scope === 'either' ? [...gs.me.graveyard, ...gs.opponent.graveyard] : gs.me.graveyard).filter((c) => c.type !== 'maryoku');
      const built = buildMultiSelectRow(pool);
      div.appendChild(built.el);
      return { el: div, getPayload: () => ({ targetUids: built.getSelected() }) };
    }
    if (effect.type === 'carbonize_flexible_destroy_to_deck_bottom') {
      div.innerHTML = '対象: 戦場のハイケイ1つか装備されているカード1つ(破壊して山札の下へ)';
      const opts = [];
      gs.me.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[自分/ハイケイ] ${c.name}` }));
      gs.opponent.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[相手/ハイケイ] ${c.name}` }));
      gs.me.field.ijin.filter((c) => c.equippedCardUid).forEach((c) => opts.push({ value: c.equippedCardUid, label: `[自分/${c.name}に装備] ${c.equippedCardName}` }));
      gs.opponent.field.ijin.filter((c) => c.equippedCardUid).forEach((c) => opts.push({ value: c.equippedCardUid, label: `[相手/${c.name}に装備] ${c.equippedCardName}` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'catastrophe_own_guardian_to_deck_bottom_destroy_all_ijin') {
      div.innerHTML = '対象: 自分のガーディアン1体(山札の下へ、その後イジンすべてを破壊)';
      const opts = gs.me.guardians.map((c) => ({ value: c.uid, label: c.hidden ? '裏向きカード' : c.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'multi_destroy_field_haikei_scaled_by_own_colors') {
      const colorCount = new Set(gs.me.field.ijin.map((c) => c.color)).size;
      div.innerHTML = `対象: 戦場のハイケイ最大${colorCount}つ(破壊、自分の戦場の色の数まで)`;
      const pool = [...gs.me.field.haikei, ...gs.opponent.field.haikei];
      const built = buildMultiSelectRow(pool);
      div.appendChild(built.el);
      return { el: div, getPayload: () => ({ targetUids: built.getSelected() }) };
    }
    if (effect.type === 'multi_tap_field_ijin_scaled_by_own_colors') {
      const colorCount = new Set(gs.me.field.ijin.map((c) => c.color)).size;
      div.innerHTML = `対象: 戦場のイジン最大${colorCount}体(寝かせる、自分の戦場の色の数まで)`;
      const pool = [...gs.me.field.ijin, ...gs.opponent.field.ijin];
      const built = buildMultiSelectRow(pool);
      div.appendChild(built.el);
      return { el: div, getPayload: () => ({ targetUids: built.getSelected() }) };
    }
    if (effect.type === 'multi_bounce_graveyard_mana_scaled_by_own_colors') {
      const colorCount = new Set(gs.me.field.ijin.map((c) => c.color)).size;
      div.innerHTML = `対象: 自分の墓地のマリョク最大${colorCount}つ(手札に戻す、自分の戦場の色の数まで)`;
      const pool = gs.me.graveyard.filter((c) => c.type === 'maryoku');
      const built = buildMultiSelectRow(pool);
      div.appendChild(built.el);
      return { el: div, getPayload: () => ({ targetUids: built.getSelected() }) };
    }
    if (effect.type === 'pressure_ijin_deck_bottom_if_attacker_else_tap') {
      div.innerHTML = '対象: 「プレッシャー」を持つイジン1体';
      const opts = [
        ...gs.me.field.ijin.filter((c) => c.keywords && c.keywords.pressure).map((c) => ({ value: c.uid, label: `[自分] ${c.name}` })),
        ...gs.opponent.field.ijin.filter((c) => c.keywords && c.keywords.pressure).map((c) => ({ value: c.uid, label: `[相手] ${c.name}` })),
      ];
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'destroy_own_ijin_or_guardian_and_opponent_field_card') {
      div.innerHTML = '対象: 自分のイジンかガーディアン1体 + 相手の戦場のカード1つ(どちらも破壊)';
      const selA = selectEl([
        ...gs.me.field.ijin.map((c) => ({ value: c.uid, label: `[イジン] ${c.name}` })),
        ...gs.me.guardians.map((c) => ({ value: c.uid, label: `[ガーディアン] ${c.hidden ? '裏向きカード' : c.name}` })),
      ], '自分のイジンかガーディアンを選択');
      const selB = selectEl([
        ...gs.opponent.field.ijin.map((c) => ({ value: c.uid, label: `[イジン] ${c.name}` })),
        ...gs.opponent.field.haikei.map((c) => ({ value: c.uid, label: `[ハイケイ] ${c.name}` })),
      ], '相手の戦場のカードを選択');
      div.appendChild(selA);
      div.appendChild(selB);
      return { el: div, getPayload: () => ({ targetUid: selA.value, targetUid2: selB.value }) };
    }
    if (effect.type === 'flip_own_color_matching_ijin_to_mana') {
      const manaColors = new Set(gs.me.mana.filter((m) => !m.hidden && !m.faceDown).map((m) => m.color));
      div.innerHTML = '対象: 自分の魔力ゾーンと同じ色の自分のイジン1体(裏にして魔力ゾーンへ)';
      const opts = gs.me.field.ijin.filter((c) => (c.colors || [c.color]).some((cc) => manaColors.has(cc))).map((c) => ({ value: c.uid, label: c.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'bounce_own_haikei_by_uid') {
      div.innerHTML = '対象: 自分の戦場のハイケイ1つ(手札に戻す)';
      const opts = gs.me.field.haikei.map((c) => ({ value: c.uid, label: c.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'mill_self_then_graveyard_to_deck_top') {
      div.innerHTML = `自分の山札の上から${effect.millValue}枚を墓地に置いた後、対象: 自分の墓地のカード1つ(山札の上へ)`;
      const opts = gs.me.graveyard.map((c) => ({ value: c.uid, label: c.name }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'flexible_haikei_or_equipped_to_deck_bottom') {
      div.innerHTML = '対象: 戦場のハイケイ1つか装備されているカード1つ(山札の下へ)';
      const opts = [];
      gs.me.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[自分/ハイケイ] ${c.name}` }));
      gs.opponent.field.haikei.forEach((c) => opts.push({ value: c.uid, label: `[相手/ハイケイ] ${c.name}` }));
      gs.me.field.ijin.filter((c) => c.equippedCardUid).forEach((c) => opts.push({ value: c.equippedCardUid, label: `[自分/${c.name}に装備] ${c.equippedCardName}` }));
      gs.opponent.field.ijin.filter((c) => c.equippedCardUid).forEach((c) => opts.push({ value: c.equippedCardUid, label: `[相手/${c.name}に装備] ${c.equippedCardName}` }));
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    if (effect.type === 'draw_entire_deck_then_optional_free_summon_then_reshuffle') {
      div.innerHTML = `対象: 自分の手札の${effect.levelMax != null ? `レベル${effect.levelMax}以下の` : ''}イジン1体(任意、無償で戦場に置く。その後山札を全ドローしてシャッフル)`;
      const opts = gs.me.hand.filter((c) => c.type === 'ijin' && c.uid !== (card && card.uid) && (effect.levelMax == null || c.level <= effect.levelMax)).map((c) => ({ value: c.uid, label: c.name }));
      const sel = selectEl(opts, '対象なし');
      div.appendChild(sel);
      return { el: div, getPayload: () => (sel.value ? { targetUid: sel.value } : {}) };
    }
    if (effect.type === 'mill_self_then_place_graveyard_card_level_at_most_mana_level') {
      const manaLevel = gs.me.mana.reduce((s, m) => s + (m.level || 1), 0);
      div.innerHTML = `対象: 自分の墓地のレベル${manaLevel}以下のイジンかハイケイ1つ(戦場に置く、任意)`;
      const opts = gs.me.graveyard
        .filter((c) => (c.type === 'ijin' || c.type === 'haikei') && c.level <= manaLevel)
        .map((c) => ({ value: c.uid, label: `${c.name} (${c.type === 'ijin' ? 'イジン' : 'ハイケイ'} Lv${c.level})` }));
      const sel = selectEl(opts, '対象なし(ミルのみ)');
      div.appendChild(sel);
      return { el: div, getPayload: () => (sel.value ? { targetUid: sel.value } : {}) };
    }
    if (effect.type === 'bounce_flexible_mana_then_cannot_cast_mahou') {
      div.innerHTML = '対象: 自分か相手の魔力ゾーンのカード1つ(手札に戻す)';
      const opts = [
        ...gs.me.mana.map((m) => ({ value: m.uid, label: `[自分] ${m.hidden ? '?' : (m.faceDown ? '(裏)' + m.name : m.name)}` })),
        ...gs.opponent.mana.map((m) => ({ value: m.uid, label: `[相手] ${m.hidden ? '?' : (m.faceDown ? '(裏)' + m.name : m.name)}` })),
      ];
      const sel = selectEl(opts, '選択してください');
      div.appendChild(sel);
      return { el: div, getPayload: () => ({ targetUid: sel.value }) };
    }
    return null;
  }

  function buildMultiSelectRow(pool) {
    const row = document.createElement('div');
    row.className = 'hand-row';
    const selected = new Set();
    pool.forEach((c) => {
      const el = cardEl(c, {
        small: true,
        onClick: () => {
          if (selected.has(c.uid)) selected.delete(c.uid);
          else selected.add(c.uid);
          el.classList.toggle('selected');
        },
      });
      row.appendChild(el);
    });
    return { el: row, getSelected: () => Array.from(selected) };
  }

  function buildTargetUI(effect, card) {
    if (Array.isArray(effect)) {
      for (const e of effect) {
        const built = buildMahouTargetUI(e, card);
        if (built) return built;
      }
      return null;
    }
    return buildMahouTargetUI(effect, card);
  }

  function scopedIjinOptions(scope, levelMax, powerMax) {
    const opts = [];
    if (scope === 'own' || scope === 'either') {
      gs.me.field.ijin.forEach((c) => {
        if (levelMax != null && c.level > levelMax) return;
        if (powerMax != null && c.power > powerMax) return;
        opts.push({ value: c.uid, label: `[自分] ${c.name} (Pow${c.power})` });
      });
    }
    if (scope === 'opponent' || scope === 'either') {
      gs.opponent.field.ijin.forEach((c) => {
        if (levelMax != null && c.level > levelMax) return;
        if (powerMax != null && c.power > powerMax) return;
        opts.push({ value: c.uid, label: `[相手] ${c.name} (Pow${c.power})` });
      });
    }
    return opts;
  }

  function scopedGuardianOptions(scope) {
    const opts = [];
    if (scope === 'own' || scope === 'either') {
      gs.me.guardians.forEach((g, i) => opts.push({ value: g.uid, label: `[自分] ガーディアン${i + 1}` }));
    }
    if (scope === 'opponent' || scope === 'either') {
      gs.opponent.guardians.forEach((g, i) => opts.push({ value: g.uid, label: `[相手] ガーディアン${i + 1}` }));
    }
    return opts;
  }

  // ---------------- バトル(ブロック) ----------------

  function toggleBlocker(blockerUid) {
    // どのアタッカーに割り当てるか選択させる
    const battle = gs.pendingBattle;
    if (!battle) return;
    if (battle.attackers.length === 1) {
      assignBlocker(battle.attackers[0].uid, blockerUid);
      return;
    }
    openAttackerPicker(blockerUid);
  }

  function toggleGuardianBlocker(guardianUid) {
    const battle = gs.pendingBattle;
    if (!battle) return;
    if (battle.attackers.length === 1) {
      assignBlocker(battle.attackers[0].uid, guardianUid);
      return;
    }
    openAttackerPicker(guardianUid);
  }

  function openAttackerPicker(blockerUid) {
    const battle = gs.pendingBattle;
    const wrap = document.createElement('div');
    wrap.innerHTML = '<h3>どのアタッカーをブロックしますか？</h3>';
    battle.attackers.forEach((entry) => {
      const atk = gs.opponent.field.ijin.find((c) => c.uid === entry.uid);
      const btn = document.createElement('button');
      btn.textContent = atk ? `${atk.name} (Pow${atk.power})` : entry.uid;
      btn.style.display = 'block';
      btn.style.width = '100%';
      btn.style.marginBottom = '8px';
      btn.onclick = () => { assignBlocker(entry.uid, blockerUid); closeModal(); };
      wrap.appendChild(btn);
    });
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'キャンセル';
    cancel.onclick = closeModal;
    wrap.appendChild(cancel);
    openModal(wrap);
  }

  function assignBlocker(attackerUid, blockerUid) {
    for (const key of Object.keys(blockAssignments)) {
      blockAssignments[key].delete(blockerUid);
    }
    if (!blockAssignments[attackerUid]) blockAssignments[attackerUid] = new Set();
    if (blockAssignments[attackerUid].has(blockerUid)) blockAssignments[attackerUid].delete(blockerUid);
    else blockAssignments[attackerUid].add(blockerUid);
    render();
  }

  function renderBattlePanel() {
    const panel = $('battle-panel');
    if (gs.phase !== 'block' || !gs.pendingBattle) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
    panel.classList.remove('hidden');
    panel.innerHTML = '';

    const isDefender = gs.pendingBattle.attackerPlayerId !== gs.me.id;
    const title = document.createElement('div');
    title.className = 'select-hint';
    title.textContent = isDefender ? 'アタックされています！自分のイジン/ガーディアンをクリックしてブロックを割り当ててください。' : '相手のブロックを待っています…';
    panel.appendChild(title);

    const attackersSrc = isDefender ? gs.opponent.field.ijin : gs.me.field.ijin;
    const list = document.createElement('div');
    list.className = 'hand-row';
    gs.pendingBattle.attackers.forEach((entry) => {
      const atk = attackersSrc.find((c) => c.uid === entry.uid);
      if (!atk) return;
      const box = document.createElement('div');
      box.style.textAlign = 'center';
      const kw = [];
      if (atk.keywords) {
        if (atk.keywords.pressure) kw.push(`要ブロッカー${atk.keywords.pressure}体`);
        if (atk.keywords.rush) kw.push('即応');
      }
      const el = cardEl(atk, { small: true });
      box.appendChild(el);
      const cap = document.createElement('div');
      cap.style.fontSize = '9px';
      cap.style.color = '#9aa4b5';
      cap.textContent = kw.join(' ');
      box.appendChild(cap);
      if (isDefender) {
        const assigned = blockAssignments[entry.uid] ? blockAssignments[entry.uid].size : 0;
        const cap2 = document.createElement('div');
        cap2.style.fontSize = '9px';
        cap2.style.color = '#4fd1c5';
        cap2.textContent = `ブロッカー${assigned}体割当`;
        box.appendChild(cap2);
      }
      list.appendChild(box);
    });
    panel.appendChild(list);

    if (isDefender) {
      const btn = document.createElement('button');
      btn.textContent = 'ブロック確定';
      btn.onclick = submitBlock;
      panel.appendChild(btn);

      const noBlockBtn = document.createElement('button');
      noBlockBtn.className = 'secondary';
      noBlockBtn.style.marginLeft = '8px';
      noBlockBtn.textContent = '全てブロックしない';
      noBlockBtn.onclick = () => { blockAssignments = {}; submitBlock(); };
      panel.appendChild(noBlockBtn);
    }
  }

  function submitBlock() {
    const assignments = {};
    for (const [atkUid, set] of Object.entries(blockAssignments)) {
      assignments[atkUid] = Array.from(set);
    }
    sendAction({ type: 'declare_block', assignments });
    blockAssignments = {};
  }

  // ---------------- モーダル ----------------

  function openModal(contentEl) {
    const overlay = $('modal-overlay');
    const content = $('modal-content');
    content.innerHTML = '';
    content.appendChild(contentEl);
    overlay.classList.remove('hidden');
  }
  function closeModal() {
    $('modal-overlay').classList.add('hidden');
    $('modal-content').innerHTML = '';
  }
  $('modal-overlay').addEventListener('click', (e) => { if (e.target === $('modal-overlay')) closeModal(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- ログ / ゲーム終了 ----------------

  function renderLog() {
    const panel = $('log-panel');
    panel.innerHTML = '';
    (gs.log || []).forEach((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      panel.appendChild(div);
    });
    panel.scrollTop = panel.scrollHeight;
  }

  function showGameOver() {
    const overlay = $('game-over-overlay');
    overlay.classList.remove('hidden');
    const win = gs.winner === gs.me.id;
    $('game-over-text').textContent = win ? 'あなたの勝利です！' : `${gs.opponent.name}の勝利です。`;
    $('game-over-illust').src = win ? 'img/kakeru.png' : 'img/galileo.png';
  }

  $('btn-back-to-lobby').addEventListener('click', () => {
    window.location.reload();
  });
})();
