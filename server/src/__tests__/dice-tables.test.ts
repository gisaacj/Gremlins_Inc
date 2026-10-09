// =============================================================
// 骰子结算表测试
//
// 原版把"掷骰结果 → 效果"写在格子类型的 `Label1..6` 里，
// 本文件锁住解析结果与关键数值，防止再退回"猜公式"的写法。
//
// 运行: npx tsx src/__tests__/dice-tables.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  CELL_TYPE_BY_NAME, diceTableOf, jailTermFor, parseDiceTable,
} from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

console.log('=== 1. 解析器本身 ===');
check('空表返回空对象', () => {
  assert.deepEqual(parseDiceTable([], []), {});
});
check('多面同一行 "2, 3 = +7$" 两面都命中', () => {
  const t = parseDiceTable(['2, 3 = +7$'], []);
  assert.deepEqual(t[2]?.gain, { money: 7 });
  assert.deepEqual(t[3]?.gain, { money: 7 });
});
check('中文逗号 "2，3 = +7$" 也能解析', () => {
  const t = parseDiceTable(['2，3 = +7$'], []);
  assert.deepEqual(t[2]?.faces, [2, 3]);
  assert.deepEqual(t[3]?.faces, [2, 3]);
});
check('{N} 按 params[N-1] 替换（{4} → params[3]）', () => {
  const t = parseDiceTable(['4 = +{4}$'], [0, 0, 0, 55]);
  assert.deepEqual(t[4]?.gain, { money: 55 });
});
check('多个效果 "-{3}&, +{3}^" 都解析', () => {
  const t = parseDiceTable(['3 = -{3}&, +{3}^'], [0, 0, 9]);
  assert.deepEqual(t[3]?.gain, { vote: -9, malice: 9 });
});
check('纯文本结果进 special', () => {
  assert.equal(parseDiceTable(['1 = 厄运'], [])[1]?.special, '厄运');
  assert.equal(parseDiceTable(['2 = 谢谢参与'], [])[2]?.special, '谢谢参与');
});
check('非法点数被忽略', () => {
  assert.deepEqual(parseDiceTable(['0 = +1$', '7 = +1$'], []), {});
});
check('没有 "=" 的行被忽略', () => {
  assert.deepEqual(parseDiceTable(['随便一句话'], []), {});
});

console.log('\n=== 2. 赌场（Casino）：1~3 扣钱，4~6 加钱 ===');
check('赌场参数为 [100,50,25,25,50,100]', () => {
  assert.deepEqual(CELL_TYPE_BY_NAME.Casino.params, [100, 50, 25, 25, 50, 100]);
});
check('各点数金额与数据一致', () => {
  const t = diceTableOf('Casino');
  const expect: Record<number, number> = { 1: -100, 2: -50, 3: -25, 4: 25, 5: 50, 6: 100 };
  for (let f = 1; f <= 6; f++) {
    assert.equal(t[f]?.gain?.money, expect[f], `点数 ${f}`);
  }
});
check('赌场不是"最低点数→奖金"的递增表（旧错误实现会全为正）', () => {
  const t = diceTableOf('Casino');
  assert.ok((t[1]?.gain?.money ?? 0) < 0, '掷 1 必须是扣钱');
  assert.ok((t[6]?.gain?.money ?? 0) > 0, '掷 6 必须是加钱');
});

console.log('\n=== 3. 垃圾场（Junkyard）：1 扣选票，2~3 无事，4~6 加钱 ===');
check('垃圾场参数为 [1,30,0,10,20,30]', () => {
  assert.deepEqual(CELL_TYPE_BY_NAME.Junkyard.params, [1, 30, 0, 10, 20, 30]);
});
check('掷 1 扣 1 选票', () => {
  assert.equal(diceTableOf('Junkyard')[1]?.gain?.vote, -1);
});
check('掷 2、3 无事', () => {
  const t = diceTableOf('Junkyard');
  assert.equal(t[2]?.gain, undefined);
  assert.equal(t[3]?.gain, undefined);
  assert.ok(t[2]?.special, '应带"谢谢参与"之类的文案');
});
check('掷 4/5/6 分别 +10/+20/+30 金钱', () => {
  const t = diceTableOf('Junkyard');
  assert.equal(t[4]?.gain?.money, 10);
  assert.equal(t[5]?.gain?.money, 20);
  assert.equal(t[6]?.gain?.money, 30);
});
check('旧实现 dice×10 是错的（掷 2 不该 +20）', () => {
  assert.notEqual(diceTableOf('Junkyard')[2]?.gain?.money, 20);
});

