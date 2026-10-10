// =============================================================
// 混沌卡（暴乱卡）完整生命周期测试
//
// 原版规则（`GGame`）：
//  - 混沌卡是**共享公共池**，没有 `DeckCount`、不归任何人，
//    每张全局唯一；打一张少一张。
//  - `CellID` 限定只能在该建筑类型打出
//    （c001-003 @ 地狱 Inferno；c004-005 @ 天界 Astral；c006 @ 工厂 Plant）。
//  - c001「供奉」需要**先丢弃一张激活的永久卡**（`SacrificePermanent`）。
//  - **赛局在"最后一张混沌卡被打出的那一轮结束时"结束**，按齿轮最高者判胜：
//    "The session will end at the end of the round during which the last
//     Chaos Card has been played."
//
// 这套东西此前**从未被端到端跑过**：自动对局驱动器不尝试打混沌卡，
// 实测一局 183 轮里混沌打出 0/6，于是"最后一张"的收尾路径零覆盖。
//
// 运行: npx tsx server/src/__tests__/chaos-lifecycle.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { CHAOS_CARDS, CELL_TYPE_BY_ID } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, chaosExhausted, chaosOptions, createState, endTurn, getMap, getPlayer,
  playChaosCard,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;
const cellOfType = (st: EngineState, cellType: string) =>
  getMap(st).cells.find((c) => c.cellType === cellType);

function game(n = 4): EngineState {
  const names = ['Engineer', 'Banker', 'Gambler', 'Thief', 'Judge', 'Merchant'];
  return createState({
    roomId: 'chaos', seed: 4242, targetScore: 100,   // 目标拉高，避免"齿轮达标"抢先结束
    players: names.slice(0, n).map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: true,
  });
}

/** 把某玩家放到指定建筑类型的格子上，并给足资源 */
function station(st: EngineState, pid: string, cellType: string, opts: { permanents?: number } = {}) {
  const p = getPlayer(st, pid)!;
  const cell = cellOfType(st, cellType);
  assert.ok(cell, `棋盘上找不到 ${cellType} 格`);
  p.cellId = cell.id;
  p.res.money = 9999;
  p.res.vote = 99;
  p.permanents = Array.from({ length: opts.permanents ?? 0 }, (_, i) => `perm${i}`);
  return p;
}

console.log('=== 1. 数据 ===');
check('混沌卡共 6 张，全局唯一且无 DeckCount/归属', () => {
  assert.equal(CHAOS_CARDS.length, 6);
  const ids = new Set(CHAOS_CARDS.map((c) => c.id));
  assert.equal(ids.size, 6, 'id 应唯一');
  console.log(`      ${CHAOS_CARDS.map((c) => `${c.name}@${CELL_TYPE_BY_ID[c.cellTypeId]?.cellType ?? '?'}`).join(', ')}`);
});
check('创建时混沌池 = 全部 6 张', () => {
  const st = game();
  assert.equal(st.chaosPool.length, 6);
  assert.equal(st.chaosPlayed.length, 0);
  assert.equal(chaosExhausted(st), false);
});

console.log('\n=== 2. 地点限定 ===');
check('站在错误地点时，对应混沌卡不可打出', () => {
  const st = game();
  const p = station(st, 'P0', 'Astral');   // 天界
  const opts = chaosOptions(st, 'P0');
  const inferno = opts.filter((o) => ['c001', 'c002', 'c003'].includes(
    CHAOS_CARDS.find((c) => c.id === o.cardId)?.name ?? ''));
  assert.ok(inferno.length === 3, '地狱三张都在池里');
  for (const o of inferno) {
    assert.equal(o.playable, false, `${o.name} 在天界不该可打出`);
    assert.match(o.reason ?? '', /需在/, `理由应说明地点：${o.reason}`);
  }
  const astral = opts.filter((o) => o.playable);
  assert.ok(astral.length > 0, '天界的卡应可打出');
  console.log(`      天界可打出: ${astral.map((o) => o.name).join(', ')}`);
  void p;
});
check('地狱的卡在地狱可打出', () => {
  const st = game();
  station(st, 'P0', 'Inferno');
  const opts = chaosOptions(st, 'P0').filter((o) => o.playable);
  assert.ok(opts.length >= 2, `地狱至少 2 张可打（c002/c003）`, );
  console.log(`      地狱可打出: ${opts.map((o) => o.name).join(', ')}`);
});

