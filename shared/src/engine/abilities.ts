// =============================================================
// 角色能力（数据驱动）
//
// 数据来源：原版 `GCharacter.ActionList` 的 `Xxx_Ability` 原语名 + 原版角色说明。
// 说明文字在 `GameCharacter.text.description` 里（已按 STARTING MODIFIERS /
// HOME LOCATION / CARDS / EVENTS / OTHER EFFECTS 分节），是**规则依据**。
//
// ⚠️ 两个已踩过的坑：
//  1. `ActionParams` 前两个参数是**文本 UIN**（描述用的名字/说明键），
//     数值在第 3 个起。不要拿前两个当参数用。
//  2. 不能按 ActionType 字面直译。例如 `OpponentSkipTurn` 挂在移动牌上时
//     表示「**你自己**跳过下一回合」（卡牌代价），不是让对手跳过。
//     所以本表的每个条目的语义都能在原版英文说明里找到对应句子。
//
// 触发点与永久卡共用：`interp.ts` / `state.ts` 在相应时机调用
// `fireAbility()`，与 `fireTrigger()`（永久卡）并列。
// =============================================================
import type { EnginePlayer, EngineState, GameCharacter } from './model.js';
import { CARD_BY_ID, CHARACTER_BY_ID, cellTypeOf, getCell, getMap } from './model.js';
import { addRes, transferRes } from './resources.js';
import { rollDice } from './interp.js';

/** 角色能力触发时机 */
export type AbilityEvent =
  /** 开局 */
  | 'gameStart'
  /** 造访自己的主场（Home location） */
  | 'visitHome'
  /** 掷骰后（可改判/加奖） */
  | 'afterRoll'
  /** 跳过走牌 */
  | 'skipMove'
  /** 被捕时 */
  | 'arrest'
  /** 玩家交锋开始前（引发方决定是否逃避） */
  | 'beforeConflict'
  /** 用卡移动后（携带步数） */
  | 'afterMove'
  /** 打出卡牌后（携带是否秘密卡/罪恶卡/是否给罪恶） */
  | 'afterPlayCard'
  /** 在市场上卖齿轮 */
  | 'marketSell'
  /** 他在办公楼卖选票 */
  | 'officeSellVotes'
  /** 回合开始 */
  | 'turnStart'
  /** 回合结束 */
  | 'turnEnd';

/** 一条角色能力 */
export interface AbilitySpec {
  /** 对应原版 ActionType，便于追溯 */
  action: string;
  event: AbilityEvent;
  /** 生效所需的格子类型（visitHome 用） */
  cellType?: string;
  /** 说明（中文，供 UI/日志；取自 OCR 能力名） */
  label: string;
  /** 一句话规则摘要（英文原文摘要） */
  rule: string;
  /** 数值参数（从 ActionParams 第 3 个起取） */
  nums?: number[];
  /** 特殊实现标记 */
  flag?:
    | 'engineerPrototype'      // 开局 +N 齿轮
    | 'damnedServant'          // 开局 +N 罪恶
    | 'homelessDebts'          // 开局 -N 金钱
    | 'homelessSmooth'         // 开局贿赂基数
    | 'thiefJailbird'          // 开局监狱等级
    | 'collectorFirstExhibit'  // 开局带一张永久卡
    | 'engineerSalary'         // 造访工厂 +N 金钱
    | 'damnedDarkPact'         // 在地狱打牌 +N 齿轮
    | 'gamblerWager'           // 掷 6 +N 金钱
    | 'gamblerPrize'           // 掷 1 +N 收入
    | 'gamblerExtraTurn'       // 赌场赢钱 +1 额外走牌（每回合一次）
    | 'merchantSell'           // 卖齿轮额外 +N 金钱
    | 'secretAgentSecrets'     // 用秘密卡 +N 金钱
    | 'thiefCrimePays'         // 用罪恶卡 +N 齿轮
    | 'judgeGuardian'          // 法院/警察站打牌 +N 选票
    | 'politicianCharisma'     // 讲话/给选票的卡 +N 选票
    | 'politicianPopulist'     // 每 N 选票 +N 收入
    | 'bankerCashback'         // 付钱打牌返现 N%
    | 'bankerDividends'        // 银行投资立刻返还
    | 'bankerMoneyMakes'       // 收入增加时额外 +N
    | 'secretAgentConnections' // 被捕时按掷 6 判刑
    | 'merchantMoveIt'         // 用 >=N 点卡移动免贿赂
    | 'merchantStop'           // 用 <=N 点卡移动可停在厄运格不触发
    | 'judgeStampDuty'         // 建筑内其他玩家付双倍贿赂
    | 'judgeJustice'           // 每 N 罪恶 +1 贿赂（削弱）
    | 'thiefRobbery'           // 跳过一次走牌 +N 金钱
    | 'homelessTheGreat'       // 最穷时垃圾场掷骰 +N 金钱
    | 'homelessNoPlace'        // 钱 <N 被捕改送垃圾场
    | 'collectorApathy'        // 钱 <N 时厄运改为 +1 罪恶
    | 'enterpreneurPromotion'  // 同回合第 3 张卡起每张 +N 齿轮
    | 'enterpreneurOwner'      // 别人在办公楼卖选票时你获得
    | 'astralClub'             // 选票 >=N 可从银行直达天界
    | 'extraCardAtOffice'      // 停在办公楼可再打一张
    | 'discardAtDanger'        // 停在冒险格可弃 1 张
    | 'rerollAtGamble'         // 赌博格可重掷
    | 'insuranceDiscount'      // 冒险格保险费用 N
    | 'excavation'             // 收入格二选一（双倍收入 / 抽 6 张）
    | 'sellIncome'             // 冒险格可卖 N 收入换钱
    | 'escapeConflict'         // 交锋前可付 N% 的钱逃到中心厄运站
    | 'none';                  // 仅登记，未实现机械效果
}

