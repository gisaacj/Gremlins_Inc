// =============================================================
// 棋盘运行时视图 —— UI 消费的棋盘形态
//
// 数据来源：用户提供的 30 节点坐标 + 连线规则。
// 坐标已设计好不交叉，无需网格布局或交叉消除算法。
// =============================================================
import type { BoardCell, BoardMap, CellTypeName } from './gamedata/index.js';
import {
  CELL_TYPE_BY_ID, CUSTOM_MAP, CUSTOM_POS,
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
  _reverse?: boolean,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (steps <= 0) return result;
  let current = new Map<string, string[]>([[startId, []]]);
  for (let i = 0; i < steps; i++) {
    const next = new Map<string, string[]>();
    for (const [tileId, path] of current) {
      const tile = view.byId.get(tileId);
      if (!tile) continue;
      for (const nb of tile.out) {
        if (!next.has(nb)) next.set(nb, [...path, nb]);
      }
    }
    current = next;
  }
  return current;
}

/** 卡牌实际移动步数 */
export function cardMoveSteps(cardId: string): number {
  return 0;
}

/** 是否为掷骰移动牌 */
export function isDiceMoveCard(cardId: string): boolean {
  return false;
}

/** 是否为弃牌移动牌 */
export function isDiscardMoveCard(cardId: string): boolean {
  return false;
}

/** 中央厄运格 id */
export function centralMisfortuneId(_map: BoardMap): string | undefined {
  return BOARD_VIEW.tiles.find((t) => t.cellType === 'Misfortune' && t.out.length + t.in.length >= 4)?.id;
}

/** 是否为反向移动牌 */
export function isReverseMoveCard(_cardId: string): boolean {
  return false;
}
