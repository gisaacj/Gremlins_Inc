// =============================================================
// 引擎模型层 —— 建立在原版权威数据之上
//
// 与旧引擎的关键区别：
//  1. 用 gamedata 的稳定 id（UIN / 内部名）判定，不用中文名字符串匹配
//  2. 位置用棋盘格 id（十进制 UIN），不用旧棋盘的自增数字下标
//  3. 卡牌能力直接来自 Card.actions，不再手写 if/else
// =============================================================
import type {
  ActionCard, BoardCell, BoardMap, GameCharacter, JailCard,
  MisfortuneCard, ChaosCard, CellTypeDef, ResourceBundle, CardAction,
} from '../gamedata/index.js';
import {
  ACTION_CARDS, CARD_BY_ID, CARD_BY_NAME, CHARACTERS, CHARACTER_BY_ID,
  JAIL_CARDS, MISFORTUNE_CARDS, CHAOS_CARDS, CELL_TYPES,
  CELL_TYPE_BY_ID, CELL_TYPE_BY_NAME, BOARD_MAPS, NORMAL_MAP, CUSTOM_MAP, GAME_CONST,
} from '../gamedata/index.js';

export {
  ACTION_CARDS, CARD_BY_ID, CARD_BY_NAME, CHARACTERS, CHARACTER_BY_ID,
  JAIL_CARDS, MISFORTUNE_CARDS, CHAOS_CARDS, CELL_TYPES,
  CELL_TYPE_BY_ID, CELL_TYPE_BY_NAME, BOARD_MAPS, NORMAL_MAP, CUSTOM_MAP, GAME_CONST,
};
export type {
  ActionCard, BoardCell, BoardMap, GameCharacter, JailCard,
  MisfortuneCard, ChaosCard, CellTypeDef, ResourceBundle, CardAction,
  ActionType, PriceType, CellTypeName, TextToken, LangCode,
} from '../gamedata/index.js';

// ---------------------------------------------------------------- 资源
/** 引擎内部的资源容器。income 是"收入值"，bribe 是"贿赂基数"。 */
export interface Resources {
  money: number;
  vote: number;
  malice: number;
  score: number;
  income: number;
  term: number;
}

export const RESOURCE_KEYS = ['money', 'vote', 'malice', 'score', 'income', 'term'] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

export const RESOURCE_LABEL_ZH: Record<ResourceKey, string> = {
  money: '金钱',
  vote: '选票',
  malice: '罪恶',
  score: '齿轮',
  income: '收入',
  term: '刑期',
};

export function emptyResources(): Resources {
  return { money: 0, vote: 0, malice: 0, score: 0, income: 0, term: 0 };
}

export function resourcesFrom(b: ResourceBundle | undefined | null): Resources {
  const r = emptyResources();
  if (!b) return r;
  r.money = b.money ?? 0;
  r.vote = b.vote ?? 0;
  r.malice = b.malice ?? 0;
  r.score = b.score ?? 0;
  r.income = b.income ?? 0;
  r.term = b.term ?? 0;
  return r;
}

// ---------------------------------------------------------------- 玩家
/** 玩家对局状态 */
export interface EnginePlayer {
  id: string;
  name: string;
  isAI: boolean;
  connected: boolean;
  characterId?: string;

  res: Resources;
  /** 当前所在棋盘格 id（BoardCell.id） */
  cellId: string;
  /** 手牌 card id */
  hand: string[];
  /** 已激活的永久卡 card id */
  permanents: string[];
  /** 秘密卡（内容对其他玩家隐藏） */
  secrets: string[];

  inJail: boolean;
  /**
   * 剩余刑期（走牌次数）。对应原版 `GPlayer.JailTerm`。
   *
   * ⚠️ 注意与原版 `GPlayer.Resources.Term`（**监狱经验**）区分：
   * 这里是"还要坐几回合"，不是等级进度。原版两个字段并存，
   * 本项目把"经验"放在 `jailExp`。
   */
  term: number;
  /**
   * 监狱等级 0..4（新手 / 农民 / 恶棍 / 二把手 / 老大）。
   * 对应原版 `GPlayer.JailRank`。
   */
  jailRank: number;
  /**
   * 当前等级内累积的**监狱经验**。对应原版 `GPlayer.Resources.Term`。
   * 每在狱中待一回合 +1；达到该等级门槛就升级并清零。
   */
  jailExp: number;
  /**
   * 本回合的**监狱表现**：-1 消极 / 0 中性 / +1 积极。
   * 对应原版 `GPlayer.JailKarma`，决定本回合能抽到哪一档监狱牌
   * （`GJailCard.Karma`）。默认 0（中性）。
   */
  jailKarma?: number;
  /** 跳过接下来的 N 次走牌 */
  skipTurns: number;
  /** 本回合剩余的额外走牌次数 */
  extraTurns: number;

