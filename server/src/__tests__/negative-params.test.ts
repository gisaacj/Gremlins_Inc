// =============================================================
// 负参数约定测试（`OpponentLoseXxx(-N)` / `AddTurn(-1)` 表示"获得/减少"）
//
// 原版卡牌数据用**负参数**表达反方向效果：
//   `OpponentLoseMoney(-20)`   → 目标 **+20$**（不是"失去 -20"）
//   `OpponentLoseMalice(-1)`   → 目标 **+1^**
//   `OpponentLoseVotes(-1)`    → 目标 **+1&**
//   `OpponentLoseScore(-1)`    → 目标 **+1***
//   `AddTurn(-1)`              → **减少** 1 次额外走牌
//
// 这是很容易写错的一类：旧实现里
//   - `OpponentLose*` 写成 `if (amount > 0)`，负值被**静默丢弃**；
//   - `AddTurn` 写死 `+= 1`，`-1` 反而变成 **+1**（方向反了）。
//
// 全量审计：卡牌数据里共 **24 处**负参数，涉及 8 种动作。
//
// 运行: npx tsx server/src/__tests__/negative-params.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHARACTERS, createState, getPlayer, runActions,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(): { st: EngineState; p: ReturnType<typeof getPlayer> } {
  const st = createState({
    roomId: 'neg', seed: 11, targetScore: 30,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
  const p = getPlayer(st, 'p0')!;
  st.currentIndex = st.players.indexOf(p);
  return { st, p };
}

/** 直接跑一段动作（目标为自己），返回玩家资源快照 */
function run(actions: Array<{ type: string; params?: string[] }>) {
  const { st, p } = game();
  p!.res.money = 100;
  p!.res.vote = 10;
  p!.res.malice = 10;
  p!.res.score = 10;
  const before = { ...p!.res, extra: p!.extraTurns };
  const r = runActions(st, {
    actions: actions as never,
    index: 0,
    targets: [p!.id],
    ownerId: p!.id,
    source: 'test',
  });
  return { st, p: p!, before, r };
}

console.log('=== 1. OpponentLose* 的负参数 = 获得 ===');
check('OpponentLoseMoney(-20) → +20$', () => {
  const { p, before } = run([{ type: 'OpponentLoseMoney', params: ['-20'] }]);
  assert.equal(p.res.money, before.money + 20, `实际 ${before.money} → ${p.res.money}`);
  console.log(`      金钱 ${before.money} → ${p.res.money}`);
});
check('OpponentLoseMalice(-1) → +1^', () => {
  const { p, before } = run([{ type: 'OpponentLoseMalice', params: ['-1'] }]);
  assert.equal(p.res.malice, before.malice + 1);
  console.log(`      罪恶 ${before.malice} → ${p.res.malice}`);
});
check('OpponentLoseVotes(-1) → +1&', () => {
  const { p, before } = run([{ type: 'OpponentLoseVotes', params: ['-1'] }]);
  assert.equal(p.res.vote, before.vote + 1);
  console.log(`      选票 ${before.vote} → ${p.res.vote}`);
});
check('OpponentLoseScore(-1) → +1*', () => {
  const { p, before } = run([{ type: 'OpponentLoseScore', params: ['-1'] }]);
  assert.equal(p.res.score, before.score + 1);
  console.log(`      齿轮 ${before.score} → ${p.res.score}`);
});

console.log('\n=== 2. 正参数仍是"失去" ===');
check('OpponentLoseMoney(20) → -20$', () => {
  const { p, before } = run([{ type: 'OpponentLoseMoney', params: ['20'] }]);
  assert.equal(p.res.money, before.money - 20);
});
check('OpponentLoseMalice(3) → -3^', () => {
  const { p, before } = run([{ type: 'OpponentLoseMalice', params: ['3'] }]);
  assert.equal(p.res.malice, before.malice - 3);
});
check('OpponentLoseVotes(4) → -4&', () => {
  const { p, before } = run([{ type: 'OpponentLoseVotes', params: ['4'] }]);
  assert.equal(p.res.vote, before.vote - 4);
});

console.log('\n=== 3. AddTurn 的负参数 = 减少（旧实现写死 +1）===');
check('AddTurn(-1) → extraTurns 不增反减（下限 0）', () => {
  const { st, p } = game();
  p!.extraTurns = 2;
  const before = p!.extraTurns;
  runActions(st, {
    actions: [{ type: 'AddTurn', params: ['-1'] }] as never,
    index: 0, targets: [p!.id], ownerId: p!.id, source: 'test',
  });
  assert.equal(p!.extraTurns, before - 1, `实际 ${before} → ${p!.extraTurns}`);
  console.log(`      extraTurns ${before} → ${p!.extraTurns}`);
});
check('AddTurn(1) → +1', () => {
  const { p, before } = run([{ type: 'AddTurn', params: ['1'] }]);
  assert.equal(p.extraTurns, before.extra + 1);
});
check('AddTurn 无参数时默认 +1（兼容旧数据）', () => {
  const { p, before } = run([{ type: 'AddTurn', params: [''] }]);
  assert.equal(p.extraTurns, before.extra + 1);
});
check('extraTurns 不会被减成负数', () => {
  const { st, p } = game();
  p!.extraTurns = 0;
  runActions(st, {
    actions: [{ type: 'AddTurn', params: ['-1'] }] as never,
    index: 0, targets: [p!.id], ownerId: p!.id, source: 'test',
  });
  assert.equal(p!.extraTurns, 0, `实际 ${p!.extraTurns}`);
});

console.log('\n=== 4. 数据侧：负参数确实存在（防止数据被改掉）===');
check('卡牌数据里至少有 20 处负参数', () => {
  const files = ['action_cards', 'misfortune_cards', 'jail_cards', 'chaos_cards', 'characters'];
  let n = 0;
  for (const f of files) {
    let raw: Array<{ ActionList?: Array<{ ActionParams?: string[] }> }>;
    try {
      raw = JSON.parse(readFileSync(resolve(ROOT, `test/data/${f}.json`), 'utf8'));
    } catch { continue; }   // test/data 不在仓库里时跳过
    for (const c of raw) {
      for (const a of c.ActionList ?? []) {
        if ((a.ActionParams ?? []).some((x) => /^-\d+$/.test(String(x)))) n++;
      }
    }
  }
  if (n === 0) {
    console.log('      （test/data 不在仓库里，跳过数据侧校验）');
    return;
  }
  assert.ok(n >= 20, `负参数只找到 ${n} 处，预期 ≥20`);
  console.log(`      找到 ${n} 处负参数`);
});

console.log('\n=== 5. 不变量 ===');
check('负参数造成的资源变化不会使其为负', () => {
  for (const [type, v] of [['OpponentLoseMoney', '-9999'], ['OpponentLoseVotes', '-9999'],
    ['OpponentLoseMalice', '-9999'], ['OpponentLoseScore', '-9999']] as const) {
    const { p } = run([{ type, params: [v] }]);
    for (const k of ['money', 'vote', 'malice', 'score', 'income'] as const) {
      assert.ok(p.res[k] >= 0, `${type} 让 ${k} 变成 ${p.res[k]}`);
    }
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
