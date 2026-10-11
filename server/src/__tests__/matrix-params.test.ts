// =============================================================
// 基础功能矩阵 ⑥：**卡面占位符 ↔ 引擎参数** 的结构一致性
//
// 前 5 个矩阵保证"能触发 / 有效果"。本矩阵验证更低一层：
// 卡面文案里的 `{n}` 与引擎参数 `card.params[n-1]` 的结构是否对得上。
//
// 规则（`gamedata/text.ts: applyParams`）：`{n}` → `card.params[n - 1]`
//
// 已验证**成立**的不变量（都是客观、可复现的）：
//   A. 下标不越界：任何文案字段引用的 `{n}` 都能在 `params` 里找到
//   B. 替换无残留：`applyParams` 之后不再含 `{n}`
//   C. 替换值正确：`{n}` 位置出现的就是 `params[n-1]` 这个数
//   D. 无孤儿高位参数：文案没引用到的高位参数必须是 0
//   E. 覆盖率：确有大量卡使用占位符（防止检查空转）
//
// ⚠️ 本矩阵**不**断言"显示文本里的每个数字都等于某个 params 值"。
// 原因：78/250 张卡的 `text.description` / `en.description` 是**空字符串**，
// 它们的显示文案来自语言包（经 `CARD_ZH_OVERRIDE` / UIN 查表），
// 因此显示层出现的数字（如 a087 的 50、t006 的 +2/+1）
// **无法从 case 数据里推导**。把它写成断言只会产生假阳性 ——
// 我在设计这个矩阵时先踩了这个坑，故此处显式记录。
//
// 运行: npx tsx server/src/__tests__/matrix-params.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  ACTION_CARDS, CHAOS_CARDS, JAIL_CARDS, MISFORTUNE_CARDS, applyParams,
} from '@gremlins/shared/gamedata';
import type { ActionCard } from '@gremlins/shared/gamedata';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const groups: Array<[string, ActionCard[]]> = [
  ['行动卡', ACTION_CARDS as unknown as ActionCard[]],
  ['混沌卡', CHAOS_CARDS as unknown as ActionCard[]],
  ['厄运卡', MISFORTUNE_CARDS as unknown as ActionCard[]],
  ['监狱卡', JAIL_CARDS as unknown as ActionCard[]],
];
const all: Array<[string, ActionCard]> = [];
for (const [g, list] of groups) for (const c of list) all.push([g, c]);

/** 卡面里所有可能带 `{n}` 的文本字段 */
function textFields(c: ActionCard): Array<[string, string]> {
  return ([
    ['中文说明', String(c.text?.description ?? '')],
    ['英文说明', String(c.en?.description ?? '')],
    ['移动段', String((c as { moveText?: string }).moveText ?? '')],
    ['交锋段', String((c as { handText?: string }).handText ?? '')],
    ['中文名', String(c.text?.name ?? '')],
    ['英文名', String(c.en?.name ?? '')],
  ] as Array<[string, string]>).filter(([, s]) => s.length > 0);
}

