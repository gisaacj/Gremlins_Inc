// =============================================================
// 服务端"无提示时收尾"：用户报的第二次"移动到警察格卡死"
//
// 用户实测（第二次）：
//   "我移动到警察站点，直接灰色，没任何东西触发，无法下一步了"
//
// 根因（两处叠加）：
//   1. 走牌落地后引擎只登记 `pendingCellEffect`（"欠着的格子效果"），
//      **故意**留到 UseCell 阶段收尾（原版顺序 Move→Conflict→UseCard→UseCell）
//   2. `rooms.ts` 的 `emitPromptTo` 只在 `prompt` 非 null 时 emit ——
//      于是引擎返回 null 时客户端**收不到任何更新**，界面停在移动前的旧提示：
//      手牌全灰、没有任何可点的东西。格子效果也因此永远没人结算。
//
// 修法：服务端在"没有提示"时主动收尾（`settleIfNoPrompt`）：
//   先 `finishTurnActions` 结算欠着的效果（它可能自己挂起 → 下发那个挂起），
//   没有挂起就 `nextTurn` 推进回合。
//
// ⚠️ 这段收尾**不能**塞进 `buildEnginePrompt`：那个函数必须只读
// （界面会反复调用），在里面改状态会让"走牌之后、结算之前"的中间态
// 无法被观察 —— 已有多个测试依赖它（turn-order 的站点结算时机等）。
//
// 运行: npx tsx server/src/__tests__/server-settle.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, LocalGame, buildEnginePrompt, createState, getMap, getPlayer, moveWithCard,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';
import { settleIfNoPrompt } from '../rooms.js';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function pathTo(map: ReturnType<typeof getMap>, steps: number, endType: string, viaType?: string) {
  const ends = new Set(map.cells.filter((c) => String(c.cellType) === endType).map((c) => c.id));
  for (const start of map.cells) {
    if (ends.has(start.id)) continue;
    let cur: string[][] = [[start.id]];
    for (let i = 0; i < steps; i++) {
      const nxt: string[][] = [];
      for (const p of cur) for (const nx of map.cells.find((c) => c.id === p[p.length - 1])!.out) nxt.push([...p, nx]);
      cur = nxt;
    }
    for (const p of cur) {
      if (!ends.has(p[p.length - 1]!)) continue;
      if (viaType && !p.slice(1, -1).some((id) => String(map.cells.find((c) => c.id === id)!.cellType) === viaType)) continue;
      return { start: start.id, path: p };
    }
  }
  return null;
}

