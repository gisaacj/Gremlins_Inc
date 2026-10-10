// =============================================================
// 交互型原语测试：Auction / CompareResource / TopStatBonus
//
// 这三个都只有 1 张卡在用，规则写在卡牌说明里：
//
//   a061「拍卖」      每个玩家出价，最高者付价并 +出价额 齿轮
//   m031「总统造访」  每个玩家出价，所有出价都付，最低者 -出价额 齿轮
//   a134「伪证」      目标给你 {1} 齿轮；**若其罪恶高于你，则被逮捕**
//   a181「知名品牌」  每有一项资源最高 → +1 齿轮、+3 收入
//
// 运行: npx tsx src/__tests__/primitives.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  ACTION_CARDS, CHARACTERS, MISFORTUNE_CARDS,
  createState, getPlayer, runActions, resolvePending,
} from '@gremlins/shared/engine';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;
const cardOf = (n: string) => ACTION_CARDS.find((c) => c.name === n)!;
const misfOf = (n: string) => MISFORTUNE_CARDS.find((c) => c.name === n)!;

/** 建 n 人局 */
function game(n = 3, seed = 4242): EngineState {
  const names = ['Banker', 'Engineer', 'Thief', 'Judge', 'Gambler', 'Damned'];
  return createState({
    roomId: 'prim', seed, targetScore: 30,
    players: names.slice(0, n).map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
}

/**
 * 直接跑一张卡的动作序列（不经由打牌流程）。
 *
 * 注意三点：
 *  1. `createState` 会按**行动顺序重排玩家**，不要假设 `players[0]` 是 `p0`
 *  2. 跑卡前把 `currentIndex` 指到 owner，否则 `owner(state, ctx)` 会取错人
 *  3. `runActions` 只**返回** pending，不写 `state.pending` —— 必须写回，
 *     否则后续 `resolvePending` 会报"当前没有待决策项"
 */
function runCard(st: EngineState, cardName: string, ownerId = 'p0') {
  const card = cardOf(cardName);
  st.currentIndex = st.players.findIndex((p) => p.id === ownerId);
  const r = runActions(st, {
    actions: card.actions,
    index: 0,
    targets: [ownerId],
    ownerId,
    source: cardName,
    sourceCardId: card.id,
  });
  if (r.status === 'pending') st.pending = r.pending;
  return r;
}
function runMisfortune(st: EngineState, cardName: string, ownerId = 'p0') {
  const card = misfOf(cardName);
  st.currentIndex = st.players.findIndex((p) => p.id === ownerId);
  const r = runActions(st, {
    actions: card.actions,
    index: 0,
    targets: [ownerId],
    ownerId,
    source: cardName,
    sourceCardId: card.id,
  });
  if (r.status === 'pending') st.pending = r.pending;
  return r;
}

/** 回答挂起并把返回的新挂起写回（最后一次会返回 undefined → 清空） */
function answer(st: EngineState, playerId: string, value: string): void {
  const r = resolvePending(st, playerId, [value]);
  st.pending = r.pending;
}

/** 依次回答所有挂起（每次都用给定的出价） */
function answerAll(st: EngineState, bid: string): number {
  let guard = 0;
  while (st.pending && guard++ < 20) {
    answer(st, st.pending.playerId, bid);
  }
  return guard;
}

console.log('=== 1. TopStatBonus（a181 知名品牌）===');
check('每有一项资源最高 → +1 齿轮、+3 收入', () => {
  const st = game(3);
  const me = getPlayer(st, 'p0')!;
  // 人为制造两项最高：齿轮最高、收入最高
  me.res.score = 10;
  me.res.income = 50;
  for (const o of st.players) {
    if (o.id === me.id) continue;
    o.res.score = 1;
    o.res.income = 1;
  }
  const before = { score: me.res.score, income: me.res.income };
  const r = runCard(st, 'a181');
  assert.equal(r.status, 'done', '不该挂起');
  // 齿轮/收入本来就是最高的两项 → count 至少 2
  assert.ok(me.res.score > before.score, `齿轮应增加，实际 ${before.score} → ${me.res.score}`);
  assert.ok(me.res.income > before.income, `收入应增加，实际 ${before.income} → ${me.res.income}`);
  const dScore = me.res.score - before.score;
  const dIncome = me.res.income - before.income;
  assert.equal(dScore % 1, 0);
  assert.equal(dIncome, dScore * 3, `收入增量应为齿轮增量的 3 倍：${dScore} vs ${dIncome}`);
  console.log(`      ${dScore} 齿轮 / ${dIncome} 收入（count=${dScore}）`);
});
check('一项都不最高时无奖励', () => {
  const st = game(3);
  const me = getPlayer(st, 'p0')!;
  for (const k of ['money', 'score', 'vote', 'malice', 'income', 'term'] as const) me.res[k] = 0;
  for (const o of st.players) {
    if (o.id === me.id) continue;
    for (const k of ['money', 'score', 'vote', 'malice', 'income', 'term'] as const) o.res[k] = 5;
  }
  const before = { score: me.res.score, income: me.res.income };
  runCard(st, 'a181');
  assert.equal(me.res.score, before.score);
  assert.equal(me.res.income, before.income);
});

console.log('\n=== 2. CompareResource（a134 伪证）===');
check('目标罪恶高于自己 → 被逮捕', () => {
  const st = game(2);
  const me = getPlayer(st, 'p0')!;
  const foe = getPlayer(st, 'p1')!;
  me.res.malice = 1;
  foe.res.malice = 9; // 高于我 → 应被逮捕
  foe.res.score = 10;
  const r = runCard(st, 'a134');
  assert.equal(r.status, 'done', '两人局 SelectOpponent 自动选目标');
  assert.equal(foe.inJail, true, '目标罪恶更高，应被逮捕');
  console.log(`      目标罪恶 9 > 自己 1 → 已逮捕`);
});
check('目标罪恶不高于自己 → 不逮捕', () => {
  const st = game(2);
  const me = getPlayer(st, 'p0')!;
  const foe = getPlayer(st, 'p1')!;
  me.res.malice = 9;
  foe.res.malice = 1; // 低于我 → 不应被逮捕
  foe.res.score = 10;
  const r = runCard(st, 'a134');
  assert.equal(r.status, 'done');
  assert.equal(foe.inJail, false, '目标罪恶不更高，不该被逮捕');
});
check('无论是否逮捕，目标都要付 {1} 齿轮', () => {
  for (const [myM, foeM] of [[0, 5], [9, 1]] as const) {
    const st = game(2);
    const me = getPlayer(st, 'p0')!;
    const foe = getPlayer(st, 'p1')!;
    me.res.malice = myM;
    foe.res.malice = foeM;
    foe.res.score = 10;
    const before = { me: me.res.score, foe: foe.res.score };
    runCard(st, 'a134');
    assert.equal(me.res.score, before.me + 2, `自己应 +2 齿轮（${myM}/${foeM}）`);
    assert.equal(foe.res.score, before.foe - 2, `目标应 -2 齿轮（${myM}/${foeM}）`);
  }
});
check('a134 参数与说明一致（付 2 齿轮、比罪恶）', () => {
  const c = cardOf('a134');
  const pay = c.actions.find((a) => a.type === 'OpponentPayScore')!;
  const cmp = c.actions.find((a) => a.type === 'CompareResource')!;
  assert.deepEqual(pay.params, ['2']);
  assert.deepEqual(cmp.params, ['malice']);
  assert.match(c.text.description, /\{1\}/);
});

console.log('\n=== 3. Auction：a061「拍卖」（最高者付价 + 齿轮）===');
check('三人局会依次问三个人出价', () => {
  const st = game(3);
  const r = runCard(st, 'a061');
  assert.equal(r.status, 'pending', '应挂起等出价');
  const order = st.players.map((p) => p.id);
  assert.equal(st.pending!.playerId, order[0], '先问第一位');
  answer(st, order[0], '100');
  assert.equal(st.pending!.playerId, order[1], '接着问第二位');
  answer(st, order[1], '200');
  assert.equal(st.pending!.playerId, order[2], '接着问第三位');
});
check('最高出价者付钱并 +出价额 齿轮，其他人不受影响', () => {
  const st = game(3);
  runCard(st, 'a061');
  const order = st.players.map((p) => p.id);
  for (const p of st.players) { p.res.money = 500; p.res.score = 0; }
  // 第二位出最高价
  answer(st, order[0], '100');
  answer(st, order[1], '300'); // 最高
  answer(st, order[2], '50');
  const hi = getPlayer(st, order[1])!;
  const lo1 = getPlayer(st, order[0])!;
  const lo2 = getPlayer(st, order[2])!;
  assert.equal(hi.res.money, 200, `最高者应付 300：500 → ${hi.res.money}`);
  assert.equal(hi.res.score, 300, `最高者应 +300 齿轮，实际 ${hi.res.score}`);
  assert.equal(lo1.res.money, 500, '非最高者不付钱');
  assert.equal(lo2.res.money, 500, '非最高者不付钱');
  assert.equal(lo1.res.score, 0, '非最高者不得齿轮');
  console.log(`      ${order[1]} 付 300 得 300 齿轮；其余未受影响`);
});
check('无人出价 → 流拍（没人付钱）', () => {
  const st = game(3);
  runCard(st, 'a061');
  for (const p of st.players) p.res.money = 100;
  answerAll(st, '0');
  for (const p of st.players) assert.equal(p.res.money, 100, `${p.id} 不该付钱`);
});

console.log('\n=== 4. Auction：m031「总统造访」（全员付价，最低者 -齿轮）===');
check('所有人都要付自己的出价', () => {
  const st = game(3);
  runMisfortune(st, 'm031');
  const order = st.players.map((p) => p.id);
  for (const p of st.players) { p.res.money = 500; p.res.score = 100; }
  answer(st, order[0], '100');
  answer(st, order[1], '200');
  answer(st, order[2], '50');
  assert.equal(getPlayer(st, order[0])!.res.money, 400);
  assert.equal(getPlayer(st, order[1])!.res.money, 300);
  assert.equal(getPlayer(st, order[2])!.res.money, 450);
  console.log(`      付价后：${order.map((id) => getPlayer(st, id)!.res.money).join(' / ')}`);
});
check('最低出价者额外 -出价额 齿轮', () => {
  const st = game(3);
  runMisfortune(st, 'm031');
  const order = st.players.map((p) => p.id);
  for (const p of st.players) { p.res.money = 500; p.res.score = 100; }
  answer(st, order[0], '100');
  answer(st, order[1], '200');
  answer(st, order[2], '50'); // 最低
  assert.equal(getPlayer(st, order[2])!.res.score, 50,
    `最低者应 -50 齿轮：100 → ${getPlayer(st, order[2])!.res.score}`);
  assert.equal(getPlayer(st, order[0])!.res.score, 100, '非最低者不掉齿轮');
  assert.equal(getPlayer(st, order[1])!.res.score, 100, '非最低者不掉齿轮');
});
check('m031 参数与 a061 不同（用于判别形态）', () => {
  assert.equal(Number(cardOf('a061').params[0]), 3);
  assert.equal(Number(misfOf('m031').params[0]), 2);
  console.log(`      a061 params[0]=${cardOf('a061').params[0]}，m031 params[0]=${misfOf('m031').params[0]}`);
});

console.log('\n=== 5. 三者都进了动作序列且不挂死 ===');
check('a061 / m031 / a134 / a181 完整跑完都不卡住', () => {
  for (const [name, isMisf] of [['a061', false], ['m031', true], ['a134', false], ['a181', false]] as const) {
    const st = game(3);
    const r = isMisf ? runMisfortune(st, name) : runCard(st, name);
    let guard = 0;
    while (st.pending && guard++ < 20) {
      // 选第一个选项
      const p = st.pending!;
      answer(st, p.playerId, p.options[0].value);
    }
    assert.ok(guard < 20, `${name} 疑似死循环（${guard} 次挂起）`);
    console.log(`      ${name} 完成，挂起 ${guard} 次`);
  }
});
check('没有玩家资源变成负数', () => {
  for (const name of ['a061', 'a181', 'a134']) {
    const st = game(3);
    for (const p of st.players) { p.res.money = 30; p.res.score = 1; p.res.income = 0; }
    runCard(st, name);
    let guard = 0;
    while (st.pending && guard++ < 20) {
      const p = st.pending!;
      answer(st, p.playerId, p.options[p.options.length - 1].value);
    }
    for (const p of st.players) {
      for (const k of ['money', 'score', 'income'] as const) {
        assert.ok(p.res[k] >= 0, `${name}: ${p.id}.${k} = ${p.res[k]}`);
      }
    }
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
