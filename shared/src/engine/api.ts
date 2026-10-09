// =============================================================
// engine 公开 API 门面
//
// 把 `state.ts` / `interp.ts` / `options.ts` 的内部函数收成一个稳定的动作接口，
// 供 server（socket 处理）、客户端单机与 AI 共用。所有函数都返回统一的 ActionResult。
// =============================================================
import type { EngineState, PendingChoice } from './model.js';
import { CARD_BY_ID, cellLabel, getCell, getMap, getPlayer } from './model.js';
import {
  canAffordCard, canMoveWithCard, canPlayCard, createState, endTurn,
  resolvePending, startMove, takeJailTurn,
} from './state.js';
import type { EngineInitArgs } from './state.js';
import { playEffectCard } from './state.js';
import { availableOptions, doOption, type OptionSpec } from './options.js';

export type { EngineInitArgs };

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** 是否产生了新的挂起决策 */
  pending?: PendingChoice;
}

const fail = (error: string): ActionResult => ({ ok: false, error });
const ok = (pending?: PendingChoice): ActionResult => ({ ok: true, pending });

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

  // 逐段推进，遇到岔路时按"是否仍在通往目的地的路径上"自动选
  let result = startMove(state, playerId, cardId);
  let guard = 0;
  while (result.pending && guard++ < 40) {
    const pend = result.pending;
    if (!pend.kind.startsWith('moveBranch:')) break; // 非选路挂起，交给上层

    const pick = autoPickBranch(state, pend, destinationTileId, playerId, cardId, card.move);
    if (!pick) break; // 无法自动决定 → 留给玩家

    result = startMove(state, playerId, cardId, { [pend.kind]: [pick] });
  }

  if (!result.ok) return fail(result.reason ?? '移动失败');
  return ok(result.pending);
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
export function playCard(
  state: EngineState,
  playerId: string,
  cardId: string,
): ActionResult {
  const p = getPlayer(state, playerId);
  if (!p) return fail('玩家不存在');
  if (!isTurn(state, playerId)) return fail('不是你的回合');
  if (state.pending) return fail('有未完成的决策');
  const chk = canPlayCard(state, p, cardId);
  if (!chk.ok) return fail(chk.reason ?? '不能打出');
  const r = playEffectCard(state, playerId, cardId);
  if (!r.ok) return fail(r.reason ?? '打出失败');
  return ok(r.pending);
}

/** 跳过打牌（不做任何事） */
export function skipPlay(state: EngineState, playerId: string): ActionResult {
  if (!isTurn(state, playerId)) return fail('不是你的回合');
  if (state.pending) return fail('有未完成的决策');
  return ok();
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
  return doOption(state, playerId, optionId, targetId);
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
  return ok(r.pending);
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
/** 结束当前回合，交给下一位；返回是否已分出胜负 */
export function nextTurn(state: EngineState): { ok: boolean; error?: string; gameOver: boolean } {
  if (state.pending) return { ok: false, error: '有未完成的决策', gameOver: false };
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
