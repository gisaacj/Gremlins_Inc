// =============================================================
// 交锋出价（`MaxResultValue`）行为测试
//
// ## 已确认的部分（来自原版客户端）
//
// `ComConflictWindow.MaxResultValue` 只被客户端**读取**，用于：
//   - `CConflictForm`：`valueSlider.maxValue = maxResValue`（滑条上限）
//   - `MaxValueLabel.text = maxResValue`（显示"最大可出价"）
//   - `OnSetClick` 校验 `0 <= num <= maxResValue` 后才回传 `ComConflictWindowAnswer.Result`
//   - `MaxResultValue <= 0` 时整块出价 UI 禁用，该玩家直接标记为"已就绪"
//
// 全仓库搜 `new ComConflictWindow`，**客户端从不构造它** —— 它由服务端下发。
// 因此 `MaxResultValue` 的**具体算法在本次反编译产物内不可确认**。
//
// ## 本引擎的取值与依据
//
// 取「出价者**自己**持有的金钱」。依据：
//  1. 必然性——不能喊出付不起的价，否则"出价最高者付款"会退化成
//     "喊一个天价、只付一点点，却照样赢下交锋"。
//  2. 滑条上限是**每条命令一个数值**，而双方共用同一张表单，
//     说明原版两侧上限本就可能不同（各按各自的钱算）。
//
// ⚠️ 这是**推断**，不是权威结论。原版是否另有上限（如某个全局常量、
// 或"双方取较小值"）无法从产物内证实。
//
// 运行: npx tsx server/src/__tests__/conflict-bid.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  CHARACTERS, conflictBidMax, createState, getPlayer, resolvePending, startConflict,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function duel(moneyA = 500, moneyB = 500, maliceA = 0, maliceB = 0) {
  const st: EngineState = createState({
    roomId: 'bid', seed: 5, targetScore: 999,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  const a = getPlayer(st, 'P0')!;
  const b = getPlayer(st, 'P1')!;
  a.res.money = moneyA; a.res.malice = maliceA;
  b.res.money = moneyB; b.res.malice = maliceB;
  st.currentIndex = st.players.indexOf(a);
  startConflict(st, a, b);
  return { st, a, b };
}

const maxOption = (st: EngineState) =>
  st.pending!.options.reduce((m, o) => Math.max(m, Number(o.value)), 0);

console.log('=== 1. 出价上限 = 出价者自己的金钱 ===');
check('conflictBidMax 返回玩家当前金钱', () => {
  const { a, b } = duel(500, 80);
  assert.equal(conflictBidMax(a), 500);
  assert.equal(conflictBidMax(b), 80);
});
check('金钱为 0 时上限为 0（不会出负数）', () => {
  const { a } = duel(0, 100);
  assert.equal(conflictBidMax(a), 0);
});
check('挑战者可出到自己的全部金钱', () => {
  const { st, a } = duel(500, 80);
  assert.equal(st.pending!.playerId, a.id, '应先问挑战者');
  assert.ok(maxOption(st) <= 500, `选项不该超过 500，实际 ${maxOption(st)}`);
  assert.equal(maxOption(st), 500, `应能全押 500，实际 ${maxOption(st)}`);
  console.log(`      挑战者(金500) 最大可选 ${maxOption(st)}`);
});
check('对手只能出到**自己**的钱，而不是挑战者的', () => {
  const { st, a, b } = duel(500, 80);
  resolvePending(st, a.id, ['500']);          // 挑战者全押
  assert.equal(st.pending!.playerId, b.id, '应接着问对手');
  assert.equal(maxOption(st), 80, `对手(金80) 上限应是 80，实际 ${maxOption(st)}`);
  console.log(`      对手(金80) 最大可选 ${maxOption(st)}`);
});
check('提示语里的上限是该玩家自己的数额', () => {
  const { st, a, b } = duel(500, 80);
  assert.ok(st.pending!.prompt.includes('500'), `挑战者提示应含 500：${st.pending!.prompt}`);
  resolvePending(st, a.id, ['10']);
  assert.ok(st.pending!.prompt.includes('80'), `对手提示应含 80：${st.pending!.prompt}`);
  console.log(`      挑战者: ${st.pending?.prompt ?? ''}`);
});

console.log('\n=== 2. 超额的出价会被夹取 ===');
check('喊出超过自己金钱的价 → 夹到持有额', () => {
  const { st, a, b } = duel(100, 100);
  resolvePending(st, a.id, ['9999']);         // 挑战者喊 9999
  resolvePending(st, b.id, ['50']);           // 对手喊 50
  assert.ok(a.res.money >= 0, `金钱不该为负：${a.res.money}`);
  assert.equal(a.res.money, 0, `应被夹到 100 并全额支付，实际剩 ${a.res.money}`);
  console.log(`      喊 9999 → 实付 100，剩 ${a.res.money}`);
});
check('夹取后仍是出价高者获胜（不会因夹取改变胜负）', () => {
  const { st, a, b } = duel(100, 50);
  resolvePending(st, a.id, ['9999']);         // 夹到 100
  resolvePending(st, b.id, ['50']);
  assert.equal(b.inJail, true, '对手出价低，应被逮捕');
  assert.equal(a.inJail, false, '赢家留下');
});

console.log('\n=== 3. 结算 ===');
check('高者付款并留下，低者被捕', () => {
  const { st, a, b } = duel(500, 500);
  const before = a.res.money;
  resolvePending(st, a.id, ['100']);
  resolvePending(st, b.id, ['50']);
  assert.equal(before - a.res.money, 100, `赢家应付自己的出价，实际扣 ${before - a.res.money}`);
  assert.equal(b.inJail, true);
  console.log(`      赢家付 100，对手被捕`);
});
check('平局时罪恶较少者胜（交锋专属规则）', () => {
  const { st, a, b } = duel(500, 500, 0, 5);   // a 罪恶更少
  resolvePending(st, a.id, ['50']);
  resolvePending(st, b.id, ['50']);
  assert.equal(a.inJail, false, '罪恶少的 a 应留下');
  assert.equal(b.inJail, true, '罪恶多的 b 应被捕');
});
check('双方都出 0 时也走平局规则，不被卡住', () => {
  const { st, a, b } = duel(500, 500, 0, 3);
  const r1 = resolvePending(st, a.id, ['0']);
  assert.ok(r1.ok, '出价 0 应被接受');
  const r2 = resolvePending(st, b.id, ['0']);
  assert.ok(r2.ok, '对手出价 0 也应被接受');
  assert.equal(st.pending, undefined, '不该残留挂起');
  console.log(`      双方 0 价 → a.inJail=${a.inJail} b.inJail=${b.inJail}`);
});
check('出价上限不受对手金钱影响（对称性）', () => {
  const rich = duel(1000, 10);
  assert.equal(maxOption(rich.st), 1000, '富人应能出到 1000');
  resolvePending(rich.st, rich.a.id, ['10']);
  assert.equal(maxOption(rich.st), 10, '穷人只能出到 10，不该被富人的 1000 抬高');
});

console.log('\n=== 4. 不变量 ===');
check('任意出价都不会让金钱变成负数', () => {
  for (const [ma, mb, ba, bb] of [[100, 100, 9999, 0], [50, 500, 0, 9999],
    [0, 0, 100, 100], [30, 30, 30, 30]] as const) {
    const { st, a, b } = duel(ma, mb);
    resolvePending(st, a.id, [String(ba)]);
    if (st.pending) resolvePending(st, b.id, [String(bb)]);
    assert.ok(a.res.money >= 0, `a 金钱为负：${a.res.money}`);
    assert.ok(b.res.money >= 0, `b 金钱为负：${b.res.money}`);
  }
});
check('每次交锋恰好产生 1 名输家（除非双方都留下）', () => {
  const { st, a, b } = duel(500, 500);
  resolvePending(st, a.id, ['20']);
  if (st.pending) resolvePending(st, b.id, ['10']);
  const jailed = [a, b].filter((p) => p.inJail).length;
  assert.equal(jailed, 1, `应有 1 人入狱，实际 ${jailed}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
