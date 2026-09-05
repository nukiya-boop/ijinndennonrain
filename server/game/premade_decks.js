'use strict';

/**
 * 「天草絵巻」サイト(ijinden-amakusaemaki)のイジデキ環境デッキ紹介ページに掲載されていた
 * 第3弾〜第6弾の環境デッキ29種を、実カードデータへマッピングしたもの。
 * CPU対戦の相手デッキとしてランダムに使用する。
 * 判読困難だったカード名の一部は、デッキと同じ色のマリョクで代替している。
 */

const fs = require('fs');
const path = require('path');

const DECKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'premade_decks.json'), 'utf-8'));
const NAMES = Object.keys(DECKS);

function pickRandomPremadeDeck() {
  const name = NAMES[Math.floor(Math.random() * NAMES.length)];
  const deck = DECKS[name];
  return { name, cardIds: deck.cardIds.slice(), colors: deck.colors };
}

function listPremadeDecks() {
  return NAMES.map((name) => ({ name, colors: DECKS[name].colors, count: DECKS[name].count }));
}

module.exports = { pickRandomPremadeDeck, listPremadeDecks };
