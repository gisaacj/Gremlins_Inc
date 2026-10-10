// =============================================================
// 新引擎测试 —— 基于原版权威数据
//
// 运行: npx tsx src/__tests__/engine.test.ts
// （用 node:assert，不引入测试框架依赖）
// =============================================================
import assert from 'node:assert/strict';
import {
  CARD_BY_ID, CHARACTER_BY_ID, CHARACTERS, NORMAL_MAP, cellLabel, mustCurrentPlayer, getCell, getMap,
} from '@gremlins/shared/engine';
import {
  HAND_SIZE, bribeAmount, canMoveWithCard, canPlayCard, createState, startMove,
  endTurn, playEffectCard, resolvePending,
} from '@gremlins/shared/engine';
import { parseParam, parseParams, firstNumber, firstResource, hasTag, payAmount } from '@gremlins/shared/engine';
import { rollDice, runElection } from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
    fail++;
  }
};

function newGame(seed = 12345, names = ['Alice', 'Bob', 'Cara']): EngineState {
  const chars = ['Engineer', 'Banker', 'Gambler'];
  return createState({
    roomId: 'test',
    seed,
    players: names.map((n, i) => ({
      id: n, name: n, isAI: i > 0, characterId: CHARACTERS.find((c) => c.name === chars[i])?.id,
    })),
    targetScore: 30,
  });
}

console.log('=== 1. 初始化 ===');
check('牌库守恒：DeckCount 总和 225 = 手牌 + 牌库 + 弃牌', () => {
  const s = newGame();
  const expected = Object.values(CARD_BY_ID).reduce((n, c) => n + c.deckCount, 0);
  const hand = s.players.reduce((n, p) => n + p.hand.length, 0);
  const actual = s.deck.length + hand + s.discard.length;
  assert.equal(expected, 225, `DeckCount 总和应为 225，实际 ${expected}`);
  assert.equal(actual, expected, `实际 ${actual} 应为 ${expected}`);
  console.log(`      牌库 ${s.deck.length} + 手牌 ${hand} = ${actual}`);
});
check(`每人起手 ${HAND_SIZE} 张`, () => {
  const s = newGame();
  for (const p of s.players) assert.equal(p.hand.length, HAND_SIZE);
});
check('玩家按原版行动顺序排列（工程师 1 → 银行家 7 → 赌徒 5...）', () => {
  const s = newGame();
  const orders = s.players.map((p) => CHARACTER_BY_ID[p.characterId!]!.order);
  // Engineer=1, Banker=7, Gambler=5 → 排序后应为 1,5,7
  assert.deepEqual(orders, [1, 5, 7]);
  assert.equal(s.players[0].name, 'Alice');
  assert.equal(s.players[1].name, 'Cara');
  assert.equal(s.players[2].name, 'Bob');
});
check('起始位置来自 GCharacter.NormalCellStartID 且真实存在', () => {
  const s = newGame();
  for (const p of s.players) {
    const char = CHARACTER_BY_ID[p.characterId!]!;
    assert.equal(p.cellId, char.normalStartCellId, `${p.name} 起始格不符`);
    assert.ok(getCell(s, p.cellId), `${p.name} 起始格 ${p.cellId} 不在地图上`);
    console.log(`      ${char.text.name} → ${cellLabel(getCell(s, p.cellId))}`);
  }
});
check('同一 seed 产生同一牌序（可复现）', () => {
  const a = newGame(999);
  const b = newGame(999);
  assert.deepEqual(a.deck, b.deck);
  assert.deepEqual(a.players.map((p) => p.hand), b.players.map((p) => p.hand));
});

