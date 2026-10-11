// =============================================================
// 动作解释器 —— 原版 ActionList 的执行器
//
// 核心设计：原版动作是**有序列表**，且带隐式目标上下文。
// 例如卡 a001「游说」：  [SelectOpponent(文本ID), OpponentLoseVotes("1")]
// `SelectOpponent` 并不直接产生效果，而是设定后续动作的作用目标。
//
// 执行器维护执行上下文 ctx.targets；遇到 Select* 动作时：
//  - 若调用方已提供选择结果（ctx.choices）→ 直接应用
//  - 否则返回 PendingChoice 挂起，客户端回答后用 resume 续跑
// =============================================================
import type {
  ActionType, EnginePlayer, EngineState, PendingChoice, ResourceKey, CardAction,
} from './model.js';
import {
  CARD_BY_ID, CHARACTER_BY_ID, MISFORTUNE_CARDS, cellLabel, characterName, getCell, getMap,
} from './model.js';
import { fireTrigger as firePermTrigger } from './permanents.js';
import { fireAbility } from './abilities.js';
import { collectButtons } from './dialog.js';
import { diceTableOf, handleSpecialOutcome, jailTermFor } from './options.js';
import {
  addRes, firstId, firstNumber, firstResource, hasTag, parseParams, payAmount,
  takeTaggedNumbers, transferRes,
  type ParamSlot,
} from './resources.js';

/** 选举间隔（回合） */
export const ELECTION_INTERVAL = 20;

/** 一次动作执行的上下文 */
export interface ActionContext {
  actions: CardAction[];
  /** 下一条待执行下标 */
  index: number;
  /** 已选定目标（玩家 id / 格子 id，依动作而定） */
  targets: string[];
  /** 效果持有者 */
  ownerId: string;
  /** 触发来源描述，用于日志 */
  source: string;
  /**
   * 动作序列所属的卡牌 id（若来自某张牌）。
   *
   * 有些原语需要读**卡牌自身**的 `params` 才能确定规则形态
   * （如 `Auction`：a061 是"最高者付价"，m031 是"全员付价、最低者受罚"），
   * 而动作自己的 `ActionParams` 是空的（`[""]`）。
   */
  sourceCardId?: string;
  /** 调用方预先给出的选择结果（resume 或 AI 决策） */
  choices?: Record<string, string[]>;
  /** 额外数据槽（选定的地点、卡牌等） */
  scratch?: Record<string, string>;
  /**
   * 中止剩余动作的标记（由带 `HaltFailed` 之类的动作设置）。
   *
   * 原版有些牌是"要么整段生效、要么整段不生效"：
   * a179「昂贵的命令」——"该玩家必须支付 {1}$ 才能获得 {2}* 并失去 {3}^。
   * **如果无法全额支付**：其不会支付或者失去什么，但仅获得 {4}^（不会获得*）。"
   *
   * 由于动作是**顺序执行**的（付款 → 加齿轮 → 减齿轮 → 加罪恶），
   * "整段不生效"必须能把后面的动作一起停掉，所以需要一个显式中止标记。
   */
  haltRest?: boolean;
}

export type RunResult =
  | { status: 'done' }
  | { status: 'pending'; pending: PendingChoice };

export function resumeFrom(pending: PendingChoice): ActionContext {
  return {
    actions: pending.resume.actions,
    index: pending.resume.index,
    targets: pending.resume.targets,
    ownerId: pending.resume.ownerId,
    source: pending.resume.source,
    sourceCardId: pending.resume.sourceCardId,
  };
}

// ---------------------------------------------------------------- 基础工具
function owner(state: EngineState, ctx: ActionContext): EnginePlayer {
  const p = state.players.find((x) => x.id === ctx.ownerId);
  if (!p) throw new Error(`engine: 未知玩家 ${ctx.ownerId}`);
  return p;
}

function log(state: EngineState, playerId: string, text: string): void {
  state.log.push({ round: state.round, playerId, text, ts: Date.now() });
  if (state.log.length > 400) state.log.shift();
}

/** 地图全部格 id（按原版格号排序） */
export function mapCellIds(state: EngineState): string[] {
  return getMap(state).cells.map((c) => c.id);
}

/** 目标玩家：ctx.targets 为空则退回"自己" */
function targetPlayers(state: EngineState, ctx: ActionContext): EnginePlayer[] {
  const ids = ctx.targets.length ? ctx.targets : [ctx.ownerId];
  return ids
    .map((id) => state.players.find((p) => p.id === id))
    .filter((p): p is EnginePlayer => !!p);
}

const RES_LABEL: Record<ResourceKey, string> = {
  money: '金钱', vote: '选票', malice: '罪恶',
  score: '齿轮', income: '收入', term: '刑期',
};

const nameOf = (p: EnginePlayer): string => p.name || p.id;

function makePending(
  ctx: ActionContext,
  kind: string,
  prompt: string,
  options: Array<{ value: string; label: string }>,
  extra: Partial<PendingChoice> = {},
): RunResult {
  return {
    status: 'pending',
    pending: {
      kind,
      playerId: ctx.ownerId,
      prompt,
      options,
      min: 1,
      max: 1,
      resume: {
        actions: ctx.actions,
        // 不推进：回答后从同一个选择动作重放，applyChoice 会消费 choices 并写回 target
        index: ctx.index,
        // 必须快照：resume 保存后，后续动作仍会改写 ctx.targets，
        // 若存引用会把"挂起那一刻的目标"覆盖掉。
        targets: [...ctx.targets],
        source: ctx.source,
        sourceCardId: ctx.sourceCardId,
        ownerId: ctx.ownerId,
        scratch: ctx.scratch ? { ...ctx.scratch } : undefined,
      },
      ...extra,
    },
  };
}

/**
 * 像 `makePending` 一样挂起，但可以指定**由谁来答**。
 * `Auction` 要轮流问每个玩家，不能固定用 ctx.ownerId。
 */
function makePendingFor(
  ctx: ActionContext,
  kind: string,
  playerId: string,
  prompt: string,
  options: Array<{ value: string; label: string }>,
): RunResult {
  return {
    status: 'pending',
    pending: {
      kind,
      playerId,
      prompt,
      options,
      min: 1,
      max: 1,
      resume: {
        actions: ctx.actions,
        index: ctx.index,
        targets: [...ctx.targets],
        source: ctx.source,
        sourceCardId: ctx.sourceCardId,
        ownerId: ctx.ownerId,
        scratch: ctx.scratch ? { ...ctx.scratch } : undefined,
      },
    },
  };
}

const takeChoice = (ctx: ActionContext, kind: string): string[] | undefined => {
  const c = ctx.choices?.[kind];
  return c && c.length ? c : undefined;
};

/**
 * 已消费的 `BUTTON` 下标集合。
 *
 * 存在 `ctx.scratch` 里（scratch 是 `Record<string, string>`，所以用逗号分隔的字符串），
 * 并且会被 `makePending` 快照进 resume —— 这样挂起期间也不会丢。
 *
 * @param write 传了就把这份集合写回 ctx.scratch
 */
function consumedButtons(ctx: ActionContext, write?: Set<number>): Set<number> {
  if (write) {
    ctx.scratch = { ...ctx.scratch, __buttons: [...write].join(',') };
    return write;
  }
  const raw = ctx.scratch?.['__buttons'];
  if (!raw) return new Set<number>();
  return new Set(raw.split(',').filter(Boolean).map(Number));
}

// ---------------------------------------------------------------- 随机
/** 可复现的 LCG */
export function random(state: EngineState): number {
  state.rngState = (state.rngState * 1664525 + 1013904223) >>> 0;
  return state.rngState / 0x100000000;
}

export function rollDice(state: EngineState): number {
  return 1 + Math.floor(random(state) * 6);
}

// ---------------------------------------------------------------- 牌堆
export function drawTo(state: EngineState, p: EnginePlayer, n: number): string[] {
  const drawn: string[] = [];
  for (let i = 0; i < n; i++) {
    if (state.deck.length === 0) {
      if (state.discard.length === 0) break;
      state.deck = state.discard.splice(0).reverse();
    }
    const id = state.deck.pop();
    if (id) drawn.push(id);
  }
  p.hand.push(...drawn);
  return drawn;
}

export function discardFromHand(state: EngineState, p: EnginePlayer, n: number): string[] {
  const count = Math.max(0, Math.min(p.hand.length, n));
  const dropped = p.hand.splice(0, count);
  state.discard.push(...dropped);
  return dropped;
}

// ---------------------------------------------------------------- 逮捕/释放/厄运
function findCellByType(state: EngineState, cellType: string): string | undefined {
  return getMap(state).cells.find((c) => c.cellType === cellType)?.id;
}

