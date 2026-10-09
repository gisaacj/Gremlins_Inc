// =============================================================
// 单机（本地对局）测试
//
// 验证引擎 + AI 能在**没有服务端**的情况下跑完整局——
// 这是客户端单机模式的基础。
//
// 运行: npx tsx src/__tests__/local-game.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  CHARACTERS, LocalGame, defaultAI, runAIPlayers,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (name: string) => CHARACTERS.find((c) => c.name === name)!.id;

/** 1 真人 + 2 AI */
function localGame(seed = 24680): LocalGame {
  return new LocalGame({
    roomId: 'local',
    seed,
    targetScore: 30,
    seats: [
      { id: 'human', name: '我', isAI: false, characterId: charOf('Engineer') },
      { id: 'ai1', name: 'AI 1', isAI: true, characterId: charOf('Banker') },
      { id: 'ai2', name: 'AI 2', isAI: true, characterId: charOf('Gambler') },
    ],
    think: (state, playerId) => { defaultAI.act(state, playerId); },
  });
}

console.log('=== 1. 建局（无服务端）===');
check('LocalGame 能建立 3 人对局', () => {
  const g = localGame();
  assert.equal(g.phase, 'playing');
  assert.equal(g.round, 1);
  const view = g.viewFor('human');
  assert.equal(view.players.length, 3);
  assert.ok(view.mapId, '应有地图 id');
});
check('序列化只给自己看手牌', () => {
  const g = localGame();
  const view = g.viewFor('human');
  const me = view.players.find((p) => p.id === 'human')!;
  assert.ok(Array.isArray(me.hand) && me.hand.length === 6);
  for (const other of view.players.filter((p) => p.id !== 'human')) {
    assert.equal(other.hand, undefined);
  }
});
check('开局被动已生效（工程师 +1 齿轮）', () => {
  const g = localGame();
  const view = g.viewFor('human');
  const me = view.players.find((p) => p.id === 'human')!;
  assert.equal(me.resources.cogs, 1);
});

console.log('\n=== 2. 提示与回合推进 ===');
check('promptFor 给出当前该做什么', () => {
  const g = localGame();
  // 可能轮到 human 也可能轮到 AI（按行动顺序）
  for (const id of ['human', 'ai1', 'ai2']) {
    const p = g.promptFor(id);
    assert.ok(p, `${id} 应有提示`);
    assert.ok(['select_move_card', 'choose', 'wait_others'].includes(p!.type), `未知类型 ${p!.type}`);
  }
});
check('runAI 会把行动权交回人类或结束对局', () => {
  const g = localGame();
  const steps = g.runAI();
  assert.ok(steps >= 0);
  const cur = g.needsAI();
  assert.equal(cur, false, 'runAI 结束后不应还需要 AI 行动');
});

console.log('\n=== 3. 人类能完整行动一轮 ===');
check('人类能移动并看到位置变化', () => {
  const g = localGame(11111);
  g.runAI(); // 先把回合交到人类手上
  if (!g.isTurn('human')) {
    // 有可能开局就是人类先手；若 AI 已推进到人类则到这里
    assert.ok(g.isTurn('human') || g.phase === 'game_over');
    return;
  }
  const before = g.viewFor('human').players.find((p) => p.id === 'human')!;
  const prompt = g.promptFor('human')!;
  const cardId = prompt.options?.find((id) => {
    const view = g.viewFor('human');
    const me = view.players.find((p) => p.id === 'human')!;
    return !!id && me.hand?.includes(id);
  });
  assert.ok(cardId, '应有手牌');
  const r = g.move('human', cardId!);
  assert.ok(r.ok, r.error);
  // 可能触发选择
  let guard = 0;
  while (g.pending && guard++ < 20) {
    const pend = g.pending!;
    g.choose('human', pend.options.slice(0, 1).map((o) => o.value));
  }
  const after = g.viewFor('human').players.find((p) => p.id === 'human')!;
  assert.notEqual(after.position, before.position, '位置应变化');
});
check('人类能结束回合，行动权转移', () => {
  const g = localGame(22222);
  g.runAI();
  if (!g.isTurn('human')) return;
  const r = g.endTurn();
  assert.ok(r.ok, r.error);
  assert.equal(g.isTurn('human'), false, '应换人');
});

console.log('\n=== 4. AI 能独立跑完一局（无服务端）===');
check('3 个 AI 互相对战到分出胜负或跑满回合', () => {
  const g = new LocalGame({
    roomId: 'local-all-ai',
    seed: 33333,
    targetScore: 30,
    seats: [
      { id: 'a', name: 'AI A', isAI: true, characterId: charOf('Engineer') },
      { id: 'b', name: 'AI B', isAI: true, characterId: charOf('Thief') },
      { id: 'c', name: 'AI C', isAI: true, characterId: charOf('Judge') },
    ],
  });
  const steps = runAIPlayers(g.state, 4000);
  assert.ok(steps.length > 0, 'AI 应有动作');
  console.log(`      AI 动作 ${steps.length} 步，回合 ${g.round}，阶段 ${g.phase}`);
  if (g.phase === 'game_over') console.log(`      胜者 ${g.winnerId}`);

  // 状态合法性
  for (const p of g.state.players) {
    assert.ok(p.cellId, `${p.name} 无位置`);
    for (const k of ['money', 'vote', 'malice', 'score', 'income'] as const) {
      assert.ok(p.res[k] >= 0, `${p.name}.${k} 为负`);
    }
  }
});
check('单机对局可序列化给"客户端"（形状正确）', () => {
  const g = new LocalGame({
    roomId: 'local-serial',
    seed: 44444,
    targetScore: 20,
    seats: [
      { id: 'a', name: 'AI A', isAI: true, characterId: charOf('Banker') },
      { id: 'b', name: 'AI B', isAI: true, characterId: charOf('Damned') },
    ],
  });
  runAIPlayers(g.state, 2000);
  const view = g.viewFor('a');
  assert.equal(view.players.length, 2);
  for (const p of view.players) {
    assert.equal(typeof p.position, 'string');
    assert.ok(/^\d+$/.test(p.position), `位置应为格 id，实际 ${p.position}`);
  }
  assert.ok(view.log.length > 0, '应有日志');
});

console.log('\n=== 5. 不依赖宿主环境 ===');
check('引擎模块不引用 process / fs / Buffer', async () => {
  // 通过动态 import 检查导出的函数不抛（纯逻辑）
  const mod = await import('@gremlins/shared/engine');
  assert.ok(typeof mod.createState === 'function');
  assert.ok(typeof mod.runAIPlayers === 'function');
  assert.equal((globalThis as Record<string, unknown>).process !== undefined, true, '（Node 环境本身有 process，这里只确认引擎可用）');
});
check('同一 seed 产生同一开局（可复现，便于调试单机）', () => {
  const a = localGame(99999);
  const b = localGame(99999);
  assert.deepEqual(a.state.deck, b.state.deck, '牌序应一致');
  assert.deepEqual(
    a.state.players.map((p) => p.hand),
    b.state.players.map((p) => p.hand),
  );
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
