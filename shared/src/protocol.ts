import type {
  GameState, PlayerState, CardDef, MisfortuneDef, RoomConfig,
} from './types.js';

// =============================================================
// 客户端 -> 服务端（C2S）
// =============================================================

export interface C2SEvents {
  /** 创建房间 */
  'room:create': (payload: { name: string; config?: Partial<RoomConfig> }, ack: (res: { ok: boolean; roomId?: string; error?: string }) => void) => void;
  /** 加入房间 */
  'room:join': (payload: { roomId: string; name: string }, ack: (res: { ok: boolean; error?: string }) => void) => void;
  /** 离开房间 */
  'room:leave': () => void;
  /** 准备 */
  'room:ready': (payload: { ready: boolean }) => void;
  /** 选择角色 */
  'room:select_character': (payload: { characterId: string }) => void;
  /** 房主开始游戏 */
  'room:start': () => void;
  /** 添加 AI */
  'room:add_ai': () => void;
  /** 房主更新配置 */
  'room:update_config': (payload: Partial<RoomConfig>) => void;

  // 游戏内
  /**
   * 选择移动卡牌。
   * `destinationTileId` 为棋盘格 id（原版 UIN 字符串）。
   * 若目的地路径上存在岔路口，服务端会逐段回 `game:prompt`（`move_branch`）。
   */
  'game:select_move_card': (payload: {
    cardId: string;
    destinationTileId?: string;
    /**
     * @deprecated 掷骰移动牌的步数**不再由客户端决定**。
     *
     * 原版流程是「选牌 → **服务端**掷骰 → 返回步数 → 玩家选目的地」，
     * 而早先由客户端 `Math.random()` 掷好再随预览发给服务端，于是玩家可以
     * **反复取消重开直到掷出满意的点数**（用户报的 bug #6）。
     * 现在改走 `game:roll_move_dice`，服务端用权威 RNG 掷骰并回传结果。
     */
    customSteps?: number;
  }) => void;
  /**
   * 掷骰决定特殊移动牌的步数（a022 装腔作势）。
   *
   * 由**服务端**用权威 RNG 掷，结果写进 `customMoveSteps` 并通过 ack 回传，
   * 客户端拿这个值去做移动预览。重复调用会重新掷骰，所以客户端只在
   * 「玩家点了这张牌」时调一次，不能作为"预览"反复调用。
   */
  'game:roll_move_dice': (payload: { cardId: string }, ack?: (res: { ok: boolean; steps?: number; error?: string }) => void) => void;
  /** 到达建筑后选择打牌 */
  'game:play_card': (payload: { cardId: string; targetPlayerId?: string; targetBuilding?: string }) => void;
  /**
   * 通用选择应答：回答服务端最近一次 `game:prompt`。
   * engine 的选择流（选对手/选地点/选方向）统一走这里，不必为每种情况加协议。
   */
  'game:choose': (payload: { kind: string; values: string[] }) => void;
  /**
   * 执行一个**可选动作**（站点/建筑主动做的事，如投资、卖选票、打工）。
   * `optionId` 来自 `PlayerPrompt.optionalActions`。
   */
  'game:do_option': (payload: { optionId: string; targetId?: string }) => void;
  /**
   * 打出一张**混沌卡**（暴乱卡）。
   *
   * 混沌卡是**全员共享池**（"available to every player in this session"），
   * 不在手牌里，只能用于行动、不能移动；每张只能打一次。
   * 卡池见 `SerializedGameState.chaosPool`。
   */
  'game:play_chaos': (payload: { cardId: string; permanentId?: string }) => void;
  /** 结束自己的回合（由玩家显式推进回合） */
  'game:end_turn': () => void;
  /** 狱中服刑：抽一张监狱卡结算 */
  'game:jail_turn': () => void;
  /** 跳过建筑处打牌 */
  'game:skip_play': () => void;
  /** 心跳/重连请求 */
  'game:sync': () => void;
  /** 聊天 */
  'chat:send': (payload: { text: string }) => void;
}

// =============================================================
// 服务端 -> 客户端（S2C）
// =============================================================

export interface S2CEvents {
  /** 房间状态变更 */
  'room:state': (state: LobbyState) => void;
  /** 进入角色选择阶段 */
  'room:character_select': (state: LobbyState) => void;
  /** 游戏开始 */
  'game:start': () => void;
  /** 完整状态同步（重连/初次同步用） */
  'game:state': (state: SerializedGameState) => void;
  /** 增量状态更新（每次动作后） */
  'game:patch': (patch: GamePatch) => void;
  /** 提示：需要玩家做选择（仅发给当前行动者） */
  'game:prompt': (prompt: PlayerPrompt) => void;
  /** 日志 */
  'game:log': (entry: { turn: number; playerId: string; text: string; ts: number }) => void;
  /** 游戏结束 */
  'game:over': (winnerId: string) => void;
  /** 错误 */
  'error': (msg: { code: string; message: string }) => void;
  /** 聊天 */
  'chat:recv': (msg: { playerId: string; name: string; text: string; ts: number }) => void;
  /** AI 行动延迟提示 */
  'game:ai_thinking': (playerId: string) => void;
}