export function arrest(state: EngineState, p: EnginePlayer, reason: string): void {
  // 逮捕前钩子：永久卡可能豁免逮捕（如「寡头」传送到赌场）
  const preFlags: Record<string, string | number | boolean> = {};
  firePermTrigger(state, 'beforeArrest', { actorId: p.id, flags: preFlags });
  if (preFlags.arrestSkipped) return;

  // 角色能力：被捕时的判刑修正 / 改送地点
  const abilFlags: Record<string, string | number | boolean> = {};
  fireAbility(state, p.id, 'arrest', { flags: abilFlags });

  // 「穷人勿进」：钱不够时改送垃圾场（不触发垃圾场规则）
  if (abilFlags.arrestToJunkyard) {
    const junkyard = findCellByType(state, 'Junkyard');
    if (junkyard) p.cellId = junkyard;
    p.inJail = false;
    p.term = 0;
    log(state, p.id, `${nameOf(p)} 因「穷人勿进」被送往垃圾场（${reason}）`);
    return;
  }

  const jail = findCellByType(state, 'Jail');
  if (jail) p.cellId = jail;
  // 刑期用原版 `Jail` 格子的 Label 表（1,2 = {3}；3,4 = {2}；5,6 = {1}）。
  // 「秘密关系」等角色能力把点数固定为 6。
  const alwaysSix = abilFlags.arrestAsSix === true;
  const dice = alwaysSix ? 6 : rollDice(state);
  p.inJail = true;
  p.term = jailTermFor(dice);
  log(state, p.id,
    `${nameOf(p)} 被逮捕入狱（${reason}），刑期 ${p.term} 次走牌（掷骰 ${dice}${alwaysSix ? '，角色能力固定为 6' : ''}）`);

  // 逮捕后钩子：永久卡可能调整刑期（如「自动狱长」）
  firePermTrigger(state, 'anyArrest', { actorId: p.id });
}

export function release(state: EngineState, p: EnginePlayer): void {
  p.inJail = false;
  p.term = 0;
  log(state, p.id, `${nameOf(p)} 获释`);
}

/**
 * 构造一副新的厄运牌堆（按 `DeckCount` 展开，已洗牌）。
 *
 * 对应原版 `GGame.nonlockedMFPickCard()` 里构造牌堆的那段：
 * 先按每张卡的 `DeckCount` 重复放入，再随机排序。
 *
 * ⚠️ 原版有一条**人数相关的硬编码剔除**（同一段逻辑连着写了两遍，
 * 因为"抽完立即重洗"也走这里）：
 * ```csharp
 * if (this.Players.Count < 5 || !(array[k] == "F7C040EC0741FE1C"))
 *     this.MFCDeck.AddFirst(array[k]);
 * ```
 * `F7C040EC0741FE1C` = **m029「丢失的债券」**。
 * 即**玩家 ≥ 5 人时这张牌不进牌堆**。这是原版里少见的"按人数改卡池"规则。
 */
export const MF_EXCLUDED_AT_FIVE_PLAYERS = 'F7C040EC0741FE1C';

export function buildMisfortuneDeck(state: EngineState): string[] {
  const deck: string[] = [];
  for (const c of MISFORTUNE_CARDS) {
    const n = Math.max(1, c.deckCount ?? 1);
    for (let i = 0; i < n; i++) deck.push(c.id);
  }
  shuffleInPlace(state, deck);
  // 玩家 ≥5 人时剔除指定牌（原版比较的是十六进制 UIN 字符串）
  if (state.players.length >= 5) {
    const dec = BigInt(`0x${MF_EXCLUDED_AT_FIVE_PLAYERS}`).toString();
    for (let i = deck.length - 1; i >= 0; i--) {
      if (deck[i] === dec) deck.splice(i, 1);
    }
  }
  return deck;
}

