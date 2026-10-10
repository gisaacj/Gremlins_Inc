// =============================================================
// 玩家交锋（Player Conflict）测试
//
// 规则来自游戏内说明与 DLL 的 `ComConflictWindow` 协议字段：
//  - 触发：两位玩家停留在同一**非建筑**站点（建筑可容纳任意人数）
//  - 结算：每位玩家出价 → **最高者付款并留在原地，另一位被逮捕**
//  - 平局：`^`（罪恶）最少者获胜
//  - 统计：ConflictTotal / ConflictInit / ConflictWon / ConflictPaid
//          （字段名取自原版 GPlayer）
//
// 运行: npx tsx src/__tests__/conflict.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, cellTypeOf, createState, getMap, getPlayer, moveWithCard,
  resolvePending, startConflict,
} from '@gremlins/shared/engine';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(seed = 777): EngineState {
  return createState({
    roomId: 'conflict', seed, targetScore: 30,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
}

/** 回答当前挂起并写回 */
function answer(st: EngineState, value: string): void {
  const p = st.pending!;
  const r = resolvePending(st, p.playerId, [value]);
  st.pending = r.pending;
}

/** 摆好一场交锋：a 挑战 b，双方都有钱 */
function setup(bidA: number, bidB: number, maliceA = 0, maliceB = 0) {
  const st = game();
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 500; b.res.money = 500;
  a.res.malice = maliceA; b.res.malice = maliceB;
  startConflict(st, a, b);
  return { st, a, b, bidA, bidB };
}

/** 走完一场交锋 */
/** 走完一场交锋
 *
 * 注意：**清空双方手牌**。若赢家手里有带 `[i]` 段的卡（a070/a099），
 * 结算会在"付款前"挂起询问是否打出——那是 `conflict-hand-cards.test.ts`
 * 的测试对象。这里只验基础结算，所以先把干扰因素去掉。
 */
function fight(bidA: number, bidB: number, maliceA = 0, maliceB = 0) {
  const { st, a, b } = setup(bidA, bidB, maliceA, maliceB);
  a.hand = [];
  b.hand = [];
  answer(st, String(bidA));
  answer(st, String(bidB));
  return { st, a, b };
}

console.log('=== 1. 触发与挂起 ===');
check('startConflict 会挂起并要求出价', () => {
  const { st } = setup(50, 50);
  assert.ok(st.pending, '应挂起');
  assert.equal(st.pending!.kind.startsWith('conflict:'), true, `kind=${st.pending!.kind}`);
  assert.ok(st.pending!.options.length >= 2, '应给出多个出价选项');
  console.log(`      prompt: ${st.pending!.prompt}`);
});
check('先问挑战者，再问对手', () => {
  const st = game();
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 500; b.res.money = 500;
  startConflict(st, a, b);
  assert.equal(st.pending!.playerId, a.id, '应先问挑战者');
  answer(st, '50');
  assert.equal(st.pending!.playerId, b.id, '再问对手');
});
check('出价上限反映持有金钱', () => {
  const st = game();
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 120; b.res.money = 500;
  startConflict(st, a, b);
  const vals = st.pending!.options.map((o) => Number(o.value));
  assert.ok(Math.max(...vals) <= 120, `选项不应超过 120：${vals.join(',')}`);
  assert.ok(vals.includes(120), `应含"全押"120：${vals.join(',')}`);
});

console.log('\n=== 2. 结算：高者付款留下，低者被捕 ===');
check('挑战者出价更高 → 挑战者留下并付款，对手被捕', () => {
  const { st, a, b } = fight(200, 100);
  assert.equal(a.res.money, 300, `挑战者应付 200：500 → ${a.res.money}`);
  assert.equal(b.res.money, 500, '输家不付钱');
  assert.equal(a.inJail, false, '赢家留在原地');
  assert.equal(b.inJail, true, '输家被逮捕');
  console.log(`      ${a.name} 付 200 留下；${b.name} 被捕`);
});
check('对手出价更高 → 对手留下并付款，挑战者被捕', () => {
  const { st, a, b } = fight(50, 300);
  assert.equal(b.res.money, 200, `对手应付 300：500 → ${b.res.money}`);
  assert.equal(a.res.money, 500, '输家不付钱');
  assert.equal(b.inJail, false);
  assert.equal(a.inJail, true, '挑战者被捕');
});
check('钱不够时最多付掉全部持有', () => {
  const st = game();
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 30; b.res.money = 500;
  startConflict(st, a, b);
  answer(st, '30');
  answer(st, '10');
  assert.equal(a.res.money, 0, `应付 30 但只有 30 → ${a.res.money}`);
  assert.equal(b.inJail, true);
});

console.log('\n=== 3. 平局：罪恶最少者胜 ===');
check('平局时罪恶少的一方获胜', () => {
  const { a, b } = fight(100, 100, 5, 1);
  assert.equal(b.inJail, false, '罪恶少的 b 应获胜');
  assert.equal(a.inJail, true, '罪恶多的 a 应被捕');
});
check('平局且罪恶相同 → 挑战者获胜（<= 判定）', () => {
  const { a, b } = fight(100, 100, 3, 3);
  assert.equal(a.inJail, false, '挑战者应获胜');
  assert.equal(b.inJail, true);
});
check('平局时赢家仍要付出自己的出价', () => {
  const { a } = fight(100, 100, 0, 5);
  assert.equal(a.res.money, 400, `平局赢家应付 100：500 → ${a.res.money}`);
});

console.log('\n=== 4. 统计字段（对应原版 ConflictTotal/Init/Won/Paid）===');
check('双方的 conflictTotal 都 +1', () => {
  const { a, b } = fight(200, 100);
  assert.equal(a.conflictTotal, 1);
  assert.equal(b.conflictTotal, 1);
});
check('挑战者的 conflictInit +1，对手不增', () => {
  const { a, b } = fight(200, 100);
  assert.equal(a.conflictInit, 1);
  assert.equal(b.conflictInit, 0);
});
check('只有赢家的 conflictWon +1', () => {
  const { a, b } = fight(200, 100);
  assert.equal(a.conflictWon, 1);
  assert.equal(b.conflictWon, 0);
});
check('conflictPaid 累计赢家实际付出的钱', () => {
  const { a, b } = fight(200, 100);
  assert.equal(a.conflictPaid, 200);
  assert.equal(b.conflictPaid, 0);
});

console.log('\n=== 5. 不变量 ===');
check('交锋后资源不为负', () => {
  for (const [x, y] of [[0, 0], [500, 500], [10, 400]] as const) {
    const st = game();
    const a = getPlayer(st, 'p0')!;
    const b = getPlayer(st, 'p1')!;
    a.res.money = x; b.res.money = y;
    startConflict(st, a, b);
    answer(st, String(x));
    answer(st, String(y));
    for (const p of [a, b]) {
      assert.ok(p.res.money >= 0, `金钱为负：${p.id} = ${p.res.money}`);
      assert.ok(p.res.score >= 0, `齿轮为负：${p.id} = ${p.res.score}`);
    }
  }
});
check('发完双方出价后不再有挂起', () => {
  const { st } = fight(50, 50);
  assert.equal(st.pending, undefined, '应已结算完');
});
check('地图上同时存在非建筑站与建筑（交锋只在非建筑触发）', () => {
  const st = game();
  // 注意：`BoardCell` 本身没有 building 字段，要经 `cellTypeOf` 取 CellTypeDef
  const cells = getMap(st).cells;
  const nb = cells.filter((c) => !cellTypeOf(c)?.building);
  const b = cells.filter((c) => cellTypeOf(c)?.building);
  assert.ok(nb.length > 0, '应存在非建筑站');
  assert.ok(b.length > 0, '应存在建筑（建筑不引发交锋）');
  console.log(`      非建筑 ${nb.length} / 建筑 ${b.length}（合计 ${cells.length}）`);
});

/** 有移动点数且免费的卡（按步数升序）——避免测试里还要准备费用 */
const MOVE_CARDS = ACTION_CARDS
  .filter((c) => c.move > 0 && (c.price ?? 0) === 0)
  .sort((a, b) => a.move - b.move);

/**
 * 从 from 出发走恰好 steps 步能到达的格子集合。
 * 引擎要求落点距离**精确等于**卡牌步数，所以不能用"可达"代替。
 */
function reachableIn(st: EngineState, fromId: string, steps: number): string[] {
  let frontier = [fromId];
  const seen = new Set([fromId]);
  for (let i = 0; i < steps; i++) {
    const next: string[] = [];
    for (const id of frontier) {
      const cell = getMap(st).cells.find((c) => c.id === id);
      if (!cell) continue;
      for (const nb of cell.out) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return frontier;
}

console.log('\n=== 6. 真实移动流程触发（走引擎的移动结算） ===');
check('用真实卡牌走到对手所在非建筑站 → 触发交锋', () => {
  const st = game(4242);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 500; b.res.money = 500;
  st.currentIndex = st.players.indexOf(a);

  // 目标格要避开"落地即挂起"的格子（Danger / Police）：
  // 那两类会在 `resolveLanding` 里提前 return，交锋检查排在函数末尾，
  // 于是不会触发。那是另一个已知问题（见下方专门的用例与待办），
  // 这里验的是"普通非建筑站能触发交锋"。
  const HANGS = new Set(['Danger', 'Police']);
  let pick: { card: typeof MOVE_CARDS[number]; origin: string; dest: string } | undefined;
  for (const origin of getMap(st).cells) {
    if (cellTypeOf(origin)?.building) continue;
    for (const card of MOVE_CARDS.slice(0, 6)) {
      const dests = reachableIn(st, origin.id, card.move)
        .map((id) => getMap(st).cells.find((c) => c.id === id)!)
        .filter((c) => c && !cellTypeOf(c)?.building && !HANGS.has(c.cellType));
      if (dests.length) { pick = { card, origin: origin.id, dest: dests[0].id }; break; }
    }
    if (pick) break;
  }
  assert.ok(pick, '应能找到"非建筑 →(恰好 N 步) 非建筑(非 Danger/Police)"的组合');

  b.cellId = pick!.dest;
  a.cellId = pick!.origin;
  a.hand = [pick!.card.id];

  const r = moveWithCard(st, a.id, pick!.card.id, pick!.dest);
  assert.ok(r.ok, `移动应成功：${r.error}`);
  assert.ok(st.pending, '走到对手所在非建筑站应挂起交锋');
  assert.equal(st.pending!.kind.startsWith('conflict:'), true, `kind=${st.pending!.kind}`);
  const destCell = getMap(st).cells.find((c) => c.id === pick!.dest)!;
  console.log(`      ${pick!.card.text.name}(${pick!.card.move}步) → ${destCell.cellType}，触发交锋`);
  console.log(`      prompt: ${st.pending!.prompt}`);
});

/**
 * ✅ 已修复的缺陷（保留为回归用例）。
 *
 * 原来 `resolveLanding` 里 Danger 与 Police 会**提前 return**（挂起买保险 / 付贿赂），
 * 而"两位玩家同格则交锋"的检查排在函数**末尾**，于是这两类格子上
 * 交锋永远不会触发。
 *
 * 原文（游戏内说明）是：「当两位玩家停留在同一站点时，就会引发玩家交锋
 * （建筑除外）」——没有排除 Danger / Police。
 *
 * 修法：格子效果**先行**（它是"停在该格"的即时结算），
 * 交锋留到格子交互结束后再补判（见 `doneWithConflict`）。
 * 顺序选"先格子后交锋"，是因为交锋挂起被应答后引擎不会回到 `resolveLanding`，
 * 若先交锋会把格子效果**静默丢掉**（实测确认）。
 */
check('停在对手所在的 Danger/Police 格：先挂格子交互，之后触发交锋', () => {
  const st = game(4242);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 500; b.res.money = 500;
  st.currentIndex = st.players.indexOf(a);

  const HANGS = new Set(['Danger', 'Police']);
  let pick: { card: typeof MOVE_CARDS[number]; origin: string; dest: string } | undefined;
  for (const origin of getMap(st).cells) {
    for (const card of MOVE_CARDS.slice(0, 8)) {
      const dests = reachableIn(st, origin.id, card.move)
        .map((id) => getMap(st).cells.find((c) => c.id === id)!)
        .filter((c) => c && !cellTypeOf(c)?.building && HANGS.has(c.cellType));
      if (dests.length) { pick = { card, origin: origin.id, dest: dests[0].id }; break; }
    }
    if (pick) break;
  }
  assert.ok(pick, '应能找到走到 Danger/Police 格的组合');

  b.cellId = pick!.dest;
  a.cellId = pick!.origin;
  a.hand = [pick!.card.id];
  const r = moveWithCard(st, a.id, pick!.card.id, pick!.dest);
  assert.ok(r.ok, `移动应成功：${r.error}`);

  const destCell = getMap(st).cells.find((c) => c.id === pick!.dest)!;
  // 1) 先挂格子交互（买保险 / 付贿赂）
  assert.ok(st.pending, '应挂起格子交互');
  assert.equal(st.pending!.kind.startsWith('conflict:'), false,
    `第一步应是格子交互，实际 ${st.pending!.kind}`);
  console.log(`      ${destCell.cellType} 格 → 先挂起 ${st.pending!.kind}`);

  // 2) 应答格子交互后，应当补上交锋
  let guard = 0;
  while (st.pending && !st.pending.kind.startsWith('conflict:') && guard++ < 10) {
    const pd = st.pending;
    const ans = pd.options.slice(0, Math.max(1, pd.min ?? 1)).map((o) => o.value);
    const rr = resolvePending(st, pd.playerId, ans);
    st.pending = rr.pending;
  }
  assert.ok(st.pending, '应交接到交锋挂起');
  assert.ok(st.pending!.kind.startsWith('conflict:'),
    `格子交互结束后应触发交锋，实际 ${st.pending!.kind}`);
  console.log(`      格子交互结束 → ${st.pending!.kind}（交锋已触发）`);
});
check('走到对手所在的**建筑**格不触发交锋', () => {  const st = game(4242);
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  a.res.money = 500; b.res.money = 500;
  st.currentIndex = st.players.indexOf(a);

  let pick: { card: typeof MOVE_CARDS[number]; origin: string; dest: string } | undefined;
  for (const origin of getMap(st).cells) {
    for (const card of MOVE_CARDS.slice(0, 6)) {
      const dests = reachableIn(st, origin.id, card.move)
        .map((id) => getMap(st).cells.find((c) => c.id === id)!)
        .filter((c) => c && cellTypeOf(c)?.building);
      if (dests.length) { pick = { card, origin: origin.id, dest: dests[0].id }; break; }
    }
    if (pick) break;
  }
  assert.ok(pick, '应能找到走到建筑格的组合');

  b.cellId = pick!.dest;
  a.cellId = pick!.origin;
  a.hand = [pick!.card.id];
  const r = moveWithCard(st, a.id, pick!.card.id, pick!.dest);
  assert.ok(r.ok, `移动应成功：${r.error}`);
  const conflict = st.pending?.kind.startsWith('conflict:') ?? false;
  assert.equal(conflict, false, `建筑格不该触发交锋，实际 ${st.pending?.kind}`);
  const destCell = getMap(st).cells.find((c) => c.id === pick!.dest)!;
  console.log(`      ${pick!.card.text.name}(${pick!.card.move}步) → ${destCell.cellType}（建筑），未触发交锋`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
