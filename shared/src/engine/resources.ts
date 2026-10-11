// =============================================================
// 资源操作 —— 原版动作参数语法（ActionParams）的统一解释
//
// 已从权威数据归纳出的参数形态：
//   OpponentLoseVotes("1")                   固定数额
//   OpponentPayMoney("250")                  固定数额
//   OpponentLoseMoney("Malice|20|Arrest")    取资源 x 倍率，付不出则逮捕
//   OpponentPayMoney("200|GetHalf|Arrest")   付不出则逮捕，付出的一半给发起者
//   OpponentLoseMoney("Bribe|2|Arrest")      取贿赂 x 2
//
// 因此本模块提供：① 基本增减；② 把 params 解析成宽松的「资源操作规格」。
// =============================================================
import type { EnginePlayer, Resources, ResourceKey } from './model.js';

/** 资源操作结果 */
export interface TransferResult {
  /** 实际转移数额 */
  moved: number;
  /** 是否足额支付 */
  full: boolean;
}

/** 直接改一个资源，并保证不出现负值（term 除外，term 也不为负） */
export function addRes(p: EnginePlayer, key: ResourceKey, amount: number): number {
  if (!amount) return 0;
  if (key === 'term') {
    p.res.term = Math.max(0, p.res.term + amount);
    return amount;
  }
  const before = p.res[key];
  const after = Math.max(0, before + amount);
  p.res[key] = after;
  return after - before;
}

export function getRes(p: EnginePlayer, key: ResourceKey): number {
  return p.res[key];
}

export function hasRes(p: EnginePlayer, key: ResourceKey, amount: number): boolean {
  return p.res[key] >= amount;
}

/**
 * 把 amount 从 from 转移给 to，返回实际转移量。
 * 不足额时只转移持有量，并把 full 置为 false。
 */
export function transferRes(
  from: EnginePlayer,
  to: EnginePlayer | undefined,
  key: ResourceKey,
  amount: number,
  opts: { takePartial?: boolean } = {},
): TransferResult {
  const want = Math.max(0, Math.floor(amount));
  if (want === 0) return { moved: 0, full: true };

  const available = from.res[key];
  const takePartial = opts.takePartial !== false;
  const moved = takePartial ? Math.min(available, want) : available >= want ? want : 0;

  if (moved > 0) {
    addRes(from, key, -moved);
    if (to) addRes(to, key, moved);
  }
  return { moved, full: available >= want };
}

/** 按比例夺取（如"一半金钱"），返回实际夺取量 */
export function takePercent(
  from: EnginePlayer,
  to: EnginePlayer | undefined,
  key: ResourceKey,
  percent: number,
  opts: { round?: 'floor' | 'ceil' } = {},
): number {
  const raw = (from.res[key] * percent) / 100;
  const amount = opts.round === 'ceil' ? Math.ceil(raw) : Math.floor(raw);
  return transferRes(from, to, key, amount).moved;
}

// ---------------------------------------------------------------- 参数解析
/** 参数的语义角色 */
export type ParamSlot =
  | { kind: 'number'; value: number }
  | { kind: 'resource'; value: ResourceKey }
  | { kind: 'tag'; value: string }
  | { kind: 'id'; value: string };

const RESOURCE_ALIASES: Record<string, ResourceKey> = {
  money: 'money', cash: 'money', gold: 'money',
  vote: 'vote', votes: 'vote',
  malice: 'malice', evil: 'malice',
  score: 'score', scores: 'score', cog: 'score', cogs: 'score',
  income: 'income',
  term: 'term', jail: 'term',
};

/**
 * UIN 形态的 id 串。
 *
 * ⚠️ 原版 `ActionParams` 里的 UIN **两种进制都有**：
 *  - 十进制（`AsString` 序列化后的形态）：`14458891128750972929`
 *  - **十六进制**（dnSpy 里直接看到的形态）：`E1D14CE007F0D903`
 *
 * 早先这里只认十进制 `/^\d{8,}$/`，于是十六进制的那些被当成**普通文本**
 * 落进 `tag` 槽位。而 `Teleport` 是按 `slots.filter(kind === 'id')` 取
 * 目的地 cellTypeId 的 —— 取不到就退化到"列出地图上所有格子"，
 * 于是 a024「翻筋斗」能传送到收入格等任意地点（用户报的 bug）。
 *
 * 判据：8 位以上、只含 0-9A-Fa-f。刻意要求**至少 8 位**，
 * 避免把 `"All"` / `"Card"` / `"Opponent"` 这类语义标记误判成 id
 * （它们也是纯字母，但短）。
 */
function looksLikeUin(s: string): boolean {
  return /^(\d{8,}|[0-9A-Fa-f]{8,})$/.test(s);
}

