/**
 * 原版棋盘 + 用户自定义坐标。
 *
 * 拓扑（格子 ID、连线、cellTypeId 等）全部来自原版 NORMAL_MAP。
 * 仅坐标 (x, y) 来自用户的 地图.csv，按格子类型 + 序号映射。
 *
 * 这样引擎、卡牌、角色数据全部使用原版 UIN 字符串 ID，不会断裂。
 */
import { NORMAL_MAP } from './board.js';
import type { CellTypeName } from './enums.js';

/** 用户 CSV 的 subtype → CellTypeName */
function toCellType(sub: string): CellTypeName {
  const direct: Record<string, CellTypeName> = {
    '监狱':'Jail','地狱':'Inferno','赌场':'Casino','银行':'Bank',
    '藏宝阁':'Treasure','法院':'Courthouse','市场':'Marketplace',
    '垃圾场':'Junkyard','办公楼':'Office','工厂':'Plant','天界':'Astral',
  };
  if (direct[sub]) return direct[sub];
  const base = sub.replace(/[0-9]+$/, '');
  const m: Record<string, CellTypeName> = {
    '冒险':'Danger','赌博':'Risk','贿赂':'Bribe','警察':'Police',
    '收入':'Income','厄运':'Misfortune','演讲':'Tribune',
  };
  return m[base] || 'Income';
}

/** 用户 CSV 节点 */
interface UserNode { id: string; subtype: string; x: number; y: number; }

const USER_NODES: UserNode[] = [
  { id:'1', subtype:'监狱', x:290, y:323 },
  { id:'2', subtype:'冒险1', x:319, y:328 },
  { id:'3', subtype:'赌博1', x:347, y:314 },
  { id:'4', subtype:'贿赂1', x:342, y:284 },
  { id:'5', subtype:'警察1', x:314, y:268 },
  { id:'6', subtype:'冒险2', x:335, y:248 },
  { id:'7', subtype:'收入1', x:368, y:257 },
  { id:'8', subtype:'厄运1', x:400, y:260 },
  { id:'9', subtype:'地狱', x:434, y:254 },
  { id:'10', subtype:'赌博2', x:415, y:228 },
  { id:'11', subtype:'厄运2', x:385, y:228 },
  { id:'12', subtype:'警察2', x:353, y:223 },
  { id:'13', subtype:'冒险3', x:357, y:192 },
  { id:'14', subtype:'赌博3', x:387, y:185 },
  { id:'15', subtype:'赌场', x:415, y:180 },
  { id:'16', subtype:'演讲1', x:387, y:157 },
  { id:'17', subtype:'警察3', x:354, y:163 },
  { id:'18', subtype:'冒险4', x:340, y:140 },
  { id:'19', subtype:'贿赂3', x:367, y:119 },
  { id:'20', subtype:'法院', x:383, y:90 },
  { id:'21', subtype:'演讲2', x:347, y:102 },
  { id:'22', subtype:'警察4', x:316, y:119 },
  { id:'23', subtype:'冒险5', x:283, y:116 },
  { id:'24', subtype:'冒险6', x:290, y:88 },
  { id:'25', subtype:'厄运3', x:303, y:64 },
  { id:'26', subtype:'藏宝阁', x:284, y:39 },
  { id:'27', subtype:'赌博4', x:269, y:66 },
  { id:'28', subtype:'冒险7', x:258, y:92 },
  { id:'29', subtype:'警察5', x:253, y:120 },
  { id:'30', subtype:'贿赂4', x:224, y:131 },
  { id:'31', subtype:'贿赂5', x:230, y:97 },
  { id:'32', subtype:'贿赂6', x:222, y:65 },
  { id:'33', subtype:'贿赂7', x:192, y:39 },
  { id:'34', subtype:'贿赂8', x:155, y:34 },
  { id:'35', subtype:'贿赂9', x:124, y:47 },
  { id:'36', subtype:'天界', x:92, y:62 },
  { id:'37', subtype:'收入2', x:97, y:99 },
  { id:'38', subtype:'赌博5', x:109, y:129 },
  { id:'39', subtype:'厄运4', x:135, y:152 },
  { id:'40', subtype:'冒险8', x:168, y:161 },
  { id:'41', subtype:'收入3', x:198, y:146 },
  { id:'42', subtype:'警察6', x:191, y:118 },
  { id:'43', subtype:'银行', x:159, y:130 },
  { id:'44', subtype:'赌博6', x:159, y:130 },
  { id:'45', subtype:'警察7', x:143, y:181 },
  { id:'46', subtype:'赌博7', x:112, y:177 },
  { id:'47', subtype:'办公楼', x:80, y:188 },
  { id:'48', subtype:'演讲3', x:111, y:200 },
  { id:'49', subtype:'冒险9', x:138, y:207 },
  { id:'50', subtype:'警察8', x:154, y:231 },
  { id:'51', subtype:'赌博8', x:137, y:256 },
  { id:'52', subtype:'工厂', x:120, y:278 },
  { id:'53', subtype:'演讲4', x:155, y:276 },
  { id:'54', subtype:'冒险10', x:175, y:248 },
  { id:'55', subtype:'警察9', x:203, y:254 },
  { id:'56', subtype:'赌博9', x:185, y:278 },
  { id:'57', subtype:'垃圾场', x:185, y:305 },
  { id:'58', subtype:'演讲5', x:219, y:287 },
  { id:'59', subtype:'冒险11', x:229, y:255 },
  { id:'60', subtype:'警察10', x:259, y:255 },
  { id:'61', subtype:'赌博10', x:260, y:228 },
  { id:'62', subtype:'市场', x:281, y:203 },
  { id:'63', subtype:'演讲6', x:294, y:231 },
  { id:'64', subtype:'收入4', x:286, y:259 },
  { id:'65', subtype:'贿赂2', x:320, y:181 },
  { id:'66', subtype:'厄运5', x:255, y:178 },
  { id:'67', subtype:'贿赂10', x:191, y:204 },
];

/** 构建原版 cell ID → 用户坐标 的映射 */
function buildCustomPos(): Record<string, { x: number; y: number }> {
  const origByType = new Map<string, typeof NORMAL_MAP.cells>();
  for (const c of NORMAL_MAP.cells) {
    if (!origByType.has(c.cellType)) origByType.set(c.cellType, []);
    origByType.get(c.cellType)!.push(c);
  }
  for (const [, arr] of origByType) arr.sort((a, b) => a.num - b.num);

  const userByType = new Map<string, UserNode[]>();
  for (const n of USER_NODES) {
    const t = toCellType(n.subtype);
    if (!userByType.has(t)) userByType.set(t, []);
    userByType.get(t)!.push(n);
  }

  const xs = USER_NODES.map(n => n.x);
  const ys = USER_NODES.map(n => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rX = maxX - minX || 1, rY = maxY - minY || 1;

  const result: Record<string, { x: number; y: number }> = {};
  for (const [type, userArr] of userByType) {
    const origArr = origByType.get(type) || [];
    for (let i = 0; i < userArr.length; i++) {
      const origCell = origArr[i] ?? origArr[0];
      if (!origCell) continue;
      const n = userArr[i];
      result[origCell.id] = {
        x: +(((n.x - minX) / rX) * 100).toFixed(1),
        y: +(((n.y - minY) / rY) * 100).toFixed(1),
      };
    }
  }
  return result;
}

/** 原版棋盘拓扑（不变） */
export const CUSTOM_MAP = NORMAL_MAP;

/** 原版 cell ID → 用户坐标 (0-100) */
export const CUSTOM_POS: Record<string, { x: number; y: number }> = buildCustomPos();
