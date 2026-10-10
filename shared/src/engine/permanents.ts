// =============================================================
// 永久卡效果（Perm_*）与事件钩子层
//
// 33 张永久卡的 `Perm_*` 动作分两类，必须区别对待：
//
//  A. 数值型：打出时立即改写玩家属性
//       Perm_Income(10)  → 收入 +10
//       Perm_Bribe(10)   → 其他玩家的贿赂 +10（记录为修正值）
//
//  B. 触发型：打出后不立即生效，而是在某个**事件**发生时由持卡者受益
//       Perm_CasinoMoney(25) → 任意玩家进赌场时，持卡者 +25 金
//       Perm_SpeedPay(20)    → 任意玩家用 5/6 点卡移动时，向持卡者付 20 金
//
// 触发型必须有事件钩子：PERM_TRIGGERS 把每个 Perm_* 原语映射到
// 「触发事件 + 作用域 + 数值来源」，引擎在对应时机调用 fireTrigger()。
//
// 规格来源：每张卡的英文原文说明（test/data/action_cards.json），例如
//   a118 One-armed bandit = "When any player (including you) visits the
//   Casino: you +25$" → { event:'anyVisitCasino', who:'holder', key:'money', fromParam:0 }
// =============================================================
import type { CardAction, EnginePlayer, EngineState } from './model.js';
import { CARD_BY_ID, getCell, getMap } from './model.js';
import { addRes, firstNumber, parseParams, transferRes } from './resources.js';
import { random } from './interp.js';

// ---------------------------------------------------------------- 触发事件
/**
 * 触发事件清单。每个事件在引擎对应位置调用 fireTrigger()。
 */
export type TriggerEvent =
  /** 永久卡刚刚被打出并激活（一次性） */
  | 'cardActivated'
  | 'playSecret'            // 你打出秘密卡
  | 'anyPlaySecret'         // 任一玩家打出秘密卡
  | 'mustGetMisfortune'     // 你即将获得厄运
  | 'playCardGainMalice'    // 你打出卡牌并获得罪恶
  | 'anyMove'               // 任意玩家用卡牌移动
  | 'afterPlayAction'       // 你打出效果卡之后
  | 'beforeArrest'          // 你即将被捕
  | 'anyArrest'             // 任意玩家被捕
  | 'anyVisitCasino'        // 任意玩家进赌场
  | 'otherVisitCasino'      // 其他玩家进赌场
  | 'casinoGamble'          // 你在赌场赌博
  | 'anyVisitJunkyard'      // 任意玩家进垃圾场
  | 'visitTreasure'         // 你进藏宝阁
  | 'visitPlant'            // 你进工厂
  | 'visitBank'             // 你进银行
  | 'gambleSpot'            // 你在冒险/赌博格试手气
  | 'bankInvest'            // 银行投资
  | 'marketSellScore'       // 在市場卖齿轮
  | 'playerConflict'        // 玩家交锋
  | 'bribeSpot'             // 经过贿赂格
  | 'policePayBribe'        // 经过警察格并选择付贿赂
  | 'anyLongMove'           // 任意玩家用 5/6 点卡移动
  | 'moveWithOne'           // 你用 1 点卡移动
  | 'ownTurnStart'          // 你自己的回合开始
  | 'ownTurnEnd'            // 你自己的回合结束
  | 'roundEnd'              // 每轮结束
  | 'anyPermanentDiscarded' // 任意已激活永久卡被弃置
  | 'loseConflict';         // 你输掉玩家交锋

type ResKey = 'money' | 'vote' | 'malice' | 'score' | 'income' | 'term';

/** 一条永久卡触发规格 */
export interface TriggerSpec {
  /**
   * 触发事件。可以是数组——同一张卡可能挂在多个时机上，
   * 例如「借口编造器」(`Perm_BribeSkip`) 同时作用于**贿赂格**与**警察格**：
   *   "50% chance to avoid ~ on Bribe spots.
   *    50% chance to avoid ~ on Police spots (when you choose to pay ~ there)."
   */
  event: TriggerEvent | TriggerEvent[];
  /** 受益者 / 承受者 */
  who: 'holder' | 'other' | 'allPlayers';
  key?: ResKey;
  /** 固定数值；给了 fromParam 时以参数为准 */
  value?: number;
  /** 从动作参数里取第 N 个数值（0 起） */
  fromParam?: number;
  /** 特殊行为标记 */
  flag?: string;
  note?: string;
}

