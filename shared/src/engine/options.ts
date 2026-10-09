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
  CARD_BY_ID, cellTypeOf, getCell, getMap, getPlayer, currentPlayer as modelCurrentPlayer,
} from './model.js';
import { addRes, hasRes, transferRes } from './resources.js';
import { discardFromHand, drawTo, random, rollDice } from './interp.js';
import { abilitiesOf } from './abilities.js';

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

  if (def?.optional) {
    out.push(...stationOptions(state, p, cell.cellType, pr, def.text.description));
  } else if (cell.cellType === 'Danger') {
    // 冒险格的保险原版是"必选"，但买不买由玩家定，所以即使
    // OptionalFlag=false 也要给出这个选项。
    out.push(...stationOptions(state, p, 'Danger', pr, def?.text.description ?? ''));
  }

  // 角色能力带来的可选动作：与格子的 OptionalFlag 无关
  out.push(...abilityOptions(state, p, cell.cellType));

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
      const cost = pr[0] || 10;
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

    // 冒险：买保险（原版必选，此处作为可选动作展示，不选则视为不买）
    case 'Danger': {
      let cost = pr[0] || 40;
      for (const a of abilitiesOf(p)) {
        if (a.flag === 'insuranceDiscount') cost = a.nums?.[0] ?? 10;
      }
      out.push({
        id: 'danger.insure',
        label: `买保险 ${cost} 金`,
        description,
        affordable: p.res.money >= cost,
        reason: p.res.money >= cost ? undefined : `需要 ${cost} 金钱`,
      });
      break;
    }

    // 风险（赌博格）：掷骰试手气
    case 'Risk': {
      out.push({ id: 'risk.gamble', label: '试手气（掷骰）', description });
      break;
    }

    // 赌场：掷骰赌博
    case 'Casino': {
      out.push({ id: 'casino.gamble', label: '赌博（掷骰）', description });
      break;
    }

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

      // 收入格：双倍收入 / 抽牌留 1 张
      case 'excavation': {
        if (cellType !== 'Income') break;
        const n = a.nums?.[0] ?? 6;
        out.push({
          id: 'ability.doubleIncome',
          label: `双倍收入（+${p.res.income} 金）`,
          description: a.rule,
        });
        out.push({
          id: `ability.drawAndKeep.${n}`,
          label: `抽 ${n} 张，留 1 张`,
          description: a.rule,
        });
        break;
      }

      default:
        break;
    }
  }
  return out;
}

