// =============================================================
// 棋盘运行时视图 —— UI 消费的棋盘形态
//
// 数据来源：原作 GMap（真实拓扑）+ 计算出的布局坐标。
// 与旧的 shared/src/data/board.ts 的区别：
//   旧：手写的数字 id 近似图（"基于 地图.txt 重新生成"）
//   新：原作 67/64 格真实邻接关系 + 拓扑算出的坐标
//
// 格 id 是字符串（原版 UIN），不再是 0..200 的自增下标。
// =============================================================
import type { BoardCell, BoardMap, BoardLayout, CellTypeName } from './gamedata/index.js';
// 注意：必须从 `./gamedata/index.js` 直接取。
// 顶层 `@gremlins/shared` 的 `CARD_BY_ID` / `BOARD_MAPS` 等名字被
// `./data/index.js`（基于 OCR 的历史数据）遮蔽，拿到的是错误数据。
import {
  BOARD_MAPS, CARD_BY_ID, CELL_TYPE_BY_ID, LAYOUT_BY_MAP_NAME, NORMAL_MAP, EMPTY_LAYOUT,
} from './gamedata/index.js';

// 棋盘相关的原版类型一并 re-export，客户端不必再单独引 gamedata 子路径
export type { BoardCell, BoardMap, BoardLayout, CellTypeName } from './gamedata/index.js';

/** UI 用的格子分类 */
export type TileKind = 'building' | 'station' | 'jail';

/** UI 用的单格 */
export interface BoardTile {
  /** 格 id（原版 UIN 字符串） */
  id: string;
  /** 原版格号（1 起，用于展示与排序） */
  num: number;
  /** 原版格子类型名，如 Bank / Risk */
  cellType: CellTypeName;
  /** UI 分类 */
  kind: TileKind;
  /** 是否为建筑（来自 GCellType.BuildingFlag） */
  isBuilding: boolean;
  /** 中文名 */
  label: string;
  /** 中文说明 */
  description: string;
  /** 百分比坐标 */
  x: number;
  y: number;
  /** 出边（可达格 id），长度 > 1 表示岔路口 */
  out: string[];
  /** 入边 */
  in: string[];
  /** 原始格对象，供引擎/调试使用 */
  cell: BoardCell;
}

/** UI 用的边 */
export interface BoardEdge {
  from: string;
  to: string;
}

/** 一整张地图的 UI 视图 */
export interface BoardViewData {
  mapId: string;
  mapName: string;
  tiles: BoardTile[];
  edges: BoardEdge[];
  /** 岔路口格 id */
  junctions: string[];
  /** 监狱格 id（出生/入狱点） */
  jailTileId: string;
  byId: Map<string, BoardTile>;
  /** 预计算的边弯曲偏移（避免交叉/压住节点） */
  bends: Map<string, { dx: number; dy: number }>;
}

const JAIL_TILE_KIND: TileKind = 'jail';

function classify(cell: BoardCell): { kind: TileKind; isBuilding: boolean } {
  const def = CELL_TYPE_BY_ID[cell.cellTypeId];
  const isBuilding = !!def?.building;
  if (cell.cellType === 'Jail') return { kind: JAIL_TILE_KIND, isBuilding: true };
  return { kind: isBuilding ? 'building' : 'station', isBuilding };
}

/** 由地图 + 布局构造 UI 视图 */
export function buildBoardView(map: BoardMap, layout: BoardLayout): BoardViewData {
  const tiles: BoardTile[] = map.cells.map((cell) => {
    const { kind, isBuilding } = classify(cell);
    const p = layout.pos[cell.id] ?? { x: 50, y: 50 };
    return {
      id: cell.id,
      num: cell.num,
      cellType: cell.cellType,
      kind,
      isBuilding,
      label: cell.text?.caption || cell.caption || cell.name,
      description: cell.text?.description || cell.description || '',
      x: p.x,
      y: p.y,
      out: cell.out,
      in: cell.in,
      cell,
    };
  });

  // 调整坐标
  adjustPositions(tiles, layout.spine);

  const edges: BoardEdge[] = [];
  for (const t of tiles) for (const to of t.out) edges.push({ from: t.id, to });

  const jail = tiles.find((t) => t.cellType === 'Jail');

  const view: BoardViewData = {
    mapId: map.id,
    mapName: map.name,
    tiles,
    edges,
    junctions: layout.junctions,
    jailTileId: jail?.id ?? tiles[0]?.id ?? '',
    byId: new Map(tiles.map((t) => [t.id, t])),
    bends: new Map(),
  };

  computeEdgeBends(view);
  return view;
}

