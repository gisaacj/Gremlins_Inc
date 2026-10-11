// =============================================================
// 可选动作（玩家在站点/建筑可以主动选择做的事）
//
// 与原版 `GCellType` 的对应关系：`OptionalFlag == true` 的格子都有
// "If you want: ..." 的说明，参数就在 `Param1..Param6` 里。例如：
//
//   Bank    params=[10,10]      If you want: invest {1}$. → |+{2}
//   Office  params=[70]         If you want: sell 1& for {1}$
//   Market  params=[200]        If you want: sell 1* for {1}$
//   Astral  params=[3,2]        skip 1 turn → -{2}^, draw {1} cards, keep 1
//   Plant   params=[50,1]       skip 1 turn → +{1}$, -{2}^
//   Tribune params=[10,20,30,40,50]  下注额选项
//   Risk    params=[0,50,1,50,2,100] 掷骰奖金表
//   Casino  params=[100,50,25,25,50,100] 赌场奖金表
//   Junkyard params=[1,30,0,10,20,30] 掷骰挖垃圾
//
// 另外**角色能力**也会带来可选动作（办公楼再打一张、冒险格弃牌、
// 卖收入换钱、收入格二选一…），见 `abilities.ts` 的 `extraCardAtOffice` 等 flag。
//
// 本模块把两者统一成 `OptionSpec`，引擎在"可行动阶段"把它们列出来，
// 玩家选一个执行（或直接结束回合）。
// =============================================================
import type { EnginePlayer, EngineState } from './model.js';
import {
  CARD_BY_ID, CELL_TYPE_BY_NAME, cellTypeOf, getCell, getMap, getPlayer,
  currentPlayer as modelCurrentPlayer,
} from './model.js';
import { addRes, hasRes, transferRes } from './resources.js';
import { discardFromHand, drawMisfortune, drawTo, rollDice } from './interp.js';
import { HAND_SIZE, canPlayCard } from './state.js';
import { abilitiesOf, excavationCount, hasExcavation, insuranceCost } from './abilities.js';

// =============================================================
// 骰子结算表（数据驱动）
//
// 原版把"掷骰结果 → 效果"直接写在格子的 `Label1..6` 里，例如：
//
//   Casino   1 = -{1}$          6 = +{6}$
//   Junkyard 1 = -{1}&          2 = 谢谢参与      4 = +{4}$
//   Risk     1 = 厄运           3 = -{3}&, +{3}^
//   Tribune  6 = +1&            5, 6 = +1&        2, 3, 4, 5, 6 = +1&
//   Jail     1 = {3} 次走牌     3 = {2} 次走牌
//   Treasure 1 = +{1}$          6 = +{6}$
//
// `{N}` 是 `params[N-1]` 的占位。**必须解析这些文案而不是猜公式**——
// 之前用"最低点数→奖金"的递增表实现 Risk/Casino 是错的。
// =============================================================

/** 一条骰子结算 */
export interface DiceOutcome {
  /** 触发该结果的点数 */
  faces: number[];
  /** 资源增减 */
  gain?: { score?: number; vote?: number; malice?: number; money?: number; income?: number };
  /** 非资源的特殊结果（原版文案，如「厄运」「谢谢参与」） */
  special?: string;
}

/** 符号 → 资源：`|` 收入、`&` 选票、`^` 罪恶、`*` 齿轮、`$` 金钱（来自游戏内符号说明） */
const RES_BY_SYMBOL: Record<string, 'income' | 'vote' | 'malice' | 'score' | 'money'> = {
  '|': 'income', '&': 'vote', '^': 'malice', '*': 'score', '$': 'money',
};

const RES_ZH: Record<string, string> = {
  score: '齿轮', vote: '选票', malice: '罪恶', money: '金钱', income: '收入',
};

/** 把 `{N}` 换成 params[N-1] */
function subst(text: string, params: number[]): string {
  return text.replace(/\{(\d+)\}/g, (_, i) => String(params[Number(i) - 1] ?? 0));
}

/**
 * 解析一个格子的骰子结算表。
 *
 * @returns 按点数 1..6 索引；无该点数的格子不会出现在结果里
 */
export function parseDiceTable(labels: string[], params: number[]): Record<number, DiceOutcome> {
  const out: Record<number, DiceOutcome> = {};
  for (const raw of labels) {
    const text = subst(raw, params);
    const eq = text.indexOf('=');
    if (eq < 0) continue;

    const facePart = text.slice(0, eq).trim();
    const effectPart = text.slice(eq + 1).trim();

    // 点数可能形如 "5, 6" 或 "2，3"（中文逗号）
    const faces = facePart
      .split(/[,，\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 6);
    if (!faces.length) continue;

    const outcome: DiceOutcome = { faces };
    if (/[+-]?\d/.test(effectPart)) {
      const gain: NonNullable<DiceOutcome['gain']> = {};
      const re = /([+-])\s*(\d+)\s*([|&^*$])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(effectPart))) {
        const sign = m[1] === '-' ? -1 : 1;
        const key = RES_BY_SYMBOL[m[3]];
        if (key) gain[key] = (gain[key] ?? 0) + Number(m[2]) * sign;
      }
      if (Object.keys(gain).length) outcome.gain = gain;
      else outcome.special = effectPart; // 有数字但不是资源语法（如「3 次走牌」）
    } else {
      outcome.special = effectPart;
    }

    for (const f of faces) out[f] = outcome;
  }
  return out;
}

