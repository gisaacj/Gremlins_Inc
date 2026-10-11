// =============================================================
// 基础功能矩阵 ①：**每张牌都能移动**
//
// 与"按 bug 写用例"不同：这里**穷举全部行动卡**，逐张验证"用它移动"这条
// 最基本的路径。
//
// 对每张行动卡检查：
//   A. 元数据自洽（id / 名称 / move / specialMove 不矛盾）
//   B. 有移动点数的卡：`canMoveWithCard` 必须放行
//   C. 没有移动点数且非特殊牌：必须**明确拒绝**（不能"能点但走不动"）
//   D. 逐张真走一步：要么成功、要么给明确原因；落点合法、步数一致、
//      走完后不会留下"既无提示也无挂起"的死局
//
// 运行: npx tsx server/src/__tests__/matrix-card-move.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, answerChoice, availableOptions, buildEnginePrompt, canMoveWithCard, createState,
  finishTurnActions, getMap, getPlayer, moveWithCard, movableCards, nextTurn, playableCards,
} from '@gremlins/shared/engine';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function fresh(seed = 1): { st: EngineState; a: EnginePlayer } {
  const st = createState({
    roomId: 'm1', seed, targetScore: 999,
    players: ['Banker', 'Engineer', 'Gambler'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = 5000; p.res.vote = 50; p.hand = []; p.inJail = false;
    p.res.malice = 0; p.res.score = 10; p.term = 0;
  }
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  for (const id of ['P1', 'P2']) getPlayer(st, id)!.cellId = map.cells.find((c) => c.cellType === 'Jail')!.id;
  st.currentIndex = st.players.indexOf(a);
  a.cellId = map.cells.find((c) => c.out.length > 0)!.id;
  return { st, a };
}

/** 与服务端/LocalGame 等价的收尾 */
function settle(st: EngineState, viewerId: string) {
  let prompt = buildEnginePrompt(st, viewerId);
  if (prompt || st.phase !== 'playing') return prompt;
  finishTurnActions(st);
  if (!st.pending) nextTurn(st);
  return buildEnginePrompt(st, viewerId);
}

/** 一路应答到底，返回最终提示 */
function drain(st: EngineState, pid: string) {
  let prompt = settle(st, pid);
  let g = 0;
  while (st.pending && g++ < 30) {
    const pend = st.pending;
    const rr = answerChoice(st, pend.playerId, pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value));
    st.pending = rr.pending;
    if (!rr.ok) break;
    prompt = settle(st, pid);
  }
  return prompt;
}

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const cards = ACTION_CARDS;
console.log(`=== ① 每张牌都能移动（穷举 ${cards.length} 张行动卡）===`);

check('A. 元数据自洽（id / 名称 / move / specialMove 组合合理）', () => {
  const bad: string[] = [];
  for (const c of cards) {
    if (!c.id) bad.push(`${c.name}: 缺 id`);
    if (!c.text?.name) bad.push(`${c.name}: 缺名称`);
    if (typeof c.move !== 'number') bad.push(`${c.name}: move 不是数字`);
    if (c.move < 0) bad.push(`${c.name}: move 为负 (${c.move})`);
    // `move === 0` 的卡必须靠 specialMove 才能用于移动（如 a022 掷骰、a059 弃牌）
    // 反之 `move > 0` 时 specialMove 是无关标记（17 张带它的卡里 15 张 move>0）
    if (c.move === 0 && !c.specialMove) {
      const chk = canMoveWithCard({ hand: [c.id] } as never, c.id);
      if (chk.ok) bad.push(`${c.name}: move=0 且非 specialMove，却被判为可移动`);
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      特殊移动牌（move=0 + specialMove）：`
    + cards.filter((c) => c.move === 0 && c.specialMove).map((c) => c.name).join(', '));
});

check(`B. 全部有移动点数的卡都能被用于移动`, () => {
  const movable = cards.filter((c) => c.move > 0);
  const bad: string[] = [];
  for (const c of movable) {
    const { a } = fresh();
    a.hand = [c.id];
    const chk = canMoveWithCard(a, c.id);
    if (!chk.ok) bad.push(`${c.name}「${c.text.name}」move=${c.move} → 被拒：${chk.reason}`);
  }
  assert.equal(bad.length, 0,
    `有移动点数却被拒（${bad.length} 张）：\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      ${movable.length} 张全部放行`);
});

check('C. 没有移动点数且非特殊牌必须明确拒绝（且有原因）', () => {
  const immobile = cards.filter((c) => c.move <= 0 && !c.specialMove);
  const bad: string[] = [];
  for (const c of immobile) {
    const { a } = fresh();
    a.hand = [c.id];
    const chk = canMoveWithCard(a, c.id);
    if (chk.ok) bad.push(`${c.name}「${c.text.name}」move=0 → 却被放行`);
    if (!chk.reason) bad.push(`${c.name}: 被拒但没有原因文案`);
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      ${immobile.length} 张全部被明确拒绝`);
});

check('D. 逐张真走一步（落点合法 / 步数一致 / 不卡死）', () => {
  const bad: string[] = [];
  let moved = 0;
  const refused: string[] = [];
  for (const c of cards) {
    const { st, a } = fresh();
    a.hand = [c.id];
    const from = a.cellId;
    const dest = getMap(st).cells.find((x) => x.id === from)!.out[0];
    const r = moveWithCard(st, a.id, c.id, dest);

    if (!r.ok) {
      if (!r.error) bad.push(`${c.name}「${c.text.name}」被拒但无原因`);
      else refused.push(`${c.name}(move=${c.move}${c.specialMove ? ',special' : ''})`);
      continue;
    }
    moved++;
    const landed = getMap(st).cells.find((x) => x.id === a.cellId);
    if (!landed) { bad.push(`${c.name}「${c.text.name}」落点不是合法格：${a.cellId}`); continue; }
    if (!c.specialMove && c.move > 0 && a.lastMoveSteps !== c.move) {
      bad.push(`${c.name}: 步数应为 ${c.move}，实际 ${a.lastMoveSteps}`);
      continue;
    }
    const prompt = drain(st, a.id);
    const nowMine = st.players[st.currentIndex]!.id === a.id;
    if (!st.pending && prompt === null && nowMine && !a.inJail
      && movableCards(st, a.id).length === 0
      && playableCards(st, a.id).length === 0
      && availableOptions(st, a.id).length === 0) {
      bad.push(`${c.name}「${c.text.name}」走完卡死（落点=${landed.cellType}）`);
    }
  }
  assert.equal(bad.length, 0,
    `逐张走牌发现问题（${bad.length} 张）：\n      ${bad.slice(0, 12).join('\n      ')}`);
  console.log(`      成功 ${moved} 张 / 明确拒绝 ${refused} 张 / 0 卡死`);
});

console.log(`\n通过 ${pass} 组，失败 ${fail} 组（覆盖 ${cards.length} 张行动卡）`);
if (fail > 0) process.exitCode = 1;
