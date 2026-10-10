/**
 * 自定义 30 节点棋盘 —— 用户提供的坐标和连线规则。
 *
 * 坐标为归一化 (0..1)，渲染时乘以画布尺寸。
 * 连线规则：
 *   主环：1→2→3→...→21→1（逆时针）
 *   中央捷径：4→12, 12→20, 20→28, 9→17, 17→25
 *   内部连接：22-30 互相连接
 */
import type { BoardCell, BoardMap } from './board.js';
import type { CellTypeName } from './enums.js';

/** subtype → CellTypeName 映射 */
const SUBTYPE_MAP: Record<string, CellTypeName> = {
  income: 'Income', bribe: 'Bribe', police: 'Police', misfortune: 'Misfortune',
  gambling: 'Risk', danger: 'Danger', speech: 'Tribune',
  plant: 'Plant', jail: 'Jail', casino: 'Casino', bank: 'Bank',
  treasure_vault: 'Treasure', court: 'Courthouse', market: 'Marketplace',
  junkyard: 'Junkyard', office: 'Office', hell: 'Inferno', heaven: 'Astral',
};

/** cellType → cellTypeId（从原版数据提取） */
const CELL_TYPE_ID: Record<CellTypeName, string> = {
  Income: '12167966293311076356',
  Bribe: '16204880409289649669',
  Police: '14458891128750972929',
  Misfortune: '12748367695283384070',
  Risk: '16271871453755922691',
  Danger: '14030686299553685508',
  Tribune: '17637869515721969922',
  Plant: '11749977052396124682',
  Jail: '14066516110727860493',
  Casino: '14360938936374734863',
  Bank: '11601921214659220744',
  Treasure: '11843989694623805201',
  Courthouse: '15443773171780652560',
  Marketplace: '13199010232511312140',
  Junkyard: '17877687295394095883',
  Office: '16143519963885831945',
  Inferno: '12771168267915490318',
  Astral: '11670037059498564103',
};

const CELL_TEXT: Record<string, { caption: string; description: string }> = {
  Income: { caption: '收入', description: '经过+收入，停留双倍收入' },
  Bribe: { caption: '贿赂', description: '支付贿赂金' },
  Police: { caption: '警察', description: '贿赂或掷骰' },
  Misfortune: { caption: '厄运', description: '抽厄运牌' },
  Risk: { caption: '赌博', description: '可选掷骰试手气' },
  Danger: { caption: '冒险', description: '买保险+掷骰' },
  Tribune: { caption: '演讲', description: '下注赢选票' },
  Plant: { caption: '工厂', description: '+50金-1罪恶跳1回合' },
  Jail: { caption: '监狱', description: '入狱/服刑' },
  Casino: { caption: '赌场', description: '掷骰赌博' },
  Bank: { caption: '银行', description: '投资10金+10收入' },
  Treasure: { caption: '藏宝阁', description: '自动掷骰寻宝' },
  Courthouse: { caption: '法院', description: '没收对手选票' },
  Marketplace: { caption: '市场', description: '卖齿轮换钱' },
  Junkyard: { caption: '垃圾场', description: '掷骰获取资源' },
  Office: { caption: '办公楼', description: '卖选票换钱' },
  Inferno: { caption: '地狱', description: '付100金抽1牌' },
  Astral: { caption: '天界', description: '电梯传送' },
};

interface NodeDef {
  id: string;
  subtype: string;
  x: number;
  y: number;
}

