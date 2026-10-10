import { useEffect, useState, useRef } from 'react';
import type { SerializedPlayer } from '@gremlins/shared';
import {
  BOARD_VIEW, getBoardView, edgeBend, isBidirectional,
  type BoardViewData, type BoardTile, type CellTypeName,
} from '@gremlins/shared';
import { createLogger } from '../utils/logger.js';
import '../styles/board.css';

const boardLog = createLogger('ui', 'board');

interface Props {
  players: SerializedPlayer[];
  myPlayer?: SerializedPlayer;
  /** 当前地图 id（来自 game state），缺省用普通地图 */
  mapId?: string;
  highlightTileId?: string;
  /** 移动预览：可达目的地 tile id 列表 */
  moveDestTiles?: string[];
  /** 移动预览：已选定的目的地 */
  selectedDestTile?: string;
  /** 移动预览：已选目的地的途经路径（含终点，不含起点） */
  pathTiles?: string[];
  onTileClick?: (tileId: string) => void;
}

interface TooltipState {
  x: number;
  y: number;
  label: string;
  sub: string;
}

/**
 * 棋盘渲染。
 *
 * 数据源是**原作真实拓扑**（`shared/board-view.ts` → `gamedata/board.ts`），
 * 不是旧的手写数字 id 近似图。格 id 为原版 UIN 字符串。
 */