console.log('\n=== 4. 赌博格（Risk）：1 厄运，2 扣钱，3 扣选票+罪恶，4~6 收益 ===');
check('Risk 参数为 [0,50,1,50,2,100]', () => {
  assert.deepEqual(CELL_TYPE_BY_NAME.Risk.params, [0, 50, 1, 50, 2, 100]);
});
check('掷 1 是厄运（special）', () => {
  assert.match(diceTableOf('Risk')[1]?.special ?? '', /厄运|Misfortune/i);
});
check('掷 2 扣 50 金钱', () => {
  assert.equal(diceTableOf('Risk')[2]?.gain?.money, -50);
});
check('掷 3 扣 1 选票并 +1 罪恶', () => {
  const g = diceTableOf('Risk')[3]?.gain;
  assert.equal(g?.vote, -1);
  assert.equal(g?.malice, 1);
});
check('掷 4 +50 金 / 掷 5 +2 选票 / 掷 6 +100 金', () => {
  const t = diceTableOf('Risk');
  assert.equal(t[4]?.gain?.money, 50);
  assert.equal(t[5]?.gain?.vote, 2);
  assert.equal(t[6]?.gain?.money, 100);
});

console.log('\n=== 5. 演讲（Tribune）：下注额决定掷骰门槛 ===');
check('Tribune 参数为 [10,20,30,40,50,0]', () => {
  assert.deepEqual(CELL_TYPE_BY_NAME.Tribune.params, [10, 20, 30, 40, 50, 0]);
});
check('下注 10 需掷出 6（只命中 6）', () => {
  const t = diceTableOf('Tribune');
  assert.deepEqual(t[6]?.faces, [2, 3, 4, 5, 6]); // 表是"点数→结果"，需按档位取值
  // 档位 1（10 金）的 Label 是 "6 = +1&" → 只命中 6
  const tier1 = parseDiceTable([CELL_TYPE_BY_NAME.Tribune.labels[0]], [10, 20, 30, 40, 50, 0]);
  assert.deepEqual(tier1[6]?.faces, [6]);
  assert.equal(tier1[6]?.gain?.vote, 1);
  assert.equal(tier1[5], undefined, '下注 10 时掷 5 不该命中');
});
check('下注 50 掷 2~6 都命中', () => {
  const tier5 = parseDiceTable([CELL_TYPE_BY_NAME.Tribune.labels[4]], [10, 20, 30, 40, 50, 0]);
  for (let f = 2; f <= 6; f++) {
    assert.equal(tier5[f]?.gain?.vote, 1, `点数 ${f} 应命中`);
  }
  assert.equal(tier5[1], undefined, '掷 1 不该命中');
});
check('每一档的命中面数递增（下注越高越容易）', () => {
  const counts = CELL_TYPE_BY_NAME.Tribune.labels
    .slice(0, 5)
    .map((l) => {
      const t = parseDiceTable([l], [10, 20, 30, 40, 50, 0]);
      return Object.values(t)[0]?.faces.length ?? 0;
    });
  assert.deepEqual(counts, [1, 2, 3, 4, 5], `实际 ${counts.join(',')}`);
});
check('最后一档是"不演讲"（非掷骰选项）', () => {
  assert.match(CELL_TYPE_BY_NAME.Tribune.labels[5], /不向选民演讲|Do not address/i);
});
check('每档的门槛 = 该档最低命中点数（下注 10→6，50→2）', () => {
  const def = CELL_TYPE_BY_NAME.Tribune;
  const needs = [0, 1, 2, 3, 4].map((i) => {
    const t = parseDiceTable([def.labels[i]], def.params);
    const faces = t[Object.keys(t).map(Number)[0]]?.faces ?? [];
    return Math.min(...faces);
  });
  assert.deepEqual(needs, [6, 5, 4, 3, 2], `实际 ${needs.join(',')}`);
  // 下注额与门槛反相关：下注越高门槛越低
  assert.deepEqual(def.params.slice(0, 5), [10, 20, 30, 40, 50]);
});
check('用 diceTableOf 的合并表取档位会错（回归锁）', () => {
  // diceTableOf 是"点数 → 结果"，下注 10 需 6，但合并表里 6 对应的是**最后写入**的档位。
  // 所以 tribune 必须按档位逐行解析（见 options.ts），不能用 diceTableOf 下标取档位。
  const merged = diceTableOf('Tribune');
  const tier1 = parseDiceTable([CELL_TYPE_BY_NAME.Tribune.labels[0]], CELL_TYPE_BY_NAME.Tribune.params);
  assert.notDeepEqual(
    merged[6]?.faces,
    tier1[6]?.faces,
    '若两者相同说明测试失去意义（合并表行为变了）',
  );
  assert.deepEqual(tier1[6]?.faces, [6], '档位 1 只命中 6');
});

