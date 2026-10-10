// =============================================================
// 文案显示层测试（`{n}` 替换 / 控制符清理 / 中文缺失回退英文）
//
// 背景：数据层保留的是原版原始文案，直接丢给 UI 有两个实测问题：
//   1. **78/186** 张卡的说明含未替换的 `{n}` → UI 上显示「丢弃{1}张卡牌。」
//   2. 中文对部分卡**完全缺失或只剩标记**（如 a015/a099 只给了 `[m]`/`[i]`）
//
// 注意：本层**只影响显示**。引擎效果走 `actions`/`params`，与文案无关
// （另有审计确认：受截断影响的 168 张卡，效果完整率 100%）。
//
// 运行: npx tsx server/src/__tests__/text-display.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CARD_BY_NAME, JAIL_CARDS } from '@gremlins/shared/gamedata';
import {
  cleanGameText, displayCardDescription, displayCardName, displayCardText, isIncompleteZh,
} from '@gremlins/shared';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

console.log('=== 1. cleanGameText ===');
check('去掉 \\r 与多余空白', () => {
  assert.equal(cleanGameText('翻垃圾（规则和垃圾场规则相同）。\r\r'), '翻垃圾（规则和垃圾场规则相同）。');
  assert.equal(cleanGameText('a\r\n\r\nb'), 'a b');
  assert.equal(cleanGameText('  前后空白  '), '前后空白');
});
check('空值安全', () => {
  assert.equal(cleanGameText(''), '');
  assert.equal(cleanGameText(undefined as unknown as string), '');
});

console.log('\n=== 2. isIncompleteZh（判据必须保守）===');
check('[m] / [i] / 空 / 纯符号 → 视为不完整', () => {
  for (const s of ['[m]', '[i]', '', '   ', '...', '——', '[m]。']) {
    assert.equal(isIncompleteZh(s), true, `${JSON.stringify(s)} 应判为不完整`);
  }
});
check('正常短中文 → 视为完整（不能误判）', () => {
  // 这些中文比英文短得多，但语义完整，绝不能被判为截断
  for (const s of ['游说', '获得|。', '外快', '选择任意其他玩家：-{1}&。', '永动机']) {
    assert.equal(isIncompleteZh(s), false, `${JSON.stringify(s)} 不该判为不完整`);
  }
});
check('中英长度比不参与判断（避免大面积误判）', () => {
  // 若按长度比判定，「永动机」(3) vs "Perpetuum mobile"(16) 会被误判
  assert.equal(isIncompleteZh('永动机'), false);
});

console.log('\n=== 3. 全量数据：文案里不该残留 {n} ===');
check('所有卡牌的显示说明都不含未替换的 {n}', () => {
  const bad: string[] = [];
  for (const c of ACTION_CARDS) {
    const d = displayCardDescription(c);
    if (/\{\d\}/.test(d)) bad.push(`${c.name}: ${d.slice(0, 50)}`);
  }
  assert.equal(bad.length, 0, `仍有占位符：\n      ${bad.slice(0, 8).join('\n      ')}`);
  console.log(`      186 张卡的显示说明均无残留占位符`);
});
check('所有监狱卡的显示说明也不含 {n}', () => {
  const bad = JAIL_CARDS.filter((c) => /\{\d\}/.test(displayCardDescription(c)));
  assert.equal(bad.length, 0, `仍有占位符：${bad.map((c) => c.name).join(', ')}`);
});
check('显示说明不含 \\r 控制符', () => {
  const bad = [...ACTION_CARDS, ...JAIL_CARDS].filter((c) => /\r/.test(displayCardDescription(c)));
  assert.equal(bad.length, 0, `含 \\r：${bad.map((c) => c.name).join(', ')}`);
});
check('没有卡牌的显示说明为空（至少回退到英文）', () => {
  const empty = ACTION_CARDS.filter((c) => {
    // 本身就没有任何文案的卡（如某些永久卡）不算问题
    const has = (c.text?.description ?? '') || (c.en?.description ?? '');
    return has && !displayCardDescription(c);
  });
  assert.equal(empty.length, 0, `显示为空：${empty.map((c) => c.name).join(', ')}`);
});

console.log('\n=== 4. 中文缺失 → 回退英文（实测样例）===');
check('a015：中文只有 "[m]" → 回退英文完整句', () => {
  const c = CARD_BY_NAME['a015']!;
  assert.equal(c.text.description, '[m]', '前置条件：中文确实只有 [m]');
  const d = displayCardDescription(c);
  assert.ok(d.includes('use this card to move'), `实际：${d}`);
  assert.ok(!/^\[m\]$/.test(d), '不该只剩 [m]');
  console.log(`      ${d}`);
});
check('a099：中文只有 "[i]" → 回退英文', () => {
  const c = CARD_BY_NAME['a099']!;
  const d = displayCardDescription(c);
  assert.ok(d.includes('conflict'), `实际：${d}`);
  console.log(`      ${d.slice(0, 80)}…`);
});
check('a004：中文完整 → 用中文（且替换了 {1}）', () => {
  const c = CARD_BY_NAME['a004']!;
  const d = displayCardDescription(c);
  assert.ok(/[\u4e00-\u9fa5]/.test(d), `应保留中文：${d}`);
  assert.ok(!/\{1\}/.test(d), '占位符应已替换');
  console.log(`      ${d}`);
});
check('a001：中文完整且短，仍用中文（不被长度比误判）', () => {
  const c = CARD_BY_NAME['a001']!;
  const d = displayCardDescription(c);
  assert.ok(d.includes('选择'), `应保留中文：${d}`);
  console.log(`      ${d}`);
});

console.log('\n=== 5. displayCardName / displayCardText ===');
check('中文名缺失时回退英文名', () => {
  const fake = { text: { name: '', description: '', flavor: '' }, en: { name: 'Fallback', description: '' } };
  assert.equal(displayCardName(fake as never), 'Fallback');
});
check('中文名正常时用中文名', () => {
  assert.equal(displayCardName(CARD_BY_NAME['a015']!), '永动机');
});
check('displayCardText 返回三项且都不含控制符', () => {
  for (const c of ACTION_CARDS.slice(0, 40)) {
    const t = displayCardText(c);
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(typeof t.flavor, 'string');
    assert.ok(!/\r/.test(t.name + t.description + t.flavor), `${c.name} 含控制符`);
  }
});
check('formatted 选项会把资源符号转成 [[token]] 标记', () => {
  const c = CARD_BY_NAME['a001']!;   // 「选择任意其他玩家：-{1}&。」→ 含 &
  const plain = displayCardDescription(c);
  const fmt = displayCardDescription(c, { formatted: true });
  assert.ok(plain.includes('&'), `纯文本应保留 &：${plain}`);
  assert.ok(fmt.includes('[[vote]]'), `格式化应出现 [[vote]]：${fmt}`);
  console.log(`      纯文本: ${plain}`);
  console.log(`      格式化: ${fmt}`);
});

console.log('\n=== 6. 不变量 ===');
check('显示层不修改原始数据', () => {
  const c = CARD_BY_NAME['a015']!;
  const before = JSON.stringify(c);
  displayCardText(c, { formatted: true });
  assert.equal(JSON.stringify(c), before, '原始卡牌对象不该被改动');
});
check('全部 186 张卡都能安全调用（不抛异常）', () => {
  for (const c of ACTION_CARDS) {
    const t = displayCardText(c);
    assert.ok(t.name.length >= 0);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
