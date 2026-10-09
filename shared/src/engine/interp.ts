// =============================================================
// 动作解释器 —— 原版 ActionList 的执行器
//
// 核心设计：原版动作是**有序列表**，且带隐式目标上下文。
// 例如卡 a001「游说」：  [SelectOpponent(文本ID), OpponentLoseVotes("1")]
// `SelectOpponent` 并不直接产生效果，而是设定后续动作的作用目标。
//
// 执行器维护执行上下文 ctx.targets；遇到 Select* 动作时：
//  - 若调用方已提供选择结果（ctx.choices）→ 直接应用
//  - 否则返回 PendingChoice 挂起，客户端回答后用 resume 续跑
// =============================================================
import type {
  ActionType, EnginePlayer, EngineState, PendingChoice, ResourceKey, CardAction,
} from './model.js';
import {
  CARD_BY_ID, MISFORTUNE_CARDS, cellLabel, characterName, getCell, getMap,
} from './model.js';
import { fireTrigger as firePermTrigger } from './permanents.js';
import { fireAbility } from './abilities.js';
import { collectButtons } from './dialog.js';
import { diceTableOf, handleSpecialOutcome, jailTermFor } from './options.js';
import {
  addRes, firstId, firstNumber, firstResource, hasTag, parseParams, payAmount, transferRes,
  type ParamSlot,
} from './resources.js';

/** 选举间隔（回合） */
export const ELECTION_INTERVAL = 20;

/** 一次动作执行的上下文 */
export interface ActionContext {
  actions: CardAction[];
  /** 下一条待执行下标 */
  index: number;
  /** 已选定目标（玩家 id / 格子 id，依动作而定） */
  targets: string[];
  /** 效果持有者 */
  ownerId: string;
  /** 触发来源描述，用于日志 */
  source: string;
  /**
   * 动作序列所属的卡牌 id（若来自某张牌）。
   *
   * 有些原语需要读**卡牌自身**的 `params` 才能确定规则形态
   * （如 `Auction`：a061 是"最高者付价"，m031 是"全员付价、最低者受罚"），
   * 而动作自己的 `ActionParams` 是空的（`[""]`）。
   */
  sourceCardId?: string;
  /** 调用方预先给出的选择结果（resume 或 AI 决策） */
  choices?: Record<string, string[]>;
  /** 额外数据槽（选定的地点、卡牌等） */
  scratch?: Record<string, string>;
}

export type RunResult =
  | { status: 'done' }
  | { status: 'pending'; pending: PendingChoice };

export function resumeFrom(pending: PendingChoice): ActionContext {
  return {
    actions: pending.resume.actions,
    index: pending.resume.index,
    targets: pending.resume.targets,
    ownerId: pending.resume.ownerId,
    source: pending.resume.source,
    sourceCardId: pending.resume.sourceCardId,
  };
}

// ---------------------------------------------------------------- 基础工具
function owner(state: EngineState, ctx: ActionContext): EnginePlayer {
  const p = state.players.find((x) => x.id === ctx.ownerId);
  if (!p) throw new Error(`engine: 未知玩家 ${ctx.ownerId}`);
  return p;
}

function log(state: EngineState, playerId: string, text: string): void {
  state.log.push({ round: state.round, playerId, text, ts: Date.now() });
  if (state.log.length > 400) state.log.shift();
}

/** 地图全部格 id（按原版格号排序） */
export function mapCellIds(state: EngineState): string[] {
  return getMap(state).cells.map((c) => c.id);
}

/** 目标玩家：ctx.targets 为空则退回"自己" */
function targetPlayers(state: EngineState, ctx: ActionContext): EnginePlayer[] {
  const ids = ctx.targets.length ? ctx.targets : [ctx.ownerId];
  return ids
    .map((id) => state.players.find((p) => p.id === id))
    .filter((p): p is EnginePlayer => !!p);
}

const RES_LABEL: Record<ResourceKey, string> = {
  money: '金钱', vote: '选票', malice: '罪恶',
  score: '齿轮', income: '收入', term: '刑期',
};

const nameOf = (p: EnginePlayer): string => p.name || p.id;

function makePending(
  ctx: ActionContext,
  kind: string,
  prompt: string,
  options: Array<{ value: string; label: string }>,
  extra: Partial<PendingChoice> = {},
): RunResult {
  return {
    status: 'pending',
    pending: {
      kind,
      playerId: ctx.ownerId,
      prompt,
      options,
      min: 1,
      max: 1,
      resume: {
        actions: ctx.actions,
        // 不推进：回答后从同一个选择动作重放，applyChoice 会消费 choices 并写回 target
        index: ctx.index,
        // 必须快照：resume 保存后，后续动作仍会改写 ctx.targets，
        // 若存引用会把"挂起那一刻的目标"覆盖掉。
        targets: [...ctx.targets],
        source: ctx.source,
        sourceCardId: ctx.sourceCardId,
        ownerId: ctx.ownerId,
        scratch: ctx.scratch ? { ...ctx.scratch } : undefined,
      },
      ...extra,
    },
  };
}

/**
 * 像 `makePending` 一样挂起，但可以指定**由谁来答**。
 * `Auction` 要轮流问每个玩家，不能固定用 ctx.ownerId。
 */
function makePendingFor(
  ctx: ActionContext,
  kind: string,
  playerId: string,
  prompt: string,
  options: Array<{ value: string; label: string }>,
): RunResult {
  return {
    status: 'pending',
    pending: {
      kind,
      playerId,
      prompt,
      options,
      min: 1,
      max: 1,
      resume: {
        actions: ctx.actions,
        index: ctx.index,
        targets: [...ctx.targets],
        source: ctx.source,
        sourceCardId: ctx.sourceCardId,
        ownerId: ctx.ownerId,
        scratch: ctx.scratch ? { ...ctx.scratch } : undefined,
      },
    },
  };
}

const takeChoice = (ctx: ActionContext, kind: string): string[] | undefined => {
  const c = ctx.choices?.[kind];
  return c && c.length ? c : undefined;
};

/**
 * 已消费的 `BUTTON` 下标集合。
 *
 * 存在 `ctx.scratch` 里（scratch 是 `Record<string, string>`，所以用逗号分隔的字符串），
 * 并且会被 `makePending` 快照进 resume —— 这样挂起期间也不会丢。
 *
 * @param write 传了就把这份集合写回 ctx.scratch
 */