/** 列出该玩家此刻可执行的全部可选动作 */
export function availableOptions(state: EngineState, playerId: string): OptionSpec[] {
  const p = getPlayer(state, playerId);
  if (!p) return [];
  if (state.phase !== 'playing') return [];
  if (state.pending) return [];
  // 只有轮到自己、且已完成走牌才有可选动作
  const cur = modelCurrentPlayer(state);
  if (!cur || cur.id !== playerId) return [];
  return cellOptions(state, p);
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

  switch (parts[0]) {
    // ---- 站点动作 ----
    case 'bank': {
      const cost = pr[0] || 10;
      const gain = pr[1] || 10;
      if (!hasRes(p, 'money', cost)) return fail(`需要 ${cost} 金钱`);
      addRes(p, 'money', -cost);
      addRes(p, 'income', gain);
      logIt(`投资 ${cost} 金，收入 +${gain}`);
      return done(`投资 ${cost} 金，收入 +${gain}`);
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
      return done(`卖 1 选票，得 ${gain} 金`);
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
      return done(`卖 1 齿轮，得 ${gain + bonus} 金`);
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
      return done(`没收 ${r.moved} 选票`);
    }

    case 'plant': {
      const money = pr[0] || 50;
      const malice = pr[1] || 1;
      addRes(p, 'money', money);
      addRes(p, 'malice', -malice);
      p.skipTurns += 1;
      logIt(`在工厂打工：+${money} 金，-${malice} 罪恶，跳过 1 回合`);
      return done(`打工：+${money} 金，-${malice} 罪恶，下回合跳过`);
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
      return done(`休息：-${malice} 罪恶，跳过下回合`);
    }

    case 'junkyard': {
      const bonus = pr[1] || 30;
      const poorest = p.res.money === Math.min(...state.players.map((x) => x.res.money));
      const dice = rollDice(state);
      state.lastRoll = dice;
      let gained = dice * 10;
      if (poorest) gained += bonus;
      // 「了不起的乞丐」：最穷时额外加成（替代常规奖励）
      for (const a of abilitiesOf(p)) {
        if (a.flag === 'homelessTheGreat' && poorest) gained += a.nums?.[0] ?? 60;
      }
      addRes(p, 'money', gained);
      logIt(`翻垃圾掷出 ${dice}：+${gained} 金${poorest ? '（最穷加成）' : ''}`);
      return done(`翻垃圾掷出 ${dice}，+${gained} 金`);
    }

    case 'tribune': {
      const amt = Number(parts[2] ?? 0);
      if (amt <= 0) return fail('下注额无效');
      if (p.res.money < amt) return fail(`需要 ${amt} 金钱`);
      // 原版：下注越高，拿到选票的概率越高。
      // 赢了**退还本金**并 +1 选票；输了失去下注额。
      const chance = Math.min(0.9, 0.2 + amt / 100);
      const win = random(state) < chance;
      // 「超凡魅力」：演讲额外 +1 选票
      let bonus = 0;
      for (const a of abilitiesOf(p)) {
        if (a.flag === 'politicianCharisma') bonus += a.nums?.[0] ?? 1;
      }
      if (win) {
        addRes(p, 'vote', 1 + bonus);
        logIt(`演讲下注 ${amt} 成功：+${1 + bonus} 选票（本金退回）`);
        return done(`演讲成功，+${1 + bonus} 选票`);
      }
      addRes(p, 'money', -amt);
      logIt(`演讲下注 ${amt} 失败：失去 ${amt} 金`);
      return done(`演讲失败，失去 ${amt} 金`);
    }

    case 'danger': {
      let cost = pr[0] || 40;
      for (const a of abilitiesOf(p)) {
        if (a.flag === 'insuranceDiscount') cost = a.nums?.[0] ?? 10;
      }
      if (p.res.money < cost) return fail(`需要 ${cost} 金钱`);
      addRes(p, 'money', -cost);
      p.flags['insured'] = 1;
      logIt(`购买保险 ${cost} 金`);
      return done(`已购买保险（${cost} 金）`);
    }

    case 'risk': {
      const dice = rollDice(state);
      state.lastRoll = dice;
      // 原版 Risk 参数是最低点数 → 奖金 的对照表
      const table: Array<[number, number]> = [];
      for (let i = 1; i + 1 < pr.length; i += 2) table.push([pr[i], pr[i + 1]]);
      let gain = 0;
      for (const [need, amount] of table) if (dice >= need) gain = amount;
      // 「Riskomatic-40」类永久卡与「赌徒幸运星」重掷由能力/永久卡钩子处理
      if (gain > 0) addRes(p, 'money', gain);
      logIt(`试手气掷出 ${dice}：${gain > 0 ? `+${gain} 金` : '无奖励'}`);
      return done(`掷出 ${dice}${gain > 0 ? `，+${gain} 金` : '，无奖励'}`);
    }

    case 'casino': {
      const dice = rollDice(state);
      state.lastRoll = dice;
      const table: Array<[number, number]> = [];
      for (let i = 1; i + 1 < pr.length; i += 2) table.push([pr[i], pr[i + 1]]);
      let gain = 0;
      for (const [need, amount] of table) if (dice >= need) gain = amount;
      if (gain > 0) {
        addRes(p, 'money', gain);
        // 「潇洒退场」：赌场赢钱 +1 额外走牌（每回合一次）
        for (const a of abilitiesOf(p)) {
          if (a.flag !== 'gamblerExtraTurn') continue;
          const key = 'gamblerExtraTurnUsed';
          if (p.flags[key] === state.round * 100 + state.currentIndex) break;
          p.flags[key] = state.round * 100 + state.currentIndex;
          p.extraTurns += 1;
          logIt(`角色能力·${a.label}：+1 次额外走牌`);
        }
      } else {
        // 输掉时：若输的钱超过持有，+2 罪恶
        addRes(p, 'malice', 2);
      }
      logIt(`赌场掷出 ${dice}：${gain > 0 ? `+${gain} 金` : '输钱，+2 罪恶'}`);
      return done(`赌场掷出 ${dice}${gain > 0 ? `，+${gain} 金` : '，输钱 +2 罪恶'}`);
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
          return done('已传送到天界');
        }
        case 'playAgain':
          p.flags['extraCardAtOffice'] = 1;
          logIt('角色能力·商业头脑：可再打一张牌');
          return done('可再打一张牌（不结束回合）');
        case 'discardOne': {
          if (!p.hand.length) return fail('没有手牌');
          const dropped = discardFromHand(state, p, 1);
          logIt(`角色能力·风险经营：弃 ${dropped.length} 张手牌`);
          return done(`弃 ${dropped.length} 张手牌`);
        }
        case 'sellIncome': {
          const inc = Number(parts[2] ?? 10);
          const gain = Number(parts[3] ?? 100);
          if (p.res.income < inc) return fail(`需要 ${inc} 收入`);
          addRes(p, 'income', -inc);
          addRes(p, 'money', gain);
          logIt(`角色能力·对冲风险：卖 ${inc} 收入得 ${gain} 金`);
          return done(`卖 ${inc} 收入，得 ${gain} 金`);
        }
        case 'doubleIncome': {
          const gain = p.res.income;
          addRes(p, 'money', gain);
          logIt(`角色能力·挖宝：双倍收入 +${gain} 金`);
          return done(`双倍收入，+${gain} 金`);
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
          return done(`抽 ${drawn.length} 张，留 1 张`);
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
