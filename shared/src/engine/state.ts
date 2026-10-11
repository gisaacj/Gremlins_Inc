// =============================================================
// 对局初始化与回合流程
//
// 位置：使用原版棋盘格 id；起始格来自 GCharacter.NormalCellStartID，
//       不再依赖手写的 BuildingId 表和硬编码下标。
// 顺序：使用 GCharacter.StepOrderNum（原版 Initiative）。
// =============================================================
import { RESOURCE_LABEL_ZH, type
  ActionCard, BoardCell, CardAction, EnginePlayer, EngineState, PendingChoice, ResourceKey,
} from './model.js';
import {
  ACTION_CARDS, CARD_BY_ID, CARD_BY_NAME, CELL_TYPES, CELL_TYPE_BY_ID, CHARACTERS,
  CHARACTER_BY_ID, CHAOS_CARDS, CELL_TYPE_BY_NAME, GAME_CONST, JAIL_CARDS,
  MISFORTUNE_CARDS, CUSTOM_MAP, NORMAL_MAP, cellLabel, cellTypeOf, characterName,
  getCell, getMap, getPlayer,
} from './model.js';
import {
  ELECTION_INTERVAL, arrest, buildMisfortuneDeck, discardFromHand, drawMisfortune, drawTo,
  random, release, rollDice, runActions, runElection, type ActionContext,
} from './interp.js';
// `bribeAmount` 已移到 `interp.ts`（避免 interp↔state 的循环依赖），
// 这里 import 进来给本文件用，并**继续对外导出**，调用方无感。
import { bribeAmount } from './interp.js';
export { bribeAmount };
import { addRes, transferRes } from './resources.js';
import { displayCardName, displayCardRules } from '../display-text.js';
import {
  applyImmediatePermanents, discardPermanent, extraBribeFrom, fireTrigger,
} from './permanents.js';
import { bribeModifier, breathingTaxFrom, fireAbility, hasCellChoice, insuranceCost } from './abilities.js';
import { availableOptions, diceTableOf } from './options.js';
import { centralMisfortuneId, findPathTo, graphOfMap, isReverseMoveCard } from '../board-view.js';

export interface EngineInitArgs {
  roomId: string;
  players: Array<{ id: string; name: string; isAI: boolean; characterId?: string }>;
  /** 目标齿轮数（胜利条件），默认取 GConst 或 30 */
  targetScore?: number;
  /** 是否启用混沌卡 */
  chaosEnabled?: boolean;
  /** 随机种子 */
  seed?: number;
}

/**
 * 起手手牌数 / 手牌上限。
 *
 * ⚠️ 定义已移到 `model.ts`（叶子模块），这里**只做 re-export**。
 * 原因是 `interp.ts` 也需要它，而 `interp.ts` 不能 import `state.ts`
 * （`state.ts` 已经 import 了 interp 的 `runActions` / `random`，会成环）。
 */
import { HAND_SIZE } from './model.js';
export { HAND_SIZE };

/** 取原版常量，带兜底 */
function constNum(key: string, fallback: number): number {
  const v = GAME_CONST[key];
  return typeof v === 'number' ? v : fallback;
}

function emptyRes() {
  return { money: 0, vote: 0, malice: 0, score: 0, income: 0, term: 0 };
}

/** 按原版数值初始化一名玩家 */
function buildPlayer(
  args: { id: string; name: string; isAI: boolean; characterId?: string },
  index: number,
  state: Pick<EngineState, 'mapId'>,
): EnginePlayer {
  const char = args.characterId ? CHARACTER_BY_ID[args.characterId] : undefined;
  const res = emptyRes();

  // 原版初始资源（GConst.cs: INITIAL_MONEY=200, INITIAL_INCOME=30, INITIAL_BRIBE=20）
  res.money = constNum('INITIAL_MONEY', 200);
  res.income = constNum('INITIAL_INCOME', 30);
  res.vote = constNum('INITIAL_VOTE', 0);
  res.malice = constNum('INITIAL_MALICE', 0);
  res.score = 0;
  res.term = 0;

  // 起始格：按角色对应的格子类型在当前棋盘中查找
  const startCellId = (() => {
    if (char?.normalStartCellId && getCell(state, char.normalStartCellId)) {
      return char.normalStartCellId;
    }
    // 角色的起始格 ID 不在当前棋盘中（如自定义棋盘），
    // 按原版棋盘中同类型格子的序号，在当前棋盘找对应序号的格
    if (char?.normalStartCellId) {
      const origCell = NORMAL_MAP.cells.find((c) => c.id === char.normalStartCellId);
      if (origCell) {
        // 原版同类型格按 num 排序，找序号
        const origSameType = NORMAL_MAP.cells
          .filter((c) => c.cellType === origCell.cellType)
          .sort((a, b) => a.num - b.num);
        const idx = origSameType.findIndex((c) => c.id === origCell.id);
        // 当前棋盘同类型格按 num 排序，取相同序号
        const curSameType = getMap(state).cells
          .filter((c) => c.cellType === origCell.cellType)
          .sort((a, b) => a.num - b.num);
        if (idx >= 0 && idx < curSameType.length) {
          return curSameType[idx].id;
        }
        // 序号越界则取最后一个
        if (curSameType.length > 0) return curSameType[curSameType.length - 1].id;
      }
    }
    return getMap(state).cells[0].id;
  })();

  return {
    id: args.id,
    name: args.name,
    isAI: args.isAI,
    connected: !args.isAI,
    characterId: args.characterId,
    res,
    cellId: startCellId,
    hand: [],
    permanents: [],
    secrets: [],
    inJail: false,
    term: 0,
    jailRank: 0,
    jailExp: 0,
    skipTurns: 0,
    extraTurns: 0,
    lastMoveSteps: 0,
    movedThisTurn: false,
    cardsPlayedThisTurn: 0,
    colorIndex: index,
    flags: {},
    conflictTotal: 0,
    conflictInit: 0,
    conflictWon: 0,
    conflictPaid: 0,
  };
}

/** 建立初始对局 */
export function createState(args: EngineInitArgs): EngineState {
  const mapId = CUSTOM_MAP.id;
  const seed = args.seed ?? (Date.now() & 0xffffffff);

  // 主牌堆 = 行动卡按 DeckCount 展开。
  // DeckCount 为 0 表示该卡不入牌库（如 a159），不能用 max(1,..) 强行补一张。
  // 注意：混沌卡（CHAOS_CARDS）是**事件卡**，结构不同（无移动点数、不可持在手上），
  // 不能混进主牌堆——否则会抽出 CARD_BY_ID 查不到的 id。
  const deck: string[] = [];
  for (const c of ACTION_CARDS) {
    for (let i = 0; i < c.deckCount; i++) deck.push(c.id);
  }

  const state: EngineState = {
    roomId: args.roomId,
    phase: 'playing',
    round: 1,
    currentIndex: 0,
    players: [],
    deck: [],
    discard: [],
    // 厄运牌堆由 `buildMisfortuneDeck` 统一构造（按 DeckCount 展开，
    // 并处理"玩家 ≥5 人剔除 m029"这条人数规则）——见下方洗牌之后
    misfortuneDeck: [],
    jailDeck: JAIL_CARDS.map((c) => c.id),
    // 混沌卡是**共享池**：全员都能看到并选择打哪张，打一张少一张
    chaosPool: args.chaosEnabled !== false ? CHAOS_CARDS.map((c) => c.id) : [],
    chaosPlayed: [],
    mayorId: undefined,
    nextElectionRound: ELECTION_INTERVAL,
    // 目标齿轮数：原版是**可配置**的（`GConst.GOAL_SCORE_1..19` = 10..100）。
    // 缺省取最低档 10（= GOAL_SCORE_1），而不是凭空写一个 30。
    targetScore: args.targetScore ?? constNum('GOAL_SCORE_1', 10),
    mapId,
    chaosEnabled: args.chaosEnabled !== false,
    log: [],
    rngState: seed >>> 0,
  };

  // 洗牌
  shuffleInPlace(state, deck);
  shuffleInPlace(state, state.jailDeck);
  // 注意：厄运牌堆**不能在这里**构造——它有一条"玩家 ≥5 人剔除 m029"的
  // 人数规则，而 `state.players` 此时还是空的。等玩家填好后再建（见函数末尾）。

  // 角色分配追踪：已分配的角色不重复
  const assignedChars = new Set<string>();

  // 玩家按原版行动顺序（StepOrderNum）排列
  // 角色分配：从全部角色中随机分配，不重复（原版 RandomFromThree / All 模式均不重复）
  const allCharIds = CHARACTERS.map((c) => c.id);
  shuffleInPlace(state, allCharIds);
  const sorted = args.players.slice().sort((a, b) => {
    // 无角色时按加入顺序
    return 0;
  });

  state.players = sorted.map((p, i) => {
    // 优先用客户端指定的角色（如果合法且未被占用），否则随机分配
    let charId = p.characterId;
    if (!charId || !CHARACTER_BY_ID[charId] || assignedChars.has(charId)) {
      charId = allCharIds[i] ?? allCharIds[0];
    }
    assignedChars.add(charId);
    return buildPlayer({ ...p, characterId: charId }, i, state);
  });
  // 按角色行动顺序排序（原版 StepOrderNum）
  state.players.sort((a, b) => {
    const ca = a.characterId ? CHARACTER_BY_ID[a.characterId] : undefined;
    const cb = b.characterId ? CHARACTER_BY_ID[b.characterId] : undefined;
    return (ca?.order ?? 99) - (cb?.order ?? 99);
  });
  state.deck = deck;

  // 厄运牌堆：现在 players 已填好，可以应用"玩家 ≥5 人剔除 m029"的人数规则
  state.misfortuneDeck = buildMisfortuneDeck(state);

  // 发初始手牌
  for (const p of state.players) drawTo(state, p, HAND_SIZE);

  // 赛局开始被动（来自角色 ActionList 中以 StartGame 为标记的能力）
  for (const p of state.players) applyStartPassives(state, p);

  state.phase = 'playing';
  return state;
}