function consumedButtons(ctx: ActionContext, write?: Set<number>): Set<number> {
  if (write) {
    ctx.scratch = { ...ctx.scratch, __buttons: [...write].join(',') };
    return write;
  }
  const raw = ctx.scratch?.['__buttons'];
  if (!raw) return new Set<number>();
  return new Set(raw.split(',').filter(Boolean).map(Number));
}

// ---------------------------------------------------------------- 随机
/** 可复现的 LCG */
export function random(state: EngineState): number {
  state.rngState = (state.rngState * 1664525 + 1013904223) >>> 0;
  return state.rngState / 0x100000000;
}

export function rollDice(state: EngineState): number {
  return 1 + Math.floor(random(state) * 6);
}

// ---------------------------------------------------------------- 牌堆
export function drawTo(state: EngineState, p: EnginePlayer, n: number): string[] {
  const drawn: string[] = [];
  for (let i = 0; i < n; i++) {
    if (state.deck.length === 0) {
      if (state.discard.length === 0) break;
      state.deck = state.discard.splice(0).reverse();
    }
    const id = state.deck.pop();
    if (id) drawn.push(id);
  }
  p.hand.push(...drawn);
  return drawn;
}

export function discardFromHand(state: EngineState, p: EnginePlayer, n: number): string[] {
  const count = Math.max(0, Math.min(p.hand.length, n));
  const dropped = p.hand.splice(0, count);
  state.discard.push(...dropped);
  return dropped;
}

// ---------------------------------------------------------------- 逮捕/释放/厄运
function findCellByType(state: EngineState, cellType: string): string | undefined {
  return getMap(state).cells.find((c) => c.cellType === cellType)?.id;
}

export function arrest(state: EngineState, p: EnginePlayer, reason: string): void {
  // 逮捕前钩子：永久卡可能豁免逮捕（如「寡头」传送到赌场）
  const preFlags: Record<string, string | number | boolean> = {};
  firePermTrigger(state, 'beforeArrest', { actorId: p.id, flags: preFlags });
  if (preFlags.arrestSkipped) return;

  // 角色能力：被捕时的判刑修正 / 改送地点
  const abilFlags: Record<string, string | number | boolean> = {};
  fireAbility(state, p.id, 'arrest', { flags: abilFlags });

  // 「穷人勿进」：钱不够时改送垃圾场（不触发垃圾场规则）
  if (abilFlags.arrestToJunkyard) {
    const junkyard = findCellByType(state, 'Junkyard');
    if (junkyard) p.cellId = junkyard;
    p.inJail = false;
    p.term = 0;
    log(state, p.id, `${nameOf(p)} 因「穷人勿进」被送往垃圾场（${reason}）`);
    return;
  }

  const jail = findCellByType(state, 'Jail');
  if (jail) p.cellId = jail;
  // 刑期用原版 `Jail` 格子的 Label 表（1,2 = {3}；3,4 = {2}；5,6 = {1}）。
  // 「秘密关系」等角色能力把点数固定为 6。
  const alwaysSix = abilFlags.arrestAsSix === true;
  const dice = alwaysSix ? 6 : rollDice(state);
  p.inJail = true;
  p.term = jailTermFor(dice);
  log(state, p.id,
    `${nameOf(p)} 被逮捕入狱（${reason}），刑期 ${p.term} 次走牌（掷骰 ${dice}${alwaysSix ? '，角色能力固定为 6' : ''}）`);

  // 逮捕后钩子：永久卡可能调整刑期（如「自动狱长」）
  firePermTrigger(state, 'anyArrest', { actorId: p.id });
}

export function release(state: EngineState, p: EnginePlayer): void {
  p.inJail = false;
  p.term = 0;
  log(state, p.id, `${nameOf(p)} 获释`);
}

export function drawMisfortune(state: EngineState, p: EnginePlayer): void {
  // 获得厄运前钩子：永久卡可能以弃置自身代替（如「幸运药水」）
  const preFlags: Record<string, string | number | boolean> = {};
  firePermTrigger(state, 'mustGetMisfortune', { actorId: p.id, flags: preFlags });
  if (preFlags.misfortuneSkipped) return;

  if (state.misfortuneDeck.length === 0) state.misfortuneDeck = MISFORTUNE_CARDS.map((c) => c.id);
  const id = state.misfortuneDeck.pop();
  if (!id) return;
  const card = MISFORTUNE_CARDS.find((c) => c.id === id);
  state.discard.push(id);
  log(state, p.id, `厄运「${card?.text.name ?? id}」：${card?.text.description ?? ''}`);
  if (card?.actions?.length) {
    const r = runActions(state, {
      actions: card.actions,
      index: 0,
      targets: [p.id],
      ownerId: p.id,
      source: `厄运「${card.text.name}」`,
      sourceCardId: card.id,
    });
    // 厄运牌里也会有需要玩家决策的动作（`BUTTON` 二选一、`SelectOpponent` 选人…）。
    // 之前这里丢掉了返回值，挂起状态没写回 state.pending，
    // 于是这些决策被静默跳过——厄运牌只结算了"默认分支"。
    if (r.status === 'pending') state.pending = r.pending;
  }
}

// ---------------------------------------------------------------- 选举
export function runElection(state: EngineState): void {
  const minMalice = Math.min(...state.players.map((p) => p.res.malice));
  const ranked = state.players
    .map((p) => ({ p, votes: p.res.vote + (p.res.malice === minMalice ? 3 : 0) }))
    .sort((a, b) => b.votes - a.votes);
  const top = ranked[0];
  if (!top) return;
  // 镇长特权：就职 +1 齿轮
  state.mayorId = top.p.id;
  top.p.res.score += 1;
  log(state, top.p.id, `选举结束：${nameOf(top.p)} 当选镇长（${top.votes} 票），就职 +1 齿轮`);
  state.nextElectionRound = state.round + ELECTION_INTERVAL;
}

// ---------------------------------------------------------------- 主循环
/**
 * 执行动作序列。需要选择且无预置答案时返回 pending。
 * 玩家回答后，用 resumeFrom(pending) 构造 ctx 并带上 choices 再次调用。
 */
