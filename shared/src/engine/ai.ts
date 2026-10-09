// =============================================================
// AI 决策（纯函数，平台无关）
//
// 服务端与客户端单机共用同一套策略。AI 只做**选择**，
// 所有规则判定都在引擎里（`api.ts`）。
//
// 与旧实现的区别：不再手写回合状态机，而是：
//   1) 有挂起决策 → 挑一个选项
//   2) 狱中 → 服刑
//   3) 能打效果牌 → 打一张（优先高分）
//   4) 能移动 → 移动（优先走向建筑）
//   5) 都不行 → 结束回合
// =============================================================
import type { EngineState } from './model.js';
import { CARD_BY_ID, CELL_TYPE_BY_ID, cellTypeOf, getCell, getPlayer } from './model.js';
import {
  answerChoice, currentPlayerId, isTurn, jailTurn, listOptions, movableCards, nextTurn,
  playableCards, playCard, runOption,
} from './api.js';
import { moveWithCard } from './api.js';

/** 取当前格子的第 n 个参数（可选动作的数值） */
function cellTypeParam(state: EngineState, p: { cellId: string }, i: number, fallback: number): number {
  const cell = getCell(state, p.cellId);
  const def = cell ? cellTypeOf(cell) : undefined;
  return def?.params[i] ?? fallback;
}

/** AI 一次决策的日志（供调用方展示"AI 在想什么"） */
export interface AIStep {
  playerId: string;
  action: 'choose' | 'jail' | 'play' | 'move' | 'endTurn' | 'idle';
  detail?: string;
}

/** 简单的 AI 决策器：状态是显式传入的，便于测试 */
export class AIPlayer {
  /** 统计每个 AI 用过的步数，防死循环 */
  private readonly steps = new Map<string, number>();
  /** 单次调用最多推进多少步 */
  constructor(private readonly maxStepsPerCall = 50) {}

  /**
   * 让指定玩家行动，反复推进直到不再需要它决策。
   * @returns 实际执行的步骤（用于上层判断是否卡住）
   */
  act(state: EngineState, playerId: string): AIStep[] {
    const log: AIStep[] = [];
    const start = this.steps.get(playerId) ?? 0;
    let n = 0;

    while (n < this.maxStepsPerCall) {
      if (state.phase !== 'playing') break;

      // 1) 挂起决策
      if (state.pending) {
        if (state.pending.playerId !== playerId) break;
        const values = this.pickChoice(state);
        const r = answerChoice(state, playerId, values);
        log.push({ playerId, action: 'choose', detail: state.pending?.kind ?? values.join(',') });
        n++;
        if (!r.ok) break;
        continue;
      }

      // 2) 不是它的回合
      if (!isTurn(state, playerId)) break;

      const me = getPlayer(state, playerId);
      if (!me) break;

      // 3) 狱中：服刑
      if (me.inJail) {
        const r = jailTurn(state, playerId);
        log.push({ playerId, action: 'jail', detail: r.ok ? undefined : r.error });
        this.endTurn(state, playerId);
        n++;
        break;
      }

      // 4) 可选动作：只在明显有利时做（投资回本、卖资源、打工…）
      if (this.tryOption(state, playerId)) {
        log.push({ playerId, action: 'choose', detail: '可选动作' });
        n++;
        continue;
      }

      // 5) 效果牌：优先高分
      const playable = playableCards(state, playerId).sort((a, b) => cardScore(b) - cardScore(a));
      if (playable.length) {
        const r = playCard(state, playerId, playable[0]);
        log.push({
          playerId, action: 'play',
          detail: `${CARD_BY_ID[playable[0]]?.name ?? playable[0]}${r.ok ? '' : ` 失败:${r.error}`}`,
        });
        n++;
        if (r.ok) continue;
      }

      // 6) 移动：步数最大的优先
      const movable = movableCards(state, playerId).sort(
        (a, b) => (CARD_BY_ID[b]?.move ?? 0) - (CARD_BY_ID[a]?.move ?? 0),
      );
      if (movable.length) {
        const cardId = movable[0];
        const dest = this.pickDestination(state, playerId, cardId);
        const r = moveWithCard(state, playerId, cardId, dest);
        log.push({
          playerId, action: 'move',
          detail: `${CARD_BY_ID[cardId]?.name ?? cardId}${r.ok ? '' : ` 失败:${r.error}`}`,
        });
        n++;
        if (r.ok) continue;
      }

      // 7) 收尾
      this.endTurn(state, playerId);
      log.push({ playerId, action: 'endTurn' });
      n++;
      break;
    }

    this.steps.set(playerId, start + n);
    return log;
  }