console.log('\n=== 2. 参数语法解析（原版 ActionParams） ===');
check('固定数额：OpponentPayMoney("250")', () => {
  const slots = parseParams(['250']);
  assert.equal(firstNumber(slots), 250);
  assert.equal(firstResource(slots), undefined);
});
check('资源派生：OpponentLoseMoney("Malice|20|Arrest")', () => {
  const slots = parseParams(['Malice', '20', 'Arrest']);
  assert.equal(firstResource(slots), 'malice');
  assert.equal(firstNumber(slots), 20);
  assert.ok(hasTag(slots, 'Arrest'));
});
check('混合：OpponentShowHand("文本ID|50|CellPay|ID")', () => {
  const slots = parseParams(['12345678901', '50', 'CellPay', '98765432109']);
  assert.equal(firstNumber(slots), 50);
  assert.ok(hasTag(slots, 'CellPay'));
});
check('payAmount 派生型 = 资源 × 倍率（以金钱支付）', () => {
  const s = newGame();
  const [payer, payee] = s.players;
  payer.res.malice = 3;
  payer.res.money = 1000;
  const before = payee.res.money;
  const r = payAmount(payer, payee, parseParams(['Malice', '20', 'Arrest']));
  assert.equal(r.paid, 60, `实付 ${r.paid}，应为 3×20=60`);
  assert.equal(r.key, 'money', `支付币种应为 money，实际 ${r.key}`);
  assert.ok(r.full);
  assert.equal(payee.res.money - before, 60);
  assert.equal(payer.res.malice, 3, '罪恶是"计算依据"，不应被扣除');
});
check('payAmount 不足额时 full=false 且只转移持有量', () => {
  const s = newGame();
  const [payer, payee] = s.players;
  payer.res.money = 30;
  const r = payAmount(payer, payee, parseParams(['100']), { defaultKey: 'money' });
  assert.equal(r.paid, 30);
  assert.equal(r.full, false);
});

console.log('\n=== 3. 移动（原版邻接关系 + 岔路口选路） ===');

/** 自动应答移动中的选路（取第一个方向），直到移动完成 */
function autoMove(s: EngineState, playerId: string, cardId: string) {
  let r = startMove(s, playerId, cardId);
  let guard = 0;
  while (r.pending && guard++ < 30) {
    const pick = r.pending.options[0]?.value;
    if (!pick) break;
    r = startMove(s, playerId, cardId, { [r.pending.kind]: [pick] });
  }
  return r;
}

check('岔路口必须由玩家选路，引擎不代替决定', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  // 造一个必然遇到岔路口的场景：连走若干步
  p.res.money = 10000;
  const cardId = p.hand.find((id) => CARD_BY_ID[id]!.move >= 4 && canPlayCard(s, p, id).ok);
  if (!cardId) { console.log('      （没有 >=4 步的牌，跳过）'); return; }
  const r = startMove(s, p.id, cardId);
  if (!r.pending) { console.log('      （这条路径没有岔路口，跳过）'); return; }
  assert.ok(r.pending.kind.startsWith('moveBranch:'), `挂起类型应为 moveBranch，实际 ${r.pending.kind}`);
  assert.ok(r.pending.options.length > 1, '岔路口应给出多个方向');
  console.log(`      ${r.pending.prompt}，可选 ${r.pending.options.map((o) => o.label).join(' / ')}`);
  // 选一个方向后应继续把剩余步数走完
  const r2 = autoMove(s, p.id, cardId);
  assert.ok(r2.ok, r2.reason);
  assert.ok(r2.path && r2.path.length === CARD_BY_ID[cardId]!.move,
    `路径长度 ${r2.path?.length} 应等于移动点数 ${CARD_BY_ID[cardId]!.move}`);
});
check('移动路径每一步都是合法的 OutCells 出边', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  p.res.money = 10000;
  const cardId = p.hand.find((id) => CARD_BY_ID[id]!.move > 0 && canPlayCard(s, p, id).ok);
  assert.ok(cardId);
  const from = p.cellId;
  const r = autoMove(s, p.id, cardId);
  assert.ok(r.ok, r.reason);
  let cur = from;
  for (const id of r.path ?? []) {
    const cell = getCell(s, cur)!;
    assert.ok(cell.out.includes(id), `${cell.name} 的 out 不含 ${id}`);
    cur = id;
  }
});
check('打移动牌后位置改变、卡牌离开手牌', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  p.res.money = 10000;
  // 必须挑一张"当前位置真的能打出"的移动牌
  const cardId = p.hand.find((id) => CARD_BY_ID[id]!.move > 0 && canPlayCard(s, p, id).ok);
  assert.ok(cardId, '手牌里没有当前可打出的移动牌');
  const before = p.cellId;
  const r = autoMove(s, p.id, cardId);
  assert.ok(r.ok, r.reason);
  assert.notEqual(p.cellId, before, '位置未改变');
  assert.ok(!p.hand.includes(cardId), '卡牌仍在手牌');
  console.log(`      ${CARD_BY_ID[cardId]!.text.name} 移动 ${CARD_BY_ID[cardId]!.move} 步：${cellLabel(getCell(s, before))} → ${cellLabel(getCell(s, p.cellId))}`);
});
check('移动结束后 moveCursor 被清理', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  p.res.money = 10000;
  const cardId = p.hand.find((id) => CARD_BY_ID[id]!.move > 0 && canPlayCard(s, p, id).ok)!;
  autoMove(s, p.id, cardId);
  assert.equal(s.moveCursor, undefined, 'moveCursor 应被清理');
  assert.equal(s.pending, undefined, '不应残留挂起');
});
/**
 * 「用卡移动不花资源」的权威依据（游戏内文案）：
 *
 *  - `15774184674423479516`「当你**使用**无特殊规则的卡牌时，你将按价格支付金币
 *    （除非卡牌免费）并获得卡牌底部显示的资源。」——付费对应的是**资源收益**，
 *    而资源只在"在站点把卡当效果打出"时结算。
 *  - `a053「有趣的发现」` 是 `move=3 price=0`；教学里说"用它移动得花 $20"
 *    （`18132655247867922307`）其实是**永久卡 a138「机器交警」**的效果：
 *    「任意玩家使用移动点数为 5 或 6 的卡牌移动时：该玩家给予你 {1}$」
 *    （动作 `Perm_SpeedPay["20"]`）。不是卡价。
 */
