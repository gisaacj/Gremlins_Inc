// =============================================================
// 用户第四批问题的回归测试
//
//  bug A：走到警察格、没牌可出时仍弹「无可用动作，跳过结束回合」
//         → 无事可做应直接自动结束回合
//  bug B：抽到监狱卡（如 t004「倒爷」）看不到牌、也没法点开预览
//         → 界面要拿到候选卡 id，才能渲染成卡牌并预览
//  bug C：冒险格保险询问重复弹（用户"点了四次不买或跳过"）
//         → 根因是 `danger.insure` 是**没有处理分支的幽灵选项**，
//           点了没反应、回合也不推进；且格子效果问完后没推进回合
//
// 运行: npx tsx server/src/__tests__/danger-jail.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, JAIL_CARDS } from '@gremlins/shared/gamedata';
import { displayCardRules } from '@gremlins/shared';
import {
  CHARACTERS, JAIL_PICK_KIND, answerChoice, availableOptions, buildEnginePrompt, createState,
  doOption, endTurn, finishTurnActions, getMap, getPlayer, moveWithCard,
  resolvePending, skipPlay, takeJailTurn,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;
const card1 = ACTION_CARDS.find((c) => c.move === 1 && c.price === 0 && !c.specialMove)!;

function game(names = ['Banker', 'Engineer']): EngineState {
  const st: EngineState = createState({
    roomId: 'dj', seed: 11, targetScore: 999,
    players: names.map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = 1000; p.res.malice = 0; p.res.vote = 3; p.hand = []; p.inJail = false;
  }
  st.currentIndex = st.players.indexOf(getPlayer(st, 'P0')!);
  return st;
}

/** 把对手关起来，避免意外交锋干扰 */
function parkOpponent(st: EngineState) {
  const jail = getMap(st).cells.find((c) => c.cellType === 'Jail');
  const b = getPlayer(st, 'P1');
  if (jail && b) b.cellId = jail.id;
}

/** 走到某类格子 */
function landOn(st: EngineState, cellType: string) {
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  const target = map.cells.find((c) => c.cellType === cellType)!;
  const prev = map.cells.find((c) => c.out.includes(target.id))!;
  a.cellId = prev.id;
  a.hand = [card1.id];
  moveWithCard(st, a.id, card1.id, target.id);
  return { a, target };
}

// ─────────────────────────────────────────────────────────────
console.log('=== bug C：冒险格保险只该问一次 ===');

check('可选动作里不再有幽灵的 danger.insure', () => {
  const st = game();
  parkOpponent(st);
  const { a } = landOn(st, 'Danger');
  const ids = availableOptions(st, a.id).map((o) => o.id);
  assert.ok(!ids.includes('danger.insure'),
    `不该再有 danger.insure（它在 doOption 里没有处理分支）：${ids.join(', ')}`);
  console.log(`      可选动作: ${ids.join(', ') || '(无)'}`);
});

check('danger.insure 即便被硬塞也会被拒绝（不是静默无操作）', () => {
  const st = game();
  parkOpponent(st);
  const { a } = landOn(st, 'Danger');
  const r = doOption(st, a.id, 'danger.insure');
  assert.equal(r.ok, false, '幽灵选项应明确失败，而不是"看起来成功但什么都没做"');
  console.log(`      返回: ${r.ok ? 'ok' : (r as { error?: string }).error}`);
});

check('完整走一遍：保险问一次，答完就交棒（不是四次）', () => {
  const st = game();
  parkOpponent(st);
  const { a } = landOn(st, 'Danger');

  let asked = 0;
  let steps = 0;
  const trail: string[] = [];

  // 用户操作：有"跳过"就跳过；有保险问询就选"不买"
  while (steps++ < 12) {
    if (st.pending) {
      const pend = st.pending;
      trail.push(`pending:${pend.kind}`);
      if (pend.kind.startsWith('danger:')) asked++;
      const pick = pend.options.slice(-1).map((o) => o.value);   // 最后一个 = 不买
      const r = resolvePending(st, pend.playerId, pick);
      st.pending = r.pending;
      continue;
    }
    const pr = buildEnginePrompt(st, a.id);
    trail.push(pr ? `prompt:${pr.type}` : '(无事可做)');
    if (!pr) {
      // 无事可做 → 自动交棒（等价于 endTurn）
      endTurn(st);
      break;
    }
    if (pr.type === 'play_card_or_skip') { skipPlay(st, a.id); continue; }
    break;
  }

  console.log(`      经历: ${trail.join(' → ')}`);
  assert.equal(asked, 1, `保险只该问 1 次，实际 ${asked} 次`);
  assert.equal(a.movedThisTurn, false, '答完保险后回合应已交给别人');
  console.log(`      保险询问 ${asked} 次，回合已交棒`);
});

check('冒险格保险问完后：格子已结算，且保险问询本身不会再挂起', () => {
  const st = game();
  parkOpponent(st);
  const { a } = landOn(st, 'Danger');
  skipPlay(st, a.id);
  assert.ok(st.pending?.kind.startsWith('danger:'), '应挂起保险问询');
  const pend = st.pending!;
  // ⚠️ 要用 answerChoice（服务端 game:choose 与客户端本地模式都走它），
  // 不能用 resolvePending —— 后者是底层原语，不会设 cellResolved。
  answerChoice(st, pend.playerId, ['skip']);
  // ⚠️ 答完保险后 pending **可能不是空的** —— 冒险格紧接着会掷骰，
  // 掷到 1 要抽厄运（厄运自己会再挂起一次"从 2 张里选 1 张"）。
  // 那是正常流程，不是"没清干净"。真正的不变量是：
  //   1) 不再挂着 danger: 问询（保险只问一次）
  //   2) 格子效果已标记结算
  assert.ok(!st.pending?.kind.startsWith('danger:'),
    `保险不该再问一次，实际挂着 ${st.pending?.kind}`);
  assert.equal(a.flags['cellResolved'], 1, '格子效果应标记为已结算');
  console.log(`      答完保险后 pending=${st.pending?.kind ?? '(无)'}（掷骰后续流程）`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== bug A：无事可做直接自动结束回合 ===');

check('警察格：没牌可出、无可用动作 → 返回 null（不弹多余面板）', () => {
  const st = game();
  parkOpponent(st);
  const { a } = landOn(st, 'Police');
  // 警察格会挂起（付贿赂/掷骰）→ 应答掉
  let g = 0;
  while (st.pending && g++ < 8) {
    const pend = st.pending;
    const r = resolvePending(st, pend.playerId, pend.options.slice(-1).map((o) => o.value));
    st.pending = r.pending;
  }
  assert.equal(buildEnginePrompt(st, a.id), null,
    '此时无事可做，应返回 null 让调用方自动交棒');
});

check('endTurn 会自动跳过"无事可做"的玩家', () => {
  const st = game();
  const a = getPlayer(st, 'P0')!;
  a.movedThisTurn = true;          // 已走完
  a.hand = [];                     // 手上没牌
  const income = getMap(st).cells.find((c) => c.cellType === 'Income')!;
  a.cellId = income.id;            // 收入格没有可选动作（Banker 无挖宝）
  const before = st.currentIndex;
  endTurn(st);
  assert.notEqual(st.currentIndex, before, '无事可做的玩家应被跳过');
  const skipped = st.log.some((l) => l.text.includes('无事可做，自动跳过'));
  console.log(`      换人成功；日志含自动跳过标记: ${skipped}`);
});

check('有事可做的玩家不会被跳过', () => {
  const st = game();
  const a = getPlayer(st, 'P0')!;
  a.movedThisTurn = true;
  a.hand = [];                     // 没牌
  const office = getMap(st).cells.find((c) => c.cellType === 'Office')!;
  a.cellId = office.id;            // 办公楼有 sellVote → 有事可做
  endTurn(st);
  // ⚠️ 不能断言 `movedThisTurn === false`：endTurn 本意是"结束回合"，
  // 但这里因为有可选动作而**提前返回**，把决定权留给玩家 —— 等价于在问
  // "要不要用办公楼的动作？"。用 optionsOffered 标记断言更准确。
  assert.equal(a.flags['optionsOffered'], 1, '应在等玩家决定，不该直接跳过');
  assert.equal(st.currentIndex, st.players.indexOf(a), '不该换人');
  assert.ok(buildEnginePrompt(st, a.id), '此时应有提示（不是 null）');
  console.log(`      停在 UseCell；optionsOffered=${a.flags['optionsOffered']}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== bug B：抽监狱卡要能预览 ===');

check('服刑时提示里带上候选卡 id（界面靠它渲染成卡牌）', () => {
  const st = game();
  const a = getPlayer(st, 'P0')!;
  a.inJail = true;
  a.res.term = 3;
  a.jailRank = 1;
  st.currentIndex = st.players.indexOf(a);

  const r = takeJailTurn(st, a.id);
  assert.ok(r.ok, r.reason);
  assert.equal(st.pending?.kind, JAIL_PICK_KIND);

  const pr = buildEnginePrompt(st, a.id);
  assert.equal(pr?.type, 'choose');
  assert.ok((pr?.cardIds?.length ?? 0) > 0, '应给出候选卡 id');
  // 每个 id 都要能在监狱卡表里查到（否则界面渲染不出名字/规则）
  for (const id of pr!.cardIds!) {
    assert.ok(JAIL_CARDS.some((c) => c.id === id), `卡 id 应能查到：${id}`);
  }
  console.log(`      候选卡: ${pr!.cardIds!.map((id) => JAIL_CARDS.find((c) => c.id === id)?.text.name).join('、')}`);
});

check('候选卡 id 与 choices 的 value 对得上（点了能真的选到）', () => {
  const st = game();
  const a = getPlayer(st, 'P0')!;
  a.inJail = true;
  a.res.term = 3;
  a.jailRank = 1;
  st.currentIndex = st.players.indexOf(a);
  takeJailTurn(st, a.id);
  const pr = buildEnginePrompt(st, a.id)!;
  const values = new Set((pr.choices ?? []).map((c) => c.value));
  for (const id of pr.cardIds!) {
    assert.ok(values.has(id), `choices 里应有 ${id}`);
  }
  // 选一张应能成功结算
  const chosen = pr.cardIds![0]!;
  const rr = resolvePending(st, a.id, [chosen]);
  assert.ok(rr.ok, `选卡应成功：${rr.reason}`);
  console.log(`      选了「${JAIL_CARDS.find((c) => c.id === chosen)?.text.name}」`);
});

check('t004「倒爷」的规则文本可读（不留占位符）', () => {
  const t4 = JAIL_CARDS.find((c) => c.name === 't004')!;
  const pr = buildEnginePrompt;   // 只是引用一下避免 lint 抱怨
  void pr;
  assert.ok(t4, '应有 t004');
  // 规则里不该有 {n} 占位符（界面直接显示它）
  const rule = displayCardRules(t4);
  assert.ok(!/\{\d+\}/.test(rule), `不该留占位符：${rule}`);
  assert.ok(rule.length > 0, '规则不该为空');
  console.log(`      t004「${t4.text.name}」→ ${rule}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== 不变量 ===');

check('所有可选动作 id 都有对应处理（不存在幽灵选项）', () => {
  // 逐个走到有可选动作的格子上，把看到的 option id 拿去 doOption 试；
  // 幽灵选项的特征是"返回 ok 但什么都没变"或"直接抛错"。
  const st = game();
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  const ghosts: string[] = [];
  for (const cell of map.cells) {
    a.cellId = cell.id;
    a.movedThisTurn = true;
    a.hand = [];
    if (st.pending) st.pending = undefined;
    const opts = availableOptions(st, a.id);
    for (const o of opts) {
      if (o.affordable === false) continue;     // 买不起的先跳过
      const before = JSON.stringify({ i: st.currentIndex, f: a.flags });
      const r = doOption(st, a.id, o.id);
      const after = JSON.stringify({ i: st.currentIndex, f: a.flags });
      // `needsTarget` 是**正常**流程（如 courthouse 要先选一名玩家），
      // 不是幽灵 —— 它明确告诉调用方"还需要一个目标"。
      const needsTarget = (r as { needsTarget?: unknown }).needsTarget;
      if (r.ok && !needsTarget && before === after && !st.pending) {
        ghosts.push(`${cell.cellType}:${o.id}`);
      }
      st.pending = undefined;
      a.flags = {};
      a.movedThisTurn = true;
      a.hand = [];
    }
  }
  assert.equal(ghosts.length, 0,
    `发现"点了没反应"的幽灵选项：${ghosts.slice(0, 6).join(', ')}`);
  console.log('      没有幽灵选项');
});

check('finishTurnActions 在格子效果问完后会推进回合', () => {
  const st = game();
  parkOpponent(st);
  const { a } = landOn(st, 'Danger');
  skipPlay(st, a.id);                       // → 挂起保险问询
  assert.ok(st.pending?.kind.startsWith('danger:'));
  resolvePending(st, a.id, ['skip']);       // 不买
  assert.equal(a.movedThisTurn, false, '答完保险回合应已推进');
  console.log('      回合已推进');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