/** Fisher–Yates，使用 state 的可复现随机源 */
function shuffleInPlace<T>(state: EngineState, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random(state) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * 赛局开始被动。
 *
 * 角色能力统一由 `abilities.ts` 的数据驱动注册表处理（不再用 characterName 硬编码）。
 * 这里只负责广播 gameStart 事件。
 */
function applyStartPassives(state: EngineState, p: EnginePlayer): void {
  fireAbility(state, p.id, 'gameStart');
}

/**
 * 单调递增的"进度计数"。
 *
 * ⚠️ 为什么需要它：AI 驱动的"防卡死"保险原本用 `state.log.length` 判断
 * "这一轮有没有变化"，但 **`state.log` 有 400 条上限**（超过就 `shift()`），
 * 于是长局中 `log.length` 恒为 400、`before === after` 永远成立 ——
 * 保险被**每一轮都误触发**，AI 刚做一步就被强制结束回合。
 * 用户报的"AI 经常走着走着不动了"就是这个（长局才明显，短局看不出）。
 *
 * 本函数在每次状态变化时被调用，同时也让日志条数继续推进。
 */
export function bumpProgress(state: EngineState, playerId: string, text: string): void {
  state.progress = (state.progress ?? 0) + 1;
  pushLog(state, playerId, text);
}

function pushLog(state: EngineState, playerId: string, text: string): void {
  state.progress = (state.progress ?? 0) + 1;
  state.log.push({ round: state.round, playerId, text, ts: Date.now() });
  if (state.log.length > 400) state.log.shift();
}

// ---------------------------------------------------------------- 回合流程
/** 当前行动玩家（复用 model 的 currentPlayer，避免重复导出） */
function actorOf(state: EngineState): EnginePlayer {
  return state.players[state.currentIndex];
}

/**
 * 费用校验（移动与效果共用）。
 *
 * 注意：原版**所有** 186 张卡都带 CellID（可用地点），不存在"地点不限"的卡。
 * 地点限制只在"到建筑后打出卡牌效果"时生效；用它来移动不受地点限制
 * （卡面写的是"使用此卡牌的站点"，即效果的使用地点）。
 */
export function canAffordCard(p: EnginePlayer, cardId: string): { ok: boolean; reason?: string } {
  const card = CARD_BY_ID[cardId];
  if (!card) return { ok: false, reason: '卡牌不存在' };
  if (!p.hand.includes(cardId)) return { ok: false, reason: '不在手牌中' };
  const key: ResourceKey = card.priceType === 'Vote' ? 'vote' : 'money';
  if (card.price > 0 && p.res[key] < card.price) {
    return { ok: false, reason: `${key === 'vote' ? '选票' : '金钱'}不足（需 ${card.price}）` };
  }
  return { ok: true };
}

/** 能否用这张牌移动：只要求持有且付得起费用 */
/**
 * 能否用这张牌**移动**。
 *
 * 用行动卡移动**不花任何资源**——卡牌的费用只在"在站点把它当效果打出"时支付。
 * 一张牌既可用来移动，也可在它的特定站点打出效果；
 * 同样是打出一张牌，走路免费，站点施放才付费。
 *
 * 所以这里**不能**检查 `canAffordCard`：付不起钱的牌照样能用来走路。
 * （曾经误加了可支付性检查 + 移动时扣费，导致 AI 与玩家在缺钱时寸步难行。）
 */
export function canMoveWithCard(p: EnginePlayer, cardId: string): { ok: boolean; reason?: string } {
  const card = CARD_BY_ID[cardId];
  if (!card) return { ok: false, reason: '卡牌不存在' };
  // 特殊移动牌（a022 装腔作势、a059 二手货）：move=0 但可用掷骰/弃牌决定步数
  if (card.move <= 0 && !card.specialMove) return { ok: false, reason: '这张牌没有移动点数' };
  if (!p.hand.includes(cardId)) return { ok: false, reason: '不在手牌中' };
  if (p.movedThisTurn && p.extraTurns <= 0) {
    return { ok: false, reason: '本回合已移动过' };
  }
  return { ok: true };
}

/**
 * 能否在当前地点打出这张牌的**效果**。
 * 需要：在手上、付得起费用、且当前格子的类型等于卡牌的 CellID。
 */
export function canPlayCard(
  state: EngineState,
  p: EnginePlayer,
  cardId: string,
): { ok: boolean; reason?: string } {
  const card = CARD_BY_ID[cardId];
  if (!card) return { ok: false, reason: '卡牌不存在' };
  if (!p.hand.includes(cardId)) return { ok: false, reason: '不在手牌中' };

  const cell = getCell(state, p.cellId);
  if (!cell) return { ok: false, reason: '位置无效' };

  if (card.cellTypeId && card.cellTypeId !== '0' && cell.cellTypeId !== card.cellTypeId) {
    const want = CELL_TYPE_BY_ID[card.cellTypeId]?.text.name ?? '特定地点';
    return { ok: false, reason: `只能在此地点打出：${want}（当前：${cellLabel(cell)}）` };
  }

  return canAffordCard(p, cardId);
}

/**
 * 移动：逐格前进。**遇到岔路口（出度 > 1）时必须让玩家选方向**，
 * 引擎不能代替玩家决定——这是原作的核心决策点之一。
 *
 * @returns 走完返回 done；需要选路时返回 needChoice
 */
/**
 * 卡牌 `actions` 里 `MOVE` **之前**的动作 —— 即"打出效果"那一段。
 *
 * 卡牌数据把两段拼在一起：`[ ...打出效果..., MOVE, ...仅用于移动的效果... ]`。
 * `moveActions` 是 `MOVE` **之后**的部分；这个函数给 `MOVE` **之前**的部分。
 *
 * ⚠️ `Perm_*` / `Perm_Discard` 是**永久卡注册**动作，不是一次性效果：
 *   - a140「恶魔雕像」：`Perm_EvilBonus(40)` 把"打出给^的牌时+40$"登记为永久规则
 *   - a123「星际电梯」：`Perm_AstralElevator(1)` 登记"可从银行直达天界"
 *   - a121「机械帮手」：`Perm_Discard(1)` 登记"到站无牌可打时弃1张"
 * 这些只在"打出行动"时登记，**用于移动时不该登记**（移动完这张牌就进弃牌堆了）。
 */
export function preMoveActions(card: CardAction[] | undefined): CardAction[] {
  const acts = card ?? [];
  const mi = acts.findIndex((a) => String(a.type) === 'MOVE');
  if (mi < 0) return [];
  return acts.slice(0, mi);
}


/**
 * 用这张牌移动时需要**先付得起的钱**（`[m]` 段里的金钱代价）。
 *
 * 用户明确要求："这个效果你得放在 startMove 之前 —— 因为有些牌如果要
 * 支付金钱才能移动，没钱就不能用它移动了"。
 *
 * 目前带金钱代价的移动牌：
 *   a015 永动机   `[m] -20$`
 *   a024 翻筋斗   `[m] -50$`
 *   a129 贿赂有道 `[m] Pay ~`（金额随罪恶变化）
 *   a140 恶魔雕像 `[m] -50$`
 *
 * 注意 a172「认错」的 `[m]` 代价是**选票**、a140 还有 -1 罪恶 ——
 * 那些不是"付不起就不能动"的门槛（原版只对金钱做门槛）。
 */
export function moveCostOf(state: EngineState, p: EnginePlayer, cardId: string): number {
  const card = CARD_BY_ID[cardId];
  if (!card) return 0;
  let due = 0;
  // `MOVE` 之后的 `[m]` 段；a066 这类没有 `MOVE` 标记的，移动段就是 `SpecialMove`
  const phase = card.moveActions?.length
    ? card.moveActions
    : card.actions.filter((a) => String(a.type) === 'SpecialMove');
  for (const a of phase) {
    const type = String(a.type);
    // a066「巧夺先机」：`SpecialMove(20)` = "可以支付 20$ 把移动点数改为 4"
    if (type === 'SpecialMove') {
      const n = (a.params ?? []).find((x) => /^\d+$/.test(x));
      if (n) due += Number(n);
      continue;
    }
    if (type !== 'OpponentLoseMoney') continue;
    const params = a.params ?? [];
    // `Bribe`：金额 = 该玩家当前贿赂额 × 倍率
    if (params.includes('Bribe')) {
      const mult = Number(params.find((x) => /^\d+$/.test(x)) ?? 1) || 1;
      due += bribeAmount(state, p) * mult;
      continue;
    }
    // 正数 = 要扣钱（负数 = 给钱，不算门槛）
    for (const x of params) {
      if (/^\d+$/.test(x) && Number(x) > 0) due += Number(x);
    }
  }
  return due;
}

export function startMove(
  state: EngineState,
  playerId: string,
  cardId: string,
  choices?: Record<string, string[]>,
  /**
   * 目的地等选项。
   *
   * destinationTileId 是玩家在**预览**里选定的落点：引擎会据此预先算好
   * 整条路径并按它走，不再中途逐个岔路口提问。
   * （早先忽略这个字段，导致实际落点与预览不一致——用户 bug #1。）
   */
  options?: { destinationTileId?: string },
): { ok: boolean; reason?: string; path?: string[]; pending?: PendingChoice } {
  const p = getPlayer(state, playerId);
  if (!p) return { ok: false, reason: '玩家不存在' };
  const card = CARD_BY_ID[cardId];
  if (!card) return { ok: false, reason: '卡牌不存在' };

  // 同一次移动的续跑：已存在针对该玩家与该卡的 moveCursor。
  // 这个判断必须在"有待决策"检查之前，否则选路会被自己挂起的 pending 挡住。
  const resumeMove = state.moveCursor?.playerId === playerId
    && state.moveCursor?.cardId === cardId;
  const isResume = !!choices || resumeMove;

  if (!isResume) {
    if (state.pending) return { ok: false, reason: '有未完成的决策' };
    const chk = canMoveWithCard(p, cardId);
    if (!chk.ok) return chk;

    // ── 「付不起就不能用它移动」+ 实际扣款 ──
    //
    // 用户明确要求："这个效果你得放在 startMove 之前 —— 因为有些牌如果要
    // 支付金钱才能移动，没钱就不能用它移动了"。
    // 例：a015「永动机」`[m] -20$`、a024「翻筋斗」`[m] -50$`、
    //     a129「贿赂有道」`[m] Pay ~`、a066「巧夺先机」`[m] -20$`。
    //
    // ⚠️ 门槛与扣款必须用**同一个** `moveCostOf`：先按它校验，再按它扣。
    // 否则会出现"校验通过了但没人扣钱"（实测 a066 就是这样：
    // `SpecialMove` 只改点数、没扣款）。
    const due = moveCostOf(state, p, cardId);
    if (due > 0) {
      if (p.res.money < due) {
        return { ok: false, reason: `付不起用这张牌移动的代价（需要 ${due}，你有 ${p.res.money}）` };
      }
      addRes(p, 'money', -due);
      p.flags['moveCostPaid'] = due;
      pushLog(state, p.id, `用「${card.text.name}」移动，支付 ${due} ${RESOURCE_LABEL_ZH.money ?? '金钱'}`);
    }

    removeFromHand(state, p, cardId);
    state.discard.push(cardId);
    p.lastMoveCardId = cardId;
    // 特殊移动牌（掷骰决定步数）：用掷出的值，否则用卡牌基础值
    const steps = p.flags['customMoveSteps'] ?? card.move;
    if (p.flags['customMoveSteps'] != null) delete p.flags['customMoveSteps'];
    p.lastMoveSteps = steps;
    p.movedThisTurn = true;
    p.cardsPlayedThisTurn += 1;
    state.moveCursor = { playerId, stepsLeft: steps, path: [], cardId, destTileId: options?.destinationTileId };
    pushLog(state, p.id, `使用「${card.text.name}」移动 ${steps} 步`);

    // ── 按玩家选定的目的地预先算好整条路径 ──
    //
    // ⚠️ 这里原先**忽略**了 destinationTileId（只把它当"到了就提前停"的标记），
    // 于是引擎每到岔路口就再问一次方向，玩家最终走到哪**与预览无关** ——
    // 用户报的 bug #1："从收入移动 3 步，理论上可以停留在监狱，
    // 选中后却走到了赌博"。
    //
    // 现在：预览与执行共用 `findPathTo`，选定的目的地决定整条路径，
    // 引擎不再中途提问（真正走不通时才回退到逐岔路口询问）。
    const dest = options?.destinationTileId;
    if (dest && dest !== p.cellId) {
      const graph = graphOfMap(getMap(state), isReverseMoveCard(card.id));
      const full = findPathTo(graph, p.cellId, steps, dest);
      if (full) {
        state.moveCursor.plannedPath = full;
      } else {
        pushLog(state, p.id, `无法恰好用 ${steps} 步走到所选目的地，改为逐路口选择`);
      }
    }

    // 原版规则：用牌后立即补抽一张（手牌始终 6 张）
    drawTo(state, p, 1);
  }

  const cursor = state.moveCursor;
  if (!cursor) return { ok: false, reason: '没有进行中的移动' };

  // 本牌是否允许**逆行**（沿箭头反方向走）。
  //
  // a031「作弊！」的原版效果："You can move **against the arrows** when you
  // use this card to move."（`isReverseMoveCard` 通过它的 `Move_Back` 动作识别）
  //
  // ⚠️ 早先只有**预览**支持逆行（`computeReachableTiles(..., reverse)`），
  // 引擎却永远沿 `cell.out` 走 —— 于是预览里能选的逆行路线，确认后走到别处
  // 或走不动（用户 bug #3）。现在引擎按同一份 `findPathTo` 走 `cell.in`。
  const reverseMove = isReverseMoveCard(cardId);

  // ── 有预定路径：按它走，不问路口 ──
  if (cursor.plannedPath?.length) {
    const planned = cursor.plannedPath;
    let i = cursor.path.length;
    while (i < planned.length) {
      const next = planned[i]!;
      if (!getCell(state, next)) break;
      p.cellId = next;
      cursor.path.push(next);
      cursor.stepsLeft -= 1;
      i++;
    }
    cursor.plannedPath = undefined;
    cursor.stepsLeft = 0;
    // 落到下面"走完"的处理
  } else {

  // 逐步推进
  while (cursor.stepsLeft > 0) {
    // 原版规则：到达目的地建筑时可提前停止（不必走完所有步数）
    if (cursor.destTileId && p.cellId === cursor.destTileId) {
      cursor.stepsLeft = 0;
      break;
    }
    const cur = getCell(state, p.cellId);
    if (!cur) break;
    // 逆行牌沿 `in` 走，普通牌沿 `out` 走（与预览的 `reverse` 参数一致）
    const edges = reverseMove ? cur.in : cur.out;
    const outs = edges.filter((id) => !!getCell(state, id));
    if (!outs.length) break;

    if (outs.length === 1) {
      p.cellId = outs[0];
      cursor.path.push(outs[0]);
      cursor.stepsLeft -= 1;
      continue;
    }

    // 岔路口：需要玩家选择
    const key = `moveBranch:${cursor.path.length}`;
    const picked = choices?.[key]?.[0];
    if (picked && outs.includes(picked)) {
      p.cellId = picked;
      cursor.path.push(picked);
      cursor.stepsLeft -= 1;
      continue;
    }

    // 挂起，等待选择
    const pending: PendingChoice = {
      kind: key,
      playerId: p.id,
      prompt: `选择方向（剩余 ${cursor.stepsLeft} 步）`,
      options: outs.map((id) => {
        const c = getCell(state, id);
        return { value: id, label: c ? `${cellLabel(c)}（${cellTypeOf(c)?.cellType ?? ''}）` : id };
      }),
      min: 1,
      max: 1,
      resume: {
        actions: [],
        index: 0,
        targets: [],
        source: '移动选路',
        ownerId: p.id,
      },
    };
    state.pending = pending;
    return { ok: true, pending, path: cursor.path };
  }

  } // ← 结束 plannedPath 的 else 分支

  // 走完
  const path = cursor.path.slice();
  state.moveCursor = undefined;
  // 清掉可能残留的选路挂起
  if (state.pending?.kind.startsWith('moveBranch:')) state.pending = undefined;
  p.cellId = path.length ? path[path.length - 1] : p.cellId;
  pushLog(state, p.id, `移动到 ${cellLabel(getCell(state, p.cellId))}`);

  // 移动相关钩子
  const mvFlags: Record<string, string | number | boolean> = {};
  fireTrigger(state, 'anyMove', { actorId: p.id, amount: path.length, flags: mvFlags });
  if (path.length >= 5) fireTrigger(state, 'anyLongMove', { actorId: p.id, amount: path.length });
  if (path.length === 1) fireTrigger(state, 'moveWithOne', { actorId: p.id, amount: 1 });
  if (path.length >= 5 && characterName(p) === 'Merchant') mvFlags.skipBribe = true;

  // 角色能力：移动后。
  // 必须在 pass-through / landing 之前触发——「动起来」（免贿赂）与
  // 「停止」（免厄运）都要先于结算生效。印花税等即时收益也在这里结算。
  fireAbility(state, p.id, 'afterMove', { steps: path.length, cellId: p.cellId });

  // 「用这张卡**移动**」触发的规则（卡牌说明里的 `[m]` 段）。
  //
  // 原版把两种用法写在同一张卡的 ActionList 里，用 `MOVE` 分隔；
  // 生成数据时已把 `MOVE` 之后的动作抽到 `card.moveActions`。
  // 这一段**必须在这里执行**——它是在"用这张牌走路"时结算的，
  // 与"在站点把牌打出"完全不同的时机。
  //
  // 例：a015「永动机」移动时 -20$；a076 移动时跳过 1 回合；a031 可逆行。
  //
  // ── `MOVE` **没有**出现在数据里的特殊移动牌 ──
  //
  // a066「巧夺先机」在反编译数据里是：
  //     SpecialMoveFlag = true
  //     ActionList = [Teleport, SpecialMove]
  // **没有 `MOVE` 分隔符** —— 所以"抽出 MOVE 之后的部分"这套生成逻辑
  // 对它无效，`moveActions` 是空的。
  //
  // 卡面把两段写得很清楚：
  //   text     = "瞬移到任意站点或建筑。"                      ← 打出效果
  //   moveText = "When you use this card to move, you can pay {1}$
  //               to change move points to 4."                ← 移动效果
  // 所以 `SpecialMove` 才是移动段，`Teleport` 是打出效果。
  //
  // ⚠️ 我第一版写成"这类卡整张 ActionList 都跑"，结果移动时也要求玩家
  // 先选传送目的地（`Teleport(All)` 挂起）—— 那是打出效果，不该在移动时问。
  const movePhase = card.moveActions?.length
    ? card.moveActions
    : card.actions.filter((a) => String(a.type) === 'SpecialMove');
  if (movePhase.length) {
    const r = runActions(state, {
      actions: movePhase,
      index: 0,
      targets: [p.id],
      ownerId: p.id,
      source: `「${card.text.name}」移动效果`,
      sourceCardId: card.id,
    });
    if (r.status === 'pending') {
      state.pending = r.pending;
      return { ok: true, path, pending: r.pending };
    }
  }

  // pass-through 只结算途经格（不含终点——终点由 landing 处理）
  resolvePassThrough(state, p, path.slice(0, -1), mvFlags);
  // 终点：判定交锋（先）+ **登记欠着的格子效果**（UseCard 阶段收尾时再做）。
  // ⚠️ 这里**不再**设 cellResolved —— 否则 maybeAutoEnd 会立刻结束回合，
  // 玩家就没机会在站点效果之前用牌（原版顺序是 Move→Conflict→UseCard→UseCell）。
  if (!p.flags['ignoreCell']) {
    const pending = resolveLanding(state, p);
    if (pending) {
      state.pending = pending;
      return { ok: true, path, pending };
    }
    // 无挂起：格子效果欠着（pendingCellEffect），等 skipPlay / 打牌后结算
  } else {
    p.flags['cellResolved'] = 1;
  }

  return { ok: true, path };
}

/**
 * 回答「移动选路」挂起项，继续剩余步数。
 */
export function resolveMoveBranch(
  state: EngineState,
  playerId: string,
  cellId: string,
): { ok: boolean; reason?: string; pending?: PendingChoice; path?: string[] } {
  const pend = state.pending;
  if (!pend) return { ok: false, reason: '当前没有待决策项' };
  if (pend.playerId !== playerId) return { ok: false, reason: '不是你的决策' };
  if (!pend.kind.startsWith('moveBranch:')) return { ok: false, reason: '当前不是选路决策' };
  if (!pend.options.some((o) => o.value === cellId)) return { ok: false, reason: '该方向不可达' };

  const cursor = state.moveCursor;
  if (!cursor) return { ok: false, reason: '没有进行中的移动' };
  const cardId = cursor.cardId;

  state.pending = undefined;
  // 把选择带回去继续走
  return startMove(state, playerId, cardId, { [pend.kind]: [cellId] });
}

/** 打出非移动的效果卡 */
/**
 * 结算卡牌面板上的「收获 / 代价」资源包。
 *
 * 原版 `GActionCard` 有两个 `GResource` 字段：
 *  - `Income`  = 卡面「收获」→ 打出时**加**给自己
 *  - `Outcome` = 卡面「代价」→ 打出时**扣**（数据里是正数，表示扣多少）
 *
 * 实测 **137/186 张卡有「收获」、16 张有「代价」**，也就是说这个函数
 * 之前缺失时，**153 张卡打出来在资源上毫无变化**。
 *
 * @param sign `+1` 加、`-1` 扣
 */
function applyCardResourceBundle(
  state: EngineState,
  p: EnginePlayer,
  card: { text: { name: string } },
  label: 'income' | 'outcome',
  bundle: Partial<Record<ResourceKey, number>> | undefined,
  sign = 1,
): void {
  if (!bundle) return;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(bundle)) {
    if (typeof v !== 'number' || !v) continue;
    // `term`/`income` 等非负键也走 addRes（addRes 内部已保证不为负）
    const delta = addRes(p, k as ResourceKey, v * sign);
    if (!delta) continue;
    const zh = RESOURCE_LABEL_ZH[k as ResourceKey] ?? k;
    parts.push(`${delta > 0 ? '+' : ''}${delta} ${zh}`);
  }
  if (parts.length) {
    pushLog(state, p.id,
      `「${card.text.name}」${label === 'income' ? '收获' : '代价'}：${parts.join('，')}`);
  }
}