export function runActions(state: EngineState, ctx: ActionContext): RunResult {
  let i = ctx.index;
  while (i < ctx.actions.length) {
    const action = ctx.actions[i];
    // 关键：把当前下标写回 ctx，makePending 依赖 ctx.index 记录续跑位置
    ctx.index = i;
    const pending = execAction(state, ctx, action);
    if (pending) return pending;
    i = ctx.index + 1;
  }
  return { status: 'done' };
}

/** 执行单条动作；返回 pending 表示需要玩家决策 */
function execAction(
  state: EngineState,
  ctx: ActionContext,
  action: CardAction,
): RunResult | undefined {
  const type = action.type as ActionType;
  const slots = parseParams(action.params);

  switch (type) {
    // ============ 目标选择（可能挂起） ============
    case 'SelectOpponent':
    case 'SelectSelf':
    case 'SelectEvil':
    case 'SelectGovernor':
    case 'SelectPermanent':
    case 'SelectBonus':
    case 'SelectPunishment':
    case 'SelectZek':
    case 'SelectDeckCard':
    case 'NameLocation':
    case 'Teleport': {
      // 若本次调用已带有该选择的答案（resume 路径），先把它应用到 ctx，
      // 这样目标才对后续动作可见，pending 快照也不会丢。
      const chosen = takeChoice(ctx, type);
      if (chosen) applyChoice(state, ctx, type, chosen);
      return handleSelect(state, ctx, type, slots);
    }

    // ============ 二选一（对话框按钮） ============
    // 一张牌用两个 `BUTTON` 表达"两害取其轻"，各带一条分支动作序列。
    // 玩家点哪个按钮就走哪条分支。
    //
    // 「按组处理」是关键：两个 BUTTON 与它们的分支**共用一条动作列表**，
    // 所以选完分支 0 之后，主循环会继续走到分支 1 的动作。之前只在 BUTTON
    // 处 return undefined，结果**两条分支都执行了**（选钱还扣齿轮）。
    // 因此这里一次性推进整组：执行选中分支，然后直接跳到组末尾。
    case 'BUTTON': {
      const buttons = collectButtons(ctx.actions);
      if (buttons.length < 2) return undefined; // 结构不完整就跳过，不卡住

      const groupEnd = buttons[buttons.length - 1].branchEnd;
      const consumed = consumedButtons(ctx);

      // 本组已处理过 → 直接跳到组末尾（不再重复执行任何分支）
      if ([...consumed].some((i) => buttons.some((b) => b.branchStart - 1 === i))) {
        ctx.index = groupEnd - 1;
        return undefined;
      }

      const key = `BUTTON:${ctx.index}`;
      const chosen = takeChoice(ctx, key);
      if (!chosen) {
        return makePending(ctx, key, '选择一个结果', buttons.map((b, k) => ({
          value: String(k),
          label: b.label,
        })));
      }

      const pick = buttons.find((b) => b.label === chosen[0]) ?? buttons[Number(chosen[0])];
      // 用子上下文只跑选中的分支，避免主循环顺带跑掉另一条分支
      if (pick) {
        const sub: ActionContext = { ...ctx, actions: pick.actions, index: 0 };
        const r = runActions(state, sub);
        if (r.status === 'pending') return r;
      }
      consumed.add(ctx.index);
      consumedButtons(ctx, consumed);
      ctx.index = groupEnd - 1;
      return undefined;
    }

    // ============ 作用域（不挂起，只改 targets） ============
    case 'AllOpponents': {
      ctx.targets = state.players.filter((p) => p.id !== ctx.ownerId).map((p) => p.id);
      return undefined;
    }
    case 'AllPlayers': {
      ctx.targets = state.players.map((p) => p.id);
      return undefined;
    }
    case 'EvilPlayers': {
      const max = Math.max(...state.players.map((p) => p.res.malice));
      const evil = state.players.filter((p) => p.res.malice === max);
      ctx.targets = (evil.length ? evil : [owner(state, ctx)]).map((p) => p.id);
      return undefined;
    }

    // ============ 自己获益 ============
    case 'GetIncome': {
      const o = owner(state, ctx);
      const times = firstNumber(slots, 1) || 1;
      const gained = addRes(o, 'money', o.res.income * times);
      log(state, o.id, `${ctx.source}：获得收入 ×${times} → +${gained} ${RES_LABEL.money}`);
      return undefined;
    }

    // ============ 拍卖（每个玩家出价） ============
    // a061「拍卖」：             最高者付价，+出价额 齿轮
    // m031「总统造访」：         所有人都付价，最低者 -出价额 齿轮
    // 用 params 区分两种形态（规则写在卡牌说明里，参数只够做形态判别）。
    case 'Auction':
      return handleAuction(state, ctx, action.params ?? []);

    // ============ 比较资源（不满足则跳过后续动作） ============
    // a134「伪证」：...该玩家给你{1}*；**若其罪恶高于你，则被逮捕**。
    // 英文原文: "...; if their ^ is higher than yours, they are arrested."
    // 所以 `CompareResource(malice)` 之后的 `OpponentArrest` 只在
    // "目标该资源 > 自己"时执行；否则跳过后续动作。
    case 'CompareResource': {
      const key = (firstResource(slots) ?? 'malice') as ResourceKey;
      const me = owner(state, ctx);
      const targets = targetPlayers(state, ctx);
      const pass = targets.length > 0 && targets.every((t) => t.res[key] > me.res[key]);
      if (!pass) {
        // 条件不成立 → 跳过后续动作
        ctx.index = ctx.actions.length;
        log(state, me.id, `比较 ${RES_LABEL[key]} 未满足，跳过后续效果`);
      }
      return undefined;
    }

    // ============ 最高属性奖励 ============
    // a181「知名品牌」：每当你拥有最高的 $、*、&、^、| 或 ~ 之一：
    //   +{1}* 以及 |+{2}   （params = [1, 3]）
    // 英文原文: "For each occasion where you have the highest $, *, &, ^, | or ~:
    //            +{1}*, |+{2}."
    case 'TopStatBonus': {
      const me = owner(state, ctx);
      // 对应原文的 $ * & ^ | ~ 六项
      const keys: ResourceKey[] = ['money', 'score', 'vote', 'malice', 'income', 'term'];
      let count = 0;
      for (const k of keys) {
        const max = Math.max(...state.players.map((p) => p.res[k]));
        if (max > 0 && me.res[k] === max) count++;
      }
      const perScore = firstNumber(slots, 0);
      const perIncome = Number(action.params?.[1] ?? 0);
      if (count > 0) {
        if (perScore) addRes(me, 'score', perScore * count);
        if (perIncome) addRes(me, 'income', perIncome * count);
        log(state, me.id,
          `「知名品牌」：${count} 项资源最高 → +${perScore * count} ${RES_LABEL.score}，+${perIncome * count} ${RES_LABEL.income}`);
      } else {
        log(state, me.id, '「知名品牌」：没有任何一项资源最高，无奖励');
      }
      return undefined;
    }

    // ============ 赌场重掷 / 摇骰器 ============
    // a030「幸运币」（Yet another chance）：在赌场中赌博 —— 用赌场骰表结算一次
    case 'CasinoReroll': {
      const me = owner(state, ctx);
      const table = diceTableOf('Casino');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const outcome = table[dice];
      if (outcome?.gain) {
        for (const [k, v] of Object.entries(outcome.gain)) {
          if (!v) continue;
          addRes(me, k as ResourceKey, v);
        }
      }
      log(state, me.id, `「幸运币」赌场掷出 ${dice}：${dice <= 3 ? '输' : '赢'}（${JSON.stringify(outcome?.gain ?? {})}）`);
      return undefined;
    }

    // a170「摇骰器」（Dice-roller）：掷骰子，每有一张移动点数与骰点相同的手牌 +{1}$
    case 'SameMovePoints': {
      const me = owner(state, ctx);
      const per = firstNumber(slots, 0);
      const dice = rollDice(state);
      state.lastRoll = dice;
      const hits = me.hand.filter((id) => CARD_BY_ID[id]?.move === dice);
      const gain = hits.length * per;
      if (gain) addRes(me, 'money', gain);
      log(state, me.id,
        `「摇骰器」掷出 ${dice}：${hits.length} 张同点数手牌 → +${gain} ${RES_LABEL.money}`);
      return undefined;
    }

    // ============ 对手减益 ============
    case 'OpponentLoseVotes':
    case 'OpponentLoseScore':
    case 'OpponentLoseMalice':
    case 'OpponentLoseIncome':
    case 'OpponentLoseMoney':
    case 'OpponentPayMoney':
    case 'OpponentPayScore':
      return handleResourceLoss(state, ctx, type, slots);

    case 'OpponentGetMisfortune': {
      const n = firstNumber(slots, 1) || 1;
      for (const tgt of targetPlayers(state, ctx)) for (let k = 0; k < n; k++) drawMisfortune(state, tgt);
      return undefined;
    }

    case 'OpponentArrest': {
      for (const tgt of targetPlayers(state, ctx)) {
        if (hasTag(slots, 'Evil')) {
          const maxMalice = Math.max(...state.players.map((p) => p.res.malice));
          if (tgt.res.malice < maxMalice) continue;
        }
        arrest(state, tgt, ctx.source);
      }
      return undefined;
    }

    case 'OpponentSkipTurn': {
      const n = firstNumber(slots, 1) || 1;
      for (const tgt of targetPlayers(state, ctx)) {
        tgt.skipTurns += n;
        log(state, tgt.id, `${nameOf(tgt)} 将跳过 ${n} 次走牌`);
      }
      return undefined;
    }

    case 'OpponentRedraw': {
      for (const tgt of targetPlayers(state, ctx)) {
        state.discard.push(...tgt.hand.splice(0));
        drawTo(state, tgt, 6);
        log(state, tgt.id, `${nameOf(tgt)} 更换了全部手牌`);
      }
      return undefined;
    }

    case 'OpponentShowHand': {
      const value = firstNumber(slots, 0);
      const tags = slots.filter((s): s is { kind: 'tag'; value: string } => s.kind === 'tag').map((s) => s.value);
      const o = owner(state, ctx);
      for (const tgt of targetPlayers(state, ctx)) {
        log(state, o.id, `查看了 ${nameOf(tgt)} 的手牌`);
        if (tags.includes('SecretPay')) {
          const n = tgt.hand.filter((id) => {
            const c = CARD_BY_ID[id];
            return c?.secret || c?.criminal;
          }).length;
          const gain = n * (value || 0);
          if (gain > 0) {
            transferRes(tgt, o, 'money', gain);
            log(state, o.id, `其中 ${n} 张秘密/罪恶卡，${nameOf(tgt)} 支付 ${gain} ${RES_LABEL.money}`);
          }
        } else if (tags.includes('CellPay')) {
          const placeId = ctx.scratch?.placeId;
          const n = placeId
            ? tgt.hand.filter((id) => cardPlayableAtCell(state, id, placeId)).length
            : 0;
          const gain = n * (value || 0);
          if (gain > 0) {
            transferRes(tgt, o, 'money', gain);
            log(state, o.id, `其中 ${n} 张可在该地点打出，${nameOf(tgt)} 支付 ${gain} ${RES_LABEL.money}`);
          }
        } else if (tags.includes('Discard')) {
          const n = firstNumber(slots, 1) || 1;
          const dropped = discardFromHand(state, tgt, n);
          addRes(o, 'malice', dropped.length);
          log(state, o.id, `丢弃其 ${dropped.length} 张手牌，+${dropped.length} ${RES_LABEL.malice}`);
        }
      }
      return undefined;
    }

    case 'OpponentSwitchPlaces': {
      const o = owner(state, ctx);
      for (const tgt of targetPlayers(state, ctx)) {
        [o.cellId, tgt.cellId] = [tgt.cellId, o.cellId];
        log(state, o.id, `与 ${nameOf(tgt)} 交换了位置`);
      }
      return undefined;
    }

    case 'OpponentTeleport': {
      const dest = firstId(slots) ?? ctx.scratch?.placeId;
      if (!dest) return undefined;
      for (const tgt of targetPlayers(state, ctx)) {
        tgt.cellId = dest;
        log(state, tgt.id, `${nameOf(tgt)} 被传送到 ${cellLabel(getCell(state, dest))}`);
      }
      return undefined;
    }

    case 'OpponentGetsYourTerm': {
      const o = owner(state, ctx);
      const moved = o.term;
      for (const tgt of targetPlayers(state, ctx)) tgt.term += moved;
      o.term = 0;
      if (moved > 0) log(state, o.id, `刑期 ${moved} 转移给对手`);
      return undefined;
    }

    // ============ 移动 ============
    case 'RandomTeleport': {
      const o = owner(state, ctx);
      const ids = mapCellIds(state);
      if (!ids.length) return undefined;
      o.cellId = ids[Math.floor(random(state) * ids.length)];
      log(state, o.id, `随机传送到 ${cellLabel(getCell(state, o.cellId))}`);
      return undefined;
    }

    case 'Move_Back': {
      const o = owner(state, ctx);
      const steps = firstNumber(slots, o.lastMoveSteps) || o.lastMoveSteps || 1;
      let cur = getCell(state, o.cellId);
      for (let i = 0; i < steps && cur; i++) {
        const prev = cur.in[0];
        if (!prev) break;
        cur = getCell(state, prev);
      }
      if (cur) {
        o.cellId = cur.id;
        log(state, o.id, `反向移动 ${steps} 步到 ${cellLabel(cur)}`);
      }
      return undefined;
    }

    case 'MOVE':
    case 'SpecialMove':
      // 由回合流程驱动，动作序列中仅作标记
      return undefined;

    // ============ 回合流程 ============
    case 'AddTurn':
    case 'PlayExtraCard': {
      const o = owner(state, ctx);
      o.extraTurns += 1;
      log(state, o.id, `${ctx.source}：获得 1 次额外走牌`);
      return undefined;
    }
    case 'SkipDraw': {
      owner(state, ctx).flags['skipDraw'] = 1;
      return undefined;
    }
    case 'IgnoreCell': {
      owner(state, ctx).flags['ignoreCell'] = 1;
      return undefined;
    }
    case 'PickCardEarly': {
      owner(state, ctx).flags['pickCardEarly'] = 1;
      return undefined;
    }
    case 'Discard': {
      const o = owner(state, ctx);
      const n = firstNumber(slots, o.hand.length) || o.hand.length;
      const dropped = n >= o.hand.length
        ? (() => { const d = o.hand.splice(0); state.discard.push(...d); return d; })()
        : discardFromHand(state, o, n);
      log(state, o.id, `丢弃 ${dropped.length} 张手牌`);
      return undefined;
    }
    case 'Freedom': {
      release(state, owner(state, ctx));
      return undefined;
    }
    case 'ChangeTerm': {
      const n = firstNumber(slots, 1);
      for (const tgt of targetPlayers(state, ctx)) {
        tgt.term = Math.max(0, tgt.term + n);
        log(state, tgt.id, `刑期 ${n >= 0 ? '+' : ''}${n} → ${tgt.term}`);
      }
      return undefined;
    }
    case 'PayTerm': {
      const o = owner(state, ctx);
      const n = firstNumber(slots, 1);
      const paid = Math.min(o.term, n);
      o.term -= paid;
      log(state, o.id, `支付刑期 -${paid}`);
      return undefined;
    }
    case 'ChangeGovernship': {
      const o = owner(state, ctx);
      if (state.mayorId === o.id) {
        state.mayorId = undefined;
        log(state, o.id, `${nameOf(o)} 不再担任镇长`);
      } else {
        state.mayorId = o.id;
        log(state, o.id, `${nameOf(o)} 成为镇长`);
      }
      return undefined;
    }
    case 'Elections': {
      runElection(state);
      return undefined;
    }
    case 'WindOfChanges': {
      for (const p of state.players) {
        state.discard.push(...p.hand.splice(0));
        drawTo(state, p, 6);
      }
      log(state, ctx.ownerId, '风向变了：全体更换手牌');
      return undefined;
    }

    // ============ 永久卡 ============
    case 'SacrificePermanent': {
      const o = owner(state, ctx);
      if (!o.permanents.length) return undefined;
      const pre = takeChoice(ctx, type) ?? (ctx.scratch?.permanentId ? [ctx.scratch.permanentId] : undefined);
      if (!pre) {
        return makePending(ctx, type, '选择要牺牲的永久卡',
          o.permanents.map((id) => ({ value: id, label: CARD_BY_ID[id]?.text.name ?? id })));
      }
      const idx = o.permanents.indexOf(pre[0]);
      if (idx >= 0) {
        const removed = o.permanents.splice(idx, 1)[0];
        state.discard.push(removed);
        log(state, o.id, `牺牲永久卡「${CARD_BY_ID[removed]?.text.name ?? removed}」`);
      }
      return undefined;
    }

    case 'Exchange_Perm': {
      log(state, ctx.ownerId, '永久卡交换');
      return undefined;
    }

    // ============ 骰子类 ============
    // 注意：这里**只能**放真正的"只掷骰"原语。
    // 曾经把 CasinoBonus / RiskVotes / MoneyRoll 等也归进来，结果它们
    // 只掷骰、完全不结算。现在 coverage 测试专门拦这种归并。
    case 'ROLL': {
      const o = owner(state, ctx);
      state.lastRoll = rollDice(state);
      log(state, o.id, `${ctx.source}：掷骰 ${state.lastRoll}`);
      return undefined;
    }

    // m024「诈骗集团」：掷骰，按**逐点金额表**结算。
    //   ActionParams = ["-100","-70","-50","-30","-10","10"]，与卡牌
    //   params [100,70,50,30,10,10] 同值 → 点数 i 对应第 i 个金额。
    //   原版说明在这张卡上被截断（只到"掷骰子："），所以规则依据是参数表本身。
    case 'MoneyRoll': {
      const o = owner(state, ctx);
      const table = (action.params ?? []).map((x) => Number(x) || 0);
      const dice = rollDice(state);
      state.lastRoll = dice;
      const delta = table[dice - 1] ?? 0;
      if (delta >= 0) addRes(o, 'money', delta);
      else addRes(o, 'money', -Math.min(o.res.money, -delta));
      log(state, o.id, `${ctx.source}：掷出 ${dice} → ${delta >= 0 ? '+' : ''}${delta} ${RES_LABEL.money}`);
      return undefined;
    }

    // ============ 赌场 / 摇骰类卡牌 ============
    // a027「轻松赌博」：在赌场赌博，**赢钱翻三倍**；输的钱超过持有则**不涨罪恶**；
    //                  另有 AddTurn 给额外走牌（由后续动作负责）。
    case 'CasinoBonus': {
      const o = owner(state, ctx);
      const table = diceTableOf('Casino');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const gain = table[dice]?.gain?.money ?? 0;
      if (gain > 0) {
        // 赢钱翻三倍（相对赌场标准表的金额）
        const win = gain * 3;
        addRes(o, 'money', win);
        log(state, o.id, `${ctx.source}：赌场掷出 ${dice}，赢钱翻三倍 +${win} ${RES_LABEL.money}`);
      } else if (gain < 0) {
        const paid = Math.min(o.res.money, -gain);
        addRes(o, 'money', -paid);
        // 「输的钱超过持有则不涨罪恶」——所以这里**不**加罪恶
        log(state, o.id, `${ctx.source}：赌场掷出 ${dice}，损失 ${paid} ${RES_LABEL.money}（不涨 ${RES_LABEL.malice}）`);
      } else {
        log(state, o.id, `${ctx.source}：赌场掷出 ${dice}，无事`);
      }
      return undefined;
    }

    // 监狱牌 t002「大转盘」：赌场骰表结算（params 与赌场格完全一致）
    case 'Casino': {
      const o = owner(state, ctx);
      const table = diceTableOf('Casino');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const outcome = table[dice]?.gain;
      if (outcome) {
        for (const [k, v] of Object.entries(outcome)) {
          if (!v) continue;
          addRes(o, k as ResourceKey, v);
        }
      }
      log(state, o.id, `${ctx.source}：地下轮盘掷出 ${dice} → ${JSON.stringify(outcome ?? {})}`);
      return undefined;
    }

    // 监狱牌 t003「垃圾」：规则与垃圾场相同（params 全 0，用垃圾场格的表）
    case 'Junkyard': {
      const o = owner(state, ctx);
      const table = diceTableOf('Junkyard');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const outcome = table[dice];
      if (outcome?.gain) {
        for (const [k, v] of Object.entries(outcome.gain)) {
          if (!v) continue;
          addRes(o, k as ResourceKey, v);
        }
      }
      log(state, o.id, `${ctx.source}：翻垃圾掷出 ${dice} → ${outcome?.special ?? JSON.stringify(outcome?.gain ?? {})}`);
      return undefined;
    }

    // a022「装腔作势」：触发赌博站效果，**并额外获得等同于骰子点数的选票**
    case 'RiskVotes': {
      const o = owner(state, ctx);
      const table = diceTableOf('Risk');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const outcome = table[dice];
      if (outcome?.gain) {
        for (const [k, v] of Object.entries(outcome.gain)) {
          if (!v) continue;
          addRes(o, k as ResourceKey, v);
        }
      }
      if (outcome?.special) handleSpecialOutcome(state, o, outcome.special);
      addRes(o, 'vote', dice);
      log(state, o.id, `${ctx.source}：赌博站掷出 ${dice}，额外 +${dice} ${RES_LABEL.vote}`);
      return undefined;
    }

    // a074「魔幻饰品」：搜寻宝藏，可再掷一次（只有最后一次算数）
    case 'TreasureReroll': {
      const o = owner(state, ctx);
      const table = diceTableOf('Treasure');
      // 「可再掷一次」——AI/自动流程用两掷取后者；人类交互留待 UI
      const first = rollDice(state);
      const second = rollDice(state);
      const dice = second;
      state.lastRoll = dice;
      const gain = table[dice]?.gain?.money ?? 0;
      if (gain) addRes(o, 'money', gain);
      log(state, o.id,
        `${ctx.source}：搜寻宝藏（重掷 ${first} → ${dice}，只有最后一次算数）+${gain} ${RES_LABEL.money}`);
      return undefined;
    }

    // ============ 其余原语：显式记录，便于对齐进度 ============
    default: {
      log(state, ctx.ownerId, `${ctx.source}：效果「${type}」尚未实现`);
      return undefined;
    }
  }
}

