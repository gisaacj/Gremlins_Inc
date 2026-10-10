// =============================================================
// 两个 UI/交互层 bug 的回归测试
//
//  bug #4：交锋出价只能从固定档位里挑（原版是自己填金额）
//  bug #5：需要选玩家的卡要求玩家选两次
//
// 运行: npx tsx server/src/__tests__/interaction.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { CARD_BY_NAME } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, buildEnginePrompt, createState, getMap, getPlayer, playCard,
  resolvePending, startConflict,
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
    roomId: 'ia', seed: 11, targetScore: 999,
    players: names.map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = 1000; p.res.malice = 0; p.res.vote = 3;
    p.res.income = 30; p.hand = []; p.inJail = false;
  }
  st.currentIndex = st.players.indexOf(getPlayer(st, 'P0')!);
  return st;
}

/** 把玩家放到该卡允许打出的地点，并只手握该牌 */
function armCard(st: EngineState, cardName: string) {
  const card = CARD_BY_NAME[cardName]!;
  const p = getPlayer(st, 'P0')!;
  const map = getMap(st);
  const allowed = map.cells.find((c) => c.cellTypeId === card.cellTypeId);
  if (allowed) p.cellId = allowed.id;
  p.hand = [card.id];
  return { p, card };
}

// ─────────────────────────────────────────────────────────────
console.log('=== bug #4：交锋出价支持自定义金额 ===');

check('交锋挂起会附带 numeric 上限（= 出价者自己的金钱）', () => {
  const st = game(['Banker', 'Engineer']);
  const a = getPlayer(st, 'P0')!;
  const b = getPlayer(st, 'P1')!;
  a.res.money = 275;              // 刻意用非整百，验证"任意金额"
  b.res.money = 500;
  startConflict(st, a, b);

  const p = buildEnginePrompt(st, 'P0');
  assert.equal(p?.type, 'choose');
  assert.ok(p?.numeric, '应带 numeric（否则界面只能给固定档位）');
  assert.equal(p.numeric!.min, 0);
  assert.equal(p.numeric!.max, 275, `上限应为自己金钱 275，实际 ${p.numeric!.max}`);
  console.log(`      numeric = ${JSON.stringify(p.numeric)}`);
});

check('引擎接受任意金额（137）', () => {
  const st = game(['Banker', 'Engineer']);
  const a = getPlayer(st, 'P0')!;
  const b = getPlayer(st, 'P1')!;
  a.res.money = 275; b.res.money = 500;
  startConflict(st, a, b);
  const r = resolvePending(st, a.id, ['137']);
  assert.ok(r.ok, r.reason);
  const stored = Object.entries(st.pendingInput ?? {})
    .find(([k]) => k.endsWith(`:${a.id}`));
  assert.equal(stored?.[1], '137', `实际存储 ${JSON.stringify(st.pendingInput)}`);
  console.log(`      出价 137 被接受并存储`);
});

check('超额出价被夹到上限（防"喊出付不起的价"）', () => {
  const st = game(['Banker', 'Engineer']);
  const a = getPlayer(st, 'P0')!;
  const b = getPlayer(st, 'P1')!;
  a.res.money = 100; b.res.money = 500;
  startConflict(st, a, b);
  resolvePending(st, a.id, ['9999']);
  const stored = Object.entries(st.pendingInput ?? {})
    .find(([k]) => k.endsWith(`:${a.id}`));
  assert.equal(stored?.[1], '100', `应夹到 100，实际 ${stored?.[1]}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== bug #5：选玩家的卡只需选一次 ===');

const TARGET_CARDS = ['a001', 'a046', 'a047', 'a051', 'a068', 'a098'];

check('带目标打出后不再二次挂起（3 人局才有多目标可选）', () => {
  // ⚠️ 必须用 **3 人局**：`SelectOpponent` 在"只剩一个合法目标"时会**自动选中**
  // 而不挂起（见 interp.ts 的 handleSelect），所以 2 人局下这条断言永远为真、
  // 测不出问题。3 人局才会真正弹出选人框。
  for (const name of TARGET_CARDS) {
    const st = game();
    const { p } = armCard(st, name);
    const cardId = p.hand[0]!;

    // 先确认：不带目标时**确实**会挂起（否则下面的断言没有意义）
    const stProbe = game();
    const probe = armCard(stProbe, name);
    playCard(stProbe, probe.p.id, probe.p.hand[0]!);
    assert.equal(stProbe.pending?.kind, 'SelectOpponent',
      `${name}: 3 人局不带目标时应挂起 SelectOpponent，实际 ${stProbe.pending?.kind ?? '(无)'}`);

    const target = st.players.find((x) => x.id !== p.id)!;
    const r = playCard(st, p.id, cardId, target.id);
    assert.ok(r.ok, `${name}: ${r.error}`);
    // 卡牌自身仍可能产生**别的**挂起（如 a098 的 BUTTON）；
    // 关键是**不再是 SelectOpponent**（那才是"又让选一次人"）。
    const kind = st.pending?.kind ?? '';
    assert.notEqual(kind, 'SelectOpponent',
      `${name} 不该再要求选一次对手，实际挂起 ${kind}`);
  }
  console.log(`      ${TARGET_CARDS.length} 张卡均未二次要求选人`);
});

check('对照：不带目标时仍会正常挂起 SelectOpponent（兜底没坏）', () => {
  const st = game();
  const { p } = armCard(st, 'a001');
  const cardId = p.hand[0]!;
  const r = playCard(st, p.id, cardId);        // 故意不传 target
  assert.ok(r.ok, r.error);
  assert.equal(st.pending?.kind, 'SelectOpponent',
    `不带目标应挂起 SelectOpponent，实际 ${st.pending?.kind ?? '(无)'}`);
  console.log('      不带目标 → 仍挂起 SelectOpponent');
});

check('目标确实生效（a001 扣目标选票）', () => {
  const st = game();
  const { p } = armCard(st, 'a001');
  const cardId = p.hand[0]!;
  const target = st.players.find((x) => x.id !== p.id)!;
  target.res.vote = 3;
  playCard(st, p.id, cardId, target.id);
  assert.equal(target.res.vote, 2, `目标应 3 → 2，实际 ${target.res.vote}`);
});

check('目标非法时回退成正常挂起（不会卡死）', () => {
  const st = game();
  const { p } = armCard(st, 'a001');
  const cardId = p.hand[0]!;
  const r = playCard(st, p.id, cardId, 'NOT_A_PLAYER');
  assert.ok(r.ok, `不该失败：${r.error}`);
  // 非法目标无法应答 → 保留原挂起，玩家可以重新选
  assert.ok(st.pending === undefined || st.pending.kind === 'SelectOpponent',
    `应回退成 SelectOpponent 或已结束，实际 ${st.pending?.kind ?? '(无)'}`);
  console.log(`      非法目标 → ${st.pending?.kind ?? '(无需再选)'}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
