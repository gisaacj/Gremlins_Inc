// =============================================================
// 对局初始化与回合流程
//
// 位置：使用原版棋盘格 id；起始格来自 GCharacter.NormalCellStartID，
//       不再依赖手写的 BuildingId 表和硬编码下标。
// 顺序：使用 GCharacter.StepOrderNum（原版 Initiative）。
// =============================================================
import type {
  ActionCard, BoardCell, CardAction, EnginePlayer, EngineState, PendingChoice, ResourceKey,
} from './model.js';
import {
  ACTION_CARDS, CARD_BY_ID, CELL_TYPES, CELL_TYPE_BY_ID, CHARACTERS, CHARACTER_BY_ID,
  CHAOS_CARDS, CELL_TYPE_BY_NAME, GAME_CONST, JAIL_CARDS, MISFORTUNE_CARDS,
  NORMAL_MAP, cellLabel, cellTypeOf, characterName, getCell, getMap, getPlayer,
} from './model.js';
import {
  ELECTION_INTERVAL, arrest, discardFromHand, drawMisfortune, drawTo, random, release,
  rollDice, runActions, runElection, type ActionContext,
} from './interp.js';
import { addRes } from './resources.js';
import {
  applyImmediatePermanents, discardPermanent, extraBribeFrom, fireTrigger,
} from './permanents.js';
import { bribeModifier, fireAbility } from './abilities.js';
import { availableOptions } from './options.js';

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

/** 起手手牌数 */
export const HAND_SIZE = 6;

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

  // 原版初始资源（由角色能力与 GConst 决定）
  res.money = constNum('START_MONEY', 100);
  res.income = constNum('START_INCOME', 20);
  res.vote = constNum('START_VOTE', 0);
  res.malice = constNum('START_MALICE', 0);
  res.score = 0;
  res.term = 0;

  // 起始格：原版 NormalCellStartID 指向地图上的具体格
  const startCellId = char?.normalStartCellId && getCell(state, char.normalStartCellId)
    ? char.normalStartCellId
    : getMap(state).cells[0].id;

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
  const mapId = NORMAL_MAP.id;
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
    misfortuneDeck: MISFORTUNE_CARDS.map((c) => c.id),
    jailDeck: JAIL_CARDS.map((c) => c.id),
    mayorId: undefined,
    nextElectionRound: ELECTION_INTERVAL,
    targetScore: args.targetScore ?? 30,
    mapId,
    chaosEnabled: args.chaosEnabled !== false,
    log: [],
    rngState: seed >>> 0,
  };

  // 洗牌
  shuffleInPlace(state, deck);
  shuffleInPlace(state, state.misfortuneDeck);
  shuffleInPlace(state, state.jailDeck);

  // 玩家按原版行动顺序（StepOrderNum）排列
  const sorted = args.players.slice().sort((a, b) => {
    const oa = a.characterId ? CHARACTER_BY_ID[a.characterId]?.order ?? 99 : 99;
    const ob = b.characterId ? CHARACTER_BY_ID[b.characterId]?.order ?? 99 : 99;
    return oa - ob;
  });

  state.players = sorted.map((p, i) => buildPlayer(p, i, state));
  state.deck = deck;

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