/**
 * 调整格子坐标，解决全挤在一个圆上的问题。
 * 三层布局：建筑外圈(r≥60)、站点环(r=38-46)、枢纽内圈(r≤18)
 */
function adjustPositions(tiles: BoardTile[], spine: string[]): void {
  const CX = 50, CY = 50;
  const spineSet = new Set(spine);
  const spineList = spine.filter((id) => tiles.find((t) => t.id === id));
  // 预计算建筑列表和均匀分布角度
  const buildingTiles = tiles.filter((t) => t.isBuilding);
  const bSpacing = (Math.PI * 2) / buildingTiles.length;

  // 第一轮：按类型分到三层
  for (const t of tiles) {
    const dx = t.x - CX;
    const dy = t.y - CY;
    const angle = Math.atan2(dy, dx);
    const origR = Math.hypot(dx, dy) || 1;

    if (t.isBuilding) {
      // 建筑：均匀分布在外圈（11 个建筑按 360°/11 ≈ 33° 均分）
      const origAng = Math.atan2(dy, dx);
      const nearestSlot = Math.round((origAng + Math.PI / 2) / bSpacing);
      const slotAng = nearestSlot * bSpacing - Math.PI / 2;
      const r = 52;
      t.x = CX + Math.cos(slotAng) * r;
      t.y = CY + Math.sin(slotAng) * r;
    } else if (t.out.length >= 3 || t.in.length >= 3) {
      // 枢纽：内圈 r=10..18
      const r = Math.min(18, origR * 0.3);
      t.x = CX + Math.cos(angle) * r;
      t.y = CY + Math.sin(angle) * r;
    } else if (spineSet.has(t.id)) {
      // 站点：中环，交替半径
      const spineIdx = spineList.indexOf(t.id);
      const r = spineIdx >= 0 ? (spineIdx % 2 === 0 ? 38 : 44) : origR;
      t.x = CX + Math.cos(angle) * r;
      t.y = CY + Math.sin(angle) * r;
    }
  }

  // 第二轮：迭代推开（最小间距 4.5，建筑更轻）
  const MIN_DIST = 4.5;
  for (let iter = 0; iter < 25; iter++) {
    let moved = false;
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i], b = tiles[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= MIN_DIST) continue;
        if (d < 0.01) { dx = (i - j) || 1; dy = (j - i) || 1; d = Math.hypot(dx, dy) || 1; }
        const push = (MIN_DIST - d) * 0.5 + 0.2;
        const ux = dx / d, uy = dy / d;
        const wA = a.isBuilding ? 0 : 1;
        const wB = b.isBuilding ? 0 : 1;
        if (wA === 0 && wB === 0) continue; // 两个建筑由角度旋转处理
        const wSum = wA + wB;
        a.x -= ux * push * (wB / wSum) * 2;
        a.y -= uy * push * (wB / wSum) * 2;
        b.x += ux * push * (wA / wSum) * 2;
        b.y += uy * push * (wA / wSum) * 2;
        moved = true;
      }
    }
    if (!moved) break;
  }

  // 第三轮：建筑角度微调——优先拉开建筑之间的角度
  for (let pass = 0; pass < 5; pass++) {
    for (const b of tiles) {
      if (!b.isBuilding) continue;
      const origAng = Math.atan2(b.y - CY, b.x - CX);
      const origR = Math.hypot(b.x - CX, b.y - CY);
      let bestAng = origAng;
      let bestScore = -1;
      for (const delta of [0.15, -0.15, 0.3, -0.3, 0.5, -0.5, 0.8, -0.8, 1.2, -1.2]) {
        const ang = origAng + delta;
        const nx = CX + Math.cos(ang) * origR;
        const ny = CY + Math.sin(ang) * origR;
        // 评分：建筑间距（权重3）+ 站点间距（权重1）
        let bMin = Infinity, sMin = Infinity;
        for (const a of tiles) {
          if (a === b) continue;
          const d = Math.hypot(nx - a.x, ny - a.y);
          if (a.isBuilding) bMin = Math.min(bMin, d);
          else sMin = Math.min(sMin, d);
        }
        const score = (bMin === Infinity ? 100 : bMin * 3) + (sMin === Infinity ? 100 : sMin);
        if (score > bestScore) { bestScore = score; bestAng = ang; }
      }
      b.x = CX + Math.cos(bestAng) * origR;
      b.y = CY + Math.sin(bestAng) * origR;
    }
  }

  for (const t of tiles) {
    t.x = Math.max(3, Math.min(97, t.x));
    t.y = Math.max(3, Math.min(97, t.y));
  }
}

