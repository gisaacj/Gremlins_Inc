// =============================================================
// AI 决策（纯函数，平台无关）
//
// 服务端与客户端单机共用同一套策略。AI 只做**选择**，
// 所有规则判定都在引擎里（`api.ts`）。
//
// 与旧实现的区别：不再手写回合状态机，而是：
//   1) 有挂起决策 → 挑一个选项
//   2) 狱中 → 服刑
//   3) 能打效果牌 → 打一张（优先高分）
//   4) 能移动 → 移动（优先走向建筑）
//   5) 都不行 → 结束回合
// =============================================================
import type { ActionCard, ChaosCard, EnginePlayer, EngineState } from './model.js';
import { CARD_BY_ID, CELL_TYPE_BY_ID, CHAOS_CARDS, cellTypeOf, cellLabel, getCell, getPlayer } from './model.js';
import {
  answerChoice, chaosOptions, currentPlayerId, isTurn, jailTurn, listOptions, movableCards,
  nextTurn, playableCards, playCard, playChaosCard, runOption, rollMoveDice,
} from './api.js';
import { moveWithCard, discardMoveCard } from './api.js';
import { canMoveWithCard } from './state.js';
import { isDiceMoveCard, isDiscardMoveCard } from '../board-view.js';

/** 取当前格子的第 n 个参数（可选动作的数值） */
function cellTypeParam(state: EngineState, p: { cellId: string }, i: number, fallback: number): number {
  const cell = getCell(state, p.cellId);
  const def = cell ? cellTypeOf(cell) : undefined;
  return def?.params[i] ?? fallback;
}

/** AI 一次决策的日志（供调用方展示"AI 在想什么"） */
export interface AIStep {
  playerId: string;
  action: 'choose' | 'jail' | 'play' | 'move' | 'endTurn' | 'chaos' | 'idle';
  detail?: string;
}

/** 简单的 AI 决策器：状态是显式传入的，便于测试 */
export class AIPlayer {
  /** 统计每个 AI 用过的步数，防死循环 */
  private readonly steps = new Map<string, number>();
  /** 单次调用最多推进多少步 */
  constructor(private readonly maxStepsPerCall = 50) {}

