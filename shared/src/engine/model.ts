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
  ACTION_CARDS, CARD_BY_ID, CHARACTERS, CHARACTER_BY_ID,
  JAIL_CARDS, MISFORTUNE_CARDS, CHAOS_CARDS, CELL_TYPES,
  CELL_TYPE_BY_ID, CELL_TYPE_BY_NAME, BOARD_MAPS, NORMAL_MAP, GAME_CONST,
} from '../gamedata/index.js';

export {
  ACTION_CARDS, CARD_BY_ID, CHARACTERS, CHARACTER_BY_ID,
  JAIL_CARDS, MISFORTUNE_CARDS, CHAOS_CARDS, CELL_TYPES,
  CELL_TYPE_BY_ID, CELL_TYPE_BY_NAME, BOARD_MAPS, NORMAL_MAP, GAME_CONST,
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
  /** 监狱进度：还需服刑的走牌次数 */
  term: number;
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
  };
  /** 最近一次掷骰结果 */
  lastRoll?: number;

  mapId: string;
  /** 本局启用的混沌/暴乱卡 */
  chaosEnabled: boolean;

  log: Array<{ round: number; playerId: string; text: string; ts: number }>;
  /** 可种子化随机状态 */
  rngState: number;
}

// ---------------------------------------------------------------- 棋盘索引
export function getMap(state: Pick<EngineState, 'mapId'>): BoardMap {
  return BOARD_MAPS.find((m) => m.id === state.mapId) ?? NORMAL_MAP;
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
