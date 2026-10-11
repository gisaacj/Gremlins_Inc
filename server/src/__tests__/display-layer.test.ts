// =============================================================
// 显示层完整性：所有卡牌输出必须是「纯中文、无占位符、无裸符号」
//
// 用户实测："通货膨胀的显示怎么还是看不懂的字符：每个玩家-{1}%$"
//          "所有卡牌都用中文显示，你本地存卡牌效果啥的可以用字符，
//           但是显示出来都用中文"
//
// 根因不在 `displayCardRules`（它是对的），而在 UI 里有两处**直接用了
// 原始数据** `card.text.description`，绕过了显示层
// （`Hud.tsx` 的永久卡列表与卡牌详情弹窗）。
//
// 本文件守住两点：
//   1) 显示层的输出全中文（占位符/裸符号/成句英文 都是 0）
//   2) 源码里不再出现"绕过显示层"的直接用法
//
// 运行: npx tsx server/src/__tests__/display-layer.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTION_CARDS, CHAOS_CARDS, JAIL_CARDS, MISFORTUNE_CARDS } from '@gremlins/shared/gamedata';
import { displayCardRules } from '@gremlins/shared';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const all = [
  ...ACTION_CARDS.map((c) => ['行动', c] as const),
  ...CHAOS_CARDS.map((c) => ['混沌', c] as const),
  ...MISFORTUNE_CARDS.map((c) => ['厄运', c] as const),
  ...JAIL_CARDS.map((c) => ['监狱', c] as const),
];

console.log('=== 显示层输出必须全中文 ===');

check(`全部 ${all.length} 张卡：无未替换占位符 {n}`, () => {
  const bad: string[] = [];
  for (const [kind, c] of all) {
    const d = displayCardRules(c);
    if (/\{\d+\}/.test(d)) bad.push(`${kind}/${c.name}「${c.text.name}」→ ${d.replace(/\s+/g, ' ').slice(0, 50)}`);
  }
  assert.equal(bad.length, 0, `仍有占位符：\n      ${bad.slice(0, 8).join('\n      ')}`);
  console.log(`      ${all.length} 张卡全部替换`);
});

check('全部卡：无裸资源符号 & $ ^ * | ~', () => {
  const bad: string[] = [];
  for (const [kind, c] of all) {
    const d = displayCardRules(c);
    if (/[&$^*|~]/.test(d)) bad.push(`${kind}/${c.name}「${c.text.name}」→ ${d.replace(/\s+/g, ' ').slice(0, 50)}`);
  }
  assert.equal(bad.length, 0, `仍有裸符号：\n      ${bad.slice(0, 8).join('\n      ')}`);
  console.log('      无裸符号');
});

check('全部卡：无成句英文', () => {
  const bad: string[] = [];
  for (const [kind, c] of all) {
    const d = displayCardRules(c);
    if (/[A-Za-z]{3,}(\s+[A-Za-z]{2,}){1,}/.test(d)) {
      bad.push(`${kind}/${c.name}「${c.text.name}」→ ${d.replace(/\s+/g, ' ').slice(0, 50)}`);
    }
  }
  assert.equal(bad.length, 0, `仍有英文：\n      ${bad.slice(0, 8).join('\n      ')}`);
  console.log('      无成句英文');
});

check('m014「通货膨胀」显示为可读中文（用户点名的例子）', () => {
  const c = MISFORTUNE_CARDS.find((x) => x.name === 'm014')!;
  const d = displayCardRules(c);
  assert.ok(!d.includes('{1}'), `不该有占位符：${d}`);
  assert.ok(d.includes('50'), `应显示具体数值 50：${d}`);
  assert.ok(d.includes('%'), `应保留百分比语义：${d}`);
  console.log(`      ${d}`);
});

check('a108「勾结恶魔」的卡面在显示层里是中文数值', () => {
  const c = ACTION_CARDS.find((x) => x.name === 'a108')!;
  const d = displayCardRules(c);
  assert.ok(d.includes('500') && d.includes('15') && d.includes('4'), `应含三个数值：${d}`);
  console.log(`      ${d}`);
});

console.log('\n=== 源码里不得绕过显示层 ===');

check('客户端源码不再直接把「规则正文」渲染出去', () => {
  // 精确判据：只看**真的把 description 当值渲染**的写法。
  //   ✗ `{card.text.description}`                ← 渲染原始数据（会有 {n}）
  //   ✓ `{displayCardRules(card)}`
  //   ✓ `{card.text?.description && (`           ← 只是 truthy 守卫，不渲染它
  // flavor（风味文字）单独放行：实测 250 张卡 + 12 个角色的 flavor
  // **零占位符、零裸符号**，是纯叙述文本，不含数值规则。
  const root = resolve(process.cwd(), 'client', 'src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
        // 渲染表达式：`{ ... .description }`，且该表达式里没有经过显示层
        const renders = /\{[^}]*\.(text|en)\??\.description\b[^}]*\}/.test(code)
          || /\.(text|en)\??\.description\s*\.slice\(/.test(code);
        if (!renders) return;
        if (/displayCardRules|displayCardDescription|cleanGameText|displayCardName/.test(code)) return;
        offenders.push(`${full.replace(root, '')}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk(root);
  assert.equal(offenders.length, 0,
    `这些位置把原始规则正文直接渲染了（会显示 {n} 与裸符号）：\n      ${offenders.join('\n      ')}`);
  console.log('      未发现直接渲染原始规则正文的位置');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
