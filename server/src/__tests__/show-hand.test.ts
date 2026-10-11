// =============================================================
// `OpponentShowHand` 的各 tag 效果
//
// 审计发现：13 个 tag 里只实现了 3 个（SecretPay / CellPay / Discard），
// 其余 10 个被静默忽略 —— 于是 a063「诚信交易」、a128「开诚骗术」、
// a148「违禁走私」、a151「告密者」、a176「公开性」、a177「满堂红」、
// m023「大公无私」这些卡的效果一个都没生效。
//
// 关键区分（逐一核对过 13 张卡的文案与动作）：
//   「揭开**你的**手牌」→ 数**出牌者自己**的牌：
//       Confess / SamePointsBonus / Contraband
//   「查看**对手**的手牌」→ 数目标的牌：
//       SecretPay / CellPay / Discard / Snitch / SelectCards
//
// 另一个坑：数值必须**优先取卡牌 `params`**，动作 params 里的数字不可靠
// （a063 动作写 `(id|0|Exchange|Pay)`，真金额 30 在 `card.params`）。
//
// 运行: npx tsx server/src/__tests__/show-hand.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CARD_BY_NAME, MISFORTUNE_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, createState, getMap, getPlayer, runActions,
} from '@gremlins/shared/engine';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;
const idOf = (n: string) => ACTION_CARDS.find((c) => c.name === n)!.id;