// ---------------------------------------------------------------- 选择
/**
 * 把玩家的选择写进执行上下文。
 * 目标是「玩家」的动作写 ctx.targets；目标不是玩家的写 ctx.scratch。
 */
function applyChoice(
  state: EngineState,
  ctx: ActionContext,
  kind: ActionType,
  values: string[],
): void {
  switch (kind) {
    case 'SelectOpponent':
    case 'SelectSelf':
    case 'SelectEvil':
    case 'SelectGovernor':
      ctx.targets = [...values];
      break;
    case 'NameLocation':
      ctx.scratch = { ...ctx.scratch, placeId: values[0] };
      break;
    case 'SelectDeckCard':
      ctx.scratch = { ...ctx.scratch, deckCardId: values[0] };
      break;
    case 'SelectPermanent':
      ctx.scratch = { ...ctx.scratch, permanentId: values[0] };
      break;
    case 'Teleport':
      if (values[0]) {
        const actor = state.players.find((p) => p.id === ctx.ownerId);
        if (actor) {
          actor.cellId = values[0];
          log(state, actor.id, `传送到 ${cellLabel(getCell(state, values[0]))}`);
        }
      }
      break;
    default:
      ctx.scratch = { ...ctx.scratch, [kind]: values[0] };
      break;
  }
}

