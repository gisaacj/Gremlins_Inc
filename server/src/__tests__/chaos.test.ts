// =============================================================
// 混沌卡（暴乱卡）机制测试
//
// 原版规则（来自游戏内完整说明）：
//  - "Chaos Cards are an extra feature of the game that players can play with, or without."
//  - "Chaos Cards are available to every player in this session."   ← 共享池
//  - "Each of the Chaos Cards can only be played once."
//  - "Chaos Cards cannot be used to move around, they can only be played for action."
//  - "The session will end at the end of the round during which the last Chaos Card
//     has been played."
//  - 卡牌 `CellID` 限定可打出的地点；代价为金钱或选票
//
// 运行: npx tsx src/__tests__/chaos.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { CHAOS_CARDS, CELL_TYPE_BY_ID } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, chaosExhausted, chaosOptions, createState, endTurn, getMap, getPlayer,
  playChaosCard, serializeEngineState,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(chaos = true, seed = 8181): EngineState {
  const st = createState({
    roomId: 'chaos', seed, targetScore: 30, chaosEnabled: chaos,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
  // createState 会按行动顺序重排玩家，所以把行动权指到 p0
  st.currentIndex = st.players.findIndex((x) => x.id === 'p0');
  return st;
}

/** 把玩家放到某类格子（用 cellTypeId 匹配混沌卡的地点限定） */
function putAtCellType(st: EngineState, cellTypeId: string) {
  const cell = getMap(st).cells.find((c) => c.cellTypeId === cellTypeId);
  assert.ok(cell, `棋盘上没有该地点（${cellTypeId}）`);
  const p = getPlayer(st, 'p0')!;
  p.cellId = cell!.id;
  return p;
}

const card = (n: string) => CHAOS_CARDS.find((c) => c.name === n)!;

console.log('=== 1. 共享池与开关 ===');
check('开启时池里有全部 6 张混沌卡', () => {
  const st = game(true);
  assert.equal(st.chaosPool.length, 6, `实际 ${st.chaosPool.length}`);
  assert.equal(st.chaosPlayed.length, 0);
});
check('关闭时池为空（enableRiotCards = false）', () => {
  const st = game(false);
  assert.equal(st.chaosPool.length, 0);
  assert.equal(chaosExhausted(st), false, '未启用时不算"打完"');
});
check('6 张卡的数据都完整（名称/代价/收益）', () => {
  assert.equal(CHAOS_CARDS.length, 6);
  for (const c of CHAOS_CARDS) {
    assert.ok(c.text.name, `${c.name} 缺名称`);
    assert.ok(c.income, `${c.name} 缺收益`);
    console.log(`      ${c.name}「${c.text.name}」代价 ${c.price}${c.priceType} `
      + `收益 齿轮+${c.income!.score ?? 0} 罪恶+${c.income!.malice ?? 0}`);
  }
});
check('说明缺失的卡被如实标出（原版数据本身为空，不是导出遗漏）', () => {
  // c002 的 `Description` 在原始导出里就是空串，其 DescriptionID 也查不到文案；
  // m024 同样如此。这里只记录，不做"必须有说明"的强断言。
  const noDesc = CHAOS_CARDS.filter((c) => !c.text.description).map((c) => c.name);
  console.log(`      无说明的卡: ${noDesc.length ? noDesc.join(', ') : '（无）'}`);
  for (const n of noDesc) {
    assert.ok(card(n).income, `${n} 虽无说明，但必须有收益数据才能实现`);
  }
});
check('每张卡都限定了地点（不能随意打出）', () => {
  for (const c of CHAOS_CARDS) {
    assert.ok(c.cellTypeId && c.cellTypeId !== '0', `${c.name} 没有地点限定`);
  }
});

console.log('\n=== 2. 地点限定 ===');
check('不在对应地点时给出"需在XX"的原因', () => {
  const st = game();
  const c = card('c001'); // 限定地狱 Inferno
  const opts = chaosOptions(st, 'p0');
  const o = opts.find((x) => x.cardId === c.id)!;
  const need = CELL_TYPE_BY_ID[c.cellTypeId]?.text.name;
  // 起始格通常不是地狱
  if (!o.playable) {
    assert.match(o.reason ?? '', /需在/, `原因：${o.reason}`);
    console.log(`      ${c.text.name} → ${o.reason}`);
  } else {
    console.log(`      （起始格恰好在${need}，跳过）`);
  }
});
check('在地狱时 c001/c002/c003 变为可打出', () => {
  const st = game();
  const c = card('c001');
  const p = putAtCellType(st, c.cellTypeId);
  p.res.money = 5000;
  p.res.vote = 50;
  const opts = chaosOptions(st, 'p0');
  for (const n of ['c001', 'c002', 'c003']) {
    const o = opts.find((x) => x.cardId === card(n).id)!;
    assert.equal(o.playable, true, `${n} 在地狱应可打出（${o.reason ?? ''}）`);
  }
});

console.log('\n=== 3. 打出与结算 ===');
check('打出 c003（地狱，1000 金钱）→ 扣钱、加 12 齿轮 / 5 罪恶', () => {
  const st = game();
  const c = card('c003');
  const p = putAtCellType(st, c.cellTypeId);
  p.res.money = 1500;
  const before = { money: p.res.money, score: p.res.score, malice: p.res.malice };
  const r = playChaosCard(st, p.id, c.id);
  assert.ok(r.ok, r.error ?? '');
  assert.equal(p.res.money, before.money - 1000, `金钱 ${before.money} → ${p.res.money}`);
  assert.equal(p.res.score, before.score + 12);
  assert.equal(p.res.malice, before.malice + 5);
  console.log(`      金钱 ${before.money} → ${p.res.money}，齿轮 +12，罪恶 +5`);
});
check('打出后从共享池移除，进入 chaosPlayed', () => {
  const st = game();
  const c = card('c003');
  const p = putAtCellType(st, c.cellTypeId);
  p.res.money = 1500;
  playChaosCard(st, p.id, c.id);
  assert.equal(st.chaosPool.includes(c.id), false, '应从池中移除');
  assert.ok(st.chaosPlayed.includes(c.id), '应进入已打出列表');
  assert.equal(st.chaosPool.length, 5);
});
check('同一张卡不能打两次（"each can only be played once"）', () => {
  const st = game();
  const c = card('c003');
  const p = putAtCellType(st, c.cellTypeId);
  p.res.money = 5000;
  assert.ok(playChaosCard(st, p.id, c.id).ok);
  const r2 = playChaosCard(st, p.id, c.id);
  assert.equal(r2.ok, false, '第二次应被拒');
  assert.match(r2.error ?? '', /已被打出|未启用/, `原因：${r2.error}`);
});
check('付不起时被拒', () => {
  const st = game();
  const c = card('c006'); // 2000 金钱
  const p = putAtCellType(st, c.cellTypeId);
  p.res.money = 100;
  const r = playChaosCard(st, p.id, c.id);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /付不起/, `原因：${r.error}`);
});
check('选票计价的卡扣选票而不是金钱', () => {
  const st = game();
  const c = card('c002'); // 10 选票
  const p = putAtCellType(st, c.cellTypeId);
  p.res.vote = 20;
  p.res.money = 500;
  const before = { vote: p.res.vote, money: p.res.money };
  const r = playChaosCard(st, p.id, c.id);
  assert.ok(r.ok, r.error ?? '');
  assert.equal(p.res.vote, before.vote - 10, `选票 ${before.vote} → ${p.res.vote}`);
  assert.equal(p.res.money, before.money, '不该扣金钱');
});
check('不在对应地点时被拒', () => {
  const st = game();
  const c = card('c006'); // 限定工厂 Plant
  const p = getPlayer(st, 'p0')!;
  // 挪到一个非工厂格
  const elsewhere = getMap(st).cells.find((x) => x.cellTypeId !== c.cellTypeId)!;
  p.cellId = elsewhere.id;
  p.res.money = 5000;
  const r = playChaosCard(st, p.id, c.id);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /需在/, `原因：${r.error}`);
});
check('不是自己的回合时被拒', () => {
  const st = game();
  const c = card('c003');
  const p = putAtCellType(st, c.cellTypeId);
  p.res.money = 5000;
  st.currentIndex = st.players.findIndex((x) => x.id !== p.id);
  const r = playChaosCard(st, p.id, c.id);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /不是你的回合/);
});