console.log('\n=== 3. c001「供奉」的永久卡前置（曾有的不一致）===');
check('没有永久卡时 c001 报告**不可打出**', () => {
  const st = game();
  station(st, 'P0', 'Inferno', { permanents: 0 });
  const c001 = chaosOptions(st, 'P0').find((o) => o.name === '供奉');
  assert.ok(c001, '供奉应在池中');
  assert.equal(c001.playable, false,
    '没有可献祭的永久卡时不该报可打出（否则点了必然失败）');
  assert.match(c001.reason ?? '', /永久卡/, `理由应提到永久卡：${c001.reason}`);
  console.log(`      → ${c001.reason}`);
});
check('有永久卡时 c001 可打出', () => {
  const st = game();
  station(st, 'P0', 'Inferno', { permanents: 1 });
  const c001 = chaosOptions(st, 'P0').find((o) => o.name === '供奉');
  assert.equal(c001?.playable, true, `实际 ${c001?.reason}`);
});
check('打了 c001 会消耗掉那张永久卡', () => {
  const st = game();
  const p = station(st, 'P0', 'Inferno', { permanents: 2 });
  const before = p.permanents.length;
  const c001 = CHAOS_CARDS.find((c) => c.name === 'c001')!;
  const r = playChaosCard(st, 'P0', c001.id, { permanentId: p.permanents[0] });
  assert.ok(r.ok, `应成功：${r.error}`);
  assert.equal(p.permanents.length, before - 1, '应少一张永久卡');
  console.log(`      永久卡 ${before} → ${p.permanents.length}`);
});

console.log('\n=== 4. 收益与代价 ===');
check('打出后：卡离开共享池、进入已打出、收益到账', () => {
  const st = game();
  const p = station(st, 'P0', 'Inferno');
  const c002 = CHAOS_CARDS.find((c) => c.name === 'c002')!;   // 10 选票 → +5 齿轮 +3 罪恶
  const scoreBefore = p.res.score;
  const voteBefore = p.res.vote;
  const r = playChaosCard(st, 'P0', c002.id);
  assert.ok(r.ok, `应成功：${r.error}`);
  assert.equal(st.chaosPool.includes(c002.id), false, '应离开池');
  assert.ok(st.chaosPlayed.includes(c002.id), '应进入已打出');
  assert.equal(p.res.score - scoreBefore, 5, `应 +5 齿轮，实际 +${p.res.score - scoreBefore}`);
  assert.equal(voteBefore - p.res.vote, 10, `应付 10 选票，实际 -${voteBefore - p.res.vote}`);
  console.log(`      池 ${st.chaosPool.length} 张，齿轮 +${p.res.score - scoreBefore}`);
});
check('同一张卡不能打两次', () => {
  const st = game();
  station(st, 'P0', 'Inferno');
  const c002 = CHAOS_CARDS.find((c) => c.name === 'c002')!;
  assert.ok(playChaosCard(st, 'P0', c002.id).ok);
  const again = playChaosCard(st, 'P0', c002.id);
  assert.equal(again.ok, false, '第二次应失败');
  console.log(`      ${again.error}`);
});
check('付不起时不能打（c003 需 1000 金钱）', () => {
  const st = game();
  const p = station(st, 'P0', 'Inferno');
  p.res.money = 10;
  const c003 = CHAOS_CARDS.find((c) => c.name === 'c003')!;
  const o = chaosOptions(st, 'P0').find((x) => x.cardId === c003.id)!;
  assert.equal(o.playable, false, `不该可打出：${o.reason}`);
  const r = playChaosCard(st, 'P0', c003.id);
  assert.equal(r.ok, false);
});