/**
 * Perm_* 原语 → 触发规格。
 */
export const PERM_TRIGGERS: Record<string, TriggerSpec | TriggerSpec[]> = {
  // ---- 数值型：打出时一次性生效（cardActivated），不能放在 ownTurnStart，
  //      否则会变成"每回合都加一次收入"。 ----
  Perm_Income: { event: 'cardActivated', who: 'holder', key: 'income', fromParam: 0, flag: 'immediate' },
  Perm_Bribe: { event: 'cardActivated', who: 'holder', flag: 'bribeBonus', fromParam: 0, note: '其他玩家贿赂 +N' },
  Perm_BankIncome: { event: 'visitBank', who: 'holder', key: 'income', fromParam: 0 },
  Perm_ScoreIncome: { event: 'roundEnd', who: 'holder', key: 'score', fromParam: 0 },

  // ---- 秘密卡 ----
  Perm_SecretVote: { event: 'playSecret', who: 'holder', key: 'vote', fromParam: 0 },
  Perm_Secret_Police: { event: 'anyPlaySecret', who: 'other', key: 'money', fromParam: 0, flag: 'secretPolice' },

  // ---- 厄运 ----
  Perm_MFSkip: { event: 'mustGetMisfortune', who: 'holder', flag: 'skipMisfortune' },

  // ---- 赌场 ----
  Perm_CasinoMoney: { event: 'anyVisitCasino', who: 'holder', key: 'money', fromParam: 0 },
  Perm_CasinoVote: { event: 'otherVisitCasino', who: 'holder', key: 'vote', fromParam: 0 },
  Perm_CasinoRoll: { event: 'casinoGamble', who: 'holder', flag: 'reroll' },

  // ---- 地点收益 ----
  Perm_JunkyardPay: { event: 'anyVisitJunkyard', who: 'other', key: 'money', fromParam: 0 },
  Perm_TreasureMoney: { event: 'visitTreasure', who: 'holder', key: 'money', fromParam: 0 },
  Perm_Plant_Money: { event: 'visitPlant', who: 'holder', key: 'money', fromParam: 0 },
  Perm_RiskBonus: { event: 'gambleSpot', who: 'holder', key: 'money', fromParam: 0 },
  Perm_Banker: { event: 'bankInvest', who: 'holder', key: 'money', flag: 'equalToInvestment' },
  Perm_Trader: { event: 'marketSellScore', who: 'holder', key: 'income', fromParam: 0 },

  // ---- 移动 ----
  Perm_SpeedPay: { event: 'anyLongMove', who: 'other', key: 'money', fromParam: 0 },
  Perm_MoveMoney: { event: 'moveWithOne', who: 'holder', key: 'money', fromParam: 0 },
  Perm_AstralElevator: { event: 'afterPlayAction', who: 'holder', flag: 'astralFromBank' },
  Perm_ExtraCard: { event: 'afterPlayAction', who: 'holder', flag: 'extraCardSamePlace' },

  // ---- 逮捕与刑期 ----
  Perm_Jail: { event: 'anyArrest', who: 'holder', flag: 'jailTermModifier' },
  Perm_SkipArrest: { event: 'beforeArrest', who: 'holder', flag: 'skipArrestTeleport', note: '参数为替代地点' },
  Perm_JailMoney: { event: 'ownTurnStart', who: 'holder', flag: 'jailStipend' },

  // ---- 贿赂规避 ----
  // 「借口编造器」同时作用于贿赂格与警察格（英文原文明确，中文漏译了后者）
  Perm_BribeSkip: { event: ['bribeSpot', 'policePayBribe'], who: 'holder', flag: 'chanceSkip' },

  // ---- 交锋 ----
  Perm_Conflict: { event: 'playerConflict', who: 'holder', key: 'score', fromParam: 0 },

  // ---- 罪恶相关：打出给罪恶的牌时 +N 金 ----
  Perm_EvilBonus: { event: 'playCardGainMalice', who: 'holder', key: 'money', fromParam: 0 },

  // ---- 回合末 / 弃置 ----
  Perm_Chaos: { event: 'roundEnd', who: 'other', key: 'score', fromParam: 0, flag: 'everySixRounds' },
  Perm_Credit: { event: 'ownTurnStart', who: 'holder', flag: 'creditDebt' },
  Perm_Discard: { event: 'ownTurnEnd', who: 'holder', flag: 'discardIfNoAction' },
  Perm_DiscardFirst: { event: 'anyPermanentDiscarded', who: 'holder', flag: 'resurrectPermanent' },

  // ---- 组合型 ----
  Perm_Takeover: { event: 'loseConflict', who: 'holder', flag: 'giveAncientDetail' },
  Perm_Gather: { event: 'roundEnd', who: 'holder', flag: 'gatherAncient' },
  Perm_Complete_Set: { event: 'roundEnd', who: 'holder', flag: 'corporateScam' },
};

