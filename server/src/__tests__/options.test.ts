// =============================================================
// 可选动作（站点/建筑的主动行为）测试
//
// 运行: npx tsx src/__tests__/options.test.ts
//
// 数据来源：原版 GCellType 的 `OptionalFlag == true` 的格子，
// 规则与参数就在它的 `Param1..Param6` 与说明文案里。
// =============================================================
import assert from 'node:assert/strict';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';
import {
  CHARACTERS, availableOptions, createState, doOption, endTurn, getCell, getMap,
} from '@gremlins/shared/engine';


let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (name: string) => CHARACTERS.find((c) => c.name === name)!.id;

/** 建局：默认两人，方便控制 */
function game(chars: string[] = ['Banker', 'Engineer'], seed = 7777): EngineState {
  return createState({
    roomId: 'opt-test',
    seed,
    targetScore: 30,
    players: chars.map((name, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(name),
    })),
  });
}

function byChar(s: EngineState, name: string): EnginePlayer {
  const c = charOf(name);
  const p = s.players.find((x) => x.characterId === c);
  assert.ok(p, `没有角色 ${name}`);
  return p!;
}

/** 把玩家放到某类格子，并把他设为当前行动者 */
function putAt(s: EngineState, p: EnginePlayer, cellType: string): string {
  const cell = getMap(s).cells.find((c) => c.cellType === cellType);
  assert.ok(cell, `棋盘没有 ${cellType} 格`);
  p.cellId = cell!.id;
  s.currentIndex = s.players.indexOf(p);
  return cell!.id;
}

console.log('=== 1. 选项按格子类型出现 ===');
check('银行给出「投资」且参数与数据一致（10 金 → 收入 +10）', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Bank');
  const opts = availableOptions(s, p.id);
  const invest = opts.find((o) => o.id === 'bank.invest');
  assert.ok(invest, `未给出投资选项：${opts.map((o) => o.id).join(', ')}`);
  assert.ok(invest!.label.includes('10'), `标签应含参数 10：${invest!.label}`);
  console.log(`      ${invest!.label}`);
});
check('办公楼给出「卖 1 选票 → 70 金」', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Office');
  const o = availableOptions(s, p.id).find((x) => x.id === 'office.sellVote');
  assert.ok(o, '未给出卖选票选项');
  assert.ok(o!.label.includes('70'), o!.label);
});
check('市场给出「卖 1 齿轮 → 200 金」', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Marketplace');
  const o = availableOptions(s, p.id).find((x) => x.id === 'market.sellScore');
  assert.ok(o, '未给出卖齿轮选项');
  assert.ok(o!.label.includes('200'), o!.label);
});
check('演讲格按参数给出多个下注档位', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Tribune');
  const bets = availableOptions(s, p.id).filter((o) => o.id.startsWith('tribune.speak.'));
  assert.ok(bets.length >= 3, `应有多档下注，实际 ${bets.length}`);
  console.log(`      档位：${bets.map((b) => b.label).join(' / ')}`);
});
check('没有可选动作的格子返回空（如收入格、普通警察格）', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Police');
  assert.equal(availableOptions(s, p.id).length, 0, '警察格不应有可选动作');
});
check('不是自己的回合时不给选项', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  const other = byChar(s, 'Engineer');
  putAt(s, p, 'Bank');
  s.currentIndex = s.players.indexOf(other); // 改成别人行动
  assert.equal(availableOptions(s, p.id).length, 0);
});

console.log('\n=== 2. 负担不起的选项被标记 ===');
check('钱不够时投资选项 affordable=false 且给出原因', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Bank');
  p.res.money = 3;
  const o = availableOptions(s, p.id).find((x) => x.id === 'bank.invest')!;
  assert.equal(o.affordable, false);
  assert.ok(o.reason && o.reason.includes('10'), `原因：${o.reason}`);
});
check('选票不足时办公楼选项被标记为不可用', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Office');
  p.res.vote = 0;
  const o = availableOptions(s, p.id).find((x) => x.id === 'office.sellVote')!;
  assert.equal(o.affordable, false);
});

