// =============================================================
// 服务端集成测试
//
// 验证新引擎与协议层的衔接：房间逻辑用到的每个 API 都能跑通，
// 且推给客户端的数据（序列化状态 + 提示）形状正确。
//
// 运行: npx tsx src/__tests__/server-integration.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { CHARACTERS, BOARD_MAPS, CARD_BY_ID, CELL_TYPE_BY_ID } from '@gremlins/shared';
import type { EngineState } from '@gremlins/shared/engine';
import { getCell, getPlayer, mustCurrentPlayer } from '@gremlins/shared/engine';
import {
  answerChoice, currentPlayerId, hasPending, isTurn,
  jailTurn, moveWithCard, newGame, nextTurn, movableCards, playableCards,
  playCard, skipPlay,
} from '@gremlins/shared/engine';
import { buildEnginePrompt, serializeEngineState } from '@gremlins/shared/engine';
import { runAITurn } from '../ai.js';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const CHAR_NAMES = ['Engineer', 'Banker', 'Gambler', 'Thief'];

function makeGame(seed = 90210): EngineState {
  return newGame({
    roomId: 'ITEST',
    seed,
    targetScore: 30,
    players: ['Alice', 'Bob', 'Cara', 'Dan'].map((name, i) => ({
      id: `p${i}`,
      name,
      isAI: false,
      characterId: CHARACTERS.find((c) => c.name === CHAR_NAMES[i])?.id,
    })),
  });
}

/** 把挂起决策都答掉（取第一个选项），返回处理了几次 */
function drainPending(s: EngineState, guard = 30): number {
  let n = 0;
  while (s.pending && n < guard) {
    const pend = s.pending;
    const values = pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value);
    const r = answerChoice(s, pend.playerId, values);
    if (!r.ok) break;
    n++;
  }
  return n;
}

console.log('=== 1. 对局初始化 → 序列化给客户端 ===');
check('createState 建立 4 人对局，地图与角色正确', () => {
  const s = makeGame();
  assert.equal(s.players.length, 4);
  assert.ok(BOARD_MAPS.some((m) => m.id === s.mapId), 'mapId 应是真实地图');
  for (const p of s.players) {
    assert.ok(p.characterId, `${p.name} 缺角色`);
    assert.ok(getCell(s, p.cellId), `${p.name} 位置不在地图上`);
  }
});
check('序列化后每个字段都是客户端能消费的形状', () => {
  const s = makeGame();
  const view = serializeEngineState(s, 'p0');
  assert.equal(view.roomId, 'ITEST');
  assert.equal(view.phase, 'playing');
  assert.equal(view.mapId, s.mapId);
  assert.equal(typeof view.turnPhase, 'string');
  assert.equal(view.players.length, 4);
  assert.ok(view.deckCount > 0);
  assert.ok(view.targetCogs === 30);

  const me = view.players.find((p) => p.id === 'p0')!;
  // 位置必须是字符串格 id，且真实存在
  assert.equal(typeof me.position, 'string');
  assert.ok(getCell(s, me.position), `位置 ${me.position} 不在地图上`);
  // 资源字段名与协议一致
  const res = me.resources as unknown as Record<string, unknown>;
  for (const k of ['gold', 'votes', 'malice', 'cogs', 'income', 'bribe']) {
    assert.equal(typeof res[k], 'number', `resources.${k} 应为数字`);
  }
  // 自己能看到手牌，别人看不到
  assert.ok(Array.isArray(me.hand) && me.hand.length === 6);
  const other = view.players.find((p: { id: string }) => p.id === 'p1')!;
  assert.equal(other.hand, undefined, '别人不应看到手牌');
  assert.equal(other.handCount, 6);
});
check('日志字段名映射正确（引擎 round → 协议 turn）', () => {
  const s = makeGame();
  // 制造一条日志
  nextTurn(s);
  const view = serializeEngineState(s, 'p0');
  assert.ok(view.log.length > 0, '应有日志');
  for (const e of view.log) {
    assert.equal(typeof e.turn, 'number', 'log.turn 应为数字');
    assert.equal(typeof e.text, 'string');
    assert.equal(typeof e.ts, 'number');
  }
});