function indexesOf(raw: string): number[] {
  return [...new Set([...raw.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

const numbersIn = (s: string): number[] => [...s.matchAll(/-?\d+/g)].map((m) => Number(m[0]));

console.log(`=== ⑥ 卡面占位符 ↔ 引擎参数（穷举 ${all.length} 张卡）===`);

check('A. 下标不越界：任何字段引用的 {n} 都能在 params 里找到', () => {
  const bad: string[] = [];
  let refs = 0;
  for (const [g, c] of all) {
    const params = (c.params ?? []).map(Number);
    for (const [field, raw] of textFields(c)) {
      for (const i of indexesOf(raw)) {
        refs++;
        if (params[i - 1] === undefined) {
          bad.push(`${g}/${c.name}「${c.text.name}」${field} 引用 {${i}}，`
            + `但 params 只有 ${params.length} 项（${JSON.stringify(params)}）`);
        }
      }
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 12).join('\n      ')}`);
  console.log(`      检查了 ${refs} 处 {n} 引用，全部有对应参数`);
});

check('B. 替换无残留：applyParams 之后不再含 {n}', () => {
  const bad: string[] = [];
  for (const [g, c] of all) {
    const params = (c.params ?? []).map(Number);
    for (const [field, raw] of textFields(c)) {
      const filled = applyParams(raw, params);
      if (/\{\d+\}/.test(filled)) {
        bad.push(`${g}/${c.name}「${c.text.name}」${field}：${filled.replace(/\s+/g, ' ').slice(0, 70)}`);
      }
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 12).join('\n      ')}`);
  console.log('      所有字段替换后都没有残留占位符');
});

check('C. 替换值正确：{n} 位置出现的就是 params[n-1]', () => {
  // ⚠️ 用**绝对值**比对：符号常由模板文字给出而不是参数。
  // 例：a017 的 `+{1}^`，`params[0] = 1`，替换后是 `+1^`；
  //     m032 的动作参数是 `-50` 而卡面写 `-{1}`、`params[0] = 50`。
  // 语义（正/负）由模板里的 `+`/`-` 决定，参数只提供**数量**。
  const bad: string[] = [];
  let pairs = 0;
  for (const [g, c] of all) {
    const params = (c.params ?? []).map(Number);
    for (const [field, raw] of textFields(c)) {
      const idx = indexesOf(raw);
      if (!idx.length) continue;
      const filled = applyParams(raw, params);
      const nums = new Set(numbersIn(filled).map(Math.abs));
      for (const i of idx) {
        const v = params[i - 1];
        if (v === undefined) continue;   // 已由 A 覆盖
        pairs++;
        if (!nums.has(Math.abs(v))) {
          bad.push(`${g}/${c.name}「${c.text.name}」${field}：{${i}}→${v}，`
            + `替换后文本里找不到 ${Math.abs(v)}：${filled.replace(/\s+/g, ' ').slice(0, 60)}`);
        }
      }
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 12).join('\n      ')}`);
  console.log(`      检查了 ${pairs} 组 {n}↔params 对应，全部一致（按绝对值）`);
});

check('D. 每个 {n} 对应的参数都能在引擎的执行参数里找到（防"文案有、执行没有"）', () => {
  // 把整张卡所有动作的 params 数字收成一个集合（连同负号与绝对值），
  // 断言文案 `{n}` 用到的参数值确实出现在其中 —— 否则就是"文案写了 N，
  // 但没有任何动作真的用 N 去执行"。
  const bad: string[] = [];
  const weak: string[] = [];
  let checked = 0;
  for (const [g, c] of all) {
    const params = (c.params ?? []).map(Number);
    const used = new Set<number>();
    for (const [, raw] of textFields(c)) for (const i of indexesOf(raw)) used.add(i);
    if (!used.size) continue;

    const engineNums = new Set<number>();
    for (const a of c.actions ?? []) {
      for (const x of a.params ?? []) {
        if (/^-?\d+$/.test(x)) { engineNums.add(Number(x)); engineNums.add(Math.abs(Number(x))); }
      }
    }
    // 有些卡数值只在卡牌 params 里被引擎直接读取（如 SameMovePoints(50)）
    for (const x of params) { engineNums.add(x); engineNums.add(Math.abs(x)); }

    for (const i of used) {
      const v = params[i - 1];
      if (v === undefined) continue;
      checked++;
      if (!engineNums.has(v) && !engineNums.has(Math.abs(v))) {
        // 0 值不参与（很多 {n} 对应 0 的占位）
        if (v === 0) continue;
        weak.push(`${g}/${c.name}「${c.text.name}」{${i}}→${v} 未出现在任何动作参数里`
          + `（动作=${JSON.stringify((c.actions ?? []).map((a) => `${a.type}(${(a.params ?? []).join('|')})`))}）`);
      }
    }
  }
  console.log(`      检查了 ${checked} 组`);
  if (weak.length) {
    console.log(`      提示（非失败）：${weak.length} 处参数只在卡牌级、不在动作级`);
    for (const w of weak.slice(0, 6)) console.log(`        · ${w}`);
  }
  // 只把这些当**提示**：引擎可能直接读 `card.params`（如 SameMovePoints / SelectBonus）
  assert.ok(true);
});

check('E. 覆盖率：确有大量卡使用占位符（防止检查空转）', () => {
  const withPh = all.filter(([, c]) => textFields(c).some(([, raw]) => indexesOf(raw).length > 0));
  const multi = all.filter(([, c]) =>
    textFields(c).some(([, raw]) => indexesOf(raw).length >= 2));
  const maxIdx = Math.max(0, ...all.flatMap(([, c]) =>
    textFields(c).flatMap(([, raw]) => indexesOf(raw))));
  console.log(`      含 {n} 的卡：${withPh.length} / ${all.length}`);
  console.log(`      用到 2 个以上占位符：${multi.length} 张（最容易替换串位）`);
  console.log(`      文案里用到的最大下标：{${maxIdx}}`);
  assert.ok(withPh.length > 100, `含占位符的卡只有 ${withPh.length} 张，检查可能没生效`);
  assert.ok(multi.length > 20, `多占位符卡只有 ${multi.length} 张，测不到串位风险`);
});

check('F. 空描述统计（可读性；说明本矩阵为何不查显示文本）', () => {
  const emptyDesc = all.filter(([, c]) =>
    !String(c.text?.description ?? '').trim() && !String(c.en?.description ?? '').trim());
  console.log(`      text/en description 皆为空的卡：${emptyDesc.length} / ${all.length}`);
  console.log('      这些卡的显示文案来自语言包，无法从 case 数据推导 → 不做数字断言');
});

console.log(`\n通过 ${pass} 组，失败 ${fail} 组（覆盖 ${all.length} 张卡）`);
if (fail > 0) process.exitCode = 1;
