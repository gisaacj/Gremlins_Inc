// =============================================================
// 过站挂起后「回合推进」的回归测试
//
// 用户实测的卡死场景：
//   "我刚刚移动到警察站点，路过厄运，触发完厄运之后，手牌全灰的，
//    不能打牌，也没触发站点效果，卡死在这了"
//
// 根因：`maybeAutoEnd` 用 `r.ok ? ok() : fail(...)` 处理 `nextTurn` 的结果，
// 把失败**连同刚创建的挂起一起丢掉**。而 `nextTurn` 会先调
// `finishTurnActions` 结算欠着的格子效果；若该效果自己挂起
// （警察格问"付贿赂还是掷骰"、冒险格问保险），`nextTurn` 返回失败，
// 但**挂起已经创建**。结果调用方拿不到挂起 → 界面 prompt=null、无可点按钮。
//
// 运行: npx tsx server/src/__tests__/turn-resume.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, answerChoice, buildEnginePrompt, createState, getMap, getPlayer,
  moveWithCard, playableCards, availableOptions, currentPlayerId, runAIPlayers,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function mk(seed = 11, money = 500): EngineState {
  const st = createState({
    roomId: 'tr', seed, targetScore: 999,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) { p.res.money = money; p.hand = []; p.inJail = false; p.res.malice = 0; }
  const map = getMap(st);
  getPlayer(st, 'P1')!.cellId = map.cells.find((c) => c.cellType === 'Jail')!.id;
  st.currentIndex = st.players.indexOf(getPlayer(st, 'P0')!);
  return st;
}

console.log('=== 卡死的真正根因：answerChoice 吞掉新产生的挂起 ===');

check('结算格子效果时新产生的挂起，必须出现在 answerChoice 的返回值里', () => {
  // 复刻缺陷路径：
  //   answerChoice -> maybeAutoEnd -> nextTurn -> finishTurnActions
  // 手工把状态摆成"站在警察格、已移动、格子效果欠着、另有一个待应答项"，
  // 然后调用 answerChoice，断言返回值里带着新挂起。
  const st = mk();
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;

  a.cellId = map.cells.find((c) => c.cellType === 'Police')!.id;
  a.movedThisTurn = true;
  a.hand = ['a001'];
  st.pendingCellEffect = { playerId: a.id, cellId: a.cellId };
  st.pending = {
    kind: 'test:noop',
    playerId: a.id,
    prompt: '测试用挂起',
    options: [{ value: 'ok', label: '确定' }],
    min: 1, max: 1,
    resume: { actions: [], index: 0, targets: [], source: '测试', ownerId: a.id },
  };

  const r = answerChoice(st, a.id, ['ok']);

  assert.ok(st.pending, '警察格效果应产生挂起（付款/掷骰），实际 state.pending 为空');
  assert.ok(r.pending,
    'answerChoice 必须把新挂起返回给调用方；返回 undefined 会让界面无按钮可点（卡死）');
  assert.equal(r.pending!.kind, st.pending!.kind, '返回值里的挂起应与 state 一致');
  assert.ok(buildEnginePrompt(st, a.id), '有挂起时 buildEnginePrompt 不该返回 null');
  console.log(`      新挂起: ${r.pending!.kind} — ${r.pending!.prompt}`);
});

check('警察格挂起出现后，界面能拿到 choose 提示（不是 null）', () => {
  const st = mk();
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  a.cellId = map.cells.find((c) => c.cellType === 'Police')!.id;
  a.movedThisTurn = true;
  a.hand = ['a001'];
  st.pendingCellEffect = { playerId: a.id, cellId: a.cellId };
  st.pending = {
    kind: 'test:noop', playerId: a.id, prompt: '测试', options: [{ value: 'ok', label: '确定' }],
    min: 1, max: 1,
    resume: { actions: [], index: 0, targets: [], source: '测试', ownerId: a.id },
  };
  answerChoice(st, a.id, ['ok']);
  const pr = buildEnginePrompt(st, a.id);
  assert.ok(pr, 'prompt 不该是 null');
  assert.equal(pr!.type, 'choose', `应是 choose，实际 ${pr!.type}`);
  console.log(`      prompt=${pr!.type} msg="${pr!.message}"`);
});

console.log('\n=== 移动路径经过厄运格后不会卡死 ===');

check('走牌路径经过厄运格，全程都有出口可点', () => {
  const bigCard = ACTION_CARDS.find((c) => c.move >= 4 && c.price === 0 && !c.specialMove)!;
  const st = mk();
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  const policeIds = new Set(map.cells.filter((c) => c.cellType === 'Police').map((c) => c.id));
  const mfIds = new Set(map.cells.filter((c) => c.cellType === 'Misfortune').map((c) => c.id));

  let route: { start: string; path: string[] } | null = null;
  for (const start of map.cells) {
    if (policeIds.has(start.id)) continue;
    let cur: string[][] = [[start.id]];
    for (let i = 0; i < bigCard.move; i++) {
      const nxt: string[][] = [];
      for (const p of cur) {
        for (const nx of map.cells.find((c) => c.id === p[p.length - 1])!.out) nxt.push([...p, nx]);
      }
      cur = nxt;
    }
    for (const p of cur) {
      if (!policeIds.has(p[p.length - 1]!)) continue;
      if (!p.slice(1, -1).some((id) => mfIds.has(id))) continue;
      route = { start: start.id, path: p };
      break;
    }
    if (route) break;
  }
  assert.ok(route, '应能构造出"经过厄运→警察"的路径');

  a.cellId = route!.start;
  a.hand = [bigCard.id, 'a001', 'a002'];
  moveWithCard(st, a.id, bigCard.id, route!.path[route!.path.length - 1]!);

  let guard = 0;
  const seen: string[] = [];
  for (;;) {
    if (st.pending) {
      const p = st.pending;
      seen.push(p.kind);
      const rr = answerChoice(st, p.playerId, p.options.slice(0, Math.max(1, p.min ?? 1)).map((o) => o.value));
      st.pending = rr.pending;
      if (++guard > 25) break;
      continue;
    }
    const pr = buildEnginePrompt(st, a.id);
    const myTurn = currentPlayerId(st) === a.id;
    const hasOut = !!pr || playableCards(st, a.id).length > 0
      || availableOptions(st, a.id).length > 0 || !!st.pendingCellEffect;
    assert.ok(hasOut || !myTurn,
      `卡死：轮到玩家但既无提示、也无可打牌/可选动作、也没有欠着的效果`
      + `（挂起链: ${seen.join(' -> ') || '(空)'}）`);
    break;
  }
  console.log(`      挂起链: ${seen.join(' -> ') || '(空)'}`);
  console.log(`      终态: pending=${st.pending?.kind ?? '(无)'}`
    + ` prompt=${buildEnginePrompt(st, a.id)?.type ?? 'null'}`);
});

console.log('\n=== 不变量：任意状态点都必须能推进 ===');

check('随机跑多局，不出现"无法推进"的卡死', () => {
  let checked = 0;
  for (const seed of [1, 7, 42, 44444, 31337]) {
    const st = createState({
      roomId: 'tr3', seed, targetScore: 15,
      players: ['Engineer', 'Collector', 'Gambler'].map((nm, i) => ({
        id: `P${i}`, name: `P${i}`, isAI: true, characterId: charOf(nm),
      })),
      chaosEnabled: true,
    });
    let steps = 0;
    while (st.phase === 'playing' && steps++ < 1000) {
      runAIPlayers(st, 3);
      if (st.pending) {
        const p = st.pending;
        const r = answerChoice(st, p.playerId, p.options.slice(0, Math.max(1, p.min ?? 1)).map((o) => o.value));
        st.pending = r.pending;
      }
      const cur = currentPlayerId(st);
      if (!cur) break;
      const cp = getPlayer(st, cur);
      if (!cp) break;
      const pr = buildEnginePrompt(st, cur);
      const noExit = !st.pending && pr === null
        && playableCards(st, cur).length === 0
        && availableOptions(st, cur).length === 0
        && cp.movedThisTurn && !cp.inJail;
      if (noExit) {
        assert.ok(st.pendingCellEffect,
          `seed=${seed} 第 ${steps} 步：轮到我却完全没有出口，且没有欠着的格子效果 —— 卡死`);
      }
      checked++;
    }
  }
  console.log(`      检查了 ${checked} 个状态点，未发现无法推进的卡死`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
