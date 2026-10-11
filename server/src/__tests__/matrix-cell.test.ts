// =============================================================
// 基础功能矩阵 ②：**每个站点/格子走上去都能触发效果，且不卡死**
//
// 与"按 bug 写用例"不同：这里**穷举棋盘上全部 67 个格子**（覆盖所有格子类型），
// 逐个模拟"走上去 → 一路应答 → 必须能继续"。
//
// 对每个格子检查：
//   A. 格子元数据自洽：`cellType` 能在 `CELL_TYPE_BY_NAME` 里找到
//   B. 走上去之后：要么**产生了效果**（日志/资源变化/挂起），要么明确是"无事发生"格
//   C. 每个格子类型**至少有一次**产生了可见效果（防止整类格子静默失效）
//   D. 一路应答到底后**不会卡死**（有提示 / 有挂起 / 已交棒 / 还有可做的动作）
//
// 运行: npx tsx server/src/__tests__/matrix-cell.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  CELL_TYPE_BY_NAME, CHARACTERS, ACTION_CARDS,
} from '@gremlins/shared/gamedata';
import {
  answerChoice, availableOptions, buildEnginePrompt, createState, finishTurnActions, getMap,
  getPlayer, movableCards, nextTurn, playableCards,
} from '@gremlins/shared/engine';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function fresh(seed = 1, money = 1000, handSize = 6): { st: EngineState; a: EnginePlayer } {
  const st = createState({
    roomId: 'm2', seed, targetScore: 999,
    players: ['Banker', 'Engineer', 'Gambler'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = money; p.res.vote = 20; p.hand = []; p.inJail = false;
    p.res.malice = 1; p.res.score = 10; p.term = 0; p.res.income = 30;
  }
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  for (const id of ['P1', 'P2']) getPlayer(st, id)!.cellId = map.cells.find((c) => c.cellType === 'Jail')!.id;
  st.currentIndex = st.players.indexOf(a);
  const pool = ACTION_CARDS.filter((c) => !c.specialMove && !c.special && c.move > 0);
  while (a.hand.length < handSize) a.hand.push(pool[a.hand.length % pool.length]!.id);
  return { st, a };
}

function settle(st: EngineState, viewerId: string) {
  let prompt = buildEnginePrompt(st, viewerId);
  if (prompt || st.phase !== 'playing') return prompt;
  finishTurnActions(st);
  if (!st.pending) nextTurn(st);
  return buildEnginePrompt(st, viewerId);
}

/** 把玩家放到某格并登记"欠着的格子效果"（等价于刚落地的状态） */
function landOn(st: EngineState, a: EnginePlayer, cellId: string) {
  a.cellId = cellId;
  a.movedThisTurn = true;
  st.pendingCellEffect = { playerId: a.id, cellId };
}

/** 一路应答到底；返回 { 提示, 挂起链, 资源快照 } */
function drain(st: EngineState, pid: string) {
  const chain: string[] = [];
  let prompt = settle(st, pid);
  let g = 0;
  while (st.pending && g++ < 40) {
    chain.push(st.pending.kind);
    const pend = st.pending;
    const rr = answerChoice(st, pend.playerId, pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value));
    st.pending = rr.pending;
    if (!rr.ok) { chain.push(`ERR:${rr.error}`); break; }
    prompt = settle(st, pid);
  }
  return { prompt, chain };
}

const probe = (a: EnginePlayer) => JSON.stringify({
  m: a.res.money, v: a.res.vote, s: a.res.score, e: a.res.malice,
  t: a.term, i: a.res.income, h: a.hand.length, p: a.permanents.length,
  jail: a.inJail, cell: a.cellId, turns: a.extraTurns,
});

console.log('=== ② 每个格子走上去都能触发（穷举全部格子）===');

const base = (() => {
  const { st } = fresh();
  return getMap(st);
})();
const allCells = base.cells;
const types = [...new Set(allCells.map((c) => c.cellType))];

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

check(`A. 全部 ${allCells.length} 个格子的 cellType 都能在类型表里找到`, () => {
  const bad: string[] = [];
  for (const c of allCells) {
    if (!CELL_TYPE_BY_NAME[c.cellType]) bad.push(`${c.id}(${c.cellType})`);
  }
  assert.equal(bad.length, 0, `未知格子类型：${bad.slice(0, 10).join(', ')}`);
  console.log(`      ${allCells.length} 个格子，${types.length} 种类型`);
});

// 逐格：必须不卡死；并记录"落地时到底发生了什么"
const perCell: Array<{
  id: string; type: string; changed: boolean; stuck: boolean; chain: string;
  offersAction: boolean; autoEffect: boolean;
}> = [];

check('B/D. 逐格落地 + 应答到底：不卡死，并记录落地行为', () => {
  const bad: string[] = [];
  for (const cell of allCells) {
    for (const [money, handSize] of [[1000, 6], [0, 0], [25, 2]] as const) {
      const { st, a } = fresh(3, money, handSize);
      landOn(st, a, cell.id);
      const before = probe(a);
      // 先看落地时**有没有挂起**（自动效果）以及**有没有可选动作**
      const chain: string[] = [];
      let prompt = settle(st, a.id);
      const offersAction = st.players[st.currentIndex]!.id === a.id
        && availableOptions(st, a.id).length > 0;
      let g = 0;
      while (st.pending && g++ < 40) {
        chain.push(st.pending.kind);
        const pend = st.pending;
        const rr = answerChoice(st, pend.playerId, pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value));
        st.pending = rr.pending;
        if (!rr.ok) { chain.push(`ERR:${rr.error}`); break; }
        prompt = settle(st, a.id);
      }
      const after = probe(a);
      const changed = before !== after;
      const autoEffect = chain.length > 0 || changed;

      const mine = st.players[st.currentIndex]!.id === a.id;
      const stuck = !st.pending && prompt === null && mine && !a.inJail
        && movableCards(st, a.id).length === 0
        && playableCards(st, a.id).length === 0
        && availableOptions(st, a.id).length === 0;
      perCell.push({
        id: cell.id, type: String(cell.cellType), changed, stuck,
        chain: chain.join('>'), offersAction, autoEffect,
      });
      if (stuck) {
        bad.push(`格子 ${cell.id}(${cell.cellType}) $${money}手牌${handSize}`
          + ` 链=${chain.join('>') || '(空)'} cellResolved=${a.flags['cellResolved']}`);
      }
    }
  }
  assert.equal(bad.length, 0,
    `这些格子走上去会卡死（${bad.length} 例）：\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      检查了 ${perCell.length} 个（格子×金钱×手牌）组合，0 卡死`);
});

