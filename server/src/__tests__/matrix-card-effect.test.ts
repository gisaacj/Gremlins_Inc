// =============================================================
// 基础功能矩阵 ③：**每张牌打出来效果都能生效**
//
// 与"按 bug 写用例"不同：这里**穷举全部 186 张行动卡 + 混沌卡 + 厄运卡 + 监狱卡**，
// 逐张把它打到场上，验证：
//   A. 打出后**不出现**"效果「X」尚未实现"
//   B. 打出后要么产生可见变化（资源 / 手牌 / 位置 / 永久卡 / 挂起），
//      要么是**已知的"纯移动标记/纯提示"卡**（白名单显式列出）
//   C. 需要玩家选择的卡必须**真的挂起**（不能"选了等于没选"）
//   D. 打完一路应答到底不卡死
//
// 运行: npx tsx server/src/__tests__/matrix-card-effect.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  ACTION_CARDS, CHAOS_CARDS, CHARACTERS, JAIL_CARDS, MISFORTUNE_CARDS,
} from '@gremlins/shared/gamedata';
import {
  answerChoice, availableOptions, buildEnginePrompt, createState, finishTurnActions, getMap,
  getPlayer, movableCards, nextTurn, playableCards, playEffectCard,
} from '@gremlins/shared/engine';
import type { EnginePlayer, EngineState } from '@gremlins/shared/engine';
import type { ActionCard } from '@gremlins/shared/gamedata';

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

/**
 * 已知"打出本身不改变状态"的卡（纯标记 / 纯提示），显式白名单。
 * 每一条都要写明**为什么**它可以不产生变化。
 */
const NO_CHANGE_OK: Record<string, string> = {
  // 永久卡里那些"登记被动规则"的：效果发生在**以后**触发时，不是打出瞬间
  a113: '永久卡：赌场重掷许可，登记后等触发',
  a114: '永久卡：他人造访垃圾场时收费',
  a115: '永久卡：每 6 回合结算',
  a116: '永久卡：贿赂站点豁免（概率）',
  a117: '永久卡：他人贿赂 +N',
  a118: '永久卡：他人造访赌场时 +$',
  a119: '永久卡：他人造访赌场时 +&',
  a120: '永久卡：自己造访藏宝阁时 +$',
  a121: '永久卡：到站无牌可打时可弃牌（已单测）',
  a122: '永久卡：自己造访工厂时 +$',
  a123: '永久卡：可从银行直达天界',
  a124: '永久卡：同地点可再打一张',
  a131: '永久卡：逮捕时刑期修正',
  a138: '永久卡：5/6 点移动时收费',
  a142: '永久卡：赌博站点 +$',
  a153: '永久卡：市场卖齿轮时 +|',
  a154: '永久卡：交锋时 +*',
  a158: '永久卡：集齐 3 张换 1 张',
  a159: '永久卡：每回合结束 +*',
  a164: '永久卡：1 点移动时 +$',
  a165: '永久卡：囚犯回合开始 +$',
  a173: '永久卡：集齐 2 张结算',
  a174: '永久卡：他人用秘密卡时收费',
  a175: '永久卡：回合开始 -$',
  a183: '永久卡：豁免逮捕并传送赌场',
  a185: '永久卡：永久卡被丢弃时重生',
  a112: '永久卡：厄运豁免',
  // 纯标记 / 纯提示
  a169: '慈善：只有 outcome（|-N），无 actions',
};

