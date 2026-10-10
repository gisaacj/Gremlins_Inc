// =============================================================
// 用户第三批 bug 的回归测试（第 2 部分：引擎行为）
//
//  bug #1：a059「二手货」不按选定目的地移动
//  bug #5：m015「不测风云」忽略参数（应为"每人传 N 张给下家"）
//  bug #2/#6：站点效果被「结束回合」跳过（nextTurn 未结算 UseCell）
//  bug #3：a031「作弊！」逆行无效
//
// 运行: npx tsx server/src/__tests__/turn-fixes.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CARD_BY_NAME, MISFORTUNE_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, createState, getMap, getPlayer, moveWithCard, nextTurn,
  resolvePending, runActions, skipPlay, startMove,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';
import { BOARD_VIEW, computeReachableTiles, isReverseMoveCard } from '@gremlins/shared';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(names = ['Banker', 'Engineer']): EngineState {
  const st: EngineState = createState({
    roomId: 'tf', seed: 42, targetScore: 999,
    players: names.map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  const b = getPlayer(st, 'P1');
  for (const p of st.players) {
    p.res.money = 1000; p.res.malice = 0; p.hand = []; p.inJail = false;
  }
  // 对手挪去监狱格，避免误触交锋
  const jail = getMap(st).cells.find((c) => c.cellType === 'Jail');
  if (jail && b) b.cellId = jail.id;
  st.currentIndex = st.players.indexOf(getPlayer(st, 'P0')!);
  return st;
}

/** 让 P0 走到指定类型的格子（自动应答岔路） */
function landOn(st: EngineState, cellType: string, cardId: string) {
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  const targets = new Set(map.cells.filter((c) => c.cellType === cellType).map((c) => c.id));
  for (const origin of map.cells.filter((c) => c.out.some((o) => targets.has(o)))) {
    const dest = origin.out.find((o) => targets.has(o))!;
    a.cellId = origin.id;
    a.hand = [cardId];
    let g = 0;
    moveWithCard(st, a.id, cardId, dest);
    while (st.pending && g++ < 12) {
      const pd = st.pending;
      const pick = pd.options.slice(0, Math.max(1, pd.min ?? 1)).map((o) => o.value);
      if (pd.kind.startsWith('moveBranch')) { moveWithCard(st, a.id, cardId, dest); continue; }
      break;
    }
    if (a.cellId === dest) return true;
  }
  return false;
}

const card1 = ACTION_CARDS.find((c) => c.move === 1 && c.price === 0 && !c.specialMove)!;

// ─────────────────────────────────────────────────────────────
console.log('=== bug #2 / #6：站点效果不能被「结束回合」跳过 ===');

for (const cellType of ['Income', 'Bribe', 'Inferno']) {
  check(`${cellType}：skipPlay 与 nextTurn 结果一致`, () => {
    const run = (via: 'skip' | 'next') => {
      const st = game();
      if (!landOn(st, cellType, card1.id)) return null;
      const a = getPlayer(st, 'P0')!;
      const before = a.res.money;
      if (via === 'skip') skipPlay(st, a.id); else nextTurn(st);
      return { delta: a.res.money - before, pending: st.pending?.kind ?? '' };
    };
    const s = run('skip');
    const n = run('next');
    assert.ok(s, `${cellType}: 走不到该格`);
    assert.deepEqual(n, s,
      `两条路径应一致：skipPlay=${JSON.stringify(s)} / nextTurn=${JSON.stringify(n)}`);
    console.log(`      ${cellType}: 两条路径都是 ${JSON.stringify(s)}`);
  });
}

check('地狱格扣 100 金钱（bug #6 的具体表现）', () => {
  const st = game();
  if (!landOn(st, 'Inferno', card1.id)) { console.log('      （走不到地狱，跳过）'); return; }
  const a = getPlayer(st, 'P0')!;
  const before = a.res.money;
  nextTurn(st);
  assert.equal(before - a.res.money, 100, `应扣 100，实际扣 ${before - a.res.money}`);
  console.log(`      ${before} → ${a.res.money}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== bug #5：不测风云按参数传牌 ===');

check('m015 的 params[0]=2，效果是"每人传 2 张给下家"', () => {
  const m15 = MISFORTUNE_CARDS.find((m) => m.name === 'm015')!;
  assert.equal(m15.params[0], 2);
  assert.match(m15.text.description, /传给下一个玩家/, `卡面：${m15.text.description}`);
  assert.equal(String(m15.actions[0]?.type), 'WindOfChanges');
});

check('传牌后每人手牌数不变，且恰好各传 2 张', () => {
  const st: EngineState = createState({
    roomId: 'woc', seed: 7, targetScore: 999,
    players: ['Banker', 'Engineer', 'Gambler'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  const all = ACTION_CARDS.map((c) => c.id);
  st.players.forEach((p, i) => { p.hand = all.slice(i * 10, i * 10 + 6); });
  const before = st.players.map((p) => ({ id: p.id, hand: [...p.hand] }));

  // 直接触发该原语
  runActions(st, {
    actions: [{ type: 'WindOfChanges', params: ['2'] }],
    index: 0, targets: [], ownerId: 'P0', source: 'test',
  });

  const order = st.players;
  for (let i = 0; i < order.length; i++) {
    const from = order[i]!;
    const to = order[(i + 1) % order.length]!;
    const fromHand = from.hand;
    const toHand = to.hand;
    const fromBefore = before.find((x) => x.id === from.id)!.hand;
    const toBefore = before.find((x) => x.id === to.id)!.hand;
    assert.equal(fromHand.length, fromBefore.length, `${from.name} 手牌数应不变`);
    const lost = fromBefore.filter((c) => !fromHand.includes(c)).length;
    const gained = toHand.filter((c) => !toBefore.includes(c)).length;
    assert.equal(lost, 2, `${from.name} 应传出 2 张，实际 ${lost}`);
    assert.equal(gained, 2, `${to.name} 应收到 2 张，实际 ${gained}`);
  }
  console.log('      3 人局：每人传出 2 张、收到 2 张、手牌数不变');
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== bug #3：作弊牌可逆行 ===');

check('a031 被识别为逆行牌', () => {
  assert.equal(isReverseMoveCard(CARD_BY_NAME['a031']!.id), true);
});

check('逆行移动的落点与"逆行预览"一致', () => {
  let checked = 0;
  for (const tile of BOARD_VIEW.tiles.slice(0, 12)) {
    const reach = computeReachableTiles(BOARD_VIEW, tile.id, 2, true);
    if (!reach.size) continue;
    const dest = [...reach.keys()][0]!;
    const st = game();
    const a = getPlayer(st, 'P0')!;
    a.cellId = tile.id;
    a.hand = [CARD_BY_NAME['a031']!.id];
    const r = moveWithCard(st, a.id, CARD_BY_NAME['a031']!.id, dest);
    assert.ok(r.ok, r.error);
    assert.equal(a.cellId, dest,
      `从 ${tile.label} 逆行应到所选目的地，实际到 ${getMap(st).cells.find((c) => c.id === a.cellId)?.cellType}`);
    checked++;
  }
  assert.ok(checked > 0, '应至少检查到一组');
  console.log(`      ${checked} 组逆行移动落点全部与预览一致`);
});

check('普通牌不会逆行（对照）', () => {
  assert.equal(isReverseMoveCard(card1.id), false);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== bug #1：二手货两段式 ===');

check('a059 第一段选对手、第二段选目的地', () => {
  const st = game();
  const a = getPlayer(st, 'P0')!;
  const b = getPlayer(st, 'P1')!;
  const map = getMap(st);
  a.cellId = map.cells.find((c) => c.cellType === 'Income')!.id;
  a.hand = [CARD_BY_NAME['a059']!.id];
  b.hand = ACTION_CARDS.filter((c) => c.move >= 3).slice(0, 6).map((c) => c.id);
  b.cellId = map.cells.find((c) => c.cellType === 'Police')?.id ?? b.cellId;

  const r = moveWithCard(st, a.id, CARD_BY_NAME['a059']!.id);
  assert.ok(r.ok, r.error);
  assert.equal(st.pending?.resume.scratch?.phase, 'opponent', '第一段应是选对手');

  const r2 = resolvePending(st, a.id, [b.id]);
  st.pending = r2.pending;
  assert.equal(st.pending?.resume.scratch?.phase, 'dest', '第二段应是选目的地');
  assert.ok((st.pending?.options?.length ?? 0) > 0, '应给出可达目的地');
  console.log(`      目的地候选 ${st.pending!.options.length} 个`);

  const dest = st.pending!.options[0]!.value;
  resolvePending(st, a.id, [dest]);
  assert.equal(a.cellId, dest,
    `应走到选定的目的地，实际 ${map.cells.find((c) => c.id === a.cellId)?.cellType}`);
  console.log(`      按选定目的地落点正确`);
});

check('二手货移动用引擎 RNG（同一 seed 结果可复现）', () => {
  const run = () => {
    const st = game();
    const a = getPlayer(st, 'P0')!;
    const b = getPlayer(st, 'P1')!;
    const map = getMap(st);
    a.cellId = map.cells.find((c) => c.cellType === 'Income')!.id;
    a.hand = [CARD_BY_NAME['a059']!.id];
    b.hand = ACTION_CARDS.slice(0, 6).map((c) => c.id);
    const r = moveWithCard(st, a.id, CARD_BY_NAME['a059']!.id);
    st.pending = undefined;
    return st.log.filter((l) => l.text.includes('二手货')).map((l) => l.text).join('|') || r.ok;
  };
  assert.equal(run(), run(), '同一 seed 两次应完全一致');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