console.log('\n=== 2. 提示（prompt）按视角生成 ===');
check('轮到谁，谁收到 select_move_card；其他人收到 wait_others', () => {
  const s = makeGame();
  const cur = currentPlayerId(s);
  const mine = buildEnginePrompt(s, cur);
  assert.ok(mine, '当前玩家应有提示');
  assert.equal(mine!.type, 'select_move_card');
  assert.ok(Array.isArray(mine!.options) && mine!.options.length === 6, '应给出 6 张手牌');

  const other = s.players.find((p) => p.id !== cur)!;
  const theirs = buildEnginePrompt(s, other.id);
  assert.equal(theirs!.type, 'wait_others');
});
check('有挂起决策时，只有发起者收到 choose，且带 choices', () => {
  const s = makeGame();
  const cur = currentPlayerId(s);
  // 手动造一个挂起：选一个带 SelectOpponent 的卡来打
  const p = getPlayer(s, cur)!;
  const card = p.hand.map((id) => CARD_BY_ID[id]).find((c) => c.actions.some((a) => a.type === 'SelectOpponent'));
  if (!card) { console.log('      （本局手牌无选择型卡，改用直接构造挂起）'); }

  // 直接构造：让引擎处于 pending
  s.pending = {
    kind: 'SelectOpponent',
    playerId: cur,
    prompt: '选择一名玩家',
    options: [{ value: 'p1', label: 'Bob' }],
    min: 1,
    max: 1,
    resume: { actions: [], index: 0, targets: [], source: 'test', ownerId: cur },
  };
  const mine = buildEnginePrompt(s, cur);
  assert.equal(mine!.type, 'choose');
  assert.equal(mine!.message, '选择一名玩家');
  assert.equal(mine!.choices?.length, 1);
  const other = s.players.find((x) => x.id !== cur)!;
  assert.equal(buildEnginePrompt(s, other.id)!.type, 'wait_others');
});

console.log('\n=== 3. 房间逻辑用到的 API 都能跑通 ===');
check('isTurn / hasPending 与状态一致', () => {
  const s = makeGame();
  const cur = currentPlayerId(s);
  assert.equal(isTurn(s, cur), true);
  assert.equal(isTurn(s, s.players.find((p) => p.id !== cur)!.id), false);
  assert.equal(hasPending(s), false);
});
check('moveWithCard 能走完（岔路由服务端按目的地自动选）', () => {
  const s = makeGame();
  const cur = currentPlayerId(s);
  const p = getPlayer(s, cur)!;
  const movable = movableCards(s, cur);
  assert.ok(movable.length > 0, '应有可移动的牌');
  const cardId = movable[0];
  const from = p.cellId;
  const r = moveWithCard(s, cur, cardId);
  assert.ok(r.ok, r.error);
  drainPending(s); // 若仍有选择挂起（目的地不唯一）就答掉
  assert.notEqual(p.cellId, from, '位置应改变');
  assert.ok(getCell(s, p.cellId), '新位置应合法');
});
check('playCard / skipPlay 都能调用', () => {
  const s = makeGame();
  const cur = currentPlayerId(s);
  const r0 = skipPlay(s, cur);
  assert.ok(r0.ok, r0.error);
  const playable = playableCards(s, cur);
  if (playable.length) {
    const r = playCard(s, cur, playable[0]);
    assert.ok(r.ok, r.error);
    drainPending(s);
  }
});
check('nextTurn 轮转到下一位并补牌', () => {
  const s = makeGame();
  const first = currentPlayerId(s);
  const r = nextTurn(s);
  assert.ok(r.ok, r.error);
  assert.notEqual(currentPlayerId(s), first, '应换人');
  assert.equal(getPlayer(s, currentPlayerId(s))!.hand.length, 6, '下家应满手牌');
});
check('jailTurn 在狱中可服刑', () => {
  const s = makeGame();
  const cur = currentPlayerId(s);
  const p = getPlayer(s, cur)!;
  p.inJail = true;
  p.term = 3;
  const r = jailTurn(s, cur);
  assert.ok(r.ok, r.error);
  drainPending(s);
  assert.ok(p.term <= 3, '刑期不应增加');
});
check('非本人操作被拒绝', () => {
  const s = makeGame();
  const other = s.players.find((p) => p.id !== currentPlayerId(s))!.id;
  const r = skipPlay(s, other);
  assert.equal(r.ok, false, '不应允许别人跳过我的回合');
  assert.ok(r.error);
});