  /**
    * 让指定玩家行动，反复推进直到不再需要它决策。
    * @returns 实际执行的步骤（用于上层判断是否卡住）
    */
  act(state: EngineState, playerId: string): AIStep[] {
    const log: AIStep[] = [];
    const start = this.steps.get(playerId) ?? 0;
    let n = 0;
    /** 本轮已试过的步骤类型，避免无意义重复 */
    let triedOption = false;
    let triedChaos = false;

    while (n < this.maxStepsPerCall) {
      if (state.phase !== 'playing') break;

      // 1) 挂起决策
      if (state.pending) {
        if (state.pending.playerId !== playerId) break;
        const values = this.pickChoice(state);
        const r = answerChoice(state, playerId, values);
        log.push({ playerId, action: 'choose', detail: state.pending?.kind ?? values.join(',') });
        n++;
        if (!r.ok) break;
        continue;
      }

      // 不是它的回合
      if (!isTurn(state, playerId)) break;

      const me = getPlayer(state, playerId);
      if (!me) break;

      // 狱中：服刑（takeJailTurn 内部自动 endTurn 换人）
      if (me.inJail) {
        const r = jailTurn(state, playerId);
        log.push({ playerId, action: 'jail', detail: r.ok ? undefined : r.error });
        n++;
        break;
      }

      // 2) 可选动作：只在明显有利时做（投资回本、卖资源、打工…）
      //    原版规则：用建筑可选动作 = 结束本回合
      //    runOption 成功后内部调 nextTurn，循环会因 isTurn=false 而 break
      if (!triedOption && this.tryOption(state, playerId)) {
        log.push({ playerId, action: 'choose', detail: '可选动作' });
        n++;
        triedOption = true;
        continue;
      }
      triedOption = true;

      // 3) 混沌卡（暴乱卡）：共享池，值就打。
      if (!triedChaos && this.tryChaos(state, playerId)) {
        log.push({ playerId, action: 'chaos', detail: '混沌卡' });
        n++;
        triedChaos = true;
        continue;
      }
      triedChaos = true;

      // 4) 效果牌：优先高分（但罪恶过高时避开罪恶卡）
      //    原版规则：必须先移动到达建筑后才能打出效果牌
      const me2 = getPlayer(state, playerId);
      const maliceHigh = (me2?.res.malice ?? 0) > 15;
      const playable = (me2?.movedThisTurn ? playableCards(state, playerId) : [])
        .filter((id) => {
          if (!maliceHigh) return true;
          const c = CARD_BY_ID[id];
          const maliceGain = (c?.income?.malice ?? 0) + (c?.outcome?.malice ?? 0);
          return maliceGain <= 0;
        })
        .sort((a, b) => cardScoreFor(b, me2?.res.malice ?? 0) - cardScoreFor(a, me2?.res.malice ?? 0));
      if (playable.length) {
        const r = playCard(state, playerId, playable[0]);
        log.push({
          playerId, action: 'play',
          detail: `${CARD_BY_ID[playable[0]]?.name ?? playable[0]}${r.ok ? '' : ` 失败:${r.error}`}`,
        });
        n++;
        if (r.ok) {
          // 打完牌后可能触发额外走牌或可选动作，重置标记
          triedOption = false;
          triedChaos = false;
          continue;
        }
      }

      // 5) 移动：选择能让 AI 打出高分效果牌的目的地，其次收集资源。
      const bestMove = this.findBestMove(state, playerId);
      if (bestMove) {
        let r: { ok: boolean; error?: string; pending?: import('./model.js').PendingChoice };
        if (bestMove.discardCardId) {
          r = discardMoveCard(state, playerId, bestMove.cardId, bestMove.discardCardId, bestMove.dest);
        } else {
          r = moveWithCard(state, playerId, bestMove.cardId, bestMove.dest);
        }
        log.push({
          playerId, action: 'move',
          detail: `${CARD_BY_ID[bestMove.cardId]?.name ?? bestMove.cardId}→${bestMove.destLabel ?? ''}${r.ok ? '' : ` 失败:${r.error}`}`,
        });
        n++;
        if (r.ok) {
          // 移动后到了新地点，可选动作和混沌卡可能可用
          triedOption = false;
          triedChaos = false;
          continue;
        }
      }

      // 6) 收尾
      this.endTurn(state, playerId);
      log.push({ playerId, action: 'endTurn' });
      n++;
      break;
    }

    this.steps.set(playerId, start + n);
    return log;
  }

  /**
   * 尝试打出一张**值得打**的混沌卡。
   *
   * 混沌卡是共享池（打一张少一张），但**不能见钱就打**：
   * 它动辄 1000~2000 金，把现金花光之后 AI 会寸步难行
   * （AI 的主要收入来自"付得起的移动/效果牌"）。
   * 实测把门槛设成 `chaosScore > 0` 时，AI 会在攒够第一笔钱时立刻打掉，
   * 然后陷入长期贫困，整局再也打不出第二张。
   *
   * 所以加一道**财力规划**：
   *  - 能直接把齿轮打到目标线 → 立刻打（赢优先）
   *  - 否则要求付完后仍留有储备（`CHAOS_RESERVE`）
   *  - 门槛仍用 `chaosScore > 0`（收益大于代价与罪恶）
   *
   * c001「供奉」要丢永久卡，AI 取当前第一张（原版是玩家自选）。
   *
   * @returns 是否打出了卡
   */
  private tryChaos(state: EngineState, playerId: string): boolean {
    const me = getPlayer(state, playerId);
    if (!me) return false;

    const cands = chaosOptions(state, playerId)
      .filter((o) => o.playable)
      .filter((o) => chaosScoreFor(o.cardId, me.res.malice) > 0)
      .sort((a, b) => chaosScoreFor(b.cardId, me.res.malice) - chaosScoreFor(a.cardId, me.res.malice));
    if (!cands.length) return false;

    for (const cand of cands) {
      const card = CHAOS_CARDS.find((c) => c.id === cand.cardId);
      if (!card) continue;

      // 罪恶过高时，跳过增加罪恶的混沌卡
      const maliceGain = (card.income?.malice ?? 0);
      if (me.res.malice > 20 && maliceGain > 0) continue;

      // 赢了就立刻打，不看储备
      const gainScore = card.income?.score ?? 0;
      const winsNow = me.res.score + gainScore >= state.targetScore;

      if (!winsNow && !this.canAffordChaosReserve(me, card)) continue;

      const needsSacrifice = card.actions.some((a) => String(a.type) === 'SacrificePermanent');
      if (needsSacrifice) {
        const perm = me.permanents[0];
        if (!perm) continue; // 没永久卡就打不了，换下一张
        if (playChaosCard(state, playerId, card.id, { permanentId: perm }).ok) return true;
        continue;
      }
      if (playChaosCard(state, playerId, card.id).ok) return true;
    }
    return false;
  }

