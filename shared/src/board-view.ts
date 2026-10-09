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

  const edges: BoardEdge[] = [];
  for (const t of tiles) for (const to of t.out) edges.push({ from: t.id, to });

  const jail = tiles.find((t) => t.cellType === 'Jail');

  return {
    mapId: map.id,
    mapName: map.name,
    tiles,
    edges,
    junctions: layout.junctions,
    jailTileId: jail?.id ?? tiles[0]?.id ?? '',
    byId: new Map(tiles.map((t) => [t.id, t])),
  };
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

/**
 * 生成一条边的渲染路径控制点偏移量，避免多条边完全重叠。
 * 双向边（A→B 且 B→A）返回 undefined，由调用方画成双头箭头。
 */
export function edgeBend(
  view: BoardViewData,
  from: string,
  to: string,
): { dx: number; dy: number } | undefined {
  const a = view.byId.get(from);
  const b = view.byId.get(to);
  if (!a || !b) return undefined;
  // 反向边存在 → 双向，交给调用方合并渲染
  if (a.in.includes(to)) return undefined;
  // 平行边（同一个 to 有多条来源且几何接近）时错开
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const siblings = a.out.length - 1;
  if (siblings <= 0) return undefined;
  const idx = a.out.indexOf(to);
  const k = 6 * (idx - siblings / 2);
  return { dx: (-dy / len) * k, dy: (dx / len) * k };
}

/** 是否是双向边 */
export function isBidirectional(view: BoardViewData, from: string, to: string): boolean {
  const a = view.byId.get(from);
  const b = view.byId.get(to);
  if (!a || !b) return false;
  return a.in.includes(to) && b.in.includes(from);
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

  // 广度优先：把「已走步数」纳入状态，允许同一格以不同步数到达
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
  }

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
  return CARD_BY_ID[cardId]?.move ?? 0;
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