/** 取某格子的骰子结算表 */
export function diceTableOf(cellType: string): Record<number, DiceOutcome> {
  const def = CELL_TYPE_BY_NAME[cellType];
  if (!def?.labels?.length) return {};
  return parseDiceTable(def.labels, def.params);
}

/**
 * 处理骰子表里的"非资源"结果。
 *
 * 目前只认「厄运」——Risk 格掷出 1 时触发。其余（如「谢谢参与」）无需动作。
 * 文案随语言变化，所以用关键词匹配而不是全等。
 */
export function handleSpecialOutcome(state: EngineState, p: EnginePlayer, special: string): void {
  if (/厄运|Misfortune/i.test(special)) {
    drawMisfortune(state, p);
  }
}

/**
 * 监狱刑期：取自原版 `Jail` 格子的 Label 表——
 * `1, 2 = {3} 次走牌`、`3, 4 = {2} 次走牌`、`5, 6 = {1} 次走牌`，
 * `{N}` 指向 `params[N-1]`（该格参数为 [2, 3, 4]，即 1~2 点判 4 回合）。
 *
 * 不要按"点数越小刑期越长"的直觉写死：数值来自数据。
 */
export function jailTermFor(dice: number): number {
  const def = CELL_TYPE_BY_NAME.Jail;
  if (!def?.labels?.length) return dice <= 2 ? 4 : dice <= 4 ? 3 : 2;
  const table = parseDiceTable(def.labels, def.params);
  const special = table[dice]?.special ?? '';
  const m = special.match(/(\d+)/);
  return m ? Number(m[1]) : 2;
}

/** 掷骰并套用结算表 */
function rollOnTable(
  state: EngineState,
  p: EnginePlayer,
  table: Record<number, DiceOutcome>,
): { dice: number; outcome?: DiceOutcome; message: string } {
  const dice = rollDice(state);
  state.lastRoll = dice;
  const outcome = table[dice];
  if (!outcome) return { dice, message: `掷出 ${dice}` };

  const parts: string[] = [];
  if (outcome.gain) {
    for (const [k, v] of Object.entries(outcome.gain)) {
      if (!v) continue;
      addRes(p, k as 'score' | 'vote' | 'malice' | 'money' | 'income', v);
      parts.push(`${v > 0 ? '+' : ''}${v} ${RES_ZH[k] ?? k}`);
    }
  }
  if (outcome.special) parts.push(outcome.special);
  return { dice, outcome, message: parts.join('，') || '无事发生' };
}

/** 一个可选动作 */
export interface OptionSpec {
  /** 稳定 id，回传给引擎执行 */
  id: string;
  /** 给玩家看的短标签（按钮文字） */
  label: string;
  /** 规则说明（来自原版文案，已做参数替换） */
  description?: string;
  /** 能不能负担（false 时 UI 置灰） */
  affordable?: boolean;
  /** 不可负担的原因 */
  reason?: string;
  /** 需要额外选择目标（如法院没收选票要选人） */
  needsTarget?: boolean;
}

// ---------------------------------------------------------------- 站点选项
/**
 * 按当前所在格子的类型与参数，算出该格提供哪些可选动作。
 *
 * 注意：格子自身的可选动作要求 `OptionalFlag == true`（原版语义：有
 * "If you want:" 的说明）。但**角色能力带来的可选动作与这个标志无关**——
 * 例如冒险格 `OptionalFlag=false`（买保险是必选），而「风险经营」仍允许弃牌。
 * 所以能力选项单独追加，不受该标志限制。
 */
