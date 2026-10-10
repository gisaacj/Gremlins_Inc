// =============================================================
// 卡牌「移动时效果」数据测试
//
// 背景：原版一张行动卡有**两种用法**——
//   1. 在站点/建筑打出 → 触发 `ActionList` 里 `MOVE` **之前**的动作；
//   2. 用它**移动**       → 触发 `ActionList` 里 `MOVE` **之后**的动作，
//                          并在说明里以 `[m]` 段单独写一遍。
//
// 之前生成的数据只保留了整条 `ActionList`，引擎无从区分两种用法，
// 于是这 16 张卡「移动时」的规则（扣钱/加罪恶/跳过回合/逆行…）整体丢失。
//
// 现在数据里保留：
//   - `moveText`      —— `[m]` 段原文（英文；中文表里常被截断成只有标记符）
//   - `moveActions`   —— `MOVE` 之后的动作（可直接执行）
//
// 运行: npx tsx server/src/__tests__/card-move-effects.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CARD_BY_NAME } from '@gremlins/shared/gamedata';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

console.log('=== 1. 数据完整性 ===');
check('卡牌 186 张、牌库 225 张', () => {
  assert.equal(ACTION_CARDS.length, 186);
  const deck = ACTION_CARDS.reduce((s, c) => s + c.deckCount, 0);
  assert.equal(deck, 225, `牌库应为 225，实际 ${deck}`);
});
check('每张卡都有 moveActions 字段（可为空数组）', () => {
  const missing = ACTION_CARDS.filter((c) => !Array.isArray(c.moveActions));
  assert.equal(missing.length, 0, `缺字段：${missing.map((c) => c.name).join(',')}`);
});
check('每张卡都有 en.description 字段', () => {
  const missing = ACTION_CARDS.filter((c) => typeof c.en?.description !== 'string');
  assert.equal(missing.length, 0, `缺字段：${missing.map((c) => c.name).join(',')}`);
});

console.log('\n=== 2. [m] 段与 moveActions 的对应 ===');
const withMoveText = ACTION_CARDS.filter((c) => c.moveText);
const withMoveActions = ACTION_CARDS.filter((c) => (c.moveActions?.length ?? 0) > 0);

check('恰好 17 张卡带 [m] 段', () => {
  assert.equal(withMoveText.length, 17, `实际 ${withMoveText.length}：${withMoveText.map((c) => c.name).join(',')}`);
  console.log(`      ${withMoveText.map((c) => c.name).join(', ')}`);
});
check('16 张卡的 [m] 效果体现在 moveActions 里', () => {
  assert.equal(withMoveActions.length, 16,
    `实际 ${withMoveActions.length}：${withMoveActions.map((c) => c.name).join(',')}`);
});
check('唯一例外 a066：效果存在 SpecialMove 参数里，不在 MOVE 之后', () => {
  const diff = withMoveText.filter((c) => !(c.moveActions?.length > 0)).map((c) => c.name);
  assert.deepEqual(diff, ['a066'], `实际差异：${diff.join(',')}`);
  const c = CARD_BY_NAME['a066']!;
  assert.ok(c.specialMove, 'a066 应带 specialMove 标记');
  assert.ok(c.actions.some((a) => a.type === 'SpecialMove'), 'a066 应有 SpecialMove 动作');
  console.log(`      a066 [m]: ${c.moveText}`);
});
check('每张有 moveActions 的卡都能在 [m] 文本里找到对应线索', () => {
  for (const c of withMoveActions) {
    assert.ok(c.moveText && c.moveText.length > 5,
      `${c.name} 有 moveActions 但 [m] 文本为空`);
  }
});

console.log('\n=== 3. 逐张核对关键卡（参数与文本一致）===');
const expect = [
  // 卡   移动点  期望的移动动作类型
  ['a015', 6, 'OpponentLoseMoney', 20],
  ['a017', 6, 'OpponentLoseMalice', -1],
  ['a019', 6, 'OpponentLoseVotes', 1],
  ['a024', 3, 'OpponentLoseMoney', 50],
  ['a074', 3, 'OpponentLoseMoney', -20],
  ['a076', 1, 'OpponentSkipTurn', 1],
  ['a123', 6, 'OpponentSkipTurn', 1],
  ['a140', 1, 'OpponentLoseMalice', 1],
] as const;
for (const [name, move, type, val] of expect) {
  check(`${name}：move=${move}，移动时 ${type}(${val})`, () => {
    const c = CARD_BY_NAME[name]!;
    assert.ok(c, `${name} 不存在`);
    assert.equal(c.move, move);
    const a = c.moveActions.find((x) => x.type === type);
    assert.ok(a, `${name} 的 moveActions 缺 ${type}：${JSON.stringify(c.moveActions)}`);
    assert.equal(Number(a.params?.[0]), val, `${name} ${type} 参数应为 ${val}`);
  });
}
check('a031 逆行用 Move_Back，且步数 = 卡面移动点数', () => {
  const c = CARD_BY_NAME['a031']!;
  assert.ok(c.moveActions.some((a) => a.type === 'Move_Back'), '应有 Move_Back');
  assert.equal(c.move, 2);
});
check('a022 移动改为掷骰（ROLL）', () => {
  const c = CARD_BY_NAME['a022']!;
  assert.equal(c.move, 0, 'a022 卡面移动点数为 0，必须掷骰');
  assert.ok(c.moveActions.some((a) => a.type === 'ROLL'), '应有 ROLL');
});
check('a129 移动时付贿赂，参数是 Bribe 关键字而非固定金额', () => {
  const c = CARD_BY_NAME['a129']!;
  const a = c.moveActions.find((x) => x.type === 'OpponentLoseMoney')!;
  assert.ok(a, '应有 OpponentLoseMoney');
  assert.equal(a.params?.[0], 'Bribe', `参数应为 Bribe，实际 ${a.params?.[0]}`);
});

console.log('\n=== 4. [i] 手中效果 ===');
const withHand = ACTION_CARDS.filter((c) => c.handText);
check('恰好 2 张卡带 [i] 段', () => {
  assert.equal(withHand.length, 2, `实际 ${withHand.length}：${withHand.map((c) => c.name).join(',')}`);
  const names = withHand.map((c) => c.name).sort();
  assert.deepEqual(names, ['a070', 'a099'], `实际 ${names.join(',')}`);
  console.log(`      ${withHand.map((c) => `${c.name}: ${c.handText?.slice(0, 50)}`).join('\n      ')}`);
});

console.log('\n=== 5. 不变量 ===');
check('moveActions 里的 SelectSelf 不携带数值参数（只是"目标=自己"）', () => {
  for (const c of withMoveActions) {
    for (const a of c.moveActions.filter((x) => x.type === 'SelectSelf')) {
      assert.deepEqual(a.params, [''], `${c.name} 的 SelectSelf 参数异常：${JSON.stringify(a.params)}`);
    }
  }
});
check('没有卡把 MOVE 放进 moveActions（分隔符不该自指）', () => {
  for (const c of withMoveActions) {
    assert.equal(c.moveActions.some((a) => a.type === 'MOVE'), false,
      `${c.name} 的 moveActions 里出现了 MOVE`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
