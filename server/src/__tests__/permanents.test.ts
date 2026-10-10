// =============================================================
// 永久卡（Perm_*）与事件钩子测试
//
// 运行: npx tsx src/__tests__/permanents.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  CARD_BY_ID, CHARACTERS, CELL_TYPE_BY_ID, getMap, mustCurrentPlayer,
} from '@gremlins/shared/engine';
import {
  bribeAmount, createState, playEffectCard, resolvePending,
} from '@gremlins/shared/engine';
import { PERM_TRIGGERS, fireTrigger } from '@gremlins/shared/engine';
import { drawMisfortune } from '@gremlins/shared/engine';
import type { EngineState, EnginePlayer } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const CHARS = ['Engineer', 'Banker', 'Gambler'];

function newGame(seed = 4242): EngineState {
  return createState({
    roomId: 'perm-test', seed, targetScore: 30,
    players: ['Alice', 'Bob', 'Cara'].map((n, i) => ({
      id: n, name: n, isAI: true,
      characterId: CHARACTERS.find((c) => c.name === CHARS[i])?.id,
    })),
  });
}

/** 按原版内部名找卡（数据里 Name 形如 a126） */
function cardByName(name: string) {
  const c = Object.values(CARD_BY_ID).find((x) => x.name === name);
  assert.ok(c, `找不到卡 ${name}`);
  return c!;
}

/** 把玩家移到某个格子类型的第一个格子 */
function moveToCellType(s: EngineState, p: EnginePlayer, cellType: string): void {
  const cell = getMap(s).cells.find((c) => c.cellType === cellType);
  assert.ok(cell, `棋盘上没有 ${cellType} 格`);
  p.cellId = cell!.id;
}

/** 让玩家打出某张永久卡（补齐地点与费用），返回卡 id */
function givePermanent(s: EngineState, p: EnginePlayer, cardId: string): string {
  const card = cardByName(cardId);
  if (card.cellTypeId && card.cellTypeId !== '0') {
    const ct = CELL_TYPE_BY_ID[card.cellTypeId];
    if (ct) moveToCellType(s, p, ct.cellType);
  }
  p.hand = [card.id];
  p.res.money = 100000;
  const r = playEffectCard(s, p.id, card.id);
  assert.ok(r.ok, `打出「${card.text.name}」失败: ${r.reason}`);
  let g = 0;
  while (s.pending && g++ < 10) {
    const pend = s.pending;
    const pick = pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value);
    resolvePending(s, pend.playerId, pick);
  }
  return card.id;
}

const other = (s: EngineState, p: EnginePlayer) => s.players.find((x) => x.id !== p.id)!;

console.log('=== 1. 触发规格表自洽 ===');
check('PERM_TRIGGERS 覆盖数据里出现的全部 Perm_* 原语', () => {
  const used = new Set<string>();
  for (const c of Object.values(CARD_BY_ID)) {
    for (const a of c.actions) if (String(a.type).startsWith('Perm_')) used.add(String(a.type));
  }
  const missing = [...used].filter((t) => !PERM_TRIGGERS[t]);
  assert.equal(missing.length, 0, `未登记的 Perm_*: ${missing.join(', ')}`);
  console.log(`      ${used.size} 种 Perm_* 原语全部有触发规格`);
});
check('每条规格都有 event 与 who', () => {
  for (const [k, v] of Object.entries(PERM_TRIGGERS)) {
    for (const spec of Array.isArray(v) ? v : [v]) {
      assert.ok(spec.event, `${k} 缺 event`);
      assert.ok(spec.who, `${k} 缺 who`);
    }
  }
});
check('数值型 Perm_Income 挂在 cardActivated 而非每回合', () => {
  const v = PERM_TRIGGERS.Perm_Income;
  const spec = Array.isArray(v) ? v[0] : v;
  assert.equal(spec.event, 'cardActivated',
    `应为 cardActivated（否则会每回合重复加收入），实际 ${spec.event}`);
});