const CACHE = new Map<string, BoardViewData>();

/** 按地图 id 取（带缓存） */
export function getBoardView(mapId?: string): BoardViewData {
  const map = (mapId ? BOARD_MAPS.find((m) => m.id === mapId) : undefined) ?? NORMAL_MAP;
  const key = map.id;
  const cached = CACHE.get(key);
  if (cached) return cached;
  const layout = LAYOUT_BY_MAP_NAME[map.name] ?? EMPTY_LAYOUT;
  const view = buildBoardView(map, layout);
  CACHE.set(key, view);
  return view;
}

/** 默认棋盘视图（普通地图） */
export const BOARD_VIEW: BoardViewData = getBoardView();

// ---------------------------------------------------------------- 查询辅助
export function getTile(view: BoardViewData, id: string): BoardTile | undefined {
  return view.byId.get(id);
}

export function tileLabel(view: BoardViewData, id: string): string {
  return view.byId.get(id)?.label ?? id;
}

/** 是否是双向边 */
export function isBidirectional(view: BoardViewData, from: string, to: string): boolean {
  const a = view.byId.get(from);
  const b = view.byId.get(to);
  if (!a || !b) return false;
  return a.in.includes(to) && b.in.includes(from);
}

// ---------------------------------------------------------------- 边弯曲算法

interface Pt { x: number; y: number; }

/** 节点视觉半径（与 BoardView 渲染一致） */
function nodeVisualRadius(t: BoardTile): number {
  return t.isBuilding ? 2.4 : 1.8;
}

/** 点到线段的最近距离及参数 t（0..1） */
function distPointToSeg(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return { d: Math.hypot(p.x - a.x, p.y - a.y), t: 0 };
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * vx;
  const cy = a.y + t * vy;
  return { d: Math.hypot(p.x - cx, p.y - cy), t };
}

/** 三点方向：0 共线，1 顺时针，2 逆时针 */
function orient(a: Pt, b: Pt, c: Pt): number {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (v === 0) return 0;
  return v > 0 ? 1 : 2;
}

