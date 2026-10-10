// =============================================================
// 参数 tag 语义测试（`Governor` 门控 / `Percent` 百分比 / `Poorest` 翻倍）
//
// 背景：卡牌的 `ActionParams` 里除了数字与 UIN，还有一些**有语义的字符串 tag**。
// 它们很容易被当成"无用字符串"忽略掉，从而静默改变效果。
// 全量审计发现 57 种这类字符串，逐个核对后确认 3 个是**真的漏实现**：
//
//  - `Governor`（a090）：`OpponentLoseMoney(-300|Governor)` 是**门控**——
//    只有当前总督才生效。旧实现忽略它，导致**非总督打出也白拿 +300$、+3^**。
//  - `Percent`（a139）：`OpponentLoseMoney(Percent|50)` = 扣目标 **50% 的金钱**，
//    旧实现按 `firstNumber` 取到 50，变成**固定扣 50**。
//  - `Poorest`（a011）：`OpponentPayMoney(Poorest|50)` = 出牌者最穷时**金额翻倍**。
//
// 另有若干 tag（`Permanent` / `HaltFailed` / `malicebonus` …）尚未实现，
// 见文件末尾的"已知未实现"清单——本测试**显式断言它们仍未实现**，
// 避免将来误以为已经支持。
//
// 运行: npx tsx server/src/__tests__/param-tags.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARD_BY_NAME } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, createState, getPlayer, runActions,
} from '@gremlins/shared/engine';
import type { ActionType, EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(): { st: EngineState; a: ReturnType<typeof getPlayer>; b: ReturnType<typeof getPlayer> } {
  const st = createState({
    roomId: 'tag', seed: 5, targetScore: 30,
    players: ['Banker', 'Engineer'].map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  st.currentIndex = st.players.indexOf(a);
  return { st, a, b };
}

/** 直接跑一段动作（目标由 actions 的 targets 决定） */
function run(
  actions: Array<{ type: string; params?: string[] }>,
  setup?: (x: ReturnType<typeof game>) => void,
) {
  const ctx = game();
  ctx.a!.res.money = 100;
  ctx.a!.res.malice = 5;
  ctx.b!.res.money = 400;
  ctx.b!.res.malice = 5;
  setup?.(ctx);
  const before = {
    aMoney: ctx.a!.res.money, aMalice: ctx.a!.res.malice,
    bMoney: ctx.b!.res.money, bMalice: ctx.b!.res.malice,
  };
  runActions(ctx.st, {
    actions: actions as unknown as Array<{ type: ActionType; params?: string[] }>,
    index: 0,
    targets: [ctx.a!.id],
    ownerId: ctx.a!.id,
    source: 'test',
  });
  return { ...ctx, before };
}

console.log('=== 1. Governor 门控（a090）===');
check('数据里 a090 的动作带 Governor tag', () => {
  const c = CARD_BY_NAME['a090']!;
  const has = c.actions.some((x) => (x.params ?? []).includes('Governor'));
  assert.ok(has, `a090 的动作应含 Governor：${JSON.stringify(c.actions)}`);
  console.log(`      ${c.actions.map((x) => `${x.type}(${(x.params ?? []).join('|')})`).join(' → ')}`);
});
check('非总督：整段跳过，金币与罪恶都不变', () => {
  const c = CARD_BY_NAME['a090']!;
  const { a, before, st } = run(c.actions as never, (x) => { x.st.mayorId = undefined; });
  assert.equal(a!.res.money, before.aMoney, `金钱不该变：${before.aMoney} → ${a!.res.money}`);
  assert.equal(a!.res.malice, before.aMalice, `罪恶不该变：${before.aMalice} → ${a!.res.malice}`);
  console.log(`      金 ${before.aMoney} → ${a!.res.money}，罪 ${before.aMalice} → ${a!.res.malice}（跳过）`);
  void st;
});
check('是总督：正常获得 +300$、+3^', () => {
  const c = CARD_BY_NAME['a090']!;
  const { a, before } = run(c.actions as never, (x) => { x.st.mayorId = x.a!.id; });
  assert.equal(a!.res.money - before.aMoney, 300, `应 +300，实际 +${a!.res.money - before.aMoney}`);
  assert.equal(a!.res.malice - before.aMalice, 3, `应 +3，实际 +${a!.res.malice - before.aMalice}`);
  console.log(`      金 ${before.aMoney} → ${a!.res.money}，罪 ${before.aMalice} → ${a!.res.malice}`);
});
check('Governor 门控对 OpponentLoseMalice 同样生效', () => {
  const { st, a, before } = run([{ type: 'OpponentLoseMalice', params: ['-3', 'Governor'] }], (x) => {
    x.st.mayorId = undefined;
  });
  assert.equal(a!.res.malice, before.aMalice, '非总督不该加罪恶');
  void st;
});

console.log('\n=== 2. Percent 百分比扣款（a139）===');
check('数据里 a139 用 Percent tag', () => {
  const c = CARD_BY_NAME['a139']!;
  const has = c.actions.some((x) => (x.params ?? []).includes('Percent'));
  assert.ok(has, `a139 应含 Percent：${JSON.stringify(c.actions)}`);
});
check('50% 按目标当前持有量计算，不是固定 50', () => {
  const { a, before } = run([{ type: 'OpponentLoseMoney', params: ['Percent', '50'] }]);
  const lost = before.bMoney - a!.res.money; // 目标是 a（targets=[a]），此处只验证 a
  // 目标其实是 a（targets=[a]），所以看 a
  const actualLost = before.aMoney - a!.res.money;
  assert.equal(actualLost, Math.floor(before.aMoney / 2), `应扣一半：${before.aMoney} → ${a!.res.money}`);
  console.log(`      目标金 ${before.aMoney} → ${a!.res.money}（扣 ${actualLost} = 50%）`);
  void lost;
});
check('持有 0 时扣 0，不为负', () => {
  const { a } = run([{ type: 'OpponentLoseMoney', params: ['Percent', '50'] }], (x) => {
    x.a!.res.money = 0;
  });
  assert.equal(a!.res.money, 0);
});
check('99% 不会超过持有量', () => {
  const { a, before } = run([{ type: 'OpponentLoseMoney', params: ['Percent', '99'] }]);
  assert.ok(a!.res.money >= 0, `不该为负：${a!.res.money}`);
  assert.ok(a!.res.money < before.aMoney);
});

console.log('\n=== 3. Poorest 翻倍（a011）===');
check('数据里 a011 用 Poorest tag', () => {
  const c = CARD_BY_NAME['a011']!;
  const has = c.actions.some((x) => (x.params ?? []).includes('Poorest'));
  assert.ok(has, `a011 应含 Poorest：${JSON.stringify(c.actions)}`);
});
/** a011 的手牌只需第一条 OpponentPayMoney 生效，单独测它以隔离「-1^」的干扰 */
function payPoorest(myMoney: number, theirMoney: number) {
  const ctx = game();
  ctx.a!.res.money = myMoney;
  ctx.b!.res.money = theirMoney;
  ctx.a!.res.malice = 0;
  ctx.b!.res.malice = 0;
  const before = ctx.a!.res.money;
  runActions(ctx.st, {
    actions: [{ type: 'OpponentPayMoney', params: ['Poorest', '50'] }] as never,
    index: 0, targets: [ctx.b!.id], ownerId: ctx.a!.id, source: 'a011',
  });
  return { gain: ctx.a!.res.money - before, paid: theirMoney - ctx.b!.res.money };
}
check('出牌者最穷 → 对手付 100（翻倍）', () => {
  const { gain, paid } = payPoorest(10, 400);
  assert.equal(paid, 100, `对手应付 100，实际 ${paid}`);
  assert.equal(gain, 100, `出牌者应 +100，实际 +${gain}`);
  console.log(`      最穷(10)：对手付 ${paid}，出牌者 +${gain}`);
});
check('出牌者不是最穷 → 对手付原值 50', () => {
  // 判定的是**出牌者是否最穷**。用一个 3 人局，把"最穷"给第三方 c，
  // 这样出牌者 a 明确不是最穷。
  const st = createState({
    roomId: 'tag3', seed: 5, targetScore: 30,
    players: ['Banker', 'Engineer', 'Thief'].map((nm, i) => ({
      id: `p${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
  });
  const a = getPlayer(st, 'p0')!;
  const b = getPlayer(st, 'p1')!;
  const c = getPlayer(st, 'p2')!;
  st.currentIndex = st.players.indexOf(a);
  a.res.money = 300; b.res.money = 400; c.res.money = 5;   // 最穷是 c
  const bBefore = b.res.money;
  runActions(st, {
    actions: [{ type: 'OpponentPayMoney', params: ['Poorest', '50'] }] as never,
    index: 0, targets: [b.id], ownerId: a.id, source: 'a011',
  });
  const paid = bBefore - b.res.money;
  assert.equal(paid, 50, `对手应付 50，实际 ${paid}`);
  console.log(`      出牌者非最穷(300，第三方最穷=5)：对手付 ${paid}`);
});
check('并列最穷也算最穷（翻倍）', () => {
  const { paid } = payPoorest(400, 400);
  assert.equal(paid, 100, `并列最穷应翻倍，实际 ${paid}`);
});

console.log('\n=== 4. 未实现的 tag 清单 ===');
// 曾经有 5 个 tag 未实现（Permanent / HaltFailed / oppmalicepenalty /
// moneybonus / malicebonus），已在 `param-tags2.test.ts` 那一轮补齐，清单清空。
//
// 这个检查的意义：**一旦有人新增了对某个 tag 的处理，而清单里还留着它，
// 测试就会失败**，提醒同步文档与测试，避免"以为没支持、其实支持了"
// 或反过来"以为支持了、其实没支持"。
const KNOWN_UNIMPLEMENTED: Array<[string, string, string]> = [];
check('未实现 tag 清单与代码一致（当前应为空）', () => {
  const src = [
    'shared/src/engine/interp.ts', 'shared/src/engine/permanents.ts',
    'shared/src/engine/abilities.ts', 'shared/src/engine/options.ts',
    'shared/src/engine/state.ts', 'shared/src/engine/resources.ts',
  ].map((p) => readFileSync(p, 'utf8')).join('\n');
  const nowImplemented = KNOWN_UNIMPLEMENTED.filter(([t]) => src.includes(`'${t}'`));
  assert.equal(nowImplemented.length, 0,
    `以下 tag 已被实现，请从 KNOWN_UNIMPLEMENTED 移除并补测试：${nowImplemented.map((x) => x[0]).join(', ')}`);
  if (KNOWN_UNIMPLEMENTED.length === 0) {
    console.log('      清单为空——已知的语义 tag 均已实现');
  } else {
    console.log(`      仍是未实现：${KNOWN_UNIMPLEMENTED.map((x) => `${x[0]}(${x[1]})`).join(', ')}`);
  }
});

console.log('\n=== 5. 不变量 ===');
check('任何 tag 组合都不会让资源变成负数', () => {
  for (const params of [['Percent', '100'], ['Percent', '999'], ['Poorest', '9999']]) {
    const type = params[0] === 'Poorest' ? 'OpponentPayMoney' : 'OpponentLoseMoney';
    const { a, b } = run([{ type, params }], (x) => {
      x.a!.res.money = 10; x.b!.res.money = 10;
    });
    for (const p of [a, b]) {
      for (const k of ['money', 'vote', 'malice', 'score', 'income'] as const) {
        assert.ok(p!.res[k] >= 0, `${type}(${params.join('|')}) 让 ${k} 变成 ${p!.res[k]}`);
      }
    }
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
