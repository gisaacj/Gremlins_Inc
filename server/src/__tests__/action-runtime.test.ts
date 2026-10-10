// =============================================================
// 动作原语**执行**覆盖率测试
//
// 之前只验证过"143 个动作类型在引擎源码里被提到"（字符串层面）。
// 那不能说明它们**跑得通** —— 可能某个 case 一进去就抛异常，
// 或者只处理了部分参数形态。
//
// 本测试对每个动作类型：
//   1. 从真实卡牌数据里找出**实际用到它**的卡；
//   2. 把该卡放到它的使用地点、给足资源；
//   3. 真正执行一次（`playEffectCard`），必要时应答挂起；
//   4. 断言不抛异常、不产生"尚未实现"日志。
//
// 目的是把"提到了"升级成"能执行"。
//
// 运行: npx tsx server/src/__tests__/action-runtime.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CELL_TYPE_BY_ID, MISFORTUNE_CARDS, JAIL_CARDS, CHAOS_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, createState, drawMisfortune, getMap, getPlayer, playEffectCard, resolvePending,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

/** 收集：动作类型 → 使用它的卡牌 name 列表（来自全部牌堆） */
const usage = new Map<string, string[]>();
const note = (type: string, where: string) => {
  if (!usage.has(type)) usage.set(type, []);
  usage.get(type)!.push(where);
};
for (const c of ACTION_CARDS) for (const a of c.actions ?? []) note(String(a.type), `card:${c.name}`);
for (const c of MISFORTUNE_CARDS) for (const a of c.actions ?? []) note(String(a.type), `mf:${c.name}`);
for (const c of JAIL_CARDS) for (const a of c.actions ?? []) note(String(a.type), `jail:${c.name}`);
for (const c of CHAOS_CARDS) for (const a of c.actions ?? []) note(String(a.type), `chaos:${c.name}`);

console.log(`数据里出现的动作类型: ${usage.size}`);

/** 造一局"资源充足"的游戏，并把所有玩家塞到指定格子类型 */
function richGame(cellTypeId?: string): EngineState {
  const st = createState({
    roomId: 'rt', seed: 31337, targetScore: 999,
    players: ['Banker', 'Engineer', 'Gambler'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: true,
  });
  const map = getMap(st);
  for (const p of st.players) {
    p.res.money = 99999;
    p.res.vote = 999;
    p.res.score = 10;
    p.res.malice = 5;
    p.res.income = 5;
    p.hand = [];
    p.permanents = [];
    if (cellTypeId && cellTypeId !== '0') {
      const cell = map.cells.find((c) => c.cellTypeId === cellTypeId);
      if (cell) p.cellId = cell.id;
    }
  }
  st.currentIndex = 0;
  return st;
}

/** 应答所有挂起（每个挂起取第一个选项，尽量把流程推完） */
function drain(st: EngineState, guard = 40) {
  let g = 0;
  while (st.pending && g++ < guard) {
    const pd = st.pending;
    const pick = pd.options.slice(0, Math.max(1, pd.min ?? 1)).map((o) => o.value);
    if (!pick.length) { st.pending = undefined; break; }
    const r = resolvePending(st, pd.playerId, pick);
    if (!r.ok) break;
  }
}

console.log('\n=== 逐动作执行（用真实卡牌）===');
const failures: string[] = [];
let executed = 0;
let skipped = 0;

for (const [type, wheres] of [...usage.entries()].sort()) {
  // 优先用**行动卡**来执行（能通过 playEffectCard 走完整路径）
  const cardName = wheres.find((w) => w.startsWith('card:'))?.slice(5);
  const card = cardName ? ACTION_CARDS.find((c) => c.name === cardName) : undefined;
  if (!card) { skipped++; continue; }

  try {
    const st = richGame(card.cellTypeId);
    const p = getPlayer(st, 'P0')!;
    p.hand = [card.id];
    // 有些动作需要目标，先给一个有牌/有钱的对手
    for (const q of st.players.slice(1)) {
      q.hand = [ACTION_CARDS[0]!.id];
      q.permanents = ['x'];
    }
    const before = st.log.length;
    playEffectCard(st, p.id, card.id);
    drain(st);
    // 检查是否出现"尚未实现"
    const newLogs = st.log.slice(before).map((l) => l.text).join('\n');
    if (/尚未实现/.test(newLogs)) {
      failures.push(`${type}（${card.name}）：日志报告"尚未实现"`);
    }
    executed++;
  } catch (e) {
    failures.push(`${type}（${card.name}）：抛异常 ${(e as Error).message}`);
  }
}

check(`能执行的动作用例 ≥ ${Math.floor(usage.size * 0.7)} 个`, () => {
  console.log(`      执行 ${executed} 个，跳过 ${skipped} 个（无行动卡承载）`);
  assert.ok(executed >= Math.floor(usage.size * 0.7),
    `执行数偏少：${executed}/${usage.size}`);
});
check('没有任何动作在执行时抛异常或报告"尚未实现"', () => {
  assert.equal(failures.length, 0,
    `\n      ${failures.slice(0, 15).join('\n      ')}${failures.length > 15 ? `\n      …共 ${failures.length} 条` : ''}`);
});

console.log('\n=== 全卡牌冒烟：186 张各打一次 ===');
check('每张行动卡都能在其地点打出而不抛异常', () => {
  const bad: string[] = [];
  for (const card of ACTION_CARDS) {
    try {
      const st = richGame(card.cellTypeId);
      const p = getPlayer(st, 'P0')!;
      p.hand = [card.id];
      for (const q of st.players.slice(1)) { q.hand = [ACTION_CARDS[0]!.id]; q.permanents = ['x']; }
      playEffectCard(st, p.id, card.id);
      drain(st);
    } catch (e) {
      bad.push(`${card.name}：${(e as Error).message}`);
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      186 张全部执行完毕，无异常`);
});
check('每张厄运卡都能抽到并结算而不抛异常', () => {
  const bad: string[] = [];
  for (const card of MISFORTUNE_CARDS) {
    try {
      const st = richGame();
      // 把牌堆顶设成这张
      st.misfortuneDeck = [card.id];
      const p = getPlayer(st, 'P0')!;
      for (const q of st.players) { q.hand = [ACTION_CARDS[0]!.id]; q.permanents = ['x']; }
      // 通过"经过厄运格"触发抽牌
      const cell = getMap(st).cells.find((c) => c.cellType === 'Misfortune');
      if (cell) p.cellId = cell.id;
      // 直接调用抽牌路径（引擎内部给"经过厄运格"用的就是它）
      drawMisfortune(st, p);
      drain(st);
    } catch (e) {
      bad.push(`${card.name}：${(e as Error).message}`);
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      ${MISFORTUNE_CARDS.length} 张厄运卡全部结算完毕，无异常`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
