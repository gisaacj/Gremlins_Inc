// =============================================================
// 卡牌展示派生层
//
// 原作 `GActionCard` 存的是结构化数值（MovePoints / PriceType / Income / Outcome /
// CellID / 各类旗标），而 UI 想显示的是「成本 50 金钱」「收获 +3 选票」「办公楼」。
// 这里集中做这层派生，避免客户端各自拼装。
//
// 注意：不解析 `ActionList` 里带文本 UIN 的复杂参数——那部分原文文案在
// `card.text.description` 里已经是完整句子，直接展示即可。
// =============================================================
import type { ActionCard, ResourceBundle, PriceType, GameCharacter } from './gamedata/index.js';
import { CELL_TYPE_BY_ID, CELL_TYPE_BY_NAME } from './gamedata/index.js';
import { CHARACTER_ABILITIES, type AbilitySpec } from './engine/abilities.js';

// 文案显示层（`{n}` 替换 / 控制符清理 / 中文缺失回退英文）定义在
// `display-text.ts`——那边只依赖 gamedata，engine 也能安全使用；
// 这里转出去，方便 UI 只 import 一个模块。
export {
  cleanGameText, displayCardDescription, displayCardName, displayCardText,
  isIncompleteZh, type CardTextSource,
} from './display-text.js';

/** 卡牌大类（对应原版旗标） */
export type CardCategory = 'regular' | 'permanent' | 'secret' | 'criminal';

export function cardCategory(card: ActionCard): CardCategory {
  if (card.permanent) return 'permanent';
  if (card.secret) return 'secret';
  if (card.criminal) return 'criminal';
  return 'regular';
}

export const CARD_CATEGORY_ZH: Record<CardCategory, string> = {
  regular: '普通',
  permanent: '永久',
  secret: '秘密',
  criminal: '罪恶',
};

/** 资源显示名 */
const RES_ZH: Array<{ key: keyof ResourceBundle; label: string }> = [
  { key: 'money', label: '金钱' },
  { key: 'vote', label: '选票' },
  { key: 'malice', label: '罪恶' },
  { key: 'score', label: '齿轮' },
  { key: 'income', label: '收入' },
  { key: 'term', label: '刑期' },
];

/**
 * 把资源包格式化成人类可读文本。
 * @param sign 1 = 收获（值本身即正负），-1 = 惩罚（取反）
 */
export function formatResourceBundle(b: ResourceBundle | undefined, sign = 1): string {
  if (!b) return '';
  const parts: string[] = [];
  for (const { key, label } of RES_ZH) {
    const v = (b[key] ?? 0) * sign;
    if (!v) continue;
    parts.push(`${v > 0 ? '+' : ''}${v} ${label}`);
  }
  return parts.join('，');
}

/** 使用地点（中文）。返回空数组表示不限地点 */
export function cardCellTypes(card: ActionCard): string[] {
  if (!card.cellTypeId || card.cellTypeId === '0') return [];
  const def = CELL_TYPE_BY_ID[card.cellTypeId];
  if (!def) return [];
  return [def.cellType];
}

/** 使用地点的中文名数组 */
export function cardBuildingLabels(card: ActionCard): string[] {
  return cardCellTypes(card).map((t) => CELL_TYPE_BY_NAME[t]?.text.name ?? t);
}

/** 成本显示文本，如「50 金钱」；免费返回空串 */
export function cardCostLabel(card: ActionCard): string {
  if (!card.price || card.price <= 0) return '';
  return `${card.price} ${priceTypeLabel(card.priceType)}`;
}

export function priceTypeLabel(t: PriceType): string {
  switch (t) {
    case 'Money': return '金钱';
    case 'Vote': return '选票';
    default: return '';
  }
}

/** 收获显示文本（优先 Income，其次 Outcome） */
export function cardHarvestLabel(card: ActionCard, lang: 'zh' | 'en' = 'zh'): string {
  const income = formatResourceBundle(card.income);
  if (income) return income;
  return '';
}

/** 副作用显示文本（Outcome） */
export function cardOutcomeLabel(card: ActionCard): string {
  return formatResourceBundle(card.outcome);
}

/** 一句话摘要，用于列表/提示 */
export function cardSummary(card: ActionCard): string {
  const parts: string[] = [];
  if (card.move > 0) parts.push(`移动 ${card.move}`);
  const cost = cardCostLabel(card);
  if (cost) parts.push(`成本 ${cost}`);
  const income = cardHarvestLabel(card);
  if (income) parts.push(`收获 ${income}`);
  const places = cardBuildingLabels(card);
  if (places.length) parts.push(`@${places.join('/')}`);
  return parts.join(' · ');
}