  /**
   * 尝试执行一个**有利**的可选动作。
   *
   * 策略：只做确定划算的（投资回本、卖选票/齿轮、打工、翻垃圾、没收选票、
   * 保险优惠、卖收入）。赌博类（`*.gamble`）与演讲下注期望为负，AI 不做。
   *
   * @returns 是否执行了动作
   */
  private tryOption(state: EngineState, playerId: string): boolean {
    const opts = listOptions(state, playerId).filter((o) => o.affordable !== false);
    if (!opts.length) return false;

    // 按"划算程度"排序：优先纯收益，其次用闲置资源换钱
    const rank = (id: string): number => {
      if (id.startsWith('ability.astralFromBank')) return -1; // 传送不产生资源变化，收益不明显
      if (id.startsWith('plant.work')) return 1;
      if (id.startsWith('junkyard.dig')) return 2;
      if (id.startsWith('market.sellScore')) return 3;
      if (id.startsWith('office.sellVote')) return 4;
      if (id.startsWith('court.takeVotes')) return 5;
      if (id.startsWith('ability.sellIncome')) return 6;
      if (id.startsWith('ability.discardOne')) return 8;
      if (id.startsWith('ability.drawAndKeep')) return 7;
      if (id.startsWith('ability.doubleIncome')) return 7;
      if (id.startsWith('danger.insure')) return 9;
      if (id.startsWith('ability.playAgain')) return -1; // 需要后续打牌，交由下一步处理
      // 演讲：下注到 50 时成功率 70%，且赢了退本金 → 正期望
      if (id.startsWith('tribune.speak.')) return 6;
      if (id === 'bank.invest') return 10;
      return 99; // 赌博类排最后，等于不做
    };
    // 只做排名靠前的几类
    const candidates = opts
      .filter((o) => rank(o.id) <= 6)
      .sort((a, b) => rank(a.id) - rank(b.id));
    if (!candidates.length) return false;

    const pick = candidates[0];
    // 投资要回本才做（原版：投资 10 金换 10 收入，收入本身有价值）
    if (pick.id === 'bank.invest') {
      const me = getPlayer(state, playerId);
      if (!me) return false;
      const cost = cellTypeParam(state, me, 0, 10);
      const gain = cellTypeParam(state, me, 1, 10);
      if (gain < cost) return false;
    }

    const r = runOption(state, playerId, pick.id);
    return r.ok;
  }

  /** 结束回合（带保护） */
  private endTurn(state: EngineState, playerId: string): void {
    if (state.pending) return;
    if (!isTurn(state, playerId)) return;
    nextTurn(state);
  }

  /** 从挂起决策里挑答案：取前 min 个 */
  private pickChoice(state: EngineState): string[] {
    const pend = state.pending!;
    const n = Math.max(1, pend.min ?? 1);
    return pend.options.slice(0, n).map((o) => o.value);
  }

  /**
   * 选目的地：枚举步数可达格，优先建筑（能打牌），其次最先遇到的可达格。
   */
  private pickDestination(state: EngineState, playerId: string, cardId: string): string | undefined {
    const card = CARD_BY_ID[cardId];
    const me = getPlayer(state, playerId);
    if (!card || !me || card.move <= 0) return undefined;

    let frontier = [me.cellId];
    const seen = new Set([me.cellId]);
    for (let i = 0; i < card.move; i++) {
      const next: string[] = [];
      for (const cid of frontier) {
        const cell = getCell(state, cid);
        if (!cell) continue;
        for (const nb of cell.out) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          next.push(nb);
        }
      }
      if (!next.length) break;
      frontier = next;
    }
    if (!frontier.length) return undefined;

    const building = frontier.find((cid) => {
      const cell = getCell(state, cid);
      return !!cell && !!CELL_TYPE_BY_ID[cell.cellTypeId]?.building;
    });
    return building ?? frontier[Math.floor(frontier.length / 2)] ?? frontier[0];
  }
}

/** 卡牌价值粗排：齿轮 > 选票 > 金钱，并扣掉代价 */
export function cardScore(id: string): number {
  const c = CARD_BY_ID[id];
  if (!c) return 0;
  const inc = c.income;
  const out = c.outcome;
  const gain = (inc?.score ?? 0) * 10 + (inc?.vote ?? 0) * 3 + (inc?.money ?? 0) / 50;
  const loss = (out?.score ?? 0) * 10 + (out?.money ?? 0) / 50 + (out?.malice ?? 0);
  return gain - loss;
}

/** 默认共享实例（服务端与客户端单机都能直接用） */
export const defaultAI = new AIPlayer();

/**
 * 便捷入口：为状态里的所有 AI 连续行动，直到轮到人类或结束。
 *
 * @returns 执行过的步骤日志
 */
export function runAIPlayers(state: EngineState, maxSteps = 400): AIStep[] {
  const out: AIStep[] = [];
  let steps = 0;
  while (steps < maxSteps && state.phase === 'playing') {
    const actor = state.pending ? state.pending.playerId : currentPlayerId(state);
    const p = getPlayer(state, actor);
    if (!p?.isAI) break;
    const before = state.log.length;
    const beforeRound = state.round;
    out.push(...defaultAI.act(state, actor));
    steps++;
    // 保险：什么都没变就强制推进，避免卡死
    if (state.log.length === before && state.round === beforeRound && isTurn(state, actor)) {
      if (state.pending) {
        const pend = state.pending;
        answerChoice(state, pend.playerId, pend.options.slice(0, 1).map((o) => o.value));
      } else {
        nextTurn(state);
      }
    }
  }
  return out;
}
