// =============================================================
// 角色能力（数据驱动）测试
//
// 运行: npx tsx src/__tests__/abilities.test.ts
//
// 注意：`createState` 会按**原版行动顺序**（StepOrderNum）重排玩家，
// 所以一律用 `byChar()` 按角色名取人，不要用 players[0]。
// =============================================================
import assert from 'node:assert/strict';
import { CHARACTER_BY_ID, CARD_BY_ID, getCell, getMap } from '@gremlins/shared/engine';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';
import { createState, bribeAmount } from '@gremlins/shared/engine';
import {
  CHARACTER_ABILITIES, allCharacterAbilityActions, registeredAbilityActions,
  fireAbility, abilitiesOf, bribeModifier,
} from '@gremlins/shared/engine';
import { arrest } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const CHAR_BY_NAME = (name: string) =>
  Object.values(CHARACTER_BY_ID).find((c) => c.name === name)!;

function gameWith(chars: string[], seed = 5150): EngineState {
  return createState({
    roomId: 'abil-test',
    seed,
    targetScore: 30,
    players: chars.map((name, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      isAI: false,
      characterId: CHAR_BY_NAME(name)?.id,
    })),
  });
}

/** 按角色内部名取玩家 */
function byChar(s: EngineState, name: string): EnginePlayer {
  const char = CHAR_BY_NAME(name);
  const p = s.players.find((x) => x.characterId === char.id);
  assert.ok(p, `对局里没有角色 ${name}`);
  return p!;
}

/** 把玩家挪到某类格子，返回格 id */
function place(s: EngineState, p: EnginePlayer, cellType: string): string {
  const cell = getMap(s).cells.find((c) => c.cellType === cellType);
  assert.ok(cell, `棋盘缺少 ${cellType} 格`);
  p.cellId = cell!.id;
  return cell!.id;
}

console.log('=== 1. 注册表完整性（防漏实现）===');
check('注册表覆盖数据里出现的全部角色能力原语', () => {
  const used = allCharacterAbilityActions();
  const reg = new Set(registeredAbilityActions());
  const missing = used.filter((a) => !reg.has(a));
  assert.equal(missing.length, 0, `未登记: ${missing.join(', ')}`);
  console.log(`      ${used.length} 个原语全部有登记`);
});
check('每个角色的能力条数与数据一致', () => {
  for (const char of Object.values(CHARACTER_BY_ID)) {
    const fromData = char.actions.filter((a) => String(a.type).includes('_')).length;
    const fromReg = (CHARACTER_ABILITIES[char.name] ?? []).length;
    assert.equal(fromReg, fromData, `${char.name}: 数据 ${fromData} 条，注册表 ${fromReg} 条`);
  }
});
check('每条能力都有 event / label / rule / action', () => {
  for (const [charName, list] of Object.entries(CHARACTER_ABILITIES)) {
    for (const s of list) {
      assert.ok(s.event, `${charName}/${s.action} 缺 event`);
      assert.ok(s.label, `${charName}/${s.action} 缺 label`);
      assert.ok(s.rule, `${charName}/${s.action} 缺 rule`);
      assert.ok(s.action.includes('_'), `${charName}/${s.action} 命名异常`);
    }
  }
});
check('abilitiesOf 按 characterId 正确取到能力', () => {
  const s = gameWith(['Engineer']);
  const list = abilitiesOf(byChar(s, 'Engineer'));
  assert.equal(list.length, 4);
  assert.ok(list.some((x) => x.action === 'Engineer_Prototype'));
});