/** 角色内部名 → 能力清单 */
export const CHARACTER_ABILITIES: Record<string, AbilitySpec[]> = {
  Engineer: [
    {
      action: 'Engineer_Prototype', event: 'gameStart', label: '原型试样',
      rule: '起始齿轮 +1', nums: [1], flag: 'engineerPrototype',
    },
    {
      action: 'Engineer_Salary', event: 'visitHome', cellType: 'Plant', label: '薪资',
      rule: '造访工厂时：+50 金钱', nums: [50], flag: 'engineerSalary',
    },
    {
      action: 'Engineer_Golden_Thumb', event: 'afterPlayCard', label: '金科玉律',
      rule: '打出给予 5 齿轮以上的卡牌时：+1 齿轮', nums: [5, 1], flag: 'none',
    },
    {
      action: 'Engineer_Trade_Union', event: 'gameStart', label: '商会',
      rule: '工程师加入时：所有玩家在工厂打工获得 +100 金钱',
      nums: [100], flag: 'none',
    },
  ],
  Politician: [
    {
      action: 'Politician_Charisma', event: 'afterPlayCard', label: '超凡魅力',
      rule: '在演讲格演讲或打出给予选票的卡牌时：+1 选票',
      nums: [1, 1], flag: 'politicianCharisma',
    },
    {
      action: 'Politician_Populist', event: 'turnStart', label: '平民主义',
      rule: '每持有 1 选票：+1 收入', nums: [1, 1], flag: 'politicianPopulist',
    },
    {
      action: 'Politician_Astral_Club_2', event: 'turnStart', label: '天界俱乐部',
      rule: '持有 7 选票以上时：可从银行直达天界',
      nums: [7], flag: 'astralClub',
    },
  ],
  Enterpreneur: [
    {
      action: 'Enterpreneur_Business_Sense', event: 'turnEnd', label: '商业头脑',
      rule: '停在办公楼时：可再打出一张卡牌', flag: 'extraCardAtOffice',
    },
    {
      action: 'Enterpreneur_Promotion', event: 'afterPlayCard', label: '加班费',
      rule: '同一次走牌中从第 3 张卡起（不含移动牌）：每张 +2 齿轮',
      nums: [3, 2], flag: 'enterpreneurPromotion',
    },
    {
      action: 'Enterpreneur_Risky_Business', event: 'turnEnd', label: '风险经营',
      rule: '停在冒险格时：可弃 1 张手牌', flag: 'discardAtDanger',
    },
    {
      action: 'Enterpreneur_Office_Owner', event: 'officeSellVotes', label: '办公楼楼主',
      rule: '其他玩家在办公楼卖选票时：你获得那些选票',
      flag: 'enterpreneurOwner',
    },
  ],
  Homeless: [
    {
      action: 'Homeless_Apathy', event: 'visitHome', cellType: 'Junkyard', label: '冷漠',
      rule: '金钱不足 200 且需抽厄运时：改为 +1 罪恶',
      nums: [200, 1], flag: 'collectorApathy',
    },
    {
      action: 'Homeless_The_Great', event: 'afterRoll', label: '了不起的乞丐',
      rule: '作为最穷的玩家在垃圾场翻垃圾时：掷骰奖励 +60 金钱（替代 +30）',
      nums: [60], flag: 'homelessTheGreat',
    },
    {
      action: 'Homeless_Smooth_Sailing', event: 'gameStart', label: '一帆风顺',
      rule: '起始贿赂基数为 5；无法支付贿赂时不增加罪恶', nums: [5, 0],
      flag: 'homelessSmooth',
    },
    {
      action: 'Homeless_Old_Debts', event: 'gameStart', label: '未付账单',
      rule: '游戏开始时：-20 金钱', nums: [20], flag: 'homelessDebts',
    },
    {
      action: 'Homeless_No_Place', event: 'arrest', label: '穷人勿进',
      rule: '被捕时若金钱不足 200：改送垃圾场而非监狱（不触发规则）',
      nums: [200], flag: 'homelessNoPlace',
    },
  ],
  Gambler: [
    {
      action: 'Gambler_The_Regular', event: 'afterRoll', label: '潇洒退场',
      rule: '在赌场赢钱时：+1 额外走牌（每回合一次）',
      flag: 'gamblerExtraTurn',
    },
    {
      action: 'Gambler_A_Wager', event: 'afterRoll', label: '赌注',
      rule: '掷出 6 时：+40 金钱', nums: [40], flag: 'gamblerWager',
    },
    {
      action: 'Gambler_Lucky_Fellow', event: 'afterRoll', label: '幸运星',
      rule: '在赌博格赌博时：可重掷一次', flag: 'rerollAtGamble',
    },
    {
      action: 'Gambler_Consolidation_Prize', event: 'afterRoll', label: '安慰奖',
      rule: '掷出 1 时：+2 收入', nums: [2], flag: 'gamblerPrize',
    },
  ],
  Damned: [
    {
      action: 'Damned_A_Servant', event: 'gameStart', label: '恶魔之仆',
      rule: '游戏开始时：+1 罪恶', nums: [1], flag: 'damnedServant',
    },
    {
      action: 'Damned_The_Dark_Pact', event: 'afterPlayCard', label: '黑暗契约',
      rule: '在地狱打出任意卡牌时：+1 齿轮', nums: [1], flag: 'damnedDarkPact',
    },
    {
      action: 'Damned_Connections', event: 'afterMove', label: '暴乱关系',
      rule: '经过厄运格且罪恶值最高时：可从 2 张厄运牌中选 1 张',
      nums: [2], flag: 'none',
    },
    {
      action: 'Damned_Ancient_Curse', event: 'turnEnd', label: '古老咒语',
      rule: '在冒险格时：可使用厄运格的卡牌', flag: 'none',
    },
    {
      action: 'Damned_Aggressor', event: 'afterMove', label: '攻击者',
      rule: '赢得玩家交锋时：+3 齿轮，+2 罪恶', nums: [3, 2], flag: 'none',
    },
  ],
  Banker: [
    {
      action: 'Banker_Personal_Cashback', event: 'afterPlayCard', label: '个人返现',
      rule: '付钱打出卡牌时：立即返还 10% 金钱',
      nums: [10], flag: 'bankerCashback',
    },
    {
      action: 'Banker_Instant_Dividends', event: 'turnEnd', label: '即时股息',
      rule: '在银行投资时：立即获得全部投资金额',
      nums: [100], flag: 'bankerDividends',
    },
    {
      action: 'Banker_Money_Makes_Money_2', event: 'turnStart', label: '钱生钱',
      rule: '收入增加时（非永久卡来源）：+3 收入', nums: [3], flag: 'bankerMoneyMakes',
    },
    {
      action: 'Banker_Sale_Shares', event: 'turnEnd', label: '对冲风险',
      rule: '在冒险格时：可卖 10 收入换 100 金钱', nums: [10, 100], flag: 'sellIncome',
    },
  ],
  Thief: [
    {
      action: 'Thief_Jailbird', event: 'gameStart', label: '囚犯',
      rule: '游戏开始时监狱等级为 3', nums: [3], flag: 'thiefJailbird',
    },
    {
      action: 'Thief_Crime_Pays', event: 'afterPlayCard', label: '恶有恶报',
      rule: '打出罪恶卡时：+1 齿轮', nums: [1, 1, 1], flag: 'thiefCrimePays',
    },
    {
      action: 'Thief_Pickpocketing', event: 'afterMove', label: '扒窃',
      rule: '到达有玩家的建筑时：可掷骰偷取其 5-25% 金钱，掷出 1 则被捕',
      nums: [1, 5, 25], flag: 'none',
    },
    {
      action: 'Thief_Robbery', event: 'skipMove', label: '买卖',
      rule: '跳过走牌时：+100 金钱', nums: [100], flag: 'thiefRobbery',
    },
  ],
  SecretAgent: [
    {
      action: 'SecretAgent_Profitable_Secrets', event: 'afterPlayCard', label: '有利秘密',
      rule: '打出秘密卡时：+100 金钱', nums: [100], flag: 'secretAgentSecrets',
    },
    {
      action: 'SecretAgent_Shaking_The_Tail', event: 'beforeConflict', label: '摇尾巴',
      rule: '为避免交锋：失去 50% 金钱并传送到中央厄运格（若该格已有玩家则不可）。仅在你的回合。',
      nums: [50], flag: 'escapeConflict',
    },
    {
      action: 'SecretAgent_Secret_Connections', event: 'arrest', label: '秘密关系',
      rule: '被捕时：视为掷出 6 来判刑', nums: [6],
      flag: 'secretAgentConnections',
    },
  ],
  Merchant: [
    {
      action: 'Merchant_Skilled_Trader', event: 'marketSell', label: '老练商人',
      rule: '在市场卖齿轮时：每个齿轮额外 +100 金钱', nums: [100],
      flag: 'merchantSell',
    },
    {
      action: 'Merchant_Move_It', event: 'afterMove', label: '动起来',
      rule: '用 5 点以上的移动牌移动时：经过贿赂格免付贿赂',
      nums: [5], flag: 'merchantMoveIt',
    },
    {
      action: 'Merchant_Stop', event: 'afterMove', label: '停止',
      rule: '用 2 点以下的移动牌移动时：可停在厄运格且不触发厄运',
      nums: [2], flag: 'merchantStop',
    },
    {
      action: 'Merchant_Buy_And_Sell', event: 'skipMove', label: '买卖',
      rule: '跳过走牌时：+50 金钱', nums: [50], flag: 'thiefRobbery',
    },
  ],
  Judge: [
    {
      action: 'Judge_Court_Connections', event: 'visitHome', cellType: 'Courthouse', label: '法院人脉',
      rule: '在法院没收选票时：无需付钱', nums: [0], flag: 'none',
    },
    {
      action: 'Judge_Propaganda', event: 'afterPlayCard', label: '法律守护者',
      rule: '在法院或警察格打出任意卡牌时：+1 选票', nums: [1],
      flag: 'judgeGuardian',
    },
    {
      action: 'Judge_Servant_Of_Justice', event: 'turnStart', label: '正义之士',
      rule: '贿赂基数每 2 罪恶增加 1（削弱版：正常为每 1 罪恶增加 1）',
      nums: [1, 2], flag: 'judgeJustice',
    },
    {
      action: 'Judge_Stamp_Duty', event: 'afterMove', label: '印花税',
      rule: '到达有玩家的建筑时：每人向你支付双倍贿赂（监狱除外；镇长豁免）',
      nums: [200], flag: 'judgeStampDuty',
    },
  ],
  Collector: [
    {
      action: 'Collector_First_Exhibit', event: 'gameStart', label: '初次亮相',
      rule: '游戏开始时拥有一张已激活的「幸运药水」永久卡',
      flag: 'collectorFirstExhibit',
    },
    {
      action: 'Collector_Archaeology', event: 'afterRoll', label: '考古',
      rule: '在藏宝阁寻宝时：可重掷一次（仅最后一次算数）', flag: 'none',
    },
    {
      action: 'Collector_An_Exhibition', event: 'turnStart', label: '展览',
      rule: '每张已激活的永久卡：+10 收入（上限 +50）', nums: [10, 50],
      flag: 'none',
    },
    {
      action: 'Collector_Property_Insurance', event: 'afterRoll', label: '保险优惠',
      rule: '在冒险格掷骰时：保险费用仅 10 金钱', nums: [10],
      flag: 'insuranceDiscount',
    },
    {
      action: 'Collector_Excavation', event: 'afterMove', label: '挖宝',
      rule: '停在收入格时：双倍收入或抽 6 张牌后弃至 6 张',
      nums: [6], flag: 'excavation',
    },
  ],
};

