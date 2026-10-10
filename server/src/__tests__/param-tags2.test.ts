// =============================================================
// 参数 tag 语义测试（第二批：`Permanent` / `HaltFailed` / `oppmalicepenalty`
//                     / `moneybonus` / `malicebonus`）
//
// 承接 `param-tags.test.ts`（第一批修了 Governor / Percent / Poorest）。
// 这批是上一轮显式钉住的 5 个"未实现 tag"，现在按牌面语义补齐。
//
// 依据（牌面原文 + 数据）：
//
//  a045「房产税」`OpponentPayMoney(Permanent|50)`
//    "Every player gives you {1}$ for each of their active permanent cards."
//    → 每个对手按**自己持有的永久卡数量** × 50 付款
//
//  a156「Demon'stration」`OpponentPayScore(1|moneybonus|50|malicebonus|1)`
//    "Every player gives you {1}*. For each * received: you +{2}$, +{3}^."
//    → 每个对手给你 1 齿轮；**按实际收到的齿轮数**，每 1 个你 +50$、+1^
//    ⚠️ 必须按"实际收到"算：对手齿轮不足时会少给，不能用名义值 × 人数
//
//  a179「昂贵的命令」`OpponentLoseMoney(150|HaltFailed|oppmalicepenalty|3)`
//    "Choose any player (including you): they must pay {1}$ to get {2}* and
//     lose {3}^. If full payment cannot be made: they do not pay or lose
//     anything, and get {4}^ instead of *."
//    → 付得出：付 150 → +1* → −3^（此处目标罪恶为 0，所以是 0）
//    → 付不出：**整段不生效**（不付款、不拿齿轮、不减罪恶），改为 +3^
//    "整段不生效"要求能停掉**后续动作**（付款→加齿轮→减齿轮→加罪恶），
//    所以引入了 `ctx.haltRest` 中止标记。
//
// 运行: npx tsx server/src/__tests__/param-tags2.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { CARD_BY_NAME } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, createState, getPlayer, runActions,
} from '@gremlins/shared/engine';
import type { ActionType, EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(n = 3): EngineState {
  const names = ['Banker', 'Engineer', 'Thief', 'Gambler', 'Judge', 'Merchant'];
  return createState({
    roomId: 'tag2', seed: 5, targetScore: 30,
    players: names.slice(0, n).map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
}

/**
 * 跑一张卡的动作；返回前后快照。
 *
 * ⚠️ 只有当卡牌**自己**有 `SelectOpponent` 时才提供该选择：
 * `ctx.choices.SelectOpponent` 会**覆盖** `ctx.targets`，
 * 若给 a045/a156（它们用 `AllOpponents`）也塞这个选择，
 * 目标就会被缩成一个玩家，导致"只结算一次"。
 */
function playCard(cardName: string, targetId: string, setup?: (st: EngineState) => void) {
  const st = game();
  const a = getPlayer(st, 'p0')!;
  st.currentIndex = st.players.indexOf(a);
  setup?.(st);
  const snap = () => st.players.map((p) => ({
    id: p.id, money: p.res.money, score: p.res.score,
    malice: p.res.malice, vote: p.res.vote,
  }));
  const before = snap();
  const card = CARD_BY_NAME[cardName]!;
  const needsPick = card.actions.some((x) => x.type === 'SelectOpponent');
  const r = runActions(st, {
    actions: card.actions as never, index: 0, targets: [targetId], ownerId: a.id,
    source: cardName,
    ...(needsPick ? { choices: { SelectOpponent: [targetId] } } : {}),
  });
  return { st, before, after: snap(), r, a };
}

const get = (snap: ReturnType<typeof playCard>['before'], id: string) => snap.find((x) => x.id === id)!;

console.log('=== 1. a045 `Permanent`：按永久卡数量付款 ===');
check('数据里 a045 用 Permanent tag', () => {
  const c = CARD_BY_NAME['a045']!;
  assert.ok(c.actions.some((x) => (x.params ?? []).includes('Permanent')),
    JSON.stringify(c.actions));
});
check('每个对手按「自己的永久卡数 × 50」付款', () => {
  const { before, after } = playCard('a045', 'p1', (st) => {
    // ⚠️ 必须用 getPlayer 按 id 取人：`createState` 会按角色行动顺序
    // (`StepOrderNum`) **重排** `st.players`，所以 `players[0]` 不一定是 `p0`。
    getPlayer(st, 'p0')!.res.money = 0;
    const b = getPlayer(st, 'p1')!;
    const c = getPlayer(st, 'p2')!;
    b.res.money = 500; c.res.money = 500;
    b.permanents = ['x', 'y'];     // 2 张 → 100
    c.permanents = ['z'];          // 1 张 → 50
  });
  const bPaid = get(before, 'p1').money - get(after, 'p1').money;
  const cPaid = get(before, 'p2').money - get(after, 'p2').money;
  const gained = get(after, 'p0').money - get(before, 'p0').money;
  assert.equal(bPaid, 100, `p1 应付 100（2 张），实际 ${bPaid}`);
  assert.equal(cPaid, 50, `p2 应付 50（1 张），实际 ${cPaid}`);
  assert.equal(gained, 150, `出牌者应 +150，实际 +${gained}`);
  console.log(`      p1(2张)付 ${bPaid}，p2(1张)付 ${cPaid}，出牌者 +${gained}`);
});
check('没有永久卡的对手不付款', () => {
  const { before, after } = playCard('a045', 'p1', (st) => {
    for (const p of st.players) { p.res.money = 500; p.permanents = []; }
  });
  for (const id of ['p1', 'p2']) {
    assert.equal(get(before, id).money, get(after, id).money, `${id} 不该付钱`);
  }
});
check('永久卡数量不会让付款方向出错（出牌者不该付钱）', () => {
  const { before, after } = playCard('a045', 'p1', (st) => {
    const a = getPlayer(st, 'p0')!;
    const b = getPlayer(st, 'p1')!;
    a.res.money = 500; b.res.money = 500;
    b.permanents = ['x'];
    a.permanents = ['a', 'b', 'c'];   // 出牌者自己的永久卡不参与
  });
  assert.ok(get(after, 'p0').money >= get(before, 'p0').money, '出牌者不该付钱');
  console.log(`      出牌者 ${get(before, 'p0').money} → ${get(after, 'p0').money}`);
});

console.log('\n=== 2. a156 `moneybonus` / `malicebonus`：按实际收到结算 ===');
check('数据里 a156 两个 bonus tag 都在', () => {
  const c = CARD_BY_NAME['a156']!;
  const p = JSON.stringify(c.actions);
  assert.ok(p.includes('moneybonus') && p.includes('malicebonus'), p);
});
check('收到 N 个齿轮 → +N×50$、+N×1^', () => {
  const { before, after } = playCard('a156', 'p0', (st) => {
    const a = getPlayer(st, 'p0')!;
    a.res.money = 0; a.res.malice = 0; a.res.score = 0;
    getPlayer(st, 'p1')!.res.score = 5;
    getPlayer(st, 'p2')!.res.score = 5;
  });
  const gainedMoney = get(after, 'p0').money - get(before, 'p0').money;
  const gainedMalice = get(after, 'p0').malice - get(before, 'p0').malice;
  assert.equal(gainedMoney, 100, `应 +100（2 齿轮 × 50），实际 +${gainedMoney}`);
  assert.equal(gainedMalice, 2, `应 +2^，实际 +${gainedMalice}`);
  console.log(`      出牌者 +${gainedMoney}$、+${gainedMalice}^（2 个对手各给 1 齿轮）`);
});
check('对手齿轮不足时，按**实际收到**算而不是名义值', () => {
  // p1 有 5 个齿轮，p2 一个都没有 → 实际只收到 1 个
  const { before, after } = playCard('a156', 'p0', (st) => {
    const a = getPlayer(st, 'p0')!;
    a.res.money = 0; a.res.malice = 0; a.res.score = 0;
    getPlayer(st, 'p1')!.res.score = 5;
    getPlayer(st, 'p2')!.res.score = 0;
  });
  const gainedMoney = get(after, 'p0').money - get(before, 'p0').money;
  assert.equal(gainedMoney, 50, `只收到 1 齿轮 → 应 +50，实际 +${gainedMoney}`);
  console.log(`      p2 无齿轮 → 只收到 1 个 → +${gainedMoney}$`);
});
check('全员都没齿轮 → 不给奖励', () => {
  const { before, after } = playCard('a156', 'p0', (st) => {
    for (const p of st.players) { p.res.score = 0; p.res.money = 0; p.res.malice = 0; }
  });
  assert.equal(get(after, 'p0').money, 0);
  assert.equal(get(after, 'p0').malice, 0);
});

console.log('\n=== 3. a179 `HaltFailed` / `oppmalicepenalty`：付不出则整段不生效 ===');
check('数据里 a179 两个 tag 都在', () => {
  const c = CARD_BY_NAME['a179']!;
  const p = JSON.stringify(c.actions);
  assert.ok(p.includes('HaltFailed') && p.includes('oppmalicepenalty'), p);
});
check('付得出：付款 150 → +1* → 减 3^', () => {
  const { before, after } = playCard('a179', 'p1', (st) => {
    const t = getPlayer(st, 'p1')!;
    t.res.money = 500; t.res.score = 10; t.res.malice = 5;
  });
  const b = get(before, 'p1'); const a2 = get(after, 'p1');
  assert.equal(b.money - a2.money, 150, `应扣 150，实际 ${b.money - a2.money}`);
  assert.equal(a2.score - b.score, 1, `应 +1 齿轮，实际 ${a2.score - b.score}`);
  assert.equal(b.malice - a2.malice, 3, `应 -3 罪恶，实际 ${b.malice - a2.malice}`);
  console.log(`      金 ${b.money}→${a2.money}，齿轮 ${b.score}→${a2.score}，罪恶 ${b.malice}→${a2.malice}`);
});
check('付不出：不付款、不拿齿轮、不减罪恶，改为 +3^', () => {
  const { before, after } = playCard('a179', 'p1', (st) => {
    const t = getPlayer(st, 'p1')!;
    t.res.money = 50; t.res.score = 10; t.res.malice = 0;
  });
  const b = get(before, 'p1'); const a2 = get(after, 'p1');
  assert.equal(a2.money, b.money, `不该付款：${b.money} → ${a2.money}`);
  assert.equal(a2.score, b.score, `不该拿齿轮：${b.score} → ${a2.score}`);
  assert.equal(a2.malice - b.malice, 3, `应 +3 罪恶，实际 +${a2.malice - b.malice}`);
  console.log(`      金保持 ${a2.money}，齿轮保持 ${a2.score}，罪恶 ${b.malice}→${a2.malice}`);
});
check('付不出时后续动作确实被停掉（haltRest 生效）', () => {
  // 若没有 haltRest，`OpponentLoseScore(-1)` 仍会执行 → 齿轮会 +1
  const { after, before } = playCard('a179', 'p1', (st) => {
    const t = getPlayer(st, 'p1')!;
    t.res.money = 0; t.res.score = 10; t.res.malice = 0;
  });
  assert.equal(get(after, 'p1').score, get(before, 'p1').score,
    '齿轮不该变化，说明后续动作未被停掉');
});
check('恰好付得起（等于 150）算成功', () => {
  const { before, after } = playCard('a179', 'p1', (st) => {
    const t = getPlayer(st, 'p1')!;
    t.res.money = 150; t.res.score = 10; t.res.malice = 0;
  });
  assert.equal(get(after, 'p1').money, 0, `应刚好付清，实际 ${get(after, 'p1').money}`);
  assert.equal(get(after, 'p1').score - get(before, 'p1').score, 1, '应拿到齿轮');
  console.log(`      刚好 150：付清后金 ${get(after, 'p1').money}，拿到齿轮`);
});

console.log('\n=== 4. 不变量 ===');
check('所有 tag 路径都不会让资源变成负数', () => {
  for (const [card, target, setup] of [
    ['a045', 'p1', (st: EngineState) => { for (const p of st.players) { p.res.money = 10; p.permanents = ['x']; } }],
    ['a156', 'p0', (st: EngineState) => { for (const p of st.players) p.res.score = 0; }],
    ['a179', 'p1', (st: EngineState) => { const t = getPlayer(st, 'p1')!; t.res.money = 0; t.res.malice = 0; }],
  ] as const) {
    const { after } = playCard(card, target, setup);
    for (const p of after) {
      for (const k of ['money', 'vote', 'malice', 'score'] as const) {
        assert.ok(p[k] >= 0, `${card} 让 ${p.id} 的 ${k} 变成 ${p[k]}`);
      }
    }
  }
});
check('HaltFailed 不会污染下一次动作序列（标记不跨调用残留）', () => {
  const st = game();
  const a = getPlayer(st, 'p0')!;
  const t = getPlayer(st, 'p1')!;
  t.res.money = 0;
  // 第一次：付不出 → haltRest
  runActions(st, {
    actions: CARD_BY_NAME['a179']!.actions as never, index: 0, targets: [t.id],
    ownerId: a.id, source: 'a179', choices: { SelectOpponent: [t.id] },
  });
  // 第二次：独立的动作序列，应当正常执行
  const t2 = getPlayer(st, 'p2')!;
  t2.res.score = 0;
  const before = t2.res.score;
  runActions(st, {
    actions: [{ type: 'OpponentLoseScore' as ActionType, params: ['-1'] }], index: 0,
    targets: [t2.id], ownerId: a.id, source: 'test',
  });
  assert.equal(t2.res.score - before, 1, '第二次调用应正常生效');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