  /**
   * 打出这张混沌卡之后，是否还留得住储备。
   *
   * 储备按**该卡代价的 2 倍**取（上限 $2500）：
   * 代价越大说明局面越富，留的也该越多；但不必无限攒，
   * 否则永远打不出 2000 金的「破坏王」。
   */
  private canAffordChaosReserve(me: EnginePlayer, card: ChaosCard): boolean {
    if (card.price <= 0) return true;
    const key = card.priceType === 'Vote' ? 'vote' : 'money';
    const reserve = Math.min(card.price * 2, 2500);
    return me.res[key] - card.price >= reserve;
  }

  /**
   * 尝试执行一个**有利**的可选动作。
   *
   * 策略：只做确定划算的（投资回本、卖选票/齿轮、打工、翻垃圾、没收选票、
   * 保险优惠、卖收入）。赌博类（`*.gamble`）与演讲下注期望为负，AI 不做。
   *
   * @returns 是否执行了动作
   */
  private tryOption(state: EngineState, playerId: string): boolean {
    const opts = listOptions(state, playerId).filter((o) => o.affordable !== false);
    if (!opts.length) return false;

    // 按"划算程度"排序：优先纯收益，其次用闲置资源换钱
    const rank = (id: string): number => {
      if (id.startsWith('ability.astralFromBank')) return -1; // 传送不产生资源变化，收益不明显
      if (id.startsWith('plant.work')) return 1;
      if (id.startsWith('junkyard.dig')) return 2;
      if (id.startsWith('market.sellScore')) return 3;
      if (id.startsWith('office.sellVote')) return 4;
      if (id.startsWith('court.takeVotes')) return 5;
      if (id.startsWith('ability.sellIncome')) return 6;
      if (id.startsWith('ability.discardOne')) return 8;
      if (id.startsWith('ability.drawAndKeep')) return 7;
      if (id.startsWith('ability.doubleIncome')) return 7;
      // 藏宝阁：纯收益（1~6 依次 +10/+25/+50/+100/+150/+200），必做
      if (id.startsWith('treasure.dig')) return 2;
      if (id.startsWith('danger.insure')) return 9;
      // 需要"后续动作"的选项 AI 不碰：容易在「设标记 → 消费 → 再设标记」
      // 之间打转（曾造成 AI 无限循环，服务端日志刷了两分钟）。
      if (id.startsWith('ability.playAgain') || id.startsWith('ability.astralFromBank')) return 99;
      // 演讲：原版输赢都扣下注额，赢了才 +1 选票（下注 50 命中 2~6，即 5/6 概率）。
      // 期望取决于选票的相对价值，AI 从保守：只试最小两档。
      if (id === 'tribune.speak.10' || id === 'tribune.speak.20') return 7;
      if (id.startsWith('tribune.speak.')) return 99;
      if (id === 'bank.invest') return 7;
      return 99; // 赌博类排最后，等于不做
    };
    // 只做排名靠前的几类
    const candidates = opts
      .filter((o) => rank(o.id) <= 7)
      .sort((a, b) => rank(a.id) - rank(b.id));
    if (!candidates.length) return false;

    const pick = candidates[0];
    // 投资要回本才做（原版：投资 10 金换 10 收入，收入本身有价值）
    if (pick.id === 'bank.invest') {
      const me = getPlayer(state, playerId);
      if (!me) return false;
      const cost = cellTypeParam(state, me, 0, 10);
      const gain = cellTypeParam(state, me, 1, 10);
      if (gain < cost) return false;
    }

    const r = runOption(state, playerId, pick.id);
    return r.ok;
  }

  /** 结束回合（带保护） */
  private endTurn(state: EngineState, playerId: string): void {
    if (state.pending) return;
    if (!isTurn(state, playerId)) return;
    nextTurn(state);
  }

  /** 从挂起决策里挑答案：取前 min 个 */
  private pickChoice(state: EngineState): string[] {
    const pend = state.pending!;
    const n = Math.max(1, pend.min ?? 1);
    return pend.options.slice(0, n).map((o) => o.value);
  }

