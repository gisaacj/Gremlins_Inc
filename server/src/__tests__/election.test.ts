// =============================================================
// 选举（镇长）判定测试 —— **依据是选票，不是罪恶**
//
// 这条规则我曾在会话记录里写错过（写成"罪恶最低者获胜，ELECTION_SCORE_BONUS
// 未使用"），用户指出后回源码逐行核对，确认**用户是对的**：
//
// ```csharp
// // CAvatarForm.CheckVotesMedal()
// dictionary.Add(player.PlayerID, player.Resources.Vote);      // ← 基数是选票
// int num = max(Resources.Vote);                               // ← 最高票
// ...
// if (player.Resources.Malice == minMalice)                    // ← 罪恶只决定谁拿加成
//     dictionary[player.PlayerID] += CD.Game.ELECTION_VOTE_BONUS;
// ```
//
// 所以：**票数最高者当选**；"罪恶最低"只是给那人**额外加 3 票**。
// 极端例子：甲 10 票 / 罪恶 5，乙 1 票 / 罪恶 0 → 乙得 1+3=4 票，
// **甲仍以 10 票当选**。
//
// 加成来源两处：
//  1. 罪恶最低者 +3 票（`ELECTION_VOTE_BONUS`）；**全员罪恶相同则无人获得**
//     （`minMaliceAll` 分支）。
//  2. 政治家「议会人脉」`Politician_Connections` +N 票。
//     `GetCharacterAbilityParam(EAction.Politician_Connections, 2, 2)`
//     → 第二参是**默认值**，第三参才是 `ActionParams` 下标，所以默认 2。
//
// 平局（源码 `CAvatarForm` 640-659 的精确顺序）：
//  先按最高票收集 `list` → **再**用"罪恶最低"过滤 → 若过滤后仍**包含全部玩家**
//  则无人当选（源码判据 `list.Count < CD.Game.Players.Count`）。
//  ⚠️ 这是**过滤之后**的比较，不要用过滤前的长度判断。
//
// 运行: npx tsx server/src/__tests__/election.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { GAME_CONST } from '@gremlins/shared/gamedata';
import {
  CHARACTERS, createState, getPlayer, runElection,
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
    roomId: 'el', seed: 7, targetScore: 100,       // 目标拉高，避免齿轮达标干扰
    players: names.map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
}

/** 设置各玩家的票/罪（按 id 顺序 P0,P1,...） */
function setVotes(st: EngineState, rows: Array<[vote: number, malice: number]>) {
  rows.forEach(([vote, malice], i) => {
    const p = getPlayer(st, `P${i}`)!;
    p.res.vote = vote;
    p.res.malice = malice;
  });
}

console.log('=== 1. 常量 ===');
check('ELECTION_VOTE_BONUS = 3（原版 GConst）', () => {
  assert.equal(GAME_CONST['ELECTION_VOTE_BONUS'], 3, `实际 ${GAME_CONST['ELECTION_VOTE_BONUS']}`);
  console.log(`      基数是"选票"，加成 ${GAME_CONST['ELECTION_VOTE_BONUS']} 票`);
});

console.log('\n=== 2. 核心：按**选票**判定，不是按罪恶 ===');
check('票多者当选，即使他不是罪恶最低的', () => {
  const st = game(['Banker', 'Engineer', 'Thief']);
  // P0 票最多但罪恶最高；P1 罪恶最低但票很少
  setVotes(st, [[10, 5], [1, 0], [2, 3]]);
  runElection(st);
  assert.equal(st.mayorId, 'P0',
    `应选票多的 P0；若"按罪恶判定"会错选 P1。实际 ${st.mayorId}`);
  console.log(`      P0 票10/罪5，P1 票1/罪0(+3=4) → P0 当选`);
});
check('加成足以反超时，罪恶最低者才会赢', () => {
  const st = game(['Banker', 'Engineer', 'Thief']);
  // P0 4 票；P1 2 票 + 3 = 5 → 反超
  setVotes(st, [[4, 5], [2, 0], [0, 9]]);
  runElection(st);
  assert.equal(st.mayorId, 'P1', `应 P1（2+3=5 > 4）。实际 ${st.mayorId}`);
  console.log(`      P0 票4，P1 票2+3=5 → P1 当选`);
});
check('当选者就职 +1 齿轮', () => {
  const st = game(['Banker', 'Engineer']);
  setVotes(st, [[9, 0], [1, 5]]);
  const before = getPlayer(st, 'P0')!.res.score;
  runElection(st);
  assert.equal(getPlayer(st, 'P0')!.res.score, before + 1, '应 +1 齿轮');
});
check('当选后镇长 id 被设置，并排定下届选举轮次', () => {
  const st = game(['Banker', 'Engineer']);
  setVotes(st, [[9, 0], [1, 5]]);
  const beforeRound = st.nextElectionRound;
  runElection(st);
  assert.equal(st.mayorId, 'P0');
  assert.ok(st.nextElectionRound > beforeRound, `下届应为将来轮次：${beforeRound} → ${st.nextElectionRound}`);
});

