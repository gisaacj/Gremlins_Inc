// =============================================================
// 自动对局驱动器（测试用）
//
// 从 `playthrough.ts` 提炼出来，供"完整对局 / 胜利条件"等端到端测试复用。
// 策略很笨：能打效果牌就打、能移动就移动、终局靠积累齿轮。
// 目的**不是**验证策略，而是把整条链路跑到底，暴露崩溃、卡死与断点。
// =============================================================
import { CARD_BY_ID, CHARACTERS, mustCurrentPlayer } from '@gremlins/shared/engine';
import {
  canAffordToMove, canMoveWithCard, canPlayCard, chaosOptions, createState, endTurn, playChaosCard,
  playEffectCard, resolvePending, startMove, takeJailTurn,
} from '@gremlins/shared/engine';
import type { EngineState, PendingChoice } from '@gremlins/shared/engine';

export interface AutoGameOptions {
  seed: number;
  /** 参与角色（内部名，如 'Engineer'）数量即玩家数 */
  characters?: string[];
  targetScore?: number;
  /** 最多跑多少"回合"（每个玩家行动一次算一回合） */
  maxRounds?: number;
  chaosEnabled?: boolean;
  /** 单次决策的选项选择器；默认取前 min 个 */
  pickOptions?: (pending: PendingChoice, state: EngineState) => string[];
}

export interface AutoGameResult {
  state: EngineState;
  /** 是否产生了胜者 */
  finished: boolean;
  winnerId?: string;
  /** 实际执行的行动次数 */
  turns: number;
  decisions: number;
  moveActions: number;
  effectActions: number;
  jailTurns: number;
  /** 成功打出的永久卡数 */
  permanentsPlayed: number;
  /** 成功打出的混沌卡数 */
  chaosPlayed: number;
  /** 尝试打出混沌卡的次数 */
  chaosAttempts: number;
  branchesTaken: number;
  /** 日志里出现"尚未实现"的原语 → 次数 */
  unimplemented: Map<string, number>;
  /** 引擎返回的错误（ok=false 或抛异常） */
  errors: string[];
  /** 不变量违规 */
  violations: string[];
}

const DEFAULT_CHARS = ['Engineer', 'Banker', 'Gambler', 'Thief'];

/** 默认选项选择：取前 min 个（够用即可，重点是让流程往下走） */
function defaultPick(pending: PendingChoice): string[] {
  return pending.options.slice(0, Math.max(1, pending.min ?? 1)).map((o) => o.value);
}

/**
 * 跑完一局。会在产生胜者、达到 maxRounds、或行动数超限时停止。
 */