check('C. 每种格子类型：要么自动产生效果，要么给出可选动作（不能两者都没有）', () => {
  // 站点的设计就是分两类：
  //   - 自动效果型：落地即结算（收入 +|、贿赂 -$、厄运抽牌、警察问话、地狱、监狱…）
  //   - 可选动作型：落地后**给玩家按钮**（银行投资、市场卖齿轮、法院…）
  // 两类都不满足才是"静默失效"。
  const silent: string[] = [];
  for (const t of types) {
    const hits = perCell.filter((p) => p.type === t);
    const ok = hits.some((h) => h.autoEffect || h.offersAction);
    if (!ok) silent.push(t);
  }
  assert.equal(silent.length, 0,
    `这些格子类型既无自动效果、也不给可选动作，疑似静默失效：${silent.join(', ')}`);
  const auto = types.filter((t) => perCell.filter((p) => p.type === t).some((h) => h.autoEffect));
  const opt = types.filter((t) => perCell.filter((p) => p.type === t).some((h) => h.offersAction));
  console.log(`      自动效果型 ${auto.length} 种：${auto.join(', ')}`);
  console.log(`      可选动作型 ${opt.length} 种：${opt.join(', ')}`);
});

check('C2. 落地行为的完整清单（可读性检查）', () => {
  for (const t of types) {
    const h = perCell.find((p) => p.type === t)!;
    const tags = [
      h.autoEffect ? '自动效果' : '',
      h.offersAction ? '可选动作' : '',
    ].filter(Boolean).join(' + ') || '（无）';
    console.log(`      ${t.padEnd(14)} ${tags}${h.chain ? `  挂起=${h.chain}` : ''}`);
  }
});

console.log(`\n通过 ${pass} 组，失败 ${fail} 组（覆盖 ${allCells.length} 个格子 / ${types.length} 种类型）`);
if (fail > 0) process.exitCode = 1;
