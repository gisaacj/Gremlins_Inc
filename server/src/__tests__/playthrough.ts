// =============================================================
// 端到端：用真实数据自动对局 N 个回合
//
// 目的不是验证策略，而是暴露解释器在**真实卡牌组合**下的崩溃/卡死。
// 未实现的 ActionType 会出现在汇总里，用于排优先级。
//
// 运行: npx tsx src/__tests__/playthrough.ts [回合数] [seed]
// =============================================================
import { CARD_BY_ID, CHARACTERS, cellLabel, getCell, mustCurrentPlayer } from '@gremlins/shared/engine';
import {
  canMoveWithCard, canPlayCard, createState, endTurn, playEffectCard,
  resolvePending, startMove, takeJailTurn,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

const ROUNDS = Number(process.argv[2] ?? 12);
const SEED = Number(process.argv[3] ?? 20240601);

const charNames = ['Engineer', 'Banker', 'Gambler', 'Thief'];

const state = createState({
  roomId: 'sim',
  seed: SEED,
  players: charNames.map((c, i) => ({
    id: `P${i}`,
    name: ['Alice', 'Bob', 'Cara', 'Dan'][i],
    isAI: true,
    characterId: CHARACTERS.find((x) => x.name === c)?.id,
  })),
  targetScore: 30,
  chaosEnabled: true,
});

/** 统计日志里出现的"未实现"原语 */
const unimplemented = new Map<string, number>();
const errors: string[] = [];
let decisions = 0;
let moveActions = 0;
let effectActions = 0;
let jailTurns = 0;
let branchesTaken = 0;

function sniff() {
  for (const l of state.log) {
    const m = /效果「(.+?)」尚未实现/.exec(l.text);
    if (m) unimplemented.set(m[1], (unimplemented.get(m[1]) ?? 0) + 1);
  }
}

/** 简单 AI：优先打出可打出的高分牌；否则能移动就移动 */
const moveFailReasons = new Map<string, number>();
const effectFailReasons = new Map<string, number>();
const playedKinds = new Map<string, number>();
const playedDetail: string[] = [];
function bump(map: Map<string, number>, k: string) {
  map.set(k, (map.get(k) ?? 0) + 1);
}

function takeTurn(s: EngineState): void {
  const p = mustCurrentPlayer(s);
  let guard = 0;

  // 0) 服刑回合：抽监狱卡结算，而不是正常走牌
  if (p.inJail) {
    jailTurns++;
    const jr = takeJailTurn(s, p.id);
    if (!jr.ok) errors.push(`takeJailTurn ${p.name}: ${jr.reason}`);
    let g0 = 0;
    while (s.pending && g0++ < 20) {
      const pending = s.pending;
      decisions++;
      const pick = pending.options.slice(0, Math.max(1, pending.min ?? 1)).map((o) => o.value);
      if (!pick.length) break;
      const rr = resolvePending(s, pending.playerId, pick);
      if (!rr.ok) { errors.push(`resolvePending(监狱后) 失败: ${rr.reason}`); break; }
    }
    endTurn(s);
    sniff();
    return;
  }

  // 1) 先处理挂起的决策（随机选一个选项，保证流程能走通）
  while (s.pending && guard++ < 40) {
    const pending = s.pending;
    decisions++;
    const pick = pending.options.slice(0, Math.max(1, pending.min ?? 1)).map((o) => o.value);
    if (!pick.length) break;
    const r = resolvePending(s, pending.playerId, pick);
    if (!r.ok) { errors.push(`resolvePending 失败: ${r.reason}`); break; }
  }

  // 2) 尝试打一张效果卡。
  //    注意：带移动点数的卡同样可以在"它的使用地点"打出效果，
  //    所以这里不能按 move>0 过滤。
  let playedEffect = false;
  for (const id of [...p.hand]) {
    if (!canPlayCard(s, p, id).ok) continue;
    const card = CARD_BY_ID[id];
    const r = playEffectCard(s, p.id, id);
    effectActions++;
    playedEffect = true;
    if (card && playedDetail.length < 12) {
      playedDetail.push(`${card.name}(${card.text.name}) perm=${card.permanent} ok=${r.ok}`);
    }
    if (card) bump(playedKinds, card.permanent ? '永久卡' : card.secret ? '秘密卡' : card.criminal ? '罪恶卡' : '普通卡');
    if (!r.ok) { errors.push(`playEffectCard ${card?.name}: ${r.reason}`); }
    // 处理这张卡产生的决策
    let g2 = 0;
    while (s.pending && g2++ < 20) {
      const pending = s.pending;
      decisions++;
      const pick = pending.options.slice(0, Math.max(1, pending.min ?? 1)).map((o) => o.value);
      if (!pick.length) break;
      const rr = resolvePending(s, pending.playerId, pick);
      if (!rr.ok) { errors.push(`resolvePending(卡后) 失败: ${rr.reason}`); break; }
    }
    break;
  }
  if (!playedEffect) {
    // 记录为何打不出效果卡（归纳成稳定分类，避免把具体地点名当键）
    for (const id of p.hand) {
      const card = CARD_BY_ID[id];
      if (!card) continue;
      const chk = canPlayCard(s, p, id);
      if (chk.ok) continue;
      const r = chk.reason ?? '未知';
      const bucket = r.startsWith('只能在此地点打出') ? '地点不符'
        : r.includes('不足') ? '费用不足'
        : r;
      bump(effectFailReasons, bucket);
    }
  }

  // 3) 移动（挑一张能打出的移动牌）
  const playable = p.hand.filter((id) => canMoveWithCard(p, id).ok);
  if (!playable.length) {
    const reasons = p.hand.map((id) => canMoveWithCard(p, id).reason ?? '可打出');
    for (const r of reasons) bump(moveFailReasons, r.replace(/：.*/, ''));
  }
  const moveCard = playable[0];
  if (moveCard) {
    moveActions++;
    // 移动可能因岔路口多次挂起，逐次应答直到走完。
    // 注意：落点也可能挂起（警察格的"付贿赂/掷骰"），那类要走 resolvePending，
    // 不能一律用 startMove 重入——否则会报"没有进行中的移动"。
    let r = startMove(s, p.id, moveCard);
    let g3 = 0;
    while (r.pending && g3++ < 40) {
      decisions++;
      branchesTaken++;
      const pending = r.pending;
      const pick = pending.options.slice(0, Math.max(1, pending.min ?? 1)).map((o) => o.value);
      if (!pick.length) break;
      if (pending.kind.startsWith('moveBranch:')) {
        r = startMove(s, p.id, moveCard, { [pending.kind]: pick });
      } else {
        const rr = resolvePending(s, pending.playerId, pick);
        if (!rr.ok) { errors.push(`resolvePending(移动落点) 失败: ${rr.reason}`); }
        r = { ok: rr.ok, pending: rr.pending };
      }
    }
    if (!r.ok) { errors.push(`startMove: ${r.reason}`); bump(moveFailReasons, `引擎拒绝: ${r.reason}`); }
  }

  // 4) 结束回合
  endTurn(s);
  sniff();
}

console.log(`=== 自动对局 ===`);
console.log(`玩家: ${state.players.map((p) => `${p.name}(${CHARACTERS.find((c) => c.id === p.characterId)?.text.name})`).join(', ')}`);
console.log(`牌库 ${state.deck.length} 张，种子 ${SEED}，目标 ${state.targetScore} 齿轮\n`);

const t0 = Date.now();
let turns = 0;
try {
  while (state.round <= ROUNDS && state.phase === 'playing' && turns < ROUNDS * state.players.length) {
    if (state.pending) {
      // 安全网：回合外残留的挂起
      const pending = state.pending;
      const pick = pending.options.slice(0, Math.max(1, pending.min ?? 1)).map((o) => o.value);
      if (!pick.length) { state.pending = undefined; continue; }
      resolvePending(state, pending.playerId, pick);
      continue;
    }
    takeTurn(state);
    turns++;
  }
} catch (e) {
  errors.push(`抛出异常: ${(e as Error).message}\n${(e as Error).stack}`);
}

sniff();
const ms = Date.now() - t0;

console.log(`=== 结果 ===`);
console.log(`跑了 ${state.round - 1} 回合 / ${turns} 次行动，耗时 ${ms}ms`);
console.log(`移动 ${moveActions} 次，打出效果卡 ${effectActions} 次，服刑回合 ${jailTurns} 次，岔路选路 ${branchesTaken} 次，处理决策 ${decisions} 次`);
console.log(`阶段: ${state.phase}${state.winnerId ? `，胜者 ${state.winnerId}` : ''}`);
if (state.mayorId) console.log(`镇长: ${state.mayorId}`);
console.log(`\n玩家状态:`);
for (const p of state.players) {
  const cell = getCell(state, p.cellId);
  console.log(
    `  ${p.name.padEnd(6)} 齿轮 ${String(p.res.score).padStart(3)}` +
    ` 金 ${String(p.res.money).padStart(5)} 票 ${String(p.res.vote).padStart(3)}` +
    ` 罪恶 ${String(p.res.malice).padStart(3)} 收入 ${String(p.res.income).padStart(3)}` +
    ` 手牌 ${p.hand.length} 永久 ${p.permanents.length}` +
    ` @ ${cellLabel(cell)}${p.inJail ? ` [狱中 ${p.term}]` : ''}`,
  );
}

if (playedDetail.length) {
  console.log(`\n实际打出的效果卡:`);
  for (const d of playedDetail) console.log(`    ${d}`);
}

if (playedKinds.size) {
  console.log(`\n打出的卡牌类型统计:`);
  for (const [k, n] of [...playedKinds.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}× ${k}`);
  }
}

if (effectFailReasons.size) {
  console.log(`\n无法打出效果卡的原因分布:`);
  for (const [k, n] of [...effectFailReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${String(n).padStart(5)}× ${k}`);
  }
}

