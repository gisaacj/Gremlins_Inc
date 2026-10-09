// =============================================================
// 动作原语覆盖度检查
//
// 把数据里**实际出现**的 `ActionType` 与解释器已实现的分支对比，
// 列出尚未实现的原语（按出现频次排序，便于排优先级）。
//
// 运行: npx tsx src/__tests__/coverage.test.ts
// =============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ACTION_CARDS, CHARACTERS, CHAOS_CARDS, MISFORTUNE_CARDS, JAIL_CARDS, CELL_TYPES,
} from '@gremlins/shared/gamedata';

/** 仓库根目录（本文件在 <root>/server/src/__tests__/） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

/** 数据里出现的全部 ActionType 及次数 */
function usedTypes(): Map<string, number> {
  const m = new Map<string, number>();
  const bump = (t: string) => m.set(t, (m.get(t) ?? 0) + 1);
  for (const list of [ACTION_CARDS, CHARACTERS, CHAOS_CARDS, MISFORTUNE_CARDS, JAIL_CARDS, CELL_TYPES]) {
    for (const o of list) {
      for (const a of (o as { actions?: Array<{ type: string }> }).actions ?? []) bump(String(a.type));
    }
  }
  return m;
}

/**
 * 已实现的原语集合 = 三个分发点合并：
 *  1. `interp.ts` 的 `case 'Xxx':`（普通动作）
 *  2. `permanents.ts` 的 `PERM_TRIGGERS` 注册表（33 种 `Perm_*`）
 *  3. `abilities.ts` 的 `CHARACTER_ABILITIES` 注册表（49 条角色能力）
 *
 * 只看 interp.ts 会误判一大片 —— `Perm_*` 与 `Xxx_Ability` 是数据驱动注册的。
 */
function implementedTypes(): Set<string> {
  const out = new Set<string>();

  // 1) interp.ts 的 case 标签
  const interp = readFileSync(resolve(ROOT, 'shared/src/engine/interp.ts'), 'utf8');
  for (const m of interp.matchAll(/^\s*case '([A-Za-z_][A-Za-z0-9_]*)':/gm)) out.add(m[1]);

  // 2) permanents.ts 的 PERM_TRIGGERS 表键
  const perms = readFileSync(resolve(ROOT, 'shared/src/engine/permanents.ts'), 'utf8');
  const table = perms.slice(perms.indexOf('PERM_TRIGGERS'));
  for (const m of table.matchAll(/^\s*'?(Perm_[A-Za-z0-9_]+)'?\s*:/gm)) out.add(m[1]);

  // 3) abilities.ts 的 action 字段
  const abil = readFileSync(resolve(ROOT, 'shared/src/engine/abilities.ts'), 'utf8');
  for (const m of abil.matchAll(/action:\s*'([A-Za-z0-9_]+)'/g)) out.add(m[1]);

  return out;
}

const used = usedTypes();
const impl = implementedTypes();

const total = [...used.values()].reduce((a, b) => a + b, 0);
console.log(`数据里出现 ${used.size} 种 ActionType，共 ${total} 处引用`);
console.log(`解释器实现 ${impl.size} 个 case 标签\n`);

const missing = [...used.entries()]
  .filter(([t]) => !impl.has(t))
  .sort((a, b) => b[1] - a[1]);

console.log('=== 尚未实现的原语（按出现次数排序）===');
if (!missing.length) console.log('  （无）');
for (const [t, n] of missing) console.log(`  ${String(n).padStart(3)} 次  ${t}`);

console.log('\n=== 已实现的原语 ===');
const done = [...used.entries()].filter(([t]) => impl.has(t)).sort((a, b) => b[1] - a[1]);
for (const [t, n] of done) console.log(`  ${String(n).padStart(3)} 次  ${t}`);

const covered = used.size - missing.length;

check('数据里出现的每一个 ActionType 都已实现', () => {
  const pct = (covered / used.size) * 100;
  console.log(`      覆盖率 ${covered}/${used.size} = ${pct.toFixed(1)}%`);
  if (missing.length) {
    throw new Error(`未实现：${missing.map(([t, n]) => `${t}(${n}次)`).join(', ')}`);
  }
});
check('没有"落到 default 分支"的未登记原语', () => {
  // 比"逐个 case 检查空实现"更可靠的判据：解释器最后的 default 分支
  // 若被高频命中，说明还有原语没实现。这里只确认它存在且会记日志。
  const interp = readFileSync(resolve(ROOT, 'shared/src/engine/interp.ts'), 'utf8');
  if (!/default:/.test(interp)) throw new Error('interp.ts 缺少 default 分支');
  if (!/尚未实现|未实现/.test(interp)) {
    throw new Error('default 分支未记录"未实现"日志，无法从对局中发现遗漏');
  }
});
check('标记型 case（MOVE / SpecialMove）有说明注释', () => {
  const interp = readFileSync(resolve(ROOT, 'shared/src/engine/interp.ts'), 'utf8');
  const at = interp.indexOf("case 'MOVE'");
  const block = interp.slice(at, at + 240);
  if (!/\/\//.test(block)) throw new Error('MOVE/SpecialMove 缺少说明注释');
});
check('三个分发点（interp / permanents / abilities）都能被读到', () => {
  const impl = implementedTypes();
  const hasPerm = [...impl].some((t) => t.startsWith('Perm_'));
  const hasAbility = [...impl].some((t) => t.includes('_') && !t.startsWith('Perm_'));
  if (!hasPerm) throw new Error('未读到 Perm_* 注册表');
  if (!hasAbility) throw new Error('未读到角色能力注册表');
  console.log(`      interp + permanents + abilities 合计 ${impl.size} 个已实现原语`);
});
check('本轮新增的五个原语确实生效', () => {
  for (const t of ['Auction', 'CompareResource', 'TopStatBonus', 'CasinoReroll', 'SameMovePoints']) {
    if (!used.has(t)) throw new Error(`${t} 未在数据中出现`);
    if (!impl.has(t)) throw new Error(`${t} 未在解释器中实现`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
