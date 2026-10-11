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
  /** 卡牌短名（`a031` / `t005`…），用于查下面的中文补全表 */
  name?: string;
}

/**
 * **中文补全表**。
 *
 * 游戏的中文语言包在**源头就被截断**：多条译文只保留了第一句，
 * 最关键的部分（尤其监狱卡的**骰子结果表**）整段丢失。实测这些卡的
 * 英文原文是完整的、中文只有半句，例如：
 *
 *   t005「逃出监狱」 中文只有「掷骰子：」，1-6 的结果表全没了
 *   t002「大转盘」   中文只有「掷骰子 - 」，各点数的赔付全没了
 *   t013「上诉」     中文只有「掷骰子：」，几点的结果全没了
 *   t006「恶霸」     **中英都是空的**（原名 "Bully"），只能按数据反推
 *
 * 这里的译文**逐条对照英文原文与卡牌数据（`params` / `income` / `actions`）
 * 人工写出**，不是机器整句意译；数字与术语都与数据一致（金钱/选票/罪恶/
 * 齿轮/收入/贿赂/刑期）。若日后拿到官方中文，直接替换本表即可。
 */
const CARD_ZH_OVERRIDE: Record<string, string> = {
  // ── 监狱卡：补回丢失的骰子结果表 ──
  // params = [100,50,25,25,50,100]，actions = Casino()
  t002: '掷骰子玩地下轮盘：1 = −100 金钱，2 = −50 金钱，3 = −25 金钱，'
    + '4 = +25 金钱，5 = +50 金钱，6 = +100 金钱。',
  // params = [1,1]，actions = ROLL(3, …Jailbreak)
  t005: '掷骰子试图越狱：1、2、3 = +1 罪恶、刑期 +1 次走牌；'
    + '4、5、6 = 传送到垃圾场。',
  // params = [1]，actions = ROLL(3, …Apellation)
  t013: '掷骰子申请上诉：1、2、3 = 无事发生；'
    + '4、5、6 = 你获释！并额外获得 1 次走牌。',
  // 中英皆空；按数据的 income（Term +2、Malice +1）补齐
  t006: '你是狱中恶霸：刑期 +2 次走牌，+1 罪恶。',

  // ── 行动卡：中文只留了第一句（多为"选择任意玩家。"），补回后半段 ──
  // params = [3]，actions = ROLL(3, …Arrest)
  a032: '掷骰子。若掷出 3 或更小：你被逮捕。',
  a144: '掷骰子。若掷出 3 或更小：你被逮捕。',
  // params = [2]，actions = OpponentGetMisfortune(2) + IgnoreCell
  a098: '选择任意其他玩家：该玩家遭遇厄运（由你从 2 个中选 1 个）。'
    + '厄运站点的规则不会影响你。',
  // params = [1]，actions = OpponentSkipTurn(1) + MOVE + OpponentSkipTurn(1)
  a130: '选择任意其他玩家：该玩家跳过 1 次走牌。'
    + '【移动时】以此卡牌移动时：跳过 1 次走牌。',
  // params = [1]，actions = OpponentSkipTurn(1) + PlayExtraCard
  a182: '选择任意其他玩家：该玩家跳过 1 次走牌。你可以再使用一张卡牌。',
  // params = [1]，actions = Teleport(垃圾场) + AddTurn(1)
  a102: '传送到垃圾场。并额外获得 1 次走牌。',
  // ⚠️ 这条的中文（来自原版中文包，不是被截断）**漏了后半句**。
  // 英文原文是两件事：
  //   ① "Choose any player. They teleport to the Jail (only if you have a
  //      current jail term) and serve your term." → 让**对手**替你坐牢
  //   ② "Teleport to the Court."                    → **你自己**去法院
  // 中文只写了 ①。而动作参数指向的是**法院**（D6534DE007B18E10）——
  // 只看中文会以为这张牌把自己送进监狱，与实现不符。这里补齐 ②。
  a103: '选择任意玩家：该玩家瞬移到监狱并替你服刑（仅当你正在服刑时有效）。'
    + '随后你传送到法院。',
  // params = [1]，actions = Perm_AstralElevator(1) + MOVE + OpponentSkipTurn(1)
  a123: '你可以直接从银行移动到天界。'
    + '【移动时】以此卡牌移动时：跳过 1 次走牌。',
  // moveText 里的规则（保留英文原文作为兜底）
  a031: '【移动时】以此卡牌移动时：你可以逆着箭头方向移动。',
  a076: '【移动时】以此卡牌移动时：跳过 1 次走牌。',
  a099: '【交锋时】交锋获胜时：你可以丢弃此卡牌，代替支付金钱。',

  // ── 行动卡：中文只留了主语，英文模板套上中文资源名会变成"中英混杂" ──
  //    （如 a034 显示成 "they pay 金钱 equal to their 罪恶x20"），
  //    比纯英文更糟，所以一并中文化。
  a008: '选择任意玩家：该玩家给你 250 金钱。',
  a010: '选择任意玩家：该玩家给你 3 齿轮。',
  a024: '瞬移到任意赌博站点。'
    + '【移动时】以此卡牌移动时：−50 金钱，并额外走牌 1 次。',
  a034: '选择任意其他玩家：该玩家支付等于其罪恶×20 的金钱。'
    + '若无法付清，该玩家被逮捕。',
  a039: '选择任意玩家：该玩家给你 150 金钱。',
  a041: '选择任意其他玩家：该玩家支付 200 金钱，你获得实际支付额的一半。'
    + '若无法付清，该玩家被逮捕。',
  a043: '查看任意其他玩家的手牌：每发现一张罪恶卡或秘密卡，该玩家给你 100 金钱。',
  a046: '查看任意其他玩家的手牌。你可以丢弃其任意数量的手牌，'
    + '每丢弃一张你 +1 罪恶。该站点的规则不会影响你。',
  a062: '选择任意玩家：该玩家给你 2 齿轮。',
  a063: '选择任意玩家：该玩家给你 30 金钱，并与你交换手牌。',
  a064: '选择任意玩家：该玩家支付等于其罪恶×10 的金钱。',
  a066: '瞬移到任意站点或建筑。'
    + '【移动时】用此卡牌移动时：你可以支付 20 金钱，把移动点数改为 4。',
  a074: '搜寻宝藏，你可以再掷一次骰子（只有最后一次结果算数）。'
    + '【移动时】以此卡牌移动时：+20 金钱。',
  a087: '选择任意玩家：该玩家收入 −10，并给你 50 金钱；你收入 +10。',
  a097: '罪恶最高的玩家（包括你）将遭遇厄运（由你从 2 个中选 1 个）。'
    + '厄运站点的规则不会影响你。',
  a111: '每位玩家（包括你）丢弃一张已激活的永久卡。'
    + '每因此丢弃一张，你 +100 金钱。',
  a163: '选择任意玩家：该玩家给你 100 金钱、被传送到法院，并跳过 1 次走牌。',
  a166: '瞬移到天界。其他每位玩家：−3 选票。',
  a180: '选择任意玩家：该玩家给你 200 金钱、3 齿轮或 6 选票（由你选择）。',
};

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
 * 卡牌 `[m]` / `[i]` 效果原文的**中文对照**。
 *
 * ⚠️ 背景（重要）：游戏的中文语言包在**源头就被截断**了 —— 每条译文只保留了
 * 第一句，`[m]`/`[i]` 那些句子根本没被翻译进去（日文/韩文/俄文同样如此，
 * 说明是基础数据的问题，不是某个语言包的缺失）。
 * 实测：18 种 `[m]`/`[i]` 文本在中文包里**一条都没有**。
 *
 * 所以这里为这 18 条做中文对照。做法是**按语义单元拼装**，不是整句意译：
 * 英文原文由「数值 + 资源符号 + 固定短语」组成（如 `-{1}$ if you use this
 * card to move.`），逐段对照再拼回中文，术语与游戏内保持一致
 * （金钱/选票/罪恶/齿轮/收入/贿赂）。这样既完整又不会走形。
 *
 * 少量无法拆解的整句（a031/a059/a066/a070/a099）**逐条给出**。
 *
 * 若日后拿到官方中文，把这里替换掉即可。
 */