if (moveFailReasons.size) {
  console.log(`\n无法移动的原因分布:`);
  for (const [k, n] of [...moveFailReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(4)}× ${k}`);
  }
}

if (unimplemented.size) {
  console.log(`\n未实现的原语（按出现次数）:`);
  for (const [k, n] of [...unimplemented.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}× ${k}`);
  }
  console.log(`  共 ${unimplemented.size} 种`);
} else {
  console.log('\n未实现的原语: 无');
}

if (errors.length) {
  console.log(`\n错误 ${errors.length} 条:`);
  for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
  process.exitCode = 1;
} else {
  console.log('\n无异常');
}

// 基本不变量
const bad: string[] = [];
for (const p of state.players) {
  if (!getCell(state, p.cellId)) bad.push(`${p.name} 位置 ${p.cellId} 不在棋盘上`);
  if (p.res.money < 0) bad.push(`${p.name} 金钱为负 (${p.res.money})`);
  if (p.res.vote < 0) bad.push(`${p.name} 选票为负 (${p.res.vote})`);
  if (p.res.malice < 0) bad.push(`${p.name} 罪恶为负 (${p.res.malice})`);
  if (p.res.score < 0) bad.push(`${p.name} 齿轮为负 (${p.res.score})`);
  if (p.res.income < 0) bad.push(`${p.name} 收入为负 (${p.res.income})`);
}
if (bad.length) {
  console.log(`\n不变量被破坏 ${bad.length} 项:`);
  for (const b of bad) console.log(`  - ${b}`);
  process.exitCode = 1;
} else {
  console.log('不变量检查通过（位置合法、资源非负）');
}