console.log('\n=== 2. 数值型：打出即生效，且只生效一次 ===');
check('「自动会计」(a126, Perm_Income 20) 收入 +20', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const before = p.res.income;
  givePermanent(s, p, 'a126');
  assert.equal(p.res.income, before + 20, `收入 ${p.res.income}，应为 ${before + 20}`);
  assert.equal(p.permanents.length, 1, '应进入已激活区');
});
check('「自动会计」不会在后续回合重复加收入', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  givePermanent(s, p, 'a126');
  const afterPlay = p.res.income;
  // 连开两轮
  fireTrigger(s, 'ownTurnStart', { actorId: p.id });
  fireTrigger(s, 'ownTurnStart', { actorId: p.id });
  assert.equal(p.res.income, afterPlay, `收入被重复累加：${p.res.income} vs ${afterPlay}`);
});
check('「稳健投资」(a127, Perm_Income 30) 收入 +30', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const before = p.res.income;
  givePermanent(s, p, 'a127');
  assert.equal(p.res.income, before + 30);
});
check('「自动官僚」(a117, Perm_Bribe 10) 其他玩家贿赂 +10，持卡者不被自己加成', () => {
  const s = newGame();
  const holder = mustCurrentPlayer(s);
  const o = other(s, holder);
  const baseOther = bribeAmount(s, o);
  givePermanent(s, holder, 'a117');
  assert.equal(bribeAmount(s, o), baseOther + 10, '其他玩家贿赂应 +10');
  // ⚠️ a117 的卡面「收获」是 +6 齿轮 +1 罪恶（数据 income.malice = 1），
  // 打出时会给持卡者 +1 罪恶，从而**抬高持卡者自己的贿赂**（贿赂 = 20 + 罪恶）。
  // 这里要验证的是 **Perm_Bribe 只加给别人、没有加给持卡者** ——
  // 所以直接按"贿赂 = 20 + 自身罪恶"反推，排除卡牌收获的干扰。
  // （本局两名角色都不是法官/乞丐，基础贿赂就是 20 + 罪恶，无其它修正）
  assert.equal(bribeAmount(s, holder), 20 + holder.res.malice,
    `持卡者自身不该被 Perm_Bribe 加成：贿赂应等于 20 + 自身罪恶(${holder.res.malice})，`
    + `实际 ${bribeAmount(s, holder)}`);
});

console.log('\n=== 3. 触发型：事件驱动 ===');
check('「独臂强盗」(a118, Perm_CasinoMoney 25) 任意玩家进赌场 → 持卡者 +25', () => {
  const s = newGame();
  const holder = mustCurrentPlayer(s);
  givePermanent(s, holder, 'a118');
  const o = other(s, holder);
  const before = holder.res.money;
  fireTrigger(s, 'anyVisitCasino', { actorId: o.id });
  assert.equal(holder.res.money, before + 25, `持卡者 ${holder.res.money}，应为 ${before + 25}`);
});
check('「宣传机器人」(a119, Perm_CasinoVote 1) 其他玩家进赌场 → 持卡者 +1 选票', () => {
  const s = newGame();
  const holder = mustCurrentPlayer(s);
  givePermanent(s, holder, 'a119');
  const before = holder.res.vote;
  fireTrigger(s, 'otherVisitCasino', { actorId: other(s, holder).id });
  assert.equal(holder.res.vote, before + 1);
});
check('「测速警察」(a138, Perm_SpeedPay 20) 玩家用 5/6 点卡移动 → 付给持卡者 20', () => {
  const s = newGame();
  const holder = mustCurrentPlayer(s);
  givePermanent(s, holder, 'a138');
  const mover = other(s, holder);
  mover.res.money = 500;
  const h0 = holder.res.money;
  const m0 = mover.res.money;
  fireTrigger(s, 'anyLongMove', { actorId: mover.id, amount: 6 });
  assert.equal(holder.res.money, h0 + 20, '持卡者应 +20');
  assert.equal(mover.res.money, m0 - 20, '移动者应 -20');
});
check('「缓慢载具」(a164, Perm_MoveMoney 50) 自己用 1 点卡移动 → +50', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  givePermanent(s, p, 'a164');
  const before = p.res.money;
  fireTrigger(s, 'moveWithOne', { actorId: p.id, amount: 1 });
  assert.equal(p.res.money, before + 50);
});
check('「宝藏探寻者」(a120, Perm_TreasureMoney 70) 自己进藏宝阁 → +70', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  givePermanent(s, p, 'a120');
  const before = p.res.money;
  fireTrigger(s, 'visitTreasure', { actorId: p.id });
  assert.equal(p.res.money, before + 70);
});
check('「自动工人」(a122, Perm_Plant_Money 50) 自己进工厂 → +50', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  givePermanent(s, p, 'a122');
  const before = p.res.money;
  fireTrigger(s, 'visitPlant', { actorId: p.id });
  assert.equal(p.res.money, before + 50);
});
check('「自动银行家」(a149, Perm_Banker) 他人投资时持卡者获得等额', () => {
  const s = newGame();
  const holder = mustCurrentPlayer(s);
  givePermanent(s, holder, 'a149');
  const before = holder.res.money;
  fireTrigger(s, 'bankInvest', { actorId: other(s, holder).id, amount: 120 });
  assert.equal(holder.res.money, before + 120);
});

