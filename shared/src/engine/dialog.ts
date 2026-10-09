// =============================================================
// 对话框按钮（`BUTTON` 原语）
//
// 原版用 `BUTTON` 表达"**二选一**"：一张牌里出现两次 `BUTTON`，
// 各带一条分支动作序列，玩家点一个按钮就走对应分支。
// 典型是厄运牌「两害取其轻」：
//
//   m020  BUTTON ["-$150","Money","150"]   BUTTON ["-*2"]
//         SelectSelf / OpponentLoseMoney    SelectSelf / OpponentLoseScore
//   说明: -{1}$（你必须拥有{1}$）或 -{2}*
//
// 第一个参数是**按钮文案**，两种形态：
//   1. 符号语法：`-$150`、`+^4`、`-*2`、`-|10`、`+^5 +*1`
//      符号见游戏内说明：`$` 金钱、`&` 选票、`^` 罪恶、`|` 收入、`*` 齿轮
//   2. **十六进制 UIN**：`CACBE81C8D511C3D` → 十进制查文案表 → 「丢弃」
//      （注意普通 UIN 是十进制，只有 ActionParams 里是十六进制）
//
// 第二、三个参数（Money/150）是给 UI 用的结构化提示，本引擎不依赖它们。
// =============================================================
import { STRINGS, DEFAULT_LANG } from '../gamedata/index.js';
import type { CardAction } from './model.js';

/**
 * 按十六进制 UIN 查文案。
 *
 * `ActionParams` 里的 UIN 是十六进制（如 `CACBE81C8D511C3D`），
 * 而文案表按十进制索引 → 需要换算。**不要**直接拿十六进制串去查。
 */
export function hexUinToText(hex: string, lang?: string): string | undefined {
  if (!/^[0-9A-F]{16}$/.test(hex)) return undefined;
  let dec: string;
  try { dec = BigInt(`0x${hex}`).toString(); } catch { return undefined; }
  const entry = STRINGS[dec];
  if (!entry) return undefined;
  return (lang && entry[lang as never]) || entry[DEFAULT_LANG] || entry.en || Object.values(entry)[0];
}

/** 一个可点的按钮 */
export interface DialogButton {
  /** 按钮文案（已本地化） */
  label: string;
  /** 点了之后从哪个下标继续执行（-1 表示执行到动作序列末尾） */
  branchStart: number;
  /** 该分支的结束下标（不含） */
  branchEnd: number;
  /** 该分支的动作（供 UI 预览与"是否可选"判断） */
  actions: CardAction[];
  /** 原始参数，便于追溯 */
  raw: string[];
}

const RES_SYMBOL: Record<string, 'money' | 'vote' | 'malice' | 'income' | 'score'> = {
  $: 'money', '&': 'vote', '^': 'malice', '|': 'income', '*': 'score',
};

const RES_ZH: Record<string, string> = {
  money: '金钱', vote: '选票', malice: '罪恶', income: '收入', score: '齿轮',
};

/**
 * 把按钮文案参数解析成人类可读的标签。
 *
 * @returns 形如「-150 金钱」「+4 罪恶」「丢弃」
 */
export function parseButtonLabel(params: string[]): string {
  const raw = String(params?.[0] ?? '').trim();
  if (!raw) return '…';

  // 1) 十六进制 UIN → 查文案表
  if (/^[0-9A-F]{16}$/.test(raw)) {
    const text = hexUinToText(raw);
    if (text) return text;
    return raw; // 查不到就原样显示，便于排查
  }

  // 2) 符号语法：**符号在数字前面**（`-$150`、`+^4`、`-*2`、`-|10`、`+^5 +*1`）。
  //    注意顺序与卡牌说明里的 `-{1}$` 相反，别按那个习惯写正则。
  const parts: string[] = [];
  const re = /([+-])\s*([$&^|*])\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const key = RES_SYMBOL[m[2]];
    if (!key) continue;
    parts.push(`${m[1]}${Number(m[3])} ${RES_ZH[key]}`);
  }
  if (parts.length) return parts.join('，');

  // 3) 兜底：原样
  return raw;
}

/**
 * 扫描动作序列，把 `BUTTON` 结构解析成按钮列表。
 *
 * 约定：第 k 个按钮的分支从它自己之后开始，到第 k+1 个按钮之前结束；
 * 最后一个按钮的分支延伸到序列末尾。
 *
 * @returns 按钮列表；没有 `BUTTON` 时返回空数组
 */
export function collectButtons(actions: CardAction[]): DialogButton[] {
  const positions: number[] = [];
  for (let i = 0; i < actions.length; i++) {
    if (String(actions[i].type) === 'BUTTON') positions.push(i);
  }
  if (!positions.length) return [];

  return positions.map((_, k) => {
    const btnIdx = positions[k];
    const nextBtn = positions[k + 1] ?? actions.length;
    return {
      label: parseButtonLabel(actions[btnIdx].params ?? []),
      branchStart: btnIdx + 1,
      branchEnd: nextBtn,
      actions: actions.slice(btnIdx + 1, nextBtn),
      raw: actions[btnIdx].params ?? [],
    };
  });
}

/** 动作序列里是否有 `BUTTON`（即需要玩家二选一） */
export function hasButton(actions: CardAction[]): boolean {
  return actions.some((a) => String(a.type) === 'BUTTON');
}