  /** 本回合已用于移动的卡牌步数（角色被动判定用） */
  lastMoveCardId?: string;
  lastMoveSteps: number;
  movedThisTurn: boolean;
  /** 本回合已打出的卡牌数量（用于"同一次走牌中使用 N 张"判定） */
  cardsPlayedThisTurn: number;

  colorIndex: number;
  /** 本回合是否已触发过某项每回合一次的被动 */
  flags: Record<string, number>;

  // ---- 玩家交锋统计 ----
  // 字段名对应原版 `GPlayer` 的 ConflictTotal / ConflictInit / ConflictWon / ConflictPaid
  /** 参与过的交锋总次数 */
  conflictTotal: number;
  /** 由自己落地引发的交锋次数 */
  conflictInit: number;
  /** 赢下的交锋次数 */
  conflictWon: number;
  /** 在交锋中付出的金钱总额 */
  conflictPaid: number;
}

// ---------------------------------------------------------------- 待决策
/** 动作序列的执行位置 */
export interface ResumeState {
  /** 正在执行的 action 列表（来自某张卡 / 某类格子 / 某角色能力） */
  actions: CardAction[];
  /** 下一条待执行动作的下标 */
  index: number;
  /** 已选定的目标玩家（供后续动作使用） */
  targets: string[];
  /** 触发来源描述（用于日志） */
  source: string;
  /**
   * 动作序列所属卡牌的 id（若来自某张牌）。
   * 供需要读**卡牌自身 params** 的原语使用（如 `Auction` 判别形态）。
   */
  sourceCardId?: string;
  /** 持有该效果的主玩家 */
  ownerId: string;
  /** 中途产生的附加数据（选定的地点、卡牌等），必须随挂起一起保存 */
  scratch?: Record<string, string>;
}

/**
 * 引擎在动作序列中途需要玩家做选择时挂起的请求。
 * `resume` 记录了继续执行的位置，完整保存以免丢状态。
 */
export interface PendingChoice {
  /** 请求类型，与触发它的动作原语同名 */
  kind: string;
  /** 发起者 */
  playerId: string;
  /** 给客户端的提示文案（已本地化） */
  prompt: string;
  /** 可选目标（玩家 id / 格子 id / 卡牌 id，按 kind 解释） */
  options: Array<{ value: string; label: string }>;
  /** 允许选择的数量（默认 1） */
  min?: number;
  max?: number;
  /** 继续执行的续体 */
  resume: ResumeState;
}

// ---------------------------------------------------------------- 对局状态
export type EnginePhase = 'lobby' | 'character_select' | 'playing' | 'game_over';

export interface EngineState {
  roomId: string;
  phase: EnginePhase;
  /** 回合数（每完成一轮所有玩家算 1 回合） */
  round: number;
  /** 当前行动玩家下标 */
  currentIndex: number;
  players: EnginePlayer[];

  deck: string[];
  discard: string[];
  misfortuneDeck: string[];
  jailDeck: string[];
  /**
   * 混沌卡（暴乱卡）**共享池**——还没被打出的卡 id。
   *
   * 原版规则：
   *  - "Chaos Cards are available to every player in this session."
   *  - "Each of the Chaos Cards can only be played once."
   *  - "Chaos Cards cannot be used to move around, they can only be played for action."
   *  - 全部打完 → 该轮结束时赛局结束
   *
   * 所以不是各自持有，而是**公开的共享池**（打出一张即从池中移除）。
   * 关闭 `enableRiotCards` 时为空数组。
   */
  chaosPool: string[];
  /** 已打出的混沌卡 id（用于"全部打完则结束"判定与展示） */
  chaosPlayed: string[];
  /**
   * 混沌卡已打完、等待"该轮结束"时收尾。
   * 原版：「赛局会在最后一张混沌卡被打出的那一轮结束时结束」。
   */
  chaosEndPending?: boolean;

  mayorId?: string;
  nextElectionRound: number;
  targetScore: number;
  winnerId?: string;