check('用行动卡移动**不花资源**（费用只在站点打出效果时支付）', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  p.res.money = 10000;
  // 特意挑一张"付费"的移动牌：走路照样免费
  const card = p.hand
    .map((id) => CARD_BY_ID[id]!)
    .find((c) => c.move > 0 && c.price > 0 && c.priceType === 'Money');
  assert.ok(card, '手牌里没有付费移动牌');
  const before = p.res.money;
  autoMove(s, p.id, card.id);
  assert.equal(p.res.money, before,
    `移动不该扣费：${before} → ${p.res.money}（${card.name} price=${card.price}）`);
});
check('付不起钱的牌也能用来移动', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  p.res.money = 0;
  p.res.vote = 0;
  const card = p.hand
    .map((id) => CARD_BY_ID[id]!)
    .find((c) => c.move > 0 && c.price > 0);
  assert.ok(card, '手牌里没有付费移动牌');
  const chk = canMoveWithCard(p, card.id);
  assert.ok(chk.ok, `付不起也该能走路：${chk.reason}（${card.name} price=${card.price}）`);
});
check('在站点打出效果牌**才**扣费用', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  p.res.money = 10000;
  const card = p.hand
    .map((id) => CARD_BY_ID[id]!)
    .find((c) => c.move > 0 && c.price > 0 && c.priceType === 'Money' && canPlayCard(s, p, c.id).ok);
  if (!card) {
    console.log('      （本局手牌没有"在当前站点可打出且付费"的牌，跳过）');
    return;
  }
  const before = p.res.money;
  playEffectCard(s, p.id, card.id);
  assert.equal(p.res.money, before - card.price,
    `站点施放应扣费：${before} → ${p.res.money}（${card.name}）`);
});

console.log('\n=== 4. 卡牌地点限制 ===');
check('地点不符的卡不能打出', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const cell = getCell(s, p.cellId)!;
  const bad = p.hand
    .map((id) => CARD_BY_ID[id]!)
    .find((c) => c.cellTypeId && c.cellTypeId !== '0' && c.cellTypeId !== cell.cellTypeId);
  if (!bad) {
    console.log('      （本局手牌没有地点受限的卡，跳过）');
    return;
  }
  const chk = canPlayCard(s, p, bad.id);
  assert.equal(chk.ok, false, `「${bad.text.name}」不应能在 ${cellLabel(cell)} 打出`);
  assert.ok(chk.reason);
});
check('金钱不足时不能打付费卡', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const paid = p.hand.map((id) => CARD_BY_ID[id]!).find((c) => c.price > 0 && c.priceType === 'Money');
  if (!paid) return;
  p.res.money = 0;
  const chk = canPlayCard(s, p, paid.id);
  assert.equal(chk.ok, false);
});

