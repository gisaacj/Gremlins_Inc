// 分析原版 ActionList 与卡牌文案的对应关系，用于推导每个动作原语的语义
// 用法: node tools/analyze-actions.mjs [原语名]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const D = path.resolve(__dirname, '..', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));

const cards = read('action_cards.json');
const chars = read('characters.json');
const jail = read('jail_cards.json');
const mf = read('misfortune_cards.json');
const cells = read('cell_types.json');
const chaos = read('chaos_cards.json');

const all = [
  ...cards.map((c) => ({ ...c, __k: '卡牌' })),
  ...chars.map((c) => ({ ...c, __k: '角色' })),
  ...jail.map((c) => ({ ...c, __k: '监狱' })),
  ...mf.map((c) => ({ ...c, __k: '厄运' })),
  ...chaos.map((c) => ({ ...c, __k: '混沌' })),
  ...cells.map((c) => ({ ...c, __k: '格子' })),
];

const seq = (o) => (o.ActionList || []).map((a) => {
  const p = (a.ActionParams || []).filter((x) => x !== undefined && x !== null);
  return p.length ? `${a.ActionType}(${p.join('|')})` : a.ActionType;
});

const filter = process.argv[2];

if (!filter) {
  // 汇总：每个原语出现的典型组合
  const combos = new Map();
  for (const o of all) {
    const s = seq(o);
    if (!s.length) continue;
    const key = s.join(' , ');
    if (!combos.has(key)) combos.set(key, []);
    combos.get(key).push(o);
  }
  console.log(`共 ${combos.size} 种不同动作序列\n`);
  const sorted = [...combos.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, list] of sorted) {
    console.log(`[${list.length}×] ${key}`);
    const sample = list.slice(0, 3).map((o) => `${o.__k}:${o.Name}`);
    console.log(`      ${sample.join('  ')}`);
  }
} else {
  // 详查某个原语：列出所有用法 + 文案
  const hits = all.filter((o) => (o.ActionList || []).some((a) => a.ActionType === filter));
  console.log(`原语 ${filter}: ${hits.length} 处用法\n`);
  for (const o of hits) {
    console.log(`── ${o.__k} / ${o.Name}`);
    console.log(`   序列: ${seq(o).join(' , ')}`);
    if (o.Description) console.log(`   原文: ${o.Description.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (o.Param1 || o.Param2) console.log(`   Param: ${[o.Param1, o.Param2, o.Param3, o.Param4, o.Param5, o.Param6].join(',')}`);
  }
}