// ---------------------------------------------------------------- 索引
/**
 * 校验：注册表必须覆盖数据里出现的全部角色能力原语。
 * 由测试调用，防止后续加角色时静默漏实现。
 */
export function allCharacterAbilityActions(): string[] {
  const out = new Set<string>();
  for (const char of Object.values(CHARACTER_BY_ID)) {
    for (const a of char.actions) {
      if (String(a.type).includes('_')) out.add(String(a.type));
    }
  }
  return [...out].sort();
}

export function registeredAbilityActions(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(CHARACTER_ABILITIES)) for (const s of list) out.add(s.action);
  return [...out].sort();
}

/** 取某玩家的角色能力清单 */
export function abilitiesOf(player: EnginePlayer): AbilitySpec[] {
  if (!player.characterId) return [];
  const char = CHARACTER_BY_ID[player.characterId];
  if (!char) return [];
  return CHARACTER_ABILITIES[char.name] ?? [];
}

// ---------------------------------------------------------------- 触发
export interface AbilityContext {
  /** 事件相关格子 */
  cellId?: string;
  /** 掷骰结果 */
  dice?: number;
  /** 移动步数 */
  steps?: number;
  /** 打出的卡 id */
  cardId?: string;
  /** 是否秘密卡 / 罪恶卡 */
  isSecret?: boolean;
  isCriminal?: boolean;
  /** 本次打牌付出的金钱 */
  paidMoney?: number;
  /** 本次产生的选票收益 */
  gainedVotes?: number;
  /** 本次产生的齿轮收益 */
  gainedScore?: number;
  /** 回填标记 */
  flags?: Record<string, string | number | boolean>;
}