  /** 当前挂起的决策 */
  pending?: PendingChoice;
  /** 进行中的移动（岔路口需分多次调用才能走完） */
  moveCursor?: {
    playerId: string;
    /** 剩余步数 */
    stepsLeft: number;
    /** 已走过的路径 */
    path: string[];
    /** 用于移动的卡 id */
    cardId: string;
    /** 目的地格 id（用于在中途建筑提前停止） */
    destTileId?: string;
    /**
     * 预先算好的整条路径（含终点）。
     *
     * 玩家在预览里选定目的地后，`startMove` 用 `findPathTo` 算出路径存这里，
     * 引擎就按它一路走完、不再中途问岔路口 —— 保证**预览与实际落点一致**。
     * 走完即清空；只有"无法恰好走到"时才回退到逐岔路口询问。
     */
    plannedPath?: string[];
  };
  /** 最近一次掷骰结果 */
  lastRoll?: number;
  /**
   * 最近一次「被查看的手牌」—— 供界面展示。
   *
   * a043「搜身」/a046「清剿行动」/a048「视察」/a049「调查」/a151「告密者」
   * 这类牌的效果是"查看对方手牌"，但引擎原先**只写了一条日志**，
   * 玩家在界面上根本看不到对方的牌（用户报的 bug #4）。
   *
   * 用"最近一次"而不是累积列表：查看是一次性动作，展示完就可以被下一次覆盖。
   */
  revealedHand?: {
    /** 被查看的玩家 */
    ownerId: string;
    /** 被查看的玩家名（便于界面直接显示） */
    ownerName: string;
    /** 查看了谁的玩家 */
    viewerId: string;
    /** 手牌 id 列表 */
    cardIds: string[];
  };
  /**
   * "欠着"的格子效果。
   *
   * 落地顺序是**先交锋、后格子效果**（依据 `TAG.Game_Label_Conflict_Description`：
   * "The player who bids the most pays up and **remains on the spot**, the other
   * player is **arrested**" —— 输家被带走，只有赢家留下，所以格子效果留给留下来的人）。
   *
   * 但交锋会挂起等双方出价，而挂起被应答后引擎不会回到 `resolveLanding`，
   * 所以发起交锋时把 `{playerId, cellId}` 记在这里，
   * 等交锋结算完（或被逃避）再用 `resumePendingCellEffect` 补做。
   */
  pendingCellEffect?: { playerId: string; cellId: string };
  /**
   * 多阶段挂起的暂存（拍卖出价、交锋出价等需要"收齐各方输入"的场景）。
   *
   * 每次 `PendingChoice` 挂起时 `resume.scratch` 会快照 `ActionContext.scratch`，
   * 但那些输入不属于动作序列本身，放在这里更直接。
   * 键形如 `conflict:<a>:<b>:<playerId>`。
   */
  pendingInput?: Record<string, string>;

  mapId: string;
  /** 本局启用的混沌/暴乱卡 */
  chaosEnabled: boolean;

  log: Array<{ round: number; playerId: string; text: string; ts: number }>;
  /** 可种子化随机状态 */
  rngState: number;
}

// ---------------------------------------------------------------- 棋盘索引
export function getMap(state: Pick<EngineState, 'mapId'>): BoardMap {
  return CUSTOM_MAP;
}

export function cellIndex(map: BoardMap): Map<string, BoardCell> {
  return new Map(map.cells.map((c) => [c.id, c]));
}

export function getCell(state: Pick<EngineState, 'mapId'>, cellId: string): BoardCell | undefined {
  return getMap(state).cells.find((c) => c.id === cellId);
}

/** 取格子对应的格子类型定义 */
export function cellTypeOf(cell: BoardCell): CellTypeDef | undefined {
  return CELL_TYPE_BY_ID[cell.cellTypeId] ?? CELL_TYPE_BY_NAME[cell.cellType];
}

/** 建筑名（中文） */
export function cellLabel(cell: BoardCell | undefined): string {
  if (!cell) return '未知地点';
  return cell.text?.caption || cell.caption || cell.name;
}

export function getPlayer(state: EngineState, id: string): EnginePlayer | undefined {
  return state.players.find((p) => p.id === id);
}

export function currentPlayer(state: EngineState): EnginePlayer | undefined {
  return state.players[state.currentIndex];
}

/** 当前行动玩家，不存在时抛错（对局中必定存在） */
export function mustCurrentPlayer(state: EngineState): EnginePlayer {
  const p = state.players[state.currentIndex];
  if (!p) throw new Error('engine: 当前没有行动玩家');
  return p;
}

export function opponentsOf(state: EngineState, id: string): EnginePlayer[] {
  return state.players.filter((p) => p.id !== id);
}

export function characterOf(p: EnginePlayer): GameCharacter | undefined {
  return p.characterId ? CHARACTER_BY_ID[p.characterId] : undefined;
}

/** 角色内部名（如 'Banker'），用于稳定判定，不用中文 */
export function characterName(p: EnginePlayer): string {
  return characterOf(p)?.name ?? '';
}
