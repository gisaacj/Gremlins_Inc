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
import {
  addRes, firstId, firstNumber, hasTag, parseParams, payAmount, transferRes,
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
        ownerId: ctx.ownerId,
        scratch: ctx.scratch ? { ...ctx.scratch } : undefined,
      },
      ...extra,
    },
  };
}

const takeChoice = (ctx: ActionContext, kind: string): string[] | undefined => {
  const c = ctx.choices?.[kind];
  return c && c.length ? c : undefined;
};

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
  // 「秘密关系」：按掷出 6 判刑；否则正常掷骰
  const alwaysSix = abilFlags.arrestAsSix === true;
  const dice = alwaysSix ? 6 : rollDice(state);
  p.inJail = true;
  p.term = dice <= 2 ? 4 : dice <= 4 ? 3 : 2;
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
    runActions(state, {
      actions: card.actions,
      index: 0,
      targets: [p.id],
      ownerId: p.id,
      source: `厄运「${card.text.name}」`,
    });
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
    case 'ROLL':
    case 'MoneyRoll':
    case 'Casino':
    case 'CasinoBonus':
    case 'Junkyard':
    case 'RiskVotes':
    case 'TreasureReroll': {
      const o = owner(state, ctx);
      state.lastRoll = rollDice(state);
      log(state, o.id, `${ctx.source}：掷骰 ${state.lastRoll}`);
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
        const r = payAmount(tgt, o, slots, { defaultKey: 'money' });
        log(state, tgt.id, `${nameOf(tgt)} 失去 ${r.paid} ${RES_LABEL[r.key]}`);
        if (!r.full && hasTag(slots, 'Arrest')) arrest(state, tgt, `${ctx.source}：无力足额支付`);
        break;
      }
    }
  }
  return undefined;
}
