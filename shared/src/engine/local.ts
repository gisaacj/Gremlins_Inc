// =============================================================
// 本地对局门面（单机模式）
//
// 让客户端脱离服务端跑完整对局：建局 → 人类动作 → AI 自动行动 → 提示。
// 复用了与联机模式**完全相同**的引擎与 AI 策略，只是把"谁在什么时候动"
// 从 socket 事件换成了本地函数调用。
//
// AI 策略的依赖是注入的（`think`），这样 shared 不需要知道 AI 的实现，
// 也不引入循环依赖。
// =============================================================
import type { EngineState, PendingChoice } from './model.js';
import { getPlayer } from './model.js';
import {
  answerChoice, chaosOptions, currentPlayerId, hasPending,
  isTurn, jailTurn, listOptions, moveWithCard, nextTurn, playCard, playChaosCard,
  runOption, skipPlay,
} from './api.js';
import { buildEnginePrompt, serializeEngineState } from './serialize.js';
import { createState } from './state.js';
import type { EngineInitArgs } from './state.js';
import type { PlayerPrompt, SerializedGameState } from '../protocol.js';

/** 本地对局里的一名参与者 */
export interface LocalSeat {
  id: string;
  name: string;
  isAI: boolean;
  characterId?: string;
}

export interface LocalGameOptions extends Omit<EngineInitArgs, 'players'> {
  seats: LocalSeat[];
  /**
   * AI 决策：给定状态与该 AI 的 id，执行它的一步动作。
   * 由调用方注入（服务端用 socket.io 版 AI，客户端用纯函数版）。
   */
  think?: (state: EngineState, playerId: string) => void;
}

/**
 * 本地对局。
 *
 * 典型用法：
 * ```ts
 * const g = new LocalGame({ seats, think: myAI });
 * g.actHuman('move', { cardId, destinationTileId });
 * g.runAI();                 // 让所有 AI 依次行动到轮到人类
 * g.viewFor('p0');           // 取序列化状态
 * g.promptFor('p0');         // 取该玩家该做什么
 * ```
 */
export class LocalGame {
  readonly state: EngineState;
  private readonly think?: (state: EngineState, playerId: string) => void;

  constructor(opts: LocalGameOptions) {
    this.think = opts.think;
    this.state = createState({
      roomId: opts.roomId,
      seed: opts.seed,
      targetScore: opts.targetScore,
      chaosEnabled: opts.chaosEnabled,
      players: opts.seats.map((s) => ({
        id: s.id,
        name: s.name,
        isAI: s.isAI,
        characterId: s.characterId,
      })),
    });
  }

  // ---------------------------------------------------------------- 查询
  get phase(): string { return this.state.phase; }
  get winnerId(): string | undefined { return this.state.winnerId; }
  get round(): number { return this.state.round; }
  get pending(): PendingChoice | undefined { return this.state.pending; }

  /** 该玩家当前该做什么 */
  promptFor(playerId: string): PlayerPrompt | null {
    return buildEnginePrompt(this.state, playerId);
  }

  /** 该玩家视角的完整状态 */
  viewFor(playerId: string): SerializedGameState {
    return serializeEngineState(this.state, playerId);
  }

  /** 是否有待 AI 处理的决策（用于判断要不要继续跑 AI） */
  needsAI(): boolean {
    if (this.state.phase !== 'playing') return false;
    const actor = this.state.pending ? this.state.pending.playerId : currentPlayerId(this.state);
    return !!getPlayer(this.state, actor)?.isAI;
  }

  // ---------------------------------------------------------------- 人类动作
  /** 用卡移动（可带目的地；岔路由引擎按目的地自动选） */
  move(playerId: string, cardId: string, destinationTileId?: string) {
    return moveWithCard(this.state, playerId, cardId, destinationTileId);
  }

  /** 在当前地点打出效果卡 */
  play(playerId: string, cardId: string) {
    return playCard(this.state, playerId, cardId);
  }

  /** 跳过打牌 */
  skip(playerId: string) {
    return skipPlay(this.state, playerId);
  }

  /** 打出一张混沌卡（暴乱卡，全员共享池；c001 需传 permanentId） */
  playChaos(playerId: string, cardId: string, permanentId?: string) {
    return playChaosCard(this.state, playerId, cardId, { permanentId });
  }

  /** 当前玩家此刻可打出的混沌卡清单 */
  chaosOptions(playerId: string) {
    return chaosOptions(this.state, playerId);
  }

  /** 回答挂起决策 */
  choose(playerId: string, values: string[]) {
    return answerChoice(this.state, playerId, values);
  }

  /** 狱中服刑 */
  jail(playerId: string) {
    return jailTurn(this.state, playerId);
  }

  /** 列出该玩家当前地点的可选动作 */
  options(playerId: string) {
    return listOptions(this.state, playerId);
  }

  /** 执行一个可选动作 */
  doOption(playerId: string, optionId: string, targetId?: string) {
    return runOption(this.state, playerId, optionId, targetId);
  }

  /** 结束回合，交给下一位 */
  endTurn() {
    if (hasPending(this.state)) return { ok: false, error: '有未完成的决策' };
    const r = nextTurn(this.state);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** 是否轮到该玩家 */
  isTurn(playerId: string): boolean {
    return isTurn(this.state, playerId);
  }

  /**
   * 让 AI 连续行动，直到轮到人类玩家或对局结束。
   *
   * @param maxSteps 防止 AI 互相触发死循环
   */
  runAI(maxSteps = 200): number {
    if (!this.think) return 0;
    let steps = 0;
    while (steps < maxSteps && this.state.phase === 'playing' && this.needsAI()) {
      const actor = this.state.pending
        ? this.state.pending.playerId
        : currentPlayerId(this.state);
      const before = JSON.stringify(this.state.log.length) + this.state.round + actor;
      this.think(this.state, actor);
      steps++;
      // 保险：若这一轮什么都没变，强制结束该 AI 回合，避免卡死
      const after = JSON.stringify(this.state.log.length) + this.state.round + actor;
      if (before === after) {
        if (this.state.pending) {
          // 决策没被消费，取第一个选项兜底
          const p = this.state.pending;
          answerChoice(this.state, p.playerId, p.options.slice(0, 1).map((o) => o.value));
        } else if (isTurn(this.state, actor)) {
          nextTurn(this.state);
        }
      }
    }
    return steps;
  }
}
