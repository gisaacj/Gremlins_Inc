// =============================================================
// 对话框按钮（`BUTTON` 原语）测试
//
// 原版用一张牌里的两个 `BUTTON` 表达"两害取其轻"：
//
//   m020  BUTTON ["-$150"]   BUTTON ["-*2"]
//         OpponentLoseMoney  OpponentLoseScore
//
// 按钮文案有两形态：符号语法（`-$150`）与**十六进制 UIN**（`CACBE81C8D511C3D`
// → 十进制查文案 → 「丢弃」）。
//
// 运行: npx tsx src/__tests__/buttons.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  MISFORTUNE_CARDS, collectButtons, hasButton, parseButtonLabel, hexUinToText,
  createState, drawMisfortune, resolvePending, getPlayer, CHARACTERS,
} from '@gremlins/shared/engine';
import type { CardAction, EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const card = (name: string) => MISFORTUNE_CARDS.find((c) => c.name === name)!;

console.log('=== 1. 按钮文案解析 ===');
check('符号语法：-$150 → -150 金钱', () => {
  assert.equal(parseButtonLabel(['-$150', 'Money', '150']), '-150 金钱');
});
check('符号语法：+^4 → +4 罪恶', () => {
  assert.equal(parseButtonLabel(['+^4']), '+4 罪恶');
});
check('符号语法：-*2 → -2 齿轮', () => {
  assert.equal(parseButtonLabel(['-*2']), '-2 齿轮');
});
check('符号语法：-|10 → -10 收入', () => {
  assert.equal(parseButtonLabel(['-|10']), '-10 收入');
});
check('多段：+^5 +*1 → 两段都解析', () => {
  const s = parseButtonLabel(['+^5 +*1']);
  assert.ok(s.includes('+5 罪恶') && s.includes('+1 齿轮'), s);
});
check('十六进制 UIN 查文案：CACBE81C8D511C3D → 丢弃', () => {
  assert.equal(hexUinToText('CACBE81C8D511C3D'), '丢弃');
  assert.equal(parseButtonLabel(['CACBE81C8D511C3D']), '丢弃');
});
check('十六进制 UIN：AC3E7E3C1E938595 → 逮捕', () => {
  assert.equal(parseButtonLabel(['AC3E7E3C1E938595']), '逮捕');
});
check('十六进制 UIN：CC8701FF27D38C51 → 失去 $', () => {
  assert.equal(parseButtonLabel(['CC8701FF27D38C51']), '失去 $');
});
check('十六进制 UIN：AB77A99F79862F57 → 跳过走牌', () => {
  assert.equal(parseButtonLabel(['AB77A99F79862F57']), '跳过走牌');
});
check('空参数不崩，返回占位符', () => {
  assert.equal(parseButtonLabel([]), '…');
  assert.equal(parseButtonLabel(['']), '…');
});
check('未知十六进制 UIN 原样返回（便于排查）', () => {
  assert.equal(parseButtonLabel(['00000000000000FF']), '00000000000000FF');
});

console.log('\n=== 2. 按钮结构扫描 ===');
const btns020 = collectButtons(card('m020').actions);
check('m020 解析出 2 个按钮', () => {
  assert.equal(btns020.length, 2, `实际 ${btns020.length}`);
});
check('按钮 1：标签「-150 金钱」，分支是 OpponentLoseMoney', () => {
  assert.equal(btns020[0].label, '-150 金钱');
  assert.ok(btns020[0].actions.some((a) => a.type === 'OpponentLoseMoney'),
    JSON.stringify(btns020[0].actions));
});
check('按钮 2：标签「-2 齿轮」，分支是 OpponentLoseScore', () => {
  assert.equal(btns020[1].label, '-2 齿轮');
  assert.ok(btns020[1].actions.some((a) => a.type === 'OpponentLoseScore'),
    JSON.stringify(btns020[1].actions));
});
check('分支不重叠：按钮 1 的区间止于按钮 2 之前', () => {
  assert.ok(btns020[0].branchEnd <= btns020[1].branchStart, '区间应有序不重叠');
});
check('hasButton 判定正确', () => {
  assert.equal(hasButton(card('m020').actions), true);
  const plain = MISFORTUNE_CARDS.find((c) => !hasButton(c.actions));
  assert.ok(plain, '应存在不带 BUTTON 的厄运牌');
  assert.equal(hasButton(plain!.actions), false);
});
check('没有 BUTTON 时返回空数组', () => {
  assert.deepEqual(collectButtons([{ type: 'OpponentLoseMoney', params: ['1'] } as CardAction]), []);
});
check('单按钮（结构不完整）也能解析出 1 个', () => {
  const one = collectButtons([
    { type: 'BUTTON', params: ['-*1'] } as CardAction,
    { type: 'OpponentLoseScore', params: ['1'] } as CardAction,
  ]);
  assert.equal(one.length, 1);
});

console.log('\n=== 3. 全部厄运牌的按钮都能解析出可读文案 ===');
check('所有 BUTTON 标签都不是十六进制串（都能本地化）', () => {
  let n = 0;
  for (const c of MISFORTUNE_CARDS) {
    for (const b of collectButtons(c.actions)) {
      n++;
      assert.ok(
        !/^[0-9A-F]{16}$/.test(b.label),
        `${c.name} 的按钮文案未解析：${b.label} (raw=${JSON.stringify(b.raw)})`,
      );
    }
  }
  assert.equal(n, 20, `期望 20 个按钮，实际 ${n}`);
  console.log(`      ${n} 个按钮全部可读`);
});
check('按钮文案覆盖：列出全部 (牌, 标签)', () => {
  const seen: string[] = [];
  for (const c of MISFORTUNE_CARDS) {
    for (const b of collectButtons(c.actions)) seen.push(`${c.name}:${b.label}`);
  }
  for (const s of seen) console.log(`      ${s}`);
  assert.equal(seen.length, 20);
});

console.log('\n=== 4. 引擎行为：抽到带 BUTTON 的厄运牌必须挂起 ===');
/** 把厄运牌堆顶固定成指定卡，然后让 p0 抽厄运 */
function drawSpecific(seed: number, cardName: string): { st: EngineState; p0: string } {
  const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;
  const st = createState({
    roomId: 'btn', seed, targetScore: 30,
    players: [
      { id: 'p0', name: 'P0', isAI: false, characterId: charOf('Banker') },
      { id: 'p1', name: 'P1', isAI: false, characterId: charOf('Engineer') },
    ],
  });
  // 厄运牌堆是 pop() 取的 → 目标卡放末尾
  const target = MISFORTUNE_CARDS.find((c) => c.name === cardName)!;
  st.misfortuneDeck = [target.id];
  drawMisfortune(st, getPlayer(st, 'p0')!);
  return { st, p0: 'p0' };
}

check('m020 抽到后挂起，且给出 2 个按钮', () => {
  const { st } = drawSpecific(1234, 'm020');
  assert.ok(st.pending, '带 BUTTON 的厄运牌应挂起（之前会静默跳过）');
  assert.equal(st.pending!.options.length, 2, JSON.stringify(st.pending!.options));
  const labels = st.pending!.options.map((o) => o.label);
  assert.ok(labels.includes('-150 金钱'), `实际 ${labels.join(' / ')}`);
  assert.ok(labels.includes('-2 齿轮'), `实际 ${labels.join(' / ')}`);
  console.log(`      挂起选项：${labels.join(' / ')}`);
});
check('选「-2 齿轮」分支：扣齿轮不扣钱', () => {
  const { st, p0 } = drawSpecific(1234, 'm020');
  const p = getPlayer(st, p0)!;
  p.res.score = 5;
  p.res.money = 500;
  const before = { score: p.res.score, money: p.res.money };
  const r = resolvePending(st, p0, ['1']); // 索引 1 = 第二个按钮
  assert.ok(r.ok, r.reason);
  assert.equal(p.res.score, before.score - 2, `齿轮应 -2，实际 ${before.score} → ${p.res.score}`);
  assert.equal(p.res.money, before.money, '选齿轮分支不该扣钱');
  assert.equal(st.pending, undefined, '决策应已消费');
});
check('选「-150 金钱」分支：扣钱不扣齿轮', () => {
  const { st, p0 } = drawSpecific(1234, 'm020');
  const p = getPlayer(st, p0)!;
  p.res.score = 5;
  p.res.money = 500;
  const before = { score: p.res.score, money: p.res.money };
  const r = resolvePending(st, p0, ['0']);
  assert.ok(r.ok, r.reason);
  assert.equal(p.res.money, before.money - 150, `金钱应 -150，实际 ${before.money} → ${p.res.money}`);
  assert.equal(p.res.score, before.score, '选金钱分支不该扣齿轮');
});
check('分支只生效一次（不会两条都结算）', () => {
  const { st, p0 } = drawSpecific(1234, 'm020');
  const p = getPlayer(st, p0)!;
  p.res.score = 10;
  p.res.money = 500;
  resolvePending(st, p0, ['0']);
  const after = { score: p.res.score, money: p.res.money };
  // 再调一次不应重复扣
  if (st.pending) resolvePending(st, p0, ['0']);
  assert.equal(p.res.money, after.money, '不应重复扣钱');
  assert.equal(p.res.score, after.score, '不应重复扣齿轮');
});
check('不带 BUTTON 的厄运牌不挂起（行为未变）', () => {
  const plain = MISFORTUNE_CARDS.find((c) => !hasButton(c.actions)
    && c.actions.length > 0
    && !c.actions.some((a) => String(a.type).startsWith('Select')));
  assert.ok(plain, '应存在可直接结算的厄运牌');
  const { st } = drawSpecific(4321, plain!.name);
  assert.equal(st.pending, undefined, `${plain!.name} 不该挂起：${JSON.stringify(plain!.actions)}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