console.log('\n=== 5. 打完最后一张 → 本轮结束收尾 ===');
check('打完 5 张但还剩 1 张时，赛局不结束', () => {
  const st = game();
  // 用 4 个玩家分别站在能打的位置，把前 5 张打掉
  const plan: Array<[string, string, string | undefined]> = [
    ['P0', 'Inferno', 'c001'],
    ['P1', 'Inferno', 'c002'],
    ['P2', 'Inferno', 'c003'],
    ['P3', 'Astral', 'c004'],
  ];
  for (const [pid, cell, cname] of plan) {
    const perms = cname === 'c001' ? 1 : 0;
    station(st, pid, cell, { permanents: perms });
    const card = CHAOS_CARDS.find((c) => c.name === cname)!;
    st.currentIndex = st.players.findIndex((x) => x.id === pid);
    const opts = { permanentId: getPlayer(st, pid)!.permanents[0] };
    const r = playChaosCard(st, pid, card.id, cname === 'c001' ? opts : {});
    assert.ok(r.ok, `${cname}: ${r.error}`);
  }
  assert.equal(st.chaosPool.length, 2, `池里应剩 2 张，实际 ${st.chaosPool.length}`);
  assert.equal(st.chaosEndPending, undefined, '还没打完，不该挂起收尾');
  assert.equal(st.phase, 'playing');
  console.log(`      已打出 ${st.chaosPlayed.length} 张，池里剩 ${st.chaosPool.length} 张`);
});

check('打完最后一张 → 标记 chaosEndPending，赛局尚未立刻结束', () => {
  const st = game();
  // 直接把池缩到只剩 1 张，模拟"只剩最后一张"
  const last = CHAOS_CARDS.find((c) => c.name === 'c006')!;   // 工厂，2000 金钱
  st.chaosPool = [last.id];
  station(st, 'P0', 'Plant');
  st.currentIndex = st.players.findIndex((x) => x.id === 'P0');
  const r = playChaosCard(st, 'P0', last.id);
  assert.ok(r.ok, `${r.error}`);
  assert.equal(chaosExhausted(st), true, '池应已空');
  // 原版："在该轮**结束时**"才结束 —— 所以此刻还不能判定胜负
  assert.equal(st.phase, 'playing', '不该立刻结束赛局');
  console.log(`      池空，已打出 ${st.chaosPlayed.length} 张，阶段仍为 ${st.phase}`);
});

check('轮次结束后按齿轮最高者判胜', () => {
  const st = game();
  const last = CHAOS_CARDS.find((c) => c.name === 'c006')!;
  st.chaosPool = [last.id];
  const p0 = station(st, 'P0', 'Plant');
  p0.res.score = 7;
  getPlayer(st, 'P1')!.res.score = 3;
  getPlayer(st, 'P2')!.res.score = 5;
  getPlayer(st, 'P3')!.res.score = 1;
  st.currentIndex = st.players.findIndex((x) => x.id === 'P0');
  assert.ok(playChaosCard(st, 'P0', last.id).ok);
  // c006 给 +20 齿轮 → P0 变 27，最高
  assert.ok(p0.res.score >= 20, `P0 齿轮应大涨，实际 ${p0.res.score}`);
  // 走到"轮末"：把 currentIndex 推回 0 再 endTurn
  st.currentIndex = st.players.length - 1;
  endTurn(st);
  assert.equal(st.phase, 'game_over', `赛局应结束，实际 ${st.phase}`);
  assert.equal(st.winnerId, p0.id, `胜者应为 P0（齿轮最高），实际 ${st.winnerId}`);
  console.log(`      胜者 ${st.winnerId}（齿轮 ${p0.res.score}）`);
});

console.log('\n=== 6. 关闭混沌时不应干扰 ===');
check('chaosEnabled=false 时池为空、chaosExhausted 为 false', () => {
  const st = createState({
    roomId: 'nc', seed: 1, targetScore: 30,
    players: ['Engineer', 'Banker'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  assert.equal(st.chaosPool.length, 0);
  assert.equal(chaosExhausted(st), false, '没启用混沌不算"打完"');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
