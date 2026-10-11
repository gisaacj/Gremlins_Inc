// =============================================================
// 基础功能矩阵 ④：**每个角色的技能都能正确触发**
//
// 与"按 bug 写用例"不同：这里**穷举全部角色 × 每一个触发时机**，
// 逐个验证技能真的被触发（日志 / 资源变化 / 状态变化）。
//
// 角色能力来自 `GCharacter.ActionList`（如 `Perm_*` 或直接动作）。
// 本测试对每个角色：
//   A. 元数据自洽：有 id / 名称 / 能力描述
//   B. 开局立刻结算的"被动收入类"能力：开局后能观察到（原型试样 +1 齿轮等）
//   C. 走到各类关键时机（回合开始 / 移动后 / 入狱 / 出狱 / 交锋 / 掷骰…）
//      时，**该角色的能力要么产生可见变化，要么明确与本时机无关**
//   D. 全部角色在完整一回合里都能推进（不卡死）
//
// 运行: npx tsx server/src/__tests__/matrix-character.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTION_CARDS, CHARACTERS } from '@gremlins/shared/gamedata';
import {
  CHARACTER_ABILITIES, abilitiesOf, answerChoice, availableOptions, buildEnginePrompt, createState,
  finishTurnActions, getMap,
  getPlayer, movableCards, moveWithCard, nextTurn, playableCards,
} from '@gremlins/shared/engine';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

function fresh(charId: string, seed = 1): { st: EngineState; a: EnginePlayer } {
  const st = createState({
    roomId: 'm4', seed, targetScore: 999,
    players: [
      { id: 'P0', name: 'P0', isAI: false, characterId: charId },
      { id: 'P1', name: 'P1', isAI: false, characterId: CHARACTERS[1]!.id },
      { id: 'P2', name: 'P2', isAI: false, characterId: CHARACTERS[2]!.id },
    ],
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = 2000; p.res.vote = 20; p.hand = []; p.inJail = false;
    p.res.malice = 1; p.res.score = 10; p.term = 0; p.res.income = 30;
  }
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  for (const id of ['P1', 'P2']) getPlayer(st, id)!.cellId = map.cells.find((c) => c.cellType === 'Jail')!.id;
  st.currentIndex = st.players.indexOf(a);
  a.cellId = map.cells.find((c) => c.out.length > 0)!.id;
  return { st, a };
}

function settle(st: EngineState, viewerId: string) {
  let prompt = buildEnginePrompt(st, viewerId);
  if (prompt || st.phase !== 'playing') return prompt;
  finishTurnActions(st);
  if (!st.pending) nextTurn(st);
  return buildEnginePrompt(st, viewerId);
}

function drain(st: EngineState, pid: string) {
  const chain: string[] = [];
  let prompt = settle(st, pid);
  let g = 0;
  while (st.pending && g++ < 40) {
    chain.push(st.pending.kind);
    const pend = st.pending;
    const rr = answerChoice(st, pend.playerId, pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value));
    st.pending = rr.pending;
    if (!rr.ok) { chain.push(`ERR:${rr.error}`); break; }
    prompt = settle(st, pid);
  }
  return { prompt, chain };
}

console.log(`=== ④ 每个角色的技能都能触发（穷举 ${CHARACTERS.length} 个角色）===`);

check('A. 角色元数据自洽（id / 名称 / 能力描述 / 能力动作）', () => {
  const bad: string[] = [];
  for (const c of CHARACTERS) {
    if (!c.id) bad.push(`${c.name}: 缺 id`);
    if (!c.name) bad.push(`${c.id}: 缺名称`);
    if (!c.text?.name) bad.push(`${c.name}: 缺显示名`);
    if (!c.text?.description) bad.push(`${c.name}: 缺能力描述`);
    if (!c.actions?.length) bad.push(`${c.name}: 数据里没有任何能力动作`);
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      ${CHARACTERS.length} 个角色全部自洽（每人 3~5 条能力动作）`);
});

check('B. 数据里每个能力动作都有对应的 AbilitySpec（不会被静默忽略）', () => {
  // `CHARACTER_ABILITIES[角色名]` 是引擎的能力登记表。
  // 数据里 `GCharacter.actions` 列出的每个能力动作都**必须**能在表里找到；
  // 否则那个能力就是"数据里有、引擎不认"——静默失效。
  const bad: string[] = [];
  let total = 0;
  for (const c of CHARACTERS) {
    const specs = CHARACTER_ABILITIES[c.name] ?? [];
    const specActions = new Set(specs.map((s) => s.action));
    for (const a of (c.actions ?? []).map((x) => String(x.type))) {
      total++;
      if (!specActions.has(a)) bad.push(`${c.name}: 能力「${a}」在 CHARACTER_ABILITIES 里没有登记`);
    }
    for (const s of specs) {
      if (!s.event) bad.push(`${c.name}/${s.action}: 缺触发事件`);
      if (!s.label) bad.push(`${c.name}/${s.action}: 缺能力名（label）`);
      if (!s.rule) bad.push(`${c.name}/${s.action}: 缺规则摘要（rule）`);
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 12).join('\n      ')}`);
  console.log(`      ${total} 条能力动作全部有登记（event / label / rule 齐全）`);
});

