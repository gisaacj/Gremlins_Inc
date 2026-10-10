// =============================================================
// 文档一致性审计（可重复运行）
//
// 背景：`docs/README.md` 的"更正表"是**某个时间点的快照**。
// 随着代码推进，表里"未实现"的条目会陆续被修好，但表格本身不会自己更新，
// 于是文档开始**说谎** —— 第 15 轮复核时发现 3 条已经实现的还被标着"未实现"
// （照它去改代码会把正确的地方改坏）。
//
// 本脚本逐条核对"更正表"里**声称仍缺失**的条目，检查引擎里是否其实已经有了。
// 只对"声称缺失"的行报错，避免把历史列里的说明当成现状。
//
// 用法: node tools/audit-doc-consistency.mjs
// =============================================================
import { readFileSync } from 'node:fs';

const ROOT = 'E:/code/小魔怪-push';
const ENGINE = [
  'shared/src/engine/interp.ts', 'shared/src/engine/permanents.ts',
  'shared/src/engine/abilities.ts', 'shared/src/engine/options.ts',
  'shared/src/engine/state.ts', 'shared/src/engine/resources.ts',
  'shared/src/engine/api.ts',
].map((p) => readFileSync(`${ROOT}/${p}`, 'utf8')).join('\n');

/** 每条更正 → 引擎里应存在的关键标识 */
const KEY = {
  1: ['INITIAL_MONEY'], 2: ['INITIAL_INCOME'], 3: ['GOAL_SCORE_1'],
  4: ['homelessSmooth'], 5: ["addRes(p, 'malice', 1)"], 7: ['policePayBribe'],
  8: ['homelessSmooth'], 9: ['gainJailExp'], 10: ['jailCardLimit'],
  11: ['optionUsedThisTurn'], 13: ['judgeJustice'], 14: ['Breathing_Tax'],
  15: ['resolvePassThrough'], 16: ['经过厄运格'], 17: ['tribune'],
  18: ['danger:'], 19: ["case 'Risk'"], 20: ['jailTermFor'],
  21: ['mayorId'], 22: ['astralFromBank'], 23: ['ELECTION_VOTE_BONUS'],
  24: ['就职 +1 齿轮'], 25: ['MF_EXCLUDED_AT_FIVE_PLAYERS'],
  26: ['buildMisfortuneDeck'], 27: ['chaosPool'], 28: ['SpecialFlag'],
  29: ['jailKarma'],
};

const readme = readFileSync(`${ROOT}/docs/README.md`, 'utf8');
const rows = [];
for (const line of readme.split(/\r?\n/)) {
  // 更正表行：| # | 项目 | ... |  末尾可能多一列"复核状态"
  const m = /^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|?\s*$/.exec(line);
  if (m) rows.push({
    no: Number(m[1]), topic: m[2].trim(),
    hist: m[3].trim(), fix: m[4].trim(), src: m[5].trim(), state: (m[6] ?? '').trim(),
  });
}

let problems = 0;
console.log(`更正表条目: ${rows.length}\n`);
console.log(' #  主题                 复核状态');
console.log('--- ------------------- -------------------------------------------');
for (const r of rows) {
  const keys = KEY[r.no] ?? [];
  const hit = keys.filter((k) => ENGINE.includes(k));
  const implemented = keys.length > 0 && hit.length === keys.length;
  // 该行是否**声称仍然缺失**（看复核状态列，而不是历史列）
  const claimsMissing = /仍缺|仍缺失|未实现|无命中/.test(r.state) && !/已修|已实现|一致/.test(r.state);
  let verdict = implemented ? '✅ 引擎已有' : (hit.length ? '⚠️ 部分命中' : '❌ 引擎没有');
  let flag = '';
  if (implemented && claimsMissing) { verdict = '❗ 文档过时'; flag = '  ← 声称缺失但已实现'; problems++; }
  console.log(`${String(r.no).padStart(3)} ${r.topic.slice(0, 19).padEnd(19)} ${verdict}${flag}`);
}

console.log(`\n=== 结论 ===`);
console.log(problems === 0
  ? '✓ 没有"声称缺失但其实已实现"的条目'
  : `✗ 有 ${problems} 条文档与实现不一致，需要修正 README`);
console.log('\n※ 本脚本只检查"声称缺失"的条目；');
console.log('  "被实现但文档仍标未实现"会误导后续开发，是这类审计的主要目标。');
process.exit(problems === 0 ? 0 : 1);
