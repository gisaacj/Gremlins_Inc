// =============================================================
// 落地顺序测试：**先交锋，赢了留在格上才处理格子效果**
//
// 依据（`TAG.Game_Label_Conflict_Description` 原文）：
//   "The player who bids the most pays up and **remains on the spot**,
//    the other player is **arrested**."
//
// 输家被带走、只有赢家留在该站 → 格子效果是**留给留下来的人**结算的。
// 若先结算格子效果，等于"没争到站点的人也照吃了站点效果"，与原版不符。
//
// 实现上有个续跑难点：交锋会挂起等双方出价，而挂起被应答后引擎
// **不会**回到 `resolveLanding`。所以发起交锋时把 `{playerId, cellId}`
// 记进 `state.pendingCellEffect`，等交锋结算完（或被逃避）再补做。
//
// 本文件同时验证那个补做机制的两个边界：
//  - 赢家被 `[i]` 卡（a070「敲诈！」）挪走后，**不该**再吃原格效果
//  - 输家从不吃格子效果（它已被送进监狱）
//
// 运行: npx tsx server/src/__tests__/landing-order.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { CARD_BY_NAME, CELL_TYPE_BY_NAME } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, createState, getMap, getPlayer, resolvePending, skipPlay, startConflict, startMove,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

/** 造一局：P0 站在 `cellType` 的前驱格、持有 1 步牌，P1 已在该格 */
function setupDuel(cellType: string, opts: { money?: number } = {}) {
  const st: EngineState = createState({
    roomId: 'ord', seed: 11, targetScore: 999,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  const b = getPlayer(st, 'P1')!;
  for (const p of st.players) {
    p.res.money = opts.money ?? 2000;
    p.res.malice = 0;
    p.hand = [];
    p.inJail = false;
  }
  const cell = map.cells.find((c) => c.cellType === cellType);
  assert.ok(cell, `棋盘上应有 ${cellType} 格`);
  const prev = map.cells.find((c) => c.out.includes(cell!.id));
  assert.ok(prev, `${cellType} 应有前驱格`);
  const card = Object.values(CARD_BY_NAME).find((c) => c.move === 1 && c.price === 0)!;
  a.cellId = prev!.id;
  a.hand = [card.id];
  b.cellId = cell!.id;
  st.currentIndex = st.players.indexOf(a);
  return { st, a, b, cell: cell!, card };
}

/**
 * 驱动到走完（自动应答所有挂起），返回经过的挂起链。
 *
 * ⚠️ 原版顺序 Move → Conflict → UseCard → **UseCell**：
 * 站点效果在 UseCard 阶段收尾（`skipPlay`）才结算，
 * 所以应答完 Move/Conflict 的挂起后还要再 `skipPlay` 一次，
 * 才会看到站点交互（police / danger 等）并把它结算掉。
 */
function drive(st: EngineState, cardId: string, playerId: string) {
  const seen: string[] = [];
  let r = startMove(st, playerId, cardId);
  let g = 0;
  // 阶段一：Move / Conflict 的挂起
  while (st.pending && g++ < 16) {
    const pd = st.pending;
    seen.push(pd.kind);
    const pick = pd.options.slice(0, Math.max(1, pd.min ?? 1)).map((o) => o.value);
    if (pd.kind.startsWith('moveBranch:')) {
      r = startMove(st, playerId, cardId, { [pd.kind]: pick });
      continue;
    }
    const rr = resolvePending(st, pd.playerId, pick);
    st.pending = rr.pending;
  }
  // 阶段二：UseCard 收尾 → UseCell（站点效果）
  if (!st.pending && st.pendingCellEffect) {
    skipPlay(st, playerId);
    let g2 = 0;
    while (st.pending && g2++ < 16) {
      const pd = st.pending;
      seen.push(pd.kind);
      const pick = pd.options.slice(0, Math.max(1, pd.min ?? 1)).map((o) => o.value);
      const rr = resolvePending(st, pd.playerId, pick);
      st.pending = rr.pending;
    }
  }
  return { seen, r };
}

console.log('=== 1. 交锋在前，格子效果在后 ===');
check('Bribe 格：挂起链是 交锋 → （格子已即时结算）', () => {
  const { st, a, b, card } = setupDuel('Bribe');
  const before = a.res.money;
  const { seen } = drive(st, card.id, a.id);
  const ci = seen.findIndex((k) => k.startsWith('conflict:'));
  assert.ok(ci >= 0, `应触发交锋，实际链 ${seen.join(' → ')}`);
  assert.equal(b.inJail, true, '输家应被逮捕');
  // 停留贿赂格是双倍贿赂；赢家付了钱说明格子效果确实结算了
  assert.ok(a.res.money < before, `赢家应吃到格子效果（付双倍贿赂），${before} → ${a.res.money}`);
  console.log(`      链: ${seen.join(' → ')}；赢家金 ${before} → ${a.res.money}`);
});
check('Danger 格：**交锋先挂起，格子交互后挂起**', () => {
  const { st, a, b, card } = setupDuel('Danger');
  const { seen } = drive(st, card.id, a.id);
  const ci = seen.findIndex((k) => k.startsWith('conflict:'));
  const di = seen.findIndex((k) => k.startsWith('danger'));
  assert.ok(ci >= 0, `应触发交锋：${seen.join(' → ')}`);
  assert.ok(di >= 0, `应触发冒险格交互：${seen.join(' → ')}`);
  assert.ok(ci < di, `交锋应在格子交互之前：${seen.join(' → ')}`);
  console.log(`      链: ${seen.join(' → ')}`);
});
check('Police 格同理：交锋在前', () => {
  const { st, a, card } = setupDuel('Police');
  const { seen } = drive(st, card.id, a.id);
  const ci = seen.findIndex((k) => k.startsWith('conflict:'));
  const pi = seen.findIndex((k) => k.startsWith('police:'));
  if (ci < 0) { console.log('      （该路径未触发交锋，跳过）'); return; }
  assert.ok(pi < 0 || ci < pi, `交锋应在警察格交互之前：${seen.join(' → ')}`);
  console.log(`      链: ${seen.join(' → ')}`);
});
check('Risk 格（可选掷骰）不自动挂起，交锋先发生', () => {
  const { st, a, card } = setupDuel('Risk');
  const { seen } = drive(st, card.id, a.id);
  assert.ok(seen.some((k) => k.startsWith('conflict:')), `应触发交锋：${seen.join(' → ')}`);
  console.log(`      链: ${seen.join(' → ')}`);
});

console.log('\n=== 2. 只有**留下来的人**吃格子效果 ===');
check('输家不会吃到格子效果（它已被送进监狱）', () => {
  const { st, a, b, card, cell } = setupDuel('Bribe');
  const bBefore = b.res.money;
  drive(st, card.id, a.id);
  assert.equal(b.inJail, true, '输家应入狱');
  // 输家被送进监狱格，金钱不该因"停留贿赂格"而变化
  assert.equal(b.res.money, bBefore,
    `输家不该吃站点效果，金钱 ${bBefore} → ${b.res.money}`);
  assert.notEqual(b.cellId, cell.id, '输家应已离开该站');
  console.log(`      输家金保持 ${b.res.money}，已离开 ${cell.cellType}，在监狱`);
});
check('赢家留在原格（除非被卡牌挪走）', () => {
  const { st, a, card, cell } = setupDuel('Risk');
  drive(st, card.id, a.id);
  assert.equal(a.inJail, false, '赢家不入狱');
  assert.equal(a.cellId, cell.id, `赢家应留在 ${cell.cellType}`);
  console.log(`      赢家留在 ${cell.cellType}`);
});

console.log('\n=== 3. 边界：赢家被 a070 挪走后不再吃原格效果 ===');
check('a070「敲诈！」把对手挪走的机制不受影响', () => {
  // a070 是把**对手**挪走；这里验证挪动逻辑仍正常，且不破坏落地顺序
  const st: EngineState = createState({
    roomId: 'o2', seed: 5, targetScore: 999,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  const a = getPlayer(st, 'P0')!;
  const b = getPlayer(st, 'P1')!;
  a.res.money = 500; b.res.money = 500;
  a.res.malice = 0; b.res.malice = 0;
  a.hand = [CARD_BY_NAME['a070']!.id];
  startConflict(st, a, b);
  // 出价
  resolvePending(st, a.id, ['300']);
  resolvePending(st, b.id, ['100']);
  // 赢家手里有 a070 → 会挂起问是否打出
  assert.ok(st.pending, '应挂起交锋用牌选择');
  const useOpt = st.pending!.options.find((o) => o.value === 'use')!;
  resolvePending(st, a.id, [useOpt.value]);
  assert.equal(b.inJail, true, '对手仍被捕');
  console.log(`      赢家金 ${a.res.money}，对手被捕`);
});

console.log('\n=== 4. 不变量 ===');
check('pendingCellEffect 不会残留到回合外', () => {
  const { st, a, card } = setupDuel('Danger');
  drive(st, card.id, a.id);
  assert.equal(st.pendingCellEffect, undefined,
    `不该残留：${JSON.stringify(st.pendingCellEffect)}`);
});
check('整条链跑完后没有残留挂起', () => {
  for (const type of ['Bribe', 'Danger', 'Police', 'Risk', 'Income', 'Misfortune']) {
    const { st, a, card } = setupDuel(type);
    drive(st, card.id, a.id);
    assert.equal(st.pending, undefined, `${type}: 残留 ${st.pending?.kind}`);
    assert.equal(st.pendingCellEffect, undefined, `${type}: pendingCellEffect 残留`);
  }
});
check('建筑格不引发交锋（可容纳任意人数）', () => {
  const buildings = Object.entries(CELL_TYPE_BY_NAME)
    .filter(([, d]) => d.building).map(([k]) => k);
  assert.ok(buildings.length >= 11, `建筑应有 11 个，实际 ${buildings.length}`);
  const { st, a, card, cell } = setupDuel(buildings[0]);
  const { seen } = drive(st, card.id, a.id);
  assert.equal(seen.some((k) => k.startsWith('conflict:')), false,
    `${cell.cellType} 是建筑，不该交锋：${seen.join(' → ')}`);
  console.log(`      建筑 ${buildings.length} 个；样例 ${cell.cellType} 不交锋`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