function cellOptions(state: EngineState, p: EnginePlayer): OptionSpec[] {
  const cell = getCell(state, p.cellId);
  if (!cell) return [];
  const def = cellTypeOf(cell);
  const pr = def?.params ?? [];
  const out: OptionSpec[] = [];

  // ── 「无视本站」：本站规则对这名玩家**不生效** ──
  //
  // 由 `IgnoreCell` 动作置位（`p.flags.ignoreCell`），共 11 张卡用到，例如：
  //  - a023「恶作剧」：与对手交换位置，**交换后所在位置的规则不会触发**
  //  - a160「好运」：厄运站点的规则**不会影响你**
  //
  // ⚠️ 这里原先只挡住了"自动落点结算"（`resolveCellEffect`），
  // 却没挡住**可选动作**，于是打完「恶作剧」换到办公楼后，
  // 界面仍然给出「卖选票」——正是用户报的 bug #2。
  // 既然卡面说"站点规则不会生效"，本站的可选动作同样不该提供。
  //
  // 注意：只屏蔽**本站**动作。角色能力带来的动作（如政治家从银行直达天界）
  // 与"再打一张牌"之类的通用动作不受影响 —— 它们不属于"本站规则"。
  if (p.flags['ignoreCell'] === 1) return out;

  if (def?.optional) {
    out.push(...stationOptions(state, p, cell.cellType, pr, def.text.description));
  } else if (cell.cellType === 'Treasure') {
    // 藏宝阁的掷骰原版是"必掷"，但**掷不掷**仍由玩家决定，
    // 所以即使 OptionalFlag=false 也要给出这个选项。
    //
    // 冒险格（Danger）不在这里 —— 它走落地强制弹窗（见下）。早先它被一起
    // 放进来，产出一个**没有处理分支的幽灵选项** `danger.insure`，
    // 点下去什么都不发生、回合也推进不了，于是面板反复弹出（用户 bug）。
    out.push(...stationOptions(state, p, cell.cellType, pr, def?.text.description ?? ''));
  }

  // ── 收藏家「挖宝」：停在收入格时可二选一 ──
  //
  // 收入格被标为 `autoCellEffect: false`（见 gamedata/decks.ts），
  // 所以不会自动结算，而是在这里给出两个选项，玩家选了才进
  // `resolveCellEffect` 结算。原版文案是"在藏宝阁寻宝时：可重掷一次"
  // 与本能力（`Collector_Excavation`，nums=[6]）**不是同一条**。
  // 本实现按用户实测行为：**双倍收入 或 换牌**。
  if (cell.cellType === 'Income') {
    const exc = abilitiesOf(p).find((s) => s.flag === 'excavation');
    if (exc) {
      const n = exc.nums?.[0] ?? 6;
      out.push({
        id: 'excavation.income',
        label: `双倍收入（+${p.res.income * 2} 金钱）`,
        description: '按收入格正常结算：获得双倍收入',
      });
      out.push({
        id: 'excavation.swap',
        label: `换牌（重抽 ${n} 张）`,
        description: `放弃本次收入，把手里的 ${p.hand.length} 张换成 ${n} 张新牌`,
      });
    }
  }

  // 角色能力带来的可选动作：与格子的 OptionalFlag 无关
  out.push(...abilityOptions(state, p, cell.cellType));

  // ── a121「机械帮手」（永久卡，`discardIfNoAction`）──
  //
  // 卡面："If you cannot play a card for action in the place where you visit,
  //        you can discard 1 card from your hand."
  // 判据：持有该永久卡 + 本回合已移动 + **当前地点没有任何可打出的牌**。
  if (p.flags['discardIfNoAction'] && p.movedThisTurn && p.hand.length > 0
    && p.hand.every((id) => !canPlayCard(state, p, id).ok)) {
    out.push({
      id: 'perm.discardToRedraw',
      label: `机械帮手：弃 ${p.flags['discardIfNoAction']} 张手牌再抽`,
      description: '到站后无牌可打时可弃牌换新牌（永久卡「机械帮手」）',
    });
  }

  return out;
}