console.log('\n=== 2. 开局被动 ===');
check('工程师「原型试样」开局 +1 齿轮', () => {
  const s = gameWith(['Engineer', 'Banker']);
  assert.equal(byChar(s, 'Engineer').res.score, 1);
});
check('恶魔「恶魔之仆」开局 +1 罪恶', () => {
  const s = gameWith(['Damned', 'Engineer']);
  assert.equal(byChar(s, 'Damned').res.malice, 1);
});
check('乞丐「未付账单」开局 -20 金钱', () => {
  const s = gameWith(['Homeless', 'Engineer']);
  assert.equal(byChar(s, 'Homeless').res.money, 80, '基础 100 → 80');
});
check('乞丐「一帆风顺」设置贿赂基数 5', () => {
  const s = gameWith(['Homeless', 'Engineer']);
  const p = byChar(s, 'Homeless');
  assert.equal(p.flags['bribeBase'], 5);
  assert.equal(p.flags['noMaliceOnUnpaid'], 1);
});
check('小偷「囚犯」标记开局监狱等级 3', () => {
  const s = gameWith(['Thief', 'Engineer']);
  assert.equal(byChar(s, 'Thief').flags['jailRankStart'], 3);
});
check('收藏家「初次亮相」开局自带激活的「幸运药水」', () => {
  const s = gameWith(['Collector', 'Engineer']);
  const p = byChar(s, 'Collector');
  const potion = Object.values(CARD_BY_ID).find((c) => c.name === 'a112')!;
  assert.ok(p.permanents.includes(potion.id), `永久卡区 ${JSON.stringify(p.permanents)}`);
});

console.log('\n=== 3. 造访主场 ===');
check('工程师「薪资」造访工厂 +50 金钱', () => {
  const s = gameWith(['Engineer', 'Banker']);
  const p = byChar(s, 'Engineer');
  const before = p.res.money;
  fireAbility(s, p.id, 'visitHome', { cellId: place(s, p, 'Plant') });
  assert.equal(p.res.money, before + 50);
});
check('工程师能力不在别的建筑生效', () => {
  const s = gameWith(['Engineer', 'Banker']);
  const p = byChar(s, 'Engineer');
  const before = p.res.money;
  fireAbility(s, p.id, 'visitHome', { cellId: place(s, p, 'Casino') });
  assert.equal(p.res.money, before, '赌场不应给薪资');
});

console.log('\n=== 4. 掷骰相关 ===');
check('赌徒「赌注」掷出 6 → +40 金钱', () => {
  const s = gameWith(['Gambler', 'Engineer']);
  const p = byChar(s, 'Gambler');
  const before = p.res.money;
  fireAbility(s, p.id, 'afterRoll', { dice: 6 });
  assert.equal(p.res.money, before + 40);
});
check('赌徒「安慰奖」掷出 1 → +2 收入', () => {
  const s = gameWith(['Gambler', 'Engineer']);
  const p = byChar(s, 'Gambler');
  const before = p.res.income;
  fireAbility(s, p.id, 'afterRoll', { dice: 1 });
  assert.equal(p.res.income, before + 2);
});
check('赌徒掷出 3 无奖励（不会误触发）', () => {
  const s = gameWith(['Gambler', 'Engineer']);
  const p = byChar(s, 'Gambler');
  const before = { money: p.res.money, income: p.res.income };
  fireAbility(s, p.id, 'afterRoll', { dice: 3 });
  assert.equal(p.res.money, before.money);
  assert.equal(p.res.income, before.income);
});

