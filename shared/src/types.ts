// =============================================================
// 资源系统
// =============================================================

/** 资源类型 */
export type ResourceType = 'gold' | 'votes' | 'malice' | 'cogs';

/** 玩家资源容器 */
export interface Resources {
  gold: number;
  votes: number;
  malice: number;
  cogs: number;
  income: number;
  bribe: number;
}

export interface ResourceDelta {
  gold?: number;
  votes?: number;
  malice?: number;
  cogs?: number;
  income?: number;
  bribe?: number;
}

// =============================================================
// 卡牌系统
// =============================================================

export type CardKind = 'regular' | 'permanent' | 'secret' | 'criminal';

/** 卡牌使用地点（建筑 ID 集合，空数组表示任意地点） */
export type BuildingId =
  | 'office'
  | 'plant'
  | 'junkyard'
  | 'market'
  | 'hell'
  | 'jail'
  | 'casino'
  | 'court'
  | 'treasury'
  | 'bank'
  | 'heaven';

/** 效果目标选择类型 */
export type TargetSelector =
  | 'self'                // 自己
  | 'all_others'          // 所有其他玩家
  | 'choose_one'          // 选一名对手
  | 'choose_building'     // 选一座建筑（用于传送等）
  | 'highest_malice'      // 罪恶值最高的玩家
  | 'leader'              // 分数领先者
  | 'none';

/** 单条效果指令（引擎可执行的最小单元） */
export interface CardEffect {
  /** 资源直接变更 */
  delta?: ResourceDelta;
  /** 目标选择 */
  target?: TargetSelector;
  /** 强制移动到指定建筑（监狱/地狱等） */
  moveTo?: BuildingId | 'current_position_of_target';
  /** 传送到指定站点 ID */
  moveToTile?: number;
  /** 让目标跳过下回合 */
  skipTurn?: boolean;
  /** 抽牌张数 */
  drawCards?: number;
  /** 弃手牌张数（随机或指定） */
  discardHand?: number;
  /** 销毁目标一张永久卡（破坏） */
  destroyPermanent?: boolean;
  /** 偷取目标资源 */
  steal?: { gold?: number; cogs?: number };
  /** 反向移动标志（如 It's a foul!） */
  reverseMovement?: boolean;
  /** 持续生效标记（永久卡，记录在玩家面前） */
  ongoing?: {
    /** 其他玩家贿赂金额增量 */
    bribeIncrement?: number;
    /** 其他玩家进入某建筑时触发 */
    onOpponentEnterBuilding?: { building: BuildingId; give: ResourceDelta };
  };
  /** 让目标更换所有手牌 */
  replaceHand?: boolean;
  /** 厄运牌堆抽牌 */
  drawMisfortune?: number;
  /** 额外走牌（再使用一张卡/额外回合） */
  extraTurn?: boolean;
  /** 成为镇长 */
  becomeMayor?: boolean;
  /** 描述文本（用于日志展示） */
  text?: string;
}

/** 卡牌定义 */
export interface CardDef {
  id: string;
  name: string;
  move: number;
  cost: number;
  /** 费用资源类型（默认金钱） */
  costType?: 'gold' | 'votes' | 'malice' | 'bribe';
  buildings: BuildingId[];
  kind: CardKind;
  effects: CardEffect[];
  malice?: number;
  description: string;
  theme?: 'gold' | 'crime' | 'heaven' | 'court' | 'casino' | 'office' | 'plant' | 'magic' | 'neutral';
  diceRoll?: { success: number; reward?: CardEffect; failure?: CardEffect };
  /** 是否永久卡牌 */
  permanent?: boolean;
  /** 成本显示文本（OCR原始格式，去反引号） */
  costDisplay?: string;
  /** 收获显示文本 */
  harvestDisplay?: string;
  /** 特殊规则文本 */
  specialRules?: string;
}

// =============================================================
// 棋盘系统
// =============================================================

export type StationType =
  | 'income'
  | 'bribe'
  | 'police'
  | 'misfortune'
  | 'gambling'
  | 'speech'
  | 'danger'
  | 'start'        // 起点
  | 'junction'     // 分支口（普通格）
  | 'building'     // 建筑入口
  | 'fast_track';  // 中央快速通道

/** 棋盘上的一格 */
export interface Tile {
  id: number;
  /** 站点类型 */
  type: StationType;
  /** 关联的建筑（仅 type=building/junction 时） */
  building?: BuildingId;
  /** 下一格 ID（沿主环逆时针前进方向）。junction 表示拐入分支 */
  next: number[];
  /** 上一格 ID（用于反向移动） */
  prev: number[];
  /** SVG 坐标（百分比 0-100） */
  x: number;
  y: number;
  /** 显示标签 */
  label?: string;
  /** 是否为快速通道入口 */
  fastTrackEntry?: boolean;
}

/** 棋盘整体定义 */
export interface BoardDef {
  tiles: Tile[];
  /** 起点格子 ID */
  startTileId: number;
  /** 监狱格子 ID（玩家被捕后送到此） */
  jailTileId: number;
  /** 中央快速通道格子 ID 列表 */
  fastTrackIds: number[];
  /** 主环格子 ID 顺序（逆时针） */
  ringOrder: number[];
  /** 建筑入口格子映射 */
  buildingTiles: Record<BuildingId, number>;
}

// =============================================================
// 角色系统
// =============================================================