console.log('\n=== 4. 特殊行为标记 ===');
check('「幸运药水」(a112, Perm_MFSkip) 获得厄运时改为弃置此卡', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const cardId = givePermanent(s, p, 'a112');
  const mfBefore = s.misfortuneDeck.length;
  drawMisfortune(s, p);
  assert.ok(!p.permanents.includes(cardId), '此卡应被弃置');
  assert.equal(s.misfortuneDeck.length, mfBefore, '不应真的抽厄运牌');
  assert.ok(s.discard.includes(cardId), '此卡应进弃牌堆');
});
check('「自动狱长」(a131, Perm_Jail) 自己刑期 -1 / 他人 +1', () => {
  const s = newGame();
  const holder = mustCurrentPlayer(s);
  givePermanent(s, holder, 'a131');
  holder.term = 3;
  fireTrigger(s, 'anyArrest', { actorId: holder.id });
  assert.equal(holder.term, 2, `自己刑期应为 2，实际 ${holder.term}`);
  const o = other(s, holder);
  o.term = 2;
  fireTrigger(s, 'anyArrest', { actorId: o.id });
  assert.equal(o.term, 3, `他人刑期应为 3，实际 ${o.term}`);
});
check('「寡头」(a183, Perm_SkipArrest) 豁免逮捕 → 传送到赌场并弃卡', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const cardId = givePermanent(s, p, 'a183');
  const flags: Record<string, string | number | boolean> = {};
  fireTrigger(s, 'beforeArrest', { actorId: p.id, flags });
  assert.equal(flags.arrestSkipped, true, '应标记豁免逮捕');
  const casino = getMap(s).cells.find((c) => c.cellType === 'Casino')!;
  assert.equal(p.cellId, casino.id, '应传送到赌场');
  assert.ok(!p.permanents.includes(cardId), '此卡应被弃置');
});
check('「古代机构」(a159, Perm_ScoreIncome 1) 每轮结束 +1 齿轮', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  // a159 的 DeckCount 为 0（靠「古代细节」合成），测试里直接塞进已激活区
  const card = cardByName('a159');
  p.permanents.push(card.id);
  const before = p.res.score;
  fireTrigger(s, 'roundEnd', {});
  assert.equal(p.res.score, before + 1, `应 +1 齿轮，实际 +${p.res.score - before}`);
});
check('「末日时钟」(a115, Perm_Chaos 1) 每 6 轮其他玩家各 -1 齿轮', () => {
  const s = newGame();
  const holder = mustCurrentPlayer(s);
  givePermanent(s, holder, 'a115');
  const o = other(s, holder);
  o.res.score = 10;
  s.round = 5;
  fireTrigger(s, 'roundEnd', {});
  assert.equal(o.res.score, 10, '非 6 的倍数轮不应触发');
  s.round = 6;
  fireTrigger(s, 'roundEnd', {});
  assert.equal(o.res.score, 9, `第 6 轮应 -1，实际 ${o.res.score}`);
});

