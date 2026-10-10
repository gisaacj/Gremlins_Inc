// =============================================================
// engine 公开 API 门面
//
// 把 `state.ts` / `interp.ts` / `options.ts` 的内部函数收成一个稳定的动作接口，
// 供 server（socket 处理）、客户端单机与 AI 共用。所有函数都返回统一的 ActionResult。
// =============================================================
import type { EnginePlayer, EngineState, PendingChoice, ResourceKey } from './model.js';
import {
  CARD_BY_ID, CELL_TYPE_BY_ID, CHAOS_CARDS, cellLabel, getCell, getMap, getPlayer,
} from './model.js';
import {
  canAffordCard, canMoveWithCard, canPlayCard, createState, endTurn,
  finishTurnActions, resolveLanding, resolvePending, startMove, takeJailTurn,
} from './state.js';
import type { EngineInitArgs } from './state.js';
import { playEffectCard } from './state.js';
import { discardPermanent } from './permanents.js';
import { addRes } from './resources.js';
import { runActions } from './interp.js';
import { rollDice, drawTo } from './interp.js';
import { availableOptions, doOption, type OptionSpec } from './options.js';
import { isDiscardMoveCard } from '../board-view.js';

export type { EngineInitArgs };

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** 是否产生了新的挂起决策 */
  pending?: PendingChoice;
}

const fail = (error: string): ActionResult => ({ ok: false, error });
const ok = (pending?: PendingChoice): ActionResult => ({ ok: true, pending });

/**
 * 检查当前玩家是否还有可做的事情；如果没有则自动结束回合。
 *
 * 触发条件（全部满足）：
 *  - 无挂起决策
 *  - 已移动（movedThisTurn = true）或在狱中
 *  - 无额外走牌可走（extraTurns = 0 或没有可移动牌）
 *  - 无可打效果牌
 *  - 无可选动作（站点/建筑）
 */
function maybeAutoEnd(state: EngineState): ActionResult {
  if (state.pending) return ok(state.pending);

  const pid = currentPlayerId(state);
  const p = getPlayer(state, pid);
  if (!p) return ok();
  if (!p.movedThisTurn && !p.inJail) return ok();

  // 终点格效果尚未结算 → 不自动结束（等 skipPlay 触发 resolveLanding）
  if (!p.flags['cellResolved']) return ok();

  // 有额外走牌且还能移动 → 不自动结束
  if (p.extraTurns > 0 && movableCards(state, pid).length > 0) return ok();

  // 还有可打的效果牌 → 不自动结束
  // 但要考虑 cardsPlayedThisTurn：移动用 1 张、效果牌用 1 张后不能再打。
  const canPlayMore = p.cardsPlayedThisTurn <= 1 || p.flags['canPlayAgain'] === 1;
  if (canPlayMore && playableCards(state, pid).length > 0) return ok();

  // 还有可选动作 → 不自动结束
  if (availableOptions(state, pid).length > 0) return ok();

  // 没事可做了 → 自动换人
  const r = nextTurn(state);
  return r.ok ? ok() : fail(r.error ?? '换人失败');
}

/** 建立新对局 */
export const newGame = createState;

/** 当前行动玩家 id */
export function currentPlayerId(state: EngineState): string {
  return state.players[state.currentIndex]?.id ?? '';
}

/** 是否轮到这个玩家 */
export function isTurn(state: EngineState, playerId: string): boolean {
  return currentPlayerId(state) === playerId;
}

/** 是否有待决策（阻塞其他操作） */
export function hasPending(state: EngineState): boolean {
  return !!state.pending;
}