  /**
   * 找出最优 (移动牌, 目的地) 组合。
   *
   * 对每张可移动牌 BFS 出所有可达格，按到达后能获得的价值排序：
   *  - 能打出高分效果牌的建筑 → 最高价值
   *  - 收入格 → 攒钱（缺钱时重要）
   *  - 演讲格 → 攒选票
   *  - 藏宝阁 / 工厂 / 垃圾场 → 可选动作收益
   *
   * @returns 最优移动组合，或 undefined（无法移动）
   */
  private findBestMove(
    state: EngineState,
    playerId: string,
  ): { cardId: string; dest: string | undefined; destLabel: string; discardCardId?: string } | undefined {
    const me = getPlayer(state, playerId);
    if (!me) return undefined;

    const movable = movableCards(state, playerId);
    if (!movable.length) return undefined;

    let bestCard = '';
    let bestDest: string | undefined = undefined;
    let bestLabel = '';
    let bestVal = -Infinity;
    let bestDiscard: string | undefined = undefined;

    for (const cardId of movable) {
      const card = CARD_BY_ID[cardId];
      if (!card) continue;

      const diceMove = isDiceMoveCard(cardId);
      const discardMove = isDiscardMoveCard(cardId);
      if (card.move <= 0 && !diceMove && !discardMove) continue;

      // 掷骰移动牌：先掷骰拿到步数，再 BFS
      // 弃牌移动牌：选一个对手，以其随机弃牌的 MovePoints 估算步数
      let steps = card.move;
      let discardCardId: string | undefined;
      if (diceMove) {
        steps = rollMoveDice(state, playerId);
      } else if (discardMove) {
        const opp = this.findBestOpponent(state, me);
        if (!opp) continue;
        discardCardId = opp;
        // 用对手手牌的平均移动点数估算步数
        const opp2 = state.players.find((x) => x.id === opp);
        const moves = opp2?.hand.map((id) => CARD_BY_ID[id]?.move ?? 0).filter((m) => m > 0) ?? [];
        steps = moves.length ? Math.round(moves.reduce((a, b) => a + b, 0) / moves.length) : 0;
      }

      const reach = this.reachableCells(state, me.cellId, steps);
      if (!reach.length) continue;

      for (const cellId of reach) {
        const val = this.destValue(state, me, cardId, cellId);
        const freeBonus = cardCost(card) === 0 ? 0.5 : 0;
        const stepPenalty = steps * 0.05;
        const total = val + freeBonus - stepPenalty;
        if (total > bestVal) {
          bestVal = total;
          bestCard = cardId;
          bestDest = cellId;
          bestLabel = cellLabelShort(state, cellId);
          bestDiscard = discardCardId;
        }
      }
    }

    if (!bestCard) return undefined;
    return { cardId: bestCard, dest: bestDest, destLabel: bestLabel, discardCardId: bestDiscard };
  }