console.log('\n=== 5. 打牌相关 ===');
check('特务「有利秘密」用秘密卡 +100 金钱，用普通卡无效果', () => {
  const s = gameWith(['SecretAgent', 'Engineer']);
  const p = byChar(s, 'SecretAgent');
  const before = p.res.money;
  fireAbility(s, p.id, 'afterPlayCard', { isSecret: true, cellId: p.cellId });
  assert.equal(p.res.money, before + 100);
  fireAbility(s, p.id, 'afterPlayCard', { isSecret: false, cellId: p.cellId });
  assert.equal(p.res.money, before + 100, '普通卡不应再给钱');
});
check('小偷「恶有恶报」用罪恶卡 +1 齿轮', () => {
  const s = gameWith(['Thief', 'Engineer']);
  const p = byChar(s, 'Thief');
  const before = p.res.score;
  fireAbility(s, p.id, 'afterPlayCard', { isCriminal: true, cellId: p.cellId });
  assert.equal(p.res.score, before + 1);
});
check('恶魔「黑暗契约」只在地狱给齿轮', () => {
  const s = gameWith(['Damned', 'Engineer']);
  const p = byChar(s, 'Damned');
  const before = p.res.score;
  fireAbility(s, p.id, 'afterPlayCard', { cellId: place(s, p, 'Casino') });
  assert.equal(p.res.score, before, '赌场不应触发');
  fireAbility(s, p.id, 'afterPlayCard', { cellId: place(s, p, 'Inferno') });
  assert.equal(p.res.score, before + 1, '地狱应 +1 齿轮');
});
check('检察官「法律守护者」在法院/警察站打牌 +1 选票', () => {
  const s = gameWith(['Judge', 'Engineer']);
  const p = byChar(s, 'Judge');
  const before = p.res.vote;
  fireAbility(s, p.id, 'afterPlayCard', { cellId: place(s, p, 'Casino') });
  assert.equal(p.res.vote, before, '赌场不应触发');
  fireAbility(s, p.id, 'afterPlayCard', { cellId: place(s, p, 'Courthouse') });
  assert.equal(p.res.vote, before + 1);
});
check('银行家「个人返现」按付出金钱返 10%', () => {
  const s = gameWith(['Banker', 'Engineer']);
  const p = byChar(s, 'Banker');
  const before = p.res.money;
  fireAbility(s, p.id, 'afterPlayCard', { paidMoney: 250, cellId: p.cellId });
  assert.equal(p.res.money, before + 25, `返现应为 25，实际 ${p.res.money - before}`);
});
check('政治家「超凡魅力」用给选票的卡 +1 选票', () => {
  const s = gameWith(['Politician', 'Engineer']);
  const p = byChar(s, 'Politician');
  const before = p.res.vote;
  fireAbility(s, p.id, 'afterPlayCard', { gainedVotes: 3, cellId: place(s, p, 'Casino') });
  assert.equal(p.res.vote, before + 1);
});
check('经理「加班费」本回合第 3 张效果卡起 +2 齿轮', () => {
  const s = gameWith(['Enterpreneur', 'Engineer']);
  const p = byChar(s, 'Enterpreneur');
  p.cardsPlayedThisTurn = 2;
  const before = p.res.score;
  fireAbility(s, p.id, 'afterPlayCard', { cellId: p.cellId });
  assert.equal(p.res.score, before, '第 2 张不应触发');
  p.cardsPlayedThisTurn = 3;
  fireAbility(s, p.id, 'afterPlayCard', { cellId: p.cellId });
  assert.equal(p.res.score, before + 2, '第 3 张应 +2 齿轮');
});

console.log('\n=== 6. 移动相关 ===');
check('商人「动起来」用 5+ 点卡移动时标记免贿赂', () => {
  const s = gameWith(['Merchant', 'Engineer']);
  const p = byChar(s, 'Merchant');
  p.flags = {};
  fireAbility(s, p.id, 'afterMove', { steps: 5 });
  assert.equal(p.flags['skipBribeThisMove'], 1);
  p.flags = {};
  fireAbility(s, p.id, 'afterMove', { steps: 2 });
  assert.equal(p.flags['skipBribeThisMove'], undefined, '2 点卡不应免贿赂');
});
check('商人「停止」用 <=2 点卡移动时标记免厄运', () => {
  const s = gameWith(['Merchant', 'Engineer']);
  const p = byChar(s, 'Merchant');
  p.flags = {};
  fireAbility(s, p.id, 'afterMove', { steps: 2 });
  assert.equal(p.flags['skipMisfortuneThisMove'], 1);
  p.flags = {};
  fireAbility(s, p.id, 'afterMove', { steps: 4 });
  assert.equal(p.flags['skipMisfortuneThisMove'], undefined);
});
check('检察官「印花税」同格其他玩家付双倍贿赂', () => {
  const s = gameWith(['Judge', 'Engineer']);
  const judge = byChar(s, 'Judge');
  const otherP = byChar(s, 'Engineer');
  const cellId = place(s, judge, 'Casino');
  otherP.cellId = cellId;
  otherP.res.money = 500;
  const before = judge.res.money;
  fireAbility(s, judge.id, 'afterMove', { steps: 1, cellId });
  assert.ok(judge.res.money > before, `应收到印花税，实际 ${before} → ${judge.res.money}`);
});