console.log('\n=== 4. AI 能在真实引擎上跑完整局 ===');
check('让 4 个 AI 自动打完若干回合，无异常且状态合法', () => {
  const s = makeGame(13579);
  for (const p of s.players) p.isAI = true;
  const room = {
    id: 'ITEST',
    players: new Map(s.players.map((p) => [p.id, { id: p.id, name: p.name, isAI: true }])),
  };
  const fakeIo = {} as never;

  let turns = 0;
  const startRound = s.round;
  while (s.round < startRound + 8 && s.phase === 'playing' && turns < 200) {
    runAITurn(fakeIo, room, s);
    turns++;
  }
  assert.ok(turns > 0, 'AI 应有动作');

  // 状态合法性
  for (const p of s.players) {
    assert.ok(getCell(s, p.cellId), `${p.name} 位置非法 ${p.cellId}`);
    for (const k of ['money', 'vote', 'malice', 'score', 'income'] as const) {
      assert.ok(p.res[k] >= 0, `${p.name}.${k} 为负 (${p.res[k]})`);
    }
    assert.ok(p.hand.length <= 12, `${p.name} 手牌异常 ${p.hand.length}`);
  }
  console.log(`      AI 走了 ${turns} 步，跑到第 ${s.round} 回合`);
  console.log(`      ${s.players.map((p) => `${p.name}:齿轮${p.res.score} 金${p.res.money} 手牌${p.hand.length}`).join(' | ')}`);
});
check('AI 跑完后仍能序列化给客户端', () => {
  const s = makeGame(24680);
  for (const p of s.players) p.isAI = true;
  const room = {
    id: 'ITEST',
    players: new Map(s.players.map((p) => [p.id, { id: p.id, name: p.name, isAI: true }])),
  };
  runAITurn({} as never, room, s);
  const view = serializeEngineState(s, 'p0');
  assert.equal(view.players.length, 4);
  for (const p of view.players) {
    assert.ok(getCell(s, p.position), `序列化位置非法 ${p.position}`);
  }
});

console.log('\n=== 5. 角色与地图数据贯通 ===');
check('12 个角色的起始格都在真实地图上', () => {
  const map = BOARD_MAPS.find((m) => m.name === 'Normal')!;
  const ids = new Set(map.cells.map((c) => c.id));
  for (const c of CHARACTERS) {
    assert.ok(ids.has(c.normalStartCellId), `${c.name} 起始格不在普通地图`);
  }
});
check('开局每个玩家落在自己角色的起始格', () => {
  const s = makeGame();
  for (const p of s.players) {
    const char = CHARACTERS.find((c) => c.id === p.characterId)!;
    assert.equal(p.cellId, char.normalStartCellId, `${p.name} 起始格不符`);
  }
});
check('手牌里的每张卡都在权威牌库里', () => {
  const s = makeGame();
  for (const p of s.players) {
    for (const id of p.hand) assert.ok(CARD_BY_ID[id], `${p.name} 手牌含未知卡 ${id}`);
  }
});
check('每个玩家的位置对应格子都有合法的格子类型', () => {
  const s = makeGame();
  for (const p of s.players) {
    const cell = getCell(s, p.cellId)!;
    assert.ok(CELL_TYPE_BY_ID[cell.cellTypeId], `${cell.name} 的 cellTypeId 无对应类型`);
  }
});
check('mustCurrentPlayer 与 currentPlayerId 一致', () => {
  const s = makeGame();
  assert.equal(mustCurrentPlayer(s).id, currentPlayerId(s));
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
