// =============================================================
// 贿赂计算测试（含「呼吸税」—— 第 16 轮补完的最后一条规则缺口）
//
// 原版 `GPlayer.GetBribe()`（GPlayer.cs:1136-1169）：
// ```csharp
// num = /* 基础值 */;
// if (CharPerks && 角色名=="Homeless")
//     num = GetCharacterAbilityParam(Homeless_Smooth_Sailing, num/2, 2);
// if (CharPerks && 角色名=="Judge")
//     num += Malice / GetCharacterAbilityParam(Judge_Servant_Of_Justice, 2, 3)
//                * GetCharacterAbilityParam(Judge_Servant_Of_Justice, 1, 2);
// else
//     num += Malice;
// foreach (GPlayer gp in Players.Values)
//     if (gp.Governor) {
//         if (角色名=="Politician" && 有 Politician_Breathing_Tax)
//             num += GetCharacterAbilityParam(Politician_Breathing_Tax, 5, 2);
//         break;   // ← 只加一次，且条件是"**镇长**是不是政治家"
//     }
// foreach (上述以外每位 Perm_Bribe 持有者)
//     num += 其 Perm_Bribe 数量;
// ```
// 
// 参数索引：`GetCharacterAbilityParam(_, default, N)` 取 `ActionParams[N]`，
// 而导出到 `AbilitySpec.nums` 时**从 ActionParams[2] 起**，
// 所以 `nums[0] == ActionParams[2]`。
// 
// 运行: npx tsx server/src/__tests__/bribe.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  CHARACTERS, bribeAmount, bribeModifier, breathingTaxFrom, createState, getPlayer,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(names: string[]): EngineState {
  return createState({
    roomId: 'bribe', seed: 3, targetScore: 999,
    players: names.map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
}

/** 设各玩家的罪恶与金钱 */
function setMalice(st: EngineState, rows: number[]) {
  rows.forEach((m, i) => { getPlayer(st, `P${i}`)!.res.malice = m; });
}

console.log('=== 1. 基础贿赂 = 20 + 罪恶 ===');
check('无修正角色：20 + 罪恶', () => {
  const st = game(['Banker', 'Engineer']);
  setMalice(st, [0, 7]);
  assert.equal(bribeAmount(st, getPlayer(st, 'P0')!), 20);
  assert.equal(bribeAmount(st, getPlayer(st, 'P1')!), 27);
  console.log(`      罪0 → 20；罪7 → 27`);
});
check('贿赂不为负', () => {
  const st = game(['Banker', 'Engineer']);
  setMalice(st, [0, 0]);
  for (const p of st.players) assert.ok(bribeAmount(st, p) >= 0);
});

console.log('\n=== 2. 法官「正义之士」：每 2 点罪恶 +1 ===');
check('Judge 的贿赂按 ceil 折算（每 2 点 +1）', () => {
  const st = game(['Judge', 'Banker']);
  // nums = [1, 2] → perMalice = 1/2
  const mod = bribeModifier(getPlayer(st, 'P0')!);
  assert.equal(mod.perMalice, 0.5, `实际 ${mod.perMalice}`);
  setMalice(st, [4, 4]);
  // Judge: 20 + floor(4 * 0.5) = 22；Banker: 20 + 4 = 24
  assert.equal(bribeAmount(st, getPlayer(st, 'P0')!), 22);
  assert.equal(bribeAmount(st, getPlayer(st, 'P1')!), 24);
  console.log(`      罪4：法官 22 vs 普通人 24`);
});
check('法官的削弱比"每点+1"更便宜', () => {
  const st = game(['Judge', 'Banker']);
  setMalice(st, [10, 10]);
  const judge = bribeAmount(st, getPlayer(st, 'P0')!);
  const normal = bribeAmount(st, getPlayer(st, 'P1')!);
  assert.ok(judge < normal, `法官(${judge}) 应低于普通(${normal})`);
  console.log(`      罪10：法官 ${judge} vs 普通 ${normal}`);
});

console.log('\n=== 3. 乞丐「一帆风顺」：基数换成 5 ===');
check('基数变 5（而非 20）', () => {
  const st = game(['Homeless', 'Banker']);
  setMalice(st, [0, 0]);
  assert.equal(bribeAmount(st, getPlayer(st, 'P0')!), 5);
  assert.equal(bribeAmount(st, getPlayer(st, 'P1')!), 20);
  console.log(`      乞丐 5 vs 普通 20`);
});
check('基数变了但罪恶仍按 +1 累加', () => {
  const st = game(['Homeless', 'Banker']);
  setMalice(st, [6, 6]);
  assert.equal(bribeAmount(st, getPlayer(st, 'P0')!), 11, '5 + 6');
  console.log(`      罪6：乞丐 11 = 5 + 6`);
});

console.log('\n=== 4. 政治家「呼吸税」：镇长是政治家 → **全场** +5 ===');
check('没有镇长 → 不加', () => {
  const st = game(['Politician', 'Banker']);
  st.mayorId = undefined;
  setMalice(st, [0, 0]);
  assert.equal(breathingTaxFrom(st), 0);
  assert.equal(bribeAmount(st, getPlayer(st, 'P0')!), 20);
});
check('镇长是政治家 → 加成生效', () => {
  const st = game(['Politician', 'Banker']);
  st.mayorId = 'P0';
  setMalice(st, [0, 0]);
  assert.equal(breathingTaxFrom(st), 5, `实际 ${breathingTaxFrom(st)}`);
  console.log(`      呼吸税 = ${breathingTaxFrom(st)}`);
});
check('加成作用于**所有人**，不只镇长自己', () => {
  const st = game(['Politician', 'Banker']);
  st.mayorId = 'P0';
  setMalice(st, [0, 0]);
  assert.equal(bribeAmount(st, getPlayer(st, 'P0')!), 25, '镇长本人 20+5');
  assert.equal(bribeAmount(st, getPlayer(st, 'P1')!), 25, '其他人也是 20+5');
  console.log(`      两人都是 25（依据：原版按"镇长是不是政治家"判定，与算谁的贿赂无关）`);
});
check('镇长是**非**政治家 → 不加（哪怕场上有政治家）', () => {
  const st = game(['Banker', 'Politician']);
  st.mayorId = 'P0';                       // 镇长是 Banker
  setMalice(st, [0, 0]);
  assert.equal(breathingTaxFrom(st), 0);
  assert.equal(bribeAmount(st, getPlayer(st, 'P1')!), 20, '场上有政治家但没当镇长 → 不加');
  console.log(`      镇长是银行家 → 无加成`);
});
check('只加一次（不会因多个政治家重复叠加）', () => {
  const st = game(['Politician', 'Politician']);
  st.mayorId = 'P0';
  setMalice(st, [0, 0]);
  assert.equal(breathingTaxFrom(st), 5, '原版遍历到镇长就 break，最多一次');
  assert.equal(bribeAmount(st, getPlayer(st, 'P1')!), 25, '不该是 30');
  console.log(`      两名政治家，镇长 P0 → 仍是 +5（25 而非 30）`);
});

console.log('\n=== 5. 叠加 ===');
check('乞丐+呼吸税：5 + 罪恶 + 5', () => {
  const st = game(['Homeless', 'Politician']);
  st.mayorId = 'P1';
  setMalice(st, [3, 3]);
  // 乞丐: 5 + 3 + 5(呼吸税) = 13
  assert.equal(bribeAmount(st, getPlayer(st, 'P0')!), 13);
  console.log(`      乞丐罪3 → 13 = 5 + 3 + 5`);
});
check('法官+呼吸税：20 + floor(罪/2) + 5', () => {
  const st = game(['Judge', 'Politician']);
  st.mayorId = 'P1';
  setMalice(st, [4, 0]);
  // 法官: 20 + floor(4*0.5) + 5 = 27
  assert.equal(bribeAmount(st, getPlayer(st, 'P0')!), 27);
  console.log(`      法官罪4 → 27 = 20 + 2 + 5`);
});

console.log('\n=== 6. 警察格用单倍贿赂（与停留贿赂格的双倍区分）===');
check('警察格贿赂 = bribeAmount（单倍），不是双倍', () => {
  const st = game(['Banker', 'Engineer']);
  setMalice(st, [5, 0]);
  const single = bribeAmount(st, getPlayer(st, 'P0')!);
  assert.equal(single, 25, '20 + 5');
  // 停留贿赂格的双倍由调用方乘 2；这里只确认基数语义
  console.log(`      单倍 ${single}（停留贿赂格会由调用方 ×2 = ${single * 2}）`);
});

console.log('\n=== 7. 不变量 ===');
check('任何组合下贿赂都 ≥ 0', () => {
  for (const names of [['Banker', 'Engineer'], ['Judge', 'Homeless'],
    ['Politician', 'Judge'], ['Homeless', 'Homeless']]) {
    const st = game(names);
    for (const mayor of [undefined, 'P0', 'P1']) {
      st.mayorId = mayor;
      for (let m = 0; m <= 20; m += 5) {
        setMalice(st, [m, m]);
        for (const p of st.players) {
          const v = bribeAmount(st, p);
          assert.ok(Number.isFinite(v) && v >= 0, `${names}/${mayor}/罪${m} → ${v}`);
        }
      }
    }
  }
});
check('呼吸税条目已登记进 Politician 能力表', () => {
  const st = game(['Politician', 'Banker']);
  st.mayorId = 'P0';
  assert.equal(breathingTaxFrom(st), 5,
    '若返回 0，说明 Politician_Breathing_Tax 没登记进 CHARACTER_ABILITIES');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
