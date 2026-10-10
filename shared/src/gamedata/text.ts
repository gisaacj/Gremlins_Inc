// 本文件由 tools/gen-shared-data.mjs 自动生成，请勿手工编辑。
// 数据来源: Gremlins, Inc. 原版 Assembly-CSharp.dll (GServer.DM)
// 原版资源符号与文本占位符的解析

/** 文案中的资源标记 —— 由原版单字符符号归一化而来 */
export type TextToken =
  | 'money'
  | 'vote'
  | 'malice'
  | 'score'
  | 'bribe'
  | 'income'
  | 'money2'
  | 'bribe2'
  | 'term';

/** 原版符号 -> 标记（顺序有意义：长组合优先） */
const SYMBOL_TO_TOKEN: ReadonlyArray<readonly [string, TextToken]> = [
  ['@', 'money2'],
  ['#', 'bribe2'],
  ['$', 'money'],
  ['&', 'vote'],
  ['^', 'malice'],
  ['*', 'score'],
  ['~', 'bribe'],
  ['|', 'income'],
  ['+', 'term'],
];

/** 标记的缺省中文显示（客户端可用图标替换） */
export const TOKEN_LABEL_ZH: Record<TextToken, string> = {
  money: '金钱', vote: '选票', malice: '罪恶', score: '齿轮',
  bribe: '贿赂', income: '收入', money2: '金币', bribe2: '贿赂', term: '刑期',
};

/**
 * 把原版文案转成带 [[token]] 标记的文本。
 * 注意: '+' 在结算文本里表示刑期, 但也会出现在普通文案中, 因此默认不转换, 由调用方决定。
 */
export function tokenizeSymbols(s: string, opts: { plusAsTerm?: boolean } = {}): string {
  let out = s;
  for (const [sym, token] of SYMBOL_TO_TOKEN) {
    if (sym === '+' && !opts.plusAsTerm) continue;
    out = out.split(sym).join('[[' + token + ']]');
  }
  return out;
}

/** 用 params[n-1] 替换文案里的 {n} */
export function applyParams(s: string, params: number[]): string {
  if (!params?.length) return s;
  let out = s;
  for (let i = 0; i < params.length; i++) out = out.split('{' + (i + 1) + '}').join(String(params[i]));
  return out;
}

/** 一次性完成 {n} 替换与符号归一化 */
export function formatGameText(
  s: string,
  params: number[] = [],
  opts: { plusAsTerm?: boolean } = {},
): string {
  return tokenizeSymbols(applyParams(s ?? '', params), opts);
}

/** 把带标记的文本还原成纯文本（日志、占位渲染用） */
export function plainText(
  s: string,
  label: Record<TextToken, string> = TOKEN_LABEL_ZH,
): string {
  return (s ?? '').replace(/\[\[([a-z0-9]+)\]\]/g, (m, k) => label[k as TextToken] ?? m);
}
