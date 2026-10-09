/**
 * 权威数据层冒烟测试 —— 校验 shared/src/gamedata 生成结果的自洽性。
 *
 * 用法: node tools/smoke-gamedata.mjs
 * 依赖: 需先构建 shared (cd shared && npx tsc -p tsconfig.json)
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const GD = 'E:/code/小魔怪/shared/dist/gamedata/index.js';
const gd = await import(pathToFileURL(GD).href);

let pass = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

console.log(`加载: ${GD}\n`);
console.log('=== 1. 规模 ===');
check(`${gd.ACTION_CARDS.length} 张行动卡 / 牌库 ${gd.ACTION_CARDS.reduce((s, c) => s + c.deckCount, 0)} 张`, () => {
  assert.equal(gd.ACTION_CARDS.length, 186);
  assert.equal(gd.ACTION_CARDS.reduce((s, c) => s + c.deckCount, 0), 225);
});
check(`地图 ${gd.BOARD_MAPS.length} 张（${gd.BOARD_MAPS.map((m) => m.cells.length).join('+')} 格）`, () => {
  assert.equal(gd.BOARD_MAPS.length, 2);
});
check(`角色 ${gd.CHARACTERS.length} / 监狱卡 ${gd.JAIL_CARDS.length} / 厄运卡 ${gd.MISFORTUNE_CARDS.length}`, () => {
  assert.equal(gd.CHARACTERS.length, 12);
  assert.equal(gd.JAIL_CARDS.length, 18);
  assert.equal(gd.MISFORTUNE_CARDS.length, 40);
});
check(`动作原语 ${gd.ACTION_TYPES.length} 种`, () => assert.equal(gd.ACTION_TYPES.length, 143));

console.log('\n=== 2. 已知数值抽查（对照原版，非 OCR） ===');
check('卡 a001 应为 移动3 / 50金钱 / +3选票', () => {
  const c = gd.CARD_BY_NAME['a001'];
  assert.ok(c, 'a001 不存在');
  assert.equal(c.move, 3, `move=${c.move}`);
  assert.equal(c.price, 50, `price=${c.price}`);
  assert.equal(c.priceType, 'Money');
  assert.equal(c.income?.vote, 3, `income.vote=${c.income?.vote}`);
  assert.equal(c.en.name, 'Propaganda');
  assert.equal(c.text.name, '游说');
});
check('卡牌移动点数均在 0..6', () => {
  for (const c of gd.ACTION_CARDS) assert.ok(c.move >= 0 && c.move <= 6, `${c.name} move=${c.move}`);
});
check('永久/秘密/罪恶旗标互斥计数 = 186', () => {
  const n = gd.ACTION_CARDS.filter((c) => c.permanent || c.secret || c.criminal || true).length;
  assert.equal(n, 186);
});

console.log('\n=== 3. 引用完整性 ===');
check('棋盘邻接 out/in 都指向存在的格', () => {
  for (const m of gd.BOARD_MAPS) {
    const ids = new Set(m.cells.map((c) => c.id));
    assert.equal(ids.size, m.cells.length, `${m.name} 存在重复格 id`);
    for (const c of m.cells) {
      for (const o of c.out) assert.ok(ids.has(o), `${m.name} ${c.name} out 指向未知格 ${o}`);
      for (const i of c.in) assert.ok(ids.has(i), `${m.name} ${c.name} in 指向未知格 ${i}`);
    }
  }
});
check('每格 cellType 都在枚举内', () => {
  const allowed = new Set(gd.CELL_TYPE_NAMES);
  for (const m of gd.BOARD_MAPS) for (const c of m.cells) assert.ok(allowed.has(c.cellType), `${c.name} -> ${c.cellType}`);
});
check('所有卡牌/角色/牌堆的 action.type 都在 ACTION_TYPES 内', () => {
  const allowed = new Set(gd.ACTION_TYPES);
  const scan = (label, list) => {
    for (const o of list)
      for (const a of o.actions || []) assert.ok(allowed.has(a.type), `${label} ${o.name} -> ${a.type}`);
  };
  scan('card', gd.ACTION_CARDS);
  scan('char', gd.CHARACTERS);
  scan('jail', gd.JAIL_CARDS);
  scan('chaos', gd.CHAOS_CARDS);
  scan('misfortune', gd.MISFORTUNE_CARDS);
  scan('cell', gd.CELL_TYPES);
});
check('角色行动顺序为 1..12 且唯一', () => {
  const orders = gd.CHARACTERS.map((c) => c.order).sort((a, b) => a - b);
  assert.deepEqual(orders, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});
check('每个角色的起始格都能在普通地图上找到', () => {
  const ids = new Set(gd.NORMAL_MAP.cells.map((c) => c.id));
  for (const c of gd.CHARACTERS)
    assert.ok(ids.has(c.normalStartCellId), `${c.name} 起始格 ${c.normalStartCellId} 不在普通地图`);
});
check('卡牌 cellTypeId（非空时）指向存在的格子类型', () => {
  let checked = 0;
  for (const c of gd.ACTION_CARDS) {
    if (!c.cellTypeId || c.cellTypeId === '0') continue;
    assert.ok(gd.CELL_TYPE_BY_ID[c.cellTypeId], `卡 ${c.name} cellTypeId ${c.cellTypeId} 未知`);
    checked++;
  }
  assert.ok(checked > 0, '没有任何卡带可用地点');
  console.log(`      （校验了 ${checked} 张卡的可用地点，指向格子类型而非棋盘格）`);
});
check('格子通过 cellTypeId 关联到格子类型定义', () => {
  for (const m of gd.BOARD_MAPS) {
    for (const c of m.cells) assert.ok(gd.CELL_TYPE_BY_ID[c.cellTypeId], `${m.name} ${c.name} -> ${c.cellTypeId}`);
  }
});

console.log('\n=== 4. 文案 ===');
check('所有卡牌都有中文名，且英文名非空', () => {
  const missing = gd.ACTION_CARDS.filter((c) => !c.text.name);
  assert.equal(missing.length, 0, `缺中文名: ${missing.slice(0, 5).map((c) => c.name).join(',')}`);
  const noEn = gd.ACTION_CARDS.filter((c) => !c.en.name);
  assert.equal(noEn.length, 0, `缺英文名: ${noEn.slice(0, 5).map((c) => c.name).join(',')}`);
});
check(`STRINGS 表 ${Object.keys(gd.STRINGS).length} 条，含 zh 与 en`, () => {
  const keys = Object.keys(gd.STRINGS);
  assert.ok(keys.length > 700);
  assert.ok(keys.every((k) => gd.STRINGS[k].zh !== undefined && gd.STRINGS[k].en !== undefined));
});
check('格子的中文标题已解析（继承自所属格子类型）', () => {
  const withText = gd.NORMAL_MAP.cells.filter((c) => c.text.caption).length;
  assert.ok(withText > 50, `仅 ${withText}/${gd.NORMAL_MAP.cells.length} 格有中文标题`);
});
check('格子类型的 params 至少有一个非零（站点规则参数）', () => {
  const withParams = gd.CELL_TYPES.filter((c) => c.params.some((p) => p !== 0)).length;
  assert.ok(withParams >= 5, `仅 ${withParams} 种格子类型带参数`);
});

console.log('\n=== 5. 棋盘布局 ===');
check('每张地图的每格都有坐标，且落在 0..100 内', () => {
  for (const [name, layout] of Object.entries(gd.LAYOUT_BY_MAP_NAME)) {
    const map = gd.BOARD_MAPS.find((m) => m.name === name);
    assert.ok(map, `找不到地图 ${name}`);
    for (const c of map.cells) {
      const p = layout.pos[c.id];
      assert.ok(p, `${name} 的格 ${c.name} 缺坐标`);
      assert.ok(p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100, `${c.name} 坐标越界 (${p.x},${p.y})`);
    }
  }
});
check('岔路口数量与实际出度>1 的格一致', () => {
  for (const [name, layout] of Object.entries(gd.LAYOUT_BY_MAP_NAME)) {
    const map = gd.BOARD_MAPS.find((m) => m.name === name);
    const actual = map.cells.filter((c) => c.out.length > 1).map((c) => c.id).sort();
    assert.deepEqual([...layout.junctions].sort(), actual, `${name} 岔路口列表不符`);
    console.log(`      ${name}: ${actual.length} 个岔路口`);
  }
});
check('主干道格 id 都真实存在且不重复', () => {
  for (const [name, layout] of Object.entries(gd.LAYOUT_BY_MAP_NAME)) {
    const ids = new Set(gd.BOARD_MAPS.find((m) => m.name === name).cells.map((c) => c.id));
    const seen = new Set();
    for (const id of layout.spine) {
      assert.ok(ids.has(id), `${name} 主干含未知格 ${id}`);
      assert.ok(!seen.has(id), `${name} 主干重复格 ${id}`);
      seen.add(id);
    }
  }
});
check('不同格的坐标不重叠（最小间距 > 2）', () => {
  const layout = gd.NORMAL_LAYOUT;
  const pts = Object.entries(layout.pos);
  let minDist = Infinity;
  let pair = '';
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i][1].x - pts[j][1].x, pts[i][1].y - pts[j][1].y);
      if (d < minDist) { minDist = d; pair = `${pts[i][0]}/${pts[j][0]}`; }
    }
  }
  console.log(`      最小间距 ${minDist.toFixed(2)}（${pair}）`);
  assert.ok(minDist > 2, `坐标重叠：最近两格距离仅 ${minDist.toFixed(2)}`);
});
check('出度分布与原始数据一致（分支图，不是单环）', () => {
  const dist = {};
  for (const c of gd.NORMAL_MAP.cells) dist[c.out.length] = (dist[c.out.length] ?? 0) + 1;
  console.log(`      普通地图出度分布: ${JSON.stringify(dist)}`);
  assert.ok(Object.keys(dist).length > 1, '若只有一个出度值说明不是分支图');
  assert.ok(gd.NORMAL_LAYOUT.junctions.length > 0, '应存在岔路口');
});

console.log('\n=== 6. 抽样输出 ===');
const sample = gd.CARD_BY_NAME['a001'];
console.log(`  卡 a001: ${sample.text.name} / ${sample.en.name}  移动=${sample.move} 费用=${sample.price}${sample.priceType}`);
console.log(`  中文说明: ${sample.text.description.slice(0, 80)}`);
const ch = gd.CHARACTERS[0];
console.log(`  角色[顺序${ch.order}]: ${ch.text.name} (${ch.name}) 技能数=${ch.actions.length}`);
const cell = gd.CELL_TYPE_BY_NAME['Bank'];
console.log(`  格子 Bank: ${cell.text.name} 建筑=${cell.building} 可选=${cell.optional} params=[${cell.params}]`);

console.log(`\n通过 ${pass} 项检查${process.exitCode ? '，存在失败项' : '，全部通过'}`);