function mk(seed: number, money = 1000): { st: EngineState; a: ReturnType<typeof getPlayer> & object } {
  const st = createState({
    roomId: 'srv', seed, targetScore: 999,
    players: ['Banker', 'Engineer', 'Gambler'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = money; p.res.vote = 10; p.hand = []; p.inJail = false;
    p.res.malice = 0; p.res.score = 10; p.term = 0;
  }
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  for (const id of ['P1', 'P2']) getPlayer(st, id)!.cellId = map.cells.find((c) => c.cellType === 'Jail')!.id;
  st.currentIndex = st.players.indexOf(a);
  return { st, a: a as never };
}

const big = ACTION_CARDS.find((c) => c.move >= 4 && c.price === 0 && !c.specialMove && !c.special)!;

console.log('=== 走牌落到警察格：服务端必须收尾（不能停在 prompt=null）===');

check('落点警察格后，settleIfNoPrompt 一定能给出下一步（不再卡死）', () => {
  let checked = 0;
  for (let seed = 1; seed <= 15; seed++) {
    for (const money of [0, 20, 1000]) {
      const { st, a } = mk(seed, money);
      const map = getMap(st);
      const route = pathTo(map, big.move, 'Police', 'Misfortune');
      if (!route) continue;
      checked++;
      a.cellId = route.start;
      a.hand = [big.id, 'a001' as never, 'a002' as never];
      moveWithCard(st, a.id, big.id, route.path[route.path.length - 1]);

      // 走牌后引擎故意留"欠着的格子效果" → 提示是 null
      // 服务端这时必须收尾，而不是就这么把 null 发给客户端
      const after = settleIfNoPrompt(st, a.id);
      const isPolicePending = st.pending?.kind.startsWith('police:');
      const advanced = st.currentIndex !== st.players.indexOf(a);
      assert.ok(after !== null || isPolicePending || advanced,
        `seed=${seed} $${money}：收尾后仍既无提示、也无挂起、也没交棒 —— 界面会卡死`
        + `（pending=${st.pending?.kind ?? '(无)'} prompt=${after?.type ?? 'null'}`
        + ` cellResolved=${a.flags['cellResolved']}`
        + ` pendingCellEffect=${JSON.stringify(st.pendingCellEffect)}）`);
    }
  }
  assert.ok(checked > 0, '应至少跑通一个组合');
  console.log(`      检查了 ${checked} 个组合，全部有出口`);
});

check('警察格效果确实被触发了（不是被静默跳过）', () => {
  const { st, a } = mk(1, 1000);
  const map = getMap(st);
  const route = pathTo(map, big.move, 'Police', 'Misfortune')!;
  a.cellId = route.start;
  a.hand = [big.id];
  moveWithCard(st, a.id, big.id, route.path[route.path.length - 1]);
  assert.equal(buildEnginePrompt(st, a.id), null, '前提：走牌后引擎返回 null（欠着格子效果）');
  settleIfNoPrompt(st, a.id);
  const touched = st.log.some((l) => /警察/.test(l.text)) || st.pending?.kind.startsWith('police:');
  assert.ok(touched, `警察格效果应被结算，日志：${st.log.slice(-4).map((l) => l.text).join(' | ')}`);
  console.log(`      ${st.log.slice(-3).map((l) => l.text).join(' | ')}`);
});

check('结算后要么有提示、要么已交棒（不会两边都空）', () => {
  const { st, a } = mk(3, 0);
  const map = getMap(st);
  const route = pathTo(map, big.move, 'Police', 'Misfortune')!;
  a.cellId = route.start;
  a.hand = [big.id];
  moveWithCard(st, a.id, big.id, route.path[route.path.length - 1]);
  settleIfNoPrompt(st, a.id);
  const myTurn = st.players[st.currentIndex]!.id === a.id;
  const hasPrompt = buildEnginePrompt(st, a.id) !== null;
  const hasPending = !!st.pending;
  assert.ok(!myTurn || hasPrompt || hasPending,
    `轮到我却没有提示也没有挂起 —— 卡死（pending=${st.pending?.kind ?? '(无)'}`
    + ` cellResolved=${a.flags['cellResolved']}）`);
  console.log(`      轮到我=${myTurn} 提示=${hasPrompt} 挂起=${st.pending?.kind ?? '(无)'}`);
});

check('buildEnginePrompt 保持只读：调用它不会改变状态', () => {
  const { st, a } = mk(5, 1000);
  const map = getMap(st);
  const route = pathTo(map, big.move, 'Police', 'Misfortune')!;
  a.cellId = route.start;
  a.hand = [big.id];
  moveWithCard(st, a.id, big.id, route.path[route.path.length - 1]);

  const before = {
    money: a.res.money,
    cellResolved: a.flags['cellResolved'],
    pendingCellEffect: JSON.stringify(st.pendingCellEffect),
    pending: st.pending?.kind ?? null,
    cur: st.currentIndex,
    logLen: st.log.length,
  };
  buildEnginePrompt(st, a.id);
  buildEnginePrompt(st, a.id);
  const after = {
    money: a.res.money,
    cellResolved: a.flags['cellResolved'],
    pendingCellEffect: JSON.stringify(st.pendingCellEffect),
    pending: st.pending?.kind ?? null,
    cur: st.currentIndex,
    logLen: st.log.length,
  };
  assert.deepEqual(after, before, 'buildEnginePrompt 不该有任何副作用');
  console.log('      两次调用后状态完全一致');
});

console.log('\n=== 单机路径（LocalGame.promptFor）同样必须收尾 ===');

check('LocalGame.promptFor：走牌落到警察格后一定给出下一步', () => {
  let checked = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const g = new LocalGame({
      roomId: 'local-settle', seed, targetScore: 999, chaosEnabled: false,
      seats: [
        { id: 'P0', name: 'P0', isAI: false, characterId: charOf('Banker') },
        { id: 'P1', name: 'P1', isAI: true, characterId: charOf('Engineer') },
        { id: 'P2', name: 'P2', isAI: true, characterId: charOf('Gambler') },
      ],
    });
    const st = (g as unknown as { state: EngineState }).state;
    const a = getPlayer(st, 'P0')!;
    const map = getMap(st);
    const route = pathTo(map, big.move, 'Police', 'Misfortune');
    if (!route) continue;
    checked++;
    a.cellId = route.start;
    a.hand = [big.id];
    g.move('P0', big.id, route.path[route.path.length - 1]);

    const prompt = g.promptFor('P0');
    const isPolicePending = st.pending?.kind.startsWith('police:');
    const advanced = st.players[st.currentIndex]!.id !== 'P0';
    assert.ok(prompt !== null || isPolicePending || advanced,
      `seed=${seed}：单机路径收尾后仍无出路 —— 界面会卡死`
      + `（pending=${st.pending?.kind ?? '(无)'} prompt=${prompt?.type ?? 'null'}`
      + ` cellResolved=${a.flags['cellResolved']}）`);
  }
  assert.ok(checked > 0, '应至少跑通一个组合');
  console.log(`      检查了 ${checked} 个组合，全部有出口`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