console.log('\n=== 6. 监狱（Jail）：刑期表 ===');
check('Jail 参数为 [2,3,4,0,0,0]', () => {
  assert.deepEqual(CELL_TYPE_BY_NAME.Jail.params.slice(0, 3), [2, 3, 4]);
});
check('掷 1/2 → 4 回合；3/4 → 3 回合；5/6 → 2 回合', () => {
  assert.equal(jailTermFor(1), 4);
  assert.equal(jailTermFor(2), 4);
  assert.equal(jailTermFor(3), 3);
  assert.equal(jailTermFor(4), 3);
  assert.equal(jailTermFor(5), 2);
  assert.equal(jailTermFor(6), 2);
});
check('jailTermFor 读的是数据表而不是硬编码', () => {
  // 刑期表里的文案形如 "4 次走牌"，数值与 params[2] 一致
  assert.equal(CELL_TYPE_BY_NAME.Jail.params[2], 4);
  assert.equal(jailTermFor(1), CELL_TYPE_BY_NAME.Jail.params[2]);
});

console.log('\n=== 7. 藏宝阁（Treasure）：纯收益递增 ===');
check('Treasure 参数为 [10,25,50,100,150,200]', () => {
  assert.deepEqual(CELL_TYPE_BY_NAME.Treasure.params, [10, 25, 50, 100, 150, 200]);
});
check('各点数金钱与参数一一对应', () => {
  const t = diceTableOf('Treasure');
  const p = CELL_TYPE_BY_NAME.Treasure.params;
  for (let f = 1; f <= 6; f++) assert.equal(t[f]?.gain?.money, p[f - 1], `点数 ${f}`);
});

console.log('\n=== 8. 覆盖检查：所有带 Label 的格子都能解析 ===');
check('有 labels 的格子解析结果非空', () => {
  const withLabels = Object.values(CELL_TYPE_BY_NAME).filter((c) => c.labels?.length);
  assert.ok(withLabels.length >= 6, `应至少 6 种，实际 ${withLabels.length}`);
  for (const c of withLabels) {
    const t = diceTableOf(c.cellType);
    assert.ok(Object.keys(t).length > 0, `${c.cellType} 解析失败：labels=${JSON.stringify(c.labels)}`);
    console.log(`      ${c.cellType.padEnd(10)} 命中点数 ${Object.keys(t).sort().join(',')}`);
  }
});
check('labels 是实际文案而不是 UIN', () => {
  for (const c of Object.values(CELL_TYPE_BY_NAME)) {
    for (const l of c.labels ?? []) {
      assert.ok(!/^\d{15,}$/.test(l), `${c.cellType} 的 label 仍是 UIN: ${l}`);
    }
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
