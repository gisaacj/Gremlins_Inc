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
import { applyParams, TOKEN_LABEL_ZH, tokenizeSymbols, type TextToken } from './gamedata/text.js';
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

/** 文本里引用的 `{n}` 占位符编号集合 */
function paramRefs(s: string): Set<string> {
  return new Set([...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]));
}

/**
 * 判断中文是否**丢掉了关键数值**。
 *
 * 这是比 `isIncompleteZh` 更细的一层：中文可能"看起来完整"
 * （有实义词、以句号结束），却把"给多少 / 扣多少"整个删掉了 ——
 * 这类文案对玩家**毫无用处**，因为看不出金额。
 *
 * 判据：**英文引用了 `{n}`，而中文一个都没引用**。
 * 实测命中的例子（共 41/186 张）：
 * - a008 中「选择任意玩家。」／英 "…they give you {1}$."
 *   → 中文完全没说要给钱
 * - a041 中「选择任意其他玩家。」／英 "…they pay {1}$. You get half…"
 * - a034 中「选择任意其他玩家。」／英 "…they pay $ equal to their ^x{1}…"
 *
 * ⚠️ 判据刻意用"中文**一个都没**引用"而不是"少引用了某个"：
 * 中文常把 `{1}` 直接写成具体语义（如「-1选票」直接内部化了数字），
 * 只要它自带数字就不算丢失。只有当它**完全没有占位符**、
 * 而英文**有**时，才说明数值信息整体缺失。
 * 这样也**不会**误伤那些本来就无参数的卡。
 */
export function isMissingKeyNumbers(zh: string, en: string): boolean {
  const rz = paramRefs(cleanGameText(zh));
  const re = paramRefs(cleanGameText(en));
  if (re.size === 0) return false;      // 英文本身就没参数 → 无从丢失
  if (rz.size > 0) return false;        // 中文引用了占位符 → 数值在
  // 中文里是否**自带数字**（可能把 {1} 写成了具体值）？有就不算丢
  if (/\d/.test(cleanGameText(zh))) return false;
  return true;
}

/** 优先中文，不足则回退英文 */
function pickText(zh: string | undefined, en: string | undefined): string {
  const z = cleanGameText(zh ?? '');
  if (isIncompleteZh(z)) return cleanGameText(en ?? '');
  // 中文"形似完整"但丢了关键数值 → 也用英文
  if (isMissingKeyNumbers(z, cleanGameText(en ?? ''))) return cleanGameText(en ?? '');
  return z;
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

/**
 * 把资源标记还原成**中文名**。
 *
 * 与 `plainText` 的区别：在**英文句子里**，标记紧跟在数字后面时用全角括号包起来，
 * 如 `they give you 250金钱.` → `they give you 250（金钱）.`，
 * 避免像把"金钱"当成英文单词糊在一起。
 * 纯中文句子里不加括号（「-1选票」本身就很清楚）。
 */
function detokenize(s: string): string {
  const plain = s.replace(/\[\[([a-z0-9]+)\]\]/g, (_m, k: string) =>
    TOKEN_LABEL_ZH[k as TextToken] ?? k);
  // 整句含拉丁字母 → 判为英文句子，给金额加全角括号
  if (!/[A-Za-z]{2,}/.test(plain)) return plain;
  return plain.replace(/(\d)(金钱|选票|罪恶|齿轮|收入|贿赂|刑期|金币)/g, '$1（$2）');
}

/**
 * 卡牌**规则说明**的成品文本 —— 直接可显示的那种。
 *
 * ⚠️ 这是给 UI 用的**首选**函数。原因：原版文案里用的是**单个符号**表示资源
 * （`$` 金钱 / `&` 选票 / `^` 罪恶 / `*` 齿轮 / `|` 收入 / `~` 贿赂），
 * 实测 **中文文案里 78/186 张卡带裸符号**（`$`×33、`*`×22、`&`×17 …）。
 * 直接把原始文案丢给界面，玩家看到的就是「选择任意玩家：-4&」这种天书。
 *
 * 本函数把三步一次做完：
 *  1. 替换 `{n}` 占位符（用卡牌自己的 `params`）
 *  2. 把资源符号归一化成内部标记（`[[vote]]` 等）
 *  3. 把标记还原成**中文名**（选票 / 金钱 / …）
 *
 * 需要"用图标渲染"的场景请改用 `displayCardDescription(card, {formatted:true})`，
 * 它会保留 `[[token]]` 标记交给调用方处理。
 */
export function displayCardRules(card: CardTextSource): string {
  return detokenize(displayCardDescription(card, { formatted: true }));
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