export function runAutoGame(opts: AutoGameOptions): AutoGameResult {
  const chars = opts.characters ?? DEFAULT_CHARS;
  const maxRounds = opts.maxRounds ?? 400;
  const pickOptions = opts.pickOptions ?? ((p: PendingChoice) => defaultPick(p));

  const state = createState({
    roomId: 'auto',
    seed: opts.seed,
    players: chars.map((c, i) => ({
      id: `P${i}`,
      name: `P${i}`,
      isAI: true,
      characterId: CHARACTERS.find((x) => x.name === c)?.id,
    })),
    targetScore: opts.targetScore ?? 30,
    chaosEnabled: opts.chaosEnabled !== false,
  });

  const unimplemented = new Map<string, number>();
  const errors: string[] = [];
  const violations: string[] = [];
  let decisions = 0;
  let moveActions = 0;
  let effectActions = 0;
  let jailTurns = 0;
  let chaosPlayed = 0;
  let permanentsPlayed = 0;
  let chaosAttempts = 0;
  let branchesTaken = 0;

  /** 扫描日志里的"未实现"原语 */
  const sniff = () => {
    for (const l of state.log) {
      const m = /效果「(.+?)」尚未实现/.exec(l.text);
      if (m) unimplemented.set(m[1], (unimplemented.get(m[1]) ?? 0) + 1);
    }
  };

  /** 把挂起决策全部应答掉 */
  const drainPending = (where: string, guard = 30) => {
    let g = 0;
    while (state.pending && g++ < guard) {
      const pending = state.pending;
      decisions++;
      const pick = pickOptions(pending, state);
      if (!pick.length) { state.pending = undefined; break; }
      const r = resolvePending(state, pending.playerId, pick);
      if (!r.ok) { errors.push(`resolvePending(${where}): ${r.reason}`); break; }
    }
  };

  const takeTurn = () => {
    const p = mustCurrentPlayer(state);
    let guard = 0;

    // 0) 服刑回合：抽监狱卡结算，而不是正常走牌
    if (p.inJail) {
      jailTurns++;
      const jr = takeJailTurn(state, p.id);
      if (!jr.ok) errors.push(`takeJailTurn ${p.name}: ${jr.reason}`);
      drainPending('监狱后', 20);
      endTurn(state);
      sniff();
      return;
    }

    // 1) 先清掉挂起
    drainPending('回合初', 40);

    // 2) 尝试打一张效果卡（带移动点数的卡也能在其使用地点打效果，故不按 move 过滤）。
    //
    //    优先打**永久卡**：永久卡会挂上持续触发钩子（`fireTrigger` 系列），
    //    是本引擎里最复杂的一条路径。若总是按手牌顺序取第一张可打的，
    //    永久卡几乎永远轮不到——实测 183 轮、29 次打效果牌，永久卡 0 张。
    const playableEffect = [...p.hand]
      .filter((id) => canPlayCard(state, p, id).ok)
      .sort((a, b) => {
        const ca = CARD_BY_ID[a];
        const cb = CARD_BY_ID[b];
        const pa = ca?.permanent ? 0 : 1;
        const pb = cb?.permanent ? 0 : 1;
        return pa - pb;
      });
    let playedEffect = false;
    for (const id of playableEffect) {
      const card = CARD_BY_ID[id];
      const r = playEffectCard(state, p.id, id);
      effectActions++;
      playedEffect = true;
      if (card?.permanent) permanentsPlayed++;
      if (!r.ok) errors.push(`playEffectCard ${card?.name}: ${r.reason ?? 'unknown'}`);
      drainPending('卡后', 20);
      break;
    }

    // 2b) 尝试打一张**混沌卡**。
    //
    // 这一步很重要：混沌卡是**共享池**（打一张少一张），且
    // "最后一张被打出"会触发终局判定。如果驱动器从不尝试，
    // 整个混沌子系统在端到端测试里永远是 0 覆盖（实测确实如此：
    // 一局跑了 183 轮，混沌打出 0/6）。
    // 放在效果卡之后、移动之前——混沌卡不影响移动阶段。
    if (state.chaosEnabled && state.chaosPool.length) {
      const chaosOpts = chaosOptions(state, p.id);
      // 必须挑**标记为可打出**的那张。`chaosPool` 里可能有需要额外条件
      // 才能打的卡（如 c001「供奉」要先丢弃一张激活的永久卡），
      // 直接拿第一张会反复失败并污染 errors。
      const canPlay = chaosOpts.find((o) => o.playable);
      if (canPlay) {
        chaosAttempts++;
        // c001「供奉」要求指定一张要丢弃的永久卡
        const permanentId = p.permanents[0];
        const r = playChaosCard(state, p.id, canPlay.cardId,
          permanentId ? { permanentId } : {});
        if (r.ok) chaosPlayed++;
        else errors.push(`playChaosCard ${canPlay.name}: ${r.error ?? 'unknown'}`);
        drainPending('混沌后', 20);
      }
    }

    // 3) 移动（挑第一张可移动牌）
    void playedEffect;
    const playable = p.hand.filter((id) => canAffordToMove(state, p, id).ok);
    const moveCard = playable[0];
    if (moveCard) {
      moveActions++;
      let r = startMove(state, p.id, moveCard);
      let g3 = 0;
      while (r.pending && g3++ < 40) {
        decisions++;
        branchesTaken++;
        const pending = r.pending;
        const pick = pickOptions(pending, state);
        if (!pick.length) break;
        if (pending.kind.startsWith('moveBranch:')) {
          r = startMove(state, p.id, moveCard, { [pending.kind]: pick });
        } else {
          const rr = resolvePending(state, pending.playerId, pick);
          if (!rr.ok) errors.push(`resolvePending(移动落点): ${rr.reason}`);
          r = { ok: rr.ok, pending: rr.pending };
        }
      }
      if (!r.ok) errors.push(`startMove: ${r.reason}`);
    }

    // 4) 结束回合
    void guard;
    endTurn(state);
    sniff();
  };

  let turns = 0;
  const turnLimit = maxRounds * state.players.length;
  try {
    while (state.phase === 'playing' && !state.winnerId && turns < turnLimit) {
      // 回合外残留的挂起：安全网
      if (state.pending) {
        const pending = state.pending;
        const pick = pickOptions(pending, state);
        if (!pick.length) { state.pending = undefined; continue; }
        resolvePending(state, pending.playerId, pick);
        continue;
      }
      takeTurn();
      turns++;
    }
  } catch (e) {
    errors.push(`抛出异常: ${(e as Error).message}\n${(e as Error).stack}`);
  }

  sniff();

  // 不变量
  for (const p of state.players) {
    const cell = state.players.length ? state.players.find((x) => x.id === p.id) : undefined;
    void cell;
    if (p.res.money < 0) violations.push(`${p.name} 金钱为负 (${p.res.money})`);
    if (p.res.vote < 0) violations.push(`${p.name} 选票为负 (${p.res.vote})`);
    if (p.res.malice < 0) violations.push(`${p.name} 罪恶为负 (${p.res.malice})`);
    if (p.res.score < 0) violations.push(`${p.name} 齿轮为负 (${p.res.score})`);
    if (p.res.income < 0) violations.push(`${p.name} 收入为负 (${p.res.income})`);
    if (p.hand.length > 12) violations.push(`${p.name} 手牌异常多 (${p.hand.length})`);
  }
  if (state.winnerId) {
    const w = state.players.find((p) => p.id === state.winnerId);
    if (!w) violations.push(`winnerId ${state.winnerId} 不在玩家列表里`);
    else if (w.res.score < state.targetScore) {
      violations.push(`胜者 ${w.name} 齿轮 ${w.res.score} < 目标 ${state.targetScore}`);
    }
  }

  return {
    state,
    finished: !!state.winnerId,
    winnerId: state.winnerId,
    turns, decisions, moveActions, effectActions, jailTurns, branchesTaken,
    chaosPlayed, chaosAttempts, permanentsPlayed,
    unimplemented, errors, violations,
  };
}