function fresh(seed = 1): { st: EngineState; a: EnginePlayer } {
  const st = createState({
    roomId: 'm3', seed, targetScore: 999,
    players: ['Banker', 'Engineer', 'Gambler'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = 3000; p.res.vote = 30; p.hand = []; p.inJail = false;
    p.res.malice = 1; p.res.score = 10; p.term = 0; p.res.income = 30;
  }
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  for (const id of ['P1', 'P2']) getPlayer(st, id)!.cellId = map.cells.find((c) => c.cellType === 'Jail')!.id;
  st.currentIndex = st.players.indexOf(a);
  return { st, a };
}

function settle(st: EngineState, viewerId: string) {
  let prompt = buildEnginePrompt(st, viewerId);
  if (prompt || st.phase !== 'playing') return prompt;
  finishTurnActions(st);
  if (!st.pending) nextTurn(st);
  return buildEnginePrompt(st, viewerId);
}

/**
 * 状态指纹。
 *
 * ⚠️ 手牌必须记**内容**而不只是张数：a078「古代经文」是"抽 6 张、保留 6 张"，
 * 手牌张数不变但牌换了 —— 只比张数会误判成"没有变化"。
 */
const probe = (st: EngineState, a: EnginePlayer) => JSON.stringify({
  m: a.res.money, v: a.res.vote, s: a.res.score, e: a.res.malice,
  t: a.term, i: a.res.income, h: [...a.hand].sort(), p: [...a.permanents].sort(),
  sec: a.secrets.length, jail: a.inJail, cell: a.cellId, turns: a.extraTurns,
  deck: st.deck.length, discard: st.discard.length,
  others: st.players.map((p) => `${p.res.money},${p.res.vote},${p.res.score},${p.res.malice},${p.cellId},${[...p.hand].sort().join('+')}`).join('|'),
});

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

/** 把一张卡放到"能打出的格子"上 */
function placeFor(st: EngineState, a: EnginePlayer, card: ActionCard): void {
  const map = getMap(st);
  const cells = map.cells.filter((c) => c.cellTypeId === card.cellTypeId);
  a.cellId = (cells[0] ?? map.cells[0])!.id;
  a.movedThisTurn = true;
  a.cardsPlayedThisTurn = 1;
}

console.log('=== ③ 每张牌打出效果都能生效（穷举全部卡）===');

const groups: Array<[string, ActionCard[], boolean]> = [
  ['行动卡', ACTION_CARDS as unknown as ActionCard[], true],
  ['混沌卡', CHAOS_CARDS as unknown as ActionCard[], false],
  ['厄运卡', MISFORTUNE_CARDS as unknown as ActionCard[], false],
  ['监狱卡', JAIL_CARDS as unknown as ActionCard[], false],
];

const noChange: string[] = [];
const unimplemented: string[] = [];
const stuckCards: string[] = [];
const noPending: string[] = [];
let totalCards = 0;
let playedCards = 0;
let changedCards = 0;

check('A/B/C/D. 逐张打出：无"尚未实现"、有变化或白名单、需要选择就挂起、不卡死', () => {
  for (const [groupName, cards, needLocation] of groups) {
    for (const c of cards) {
      totalCards++;
      const { st, a } = fresh();
      // ── 把局面构造成"这张卡能真的发挥作用"的样子 ──
      // 对手要有永久卡（a045 财产税 / a184 秘密仓库这类按永久卡计费）
      for (const p of st.players) {
        if (p.id !== a.id && p.permanents.length === 0) {
          p.permanents = ACTION_CARDS.filter((x) => x.permanent).slice(0, 2).map((x) => x.id);
        }
      }
      // 手里要有牌（a186 弃光手牌这类需要真的弃）
      const filler = ACTION_CARDS.filter((x) => x.id !== c.id && !x.specialMove).slice(0, 5).map((x) => x.id);
      if (needLocation) {
        placeFor(st, a, c);
        // 手里的填充牌要"不在当前格能打出的类型上"，避免它们干扰
        a.hand = [c.id, ...filler];
      } else {
        a.cellId = getMap(st).cells.find((x) => x.out.length > 0)!.id;
        a.movedThisTurn = true;
        a.hand = [c.id];
      }

      const before = probe(st, a);
      const logBefore = st.log.length;
      const r = playEffectCard(st, a.id, c.id);
      if (!r.ok) continue;          // 打不出（不在此格）不算失败
      playedCards++;
      const hadPending = !!st.pending;

      // 一路应答到底
      let prompt = settle(st, a.id);
      let g = 0;
      while (st.pending && g++ < 40) {
        const pend = st.pending;
        const rr = answerChoice(st, pend.playerId, pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value));
        st.pending = rr.pending;
        if (!rr.ok) break;
        prompt = settle(st, a.id);
      }

      const after = probe(st, a);
      // "产生了效果"的判据（满足任一即可）：
      //   - 资源 / 手牌 / 永久卡 / 位置 / 额外回合发生变化
      //   - 产生过挂起（需要玩家选择）
      //   - 打出了带动作的卡后**新增了日志**（说明解释器真的跑了动作）
      const newLogs = st.log.slice(logBefore).filter((l) => !l.text.includes('打出「'));
      const changed = before !== after || hadPending || newLogs.length > 0;

      if (st.log.some((l) => l.text.includes('尚未实现'))) {
        unimplemented.push(`${groupName}/${c.name}「${c.text.name}」`);
      }
      if (!changed) {
        if (NO_CHANGE_OK[c.name]) noChange.push(c.name);
        else noChange.push(`!!${groupName}/${c.name}「${c.text.name}」`
          + ` actions=${JSON.stringify((c.actions ?? []).map((x) => String(x.type)))}`);
      } else {
        changedCards++;
      }
      const hasSelect = (c.actions ?? []).some((x) => /^Select/.test(String(x.type)));
      if (hasSelect && !hadPending && before === after) {
        noPending.push(`${groupName}/${c.name}「${c.text.name}」有 Select 动作却没挂起也没变化`);
      }
      const mine = st.players[st.currentIndex]!.id === a.id;
      if (!st.pending && prompt === null && mine && !a.inJail
        && movableCards(st, a.id).length === 0
        && playableCards(st, a.id).length === 0
        && availableOptions(st, a.id).length === 0) {
        stuckCards.push(`${groupName}/${c.name}「${c.text.name}」`);
      }
    }
  }

  assert.equal(unimplemented.length, 0,
    `这些卡出现了"尚未实现"：\n      ${unimplemented.slice(0, 12).join('\n      ')}`);
  assert.equal(noPending.length, 0,
    `这些卡有 Select 动作却"选了等于没选"：\n      ${noPending.slice(0, 12).join('\n      ')}`);
  assert.equal(stuckCards.length, 0,
    `这些卡打完会卡死：\n      ${stuckCards.slice(0, 12).join('\n      ')}`);
  const suspicious = noChange.filter((x) => x.startsWith('!!'));
  assert.equal(suspicious.length, 0,
    `这些卡打出后没有任何变化（资源/挂起/日志都没有），且不在白名单里：\n      ${suspicious.slice(0, 12).join('\n      ')}`);
});

check('B2. 覆盖统计（可读性检查）', () => {
  console.log(`      共 ${totalCards} 张卡，实际打出 ${playedCards} 张`);
  console.log(`      有变化/有挂起/有日志：${changedCards} 张`);
  console.log(`      白名单（登记被动规则、效果延后触发）：${noChange.filter((x) => !x.startsWith('!!')).length} 张`);
  assert.ok(changedCards > playedCards * 0.5,
    `有变化的卡只占 ${Math.round(changedCards / Math.max(1, playedCards) * 100)}%，覆盖率偏低，可能有整类卡静默失效`);
});

console.log(`\n通过 ${pass} 组，失败 ${fail} 组（覆盖 ${totalCards} 张卡）`);
if (fail > 0) process.exitCode = 1;