// ---------------------------------------------------------------- 索引
export interface TriggerHit {
  spec: TriggerSpec;
  holder: EnginePlayer;
  cardId: string;
  value: number;
  /** 原始参数串，便于特殊处理 */
  params: string[];
}

/** 找出场上所有对某事件有反应的永久卡 */
export function collectTriggers(state: EngineState, event: TriggerEvent): TriggerHit[] {
  const out: TriggerHit[] = [];
  for (const holder of state.players) {
    for (const cardId of holder.permanents) {
      const card = CARD_BY_ID[cardId];
      if (!card) continue;
      for (const action of card.actions) {
        const raw = PERM_TRIGGERS[action.type as string];
        if (!raw) continue;
        for (const spec of Array.isArray(raw) ? raw : [raw]) {
          const evs = Array.isArray(spec.event) ? spec.event : [spec.event];
          if (!evs.includes(event)) continue;
          const slots = parseParams(action.params);
          out.push({
            spec,
            holder,
            cardId,
            value: spec.value ?? firstNumber(slots, 0),
            params: action.params ?? [],
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 触发执行
export interface TriggerContext {
  /** 事件发起者 */
  actorId?: string;
  /** 附加数值（投资额、移动步数等） */
  amount?: number;
  /** 事件涉及格子 */
  cellId?: string;
  /** 回填给调用方的标记 */
  flags?: Record<string, string | number | boolean>;
  /**
   * 仅考虑这一张永久卡的效果。
   * 用于一次性事件（cardActivated）——否则刚打出的卡会连带触发
   * 别人已激活的 Perm_* 效果（例如自己被「寡头」误弃）。
   */
  onlyCardId?: string;
}

/**
 * 触发某事件上的全部永久卡效果。
 * @returns 命中的效果数量
 */
export function fireTrigger(
  state: EngineState,
  event: TriggerEvent,
  ctx: TriggerContext = {},
): number {
  let hits = collectTriggers(state, event);
  if (ctx.onlyCardId) hits = hits.filter((h) => h.cardId === ctx.onlyCardId);
  if (!hits.length) return 0;

  let fired = 0;
  for (const hit of hits) {
    const { spec, holder, cardId, value, params } = hit;
    const cardName = CARD_BY_ID[cardId]?.text.name ?? cardId;
    const actor = ctx.actorId ? state.players.find((p) => p.id === ctx.actorId) : holder;

    if (spec.flag) {
      const handled = handleFlag(state, { spec, holder, actor, ctx, value, params, cardName, cardId });
      if (handled) { fired++; continue; }
    }

    if (!spec.key) continue;
    const n = spec.flag === 'equalToInvestment' ? (ctx.amount ?? 0) : value;
    if (!n) continue;

    switch (spec.who) {
      case 'holder':
        addRes(holder, spec.key, n);
        logIt(state, holder, `永久卡「${cardName}」：+${n} ${RES_ZH[spec.key]}`);
        fired++;
        break;
      case 'other':
        if (actor && actor.id !== holder.id) {
          const r = transferRes(actor, holder, spec.key, n);
          if (r.moved > 0) {
            logIt(state, holder,
              `永久卡「${cardName}」：${actor.name} 支付 ${r.moved} ${RES_ZH[spec.key]} 给 ${holder.name}`);
            fired++;
          }
        }
        break;
      case 'allPlayers':
        for (const p of state.players) addRes(p, spec.key, n);
        logIt(state, holder, `永久卡「${cardName}」：全体 ${n >= 0 ? '+' : ''}${n} ${RES_ZH[spec.key]}`);
        fired++;
        break;
      default:
        break;
    }
  }
  return fired;
}

const RES_ZH: Record<ResKey, string> = {
  money: '金钱', vote: '选票', malice: '罪恶',
  score: '齿轮', income: '收入', term: '刑期',
};

interface FlagArgs {
  spec: TriggerSpec;
  holder: EnginePlayer;
  actor: EnginePlayer | undefined;
  ctx: TriggerContext;
  value: number;
  params: string[];
  cardName: string;
  cardId: string;
}

/** 处理带特殊标记的效果，返回 true 表示已处理 */
function handleFlag(state: EngineState, a: FlagArgs): boolean {
  const { spec, holder, actor, ctx, value, params, cardName, cardId } = a;
  const isSelf = ctx.actorId === holder.id;

  switch (spec.flag) {
    // 厄运免疫：弃置此卡代替获得厄运
    case 'skipMisfortune': {
      if (!isSelf) return false;
      if (ctx.flags) ctx.flags.misfortuneSkipped = true;
      discardPermanent(state, holder, cardId, cardName);
      return true;
    }

    // 赌场重掷许可
    case 'reroll': {
      if (isSelf && ctx.flags) ctx.flags.rerollAllowed = true;
      return true;
    }

    // 同地点再打一张
    case 'extraCardSamePlace': {
      if (!isSelf) return false;
      holder.extraTurns += 1;
      logIt(state, holder, `永久卡「${cardName}」：同地点可再打一张卡`);
      return true;
    }

    // 从银行直达天界
    case 'astralFromBank': {
      if (ctx.flags) ctx.flags.astralFromBank = true;
      return true;
    }

    // 刑期修正：自己 -1，他人 +1
    case 'jailTermModifier': {
      if (!actor) return false;
      if (actor.id === holder.id) {
        actor.term = Math.max(0, actor.term - 1);
        logIt(state, actor, `永久卡「${cardName}」：自己的刑期 -1`);
      } else {
        actor.term += 1;
        logIt(state, actor, `永久卡「${cardName}」：${actor.name} 的刑期 +1`);
      }
      return true;
    }

    // 豁免逮捕并传送到替代地点，随后弃卡
    case 'skipArrestTeleport': {
      if (!isSelf) return false;
      const dest = params.find((p) => /^[A-Z][A-Za-z]+$/.test(p)) ?? 'Casino';
      const cellId = getMap(state).cells.find((c) => c.cellType === dest)?.id;
      if (cellId) holder.cellId = cellId;
      if (ctx.flags) ctx.flags.arrestSkipped = true;
      discardPermanent(state, holder, cardId, cardName);
      logIt(state, holder,
        `永久卡「${cardName}」：豁免逮捕，传送到 ${cellLabelOf(state, cellId ?? holder.cellId)}`);
      return true;
    }

    // 概率规避
    case 'chanceSkip': {
      if (!isSelf) return false;
      const ok = random(state) < 0.5;
      if (ctx.flags) ctx.flags.bribeSkipped = ok;
      logIt(state, holder, `永久卡「${cardName}」：${ok ? '成功规避' : '规避失败'}`);
      return true;
    }

    // 服刑津贴：参数为 [监狱中金额, 持卡者金额]
    case 'jailStipend': {
      const nums = paramNumbers(params);
      const base = nums[0] ?? 25;
      const boosted = nums[1] ?? base * 2;
      if (!holder.inJail) return true;
      const amount = holder.permanents.includes(cardId) ? boosted : base;
      addRes(holder, 'money', amount);
      logIt(state, holder, `永久卡「${cardName}」：服刑津贴 +${amount} 金`);
      return true;
    }

    // 每 6 回合
    case 'everySixRounds': {
      if (state.round % 6 !== 0) return false;
      for (const p of state.players) {
        if (p.id === holder.id) continue;
        addRes(p, 'score', -value);
      }
      logIt(state, holder, `永久卡「${cardName}」：回合 ${state.round}，其他玩家各 -${value} 齿轮`);
      return true;
    }

    // 每回合信用贷扣款：参数为 [每回合应还, 付不出时的齿轮惩罚]
    case 'creditDebt': {
      if (!isSelf) return false;
      const nums = paramNumbers(params);
      const owe = nums[0] ?? 25;
      const penalty = nums[1] ?? 3;
      if (holder.res.money >= owe) {
        addRes(holder, 'money', -owe);
        logIt(state, holder, `永久卡「${cardName}」：-${owe} 金`);
      } else {
        addRes(holder, 'score', -penalty);
        logIt(state, holder, `永久卡「${cardName}」：无力偿还，-${penalty} 齿轮`);
        discardPermanent(state, holder, cardId, cardName);
      }
      return true;
    }

    // 永久卡被弃置时复活并转给持卡者，同时弃掉本卡
    case 'resurrectPermanent': {
      const discardedId = String(ctx.flags?.discardedCardId ?? '');
      if (!discardedId || discardedId === cardId) return false;
      if (holder.permanents.includes(discardedId)) return false;
      holder.permanents.push(discardedId);
      logIt(state, holder,
        `永久卡「${cardName}」：复活「${CARD_BY_ID[discardedId]?.text.name ?? discardedId}」并转给自己`);
      discardPermanent(state, holder, cardId, cardName);
      return true;
    }

    // 秘密警察：付款给持卡者，付不出则弃手牌
    case 'secretPolice': {
      if (!actor || actor.id === holder.id) return true;
      const r = transferRes(actor, holder, 'money', value);
      if (r.moved > 0) {
        logIt(state, holder, `永久卡「${cardName}」：${actor.name} 支付 ${r.moved} 金钱`);
      }
      if (!r.full) {
        state.discard.push(...actor.hand.splice(0));
        logIt(state, actor, `永久卡「${cardName}」：无法足额支付，弃掉全部手牌`);
      }
      return true;
    }

    // 企业骗局：集齐 2 张时结算
    case 'corporateScam': {
      const n = holder.permanents.filter((id) => CARD_BY_ID[id]?.name === CARD_BY_ID[cardId]?.name).length;
      if (n < 2) return false;
      for (const p of state.players) {
        if (p.id === holder.id) {
          addRes(p, 'score', n);
        } else {
          addRes(p, 'score', -1);
        }
      }
      logIt(state, holder, `永久卡「${cardName}」：集齐 ${n} 张，自己 +${n} 齿轮，其他玩家各 -1`);
      return true;
    }

    // 古老部件「收集 consolation」：输掉交锋时从牌堆/弃牌堆获得 1 张 a158
    case 'giveAncientDetail': {
      const a158Id = Object.keys(CARD_BY_ID).find((id) => CARD_BY_ID[id]?.name === 'a158');
      if (!a158Id) return false;
      const qty = paramNumbers(params)[0] ?? 1;
      let given = 0;
      for (let i = 0; i < qty; i++) {
        const di = state.deck.indexOf(a158Id);
        if (di >= 0) {
          state.deck.splice(di, 1);
          holder.permanents.push(a158Id);
          given++;
        } else {
          const dj = state.discard.indexOf(a158Id);
          if (dj >= 0) {
            state.discard.splice(dj, 1);
            holder.permanents.push(a158Id);
            given++;
          }
        }
      }
      if (given > 0) {
        logIt(state, holder,
          `永久卡「${cardName}」：输掉交锋，获得 ${given} 张「${CARD_BY_ID[a158Id]?.text.name ?? a158Id}」`);
      }
      return given > 0;
    }

    // 古老部件「集资」：回合末，若持 3 张 a158 则弃 3 换 1 张 a159
    case 'gatherAncient': {
      const threshold = paramNumbers(params)[0] ?? 3;
      const targetName = params[1] ?? 'a159';
      const a158Id = Object.keys(CARD_BY_ID).find((id) => CARD_BY_ID[id]?.name === 'a158');
      const a159Id = Object.keys(CARD_BY_ID).find((id) => CARD_BY_ID[id]?.name === targetName);
      if (!a158Id || !a159Id) return false;
      const owned = holder.permanents.filter((id) => id === a158Id);
      if (owned.length < threshold) return false;
      // 弃掉 threshold 张 a158
      for (let i = 0; i < threshold; i++) {
        const idx = holder.permanents.indexOf(a158Id);
        if (idx >= 0) {
          holder.permanents.splice(idx, 1);
          state.discard.push(a158Id);
        }
      }
      // 获得 1 张 a159
      holder.permanents.push(a159Id);
      logIt(state, holder,
        `永久卡「${cardName}」：集齐 ${threshold} 张，交换获得「${CARD_BY_ID[a159Id]?.text.name ?? a159Id}」`);
      return true;
    }

    // 贿赂加成 / 立即生效：主数值分支处理即可
    case 'bribeBonus':
    case 'immediate':
      return false;

    default:
      return false;
  }
}

/** 弃置一张永久卡并触发"永久卡被弃置"钩子 */
export function discardPermanent(
  state: EngineState,
  holder: EnginePlayer,
  cardId: string,
  cardName: string,
): void {
  const i = holder.permanents.indexOf(cardId);
  if (i < 0) return;
  const removed = holder.permanents.splice(i, 1)[0];
  state.discard.push(removed);
  logIt(state, holder, `永久卡「${cardName}」被弃置`);
  fireTrigger(state, 'anyPermanentDiscarded', {
    actorId: holder.id,
    flags: { discardedCardId: removed },
  });
}

/**
 * 打出永久卡时应用「立即生效」的部分。
 *
 * 实现要点：**只广播 cardActivated 事件**，不在本函数里直接改属性。
 * 否则 banner 的 immediate 规格会被执行两次（本函数一次 + fireTrigger 一次）。
 * 同时把 Perm_Bribe 类的贿赂加成登记到 flags，供 bribeAmount 读取。
 */
export function applyImmediatePermanents(state: EngineState, holder: EnginePlayer, cardId: string): void {
  const card = CARD_BY_ID[cardId];
  if (!card) return;

  for (const action of card.actions) {
    if (action.type === 'Perm_Bribe') {
      const value = firstNumber(parseParams(action.params), 0);
      if (value) holder.flags[`bribeBonus:${cardId}`] = value;
    }
  }

  // 广播一次性激活事件。
  // 必须用 onlyCardId 限定到刚打出的这张卡：否则会连带触发别人已激活的
  // Perm_* 效果（例如「寡头」会把自己弃掉、「幸运药水」会被误消耗）。
  fireTrigger(state, 'cardActivated', { actorId: holder.id, onlyCardId: cardId });
}

/** 其他玩家施加在我身上的贿赂加成总额（由 Perm_Bribe 类永久卡产生） */
export function extraBribeFrom(state: EngineState, targetId: string): number {
  let extra = 0;
  for (const p of state.players) {
    if (p.id === targetId) continue;
    for (const [k, v] of Object.entries(p.flags)) {
      if (k.startsWith('bribeBonus:') && typeof v === 'number') extra += v;
    }
  }
  return extra;
}

/** 从原始 ActionParams 里按顺序取出全部数值 */
function paramNumbers(params: string[]): number[] {
  return params
    .filter((p) => /^-?\d+$/.test(p))
    .map(Number);
}

function cellLabelOf(state: EngineState, cellId: string): string {
  const c = getCell(state, cellId);
  return c ? (c.text?.caption || c.caption || c.name) : cellId;
}

function logIt(state: EngineState, p: EnginePlayer, text: string): void {
  state.log.push({ round: state.round, playerId: p.id, text, ts: Date.now() });
  if (state.log.length > 400) state.log.shift();
}