/** 格子自身的可选动作（来自原版 `GCellType` 参数） */
function stationOptions(
  state: EngineState,
  p: EnginePlayer,
  cellType: string,
  pr: number[],
  description: string,
): OptionSpec[] {
  const out: OptionSpec[] = [];

  switch (cellType) {
    // 银行：投资 Param1 金 → 收入 +Param2
    case 'Bank': {
      // 原版规则：投资金额 = 当前收入值（Param1=10 是静态面板兜底，非实际费用）
      // 投资后收入 +Param2（=10）
      const cost = Math.max(10, p.res.income);
      const gain = pr[1] || 10;
      out.push({
        id: 'bank.invest',
        label: `投资 ${cost} 金 → 收入 +${gain}`,
        description,
        affordable: p.res.money >= cost,
        reason: p.res.money >= cost ? undefined : `需要 ${cost} 金钱`,
      });
      break;
    }

    // 办公楼：卖 1 选票换 Param1 金
    case 'Office': {
      const gain = pr[0] || 70;
      out.push({
        id: 'office.sellVote',
        label: `卖 1 选票 → ${gain} 金`,
        description,
        affordable: p.res.vote >= 1,
        reason: p.res.vote >= 1 ? undefined : '需要 1 选票',
      });
      break;
    }

    // 市场：卖 1 齿轮换 Param1 金
    case 'Marketplace': {
      const gain = pr[0] || 200;
      out.push({
        id: 'market.sellScore',
        label: `卖 1 齿轮 → ${gain} 金`,
        description,
        affordable: p.res.score >= 1,
        reason: p.res.score >= 1 ? undefined : '需要 1 齿轮',
      });
      break;
    }

    // 法院：花 Param1 金，从别人那里没收 Param2 选票
    case 'Courthouse': {
      const cost = pr[0] || 40;
      const votes = pr[1] || 1;
      out.push({
        id: 'court.takeVotes',
        label: `花 ${cost} 金没收 ${votes} 选票`,
        description,
        affordable: p.res.money >= cost,
        reason: p.res.money >= cost ? undefined : `需要 ${cost} 金钱`,
        needsTarget: true,
      });
      break;
    }

    // 工厂：打工（跳过 1 回合）→ +Param1 金，-Param2 罪恶
    case 'Plant': {
      const money = pr[0] || 50;
      const malice = pr[1] || 1;
      out.push({
        id: 'plant.work',
        label: `打工（跳过 1 回合）→ +${money} 金，-${malice} 罪恶`,
        description,
      });
      break;
    }

    // 天界：休息（跳过 1 回合）→ -Param2 罪恶，抽 Param1 张留 1 张
    case 'Astral': {
      const draw = pr[0] || 3;
      const malice = pr[1] || 2;
      out.push({
        id: 'astral.rest',
        label: `休息（跳过 1 回合）→ -${malice} 罪恶，抽 ${draw} 张留 1 张`,
        description,
      });
      break;
    }

    // 垃圾场：掷骰挖垃圾；最穷时额外 +Param2
    case 'Junkyard': {
      const bonus = pr[1] || 30;
      const poorest = p.res.money === Math.min(...state.players.map((x) => x.res.money));
      out.push({
        id: 'junkyard.dig',
        label: `翻垃圾（掷骰）${poorest ? `，你最穷额外 +${bonus}` : ''}`,
        description,
      });
      break;
    }

    // 演讲：下注额由 Param1..5 给出
    case 'Tribune': {
      for (const amt of pr.filter((x) => x > 0)) {
        out.push({
          id: `tribune.speak.${amt}`,
          label: `演讲下注 ${amt} 金`,
          description,
          affordable: p.res.money >= amt,
          reason: p.res.money >= amt ? undefined : `需要 ${amt} 金钱`,
        });
      }
      break;
    }

    // 冒险格：**不在这里给可选动作**。
    //
    // ⚠️ 这里原先给了一个 `danger.insure`（"买保险 N 金"），但 `doOption`
    // 里**根本没有它的处理分支** —— 是个幽灵选项：点下去什么都不发生，
    // 回合也推进不了，于是 UseCell 面板反复弹出来。
    // 用户实测："我总共点了四次不买或跳过，离谱"。
    //
    // 冒险格的买保险本来就走**落地强制弹窗**
    // （`resolveCellEffect` 的 `case 'Danger'`，pending kind = `danger:<id>`），
    // 那里才是唯一入口。所以直接不给可选动作。
    // 藏宝阁（Treasure）同理 —— 它也是落地自动掷骰，没有可选动作。
    case 'Danger':
      break;

    // 风险格（赌博站）：可选掷骰试手气
    case 'Risk': {
      out.push({ id: 'risk.gamble', label: '试手气（掷骰）', description });
      break;
    }

    // 赌场：掷骰赌博
    case 'Casino': {
      out.push({ id: 'casino.gamble', label: '赌博（掷骰）', description });
      break;
    }

    // 藏宝阁：OptionalFlag=false → 停留时自动掷骰（见 state.ts resolveLanding），不作为可选动作

    default:
      break;
  }
  return out;
}

/** 由角色能力带来的可选动作 */
function abilityOptions(state: EngineState, p: EnginePlayer, cellType: string): OptionSpec[] {
  const out: OptionSpec[] = [];

  for (const a of abilitiesOf(p)) {
    switch (a.flag) {
      // 银行：选票够时可直达天界
      case 'astralClub': {
        if (cellType !== 'Bank') break;
        const need = a.nums?.[0] ?? 7;
        out.push({
          id: 'ability.astralFromBank',
          label: `直达天界（需 ${need} 选票）`,
          description: a.rule,
          affordable: p.res.vote >= need,
          reason: p.res.vote >= need ? undefined : `需要 ${need} 选票`,
        });
        break;
      }

      // 办公楼：可再打一张牌
      case 'extraCardAtOffice': {
        if (cellType !== 'Office') break;
        out.push({ id: 'ability.playAgain', label: '再打一张牌', description: a.rule });
        break;
      }

      // 冒险格：弃 1 张手牌
      case 'discardAtDanger': {
        if (cellType !== 'Danger') break;
        out.push({
          id: 'ability.discardOne',
          label: '弃 1 张手牌',
          description: a.rule,
          affordable: p.hand.length > 0,
          reason: p.hand.length > 0 ? undefined : '没有手牌',
        });
        break;
      }

      // 冒险格：卖收入换钱
      case 'sellIncome': {
        if (cellType !== 'Danger') break;
        const inc = a.nums?.[0] ?? 10;
        const gain = a.nums?.[1] ?? 100;
        out.push({
          id: `ability.sellIncome.${inc}.${gain}`,
          label: `卖 ${inc} 收入 → ${gain} 金`,
          description: a.rule,
          affordable: p.res.income >= inc,
          reason: p.res.income >= inc ? undefined : `需要 ${inc} 收入`,
        });
        break;
      }

      // 收藏家「挖宝」的选项由 `cellOptions` 的收入格分支统一给出
      // （`excavation.income` / `excavation.swap`）。
      // ⚠️ 这里原先还生成了一份 `ability.doubleIncome` / `ability.drawAndKeep`，
      // 两份**语义不一致**（旧的那份把"双倍收入"写成了单倍、把"换牌"写成了
      // "抽 N 留 1"），界面上会同时出现 4 个选项。已删除，避免歧义。
      case 'excavation':
        break;

      default:
        break;
    }
  }
  return out;
}

