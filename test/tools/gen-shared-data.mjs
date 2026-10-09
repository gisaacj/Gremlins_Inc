#!/usr/bin/env node
/**
 * 把从 Assembly-CSharp.dll (GServer.DM) 导出的权威数据转换成 shared/ 下的类型化 TS 模块。
 *
 * 输入: ../data/*.json            (extract-dm.ps1 产出)
 *       ../data/strings/*.txt    (extract-strings.ps1 产出, UIN<TAB>文本)
 * 输出: E:/code/小魔怪/shared/src/gamedata/*
 *
 * 用法: node tools/gen-shared-data.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'data');
const OUT = 'E:/code/小魔怪/shared/src/gamedata';

/** 随包发布的语言（其余语言包留在导出目录，需要时再启用） */
const SHIPPED_LANGS = ['Chinese', 'English'];
const LANG_CODES = { Chinese: 'zh', English: 'en' };

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const uinStr = (u) => (u && typeof u === 'object' ? String(u.AsString ?? '') : String(u ?? ''));
const isEmptyUin = (s) => !s || s === '0';

// ---------------------------------------------------------------- 文案
function loadStrings(lang) {
  const p = path.join(SRC, 'strings', `${lang}.txt`);
  const map = new Map();
  if (!fs.existsSync(p)) return map;
  const txt = fs.readFileSync(p, 'utf8');
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const i = line.indexOf('\t');
    if (i < 0) continue;
    map.set(line.slice(0, i), line.slice(i + 1).replace(/\r$/, ''));
  }
  return map;
}

const stringsByLang = Object.fromEntries(SHIPPED_LANGS.map((l) => [l, loadStrings(l)]));

/** 取某语言文本；缺失则回退英文；再缺失返回空串 */
function t(uin, lang = 'Chinese') {
  const s = uinStr(uin);
  if (isEmptyUin(s)) return '';
  const hit = stringsByLang[lang]?.get(s) || stringsByLang.English?.get(s);
  if (hit) return hit;

  // ⚠️ `ActionParams` 里的 UIN 是**十六进制**形式（如 "CACBE81C8D511C3D"），
  // 而语言包是按**十进制** UIN 索引的。直接拿十六进制串去查必然查不到，
  // 于是 `BUTTON` 这类"二选一"按钮文案会变成空。
  // 这里把十六进制换算成十进制再查一次。
  if (/^[0-9A-F]{16}$/.test(s)) {
    const dec = BigInt(`0x${s}`).toString();
    return stringsByLang[lang]?.get(dec) || stringsByLang.English?.get(dec) || '';
  }
  return '';
}

/** 生成 (uin) => 各语言文本 的紧凑字面量 */
function multi(uin) {
  const out = {};
  for (const l of SHIPPED_LANGS) {
    const v = t(uin, l);
    out[LANG_CODES[l]] = v;
  }
  return out;
}
const hasText = (uin) => SHIPPED_LANGS.some((l) => t(uin, l) !== '');

// ---------------------------------------------------------------- TS 输出工具
const banner = (title, extra = '') =>
  `// 本文件由 tools/gen-shared-data.mjs 自动生成，请勿手工编辑。\n` +
  `// 数据来源: Gremlins, Inc. 原版 Assembly-CSharp.dll (GServer.DM)\n` +
  `// ${title}${extra ? '\n// ' + extra : ''}\n\n`;

const ts = (v) => JSON.stringify(v); // 输出合法 TS 字面量
const num = (v) => Number(v) || 0;
const bool = (v) => v === true;

function write(rel, content) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  const kb = (fs.statSync(p).size / 1024).toFixed(1);
  console.log(`  ${rel.padEnd(24)} ${kb.padStart(8)} KB`);
}

// ---------------------------------------------------------------- 1. 枚举
const actionCards = readJson('action_cards.json');
const cellTypes = readJson('cell_types.json');
const characters = readJson('characters.json');
const jailCards = readJson('jail_cards.json');
const chaosCards = readJson('chaos_cards.json');
const misfortuneCards = readJson('misfortune_cards.json');
const maps = readJson('maps.json');
const consts = readJson('const.json');
const dialogs = readJson('dialogs.json');
const dialogAnswers = readJson('dialog_answers.json');
const achievements = readJson('achievements.json');
const tutors = readJson('tutors.json');

