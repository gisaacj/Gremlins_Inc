// =============================================================
// 厄运牌堆构造与「玩家 ≥5 人剔除 m029」测试
//
// 依据（反编译 `GGame.nonlockedMFPickCard()`，同一段逻辑连着写了两遍，
// 因为"抽完立即重洗"也走这里）：
//
// ```csharp
// List<UIN> list = new List<UIN>();
// foreach (card in DM.MisFortuneCards)          // 按 DeckCount 展开
//     for (int j = 0; j < card.DeckCount; j++) list.Add(card.ID);
// UIN[] array = list.OrderBy(x => GGame.GetNextInt32(rnd)).ToArray();   // 洗牌
// for (int k = 0; k < array.Length; k++)
//     if (this.Players.Count < 5 || !(array[k] == "F7C040EC0741FE1C"))
//         this.MFCDeck.AddFirst(array[k]);
// ```
//
// `F7C040EC0741FE1C` = **m029「丢失的债券」**。
// 即玩家 ≥5 人时这张牌**不进牌堆**——原版里少见的"按人数改卡池"规则。
//
// 运行: npx tsx server/src/__tests__/misfortune-deck.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { MISFORTUNE_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, MF_EXCLUDED_AT_FIVE_PLAYERS, buildMisfortuneDeck, createState,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const EXCLUDED = BigInt(`0x${MF_EXCLUDED_AT_FIVE_PLAYERS}`).toString();
const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;
const NAMES = ['Banker', 'Engineer', 'Gambler', 'Thief', 'Judge', 'Merchant'];

function game(n: number, seed = 1234): EngineState {
  return createState({
    roomId: 'mf', seed, targetScore: 30,
    players: Array.from({ length: n }, (_, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: true, characterId: charOf(NAMES[i % NAMES.length]),
    })),
  });
}

console.log('=== 1. 常量与数据 ===');
check('被剔除的 UIN 就是 m029「丢失的债券」', () => {
  const c = MISFORTUNE_CARDS.find((x) => x.id === EXCLUDED);
  assert.ok(c, `没找到 id=${EXCLUDED} 的厄运牌`);
  assert.equal(c.name, 'm029', `实际 ${c.name}「${c.text.name}」`);
  console.log(`      ${c.name}「${c.text.name}」`);
});
check('厄运牌共 40 种、按 DeckCount 展开也是 40 张', () => {
  assert.equal(MISFORTUNE_CARDS.length, 40);
  const total = MISFORTUNE_CARDS.reduce((s, c) => s + Math.max(1, c.deckCount ?? 1), 0);
  assert.equal(total, 40, `实际 ${total}`);
});

console.log('\n=== 2. 人数规则（核心）===');
for (const n of [2, 3, 4]) {
  check(`${n} 人局：牌堆含 m029（40 张）`, () => {
    const st = game(n);
    assert.equal(st.misfortuneDeck.length, 40, `实际 ${st.misfortuneDeck.length}`);
    assert.ok(st.misfortuneDeck.includes(EXCLUDED), '应包含 m029');
  });
}
for (const n of [5, 6]) {
  check(`${n} 人局：牌堆不含 m029（39 张）`, () => {
    const st = game(n);
    assert.equal(st.misfortuneDeck.length, 39, `实际 ${st.misfortuneDeck.length}`);
    assert.equal(st.misfortuneDeck.includes(EXCLUDED), false, '不该包含 m029');
  });
}
check('4 人与 5 人恰好差那 1 张牌', () => {
  const a = game(4).misfortuneDeck.length;
  const b = game(5).misfortuneDeck.length;
  assert.equal(a - b, 1, `4 人 ${a} 张 vs 5 人 ${b} 张`);
});

console.log('\n=== 3. buildMisfortuneDeck 的通用行为 ===');
check('不修改传入 state 的其它字段', () => {
  const st = game(3);
  const before = { deck: st.deck.length, hand: st.players[0].hand.length };
  buildMisfortuneDeck(st);
  assert.equal(st.deck.length, before.deck, '主牌库不该变');
  assert.equal(st.players[0].hand.length, before.hand, '手牌不该变');
});
check('两次构造结果长度一致（确定性）', () => {
  const st = game(4);
  const a = buildMisfortuneDeck(st).length;
  const b = buildMisfortuneDeck(st).length;
  assert.equal(a, b);
});
check('同一 seed 两次构造顺序一致（可复现）', () => {
  const a = game(4, 777).misfortuneDeck.join(',');
  const b = game(4, 777).misfortuneDeck.join(',');
  assert.equal(a, b, '同 seed 应得到同样的洗牌结果');
});
check('不同 seed 顺序不同（确实洗过牌）', () => {
  const a = game(4, 1).misfortuneDeck.join(',');
  const b = game(4, 999).misfortuneDeck.join(',');
  assert.notEqual(a, b, '不同 seed 不该完全一样');
});
check('牌堆元素都是合法厄运牌 id', () => {
  const ids = new Set(MISFORTUNE_CARDS.map((c) => c.id));
  for (const id of game(5).misfortuneDeck) {
    assert.ok(ids.has(id), `未知牌 id ${id}`);
  }
});

console.log('\n=== 4. 抽完重洗后仍遵守人数规则 ===');
check('5 人局把牌抽干再重洗，仍不会出现 m029', () => {
  const st = game(5);
  // 模拟抽干
  st.misfortuneDeck.length = 0;
  const rebuilt = buildMisfortuneDeck(st);   // drawMisfortune 内部用的同一函数
  assert.equal(rebuilt.includes(EXCLUDED), false, '重洗后不该出现 m029');
  assert.equal(rebuilt.length, 39);
});
check('3 人局重洗后仍含 m029', () => {
  const st = game(3);
  st.misfortuneDeck.length = 0;
  const rebuilt = buildMisfortuneDeck(st);
  assert.ok(rebuilt.includes(EXCLUDED), '重洗后应仍含 m029');
});

console.log('\n=== 5. 不变量 ===');
check('牌堆不含重复以外的异常（长度等于展开总数）', () => {
  for (const n of [2, 4, 5, 6]) {
    const st = game(n);
    const expect = 40 - (n >= 5 ? 1 : 0);
    assert.equal(st.misfortuneDeck.length, expect, `${n} 人局长度应为 ${expect}`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
