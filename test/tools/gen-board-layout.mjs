#!/usr/bin/env node
/**
 * 为真实棋盘拓扑计算渲染坐标。
 *
 * 原作 GMap 只存图结构（OutCells/InCells），没有坐标——UI 布局需要自己算。
 *
 * 算法：
 *   1. 取"主干道"：从监狱出发，反复选「未被访问且出度最小」的路径，得到一条长链
 *   2. 主干道首尾相接的假设下，按弧长均匀铺在一个圆上
 *   3. 非主干格按其到最近主干格的路径挂到外层（建筑）或内层（分叉支线）
 *
 * 输出: E:/code/小魔怪/shared/src/gamedata/board-layout.ts
 */
import fs from 'node:fs';

const MAPS = 'E:/code/小魔怪/test/data/maps.json';
const OUT = 'E:/code/小魔怪/shared/src/gamedata/board-layout.ts';

const maps = JSON.parse(fs.readFileSync(MAPS, 'utf8'));

function analyze(mapObj) {
  const cells = Object.values(mapObj.Cells);
  const byId = new Map(cells.map((c) => [c.ID.AsString, c]));
  const outs = (c) => (c.OutCells || []).map((x) => x.AsString).filter((x) => x && x !== '0');
  const ins = (c) => (c.InCells || []).map((x) => x.AsString).filter((x) => x && x !== '0');

  // 起点：监狱
  const jail = cells.find((c) => c.CellType === 'Jail') ?? cells[0];

  // ---------- 1. 主干道 ----------
  // 策略：每次在候选出边里选「入度最小」的，偏向走廊；已被访问的跳过。
  // 直到无法继续或达到上限。
  const spine = [jail.ID.AsString];
  const seen = new Set(spine);
  let cur = jail;
  for (let guard = 0; guard < cells.length * 2; guard++) {
    const cand = outs(cur).filter((id) => byId.has(id) && !seen.has(id));
    if (!cand.length) break;
    // 优先出度=1（纯走廊），其次入度小
    cand.sort((a, b) => {
      const ca = byId.get(a), cb = byId.get(b);
      return (outs(ca).length - outs(cb).length) || (ins(ca).length - ins(cb).length);
    });
    const next = cand[0];
    spine.push(next);
    seen.add(next);
    cur = byId.get(next);
  }

  // ---------- 2. 距离主干的最短路径层数 ----------
  const dist = new Map(spine.map((id, i) => [id, 0]));
  let frontier = [...spine];
  let d = 0;
  while (frontier.length && d < 10) {
    d++;
    const next = [];
    for (const id of frontier) {
      const c = byId.get(id);
      if (!c) continue;
      for (const nb of [...outs(c), ...ins(c)]) {
        if (!byId.has(nb) || dist.has(nb)) continue;
        dist.set(nb, d);
        next.push(nb);
      }
    }
    frontier = next;
  }

  // ---------- 3. 坐标 ----------
  const N = spine.length;
  const R_SPINE = 34;      // 主干半径（百分比）
  const R_OUT = 46;        // 外层（建筑/支线）
  const cx = 50, cy = 50;
  const pos = new Map();

  spine.forEach((id, i) => {
    // 从 -90° 起顺时针，让起点在正上方
    const ang = (-90 + (360 * i) / Math.max(1, N)) * (Math.PI / 180);
    pos.set(id, { x: cx + R_SPINE * Math.cos(ang), y: cy + R_SPINE * Math.sin(ang) });
  });

  // 非主干：挂到最近的已定位邻格的角向外偏移
  const rest = cells.map((c) => c.ID.AsString).filter((id) => !pos.has(id));
  // 多轮扩散，保证每个格都能找到已定位的锚点
  const pending = [...rest];
  for (let round = 0; round < 6 && pending.length; round++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const id = pending[i];
      const c = byId.get(id);
      const anchors = [...outs(c), ...ins(c)].filter((nb) => pos.has(nb));
      if (!anchors.length) continue;
      // 锚点方向
      let vx = 0, vy = 0;
      for (const a of anchors) {
        const p = pos.get(a);
        vx += p.x - cx;
        vy += p.y - cy;
      }
      const len = Math.hypot(vx, vy) || 1;
      const ux = vx / len, uy = vy / len;
      const layer = dist.get(id) ?? 1;
      const r = R_SPINE + Math.min(3, layer) * 6;
      pos.set(id, { x: cx + r * ux, y: cy + r * uy });
      pending.splice(i, 1);
    }
  }
  // 兜底
  for (const id of pending) pos.set(id, { x: cx, y: cy });

  // ---------- 4. 规整化到 0..100 ----------
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sx = maxX - minX || 1, sy = maxY - minY || 1;
  const pad = 5;
  const norm = {};
  for (const [id, p] of pos) {
    norm[id] = {
      x: +(pad + ((p.x - minX) / sx) * (100 - 2 * pad)).toFixed(2),
      y: +(pad + ((p.y - minY) / sy) * (100 - 2 * pad)).toFixed(2),
    };
  }

  return {
    name: mapObj.Name,
    spine,
    junctions: cells.filter((c) => outs(c).length > 1).map((c) => c.ID.AsString),
    pos: norm,
  };
}

const results = Object.values(maps.MapList).map(analyze);

const body = results.map((r) => {
  const key = r.name === 'Normal' ? 'NORMAL' : 'COLONY';
  return (
    `/** ${r.name} 地图布局：${Object.keys(r.pos).length} 格 */\n` +
    `export const ${key}_LAYOUT: BoardLayout = {\n` +
    `  spine: ${JSON.stringify(r.spine)},\n` +
    `  junctions: ${JSON.stringify(r.junctions)},\n` +
    `  pos: ${JSON.stringify(r.pos)},\n` +
    `};\n`
  );
}).join('\n');

fs.writeFileSync(OUT,
`// 本文件由 test/tools/gen-board-layout.mjs 自动生成，请勿手工编辑。
//
// 原作 GMap 只存图结构（OutCells/InCells），没有坐标；这里按拓扑算出渲染坐标。
// 算法：先抽一条主干道铺成圆环，其余格按其到主干的最短距离向外分层展开。
//
// 注意：\`junctions\` 是出度 > 1 的格子——玩家在这些格必须自选分支，
// 引擎不可代替玩家决定。

/** 单张地图的渲染布局 */
export interface BoardLayout {
  /** 主干道格 id 顺序（用于画环形骨架） */
  spine: string[];
  /** 岔路口格 id（出度 > 1，需要玩家选方向） */
  junctions: string[];
  /** 格 id -> 百分比坐标（0..100） */
  pos: Record<string, { x: number; y: number }>;
}

${body}
/** 地图名 -> 布局 */
export const LAYOUT_BY_MAP_NAME: Record<string, BoardLayout> = {
  Normal: NORMAL_LAYOUT,
  Colony: COLONY_LAYOUT,
};

/** 未收录地图时的兜底：全部格堆在中心，避免 UI 崩 */
export const EMPTY_LAYOUT: BoardLayout = { spine: [], junctions: [], pos: {} };
`, 'utf8');

console.log('=== 布局生成 ===');
for (const r of results) {
  const n = Object.keys(r.pos).length;
  console.log(`  ${r.name.padEnd(8)} 格=${n}  主干=${r.spine.length}  岔路口=${r.junctions.length}`);
}
console.log(`\n输出: ${OUT}`);