const uniqSorted = (arr) => [...new Set(arr)].sort();
const cellTypeNames = uniqSorted(cellTypes.map((c) => c.CellType));
const priceTypes = uniqSorted([...actionCards, ...chaosCards].map((c) => c.PriceType));

const actionTypeSet = new Set();
for (const list of [actionCards, characters, jailCards, chaosCards, misfortuneCards, cellTypes]) {
  for (const o of list) for (const a of o.ActionList || []) actionTypeSet.add(a.ActionType);
}
const actionTypes = [...actionTypeSet].sort();

write(
  'enums.ts',
  banner(`${cellTypeNames.length} 种格子类型 / ${priceTypes.length} 种费用类型 / ${actionTypes.length} 种动作原语`) +
    `/** 格子（站点或建筑）类型 —— 对应原版 ECellType */\nexport type CellTypeName =\n` +
    cellTypeNames.map((n) => `  | '${n}'`).join('\n') +
    `;\n\nexport const CELL_TYPE_NAMES = [\n` +
    cellTypeNames.map((n) => `  '${n}',`).join('\n') +
    `\n] as const satisfies readonly CellTypeName[];\n\n` +
    `/** 卡牌/建筑的付费资源类型 —— 对应原版 GPriceType */\nexport type PriceType =\n` +
    priceTypes.map((n) => `  | '${n}'`).join('\n') +
    `;\n\n` +
    `/** 动作原语 —— 对应原版 EAction，共 ${actionTypes.length} 种，引擎需逐条实现 */\nexport type ActionType =\n` +
    actionTypes.map((n) => `  | '${n}'`).join('\n') +
    `;\n\nexport const ACTION_TYPES = [\n` +
    actionTypes.map((n) => `  '${n}',`).join('\n') +
    `\n] as const satisfies readonly ActionType[];\n`
);

// ---------------------------------------------------------------- 2. 棋盘
// 注意: GCell.CaptionID / DescriptionID 在 DM 数据里为空, 格子的文案要经由
// GCell.CellTypeID 指向的 GCellType 取。这里预先把 cellTypeId -> 文案 建好。
const cellTypeTextById = new Map(
  cellTypes.map((c) => [
    uinStr(c.ID),
    { name: t(c.CaptionID), description: t(c.DescriptionID), flavor: t(c.FlavorTextID) },
  ])
);

function buildMap(mapObj) {
  const cells = Object.entries(mapObj.Cells).map(([key, c]) => {
    const typeId = uinStr(c.CellTypeID);
    const typeText = cellTypeTextById.get(typeId) || { name: '', description: '', flavor: '' };
    return {
      key,
      id: uinStr(c.ID),
      cellType: c.CellType,
      name: c.Name,
      num: num(c.Num),
      out: (c.OutCells || []).map(uinStr).filter((x) => x && x !== '0'),
      in: (c.InCells || []).map(uinStr).filter((x) => x && x !== '0'),
      cellTypeId: typeId,
      soundId: uinStr(c.SoundID),
      soundVolume: num(c.SoundVolume),
      caption: c.Caption || '',
      description: c.Description || '',
      flavorText: c.FlavorTextID || '',
      /** 文案继承自所属格子类型定义（中文/英文） */
      text: {
        caption: typeText.name || c.Caption || '',
        description: typeText.description || c.Description || '',
      },
    };
  });
  cells.sort((a, b) => a.num - b.num);
  return { id: uinStr(mapObj.ID), name: mapObj.Name, cells };
}

const mapList = Object.values(maps.MapList).map(buildMap);
const normalMap = mapList.find((m) => m.name === 'Normal') || mapList[0];
const colonyMap = mapList.find((m) => m.name !== 'Normal');

