'use strict';

/**
 * 「天草絵巻」サイト(ijinden-amakusaemaki)のイジデキ環境デッキ紹介ページに掲載されていた
 * 第3弾〜第6弾の環境デッキ29種を、実カードデータへマッピングしたもの。
 * CPU対戦の相手デッキとしてランダムに使用する。
 * 判読困難だったカード名の一部は、デッキと同じ色のマリョクで代替している。
 *
 * `playerSelectable: false` が付いたデッキは、CPU対戦の候補には含めるが、
 * デッキ編集画面の「おすすめデッキ」からプレイヤーが選べるようにはしない
 * (CPU専用の新規デッキレシピ向け)。
 */

const fs = require('fs');
const path = require('path');

const DECKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'premade_decks.json'), 'utf-8'));
const NAMES = Object.keys(DECKS);
const PLAYER_SELECTABLE_NAMES = NAMES.filter((name) => DECKS[name].playerSelectable !== false);

function pickRandomPremadeDeck() {
  const name = NAMES[Math.floor(Math.random() * NAMES.length)];
  const deck = DECKS[name];
  return { name, cardIds: deck.cardIds.slice(), colors: deck.colors };
}

function listPremadeDecks() {
  return PLAYER_SELECTABLE_NAMES.map((name) => ({ name, colors: DECKS[name].colors, count: DECKS[name].count }));
}

// デッキ編集画面の「おすすめデッキ」機能向けに、実際のカードID一覧まで含めて返す。
// CPU専用デッキ(playerSelectable: false)はここには含めない。
function listPremadeDecksWithCards() {
  return PLAYER_SELECTABLE_NAMES.map((name) => ({ name, colors: DECKS[name].colors, cardIds: DECKS[name].cardIds.slice() }));
}

module.exports = { pickRandomPremadeDeck, listPremadeDecks, listPremadeDecksWithCards };
