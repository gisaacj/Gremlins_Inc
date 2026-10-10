// =============================================================
// engine → 协议序列化
//
// 把引擎内部状态转成客户端消费的 `SerializedGameState`。
// 引擎内部用 `round` / `currentIndex` / 字符串格 id，
// 协议侧用 `turn` / `currentTurnPlayerId` / 字符串 position。
// =============================================================
import type {
  SerializedGameState, SerializedPlayer, PlayerPrompt, GamePatch,
} from '../protocol.js';
import type { EngineState, EnginePlayer } from './model.js';
import { CHAOS_CARDS, cellLabel, getCell, getMap } from './model.js';
import { availableOptions } from './options.js';
import { chaosOptions, playableCards } from './api.js';

/** 引擎回合阶段 → 协议字符串（客户端主要用 prompt，这里只作展示与调试） */
function phaseOf(state: EngineState): string {
  if (state.phase !== 'playing') return state.phase;
  if (state.pending) return 'choose';
  if (state.moveCursor) return 'moving';
  return 'select_move_card';
}

export function serializeEngineState(state: EngineState, viewerId?: string): SerializedGameState {
  const current = state.players[state.currentIndex];
  return {
    roomId: state.roomId,
    phase: state.phase,
    turn: state.round,
    currentTurnPlayerId: current?.id ?? '',
    turnPhase: phaseOf(state),
    players: state.players.map((p) => serializeEnginePlayer(state, p, p.id === viewerId)),
    mayorId: state.mayorId,
    nextElectionTurn: state.nextElectionRound,
    targetCogs: state.targetScore,
    winnerId: state.winnerId,
    // 引擎日志用 round，协议侧用 turn（同一含义）
    log: state.log.map((e) => ({
      turn: e.round,
      playerId: e.playerId,
      text: e.text,
      ts: e.ts,
    })),
    deckCount: state.deck.length,
    discard: state.discard.slice(-60),
    misfortuneDeckCount: state.misfortuneDeck.length,
    lastDiceRoll: state.lastRoll,
    riotCardsEnabled: state.chaosEnabled,
    // 混沌卡共享池：附带"该视角玩家能否打出"的判定，客户端直接渲染。
    // viewerId 缺省时不判定（全部按不可打处理），避免误报可打。
    chaosPool: chaosOptions(state, viewerId ?? '').map((o) => {
      const card = CHAOS_CARDS.find((c) => c.id === o.cardId);
      return {
        id: o.cardId,
        name: o.name,
        description: card?.text.description ?? '',
        cost: o.cost,
        gain: o.gain,
        playable: o.playable,
        reason: o.reason,
      };
    }),
    chaosPlayed: [...state.chaosPlayed],
    mapId: state.mapId,
  };
}

export function serializeEnginePlayer(
  state: EngineState,
  p: EnginePlayer,
  showHand: boolean,
): SerializedPlayer {
  return {
    id: p.id,
    name: p.name,
    characterId: p.characterId,
    connected: p.connected,
    isAI: p.isAI,
    // 协议侧资源形状与引擎不同：gold/votes/cogs → money/vote/score
    resources: {
      gold: p.res.money,
      votes: p.res.vote,
      malice: p.res.malice,
      cogs: p.res.score,
      income: p.res.income,
      bribe: bribeDisplay(state, p),
    },
    position: p.cellId,
    hand: showHand ? p.hand : undefined,
    handCount: p.hand.length,
    permanents: p.permanents,
    secretCount: p.secrets.length,
    skipNextTurn: p.skipTurns > 0,
    inJail: p.inJail,
    jailExperience: p.term,
    colorIndex: p.colorIndex,
    activeAbilityUsed: p.flags['activeUsed'] ?? 0,
    isCurrentTurn: state.players[state.currentIndex]?.id === p.id,
    // 玩家交锋统计（对应原版 GPlayer 的 ConflictTotal / Init / Won / Paid）
    conflicts: {
      total: p.conflictTotal ?? 0,
      init: p.conflictInit ?? 0,
      won: p.conflictWon ?? 0,
      paid: p.conflictPaid ?? 0,
    },
  };
}

/** 贿赂金额（展示用）。与引擎状态无关的计算放这里，避免循环依赖。 */
function bribeDisplay(_state: EngineState, p: EnginePlayer): number {
  return Math.max(0, 20 + p.res.malice);
}