write(
  'board.ts',
  banner(`${mapList.length} 张地图：${mapList.map((m) => `${m.name}=${m.cells.length}格`).join(' / ')}`,
    '邻接关系来自原版 GMap.Cells[].OutCells / InCells') +
    `import type { CellTypeName } from './enums.js';\n\n` +
    `/** 棋盘格 —— 对应原版 GCell */\nexport interface BoardCell {\n` +
    `  /** 原版字典键（十六进制 UIN 串），客户端仅用于调试 */\n  key: string;\n` +
    `  /** 十进制 UIN，对外稳定标识 */\n  id: string;\n  cellType: CellTypeName;\n` +
    `  /** 原版格名，如 Cell1.Bank */\n  name: string;\n` +
    `  /** 原版格号（1 起，用于排序与展示） */\n  num: number;\n` +
    `  /** 出发边（可达格 id） */\n  out: string[];\n  /** 入边（可达本格的 id） */\n  in: string[];\n` +
    `  cellTypeId: string;\n  soundId: string;\n  soundVolume: number;\n` +
    `  /** 原文标题（英文，兼容旧逻辑） */\n  caption: string;\n  description: string;\n  flavorText: string;\n` +
    `  text: { caption: string; description: string };\n}\n\n` +
    `export interface BoardMap {\n  id: string;\n  name: string;\n  cells: BoardCell[];\n}\n\n` +
    `export const BOARD_MAPS: BoardMap[] = ${ts(mapList)} as BoardMap[];\n\n` +
    `export const NORMAL_MAP: BoardMap = ${ts(normalMap)} as BoardMap;\n` +
    (colonyMap ? `export const COLONY_MAP: BoardMap = ${ts(colonyMap)} as BoardMap;\n` : '') +
    `\nexport const MAP_BY_ID: Record<string, BoardMap> = Object.fromEntries(\n  BOARD_MAPS.map((m) => [m.id, m])\n);\n`
);

// ---------------------------------------------------------------- 3. 卡牌
function buildActionList(list) {
  return (list || []).map((a) => {
    const o = { type: a.ActionType };
    const params = (a.ActionParams || []).filter((p) => p !== undefined && p !== null);
    if (params.length) o.params = params;
    return o;
  });
}

const cardOut = actionCards.map((c) => ({
  id: uinStr(c.ID),
  name: c.Name,
  move: num(c.MovePoints),
  customMove: num(c.CustomMovePoints),
  priceType: c.PriceType,
  price: num(c.PriceValue),
  deckCount: num(c.DeckCount),
  permanent: bool(c.PermanentFlag),
  secret: bool(c.SecretFlag),
  criminal: bool(c.CriminalFlag),
  special: bool(c.SpecialFlag),
  specialMove: bool(c.SpecialMoveFlag),
  instant: bool(c.InstantFlag),
  num: num(c.Num),
  /** 可使用该卡的格子类型 id（对应 CellTypeDef.id，不是棋盘格 id） */
  cellTypeId: uinStr(c.CellID),
  income: resOf(c.Income),
  outcome: resOf(c.Outcome),
  params: [num(c.Param1), num(c.Param2), num(c.Param3), num(c.Param4), num(c.Param5), num(c.Param6)],
  actions: buildActionList(c.ActionList),
  text: { name: t(c.CaptionID), description: t(c.DescriptionID), flavor: t(c.FlavorTextID) },
  en: { name: stringsByLang.English.get(uinStr(c.CaptionID)) || c.Caption || '' },
}));

function resOf(r) {
  if (!r) return undefined;
  const o = {
    money: num(r.Money),
    vote: num(r.Vote),
    score: num(r.Score),
    malice: num(r.Malice),
    term: num(r.Term),
    income: num(r.Income),
  };
  return Object.values(o).some((v) => v !== 0) ? o : undefined;
}

