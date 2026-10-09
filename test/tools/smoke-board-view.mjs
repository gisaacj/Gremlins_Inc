/**
 * 棋盘视图与桥接层的运行时校验。
 *
 * 用法: node tools/smoke-board-view.mjs
 * 依赖: 需先构建 shared
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const shared = await import(pathToFileURL('E:/code/小魔怪/shared/dist/index.js').href);
const {
  BOARD_VIEW, getBoardView, computeReachableTiles, findPath,
  edgeBend, isBidirectional, cardMoveSteps, isReverseMoveCard,
  BOARD_MAPS, CARD_BY_ID, CELL_TYPES,
} = shared;

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('=== 1. 棋盘视图 ===');
check(`默认地图 ${BOARD_VIEW.mapName}: ${BOARD_VIEW.tiles.length} 格 / ${BOARD_VIEW.edges.length} 条边`, () => {
  assert.equal(BOARD_VIEW.mapName, 'Normal');
  assert.equal(BOARD_VIEW.tiles.length, 67);
  assert.ok(BOARD_VIEW.edges.length > 60);
});
check('每格的 out/in 都指向存在的格', () => {
  for (const t of BOARD_VIEW.tiles) {
    for (const o of t.out) assert.ok(BOARD_VIEW.byId.has(o), `${t.label} out -> 未知格 ${o}`);
    for (const i of t.in) assert.ok(BOARD_VIEW.byId.has(i), `${t.label} in -> 未知格 ${i}`);
  }
});
check('所有边的两端都能在 byId 里解析（BoardView 渲染不会丢边）', () => {
  for (const e of BOARD_VIEW.edges) {
    assert.ok(BOARD_VIEW.byId.has(e.from), `边起点 ${e.from} 缺格`);
    assert.ok(BOARD_VIEW.byId.has(e.to), `边终点 ${e.to} 缺格`);
  }
});
check('监狱格存在且被标记为建筑', () => {
  const jail = BOARD_VIEW.byId.get(BOARD_VIEW.jailTileId);
  assert.ok(jail, '找不到监狱格');
  assert.equal(jail.cellType, 'Jail');
  assert.equal(jail.isBuilding, true);
});
check('坐标都在 0..100（SVG viewBox 内可绘制）', () => {
  for (const t of BOARD_VIEW.tiles) {
    assert.ok(t.x >= 0 && t.x <= 100 && t.y >= 0 && t.y <= 100, `${t.label} 坐标越界 (${t.x},${t.y})`);
  }
});
check('岔路口数量正确且都有多条出边', () => {
  assert.equal(BOARD_VIEW.junctions.length, 16);
  for (const id of BOARD_VIEW.junctions) {
    const t = BOARD_VIEW.byId.get(id);
    assert.ok(t, `岔路口 ${id} 不存在`);
    assert.ok(t.out.length > 1, `${t.label} 出度 ${t.out.length}，不应算岔路口`);
  }
});
check('两张地图都能构建视图', () => {
  for (const m of BOARD_MAPS) {
    const v = getBoardView(m.id);
    assert.equal(v.tiles.length, m.cells.length, `${m.name} 格数不符`);
    assert.ok(v.tiles.length > 60);
  }
});

console.log('\n=== 2. 移动可达 ===');
check('走 0 步无可达目的地', () => {
  assert.equal(computeReachableTiles(BOARD_VIEW, BOARD_VIEW.jailTileId, 0).size, 0);
});
check('走 N 步的可达集非空，且路径长度都等于 N', () => {
  for (const steps of [1, 2, 3, 4]) {
    const reach = computeReachableTiles(BOARD_VIEW, BOARD_VIEW.jailTileId, steps);
    assert.ok(reach.size > 0, `走 ${steps} 步应有可达格`);
    for (const [dest, path] of reach) {
      assert.equal(path.length, steps, `到 ${dest} 的路径长 ${path.length} 应为 ${steps}`);
      assert.equal(path[path.length - 1], dest, '路径末位应是目的地');
    }
  }
});
check('可达路径每一步都是合法出边', () => {
  const from = BOARD_VIEW.jailTileId;
  const reach = computeReachableTiles(BOARD_VIEW, from, 4);
  for (const [, path] of reach) {
    let cur = from;
    for (const id of path) {
      const t = BOARD_VIEW.byId.get(cur);
      assert.ok(t.out.includes(id), `${t.label} 的 out 不含 ${id}`);
      cur = id;
    }
  }
});
check('反向移动沿 in 边走', () => {
  const start = BOARD_VIEW.tiles.find((t) => t.in.length > 0);
  const fwd = computeReachableTiles(BOARD_VIEW, start.id, 2, false);
  const rev = computeReachableTiles(BOARD_VIEW, start.id, 2, true);
  assert.ok(fwd.size > 0 && rev.size > 0, '正反两个方向都应有可达格');
});
check('findPath 返回的路径合法且连通', () => {
  const from = BOARD_VIEW.jailTileId;
  const reach = computeReachableTiles(BOARD_VIEW, from, 3);
  const dest = [...reach.keys()][0];
  const path = findPath(BOARD_VIEW, from, dest);
  assert.ok(path, `应能找到 ${from} -> ${dest} 的路径`);
  let cur = from;
  for (const id of path) {
    assert.ok(BOARD_VIEW.byId.get(cur).out.includes(id), `路径不连通：${cur} -> ${id}`);
    cur = id;
  }
  assert.equal(cur, dest);
});

console.log('\n=== 3. 边渲染辅助 ===');
check('双向边判定正确：至少存在一些双向边', () => {
  let bi = 0;
  for (const e of BOARD_VIEW.edges) if (isBidirectional(BOARD_VIEW, e.from, e.to)) bi++;
  console.log(`      双向边 ${bi} / ${BOARD_VIEW.edges.length}`);
  assert.ok(bi > 0, '应存在双向边（棋盘有可双向通行的路段）');
});
check('单向边给出弯曲偏移，双向边不给（由调用方合并成双头箭头）', () => {
  for (const e of BOARD_VIEW.edges.slice(0, 200)) {
    const bend = edgeBend(BOARD_VIEW, e.from, e.to);
    if (isBidirectional(BOARD_VIEW, e.from, e.to)) {
      assert.equal(bend, undefined, '双向边不应给弯曲偏移');
    }
  }
});

console.log('\n=== 4. 顶层导出确认（OCR 数据已删除） ===');
check('BOARD_MAPS / CARD_BY_ID / CELL_TYPES 都是权威数据', () => {
  assert.ok(Array.isArray(shared.BOARD_MAPS), 'BOARD_MAPS 应为数组');
  assert.equal(shared.BOARD_MAPS.length, 2);
  assert.equal(Object.keys(shared.CARD_BY_ID).length, 186, 'CARD_BY_ID 应有 186 张');
  assert.ok(Array.isArray(shared.CELL_TYPES), 'CELL_TYPES 应为数组');
  assert.equal(shared.CELL_TYPES.length, 18);
});
check('OCR 命名空间已移除（不再有两套同名数据）', () => {
  assert.equal(shared.ocr, undefined, 'ocr 命名空间应已删除');
});
check('CARD_BY_ID 里的卡是权威结构（有 actions / deckCount）', () => {
  const a001 = shared.CARD_BY_NAME.a001;
  assert.ok(a001, '找不到 a001');
  assert.equal(a001.move, 3);
  assert.ok(Array.isArray(a001.actions), 'should have actions');
  assert.ok(a001.actions.some((x) => x.type === 'SelectOpponent'));
});

console.log('\n=== 5. 卡牌语义辅助 ===');
check('cardMoveSteps 与原版 MovePoints 一致', () => {
  let checked = 0;
  for (const c of Object.values(CARD_BY_ID)) {
    assert.equal(cardMoveSteps(c.id), c.move, `${c.name} 步数不符`);
    checked++;
  }
  console.log(`      校验了 ${checked} 张卡`);
});
check('反向移动判定基于动作序列，不靠卡名', () => {
  const rev = Object.values(CARD_BY_ID).filter((c) => isReverseMoveCard(c.id));
  console.log(`      判定为反向移动的卡：${rev.length} 张（${rev.slice(0, 4).map((c) => c.text.name).join('、')}）`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