// ---------------------------------------------------------------- 拍卖
/**
 * 取"动作序列所属卡牌"的 `params`。
 *
 * 有些原语的规则形态写在**卡牌**的 params 里，而动作自己的 `ActionParams`
 * 是空的（`[""]`）。例如 `Auction`：
 *
 * | 卡 | 说明 | 卡牌 params | 结算 |
 * |---|---|---|---|
 * | a061 拍卖 | 最高者付价并 +出价额 齿轮 | `[3]` | 只最高者付钱 |
 * | m031 总统造访 | 所有出价都付，最低者 -出价额 齿轮 | `[2]` | 全员付钱 |
 *
 * 找不到就返回 undefined（调用方回退到动作参数）。
 */
function cardParamsOf(ctx: ActionContext): string[] | undefined {
  const id = ctx.sourceCardId;
  if (!id) return undefined;
  const card = CARD_BY_ID[id] ?? MISFORTUNE_CARDS.find((c) => c.id === id);
  if (!card) return undefined;
  return (card.params ?? []).map(String);
}

/**
 * 拍卖：**每个玩家各出一次价**，按顺序逐个询问。
 *
 * 两种形态见 `cardParamsOf` 的说明。出价逐个收集，
 * 用 `ctx.scratch.__bids` 跨挂起保存。
 */