write(
  'cards.ts',
  banner(`${cardOut.length} 张行动卡，牌库共 ${cardOut.reduce((s, c) => s + c.deckCount, 0)} 张`,
    '成本/收获/旗标/动作序列均为原版数值，非 OCR 估算') +
    `import type { ActionType, PriceType } from './enums.js';\n\n` +
    `/** 资源包 —— 对应原版 GResource */\nexport interface ResourceBundle {\n` +
    `  money: number;\n  vote: number;\n  score: number;\n  malice: number;\n  term: number;\n  income: number;\n}\n\n` +
    `/** 动作项 —— 对应原版 GActionItem */\nexport interface CardAction {\n` +
    `  type: ActionType;\n  /** 原版 ActionParams（含资源/文本 UIN 与数值的裸串） */\n  params?: string[];\n}\n\n` +
    `export interface CardText {\n  name: string;\n  description: string;\n  flavor: string;\n}\n\n` +
    `/** 行动卡 —— 对应原版 GActionCard */\nexport interface ActionCard {\n` +
    `  id: string;\n  /** 原版内部名，如 a001 */\n  name: string;\n` +
    `  /** 移动点数 */\n  move: number;\n  customMove: number;\n` +
    `  priceType: PriceType;\n  /** 费用数额 */\n  price: number;\n` +
    `  /** 该卡在牌库中的张数 */\n  deckCount: number;\n` +
    `  permanent: boolean;\n  secret: boolean;\n  criminal: boolean;\n` +
    `  special: boolean;\n  specialMove: boolean;\n  instant: boolean;\n  num: number;\n` +
    `  /** 可使用该卡的格子类型 id（对应 CellTypeDef.id，空/0 表示不限） */\n  cellTypeId: string;\n` +
    `  income?: ResourceBundle;\n  outcome?: ResourceBundle;\n` +
    `  /** Param1..6 原版附加参数 */\n  params: number[];\n  actions: CardAction[];\n` +
    `  /** 中文等随包语言的文案 */\n  text: CardText;\n  /** 英文名，便于对照 */\n  en: { name: string };\n}\n\n` +
    `export const ACTION_CARDS: ActionCard[] = ${ts(cardOut)} as ActionCard[];\n\n` +
    `export const CARD_BY_ID: Record<string, ActionCard> = Object.fromEntries(\n  ACTION_CARDS.map((c) => [c.id, c])\n);\n\n` +
    `export const CARD_BY_NAME: Record<string, ActionCard> = Object.fromEntries(\n  ACTION_CARDS.map((c) => [c.name, c])\n);\n`
);

// ---------------------------------------------------------------- 4. 角色
const charOut = characters.map((c) => ({
  id: uinStr(c.ID),
  name: c.Name,
  order: num(c.StepOrderNum),
  normalStartCellId: uinStr(c.NormalCellStartID),
  colonyStartCellId: uinStr(c.ColonyCellStartID),
  actions: buildActionList(c.ActionList),
  text: { name: t(c.CaptionID), description: t(c.DescriptionID), flavor: t(c.FlavorTextID) },
}));
charOut.sort((a, b) => a.order - b.order);

const jailOut = jailCards.map((c) => ({
  id: uinStr(c.ID),
  name: c.Name,
  rank: num(c.Rank),
  karma: num(c.Karma),
  imageNum: num(c.ImageNum),
  deckCount: num(c.DeckCount),
  income: resOf(c.Income),
  outcome: resOf(c.Outcome),
  params: [num(c.Param1), num(c.Param2), num(c.Param3), num(c.Param4), num(c.Param5), num(c.Param6)],
  actions: buildActionList(c.ActionList),
  text: { name: t(c.CaptionID), description: t(c.DescriptionID), flavor: t(c.FlavorTextID) },
}));

write(
  'characters.ts',
  banner(`${charOut.length} 个角色 + ${jailOut.length} 张监狱卡`,
    'StepOrderNum 即原版行动顺序（Initiative）') +
    `import type { CardAction, ResourceBundle } from './cards.js';\n\n` +
    `/** 角色 —— 对应原版 GCharacter */\nexport interface GameCharacter {\n` +
    `  id: string;\n  /** 原版内部名，如 Banker */\n  name: string;\n` +
    `  /** 行动顺序 1..12 */\n  order: number;\n` +
    `  normalStartCellId: string;\n  colonyStartCellId: string;\n` +
    `  actions: CardAction[];\n  text: { name: string; description: string; flavor: string };\n}\n\n` +
    `export const CHARACTERS: GameCharacter[] = ${ts(charOut)} as GameCharacter[];\n\n` +
    `export const CHARACTER_BY_ID: Record<string, GameCharacter> = Object.fromEntries(\n  CHARACTERS.map((c) => [c.id, c])\n);\n\n` +
    `export const CHARACTER_BY_NAME: Record<string, GameCharacter> = Object.fromEntries(\n  CHARACTERS.map((c) => [c.name, c])\n);\n\n` +
    `/** 监狱卡 —— 对应原版 GJailCard（Rank/Karma 决定服刑强度） */\nexport interface JailCard {\n` +
    `  id: string;\n  name: string;\n  rank: number;\n  karma: number;\n  imageNum: number;\n` +
    `  deckCount: number;\n  income?: ResourceBundle;\n  outcome?: ResourceBundle;\n` +
    `  params: number[];\n  actions: CardAction[];\n` +
    `  text: { name: string; description: string; flavor: string };\n}\n\n` +
    `export const JAIL_CARDS: JailCard[] = ${ts(jailOut)} as JailCard[];\n`
);