/** 可用于打出的地点 id 集合（用于快速筛牌） */
export function cardPlayableAt(card: ActionCard, cellTypeId: string): boolean {
  if (!card.cellTypeId || card.cellTypeId === '0') return true;
  return card.cellTypeId === cellTypeId;
}

/** 卡牌主题色分类（UI 用） */
export function cardTheme(card: ActionCard): 'gold' | 'crime' | 'heaven' | 'court' | 'casino' | 'office' | 'plant' | 'magic' | 'neutral' {
  const ct = cardCellTypes(card)[0];
  switch (ct) {
    case 'Casino':
    case 'Risk':
      return 'casino';
    case 'Courthouse':
    case 'Police':
      return 'court';
    case 'Inferno':
      return 'crime';
    case 'Astral':
      return 'heaven';
    case 'Office':
      return 'office';
    case 'Plant':
    case 'Junkyard':
      return 'plant';
    case 'Bank':
    case 'Treasure':
    case 'Marketplace':
      return 'gold';
    case 'Tribune':
    case 'Income':
      return 'court';
    default:
      return 'neutral';
  }
}

// =============================================================
// 角色展示派生层
// =============================================================

/** 角色技能的展示条目 */
export interface CharacterAbility {
  name: string;
  description: string;
  /** 分类（原作者按 STARTING MODIFIERS / HOME LOCATION / CARDS / EVENTS / OTHER EFFECTS 分组） */
  section: string;
}

/** 原版角色说明的分节标题 -> 中文 */
const SECTION_ZH: Record<string, string> = {
  'STARTING MODIFIERS': '起始修正',
  'HOME LOCATION': '主场地点',
  CARDS: '卡牌',
  EVENTS: '事件',
  'OTHER EFFECTS': '其它效果',
};

/**
 * 从引擎能力表 + 角色文案解析出技能条目。
 *
 * 优先用 `CHARACTER_ABILITIES`（来自 `abilities.ts`，含 label + rule），
 * 因为 `char.text.description` 的中文文案常被截断（如只到"起始标准："）。
 * 如果文案完整则作为补充说明。
 */
export function characterAbilities(char: GameCharacter): CharacterAbility[] {
  const specs = CHARACTER_ABILITIES[char.name];
  if (specs && specs.length) {
    return specs.map((s) => ({
      name: s.label,
      description: s.rule,
      section: abilitySection(s),
    }));
  }
  // 回退：尝试解析 description 文本（文案完整时有效）
  const raw = char.text?.description ?? '';
  if (!raw) return [];
  const out: CharacterAbility[] = [];
  let section = '';
  const lines = raw.replace(/\r/g, '').split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    const head = /^([A-Z][A-Z ()]*[A-Z)]):\s*(.*)$/.exec(s);
    if (head) {
      const rawSection = head[1].trim();
      const key = rawSection.replace(/\s*\(.*\)\s*$/, '').trim();
      section = SECTION_ZH[key] ?? key;
      const rest = head[2]?.trim();
      if (rest && rest !== '---') out.push({ name: section, description: rest, section });
      continue;
    }
    if (s === '---') continue;
    const kv = /^([^:：]{1,24})[:：]\s*(.+)$/.exec(s);
    if (kv) {
      out.push({ name: kv[1].trim(), description: kv[2].trim(), section });
    } else {
      out.push({ name: section || '效果', description: s, section });
    }
  }
  return out;
}

/** 从 AbilitySpec 推导分节名 */
function abilitySection(s: AbilitySpec): string {
  switch (s.event) {
    case 'gameStart': return '起始修正';
    case 'visitHome': return '主场能力';
    case 'afterRoll': return '掷骰';
    case 'afterMove': return '移动后';
    case 'afterPlayCard': return '打牌后';
    case 'turnStart': return '回合开始';
    case 'turnEnd': return '回合结束';
    case 'arrest': return '被捕时';
    case 'beforeConflict': return '交锋前';
    case 'marketSell': return '卖齿轮';
    case 'officeSellVotes': return '卖选票';
    case 'skipMove': return '跳过走牌';
    default: return '能力';
  }
}

/** 角色的起始格（真实棋盘格 id） */
export function characterStartCell(char: GameCharacter): string {
  return char.normalStartCellId;
}

/** 角色简述，用于列表 */
export function characterSummary(char: GameCharacter): string {
  const abil = characterAbilities(char);
  return abil.length ? `${abil.length} 项能力` : '';
}
