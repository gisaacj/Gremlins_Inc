// =============================================================
// 之前"效果完全没实现"的 5 个动作 + `[m]` 代价门槛
//
// 审计发现这些动作在 `execAction`/`handleSelect` 里**没有分支**，
// 落到 `default` 只写一句"尚未实现"：
//   SelectPunishment（a105 恶魔之职 / a180 天职）
//   SelectZek       （t009 保护费 / t010 新狱友）
//   Exchange_Perm   （a152 伪装卡牌）
//   SpecialMove     （a066 巧夺先机）
//   Perm_Discard    （a121 机械帮手）—— 注册了 flag 但没人读，见文件末尾说明
//
// 另有用户明确要求的一条规则：
//   "[m] 里要支付金钱才能移动的代价，付不起就不能用它移动"
//
// 运行: npx tsx server/src/__tests__/missing-actions.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CARD_BY_NAME, JAIL_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, answerChoice, availableOptions, createState, getMap, getPlayer, moveCostOf,
  moveWithCard, playCard, playEffectCard, runActions, runOption,
} from '@gremlins/shared/engine';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function setup(money = 1000, vote = 10) {
  const st = createState({
    roomId: 'ma', seed: 1, targetScore: 999,
    players: ['Banker', 'Engineer', 'Gambler'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = money; p.res.vote = vote;
    p.hand = []; p.inJail = false; p.res.malice = 0; p.res.score = 10; p.term = 0;
  }
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  for (const id of ['P1', 'P2']) getPlayer(st, id)!.cellId = map.cells.find((x) => x.cellType === 'Jail')!.id;
  st.currentIndex = st.players.indexOf(a);
  return { st, a, t: getPlayer(st, 'P1')!, map };
}

console.log('=== SelectPunishment：出牌者替对手挑一种损失 ===');

check('a105「恶魔之职」：对手 -选票（卡牌 params 顺序与动作参数不同）', () => {
  const { st, a, t } = setup();
  const c = CARD_BY_NAME['a105']!;
  const act = (c.actions ?? []).find((x) => String(x.type) === 'SelectPunishment')!;
  // 先应答选择
  runActions(st, {
    actions: [act], index: 0, targets: [t.id], ownerId: a.id,
    source: `「${c.text.name}」`, sourceCardId: c.id, choices: { SelectPunishment: ['vote'] },
  });
  // 卡面 `-{3}&`，{3} = card.params[2] = 12；初始 10 → 夹到 0
  assert.equal(t.res.vote, 0, `对手选票应为 0，实际 ${t.res.vote}`);
  assert.equal(a.res.money, 1000, '出牌者金钱不变');
});

check('a180「天职」带 `pay`：对手把钱**给**出牌者', () => {
  const { st, a, t } = setup();
  const c = CARD_BY_NAME['a180']!;
  const act = (c.actions ?? []).find((x) => String(x.type) === 'SelectPunishment')!;
  runActions(st, {
    actions: [act], index: 0, targets: [t.id], ownerId: a.id,
    source: `「${c.text.name}」`, sourceCardId: c.id, choices: { SelectPunishment: ['money'] },
  });
  assert.equal(a.res.money, 1200, `出牌者应为 1200，实际 ${a.res.money}`);
  assert.equal(t.res.money, 800, `对手应为 800，实际 ${t.res.money}`);
});

check('SelectPunishment 会挂起让玩家选（不静默跳过）', () => {
  const { st, a, t } = setup();
  const c = CARD_BY_NAME['a105']!;
  const act = (c.actions ?? []).find((x) => String(x.type) === 'SelectPunishment')!;
  const r = runActions(st, {
    actions: [act], index: 0, targets: [t.id], ownerId: a.id,
    source: `「${c.text.name}」`, sourceCardId: c.id,
  });
  assert.equal(r.status, 'pending', '应产生挂起');
  assert.equal(r.pending!.kind, 'SelectPunishment');
  assert.equal(r.pending!.options.length, 3, `应有 3 个选项，实际 ${r.pending!.options.length}`);
});

console.log('\n=== SelectZek：等级更低的囚犯给你 ===');

check('t009「保护费」：两名等级更低的囚犯各给 50', () => {
  const { st, a } = setup();
  const c = JAIL_CARDS.find((x) => x.name === 't009')!;
  a.inJail = true; a.term = 4;
  const t1 = getPlayer(st, 'P1')!; t1.inJail = true; t1.term = 2;
  const t2 = getPlayer(st, 'P2')!; t2.inJail = true; t2.term = 1;
  runActions(st, {
    actions: c.actions, index: 0, targets: [a.id], ownerId: a.id,
    source: '保护费', sourceCardId: c.id,
  });
  assert.equal(a.res.money, 1100, `应为 1100（+100），实际 ${a.res.money}`);
});

check('t009：没有等级更低的囚犯时不给钱', () => {
  const { st, a } = setup();
  const c = JAIL_CARDS.find((x) => x.name === 't009')!;
  a.inJail = true; a.term = 1;
  const t1 = getPlayer(st, 'P1')!; t1.inJail = true; t1.term = 5;
  runActions(st, {
    actions: c.actions, index: 0, targets: [a.id], ownerId: a.id,
    source: '保护费', sourceCardId: c.id,
  });
  assert.equal(a.res.money, 1000, `应不变，实际 ${a.res.money}`);
});

console.log('\n=== Exchange_Perm：与对手交换永久卡 ===');

check('a152「伪装卡牌」：拿到对手的永久卡，把自己的给它', () => {
  const { st, a, t } = setup();
  const c = CARD_BY_NAME['a152']!;
  const mine = ACTION_CARDS.find((x) => x.permanent)!.id;
  const theirs = ACTION_CARDS.filter((x) => x.permanent && x.id !== mine)[0]!.id;
  a.permanents = [mine];
  t.permanents = [theirs];
  const act = (c.actions ?? []).find((x) => String(x.type) === 'Exchange_Perm')!;
  runActions(st, {
    actions: [act], index: 0, targets: [t.id], ownerId: a.id,
    source: `「${c.text.name}」`, sourceCardId: c.id,
  });
  assert.ok(a.permanents.includes(theirs), '出牌者应拿到对手的永久卡');
  assert.ok(!t.permanents.includes(theirs), '对手应失去那张');
  assert.ok(t.permanents.includes(c.id), '对手应拿到 a152 本身');
});

console.log('\n=== SpecialMove（a066 巧夺先机）与 [m] 代价门槛 ===');

check('a066 的移动段是 SpecialMove（没有 MOVE 标记，moveActions 为空）', () => {
  const c = CARD_BY_NAME['a066']!;
  assert.equal(c.specialMove, true, '前提：specialMove=true');
  assert.equal((c.moveActions ?? []).length, 0, '前提：moveActions 为空');
  assert.ok((c.actions ?? []).some((x) => String(x.type) === 'SpecialMove'),
    '前提：actions 里有 SpecialMove');
  assert.equal(String(c.moveText ?? '').includes('change move points to 4'), true,
    '前提：moveText 写明"改成 4 点"');
});

check('a066 用它移动：先问"付 20 改 4 步 / 不付走 3 步"（用户裁定）', () => {
  const { st, a, map } = setup();
  const c = CARD_BY_NAME['a066']!;
  a.cellId = map.cells.find((x) => x.out.length > 0)!.id;
  a.hand = [c.id];
  // 这 20 金是**可选升级**，不是"付不起不让动"的门槛 → moveCostOf 应为 0
  assert.equal(moveCostOf(st, a, c.id), 0,
    `a066 不该有硬性移动代价，实际 ${moveCostOf(st, a, c.id)}`);

  moveWithCard(st, a.id, c.id, map.cells.find((x) => x.id === a.cellId)!.out[0]);
  assert.ok(st.pending, '应挂起问二选一');
  assert.ok(st.pending!.kind.startsWith('specialMove:'),
    `挂起种类应为 specialMove:，实际 ${st.pending!.kind}`);
  assert.equal(st.pending!.options.length, 2, '应有两个选项');
  const labels = st.pending!.options.map((o) => o.label).join(' | ');
  assert.ok(/20/.test(labels) && /4/.test(labels), `应含"20"与"4"，实际 ${labels}`);
  assert.ok(/\b3\b/.test(labels), `不付应走 3 步（卡牌数据 MovePoints=3），实际 ${labels}`);
});

check('a066 选"付 20"：扣钱、走 4 步', () => {
  const { st, a, map } = setup(1000);
  const c = CARD_BY_NAME['a066']!;
  a.cellId = map.cells.find((x) => x.out.length > 0)!.id;
  a.hand = [c.id];
  const dest = map.cells.find((x) => x.id === a.cellId)!.out[0];
  moveWithCard(st, a.id, c.id, dest);
  const r = answerChoice(st, a.id, ['pay']);
  st.pending = r.pending;
  assert.equal(r.ok, true, `应答应成功：${r.error}`);
  assert.equal(a.res.money, 1000 - 20, `应扣 20，实际扣了 ${1000 - a.res.money}`);
  assert.equal(a.lastMoveSteps, 4, `步数应为 4，实际 ${a.lastMoveSteps}`);
});

check('a066 选"不付"：不扣钱、走 3 步', () => {
  const { st, a, map } = setup(1000);
  const c = CARD_BY_NAME['a066']!;
  a.cellId = map.cells.find((x) => x.out.length > 0)!.id;
  a.hand = [c.id];
  const dest = map.cells.find((x) => x.id === a.cellId)!.out[0];
  moveWithCard(st, a.id, c.id, dest);
  const r = answerChoice(st, a.id, ['free']);
  st.pending = r.pending;
  assert.equal(a.res.money, 1000, '不该扣钱');
  assert.equal(a.lastMoveSteps, 3, `步数应为 3，实际 ${a.lastMoveSteps}`);
});

check('a066 钱不够时仍然能"不付"走掉（不是硬性门槛）', () => {
  const { st, a, map } = setup(5);
  const c = CARD_BY_NAME['a066']!;
  a.cellId = map.cells.find((x) => x.out.length > 0)!.id;
  a.hand = [c.id];
  moveWithCard(st, a.id, c.id, map.cells.find((x) => x.id === a.cellId)!.out[0]);
  const r = answerChoice(st, a.id, ['free']);
  st.pending = r.pending;
  assert.equal(r.ok, true, `只有 5 金也该能走：${r.error}`);
  assert.equal(a.res.money, 5, '不该扣钱');
  assert.equal(a.lastMoveSteps, 3, `步数应为 3，实际 ${a.lastMoveSteps}`);
});

check('[m] 代价付不起就不能用它移动（用户明确要求）', () => {
  const { st, a, map } = setup(5);
  const c = CARD_BY_NAME['a015']!;   // [m] -20$
  a.cellId = map.cells.find((x) => x.out.length > 0)!.id;
  a.hand = [c.id];
  const r = moveWithCard(st, a.id, c.id, map.cells.find((x) => x.id === a.cellId)!.out[0]);
  assert.equal(r.ok, false, '应当被拒绝');
  assert.ok(/付不起/.test(r.error ?? ''), `错误信息应说明付不起，实际 ${r.error}`);
  assert.equal(a.res.money, 5, '金钱不该变');
});

check('[m] 代价只扣一次（门槛与扣款用同一个 moveCostOf）', () => {
  const { st, a, map } = setup(100);
  const c = CARD_BY_NAME['a015']!;
  a.cellId = map.cells.find((x) => x.out.length > 0)!.id;
  a.hand = [c.id];
  moveWithCard(st, a.id, c.id, map.cells.find((x) => x.id === a.cellId)!.out[0]);
  assert.equal(a.res.money, 80, `应只扣 20（不是 40），实际 ${a.res.money}`);
});

check('a129「贿赂有道」的代价随罪恶变动', () => {
  const { st, a } = setup(1000);
  const c = CARD_BY_NAME['a129']!;
  a.res.malice = 0;
  const base = moveCostOf(st, a, c.id);
  a.res.malice = 5;
  const higher = moveCostOf(st, a, c.id);
  assert.ok(higher > base, `罪恶更高时代价应更高（${base} → ${higher}）`);
});

console.log('\n=== Perm_Discard（a121 机械帮手）===');

check('a121 打出后 flag 落到持有者身上', () => {
  const { st, a, map } = setup();
  const c = CARD_BY_NAME['a121']!;
  a.cellId = map.cells.find((x) => x.cellTypeId === c.cellTypeId)!.id;
  a.hand = [c.id];
  const r = playEffectCard(st, a.id, c.id);
  assert.equal(r.ok, true, `应能打出：${r.reason}`);
  assert.equal(a.flags['discardIfNoAction'], 1, `flag 应为 1，实际 ${a.flags['discardIfNoAction']}`);
});

check('a121：到站无牌可打时给出"弃牌换新牌"选项，且手牌回到 6 张', () => {
  const { st, a, map } = setup();
  const c = CARD_BY_NAME['a121']!;
  a.cellId = map.cells.find((x) => x.cellTypeId === c.cellTypeId)!.id;
  a.hand = [c.id];
  playEffectCard(st, a.id, c.id);

  a.movedThisTurn = true;
  // 手里全是打不出的牌（不在当前格子的类型上）
  const poor = ACTION_CARDS.filter((x) => !x.specialMove && x.cellTypeId !== c.cellTypeId)
    .slice(0, 3).map((x) => x.id);
  a.hand = poor;

  const opts = availableOptions(st, a.id);
  const pick = opts.find((o) => o.id === 'perm.discardToRedraw');
  assert.ok(pick, `应给出该选项，实际选项：${opts.map((o) => o.id).join(', ') || '(无)'}`);

  const r = runOption(st, a.id, 'perm.discardToRedraw');
  assert.equal(r.ok, true, `执行应成功：${r.error}`);
  // 弃 1 张（3→2）后补到上限 6 —— `drawTo` 是"再抽 N 张"，别写成交 6
  assert.equal(a.hand.length, 6, `手牌应回到 6 张，实际 ${a.hand.length}`);
});

console.log('\n=== 不变量：不再有"效果尚未实现"的动作 ===');

check('审计点名的动作都有真实实现（有独立测试断言其数值）', () => {
  const covered = ['SelectPunishment', 'SelectZek', 'Exchange_Perm', 'SpecialMove'] as const;
  for (const t of covered) {
    const st = createState({
      roomId: 'x', seed: 1, targetScore: 999,
      players: [{ id: 'P0', name: 'P0', isAI: false }, { id: 'P1', name: 'P1', isAI: false }],
      chaosEnabled: false,
    });
    const a = getPlayer(st, 'P0')!;
    a.res.money = 1000; a.hand = [];
    // 直接调原语，确认不落 default 的"尚未实现"
    runActions(st, {
      actions: [{ type: t as never, params: [] }], index: 0, targets: [a.id], ownerId: a.id,
      source: '不变量', sourceCardId: CARD_BY_NAME['a105']!.id,
    });
    const unimplemented = st.log.some((l) => l.text.includes('尚未实现'));
    assert.equal(unimplemented, false, `${t} 仍然落到"尚未实现"`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