function pushLog(state: EngineState, playerId: string, text: string): void {
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
export function canMoveWithCard(p: EnginePlayer, cardId: string): { ok: boolean; reason?: string } {
  const card = CARD_BY_ID[cardId];
  if (!card) return { ok: false, reason: '卡牌不存在' };
  if (card.move <= 0) return { ok: false, reason: '这张牌没有移动点数' };
  return canAffordCard(p, cardId);
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
export function startMove(
  state: EngineState,
  playerId: string,
  cardId: string,
  choices?: Record<string, string[]>,
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
    payCardCost(p, card);
    removeFromHand(state, p, cardId);
    p.lastMoveCardId = cardId;
    p.lastMoveSteps = card.move;
    p.movedThisTurn = true;
    p.cardsPlayedThisTurn += 1;
    state.moveCursor = { playerId, stepsLeft: card.move, path: [], cardId };
    pushLog(state, p.id, `使用「${card.text.name}」移动 ${card.move} 步`);
  }

  const cursor = state.moveCursor;
  if (!cursor) return { ok: false, reason: '没有进行中的移动' };

  // 逐步推进
  while (cursor.stepsLeft > 0) {
    const cur = getCell(state, p.cellId);
    if (!cur) break;
    const outs = cur.out.filter((id) => !!getCell(state, id));
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

  resolvePassThrough(state, p, path, mvFlags);
  if (!p.flags['ignoreCell']) resolveLanding(state, p);

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

  const ctx: ActionContext = {
    actions: card.actions,
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

  // 玩家交锋：两方逐个出价，收齐后结算（不走动作解释器）
  if (pending.kind.startsWith('conflict:')) {
    state.pending = undefined;
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

/** 经过格子的效果（收入/贿赂等） */
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
        // 镇长免付
        if (state.mayorId === p.id) break;
        // 永久卡规避（「借口生成器」50% 机率）
        const flags: Record<string, string | number | boolean> = {};
        fireTrigger(state, 'bribeSpot', { actorId: p.id, cellId, flags });
        if (flags.bribeSkipped) break;
        // 商人·动起来：用 5 点以上移动时免付
        if (mvFlags.skipBribe) break;

        const amount = bribeAmount(state, p);
        if (amount > 0) {
          const paid = Math.min(p.res.money, amount);
          addRes(p, 'money', -paid);
          const mayor = state.players.find((x) => x.id === state.mayorId);
          if (mayor) addRes(mayor, 'money', paid);
          pushLog(state, p.id, `经过贿赂格：支付 ${paid} 金钱`);
        }
        break;
      }
      case 'Misfortune': {
        // 经过厄运格：原版仅停留才结算，经过不触发
        break;
      }
      default:
        break;
    }
  }
}

/** 落点结算：站点效果 / 建筑可打牌 */
function resolveLanding(state: EngineState, p: EnginePlayer): void {
  const cell = getCell(state, p.cellId);
  if (!cell) return;
  const cellType = cellTypeOf(cell);
  if (!cellType) return;

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
      pushLog(state, p.id, `停留贿赂格：双倍贿赂 ${paid} 金钱`);
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
      const dice = rollDice(state);
      pushLog(state, p.id, `警察格掷骰 ${dice}${dice === 1 ? ' —— 被逮捕！' : ' —— 安全'}`);
      if (dice === 1) arrest(state, p, '警察格掷出 1');
      break;
    }
    case 'Risk': {
      pushLog(state, p.id, `冒险格（可购买保险，费用 ${cellType.params[1] ?? 40}）`);
      break;
    }
    case 'Tribune': {
      const votes = Math.max(1, Math.floor((cellType.params[0] || 1)));
      addRes(p, 'vote', votes);
      pushLog(state, p.id, `演讲格：+${votes} 选票`);
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

  // 玩家交锋：两位玩家停留在同一站点时引发（**建筑除外**，建筑可容纳任意人数）。
  // 原版文案：「当两位玩家停留在同一站点时，就会引发玩家交锋（建筑除外）」。
  if (!cellType.building) {
    const rival = state.players.find((x) => x.id !== p.id && x.cellId === cell.id);
    if (rival) startConflict(state, p, rival);
  }
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
  pushLog(state, challenger.id,
    `玩家交锋！${challenger.name} vs ${defender.name} —— 每位玩家出价，出价最高者留下，另一位被逮捕`);
  state.pending = {
    kind,
    playerId: challenger.id,
    prompt: `玩家交锋：与 ${defender.name} 竞价（出价上限 ${challenger.res.money}）`,
    options: bidOptions(challenger.res.money),
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
 * 出价选项。
 *
 * 原版是**数值输入**（`MaxResultValue` 为上限），这里用几档常见金额 + 全押，
 * 上限为出价者的金钱；引擎按数值结算，因此调用方也可以直接传任意金额。
 */
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
  store[`${key}:${playerId}`] = String(Math.max(0, Math.floor(bid)));

  // 还差一方 → 问另一位
  const other = playerId === challenger.id ? defender : challenger;
  if (!store[`${key}:${other.id}`]) {
    state.pending = {
      kind: pendingKind,
      playerId: other.id,
      prompt: `玩家交锋：与 ${playerId === challenger.id ? challenger.name : defender.name} 竞价（出价上限 ${other.res.money}）`,
      options: bidOptions(other.res.money),
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
  settleConflict(state, challenger, defender, bidA, bidB, playerId === challenger.id ? defender.id : challenger.id);
  delete store[`${key}:${challenger.id}`];
  delete store[`${key}:${defender.id}`];
  return { ok: true };
}

/** 结算：高者付款留下，低者被逮捕；平局比罪恶（少者胜）。 */
function settleConflict(
  state: EngineState,
  challenger: EnginePlayer,
  defender: EnginePlayer,
  bidA: number,
  bidB: number,
  lastBidderId: string,
): void {
  // 平局：罪恶最少者获胜
  let winner: EnginePlayer;
  let loser: EnginePlayer;
  let winningBid: number;
  if (bidA === bidB) {
    winner = challenger.res.malice <= defender.res.malice ? challenger : defender;
    loser = winner.id === challenger.id ? defender : challenger;
    winningBid = bidA;
    pushLog(state, winner.id,
      `交锋平局（各出价 ${bidA}）→ ${winner.name} 罪恶较少（${winner.res.malice} vs ${loser.res.malice}），获胜`);
  } else if (bidA > bidB) {
    winner = challenger; loser = defender; winningBid = bidA;
  } else {
    winner = defender; loser = challenger; winningBid = bidB;
  }

  // 赢家付掉自己的出价（钱给银行，不是给对手）
  const paid = Math.min(winner.res.money, winningBid);
  if (paid > 0) addRes(winner, 'money', -paid);

  // 统计
  for (const p of [challenger, defender]) p.conflictTotal += 1;
  challenger.conflictInit += 1; // 由挑战者落地引发
  winner.conflictWon += 1;
  winner.conflictPaid += paid;

  pushLog(state, winner.id,
    `${winner.name} 以 ${paid} 金钱赢下交锋，留在原地；${loser.name} 被逮捕`);

  // 永久卡钩子：参与的持卡者 +N；输家的持卡者效果
  fireTrigger(state, 'playerConflict', { actorId: winner.id });
  fireTrigger(state, 'loseConflict', { actorId: loser.id });

  arrest(state, loser, `玩家交锋输给 ${winner.name}`);

  void lastBidderId;
}

function drawMisfortuneFor(state: EngineState, p: EnginePlayer): void {
  drawMisfortune(state, p);
}

/** 贿赂金额：原版为 20 + 罪恶值，叠加永久卡加成与角色能力修正 */
export function bribeAmount(state: EngineState, p: EnginePlayer): number {
  const mod = bribeModifier(p);
  // 「乞丐·一帆风顺」把基数从 20 换成 5；否则用默认基数
  const baseOverride = typeof p.flags['bribeBase'] === 'number' ? p.flags['bribeBase'] : undefined;
  const base = baseOverride ?? mod.base;
  // 默认每 1 点罪恶 +1；「法官·正义之士」削弱为每 2 点 +1
  let amount = base + Math.floor(p.res.malice * mod.perMalice);
  // 「自动官僚」等永久卡：其他玩家的贿赂 +N
  amount += extraBribeFrom(state, p.id);
  return Math.max(0, amount);
}

// ---------------------------------------------------------------- 服刑回合
/**
 * 服刑回合流程。
 *
 * 原版入狱不是纯惩罚：每个服刑回合会抽一张监狱卡（`GJailCard`）并按 `Rank`/`Karma`
 * 结算，可能减刑、获得收入、掷骰出狱，也可能加刑。刑期走到 0 即出狱。
 *
 * 本实现按 jail card 的 `actions` 驱动；牌堆耗尽时用 ID 重洗。
 */
export function takeJailTurn(state: EngineState, playerId: string): { ok: boolean; reason?: string; pending?: PendingChoice } {
  const p = getPlayer(state, playerId);
  if (!p) return { ok: false, reason: '玩家不存在' };
  if (!p.inJail) return { ok: false, reason: '该玩家不在狱中' };
  if (state.pending) return { ok: false, reason: '有未完成的决策' };

  if (state.jailDeck.length === 0) state.jailDeck = JAIL_CARDS.map((c) => c.id);
  const id = state.jailDeck.pop();
  if (!id) return { ok: false, reason: '监狱牌堆为空' };
  state.discard.push(id);

  const card = JAIL_CARDS.find((c) => c.id === id);
  if (!card) return { ok: false, reason: '监狱卡不存在' };

  pushLog(state, p.id, `服刑：抽出监狱卡「${card.text.name}」—— ${card.text.description}`);

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

  // 刑期推进：无论卡牌效果如何，本回合都已完成一次服刑
  if (p.inJail) {
    p.term = Math.max(0, p.term - 1);
    if (p.term === 0) {
      release(state, p);
    } else {
      pushLog(state, p.id, `服刑中，剩余刑期 ${p.term} 次走牌`);
    }
  }

  return { ok: true };
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
      p.movedThisTurn = false; // 避免下次 endTurn 又停一次
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
    if (!skipDraw && !p.inJail) {
      const limit = characterName(p) === 'Collector' ? 8 : HAND_SIZE;
      while (p.hand.length < limit) {
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

  // 新回合开始钩子（信用贷扣款、服刑津贴、角色「平民主义」等）
  const next = actorOf(state);
  if (next) {
    fireTrigger(state, 'ownTurnStart', { actorId: next.id });
    fireAbility(state, next.id, 'turnStart', { cellId: next.cellId });
  }

  if (next && next.skipTurns > 0) {
    next.skipTurns -= 1;
    pushLog(state, next.id, `跳过本次走牌（剩余 ${next.skipTurns}）`);
  }

  // 每轮结束钩子（「古代机构」+齿轮、「末日时钟」每 6 轮扣分等）
  if (state.currentIndex === 0) fireTrigger(state, 'roundEnd', {});

  // 选举检查
  if (state.round >= state.nextElectionRound) runElection(state);

  // 胜利检查
  checkVictory(state);
}

export function checkVictory(state: EngineState): void {
  const winner = state.players.find((p) => p.res.score >= state.targetScore);
  if (winner) {
    state.winnerId = winner.id;
    state.phase = 'game_over';
    pushLog(state, winner.id, `${winner.name} 达到 ${state.targetScore} 齿轮，获胜！`);
  }
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