function handleAuction(state: EngineState, ctx: ActionContext, actionParams: string[]): RunResult | undefined {
  // 形态判别用**卡牌**的 params（动作参数是空的）
  const params = cardParamsOf(ctx) ?? actionParams;
  const key = 'auction';
  const bids: Record<string, number> = {};
  const raw = ctx.scratch?.['__bids'];
  if (raw) {
    for (const pair of raw.split(';')) {
      const [id, v] = pair.split('=');
      if (id) bids[id] = Number(v) || 0;
    }
  }

  // 消费本次提交的出价（挂起时是问某一位，resume 时把答案记进 bids）
  const answer = takeChoice(ctx, key);
  if (answer) {
    const who = state.players.find((p) => !(p.id in bids));
    if (who) bids[who.id] = Math.max(0, Number(answer[0]) || 0);
    ctx.scratch = {
      ...ctx.scratch,
      __bids: Object.entries(bids).map(([id, v]) => `${id}=${v}`).join(';'),
    };
  }

  // 还没问完 → 问下一位
  const next = state.players.find((p) => !(p.id in bids));
  if (next) {
    const already = state.players.filter((p) => p.id in bids);
    const prompt = already.length
      ? `拍卖出价（已出价 ${already.length}/${state.players.length}）`
      : '拍卖：请出价';
    return makePendingFor(ctx, key, next.id, prompt, [
      { value: '0', label: '不出价（0）' },
      { value: '50', label: '出价 50 金钱' },
      { value: '100', label: '出价 100 金钱' },
      { value: '200', label: '出价 200 金钱' },
    ]);
  }

  // 出价收齐 → 结算
  const entries = state.players.map((p) => ({ p, bid: Math.max(0, bids[p.id] ?? 0) }));
  // 形态判别：params [2]（→ {1}=2）是"总统造访"，其余按"拍卖"处理
  const penaltyMode = Number(params[0] ?? 0) === 2;
  const maxBid = Math.max(...entries.map((e) => e.bid));
  const minBid = Math.min(...entries.map((e) => e.bid));

  if (penaltyMode) {
    // 所有出价都要付；最低出价者额外 -出价额 齿轮
    for (const { p, bid } of entries) {
      if (bid > 0) transferRes(p, undefined, 'money', bid);
    }
    const losers = entries.filter((e) => e.bid === minBid);
    for (const { p, bid } of losers) {
      const lost = -addRes(p, 'score', -bid);
      log(state, p.id, `「总统造访」最低出价（${bid}）：付 ${bid} 金钱，-${lost} ${RES_LABEL.score}`);
    }
    if (!losers.length) log(state, ctx.ownerId, '「总统造访」：无人出价');
  } else {
    // 只有最高出价者付钱，并 +出价额 齿轮（并列时都算）
    const winners = entries.filter((e) => e.bid === maxBid && e.bid > 0);
    if (!winners.length) {
      log(state, ctx.ownerId, '「拍卖」：无人出价，流拍');
    }
    for (const { p, bid } of winners) {
      transferRes(p, undefined, 'money', bid);
      addRes(p, 'score', bid);
      log(state, p.id, `「拍卖」最高出价（${bid}）：付 ${bid} 金钱，+${bid} ${RES_LABEL.score}`);
    }
  }

  ctx.scratch = { ...ctx.scratch, __bids: '' };
  return undefined;
}