console.log('\n=== 5. 回合钩子 ===');
check('「快速贷款」(a175, Perm_Credit) 够钱扣 25，不够则 -3 齿轮并弃卡', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const cardId = givePermanent(s, p, 'a175');
  p.res.money = 100;
  fireTrigger(s, 'ownTurnStart', { actorId: p.id });
  assert.equal(p.res.money, 75, `应扣 25，实际 ${p.res.money}`);
  assert.ok(p.permanents.includes(cardId), '付得起时不应弃卡');

  // 付不出：-3 齿轮并弃卡。
  // 注意 addRes 会把资源钳制在 0，所以先给足齿轮才能观察到完整的 -3。
  p.res.money = 10;
  p.res.score = 10;
  fireTrigger(s, 'ownTurnStart', { actorId: p.id });
  assert.equal(p.res.score, 7, `应 -3 齿轮，实际 ${p.res.score}`);
  assert.ok(!p.permanents.includes(cardId), '付不出时应弃卡');
  assert.ok(s.discard.includes(cardId), '弃卡应进弃牌堆');
});
check('「公基金」(a165, Perm_JailMoney) 服刑时给更高津贴', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  givePermanent(s, p, 'a165');
  p.inJail = true;
  const before = p.res.money;
  fireTrigger(s, 'ownTurnStart', { actorId: p.id });
  assert.ok(p.res.money > before, `服刑应有津贴，实际 ${before} → ${p.res.money}`);
});
check('「守墓人」(a185, Perm_DiscardFirst) 复活被弃置的永久卡并转给自己', () => {
  const s = newGame();
  const keeper = mustCurrentPlayer(s);
  const owner = other(s, keeper);
  givePermanent(s, keeper, 'a185');
  // 造一张别人的永久卡"被弃置"
  const victim = cardByName('a126');
  owner.permanents.push(victim.id);
  fireTrigger(s, 'anyPermanentDiscarded', {
    actorId: owner.id,
    flags: { discardedCardId: victim.id },
  });
  assert.ok(keeper.permanents.includes(victim.id), '应复活并转给守墓人');
  assert.ok(!keeper.permanents.some((id) => cardByName('a185').id === id), '守墓人自身应被弃置');
});
check('「秘密社会」(a085, Perm_SecretVote 1) 打出秘密卡 → +1 选票', () => {
  const s = newGame();
  const holder = mustCurrentPlayer(s);
  givePermanent(s, holder, 'a085');
  const before = holder.res.vote;
  fireTrigger(s, 'playSecret', { actorId: holder.id });
  assert.equal(holder.res.vote, before + 1);
});

console.log('\n=== 6. 回归：一次性激活不应波及其他永久卡 ===');
check('打出永久卡不会连带触发别人的卡（「寡头」不应弃掉刚打出的卡）', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  // 先让 p 拥有「寡头」（beforeArrest 型），再让它打另一张永久卡
  const oligarch = givePermanent(s, p, 'a183');
  assert.ok(p.permanents.includes(oligarch), '寡头应已激活');
  const accountant = givePermanent(s, p, 'a126');
  assert.ok(p.permanents.includes(accountant),
    '新打出的永久卡应留在已激活区，而不是被别人的卡误弃');
  assert.ok(p.permanents.includes(oligarch), '寡头本身也不应被误弃');
});
check('打出永久卡不会连带消耗「幸运药水」', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const potion = givePermanent(s, p, 'a112');
  const accountant = givePermanent(s, p, 'a126');
  assert.ok(p.permanents.includes(potion), '幸运药水不应被误消耗');
  assert.ok(p.permanents.includes(accountant), '自动会计应已激活');
  assert.equal(p.permanents.length, 2);
});
check('永久卡与秘密卡旗标：a085 同时是永久+秘密，应进永久区', () => {
  const s = newGame();
  const p = mustCurrentPlayer(s);
  const id = givePermanent(s, p, 'a085');
  assert.ok(p.permanents.includes(id), '应进已激活区');
  assert.ok(!p.secrets.includes(id), '不应同时进秘密区');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