  /**
   * 为弃牌移动牌选最佳对手：手牌多、平均移动点数高的优先。
   */
  private findBestOpponent(state: EngineState, me: EnginePlayer): string | undefined {
    let best: string | undefined;
    let bestScore = -Infinity;
    for (const opp of state.players) {
      if (opp.id === me.id || opp.inJail || opp.hand.length === 0) continue;
      const moves = opp.hand.map((id) => CARD_BY_ID[id]?.move ?? 0).filter((m) => m > 0);
      const avg = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : 0;
      const score = avg * 2 + opp.hand.length * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = opp.id;
      }
    }
    return best;
  }

  /**
   * BFS 展开从 from 出发、恰好 maxSteps 步可达的所有格子 id。
   * 玩家必须走完整张牌的步数（不能中途停下），所以只返回最后一层。
   * 死路时返回最后能到达的那一层。
   */
  private reachableCells(state: EngineState, from: string, maxSteps: number): string[] {
    const seen = new Set<string>([from]);
    const result: string[] = [];
    let frontier = [from];
    for (let step = 0; step < maxSteps; step++) {
      const next: string[] = [];
      for (const cid of frontier) {
        const cell = getCell(state, cid);
        if (!cell) continue;
        for (const nb of cell.out) {
          if (seen.has(nb) || !getCell(state, nb)) continue;
          seen.add(nb);
          next.push(nb);
          // 原版规则：路径中途的建筑可以停下（1..N-1 步）
          if (step < maxSteps - 1) {
            const nbCell = getCell(state, nb);
            const nbType = nbCell && CELL_TYPE_BY_ID[nbCell.cellTypeId];
            if (nbType?.building) result.push(nb);
          }
        }
      }
      if (!next.length) break;
      frontier = next;
    }
    // 最后一步：所有可达格子
    result.push(...frontier.filter((id) => id !== from));
    // 去重
    return [...new Set(result)];
  }

  /**
   * 评估某个目的地对当前玩家的价值。
   *
   * 核心思路：**到达后能打出什么**决定格子价值。
   *  - 建筑 + 手中有可打的效果牌 → 效果牌的 cardScore
   *  - 收入格 → 收入值（缺钱时更重要）
   *  - 演讲格 → 最小赌注的期望选票
   *  - 藏宝格 → 平均宝藏收益
   *  - 赌博/危险/厄运/警察/贿赂格 → 负值（尽量避开）
   */
  private destValue(state: EngineState, me: EnginePlayer, moveCardId: string, cellId: string): number {
    const cell = getCell(state, cellId);
    if (!cell) return -1;
    const ct = cellTypeOf(cell);
    if (!ct) return 0;

    // 建筑：检查手中有哪些牌能在此打出
    if (ct.building) {
      let bestPlay = 0;
      let bestPotential = 0;
      for (const handId of me.hand) {
        if (handId === moveCardId) continue; // 移动牌本身打出后已不在手
        const hc = CARD_BY_ID[handId];
        if (!hc) continue;
        // 卡牌的使用地点 == 目标建筑（不是当前位置！）
        if (hc.cellTypeId && hc.cellTypeId !== '0' && hc.cellTypeId !== cell.cellTypeId) continue;
        const v = cardScoreFor(handId, me.res.malice);
        const key = hc.priceType === 'Vote' ? 'vote' : 'money';
        if (hc.price <= 0 || me.res[key] >= hc.price) {
          // 付得起 → 满分
          if (v > bestPlay) bestPlay = v;
        } else {
          // 付不起但有潜力（攒钱后可打）
          const ratio = me.res[key] / hc.price;
          const potential = v * ratio * 0.5;
          if (potential > bestPotential) bestPotential = potential;
        }
      }
      const optVal = this.buildingOptionValue(state, me, cell.cellTypeId);
      return Math.max(bestPlay, bestPotential) + optVal;
    }

    // 收入格：经过得收入，停留得双倍
    if (ct.name === 'Income') {
      const income = me.res.income;
      const need = me.res.money < 200 ? 2 : 1; // 缺钱时收入格价值翻倍
      return income * 0.1 * need;
    }

    // 演讲格：获得选票
    if (ct.name === 'Tribune') {
      const voteNeed = me.res.vote < 5 ? 2 : 1;
      return 0.5 * voteNeed;
    }

    // 贿赂格：扣钱（罪恶越高扣越多）
    if (ct.name === 'Bribe') {
      return -0.3 - me.res.malice * 0.01;
    }

    // 警察格：有被捕风险
    if (ct.name === 'Police') {
      return me.res.money >= 30 ? -0.2 : -0.4;
    }

    // 厄运 / 危险格：负面效果
    if (ct.name === 'Misfortune' || ct.name === 'Danger') {
      return -0.3;
    }

    // 赌博格：期望收益约 0（娱乐性强但 AI 不主动去）
    if (ct.name === 'Gambling') {
      return -0.1;
    }

    return 0;
  }

  /** 建筑可选动作的大致收益（工厂打工、藏宝阁寻宝…） */
  private buildingOptionValue(state: EngineState, me: EnginePlayer, cellTypeId: string): number {
    const ct = CELL_TYPE_BY_ID[cellTypeId];
    if (!ct) return 0;
    switch (ct.name) {
      case 'Treasure':
        return 0.6; // 藏宝阁寻宝：+10~200 金
      case 'Plant':
        return me.res.malice > 0 ? 0.4 : 0.1; // 打工减罪恶
      case 'Junkyard':
        return 0.2; // 翻垃圾：小额金钱
      case 'Bank':
        return me.res.money >= 10 ? 0.3 : 0; // 投资增加收入
      case 'Market':
        return me.res.score > 2 ? 0.3 : 0; // 卖齿轮换钱
      case 'Office':
        return me.res.vote > 2 ? 0.2 : 0; // 卖选票换钱
      default:
        return 0;
    }
  }
}