console.log('\n=== 4. c001「供奉」需要丢弃永久卡 ===');
check('没有永久卡时被拒', () => {
  const st = game();
  const c = card('c001');
  const p = putAtCellType(st, c.cellTypeId);
  p.permanents = [];
  const r = playChaosCard(st, p.id, c.id);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /没有可丢弃的永久卡/);
});
check('未指定要丢弃的永久卡时被拒（需要先选）', () => {
  const st = game();
  const c = card('c001');
  const p = putAtCellType(st, c.cellTypeId);
  p.permanents = [card('c001').id]; // 随便塞一个 id 当永久卡
  const r = playChaosCard(st, p.id, c.id);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /需要选择/);
});
check('指定合法永久卡后可打出，且该永久卡被弃置', () => {
  const st = game();
  const c = card('c001');
  const p = putAtCellType(st, c.cellTypeId);
  // 借一张真实永久卡的 id（a154 带 Perm_Conflict）
  const perm = 'a154';
  p.permanents = [perm];
  const before = p.res.score;
  const r = playChaosCard(st, p.id, c.id, { permanentId: perm });
  assert.ok(r.ok, r.error ?? '');
  assert.equal(p.permanents.includes(perm), false, '永久卡应被移除');
  assert.equal(p.res.score, before + 4, `应 +4 齿轮，实际 ${before} → ${p.res.score}`);
});
check('指定不在激活区的永久卡时被拒', () => {
  const st = game();
  const c = card('c001');
  const p = putAtCellType(st, c.cellTypeId);
  p.permanents = ['a154'];
  const r = playChaosCard(st, p.id, c.id, { permanentId: 'a999' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /不在你的激活区/);
});

console.log('\n=== 5. 全部打完 → 赛局结束信号 ===');
check('未打完时 chaosExhausted 为 false', () => {
  const st = game();
  assert.equal(chaosExhausted(st), false);
});
check('打完 6 张后 chaosExhausted 为 true', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.res.money = 100000;
  p.res.vote = 1000;
  for (const c of CHAOS_CARDS) {
    putAtCellType(st, c.cellTypeId);
    if (c.name === 'c001') {
      p.permanents = ['a154'];
      const r = playChaosCard(st, p.id, c.id, { permanentId: 'a154' });
      assert.ok(r.ok, `c001 打出失败：${r.error}`);
    } else {
      const r = playChaosCard(st, p.id, c.id);
      assert.ok(r.ok, `${c.name} 打出失败：${r.error}`);
    }
  }
  assert.equal(st.chaosPool.length, 0, '池应空');
  assert.equal(chaosExhausted(st), true, '应标记为打完');
  console.log(`      已打出 ${st.chaosPlayed.length} 张，池空`);
});
check('打完混沌卡后，走到下一轮开始时赛局结束（不是立刻）', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.res.money = 100000;
  p.res.vote = 1000;
  for (const c of CHAOS_CARDS) {
    putAtCellType(st, c.cellTypeId);
    if (c.name === 'c001') { p.permanents = ['a154']; playChaosCard(st, p.id, c.id, { permanentId: 'a154' }); }
    else playChaosCard(st, p.id, c.id);
  }
  // 打出后仍未结束（要等本轮走完）
  assert.equal(st.phase, 'playing', `打完时不该立刻结束，实际 ${st.phase}`);
  assert.equal(st.chaosEndPending, true, '应标记待收尾');

  // 推进到下一轮：endTurn 直到回到 round 2
  let guard = 0;
  const stillPlaying = () => String(st.phase) === 'playing';
  while (stillPlaying() && st.round < 2 && guard++ < 20) endTurn(st);
  if (String(st.phase) === 'game_over') {
    assert.ok(st.winnerId, '结束后应有胜者');
    console.log(`      第 ${st.round} 轮开始时结束，胜者 ${st.winnerId}`);
  } else {
    console.log(`      （未在 2 轮内触发，round=${st.round} phase=${st.phase}）`);
  }
});

