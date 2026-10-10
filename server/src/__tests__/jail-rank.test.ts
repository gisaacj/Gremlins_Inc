// =============================================================
// 监狱等级（JailRank）系统测试
//
// 依据（反编译源码）：
//  - `GConst.cs`：JAIL_RANK_1..5_TERM = 5 / 7 / 8 / 10 / 3
//  - `GPlayer.GetJailCardLimit()`：n = 2; rank>=2 → ++; rank>=4 → ++
//      ⇒ 2 / 2 / 3 / 3 / 4
//  - `GPlayer.ChangeRes` 的 Term 分支：
//      经验累加到门槛 → 扣掉门槛、JailRank++；
//      rank 已是 4（老大）时再满 → ChangeRes(Score, +1)
//  - 两个字段必须区分：
//      `GPlayer.JailTerm`         = 剩余刑期（还要坐几回合）
//      `GPlayer.Resources.Term`   = 监狱经验（等级进度）
//  - 等级名（`JailRankDetailsPanel`）：新手/农民/恶棍/二把手/老大
//  - 教程："每在狱中待一回合获得 1 点监狱经验"
//
// 运行: npx tsx server/src/__tests__/jail-rank.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  CHARACTERS, JAIL_PICK_KIND, JAIL_RANK_MAX, JAIL_RANK_NAMES, createState, gainJailExp,
  getPlayer, jailCardLimit, jailExpForRank, resolveJailPick, resolvePending, takeJailTurn,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';
import { JAIL_CARDS } from '@gremlins/shared/gamedata';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(seed = 7): EngineState {
  const st = createState({
    roomId: 'jail', seed, targetScore: 30,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
  return st;
}

console.log('=== 1. 常量与门槛（对照 GConst）===');
check('升级经验门槛 = 5 / 7 / 8 / 10 / 3', () => {
  const got = [0, 1, 2, 3, 4].map((r) => jailExpForRank(r));
  assert.deepEqual(got, [5, 7, 8, 10, 3], `实际 ${got.join('/')}`);
  console.log(`      ${got.join(' / ')}`);
});
check('最高等级为 4（老大）', () => {
  assert.equal(JAIL_RANK_MAX, 4);
  assert.equal(JAIL_RANK_NAMES.length, 5);
  assert.equal(JAIL_RANK_NAMES[4], '老大');
  console.log(`      等级名: ${JAIL_RANK_NAMES.join(' / ')}`);
});
check('每回合可选监狱牌数 = 2 / 2 / 3 / 3 / 4', () => {
  const got = [0, 1, 2, 3, 4].map((r) => jailCardLimit(r));
  assert.deepEqual(got, [2, 2, 3, 3, 4], `实际 ${got.join('/')}`);
  console.log(`      ${got.join(' / ')}`);
});

console.log('\n=== 2. 经验累积与升级 ===');
check('新玩家初始 rank=0、经验=0', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  assert.equal(p.jailRank, 0);
  assert.equal(p.jailExp, 0);
});
check('经验累加但不升级时保持不变', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  gainJailExp(st, p, 3);
  assert.equal(p.jailExp, 3, `实际 ${p.jailExp}`);
  assert.equal(p.jailRank, 0);
});
check('达到门槛 5 → rank 1，经验清零', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  const r = gainJailExp(st, p, 5);
  assert.equal(p.jailRank, 1, `实际 rank=${p.jailRank}`);
  assert.equal(p.jailExp, 0, `实际 exp=${p.jailExp}`);
  assert.equal(r.rankedUp, 1);
  console.log(`      rank 0 → 1（${JAIL_RANK_NAMES[1]}）`);
});
check('超出部分保留（6 点 → rank1 + 剩 1 点）', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  gainJailExp(st, p, 6);
  assert.equal(p.jailRank, 1);
  assert.equal(p.jailExp, 1, `实际 ${p.jailExp}`);
});
check('一次加大量可连升多级', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  // 5 → rank1；再 7 → rank2；再 8 → rank3；共 20 点
  gainJailExp(st, p, 20);
  assert.equal(p.jailRank, 3, `实际 rank=${p.jailRank}`);
  assert.equal(p.jailExp, 0, `实际 exp=${p.jailExp}`);
  console.log(`      20 点经验 → rank 3（${JAIL_RANK_NAMES[3]}）`);
});
check('4 次升级后到达老大（rank 4）', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  // 5+7+8+10 = 30
  gainJailExp(st, p, 30);
  assert.equal(p.jailRank, 4, `实际 rank=${p.jailRank}`);
  assert.equal(p.jailExp, 0, `实际 exp=${p.jailExp}`);
  console.log(`      30 点经验 → rank 4（${JAIL_RANK_NAMES[4]}）`);
});