console.log('\n=== 7. 回合相关 ===');
check('政治家「平民主义」按选票加收入', () => {
  const s = gameWith(['Politician', 'Engineer']);
  const p = byChar(s, 'Politician');
  p.res.vote = 6;
  const before = p.res.income;
  fireAbility(s, p.id, 'turnStart', { cellId: p.cellId });
  assert.equal(p.res.income, before + 6);
});
check('小偷「买卖」跳过一次走牌 +100 金钱', () => {
  const s = gameWith(['Thief', 'Engineer']);
  const p = byChar(s, 'Thief');
  const before = p.res.money;
  fireAbility(s, p.id, 'skipMove', {});
  assert.equal(p.res.money, before + 100);
});
check('银行家「钱生钱」登记收入加成标记', () => {
  const s = gameWith(['Banker', 'Engineer']);
  const p = byChar(s, 'Banker');
  const flags: Record<string, string | number | boolean> = {};
  fireAbility(s, p.id, 'turnStart', { flags, cellId: p.cellId });
  assert.equal(flags.incomeBonus, 3);
});

console.log('\n=== 8. 逮捕相关 ===');
check('特务「秘密关系」被捕时按掷出 6 判刑（刑期 2）', () => {
  const s = gameWith(['SecretAgent', 'Engineer']);
  const p = byChar(s, 'SecretAgent');
  arrest(s, p, '测试');
  assert.equal(p.inJail, true);
  assert.equal(p.term, 2, `按 6 判刑应为 2 次，实际 ${p.term}`);
});
check('乞丐「穷人勿进」钱不足被捕改送垃圾场', () => {
  const s = gameWith(['Homeless', 'Engineer']);
  const p = byChar(s, 'Homeless');
  p.res.money = 50;
  arrest(s, p, '测试');
  assert.equal(p.inJail, false, '不应入狱');
  assert.equal(getCell(s, p.cellId)!.cellType, 'Junkyard');
});
check('普通人被捕仍正常入狱（能力不误触发）', () => {
  const s = gameWith(['Banker', 'Engineer']);
  const p = byChar(s, 'Banker');
  p.res.money = 10;
  arrest(s, p, '测试');
  assert.equal(p.inJail, true);
  assert.equal(getCell(s, p.cellId)!.cellType, 'Jail');
});

console.log('\n=== 9. 贿赂修正 ===');
check('默认贿赂 = 20 + 罪恶', () => {
  const s = gameWith(['Banker', 'Engineer']);
  const p = byChar(s, 'Banker');
  p.res.malice = 10;
  const mod = bribeModifier(p);
  assert.equal(mod.perMalice, 1);
  assert.equal(mod.base, 20);
  assert.equal(bribeAmount(s, p), 30, `实际 ${bribeAmount(s, p)}`);
});
check('检察官「正义之士」贿赂随罪恶增长减半', () => {
  const s = gameWith(['Judge', 'Engineer']);
  const p = byChar(s, 'Judge');
  p.res.malice = 10;
  assert.equal(bribeModifier(p).perMalice, 0.5, '每 2 点罪恶 +1');
  assert.equal(bribeAmount(s, p), 25, `实际 ${bribeAmount(s, p)}`);
});
check('乞丐「一帆风顺」贿赂基数为 5（不与默认 20 叠加）', () => {
  const s = gameWith(['Homeless', 'Engineer']);
  const p = byChar(s, 'Homeless');
  p.res.malice = 0;
  assert.equal(bribeModifier(p).base, 5);
  assert.equal(bribeAmount(s, p), 5, `实际 ${bribeAmount(s, p)}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
