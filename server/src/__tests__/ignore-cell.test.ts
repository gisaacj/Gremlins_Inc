// =============================================================
// 「无视本站」（IgnoreCell）与位置交换的回归测试 —— 用户 bug #2
//
// 用户实测：「恶作剧」和别人交换位置后**不应**再触发建筑，为什么还是触发了。
//
// a023「恶作剧」卡面原文：
//   "选择任意玩家进行位置交换（**交换后所在位置的规则不会触发**）。"
// 其动作序列是 `IgnoreCell() → SelectOpponent → OpponentSwitchPlaces()`。
//
// 根因：`ignoreCell` 原先只挡住了**自动落点结算**（`resolveCellEffect`），
// 没挡住**可选动作**，所以换到办公楼后界面仍给出「卖选票」。
//
// a160「好运」把语义说得更直白："厄运站点的规则**不会影响你**"，
// 所以实现上把"本站的可选动作"一并屏蔽。
//
// 运行: npx tsx server/src/__tests__/ignore-cell.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CARD_BY_NAME } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, availableOptions, createState, getMap, getPlayer, playEffectCard,
  resolvePending, skipPlay,
} from '@gremlins/shared/engine';
import type { EngineState, EnginePlayer } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function buildGame(names = ['Banker', 'Engineer']) {
  const st: EngineState = createState({
    roomId: 'ic', seed: 11, targetScore: 999,
    players: names.map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  const b = getPlayer(st, 'P1')!;
  for (const p of st.players) {
    p.res.money = 1000; p.res.malice = 0; p.hand = []; p.inJail = false;
  }
  st.currentIndex = st.players.indexOf(a);
  return { st, a, b, map };
}

const cellOf = (st: EngineState, p: EnginePlayer) =>
  getMap(st).cells.find((c) => c.id === p.cellId)?.cellType;

const prank = CARD_BY_NAME['a023']!;

console.log('=== 前置：数据与卡面一致 ===');
check('a023 的动作序列是 IgnoreCell → SelectOpponent → OpponentSwitchPlaces', () => {
  const types = (prank.actions ?? []).map((a) => String(a.type));
  assert.deepEqual(types, ['IgnoreCell', 'SelectOpponent', 'OpponentSwitchPlaces'],
    `实际 ${types.join(' → ')}`);
});
check('a023 卡面写明"交换后所在位置的规则不会触发"', () => {
  assert.match(prank.text.description, /规则不会触发/, `实际：${prank.text.description}`);
});
check('共 11 张卡用到 IgnoreCell', () => {
  const n = ACTION_CARDS.filter((c) =>
    (c.actions ?? []).some((a) => String(a.type) === 'IgnoreCell')).length;
  assert.equal(n, 11, `实际 ${n}`);
});

console.log('\n=== bug #2：恶作剧交换位置后不再触发建筑 ===');
check('交换后落在办公楼，但**没有**任何可选动作', () => {
  const { st, a, b, map } = buildGame();
  const office = map.cells.find((c) => c.cellType === 'Office')!;
  const risk = map.cells.find((c) => c.cellType === 'Risk')!;
  a.cellId = risk.id;                 // 恶作剧要求在赌博格打出
  b.cellId = office.id;
  a.movedThisTurn = true;
  a.hand = [prank.id];

  const r = playEffectCard(st, a.id, prank.id);
  assert.ok(r.ok, r.reason);
  let g = 0;
  while (st.pending && g++ < 6) {
    const pd = st.pending;
    const pick = pd.kind === 'SelectOpponent' ? [b.id]
      : pd.options.slice(0, Math.max(1, pd.min ?? 1)).map((o) => o.value);
    const rr = resolvePending(st, a.id, pick);
    st.pending = rr.pending;
  }

  assert.equal(cellOf(st, a), 'Office', '应已换到办公楼');
  assert.equal(cellOf(st, b), 'Risk', '对手应换到赌博格');
  assert.equal(a.flags['ignoreCell'], 1, 'ignoreCell 应已置位');

  const opts = availableOptions(st, a.id).map((o) => o.id);
  assert.equal(opts.length, 0,
    `办公楼规则不该触发，实际给出：${opts.join(', ')}`);
  console.log(`      换到 Office，可选动作 ${opts.length} 个（含 office.sellVote 已消失）`);
});

check('对照：没有 ignoreCell 时，办公楼**会**给出卖选票', () => {
  const { st, a, map } = buildGame();
  a.cellId = map.cells.find((c) => c.cellType === 'Office')!.id;
  a.movedThisTurn = true;
  const opts = availableOptions(st, a.id).map((o) => o.id);
  assert.ok(opts.includes('office.sellVote'), `应有 office.sellVote，实际 ${opts.join(', ')}`);
  console.log(`      ${opts.join(', ')}`);
});

check('交换后结束回合，不会结算新落点的规则', () => {
  const { st, a, b, map } = buildGame();
  a.cellId = map.cells.find((c) => c.cellType === 'Risk')!.id;
  b.cellId = map.cells.find((c) => c.cellType === 'Office')!.id;
  a.movedThisTurn = true;
  a.hand = [prank.id];
  playEffectCard(st, a.id, prank.id);
  let g = 0;
  while (st.pending && g++ < 6) {
    const pd = st.pending;
    const pick = pd.kind === 'SelectOpponent' ? [b.id]
      : pd.options.slice(0, Math.max(1, pd.min ?? 1)).map((o) => o.value);
    const rr = resolvePending(st, a.id, pick);
    st.pending = rr.pending;
  }
  const money = a.res.money, income = a.res.income, score = a.res.score;
  skipPlay(st, a.id);
  assert.deepEqual([a.res.money, a.res.income, a.res.score], [money, income, score],
    '新落点（办公楼）的规则不该结算');
});

console.log('\n=== 不变量 ===');
check('ignoreCell 屏蔽**本站全部**选项（含角色能力动作）—— 这是"站点规则不生效"的自然含义', () => {
  // ⚠️ 实测发现的边界：`ignoreCell` 写在 `cellOptions` 最前面，
  // 所以它连"角色能力在该站提供的动作"（如政治家在银行的天界俱乐部）也一并屏蔽。
  // 依据是 a160「好运」的措辞"该站点的规则**不会影响你**" —— 既然本站规则不生效，
  // 本站给出的动作（无论来自格子还是角色能力）都不该出现。
  // 这个取舍记录在此，避免以后被当成 bug 又改回去。
  const { st, a, map } = buildGame(['Politician', 'Banker']);
  a.cellId = map.cells.find((c) => c.cellType === 'Bank')!.id;
  a.movedThisTurn = true;
  a.res.vote = 10;
  const without = availableOptions(st, a.id).map((o) => o.id);
  assert.ok(without.includes('bank.invest'), `无标记时应有 bank.invest：${without.join(', ')}`);
  a.flags['ignoreCell'] = 1;
  const withFlag = availableOptions(st, a.id).map((o) => o.id);
  assert.equal(withFlag.length, 0, `置位后本站不该给任何动作：${withFlag.join(', ')}`);
  console.log(`      无标记 [${without.join(', ')}] → 置位后 [${withFlag.join(', ')}]`);
});

check('ignoreCell 只在当回合有效（回合结束清空 flags）', () => {
  const { st, a, b, map } = buildGame();
  a.cellId = map.cells.find((c) => c.cellType === 'Risk')!.id;
  b.cellId = map.cells.find((c) => c.cellType === 'Office')!.id;
  a.movedThisTurn = true;
  a.hand = [prank.id];
  playEffectCard(st, a.id, prank.id);
  let g = 0;
  while (st.pending && g++ < 6) {
    const pd = st.pending;
    const pick = pd.kind === 'SelectOpponent' ? [b.id]
      : pd.options.slice(0, Math.max(1, pd.min ?? 1)).map((o) => o.value);
    const rr = resolvePending(st, a.id, pick);
    st.pending = rr.pending;
  }
  assert.equal(a.flags['ignoreCell'], 1, '打出后应置位');
  skipPlay(st, a.id);           // 结束回合 → endTurn 清空 flags
  assert.equal(a.flags['ignoreCell'], undefined, '回合结束后应被清空');
  console.log('      回合结束 → 标记已清空（不会污染后续回合）');
});

check('a023 是唯一"交换位置"的卡（Exchange_Perm 是交换永久卡，不同机制）', () => {
  const swappers = ACTION_CARDS.filter((c) =>
    (c.actions ?? []).some((a) => String(a.type) === 'OpponentSwitchPlaces'));
  assert.deepEqual(swappers.map((c) => c.name), ['a023'], `实际 ${swappers.map((c) => c.name).join(',')}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