/**
 * 触发角色在某时机的能力。
 *
 * 与永久卡的 `fireTrigger` 并列：永久卡看 `permanents`，角色能力看 `characterId`。
 *
 * @returns 触发了几条
 */
export function fireAbility(
  state: EngineState,
  playerId: string,
  event: AbilityEvent,
  ctx: AbilityContext = {},
): number {
  const p = state.players.find((x) => x.id === playerId);
  if (!p) return 0;
  const specs = abilitiesOf(p).filter((s) => s.event === event);
  if (!specs.length) return 0;

  let fired = 0;
  for (const spec of specs) {
    // 地点限定
    if (spec.cellType) {
      const cell = ctx.cellId ? getCell(state, ctx.cellId) : getCell(state, p.cellId);
      if (!cell || cell.cellType !== spec.cellType) continue;
    }
    if (applyAbility(state, p, spec, ctx)) fired++;
  }
  return fired;
}

/** 执行单条能力；返回是否真的产生了效果 */
function applyAbility(
  state: EngineState,
  p: EnginePlayer,
  spec: AbilitySpec,
  ctx: AbilityContext,
): boolean {
  const n = (i: number, d = 0) => spec.nums?.[i] ?? d;
  const label = spec.label;

  switch (spec.flag) {
    // ---- 开局 ----
    case 'engineerPrototype':
      addRes(p, 'score', n(0, 1));
      logAbility(state, p, label, `开局 +${n(0, 1)} 齿轮`);
      return true;
    case 'damnedServant':
      addRes(p, 'malice', n(0, 1));
      logAbility(state, p, label, `开局 +${n(0, 1)} 罪恶`);
      return true;
    case 'homelessDebts':
      addRes(p, 'money', -n(0, 20));
      logAbility(state, p, label, `开局 -${n(0, 20)} 金钱`);
      return true;
    case 'homelessSmooth':
      p.flags['bribeBase'] = n(0, 5);
      p.flags['noMaliceOnUnpaid'] = 1;
      logAbility(state, p, label, `开局贿赂基数 ${n(0, 5)}`);
      return true;
    case 'thiefJailbird':
      p.flags['jailRankStart'] = n(0, 3);
      logAbility(state, p, label, `开局监狱等级 ${n(0, 3)}`);
      return true;
    case 'collectorFirstExhibit': {
      // 找「幸运药水」并直接激活
      const potion = Object.values(CARD_BY_ID).find((c) => c.name === 'a112');
      if (potion && !p.permanents.includes(potion.id)) {
        p.permanents.push(potion.id);
        logAbility(state, p, label, `开局激活永久卡「${potion.text.name}」`);
        return true;
      }
      return false;
    }

    // ---- 造访主场 ----
    case 'engineerSalary':
      addRes(p, 'money', n(0, 50));
      logAbility(state, p, label, `造访工厂 +${n(0, 50)} 金钱`);
      return true;

    // ---- 打牌相关 ----
    case 'damnedDarkPact': {
      const cell = getCell(state, ctx.cellId ?? p.cellId);
      if (cell?.cellType !== 'Inferno') return false;
      addRes(p, 'score', n(0, 1));
      logAbility(state, p, label, `在地狱打牌 +${n(0, 1)} 齿轮`);
      return true;
    }
    case 'secretAgentSecrets':
      if (!ctx.isSecret) return false;
      addRes(p, 'money', n(0, 100));
      logAbility(state, p, label, `使用秘密卡 +${n(0, 100)} 金钱`);
      return true;
    case 'thiefCrimePays':
      if (!ctx.isCriminal) return false;
      addRes(p, 'score', n(0, 1));
      logAbility(state, p, label, `使用罪恶卡 +${n(0, 1)} 齿轮`);
      return true;
    case 'judgeGuardian': {
      const cell = getCell(state, ctx.cellId ?? p.cellId);
      if (!cell) return false;
      if (cell.cellType !== 'Courthouse' && cell.cellType !== 'Police') return false;
      addRes(p, 'vote', n(0, 1));
      logAbility(state, p, label, `法院/警察站打牌 +${n(0, 1)} 选票`);
      return true;
    }
    case 'politicianCharisma': {
      // 「在演讲站点演讲」或「使用给选票的卡」
      const cell = getCell(state, ctx.cellId ?? p.cellId);
      const atTribune = cell?.cellType === 'Tribune';
      if (!atTribune && !(ctx.gainedVotes && ctx.gainedVotes > 0)) return false;
      addRes(p, 'vote', n(0, 1));
      logAbility(state, p, label, `+${n(0, 1)} 选票`);
      return true;
    }
    case 'bankerCashback': {
      const paid = ctx.paidMoney ?? 0;
      if (paid <= 0) return false;
      const back = Math.floor((paid * n(0, 10)) / 100);
      if (back <= 0) return false;
      addRes(p, 'money', back);
      logAbility(state, p, label, `返现 +${back} 金钱`);
      return true;
    }
    case 'enterpreneurPromotion': {
      const need = n(0, 3);
      const played = p.cardsPlayedThisTurn;
      if (played < need) return false;
      const gain = n(1, 2);
      addRes(p, 'score', gain);
      logAbility(state, p, label, `本回合第 ${played} 张效果卡 +${gain} 齿轮`);
      return true;
    }

    // ---- 掷骰 ----
    case 'gamblerWager':
      if (ctx.dice !== 6) return false;
      addRes(p, 'money', n(0, 40));
      logAbility(state, p, label, `掷出 6 +${n(0, 40)} 金钱`);
      return true;
    case 'gamblerPrize':
      if (ctx.dice !== 1) return false;
      addRes(p, 'income', n(0, 2));
      logAbility(state, p, label, `掷出 1 +${n(0, 2)} 收入`);
      return true;
    case 'rerollAtGamble':
      if (ctx.flags) ctx.flags.rerollAllowed = true;
      return true;
    case 'insuranceDiscount': {
      if (ctx.flags) ctx.flags.insuranceCost = n(0, 10);
      return true;
    }
    case 'homelessTheGreat': {
      // 只在最穷时生效
      const poorest = Math.min(...state.players.map((x) => x.res.money));
      if (p.res.money > poorest) return false;
      if (ctx.flags) ctx.flags.junkyardBonus = n(0, 60);
      logAbility(state, p, label, `垃圾场掷骰奖励 ${n(0, 60)} 金钱`);
      return true;
    }

    // ---- 移动 ----
    case 'merchantMoveIt': {
      const need = n(0, 5);
      if ((ctx.steps ?? 0) < need) return false;
      p.flags['skipBribeThisMove'] = 1;
      logAbility(state, p, label, `用 ${ctx.steps} 点卡移动，免付贿赂`);
      return true;
    }
    case 'merchantStop': {
      const max = n(0, 2);
      if ((ctx.steps ?? 99) > max) return false;
      p.flags['skipMisfortuneThisMove'] = 1;
      return true;
    }
    case 'judgeStampDuty': {
      // 抵达的建筑里有其他玩家 → 每人付双倍贿赂
      const cell = getCell(state, ctx.cellId ?? p.cellId);
      if (!cell || cell.cellType === 'Jail') return false;
      const others = state.players.filter((x) => x.id !== p.id && x.cellId === cell.id);
      if (!others.length) return false;
      let got = 0;
      for (const o of others) {
        if (state.mayorId === o.id) continue;
        const amount = 2 * Math.max(0, 20 + o.res.malice);
        const r = transferRes(o, p, 'money', amount);
        got += r.moved;
      }
      if (got > 0) logAbility(state, p, label, `印花税 +${got} 金钱`);
      return got > 0;
    }

    // ---- 回合相关 ----
    case 'politicianPopulist': {
      const per = n(0, 1);
      const gain = Math.floor(p.res.vote / Math.max(1, per));
      if (gain <= 0) return false;
      addRes(p, 'income', gain);
      logAbility(state, p, label, `按选票 +${gain} 收入`);
      return true;
    }
    case 'astralClub': {
      const need = n(0, 7);
      if (p.res.vote < need) return false;
      if (ctx.flags) ctx.flags.astralClubAvailable = true;
      return true;
    }
    case 'bankerMoneyMakes':
      // 收入增长时的额外加成由 addRes 的调用方判断来源，这里只登记
      if (ctx.flags) ctx.flags.incomeBonus = n(0, 3);
      return false;
    case 'judgeJustice':
      // 贿赂计算时由 bribeAmount 读取（每 N 罪恶 +1）
      return false;
    case 'extraCardAtOffice':
    case 'bankerDividends': {
      // 银行家·即时股息：回合末返还本回合银行投资金额
      const invested = p.flags['bankInvestAmount'];
      if (typeof invested === 'number' && invested > 0) {
        p.res.money += invested;
        delete p.flags['bankInvestAmount'];
        state.log.push({ round: state.round, playerId: p.id, text: `「${spec.label}」：返还投资 ${invested} 金`, ts: Date.now() });
        return true;
      }
      return false;
    }
    case 'discardAtDanger':
    case 'sellIncome':
    case 'excavation':
      // 这些是"可选动作"，需要玩家决策；先把可用性写到 flags 供 UI/后续扩展
      if (ctx.flags) ctx.flags[spec.flag] = 1;
      return false;

    // ---- 其他玩家的行为影响我 ----
    case 'enterpreneurOwner': {
      if (ctx.flags) ctx.flags.officeVotesToOwner = p.id;
      return true;
    }
    case 'merchantSell':
      // 由市场结算处调用
      return false;

    case 'thiefRobbery':
      addRes(p, 'money', n(0, 50));
      logAbility(state, p, label, `跳过走牌 +${n(0, 50)} 金钱`);
      return true;

    case 'homelessNoPlace':
      if (p.res.money >= n(0, 200)) return false;
      if (ctx.flags) ctx.flags.arrestToJunkyard = true;
      return true;

    case 'collectorApathy':
      if (p.res.money >= n(0, 200)) return false;
      if (ctx.flags) ctx.flags.misfortuneToMalice = n(1, 1);
      return true;

    case 'secretAgentConnections':
      if (ctx.flags) ctx.flags.arrestAsSix = true;
      return true;

    // 「摇尾巴」：交锋开始前，引发方可选择付钱逃到中心厄运站。
    // 只提供"可选项"信息，真正执行由 state.ts 的 startConflict 读取。
    case 'escapeConflict': {
      const pct = n(0, 50);
      if (ctx.flags) {
        ctx.flags.escapeConflictPct = pct;
      }
      return true;
    }

    case 'gamblerExtraTurn': {
      const cell = getCell(state, ctx.cellId ?? p.cellId);
      if (cell?.cellType !== 'Casino') return false;
      const key = 'gamblerExtraTurnUsed';
      if (p.flags[key] === state.round * 100 + state.currentIndex) return false;
      p.flags[key] = state.round * 100 + state.currentIndex;
      p.extraTurns += 1;
      logAbility(state, p, label, `赌场赢钱 +1 次额外走牌（每回合一次）`);
      return true;
    }

    case 'none':
    default:
      return false;
  }
}