export function playEffectCard(
  state: EngineState,
  playerId: string,
  cardId: string,
  choices?: Record<string, string[]>,
): { ok: boolean; reason?: string; pending?: PendingChoice } {
  const p = getPlayer(state, playerId);
  if (!p) return { ok: false, reason: '玩家不存在' };
  if (!choices && state.pending) return { ok: false, reason: '有未完成的决策' };

  const card = CARD_BY_ID[cardId];
  if (!card) return { ok: false, reason: '卡牌不存在' };
  if (!choices) {
    const chk = canPlayCard(state, p, cardId);
    if (!chk.ok) return chk;
  }

  if (!choices) {
    payCardCost(p, card);
    removeFromHand(state, p, cardId);
    p.cardsPlayedThisTurn += 1;
    p.flags['sourceCardId'] = 1;
    pushLog(state, p.id, `打出「${card.text.name}」`);
  }

  // 记录施放前的罪恶值，用于「恶魔雕像」类永久卡（打出给罪恶的牌时 +N 金）
  const maliceBefore = p.res.malice;
  const moneyBefore = p.res.money;
  const voteBefore = p.res.vote;
  const scoreBefore = p.res.score;

  // ── 卡牌自身的「收获 / 代价」字段 ──
  //
  // ⚠️ 这里曾经**完全没有结算** `card.income` / `card.outcome`，于是
  // **137/186 张卡的"收获"打出来毫无效果**（用户报的 bug #3：
  // a021「奔跑的炸弹」写着 +6 齿轮，打出后齿轮不涨）。
  // 混沌卡那条路径（`playChaosCard`）一直是结算的，行动卡漏了。
  //
  // 字段语义（与卡面 UI 一致，见 `card-display.ts`）：
  //  - `income`  = 「收获」→ **加**给打出者
  //  - `outcome` = 「代价」→ 从打出者**扣**（数据里存的都是正数，表示要扣多少）
  //
  // 没有重复结算：`income`/`outcome` 是卡牌面板上的固定数值，
  // 而 `actions` 是具体效果（如 `Perm_SecretVote` 只是登记触发钩子，
  // 本就不产生即时资源变化）。
  if (!choices) {
    applyCardResourceBundle(state, p, card, 'income', card.income);
    applyCardResourceBundle(state, p, card, 'outcome', card.outcome, -1);
  }

  // ── 用卡牌**行动**时，只跑 `MOVE` 之前的动作 ──
  //
  // ⚠️ 卡牌的 `actions` 数组把两段拼在一起：
  //     [ ...打出效果..., MOVE, ...仅在"用于移动"时才生效的效果... ]
  // 移动路径用的是 `card.moveActions`（生成数据时已把 `MOVE` 之后的部分抽出来），
  // 而行动路径原先直接传**整个** `card.actions` —— 于是 `[m]` 段被一起执行。
  //
  // 实测后果（16 张卡受影响）：
  //   a015「永动机」`[m] -{1}$ if you use this card to move` → 用卡牌行动也扣 20$
  //   a150「斜坡」 `[m] +{2}$ …`                            → 白拿 50$
  // 用户没提到，但是**成规模的错误**。
  //
  // 注意：`MOVE` **之前**的动作两段**都要跑**（例如 a024 的 Teleport 是
  // "打出即传送"，与移动无关），所以只能截掉 `MOVE` 之后的部分。
  const moveIdx = card.actions.findIndex((a) => String(a.type) === 'MOVE');
  const actionsForPlay = moveIdx >= 0 ? card.actions.slice(0, moveIdx) : card.actions;

  const ctx: ActionContext = {
    actions: actionsForPlay,
    index: 0,
    targets: [p.id],
    ownerId: p.id,
    source: `卡牌「${card.text.name}」`,
    sourceCardId: cardId,
    choices,
    scratch: { sourceCardId: cardId },
  };
  const r = runActions(state, ctx);
  if (r.status === 'pending') {
    state.pending = r.pending;
    return { ok: true, pending: r.pending };
  }

  // 永久卡：永久卡进已激活区，秘密卡进秘密区，其余进弃牌堆
  if (card.permanent) {
    p.permanents.push(cardId);
    // 数值型 Perm_* 在打出时立即落地；触发型留给 fireTrigger
    applyImmediatePermanents(state, p, cardId);
    // ── a121「机械帮手」：把"到站无牌可打时可弃牌"记在**持有者**身上 ──
    //
    // ⚠️ `PERM_SPECS.Perm_Discard` 挂的是 `ownTurnEnd` 事件，但 `handleFlag`
    // 原先落 `default: return false` —— flag 永远不会被写到玩家身上，
    // 于是这张 700 金的永久卡完全没作用。
    // 这里在**打出时**就把 flag 落到持有者（它是持久的，不是一次性触发）。
    if (card.actions.some((a) => String(a.type) === 'Perm_Discard')) {
      const n = card.actions
        .filter((a) => String(a.type) === 'Perm_Discard')
        .map((a) => Number((a.params ?? []).find((x) => /^\d+$/.test(x)) ?? 1))
        .find((v) => v > 0) ?? 1;
      p.flags['discardIfNoAction'] = n;
      pushLog(state, p.id, `永久卡「${card.text.name}」：到站无牌可打时可弃 ${n} 张手牌`);
    }
  } else if (card.secret) {
    p.secrets.push(cardId);
    // 秘密卡相关钩子（「秘密社会」+选票、「秘密警察」向他人收费）
    fireTrigger(state, 'playSecret', { actorId: p.id });
    fireTrigger(state, 'anyPlaySecret', { actorId: p.id });
  } else {
    state.discard.push(cardId);
  }

  // 打出效果卡之后的钩子（「加速器」同地点再打一张、「天界电梯」）
  fireTrigger(state, 'afterPlayAction', { actorId: p.id, cellId: p.cellId });

  // 罪恶相关钩子：本卡使罪恶净增时触发（「恶魔雕像」+N 金）
  if (p.res.malice > maliceBefore) {
    fireTrigger(state, 'playCardGainMalice', {
      actorId: p.id,
      amount: p.res.malice - maliceBefore,
    });
  }

  // 角色能力：打出卡牌后（给选票的卡、秘密卡、罪恶卡、在地狱打牌…）
  fireAbility(state, p.id, 'afterPlayCard', {
    cellId: p.cellId,
    cardId,
    isSecret: card.secret,
    isCriminal: card.criminal,
    gainedVotes: p.res.vote - voteBefore,
    gainedScore: p.res.score - scoreBefore,
    paidMoney: Math.max(0, moneyBefore - p.res.money),
  });

  // 原版规则：打牌后立即补抽一张（手牌始终 6 张），除非 SkipDraw
  if (!p.flags['skipDraw']) {
    drawTo(state, p, 1);
  }

  // ── 整张牌处理完，把手牌收敛回上限 ──
  //
  // ⚠️ a078「古代经文」`actions = [PickCardEarly, SelectDeckCard(6|Hand)]`：
  //   `PickCardEarly` 先抽 1（手牌 0→1）→ `SelectDeckCard` 抽 6 进手牌、
  //   并把上限压到 `HAND_SIZE` → 但紧接着"打牌后补抽 1 张"又把它顶到 7。
  //   卡面写的是"抽 6 张加入手牌，**保留 6**，丢弃其余"，结束时应该是 6 张。
  // 在整张牌结算完（含补抽）之后再收敛一次，与"手牌恒为 6"的不变量一致。
  if (!card.permanent && !card.secret) {
    while (p.hand.length > HAND_SIZE) {
      const extra = p.hand.pop()!;
      state.discard.push(extra);
    }
  }
  // 清除"可再打一张"标记（用掉了这次额外机会）
  if (p.flags['canPlayAgain']) delete p.flags['canPlayAgain'];

  return { ok: true };
}