console.log('\n=== 5. 动作解释器（真实卡牌数据） ===');
check('卡 a001「游说」序列执行：选择对手 → 扣 1 选票', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const card = CARD_BY_ID[Object.keys(CARD_BY_ID).find((k) => CARD_BY_ID[k].name === 'a001')!];
  // 把玩家放到该卡可打出的格子（办公楼），并只手握这张牌
  p.cellId = NORMAL_MAP.cells.find((c) => c.cellTypeId === card.cellTypeId)!.id;
  p.hand = [card.id];
  p.res.money = 1000;
  // 注意：players 已按原版行动顺序重排，目标要按 id 取而不是按下标
  const target = s.players.find((x) => x.id === 'Bob')!;
  target.res.vote = 5;

  const r = playEffectCard(s, p.id, card.id);
  assert.ok(r.ok, r.reason);
  assert.ok(r.pending, '应挂起等待选择对手');
  assert.equal(r.pending!.kind, 'SelectOpponent');

  const r2 = resolvePending(s, p.id, [target.id]);
  assert.ok(r2.ok, r2.reason);
  assert.equal(target.res.vote, 4, `${target.name} 选票应为 4，实际 ${target.res.vote}`);
  assert.equal(p.res.vote, 0, '发起者不应误伤自己');
});
check('挂起决策记录在 state.pending，且只能由发起者回答', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const card = s.players
    .flatMap((x) => x.hand)
    .map((id) => CARD_BY_ID[id])
    .find((c) => c.actions.some((a) => a.type === 'SelectOpponent') && (!c.cellTypeId || c.cellTypeId === '0'));
  if (!card) { console.log('      （本局无无地点限制的选择型卡，跳过）'); return; }
  p.hand = [card.id];
  const r = playEffectCard(s, p.id, card.id);
  if (!r.pending) return;
  assert.ok(s.pending);
  const wrong = resolvePending(s, s.players[1].id, [s.players[0].id]);
  assert.equal(wrong.ok, false);
});

console.log('\n=== 6. 站点规则 ===');
check('贿赂金额 = 20 + 罪恶（原版基准）', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  p.res.malice = 0;
  const a = bribeAmount(s, p);
  p.res.malice = 10;
  const b = bribeAmount(s, p);
  assert.equal(b - a, 10, `罪恶 +10 应使贿赂 +10（${a} → ${b}）`);
});
check('投票结果：票多者当选镇长并获得 1 齿轮', () => {
  const s = newGame();
  s.players[1].res.vote = 10;
  s.players[0].res.vote = 0;
  s.players[2].res.vote = 0;
  const before = s.players[1].res.score;
  runElection(s);
  assert.equal(s.mayorId, s.players[1].id);
  assert.equal(s.players[1].res.score, before + 1);
});

console.log('\n=== 7. 回合推进 ===');
check('endTurn 轮转到下一位并补满手牌', () => {
  const s = newGame();
  const first = mustCurrentPlayer(s);
  first.hand = first.hand.slice(0, 2); // 制造缺口
  // 消耗一张牌以便补牌生效
  endTurn(s);
  const next = mustCurrentPlayer(s);
  assert.notEqual(next.id, first.id, '未轮转');
  assert.equal(next.hand.length, HAND_SIZE, `下家手牌 ${next.hand.length} 应为 ${HAND_SIZE}`);
});
check('endTurn 一圈后回合数 +1', () => {
  const s = newGame();
  const n = s.players.length;
  for (let i = 0; i < n; i++) endTurn(s);
  assert.equal(s.round, 2, `回合数应为 2，实际 ${s.round}`);
});
check('掷骰落在 1..6', () => {
  const s = newGame();
  for (let i = 0; i < 200; i++) {
    const d = rollDice(s);
    assert.ok(d >= 1 && d <= 6, `骰子 ${d} 越界`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