export function BoardView({
  players, mapId, highlightTileId, moveDestTiles, selectedDestTile, pathTiles, onTileClick,
}: Props) {
  const board: BoardViewData = mapId ? getBoardView(mapId) : BOARD_VIEW;
  const tiles = board.tiles;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const destSet = new Set(moveDestTiles ?? []);
  const pathSet = new Set(pathTiles ?? []);
  // 岔路口用空心环标记，提示玩家这里要选方向
  const junctionSet = new Set(board.junctions);

  useEffect(() => {
    boardLog.debug('players on board:',
      players.map((p) => `${p.name}(pos=${p.position},ai=${p.isAI},turn=${p.isCurrentTurn})`).join(' | '));
  }, [players]);

  const handleNodeClick = (tile: BoardTile) => {
    boardLog.info('click tile', tile.id, tile.label);
    setSelectedNodeId((cur) => (cur === tile.id ? null : tile.id));
    onTileClick?.(tile.id);
  };

  const handleNodeHover = (tile: BoardTile, e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      x: rect.left + (tile.x / 100) * rect.width,
      y: rect.top + (tile.y / 100) * rect.height,
      label: tile.label,
      sub: `${tile.isBuilding ? '建筑' : '站点'} · ${CELL_TYPE_ZH[tile.cellType] ?? tile.cellType}`
        + (junctionSet.has(tile.id) ? ' · 岔路口' : ''),
    });
    void e;
  };

  return (
    <>
      <svg
        ref={svgRef}
        className="board-svg"
        viewBox="-10 -7 120 117"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker id="arrow" markerWidth="4" markerHeight="4" refX="3.5" refY="2" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L4,2 L0,4 Z" fill="#5a7ab0" />
          </marker>
          <marker id="arrow-hl" markerWidth="4" markerHeight="4" refX="3.5" refY="2" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L4,2 L0,4 Z" fill="#f5b800" />
          </marker>
          <marker id="arrow-start" markerWidth="4" markerHeight="4" refX="0.5" refY="2" orient="auto" markerUnits="strokeWidth">
            <path d="M4,0 L0,2 L4,4 Z" fill="#5a7ab0" />
          </marker>
          <marker id="arrow-start-hl" markerWidth="4" markerHeight="4" refX="0.5" refY="2" orient="auto" markerUnits="strokeWidth">
            <path d="M4,0 L0,2 L4,4 Z" fill="#f5b800" />
          </marker>
        </defs>

        {/* 所有边（双向边合并为一根双头箭头） */}
        {board.edges.map((e, i) => {
          const bi = isBidirectional(board, e.from, e.to);
          // 双向边只画一次
          if (bi && e.from > e.to) return null;
          const from = board.byId.get(e.from);
          const to = board.byId.get(e.to);
          if (!from || !to) return null;
          const isHighlighted = selectedNodeId !== null
            && (e.from === selectedNodeId || e.to === selectedNodeId);
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const r = 3;
          const x1 = from.x + ux * r;
          const y1 = from.y + uy * r;
          const x2 = to.x - ux * r;
          const y2 = to.y - uy * r;
          const bend = bi ? undefined : edgeBend(board, e.from, e.to);
          const cx = (x1 + x2) / 2 + (bend?.dx ?? 0);
          const cy = (y1 + y2) / 2 + (bend?.dy ?? 0);
          return (
            <path
              key={`edge-${i}`}
              d={`M ${x1.toFixed(2)} ${y1.toFixed(2)} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`}
              fill="none"
              stroke={isHighlighted ? '#f5b800' : '#5a7ab0'}
              strokeWidth={isHighlighted ? '0.55' : '0.32'}
              opacity={selectedNodeId !== null && !isHighlighted ? 0.2 : 0.85}
              markerEnd={isHighlighted ? 'url(#arrow-hl)' : 'url(#arrow)'}
              markerStart={bi ? (isHighlighted ? 'url(#arrow-start-hl)' : 'url(#arrow-start)') : undefined}
            />
          );
        })}

        {/* 节点 */}
        {tiles.map((t) => {
          const color = t.isBuilding
            ? (BUILDING_COLORS[t.cellType] ?? '#7f8c8d')
            : (STATION_COLORS[t.cellType] ?? '#7f8c8d');
          const isSelected = selectedNodeId === t.id;
          const isHighlight = highlightTileId === t.id;
          const isBuilding = t.isBuilding;
          const isJunction = junctionSet.has(t.id);
          const r = isBuilding ? 2.4 : 1.8;
          const halfSize = isBuilding ? 2.4 : 0;
          const isDest = destSet.has(t.id);
          const isSelectedDest = selectedDestTile === t.id;
          const isPath = pathSet.has(t.id);

          return (
            <g
              key={t.id}
              transform={`translate(${t.x} ${t.y})`}
              style={{ cursor: isDest ? 'pointer' : 'default' }}
              onClick={() => handleNodeClick(t)}
              onMouseEnter={(e) => handleNodeHover(t, e)}
              onMouseLeave={() => setTooltip(null)}
            >
              {isSelected && (
                <circle r={r + 1.5} fill="none" stroke="#f5b800" strokeWidth="0.4" opacity="0.6">
                  <animate attributeName="r" values={`${r + 1.5};${r + 2.5};${r + 1.5}`} dur="1.2s" repeatCount="indefinite" />
                </circle>
              )}
              {isDest && !isSelectedDest && (
                <circle r={r + 1.2} fill="none" stroke="#2ecc71" strokeWidth="0.5" opacity="0.9">
                  <animate attributeName="opacity" values="0.4;0.95;0.4" dur="1.3s" repeatCount="indefinite" />
                </circle>
              )}
              {isSelectedDest && (
                <circle r={r + 1.6} fill="none" stroke="#f5b800" strokeWidth="0.7" opacity="0.95" />
              )}
              {isBuilding ? (
                <rect
                  x={-halfSize} y={-halfSize}
                  width={halfSize * 2} height={halfSize * 2}
                  rx="0.3"
                  fill={isSelectedDest ? '#f5b800' : isHighlight ? '#fff' : color}
                  stroke={isSelectedDest ? '#fff' : isSelected ? '#f5b800' : '#1a1a2e'}
                  strokeWidth="0.4"
                />
              ) : (
                <circle
                  r={r}
                  fill={isSelectedDest ? '#f5b800' : isPath ? '#2ecc71' : isHighlight ? '#fff' : color}
                  stroke={isSelectedDest ? '#fff' : isSelected ? '#f5b800' : isJunction ? '#fff' : '#1a1a2e'}
                  strokeWidth={isJunction ? '0.6' : '0.4'}
                  strokeDasharray={isJunction ? '0.8 0.6' : undefined}
                />
              )}
              <text
                x="0"
                y={isBuilding ? -3.2 : -2.4}
                textAnchor="middle"
                fontSize={isBuilding ? 2.2 : 1.6}
                fill="#fff"
                fontWeight={isBuilding ? 'bold' : 'normal'}
                style={{ pointerEvents: 'none' }}
              >
                {t.label.length > 4 ? t.label.slice(0, 4) : t.label}
              </text>
            </g>
          );
        })}

        {/* 玩家棋子 */}
        {players.map((p) => {
          const tile = board.byId.get(p.position);
          if (!tile) {
            boardLog.warn(`player ${p.name} position ${p.position} not on board`);
            return null;
          }
          const samePosPlayers = players.filter((pp) => pp.position === p.position);
          const samePosCount = samePosPlayers.length;
          const samePosIdx = samePosPlayers.indexOf(p);
          const angle = samePosCount > 1
            ? (samePosIdx / samePosCount) * Math.PI * 2 - Math.PI / 2
            : 0;
          const offset = samePosCount > 1 ? 3 : 0;
          const px = tile.x + Math.cos(angle) * offset;
          const py = tile.y + Math.sin(angle) * offset;
          const colors = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length];
          const initial = (p.name[0] || '?').toUpperCase();

          return (
            <g key={p.id} transform={`translate(${px} ${py})`}>
              <circle r="2.4" fill="rgba(0,0,0,0.5)" transform="translate(0.3 0.5)" />
              <circle r="2.4" fill={colors.primary} stroke={colors.secondary} strokeWidth="0.5" />
              <text x="0" y="0.9" textAnchor="middle" fontSize="2.4" fill={colors.secondary} fontWeight="bold" style={{ pointerEvents: 'none' }}>
                {initial}
              </text>
              {p.isAI && (
                <text x="0" y="4.5" textAnchor="middle" fontSize="1.4" fill={colors.primary} fontWeight="bold" style={{ pointerEvents: 'none' }}>
                  AI
                </text>
              )}
              {p.isCurrentTurn && (
                <circle r="3.4" fill="none" stroke={colors.primary} strokeWidth="0.5" opacity="0.8">
                  <animate attributeName="r" values="3.4;4.4;3.4" dur="1.5s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.8;0.3;0.8" dur="1.5s" repeatCount="indefinite" />
                </circle>
              )}
              <text x="0" y={p.isAI ? 7 : 5} textAnchor="middle" fontSize="1.6" fill="#fff" opacity="0.85" style={{ pointerEvents: 'none' }}>
                {p.name.length > 6 ? p.name.slice(0, 6) + '…' : p.name}
              </text>
            </g>
          );
        })}
      </svg>

      {tooltip && (
        <div className="board-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.label}
          <span className="tooltip-sub">{tooltip.sub}</span>
        </div>
      )}
    </>
  );
}