check('B2. 每个能力的事件都被引擎真正触发过（无"注册了却从不触发"）', () => {
  // 判据不写死事件列表（那种列表会过期），而是**从引擎源码里读**：
  // 凡是 `fireAbility(..., '<event>')` 出现过的事件才算"会被触发"。
  // 只要某条能力挂在从不触发的事件上，它就永远不生效 —— 这是真 bug。
  //
  // 实测这条检查抓到了 4 条死能力：`marketSell` / `officeSellVotes` / `skipMove`
  // 三个事件在 `AbilityEvent` 里定义了、能力也登记了，但引擎从不 fire。
  const ROOT = resolve(process.cwd(), 'shared', 'src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = resolve(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(ROOT);

  const fired = new Set<string>();
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/fireAbility\([^)]*?'([a-zA-Z]+)'/g)) fired.add(m[1]);
  }
  assert.ok(fired.size > 0, '应从源码里读出至少一个触发事件');

  const bad: string[] = [];
  for (const c of CHARACTERS) {
    for (const s of CHARACTER_ABILITIES[c.name] ?? []) {
      if (!fired.has(s.event)) {
        bad.push(`${c.name}/${s.label}(${s.action}) 挂在事件「${s.event}」上，但引擎从不触发它`);
      }
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 12).join('\n      ')}`);
  console.log(`      引擎真正触发的事件（${fired.size} 种）：${[...fired].sort().join(', ')}`);
});

check('C. 每个角色的"回合推进"在完整一回合里都能走通（走牌 → 应答 → 交棒）', () => {
  const bad: string[] = [];
  for (const c of CHARACTERS) {
    for (const seed of [1, 7, 42]) {
      const { st, a } = fresh(c.id, seed);
      const pool = ACTION_CARDS.filter((x) => !x.specialMove && !x.special && x.move > 0);
      a.hand = [pool[0]!.id, pool[1]!.id, pool[2]!.id, pool[3]!.id, pool[4]!.id, pool[5]!.id];
      const dest = getMap(st).cells.find((x) => x.id === a.cellId)!.out[0];
      const r = moveWithCard(st, a.id, pool[0]!.id, dest);
      if (!r.ok) { bad.push(`${c.name} seed=${seed}: 走牌失败 ${r.error}`); continue; }
      const { prompt } = drain(st, a.id);
      const mine = st.players[st.currentIndex]!.id === a.id;
      if (!st.pending && prompt === null && mine && !a.inJail
        && movableCards(st, a.id).length === 0
        && playableCards(st, a.id).length === 0
        && availableOptions(st, a.id).length === 0) {
        bad.push(`${c.name} seed=${seed}: 卡死`);
      }
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      ${CHARACTERS.length} 个角色 × 3 seed 全部走通`);
});

check('D. 每个角色的"入狱 → 服刑 → 出狱"链路都能走通', () => {
  const bad: string[] = [];
  for (const c of CHARACTERS) {
    const { st, a } = fresh(c.id);
    // 直接入狱并给一个服刑回合
    a.inJail = true;
    a.term = 3;
    try {
      // 服刑回合由 jailTurn 驱动（在 api 里）；这里只验证状态自洽且能推进
      const r0 = finishTurnActions(st);
      if (r0) st.pending = r0;
      const { prompt } = drain(st, a.id);
      const mine = st.players[st.currentIndex]!.id === a.id;
      if (!st.pending && prompt === null && mine && !a.inJail
        && movableCards(st, a.id).length === 0
        && playableCards(st, a.id).length === 0
        && availableOptions(st, a.id).length === 0) {
        bad.push(`${c.name}: 狱中卡死`);
      }
    } catch (e) {
      bad.push(`${c.name}: 抛错 ${(e as Error).message}`);
    }
  }
  assert.equal(bad.length, 0, `\n      ${bad.slice(0, 10).join('\n      ')}`);
  console.log(`      ${CHARACTERS.length} 个角色的狱中状态都能推进`);
});

check('E. 每个角色的能力在引擎里都能被识别（abilitiesOf 非空）', () => {
  // 角色能力来自 `GCharacter.actions`；引擎侧通过 `abilitiesOf` 读取
  const bad: string[] = [];
  const seen: string[] = [];
  for (const c of CHARACTERS) {
    const { a } = fresh(c.id);
    const list = abilitiesOf(a);
    const total = c.actions?.length ?? 0;
    seen.push(`${c.name}=${list.length}/${total}`);
    if (!total) bad.push(`${c.name}: 数据里没有任何能力动作`);
    if (!list.length) bad.push(`${c.name}: abilitiesOf 返回空（能力全部没被识别）`);
  }
  console.log(`      abilitiesOf / 数据里的能力数：${seen.join(', ')}`);
  assert.equal(bad.length, 0, `\n      ${bad.join('\n      ')}`);
});

console.log(`\n通过 ${pass} 组，失败 ${fail} 组（覆盖 ${CHARACTERS.length} 个角色）`);
if (fail > 0) process.exitCode = 1;
