// =============================================================
// 「举一反三」的系统性不变量测试
//
// 前五批 bug 暴露出的**问题类别**（不是单张卡的问题）：
//
//  A. 幽灵选项 —— `availableOptions` 产出的 optionId 在 `doOption` 里
//     没有处理分支。玩家点了没反应，回合也推进不了，面板反复弹出。
//     （第 21 轮：danger.insure）
//
//  B. 参数被忽略 —— 动作带了"限制范围"的参数，实现却无视它，
//     退化成"所有格子 / 所有玩家"。
//     （第 22 轮：Teleport 的十六进制 UIN 解析失败 → 67 个地点；
//       RandomTeleport 完全无视参数；a179 的 `All` 选不到自己）
//
//  C. 位置/资源被写成非法值 —— 把"类型 id"当"实例 id"用。
//     （第 22 轮：OpponentTeleport 把 cellId 写成 cellType key）
//
// 本文件把这三类做成**自动遍历**的不变量，而不是逐个手查。
//
// 运行: npx tsx server/src/__tests__/invariants.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CHAOS_CARDS, JAIL_CARDS, MISFORTUNE_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, availableOptions, buildEnginePrompt, createState, doOption, endTurn,
  getMap, getPlayer, playCard, runAIPlayers, answerChoice, teleportTargetCells,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(names = ['Banker', 'Engineer', 'Gambler']): EngineState {
  const st: EngineState = createState({
    roomId: 'inv', seed: 11, targetScore: 999,
    players: names.map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = 5000; p.res.vote = 10; p.hand = []; p.inJail = false; p.res.malice = 1;
  }
  // 把 1、2 号玩家丢进监狱，避免意外交锋干扰
  const jail = getMap(st).cells.find((c) => c.cellType === 'Jail');
  if (jail) for (const p of st.players.slice(1)) p.cellId = jail.id;
  st.currentIndex = st.players.indexOf(getPlayer(st, 'P0')!);
  return st;
}

const MAP = getMap(game());
const ids = new Set(MAP.cells.map((c) => c.id));
const allCards = [...ACTION_CARDS, ...CHAOS_CARDS, ...MISFORTUNE_CARDS, ...JAIL_CARDS];

// ─────────────────────────────────────────────────────────────
console.log('=== A. 不存在「幽灵选项」：每个 optionId 都有 doOption 分支 ===');

check('遍历全图所有格子的所有可选动作，没有"点了没反应"的', () => {
  const ghosts: string[] = [];
  for (const cell of MAP.cells) {
    const st = game();
    const a = getPlayer(st, 'P0')!;
    a.cellId = cell.id;
    a.movedThisTurn = true;
    a.hand = [];
    // 给两种角色能力都试一遍（有些动作来自能力）
    for (const charName of ['Banker', 'Collector', 'Politician', 'Engineer']) {
      const st2 = game(['Banker', 'Engineer', 'Gambler']);
      const p = getPlayer(st2, 'P0')!;
      p.characterId = charOf(charName);
      p.cellId = cell.id;
      p.movedThisTurn = true;
      p.hand = [];
      p.res.vote = 10;
      for (const o of availableOptions(st2, p.id)) {
        if (o.affordable === false) continue;
        const before = JSON.stringify({ i: st2.currentIndex, f: p.flags, m: p.res.money });
        const r = doOption(st2, p.id, o.id);
        const after = JSON.stringify({ i: st2.currentIndex, f: p.flags, m: p.res.money });
        const needsTarget = (r as { needsTarget?: unknown }).needsTarget;
        // needsTarget 是正常流程；pending 也算有反应
        if (r.ok && !needsTarget && !st2.pending && before === after) {
          ghosts.push(`${cell.cellType}(${charName}):${o.id}`);
        }
      }
    }
  }
  assert.equal(ghosts.length, 0,
    `幽灵选项：${[...new Set(ghosts)].slice(0, 8).join(', ')}`);
  console.log('      遍历完毕，无幽灵选项');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== B. 参数被尊重：限制范围的动作不能退化成"全部" ===');

check('所有传送参数的格子类型都能解析到真实格子', () => {
  const st = game();
  const problems: string[] = [];
  for (const c of allCards) {
    for (const act of c.actions ?? []) {
      const t = String(act.type);
      if (!/^(Teleport|OpponentTeleport|RandomTeleport)$/.test(t)) continue;
      for (const raw of act.params ?? []) {
        if (!raw || /^(All|Card|Opponent|None)$/i.test(raw)) continue;
        if (teleportTargetCells(st, [raw]).length === 0) {
          problems.push(`${c.name}(${t}) 参数 ${raw}`);
        }
      }
    }
  }
  assert.equal(problems.length, 0, `无法解析：${problems.slice(0, 6).join('; ')}`);
  console.log('      全部可解析');
});

check('a024「翻筋斗」的目的地只有赌博站点（不会退化成全图）', () => {
  const st = game();
  const a = getPlayer(st, 'P0')!;
  a.cellId = MAP.cells.find((c) => c.cellType === 'Risk')!.id;
  a.hand = [ACTION_CARDS.find((c) => c.name === 'a024')!.id];
  const card = ACTION_CARDS.find((c) => c.name === 'a024')!;
  playCard(st, a.id, card.id);
  const opts = st.pending?.options ?? [];
  const types = new Set(opts.map((o) => MAP.cells.find((c) => c.id === o.value)?.cellType));
  assert.deepEqual([...types], ['Risk'], `只该有 Risk，实际 ${[...types].join(',')}`);
  assert.ok(opts.length < MAP.cells.length, `不该退化成全图（${opts.length}/${MAP.cells.length}）`);
  console.log(`      ${opts.length} 个目的地，全是 Risk（全图共 ${MAP.cells.length} 格）`);
});

check('a179「昂贵的订单」的候选**包含自己**（参数 All）', () => {
  const st = game();
  const a = getPlayer(st, 'P0')!;
  a.cellId = MAP.cells.find((c) => c.cellType === 'Marketplace')!.id;
  const card = ACTION_CARDS.find((c) => c.name === 'a179')!;
  a.hand = [card.id];
  const r = playCard(st, a.id, card.id);
  assert.ok(r.ok, `应能打出：${r.error}`);
  const pr = buildEnginePrompt(st, a.id)!;
  assert.ok((pr.choices ?? []).some((c) => c.value === a.id),
    `候选应含自己，实际 ${(pr.choices ?? []).map((c) => c.value).join(',')}`);
  console.log(`      ${pr.message} → ${(pr.choices ?? []).length} 个候选（含自己）`);
});

check('只带"任意其他玩家"的卡**不**包含自己（不能放宽）', () => {
  // 找一张 SelectOpponent 且参数里**没有** `All` 的卡（即"任意其他玩家"）
  const card = ACTION_CARDS.find((c) => {
    const sel = (c.actions ?? []).filter((a) => String(a.type) === 'SelectOpponent');
    if (!sel.length) return false;
    return sel.every((a) => !(a.params ?? []).includes('All'));
  });
  assert.ok(card, '应能找出一张"任意其他玩家"的卡');
  const st = game();
  const a = getPlayer(st, 'P0')!;
  // 遍历棋盘，找到能打出这张牌的格子
  for (const cell of MAP.cells) {
    a.cellId = cell.id;
    a.hand = [card!.id];
    a.movedThisTurn = false;
    a.cardsPlayedThisTurn = 0;
    (st as { pending?: unknown }).pending = undefined;
    const r = playCard(st, a.id, card!.id);
    if (!r.ok || !st.pending) continue;
    const pr = buildEnginePrompt(st, a.id)!;
    assert.ok(!(pr.choices ?? []).some((c) => c.value === a.id),
      `${card!.name} 是"任意其他玩家"，不该能选自己`);
    console.log(`      ${card!.name}「${card!.text.name}」候选不含自己（${(pr.choices ?? []).length} 人）`);
    return;
  }
  console.log(`      （${card!.name} 在棋盘上没有可打出位置，跳过）`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== C. 位置永远是合法格 id ===');

check('长时间对局（多角色 + 混沌）中位置始终合法', () => {
  let total = 0;
  for (const seed of [1, 7, 42, 44444, 20240601, 999, 31337]) {
    const st = createState({
      roomId: 'inv2', seed, targetScore: 20,
      players: ['Banker', 'Damned', 'Engineer', 'Collector'].map((nm, i) => ({
        id: `P${i}`, name: `P${i}`, isAI: true, characterId: charOf(nm),
      })),
      chaosEnabled: true,
    });
    const valid = new Set(getMap(st).cells.map((c) => c.id));
    let steps = 0;
    while (st.phase === 'playing' && steps++ < 2500) {
      runAIPlayers(st, 4);
      if (st.pending) {
        const pend = st.pending;
        const r = answerChoice(st, pend.playerId,
          pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value));
        st.pending = r.pending;
      }
      for (const p of st.players) {
        assert.ok(valid.has(p.cellId),
          `seed=${seed} 第 ${steps} 步：${p.name} 位置非法 (${p.cellId})`);
      }
    }
    total += steps;
  }
  console.log(`      7 个 seed 共 ${total} 步，位置始终合法`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== D. 界面提示与引擎的合法集合一致 ===');

check('凡带 placeOptions 的提示，其 choices 必须与之一致', () => {
  // 界面只允许点 placeOptions 里的地点；若两者不一致，
  // 会出现"高亮了却点不动"或"能点但引擎不认"。
  const st = game();
  const a = getPlayer(st, 'P0')!;
  a.cellId = MAP.cells.find((c) => c.cellType === 'Risk')!.id;
  const card = ACTION_CARDS.find((c) => c.name === 'a024')!;
  a.hand = [card.id];
  playCard(st, a.id, card.id);
  const pr = buildEnginePrompt(st, a.id)!;
  assert.ok(pr.placeOptions?.length, '应有 placeOptions');
  const choiceValues = new Set((pr.choices ?? []).map((c) => c.value));
  for (const p of pr.placeOptions!) {
    assert.ok(choiceValues.has(p), `placeOptions 里的 ${p} 必须在 choices 里`);
  }
  console.log(`      placeOptions=${pr.placeOptions!.length}，与 choices 一致`);
});

check('placeOptions 里的每个地点都是真实格 id（界面能高亮）', () => {
  const st = game();
  const a = getPlayer(st, 'P0')!;
  a.cellId = MAP.cells.find((c) => c.cellType === 'Risk')!.id;
  const card = ACTION_CARDS.find((c) => c.name === 'a024')!;
  a.hand = [card.id];
  playCard(st, a.id, card.id);
  const pr = buildEnginePrompt(st, a.id)!;
  for (const p of pr.placeOptions!) {
    assert.ok(ids.has(p), `不是真实格 id：${p}`);
  }
  console.log('      全部是真实格 id');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