console.log('\n=== 3. 满级后换齿轮（原版 ChangeRes case Term）===');
check('已是老大后再满 3 点 → +1 齿轮', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  gainJailExp(st, p, 30);          // → rank 4
  const before = p.res.score;
  const r = gainJailExp(st, p, 3); // 门槛 3
  assert.equal(p.res.score, before + 1, `齿轮 ${before} → ${p.res.score}`);
  assert.equal(r.scoreGained, 1);
  console.log(`      齿轮 ${before} → ${p.res.score}`);
});
check('老大阶段 9 点经验 → +3 齿轮', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  gainJailExp(st, p, 30);
  const before = p.res.score;
  gainJailExp(st, p, 9);
  assert.equal(p.res.score, before + 3, `齿轮 ${before} → ${p.res.score}`);
});
check('老大阶段经验不满 3 点时不给齿轮', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  gainJailExp(st, p, 30);
  const before = p.res.score;
  gainJailExp(st, p, 2);
  assert.equal(p.res.score, before, '不该给齿轮');
  assert.equal(p.jailExp, 2);
});

console.log('\n=== 4. 两个字段必须区分（易错点）===');
check('jailExp 增长不影响剩余刑期 term', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.inJail = true;
  p.term = 3;
  p.jailRank = 0;
  gainJailExp(st, p, 5);
  assert.equal(p.term, 3, `term 不该被经验改动，实际 ${p.term}`);
  assert.equal(p.jailRank, 1, 'rank 应提升');
});
check('takeJailTurn 会挂起让玩家选牌，选完才推进刑期与经验', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.inJail = true;
  p.term = 3;
  st.currentIndex = st.players.indexOf(p);

  const r = takeJailTurn(st, 'p0');
  assert.ok(r.ok, r.reason ?? '');
  // 候选 ≥2 时挂起等待选择（原版是"从 N 张里选一张"）
  if (r.pending) {
    assert.equal(r.pending.kind, JAIL_PICK_KIND, `kind=${r.pending.kind}`);
    assert.equal(p.term, 3, '还没选牌，刑期不该变');
    const pick = r.pending.options.find((o) => o.value !== 'jailDecline')!;
    const rr = resolveJailPick(st, 'p0', pick.value);
    assert.ok(rr.ok, rr.reason ?? '');
    console.log(`      候选 ${r.pending.options.length - 1} 张 → 选「${pick.label.slice(0, 12)}…」`);
  }
  assert.equal(p.term, 2, `刑期应 3 → 2，实际 ${p.term}`);
  assert.equal(p.jailExp, 1, `经验应为 1，实际 ${p.jailExp}`);
  console.log(`      刑期 → ${p.term}，经验 → ${p.jailExp}`);
});
check('服刑 5 回合后应升到 rank 1', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.inJail = true;
  p.term = 999;                   // 保证 5 回合内不出狱
  // ⚠️ 必须**固定牌堆**：监狱牌里有「特赦」等直接释放的牌，
  // 抽到就会提前出狱，导致这个用例变成看运气（之前正因洗牌顺序变化而失败）。
  // 这里只留"不会释放"的牌，把变量控制在"经验累积"这一件事上。
  const RELEASE_ACTIONS = new Set(['Freedom', 'PayTerm']);
  const safeIds = JAIL_CARDS
    .filter((c) => !c.actions.some((a) => RELEASE_ACTIONS.has(String(a.type))))
    .map((c) => c.id);

  for (let i = 0; i < 5; i++) {
    st.currentIndex = st.players.indexOf(p);
    if (!p.inJail) break;
    st.jailDeck = [...safeIds];   // 重置成"安全牌堆"，避免抽到释放牌
    const r = takeJailTurn(st, 'p0');
    if (r.pending?.kind === JAIL_PICK_KIND) {
      const pick = r.pending.options.find((o) => o.value !== 'jailDecline')!;
      resolveJailPick(st, 'p0', pick.value);
    }
    // 清掉卡牌动作产生的其它挂起，让循环能继续
    let g = 0;
    while (st.pending && g++ < 20) {
      const pd = st.pending;
      const v = pd.options[0]?.value ?? 'x';
      const rr = resolvePending(st, pd.playerId, [v]);
      st.pending = rr.pending;
    }
  }
  assert.equal(p.inJail, true, '不该在这个用例里出狱');
  assert.equal(p.jailRank, 1, `实际 rank=${p.jailRank}，经验=${p.jailExp}`);
  console.log(`      5 回合后 rank=${p.jailRank}（${JAIL_RANK_NAMES[p.jailRank]}），经验 ${p.jailExp}`);
});