// ---------------------------------------------------------------- 5. 其余牌堆与常量
const chaosOut = chaosCards.map((c) => ({
  id: uinStr(c.ID),
  name: c.Name,
  num: num(c.Num),
  priceType: c.PriceType,
  price: num(c.PriceValue),
  cellTypeId: uinStr(c.CellID),
  special: bool(c.SpecialFlag),
  income: resOf(c.Income),
  outcome: resOf(c.Outcome),
  params: [num(c.Param1), num(c.Param2), num(c.Param3), num(c.Param4), num(c.Param5), num(c.Param6)],
  actions: buildActionList(c.ActionList),
  text: { name: t(c.CaptionID), description: t(c.DescriptionID), flavor: t(c.FlavorTextID) },
}));

const mfOut = misfortuneCards.map((c) => ({
  id: uinStr(c.ID),
  name: c.Name,
  deckCount: num(c.DeckCount),
  showAll: bool(c.ShowAll),
  income: resOf(c.Income),
  outcome: resOf(c.Outcome),
  params: [num(c.Param1), num(c.Param2), num(c.Param3), num(c.Param4), num(c.Param5), num(c.Param6)],
  actions: buildActionList(c.ActionList),
  text: { name: t(c.CaptionID), description: t(c.DescriptionID), flavor: t(c.FlavorTextID) },
}));

const cellTypeOut = cellTypes.map((c) => ({
  id: uinStr(c.ID),
  cellType: c.CellType,
  name: c.Name,
  building: bool(c.BuildingFlag),
  optional: bool(c.OptionalFlag),
  num: num(c.Num),
  params: [num(c.Param1), num(c.Param2), num(c.Param3), num(c.Param4), num(c.Param5), num(c.Param6)],
  // Label1..6 是原版**骰子结算表**的口径，例如 Tribue 的 "5, 6 = +1&"、
  // Risk 的 "3 = -{3}&, +{3}^"。这里解析成随包语言的**实际文案**（而不是 UIN），
  // 引擎要靠它还原掷骰规则——不要按 ActionType 或 Description 猜。
  labels: [c.Label1, c.Label2, c.Label3, c.Label4, c.Label5, c.Label6].map((u) => t(u)).filter(Boolean),
  actions: buildActionList(c.ActionList),
  text: { name: t(c.CaptionID), description: t(c.DescriptionID), flavor: t(c.FlavorTextID) },
}));

const constOut = {};
for (const [k, v] of Object.entries(consts)) {
  if (k === '__type' || k === 'LabelList' || k === 'deflabels') continue;
  if (typeof v === 'object' && v !== null) continue;
  constOut[k] = v;
}

write(
  'decks.ts',
  banner(`混沌卡 ${chaosOut.length} / 厄运卡 ${mfOut.length} / 格子类型 ${cellTypeOut.length}`) +
    `import type { ActionType, CellTypeName, PriceType } from './enums.js';\n` +
    `import type { CardAction, ResourceBundle } from './cards.js';\n\n` +
    `export interface ChaosCard {\n  id: string;\n  name: string;\n  num: number;\n  priceType: PriceType;\n  price: number;\n` +
    `  cellTypeId: string;\n  special: boolean;\n  income?: ResourceBundle;\n  outcome?: ResourceBundle;\n` +
    `  params: number[];\n  actions: CardAction[];\n  text: { name: string; description: string; flavor: string };\n}\n\n` +
    `export const CHAOS_CARDS: ChaosCard[] = ${ts(chaosOut)} as ChaosCard[];\n\n` +
    `/** 厄运卡 —— 对应原版 GMisFortuneCard */\nexport interface MisfortuneCard {\n` +
    `  id: string;\n  name: string;\n  deckCount: number;\n  showAll: boolean;\n` +
    `  income?: ResourceBundle;\n  outcome?: ResourceBundle;\n  params: number[];\n  actions: CardAction[];\n` +
    `  text: { name: string; description: string; flavor: string };\n}\n\n` +
    `export const MISFORTUNE_CARDS: MisfortuneCard[] = ${ts(mfOut)} as MisfortuneCard[];\n\n` +
    `/** 格子类型定义 —— 对应原版 GCellType（Param1..6 为各站点规则参数） */\nexport interface CellTypeDef {\n` +
    `  id: string;\n  cellType: CellTypeName;\n  name: string;\n  /** 是否为建筑（可打牌） */\n  building: boolean;\n` +
    `  /** 是否可选（玩家可跳过） */\n  optional: boolean;\n  num: number;\n  params: number[];\n` +
    `  labels: string[];\n  actions: CardAction[];\n` +
    `  text: { name: string; description: string; flavor: string };\n}\n\n` +
    `export const CELL_TYPES: CellTypeDef[] = ${ts(cellTypeOut)} as CellTypeDef[];\n\n` +
    `export const CELL_TYPE_BY_NAME: Record<string, CellTypeDef> = Object.fromEntries(\n  CELL_TYPES.map((c) => [c.cellType, c])\n);\n\n` +
    `export const CELL_TYPE_BY_ID: Record<string, CellTypeDef> = Object.fromEntries(\n  CELL_TYPES.map((c) => [c.id, c])\n);\n\n` +
    `/** 原版 GConst 中的数值常量（AI_INCOME_VALUE、罚款基准、选举周期等） */\nexport const GAME_CONST: Record<string, number | string | boolean> = ${ts(constOut)};\n`
);