/** 原地洗牌，用引擎的确定性 RNG */
function shuffleInPlace(state: EngineState, arr: string[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random(state) * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

export function drawMisfortune(state: EngineState, p: EnginePlayer): void {
  // 获得厄运前钩子：永久卡可能以弃置自身代替（如「幸运药水」）
  const preFlags: Record<string, string | number | boolean> = {};
  firePermTrigger(state, 'mustGetMisfortune', { actorId: p.id, flags: preFlags });
  if (preFlags.misfortuneSkipped) return;

  if (state.misfortuneDeck.length === 0) state.misfortuneDeck = buildMisfortuneDeck(state);
  const id = state.misfortuneDeck.pop();
  if (!id) return;
  const card = MISFORTUNE_CARDS.find((c) => c.id === id);
  // 注意：厄运牌不入 action card 的弃牌堆——它有自己的 misfortuneDeck，
  // 会自动重洗。推入 state.discard 会让非行动卡 id 污染主牌堆，
  // 重洗后进入玩家手牌，导致 canMoveWithCard/canPlayCard 全部失败。
  log(state, p.id, `厄运「${card?.text.name ?? id}」：${card?.text.description ?? ''}`);
  if (card?.actions?.length) {
    const r = runActions(state, {
      actions: card.actions,
      index: 0,
      targets: [p.id],
      ownerId: p.id,
      source: `厄运「${card.text.name}」`,
      sourceCardId: card.id,
    });
    // 厄运牌里也会有需要玩家决策的动作（`BUTTON` 二选一、`SelectOpponent` 选人…）。
    // 之前这里丢掉了返回值，挂起状态没写回 state.pending，
    // 于是这些决策被静默跳过——厄运牌只结算了"默认分支"。
    if (r.status === 'pending') state.pending = r.pending;
  }
}

// ---------------------------------------------------------------- 选举
/** 选举加票基数（原版 `GConst.ELECTION_VOTE_BONUS` = 3） */
const ELECTION_VOTE_BONUS = 3;

/**
 * 政治家「议会人脉」在选举中提供的额外票数。
 *
 * 原版：`GetCharacterAbilityParam(EAction.Politician_Connections, 2, 2)`
 * —— 第二个参数是**默认值**，第三个是 `ActionParams` 的下标。
 * 所以"拿不到该能力时用 2"是源码自带的行为。
 *
 * ⚠️ `Politician_Connections` **不在导出的角色数据里**
 * （角色 ActionList 只有 Charisma / Populist / Astral_Club_2），
 * 因此目前恒返回默认 2。若日后找到该能力的参数，在此处读取即可。
 */
function politicianConnectionsBonus(p: EnginePlayer): number {
  const char = p.characterId ? CHARACTER_BY_ID[p.characterId] : undefined;
  if (!char || char.name !== 'Politician') return 0;
  // 角色定义的 actions 里找该能力（数据缺失时退回源码默认值 2）
  const ability = (char.actions ?? []).find(
    (a) => String(a.type) === 'Politician_Connections',
  );
  const raw = ability?.params?.[2] ?? ability?.params?.[0];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/**
 * 选举（镇长/总督）。
 *
 * ## 判定依据是**选票**，不是罪恶 ⚠️
 *
 * 原版 `CAvatarForm.CheckVotesMedal()` / `CElectionForm.showAddVote()`：
 * ```csharp
 * dictionary.Add(player.PlayerID, player.Resources.Vote);   // ← 基数是**选票**
 * ...
 * if (player.Resources.Malice == minMalice)                 // 罪恶只决定"谁拿加成"
 *     dictionary[player.PlayerID] += CD.Game.ELECTION_VOTE_BONUS;
 * ```
 * 即：**票数最高者当选**；「罪恶最低」只是给那人**额外加 3 票**。
 *
 * 极端例子：某人有 10 票、罪恶 5；另一人 1 票、罪恶 0。
 * 后者得 1+3=4 票，**前者 10 票仍然当选** —— 不是"罪恶最低者当选"。
 *
 * 这一点曾被我在会话记录里写错成"罪恶最低者获胜"，已按源码更正。
 *
 * ## 加成来源（两处）
 *  1. **罪恶最低者** +3 票；若**全员罪恶相同**则无人获得（`minMaliceAll` 分支）。
 *  2. **政治家「议会人脉」**（`Politician_Connections`）+N 票。
 *     `GetCharacterAbilityParam(EAction.Politician_Connections, 2, 2)`
 *     → 该能力 `ActionParams[2]`，拿不到时用**默认值 2**。
 *
 * ⚠️ `Politician_Connections` **不在导出的角色数据里**（角色 ActionList 只有
 * Charisma / Populist / Astral_Club_2），所以这里恒走"默认 2"。
 * 若日后在别处找到该能力的参数，改 `politicianConnections` 即可。
 *
 * ## 平局
 * 票数并列时，源码再按**罪恶较低**筛选一次；若筛选后仍**包含全部玩家**，
 * 则视为无人当选（不换镇长、不加齿轮）。见 `CAvatarForm` 用
 * `list.Count < CD.Game.Players.Count` 作为"有人当选"的条件。
 */
export function runElection(state: EngineState): void {
  const n = state.players.length;

  // 1) 基础票数
  const votes = new Map<string, number>();
  for (const p of state.players) votes.set(p.id, p.res.vote);

  // 2) 罪恶最低者 +3，全员同罪恶则无人获得
  const minMalice = Math.min(...state.players.map((p) => p.res.malice));
  const allSameMalice = state.players.every((p) => p.res.malice === minMalice);
  if (!allSameMalice) {
    for (const p of state.players) {
      if (p.res.malice === minMalice) {
        votes.set(p.id, (votes.get(p.id) ?? 0) + ELECTION_VOTE_BONUS);
      }
    }
  }

  // 3) 政治家「议会人脉」加成
  //
  // 不 import `abilities.ts` 的 `abilitiesOf`：那边已经 import 本文件，
  // 反向依赖会形成循环。这里只需查一张静态表，直接读角色定义即可。
  for (const p of state.players) {
    const bonus = politicianConnectionsBonus(p);
    if (bonus > 0) votes.set(p.id, (votes.get(p.id) ?? 0) + bonus);
  }

  // 4) 最高票
  const maxVotes = Math.max(...[...votes.values()]);
  let tied = state.players.filter((p) => votes.get(p.id) === maxVotes);
  if (!tied.length) return;

  // 5) 票数并列 → 取**罪恶较低**者
  //
  // 源码顺序（`CAvatarForm` 640-659）：先按最高票收集 `list`，
  // **再**用"罪恶最低"过滤 `list`。所以过滤后正常只剩少数人。
  if (tied.length > 1) {
    const minTiedMalice = Math.min(...tied.map((p) => p.res.malice));
    tied = tied.filter((p) => p.res.malice === minTiedMalice);
  }

  // 6) 若过滤后**仍包含全部玩家**（全员票数与罪恶都一样）→ 无人当选
  //
  // 源码用 `list.Count < CD.Game.Players.Count` 作为"有人当选"的条件。
  // 注意这是**过滤之后**的比较：例如 2 人局里两人票数并列但罪恶不同，
  // 过滤后 list 只剩 1 人 < 2，**仍然有人当选**（不要用过滤前的长度判断）。
  if (tied.length >= n) {
    log(state, state.players[0]!.id,
      `选举结束：全部玩家票数并列（各 ${maxVotes} 票），无人当选`);
    state.nextElectionRound = state.round + ELECTION_INTERVAL;
    return;
  }

  // 仍有多人并列（票数与罪恶都相同，但未覆盖全员）时，取座位顺序靠前者。
  //
  // ⚠️ 原版这一步由**服务端**决定并通过 `ComElectionWindow.WinPlayerID` 下发，
  // 而服务端程序集不在本次反编译产物内，所以"多人完全并列"时原版选谁
  // **无法证实**。这里用座位顺序保证确定性，属于**推断**。
  const winner = tied[0]!;
  state.mayorId = winner.id;
  // 镇长特权：就职 +1 齿轮
  winner.res.score += 1;
  log(state, winner.id,
    `选举结束：${nameOf(winner)} 当选镇长（${votes.get(winner.id)} 票），就职 +1 齿轮`
    + (winner.res.malice === minMalice && !allSameMalice ? '（罪恶最低，含 +3 票加成）' : ''));
  state.nextElectionRound = state.round + ELECTION_INTERVAL;
}

// ---------------------------------------------------------------- 主循环
/**
 * 执行动作序列。需要选择且无预置答案时返回 pending。
 * 玩家回答后，用 resumeFrom(pending) 构造 ctx 并带上 choices 再次调用。
 */
export function runActions(state: EngineState, ctx: ActionContext): RunResult {
  let i = ctx.index;
  while (i < ctx.actions.length) {
    // 有动作要求中止后续（如 a179 的 `HaltFailed`：付不出就整段不生效）
    if (ctx.haltRest) break;
    const action = ctx.actions[i];
    // 关键：把当前下标写回 ctx，makePending 依赖 ctx.index 记录续跑位置
    ctx.index = i;
    const pending = execAction(state, ctx, action);
    if (pending) return pending;
    i = ctx.index + 1;
  }
  return { status: 'done' };
}

/** 执行单条动作；返回 pending 表示需要玩家决策 */
function execAction(
  state: EngineState,
  ctx: ActionContext,
  action: CardAction,
): RunResult | undefined {
  const type = action.type as ActionType;
  const slots = parseParams(action.params);

  switch (type) {
    // ============ 目标选择（可能挂起） ============
    case 'SelectOpponent':
    case 'SelectSelf':
    case 'SelectEvil':
    case 'SelectGovernor':
    case 'SelectPermanent':
    case 'SelectBonus':
    case 'SelectPunishment':
    case 'SelectZek':
    case 'SelectDeckCard':
    case 'NameLocation':
    case 'Teleport': {
      // 若本次调用已带有该选择的答案（resume 路径），先把它应用到 ctx，
      // 这样目标才对后续动作可见，pending 快照也不会丢。
      const chosen = takeChoice(ctx, type);
      if (chosen) applyChoice(state, ctx, type, chosen);
      return handleSelect(state, ctx, type, slots);
    }

    // ============ 二选一（对话框按钮） ============
    // 一张牌用两个 `BUTTON` 表达"两害取其轻"，各带一条分支动作序列。
    // 玩家点哪个按钮就走哪条分支。
    //
    // 「按组处理」是关键：两个 BUTTON 与它们的分支**共用一条动作列表**，
    // 所以选完分支 0 之后，主循环会继续走到分支 1 的动作。之前只在 BUTTON
    // 处 return undefined，结果**两条分支都执行了**（选钱还扣齿轮）。
    // 因此这里一次性推进整组：执行选中分支，然后直接跳到组末尾。
    case 'BUTTON': {
      const buttons = collectButtons(ctx.actions);
      if (buttons.length < 2) return undefined; // 结构不完整就跳过，不卡住

      const groupEnd = buttons[buttons.length - 1].branchEnd;
      const consumed = consumedButtons(ctx);

      // 本组已处理过 → 直接跳到组末尾（不再重复执行任何分支）
      if ([...consumed].some((i) => buttons.some((b) => b.branchStart - 1 === i))) {
        ctx.index = groupEnd - 1;
        return undefined;
      }

      const key = `BUTTON:${ctx.index}`;
      const chosen = takeChoice(ctx, key);
      if (!chosen) {
        return makePending(ctx, key, '选择一个结果', buttons.map((b, k) => ({
          value: String(k),
          label: b.label,
        })));
      }

      const pick = buttons.find((b) => b.label === chosen[0]) ?? buttons[Number(chosen[0])];
      // 用子上下文只跑选中的分支，避免主循环顺带跑掉另一条分支
      if (pick) {
        const sub: ActionContext = { ...ctx, actions: pick.actions, index: 0 };
        const r = runActions(state, sub);
        if (r.status === 'pending') return r;
      }
      consumed.add(ctx.index);
      consumedButtons(ctx, consumed);
      ctx.index = groupEnd - 1;
      return undefined;
    }

    // ============ 作用域（不挂起，只改 targets） ============
    case 'AllOpponents': {
      ctx.targets = state.players.filter((p) => p.id !== ctx.ownerId).map((p) => p.id);
      return undefined;
    }
    case 'AllPlayers': {
      ctx.targets = state.players.map((p) => p.id);
      return undefined;
    }
    case 'EvilPlayers': {
      const max = Math.max(...state.players.map((p) => p.res.malice));
      const evil = state.players.filter((p) => p.res.malice === max);
      ctx.targets = (evil.length ? evil : [owner(state, ctx)]).map((p) => p.id);
      return undefined;
    }

    // ============ 自己获益 ============
    case 'GetIncome': {
      const o = owner(state, ctx);
      const times = firstNumber(slots, 1) || 1;
      const gained = addRes(o, 'money', o.res.income * times);
      log(state, o.id, `${ctx.source}：获得收入 ×${times} → +${gained} ${RES_LABEL.money}`);
      return undefined;
    }

    // ============ 拍卖（每个玩家出价） ============
    // a061「拍卖」：             最高者付价，+出价额 齿轮
    // m031「总统造访」：         所有人都付价，最低者 -出价额 齿轮
    // 用 params 区分两种形态（规则写在卡牌说明里，参数只够做形态判别）。
    case 'Auction':
      return handleAuction(state, ctx, action.params ?? []);

    // ============ 比较资源（不满足则跳过后续动作） ============
    // a134「伪证」：...该玩家给你{1}*；**若其罪恶高于你，则被逮捕**。
    // 英文原文: "...; if their ^ is higher than yours, they are arrested."
    // 所以 `CompareResource(malice)` 之后的 `OpponentArrest` 只在
    // "目标该资源 > 自己"时执行；否则跳过后续动作。
    case 'CompareResource': {
      const key = (firstResource(slots) ?? 'malice') as ResourceKey;
      const me = owner(state, ctx);
      const targets = targetPlayers(state, ctx);
      const pass = targets.length > 0 && targets.every((t) => t.res[key] > me.res[key]);
      if (!pass) {
        // 条件不成立 → 跳过后续动作
        ctx.index = ctx.actions.length;
        log(state, me.id, `比较 ${RES_LABEL[key]} 未满足，跳过后续效果`);
      }
      return undefined;
    }

    // ============ 最高属性奖励 ============
    // a181「知名品牌」：每当你拥有最高的 $、*、&、^、| 或 ~ 之一：
    //   +{1}* 以及 |+{2}   （params = [1, 3]）
    // 英文原文: "For each occasion where you have the highest $, *, &, ^, | or ~:
    //            +{1}*, |+{2}."
    case 'TopStatBonus': {
      const me = owner(state, ctx);
      // 对应原文的 $ * & ^ | ~ 六项
      const keys: ResourceKey[] = ['money', 'score', 'vote', 'malice', 'income', 'term'];
      let count = 0;
      for (const k of keys) {
        const max = Math.max(...state.players.map((p) => p.res[k]));
        if (max > 0 && me.res[k] === max) count++;
      }
      const perScore = firstNumber(slots, 0);
      const perIncome = Number(action.params?.[1] ?? 0);
      if (count > 0) {
        if (perScore) addRes(me, 'score', perScore * count);
        if (perIncome) addRes(me, 'income', perIncome * count);
        log(state, me.id,
          `「知名品牌」：${count} 项资源最高 → +${perScore * count} ${RES_LABEL.score}，+${perIncome * count} ${RES_LABEL.income}`);
      } else {
        log(state, me.id, '「知名品牌」：没有任何一项资源最高，无奖励');
      }
      return undefined;
    }

    // ============ 赌场重掷 / 摇骰器 ============
    // a030「幸运币」（Yet another chance）：在赌场中赌博 —— 用赌场骰表结算一次
    case 'CasinoReroll': {
      const me = owner(state, ctx);
      const table = diceTableOf('Casino');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const outcome = table[dice];
      if (outcome?.gain) {
        for (const [k, v] of Object.entries(outcome.gain)) {
          if (!v) continue;
          addRes(me, k as ResourceKey, v);
        }
      }
      log(state, me.id, `「幸运币」赌场掷出 ${dice}：${dice <= 3 ? '输' : '赢'}（${JSON.stringify(outcome?.gain ?? {})}）`);
      return undefined;
    }

    // a170「摇骰器」（Dice-roller）：掷骰子，每有一张移动点数与骰点相同的手牌 +{1}$
    case 'SameMovePoints': {
      const me = owner(state, ctx);
      const per = firstNumber(slots, 0);
      const dice = rollDice(state);
      state.lastRoll = dice;
      const hits = me.hand.filter((id) => CARD_BY_ID[id]?.move === dice);
      const gain = hits.length * per;
      if (gain) addRes(me, 'money', gain);
      log(state, me.id,
        `「摇骰器」掷出 ${dice}：${hits.length} 张同点数手牌 → +${gain} ${RES_LABEL.money}`);
      return undefined;
    }

    // ============ 对手减益 ============
    case 'OpponentLoseVotes':
    case 'OpponentLoseScore':
    case 'OpponentLoseMalice':
    case 'OpponentLoseIncome':
    case 'OpponentLoseMoney':
    case 'OpponentPayMoney':
    case 'OpponentPayScore':
      return handleResourceLoss(state, ctx, type, slots);

    case 'OpponentGetMisfortune': {
      const n = firstNumber(slots, 1) || 1;
      for (const tgt of targetPlayers(state, ctx)) for (let k = 0; k < n; k++) drawMisfortune(state, tgt);
      return undefined;
    }

    case 'OpponentArrest': {
      for (const tgt of targetPlayers(state, ctx)) {
        if (hasTag(slots, 'Evil')) {
          const maxMalice = Math.max(...state.players.map((p) => p.res.malice));
          if (tgt.res.malice < maxMalice) continue;
        }
        arrest(state, tgt, ctx.source);
      }
      return undefined;
    }

    case 'OpponentSkipTurn': {
      const n = firstNumber(slots, 1) || 1;
      for (const tgt of targetPlayers(state, ctx)) {
        tgt.skipTurns += n;
        log(state, tgt.id, `${nameOf(tgt)} 将跳过 ${n} 次走牌`);
      }
      return undefined;
    }

    case 'OpponentRedraw': {
      for (const tgt of targetPlayers(state, ctx)) {
        state.discard.push(...tgt.hand.splice(0));
        drawTo(state, tgt, 6);
        log(state, tgt.id, `${nameOf(tgt)} 更换了全部手牌`);
      }
      return undefined;
    }

    case 'OpponentShowHand': {
      const value = firstNumber(slots, 0);
      const tags = slots.filter((s): s is { kind: 'tag'; value: string } => s.kind === 'tag').map((s) => s.value);
      const o = owner(state, ctx);
      for (const tgt of targetPlayers(state, ctx)) {
        log(state, o.id, `查看了 ${nameOf(tgt)} 的手牌`);
        // 把被查看的手牌记下来，界面才能真的显示出来。
        // ⚠️ 原先只写日志，玩家看不到对方的牌（用户 bug #4）。
        // 自己的手牌（SelectSelf + 揭示类卡）不必记 —— 本来就看得见。
        if (tgt.id !== o.id) {
          state.revealedHand = {
            ownerId: tgt.id,
            ownerName: nameOf(tgt),
            viewerId: o.id,
            cardIds: [...tgt.hand],
          };
        }
        if (tags.includes('SecretPay')) {
          const n = tgt.hand.filter((id) => {
            const c = CARD_BY_ID[id];
            return c?.secret || c?.criminal;
          }).length;
          const gain = n * (value || 0);
          if (gain > 0) {
            transferRes(tgt, o, 'money', gain);
            log(state, o.id, `其中 ${n} 张秘密/罪恶卡，${nameOf(tgt)} 支付 ${gain} ${RES_LABEL.money}`);
          }
        } else if (tags.includes('CellPay')) {
          const placeId = ctx.scratch?.placeId;
          const n = placeId
            ? tgt.hand.filter((id) => cardPlayableAtCell(state, id, placeId)).length
            : 0;
          const gain = n * (value || 0);
          if (gain > 0) {
            transferRes(tgt, o, 'money', gain);
            log(state, o.id, `其中 ${n} 张可在该地点打出，${nameOf(tgt)} 支付 ${gain} ${RES_LABEL.money}`);
          }
        } else if (tags.includes('Discard')) {
          const n = firstNumber(slots, 1) || 1;
          const dropped = discardFromHand(state, tgt, n);
          addRes(o, 'malice', dropped.length);
          log(state, o.id, `丢弃其 ${dropped.length} 张手牌，+${dropped.length} ${RES_LABEL.malice}`);
        }
      }
      return undefined;
    }

    case 'OpponentSwitchPlaces': {
      const o = owner(state, ctx);
      for (const tgt of targetPlayers(state, ctx)) {
        [o.cellId, tgt.cellId] = [tgt.cellId, o.cellId];
        log(state, o.id, `与 ${nameOf(tgt)} 交换了位置`);
      }
      return undefined;
    }

    case 'OpponentTeleport': {
      // 参数是**格子类型 id**，必须先解析成真实格 id（见 teleportTargetCells）。
      // 原先直接 firstId(slots) 当格 id 用，会把位置写成类型 key。
      const rawParams = slots.map((s) => String(s.value)).filter(Boolean);
      const targets = teleportTargetCells(state, rawParams);
      const dest = targets[0]?.id ?? ctx.scratch?.placeId;
      if (!dest) return undefined;
      for (const tgt of targetPlayers(state, ctx)) {
        tgt.cellId = dest;
        log(state, tgt.id, `${nameOf(tgt)} 被传送到 ${cellLabel(getCell(state, dest))}`);
      }
      return undefined;
    }

    case 'OpponentGetsYourTerm': {
      const o = owner(state, ctx);
      const moved = o.term;
      for (const tgt of targetPlayers(state, ctx)) tgt.term += moved;
      o.term = 0;
      if (moved > 0) log(state, o.id, `刑期 ${moved} 转移给对手`);
      return undefined;
    }

    // ============ 移动 ============
    case 'RandomTeleport': {
      const o = owner(state, ctx);
      const ids = mapCellIds(state);
      if (!ids.length) return undefined;
      o.cellId = ids[Math.floor(random(state) * ids.length)];
      log(state, o.id, `随机传送到 ${cellLabel(getCell(state, o.cellId))}`);
      return undefined;
    }

    case 'Move_Back': {
      // ⚠️ 这不是"向后退 N 步"的动作，而是 a031「作弊！」用来声明
      // **本牌的移动可以逆行（逆时针走）** 的标记。
      //
      // 原版卡面（英文）："You can move **against the arrows** when you use
      // this card to move."
      //
      // 早先这里真的把玩家沿 `in[0]` 倒退 `lastMoveSteps` 步，结果
      // 「先向前走 2 步、再退回来」＝净位移 0 —— 用户报的 bug #3
      // "作弊这张牌的移动不符合预期"。
      //
      // 真正的逆行由移动引擎负责：`isReverseMoveCard()` 认得这个动作，
      // `startMove` 会据此沿 `cell.in` 走。这里只做标记，不改变位置。
      const o = owner(state, ctx);
      o.flags['reverseMove'] = 1;
      log(state, o.id, `${ctx.source}：本牌可以逆行（沿箭头反方向移动）`);
      return undefined;
    }

    case 'MOVE':
    case 'SpecialMove':
      // 由回合流程驱动，动作序列中仅作标记
      return undefined;

    // ============ 回合流程 ============
    case 'AddTurn': {
      const o = owner(state, ctx);
      // `ActionParams[0]` 是**次数**，且可以为负。
      // m038「…」用的是 `AddTurn(-1)` = **减少** 1 次额外走牌；
      // 旧实现写死 `+= 1`，会把"减一次"变成"加一次"（方向反了）。
      const n = firstNumber(slots, 0) || 1;
      o.extraTurns = Math.max(0, o.extraTurns + n);
      log(state, o.id, `${ctx.source}：${n >= 0 ? `获得 ${n}` : `失去 ${-n}`} 次额外走牌`);
      return undefined;
    }
    case 'PlayExtraCard': {
      // 原版：额外打出一张效果牌（不是额外移动）
      const o = owner(state, ctx);
      o.flags['canPlayAgain'] = 1;
      log(state, o.id, `${ctx.source}：可再打出一张卡牌`);
      return undefined;
    }
    case 'SkipDraw': {
      owner(state, ctx).flags['skipDraw'] = 1;
      return undefined;
    }
    case 'IgnoreCell': {
      owner(state, ctx).flags['ignoreCell'] = 1;
      return undefined;
    }
    case 'PickCardEarly': {
      // 原版规则：立即抽一张牌（手牌可能临时超过 6，用牌后回到 6）
      const o = owner(state, ctx);
      drawTo(state, o, 1);
      log(state, o.id, `${ctx.source}：提前抽 1 张牌`);
      return undefined;
    }
    case 'Discard': {
      // "Move" 关键字：仅用于移动流程（弃牌/掷骰决定步数），
      // 在效果结算中不执行任何弃牌。
      if (hasTag(slots, 'Move')) return undefined;
      const o = owner(state, ctx);
      const n = firstNumber(slots, o.hand.length) || o.hand.length;
      const dropped = n >= o.hand.length
        ? (() => { const d = o.hand.splice(0); state.discard.push(...d); return d; })()
        : discardFromHand(state, o, n);
      log(state, o.id, `丢弃 ${dropped.length} 张手牌`);
      return undefined;
    }
    case 'Freedom': {
      release(state, owner(state, ctx));
      return undefined;
    }
    case 'ChangeTerm': {
      const n = firstNumber(slots, 1);
      for (const tgt of targetPlayers(state, ctx)) {
        tgt.term = Math.max(0, tgt.term + n);
        log(state, tgt.id, `刑期 ${n >= 0 ? '+' : ''}${n} → ${tgt.term}`);
      }
      return undefined;
    }
    case 'PayTerm': {
      const o = owner(state, ctx);
      const n = firstNumber(slots, 1);
      const paid = Math.min(o.term, n);
      o.term -= paid;
      log(state, o.id, `支付刑期 -${paid}`);
      return undefined;
    }
    case 'ChangeGovernship': {
      const o = owner(state, ctx);
      if (state.mayorId === o.id) {
        state.mayorId = undefined;
        log(state, o.id, `${nameOf(o)} 不再担任镇长`);
      } else {
        state.mayorId = o.id;
        log(state, o.id, `${nameOf(o)} 成为镇长`);
      }
      return undefined;
    }
    case 'Elections': {
      runElection(state);
      return undefined;
    }
    case 'WindOfChanges': {
      // m015「不测风云」原文：
      //   「每个玩家将 {1} 张手牌传给下一个玩家。」（`params[0]` = 2）
      //
      // ⚠️ 早先这里**完全忽略参数**，把所有人的手牌全丢进弃牌堆再各抽 6 张 ——
      // 效果从"每人传 2 张"变成了"全体换一手牌"，用户报的 bug #5。
      //
      // 实现要点：
      //  - **同时结算**：先按"传牌前"的手牌各取出 N 张，再一起发给下一位，
      //    否则玩家 A 收到的牌会被算进 A 要传出的牌里，越传越乱。
      //  - "下一个玩家"按**座位顺序**（`state.players` 已按原版行动顺序排好）。
      //  - 手牌不足 N 张的玩家按实际持有量传（不会凭空造牌）。
      //  - 卡面没写让玩家挑牌，所以取**随机** N 张。
      const n = firstNumber(slots, 2) || 2;
      const order = state.players;
      if (order.length < 2) return undefined;

      const outgoing = new Map<string, string[]>();
      for (const p of order) {
        const picked: string[] = [];
        for (let i = 0; i < n && p.hand.length > 0; i++) {
          const idx = Math.floor(random(state) * p.hand.length) % p.hand.length;
          picked.push(p.hand.splice(idx, 1)[0]!);
        }
        outgoing.set(p.id, picked);
      }
      // 传给下一位
      for (let i = 0; i < order.length; i++) {
        const from = order[i]!;
        const to = order[(i + 1) % order.length]!;
        const cards = outgoing.get(from.id) ?? [];
        to.hand.push(...cards);
      }
      const detail = order
        .map((p) => `${p.name} 传出 ${(outgoing.get(p.id) ?? []).length} 张`)
        .join('，');
      log(state, ctx.ownerId, `不测风云：每个玩家向下一家传 ${n} 张手牌（${detail}）`);
      return undefined;
    }

    // ============ 永久卡 ============
    case 'SacrificePermanent': {
      const o = owner(state, ctx);
      if (!o.permanents.length) return undefined;
      const pre = takeChoice(ctx, type) ?? (ctx.scratch?.permanentId ? [ctx.scratch.permanentId] : undefined);
      if (!pre) {
        return makePending(ctx, type, '选择要牺牲的永久卡',
          o.permanents.map((id) => ({ value: id, label: CARD_BY_ID[id]?.text.name ?? id })));
      }
      const idx = o.permanents.indexOf(pre[0]);
      if (idx >= 0) {
        const removed = o.permanents.splice(idx, 1)[0];
        state.discard.push(removed);
        log(state, o.id, `牺牲永久卡「${CARD_BY_ID[removed]?.text.name ?? removed}」`);
      }
      return undefined;
    }

    case 'Exchange_Perm': {
      log(state, ctx.ownerId, '永久卡交换');
      return undefined;
    }

    // ============ 骰子类 ============
    // 注意：这里**只能**放真正的"只掷骰"原语。
    // 曾经把 CasinoBonus / RiskVotes / MoneyRoll 等也归进来，结果它们
    // 只掷骰、完全不结算。现在 coverage 测试专门拦这种归并。
    case 'ROLL': {
      const o = owner(state, ctx);
      state.lastRoll = rollDice(state);
      log(state, o.id, `${ctx.source}：掷骰 ${state.lastRoll}`);
      return undefined;
    }

    // m024「诈骗集团」：掷骰，按**逐点金额表**结算。
    //   ActionParams = ["-100","-70","-50","-30","-10","10"]，与卡牌
    //   params [100,70,50,30,10,10] 同值 → 点数 i 对应第 i 个金额。
    //   原版说明在这张卡上被截断（只到"掷骰子："），所以规则依据是参数表本身。
    case 'MoneyRoll': {
      const o = owner(state, ctx);
      const table = (action.params ?? []).map((x) => Number(x) || 0);
      const dice = rollDice(state);
      state.lastRoll = dice;
      const delta = table[dice - 1] ?? 0;
      if (delta >= 0) addRes(o, 'money', delta);
      else addRes(o, 'money', -Math.min(o.res.money, -delta));
      log(state, o.id, `${ctx.source}：掷出 ${dice} → ${delta >= 0 ? '+' : ''}${delta} ${RES_LABEL.money}`);
      return undefined;
    }

    // ============ 赌场 / 摇骰类卡牌 ============
    // a027「轻松赌博」：在赌场赌博，**赢钱翻三倍**；输的钱超过持有则**不涨罪恶**；
    //                  另有 AddTurn 给额外走牌（由后续动作负责）。
    case 'CasinoBonus': {
      const o = owner(state, ctx);
      const table = diceTableOf('Casino');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const gain = table[dice]?.gain?.money ?? 0;
      if (gain > 0) {
        // 赢钱翻三倍（相对赌场标准表的金额）
        const win = gain * 3;
        addRes(o, 'money', win);
        log(state, o.id, `${ctx.source}：赌场掷出 ${dice}，赢钱翻三倍 +${win} ${RES_LABEL.money}`);
      } else if (gain < 0) {
        const paid = Math.min(o.res.money, -gain);
        addRes(o, 'money', -paid);
        // 「输的钱超过持有则不涨罪恶」——所以这里**不**加罪恶
        log(state, o.id, `${ctx.source}：赌场掷出 ${dice}，损失 ${paid} ${RES_LABEL.money}（不涨 ${RES_LABEL.malice}）`);
      } else {
        log(state, o.id, `${ctx.source}：赌场掷出 ${dice}，无事`);
      }
      return undefined;
    }

    // 监狱牌 t002「大转盘」：赌场骰表结算（params 与赌场格完全一致）
    case 'Casino': {
      const o = owner(state, ctx);
      const table = diceTableOf('Casino');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const outcome = table[dice]?.gain;
      if (outcome) {
        for (const [k, v] of Object.entries(outcome)) {
          if (!v) continue;
          addRes(o, k as ResourceKey, v);
        }
      }
      log(state, o.id, `${ctx.source}：地下轮盘掷出 ${dice} → ${JSON.stringify(outcome ?? {})}`);
      return undefined;
    }

    // 监狱牌 t003「垃圾」：规则与垃圾场相同（params 全 0，用垃圾场格的表）
    case 'Junkyard': {
      const o = owner(state, ctx);
      const table = diceTableOf('Junkyard');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const outcome = table[dice];
      if (outcome?.gain) {
        for (const [k, v] of Object.entries(outcome.gain)) {
          if (!v) continue;
          addRes(o, k as ResourceKey, v);
        }
      }
      log(state, o.id, `${ctx.source}：翻垃圾掷出 ${dice} → ${outcome?.special ?? JSON.stringify(outcome?.gain ?? {})}`);
      return undefined;
    }

    // a022「装腔作势」：触发赌博站效果，**并额外获得等同于骰子点数的选票**
    case 'RiskVotes': {
      const o = owner(state, ctx);
      const table = diceTableOf('Risk');
      const dice = rollDice(state);
      state.lastRoll = dice;
      const outcome = table[dice];
      if (outcome?.gain) {
        for (const [k, v] of Object.entries(outcome.gain)) {
          if (!v) continue;
          addRes(o, k as ResourceKey, v);
        }
      }
      if (outcome?.special) handleSpecialOutcome(state, o, outcome.special);
      addRes(o, 'vote', dice);
      log(state, o.id, `${ctx.source}：赌博站掷出 ${dice}，额外 +${dice} ${RES_LABEL.vote}`);
      return undefined;
    }

    // a074「魔幻饰品」：搜寻宝藏，可再掷一次（只有最后一次算数）
    case 'TreasureReroll': {
      const o = owner(state, ctx);
      const table = diceTableOf('Treasure');
      // 「可再掷一次」——AI/自动流程用两掷取后者；人类交互留待 UI
      const first = rollDice(state);
      const second = rollDice(state);
      const dice = second;
      state.lastRoll = dice;
      const gain = table[dice]?.gain?.money ?? 0;
      if (gain) addRes(o, 'money', gain);
      log(state, o.id,
        `${ctx.source}：搜寻宝藏（重掷 ${first} → ${dice}，只有最后一次算数）+${gain} ${RES_LABEL.money}`);
      return undefined;
    }

    // ============ 永久卡触发型原语：由 permanents.ts 的触发系统处理，不走解释器 ============
    case 'Perm_AstralElevator':
    case 'Perm_BankIncome':
    case 'Perm_Banker':
    case 'Perm_Bribe':
    case 'Perm_BribeSkip':
    case 'Perm_CasinoMoney':
    case 'Perm_CasinoRoll':
    case 'Perm_CasinoVote':
    case 'Perm_Chaos':
    case 'Perm_Complete_Set':
    case 'Perm_Conflict':
    case 'Perm_Credit':
    case 'Perm_Discard':
    case 'Perm_DiscardFirst':
    case 'Perm_EvilBonus':
    case 'Perm_ExtraCard':
    case 'Perm_Gather':
    case 'Perm_Income':
    case 'Perm_Jail':
    case 'Perm_JailMoney':
    case 'Perm_JunkyardPay':
    case 'Perm_MFSkip':
    case 'Perm_MoveMoney':
    case 'Perm_Plant_Money':
    case 'Perm_RiskBonus':
    case 'Perm_ScoreIncome':
    case 'Perm_SecretVote':
    case 'Perm_Secret_Police':
    case 'Perm_SkipArrest':
    case 'Perm_SpeedPay':
    case 'Perm_Takeover':
    case 'Perm_Trader':
    case 'Perm_TreasureMoney':
      return undefined;

    // ============ 其余原语：显式记录，便于对齐进度 ============
    default: {
      log(state, ctx.ownerId, `${ctx.source}：效果「${type}」尚未实现`);
      return undefined;
    }
  }
}

// ---------------------------------------------------------------- 选择
/**
 * 把玩家的选择写进执行上下文。
 * 目标是「玩家」的动作写 ctx.targets；目标不是玩家的写 ctx.scratch。
 */
function applyChoice(
  state: EngineState,
  ctx: ActionContext,
  kind: ActionType,
  values: string[],
): void {
  switch (kind) {
    case 'SelectOpponent':
    case 'SelectSelf':
    case 'SelectEvil':
    case 'SelectGovernor':
      ctx.targets = [...values];
      break;
    case 'NameLocation':
      ctx.scratch = { ...ctx.scratch, placeId: values[0] };
      break;
    case 'SelectDeckCard':
      // 已在 handleSelect 中将牌加入手牌，这里只记录 scratch
      ctx.scratch = { ...ctx.scratch, deckCardId: values[0] };
      break;
    case 'SelectPermanent':
      ctx.scratch = { ...ctx.scratch, permanentId: values[0] };
      break;
    case 'Teleport':
      if (values[0]) {
        const actor = state.players.find((p) => p.id === ctx.ownerId);
        if (actor) {
          actor.cellId = values[0];
          log(state, actor.id, `传送到 ${cellLabel(getCell(state, values[0]))}`);
        }
      }
      break;
    default:
      ctx.scratch = { ...ctx.scratch, [kind]: values[0] };
      break;
  }
}

// ---------------------------------------------------------------- 拍卖
/**
 * 取"动作序列所属卡牌"的 `params`。
 *
 * 有些原语的规则形态写在**卡牌**的 params 里，而动作自己的 `ActionParams`
 * 是空的（`[""]`）。例如 `Auction`：
 *
 * | 卡 | 说明 | 卡牌 params | 结算 |
 * |---|---|---|---|
 * | a061 拍卖 | 最高者付价并 +出价额 齿轮 | `[3]` | 只最高者付钱 |
 * | m031 总统造访 | 所有出价都付，最低者 -出价额 齿轮 | `[2]` | 全员付钱 |
 *
 * 找不到就返回 undefined（调用方回退到动作参数）。
 */
function cardParamsOf(ctx: ActionContext): string[] | undefined {
  const id = ctx.sourceCardId;
  if (!id) return undefined;
  const card = CARD_BY_ID[id] ?? MISFORTUNE_CARDS.find((c) => c.id === id);
  if (!card) return undefined;
  return (card.params ?? []).map(String);
}

/**
 * 拍卖：**每个玩家各出一次价**，按顺序逐个询问。
 *
 * 两种形态见 `cardParamsOf` 的说明。出价逐个收集，
 * 用 `ctx.scratch.__bids` 跨挂起保存。
 */
function handleAuction(state: EngineState, ctx: ActionContext, actionParams: string[]): RunResult | undefined {
  // 形态判别用**卡牌**的 params（动作参数是空的）
  const params = cardParamsOf(ctx) ?? actionParams;
  const key = 'auction';
  const bids: Record<string, number> = {};
  const raw = ctx.scratch?.['__bids'];
  if (raw) {
    for (const pair of raw.split(';')) {
      const [id, v] = pair.split('=');
      if (id) bids[id] = Number(v) || 0;
    }
  }

  // 消费本次提交的出价（挂起时是问某一位，resume 时把答案记进 bids）
  const answer = takeChoice(ctx, key);
  if (answer) {
    const who = state.players.find((p) => !(p.id in bids));
    if (who) bids[who.id] = Math.max(0, Number(answer[0]) || 0);
    ctx.scratch = {
      ...ctx.scratch,
      __bids: Object.entries(bids).map(([id, v]) => `${id}=${v}`).join(';'),
    };
  }

  // 还没问完 → 问下一位
  const next = state.players.find((p) => !(p.id in bids));
  if (next) {
    const already = state.players.filter((p) => p.id in bids);
    const prompt = already.length
      ? `拍卖出价（已出价 ${already.length}/${state.players.length}）`
      : '拍卖：请出价';
    return makePendingFor(ctx, key, next.id, prompt, [
      { value: '0', label: '不出价（0）' },
      { value: '50', label: '出价 50 金钱' },
      { value: '100', label: '出价 100 金钱' },
      { value: '200', label: '出价 200 金钱' },
    ]);
  }

  // 出价收齐 → 结算
  const entries = state.players.map((p) => ({ p, bid: Math.max(0, bids[p.id] ?? 0) }));
  // 形态判别：params [2]（→ {1}=2）是"总统造访"，其余按"拍卖"处理
  const penaltyMode = Number(params[0] ?? 0) === 2;
  const maxBid = Math.max(...entries.map((e) => e.bid));
  const minBid = Math.min(...entries.map((e) => e.bid));

  if (penaltyMode) {
    // 所有出价都要付；最低出价者额外 -出价额 齿轮
    for (const { p, bid } of entries) {
      if (bid > 0) transferRes(p, undefined, 'money', bid);
    }
    const losers = entries.filter((e) => e.bid === minBid);
    for (const { p, bid } of losers) {
      const lost = -addRes(p, 'score', -bid);
      log(state, p.id, `「总统造访」最低出价（${bid}）：付 ${bid} 金钱，-${lost} ${RES_LABEL.score}`);
    }
    if (!losers.length) log(state, ctx.ownerId, '「总统造访」：无人出价');
  } else {
    // 只有最高出价者付钱，并 +出价额 齿轮（并列时都算）
    const winners = entries.filter((e) => e.bid === maxBid && e.bid > 0);
    if (!winners.length) {
      log(state, ctx.ownerId, '「拍卖」：无人出价，流拍');
    }
    for (const { p, bid } of winners) {
      transferRes(p, undefined, 'money', bid);
      addRes(p, 'score', bid);
      log(state, p.id, `「拍卖」最高出价（${bid}）：付 ${bid} 金钱，+${bid} ${RES_LABEL.score}`);
    }
  }

  ctx.scratch = { ...ctx.scratch, __bids: '' };
  return undefined;
}

function handleSelect(
  state: EngineState,
  ctx: ActionContext,
  kind: ActionType,
  slots: ParamSlot[],
): RunResult | undefined {
  const o = owner(state, ctx);
  const pre = takeChoice(ctx, kind);

  // 记录来源卡 id，供 Teleport(Card) 之类使用
  if (ctx.scratch?.sourceCardId) {
    // no-op：由调用方写入
  } else if (o.lastMoveCardId) {
    ctx.scratch = { ...ctx.scratch, sourceCardId: o.lastMoveCardId };
  }

  switch (kind) {
    case 'SelectOpponent': {
      if (pre) { ctx.targets = pre; return undefined; }
      const others = state.players.filter((p) => p.id !== o.id);
      if (others.length === 0) { ctx.targets = [o.id]; return undefined; }
      if (others.length === 1) { ctx.targets = [others[0].id]; return undefined; }
      // 带选择条件的形态（如"罪恶最高"）：参数为文本 id，暂按普通选择处理
      return makePending(ctx, kind, `选择一名玩家（${ctx.source}）`,
        others.map((p) => ({
          value: p.id,
          label: `${nameOf(p)}（${RES_LABEL.malice} ${p.res.malice}，${RES_LABEL.money} ${p.res.money}）`,
        })));
    }

    case 'SelectSelf': {
      ctx.targets = [o.id];
      return undefined;
    }

    case 'SelectEvil': {
      if (pre) { ctx.targets = pre; return undefined; }
      const max = Math.max(...state.players.map((p) => p.res.malice));
      const evil = state.players.filter((p) => p.res.malice === max);
      if (evil.length <= 1) { ctx.targets = evil.map((p) => p.id); return undefined; }
      return makePending(ctx, kind, `选择一名${RES_LABEL.malice}最高的玩家`,
        evil.map((p) => ({ value: p.id, label: `${nameOf(p)}（${RES_LABEL.malice} ${p.res.malice}）` })));
    }

    case 'SelectGovernor': {
      if (pre) { ctx.targets = pre; return undefined; }
      const mayor = state.players.find((p) => p.id === state.mayorId);
      if (mayor) { ctx.targets = [mayor.id]; return undefined; }
      return makePending(ctx, kind, '当前无镇长，选择一名玩家',
        state.players.map((p) => ({ value: p.id, label: nameOf(p) })));
    }

    case 'SelectDeckCard': {
      if (pre) {
        // 玩家已选好牌：从牌堆移除并加入手牌（替代正常补抽）
        const cardId = pre[0];
        const idx = state.deck.lastIndexOf(cardId);
        if (idx >= 0) {
          state.deck.splice(idx, 1);
          owner(state, ctx).hand.push(cardId);
          log(state, ctx.ownerId, `${ctx.source}：从牌堆选得「${CARD_BY_ID[cardId]?.text.name ?? cardId}」`);
        }
        ctx.scratch = { ...ctx.scratch, deckCardId: cardId };
        return undefined;
      }
      const n = firstNumber(slots, 1) || 1;
      const sample = state.deck.slice(-Math.min(n, state.deck.length));
      if (!sample.length) return undefined;
      return makePending(ctx, kind, `从牌堆选择 ${n} 张牌`,
        sample.map((id) => {
          const c = CARD_BY_ID[id];
          return { value: id, label: c ? `${c.text.name}（移动 ${c.move}）` : id };
        }), { min: n, max: n });
    }

    case 'SelectPermanent': {
      if (pre) { ctx.scratch = { ...ctx.scratch, permanentId: pre[0] }; return undefined; }
      const pool = state.players.flatMap((p) => p.permanents);
      if (!pool.length) return undefined;
      return makePending(ctx, kind, '选择一张永久卡',
        pool.map((id) => ({ value: id, label: CARD_BY_ID[id]?.text.name ?? id })));
    }

    case 'NameLocation': {
      if (pre) { ctx.scratch = { ...ctx.scratch, placeId: pre[0] }; return undefined; }
      const buildings = buildingCellIds(state);
      if (!buildings.length) return undefined;
      return makePending(ctx, kind, '选择一个地点',
        buildings.map((id) => ({ value: id, label: cellLabel(getCell(state, id)) })));
    }

    case 'Teleport': {
      // Teleport(Card)：传送到"这张牌可打出的地点"
      const tag = slots.find((s) => s.kind === 'tag')?.value;
      if (tag === 'Card') {
        const cardId = ctx.scratch?.sourceCardId ?? o.lastMoveCardId;
        const card = cardId ? CARD_BY_ID[cardId] : undefined;
        if (card?.cellTypeId && card.cellTypeId !== '0') {
          const cell = getMap(state).cells.find((c) => c.cellTypeId === card.cellTypeId);
          if (cell) {
            o.cellId = cell.id;
            log(state, o.id, `传送到 ${cellLabel(cell)}`);
            return undefined;
          }
        }
        return undefined;
      }
      // params 可能是 cellType ID（十六进制），需要转换后查格子。
      //
      // ⚠️ 这里原先写成 `if (cellTypeIds.length > 0 && !pre)` ——
      // 只在**首次**通过时按类型过滤，**重放**（`pre` 已存在）时整个跳过，
      // 直接落到下面"列出地图上所有格子"的兜底分支。
      // 于是 a024「翻筋斗」（参数=赌博站点的 cellTypeId）会给出**全部 67 格**，
      // 连收入格都能传送 —— 用户报的正是这个。
      // 现在不区分首次/重放：过滤后若只剩 1 格就直接用（重放路径）。
      const cellTypeIds = slots
        .filter((s) => s.kind === 'id')
        .map((s) => s.value)
        .filter(Boolean);
      if (cellTypeIds.length > 0) {
        // 把 hex cellType ID 转成 decimal，找棋盘上对应类型的格子
        const destCells: { id: string; label: string }[] = [];
        for (const hex of cellTypeIds) {
          let dec: string;
          try { dec = BigInt('0x' + hex).toString(); } catch { dec = hex; }
          const cells = getMap(state).cells.filter((c) => c.cellTypeId === dec);
          for (const cell of cells) {
            destCells.push({ id: cell.id, label: cellLabel(cell) });
          }
        }
        if (destCells.length === 1) {
          o.cellId = destCells[0].id;
          log(state, o.id, `传送到 ${destCells[0].label}`);
          return undefined;
        }
        if (destCells.length > 1) {
          // 重放时玩家已选好 → 直接用他选的那一格（并校验它合法）
          if (pre && destCells.some((d) => d.id === pre[0])) {
            o.cellId = pre[0]!;
            log(state, o.id, `传送到 ${cellLabel(getCell(state, pre[0]!))}`);
            return undefined;
          }
          return makePending(ctx, kind, `选择传送目的地（${ctx.source}）`,
            destCells.map((d) => ({ value: d.id, label: d.label })));
        }
        // 参数给了类型但**棋盘上没有这种格子** → 不能退化成"任意地点"。
        // 宁可原地不动并写日志，也不要给出非法目的地。
        log(state, o.id, `传送到指定地点（棋盘上无此类格子，原地不动）`);
        return undefined;
      }
      const dest = firstId(slots) ?? ctx.scratch?.placeId;
      if (dest) {
        o.cellId = dest;
        log(state, o.id, `传送到 ${cellLabel(getCell(state, dest))}`);
        return undefined;
      }
      if (pre) {
        o.cellId = pre[0];
        log(state, o.id, `传送到 ${cellLabel(getCell(state, pre[0]))}`);
        return undefined;
      }
      const ids = mapCellIds(state);
      if (!ids.length) return undefined;
      return makePending(ctx, kind, '选择传送目的地',
        ids.map((id) => ({ value: id, label: cellLabel(getCell(state, id)) })));
    }

    default: {
      if (pre) { ctx.scratch = { ...ctx.scratch, [kind]: pre[0] }; return undefined; }
      return undefined;
    }
  }
}

/**
 * 解析"传送目的地"参数 → 棋盘上的候选格子。
 *
 * ⚠️ 这是**唯一**该做这件事的地方。原实现有两份：
 *  - `handleSelect` 的 `Teleport` 分支（过滤后给出候选，正确）
 *  - `runPrimitive` 的 `OpponentTeleport` 分支（直接 `firstId(slots)` 当格 id 用，**错**）
 *
 * 而卡牌参数里存的是**格子类型 id**（形如 `D6534DE007B18E10`，是 cellType 的
 * hex），**不是**格 id。于是 `OpponentTeleport` 会把玩家的位置写成那个 key ——
 * 一个不存在的"格子"，后续所有 `getCell` 都失败。
 * 实测 a163「审判日」把对手传送到办公室 key `D6534DE007B18E10`（用户可见的位置异常）。
 *
 * @returns 候选格列表（0 个表示参数不是格子类型 id，或棋盘上没这种格子）
 */
export function teleportTargetCells(state: EngineState, params: string[]): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const raw of params) {
    // 语义标记（All / Card / Opponent）不是格子类型 id，交给调用方另行处理
    if (/^(All|Card|Opponent)$/i.test(raw)) continue;
    let dec = raw;
    if (!/^\d+$/.test(raw)) {
      try { dec = BigInt('0x' + raw).toString(); } catch { continue; }
    }
    for (const cell of getMap(state).cells) {
      if (String(cell.cellTypeId) === dec || cell.id === raw) {
        out.push({ id: cell.id, label: cellLabel(cell) });
      }
    }
  }
  return out;
}

/** 所有建筑格 id */
export function buildingCellIds(state: EngineState): string[] {
  return getMap(state).cells.filter((c) => {
    const cellType = c.cellType;
    return ['Office', 'Plant', 'Junkyard', 'Marketplace', 'Inferno', 'Jail',
      'Casino', 'Courthouse', 'Treasure', 'Bank', 'Astral', 'Tribune'].includes(cellType);
  }).map((c) => c.id);
}

function cardPlayableAtCell(state: EngineState, cardId: string, cellId: string): boolean {
  const card = CARD_BY_ID[cardId];
  if (!card) return false;
  if (!card.cellTypeId || card.cellTypeId === '0') return true;
  const cell = getCell(state, cellId);
  return !!cell && cell.cellTypeId === card.cellTypeId;
}

// ---------------------------------------------------------------- 资源损失
function handleResourceLoss(
  state: EngineState,
  ctx: ActionContext,
  kind: ActionType,
  slots: ParamSlot[],
): RunResult | undefined {
  const o = owner(state, ctx);

  // ── 门控 tag：不满足就**整段跳过**（不是改成别的数值）──
  //
  // `Governor`：只有当前总督才能享受/承担这条效果。
  //   a090「…」：`OpponentLoseMoney(-300|Governor)` — "**If you're the Governor**: +{1}$, +{2}^."
  //   旧实现忽略该 tag，导致**非总督打出也能白拿 +300$ 和 +3^**（实测确认）。
  //   这类"整段跳过"的语义与 `OpponentArrest(Evil)` 一致（不满足恶意条件就不逮捕）。
  if (hasTag(slots, 'Governor') && state.mayorId !== o.id) {
    log(state, o.id, `${ctx.source}：需为总督才生效，跳过`);
    return undefined;
  }

  // `Permanent`：按目标**已激活永久卡数量**计费（a045「房产税」）
  //   「其他玩家每拥有一张当前已激活的永久卡牌，则给你 {1}$。」
  //   数据 `OpponentPayMoney(Permanent|50)` 的 50 是**每张**永久卡的单价。
  const permanentPer = hasTag(slots, 'Permanent') ? firstNumber(slots, 0) : 0;

  /** 本动作实际收到的总数（a156 的 moneybonus/malicebonus 要按它结算） */
  let receivedTotal = 0;

  for (const tgt of targetPlayers(state, ctx)) {
    // ── `HaltFailed` 门控：付不出就**整段不生效** ──
    //
    // a179「昂贵的命令」：「该玩家必须支付 {1}$ 才能获得 {2}* 并失去 {3}^。
    //   如果无法全额支付：其不会支付或者失去什么，但仅获得 {4}^（不会获得*）。」
    // 数据只写了前半段（付款 → 加齿轮 → 减齿轮 → 加罪恶），
    // `HaltFailed` 表示"付不出就全都别做"，还要把**后面的动作一起停掉**。
    if (hasTag(slots, 'HaltFailed')) {
      const need = firstNumber(slots, 0);
      if (tgt.res.money < need) {
        // 「但仅获得 {4}^」——`oppmalicepenalty|3` 里的 3 即替代罪恶
        const penalty = firstNumber(takeTaggedNumbers(slots, 'oppmalicepenalty'), 0);
        if (penalty > 0) {
          addRes(tgt, 'malice', penalty);
          log(state, tgt.id, `${nameOf(tgt)} 无力支付 ${need} 金钱：仅获得 +${penalty} 罪恶`);
        } else {
          log(state, tgt.id, `${nameOf(tgt)} 无力支付 ${need} 金钱：本效果整段不生效`);
        }
        ctx.haltRest = true;
        return undefined;
      }
    }

    // `Permanent`：按目标持有的永久卡数量付款，与 `OpponentPayMoney` 同义
    if (permanentPer > 0) {
      const count = tgt.permanents?.length ?? 0;
      if (count > 0) {
        const r = payAmount(tgt, o, [{ kind: 'number', value: permanentPer * count }],
          { defaultKey: 'money' });
        receivedTotal += r.paid;
        log(state, tgt.id,
          `${nameOf(tgt)} 有 ${count} 张永久卡，付 ${r.paid} 金钱给 ${nameOf(o)}`);
      }
      continue;
    }

    switch (kind) {
      case 'OpponentLoseVotes':
      case 'OpponentLoseScore':
      case 'OpponentLoseMalice':
      case 'OpponentLoseIncome': {
        const key: ResourceKey =
          kind === 'OpponentLoseVotes' ? 'vote'
          : kind === 'OpponentLoseScore' ? 'score'
          : kind === 'OpponentLoseMalice' ? 'malice'
          : 'income';
        const amount = firstNumber(slots, 0);
        // ⚠️ 负参数 = **获得**，不是忽略。
        // 卡牌数据用 `OpponentLoseXxx(-N)` 表达"目标 +N"，
        // 例如 a074「魔幻饰品」移动时 `OpponentLoseMoney(-20)` 即 +20$，
        // a017 `OpponentLoseMalice(-1)` 即 +1^。
        // 旧实现写成 `if (amount > 0)`，于是这些"获得"分支被整体静默丢弃。
        if (amount === 0) break;
        if (amount > 0) {
          const lost = -addRes(tgt, key, -amount);
          log(state, tgt.id, `${nameOf(tgt)} 失去 ${lost} ${RES_LABEL[key]}`);
        } else {
          const got = addRes(tgt, key, -amount);
          log(state, tgt.id, `${nameOf(tgt)} 获得 ${got} ${RES_LABEL[key]}`);
        }
        break;
      }

      case 'OpponentPayMoney':
      case 'OpponentPayScore': {
        const key: ResourceKey = kind === 'OpponentPayMoney' ? 'money' : 'score';
        // `Poorest` tag：出牌者是全场最穷时金额**翻倍**（a011）。
        // 判定用**出牌者** `o`，不是付款方——牌面写的是
        // "If **you** have the least $, they give you twice as much."
        //
        // 这里不 import `abilities.isPoorest`：`abilities.ts` 已经 import 本文件，
        // 再反向依赖会形成环。判定只有一行，就地写更安全。
        const poorestDouble = hasTag(slots, 'Poorest')
          && o.res.money === Math.min(...state.players.map((x) => x.res.money));
        const r = payAmount(tgt, o, slots, { defaultKey: key, poorestDouble });
        receivedTotal += r.paid;
        log(state, tgt.id,
          `${nameOf(tgt)} 支付 ${r.paid} ${RES_LABEL[r.key]} 给 ${nameOf(o)}`
          + (poorestDouble ? '（出牌者最穷，金额翻倍）' : ''));
        if (hasTag(slots, 'GetHalf') && r.paid > 0) {
          const half = Math.floor(r.paid / 2);
          transferRes(o, tgt, r.key, half);
          log(state, o.id, `返还一半 ${half} ${RES_LABEL[r.key]} 给 ${nameOf(tgt)}`);
        }
        if (!r.full && hasTag(slots, 'Arrest')) arrest(state, tgt, `${ctx.source}：无力足额支付`);
        break;
      }

      case 'OpponentLoseMoney': {
        // 「失去」不是「支付」：钱不进任何人口袋，直接蒸发。
        // 之前把 payee 传成 ctx 的 owner —— 而厄运牌的 ownerId/targets 都是自己，
        // 于是 transferRes 把钱"转给自己"，净变化为 0（`-{1}$` 分支完全没生效）。
        //
        // ⚠️ 负参数 = **获得**（`OpponentLoseMoney(-20)` 即目标 +20$）。
        // `transferRes` 会把负数夹成 0，所以负值必须走 `addRes` 而不是 `payAmount`，
        // 否则 a074/a150 这类"移动时 +N$"的卡会被静默丢弃。
        //
        // `Percent` tag = 按目标当前持有量的百分比扣（a139：`Percent|50`
        // = "they -{2}% of their $"，即扣掉 50% 的金钱，不是扣 50）
        if (hasTag(slots, 'Percent')) {
          const pct = firstNumber(slots, 0) || 0;
          const lost = Math.floor((tgt.res.money * pct) / 100);
          if (lost > 0) {
            addRes(tgt, 'money', -lost);
            log(state, tgt.id, `${nameOf(tgt)} 失去 ${lost} 金钱（${pct}%）`);
          }
          break;
        }
        const negAmount = firstNumber(slots, 0);
        if (negAmount < 0) {
          const got = addRes(tgt, 'money', -negAmount);
          log(state, tgt.id, `${nameOf(tgt)} 获得 ${got} ${RES_LABEL.money}`);
          break;
        }
        const r = payAmount(tgt, undefined, slots, { defaultKey: 'money' });
        log(state, tgt.id, `${nameOf(tgt)} 失去 ${r.paid} ${RES_LABEL[r.key]}`);
        if (!r.full && hasTag(slots, 'Arrest')) arrest(state, tgt, `${ctx.source}：无力足额支付`);
        break;
      }
    }
  }

  // ── `moneybonus` / `malicebonus`：按**实际收到**的数量给奖励 ──
  //
  // a156「Demon'stration」：「每个玩家给你 {1}*。每收到 1 个 *：你 +{2}$、+{3}^。」
  // 数据 `OpponentPayScore(1|moneybonus|50|malicebonus|1)`。
  //
  // 必须**在循环之后**结算：奖励按"实际到手的齿轮总数"计算，
  // 而对手可能因为齿轮不足而少给（`payAmount` 会夹取），
  // 所以不能用名义值（`{1}` × 人数）来算。
  if (receivedTotal > 0) {
    const moneyPer = firstNumber(takeTaggedNumbers(slots, 'moneybonus'), 0);
    const malicePer = firstNumber(takeTaggedNumbers(slots, 'malicebonus'), 0);
    if (moneyPer > 0) {
      addRes(o, 'money', moneyPer * receivedTotal);
      log(state, o.id, `每收到 1 齿轮 +${moneyPer}$：共 ${receivedTotal} → +${moneyPer * receivedTotal}$`);
    }
    if (malicePer > 0) {
      addRes(o, 'malice', malicePer * receivedTotal);
      log(state, o.id, `每收到 1 齿轮 +${malicePer}^：共 ${receivedTotal} → +${malicePer * receivedTotal}^`);
    }
  }
  return undefined;
}
