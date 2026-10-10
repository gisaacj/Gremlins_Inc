// =============================================================
// 用户实测反馈的 5 个 bug 的回归测试
//
//  1. 卡牌描述里的特殊符号没翻译（"选择任意玩家：-4&" 应为 "-4选票"）
//  2. 文案丢失关键数值（a008 中文只剩「选择任意玩家。」，没说给多少钱）
//  3. 收藏家「挖宝」没触发（收入格不给"双倍收入 / 换牌"的选择）
//  4. 落地顺序错：站点效果在"用牌"之前就结算了
//     （原版顺序 Move → Conflict → UseCard → **UseCell**）
//  5. 收藏家到冒险格买保险应 10 元，实际被收 40
//
// 运行: npx tsx server/src/__tests__/bugfixes.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  ACTION_CARDS, CARD_BY_NAME, CELL_TYPE_BY_NAME, CHAOS_CARDS, JAIL_CARDS,
  MISFORTUNE_CARDS,
} from '@gremlins/shared/gamedata';
import {
  CHARACTERS, availableOptions, createState, currentPlayerId, getMap, getPlayer,
  insuranceCost, runOption, skipPlay, startMove,
} from '@gremlins/shared/engine';
import { displayCardRules } from '@gremlins/shared';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

// ─────────────────────────────────────────────────────────────
// ---- 测试辅助 ----
function game(names: string[]): EngineState {
  return createState({
    roomId: 'bf', seed: 11, targetScore: 999,
    players: names.map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
}

/**
 * 一张 1 步、免费的移动牌（用来走到目标格）。
 * 用函数而不用顶层 const：landOn 在本行之前就被调用，
 * 顶层 const 会落在 TDZ 里报 "Cannot access before initialization"。
 */
let cachedCard1: string | undefined;
function card1(): string {
  cachedCard1 ??= Object.values(CARD_BY_NAME).find((c) => c.move === 1 && c.price === 0)!.id;
  return cachedCard1;
}

/** 让 P0 走到指定类型的格子（自动应答岔路），返回落点信息 */
function landOn(cellType: string, who: string) {
  // 先探一次棋盘，找出"出边里有目标格"的起点
  const probe = game([who, 'Banker']);
  const targets = new Set(
    getMap(probe).cells.filter((c) => c.cellType === cellType).map((c) => c.id));
  const origins = getMap(probe).cells.filter((c) => c.out.some((o) => targets.has(o)));
  assert.ok(origins.length > 0, `棋盘上应能 1 步走到 ${cellType}`);

  for (const origin of origins) {
    const dest = origin.out.find((o) => targets.has(o))!;
    const st = game([who, 'Banker']);
    const a = getPlayer(st, 'P0')!;
    const b = getPlayer(st, 'P1')!;
    for (const p of st.players) {
      p.res.money = 1000; p.res.malice = 0; p.hand = []; p.inJail = false;
    }
    // 对手挪去监狱格，避免误触交锋
    const jail = getMap(st).cells.find((c) => c.cellType === 'Jail');
    if (jail) b.cellId = jail.id;
    a.cellId = origin.id;
    a.hand = [card1()];
    st.currentIndex = st.players.indexOf(a);

    let g = 0;
    startMove(st, a.id, card1());
    while (st.pending && g++ < 12) {
      const pd = st.pending;
      const pick = pd.options.slice(0, Math.max(1, pd.min ?? 1)).map((o) => o.value);
      if (pd.kind.startsWith('moveBranch:')) {
        startMove(st, a.id, card1(), { [pd.kind]: pick });
        continue;
      }
      break;
    }
    if (a.cellId === dest) return { st, a, b, dest };
  }
  throw new Error(`走不到 ${cellType}`);
}

console.log('=== Bug 1：卡牌描述必须把资源符号翻译成中文 ===');

check('所有卡牌的显示文本都不含裸符号 & $ ^ * | ~', () => {
  const all = [
    ...ACTION_CARDS.map((c) => ['行动', c]),
    ...JAIL_CARDS.map((c) => ['监狱', c]),
    ...MISFORTUNE_CARDS.map((c) => ['厄运', c]),
    ...CHAOS_CARDS.map((c) => ['混沌', c]),
  ] as [string, { name: string }][];
  const bad: string[] = [];
  for (const [kind, c] of all) {
    const d = displayCardRules(c as never);
    if (/[&$^*|~]/.test(d)) bad.push(`[${kind}]${c.name}: ${d.slice(0, 60)}`);
  }
  assert.equal(bad.length, 0, `仍有裸符号：\n      ${bad.slice(0, 5).join('\n      ')}`);
  console.log(`      ${all.length} 张卡全部已翻译`);
});

check('所有卡牌的显示文本都不含未替换的 {n} 占位符', () => {
  const all = [...ACTION_CARDS, ...JAIL_CARDS, ...MISFORTUNE_CARDS, ...CHAOS_CARDS];
  const bad = all.filter((c) => /\{\d+\}/.test(displayCardRules(c as never)));
  assert.equal(bad.length, 0, `仍有占位符：${bad.map((c) => c.name).join(', ')}`);
});

check('a001「游说」的 & 变成"选票"', () => {
  const d = displayCardRules(CARD_BY_NAME['a001']!);
  assert.ok(/选票/.test(d), `实际：${d}`);
  assert.ok(!/&/.test(d), `仍有 &：${d}`);
  console.log(`      ${d}`);
});

check('a011 的 $ 与 ^ 分别变成"金钱""罪恶"', () => {
  const d = displayCardRules(CARD_BY_NAME['a011']!);
  assert.ok(/金钱/.test(d) && /罪恶/.test(d), `实际：${d}`);
  console.log(`      ${d}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Bug 2：文案必须保留关键数值 ===');

check('a008 说清"给你多少钱"（中文截断 → 回退英文 + 填参）', () => {
  const d = displayCardRules(CARD_BY_NAME['a008']!);
  // 中文原文只有「选择任意玩家。」，丢了 250 这个数
  assert.ok(/250/.test(d), `应含金额 250，实际：${d}`);
  console.log(`      ${d}`);
});

check('a010 说清"给你多少齿轮"', () => {
  const d = displayCardRules(CARD_BY_NAME['a010']!);
  assert.ok(/3/.test(d) && /齿轮/.test(d), `实际：${d}`);
  console.log(`      ${d}`);
});

check('a041 说清"对方付多少"', () => {
  const d = displayCardRules(CARD_BY_NAME['a041']!);
  assert.ok(/200/.test(d), `应含 200，实际：${d}`);
  console.log(`      ${d.slice(0, 70)}`);
});

check('纯中文句子不加多余括号，且数值保留', () => {
  // ⚠️ 这条原先断言"英文回退时加全角括号"，但那些卡的**中文后来被人工补全**了
  // （见第 21 轮的 `CARD_ZH_OVERRIDE`），不再走英文回退，原断言随之失效。
  // 现在断言的是**稳定的不变量**：纯中文句子不加括号、数值不丢。
  const zh = displayCardRules(CARD_BY_NAME['a001']!);
  assert.ok(/-1选票/.test(zh), `中文句不该加括号：${zh}`);
  assert.ok(!/（金钱）|（选票）/.test(zh), `纯中文不该出现全角括号：${zh}`);

  // 曾经中英混杂的 a008，现在应完全是中文且保留 250 这个数值
  const a008 = displayCardRules(CARD_BY_NAME['a008']!);
  assert.ok(!/[A-Za-z]{3,}/.test(a008), `a008 应完全中文化：${a008}`);
  assert.ok(/250/.test(a008), `a008 应保留金额 250：${a008}`);
  console.log(`      a001: ${zh}`);
  console.log(`      a008: ${a008}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Bug 5：收藏家冒险格保险 = 10，其他角色 40 ===');

check('insuranceCost 按角色能力返回', () => {
  const st = game(['Collector', 'Banker']);
  assert.equal(insuranceCost(getPlayer(st, 'P0')!), 10, 'Collector 应为 10');
  assert.equal(insuranceCost(getPlayer(st, 'P1')!), 40, 'Banker 应为 40');
});

check('收藏家实际落地冒险格时提示 10（而非 40）', () => {
  for (const [who, want] of [['Banker', 40], ['Collector', 10]] as const) {
    const { st, a } = landOn('Danger', who);
    // ⚠️ 冒险格的买保险提示发生在 **UseCell** 阶段（即 skipPlay 时），
    // 不在 Move 阶段 —— 这正是 Bug 4 修的那个顺序。
    skipPlay(st, a.id);
    const stored = st.pendingInput?.[`danger:${a.id}`];
    assert.equal(String(stored), String(want), `${who} 应为 ${want}，实际 ${stored}`);
    console.log(`      ${who} → ${stored}`);
  }
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Bug 4：站点效果在 UseCard 之后才结算 ===');

check('走牌到达警察格时**不**立刻挂起站点交互', () => {
  const { st } = landOn('Police', 'Banker');
  assert.equal(st.pending, undefined,
    `Move 阶段不该挂起站点交互，实际 ${st.pending?.kind}`);
  assert.ok(st.pendingCellEffect, '应登记"欠着的格子效果"');
  console.log(`      Move 后无挂起，欠账已登记`);
});

check('skipPlay（UseCard 结束）后才结算警察站', () => {
  const { st, a } = landOn('Police', 'Banker');
  skipPlay(st, a.id);
  assert.ok(st.pending?.kind.startsWith('police:'),
    `应在 UseCell 阶段挂起 police:，实际 ${st.pending?.kind}`);
  console.log(`      ${st.pending!.kind}`);
});

check('用移动牌离开 → 不吃原格效果', () => {
  const { st, a } = landOn('Bribe', 'Banker');
  const before = a.res.money;
  a.cellId = getMap(st).cells.find((c) => c.cellType === 'Income')!.id;
  skipPlay(st, a.id);
  assert.equal(a.res.money, before, `离开后不该被扣钱：${before} → ${a.res.money}`);
});

check('非收藏家停在收入格仍照常结算（不会因推迟而丢失）', () => {
  const { st, a } = landOn('Income', 'Banker');
  const before = a.res.money;
  skipPlay(st, a.id);
  assert.equal(a.res.money - before, a.res.income * 2,
    `应结算双倍收入，${before} → ${a.res.money}`);
  console.log(`      +${a.res.money - before}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== Bug 3：收藏家「挖宝」二选一 ===');

check('收藏家停在收入格会得到两个选项', () => {
  const { st, a } = landOn('Income', 'Collector');
  const ids = availableOptions(st, a.id).map((o) => o.id);
  assert.ok(ids.includes('excavation.income'), `缺双倍收入选项：${ids.join(',')}`);
  assert.ok(ids.includes('excavation.swap'), `缺换牌选项：${ids.join(',')}`);
  console.log(`      ${ids.join(', ')}`);
});

check('非收藏家在收入格**没有**挖宝选项', () => {
  const { st, a } = landOn('Income', 'Banker');
  const ids = availableOptions(st, a.id).map((o) => o.id);
  assert.equal(ids.filter((x) => x.startsWith('excavation')).length, 0,
    `不该有：${ids.join(',')}`);
});

check('选「双倍收入」→ 拿到 2× 收入', () => {
  const { st, a } = landOn('Income', 'Collector');
  const inc = a.res.income, before = a.res.money;
  const r = runOption(st, a.id, 'excavation.income');
  assert.ok(r.ok, r.error);
  assert.equal(a.res.money - before, inc * 2, `应为 ${inc * 2}`);
  console.log(`      +${a.res.money - before}`);
});

check('选「换牌」→ 不给钱，手牌被换成 6 张新牌', () => {
  const { st, a } = landOn('Income', 'Collector');
  // 给玩家一副"有辨识度"的满手牌（6 张），这样"是否被换掉"才有意义
  const full = Object.keys(CARD_BY_NAME).slice(0, 6);
  a.hand = [...full];
  const before = a.res.money;
  const r = runOption(st, a.id, 'excavation.swap');
  assert.ok(r.ok, r.error);
  assert.equal(a.res.money, before, '换牌不该给钱（这是它的代价）');
  assert.equal(a.hand.length, 6, `换牌后应有 6 张，实际 ${a.hand.length}`);
  // 新旧手牌应当不同（比对集合，避免同一张牌被抽回来的巧合）
  const same = full.length === a.hand.length && full.every((c) => a.hand.includes(c));
  assert.equal(same, false, `手牌没有被换掉：${JSON.stringify(a.hand)}`);
  console.log(`      弃 ${full.length} 张 → 现有 ${a.hand.length} 张（内容已变）`);
});

check('挖宝用完不残留 pendingCellEffect（不污染下回合）', () => {
  for (const opt of ['excavation.income', 'excavation.swap']) {
    const { st, a } = landOn('Income', 'Collector');
    runOption(st, a.id, opt);
    assert.equal(st.pendingCellEffect, undefined, `${opt}: 有残留`);
    assert.notEqual(currentPlayerId(st), a.id, `${opt}: 应已换人`);
  }
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== 不变量 ===');

check('CELL_TYPE_BY_NAME.Income 被标为不自动结算', () => {
  assert.equal(CELL_TYPE_BY_NAME.Income!.autoCellEffect, false);
});

check('冒险格保底 40（数据里 params[0]=40）', () => {
  assert.equal(CELL_TYPE_BY_NAME.Danger!.params[0], 40);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