/** 卡牌价值粗排：齿轮 > 选票 > 金钱，并扣掉代价与罪恶 */
export function cardScore(id: string): number {
  return cardScoreFor(id, 0);
}

/** 带玩家当前罪恶的卡牌价值评估。罪恶越高，新增罪恶的代价越大 */
export function cardScoreFor(id: string, currentMalice: number): number {
  const c = CARD_BY_ID[id];
  if (!c) return 0;
  const inc = c.income;
  const out = c.outcome;
  const gain = (inc?.score ?? 0) * 10 + (inc?.vote ?? 0) * 3 + (inc?.money ?? 0) / 50;
  // 罪恶惩罚随当前罪恶递增：每点已有罪恶让新罪恶更危险
  const maliceWeight = 2 + Math.floor(currentMalice / 5);
  const loss = (out?.score ?? 0) * 10 + (out?.money ?? 0) / 50
    + (inc?.malice ?? 0) * maliceWeight + (out?.malice ?? 0) * maliceWeight;
  const cost = c.price > 0 && c.priceType === 'Money' ? c.price / 100 : c.price > 0 ? c.price * 2 : 0;
  return gain - loss - cost;
}

/** 卡的**现金代价**（选票计价按 0 计——选票不是"用钱移动"）。 */
function cardCost(card: ActionCard | undefined): number {
  if (!card || !card.price) return 0;
  return card.priceType === 'Money' ? card.price : 0;
}

/** 格子名的简短形式（供 AI 日志展示目的地） */
function cellLabelShort(state: EngineState, cellId: string): string {
  const cell = getCell(state, cellId);
  if (!cell) return cellId;
  return cellLabel(cell);
}

/**
 * 混沌卡价值粗排。
 *
 * 与 `cardScore` 同一个量纲：齿轮 ×10、选票 ×3、金钱 ÷50。
 * 收益取自卡牌的 `Income` 字段（原版把混沌卡收益放在这里，`Outcome` 全是 0）。
 *
 * 代价有**两层**：
 *  1. 直接代价（金钱/选票）
 *  2. 罪恶——它会把之后每次贿赂都推高（贿赂 = $20 + 罪恶），
 *     所以按 2 分/点计入，避免 AI 为了齿轮把自己搞到付不起贿赂。
 */
export function chaosScore(cardId: string): number {
  return chaosScoreFor(cardId, 0);
}

/** 带玩家当前罪恶的混沌卡价值评估 */
export function chaosScoreFor(cardId: string, currentMalice: number): number {
  const c = CHAOS_CARDS.find((x) => x.id === cardId);
  if (!c) return 0;
  const inc = (c.income ?? {}) as Record<string, number | undefined>;
  const gain = (inc.score ?? 0) * 10 + (inc.vote ?? 0) * 3 + (inc.money ?? 0) / 50;
  const cost = c.priceType === 'Vote' ? (c.price ?? 0) * 3 : (c.price ?? 0) / 50;
  const maliceWeight = 2 + Math.floor(currentMalice / 5);
  return gain - cost - (inc.malice ?? 0) * maliceWeight;
}

/** 默认共享实例（服务端与客户端单机都能直接用） */
export const defaultAI = new AIPlayer();

/**
 * 便捷入口：为状态里的所有 AI 连续行动，直到轮到人类或结束。
 *
 * @returns 执行过的步骤日志
 */
export function runAIPlayers(state: EngineState, maxSteps = 400): AIStep[] {
  const out: AIStep[] = [];
  let steps = 0;
  while (steps < maxSteps && state.phase === 'playing') {
    const actor = state.pending ? state.pending.playerId : currentPlayerId(state);
    const p = getPlayer(state, actor);
    if (!p?.isAI) break;
    const before = state.log.length;
    const beforeRound = state.round;
    out.push(...defaultAI.act(state, actor));
    steps++;
    // 保险：什么都没变就强制推进，避免卡死
    if (state.log.length === before && state.round === beforeRound && isTurn(state, actor)) {
      if (state.pending) {
        const pend = state.pending;
        answerChoice(state, pend.playerId, pend.options.slice(0, 1).map((o) => o.value));
      } else {
        nextTurn(state);
      }
    }
  }
  return out;
}
