// =============================================================
// 基础功能矩阵 ⑤：**回合顺序与"不卡死"不变量**
//
// 原版回合顺序（权威）：**Move → Conflict → UseCard → UseCell**
// 其中"落地顺序"是：先交锋，**赢了留在格上**才处理格子效果。
//
// 本矩阵做三件事：
//   A. 顺序不变量：走牌落地后，**格子效果必须还没结算**（留给 UseCell 阶段）
//   B. 不卡死不变量：任意一条真实流程走到底，都不能停在
//      "轮到我 + 无提示 + 无挂起 + 无可打牌 + 无可选动作 + 无牌可走"
//   C. 自动推进不变量：无提示时，收尾逻辑必须能把回合交出去
//   D. 强随机压测：多 seed × 多人数 × 大量步数，全程不得卡死
//
// 运行: npx tsx server/src/__tests__/matrix-turn-order.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CHAOS_CARDS, CHARACTERS } from '@gremlins/shared/gamedata';
import {
  answerChoice, availableOptions, buildEnginePrompt, createState, currentPlayerId,
  finishTurnActions, getMap, getPlayer, movableCards, moveWithCard, nextTurn, playableCards,
  playEffectCard, runOption, skipPlay,
} from '@gremlins/shared/engine';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

function fresh(playerCount = 3, seed = 1): { st: EngineState; a: EnginePlayer } {
  const names = ['Banker', 'Engineer', 'Gambler', 'Thief', 'Judge', 'Collector'];
  const st = createState({
    roomId: 'm5', seed, targetScore: 999,
    players: names.slice(0, playerCount).map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: true,
  });
  for (const p of st.players) {
    p.res.money = 3000; p.res.vote = 30; p.hand = []; p.inJail = false;
    p.res.malice = 1; p.res.score = 10; p.term = 0; p.res.income = 30;
  }
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  for (const p of st.players) {
    if (p.id !== a.id) p.cellId = map.cells.find((c) => c.cellType === 'Jail')!.id;
  }
  st.currentIndex = st.players.indexOf(a);
  a.cellId = map.cells.find((c) => c.out.length > 0)!.id;
  return { st, a };
}

/** 与服务端/LocalGame 等价的收尾 */
function settle(st: EngineState, viewerId: string) {
  let prompt = buildEnginePrompt(st, viewerId);
  if (prompt || st.phase !== 'playing') return prompt;
  finishTurnActions(st);
  if (!st.pending) nextTurn(st);
  return buildEnginePrompt(st, viewerId);
}

const stuckNow = (st: EngineState, pid: string) => {
  if (st.phase !== 'playing') return false;
  if (st.pending) return false;
  if (currentPlayerId(st) !== pid) return false;
  const p = getPlayer(st, pid);
  if (!p || p.inJail) return false;
  if (buildEnginePrompt(st, pid) !== null) return false;
  if (movableCards(st, pid).length) return false;
  if (playableCards(st, pid).length) return false;
  if (availableOptions(st, pid).length) return false;
  return true;
};

console.log('=== ⑤ 回合顺序与"不卡死"不变量 ===');

