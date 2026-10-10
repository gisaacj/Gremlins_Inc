// =============================================================
// 文案显示层（`{n}` 替换 / 控制符清理 / 中文缺失回退英文）
//
// 数据层保留的是原版原始文案，直接显示会有两个问题：
//   1. 含 `{n}` 占位符 —— 实测 **78/186** 张卡若不替换就会显示裸的 `{1}`
//   2. 中文经常**缺失或只剩片段** —— `test/data/strings/Chinese.txt` 对
//      31 张卡完全没有说明，另有若干只给了 `[m]` 这类标记
//
// ⚠️ 只影响显示。引擎效果走 `actions`/`params`，与文案无关
// （审计确认：受截断影响的卡，效果完整率 100%）。
//
// 本文件刻意**只依赖 `gamedata`**，不依赖 `engine`：
// `engine/state.ts` 需要用它生成玩家可见的选项文案，而 `card-display.ts`
// 依赖 `engine/abilities.ts`，若把这段放在 `card-display.ts` 里就会形成
// `engine → card-display → engine` 的循环。
// =============================================================
import { applyParams, tokenizeSymbols } from './gamedata/text.js';
import type { CardText } from './gamedata/index.js';

/** 提供显示所需文案的最小形状（`ActionCard` / `JailCard` 等都满足） */
export interface CardTextSource {
  text?: CardText;
  en?: { name?: string; description?: string };
  params?: number[];
}

/** 清掉控制符与多余空白（原版文案里有大量 `\r\r`） */
export function cleanGameText(s: string): string {
  return String(s ?? '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 判断一段中文是否"不足以单独显示"。
 *
 * 判据刻意保守，只抓**明确不完整**的情况：
 *  - 空 / 只有空白
 *  - 只剩标记片段（如 `[m]`、`[i]`）
 *  - 没有任何中文、字母或数字（只剩符号/标点）
 *
 * **不比较中英长度**：中文信息密度天然高于英文，用长度比会大量误判
 * （实测会把 140/186 张卡的正常译名误报成"截断"，例如
 * 「永动机」vs "Perpetuum mobile"）。
 */
export function isIncompleteZh(s: string): boolean {
  const t = cleanGameText(s);
  if (!t) return true;
  // 只剩标记片段，如 `[m]` / `[i]`（可带前后空白与标点）
  // ⚠️ 长度不限：`[m]` 是 3 个字符，早期写成 `/^\[[a-z]\]$/`（只匹配单字符）
  // 会漏判，导致 a015/a099 显示成光秃秃的「[m]」。
  if (/^\[[a-z]\]$/.test(t.replace(/[\s。．.、,，]+/g, ''))) return true;
  // 没有任何中文、字母或数字（只剩符号/标点）
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return true;
  return false;
}

/** 优先中文，不足则回退英文 */
function pickText(zh: string | undefined, en: string | undefined): string {
  const z = cleanGameText(zh ?? '');
  if (!isIncompleteZh(z)) return z;
  return cleanGameText(en ?? '');
}

/** 卡牌**名称**的显示文本（中文缺失时回退英文；不做长度比较） */
export function displayCardName(card: CardTextSource): string {
  return pickText(card.text?.name, card.en?.name);
}

/**
 * 卡牌**说明**的显示文本：替换 `{n}`、清控制符、中文不足时回退英文。
 *
 * @param opts.formatted 是否把资源符号归一化成 `[[money]]` 标记
 *                       （客户端用图标渲染；纯文本场景可关掉）
 */
export function displayCardDescription(
  card: CardTextSource,
  opts: { formatted?: boolean } = {},
): string {
  const raw = pickText(card.text?.description, card.en?.description);
  const withParams = applyParams(raw, card.params ?? []);
  return opts.formatted ? tokenizeSymbols(withParams) : withParams;
}

/** 卡牌三条文案的显示版本 */
export function displayCardText(
  card: CardTextSource,
  opts: { formatted?: boolean } = {},
): { name: string; description: string; flavor: string } {
  return {
    name: displayCardName(card),
    description: displayCardDescription(card, opts),
    flavor: cleanGameText(card.text?.flavor ?? ''),
  };
}