function handleSelect(
  state: EngineState,
  ctx: ActionContext,
  kind: ActionType,
  slots: ParamSlot[],
): RunResult | undefined {
  const o = owner(state, ctx);
  const pre = takeChoice(ctx, kind);

  // 记录来源卡 id，供 Teleport(Card) 之类使用
  if (ctx.scratch?.sourceCardId) {
    // no-op：由调用方写入
  } else if (o.lastMoveCardId) {
    ctx.scratch = { ...ctx.scratch, sourceCardId: o.lastMoveCardId };
  }

  switch (kind) {
    case 'SelectOpponent': {
      if (pre) { ctx.targets = pre; return undefined; }
      const others = state.players.filter((p) => p.id !== o.id);
      if (others.length === 0) { ctx.targets = [o.id]; return undefined; }
      if (others.length === 1) { ctx.targets = [others[0].id]; return undefined; }
      // 带选择条件的形态（如"罪恶最高"）：参数为文本 id，暂按普通选择处理
      return makePending(ctx, kind, `选择一名玩家（${ctx.source}）`,
        others.map((p) => ({
          value: p.id,
          label: `${nameOf(p)}（${RES_LABEL.malice} ${p.res.malice}，${RES_LABEL.money} ${p.res.money}）`,
        })));
    }

    case 'SelectSelf': {
      ctx.targets = [o.id];
      return undefined;
    }

    case 'SelectEvil': {
      if (pre) { ctx.targets = pre; return undefined; }
      const max = Math.max(...state.players.map((p) => p.res.malice));
      const evil = state.players.filter((p) => p.res.malice === max);
      if (evil.length <= 1) { ctx.targets = evil.map((p) => p.id); return undefined; }
      return makePending(ctx, kind, `选择一名${RES_LABEL.malice}最高的玩家`,
        evil.map((p) => ({ value: p.id, label: `${nameOf(p)}（${RES_LABEL.malice} ${p.res.malice}）` })));
    }

    case 'SelectGovernor': {
      if (pre) { ctx.targets = pre; return undefined; }
      const mayor = state.players.find((p) => p.id === state.mayorId);
      if (mayor) { ctx.targets = [mayor.id]; return undefined; }
      return makePending(ctx, kind, '当前无镇长，选择一名玩家',
        state.players.map((p) => ({ value: p.id, label: nameOf(p) })));
    }

    case 'SelectDeckCard': {
      if (pre) { ctx.scratch = { ...ctx.scratch, deckCardId: pre[0] }; return undefined; }
      const n = firstNumber(slots, 1) || 1;
      const sample = state.deck.slice(-Math.min(n, state.deck.length));
      if (!sample.length) return undefined;
      return makePending(ctx, kind, `从牌堆选择 ${n} 张牌`,
        sample.map((id) => {
          const c = CARD_BY_ID[id];
          return { value: id, label: c ? `${c.text.name}（移动 ${c.move}）` : id };
        }), { min: n, max: n });
    }

    case 'SelectPermanent': {
      if (pre) { ctx.scratch = { ...ctx.scratch, permanentId: pre[0] }; return undefined; }
      const pool = state.players.flatMap((p) => p.permanents);
      if (!pool.length) return undefined;
      return makePending(ctx, kind, '选择一张永久卡',
        pool.map((id) => ({ value: id, label: CARD_BY_ID[id]?.text.name ?? id })));
    }

    case 'NameLocation': {
      if (pre) { ctx.scratch = { ...ctx.scratch, placeId: pre[0] }; return undefined; }
      const buildings = buildingCellIds(state);
      if (!buildings.length) return undefined;
      return makePending(ctx, kind, '选择一个地点',
        buildings.map((id) => ({ value: id, label: cellLabel(getCell(state, id)) })));
    }

    case 'Teleport': {
      // Teleport(Card)：传送到"这张牌可打出的地点"
      const tag = slots.find((s) => s.kind === 'tag')?.value;
      if (tag === 'Card') {
        const cardId = ctx.scratch?.sourceCardId ?? o.lastMoveCardId;
        const card = cardId ? CARD_BY_ID[cardId] : undefined;
        if (card?.cellTypeId && card.cellTypeId !== '0') {
          const cell = getMap(state).cells.find((c) => c.cellTypeId === card.cellTypeId);
          if (cell) {
            o.cellId = cell.id;
            log(state, o.id, `传送到 ${cellLabel(cell)}`);
            return undefined;
          }
        }
        return undefined;
      }
      const dest = firstId(slots) ?? ctx.scratch?.placeId;
      if (dest) {
        o.cellId = dest;
        log(state, o.id, `传送到 ${cellLabel(getCell(state, dest))}`);
        return undefined;
      }
      if (pre) {
        o.cellId = pre[0];
        log(state, o.id, `传送到 ${cellLabel(getCell(state, pre[0]))}`);
        return undefined;
      }
      const ids = mapCellIds(state);
      if (!ids.length) return undefined;
      return makePending(ctx, kind, '选择传送目的地',
        ids.map((id) => ({ value: id, label: cellLabel(getCell(state, id)) })));
    }

    default: {
      if (pre) { ctx.scratch = { ...ctx.scratch, [kind]: pre[0] }; return undefined; }
      return undefined;
    }
  }
}