const NODES: NodeDef[] = [
  { id: '1',  subtype: 'income',         x: 0.42, y: 0.06 },
  { id: '2',  subtype: 'plant',          x: 0.30, y: 0.10 },
  { id: '3',  subtype: 'bribe',          x: 0.22, y: 0.18 },
  { id: '4',  subtype: 'police',         x: 0.16, y: 0.28 },
  { id: '5',  subtype: 'jail',           x: 0.10, y: 0.40 },
  { id: '6',  subtype: 'misfortune',     x: 0.08, y: 0.52 },
  { id: '7',  subtype: 'casino',         x: 0.10, y: 0.64 },
  { id: '8',  subtype: 'gambling',       x: 0.16, y: 0.74 },
  { id: '9',  subtype: 'bank',           x: 0.24, y: 0.82 },
  { id: '10', subtype: 'income',         x: 0.34, y: 0.86 },
  { id: '11', subtype: 'treasure_vault', x: 0.44, y: 0.88 },
  { id: '12', subtype: 'misfortune',     x: 0.54, y: 0.86 },
  { id: '13', subtype: 'court',          x: 0.64, y: 0.82 },
  { id: '14', subtype: 'speech',         x: 0.72, y: 0.74 },
  { id: '15', subtype: 'market',         x: 0.78, y: 0.64 },
  { id: '16', subtype: 'danger',         x: 0.82, y: 0.52 },
  { id: '17', subtype: 'junkyard',       x: 0.80, y: 0.40 },
  { id: '18', subtype: 'bribe',          x: 0.74, y: 0.30 },
  { id: '19', subtype: 'office',         x: 0.66, y: 0.22 },
  { id: '20', subtype: 'police',         x: 0.56, y: 0.16 },
  { id: '21', subtype: 'hell',           x: 0.48, y: 0.14 },
  { id: '22', subtype: 'gambling',       x: 0.36, y: 0.20 },
  { id: '23', subtype: 'heaven',         x: 0.50, y: 0.42 },
  { id: '24', subtype: 'speech',         x: 0.36, y: 0.48 },
  { id: '25', subtype: 'income',         x: 0.60, y: 0.48 },
  { id: '26', subtype: 'misfortune',     x: 0.50, y: 0.62 },
  { id: '27', subtype: 'danger',         x: 0.30, y: 0.56 },
  { id: '28', subtype: 'bribe',          x: 0.70, y: 0.56 },
  { id: '29', subtype: 'police',         x: 0.44, y: 0.34 },
  { id: '30', subtype: 'income',         x: 0.56, y: 0.34 },
];

/** 所有有向边 */
const EDGES: Array<[string, string]> = [
  // 主环 1→2→...→21→1
  ['1','2'],['2','3'],['3','4'],['4','5'],['5','6'],['6','7'],['7','8'],['8','9'],
  ['9','10'],['10','11'],['11','12'],['12','13'],['13','14'],['14','15'],['15','16'],
  ['16','17'],['17','18'],['18','19'],['19','20'],['20','21'],['21','1'],
  // 中央捷径
  ['4','12'],['12','20'],['20','28'],['9','17'],['17','25'],
  // 内部连接（已验证不与任何边交叉）
  ['21','22'],['22','21'],
  ['22','23'],['23','22'],
  ['23','29'],['29','23'],
  ['23','26'],['26','23'],
  ['22','24'],['24','22'],
  ['25','30'],['30','25'],
  ['4','27'],['27','4'],
  ['12','28'],['28','12'],
];

function buildCustomMap(): BoardMap {
  const outMap = new Map<string, string[]>();
  const inMap = new Map<string, string[]>();
  for (const id of NODES.map((n) => n.id)) {
    outMap.set(id, []);
    inMap.set(id, []);
  }
  for (const [from, to] of EDGES) {
    outMap.get(from)?.push(to);
    inMap.get(to)?.push(from);
  }

  const cells: BoardCell[] = NODES.map((node, i) => {
    const cellType = SUBTYPE_MAP[node.subtype] ?? 'Income';
    const text = CELL_TEXT[cellType] ?? { caption: node.subtype, description: '' };
    return {
      key: `C${node.id}`,
      id: node.id,
      cellType,
      name: `Cell${node.id}.${cellType}`,
      num: i + 1,
      out: outMap.get(node.id) ?? [],
      in: inMap.get(node.id) ?? [],
      cellTypeId: CELL_TYPE_ID[cellType] ?? '',
      soundId: '',
      soundVolume: 100,
      caption: text.caption,
      description: text.description,
      flavorText: '',
      text: { caption: text.caption, description: text.description },
    };
  });

  return {
    id: 'custom-30',
    name: 'Normal',
    cells,
  };
}

export const CUSTOM_MAP: BoardMap = buildCustomMap();

/** 节点坐标（归一化 0..1 → 百分比 0..100） */
export const CUSTOM_POS: Record<string, { x: number; y: number }> = Object.fromEntries(
  NODES.map((n) => [n.id, { x: n.x * 100, y: n.y * 100 }]),
);