// ---------------------------------------------------------------- 移动
/** 从 from 到 dest 的一条最短路径（沿 out 边），找不到返回 undefined */
function pathTo(state: EngineState, from: string, dest: string): string[] | undefined {
  if (from === dest) return [];
  const prev = new Map<string, string>();
  const seen = new Set([from]);
  let frontier = [from];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      const cell = getCell(state, id);
      if (!cell) continue;
      for (const nb of cell.out) {
        if (seen.has(nb) || !getCell(state, nb)) continue;
        seen.add(nb);
        prev.set(nb, id);
        if (nb === dest) {
          const path: string[] = [];
          let cur = dest;
          while (cur !== from) {
            path.unshift(cur);
            cur = prev.get(cur)!;
          }
          return path;
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  return undefined;
}

/**
 * 用卡牌移动。
 *
 * 玩家给出目的地时，服务端会把路径上的岔路口**自动按"朝目的地的方向"**选掉，
 * 只有出现多条同样通往目的地的岔路（或没给目的地）时才回问玩家。
 * 这样界面上「点目的地 → 确认」的交互不需要玩家逐段选路。
 */
export function moveWithCard(
  state: EngineState,
  playerId: string,
  cardId: string,
  destinationTileId?: string,
): ActionResult {
  const p = getPlayer(state, playerId);
  if (!p) return fail('玩家不存在');
  if (!isTurn(state, playerId)) return fail('不是你的回合');
  if (state.pending) return fail('有未完成的决策');

  const chk = canMoveWithCard(p, cardId);
  if (!chk.ok) return fail(chk.reason ?? '不能用于移动');

  const card = CARD_BY_ID[cardId]!;
  if (destinationTileId && !getCell(state, destinationTileId)) return fail('目的地不存在');

  // 弃牌移动牌（a059 二手货）：move=0，选一个对手，随机弃其一张牌，
  // 以该牌 MovePoints 为步数，再给对手补 1 张。
  // 若 customMoveSteps 已设（由 discardMoveCard 或 AI 预设），则直接走。
  if (isDiscardMoveCard(cardId) && p.flags['customMoveSteps'] == null) {
    const opponents = state.players.filter(
      (x) => x.id !== playerId && !x.inJail && x.hand.length > 0,
    );
    if (!opponents.length) return fail('没有可选择的对手');
    const pending: PendingChoice = {
      kind: `discardMove:${cardId}`,
      playerId,
      prompt: '选择一名对手：随机弃其一张牌，以该牌移动点数行走',
      options: opponents.map((o) => ({ value: o.id, label: o.name })),
      min: 1,
      max: 1,
      resume: {
        actions: [],
        index: 0,
        targets: [],
        source: '二手货',
        ownerId: playerId,
        scratch: destinationTileId ? { destinationTileId } : undefined,
      },
    };
    state.pending = pending;
    return ok(pending);
  }

  // 掷骰移动牌的步数（从 player.flags 读取，由 rollMoveDice 设置）
  const effectiveSteps = p.flags['customMoveSteps'] ?? card.move;

  // 把目的地交给 `startMove`：它会用 `findPathTo` **预先算好整条路径**并按它走，
  // 中途不再逐个岔路口提问。这样引擎的实际落点与界面上显示/选定的目的地
  // 必然一致（早先只把目的地当"到了就提前停"的标记，实际落点是靠贪心选岔路
  // 凑出来的，于是"选监狱却走到赌博"——用户 bug #1）。
  let result = startMove(state, playerId, cardId, undefined, { destinationTileId });
  // 兼容：仍保留 destTileId 供"中途建筑提前停止"的旧逻辑使用
  if (result.ok && state.moveCursor && destinationTileId) {
    state.moveCursor.destTileId = destinationTileId;
  }
  // 兜底：只有"无法恰好 N 步走到该目的地"（没算出 plannedPath）时才回退到逐岔路询问
  let guard = 0;
  while (result.pending && guard++ < 40) {
    const pend = result.pending;
    if (!pend.kind.startsWith('moveBranch:')) break;

    const pick = autoPickBranch(state, pend, destinationTileId, playerId, cardId, effectiveSteps);
    if (!pick) break;

    result = startMove(state, playerId, cardId, { [pend.kind]: [pick] }, { destinationTileId });
  }

  if (!result.ok) return fail(result.reason ?? '移动失败');
  if (result.pending) return ok(result.pending);
  return maybeAutoEnd(state);
}

/**
 * 掷骰决定特殊移动牌的步数（a022 装腔作势）。
 * 原版流程：选牌 → 服务端掷骰 → 返回步数 → 玩家选目的地。
 * 这里在 moveWithCard 之前调用，把结果写入 player.flags['customMoveSteps']。
 */
export function rollMoveDice(state: EngineState, playerId: string): number {
  const dice = rollDice(state);
  const p = getPlayer(state, playerId);
  if (p) p.flags['customMoveSteps'] = dice;
  state.lastRoll = dice;
  return dice;
}

/**
 * 弃牌移动牌（a059 二手货）：选一名对手，随机弃其一张牌，
 * 以该牌 MovePoints 作为移动步数，再给对手补 1 张。
 *
 * 原版流程：选牌 → 选对手 → 随机弃对手一张牌 → 以该牌移动点数走 → 对手补 1 张。
 * 这里在 moveWithCard 之前调用，把结果写入 player.flags['customMoveSteps']，
 * 然后 moveWithCard 检测到该 flag 已设，直接走 startMove。
 */
export function discardMoveCard(
  state: EngineState,
  playerId: string,
  cardId: string,
  opponentId: string,
  destinationTileId?: string,
): ActionResult {
  const p = getPlayer(state, playerId);
  if (!p) return fail('玩家不存在');
  if (!isTurn(state, playerId)) return fail('不是你的回合');
  if (state.pending) return fail('有未完成的决策');

  const chk = canMoveWithCard(p, cardId);
  if (!chk.ok) return fail(chk.reason ?? '不能用于移动');

  const opponent = state.players.find((x) => x.id === opponentId);
  if (!opponent) return fail('对手不存在');
  if (opponent.id === playerId) return fail('不能选择自己');
  if (opponent.hand.length === 0) return fail('对手没有手牌');

  // 随机弃对手一张牌
  const rIdx = Math.floor(Math.random() * opponent.hand.length);
  const stolenId = opponent.hand[rIdx];
  opponent.hand.splice(rIdx, 1);
  state.discard.push(stolenId);
  // 给对手补 1 张
  drawTo(state, opponent, 1);

  const stolen = CARD_BY_ID[stolenId];
  const steps = stolen?.move ?? 0;
  p.flags['customMoveSteps'] = steps;
  state.lastRoll = undefined;

  return moveWithCard(state, playerId, cardId, destinationTileId);
}

/**
 * 在岔路口自动选方向。
 *
 * 判定：从每个候选格出发，看剩余步数能否走到目的地；能到的候选里
 * 若有且仅有一条"最短路径的首步"，就选它。多条时返回 undefined（让玩家选）。
 */
function autoPickBranch(
  state: EngineState,
  pend: PendingChoice,
  destination: string | undefined,
  playerId: string,
  cardId: string,
  totalSteps: number,
): string | undefined {
  const candidates = pend.options.map((o) => o.value);
  if (candidates.length === 1) return candidates[0];
  if (!destination) return undefined;

  const cursor = state.moveCursor;
  if (!cursor) return undefined;
  const stepsTaken = cursor.path.length;
  const stepsLeft = cursor.stepsLeft;

  const viable: string[] = [];
  for (const c of candidates) {
    const rest = pathTo(state, c, destination);
    if (!rest) continue;
    // 该候选能否在剩余步数内到达目的地（含"提前停在目的地"的情形）
    if (rest.length <= stepsLeft) viable.push(c);
  }
  if (viable.length === 1) return viable[0];
  if (viable.length > 1) {
    // 多个候选都能到目的地：选距离最短的那个（唯一最短时才算确定）
    const ranked = viable
      .map((c) => ({ c, d: pathTo(state, c, destination)!.length }))
      .sort((a, b) => a.d - b.d);
    if (ranked.length === 1 || ranked[0].d < ranked[1].d) return ranked[0].c;
  }
  void stepsTaken; void playerId; void cardId; void totalSteps;
  return undefined;
}

// ---------------------------------------------------------------- 打牌
/** 在当前地点打出卡牌效果 */
/**
 * 打出一张效果牌。
 *
 * @param targetPlayerId 玩家在界面上**已经选好**的目标玩家。
 *
 * ⚠️ 这个参数是修 bug #5 加的：界面上打出"选择任意玩家"的卡时，
 * 玩家已经在卡牌详情里点过一次目标，但服务端把目标丢了，
 * 于是引擎又挂起一次 `SelectOpponent` —— 玩家被迫**选两次同一个人**。
 * 现在把已选目标直接喂给引擎的第一步选择，不再重复询问。
 */
export function playCard(
  state: EngineState,
  playerId: string,
  cardId: string,
  targetPlayerId?: string,
): ActionResult {
  const p = getPlayer(state, playerId);
  if (!p) return fail('玩家不存在');
  if (!isTurn(state, playerId)) return fail('不是你的回合');
  if (state.pending) return fail('有未完成的决策');
  const chk = canPlayCard(state, p, cardId);
  if (!chk.ok) return fail(chk.reason ?? '不能打出');
  const r = playEffectCard(state, playerId, cardId);
  if (!r.ok) return fail(r.reason ?? '打出失败');

  // 玩家已选好目标 → 直接回答第一次选择，不再问第二遍
  if (r.pending && targetPlayerId) {
    const rr = resolvePending(state, playerId, [targetPlayerId]);
    if (!rr.ok) {
      // 目标不合法（例如该卡其实不需要选人）→ 回退成正常挂起
      return ok(r.pending);
    }
    if (rr.pending) return ok(rr.pending);
    return maybeAutoEnd(state);
  }

  if (r.pending) return ok(r.pending);
  return maybeAutoEnd(state);
}

/**
 * 跳过打牌 = UseCard 阶段结束，**先结算欠着的站点效果（UseCell）**，再换人。
 *
 * ⚠️ 顺序（原版）：Move → Player Conflict → UseCard → **UseCell**。
 * 站点效果不在 Move 阶段结算，而是在这里 —— 这样玩家才有机会
 * 在站点效果生效**之前**打出手里的牌（用户实测反馈的 bug #4）。
 *
 * 若站点效果自己挂起（买保险 / 付贿赂 / 须决策），返回该挂起而不换人。
 */
export function skipPlay(state: EngineState, playerId: string): ActionResult {
  if (!isTurn(state, playerId)) return fail('不是你的回合');
  if (state.pending) return fail('有未完成的决策');

  // 站点效果（UseCell）由 `nextTurn` 统一结算 —— 这样"结束回合"按钮
  // 与"不出牌"走的是同一条路径，不会再出现"站点效果被跳过"（bug #2）。
  const r = nextTurn(state);
  if (!r.ok) {
    // 站点效果自己挂起了（买保险/付贿赂/须决策）→ 交回给玩家处理
    if (state.pending) return ok(state.pending);
    return fail(r.error ?? '换人失败');
  }
  return ok();
}

// ---------------------------------------------------------------- 混沌卡
/** 混沌卡能否打出的原因 */
export interface ChaosOption {
  cardId: string;
  name: string;
  /** 代价描述 */
  cost: string;
  /** 收益描述 */
  gain: string;
  playable: boolean;
  reason?: string;
}

/** 只用到"价格"的最小形状（混沌卡与行动卡共有） */
interface PricedCard {
  price: number;
  priceType: string;
}

/** 代价是否付得起 */
function canAffordChaos(p: EnginePlayer, card: PricedCard): boolean {
  if (card.price <= 0) return true;
  const key: ResourceKey = card.priceType === 'Vote' ? 'vote' : 'money';
  return p.res[key] >= card.price;
}

/**
 * 列出该玩家此刻可以打出的混沌卡。
 *
 * 原版规则（来自游戏内完整说明）：
 *  - "Chaos Cards are available to every player in this session."（共享池，人人可选）
 *  - "Each of the Chaos Cards can only be played once."
 *  - "Chaos Cards cannot be used to move around, they can only be played for action."
 *  - 卡牌的 `CellID` 限定可打出的地点
 */
export function chaosOptions(state: EngineState, playerId: string): ChaosOption[] {
  const p = getPlayer(state, playerId);
  if (!p) return [];
  const cell = getCell(state, p.cellId);
  const atTypeId = cell?.cellTypeId ?? '0';

  return state.chaosPool.map((id) => {
    const card = CHAOS_CARDS.find((c) => c.id === id);
    if (!card) {
      return { cardId: id, name: id, cost: '-', gain: '-', playable: false, reason: '卡牌数据缺失' };
    }
    const inc = card.income;
    const gain = formatBundle(inc ?? {});
    const cost = card.price > 0 ? `${card.price} ${card.priceType === 'Vote' ? '选票' : '金钱'}` : '免费';
    if (card.cellTypeId && card.cellTypeId !== '0' && card.cellTypeId !== atTypeId) {
      const need = CELL_TYPE_BY_ID[card.cellTypeId]?.text?.name ?? '特定地点';
      return { cardId: id, name: card.text.name, cost, gain, playable: false, reason: `需在${need}` };
    }
    if (!canAffordChaos(p, card)) {
      return { cardId: id, name: card.text.name, cost, gain, playable: false, reason: `付不起（需 ${cost}）` };
    }
    // c001「供奉」需要**先丢弃一张激活的永久卡**才算可打。
    //
    // 这里曾有 (一个) 不一致：`playChaosCard` 会检查永久卡并要求 `permanentId`，
    // 而 `chaosOptions` 只查了地点与费用，于是**报告"可打出"但实际必然失败**。
    // 实测：一局里 5 次"可打出"全部以「没有可丢弃的永久卡」告终，
    // 而且这是混沌子系统唯一的失败来源。
    const needsSacrifice = card.actions.some((a) => String(a.type) === 'SacrificePermanent');
    if (needsSacrifice && !p.permanents.length) {
      return { cardId: id, name: card.text.name, cost, gain, playable: false, reason: '需先拥有一张激活的永久卡' };
    }
    return { cardId: id, name: card.text.name, cost, gain, playable: true };
  });
}

/** 资源包 → 简短中文描述 */
function formatBundle(b: { score?: number; malice?: number; money?: number; vote?: number; income?: number }): string {
  const parts: string[] = [];
  if (b.score) parts.push(`${b.score > 0 ? '+' : ''}${b.score} 齿轮`);
  if (b.malice) parts.push(`${b.malice > 0 ? '+' : ''}${b.malice} 罪恶`);
  if (b.money) parts.push(`${b.money > 0 ? '+' : ''}${b.money} 金钱`);
  if (b.vote) parts.push(`${b.vote > 0 ? '+' : ''}${b.vote} 选票`);
  if (b.income) parts.push(`${b.income > 0 ? '+' : ''}${b.income} 收入`);
  return parts.length ? parts.join('，') : '无';
}

/**
 * 打出一张混沌卡。
 *
 * 从共享池移除、付出代价、结算 `Income`（原版把收益放在 `Income` 字段），
 * 并执行卡牌的 `actions`（如 c001 的 `SacrificePermanent`）。
 */
export function playChaosCard(
  state: EngineState,
  playerId: string,
  cardId: string,
  opts: { permanentId?: string } = {},
): ActionResult {
  const p = getPlayer(state, playerId);
  if (!p) return fail('玩家不存在');
  if (!isTurn(state, playerId)) return fail('不是你的回合');
  if (state.pending) return fail('有未完成的决策');
  if (!state.chaosPool.includes(cardId)) return fail('该混沌卡已被打出或未启用');

  const card = CHAOS_CARDS.find((c) => c.id === cardId);
  if (!card) return fail('卡牌不存在');

  // 地点限定
  const cell = getCell(state, p.cellId);
  if (card.cellTypeId && card.cellTypeId !== '0' && card.cellTypeId !== cell?.cellTypeId) {
    const need = CELL_TYPE_BY_ID[card.cellTypeId]?.text?.name ?? '特定地点';
    return fail(`需在${need}才能打出`);
  }
  if (!canAffordChaos(p, card)) return fail(`付不起（需 ${card.price}）`);

  // c001「供奉」要求先丢弃一张激活的永久卡
  const needsSacrifice = card.actions.some((a) => String(a.type) === 'SacrificePermanent');
  if (needsSacrifice) {
    if (!p.permanents.length) return fail('没有可丢弃的永久卡');
    if (!opts.permanentId) return fail('需要选择要丢弃的永久卡');
    if (!p.permanents.includes(opts.permanentId)) return fail('该永久卡不在你的激活区');
  }

  // 代价
  if (card.price > 0) {
    const key: ResourceKey = card.priceType === 'Vote' ? 'vote' : 'money';
    addRes(p, key, -card.price);
  }
  // 从共享池移除
  state.chaosPool = state.chaosPool.filter((x) => x !== cardId);
  state.chaosPlayed.push(cardId);

  // 结算收益（原版放在 Income 字段）
  const inc = card.income ?? {};
  for (const [k, v] of Object.entries(inc)) {
    if (typeof v !== 'number' || !v) continue;
    addRes(p, k as ResourceKey, v);
  }

  // 卡牌动作（丢弃永久卡等）
  let pending: PendingChoice | undefined;
  if (needsSacrifice && opts.permanentId) {
    discardPermanent(state, p, opts.permanentId, card.text.name);
  }
  if (card.actions.length) {
    const r = runActions(state, {
      actions: card.actions.filter((a) => String(a.type) !== 'SacrificePermanent'),
      index: 0,
      targets: [p.id],
      ownerId: p.id,
      source: `混沌卡「${card.text.name}」`,
      sourceCardId: card.id,
    });
    if (r.status === 'pending') {
      state.pending = r.pending;
      pending = r.pending;
    }
  }

  logChaos(state, p.id,
    `打出混沌卡「${card.text.name}」：代价 ${card.price > 0 ? `${card.price} ${card.priceType === 'Vote' ? '选票' : '金钱'}` : '免费'}，`
    + `收益 ${formatBundle(inc)}（剩余混沌卡 ${state.chaosPool.length}）`);

  // 最后一张打完 → 标记"本轮结束时赛局结束"（原版规则），此刻还不结束
  if (state.chaosEnabled && state.chaosPool.length === 0) {
    state.chaosEndPending = true;
    logChaos(state, p.id, '全部混沌卡已打出，本赛局将在本轮结束时结算');
  }

  return ok(pending);
}

/** 混沌卡是否已全部打完（原版：该轮结束时赛局结束） */
export function chaosExhausted(state: EngineState): boolean {
  return state.chaosEnabled && state.chaosPool.length === 0;
}

function logChaos(state: EngineState, playerId: string, text: string): void {
  state.log.push({ round: state.round, playerId, text, ts: Date.now() });
  if (state.log.length > 400) state.log.shift();
}

// ---------------------------------------------------------------- 可选动作
/** 列出当前地点可执行的可选动作（投资、卖选票、打工、赌博…） */
export function listOptions(state: EngineState, playerId: string): OptionSpec[] {
  return availableOptions(state, playerId);
}

export interface OptionOutcome {
  ok: boolean;
  error?: string;
  /** 需要玩家再选目标 */
  needsTarget?: { kind: string; candidates: string[] };
  message?: string;
}

/**
 * 执行一个可选动作。
 * @param targetId 需要目标的动作（法院没收选票）用
 */
export function runOption(
  state: EngineState,
  playerId: string,
  optionId: string,
  targetId?: string,
): OptionOutcome {
  const p = getPlayer(state, playerId);
  if (!p) return fail('玩家不存在');
  if (!isTurn(state, playerId)) return fail('不是你的回合');
  const r = doOption(state, playerId, optionId, targetId);
  // 原版规则：用建筑可选动作 = 结束本回合（不能同时打牌）
  if (r.ok && !r.needsTarget) {
    // ⚠️ 顺序：Move → Conflict → UseCard → **UseCell**。
    // 选了一个站点动作就等于完成了 UseCell —— 必须把"欠着的格子效果"
    // 清掉，否则会残留到下一个回合（`endTurn` 不会清 pendingCellEffect）。
    // 有些选项自身已经把格子效果做完了（如 `excavation.income` 直接给了
    // 双倍收入），这类不要重复结算，所以额外标记 cellResolved。
    if (state.pendingCellEffect?.playerId === playerId) {
      if (!p.flags['cellResolved']) finishTurnActions(state);
      state.pendingCellEffect = undefined;
      p.flags['cellResolved'] = 1;
    }
    const nr = nextTurn(state);
    if (!nr.ok) return { ok: false, error: nr.error };
  }
  return r;
}

// ---------------------------------------------------------------- 决策应答
/** 回答挂起决策 */
export function answerChoice(
  state: EngineState,
  playerId: string,
  values: string[],
): ActionResult {
  if (!state.pending) return fail('当前没有待决策项');
  if (state.pending.playerId !== playerId) return fail('不是你的决策');
  const r = resolvePending(state, playerId, values);
  if (!r.ok) return fail(r.reason ?? '应答失败');
  if (r.pending) return ok(r.pending);
  // 挂起决策已解决（如冒险格保险/警察格）——落地效果结算完毕
  const p = getPlayer(state, playerId);
  if (p) p.flags['cellResolved'] = 1;
  return maybeAutoEnd(state);
}

// ---------------------------------------------------------------- 服刑
/** 服刑回合：抽监狱卡结算 */
export function jailTurn(state: EngineState, playerId: string): ActionResult {
  if (!isTurn(state, playerId)) return fail('不是你的回合');
  const r = takeJailTurn(state, playerId);
  if (!r.ok) return fail(r.reason ?? '服刑失败');
  return ok(r.pending);
}

// ---------------------------------------------------------------- 回合流转
/**
 * 结束当前回合，交给下一位；返回是否已分出胜负。
 *
 * ⚠️ **这里会先结算"欠着的站点效果（UseCell）"**。
 *
 * 原先不结算，而客户端的「结束回合」按钮正好走这条路（`game:end_turn`
 * → `nextTurn`），于是玩家一点结束回合，本站效果就**被静默跳过** ——
 * 收入格不给钱、贿赂格不扣钱、警察格不问话、地狱不扣 100。
 * 用户报的"建筑站点经常概率性地不生效"就是它：走「不出牌/结束回合」
 * 就会跳，走别的路径才生效，看起来像随机的（bug #2、#6 同源）。
 *
 * 把结算放进 `nextTurn` 本身，任何调用方都无法再绕过。
 */
export function nextTurn(state: EngineState): { ok: boolean; error?: string; gameOver: boolean } {
  if (state.pending) return { ok: false, error: '有未完成的决策', gameOver: false };

  // 结算欠着的站点效果；若它自己挂起（买保险/付贿赂/须决策），把回合交还给玩家
  const cellPending = finishTurnActions(state);
  if (cellPending || state.pending) {
    return { ok: false, error: '站点效果待结算', gameOver: false };
  }

  endTurn(state);
  return { ok: true, gameOver: state.phase === 'game_over' };
}

// ---------------------------------------------------------------- 给 AI 的只读视图
/** 当前玩家可用来移动的牌 */
export function movableCards(state: EngineState, playerId: string): string[] {
  const p = getPlayer(state, playerId);
  if (!p) return [];
  return p.hand.filter((id) => canMoveWithCard(p, id).ok);
}

/** 当前玩家可在本地打出的效果牌 */
export function playableCards(state: EngineState, playerId: string): string[] {
  const p = getPlayer(state, playerId);
  if (!p) return [];
  return p.hand.filter((id) => canPlayCard(state, p, id).ok);
}

/** 当前玩家是否负担得起某张牌 */
export function affordable(state: EngineState, playerId: string, cardId: string): boolean {
  const p = getPlayer(state, playerId);
  if (!p) return false;
  return canAffordCard(p, cardId).ok;
}

/** 棋盘格的中文名（AI 决策与日志共用） */
export function placeLabel(state: EngineState, cellId: string): string {
  return cellLabel(getCell(state, cellId));
}

/** 地图上的岔路口集合（AI 用来避开复杂路径） */
export function junctionSet(state: EngineState): Set<string> {
  return new Set(getMap(state).cells.filter((c) => c.out.length > 1).map((c) => c.id));
}

export type { EngineState, PendingChoice };