// ---------------------------------------------------------------- 6. 文案表
const nameId = new Map();
for (const [kind, list] of [
  ['card', actionCards],
  ['character', characters],
  ['jail', jailCards],
  ['chaos', chaosCards],
  ['misfortune', misfortuneCards],
  ['cell', cellTypes],
]) {
  for (const o of list) {
    for (const [suffix, uin] of [
      ['name', o.CaptionID],
      ['desc', o.DescriptionID],
      ['flavor', o.FlavorTextID],
    ]) {
      const s = uinStr(uin);
      if (!isEmptyUin(s) && hasText(s)) nameId.set(s, `${kind}.${o.Name}.${suffix}`);
    }

    // `ActionParams` 里也会有 UIN（如 `BUTTON` 的按钮文案）。
    // 这类 UIN 是**十六进制**形式，要换算成十进制才能查到文案。
    // 漏掉它们会让「二选一」按钮变成一串十六进制。
    for (const a of o.ActionList || []) {
      for (const raw of a.ActionParams || []) {
        const s = String(raw ?? '');
        if (isEmptyUin(s)) continue;
        const dec = /^[0-9A-F]{16}$/.test(s) ? BigInt(`0x${s}`).toString() : s;
        if (hasText(dec) && !nameId.has(dec)) nameId.set(dec, `param.${a.ActionType}`);
      }
    }
  }
}

write(
  'strings.ts',
  banner(`${nameId.size} 条文案，语言 ${SHIPPED_LANGS.join(' / ')}`,
    '键为原版 UIN（十进制）。完整 13 语言在 test/data/strings/') +
    `export type LangCode = ${SHIPPED_LANGS.map((l) => `'${LANG_CODES[l]}'`).join(' | ')};\n\n` +
    `export const LANGS: LangCode[] = [${SHIPPED_LANGS.map((l) => `'${LANG_CODES[l]}'`).join(', ')}];\n\n` +
    `export const DEFAULT_LANG: LangCode = 'zh';\n\n` +
    `/** UIN -> 各语言文本 */\nexport const STRINGS: Record<string, Partial<Record<LangCode, string>>> = ${ts(
      Object.fromEntries([...nameId.keys()].map((k) => [k, multi(k)]))
    )};\n`
);