/**
 * 一条效果原文 → 中文的对照规则。
 *
 * 传入前会先做**归一化**（见 `normalizeForTranslate`）：
 *  - `{n}` 占位符替换成具体数值
 *  - 去掉 `数字（资源名）` 里的全角括号
 * 这样模式只需要处理干净的数字，不用兼顾两种形态。
 */
const NUM = '(-?\\d+)';

const MOVE_PHRASE_ZH: Array<[RegExp, string]> = [
  // ── 可拆解的固定句式（先长后短，避免被短的先匹配）──
  [new RegExp(`^Skip ${NUM} turn if you use this card to move\\.$`),
    '以此卡牌移动时：跳过 %1 次走牌。'],
  [new RegExp(`^([+-])${NUM}\\$ if you use this card to move\\.$`),
    '以此卡牌移动时：%1%2 金钱。'],
  [new RegExp(`^([+-])${NUM}\\^ if you use this card to move\\.$`),
    '以此卡牌移动时：%1%2 罪恶。'],
  [new RegExp(`^([+-])${NUM}& if you use this card to move\\.$`),
    '以此卡牌移动时：%1%2 选票。'],
  [new RegExp(`^([+-])${NUM}\\$, \\+?${NUM} extra turn if you use this card to move\\.$`),
    '以此卡牌移动时：%1%2 金钱，并额外走牌 %3 次。'],
  [new RegExp(`^([+-])${NUM}\\$, -${NUM}\\^ if you use this card to move\\.$`),
    '以此卡牌移动时：%1%2 金钱、−%3 罪恶。'],
  [new RegExp(`^([+-])${NUM}&, -${NUM}\\^ if you use this card to move\\.$`),
    '以此卡牌移动时：%1%2 选票、−%3 罪恶。'],
  [new RegExp(`^Get\\|, ${NUM}\\^ if you use this card to move\\.$`),
    '以此卡牌移动时：获得收入，并 +%1 罪恶。'],
  [/^Pay ~ if you use this card to move \(Governor doesn't pay\)\.$/,
    '以此卡牌移动时：支付贿赂（镇长无需支付）。'],
  // ── 整句（无法拆解）──
  [/^You can move against the arrows when you use this card to move\.$/,
    '以此卡牌移动时：你可以逆着箭头方向移动。'],
  [/^To use this card to move, roll the dice and move accordingly\.$/,
    '用此卡牌移动时：掷骰子，并按点数移动。'],
  [/^If you use this card to move, choose another player\. A random card is drawn from their hand: use it to move\.$/,
    '用此卡牌移动时：选择另一名玩家，随机抽其一张手牌，并以该牌的移动点数移动。'],
  [new RegExp(`^When you use this card to move, you can pay ${NUM}\\$ to change move points to 4\\.$`),
    '用此卡牌移动时：你可以支付 %1 金钱，把移动点数改为 4。'],
];

const HAND_PHRASE_ZH: Array<[RegExp, string]> = [
  [/^If you win in a conflict you can discard this card instead of paying the money\.$/,
    '交锋获胜时：你可以丢弃此卡牌，代替支付金钱。'],
  [/^While in conflict you can discard this card and put a player you are in conflict with one spot away from you \(even against the arrows\)\. Your opponent pays you \$\d+$/,
    '交锋中：你可以丢弃此卡牌，把与你交锋的玩家挪到离你 1 格远处（可逆箭头），并由对方付给你 50 金钱。'],
];

/**
 * 翻译前的归一化。
 *
 * 1. `{n}` → 具体数值（用卡牌自己的 `params`）。**必须在翻译前做**：
 *    中文对照表的模式是按"干净数字"写的，留着 `{n}` 会匹配不上
 *    （实测 a140 会变成「- 金钱、− 罪恶」——数字被吞掉）。
 * 2. 去掉 `数字（资源名）` 的全角括号：`detokenize` 会给英文句里的金额加括号，
 *    而对照表的模式写的是 `-20$`（实测 a015 因 `-20（金钱）` 匹配失败）。
 */
function normalizeForTranslate(s: string, params: number[]): string {
  // {n} → params[n-1]
  let out = s.replace(/\{(\d+)\}/g, (m, i) => {
    const v = params[Number(i) - 1];
    return typeof v === 'number' ? String(v) : m;
  });
  // 去掉金额后的全角括号
  out = out.replace(/(\d)（(?:金钱|选票|罪恶|齿轮|收入|贿赂|刑期|金币)）/g, '$1');
  return out;
}

/** 把一条英文 `[m]`/`[i]` 原文翻成中文；无法对照时返回 undefined */
function translateEffectText(
  en: string,
  table: Array<[RegExp, string]>,
  params: number[] = [],
): string | undefined {
  const t = normalizeForTranslate(en.replace(/\s+/g, ' ').trim(), params);
  for (const [re, zh] of table) {
    const m = re.exec(t);
    if (!m) continue;
    // `%n` 对应第 n 个捕获组
    return zh.replace(/%(\d)/g, (_s, i) => m[Number(i)] ?? '');
  }
  return undefined;
}

/**
 * 把原版文案里的 `[m]` / `[i]` 记号换成可读前缀。
 *
 * 原版用这两个记号标注"这张牌**用于移动**时 / **留在手中（交锋）**时的额外规则"，
 * 它们**不是**卡面正文的一部分。原先直接显示成「[m] …」，玩家看不懂。
 */
function expandMarkers(s: string): string {
  return s
    .replace(/\[m\]\s*/gi, '【移动时】')
    .replace(/\[i\]\s*/gi, '【交锋时】')
    .replace(/^【[^】]*】$/, '')      // 只剩一个空记号（后面没有任何文字）→ 丢掉
    .trim();
}

/**
 * 把卡面正文 + `[m]` 移动效果 + `[i]` 手中效果拼成一段可读文本。
 *
 * 原版卡面只印 `[m]` / `[i]`，完整规则在鼠标悬停提示里；这里把它们合并，
 * 玩家一眼就能看到全部效果（**无需悬停**）。
 */
/**
 * 把一段成品文本里**残留的英文效果句**换成中文对照。
 *
 * 为什么需要这一步：`pickText` 在中文被截断时会整体回退到英文，而英文描述
 * **本身就带着** `[m] …` 那句（如 a076 的中文只有 `[m]`，于是整体回退成
 * `[m] Skip {1} turn if you use this card to move.`）。
 * 所以「先翻译、再拼接」的做法抓不到它 —— 必须在**拼装完成后**再过一遍，
 * 把这些英文句子逐句替换掉。
 */
function translateResidualEnglish(s: string, params: number[]): string {
  // 标记前缀要**先摘掉再对照**：对照表的模式是按英文原句（`^You can…`）写的，
  // 带着「【移动时】」前缀会锚定失败（实测 a031/a076 就是因此没被替换）。
  const MARK = /^(【移动时】|【交锋时】)/;
  const lines = s.split(/　|\n/);
  const out = lines.map((line) => {
    const m = MARK.exec(line);
    const prefix = m ? m[1] : '';
    let body = m ? line.slice(prefix.length) : line;
    if (/[A-Za-z]{3,}/.test(body)) {
      const sentences = body.split(/(?<=[.!?])\s+/);
      body = sentences.map((sent) => {
        const zh = translateEffectText(sent, MOVE_PHRASE_ZH, params)
          ?? translateEffectText(sent, HAND_PHRASE_ZH, params);
        return zh ?? sent;
      }).join(' ');
      // 整段再试一次（应对没有句末标点的情况）
      const whole = translateEffectText(body, MOVE_PHRASE_ZH, params)
        ?? translateEffectText(body, HAND_PHRASE_ZH, params);
      if (whole) body = whole;
    }
    return prefix + body;
  });
  return out.join('　');
}

/**
 * 把英文 `[m]`/`[i]` 原文转成中文；无法对照时返回 undefined。
 *
 * 依赖 `translateEffectText` 的对照表；`params` 用于把 `{n}` 换成具体数值。
 */
function effectZh(raw: string, table: Array<[RegExp, string]>, params: number[]): string | undefined {
  return translateEffectText(cleanGameText(raw), table, params);
}

function composeRules(card: CardTextSource): string {
  const params = card.params ?? [];

  // ── 0. 中文补全表优先 ──
  //
  // 这些卡的中文在源头被截断（尤其监狱卡的骰子结果表整段丢失），
  // 补全表是按英文原文 + 卡牌数据人工写的，比残缺中文或纯英文都更可用。
  const override = card.name ? CARD_ZH_OVERRIDE[card.name] : undefined;
  if (override) return override;

  const mv = (card as { moveText?: string }).moveText;
  const hd = (card as { handText?: string }).handText;

  // ── 1. 先算出「移动时 / 交锋时」两段中文 ──
  //    一律从**原始英文**出发（它是完整的），再套中文对照表。
  const moveZh = mv && mv.trim() ? effectZh(mv, MOVE_PHRASE_ZH, params) : undefined;
  const handZh = hd && hd.trim() ? effectZh(hd, HAND_PHRASE_ZH, params) : undefined;

  // ── 2. 主体文本 ──
  let main = detokenize(displayCardDescription(card, { formatted: true }));

  // 主体若因中文截断而回退到英文，它会**自带** `[m] … / [i] …` 那几句英文。
  // 这些句子我们已经用中文给出了（moveZh / handZh），所以要把它们从主体里摘掉，
  // 否则会中英重复。
  //
  // 摘掉的规则：从 `[m]` / `[i]` 记号一直吃到**换行或结尾**。
  // （原版把这两句用换行分隔，`cleanGameText` 之前是 `\r\n`。）
  if (moveZh) main = main.replace(/\[m\][^\n]*/gi, ' ');
  if (handZh) main = main.replace(/\[i\][^\n]*/gi, ' ');

  if (!moveZh && !handZh) {
    // 没有可替换的中文 → 至少把记号变成可读标签
    main = expandMarkers(main);
  }
  main = main.replace(/\s+/g, ' ').trim();

  const parts: string[] = [];
  if (main) parts.push(main);
  if (moveZh) parts.push(`【移动时】${moveZh}`);
  else if (mv && mv.trim() && !main.includes('移动时')) {
    parts.push(`【移动时】${detokenize(applyParams(cleanGameText(mv), params))}`);
  }
  if (handZh) parts.push(`【交锋时】${handZh}`);
  else if (hd && hd.trim() && !main.includes('交锋时')) {
    parts.push(`【交锋时】${detokenize(applyParams(cleanGameText(hd), params))}`);
  }

  return parts.join('　');
}

/**
 * 卡牌**规则说明**的成品文本 —— 直接可显示的那种。
 *
 * ⚠️ 这是给 UI 用的**首选**函数。原因：原版文案里用的是**单个符号**表示资源
 * （`$` 金钱 / `&` 选票 / `^` 罪恶 / `*` 齿轮 / `|` 收入 / `~` 贿赂），
 * 实测 **中文文案里 78/186 张卡带裸符号**（`$`×33、`*`×22、`&`×17 …）。
 * 直接把原始文案丢给界面，玩家看到的就是「选择任意玩家：-4&」这种天书。
 *
 * 本函数一次做完：
 *  1. 替换 `{n}` 占位符（用卡牌自己的 `params`）
 *  2. 把资源符号归一化成内部标记（`[[vote]]` 等）
 *  3. 把标记还原成**中文名**（选票 / 金钱 / …）
 *  4. 把 `[m]` / `[i]` 记号换成「【移动时】」「【交锋时】」并补全缺失的效果原文
 *
 * 需要"用图标渲染"的场景请改用 `displayCardDescription(card, {formatted:true})`，
 * 它会保留 `[[token]]` 标记交给调用方处理。
 */
export function displayCardRules(card: CardTextSource): string {
  return composeRules(card);
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
