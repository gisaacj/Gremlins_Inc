// =============================================================
// 警察格二选一测试
//
// 原版文案（来自游戏内完整规则说明）：
//   "Whenever you stop on the Police spot, you must either roll the dice
//    - or pay ~ to avoid the risk of getting arrested."
// 以及永久卡「借口编造器」的英文原文：
//   "50% chance to avoid ~ on Bribe spots.
//    50% chance to avoid ~ on Police spots (when you choose to pay ~ there)."
//
// 运行: npx tsx src/__tests__/police.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_CARDS } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, PERM_TRIGGERS, cellTypeOf, createState, getMap, getPlayer,
  moveWithCard, resolvePending,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

/** 仓库根目录（本文件在 <root>/server/src/__tests__/） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;
const MOVE_CARDS = ACTION_CARDS.filter((c) => c.move > 0 && (c.price ?? 0) === 0)
  .sort((a, b) => a.move - b.move);

function game(seed = 31337): EngineState {
  return createState({
    roomId: 'police', seed, targetScore: 30,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
}

/** 从 from 走恰好 steps 步能到达的格子 */
function reachableIn(st: EngineState, fromId: string, steps: number): string[] {
  let frontier = [fromId];
  const seen = new Set([fromId]);
  for (let i = 0; i < steps; i++) {
    const next: string[] = [];
    for (const id of frontier) {
      const cell = getMap(st).cells.find((c) => c.id === id);
      if (!cell) continue;
      for (const nb of cell.out) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return frontier;
}

/** 找到"能恰好走到警察格"的 (起点, 卡牌, 警察格) */
function findPoliceApproach(st: EngineState) {
  for (const origin of getMap(st).cells) {
    for (const card of MOVE_CARDS.slice(0, 6)) {
      const dests = reachableIn(st, origin.id, card.move)
        .map((id) => getMap(st).cells.find((c) => c.id === id)!)
        .filter((c) => c && c.cellType === 'Police');
      if (dests.length) return { origin, card, dest: dests[0] };
    }
  }
  return undefined;
}

/** 把玩家送到警察格并触发落点结算 */
function landOnPolice(money = 500) {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.res.money = money;
  st.currentIndex = st.players.indexOf(p);
  const pick = findPoliceApproach(st);
  assert.ok(pick, '应能找到走到警察格的方式');
  p.cellId = pick!.origin.id;
  p.hand = [pick!.card.id];
  const r = moveWithCard(st, p.id, pick!.card.id, pick!.dest.id);
  return { st, p, r, pick: pick! };
}

function answer(st: EngineState, value: string): void {
  const pend = st.pending!;
  const res = resolvePending(st, pend.playerId, [value]);
  st.pending = res.pending;
}

console.log('=== 1. 触发与选项 ===');
check('停在警察格会挂起"付贿赂 / 掷骰"二选一', () => {
  const { st, p } = landOnPolice(500);
  assert.ok(st.pending, '应挂起');
  assert.ok(st.pending!.kind.startsWith('police:'), `kind=${st.pending!.kind}`);
  const vals = st.pending!.options.map((o) => o.value);
  assert.deepEqual(vals, ['pay', 'roll'], `实际 ${vals.join(',')}`);
  console.log(`      ${st.pending!.prompt}`);
  void p;
});
check('选项里给出的金额 = 贿赂值（$20 + 罪恶）', () => {
  const { st, p } = landOnPolice(500);
  p.res.malice = 10; // 贿赂应为 30
  // 重新触发一次以反映新的罪恶
  const st2 = game();
  const p2 = getPlayer(st2, 'p0')!;
  p2.res.money = 500;
  p2.res.malice = 10;
  st2.currentIndex = st2.players.indexOf(p2);
  const pick = findPoliceApproach(st2)!;
  p2.cellId = pick.origin.id;
  p2.hand = [pick.card.id];
  moveWithCard(st2, p2.id, pick.card.id, pick.dest.id);
  const label = st2.pending!.options.find((o) => o.value === 'pay')!.label;
  assert.match(label, /30/, `贿赂应为 30，实际标签「${label}」`);
  console.log(`      ${label}`);
});
check('付不起贿赂时不给选项，直接掷骰', () => {
  const { st } = landOnPolice(0);
  if (st.pending) {
    assert.ok(!st.pending.kind.startsWith('police:'),
      `没钱不该给二选一：${st.pending.kind}`);
  }
  console.log('      金钱 0 → 直接掷骰');
});
check('镇长停在警察格无需处理', () => {
  const st = game();
  const p = getPlayer(st, 'p0')!;
  p.res.money = 500;
  st.mayorId = p.id;
  st.currentIndex = st.players.indexOf(p);
  const pick = findPoliceApproach(st)!;
  p.cellId = pick.origin.id;
  p.hand = [pick.card.id];
  moveWithCard(st, p.id, pick.card.id, pick.dest.id);
  assert.ok(!st.pending?.kind.startsWith('police:'), '镇长不该被挂起');
});

console.log('\n=== 2. 选择付贿赂 ===');
check('付贿赂：扣钱且不被捕', () => {
  const { st, p } = landOnPolice(500);
  const cost = p.res.money; // 记录用
  void cost;
  const before = p.res.money;
  answer(st, 'pay');
  const paid = before - p.res.money;
  assert.ok(paid > 0, `应扣钱，实际 ${before} → ${p.res.money}`);
  assert.equal(p.inJail, false, '付了贿赂不该被捕');
  assert.equal(st.pending, undefined, '应已结算完');
  console.log(`      付 ${paid} 金钱，未入狱`);
});
check('付贿赂后不再挂起、可继续游戏', () => {
  const { st } = landOnPolice(500);
  answer(st, 'pay');
  assert.equal(st.pending, undefined);
});

console.log('\n=== 3. 选择掷骰 ===');
check('掷骰：不会扣钱', () => {
  const { st, p } = landOnPolice(500);
  const before = p.res.money;
  answer(st, 'roll');
  assert.equal(p.res.money, before, `掷骰不该扣钱：${before} → ${p.res.money}`);
  assert.equal(st.pending, undefined, '应已结算完');
});
check('掷骰结果写入 lastRoll', () => {
  const { st } = landOnPolice(500);
  answer(st, 'roll');
  assert.ok(typeof st.lastRoll === 'number' && st.lastRoll! >= 1 && st.lastRoll! <= 6,
    `lastRoll=${st.lastRoll}`);
  console.log(`      掷出 ${st.lastRoll}`);
});

console.log('\n=== 4. 永久卡「借口编造器」（Perm_BribeSkip）同时作用于两种格 ===');
check('Perm_BribeSkip 已同时注册到 bribeSpot 与 policePayBribe', () => {
  const raw = PERM_TRIGGERS.Perm_BribeSkip;
  assert.ok(raw, '应注册 Perm_BribeSkip');
  const specs = Array.isArray(raw) ? raw : [raw];
  const evs = specs.flatMap((s) => (Array.isArray(s.event) ? s.event : [s.event]));
  assert.ok(evs.includes('bribeSpot'), `缺 bribeSpot：${JSON.stringify(evs)}`);
  assert.ok(evs.includes('policePayBribe'), `缺 policePayBribe：${JSON.stringify(evs)}`);
  console.log(`      事件: ${evs.join(', ')}`);
});
check('a116 的游戏原文包含警察格（中文说明漏译了这半句）', () => {
  // 注意：`card.text.description` 是**中文**且被截断，只有前半句。
  // 游戏原文（英文）在文案表里，通过能力参数 UIN 才能拿到完整版。
  const c = ACTION_CARDS.find((x) => x.name === 'a116')!;
  assert.ok(c, '应存在 a116');
  const raw = JSON.parse(
    readFileSync(resolve(ROOT, 'test/data/action_cards.json'), 'utf8'),
  ) as Array<{ Name: string; DescriptionID?: { AsString?: string } }>;
  const r = raw.find((x) => x.Name === 'a116')!;
  const uin = r.DescriptionID?.AsString ?? '0';
  const en = new Map<string, string>();
  for (const line of readFileSync(resolve(ROOT, 'test/data/strings/English.txt'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('\t');
    if (i > 0) en.set(line.slice(0, i), line.slice(i + 1));
  }
  const full = en.get(uin) ?? '';
  assert.match(full, /Police/i, `原文应提到 Police，实际「${full}」`);
  console.log(`      英文原文: ${full.replace(/\s+/g, ' ').slice(0, 100)}`);
  console.log(`      中文（截断）: ${c.text.description.replace(/\s+/g, ' ').slice(0, 40)}`);
});

console.log('\n=== 5. 不变量 ===');
check('各种金额下都不出现负资源', () => {
  for (const money of [0, 1, 30, 500, 9999]) {
    const { st, p } = landOnPolice(money);
    if (st.pending) answer(st, 'pay');
    assert.ok(p.res.money >= 0, `money=${money} → ${p.res.money}`);
  }
});
check('警察格存在且是非建筑', () => {
  const st = game();
  const police = getMap(st).cells.filter((c) => c.cellType === 'Police');
  assert.ok(police.length > 0, '应存在警察格');
  assert.equal(cellTypeOf(police[0])?.building, false, '警察格不是建筑');
  console.log(`      警察格 ${police.length} 个`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
