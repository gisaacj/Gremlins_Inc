// =============================================================
// 「特务·摇尾巴」测试 —— 付 {1}% 的钱逃避玩家交锋
//
// 原版文案（来自能力参数的第二个 UIN，即游戏自己的说明）：
//   中「（可选）为避免玩家交锋，支付{1}%的$并移动到中心厄运站点（除非该站点已被占据）。
//       如当前并非轮到你走牌，则此站点规则对你无效。」
//   英 "If you want: to avoid Player Conflict, lose {1}% of your $ and teleport to
//       the central Misfortune spot (unless another player is already there).
//       If it's not your turn, the rules of this spot do not affect you."
//
// 三个限制都要守住：
//   1. 只有**引发交锋**的一方（轮到自己走牌）能用
//   2. 中心厄运站必须**没人**
//   3. 按**持钱的百分比**扣款
//
// 运行: npx tsx src/__tests__/escape.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { BOARD_MAPS, centralMisfortuneId } from '@gremlins/shared';
import {
  CHARACTERS, createState, getMap, getPlayer, resolvePending, startConflict,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(chars: string[] = ['SecretAgent', 'Banker'], seed = 999): EngineState {
  return createState({
    roomId: 'escape', seed, targetScore: 30,
    players: chars.map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
}

function answer(st: EngineState, value: string): void {
  const p = st.pending!;
  const r = resolvePending(st, p.playerId, [value]);
  st.pending = r.pending;
}

console.log('=== 1. 中心厄运站点的判定 ===');
check('两张地图都能定位到唯一的"中心厄运站"', () => {
  // BOARD_MAPS 是 BoardMap[]（按索引取键会得到 '0'/'1'，不是地图对象）
  for (const map of BOARD_MAPS) {
    const dest = centralMisfortuneId(map);
    assert.ok(dest, `map ${map.id} 应能定位中心厄运站`);
    const cell = map.cells.find((c) => c.id === dest)!;
    assert.ok(cell, `map ${map.id} 的目标格应存在`);
    assert.equal(cell.cellType, 'Misfortune', `map ${map.id} 应为厄运格，实际 ${cell.cellType}`);
    console.log(`      ${map.name}(id=${map.id}): ${dest}（出度 ${cell.out.length}/入度 ${cell.in.length}）`);
  }
});
check('引擎侧的 centralMisfortuneId 与顶层一致', () => {
  const st = game();
  assert.equal(centralMisfortuneId(getMap(st)), centralMisfortuneId(getMap(st)));
});
check('中心厄运站的连接度高于同图其它厄运格', () => {
  const st = game();
  const ms = getMap(st).cells.filter((c) => c.cellType === 'Misfortune');
  const dest = centralMisfortuneId(getMap(st))!;
  const deg = (c: typeof ms[number]) => c.out.length + c.in.length;
  const best = Math.max(...ms.map(deg));
  assert.equal(deg(ms.find((c) => c.id === dest)!), best, '应取连接度最高者');
  console.log(`      厄运格 ${ms.length} 个，最高连接度 ${best}`);
});

console.log('\n=== 2. 选项出现条件 ===');
check('特务引发交锋时会先问"逃避还是应战"', () => {
  const st = game(['SecretAgent', 'Banker']);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 400; b.res.money = 400;
  startConflict(st, a, b);
  assert.ok(st.pending, '应挂起');
  assert.ok(st.pending!.kind.endsWith(':escape'), `kind=${st.pending!.kind}`);
  const vals = st.pending!.options.map((o) => o.value);
  assert.deepEqual(vals, ['fight', 'escape'], `实际 ${vals.join(',')}`);
  console.log(`      ${st.pending!.prompt}`);
});
check('非特务引发交锋时没有逃避选项（直接进入出价）', () => {
  const st = game(['Banker', 'Engineer']);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 400; b.res.money = 400;
  startConflict(st, a, b);
  assert.ok(!st.pending!.kind.endsWith(':escape'), `不该有逃避选项：${st.pending!.kind}`);
  assert.ok(st.pending!.options.length >= 2, '应直接进入出价');
});
check('特务没钱时没有逃避选项（付不起）', () => {
  const st = game(['SecretAgent', 'Banker']);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 0; b.res.money = 400;
  startConflict(st, a, b);
  assert.ok(!st.pending!.kind.endsWith(':escape'), `没钱不该给逃避选项：${st.pending!.kind}`);
});
check('中心厄运站已被占据时没有逃避选项', () => {
  const st = game(['SecretAgent', 'Banker', 'Engineer']);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  const third = st.players.find((p) => p.id !== a.id && p.id !== b.id)!;
  a.res.money = 400; b.res.money = 400;
  third.cellId = centralMisfortuneId(getMap(st))!; // 占住目标格
  startConflict(st, a, b);
  assert.ok(!st.pending!.kind.endsWith(':escape'),
    `目标格被占不该给逃避选项：${st.pending!.kind}`);
});

console.log('\n=== 3. 选择逃避 ===');
check('逃避：扣 50% 的钱 + 传送到中心厄运站 + 交锋取消', () => {
  const st = game(['SecretAgent', 'Banker']);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 400; b.res.money = 400;
  startConflict(st, a, b);
  const dest = centralMisfortuneId(getMap(st))!;

  answer(st, 'escape');
  assert.equal(a.res.money, 200, `应扣 50% → 200，实际 ${a.res.money}`);
  assert.equal(a.cellId, dest, '应传送到中心厄运站');
  assert.equal(st.pending, undefined, '交锋应取消');
  assert.equal(a.inJail, false, '双方都不该被捕');
  assert.equal(b.inJail, false, '双方都不该被捕');
  assert.equal(b.res.money, 400, '对手的钱不受影响');
  assert.equal(a.conflictTotal, 0, '逃避不算参与交锋');
  console.log(`      400 → ${a.res.money}，传送到 ${dest.slice(-6)}`);
});
check('扣款是"持钱的百分比"而不是固定数：钱越多扣越多', () => {
  // cost = floor(money × 50 / 100)，余额 = money - cost
  for (const [money, expect] of [[100, 50], [400, 200], [999, 500]] as const) {
    const st = game(['SecretAgent', 'Banker']);
    const a = getPlayer(st, 'p0')!;
    const b = getPlayer(st, 'p1')!;
    a.res.money = money; b.res.money = 400;
    startConflict(st, a, b);
    answer(st, 'escape');
    assert.equal(a.res.money, expect, `${money} → 余额应为 ${expect}，实际 ${a.res.money}`);
  }
});
check('没钱可付时不会出现逃避选项（避免负资源）', () => {
  const st = game(['SecretAgent', 'Banker']);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 1; b.res.money = 400;
  startConflict(st, a, b);
  if (st.pending!.kind.endsWith(':escape')) {
    answer(st, 'escape');
    assert.ok(a.res.money >= 0, `金钱为负：${a.res.money}`);
  }
});

console.log('\n=== 3b. 逃避不会额外触发厄运（当前行为，待与原版核对）===');
check('逃避落到厄运格但不抽厄运牌', () => {
  // 原文用的是 "teleport"（传送）。引擎里"落点效果"由 resolveLanding 结算，
  // 而传送不走那条路径，所以不抽厄运。
  // ⚠️ 这是一条**行为锁**：原版是否如此尚未核实，改动它要先有依据。
  const st = game(['SecretAgent', 'Banker']);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 400; b.res.money = 400;
  const deckBefore = st.misfortuneDeck.length;
  startConflict(st, a, b);
  answer(st, 'escape');
  assert.equal(st.misfortuneDeck.length, deckBefore, '逃避不该消耗厄运牌');
  console.log(`      厄运牌堆保持 ${deckBefore} 张`);
});

console.log('\n=== 4. 选择应战 ===');
check('应战：进入出价阶段，先问挑战者', () => {
  const st = game(['SecretAgent', 'Banker']);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 400; b.res.money = 400;
  startConflict(st, a, b);
  answer(st, 'fight');
  assert.ok(st.pending, '应进入出价');
  assert.ok(!st.pending!.kind.endsWith(':escape'), `应已离开逃避阶段：${st.pending!.kind}`);
  assert.equal(st.pending!.playerId, a.id, '先问挑战者');
  assert.equal(a.res.money, 400, '应战不扣逃避费');
  console.log(`      ${st.pending!.prompt}`);
});
check('应战后正常结算交锋（高者留下，低者被捕）', () => {
  const st = game(['SecretAgent', 'Banker']);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 400; b.res.money = 400;
  startConflict(st, a, b);
  answer(st, 'fight');
  answer(st, '300'); // 挑战者
  answer(st, '100'); // 对手
  assert.equal(a.res.money, 100, `赢家应付 300：400 → ${a.res.money}`);
  assert.equal(b.inJail, true, '输家被捕');
  assert.equal(a.conflictTotal, 1, '应计入交锋统计');
});

console.log('\n=== 5. 不变量 ===');
check('各种金额下逃避后资源都不为负', () => {
  for (const money of [0, 1, 2, 3, 99, 100, 101, 1000]) {
    const st = game(['SecretAgent', 'Banker']);
    const a = getPlayer(st, 'p0')!;
    const b = getPlayer(st, 'p1')!;
    a.res.money = money; b.res.money = 400;
    startConflict(st, a, b);
    if (st.pending?.kind.endsWith(':escape')) answer(st, 'escape');
    assert.ok(a.res.money >= 0, `money=${money} → ${a.res.money}`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