/** 回答挂起的决策 */
export function resolvePending(
  state: EngineState,
  playerId: string,
  answer: string[],
): { ok: boolean; reason?: string; pending?: PendingChoice } {
  const pending = state.pending;
  if (!pending) return { ok: false, reason: '当前没有待决策项' };
  if (pending.playerId !== playerId) return { ok: false, reason: '不是你的决策' };

  // 移动选路是特殊挂起：由 startMove 自己续跑，不走动作解释器
  if (pending.kind.startsWith('moveBranch:')) {
    return resolveMoveBranch(state, playerId, answer[0]);
  }

  // 监狱服刑：从候选监狱牌里选一张（或全部拒绝），不走动作解释器
  if (pending.kind === JAIL_PICK_KIND) {
    return resolveJailPick(state, playerId, answer[0] ?? 'jailDecline');
  }

  // 交锋胜出：是否打出手中的 `[i]` 卡（a070 / a099）
  if (pending.kind === CONFLICT_CARD_KIND) {
    return resolveConflictCard(state, playerId, answer[0] ?? 'decline');
  }

  // 弃牌移动（a059 二手货）：**两段式**
  //   第 1 段选对手 → 随机弃其一张牌，以该牌 MovePoints 为步数（再给对手补 1 张）
  //   第 2 段选目的地 → 按该目的地走
  //
  // ⚠️ 两段复用同一个 kind，用 `resume.scratch.phase` 区分。
  // 早先只有第 1 段、且不选目的地，于是步数一定就闷头走 —— 玩家选好的目的地
  // 不生效（用户报的 bug #1）。
  if (pending.kind.startsWith('discardMove:')) {
    const moveCardId = pending.kind.slice('discardMove:'.length);
    const phase = String(pending.resume.scratch?.phase ?? 'opponent');
    const player = getPlayer(state, playerId);
    if (!player) return { ok: false, reason: '玩家不存在' };

    // ── 第 1 段：选对手 → 抽牌定步数 → 挂起问目的地 ──
    if (phase === 'opponent') {
      const opponentId = answer[0];
      const opponent = state.players.find((x) => x.id === opponentId);
      if (!opponent) return { ok: false, reason: '对手不存在' };
      if (opponent.hand.length === 0) return { ok: false, reason: '对手没有手牌' };

      if (state.deck.length === 0 && state.discard.length > 0) {
        state.deck = state.discard.splice(0).reverse();
      }
      // 随机弃对手一张牌
      const rIdx = Math.floor(random(state) * opponent.hand.length) % opponent.hand.length;
      const stolenId = opponent.hand[rIdx]!;
      opponent.hand.splice(rIdx, 1);
      state.discard.push(stolenId);
      // 给对手补 1 张
      drawTo(state, opponent, 1);

      const stolen = CARD_BY_ID[stolenId];
      const steps = stolen?.move ?? 0;
      player.flags['customMoveSteps'] = steps;
      pushLog(state, playerId,
        `二手货：弃对手 ${opponent.name} 的「${stolen?.text.name ?? stolenId}」，`
        + (steps > 0 ? `可移动 ${steps} 步，请选择目的地` : '该牌没有移动点数'));

      // 步数为 0 → 没得选，直接结束
      if (steps <= 0) {
        player.flags['customMoveSteps'] = 0;
        state.pending = undefined;
        const r0 = startMove(state, playerId, moveCardId);
        return r0;
      }

      // 挂起问目的地（第二段）。
      //
      // 候选 = "用**恰好** steps 步能走到"的所有格子，与客户端预览
      // （`computeReachableTiles`）用的是同一套寻路判据，所以两边一致。
      const graph = graphOfMap(getMap(state), isReverseMoveCard(moveCardId));
      const options: Array<{ value: string; label: string }> = [];
      for (const c of getMap(state).cells) {
        if (c.id === player.cellId) continue;
        if (!findPathTo(graph, player.cellId, steps, c.id)) continue;
        options.push({
          value: c.id,
          label: `${cellLabel(c)}（${cellTypeOf(c)?.cellType ?? ''}）`,
        });
        if (options.length >= 40) break;
      }
      if (!options.length) {
        // 走不到任何地方 → 不挂起，直接走完
        state.pending = undefined;
        return startMove(state, playerId, moveCardId);
      }
      state.pending = {
        kind: pending.kind,
        playerId,
        prompt: `二手货：可移动 ${steps} 步，选择目的地`,
        options,
        min: 1,
        max: 1,
        resume: {
          actions: [],
          index: 0,
          targets: [],
          source: '二手货',
          ownerId: playerId,
          scratch: { phase: 'dest', steps: String(steps) },
        },
      };
      return { ok: true, pending: state.pending };
    }

    // ── 第 2 段：选目的地 → 按目的地走 ──
    const chosen = answer[0];
    const dest = chosen && chosen !== '__skip_dest__' ? chosen : undefined;
    state.pending = undefined;
    const result = startMove(state, playerId, moveCardId, undefined, {
      destinationTileId: dest,
    });
    if (result.ok && state.moveCursor && dest) {
      state.moveCursor.destTileId = dest;
    }
    return result;
  }

  // 冒险格（有保险）掷到 1：选对手抽厄运
  if (pending.kind.startsWith('dangerTarget:')) {
    const pid = pending.kind.slice('dangerTarget:'.length);
    const actor = getPlayer(state, pid);
    state.pending = undefined;
    if (!actor) return { ok: false, reason: '玩家不存在' };
    const target = state.players.find((x) => x.id === answer[0]);
    if (!target) return { ok: false, reason: '对手不存在' };
    drawMisfortune(state, target);
    pushLog(state, actor.id, `冒险格：对手 ${target.name} 抽厄运牌`);
    // 冒险格效果到此彻底结束 -> 补判交锋（否则 Danger 格永远不会触发交锋）
    return doneWithConflict(state, actor);
  }

  // 冒险格：买保险 or 不买 → 掷骰 → 扔到 1 触发厄运
  if (pending.kind.startsWith('danger:')) {
    const pid = pending.kind.slice('danger:'.length);
    const actor = getPlayer(state, pid);
    state.pending = undefined;
    if (!actor) return { ok: false, reason: '玩家不存在' };
    const cost = Number(state.pendingInput?.[pending.kind] ?? 40);

    // 1) 处理保险选择
    if ((answer[0] ?? '') === 'insure' && actor.res.money >= cost) {
      addRes(actor, 'money', -cost);
      actor.flags['insured'] = 1;
      pushLog(state, actor.id, `冒险格：购买保险 ${cost} 金钱`);
    } else {
      pushLog(state, actor.id, '冒险格：不买保险');
    }

    // 2) 掷骰
    const dice = rollDice(state);
    state.lastRoll = dice;
    if (dice === 1) {
      if (actor.flags['insured']) {
        // 有保险：选对手抽厄运
        const opponents = state.players.filter(
          (x) => x.id !== actor.id && !x.inJail,
        );
        if (!opponents.length) {
          drawMisfortune(state, actor);
          pushLog(state, actor.id, '冒险格掷出 1（有保险但无对手可选）：自己抽厄运');
          return doneWithConflict(state, actor);
        }
        pushLog(state, actor.id, '冒险格掷出 1（有保险）：选择对手抽厄运');
        const dangerTarget: PendingChoice = {
          kind: `dangerTarget:${actor.id}`,
          playerId: actor.id,
          prompt: '冒险格（有保险）：选择一名对手抽厄运牌',
          options: opponents.map((o) => ({ value: o.id, label: o.name })),
          min: 1,
          max: 1,
          resume: { actions: [], index: 0, targets: [actor.id], source: '冒险格', ownerId: actor.id },
        };
        state.pending = dangerTarget;
        return doneWithConflict(state, actor, dangerTarget);
      } else {
        // 无保险：自己抽厄运
        drawMisfortune(state, actor);
        pushLog(state, actor.id, '冒险格掷出 1（无保险）：自己抽厄运');
        return doneWithConflict(state, actor);
      }
    }
    pushLog(state, actor.id, `冒险格掷出 ${dice}：平安无事`);
    return doneWithConflict(state, actor);
  }

  // 警察格：付贿赂 or 掷骰（不走动作解释器）
  if (pending.kind.startsWith('police:')) {
    const pid = pending.kind.slice('police:'.length);
    const actor = getPlayer(state, pid);
    state.pending = undefined;
    if (!actor) return { ok: false, reason: '玩家不存在' };
    const cost = Number(state.pendingInput?.[pending.kind] ?? 0);
    if ((answer[0] ?? '') === 'pay' && cost > 0) {
      // 永久卡可规避（「借口生成器」：付警察格贿赂时 50% 机会免除）
      const flags: Record<string, string | number | boolean> = {};
      fireTrigger(state, 'policePayBribe', { actorId: actor.id, flags });
      if (flags.bribeSkipped) {
        pushLog(state, actor.id, `警察格：永久卡效果免付贿赂 ${cost} 金钱`);
      } else {
        addRes(actor, 'money', -cost);
        pushLog(state, actor.id, `警察格：支付贿赂 ${cost} 金钱，安全通过`);
      }
      delete state.pendingInput?.[pending.kind];
      return doneWithConflict(state, actor);
    }
    // 掷骰
    const dice = rollDice(state);
    state.lastRoll = dice;
    pushLog(state, actor.id, `警察格掷骰 ${dice}${dice === 1 ? ' —— 被逮捕！' : ' —— 安全'}`);
    if (dice === 1) arrest(state, actor, '警察格掷出 1');
    delete state.pendingInput?.[pending.kind];
    return doneWithConflict(state, actor);
  }

  // 玩家交锋：两方逐个出价，收齐后结算（不走动作解释器）
  if (pending.kind.startsWith('conflict:')) {
    state.pending = undefined;
    const parts = pending.kind.split(':');
    const challenger = getPlayer(state, parts[1]);
    const defender = getPlayer(state, parts[2]);
    if (!challenger || !defender) return { ok: false, reason: '交锋双方不存在' };

    // 前置：「摇尾巴」逃避选择
    if (parts[3] === 'escape') {
      if ((answer[0] ?? '').toLowerCase().startsWith('escape')) {
        applyConflictEscape(state, challenger, defender);
        // 逃避者已被传送到中心厄运站，等于离开了该站；
        // 这里仍调用一次补做逻辑（它会因 cellId 不符而直接跳过），
        // 目的是把 pendingCellEffect 标记清干净，避免残留到下一回合。
        const afterEscape = resumePendingCellEffect(state);
        return afterEscape ? { ok: true, pending: afterEscape } : { ok: true };
      }
      enterConflictBidding(state, challenger, defender);
      return { ok: true, pending: state.pending };
    }

    const r = resolveConflictBid(state, pending.kind, playerId, Number(answer[0]) || 0);
    return r.pending ? { ok: true, pending: r.pending } : { ok: r.ok };
  }

  const ctx: ActionContext = {
    actions: pending.resume.actions,
    index: pending.resume.index,
    targets: pending.resume.targets,
    ownerId: pending.resume.ownerId,
    source: pending.resume.source,
    sourceCardId: pending.resume.sourceCardId,
    // 关键：把玩家的回答交给解释器，否则后续动作会退回"默认作用于自己"
    choices: { [pending.kind]: answer },
    scratch: pending.resume.scratch ? { ...pending.resume.scratch } : undefined,
  };
  state.pending = undefined;

  const r = runActions(state, ctx);
  if (r.status === 'pending') {
    state.pending = r.pending;
    return { ok: true, pending: r.pending };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 结算
function payCardCost(p: EnginePlayer, card: ActionCard): void {
  if (card.price <= 0) return;
  const key: ResourceKey = card.priceType === 'Vote' ? 'vote' : 'money';
  addRes(p, key, -card.price);
}

function removeFromHand(state: EngineState, p: EnginePlayer, cardId: string): void {
  const i = p.hand.indexOf(cardId);
  if (i >= 0) p.hand.splice(i, 1);
}

/** 经过格子的效果（收入/贿赂/厄运等）
 *  调用方已排除终点格（path.slice(0,-1)），此处处理全部传入格。 */
function resolvePassThrough(
  state: EngineState,
  p: EnginePlayer,
  path: string[],
  mvFlags: Record<string, string | number | boolean> = {},
): void {
  for (const cellId of path) {
    const cell = getCell(state, cellId);
    if (!cell) continue;
    const t = cellTypeOf(cell);
    if (!t) continue;
    // 只有 OptionalFlag=false 的站点（BuildingFlag=false）在经过时触发
    // OptionalFlag=true 的站点（警察/演讲/赌博）只在停留时可选
    // 建筑（BuildingFlag=true）经过不触发
    if (t.optional || t.building) continue;
    switch (cell.cellType) {
      case 'Income': {
        const gain = p.res.income;
        if (gain > 0) {
          addRes(p, 'money', gain);
          pushLog(state, p.id, `经过收入格：+${gain} 金钱`);
        }
        break;
      }
      case 'Bribe': {
        if (state.mayorId === p.id) break;
        const flags: Record<string, string | number | boolean> = {};
        fireTrigger(state, 'bribeSpot', { actorId: p.id, cellId, flags });
        if (flags.bribeSkipped) break;
        if (mvFlags.skipBribe) break;
        const amount = bribeAmount(state, p);
        if (amount > 0) {
          const paid = Math.min(p.res.money, amount);
          addRes(p, 'money', -paid);
          if (paid < amount) {
            addRes(p, 'malice', 1);
            pushLog(state, p.id, `经过贿赂格：支付 ${paid} 金钱（不足 ${amount - paid}），+1 罪恶`);
          } else {
            pushLog(state, p.id, `经过贿赂格：支付 ${paid} 金钱`);
          }
        }
        break;
      }
      case 'Misfortune': {
        if (p.flags['ignoreCell']) break;
        drawMisfortuneFor(state, p);
        pushLog(state, p.id, '经过厄运格：抽一张厄运牌');
        break;
      }
      default:
        break;
    }
  }
}

/** 落点结算：站点效果 / 建筑可打牌
 *
 * @returns 需要玩家决策时返回挂起项（目前只有警察格），否则 undefined
 */
export function resolveLanding(state: EngineState, p: EnginePlayer): PendingChoice | undefined {
  const cell = getCell(state, p.cellId);
  if (!cell) return;
  const cellType = cellTypeOf(cell);
  if (!cellType) return;

  // ══ 原版回合顺序 ══
  //   1) Move（走牌移动）
  //   2) Player Conflict —— "two players stop on the same spot"，
  //      输家被逮捕、**只有赢家留在该站**（TAG.Game_Label_Conflict_Description）
  //   3) UseCard —— 打出卡牌。**站点效果在此之前不生效**
  //   4) UseCell —— 结算所在格/建筑的效果
  //
  // ⚠️ 这里曾经把"格子效果"放在 Move 阶段立即结算（即第 2 步之前），
  // 于是玩家**还没机会用牌**就被强制处理站点（用户实测：到警察站先被问
  // "处理站点"，处理完才问"用不用牌"）——顺序与原版不符，已改为推迟。
  //
  // 推迟到哪：`finishTurnActions()`（UseCard 阶段收尾时调用）。
  // 这样"用牌离开"就真的能躲开站点效果，与原版一致。
  const conflict = maybeStartConflict(state, p, cell, cellType);
  if (conflict) {
    state.pendingCellEffect = { playerId: p.id, cellId: cell.id };
    return conflict;
  }

  // 不在这里结算格子效果 —— 只标记"已到站，欠一次 UseCell"
  state.pendingCellEffect = { playerId: p.id, cellId: cell.id };
  return undefined;
}

/**
 * UseCard 阶段收尾：补做**欠着**的格子效果（UseCell）。
 *
 * 调用时机：
 *  - `skipPlay()`（玩家选择不再用牌）
 *  - 打出一张效果牌之后
 *  - 交锋结算完（赢家留在格上）之后
 *
 * 若格子效果本身又挂起（买保险 / 付贿赂），把挂起返回给调用方。
 * 若玩家已经离开该格（用移动牌走了 / 被挪走），则**跳过**原格效果。
 *
 * @returns 有挂起则返回它
 */
export function finishTurnActions(state: EngineState): PendingChoice | undefined {
  if (state.pending) return state.pending;
  const pendingEffect = state.pendingCellEffect;
  if (!pendingEffect) return undefined;

  const p = getPlayer(state, pendingEffect.playerId);
  if (!p) { state.pendingCellEffect = undefined; return undefined; }

  // 已离开该格 → 不吃原格效果（这正是"先用牌离开"能躲开站点的原因）
  if (p.cellId !== pendingEffect.cellId) {
    state.pendingCellEffect = undefined;
    p.flags['cellResolved'] = 1;
    return undefined;
  }

  state.pendingCellEffect = undefined;
  const cell = getCell(state, p.cellId);
  if (!cell) { p.flags['cellResolved'] = 1; return undefined; }
  const cellType = cellTypeOf(cell);
  if (!cellType) { p.flags['cellResolved'] = 1; return undefined; }

  const cellPending = resolveCellEffect(state, p, cell, cellType);
  if (cellPending) {
    state.pending = cellPending;
    return cellPending;
  }
  p.flags['cellResolved'] = 1;
  // 格子效果没挂起 → 补一次交锋判定（格子可能把人挪到别人格上）
  return resumeLandingAfterCellEffect(state, p);
}

/**
 * 交锋结束后，补做"欠着"的格子效果。
 *
 * 顺序改成"先交锋、后格子"之后，交锋会挂起等玩家出价，而挂起被应答后引擎
 * 不会回到 resolveLanding。所以发起交锋时把 {playerId, cellId} 记进
 * state.pendingCellEffect，在交锋真正结算完（applyConflictOutcome）或
 * 被逃避（applyConflictEscape）后调用本函数补做。
 *
 * 注意：
 *  - 赢家可能因 [i] 卡（a070「敲诈！」）被**挪到相邻格**，此时已不在原格，
 *    就不该再吃原格效果 —— 所以要比对 cellId。
 *  - 输家被逮捕送进监狱，它不是本函数记录的对象。
 *
 * @deprecated 已被 `finishTurnActions()` 取代（逻辑完全并入其中）。
 * 保留此薄封装是为了不必改动各处调用点。
 */
function resumePendingCellEffect(state: EngineState): PendingChoice | undefined {
  return finishTurnActions(state);
}

/**
 * 格子效果结算完毕后，再判一次交锋；若格子效果本身挂起了，则把交锋留到之后。
 *
 * 用法（`danger:` / `police:` 这类会挂起的格子效果分支的**每个出口**）：
 * ```ts
 * return doneWithConflict(state, actor, effectPending);
 * ```
 * - `effectPending` 有值 → 返回它，交锋留到该挂起被应答后再判
 *   （应答时会走 `resolvePending` 里的对应分支，那里会再调本函数）。
 * - `effectPending` 为空 → 立即判交锋。
 */
function doneWithConflict(
  state: EngineState,
  actor: EnginePlayer,
  effectPending?: PendingChoice,
): { ok: boolean; pending?: PendingChoice } {
  if (effectPending) return { ok: true, pending: effectPending };
  const conflict = resumeLandingAfterCellEffect(state, actor);
  if (conflict) return { ok: true, pending: conflict };

  // ── 格子效果问完了，而且没有引发交锋 → 这个回合就该结束了 ──
  //
  // ⚠️ 这里以前直接 `return { ok: true }`，**没有推进回合**。
  // 而 `endTurn` 的"有可选动作就先停一下"那道逻辑只在
  // `nextTurn → endTurn` 这条路上跑过，买保险／付贿赂这些
  // **格子效果挂起**的路径完全绕开了它 —— 于是玩家答完保险问询后，
  // 界面又看到"该格可用动作"面板，点跳过又回到原地。
  // 用户实测："我总共点了四次不买或跳过，离谱"。
  //
  // 现在明确收尾：答完格子效果就交棒。
  // （`skipPlay` → `nextTurn` 那条路不会走到这里，它自己会调 `endTurn`。）
  endTurn(state);
  return { ok: true };
}

/**
 * 判定并可能发起玩家交锋。
 *
 * 触发条件是"两位玩家停在同一个**非建筑**格"——与格子效果无关，
 * 所以它可以、也必须独立于格子效果被调用。
 */
function maybeStartConflict(
  state: EngineState,
  p: EnginePlayer,
  cell: NonNullable<ReturnType<typeof getCell>>,
  cellType: NonNullable<ReturnType<typeof cellTypeOf>>,
): PendingChoice | undefined {
  // 建筑可容纳任意人数，不引发交锋
  if (cellType.building) return undefined;
  const rival = state.players.find((x) => x.id !== p.id && x.cellId === cell.id);
  if (!rival) return undefined;
  startConflict(state, p, rival);
  return state.pending;
}

/**
 * 按玩家**当前所在格**补做一次交锋判定。
 *
 * 供 `danger:` / `police:` 这类"格子效果会挂起"的续跑分支调用：
 * 这些格子效果有多个 `return` 出口，无法从 `resolveLanding` 统一续跑，
 * 所以在每个出口之前都走一遍这个收尾，避免**漏掉交锋**。
 */
function resumeLandingAfterCellEffect(
  state: EngineState,
  p: EnginePlayer,
): PendingChoice | undefined {
  const cell = getCell(state, p.cellId);
  if (!cell) return undefined;
  const cellType = cellTypeOf(cell);
  if (!cellType) return undefined;
  return maybeStartConflict(state, p, cell, cellType);
}

/** 格子自身的落地效果（不含玩家交锋判定） */
function resolveCellEffect(
  state: EngineState,
  p: EnginePlayer,
  cell: NonNullable<ReturnType<typeof getCell>>,
  cellType: NonNullable<ReturnType<typeof cellTypeOf>>,
): PendingChoice | undefined {
  // 「不自动结算」的格子 → 交给可选动作（玩家选完再进来）。
  //
  // ⚠️ 但**只有真正有选择的人**才该被推迟。早先无条件 `return undefined`，
  // 结果没有该能力的玩家（如银行家）停在收入格时既没自动结算、
  // 也没有任何选项可点，格子效果就此丢失（实测：金钱完全不涨）。
  // 所以这里要确认玩家确实拿得到选项。
  if (cellType.autoCellEffect === false && hasCellChoice(state, p, cell.cellType)) {
    pushLog(state, p.id, `停在 ${cellLabel(cell)}（${cellType.cellType}）：等待选择`);
    return undefined;
  }

  pushLog(state, p.id, `停在 ${cellLabel(cell)}（${cellType.cellType}）`);

  // 建筑自身效果
  switch (cell.cellType) {    case 'Income': {
      const gain = p.res.income * 2;
      addRes(p, 'money', gain);
      pushLog(state, p.id, `停留收入格：双倍收入 +${gain} 金钱`);
      break;
    }
    case 'Bribe': {
      if (state.mayorId === p.id) break;
      const amount = bribeAmount(state, p) * 2;
      const paid = Math.min(p.res.money, amount);
      addRes(p, 'money', -paid);
      if (paid < amount) {
        addRes(p, 'malice', 1);
        pushLog(state, p.id, `停留贿赂格：双倍贿赂 ${paid} 金钱（不足 ${amount - paid}），+1 罪恶`);
      } else {
        pushLog(state, p.id, `停留贿赂格：双倍贿赂 ${paid} 金钱`);
      }
      break;
    }
    case 'Misfortune': {
      if (p.flags['ignoreCell']) break;
      // 「停止」：用 <=2 点卡移动时可停在厄运格且不触发
      if (p.flags['skipMisfortuneThisMove'] === 1) {
        pushLog(state, p.id, '角色能力「停止」：停在厄运格但不触发厄运');
        break;
      }
      drawMisfortuneFor(state, p);
      break;
    }
    case 'Jail': {
      if (!p.inJail) {
        p.inJail = true;
        if (p.term <= 0) p.term = 3;
        pushLog(state, p.id, `进入监狱，刑期 ${p.term}`);
      } else {
        pushLog(state, p.id, `在监狱中服刑（剩余 ${p.term}）`);
      }
      break;
    }
    case 'Police': {
      if (p.flags['ignoreCell']) break;
      if (state.mayorId === p.id) {
        pushLog(state, p.id, '镇长经过警察格无需掷骰');
        break;
      }
      // 原版：警察格是**二选一** ——
      //   「Whenever you stop on the Police spot, you must either roll the dice
      //     - or pay ~ to avoid the risk of getting arrested.」
      // 若付不起贿赂，则只剩掷骰一条路（不给无意义的选项）。
      const cost = policeBribe(state, p);
      const canPay = cost > 0 && p.res.money >= cost;
      if (!canPay) {
        const dice = rollDice(state);
        state.lastRoll = dice;
        pushLog(state, p.id,
          `警察格：付不起贿赂（需 ${cost} 金钱）→ 只能掷骰 ${dice}${dice === 1 ? ' —— 被逮捕！' : ' —— 安全'}`);
        if (dice === 1) arrest(state, p, '警察格掷出 1');
        break;
      }
      // 挂起让玩家选；答案由 resolvePending 里的 `police:` 分支处理
      state.pendingInput = { ...(state.pendingInput ?? {}), [`police:${p.id}`]: String(cost) };
      pushLog(state, p.id, `警察格：可掷骰赌运气，或付 ${cost} 金钱贿赂免于被捕`);
      return {
        kind: `police:${p.id}`,
        playerId: p.id,
        prompt: `警察格：掷骰赌运气，还是付 ${cost} 金钱贿赂？`,
        options: [
          { value: 'pay', label: `付 ${cost} 金钱贿赂（安全，但可能被永久卡拦下）` },
          { value: 'roll', label: '掷骰子（掷出 1 则被捕）' },
        ],
        min: 1,
        max: 1,
        resume: { actions: [], index: 0, targets: [p.id], source: '警察格', ownerId: p.id },
      };
    }
    case 'Danger': {
      // 冒险格（Danger）：强制弹窗——买保险？然后掷骰，
      // 扔到 1 时：有保险 → 选对手抽厄运；无保险 → 自己抽厄运。
      // OptionalFlag=false，落地即触发（不走可选动作）。
      if (p.flags['ignoreCell']) break;
      // ⚠️ 必须走 insuranceCost()：收藏家有「财产保险」时是 10，否则 40。
      // 早先这里硬编码 `cellType.params[0] ?? 40`，导致收藏家落地仍被收 40
      // （`options.ts` 的可选动作路径算对了，两处算法不一致）。
      const cost = insuranceCost(p);
      const canPay = p.res.money >= cost;
      pushLog(state, p.id, `冒险格：可花 ${cost} 金钱买保险`);
      state.pendingInput = { ...(state.pendingInput ?? {}), [`danger:${p.id}`]: String(cost) };
      return {
        kind: `danger:${p.id}`,
        playerId: p.id,
        prompt: `冒险格：是否花 ${cost} 金钱买保险？（掷到 1 时有保险可转嫁厄运给对手）`,
        options: [
          { value: 'insure', label: canPay ? `买保险（${cost} 金钱）` : `买保险（需 ${cost} 金钱，不足）` },
          { value: 'skip', label: '不买保险' },
        ],
        min: 1,
        max: 1,
        resume: { actions: [], index: 0, targets: [p.id], source: '冒险格', ownerId: p.id },
      };
    }
    case 'Risk': {
      // 风险格（赌博站）：OptionalFlag=true，可选掷骰，不在落地时自动掷
      break;
    }
    case 'Treasure': {
      // 藏宝阁：OptionalFlag=false → 停留时自动掷骰
      if (p.flags['ignoreCell']) break;
      const table = diceTableOf('Treasure');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const outcome = table[dice];
      const parts: string[] = [];
      if (outcome?.gain) {
        for (const [k, v] of Object.entries(outcome.gain)) {
          if (!v) continue;
          addRes(p, k as 'score' | 'vote' | 'malice' | 'money' | 'income', v);
          parts.push(`${v > 0 ? '+' : ''}${v} ${k}`);
        }
      }
      pushLog(state, p.id, `藏宝阁：掷出 ${dice} → ${parts.join('，') || '无事发生'}`);
      break;
    }
    // Tribune（演讲格）是 OptionalFlag=true，只有可选动作给选票，不停留不自动给
    // 地狱：OptionalFlag=false，停留时自动扣 100 金钱抽 1 张牌
    case 'Inferno': {
      // 地狱格：**弃掉全部手牌**，然后 +{1}$ / +{2}^。
      //
      // 权威文案（`English.txt`，DescriptionID 16771329641746116856）：
      //   "Discard your hand. +{1}$, +{2}^."
      // 中文包同样只保留了第一句「丢弃手牌。」
      // `params = [100, 1]` → +100 金钱、+1 罪恶（是**获得**，不是支付）。
      //
      // ⚠️ 早先这里实现成"付 100 金钱抽 1 张牌"，与数据完全相反
      // （用户报：地狱的效果应该是弃掉所有手牌再抽满）。
      const gainMoney = cellType.params[0] ?? 100;
      const gainMalice = cellType.params[1] ?? 1;
      const discarded = p.hand.length;
      for (const id of p.hand) state.discard.push(id);
      p.hand = [];
      addRes(p, 'money', gainMoney);
      addRes(p, 'malice', gainMalice);
      // 手牌补满（原版手牌恒为 HAND_SIZE，弃光后立刻重抽）
      let drawn = 0;
      while (p.hand.length < HAND_SIZE) {
        const before = p.hand.length;
        drawTo(state, p, 1);
        if (p.hand.length === before) break;
        drawn++;
      }
      pushLog(state, p.id,
        `地狱：弃掉 ${discarded} 张手牌，重抽 ${drawn} 张，+${gainMoney} 金钱、+${gainMalice} 罪恶`);
      break;
    }
    default:
      break;
  }

  // 到达地点触发的永久卡效果。
  // 注意作用域差异：赌场是"任意玩家（含自己）"，垃圾场也是"任意玩家"，
  // 而藏宝阁/工厂/银行只是"持卡者自己进"。
  switch (cell.cellType) {
    case 'Casino': {
      fireTrigger(state, 'anyVisitCasino', { actorId: p.id, cellId: cell.id });
      fireTrigger(state, 'otherVisitCasino', { actorId: p.id, cellId: cell.id });
      break;
    }
    case 'Junkyard': {
      fireTrigger(state, 'anyVisitJunkyard', { actorId: p.id, cellId: cell.id });
      break;
    }
    case 'Treasure': {
      fireTrigger(state, 'visitTreasure', { actorId: p.id, cellId: cell.id });
      break;
    }
    case 'Plant': {
      fireTrigger(state, 'visitPlant', { actorId: p.id, cellId: cell.id });
      break;
    }
    case 'Bank': {
      fireTrigger(state, 'visitBank', { actorId: p.id, cellId: cell.id });
      break;
    }
    case 'Risk': {
      fireTrigger(state, 'gambleSpot', { actorId: p.id, cellId: cell.id });
      break;
    }
    default:
      break;
  }

  // 角色落地被动
  triggerCharVisitAbility(state, p, cell);
}

// ---------------------------------------------------------------- 玩家交锋
/**
 * 玩家交锋（Player Conflict）——**本质是一次两方拍卖**。
 *
 * 原版规则（来自游戏内说明与 DLL 的 `ComConflictWindow` 协议字段）：
 *  - 触发：两位玩家停留在同一**非建筑**站点
 *  - 结算：每位玩家出价（`ComConflictWindow.MaxResultValue` 是出价上限，
 *    `Answer.Result` 回传出价）→ **出价最高者付款并留在该站点，另一位被逮捕**
 *  - 平局：`^`（罪恶）最少者获胜
 *  - 统计：`ConflictTotal / ConflictInit / ConflictWon / ConflictPaid`
 *
 * 挂起后用 `PendingChoice(kind='conflict:<challengerId>:<defenderId>')` 逐个收价。
 */
export function startConflict(state: EngineState, challenger: EnginePlayer, defender: EnginePlayer): void {
  const kind = `conflict:${challenger.id}:${defender.id}`;

  // 「特务·摇尾巴」：引发方可选择付 {1}% 的钱逃到中心厄运站，从而避免交锋。
  // 原文限制：「如当前并非轮到你走牌，则此站点规则对你无效」——所以只有
  // 引发交锋的一方（轮到自己走牌的人）能用；且目标格必须没人。
  const esc = escapeOption(state, challenger);
  if (esc) {
    pushLog(state, challenger.id,
      `玩家交锋在即（${challenger.name} vs ${defender.name}）——可选择「摇尾巴」逃避`);
    state.pending = {
      kind: `${kind}:escape`,
      playerId: challenger.id,
      prompt: `玩家交锋！是否付 ${esc.cost} 金钱（${esc.pct}% 的钱）逃到中心厄运站？`,
      options: [
        { value: 'fight', label: '应战（进入出价）' },
        { value: 'escape', label: `逃避：付 ${esc.cost} 金钱并传送到厄运站` },
      ],
      min: 1,
      max: 1,
      resume: {
        actions: [],
        index: 0,
        targets: [challenger.id, defender.id],
        source: '玩家交锋',
        ownerId: challenger.id,
        scratch: { conflictChallenger: challenger.id, conflictDefender: defender.id },
      },
    };
    return;
  }

  enterConflictBidding(state, challenger, defender);
}

/**
 * 是否可用「摇尾巴」逃避交锋。
 *
 * @returns 需付金额与百分比；不可用时返回 undefined
 */
function escapeOption(
  state: EngineState,
  challenger: EnginePlayer,
): { cost: number; pct: number; destId: string } | undefined {
  if (challenger.res.money <= 0) return undefined;
  const flags: Record<string, string | number | boolean> = {};
  const fired = fireAbility(state, challenger.id, 'beforeConflict', { flags });
  if (!fired || typeof flags.escapeConflictPct !== 'number') return undefined;

  const dest = centralMisfortuneId(getMap(state));
  if (!dest) return undefined;
  // 「除非该站点已被占据」
  if (state.players.some((p) => p.id !== challenger.id && p.cellId === dest)) return undefined;

  const pct = flags.escapeConflictPct;
  const cost = Math.floor((challenger.res.money * pct) / 100);
  return { cost, pct, destId: dest };
}

/** 进入出价阶段（先问挑战者） */
function enterConflictBidding(
  state: EngineState,
  challenger: EnginePlayer,
  defender: EnginePlayer,
): void {
  const kind = `conflict:${challenger.id}:${defender.id}`;
  pushLog(state, challenger.id,
    `玩家交锋！${challenger.name} vs ${defender.name} —— 每位玩家出价，出价最高者留下，另一位被逮捕`);
  state.pending = {
    kind,
    playerId: challenger.id,
    prompt: `玩家交锋：与 ${defender.name} 竞价（出价上限 ${conflictBidMax(challenger)}）`,
    options: bidOptions(conflictBidMax(challenger)),
    min: 1,
    max: 1,
    resume: {
      actions: [],
      index: 0,
      targets: [challenger.id, defender.id],
      source: '玩家交锋',
      ownerId: challenger.id,
      scratch: { conflictChallenger: challenger.id, conflictDefender: defender.id },
    },
  };
}

/**
 * 处理「摇尾巴」的选择。
 *
 * @returns 是否已逃避（true 表示交锋取消）
 */
export function applyConflictEscape(
  state: EngineState,
  challenger: EnginePlayer,
  defender: EnginePlayer,
): boolean {
  const esc = escapeOption(state, challenger);
  const dest = esc?.destId ?? centralMisfortuneId(getMap(state));
  const pct = esc?.pct ?? 50;
  const cost = esc?.cost ?? Math.floor((challenger.res.money * pct) / 100);

  addRes(challenger, 'money', -cost);
  if (dest) challenger.cellId = dest;
  pushLog(state, challenger.id,
    `「摇尾巴」：付 ${cost} 金钱（${pct}%），传送到中心厄运站，避开与 ${defender.name} 的交锋`);
  return true;
}

/**
 * 出价选项。
 *
 * 原版是**数值输入**（`MaxResultValue` 为上限），这里用几档常见金额 + 全押，
 * 上限为出价者的金钱；引擎按数值结算，因此调用方也可以直接传任意金额。
 */
export function conflictBidMax(p: EnginePlayer): number {
  // 上限是**出价者自己**的金钱：原版 MaxResultValue 由服务端算（本产物内无组装点），
  // 但“不能出超过自己持有的钱”是必然的，否则可以喊出付不起的价。
  return Math.max(0, Math.floor(p.res.money));
}

function bidOptions(max: number): Array<{ value: string; label: string }> {
  const opts: Array<{ value: string; label: string }> = [{ value: '0', label: '不出价（0）' }];
  for (const v of [10, 20, 30, 50, 75, 100, 150, 200]) {
    if (v <= max) opts.push({ value: String(v), label: `出价 ${v} 金钱` });
  }
  if (max > 0 && !opts.some((o) => Number(o.value) === max)) {
    opts.push({ value: String(max), label: `出价 ${max} 金钱（全押）` });
  }
  return opts;
}

/**
 * 收齐双方出价并结算交锋。
 *
 * @returns 结算结果（给 `resolvePending` 用）
 */
export function resolveConflictBid(
  state: EngineState,
  pendingKind: string,
  playerId: string,
  bid: number,
): { ok: boolean; pending?: PendingChoice } {
  const parts = pendingKind.split(':');
  const challenger = getPlayer(state, parts[1]);
  const defender = getPlayer(state, parts[2]);
  if (!challenger || !defender) return { ok: false };

  const key = pendingKind;
  state.pendingInput ??= {};
  const store = state.pendingInput;
  // 出价必须落在 [0, 出价者自己的金钱] 区间内。
  // 原版由服务端给出上限（MaxResultValue），客户端 OnSetClick 校验
  // `0 <= num <= maxResValue` 后才回传，服务端另有校验（本产物内不可见）。
  // 这里做同样的夹取，避免喊出付不起的价 —— 否则“高者付款”会退化成
  // “高者只付一点点钱却赢下交锋”。
  const bidder = getPlayer(state, playerId);
  const capped = Math.min(
    Math.max(0, Math.floor(bid)),
    bidder ? conflictBidMax(bidder) : Math.max(0, Math.floor(bid)),
  );
  store[`${key}:${playerId}`] = String(capped);

  // 还差一方 → 问另一位
  const other = playerId === challenger.id ? defender : challenger;
  if (!store[`${key}:${other.id}`]) {
    state.pending = {
      kind: pendingKind,
      playerId: other.id,
      prompt: `玩家交锋：与 ${playerId === challenger.id ? challenger.name : defender.name} 竞价（出价上限 ${conflictBidMax(other)}）`,
      options: bidOptions(conflictBidMax(other)),
      min: 1,
      max: 1,
      resume: {
        actions: [],
        index: 0,
        targets: [challenger.id, defender.id],
        source: '玩家交锋',
        ownerId: challenger.id,
        scratch: { conflictChallenger: challenger.id, conflictDefender: defender.id },
      },
    };
    return { ok: true, pending: state.pending };
  }

  // 双方出价齐了 → 结算
  const bidA = Number(store[`${key}:${challenger.id}`] ?? 0);
  const bidB = Number(store[`${key}:${defender.id}`] ?? 0);
  const pending = settleConflict(state, challenger, defender, bidA, bidB);
  delete store[`${key}:${challenger.id}`];
  delete store[`${key}:${defender.id}`];
  // 赢家手里有 `[i]` 卡时会挂起让他选择（a070 / a099）
  return pending ? { ok: true, pending } : { ok: true };
}

/** 结算：高者付款留下，低者被逮捕；平局比罪恶（少者胜）。 */
/**
 * 判定交锋胜负。
 *
 * 原版规则：出价高者胜；**平局时罪恶较少者胜**（这条是交锋专属，
 * 与选举的"罪恶最低者得票"是两套独立规则，不要互相外推）。
 *
 * 只做判定，**不产生副作用**——这样调用方可以在"扣款前后插入玩家选择"，
 * 用于卡牌的 `[i]`（留在手中、交锋时触发）效果。
 */
function decideConflict(
  challenger: EnginePlayer,
  defender: EnginePlayer,
  bidA: number,
  bidB: number,
): { winner: EnginePlayer; loser: EnginePlayer; winningBid: number; tie: boolean } {
  if (bidA === bidB) {
    // 平局：罪恶最少者获胜
    const winner = challenger.res.malice <= defender.res.malice ? challenger : defender;
    const loser = winner.id === challenger.id ? defender : challenger;
    return { winner, loser, winningBid: bidA, tie: true };
  }
  if (bidA > bidB) return { winner: challenger, loser: defender, winningBid: bidA, tie: false };
  return { winner: defender, loser: challenger, winningBid: bidB, tie: false };
}

/** 某个玩家手里是否有带 `[i]`（交锋时可用）的卡；返回第一张 */
function findConflictHandCard(p: EnginePlayer): string | undefined {
  return p.hand.find((id) => CARD_BY_ID[id]?.handText);
}

/** 挂起 kind：交锋结算前，赢家可以打出手中的 `[i]` 卡 */
export const CONFLICT_CARD_KIND = 'conflictCard';

/**
 * 结算交锋（判定 → 赢家付款 → 统计 → 钩子 → 输家被捕）。
 *
 * @param allowHandCard 赢家若持有 `[i]` 卡，是否先挂起让他选择
 * @returns 需要玩家决策时返回挂起项
 */
function settleConflict(
  state: EngineState,
  challenger: EnginePlayer,
  defender: EnginePlayer,
  bidA: number,
  bidB: number,
): PendingChoice | undefined {
  const { winner, loser, winningBid, tie } = decideConflict(challenger, defender, bidA, bidB);

  if (tie) {
    pushLog(state, winner.id,
      `交锋平局（各出价 ${bidA}）→ ${winner.name} 罪恶较少（${winner.res.malice} vs ${loser.res.malice}），获胜`);
  }

  // 赢家手里有 `[i]` 卡（a070「敲诈！」/ a099「保险政策」）→ 先让他选
  const handCardId = findConflictHandCard(winner);
  if (handCardId) {
    const card = CARD_BY_ID[handCardId]!;
    const pending: PendingChoice = {
      kind: CONFLICT_CARD_KIND,
      playerId: winner.id,
      prompt: `交锋获胜——可用手中的「${card.text.name}」（${card.handText}），或正常付款`,
      options: [
        { value: 'use', label: `打出「${card.text.name}」：${card.handText}` },
        { value: 'decline', label: `不用，正常支付 ${Math.min(winner.res.money, winningBid)} 金钱` },
      ],
      min: 1,
      max: 1,
      resume: { actions: [], index: 0, targets: [winner.id], source: '交锋用牌', ownerId: winner.id },
    };
    state.pending = pending;
    state.pendingInput = {
      ...(state.pendingInput ?? {}),
      [CONFLICT_CARD_KIND]: JSON.stringify({
        winnerId: winner.id, loserId: loser.id, winningBid, cardId: handCardId,
        challengerId: challenger.id,
      }),
    };
    pushLog(state, winner.id, `${winner.name} 赢下交锋，可选择打出「${card.text.name}」`);
    return pending;
  }

  // 交锋了结 → 补做格子效果；若它又挂起（买保险/付贿赂），把挂起交出去
  return applyConflictOutcome(state, winner, loser, winningBid, undefined, challenger.id);
}

/**
 * 应用交锋结果（扣款、统计、钩子、逮捕）。
 *
 * @param usedCardId 赢家打出的 `[i]` 卡；`undefined` 表示正常付款
 * @param challengerId 引发交锋的一方（用于 `conflictInit` 统计）
 */
function applyConflictOutcome(
  state: EngineState,
  winner: EnginePlayer,
  loser: EnginePlayer,
  winningBid: number,
  usedCardId: string | undefined,
  challengerId: string,
): PendingChoice | undefined {
  let paid = 0;
  let usedCardName = '';
  /** a070 的位移：必须等逮捕之后再放（逮捕会把输家送进监狱格） */
  const displaceAfterArrest = new Map<string, string>();

  if (usedCardId) {
    const card = CARD_BY_ID[usedCardId];
    usedCardName = card?.text.name ?? usedCardId;
    // 卡牌先离手（进弃牌堆）
    const i = winner.hand.indexOf(usedCardId);
    if (i >= 0) winner.hand.splice(i, 1);
    state.discard.push(usedCardId);

    if (usedCardId === CARD_BY_NAME['a099']?.id) {
      // a099「保险政策」：**胜出时改为弃掉此卡，不付钱**
      pushLog(state, winner.id, `打出「${usedCardName}」：赢下交锋但**不支付**出价（省下 ${Math.min(winner.res.money, winningBid)} 金钱）`);
    } else if (usedCardId === CARD_BY_NAME['a070']?.id) {
      // a070「敲诈！」：把对手挪到离自己一格的位置，且**对手付你 50$**。
      // 注意：这张卡**不免付**——出价照付，它只是额外敲诈 + 位移。
      const amount = CARD_BY_ID[usedCardId]?.params?.[0] ?? 50;
      const o = winner.res.money;
      const moved = transferRes(loser, winner, 'money', amount);
      pushLog(state, winner.id,
        `打出「${usedCardName}」：${loser.name} 付给你 ${moved.moved} 金钱（${o} → ${winner.res.money}）`);

      // 出价照付
      paid = Math.min(winner.res.money, winningBid);
      if (paid > 0) addRes(winner, 'money', -paid);
      pushLog(state, winner.id, `仍须支付出价 ${paid} 金钱`);

      // ⚠️ 位移要**记下来、等逮捕之后再放**：`arrest()` 会把输家传送到监狱格，
      // 若在这里直接改 cellId，随后就被监狱格覆盖掉了。
      const here = getCell(state, winner.cellId);
      const dest = (here?.out ?? []).find((id) => id !== loser.cellId && !!getCell(state, id));
      if (dest) {
        displaceAfterArrest.set(loser.id, dest);
        pushLog(state, winner.id,
          `${loser.name} 将被挪到相邻的 ${cellLabel(getCell(state, dest))}`);
      }
    } else {
      // 其它 `[i]` 卡（未来新增）：保守起见仍照常付款
      const p = Math.min(winner.res.money, winningBid);
      if (p > 0) addRes(winner, 'money', -p);
      paid = p;
      pushLog(state, winner.id, `打出「${usedCardName}」但规则未实现，仍支付 ${p} 金钱`);
    }
  } else {
    // 正常：赢家付掉自己的出价（钱给银行，不是给对手）
    paid = Math.min(winner.res.money, winningBid);
    if (paid > 0) addRes(winner, 'money', -paid);
  }

  // 统计
  for (const p of [loser, winner]) p.conflictTotal += 1;
  // `conflictInit` 只给**引发交锋**的一方（落地撞上对手的那位）
  const challenger = getPlayer(state, challengerId);
  if (challenger) challenger.conflictInit += 1;
  winner.conflictWon += 1;
  winner.conflictPaid += paid;

  pushLog(state, winner.id,
    `${winner.name} 赢下交锋，留在原地；${loser.name} 被逮捕`);

  // 永久卡钩子：参与的持卡者 +N；输家的持卡者效果
  fireTrigger(state, 'playerConflict', { actorId: winner.id });
  fireTrigger(state, 'loseConflict', { actorId: loser.id });

  arrest(state, loser, `玩家交锋输给 ${winner.name}`);

  // a070 的位移在逮捕之后生效（否则会被 arrest() 的"送进监狱格"覆盖）
  const dest = displaceAfterArrest.get(loser.id);
  if (dest) {
    loser.cellId = dest;
    pushLog(state, winner.id, `${loser.name} 被挪到相邻的 ${cellLabel(getCell(state, dest))}`);
  }

  // 交锋已了结 → 补做发起者"欠着"的格子效果（顺序：先交锋、后格子）
  return resumePendingCellEffect(state);
}

/**
 * 处理「交锋胜出时打出手中的 `[i]` 卡」的选择。
 */
export function resolveConflictCard(
  state: EngineState,
  playerId: string,
  answer: string,
): { ok: boolean; reason?: string; pending?: PendingChoice } {
  const raw = state.pendingInput?.[CONFLICT_CARD_KIND];
  delete state.pendingInput?.[CONFLICT_CARD_KIND];
  state.pending = undefined;
  if (!raw) return { ok: false, reason: '没有待处理的交锋用牌' };

  const info = JSON.parse(raw) as {
    winnerId: string; loserId: string; winningBid: number; cardId: string; challengerId: string;
  };
  if (info.winnerId !== playerId) return { ok: false, reason: '不是你的决策' };

  const winner = getPlayer(state, info.winnerId);
  const loser = getPlayer(state, info.loserId);
  if (!winner || !loser) return { ok: false, reason: '交锋双方不存在' };

  const use = answer === 'use';
  const after = applyConflictOutcome(state, winner, loser, info.winningBid,
    use ? info.cardId : undefined, info.challengerId ?? info.winnerId);
  return after ? { ok: true, pending: after } : { ok: true };
}

function drawMisfortuneFor(state: EngineState, p: EnginePlayer): void {
  drawMisfortune(state, p);
}

/**
 * 警察格要付的贿赂。
 *
 * 原版文案只说 "pay ~"（贿赂），没有说双倍——双倍只出现在**停留贿赂格**。
 * 所以警察格用**单倍**贿赂值（`$20 + 罪恶`，受角色修正影响）。
 */
function policeBribe(state: EngineState, p: EnginePlayer): number {
  return bribeAmount(state, p);
}

/** 贿赂金额：原版为 20 + 罪恶值，叠加永久卡加成与角色能力修正 */


// ---------------------------------------------------------------- 服刑回合
/**
 * 服刑回合流程。
 *
 * 原版入狱不是纯惩罚：每个服刑回合会抽一张监狱卡（`GJailCard`）并按 `Rank`/`Karma`
 * 结算，可能减刑、获得收入、掷骰出狱，也可能加刑。刑期走到 0 即出狱。
 *
 * 本实现按 jail card 的 `actions` 驱动；牌堆耗尽时用 ID 重洗。
 */
/** 本回合抽出的监狱牌候选（挂起期间暂存） */
export interface JailCandidate {
  cardId: string;
  name: string;
  description: string;
  /** 英文原文，中文缺失时用于回退显示 */
  enName?: string;
  enDescription?: string;
  /** 卡牌参数，用于替换文案里的 {n} */
  params?: number[];
}

/** 挂起项的 kind：等待玩家从监狱牌候选中选一张 */
export const JAIL_PICK_KIND = 'jailPick';

/**
 * 服刑一回合。
 *
 * 原版流程（`GGame.JailPickCard` + `GPlayer.GetJailCardLimit` + `GJailCard.Rank/Karma`）：
 *  1. 本回合先从牌堆抽出 `GetJailCardLimit()`（2/2/3/3/4）张**候选**；
 *  2. 玩家从中选一张结算；
 *  3. 无论选哪张，本回合都算服完一次：刑期 −1、监狱经验 +1。
 *
 * 卡池受 `Rank`（达到该监狱等级才解锁）与 `Karma`（监狱表现）约束；
 * 通关方式是把当回合所有候选牌都拒绝（`jailDecline`）。
 *
 * 本函数只负责第 1 步 + 挂起；结算在 `resolveJailPick`。
 * 若只抽到单张候选，则不挂起、直接结算（省一次交互）。
 */
export function takeJailTurn(
  state: EngineState,
  playerId: string,
): { ok: boolean; reason?: string; pending?: PendingChoice } {
  const p = getPlayer(state, playerId);
  if (!p) return { ok: false, reason: '玩家不存在' };
  if (!p.inJail) return { ok: false, reason: '该玩家不在狱中' };
  if (state.pending) return { ok: false, reason: '有未完成的决策' };

  const candidates = drawJailCandidates(state, p);
  if (!candidates.length) {
    // 牌堆异常时兜底：直接推进刑期
    pushLog(state, p.id, '服刑：没有可选的监狱牌');
    advanceJailTerm(state, p);
    endTurn(state);
    return { ok: true };
  }

  if (candidates.length === 1) {
    return resolveJailPick(state, playerId, candidates[0].cardId);
  }

  const pending: PendingChoice = {
    kind: JAIL_PICK_KIND,
    playerId: p.id,
    prompt: `服刑（等级 ${p.jailRank}·${JAIL_RANK_NAMES[p.jailRank]}）：`
      + `从 ${candidates.length} 张监狱牌中选一张，或全部拒绝`,
    options: [
      ...candidates.map((c) => ({
        value: c.cardId,
        // 用显示层：替换 `{n}`、清控制符、中文缺失时回退英文。
        // 直接用 `c.description` 会显示成「丢弃{1}张卡牌。」这种带占位符的文案。
        label: `${displayCardName(c)}——${displayCardRules(c)}`,
      })),
      { value: 'jailDecline', label: '全部拒绝（刑期 −1，+1 罪恶）' },
    ],
    min: 1,
    max: 1,
    resume: { actions: [], index: 0, targets: [p.id], source: '监狱服刑', ownerId: p.id },
  };
  state.pending = pending;
  state.pendingInput = {
    ...(state.pendingInput ?? {}),
    [JAIL_PICK_KIND]: JSON.stringify(candidates),
  };
  pushLog(state, p.id,
    `服刑：可选的监狱牌 ${candidates.map((c) => `「${c.name}」`).join('')}`);
  return { ok: true, pending };
}

/**
 * 抽出本回合的监狱牌候选。
 *
 * 卡池受两级约束（原版 `GJailCard.Rank` / `Karma`）：
 *  - `Rank` 是**解锁等级**：`rank <= JailRank` 才能出现
 *  - `Karma` 是**监狱表现**：`-1` 消极 / `0` 中性 / `+1` 积极；
 *    本回合表现等于 `p.jailKarma` 的牌才进池
 *
 * 同名卡按 `deckCount` 重复出现（牌堆按 DeckCount 构造）。
 */
function drawJailCandidates(state: EngineState, p: EnginePlayer): JailCandidate[] {
  if (state.jailDeck.length === 0) {
    // 重洗：按 DeckCount 重复放入
    state.jailDeck = [];
    for (const c of JAIL_CARDS) {
      for (let i = 0; i < Math.max(1, c.deckCount); i++) state.jailDeck.push(c.id);
    }
  }
  const want = jailCardLimit(p.jailRank);
  const out: JailCandidate[] = [];
  const skipped: string[] = [];

  // 从牌堆尾部依次取，取到 want 张"符合条件"的为止
  let guard = 0;
  while (out.length < want && state.jailDeck.length > 0 && guard++ < 200) {
    const id = state.jailDeck.pop()!;
    const c = JAIL_CARDS.find((x) => x.id === id);
    if (!c) continue;
    // Rank 是解锁等级；Karma 是本回合表现（默认 0=中性）
    const karma = p.jailKarma ?? 0;
    if ((c.rank ?? 1) > p.jailRank + 1 || (c.karma ?? 0) !== karma) {
      skipped.push(id);   // 本轮不适用，之后重洗会再轮到
      continue;
    }
    out.push({
        cardId: c.id, name: c.text.name, description: c.text.description,
        enName: c.en?.name, enDescription: c.en?.description, params: c.params,
      });
  }
  // 不适用的牌放回牌堆（保持牌数守恒）
  state.jailDeck.unshift(...skipped);

  if (!out.length) {
    // 该表现下没有可用牌：退回"不用 Karma 过滤"再抽一轮，避免卡死
    const fallback: JailCandidate[] = [];
    let g2 = 0;
    while (fallback.length < want && state.jailDeck.length > 0 && g2++ < 200) {
      const id = state.jailDeck.pop()!;
      const c = JAIL_CARDS.find((x) => x.id === id);
      if (!c) continue;
      if ((c.rank ?? 1) > p.jailRank + 1) { state.jailDeck.unshift(id); continue; }
      fallback.push({
        cardId: c.id, name: c.text.name, description: c.text.description,
        enName: c.en?.name, enDescription: c.en?.description, params: c.params,
      });
    }
    return fallback;
  }
  return out;
}

/**
 * 结算玩家选定的监狱牌（或"全部拒绝"）。
 *
 * @param cardId 选中的监狱牌 id；`'jailDecline'` 表示全部拒绝
 */
export function resolveJailPick(
  state: EngineState,
  playerId: string,
  cardId: string,
): { ok: boolean; reason?: string; pending?: PendingChoice } {
  const p = getPlayer(state, playerId);
  if (!p) return { ok: false, reason: '玩家不存在' };

  // 挂起期间暂存的候选项用完即清
  if (state.pendingInput?.[JAIL_PICK_KIND]) delete state.pendingInput[JAIL_PICK_KIND];
  state.pending = undefined;

  if (cardId === 'jailDecline') {
    // 原版 `CellType_Jail_Decline_Final`：拒绝全部候选 → +1 罪恶、刑期 −1
    addRes(p, 'malice', 1);
    pushLog(state, p.id, '拒绝所有监狱牌：+1 罪恶，刑期 −1');
    advanceJailTerm(state, p);
    endTurn(state);
    return { ok: true };
  }

  const card = JAIL_CARDS.find((c) => c.id === cardId);
  if (!card) return { ok: false, reason: '监狱卡不存在' };

  pushLog(state, p.id, `服刑：使用监狱卡「${card.text.name}」—— ${card.text.description}`);

  // 按卡牌自身的收入/结果结算
  if (card.income) applyBundle(state, p, card.income, +1, '监狱卡收获');
  if (card.outcome) applyBundle(state, p, card.outcome, -1, '监狱卡惩罚');

  // 卡牌动作序列
  if (card.actions.length) {
    const r = runActions(state, {
      actions: card.actions,
      index: 0,
      targets: [p.id],
      ownerId: p.id,
      source: `监狱卡「${card.text.name}」`,
      sourceCardId: card.id,
    });
    if (r.status === 'pending') {
      state.pending = r.pending;
      return { ok: true, pending: r.pending };
    }
  }

  // 刑期推进 + 监狱经验（无论卡牌效果如何，本回合都已完成一次服刑）
  advanceJailTerm(state, p);
  endTurn(state);
  return { ok: true };
}

/**
 * 推进一次服刑：刑期 −1，并按原版累积**监狱经验**
 * （教程："每在狱中待一回合获得 1 点监狱经验"）。
 */
function advanceJailTerm(state: EngineState, p: EnginePlayer): void {
  if (!p.inJail) return;
  p.term = Math.max(0, p.term - 1);
  gainJailExp(state, p, 1);
  if (p.term === 0) {
    release(state, p);
  } else {
    pushLog(state, p.id,
      `服刑中，剩余刑期 ${p.term} 次走牌（等级 ${p.jailRank}`
      + `${JAIL_RANK_NAMES[p.jailRank]}，经验 ${p.jailExp}/${jailExpForRank(p.jailRank)}）`);
  }
}

/**
 * 监狱等级 0..4 的名称（原版 `JailRankDetailsPanel`）。
 * 0 新手 / 1 农民 / 2 恶棍 / 3 二把手 / 4 老大
 */
export const JAIL_RANK_NAMES = ['新手', '农民', '恶棍', '二把手', '老大'] as const;

/** 最高监狱等级（"老大"） */
export const JAIL_RANK_MAX = 4;

/**
 * 升到**下一级**所需的监狱经验。对应原版
 * `GConst.JAIL_RANK_1_TERM..JAIL_RANK_5_TERM` = 5 / 7 / 8 / 10 / 3。
 *
 * 语义来自 `GPlayer.ChangeRes` 的 `Term` 分支：
 * 经验累加到该门槛 → 扣掉门槛、`JailRank++`；
 * 已经是最高级（rank 4）时再满 → 换成 **+1 齿轮**。
 */
export function jailExpForRank(rank: number): number {
  return constNum(`JAIL_RANK_${Math.min(rank, JAIL_RANK_MAX) + 1}_TERM`, 5);
}

/**
 * 本回合可**选择**的监狱牌张数。对应原版 `GPlayer.GetJailCardLimit()`：
 * `n = 2; if (rank >= 2) n++; if (rank >= 4) n++;` → **2 / 2 / 3 / 3 / 4**
 */
export function jailCardLimit(rank: number): number {
  let n = 2;
  if (rank >= 2) n += 1;
  if (rank >= 4) n += 1;
  return n;
}

/**
 * 给玩家加监狱经验，按原版规则处理升级与"满级换齿轮"。
 *
 * @returns 本次是否升级、以及满级换到的齿轮数
 */
export function gainJailExp(
  state: EngineState,
  p: EnginePlayer,
  amount = 1,
): { rankedUp: number; scoreGained: number } {
  if (amount <= 0) return { rankedUp: 0, scoreGained: 0 };
  p.jailExp += amount;
  let rankedUp = 0;
  let scoreGained = 0;

  // 升级阶段：经验累加到门槛 → 扣门槛、rank++
  // 用循环是因为一次可能加多点，可以连升（`guard` 防意外死循环）
  let guard = 0;
  while (p.jailRank < JAIL_RANK_MAX
    && p.jailExp >= jailExpForRank(p.jailRank)
    && guard++ < 64) {
    p.jailExp -= jailExpForRank(p.jailRank);
    p.jailRank += 1;
    rankedUp += 1;
    pushLog(state, p.id,
      `监狱等级提升到 ${p.jailRank}（${JAIL_RANK_NAMES[p.jailRank]}），`
      + `下一级需 ${jailExpForRank(p.jailRank)} 点经验`);
  }

  // 满级（老大）之后：经验不再有升级去向，按门槛**折算成齿轮**。
  // 一次结算完并让经验保持在门槛以下，避免无限累积
  // （曾经的写法只 +1 而不扣经验，10 万点会滚到 99790）。
  if (p.jailRank >= JAIL_RANK_MAX) {
    const need = jailExpForRank(JAIL_RANK_MAX);
    const times = Math.floor(p.jailExp / need);
    if (times > 0) {
      p.jailExp -= times * need;
      addRes(p, 'score', times);
      scoreGained += times;
      pushLog(state, p.id,
        `监狱经验已满且为最高等级「${JAIL_RANK_NAMES[JAIL_RANK_MAX]}」：`
        + `${times * need} 点经验折算为 +${times} 齿轮`);
    }
  }
  return { rankedUp, scoreGained };
}

/** 应用资源包（sign=+1 收获 / -1 惩罚） */
function applyBundle(
  state: EngineState,
  p: EnginePlayer,
  b: { money?: number; vote?: number; malice?: number; score?: number; income?: number; term?: number },
  sign: number,
  label: string,
): void {
  const parts: string[] = [];
  for (const key of ['money', 'vote', 'malice', 'score', 'income', 'term'] as const) {
    const v = b[key];
    if (!v) continue;
    addRes(p, key, v * sign);
    parts.push(`${sign > 0 ? '+' : '-'}${Math.abs(v)} ${key}`);
  }
  if (parts.length) pushLog(state, p.id, `${label}：${parts.join('，')}`);
}

// ---------------------------------------------------------------- 回合推进
/**
 * 当前玩家是否**完全无事可做**（可以自动跳过他的回合）。
 *
 * 用户要求：走到警察格、没牌可出时不该弹「无可用动作，跳过结束回合」，
 * 应该直接进下一阶段。判据就是"没牌可打 且 没有任何站点/能力动作"。
 *
 * 与 `buildEnginePrompt` 里 UseCell 阶段返回 null 的条件一致
 * （那边是 `playableCards` 与 `availableOptions` 同时为空）。
 * 放在这里而不是 `serialize.ts`，是为了让 `endTurn` 能直接调用，
 * 同时避免 `api.ts → serialize.ts → api.ts` 的循环依赖。
 */
function hasNothingToDo(state: EngineState, p: EnginePlayer): boolean {
  if (state.pending) return false;
  // 还没走牌 → 起码还要选一张移动牌，不能跳
  if (!p.movedThisTurn) return false;
  // 还能打牌 → 有事可做
  if (p.hand.some((id) => canPlayCard(state, p, id).ok)) return false;
  // 有站点 / 建筑 / 角色能力动作 → 有事可做
  if (availableOptions(state, p.id).length > 0) return false;
  return true;
}

/** 结束当前玩家回合，交给下一位 */
export function endTurn(state: EngineState): void {
  const p = actorOf(state);
  if (p) {
    // 「商业头脑」：用过"再打一张牌"后，这一次 endTurn 只负责复位状态，
    // 让玩家/AI 能再打一张效果牌。
    // 流程：playAgain(movedThisTurn=true, optionsOffered=0)
    //   → playCard  → endTurn(这里复位) → endTurn(真正结束)
    if (p.flags['extraCardAtOffice'] === 1) {
      p.flags['extraCardAtOffice'] = 0;
      p.movedThisTurn = true;
      pushLog(state, p.id, '「商业头脑」：可再打一张牌');
      return;
    }

    // 落到有可选动作的地点时，先不结束回合——让玩家决定要不要用
    // （投资、卖选票、打工、赌博…）。AI 不等待，由 tryOption 自行消费。
    if (!p.isAI && p.movedThisTurn && !p.flags['optionsOffered']
      && availableOptions(state, p.id).length > 0) {
      p.flags['optionsOffered'] = 1;
      // 不能把 movedThisTurn 设为 false——会让 canMoveWithCard 通过，
      // 导致玩家在一回合内非法二次移动（曾导致冒险格保险弹两次）。
      // optionsOffered 标志本身已防止下次 endTurn 再停一次。
      pushLog(state, p.id, '此地可用可选动作（可直接结束回合）');
      return;
    }

    // 自己的回合结束钩子（如「自动助手」在无法打牌时允许弃 1 张）
    fireTrigger(state, 'ownTurnEnd', { actorId: p.id });
    fireAbility(state, p.id, 'turnEnd', { cellId: p.cellId });

    p.movedThisTurn = false;
    p.cardsPlayedThisTurn = 0;
    // 先读取本回合留下的标记，再清空——顺序反了会让 SkipDraw 等被动失效
    const skipDraw = p.flags['skipDraw'] === 1;
    p.flags = {};
    // 补牌（被 SkipDraw 标记或身陷监狱时跳过）
    // 原版规则：手牌始终 6 张（CARDS_ON_HAND=6），无角色差异
    if (!skipDraw && !p.inJail) {
      while (p.hand.length < HAND_SIZE) {
        const before = p.hand.length;
        drawTo(state, p, 1);
        if (p.hand.length === before) break;
      }
    }
  }

  // 轮转到下一位（跳过已结束/离线玩家）
  let guard = 0;
  do {
    state.currentIndex = (state.currentIndex + 1) % state.players.length;
    if (state.currentIndex === 0) state.round += 1;
    guard++;
  } while (state.players[state.currentIndex]?.skipTurns > 0 && guard < state.players.length * 4);

  // ── 自动跳过"完全没有可操作步骤"的玩家 ──
  //
  // 用户要求：没牌可出、也没站点动作时不该弹「无可用动作，跳过结束回合」，
  // 应直接跳过这一阶段/这一位玩家。这里顺着往下走，直到轮到一位
  // **真的有事可做**的玩家（或对局结束）。
  //
  // 每一位都要走完整的"回合开始钩子"，不能简单地把 currentIndex 往后拨 ——
  // 否则被跳过的人会漏掉 turnStart 触发（信用贷扣款、服刑津贴等）。
  // 所以用 goto 式的循环：轮转 → 跑钩子 → 检查 → 需要则再轮转。
  let autoGuard = state.players.length * 2 + 4;
  for (;;) {
    const nxt = actorOf(state);
    if (!nxt) break;

    // 新回合开始钩子（信用贷扣款、服刑津贴、角色「平民主义」等）
    fireTrigger(state, 'ownTurnStart', { actorId: nxt.id });
    fireAbility(state, nxt.id, 'turnStart', { cellId: nxt.cellId });

    if (nxt.skipTurns > 0) {
      nxt.skipTurns -= 1;
      pushLog(state, nxt.id, `跳过本次走牌（剩余 ${nxt.skipTurns}）`);
    }

    // 每轮结束钩子（「古代机构」+齿轮、「末日时钟」每 6 轮扣分等）
    if (state.currentIndex === 0) {
      fireTrigger(state, 'roundEnd', {});
      // 混沌卡已打完 → 在本轮结束处收尾（原版规则）
      finishRoundIfChaosDone(state);
    }

    // 选举检查
    if (state.round >= state.nextElectionRound) runElection(state);

    // 胜利检查
    checkVictory(state);

    // 对局结束、或被挂起的决策打断 → 停
    if (state.phase !== 'playing' || state.pending) break;

    // 这位玩家有事可做 → 就交给他
    if (!hasNothingToDo(state, nxt)) break;

    // 完全无事可做 → 记一条日志并继续轮转（跳过他的回合）
    if (autoGuard-- <= 0) break;      // 兜底：避免极端情况下的死循环
    pushLog(state, nxt.id, '无事可做，自动跳过');
    state.currentIndex = (state.currentIndex + 1) % state.players.length;
    if (state.currentIndex === 0) state.round += 1;
  }

  // 换人本身就是一次状态推进 —— 必须让进度计数前进，
  // 否则 AI 的防卡死保险会把"成功换人"误判成"什么都没变"。
  state.progress = (state.progress ?? 0) + 1;
}

export function checkVictory(state: EngineState): void {
  const winner = state.players.find((p) => p.res.score >= state.targetScore);
  if (winner) {
    state.winnerId = winner.id;
    state.phase = 'game_over';
    pushLog(state, winner.id, `${winner.name} 达到 ${state.targetScore} 齿轮，获胜！`);
    return;
  }
  // 混沌卡全部打出 → **该轮结束时**赛局结束（不是立刻）。
  // 原版："The session will end at the end of the round during which the last
  //        Chaos Card has been played."
  // 注意：不能用 api.ts 的 chaosExhausted（api → state，会形成循环依赖）。
  if (state.chaosEnabled && state.chaosPool.length === 0 && state.chaosPlayed.length > 0) {
    state.chaosEndPending = true;
  }
}

/** 一轮结束时调用：若混沌卡已打完，则按齿轮数决出胜者并结束赛局 */
export function finishRoundIfChaosDone(state: EngineState): void {
  if (!state.chaosEndPending || state.phase !== 'playing') return;
  const ranked = [...state.players].sort((a, b) => b.res.score - a.res.score);
  const top = ranked[0];
  if (!top) return;
  state.winnerId = top.id;
  state.phase = 'game_over';
  state.chaosEndPending = false;
  pushLog(state, top.id,
    `全部混沌卡已打出，本赛局结束：${top.name} 以 ${top.res.score} 齿轮获得最高分`);
}

// ---------------------------------------------------------------- 角色能力
/**
 * 抵达地点时触发的角色能力。
 * 规则来自 abilities.ts 的注册表（visitHome + cellType）。
 */
export function triggerCharVisitAbility(state: EngineState, p: EnginePlayer, cell: BoardCell): void {
  fireAbility(state, p.id, 'visitHome', { cellId: cell.id });
}

/** 掷骰时触发的角色被动（赌徒的 6/1 奖励等） */
export function triggerRollAbility(state: EngineState, p: EnginePlayer, dice: number): void {
  fireAbility(state, p.id, 'afterRoll', { dice });
}

/** 可选的起始角色（供房间随机分配用） */
export function allCharacterIds(): string[] {
  return CHARACTERS.map((c) => c.id);
}