/** 所有建筑格 id */
export function buildingCellIds(state: EngineState): string[] {
  return getMap(state).cells.filter((c) => {
    const cellType = c.cellType;
    return ['Office', 'Plant', 'Junkyard', 'Marketplace', 'Inferno', 'Jail',
      'Casino', 'Courthouse', 'Treasure', 'Bank', 'Astral', 'Tribune'].includes(cellType);
  }).map((c) => c.id);
}

function cardPlayableAtCell(state: EngineState, cardId: string, cellId: string): boolean {
  const card = CARD_BY_ID[cardId];
  if (!card) return false;
  if (!card.cellTypeId || card.cellTypeId === '0') return true;
  const cell = getCell(state, cellId);
  return !!cell && cell.cellTypeId === card.cellTypeId;
}

// ---------------------------------------------------------------- 资源损失
function handleResourceLoss(
  state: EngineState,
  ctx: ActionContext,
  kind: ActionType,
  slots: ParamSlot[],
): RunResult | undefined {
  const o = owner(state, ctx);

  for (const tgt of targetPlayers(state, ctx)) {
    switch (kind) {
      case 'OpponentLoseVotes':
      case 'OpponentLoseScore':
      case 'OpponentLoseMalice':
      case 'OpponentLoseIncome': {
        const key: ResourceKey =
          kind === 'OpponentLoseVotes' ? 'vote'
          : kind === 'OpponentLoseScore' ? 'score'
          : kind === 'OpponentLoseMalice' ? 'malice'
          : 'income';
        const amount = firstNumber(slots, 0);
        if (amount > 0) {
          const lost = -addRes(tgt, key, -amount);
          log(state, tgt.id, `${nameOf(tgt)} 失去 ${lost} ${RES_LABEL[key]}`);
        }
        break;
      }

      case 'OpponentPayMoney':
      case 'OpponentPayScore': {
        const key: ResourceKey = kind === 'OpponentPayMoney' ? 'money' : 'score';
        const r = payAmount(tgt, o, slots, { defaultKey: key });
        log(state, tgt.id, `${nameOf(tgt)} 支付 ${r.paid} ${RES_LABEL[r.key]} 给 ${nameOf(o)}`);
        if (hasTag(slots, 'GetHalf') && r.paid > 0) {
          const half = Math.floor(r.paid / 2);
          transferRes(o, tgt, r.key, half);
          log(state, o.id, `返还一半 ${half} ${RES_LABEL[r.key]} 给 ${nameOf(tgt)}`);
        }
        if (!r.full && hasTag(slots, 'Arrest')) arrest(state, tgt, `${ctx.source}：无力足额支付`);
        break;
      }

      case 'OpponentLoseMoney': {
        // 「失去」不是「支付」：钱不进任何人口袋，直接蒸发。
        // 之前把 payee 传成 ctx 的 owner —— 而厄运牌的 ownerId/targets 都是自己，
        // 于是 transferRes 把钱"转给自己"，净变化为 0（`-{1}$` 分支完全没生效）。
        const r = payAmount(tgt, undefined, slots, { defaultKey: 'money' });
        log(state, tgt.id, `${nameOf(tgt)} 失去 ${r.paid} ${RES_LABEL[r.key]}`);
        if (!r.full && hasTag(slots, 'Arrest')) arrest(state, tgt, `${ctx.source}：无力足额支付`);
        break;
      }
    }
  }
  return undefined;
}
