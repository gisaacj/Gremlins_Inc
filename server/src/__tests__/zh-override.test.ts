// =============================================================
// 中文补全表的正确性测试
//
// 游戏的中文语言包在源头被截断：多条译文只保留第一句，监狱卡的**骰子结果表**
// 整段丢失（实测 t005 中文只有「掷骰子：」）。这里的中文是**人工按英文原文 +
// 卡牌数据写出**的，所以必须验证它与数据一致 —— 译文写错规则比显示英文更糟。
//
// 运行: npx tsx server/src/__tests__/zh-override.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, JAIL_CARDS } from '@gremlins/shared/gamedata';
import { displayCardRules } from '@gremlins/shared';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const jail = (n: string) => JAIL_CARDS.find((c) => c.name === n)!;
const action = (n: string) => ACTION_CARDS.find((c) => c.name === n)!;

console.log('=== 被补全的卡都真的有中文缺陷（否则不该覆盖） ===');

const OVERRIDDEN = ['t002', 't005', 't006', 't013', 'a032', 'a098', 'a102', 'a123', 'a130', 'a144', 'a182', 'a031', 'a076', 'a099'];

check('每张被补全的卡：中文确实残缺（比英文短很多或为空）', () => {
  for (const n of OVERRIDDEN) {
    const c = jail(n) ?? action(n);
    assert.ok(c, `${n} 应存在`);
    const zh = String(c.text?.description ?? '').replace(/\s+/g, ' ').trim();
    const en = String(c.en?.description ?? '').replace(/\s+/g, ' ').trim();
    // 中文为空、或明显短于英文 —— 说明确有缺陷
    const deficient = zh.length === 0 || (en.length > 0 && zh.length < en.length * 0.5);
    assert.ok(deficient, `${n} 的中文并不残缺（中${zh.length} / 英${en.length}），不该覆盖`);
  }
  console.log(`      ${OVERRIDDEN.length} 张确认都有中文缺陷`);
});

console.log('\n=== 补全后的译文与卡牌数据一致 ===');

check('t002「大转盘」的赔付与 params [100,50,25,25,50,100] 一致', () => {
  const c = jail('t002');
  assert.deepEqual(c.params.slice(0, 6), [100, 50, 25, 25, 50, 100]);
  const d = displayCardRules(c);
  // 1、2、3 扣钱；4、5、6 给钱
  assert.match(d, /1 = −100 金钱/, d);
  assert.match(d, /2 = −50 金钱/, d);
  assert.match(d, /3 = −25 金钱/, d);
  assert.match(d, /4 = \+25 金钱/, d);
  assert.match(d, /5 = \+50 金钱/, d);
  assert.match(d, /6 = \+100 金钱/, d);
  console.log(`      ${d}`);
});

check('t005「逃出监狱」的骰子表与 params [1,1] 一致', () => {
  const c = jail('t005');
  assert.deepEqual(c.params.slice(0, 2), [1, 1]);
  const d = displayCardRules(c);
  assert.match(d, /1、2、3 = \+1 罪恶、刑期 \+1 次走牌/, d);
  assert.match(d, /4、5、6 = 传送到垃圾场/, d);
  console.log(`      ${d}`);
});

check('t013「上诉」的骰子表与 params [1] 一致', () => {
  const c = jail('t013');
  assert.equal(c.params[0], 1);
  const d = displayCardRules(c);
  assert.match(d, /1、2、3 = 无事发生/, d);
  assert.match(d, /4、5、6 = 你获释！并额外获得 1 次走牌/, d);
  console.log(`      ${d}`);
});

check('t006「恶霸」的译文与数据（刑期 +2、罪恶 +1）一致', () => {
  const c = jail('t006');
  // 中英都是空的，只能靠数据反推 —— 确认数据确实是 +2 刑期 / +1 罪恶
  assert.equal(c.income?.term, 2, `income.term 应为 2，实际 ${c.income?.term}`);
  assert.equal(c.income?.malice, 1, `income.malice 应为 1，实际 ${c.income?.malice}`);
  const d = displayCardRules(c);
  assert.match(d, /刑期 \+2 次走牌/, d);
  assert.match(d, /\+1 罪恶/, d);
  console.log(`      ${d}`);
});

check('a032 / a144「掷骰 3 或更小被逮捕」与 params [3] 一致', () => {
  for (const n of ['a032', 'a144']) {
    const c = action(n);
    assert.equal(c.params[0], 3, `${n} params[0] 应为 3`);
    const roll = (c.actions ?? []).find((a) => String(a.type) === 'ROLL');
    assert.ok(roll, `${n} 应有 ROLL 动作`);
    assert.equal(Number(roll.params?.[0]), 3, `${n} ROLL 阈值应为 3`);
    const d = displayCardRules(c);
    assert.match(d, /3 或更小：你被逮捕/, d);
    console.log(`      ${n}: ${d}`);
  }
});

check('a130 / a182「跳过 1 次走牌」与 OpponentSkipTurn(1) 一致', () => {
  for (const n of ['a130', 'a182']) {
    const c = action(n);
    const skip = (c.actions ?? []).find((a) => String(a.type) === 'OpponentSkipTurn');
    assert.ok(skip, `${n} 应有 OpponentSkipTurn`);
    assert.equal(Number(skip.params?.[0]), 1, `${n} 跳过次数应为 1`);
    const d = displayCardRules(c);
    assert.match(d, /跳过 1 次走牌/, d);
  }
});

check('a102「越狱」与 Teleport + AddTurn(1) 一致', () => {
  const c = action('a102');
  const types = (c.actions ?? []).map((a) => String(a.type));
  assert.ok(types.includes('Teleport'), `应有 Teleport：${types.join(',')}`);
  assert.ok(types.includes('AddTurn'), `应有 AddTurn：${types.join(',')}`);
  const d = displayCardRules(c);
  assert.match(d, /传送到垃圾场/, d);
  assert.match(d, /额外获得 1 次走牌/, d);
  console.log(`      ${d}`);
});

check('a098「栽赃陷害！」与 OpponentGetMisfortune(2) + IgnoreCell 一致', () => {
  const c = action('a098');
  const mf = (c.actions ?? []).find((a) => String(a.type) === 'OpponentGetMisfortune');
  assert.equal(Number(mf?.params?.[0]), 2, '厄运候选数应为 2');
  assert.ok((c.actions ?? []).some((a) => String(a.type) === 'IgnoreCell'), '应有 IgnoreCell');
  const d = displayCardRules(c);
  assert.match(d, /从 2 个中选 1 个/, d);
  assert.match(d, /不会影响你/, d);
  console.log(`      ${d}`);
});

console.log('\n=== 不变量 ===');

check('补全后的文本不含裸符号或占位符', () => {
  for (const n of OVERRIDDEN) {
    const c = jail(n) ?? action(n);
    const d = displayCardRules(c);
    assert.ok(!/\{\d+\}/.test(d), `${n} 残留占位符：${d}`);
    assert.ok(!/[&$^*|~]/.test(d), `${n} 残留裸符号：${d}`);
    assert.ok(!/\[m\]|\[i\]/.test(d), `${n} 残留记号：${d}`);
  }
});

check('补全后的文本不含成句英文', () => {
  for (const n of OVERRIDDEN) {
    const c = jail(n) ?? action(n);
    const d = displayCardRules(c);
    assert.ok(!/[A-Za-z]{3,}(\s+[A-Za-z]{2,}){2,}/.test(d), `${n} 仍有英文：${d}`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