// =============================================================
// 序列化状态（发给客户端）
// =============================================================

/**
 * 序列化后的游戏状态：与 GameState 区别在于
 * - 不暴露手牌（只暴露自己）
 * - 不暴露牌堆顺序
 *
 * 注意 `turnPhase` 是**字符串而非常量联合**：engine2 的待决策状态由
 * `PlayerPrompt` 描述（选择对手/地点/方向/卡牌…），无法穷举成固定枚举。
 */
export interface SerializedGameState {
  roomId: string;
  phase: GameState['phase'];
  /** 回合数（= 原版 round） */
  turn: number;
  currentTurnPlayerId: string;
  turnPhase: string;
  players: SerializedPlayer[];
  mayorId?: string;
  nextElectionTurn: number;
  targetCogs: number;
  winnerId?: string;
  log: GameState['log'];
  /** 牌堆剩余张数 */
  deckCount: number;
  /** 弃牌堆（公开） */
  discard: string[];
  /** 厄运牌堆剩余张数 */
  misfortuneDeckCount: number;
  lastDiceRoll?: number;
  riotCardsEnabled: boolean;
  /**
   * 混沌卡（暴乱卡）**共享池**——还没被打出的卡。
   * 原版规则：全员都能看到并选择打哪张，打一张少一张；
   * 全部打完 → 该轮结束时赛局结束。
   */
  chaosPool: Array<{
    id: string;
    name: string;
    description: string;
    /** 代价描述（如 "1000 金钱" / "10 选票" / "免费"） */
    cost: string;
    /** 收益描述（如 "+12 齿轮，+5 罪恶"） */
    gain: string;
    /** 当前视角玩家能否打出，以及不能的原因 */
    playable: boolean;
    reason?: string;
  }>;
  /** 已打出的混沌卡 id */
  chaosPlayed: string[];
  /** 当前地图 id（客户端据此选棋盘布局） */
  mapId: string;
}

export interface SerializedPlayer {
  id: string;
  name: string;
  characterId?: string;
  connected: boolean;
  isAI: boolean;
  resources: PlayerState['resources'];
  /** 所在棋盘格 id（原版 UIN 字符串） */
  position: string;
  /** 仅自己可见的手牌；其他玩家为张数 */
  hand?: string[];
  handCount: number;
  permanents: string[];
  secretCount: number;
  skipNextTurn: boolean;
  inJail: boolean;
  jailExperience: number;
  colorIndex: number;
  activeAbilityUsed: number;
  isCurrentTurn: boolean;
  /**
   * 玩家交锋统计（对应原版 `GPlayer` 的
   * `ConflictTotal / ConflictInit / ConflictWon / ConflictPaid`）。
   */
  conflicts: {
    /** 参与过的交锋总数 */
    total: number;
    /** 由自己落地引发的交锋数 */
    init: number;
    /** 赢下的交锋数 */
    won: number;
    /** 在交锋中付出的金钱总额 */
    paid: number;
  };
}

/**
 * 玩家提示。
 *
 * `type` 为字符串而非常量联合：引擎的选择种类由数据驱动
 * （见 `PendingChoice.kind`），新增动作原语不需要改协议。
 */
export interface PlayerPrompt {
  type: string;
  /** 可选卡牌 id */
  options?: string[];
  /** 通用选项：value 回传给 `game:choose` */
  choices?: Array<{ value: string; label: string }>;
  /** 可选目标玩家 */
  targetOptions?: string[];
  /** 可选厄运牌 id 列表（两害取其轻） */
  misfortuneOptions?: string[];
  /**
   * 可选动作（站点/建筑主动做的事：投资、卖选票、打工、赌博…）。
   * 玩家选一个回传 `game:do_option`，或直接结束回合。
   */
  optionalActions?: Array<{
    id: string;
    label: string;
    description?: string;
    /** false 时 UI 置灰 */
    affordable?: boolean;
    reason?: string;
    /** 需要先选一名玩家 */
    needsTarget?: boolean;
  }>;
  message: string;
}

/** 状态增量（用于客户端合并更新） */
export interface GamePatch {
  players?: SerializedPlayer[];
  phase?: GameState['phase'];
  turn?: number;
  currentTurnPlayerId?: string;
  /** 同 SerializedGameState.turnPhase：字符串而非常量联合 */
  turnPhase?: string;
  mayorId?: string | null;
  winnerId?: string;
  log?: GameState['log'];
  deckCount?: number;
  discard?: string[];
  misfortuneDeckCount?: number;
  lastDiceRoll?: number;
}

// =============================================================
// 大厅状态
// =============================================================

export interface LobbyState {
  roomId: string;
  hostId: string;
  config: RoomConfig;
  players: LobbyPlayer[];
  phase: 'lobby' | 'character_select';
}

export interface LobbyPlayer {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  isAI: boolean;
  characterId?: string;
  /** 三选一模式下的可选角色列表 */
  charOptions?: string[];
}

// =============================================================
// 静态数据加载接口
// =============================================================

export interface GameData {
  cards: Record<string, CardDef>;
  misfortunes: Record<string, MisfortuneDef>;
  cardDeckOrder: string[];   // 初始牌堆顺序
  misfortuneOrder: string[];
}