function logAbility(state: EngineState, p: EnginePlayer, label: string, text: string): void {
  state.log.push({
    round: state.round,
    playerId: p.id,
    text: `角色能力·${label}：${text}`,
    ts: Date.now(),
  });
  if (state.log.length > 400) state.log.shift();
}

/** 掷骰并跑「掷骰后」能力（赌徒的 6/1 奖励等） */
export function rollDiceWithAbilities(
  state: EngineState,
  p: EnginePlayer,
  ctx: AbilityContext = {},
): number {
  const dice = rollDice(state);
  fireAbility(state, p.id, 'afterRoll', { ...ctx, dice });
  return dice;
}

/** 给 bribeAmount 用的角色贿赂修正 */
export function bribeModifier(p: EnginePlayer): { perMalice: number; base: number } {
  const specs = abilitiesOf(p);
  const justice = specs.find((s) => s.flag === 'judgeJustice');
  const smooth = specs.find((s) => s.flag === 'homelessSmooth');
  return {
    perMalice: justice ? 1 / Math.max(1, justice.nums?.[1] ?? 2) : 1,
    base: smooth ? (smooth.nums?.[0] ?? 5) : 20,
  };
}

/** 随机给一个未使用的角色 id（房间用） */
export function randomCharacterId(used: Set<string>, rngState = Date.now() >>> 0): string | undefined {
  const pool = Object.values(CHARACTER_BY_ID).filter((c) => !used.has(c.id));
  if (!pool.length) return undefined;
  // 用一次性 LCG 取值，避免为了随机一个人而构造完整对局状态
  const next = (rngState * 1664525 + 1013904223) >>> 0;
  return pool[next % pool.length]?.id;
}

/** 判断某个玩家是否是最穷的（「了不起的乞丐」等奖励判定） */
export function isPoorest(state: EngineState, p: EnginePlayer): boolean {
  const min = Math.min(...state.players.map((x) => x.res.money));
  return p.res.money === min;
}

/** 格子类型名（供测试断言） */
export function cellTypeName(state: EngineState, cellId: string): string | undefined {
  const cell = getCell(state, cellId);
  return cell ? cellTypeOf(cell)?.cellType : undefined;
}

/** 地图格数（健康检查） */
export function boardCellCount(state: EngineState): number {
  return getMap(state).cells.length;
}

export type { GameCharacter };