/** 列出该玩家此刻可执行的全部可选动作 */
/**
 * 站点/建筑的可选动作是"**每次到访做一次**"。
 *
 * 原版文案：`If you want: roll the dice to dig through the junk.`
 * ——"想要的话掷骰翻垃圾"，一次到访一次机会（`15747048738541475235`：
 * "{N} chooses not to dig through the junk."，是一个一次性选择）。
 *
 * 之前没有这个限制，AI 能在同一回合反复调用 `junkyard.dig`：
 * 掷 4/5/6 分别 +10/+20/+30 金钱，几百次滚出 $20000+。
 * 这是"每回合无限刷钱"级别的漏洞，不只是 AI 贪心。
 *
 * 用 `p.flags` 记录（回合末会被 `endTurn` 清空，正好是"每回合"的语义）。
 */
function optionUsedKey(optionId: string): string {
  return `optUsed:${optionId}`;
}

/** 该可选动作本回合是否已用过。
 * 原版规则：每次到访只能用一个可选动作——用了一个，该格所有动作都不可再选 */
export function optionUsedThisTurn(p: EnginePlayer, optionId: string): boolean {
  // 检查该格是否已用过任何动作
  if (p.flags['optUsed:cell'] === 1) return true;
  return p.flags[optionUsedKey(optionId)] === 1;
}

export function availableOptions(state: EngineState, playerId: string): OptionSpec[] {
  const p = getPlayer(state, playerId);
  if (!p) return [];
  if (state.phase !== 'playing') return [];
  if (state.pending) return [];
  // 只有轮到自己、且已完成走牌才有可选动作
  // 原版规则：建筑效果只在移动到达后触发，起始位置不触发
  const cur = modelCurrentPlayer(state);
  if (!cur || cur.id !== playerId) return [];
  if (!p.movedThisTurn) return [];
  // 本回合已用过的动作不再列出
  return cellOptions(state, p).filter((o) => !optionUsedThisTurn(p, o.id));
}

// ---------------------------------------------------------------- 执行
export interface OptionResult {
  ok: boolean;
  error?: string;
  /** 需要玩家再选目标（目前只有法院没收选票用） */
  needsTarget?: { kind: string; candidates: string[] };
  /** 给日志/UI 的一句话 */
  message?: string;
}

const fail = (error: string): OptionResult => ({ ok: false, error });
const done = (message: string): OptionResult => ({ ok: true, message });

/**
 * 执行一个可选动作。
 *
 * @param targetId 需要目标的动作用（法院没收选票）
 */