console.log('\n=== 4b. 候选抽取受 Rank/Karma 约束 ===');
check('候选张数 = jailCardLimit(rank)', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.inJail = true;
  p.term = 99;
  p.jailRank = 0;
  st.currentIndex = st.players.indexOf(p);
  const r = takeJailTurn(st, 'p0');
  const n = (r.pending?.options.length ?? 2) - (r.pending ? 1 : 0);
  assert.equal(n, jailCardLimit(0), `rank0 应给 ${jailCardLimit(0)} 张，实际 ${n}`);
  console.log(`      rank0 → ${n} 张候选（含"全部拒绝"共 ${r.pending?.options.length} 项）`);
});
check('候选不会包含未解锁的高等级牌（rank+1 以上）', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.inJail = true;
  p.term = 99;
  p.jailRank = 0;
  st.currentIndex = st.players.indexOf(p);
  const r = takeJailTurn(st, 'p0');
  if (r.pending) {
    for (const o of r.pending.options) {
      if (o.value === 'jailDecline') continue;
      const c = JAIL_CARDS.find((x) => x.id === o.value)!;
      assert.ok((c.rank ?? 1) <= 1, `rank0 不该出现 rank${c.rank} 的「${c.text.name}」`);
    }
    console.log('      候选全部 rank ≤ 1');
  }
});
check('「全部拒绝」→ +1 罪恶、刑期 −1', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.inJail = true;
  p.term = 5;
  p.res.malice = 0;
  st.currentIndex = st.players.indexOf(p);
  const r = takeJailTurn(st, 'p0');
  if (r.pending) {
    resolveJailPick(st, 'p0', 'jailDecline');
    assert.equal(p.res.malice, 1, `罪恶应为 1，实际 ${p.res.malice}`);
    assert.equal(p.term, 4, `刑期应为 4，实际 ${p.term}`);
    console.log(`      罪恶 0 → ${p.res.malice}，刑期 5 → ${p.term}`);
  } else {
    // 只抽到单张时不会挂起，此分支不适用
    console.log('      （本回合只有单张候选，跳过）');
  }
});

console.log('\n=== 5. 不变量 ===');
check('经验/等级在长跑中不越界、不死循环', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  gainJailExp(st, p, 100000);
  assert.ok(p.jailRank <= JAIL_RANK_MAX, `rank 越界：${p.jailRank}`);
  assert.ok(p.jailExp >= 0 && p.jailExp < jailExpForRank(p.jailRank),
    `经验应在 [0, 门槛) 内：${p.jailExp}/${jailExpForRank(p.jailRank)}`);
  console.log(`      10 万点经验 → rank ${p.jailRank}，齿轮 +${p.res.score}`);
});
check('amount <= 0 时不改变任何东西', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  gainJailExp(st, p, 0);
  gainJailExp(st, p, -5);
  assert.equal(p.jailExp, 0);
  assert.equal(p.jailRank, 0);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