console.log('\n=== 3. 执行效果 ===');
check('投资：-10 金，收入 +10', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Bank');
  const money = p.res.money;
  const income = p.res.income;
  const r = doOption(s, p.id, 'bank.invest');
  assert.ok(r.ok, r.error);
  assert.equal(p.res.money, money - 10);
  assert.equal(p.res.income, income + 10);
});
check('卖选票：-1 选票，+70 金', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Office');
  p.res.vote = 3;
  const money = p.res.money;
  const r = doOption(s, p.id, 'office.sellVote');
  assert.ok(r.ok, r.error);
  assert.equal(p.res.vote, 2);
  assert.equal(p.res.money, money + 70);
});
check('卖齿轮：-1 齿轮，+200 金', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Marketplace');
  p.res.score = 2;
  const money = p.res.money;
  const r = doOption(s, p.id, 'market.sellScore');
  assert.ok(r.ok, r.error);
  assert.equal(p.res.score, 1);
  assert.equal(p.res.money, money + 200);
});
check('打工：+50 金，-1 罪恶，并跳过 1 回合', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Plant');
  p.res.malice = 3;
  const money = p.res.money;
  const r = doOption(s, p.id, 'plant.work');
  assert.ok(r.ok, r.error);
  assert.equal(p.res.money, money + 50);
  assert.equal(p.res.malice, 2);
  assert.equal(p.skipTurns, 1, '应跳过 1 回合');
});
check('钱不足时执行被拒绝且不产生变化', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Bank');
  p.res.money = 3;
  const before = { m: p.res.money, i: p.res.income };
  const r = doOption(s, p.id, 'bank.invest');
  assert.equal(r.ok, false);
  assert.equal(p.res.money, before.m);
  assert.equal(p.res.income, before.i);
});
check('赌博掷骰会写入 lastRoll 并给出结果', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Risk');
  const r = doOption(s, p.id, 'risk.gamble');
  assert.ok(r.ok, r.error);
  assert.ok(typeof s.lastRoll === 'number' && s.lastRoll! >= 1 && s.lastRoll! <= 6);
  console.log(`      掷出 ${s.lastRoll}：${r.message}`);
});
check('法院没收选票需要先选目标', () => {
  const s = game();
  const p = byChar(s, 'Banker');
  const other = byChar(s, 'Engineer');
  putAt(s, p, 'Courthouse');
  other.cellId = p.cellId;
  other.res.vote = 5;
  p.res.money = 500;
  const r = doOption(s, p.id, 'court.takeVotes');
  assert.ok(r.ok, r.error);
  assert.ok(r.needsTarget, '应先要求选目标');
  assert.ok(r.needsTarget!.candidates.includes(other.id));
  // 再带目标执行一次
  const r2 = doOption(s, p.id, 'court.takeVotes', other.id);
  assert.ok(r2.ok, r2.error);
  assert.ok(other.res.vote < 5, `目标选票应减少，实际 ${other.res.vote}`);
});

console.log('\n=== 4. 角色能力带来的可选动作 ===');
check('「风险经营」在冒险格给出「弃 1 张手牌」', () => {
  const s = game(['Enterpreneur', 'Engineer']);
  const p = byChar(s, 'Enterpreneur');
  putAt(s, p, 'Danger');
  const o = availableOptions(s, p.id).find((x) => x.id === 'ability.discardOne');
  assert.ok(o, `未给出弃牌选项：${availableOptions(s, p.id).map((x) => x.id).join(', ')}`);
  const before = p.hand.length;
  const r = doOption(s, p.id, 'ability.discardOne');
  assert.ok(r.ok, r.error);
  assert.equal(p.hand.length, before - 1);
});
check('「对冲风险」在冒险格给出卖收入换钱', () => {
  const s = game(['Banker', 'Engineer']);
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Danger');
  p.res.income = 30;
  const o = availableOptions(s, p.id).find((x) => x.id.startsWith('ability.sellIncome'));
  assert.ok(o, `未给出卖收入选项：${availableOptions(s, p.id).map((x) => x.id).join(', ')}`);
  const money = p.res.money;
  const r = doOption(s, p.id, o!.id);
  assert.ok(r.ok, r.error);
  assert.equal(p.res.income, 20, '应卖 10 收入');
  assert.equal(p.res.money, money + 100);
});
check('「商业头脑」在办公楼给出「再打一张牌」', () => {
  const s = game(['Enterpreneur', 'Engineer']);
  const p = byChar(s, 'Enterpreneur');
  putAt(s, p, 'Office');
  const o = availableOptions(s, p.id).find((x) => x.id === 'ability.playAgain');
  assert.ok(o, `未给出再打一张：${availableOptions(s, p.id).map((x) => x.id).join(', ')}`);
});
check('「保险优惠」把冒险格保险价从 40 降到 10', () => {
  const s = game(['Collector', 'Engineer']);
  const p = byChar(s, 'Collector');
  putAt(s, p, 'Danger');
  const o = availableOptions(s, p.id).find((x) => x.id === 'danger.insure')!;
  assert.ok(o.label.includes('10'), `保险价应为 10：${o.label}`);
  console.log(`      ${o.label}`);
});
check('「天界俱乐部」选票达标时给出直达天界', () => {
  const s = game(['Politician', 'Engineer']);
  const p = byChar(s, 'Politician');
  putAt(s, p, 'Bank');
  p.res.vote = 3;
  const low = availableOptions(s, p.id).find((x) => x.id === 'ability.astralFromBank');
  assert.ok(low, '银行应给出天界选项');
  assert.equal(low!.affordable, false, '选票不足时应不可用');
  p.res.vote = 8;
  const high = availableOptions(s, p.id).find((x) => x.id === 'ability.astralFromBank')!;
  assert.equal(high.affordable, true);
  const r = doOption(s, p.id, 'ability.astralFromBank');
  assert.ok(r.ok, r.error);
  assert.equal(getCell(s, p.cellId)!.cellType, 'Astral', '应传送到天界');
});

console.log('\n=== 5. 有可选动作时不自动结束回合 ===');
check('落到有选项的地点后 endTurn 不会立刻换人', () => {
  const s = game(['Banker', 'Engineer']);
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Bank');
  p.movedThisTurn = true;
  const before = s.currentIndex;
  // 手动触发一次 endTurn（模拟"移动后"）
  endTurn(s);
  assert.equal(s.currentIndex, before, '有可选动作时不应换人');
  // 再调一次:这次应当真换人
  endTurn(s);
  assert.notEqual(s.currentIndex, before, '第二次应正常换人');
});
check('没有选项时 endTurn 正常换人', () => {
  const s = game(['Banker', 'Engineer']);
  const p = byChar(s, 'Banker');
  putAt(s, p, 'Police');
  p.movedThisTurn = true;
  const before = s.currentIndex;
  endTurn(s);
  assert.notEqual(s.currentIndex, before);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