export function doOption(
  state: EngineState,
  playerId: string,
  optionId: string,
  targetId?: string,
): OptionResult {
  const p = getPlayer(state, playerId);
  if (!p) return fail('玩家不存在');
  if (state.pending) return fail('有未完成的决策');

  const cell = getCell(state, p.cellId);
  if (!cell) return fail('位置无效');
  const def = cellTypeOf(cell);
  const pr = def?.params ?? [];
  const parts = optionId.split('.');

  const logIt = (msg: string) => {
    state.log.push({ round: state.round, playerId: p.id, text: msg, ts: Date.now() });
    if (state.log.length > 400) state.log.shift();
  };

  // 成功执行即标记"本回合已用过"（回合末由 endTurn 清空 flags）。
  // 没有这道标记时 AI 能在同一回合反复翻垃圾刷钱（掷 4/5/6 给 +10/+20/+30 金钱，
  // 几百次能滚出两万以上）。
  const doneUsed = (message: string): OptionResult => {
    p.flags[optionUsedKey(optionId)] = 1;
    // 原版规则：每格每次到访只能做一个动作——标记整格已用
    p.flags['optUsed:cell'] = 1;
    return done(message);
  };

  // 每次到访只能做一次——重复调用直接拒绝（不能只靠 availableOptions 过滤，
  // 调用方可能自己拼 optionId）
  if (optionUsedThisTurn(p, optionId)) {
    return fail('本回合已经做过这个动作了');
  }

  switch (parts[0]) {
    // ---- 站点动作 ----
    case 'bank': {
      // 原版规则：投资金额 = 当前收入值（非固定 10），收入 +Param2
      const cost = Math.max(10, p.res.income);
      const gain = pr[1] || 10;
      if (!hasRes(p, 'money', cost)) return fail(`需要 ${cost} 金钱`);
      addRes(p, 'money', -cost);
      addRes(p, 'income', gain);
      // 记录投资金额，供「银行家·即时股息」回合末返还
      p.flags['bankInvestAmount'] = cost;
      logIt(`投资 ${cost} 金，收入 +${gain}`);
      return doneUsed(`投资 ${cost} 金，收入 +${gain}`);
    }

    case 'office': {
      const gain = pr[0] || 70;
      if (p.res.vote < 1) return fail('需要 1 选票');
      addRes(p, 'vote', -1);
      addRes(p, 'money', gain);
      logIt(`在办公楼卖 1 选票，得 ${gain} 金`);
      // 「办公楼楼主」：其他人卖选票时归他
      for (const other of state.players) {
        if (other.id === p.id) continue;
        for (const a of abilitiesOf(other)) {
          if (a.flag !== 'enterpreneurOwner') continue;
          transferRes(p, other, 'money', gain);
          state.log.push({
            round: state.round, playerId: other.id,
            text: `角色能力·${a.label}：获得 ${gain} 金`, ts: Date.now(),
          });
        }
      }
      return doneUsed(`卖 1 选票，得 ${gain} 金`);
    }

    case 'market': {
      const gain = pr[0] || 200;
      if (p.res.score < 1) return fail('需要 1 齿轮');
      addRes(p, 'score', -1);
      // 「老练商人」：卖齿轮额外加成
      let bonus = 0;
      for (const a of abilitiesOf(p)) {
        if (a.flag === 'merchantSell') bonus += a.nums?.[0] ?? 100;
      }
      addRes(p, 'money', gain + bonus);
      logIt(`在市场卖 1 齿轮，得 ${gain + bonus} 金${bonus ? `（含能力加成 ${bonus}）` : ''}`);
      return doneUsed(`卖 1 齿轮，得 ${gain + bonus} 金`);
    }

    case 'court': {
      const cost = pr[0] || 40;
      const votes = pr[1] || 1;
      if (p.res.money < cost) return fail(`需要 ${cost} 金钱`);
      if (!targetId) {
        const candidates = state.players
          .filter((x) => x.id !== p.id && x.res.vote >= votes)
          .map((x) => x.id);
        if (!candidates.length) return fail('没有可没收选票的玩家');
        return { ok: true, needsTarget: { kind: 'court.takeVotes', candidates } };
      }
      const target = getPlayer(state, targetId);
      if (!target) return fail('目标不存在');
      addRes(p, 'money', -cost);
      const r = transferRes(target, p, 'vote', votes);
      logIt(`花 ${cost} 金从 ${target.name} 没收 ${r.moved} 选票`);
      return doneUsed(`没收 ${r.moved} 选票`);
    }

    case 'plant': {
      const money = pr[0] || 50;
      const malice = pr[1] || 1;
      addRes(p, 'money', money);
      addRes(p, 'malice', -malice);
      p.skipTurns += 1;
      logIt(`在工厂打工：+${money} 金，-${malice} 罪恶，跳过 1 回合`);
      return doneUsed(`打工：+${money} 金，-${malice} 罪恶，下回合跳过`);
    }

    case 'astral': {
      const draw = pr[0] || 3;
      const malice = pr[1] || 2;
      addRes(p, 'malice', -malice);
      p.skipTurns += 1;
      const drawn = drawTo(state, p, draw);
      // 留 1 张（简化：保留价值最高的，其余回弃牌堆）
      if (drawn.length > 1) {
        const best = drawn
          .map((id) => ({ id, v: cardValue(id) }))
          .sort((a, b) => b.v - a.v)[0].id;
        const rest = drawn.filter((id) => id !== best);
        for (const id of rest) {
          const i = p.hand.indexOf(id);
          if (i >= 0) p.hand.splice(i, 1);
          state.discard.push(id);
        }
      }
      logIt(`在天界休息：-${malice} 罪恶，抽 ${draw} 张留 1 张，跳过 1 回合`);
      return doneUsed(`休息：-${malice} 罪恶，跳过下回合`);
    }

    case 'junkyard': {
      const table = diceTableOf('Junkyard');
      const r = rollOnTable(state, p, table);
      // 最穷加成：任何点数结果都额外 +param2
      const poorest = p.res.money === Math.min(...state.players.map((x) => x.res.money));
      const bonus = pr[1] || 30;
      if (poorest) {
        addRes(p, 'money', bonus);
        // 「了不起的乞丐」：最穷时额外加成（取代常规 +30）
        for (const a of abilitiesOf(p)) {
          if (a.flag === 'homelessTheGreat') addRes(p, 'money', a.nums?.[0] ?? 60);
        }
      }
      logIt(`翻垃圾掷出 ${r.dice}：${r.message}${poorest ? `，最穷额外 +${bonus}` : ''}`);
      return doneUsed(`掷出 ${r.dice}：${r.message}${poorest ? `，最穷额外 +${bonus}` : ''}`);
    }

    // treasure 已移至 state.ts resolveLanding 自动结算（OptionalFlag=false）

    case 'tribune': {
      const amt = Number(parts[2] ?? 0);
      if (amt <= 0) return fail('下注额无效');
      if (p.res.money < amt) return fail(`需要 ${amt} 金钱`);

      // 原版：下注额与掷骰门槛一一对应（`Label1..5`），**输赢都扣下注额**。
      //   下注 10 → 需 6        下注 50 → 需 2~6
      // `diceTableOf` 是按"点数 → 结果"合并的（同一结果会被多个点数共享），
      // 所以这里要按**档位**逐行解析，取该档最低命中点数作为门槛。
      const def = CELL_TYPE_BY_NAME.Tribune;
      const idx = def.params.findIndex((v, i) => v === amt && i < 5);
      if (idx < 0) return fail(`没有 ${amt} 这档下注`);

      const tier = parseDiceTable([def.labels[idx]], def.params);
      const faces = tier[Object.keys(tier).map(Number)[0]]?.faces;
      if (!faces?.length) return fail('该档位无结算');
      const need = Math.min(...faces);

      addRes(p, 'money', -amt);
      const dice = rollDice(state);
      state.lastRoll = dice;
      const win = dice >= need;

      let bonus = 0;
      for (const a of abilitiesOf(p)) {
        if (a.flag === 'politicianCharisma') bonus += a.nums?.[0] ?? 1;
      }
      const votes = (tier[need]?.gain?.vote ?? 0) + (win ? bonus : 0);
      if (win && votes) addRes(p, 'vote', votes);
      logIt(`演讲下注 ${amt} 掷出 ${dice}（需 ≥${need}）：${win ? `+${votes} 选票` : '失败'}`);
      return doneUsed(win
        ? `掷出 ${dice}（需 ≥${need}），演讲成功 +${votes} 选票`
        : `掷出 ${dice}（需 ≥${need}），演讲失败，损失 ${amt} 金`);
    }

    // danger 的可选动作已移除——改为落地强制弹窗（见 state.ts resolveLanding）

    case 'risk': {
      // 赌博格：1 = 厄运，2 = 扣钱，3 = 扣选票并加罪恶，4~6 = 加钱
      const table = diceTableOf('Risk');
      const r = rollOnTable(state, p, table);
      if (r.outcome?.special) {
        // 原版：掷出 1 遭遇厄运
        handleSpecialOutcome(state, p, r.outcome.special);
      }
      logIt(`试手气掷出 ${r.dice}：${r.message}`);
      return doneUsed(`掷出 ${r.dice}：${r.message}`);
    }

    case 'casino': {
      // 赌场：1~3 扣钱，4~6 加钱；扣款超过持有则 +2 罪恶
      const table = diceTableOf('Casino');
      const before = p.res.money;
      const r = rollOnTable(state, p, table);
      const delta = p.res.money - before;
      if (delta < 0) {
        // 原版："If you lose more $ than what you have: +2^"
        // addRes 会把金钱夹到 0，所以用"应付额 > 持有额"判断
        const owed = -(r.outcome?.gain?.money ?? 0);
        if (owed > before) addRes(p, 'malice', 2);
        // 「潇洒退场」只在赌场**赢钱**时给额外走牌
      } else if (delta > 0) {
        for (const a of abilitiesOf(p)) {
          if (a.flag !== 'gamblerExtraTurn') continue;
          const key = 'gamblerExtraTurnUsed';
          if (p.flags[key] === state.round * 100 + state.currentIndex) break;
          p.flags[key] = state.round * 100 + state.currentIndex;
          p.extraTurns += 1;
          logIt(`角色能力·${a.label}：+1 次额外走牌`);
        }
      }
      logIt(`赌场掷出 ${r.dice}：${r.message}`);
      return doneUsed(`掷出 ${r.dice}：${r.message}`);
    }

    // ---- 收藏家「挖宝」：收入格二选一 ----
    //
    // 收入格被标为 `autoCellEffect: false`（见 gamedata/decks.ts），
    // 所以落地不自动结算，由这里的两个选项决定。
    // 选完即结束本回合（`runOption` 之后会换人）。
    // ── a121「机械帮手」：到站后无牌可打时弃牌换新牌 ──
    //
    // 卡面："If you cannot play a card for action in the place where you visit,
    //        you can discard 1 card from your hand."
    // 选项由 `cellOptions` 在满足条件时产生（持有永久卡 + 已移动 + 无牌可打）。
    case 'perm': {
      if (parts[1] === 'discardToRedraw') {
        if (!p.hand.length) return fail('没有手牌');
        const n = Number(p.flags['discardIfNoAction']) || 1;
        const dropped = discardFromHand(state, p, n);
        // `drawTo(state, p, k)` 是"再抽 k 张"，不是"补到 k 张" ——
        // 所以要先算差多少，否则手牌会超过上限（实测 3 张弃 1 后抽 6 → 8 张）。
        const drawn = drawTo(state, p, Math.max(0, HAND_SIZE - p.hand.length));
        logIt(`机械帮手：弃 ${dropped.length} 张手牌，补抽至 ${p.hand.length} 张（新抽 ${drawn.length} 张）`);
        return doneUsed(`弃 ${dropped.length} 张、抽 ${drawn.length} 张`);
      }
      return fail('未知的永久卡动作');
    }

    case 'excavation': {
      if (cell.cellType !== 'Income') return fail('只能在收入格使用');
      if (!hasExcavation(p)) return fail('没有「挖宝」能力');
      const n = excavationCount(p);

      if (parts[1] === 'income') {
        // 正常结算收入格：双倍收入
        const gain = p.res.income * 2;
        addRes(p, 'money', gain);
        // 本分支**已经**把收入格的落地效果做完了 → 标记，避免 runOption 再结算一次
        p.flags['cellResolved'] = 1;
        logIt(`「挖宝」：双倍收入 +${gain} 金钱`);
        return doneUsed(`双倍收入，+${gain} 金钱`);
      }

      if (parts[1] === 'swap') {
        // 换牌：放弃本次收入，把手牌换成 n 张新牌。
        // 本分支**没有**执行收入格效果（这正是"换牌"的代价），
        // 所以不设 cellResolved —— 让 runOption 走 finishTurnActions
        // 去结算收入格（它内部会因为 autoCellEffect=false 而不重复给钱）。
        const dropped = [...p.hand];
        const drawn = drawTo(state, p, n);
        // 旧牌全部进弃牌堆；手上留下**刚抽到的**那些。
        //
        // ⚠️ 早先写成"从 p.hand 里删掉仍在 dropped 里的牌"，但 `dropped.includes(id)`
        // 只按 id 判断，同一张牌的实体新旧分不开 —— 若重抽抽回同一张牌，
        // 就会被误删（实测：1 张手牌换牌后手里变成 0 张）。
        // 改为精确重建：手牌 = 刚抽到的那批。
        p.hand = drawn;
        state.discard.push(...dropped);
        logIt(`「挖宝」：放弃收入，换掉 ${dropped.length} 张，重抽 ${drawn.length} 张`);
        return doneUsed(`换牌：弃 ${dropped.length} 张、抽 ${drawn.length} 张`);
      }

      return fail(`未知的挖宝选项 ${optionId}`);
    }

    // ---- 角色能力带来的可选动作 ----
    case 'ability': {
      const which = parts[1];
      switch (which) {
        case 'astralFromBank': {
          const astral = findCellByType(state, 'Astral');
          if (!astral) return fail('棋盘上没有天界');
          p.cellId = astral.id;
          logIt('角色能力·天界俱乐部：从银行直达天界');
          return doneUsed('已传送到天界');
        }
        case 'playAgain': {
          // 可再打一张效果牌：把"本回合已走牌"复位，让 playCard 重新可用。
          // 关键：**同时清掉 optionsOffered**，否则 endTurn 见到它就提前返回，
          // 而 playAgain 已经不再出现在选项里 → 回合永远结束不了（死锁）。
          if (p.flags['extraCardAtOffice'] === 1) return fail('本回合已经用过「再打一张牌」');
          p.flags['extraCardAtOffice'] = 1;
          // 顺手把"本站选项已提示"标上：玩家刚用掉一个选项，
          // 不应再为同一站点的其他选项多停一次回合。
          p.flags['optionsOffered'] = 1;
          p.movedThisTurn = true;
          logIt('角色能力·商业头脑：可再打一张效果牌');
          return doneUsed('可再打一张效果牌');
        }
        case 'discardOne': {
          if (!p.hand.length) return fail('没有手牌');
          const dropped = discardFromHand(state, p, 1);
          logIt(`角色能力·风险经营：弃 ${dropped.length} 张手牌`);
          return doneUsed(`弃 ${dropped.length} 张手牌`);
        }
        case 'sellIncome': {
          const inc = Number(parts[2] ?? 10);
          const gain = Number(parts[3] ?? 100);
          if (p.res.income < inc) return fail(`需要 ${inc} 收入`);
          addRes(p, 'income', -inc);
          addRes(p, 'money', gain);
          logIt(`角色能力·对冲风险：卖 ${inc} 收入得 ${gain} 金`);
          return doneUsed(`卖 ${inc} 收入，得 ${gain} 金`);
        }
        case 'doubleIncome': {
          // ⚠️ 这条路径先前只加**一倍**收入（与「双倍收入」的名字不符），
          // 也没走 resolveCellEffect，会漏掉收入格的其它结算。
          // 现在统一由 `excavation.income` 处理（见上面 case 'excavation'）。
          return fail('已改用 excavation.income');
        }
        case 'drawAndKeep': {
          const n = Number(parts[2] ?? 6);
          const drawn = drawTo(state, p, n);
          if (drawn.length > 1) {
            const best = drawn
              .map((id) => ({ id, v: cardValue(id) }))
              .sort((a, b) => b.v - a.v)[0].id;
            for (const id of drawn) {
              if (id === best) continue;
              const i = p.hand.indexOf(id);
              if (i >= 0) p.hand.splice(i, 1);
              state.discard.push(id);
            }
          }
          logIt(`角色能力·挖宝：抽 ${drawn.length} 张留 1 张`);
          return doneUsed(`抽 ${drawn.length} 张，留 1 张`);
        }
        default:
          return fail(`未知能力动作 ${which}`);
      }
    }

    default:
      return fail(`未知可选动作 ${optionId}`);
  }
}

/** 卡牌粗估值（用于"留 1 张"的取舍） */
function cardValue(id: string): number {
  const c = CARD_BY_ID[id];
  if (!c) return 0;
  return (c.income?.score ?? 0) * 10 + (c.income?.vote ?? 0) * 3
    + (c.income?.money ?? 0) / 50 + c.move;
}

/** 找某类格子的第一个（传送到天界等用） */
function findCellByType(state: EngineState, cellType: string) {
  return getMap(state).cells.find((c) => c.cellType === cellType);
}