// ---------------------------------------------------------------- 提示
/**
 * 当前该谁做什么。
 *
 * 引擎的选择种类由数据驱动（`PendingChoice.kind`），协议侧只暴露三类：
 *  - `select_move_card`：轮到你；`optionalActions` 里是站点/建筑可选动作
 *  - `choose`：有挂起决策，按 `choices` 回传 `game:choose`
 *  - `wait_others`：等别人
 */
export function buildEnginePrompt(
  state: EngineState,
  viewerId: string,
): PlayerPrompt | null {
  if (state.phase !== 'playing') return null;

  const current = state.players[state.currentIndex];
  if (!current) return null;

  // 有挂起决策：只有发起者能回答
  if (state.pending) {
    const pend = state.pending;
    if (pend.playerId !== viewerId) {
      return { type: 'wait_others', message: `等待 ${nameOf(state, pend.playerId)} 选择` };
    }
    return {
      type: 'choose',
      message: pend.prompt,
      choices: pend.options,
    };
  }

  if (current.id !== viewerId) {
    return { type: 'wait_others', message: `等待 ${current.name} 行动` };
  }

  // 轮到该玩家：按 GTurnPhase 顺序给出提示
  // Begin → Move → UseCard → UseCell → 换人
  const inJail = current.inJail;
  const place = cellLabel(getCell(state, current.cellId));

  // === Move 阶段：未移动，必须移动（或狱中服刑）===
  if (!current.movedThisTurn && !inJail) {
    return {
      type: 'select_move_card',
      message: `请选择一张卡牌用于移动`,
      options: current.hand,
      optionalActions: [],
    };
  }

  // 已移动到达后：分 UseCard → UseCell 两阶段
  if (current.movedThisTurn && !inJail) {
    const optional = availableOptions(state, viewerId);
    const canPlayAgain = current.flags['canPlayAgain'] === 1;

    // === UseCard 阶段：可打一张牌或跳过（无建筑选项）===
    // 移动用掉 1 张牌（cardsPlayedThisTurn=1），允许再打 1 张效果牌（<=1）。
    // 之前用 === 0 导致移动后永远进不了 UseCard 阶段，无法在站点打出效果牌。
    if (current.cardsPlayedThisTurn <= 1 || canPlayAgain) {
      const playable = playableCards(state, viewerId);
      return {
        type: 'play_card_or_skip',
        message: `到达「${place}」：可打出一张卡牌，或跳过`,
        options: playable,
        optionalActions: [],
      };
    }

    // === UseCell 阶段：可用建筑动作或跳过（无卡牌）===
    return {
      type: 'play_card_or_skip',
      message: optional.length
        ? `「${place}」可用动作，或跳过结束回合`
        : `无可用动作，跳过结束回合`,
      options: [],
      optionalActions: optional.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
        affordable: o.affordable,
        reason: o.reason,
        needsTarget: o.needsTarget,
      })),
    };
  }

  // 狱中
  return {
    type: 'select_move_card',
    message: '你在狱中，请服刑（抽监狱卡）',
    options: [],
    optionalActions: [],
  };
}

function nameOf(state: EngineState, id: string): string {
  return state.players.find((p) => p.id === id)?.name ?? id;
}

// ---------------------------------------------------------------- 增量
/** 只生成发生变化的字段，减小每次动作的推送体积 */
export function buildEnginePatch(state: EngineState, viewerId?: string): GamePatch {
  const full = serializeEngineState(state, viewerId);
  return {
    players: full.players,
    phase: full.phase,
    turn: full.turn,
    currentTurnPlayerId: full.currentTurnPlayerId,
    turnPhase: full.turnPhase,
    mayorId: full.mayorId ?? null,
    winnerId: full.winnerId,
    log: full.log,
    deckCount: full.deckCount,
    discard: full.discard,
    misfortuneDeckCount: full.misfortuneDeckCount,
    lastDiceRoll: full.lastDiceRoll,
  };
}

// ---------------------------------------------------------------- 展示辅助
/** 玩家所在位置的中文名（日志/调试） */
export function playerPlaceLabel(state: EngineState, p: EnginePlayer): string {
  return cellLabel(getCell(state, p.cellId));
}

/** 地图格数（健康检查用） */
export function boardSize(state: EngineState): number {
  return getMap(state).cells.length;
}