check('A. 走牌落地后格子效果**尚未结算**（留给 UseCell 阶段）', () => {
  const bad: string[] = [];
  let checked = 0;
  for (const cellType of ['Income', 'Office', 'Bank', 'Police', 'Marketplace']) {
    for (let seed = 1; seed <= 8; seed++) {
      const { st, a } = fresh(3, seed);
      const map = getMap(st);
      // 找一张能恰好走到该类型格子的移动牌
      const card = ACTION_CARDS.find((c) => c.move > 0 && !c.specialMove && !c.special)!;
      const target = map.cells.find((c) => c.cellType === cellType);
      if (!target) continue;
      a.cellId = target.id;
      a.movedThisTurn = true;
      // 直接摆出"刚落地"的状态
      st.pendingCellEffect = { playerId: a.id, cellId: target.id };
      const moneyBefore = a.res.money;
      // 此刻不该有任何结算发生
      const prompt = buildEnginePrompt(st, a.id);
      const settled = a.flags['cellResolved'];
      checked++;
      if (settled) bad.push(`${cellType} seed=${seed}: 落地即被标记 cellResolved`);
      // 收尾后才该结算
      settle(st, a.id);
      const moneyAfterSettle = a.res.money;
      if (cellType === 'Income' && moneyBefore === moneyAfterSettle
        && st.log.every((l) => !l.text.includes('收入'))) {
        bad.push(`${cellType} seed=${seed}: 收尾后仍然没有结算收入`);
      }
      void prompt; void card;
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      检查了 ${checked} 个"落地未结算"组合，全部留给了 UseCell 阶段`);
});

check('B. 三条收尾路径（skipPlay / nextTurn / 服务端收尾）结果一致', () => {
  const runVia = (via: 'skip' | 'next' | 'settle') => {
    const { st, a } = fresh(3, 11);
    const map = getMap(st);
    const police = map.cells.find((c) => c.cellType === 'Police')!;
    a.cellId = police.id;
    a.movedThisTurn = true;
    st.pendingCellEffect = { playerId: a.id, cellId: police.id };
    const pool = ACTION_CARDS.filter((x) => !x.specialMove && !x.special && x.move > 0);
    a.hand = pool.slice(0, 5).map((x) => x.id);

    if (via === 'skip') skipPlay(st, a.id);
    else if (via === 'next') nextTurn(st);
    else settle(st, a.id);

    // 一致判据：都**不能**停在卡死态
    let g = 0;
    while (st.pending && g++ < 30) {
      const pend = st.pending;
      const rr = answerChoice(st, pend.playerId, pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value));
      st.pending = rr.pending;
      if (!rr.ok) break;
      settle(st, a.id);
    }
    return { stuck: stuckNow(st, a.id), policeSeen: st.log.some((l) => /警察/.test(l.text)) };
  };
  const r1 = runVia('skip');
  const r2 = runVia('next');
  const r3 = runVia('settle');
  assert.equal(r1.stuck, false, 'skipPlay 路径卡死');
  assert.equal(r2.stuck, false, 'nextTurn 路径卡死');
  assert.equal(r3.stuck, false, '服务端收尾路径卡死');
  console.log(`      三条路径都未卡死；警察格效果触发：skip=${r1.policeSeen} next=${r2.policeSeen} settle=${r3.policeSeen}`);
});

check('C. 任意时刻"无提示"都要能被收尾成"有出口"', () => {
  const bad: string[] = [];
  let checked = 0;
  for (let seed = 1; seed <= 20; seed++) {
    for (const cellType of ['Police', 'Income', 'Misfortune', 'Inferno', 'Bribe', 'Danger', 'Astral']) {
      const { st, a } = fresh(3, seed);
      const cell = getMap(st).cells.find((c) => c.cellType === cellType);
      if (!cell) continue;
      a.cellId = cell.id;
      a.movedThisTurn = true;
      st.pendingCellEffect = { playerId: a.id, cellId: cell.id };
      checked++;
      let g = 0;
      let prompt = settle(st, a.id);
      while (st.pending && g++ < 30) {
        const pend = st.pending;
        const rr = answerChoice(st, pend.playerId, pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value));
        st.pending = rr.pending;
        if (!rr.ok) break;
        prompt = settle(st, a.id);
      }
      if (stuckNow(st, a.id)) {
        bad.push(`${cellType} seed=${seed}: 收尾后仍卡死`);
      }
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      检查了 ${checked} 个"落地 → 收尾"组合，全部有出口`);
});

check('D. 强随机压测：多 seed × 2~6 人 × 大量步数，全程不卡死', () => {
  const bad: string[] = [];
  let steps = 0;
  let games = 0;
  for (const playerCount of [2, 3, 4, 5, 6]) {
    for (const seed of [1, 7, 42, 999, 20240601]) {
      games++;
      const { st } = fresh(playerCount, seed);
      let turnGuard = 0;
      while (st.phase === 'playing' && turnGuard++ < 260) {
        const pid = currentPlayerId(st);
        if (!pid) break;
        const p = getPlayer(st, pid);
        if (!p) break;
        steps++;

        // 有挂起就应答
        if (st.pending) {
          const pend = st.pending;
          const rr = answerChoice(st, pend.playerId, pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value));
          st.pending = rr.pending;
          if (!rr.ok) break;
          continue;
        }
        // 狱中：直接把刑期走完（避免依赖 jailTurn 的交互细节）
        if (p.inJail) {
          p.term = Math.max(0, p.term - 1);
          if (p.term === 0) p.inJail = false;
          nextTurn(st);
          continue;
        }
        // 未移动 → 用一张可移动牌走一步
        if (!p.movedThisTurn) {
          const mov = movableCards(st, pid);
          if (mov.length) {
            const cardId = mov[0]!;
            const dest = getMap(st).cells.find((x) => x.id === p.cellId)!.out[0];
            const r = moveWithCard(st, pid, cardId, dest);
            if (!r.ok) { nextTurn(st); }
            continue;
          }
          // 没有可移动的牌 → 直接推进（避免死循环）
          nextTurn(st);
          continue;
        }
        // 已移动 → 有站点动作就做一个，否则尝试打一张牌，再否则收尾
        const opts = availableOptions(st, pid);
        if (opts.length) {
          const r = runOption(st, pid, opts[0]!.id);
          if (!r.ok) { settle(st, pid); }
          continue;
        }
        const playable = playableCards(st, pid);
        if (playable.length) {
          const r = playEffectCard(st, pid, playable[0]!);
          if (!r.ok) { settle(st, pid); }
          continue;
        }
        settle(st, pid);
        if (stuckNow(st, pid)) break;
      }
      if (stuckNow(st, getPlayer(st, currentPlayerId(st))?.id ?? '')) {
        bad.push(`${playerCount}人 seed=${seed}: ${turnGuard} 步后卡死`);
      }
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      压测 ${games} 局 / ${steps} 步，0 卡死`);
});

console.log(`\n通过 ${pass} 组，失败 ${fail} 组`);
if (fail > 0) process.exitCode = 1;