/** 把单个 ActionParams 条目解析成语义槽位 */
export function parseParam(raw: string): ParamSlot {
  if (raw === undefined || raw === null || raw === '') return { kind: 'tag', value: '' };
  const asKey = RESOURCE_ALIASES[raw.toLowerCase()];
  if (asKey) return { kind: 'resource', value: asKey };
  if (/^-?\d+$/.test(raw)) {
    if (looksLikeUin(raw)) return { kind: 'id', value: raw };
    return { kind: 'number', value: Number(raw) };
  }
  if (looksLikeUin(raw)) return { kind: 'id', value: raw };
  return { kind: 'tag', value: raw };
}

export function parseParams(raw: string[] | undefined): ParamSlot[] {
  return (raw ?? []).map(parseParam);
}

/** 一组参数里第一个数值（缺省 fallback） */
export function firstNumber(slots: ParamSlot[], fallback = 0): number {
  for (const s of slots) if (s.kind === 'number') return s.value;
  return fallback;
}

/** 一组参数里第一个资源类型 */
export function firstResource(slots: ParamSlot[]): ResourceKey | undefined {
  for (const s of slots) if (s.kind === 'resource') return s.value;
  return undefined;
}

/** 收集所有标签（Arrest / GetHalf / Discard / Teleport / Evil ...） */
export function tagsOf(slots: ParamSlot[]): string[] {
  return slots.filter((s): s is { kind: 'tag'; value: string } => s.kind === 'tag').map((s) => s.value);
}

export function hasTag(slots: ParamSlot[], tag: string): boolean {
  return tagsOf(slots).some((t) => t.toLowerCase() === tag.toLowerCase());
}

/**
 * 取出紧跟在某个 tag **之后**的那些槽位。
 *
 * 原版用「tag 后面跟数值」的方式表达带参数的语义 tag，例如
 * `OpponentPayScore(1|moneybonus|50|malicebonus|1)`
 * → `moneybonus` 后面跟 50、`malicebonus` 后面跟 1。
 * 只靠 `firstNumber` 无法区分这些数值分别属于谁，所以要按 tag 定位。
 *
 * 返回从该 tag 之后**直到下一个 tag 之前**的槽位。
 */
export function takeTaggedNumbers(slots: ParamSlot[], tag: string): ParamSlot[] {
  const i = slots.findIndex((s) => s.kind === 'tag' && s.value.toLowerCase() === tag.toLowerCase());
  if (i < 0) return [];
  const out: ParamSlot[] = [];
  for (let k = i + 1; k < slots.length; k++) {
    if (slots[k].kind === 'tag') break;   // 碰到下一个 tag 就停
    out.push(slots[k]);
  }
  return out;
}

export function firstId(slots: ParamSlot[]): string | undefined {
  for (const s of slots) if (s.kind === 'id') return s.value;
  return undefined;
}

/**
 * 「支付型」损失的计算核心。
 *
 * 关键区分（已由权威文案核对）：
 *  - `ActionParams` 里的资源槽是**计算依据**，不是支付币种
 *      例: a034 文案 "they pay $ equal to their ^x{1}"，参数 `Malice|20|Arrest`
 *          → 金额 = 玩家罪恶 × 20，以**金钱**支付
 *  - 支付币种由动作原语决定：OpponentLoseMoney/OpponentPayMoney → money，
 *      OpponentPayScore → score，OpponentLoseVotes → vote
 *  - 无资源槽时参数即固定金额
 */
export function payAmount(
  payer: EnginePlayer,
  payee: EnginePlayer | undefined,
  slots: ParamSlot[],
  opts: {
    defaultKey?: ResourceKey;
    /**
     * 付款方是否满足 `Poorest` tag（"最穷"）。为真时金额**翻倍**。
     *
     * 对应卡牌 a011 的 `OpponentPayMoney(Poorest|50)`：
     * 英文原文 "Every other player: … gives you {1}$.
     * If you have the least $, they give you twice as much."
     *
     * 注意 `Poorest` 被 `parseParam` 当成普通 tag，`firstNumber` 仍取到 50，
     * 所以**翻倍必须由调用方通过这个开关告知**——`resources.ts` 拿不到全局
     * 玩家列表，无法自行判断谁最穷。
     */
    poorestDouble?: boolean;
  } = {},
): { paid: number; full: boolean; key: ResourceKey; reason?: 'no-amount' } {
  const payKey: ResourceKey = opts.defaultKey ?? 'money';
  const basis = firstResource(slots);
  const factor = firstNumber(slots, 0);

  let amount = basis ? Math.floor(payer.res[basis] * factor) : factor;
  if (opts.poorestDouble) amount *= 2;

  const r = transferRes(payer, payee, payKey, amount);
  return { paid: r.moved, full: r.full, key: payKey };
}

/** 深拷贝资源（用于状态快照/回滚） */
export function cloneResources(r: Resources): Resources {
  return { ...r };
}
