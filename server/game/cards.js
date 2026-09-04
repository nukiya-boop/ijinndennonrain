'use strict';

/**
 * カードマスタデータ。
 *
 * ダイソー「イジンデン」第1弾〜第6弾のカードリスト(公式サイト one-draw.jp で公開されている
 * カードリストExcel)を元にした、名前・色・レベル・パワー・カードテキストです。
 * これは非公式のファン制作Webアプリであり、ダイソー/大創出版/有限会社ワンドローとは
 * 一切関係ありません。
 *
 * ゲームエンジンでは、全カードのうち以下のみをルールとして実際に処理します:
 *  - イジンのキーワード能力: 即応 / ダブル・トリプル・クアドラプルプレッシャー / ウォッチャー / 特性タグ
 *  - 遺業能力のうち「Nドローする」「復元」「魔力化」「これを手札に戻す」の単純なもの
 *  - マホウのうち、個別実装した9種、および単純な定型パターン(ドロー/召喚権+1/配置権+1/
 *    単体対象の破壊・バウンス)に一致するもの
 *  - ハイケイ・マリョクのうち効果が明確なもの(power_aura, mana_right_bonus, 配置時ドロー等)
 * それ以外のルールテキストは、カード情報として表示されますが自動処理はされません。
 */

const fs = require('fs');
const path = require('path');

const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards_data.json'), 'utf-8'));

const ALL_CARDS = {};
for (const c of RAW) {
  ALL_CARDS[c.id] = c;
}

const COLORS = ['red', 'blue', 'green', 'yellow', 'purple'];
const COLOR_LABELS = {
  red: '赤 - 武将・革命家たち',
  blue: '青 - 大航海の英傑たち',
  green: '緑 - 芸術と信仰の巨人たち',
  yellow: '黄 - 策略と均衡の担い手',
  purple: '紫 - 神秘と叡智の探求者',
};

function isMono(card, color) {
  return card.colors.length === 1 && card.colors[0] === color;
}
function isColorless(card) {
  return card.colors.length === 0;
}

function poolFor(color, type) {
  return RAW.filter((c) => c.type === type && (isMono(c, color) || isColorless(c)));
}

function getCard(id) {
  const card = ALL_CARDS[id];
  if (!card) throw new Error(`Unknown card id: ${id}`);
  return card;
}

/**
 * 40枚のスターターデッキを、公式カードリストのみから自動生成する。
 * 同名カードは最大4枚まで(異なる弾の再録・別バージョンを跨いだ場合も含む)というルールを守りつつ、
 * マリョク:イジン:マホウ:ハイケイ が概ね 16:15前後:6~8:4~6 になるよう組む。
 * 無色カードはどの色のデッキにも採用できる。
 */
function buildStarterDeckIds(color) {
  const ids = [];
  const nameCounts = {};

  const push = (card, copies) => {
    let n = nameCounts[card.name] || 0;
    for (let i = 0; i < copies; i++) {
      if (n >= 4) break;
      ids.push(card.id);
      n += 1;
    }
    nameCounts[card.name] = n;
  };

  const maryoku = poolFor(color, 'maryoku').filter((c) => isMono(c, color));
  const maryokuColorless = poolFor(color, 'maryoku').filter((c) => isColorless(c));
  const mahou = poolFor(color, 'mahou').filter((c) => c.effect);
  const haikei = poolFor(color, 'haikei').slice().sort((a, b) => (b.effect ? 1 : 0) - (a.effect ? 1 : 0));
  const ijin = poolFor(color, 'ijin').slice().sort((a, b) => a.level - b.level);

  for (const c of maryoku.slice(0, 5)) push(c, 3); // 主色マリョク ~15枚
  if (ids.length < 15) {
    for (const c of maryokuColorless) {
      if (ids.length >= 16) break;
      push(c, 2);
    }
  }
  for (const c of mahou.slice(0, 5)) push(c, 2); // 効果実装済みのマホウを優先採用

  let haikeiBudget = 6;
  for (const c of haikei) {
    if (haikeiBudget <= 0) break;
    const copies = Math.min(2, haikeiBudget);
    push(c, copies);
    haikeiBudget -= copies;
  }

  let ijinBudget = 40 - ids.length;
  for (const c of ijin) {
    if (ijinBudget <= 0) break;
    const before = ids.length;
    push(c, Math.min(2, ijinBudget));
    ijinBudget -= ids.length - before;
  }

  // 端数調整: 40枚に満たない場合は残りのマリョクで埋める
  let i = 0;
  const fillers = maryoku.concat(maryokuColorless);
  while (ids.length < 40 && fillers.length > 0) {
    push(fillers[i % fillers.length], 1);
    i++;
    if (i > fillers.length * 4) break; // 名前上限などで埋まらない場合の保険
  }

  return ids;
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
