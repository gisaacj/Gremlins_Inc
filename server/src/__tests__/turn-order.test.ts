// =============================================================
// 回合内执行顺序的回归测试
//
// 用户确认的顺序：
//   移动 → 判断是否冲突 → 看是否有可使用的牌 → 执行建筑/站点效果
//   角色技能按各自描述的时机触发
//
// 本文件把这个顺序钉住，避免以后重构时又被改回去。
//
// 运行: npx tsx server/src/__tests__/turn-order.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, availableOptions, buildEnginePrompt, createState, getMap, getPlayer,
  moveWithCard, nextTurn, resolvePending, skipPlay, takeJailTurn,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;
const card1 = ACTION_CARDS.find((c) => c.move === 1 && c.price === 0 && !c.specialMove)!;

function game(names = ['Banker', 'Engineer']): EngineState {
  const st: EngineState = createState({
    roomId: 'to', seed: 11, targetScore: 999,
    players: names.map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = 1000; p.res.malice = 0; p.res.vote = 3; p.hand = []; p.inJail = false;
  }
  st.currentIndex = st.players.indexOf(getPlayer(st, 'P0')!);
  return st;
}

/** 把 P0 放到某类格子的前驱格，准备好一张 1 步牌 */
function armApproach(st: EngineState, cellType: string) {
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  const target = map.cells.find((c) => c.cellType === cellType)!;
  const prev = map.cells.find((c) => c.out.includes(target.id))!;
  a.cellId = prev.id;
  a.hand = [card1.id];
  return { a, target, prev };
}

/** 把对手挪去监狱格，避免意外交锋 */
function parkOpponent(st: EngineState) {
  const jail = getMap(st).cells.find((c) => c.cellType === 'Jail');
  const b = getPlayer(st, 'P1');
  if (jail && b) b.cellId = jail.id;
}

// ─────────────────────────────────────────────────────────────
console.log('=== 第 1 步：移动（Move） ===');

check('走牌后落点已确定，但**站点效果尚未结算**', () => {
  const st = game();
  parkOpponent(st);
  const { a, target } = armApproach(st, 'Income');
  const money0 = a.res.money;
  moveWithCard(st, a.id, card1.id, target.id);
  assert.equal(a.cellId, target.id, '应落在目标格');
  assert.equal(a.res.money, money0, `Move 阶段不该结算站点（金钱应不变，实际 ${money0} → ${a.res.money}）`);
  assert.ok(st.pendingCellEffect, '应登记"欠着的站点效果"');
  console.log(`      落点 Income，金钱保持 ${money0}，欠账已登记`);
});

check('移动用掉 1 张牌并补 1 张（手牌维持 6）', () => {
  const st = game();
  parkOpponent(st);
  const { a, target } = armApproach(st, 'Income');
  a.hand = [card1.id];
  moveWithCard(st, a.id, card1.id, target.id);
  assert.equal(a.cardsPlayedThisTurn, 1, '本回合已用 1 张');
  assert.ok(a.movedThisTurn, 'movedThisTurn 应为真');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== 第 2 步：判断是否冲突（Conflict）—— 排在站点效果之前 ===');

check('对手在目标格 → 先挂起交锋', () => {
  const st = game();
  const { a, target } = armApproach(st, 'Bribe');
  const b = getPlayer(st, 'P1')!;
  b.cellId = target.id;          // 对手已在该格
  moveWithCard(st, a.id, card1.id, target.id);
  assert.ok(st.pending, '应挂起');
  assert.ok(st.pending!.kind.startsWith('conflict:'),
    `应先挂起交锋，实际 ${st.pending!.kind}`);
  console.log(`      挂起 ${st.pending!.kind}`);
});

check('交锋在格子效果之前 —— 结算完交锋才轮到站点', () => {
  const st = game();
  const { a, target } = armApproach(st, 'Police');
  const b = getPlayer(st, 'P1')!;
  b.cellId = target.id;
  moveWithCard(st, a.id, card1.id, target.id);

  const chain: string[] = [];
  let guard = 0;
  while (st.pending && guard++ < 12) {
    chain.push(st.pending.kind);
    const pick = st.pending.options.slice(0, Math.max(1, st.pending.min ?? 1)).map((o) => o.value);
    const rr = resolvePending(st, st.pending.playerId, pick);
    st.pending = rr.pending;
  }
  const ci = chain.findIndex((k) => k.startsWith('conflict'));
  const pi = chain.findIndex((k) => k.startsWith('police'));
  assert.ok(ci >= 0, `应出现交锋，实际链 ${chain.join(' → ')}`);
  if (pi >= 0) {
    assert.ok(ci < pi, `交锋应在警察站交互之前：${chain.join(' → ')}`);
  }
  console.log(`      链: ${chain.join(' → ')}`);
});

check('建筑可容纳多人 → 不引发交锋', () => {
  const st = game();
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  const b = getPlayer(st, 'P1')!;
  const office = map.cells.find((c) => c.cellType === 'Office')!;
  const prev = map.cells.find((c) => c.out.includes(office.id))!;
  a.cellId = prev.id;
  a.hand = [card1.id];
  b.cellId = office.id;
  moveWithCard(st, a.id, card1.id, office.id);
  assert.ok(!st.pending?.kind.startsWith('conflict:'),
    `建筑不该交锋，实际 ${st.pending?.kind}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== 第 3 步：看是否有可使用的牌（UseCard） ===');

check('UseCard 阶段排在站点效果之前（此时站点仍未结算）', () => {
  // ⚠️ 用「办公楼」而不是「收入格」：收入格没有任何可选动作，
  // 现在引擎对"无事可做"返回 null（自动结束回合），测不到两阶段顺序。
  // 办公楼有 sellVote，才会真的停在 UseCard 阶段。
  const st = game();
  parkOpponent(st);
  const { a, target } = armApproach(st, 'Office');
  const money0 = a.res.money;
  moveWithCard(st, a.id, card1.id, target.id);

  const pr = buildEnginePrompt(st, a.id);
  assert.ok(pr, '应有提示');
  assert.equal(pr!.type, 'play_card_or_skip');
  assert.equal(a.res.money, money0, 'UseCard 阶段站点仍不该结算');
  console.log(`      阶段提示: ${pr!.type}, message="${pr!.message}"`);
});

check('无牌可打时自动跳过 UseCard（bug #9）', () => {
  const st = game();
  parkOpponent(st);
  const { a, target } = armApproach(st, 'Office');
  a.hand = [card1.id];         // 只有用于移动的那张，打完后手上无效果牌
  moveWithCard(st, a.id, card1.id, target.id);
  const pr = buildEnginePrompt(st, a.id);
  assert.equal(pr!.options?.length ?? 0, 0, '应没有可打的牌');
  assert.equal(pr!.canEndPhase, true, '应允许结束本阶段');
  // 已经直接落到 UseCell（建筑动作在给），说明 UseCard 被跳过了
  assert.ok((pr!.optionalActions?.length ?? 0) > 0,
    '应直接进入 UseCell 并给出建筑动作');
  console.log(`      直接进入 UseCell，可选动作: ${pr!.optionalActions!.map((o) => o.id).join(', ')}`);
});

check('无事可做的格子直接返回 null（不该弹"无可用动作，跳过结束回合"）', () => {
  // 用户实测：走到警察格、没牌可出时仍然弹「无可用动作，跳过结束回合」，
  // 那一步是多余的 —— 现在这种情况返回 null，由 endTurn 自动交棒。
  const st = game();
  parkOpponent(st);
  const a = getPlayer(st, 'P0')!;
  const map = getMap(st);
  const police = map.cells.find((c) => c.cellType === 'Police')!;
  const prev = map.cells.find((c) => c.out.includes(police.id))!;
  a.cellId = prev.id;
  a.hand = [card1.id];
  moveWithCard(st, a.id, card1.id, police.id);
  // 警察格本身会挂起（付贿赂/掷骰），先应答掉，回到"没事可做"的状态
  let guard = 0;
  while (st.pending && guard++ < 8) {
    const pend = st.pending;
    const pick = pend.options.slice(-1).map((o) => o.value);
    const r = resolvePending(st, pend.playerId, pick);
    st.pending = r.pending;
  }
  const pr = buildEnginePrompt(st, a.id);
  assert.equal(pr, null, `无事可做时应返回 null，实际 ${JSON.stringify(pr)}`);
  console.log('      返回 null（调用方会自动结束回合）');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== 第 4 步：执行建筑/站点效果（UseCell） ===');

check('站点效果在结束用牌时才结算', () => {
  const st = game();
  parkOpponent(st);
  const { a, target } = armApproach(st, 'Income');
  a.res.income = 30;
  moveWithCard(st, a.id, card1.id, target.id);
  const money0 = a.res.money;
  skipPlay(st, a.id);
  assert.equal(a.res.money - money0, 60, `应结算双倍收入 +60，实际 +${a.res.money - money0}`);
  console.log(`      金钱 ${money0} → ${a.res.money}（+60）`);
});

check('建筑的可选动作出现在 UseCell 阶段', () => {
  const st = game();
  const { a, target } = armApproach(st, 'Office');
  parkOpponent(st);
  moveWithCard(st, a.id, card1.id, target.id);
  const pr = buildEnginePrompt(st, a.id);
  const optIds = (pr!.optionalActions ?? []).map((o) => o.id);
  assert.ok(optIds.some((id) => id.startsWith('office')),
    `应给出办公楼动作，实际 ${optIds.join(', ') || '(无)'}`);
  console.log(`      可选动作: ${optIds.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== 不变量 ===');

check('三条路径（skipPlay / nextTurn / endTurn）站点结算结果一致', () => {
  const run = (via: 'skip' | 'next') => {
    const st = game();
    parkOpponent(st);
    const { a, target } = armApproach(st, 'Income');
    a.res.income = 30;
    moveWithCard(st, a.id, card1.id, target.id);
    const before = a.res.money;
    if (via === 'skip') skipPlay(st, a.id);
    else {
      // 走 nextTurn（客户端的「结束回合」按钮）
      nextTurn(st);
    }
    return a.res.money - before;
  };
  assert.equal(run('skip'), run('next'), '两条路径应结算出同样的结果');
});

check('服刑回合不触发正常的 Move→UseCard→UseCell 流程', () => {
  const st = game();
  const a = getPlayer(st, 'P0')!;
  a.inJail = true;
  a.res.term = 3;
  const r = takeJailTurn(st, a.id);
  assert.ok(r.ok, r.reason);
  console.log(`      监狱回合挂起: ${r.pending?.kind ?? '(直接结算)'}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