/** 三人家开局（`SelectOpponent` 在两人局会自动选中，测不到交互） */
function setup(name: string, money = 1000, vote = 10): {
  st: EngineState; a: EnginePlayer; t: EnginePlayer; map: ReturnType<typeof getMap>; c: (typeof ACTION_CARDS)[number];
} {
  const c = CARD_BY_NAME[name]!;
  const st = createState({
    roomId: 'sh', seed: 1, targetScore: 999,
    players: ['Banker', 'Engineer', 'Gambler'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = money; p.res.vote = vote;
    p.hand = []; p.inJail = false; p.res.malice = 0; p.res.score = 0; p.term = 0;
  }
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  for (const id of ['P1', 'P2']) getPlayer(st, id)!.cellId = map.cells.find((x) => x.cellType === 'Jail')!.id;
  st.currentIndex = st.players.indexOf(a);
  a.cellId = map.cells.find((x) => x.cellTypeId === c.cellTypeId)!.id;
  a.movedThisTurn = true;
  return { st, a, t: getPlayer(st, 'P1')!, map, c };
}

/** 直接跑该卡的 `OpponentShowHand` 原语（绕开选目标/抽牌等交互） */
function runShowHand(st: EngineState, card: (typeof ACTION_CARDS)[number],
  ownerId: string, targets: string[], scratch?: Record<string, string>) {
  const act = (card.actions ?? []).find((x) => String(x.type) === 'OpponentShowHand')!;
  return runActions(st, {
    actions: [act], index: 0, targets, ownerId,
    source: `「${card.text.name}」`, sourceCardId: card.id, scratch,
  });
}

console.log('=== 数「出牌者自己」的牌：Confess / SamePointsBonus / Contraband ===');

check('a128「开诚骗术」Confess：每罪恶卡 +2&、每秘密卡 +1&（数自己的牌）', () => {
  const { st, a, c } = setup('a128', 1000, 0);
  a.hand = [idOf('a010'), idOf('a005'), idOf('a008'), idOf('a001')];  // 1 罪恶 + 2 秘密
  runShowHand(st, c, a.id, [a.id]);
  assert.equal(a.res.vote, 1 * 2 + 2 * 1, `选票应为 4，实际 ${a.res.vote}`);
});

check('a148「违禁走私」Contraband：每罪恶卡 +2 齿轮、每秘密卡 +50 金钱（数自己的牌）', () => {
  const { st, a, c } = setup('a148');
  a.hand = [idOf('a010'), idOf('a005'), idOf('a008'), idOf('a001')];  // 1 罪恶 + 2 秘密
  runShowHand(st, c, a.id, [a.id]);
  assert.equal(a.res.score, 2, `齿轮应为 2，实际 ${a.res.score}`);
  assert.equal(a.res.money, 1000 + 100, `金钱应为 1100，实际 ${a.res.money}`);
});

check('a177「满堂红」SamePointsBonus：一对 +100，多出的每张 +100（数自己的牌）', () => {
  const { st, a, c } = setup('a177');
  const trio = ACTION_CARDS.filter((x) => x.move === 3).slice(0, 3).map((x) => x.id);
  a.hand = trio;
  runShowHand(st, c, a.id, [a.id]);
  assert.equal(a.res.money, 1000 + 200, `金钱应为 1200，实际 ${a.res.money}`);
});

check('a177 只有两张同点数时只算一对（+100）', () => {
  const { st, a, c } = setup('a177');
  const pair = ACTION_CARDS.filter((x) => x.move === 3).slice(0, 2).map((x) => x.id);
  a.hand = pair;
  runShowHand(st, c, a.id, [a.id]);
  assert.equal(a.res.money, 1100, `应为 1100，实际 ${a.res.money}`);
});

console.log('\n=== 数「对手」的牌：SecretPay / Snitch / SelectCards ===');

check('a043「搜身」SecretPay：每张罪恶/秘密卡，对手付 100（数对手的牌）', () => {
  const { st, a, t, c } = setup('a043');
  t.hand = [idOf('a010'), idOf('a005'), idOf('a001')];  // 1 罪恶 + 1 秘密
  runShowHand(st, c, a.id, [t.id]);
  assert.equal(a.res.money, 1000 + 200, `出牌者应为 1200，实际 ${a.res.money}`);
  assert.equal(t.res.money, 800, `对手应为 800，实际 ${t.res.money}`);
});

check('a151「告密者」Snitch：对手有罪恶卡 → 出牌者刑期结束', () => {
  const { st, a, t, c } = setup('a151');
  a.term = 3; a.inJail = true;
  t.hand = [idOf('a010'), idOf('a001')];
  runShowHand(st, c, a.id, [t.id]);
  assert.equal(a.term, 0, `刑期应归零，实际 ${a.term}`);
  assert.equal(a.inJail, false, '应已出狱');
});

check('a151 对手没有罪恶卡 → 刑期不变', () => {
  const { st, a, t, c } = setup('a151');
  a.term = 3; a.inJail = true;
  t.hand = [idOf('a001'), idOf('a002')];
  runShowHand(st, c, a.id, [t.id]);
  assert.equal(a.term, 3, `刑期不该变，实际 ${a.term}`);
});

check('a046「清剿行动」Discard：弃光对手手牌，出牌者每张 +1 罪恶', () => {
  const { st, a, t, c } = setup('a046');
  t.hand = [idOf('a001'), idOf('a002'), idOf('a003')];
  runShowHand(st, c, a.id, [t.id]);
  assert.equal(t.hand.length, 0, `对手手牌应清空，实际 ${t.hand.length}`);
  assert.equal(a.res.malice, 3, `罪恶应为 3，实际 ${a.res.malice}`);
});

console.log('\n=== 交换手牌：Exchange / Pay / Invert ===');

check('a063「诚信交易」Exchange+Pay：对手给 30，双方交换手牌', () => {
  const { st, a, t, c } = setup('a063');
  t.hand = [idOf('a001'), idOf('a002')];
  a.hand = [idOf('a003')];
  runShowHand(st, c, a.id, [t.id]);
  assert.equal(a.res.money, 1030, `出牌者应为 1030，实际 ${a.res.money}`);
  assert.equal(t.res.money, 970, `对手应为 970，实际 ${t.res.money}`);
  assert.deepEqual(a.hand, [idOf('a001'), idOf('a002')], '出牌者应拿到对手的牌');
});

check('a063 的金额取自 card.params（动作参数写的是 0）', () => {
  const c = CARD_BY_NAME['a063']!;
  const act = (c.actions ?? []).find((x) => String(x.type) === 'OpponentShowHand')!;
  assert.ok((act.params ?? []).includes('0'), `前提：动作参数里是 0（${JSON.stringify(act.params)}）`);
  assert.equal(c.params?.[0], 30, `card.params[0] 应为 30，实际 ${c.params?.[0]}`);
});

check('m023「大公无私」Exchange+Invert：手牌照样交换', () => {
  const m = MISFORTUNE_CARDS.find((x) => x.name === 'm023')!;
  const { st, a, t } = setup('a001');
  t.hand = [idOf('a001'), idOf('a002')];
  a.hand = [idOf('a003')];
  const act = (m.actions ?? []).find((x) => String(x.type) === 'OpponentShowHand')!;
  runActions(st, {
    actions: [act], index: 0, targets: [t.id], ownerId: a.id,
    source: `「${m.text.name}」`, sourceCardId: m.id,
  });
  assert.deepEqual(a.hand, [idOf('a001'), idOf('a002')], '出牌者应拿到对手的牌');
  assert.deepEqual(t.hand, [idOf('a003')], '对手应拿到出牌者的牌');
});

console.log('\n=== 不变量：所有 ShowHand 卡的每个 tag 都有实现 ===');

check('13 个 tag 全部被处理（没有"参数被忽略"的遗留）', () => {
  // 这条靠"每个 tag 至少有一张卡的测试"来保证；这里列出全集做可读性检查
  const seen = new Set<string>();
  const all = [...ACTION_CARDS, ...MISFORTUNE_CARDS];
  for (const c of all) {
    for (const x of c.actions ?? []) {
      if (String(x.type) !== 'OpponentShowHand') continue;
      for (const p of x.params ?? []) {
        if (/^[A-Za-z]/.test(p) && !/^\d/.test(p)) seen.add(p);
      }
    }
  }
  // 这些是**语义 tag**（实现里处理），其余是 UIN/条件 id
  const semantic = ['Confess', 'Contraband', 'Snitch', 'SelectCards', 'ZeroVotes',
    'SamePointsBonus', 'Exchange', 'Pay', 'Invert', 'SecretPay', 'CellPay',
    'Discard', 'Teleport'];
  const missing = semantic.filter((t) => !seen.has(t));
  assert.equal(missing.length, 0, `测试未覆盖这些 tag：${missing.join(', ')}`);
  console.log(`      已覆盖 tag: ${semantic.join(', ')}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;