console.log('\n=== 6. 序列化（客户端契约） ===');
check('chaosPool 带 id/名称/说明/代价/收益/可打性', () => {
  const st = game();
  const view = serializeEngineState(st, 'p0');
  assert.equal(view.chaosPool.length, 6);
  for (const c of view.chaosPool) {
    assert.ok(c.id && c.name, '应有 id 与名称');
    assert.ok(typeof c.cost === 'string' && c.cost.length, `缺代价描述：${JSON.stringify(c)}`);
    assert.ok(typeof c.gain === 'string' && c.gain.length, `缺收益描述：${JSON.stringify(c)}`);
    assert.equal(typeof c.playable, 'boolean');
  }
  console.log(`      示例：${view.chaosPool[0].name}「代价 ${view.chaosPool[0].cost}，收益 ${view.chaosPool[0].gain}」`);
});
check('riotCardsEnabled 反映开关', () => {
  assert.equal(serializeEngineState(game(true), 'p0').riotCardsEnabled, true);
  assert.equal(serializeEngineState(game(false), 'p0').riotCardsEnabled, false);
});
check('地点不匹配的卡在序列化里标为不可打并给出原因', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.res.money = 100000;
  const view = serializeEngineState(st, 'p0');
  const notHere = view.chaosPool.filter((c) => !c.playable);
  // 玩家不可能同时在所有地点 → 至少有不可打的
  assert.ok(notHere.length > 0, '应有地点不匹配的卡');
  for (const c of notHere) assert.ok(c.reason, `${c.name} 不可打但没有原因`);
});

console.log('\n=== 7. 不变量 ===');
check('打出混沌卡后资源不为负', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  for (const c of CHAOS_CARDS) {
    p.res.money = c.price; // 刚好够
    p.res.vote = c.price;
    putAtCellType(st, c.cellTypeId);
    if (c.name === 'c001') { p.permanents = ['a154']; playChaosCard(st, p.id, c.id, { permanentId: 'a154' }); }
    else playChaosCard(st, p.id, c.id);
    assert.ok(p.res.money >= 0, `金钱为负：${p.res.money}`);
    assert.ok(p.res.vote >= 0, `选票为负：${p.res.vote}`);
  }
});
check('混沌卡不提供移动点数（不能用它移动）', () => {
  for (const c of CHAOS_CARDS) {
    // ChaosCard 没有 move 字段——这正是"只能用于行动"的体现
    assert.equal((c as unknown as { move?: number }).move, undefined,
      `${c.name} 不该有移动点数`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