/** 线段 p1q1 与 p2q2 是否相交（不含共线重叠） */
function segIntersect(p1: Pt, q1: Pt, p2: Pt, q2: Pt): boolean {
  const o1 = orient(p1, q1, p2);
  const o2 = orient(p1, q1, q2);
  const o3 = orient(p2, q2, p1);
  const o4 = orient(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  return false;
}

/**
 * 预计算每条边的弯曲位移，解决两类问题：
 * 1. 边与边相交：把相交边沿中点连线方向推开。
 * 2. 边穿过非端点站点/建筑：沿"垂直于边、远离站点"的方向把控制点推开。
 *
 * 结果写入 view.bends，key = "from-to"。
 */
function computeEdgeBends(view: BoardViewData): void {
  const pos = new Map<string, Pt>();
  for (const t of view.tiles) pos.set(t.id, { x: t.x, y: t.y });

  // 去重后的渲染线段（双向边只保留一份）
  const segSeen = new Set<string>();
  const segs: Array<{ a: string; b: string; pa: Pt; pb: Pt; mid: Pt }> = [];
  for (const e of view.edges) {
    const key = e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`;
    if (segSeen.has(key)) continue;
    segSeen.add(key);
    const pa = pos.get(e.from);
    const pb = pos.get(e.to);
    if (!pa || !pb) continue;
    segs.push({ a: e.from, b: e.to, pa, pb, mid: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } });
  }

  const MAX_BEND = 8.0;
  const EDGE_PUSH = 1.8;
  const STATION_MARGIN = 1.0;

  for (const seg of segs) {
    const { a, b, pa, pb, mid } = seg;
    const vx = pb.x - pa.x;
    const vy = pb.y - pa.y;
    const vlen = Math.hypot(vx, vy) || 1;
    const perpX = -vy / vlen;
    const perpY = vx / vlen;

    let dx = 0;
    let dy = 0;

    // (1) 边-边相交：把相交边沿中点连线方向推开
    for (const s of segs) {
      if (s === seg) continue;
      if (s.a === a || s.a === b || s.b === a || s.b === b) continue;
      if (!segIntersect(pa, pb, s.pa, s.pb)) continue;
      let rx = mid.x - s.mid.x;
      let ry = mid.y - s.mid.y;
      const rl = Math.hypot(rx, ry) || 1;
      dx += (rx / rl) * EDGE_PUSH;
      dy += (ry / rl) * EDGE_PUSH;
    }

    // (2) 边穿过非端点节点：沿垂直于边、远离站点的方向推开
    for (const tile of view.tiles) {
      if (tile.id === a || tile.id === b) continue;
      const p = pos.get(tile.id);
      if (!p) continue;
      const { d, t } = distPointToSeg(p, pa, pb);
      const clearance = nodeVisualRadius(tile) + STATION_MARGIN;
      if (d >= clearance) continue;
      if (t <= 0.12 || t >= 0.88) continue; // 靠近端点的不算穿过
      const signed = (vx * (p.y - pa.y) - vy * (p.x - pa.x)) / vlen;
      const sign = signed > 0 ? -1 : 1;
      let factor = 2 * t * (1 - t);
      if (factor < 0.3) factor = 0.3;
      const need = (clearance - d) / factor + 0.8;
      dx += sign * perpX * need;
      dy += sign * perpY * need;
    }

    // (3) 多出边时，平行边错开（保留旧逻辑）
    const fromTile = view.byId.get(a);
    if (fromTile && fromTile.out.length > 1) {
      const idx = fromTile.out.indexOf(b);
      const siblings = fromTile.out.length - 1;
      const k = 3 * (idx - siblings / 2);
      dx += (-vy / vlen) * k;
      dy += (vx / vlen) * k;
    }

    const m = Math.hypot(dx, dy);
    if (m > MAX_BEND) {
      dx = (dx / m) * MAX_BEND;
      dy = (dy / m) * MAX_BEND;
    }
    if (dx !== 0 || dy !== 0) {
      view.bends.set(`${a}-${b}`, { dx, dy });
      // 双向边的正反向都写入同一个位移
      if (isBidirectional(view, a, b)) {
        view.bends.set(`${b}-${a}`, { dx, dy });
      }
    }
  }
}

/** 查询某条边的弯曲偏移（从预计算结果中取） */
export function edgeBend(
  view: BoardViewData,
  from: string,
  to: string,
): { dx: number; dy: number } | undefined {
  return view.bends.get(`${from}-${to}`);
}

// ---------------------------------------------------------------- 移动可达计算
/**
 * 计算走 `steps` 步后可达的格与对应路径。
 *
 * 与引擎的差别：引擎在岔路口会停下来问玩家；这里为了做**移动预览**，
 * 把所有可能路径都枚举出来（同一个终点可能有多条路径，保留第一条）。
 *
 * @param reverse 反向移动（沿 in 边走，如「装腔作势」）
 * @returns 终点格 id -> 路径（不含起点，含终点）
 */
export function computeReachableTiles(
  view: BoardViewData,
  fromId: string,
  steps: number,
  reverse = false,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (steps <= 0) return result;
  const start = view.byId.get(fromId);
  if (!start) return result;

  // 广度优先：逐层展开，记录每一步到达的格子
  // 原版规则（GMap.cs:152-170）：路径上经过的建筑可以中途停下，
  // 所以 1..N-1 步到达的建筑也加入可选目的地
  let frontier: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [] }];
  for (let step = 0; step < steps; step++) {
    const next: Array<{ id: string; path: string[] }> = [];
    for (const node of frontier) {
      const tile = view.byId.get(node.id);
      if (!tile) continue;
      const outs = reverse ? tile.in : tile.out;
      for (const nb of outs) {
        if (!view.byId.has(nb)) continue;
        next.push({ id: nb, path: [...node.path, nb] });
      }
    }
    if (!next.length) break;
    frontier = next;

    // 中途建筑：1..N-1 步到达的建筑也作为可选目的地（最后一步由下方统一处理）
    if (step < steps - 1) {
      for (const node of frontier) {
        const tile = view.byId.get(node.id);
        if (tile?.isBuilding && !result.has(node.id)) {
          result.set(node.id, node.path);
        }
      }
    }
  }

  // 最后一步：所有可达格子（含建筑和站点）都加入
  for (const node of frontier) {
    if (!result.has(node.id)) result.set(node.id, node.path);
  }
  return result;
}

/** 两点间一条最短路径（用于预览展示） */
export function findPath(
  view: BoardViewData,
  fromId: string,
  toId: string,
): string[] | undefined {
  if (fromId === toId) return [];
  const prev = new Map<string, string>();
  const seen = new Set([fromId]);
  let frontier = [fromId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      const tile = view.byId.get(id);
      if (!tile) continue;
      for (const nb of tile.out) {
        if (seen.has(nb) || !view.byId.has(nb)) continue;
        seen.add(nb);
        prev.set(nb, id);
        if (nb === toId) {
          const path: string[] = [];
          let cur = toId;
          while (cur !== fromId) {
            path.unshift(cur);
            cur = prev.get(cur)!;
          }
          return path;
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  return undefined;
}

// ---------------------------------------------------------------- 卡牌语义辅助
/** 用这张牌移动的步数（原版 MovePoints 覆盖角色加成的部分由引擎处理） */
export function cardMoveSteps(cardId: string): number {
  const card = CARD_BY_ID[cardId];
  if (!card) return 0;
  // 骰子移动牌（a022 装腔作势）：move=0 但实际掷骰决定步数，预览时用最大值 6
  if (card.move === 0 && isDiceMoveCard(cardId)) return 6;
  return card.move ?? 0;
}

/** 骰子移动牌：move=0 + specialMove + ROLL["Move"] 动作 */
export function isDiceMoveCard(cardId: string): boolean {
  const card = CARD_BY_ID[cardId];
  if (!card) return false;
  return card.move === 0 && card.specialMove === true
    && card.actions?.some((a) => a.type === 'ROLL' && a.params?.[0] === 'Move');
}

/** 弃牌移动牌：move=0 + specialMove + Discard["Move"] 动作（a059 二手货） */
export function isDiscardMoveCard(cardId: string): boolean {
  const card = CARD_BY_ID[cardId];
  if (!card) return false;
  return card.move === 0 && card.specialMove === true
    && card.actions?.some((a) => a.type === 'Discard' && a.params?.[0] === 'Move');
}

/**
 * 「中心厄运站点」的格 id。
 *
 * 用于「特务·摇尾巴」：为避免玩家交锋，支付 {1}% 的 $ 并移动到中心厄运站点
 * （英文原文 "teleport to the central Misfortune spot"）。
 *
 * 原版地图里所谓"中心"没有显式标记，但两张图上恰好都有一个**连接度最高的
 * 厄运格**——Normal 是 2/2（其余 1/1），Colony 是 2/3（其余 1/1）。
 * 这就是数据驱动的判据，不用写死格号。
 *
 * @returns 格 id；地图上没有厄运格时返回 undefined
 */
export function centralMisfortuneId(map: BoardMap): string | undefined {
  const ms = map.cells.filter((c) => c.cellType === 'Misfortune');
  if (!ms.length) return undefined;
  // 连接度（出入度之和）最高者；并列时取 num 较大者（更靠地图后段）
  return ms
    .slice()
    .sort((a, b) => {
      const da = a.out.length + a.in.length;
      const db = b.out.length + b.in.length;
      if (db !== da) return db - da;
      return (b.num ?? 0) - (a.num ?? 0);
    })[0].id;
}

/**
 * 这张牌是否用于反向移动。
 * 判定依据是动作序列里含 `Move_Back`（如「装腔作势」），
 * 不用卡名做字符串匹配。
 */
export function isReverseMoveCard(cardId: string): boolean {
  const card = CARD_BY_ID[cardId];
  if (!card) return false;
  return card.actions.some((a) => a.type === 'Move_Back')
    || !!card.specialMove && card.actions.some((a) => a.type === 'SpecialMove');
}