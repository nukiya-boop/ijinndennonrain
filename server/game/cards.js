'use strict';

/**
 * カードマスタデータ。
 *
 * ダイソー「イジンデン」第1弾のカードリスト(公式サイト one-draw.jp で公開されている
 * カードリストExcel)を元にした、名前・色・レベル・パワー・カードテキストです。
 * これは非公式のファン制作Webアプリであり、ダイソー/大創出版/株式会社ワンドローとは
 * 一切関係ありません。
 *
 * ゲームエンジンでは、全カードのうち以下のみをルールとして実際に処理します:
 *  - イジンのキーワード能力: 即応 / ダブルプレッシャー / トリプルプレッシャー / ウォッチャー / 特性タグ
 *  - 遺業能力のうち「Nドローする」「復元」「魔力化」の単純なもの
 *  - マホウ9種すべて(個別に実装)
 *  - ハイケイ・マリョクのうち効果が明確なもの(power_aura, mana_right_bonus, 配置時ドロー等)
 * それ以外のルールテキストは、カード情報として表示されますが自動処理はされません
 * (テキストを読んで自己申告で運用するアナログ部分として扱う想定です)。
 */

const fs = require('fs');
const path = require('path');

const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards_data.json'), 'utf-8'));

const ALL_CARDS = {};
for (const c of RAW) {
  ALL_CARDS[c.id] = c;
}

const COLORS = ['red', 'blue', 'green'];
const COLOR_LABELS = { red: '赤 - 織田信長など (速攻)', blue: '青 - 大航海の英傑たち (戦略)', green: '緑 - 芸術と信仰の巨人たち (育成)' };

function byColorAndType(color, type) {
  return RAW.filter((c) => c.color === color && c.type === type);
}

function getCard(id) {
  const card = ALL_CARDS[id];
  if (!card) throw new Error(`Unknown card id: ${id}`);
  return card;
}

/**
 * 40枚のスターターデッキを、公式カードリストのみから自動生成する。
 * 同名カードは最大4枚までというルールを守りつつ、
 * マリョク:イジン:マホウ:ハイケイ が概ね 15:16~19:6~8:3~5 になるよう組む。
 */
function buildStarterDeckIds(color) {
  const ids = [];
  const maryoku = byColorAndType(color, 'maryoku');
  const mahou = byColorAndType(color, 'mahou');
  const haikei = byColorAndType(color, 'haikei').slice().sort((a, b) => (b.effect ? 1 : 0) - (a.effect ? 1 : 0));
  const ijin = byColorAndType(color, 'ijin').slice().sort((a, b) => a.level - b.level);

  const push = (card, copies) => {
    for (let i = 0; i < copies; i++) ids.push(card.id);
  };

  for (const c of maryoku) push(c, 3); // 5種 x3 = 15
  for (const c of mahou) push(c, 2); // 効果実装済み全種 x2

  let haikeiBudget = 6;
  for (const c of haikei) {
    if (haikeiBudget <= 0) break;
    const copies = Math.min(2, haikeiBudget);
    push(c, copies);
    haikeiBudget -= copies;
  }

  const remaining = 40 - ids.length;
  let ijinBudget = remaining;
  for (const c of ijin) {
    if (ijinBudget <= 0) break;
    const copies = Math.min(2, ijinBudget);
    push(c, copies);
    ijinBudget -= copies;
  }

  // 端数調整: 40枚に満たない場合は残りのマリョクで埋める
  let i = 0;
  while (ids.length < 40 && maryoku.length > 0) {
    push(maryoku[i % maryoku.length], 1);
    i++;
  }

  return ids.slice(0, Math.max(40, ids.length));
}

function listColors() {
  return COLORS.map((color) => ({ color, label: COLOR_LABELS[color] }));
}

module.exports = {
  ALL_CARDS,
  getCard,
  buildStarterDeckIds,
  listColors,
};
