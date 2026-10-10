// =============================================================
// 卡牌「移动时效果」**执行**测试
//
// 与 `card-move-effects.test.ts`（只验数据）互补：这里验**引擎真的执行了**。
//
// 规则：原版一张卡有两种用法，说明里 `[m]` 段描述"用它移动时"的效果，
// 数据上对应 `ActionList` 里 `MOVE` 之后的动作（生成时抽到 `moveActions`）。
// 引擎在 `startMove` 走完后执行这一段。
//
// 参数符号约定（很容易搞错）：
//   `OpponentLoseXxx(-N)` 表示目标 **+N**（负值 = 获得）。
//   旧实现写 `if (amount > 0)`，把这类"获得"整体静默丢弃 —— a017/a019/a074/a150 全废。
//
// 运行: npx tsx server/src/__tests__/card-move-exec.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { CARD_BY_NAME } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, createState, getMap, getPlayer, startMove,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

/**
 * 把玩家放到一条"整段都是单出口"的路径起点，用指定卡走完。
 * 这样不会因岔路挂起，断言可以直接看资源变化。
 */
function moveWith(cardName: string, init: { money?: number; vote?: number; malice?: number } = {}) {
  const st: EngineState = createState({
    roomId: 'mv', seed: 20240601, targetScore: 30,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
  const p = getPlayer(st, 'p0')!;
  st.currentIndex = st.players.indexOf(p);
  const card = CARD_BY_NAME[cardName]!;
  const map = getMap(st);

  const safe = map.cells.filter((c) => {
    let cur = c.id;
    for (let i = 0; i < card.move; i++) {
      const cell = map.cells.find((x) => x.id === cur);
      if (!cell || cell.out.length !== 1) return false;
      cur = cell.out[0];
    }
    return true;
  });
  assert.ok(safe.length, `找不到可用 ${cardName} 走完的单出口路径`);
  p.cellId = safe[0].id;
  p.hand = [card.id];
  p.res.money = init.money ?? 200;
  p.res.vote = init.vote ?? 0;
  p.res.malice = init.malice ?? 0;
  // 避免落地效果干扰（厄运/冒险等），把落点效果跳过
  p.flags['ignoreCell'] = 1;

  const before = { ...p.res, skip: p.skipTurns };
  const r = startMove(st, 'p0', card.id);
  return { st, p, card, before, r };
}

console.log('=== 1. 扣减类（正参数）===');
check('a015「永动机」移动 -20$', () => {
  const { p, before } = moveWith('a015');
  assert.equal(before.money - p.res.money, 20, `实际扣 ${before.money - p.res.money}`);
  console.log(`      金钱 ${before.money} → ${p.res.money}`);
});
check('a019「…」移动 -1&（有选票时才看得出）', () => {
  const { p, before } = moveWith('a019', { vote: 5 });
  assert.equal(before.vote - p.res.vote, 1, `实际扣 ${before.vote - p.res.vote}`);
  console.log(`      选票 ${before.vote} → ${p.res.vote}`);
});
check('a140 移动 -50$、-1^', () => {
  const { p, before } = moveWith('a140', { malice: 3 });
  assert.equal(before.money - p.res.money, 50, `金钱应扣 50，实际 ${before.money - p.res.money}`);
  assert.equal(before.malice - p.res.malice, 1, `罪恶应扣 1，实际 ${before.malice - p.res.malice}`);
  console.log(`      金钱 ${before.money} → ${p.res.money}，罪恶 ${before.malice} → ${p.res.malice}`);
});

console.log('\n=== 2. 获得类（负参数，旧实现会全部静默丢弃）===');
check('a017 移动 +1^', () => {
  const { p, before } = moveWith('a017');
  assert.equal(p.res.malice - before.malice, 1, `实际 +${p.res.malice - before.malice}`);
  console.log(`      罪恶 ${before.malice} → ${p.res.malice}`);
});
check('a074「魔幻饰品」移动 +20$', () => {
  const { p, before } = moveWith('a074');
  assert.equal(p.res.money - before.money, 20, `实际 +${p.res.money - before.money}`);
  console.log(`      金钱 ${before.money} → ${p.res.money}`);
});
check('a150「斜坡」移动 +50$', () => {
  const { p, before } = moveWith('a150');
  assert.equal(p.res.money - before.money, 50, `实际 +${p.res.money - before.money}`);
  console.log(`      金钱 ${before.money} → ${p.res.money}`);
});

console.log('\n=== 3. 回合/移动类 ===');
check('a076 移动后跳过 1 回合', () => {
  const { p, before } = moveWith('a076');
  assert.equal(p.skipTurns, before.skip + 1, `实际 skipTurns=${p.skipTurns}`);
  console.log(`      skipTurns ${before.skip} → ${p.skipTurns}`);
});
check('a123 移动后跳过 1 回合', () => {
  const { p, before } = moveWith('a123');
  assert.equal(p.skipTurns, before.skip + 1);
});
check('a031 逆行仍算合法移动（path 非空）', () => {
  const { r } = moveWith('a031');
  assert.ok(r.ok, `移动应成功：${r.reason}`);
  assert.ok((r.path?.length ?? 0) > 0, 'path 不该为空');
  console.log(`      path 长度 ${r.path?.length}`);
});
check('a022 卡面移动点数为 0，但靠 [m] 掷骰移动', () => {
  const c = CARD_BY_NAME['a022']!;
  assert.equal(c.move, 0);
  assert.ok(c.moveActions.some((a) => a.type === 'ROLL'));
});

console.log('\n=== 4. 时机：效果应在"移动走完"时结算 ===');
check('移动效果在 pass-through 之前生效（不依赖落点）', () => {
  // 上面所有用例都已设 ignoreCell 跳过落点效果，仍能观察到数值变化
  // → 说明结算点确实在移动流程内，而不是依赖落点结算
  const { p, before } = moveWith('a015');
  assert.notEqual(p.res.money, before.money);
});
check('同时使用两种用法：站点效果与移动效果互不干扰', () => {
  const c = CARD_BY_NAME['a150']!;
  // a150 的站点效果是 AddTurn(1)，移动效果是 +50$
  assert.ok(c.actions.some((a) => a.type === 'AddTurn'), '站点效果应含 AddTurn');
  assert.ok(c.moveActions.some((a) => a.type === 'OpponentLoseMoney'), '移动效果应含加钱');
  assert.equal(c.moveActions.some((a) => a.type === 'AddTurn'), false,
    'AddTurn 属于站点效果，不该出现在移动效果里');
  console.log(`      站点: ${c.actions.map((a) => a.type).join(',')}`);
  console.log(`      移动: ${c.moveActions.map((a) => a.type).join(',')}`);
});

console.log('\n=== 5. 不变量 ===');
check('资源不会因移动效果变成负数', () => {
  for (const [name, init] of [['a015', { money: 5 }], ['a019', { vote: 0 }], ['a140', { malice: 0, money: 10 }]] as const) {
    const { p } = moveWith(name, init);
    for (const k of ['money', 'vote', 'malice', 'score', 'income'] as const) {
      assert.ok(p.res[k] >= 0, `${name} 的 ${k} 变成 ${p.res[k]}`);
    }
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
