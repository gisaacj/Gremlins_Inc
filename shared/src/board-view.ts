// =============================================================
// 棋盘运行时视图 —— UI 消费的棋盘形态
//
// 数据来源：用户提供的 30 节点坐标 + 连线规则。
// 坐标已设计好不交叉，无需网格布局或交叉消除算法。
// =============================================================
import type { BoardCell, BoardMap, CellTypeName } from './gamedata/index.js';
import {
  CELL_TYPE_BY_ID, CUSTOM_MAP, CUSTOM_POS, CARD_BY_ID,
} from './gamedata/index.js';

// 棋盘相关的原版类型一并 re-export
export type { BoardCell, BoardMap, CellTypeName } from './gamedata/index.js';

/** UI 用的格子分类 */
export type TileKind = 'building' | 'station' | 'jail';

/** UI 用的单格 */
export interface BoardTile {
  id: string;
  num: number;
  cellType: CellTypeName;
  kind: TileKind;
  isBuilding: boolean;
  label: string;
  description: string;
  x: number;
  y: number;
  out: string[];
  in: string[];
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
  junctions: string[];
  jailTileId: string;
  byId: Map<string, BoardTile>;
  bends: Map<string, { dx: number; dy: number }>;
  gridSize: number;
}

const JAIL_TILE_KIND: TileKind = 'jail';

function classify(cell: BoardCell): { kind: TileKind; isBuilding: boolean } {
  const def = CELL_TYPE_BY_ID[cell.cellTypeId];
  const isBuilding = !!def?.building;
  if (cell.cellType === 'Jail') return { kind: JAIL_TILE_KIND, isBuilding: true };
  return { kind: isBuilding ? 'building' : 'station', isBuilding };
}

/** 由自定义棋盘构造 UI 视图 */
function buildBoardView(): BoardViewData {
  const map = CUSTOM_MAP;
  const tiles: BoardTile[] = map.cells.map((cell) => {
    const { kind, isBuilding } = classify(cell);
    const p = CUSTOM_POS[cell.id] ?? { x: 50, y: 50 };
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
  const junctions = tiles.filter((t) => t.out.length > 1).map((t) => t.id);

  return {
    mapId: map.id,
    mapName: map.name,
    tiles,
    edges,
    junctions,
    jailTileId: jail?.id ?? tiles[0]?.id ?? '',
    byId: new Map(tiles.map((t) => [t.id, t])),
    bends: new Map(),
    gridSize: 0,
  };
}

/** 默认棋盘视图 */
export const BOARD_VIEW: BoardViewData = buildBoardView();

/** 按地图 id 取（30 节点棋盘只有一张） */
export function getBoardView(_mapId?: string): BoardViewData {
  return BOARD_VIEW;
}

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

/** 边弯曲（直线不需要，返回 undefined） */
export function edgeBend(_view: BoardViewData, _from: string, _to: string): { dx: number; dy: number } | undefined {
  return undefined;
}

// ---------------------------------------------------------------- 移动辅助

/** 从 start 出发走 steps 步能到达的所有目的地及路径 */
export function computeReachableTiles(
  view: BoardViewData,
  startId: string,
  steps: number,
  reverse = false,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (steps <= 0) return result;
  const start = view.byId.get(startId);
  if (!start) return result;

  // BFS 逐层展开
  // 原版规则（GMap.cs:152-170）：路径上经过的建筑可以中途停下，
  // 所以 1..N-1 步到达的建筑也加入可选目的地
  let frontier: Array<{ id: string; path: string[] }> = [{ id: startId, path: [] }];
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

    // 中途建筑：1..N-1 步到达的建筑也作为可选目的地
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

/** 用这张牌移动的步数 */
export function cardMoveSteps(cardId: string): number {
  const card = CARD_BY_ID[cardId];
  if (!card) return 0;
  // 骰子移动牌（a022 装腔作势）：move=0 但实际掷骰决定步数，预览时用最大值 6
  if (card.move === 0 && isDiceMoveCard(cardId)) return 6;
  return card.move ?? 0;
}

/** 是否为掷骰移动牌（move=0 + specialMove + ROLL["Move"]） */
export function isDiceMoveCard(cardId: string): boolean {
  const c = CARD_BY_ID[cardId];
  if (!c) return false;
  if (c.move > 0 || !c.specialMove) return false;
  return c.actions?.some((a: any) => a.type === 'ROLL' && a.params?.[0] === 'Move') ?? false;
}

/** 是否为弃牌移动牌（move=0 + specialMove + Discard["Move"]） */
export function isDiscardMoveCard(cardId: string): boolean {
  const c = CARD_BY_ID[cardId];
  if (!c) return false;
  if (c.move > 0 || !c.specialMove) return false;
  return c.actions?.some((a: any) => a.type === 'Discard' && a.params?.[0] === 'Move') ?? false;
}

/**
 * 中央厄运格 id（「特务·摇尾巴」传送的目标）。
 *
 * 判据：**连接度最高的厄运格**（出入度之和）。
 * 原版地图没有"中心"标记，但每张图上恰好都有一个度数明显更高的厄运格
 * （Normal/自定义 是 2+2，其余 1+1；Colony 是 2+3）。
 *
 * ⚠️ 必须从**传入的 map** 取，不能用模块级的 `BOARD_VIEW`——
 * 后者只装了当前这一张棋盘，对别的地图会返回不属于它的格 id。
 */
export function centralMisfortuneId(map: BoardMap): string | undefined {
  const ms = map.cells.filter((c) => c.cellType === 'Misfortune');
  if (!ms.length) return undefined;
  return ms
    .slice()
    .sort((a, b) => {
      const da = a.out.length + a.in.length;
      const db = b.out.length + b.in.length;
      if (db !== da) return db - da;
      return (b.num ?? 0) - (a.num ?? 0);
    })[0].id;
}

/** 是否为反向移动牌 */
export function isReverseMoveCard(cardId: string): boolean {
  const card = CARD_BY_ID[cardId];
  if (!card) return false;
  return card.actions?.some((a: any) => a.type === 'Move_Back') ?? false;
}