console.log('\n=== 3. 罪恶加成的边界 ===');
check('全员罪恶相同 → **无人**获得 +3（minMaliceAll）', () => {
  const st = game(['Banker', 'Engineer', 'Thief']);
  // 全员罪恶都是 4 → 谁都不加 3
  setVotes(st, [[2, 4], [5, 4], [1, 4]]);
  runElection(st);
  assert.equal(st.mayorId, 'P1', `应纯按票数 P1（5 票）。实际 ${st.mayorId}`);
  console.log(`      全员罪4：票2/票5/票1 → P1 当选（无加成）`);
});
check('多人并列罪恶最低时，各自都拿 +3', () => {
  const st = game(['Banker', 'Engineer', 'Thief']);
  // P0/P1 罪恶都是最低 0 → 都 +3；P2 票虽多但只多 2 票，会被反超
  //   P0: 2+3=5   P1: 1+3=4   P2: 4（罪7，无加成） → P0 当选
  setVotes(st, [[2, 0], [1, 0], [4, 7]]);
  runElection(st);
  assert.equal(st.mayorId, 'P0', `两人都 +3 后 P0（5）应超过 P2（4）。实际 ${st.mayorId}`);
  console.log(`      罪0 的 P0(2+3=5) 与 P1(1+3=4) vs P2(4) → P0`);
});

console.log('\n=== 4. 平局 ===');
check('全员票数与罪恶皆相同 → 无人当选', () => {
  const st = game(['Banker', 'Engineer']);
  setVotes(st, [[3, 1], [3, 1]]);
  runElection(st);
  assert.equal(st.mayorId, undefined,
    `全员并列时不应产生镇长。实际 ${st.mayorId}`);
  console.log(`      全员票3/罪1 → 无人当选`);
});
check('两人票并列但罪恶不同 → 罪恶较低者当选（**过滤后**才判全员并列）', () => {
  const st = game(['Banker', 'Engineer']);
  setVotes(st, [[5, 4], [5, 1]]);
  runElection(st);
  assert.equal(st.mayorId, 'P1', `罪恶较低的 P1 应当选。实际 ${st.mayorId}`);
  console.log(`      票5/罪4 vs 票5/罪1 → P1`);
});
check('三人中两人并列最高票 → 取罪恶较低者', () => {
  const st = game(['Banker', 'Engineer', 'Thief']);
  setVotes(st, [[7, 6], [7, 2], [1, 0]]);
  runElection(st);
  assert.equal(st.mayorId, 'P1', `实际 ${st.mayorId}`);
  console.log(`      票7/罪6 与 票7/罪2 → P1（罪低）`);
});
check('无人当选时不加齿轮、不改镇长', () => {
  const st = game(['Banker', 'Engineer']);
  setVotes(st, [[3, 1], [3, 1]]);
  st.mayorId = 'P1';                       // 已有镇长
  const before = getPlayer(st, 'P0')!.res.score;
  runElection(st);
  assert.equal(st.mayorId, 'P1', '无人当选时镇长应保持不变');
  assert.equal(getPlayer(st, 'P0')!.res.score, before, '不该加齿轮');
});

console.log('\n=== 5. 政治家「议会人脉」加成 ===');
check('政治家在票数相同时靠人脉加成获胜', () => {
  const st = game(['Politician', 'Banker']);
  // 同罪恶（都非最低不成立）——这里让两人罪恶相同，避免 +3 干扰
  setVotes(st, [[3, 9], [3, 9]]);
  runElection(st);
  // 全员罪恶相同 → 无人 +3；政治家 +2 人脉 → P0 5 > P1 3
  assert.equal(st.mayorId, 'P0', `政治家应靠人脉胜出。实际 ${st.mayorId}`);
  console.log(`      同票3/同罪9：政治家 +2 人脉 → P0`);
});
check('非政治家没有人脉加成', () => {
  const st = game(['Banker', 'Engineer']);
  setVotes(st, [[3, 9], [3, 9]]);
  runElection(st);
  assert.equal(st.mayorId, undefined, `非政治家不应有额外票。实际 ${st.mayorId}`);
});
check('人脉加成可以把政治家从落后拉到领先', () => {
  const st = game(['Politician', 'Banker']);
  setVotes(st, [[2, 9], [3, 9]]);   // 政治家少 1 票
  runElection(st);
  assert.equal(st.mayorId, 'P0', `2+2=4 > 3。实际 ${st.mayorId}`);
  console.log(`      政治家 2+2 人脉 = 4 > 3 → 当选`);
});

console.log('\n=== 6. 不变量 ===');
check('选举不会修改任何人的选票', () => {
  const st = game(['Banker', 'Engineer', 'Thief']);
  setVotes(st, [[5, 0], [3, 2], [1, 9]]);
  const before = st.players.map((p) => p.res.vote);
  runElection(st);
  assert.deepEqual(st.players.map((p) => p.res.vote), before, '选票不应被改动');
});
check('选举不会让齿轮变负或凭空多给', () => {
  for (const rows of [[[1, 0], [0, 0]], [[0, 5], [0, 1]], [[2, 0], [2, 0]]] as const) {
    const st = game(['Banker', 'Engineer']);
    setVotes(st, rows as never);
    // ⚠️ 起始齿轮不一定是 0：角色被动可能在开局就 +1（如「原型试样」）。
    // 所以这里比较**增量**，而不是绝对值。
    const before = st.players.reduce((s, p) => s + p.res.score, 0);
    runElection(st);
    const after = st.players.reduce((s, p) => s + p.res.score, 0);
    for (const p of st.players) {
      assert.ok(p.res.score >= 0, `${p.name} 齿轮为负`);
    }
    assert.ok(after - before <= 1, `一次选举最多发 1 个齿轮，实际 +${after - before}`);
  }
});
check('多次选举都能正常结算（不残留状态）', () => {
  const st = game(['Banker', 'Engineer', 'Thief']);
  for (let i = 0; i < 5; i++) {
    setVotes(st, [[i + 3, 0], [1, 5], [0, 9]]);
    st.round = 10 + i * 20;
    st.nextElectionRound = st.round;
    runElection(st);
    assert.equal(st.mayorId, 'P0', `第 ${i + 1} 次选举应 P0`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