export interface CharacterDef {
  /** Initiative 顺序序号 1-12 */
  order: number;
  id: string;
  name: string;
  /** 中文名 */
  cn: string;
  /** 角色技能描述（旧格式，纯文本） */
  ability: string;
  /** 技能列表（OCR 格式，结构化） */
  abilities?: Array<{
    name: string;
    description: string;
  }>;
  /** 起始建筑 */
  starting_building?: string;
  /** 头像路径 */
  avatar_path?: string;
  /** 被动效果（引擎执行钩子） */
  passive?: {
    /** 起始收入 */
    startIncome?: number;
    /** 起始金币 */
    startGold?: number;
    /** 起始选票 */
    startVotes?: number;
    /** 经过收入站点加成 */
    incomeBonus?: number;
    /** 经过贿赂站点减免 */
    bribeReduction?: number;
    /** 警察站点掷骰成功概率提升（小数 0-1） */
    policeSuccessBonus?: number;
    /** 移动点数加成（每张牌） */
    moveBonus?: number;
  };
  /** 主动技能（可选，每场游戏可用 N 次） */
  active?: {
    name: string;
    description: string;
    usesPerGame: number;
    effect: CardEffect;
  };
}

// =============================================================
// 厄运事件
// =============================================================

export interface MisfortuneDef {
  id: string;
  /** 事件名 */
  name: string;
  /** 描述 */
  description: string;
  /** 效果 */
  effect: CardEffect;
  /** 严重程度 1-5（用于 UI 区分） */
  severity: 1 | 2 | 3 | 4 | 5;
}

// =============================================================
// 玩家与游戏状态
// =============================================================

export interface PlayerColor { primary: string; secondary: string; }

export const PLAYER_COLORS: PlayerColor[] = [
  { primary: '#e74c3c', secondary: '#c0392b' },
  { primary: '#3498db', secondary: '#2980b9' },
  { primary: '#2ecc71', secondary: '#27ae60' },
  { primary: '#9b59b6', secondary: '#8e44ad' },
  { primary: '#f1c40f', secondary: '#d4ac0d' },
  { primary: '#e67e22', secondary: '#d35400' },
];

export interface PlayerState {
  id: string;            // socket id
  name: string;
  characterId?: string;
  ready: boolean;
  connected: boolean;
  isAI: boolean;
  resources: Resources;
  /** 当前位置（tile id） */
  position: number;
  /** 手牌（card id） */
  hand: string[];
  /** 永久卡（card id） */
  permanents: string[];
  /** 秘密卡（不公开内容，只公开数量） */
  secrets: string[];
  /** 跳过下回合标记 */
  skipNextTurn: boolean;
  /** 在监狱中 */
  inJail: boolean;
  /** 监狱经验计数 */
  jailExperience: number;
  /** 当回合已移动 */
  movedThisTurn: boolean;
  /** 本回合最后使用的移动卡步数（商人「动起来」用） */
  lastMoveSteps: number;
  /** 额外走牌次数（"再使用一张卡"/"+1次额外的走牌"） */
  extraTurns: number;
  /** 颜色索引 */
  colorIndex: number;
  /** 主动技能已用次数 */
  activeAbilityUsed: number;
  /** 是否为本回合行动者 */
  isCurrentTurn: boolean;
}

export type GamePhase =
  | 'lobby'           // 大厅等待
  | 'character_select' // 角色选择
  | 'playing'         // 进行中
  | 'election'        // 选举阶段
  | 'game_over';

export type TurnPhase =
  | 'wait_start'
  | 'select_move_card'
  | 'moving'
  | 'arrive_tile'
  | 'building_action'
  | 'choose_building_action'
  | 'collision_bid'    // 玩家交锋：双方出价
  | 'danger_target'
  | 'choose_misfortune'
  | 'play_card_target'
  | 'settle_effects'
  | 'draw_hand'
  | 'turn_end';

export interface GameLogEntry {
  turn: number;
  playerId: string;
  text: string;
  ts: number;
}

export interface GameState {
  roomId: string;
  phase: GamePhase;
  /** 当前回合数（从1开始） */
  turn: number;
  /** 当前行动玩家 ID */
  currentTurnPlayerId: string;
  /** 当前回合阶段 */
  turnPhase: TurnPhase;
  players: PlayerState[];
  /** 牌堆（剩余 card id） */
  deck: string[];
  /** 弃牌堆 */
  discard: string[];
  /** 厄运牌堆 */
  misfortuneDeck: string[];
  /** 监狱牌堆（服刑时每回合抽一张） */
  jailDeck: string[];
  /** 当前镇长 */
  mayorId?: string;
  /** 下次选举回合 */
  nextElectionTurn: number;
  /** 胜利齿轮数 */
  targetCogs: number;
  /** 胜者 */
  winnerId?: string;
  /** 玩家交锋出价状态 */
  collisionBid?: {
    moverId: string;
    otherId: string;
    moverBid?: number;
    otherBid?: number;
  };
  /** 日志（仅保留最近 200 条） */
  log: GameLogEntry[];
  /** 暴乱卡牌开关 */
  riotCardsEnabled: boolean;
  /** 当前可选项（如最近一次掷骰结果） */
  lastDiceRoll?: number;
}

// =============================================================
// 房间配置
// =============================================================

export interface RoomConfig {
  targetCogs: number;
  enableRiotCards: boolean;
  maxPlayers: number;
  turnTimerSec?: number;
  winCondition: 'cogs' | 'turns' | 'time';
  maxTurns?: number;
  maxTimeSec?: number;
  /** 角色选择模式：random=随机分配，pick3=三选一 */
  charSelectMode: 'random' | 'pick3';
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  targetCogs: 30,
  enableRiotCards: true,
  maxPlayers: 6,
  turnTimerSec: 90,
  winCondition: 'cogs',
  charSelectMode: 'pick3',
};