// ---------------------------------------------------------------- 7. 文本格式化
// 原版在 UI 层用单字符符号表示资源（见 CAvatarForm / CACardForm）:
//   $ 金钱   & 选票   ^ 罪恶   * 齿轮   ~ 贿赂   | 收入
// 文案里的 {1}..{6} 对应卡牌的 Param1..Param6。
// 这里统一转成 [[token]] 标记, 由客户端决定渲染成图标还是文字。
write(
  'text.ts',
  banner('原版资源符号与文本占位符的解析') +
    `/** 文案中的资源标记 —— 由原版单字符符号归一化而来 */\n` +
    `export type TextToken =\n` +
    `  | 'money'\n  | 'vote'\n  | 'malice'\n  | 'score'\n  | 'bribe'\n  | 'income'\n` +
    `  | 'money2'\n  | 'bribe2'\n  | 'term';\n\n` +
    `/** 原版符号 -> 标记（顺序有意义：长组合优先） */\n` +
    `const SYMBOL_TO_TOKEN: ReadonlyArray<readonly [string, TextToken]> = [\n` +
    `  ['@', 'money2'],\n` +
    `  ['#', 'bribe2'],\n` +
    `  ['$', 'money'],\n` +
    `  ['&', 'vote'],\n` +
    `  ['^', 'malice'],\n` +
    `  ['*', 'score'],\n` +
    `  ['~', 'bribe'],\n` +
    `  ['|', 'income'],\n` +
    `  ['+', 'term'],\n` +
    `];\n\n` +
    `/** 标记的缺省中文显示（客户端可用图标替换） */\n` +
    `export const TOKEN_LABEL_ZH: Record<TextToken, string> = {\n` +
    `  money: '金钱', vote: '选票', malice: '罪恶', score: '齿轮',\n` +
    `  bribe: '贿赂', income: '收入', money2: '金币', bribe2: '贿赂', term: '刑期',\n` +
    `};\n\n` +
    `/**\n * 把原版文案转成带 [[token]] 标记的文本。\n * 注意: '+' 在结算文本里表示刑期, 但也会出现在普通文案中, 因此默认不转换, 由调用方决定。\n */\n` +
    `export function tokenizeSymbols(s: string, opts: { plusAsTerm?: boolean } = {}): string {\n` +
    `  let out = s;\n` +
    `  for (const [sym, token] of SYMBOL_TO_TOKEN) {\n` +
    `    if (sym === '+' && !opts.plusAsTerm) continue;\n` +
    `    out = out.split(sym).join('\[\[' + token + '\]\]');\n` +
    `  }\n  return out;\n}\n\n` +
    `/** 用 params[n-1] 替换文案里的 {n} */\nexport function applyParams(s: string, params: number[]): string {\n` +
    `  if (!params?.length) return s;\n` +
    `  let out = s;\n` +
    `  for (let i = 0; i < params.length; i++) out = out.split('{' + (i + 1) + '}').join(String(params[i]));\n` +
    `  return out;\n}\n\n` +
    `/** 一次性完成 {n} 替换与符号归一化 */\nexport function formatGameText(\n` +
    `  s: string,\n  params: number[] = [],\n  opts: { plusAsTerm?: boolean } = {},\n` +
    `): string {\n  return tokenizeSymbols(applyParams(s ?? '', params), opts);\n}\n\n` +
    `/** 把带标记的文本还原成纯文本（日志、占位渲染用） */\nexport function plainText(\n` +
    `  s: string,\n  label: Record<TextToken, string> = TOKEN_LABEL_ZH,\n` +
    `): string {\n  return (s ?? '').replace(/\\[\\[([a-z0-9]+)\\]\\]/g, (m, k) => label[k as TextToken] ?? m);\n}\n`
);

// ---------------------------------------------------------------- 8. 索引
write(
  'index.ts',
  banner('gamedata 汇总导出') +
    `export * from './enums.js';\nexport * from './cards.js';\nexport * from './board.js';\n` +
    `export * from './board-layout.js';\nexport * from './characters.js';\n` +
    `export * from './decks.js';\nexport * from './strings.js';\nexport * from './text.js';\n`
);

// ---------------------------------------------------------------- 统计
console.log('\n=== 数据层统计 ===');
console.log(`  行动卡            ${cardOut.length} 种 / 牌库 ${cardOut.reduce((s, c) => s + c.deckCount, 0)} 张`);
console.log(`  地图              ${mapList.length} 张 / ${mapList.map((m) => m.cells.length).join('+')} 格`);
console.log(`  角色              ${charOut.length} 个`);
console.log(`  监狱/混沌/厄运    ${jailOut.length} / ${chaosOut.length} / ${mfOut.length}`);
console.log(`  格子类型          ${cellTypeOut.length} 种`);
console.log(`  动作原语          ${actionTypes.length} 种`);
console.log(`  文案              ${nameId.size} 条 × ${SHIPPED_LANGS.length} 语言`);
console.log(`\n输出目录: ${OUT}`);
