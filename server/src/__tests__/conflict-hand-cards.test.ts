// =============================================================
// 交锋用牌（`[i]` = 留在手中、交锋时触发）测试
//
// 只有 2 张卡带 `[i]` 段（`card.handText`）：
//  - a070「敲诈！」：交锋中可弃掉此卡，把对手挪到离自己一格的位置（可逆行），
//                    且**对手付你 50$**（Param1）。
//  - a099「保险政策」：交锋**胜出**时可弃掉此卡，**改为不付钱**。
//
// 时点：判定胜负之后、赢家付款之前。
// 运行: npx tsx server/src/__tests__/conflict-hand-cards.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CARD_BY_NAME } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, CONFLICT_CARD_KIND, cellTypeOf, createState, getMap, getPlayer,
  resolvePending, startConflict,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;
const A070 = CARD_BY_NAME['a070']!.id;
const A099 = CARD_BY_NAME['a099']!.id;

/** 造一场交锋：a 挑战 b，a 手里可带 `[i]` 卡 */
function setup(opts: { hand?: string; bidA?: number; bidB?: number; money?: number } = {}) {
  const st: EngineState = createState({
    roomId: 'cf', seed: 909, targetScore: 30,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  st.currentIndex = st.players.indexOf(a);
  a.res.money = opts.money ?? 500;
  b.res.money = opts.money ?? 500;
  a.hand = opts.hand ? [opts.hand] : [];
  b.hand = [];
  startConflict(st, a, b);
  // 先过掉「摇尾巴」那一层（两人都不是特务，不会出现）
  const bidA = opts.bidA ?? 300;
  const bidB = opts.bidB ?? 100;
  // 逐个出价：谁先被问就谁先答
  // 逐个出价：出到"双方都报过价"为止；之后若出现交锋用牌挂起就停手，
  // 交给测试自己决定选 use / decline。
  let g = 0;
  while (st.pending && st.pending.kind.startsWith('conflict:') && g++ < 6) {
    const pid = st.pending.playerId;
    const v = pid === a.id ? bidA : bidB;
    const r = resolvePending(st, pid, [String(v)]);
    st.pending = r.pending;
  }
  return { st, a, b };
}

const answer = (st: EngineState, v: string) => {
  const pd = st.pending!;
  const r = resolvePending(st, pd.playerId, [v]);
  st.pending = r.pending;
};

console.log('=== 1. 触发条件 ===');
check('数据里恰好 2 张卡带 [i] 段', () => {
  const withHand = ACTION_CARDS.filter((c) => c.handText);
  assert.equal(withHand.length, 2, `实际 ${withHand.length}`);
  assert.deepEqual(withHand.map((c) => c.name).sort(), ['a070', 'a099']);
});
check('赢家手里没有 [i] 卡 → 直接结算，不挂起', () => {
  const { st, a, b } = setup({});
  assert.equal(st.pending, undefined, `不该挂起，实际 ${st.pending?.kind}`);
  assert.equal(b.inJail, true, '输家应被逮捕');
  assert.equal(a.res.money, 200, `赢家应付出价 300：500 → ${a.res.money}`);
  console.log(`      赢家付款后金钱 ${a.res.money}，输家被捕`);
});
check('赢家手里有 a099 → 挂起让他选', () => {
  const { st, a } = setup({ hand: A099 });
  assert.ok(st.pending, '应挂起');
  assert.equal(st.pending!.kind, CONFLICT_CARD_KIND, `实际 ${st.pending!.kind}`);
  assert.equal(st.pending!.playerId, a.id, '应问赢家');
  console.log(`      ${st.pending!.prompt}`);
});
check('选项含"打出此卡"与"不用"两项', () => {
  const { st } = setup({ hand: A099 });
  const vals = st.pending!.options.map((o) => o.value).sort();
  assert.deepEqual(vals, ['decline', 'use']);
});

console.log('\n=== 2. a099「保险政策」：胜出时弃卡免付 ===');
check('选择打出 → 不扣钱，卡进弃牌堆', () => {
  const { st, a } = setup({ hand: A099, bidA: 300 });
  const before = a.res.money;
  answer(st, 'use');
  assert.equal(a.res.money, before, `不该扣钱：${before} → ${a.res.money}`);
  assert.equal(a.hand.includes(A099), false, '卡应离手');
  assert.ok(st.discard.includes(A099), '卡应进弃牌堆');
  console.log(`      金钱保持 ${a.res.money}（省下 300），卡已弃置`);
});
check('选择不用 → 照常付出价', () => {
  const { st, a } = setup({ hand: A099, bidA: 300 });
  answer(st, 'decline');
  assert.equal(a.res.money, 200, `应付 300：500 → ${a.res.money}`);
  assert.ok(a.hand.includes(A099), '不用则卡应留在手里');
  console.log(`      金钱 500 → ${a.res.money}，卡仍在手中`);
});
check('免付时 conflictPaid 不增加', () => {
  const { st, a } = setup({ hand: A099, bidA: 300 });
  answer(st, 'use');
  assert.equal(a.conflictPaid, 0, `实际 ${a.conflictPaid}`);
});
check('正常付款时 conflictPaid 记录实付', () => {
  const { st, a } = setup({ hand: A099, bidA: 300 });
  answer(st, 'decline');
  assert.equal(a.conflictPaid, 300, `实际 ${a.conflictPaid}`);
});

console.log('\n=== 3. a070「敲诈！」：对手付你 50$ 并被挪走 ===');
check('选择打出 → 对手付你 Param1(=50)$', () => {
  const { st, a, b } = setup({ hand: A070, bidA: 300 });
  const aBefore = a.res.money;
  const bBefore = b.res.money;
  answer(st, 'use');
  // 对手净付 50（这 50 归赢家）
  assert.equal(bBefore - b.res.money, 50, `输家应 -50，实际 -${bBefore - b.res.money}`);
  // 赢家：+50（敲诈）−300（仍须付出价）= 净 −250
  assert.equal(aBefore - a.res.money, 250, `赢家净变化应为 -250，实际 ${aBefore - a.res.money}`);
  console.log(`      输家 ${bBefore} → ${b.res.money}（-50），赢家 ${aBefore} → ${a.res.money}（+50 敲诈 −300 出价）`);
});
check('对手被挪到相邻格（不再是原格）', () => {
  const { st, b } = setup({ hand: A070 });
  const before = b.cellId;
  answer(st, 'use');
  assert.notEqual(b.cellId, before, '对手位置应改变');
  const cell = getMap(st).cells.find((c) => c.id === b.cellId);
  assert.ok(cell, '目标格应存在');
  console.log(`      对手 ${before.slice(-4)} → ${b.cellId.slice(-4)}（${cellTypeOf(cell!)?.cellType ?? '?'}）`);
});
check('打出 a070 后仍照常付出价（此卡不免付）', () => {
  const { st, a } = setup({ hand: A070, bidA: 300 });
  const before = a.res.money;
  answer(st, 'use');
  // 收 50 且付 300 → 净 -250（与 a099 的"免付"不同，a070 只负责敲诈与位移）
  assert.equal(before - a.res.money, 250, `净变化应为 -250，实际 ${before - a.res.money}`);
  console.log(`      净变化 -250（收 50、付 300）`);
});
check('位移发生在逮捕之后（不会被送进监狱格覆盖）', () => {
  const { st, b } = setup({ hand: A070 });
  answer(st, 'use');
  const cell = getMap(st).cells.find((c) => c.id === b.cellId)!;
  assert.notEqual(cell.cellType, 'Jail', `不该停在监狱格（实际 ${cell.cellType}）`);
  console.log(`      对手落在 ${cell.cellType}，且 inJail=${b.inJail}`);
});
check('对手仍被逮捕（a070 不改变胜负）', () => {
  const { st, b } = setup({ hand: A070 });
  answer(st, 'use');
  assert.equal(b.inJail, true);
});

console.log('\n=== 4. 卡牌离手 ===');
check('a070 打出后进弃牌堆且不在手牌', () => {
  const { st, a } = setup({ hand: A070 });
  answer(st, 'use');
  assert.equal(a.hand.includes(A070), false);
  assert.ok(st.discard.includes(A070));
});
check('抉择后不应残留挂起', () => {
  const { st } = setup({ hand: A099 });
  answer(st, 'use');
  assert.equal(st.pending, undefined, `仍挂起 ${st.pending?.kind}`);
});

console.log('\n=== 5. 不变量 ===');
check('双方资源不为负', () => {
  for (const hand of [A070, A099]) {
    const { st, a, b } = setup({ hand, money: 60, bidA: 500, bidB: 10 });
    if (st.pending?.kind === CONFLICT_CARD_KIND) answer(st, 'use');
    for (const p of [a, b]) {
      for (const k of ['money', 'vote', 'malice', 'score', 'income'] as const) {
        assert.ok(p.res[k] >= 0, `${p.name} 的 ${k} 变成 ${p.res[k]}`);
      }
    }
  }
});
check('不是赢家本人时拒绝处理', () => {
  const { st, a } = setup({ hand: A099 });
  assert.ok(st.pending);
  const r = resolvePending(st, st.pending!.playerId === a.id ? 'p1' : 'p0', ['use']);
  assert.equal(r.ok, false, '不该允许他人代为决策');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