/** 原版 18 种格子类型的中文名 */
const CELL_TYPE_ZH: Record<CellTypeName, string> = {
  Astral: '天界',
  Bank: '银行',
  Bribe: '贿赂',
  Casino: '赌场',
  Courthouse: '法院',
  Danger: '冒险',
  Income: '收入',
  Inferno: '地狱',
  Jail: '监狱',
  Junkyard: '垃圾场',
  Marketplace: '市场',
  Misfortune: '厄运',
  Office: '办公楼',
  Plant: '工厂',
  Police: '警察',
  Risk: '赌博',
  Treasure: '藏宝阁',
  Tribune: '演讲',
};

/** 建筑配色（按原版格子类型名） */
const BUILDING_COLORS: Partial<Record<CellTypeName, string>> = {
  Plant: '#27ae60',
  Jail: '#7f8c8d',
  Casino: '#c0392b',
  Bank: '#f39c12',
  Treasure: '#d4ac0d',
  Courthouse: '#8e44ad',
  Marketplace: '#16a085',
  Junkyard: '#5d6d7e',
  Office: '#2980b9',
  Inferno: '#a93226',
  Astral: '#5dade2',
};

/** 站点配色 */
const STATION_COLORS: Partial<Record<CellTypeName, string>> = {
  Income: '#2ecc71',
  Bribe: '#e67e22',
  Police: '#3498db',
  Misfortune: '#9b59b6',
  Risk: '#e91e63',
  Tribune: '#1abc9c',
  Danger: '#e74c3c',
};

const PLAYER_COLORS = [
  { primary: '#e74c3c', secondary: '#fff' },
  { primary: '#3498db', secondary: '#fff' },
  { primary: '#2ecc71', secondary: '#fff' },
  { primary: '#9b59b6', secondary: '#fff' },
  { primary: '#f1c40f', secondary: '#000' },
  { primary: '#e67e22', secondary: '#fff' },
];
