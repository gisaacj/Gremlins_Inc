// =============================================================
// 传送类卡牌的回归测试（用户第五批问题）
//
//  bug D：a024「翻筋斗」应只传送到**任意赌博站点**，实际却给出全部地点
//  bug E：`OpponentTeleport` 把玩家的位置写成了**格子类型 key**，
//         一个不存在的"格子"（a163「审判日」/ a096 会触发）
//  bug F：地狱格效果搞反了（应"弃光手牌+重抽，+100 金钱、+1 罪恶"）
//
// 运行: npx tsx server/src/__tests__/teleport.test.ts
// =============================================================
import assert from 'node:assert/strict';
import { ACTION_CARDS, CARD_BY_NAME } from '@gremlins/shared/gamedata';
import { displayCardRules } from '@gremlins/shared';
import {
  CHARACTERS, answerChoice, buildEnginePrompt, createState, getMap, getPlayer,
  playCard, runAIPlayers, teleportTargetCells,
} from '@gremlins/shared/engine';
import type { EngineState } from '@gremlins/shared/engine';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

const charOf = (n: string) => CHARACTERS.find((c) => c.name === n)!.id;

function game(names = ['Banker', 'Engineer']): EngineState {
  const st: EngineState = createState({
    roomId: 'tp', seed: 1, targetScore: 999,
    players: names.map((nm, i) => ({
      id: `P${i}`, name: `P${i}`, isAI: false, characterId: charOf(nm),
    })),
    chaosEnabled: false,
  });
  for (const p of st.players) {
    p.res.money = 5000; p.res.vote = 10; p.hand = []; p.inJail = false;
  }
  const map = getMap(st);
  getPlayer(st, 'P1')!.cellId = map.cells.find((c) => c.cellType === 'Jail')!.id;
  st.currentIndex = st.players.indexOf(getPlayer(st, 'P0')!);
  return st;
}

/** 在指定类型的格子上打出某张牌，返回目的地信息 */
function playAt(st: EngineState, cardName: string, cellType: string) {
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  const card = CARD_BY_NAME[cardName];
  for (const cell of map.cells.filter((c) => c.cellType === cellType)) {
    a.cellId = cell.id;
    a.hand = [card.id];
    a.movedThisTurn = false;
    a.cardsPlayedThisTurn = 0;
    a.flags = {};
    (st as { pending?: unknown }).pending = undefined;
    const r = playCard(st, a.id, card.id);
    if (!r.ok) continue;
    const opts = st.pending?.options ?? [];
    const types = [...new Set(opts.map((o) => map.cells.find((c) => c.id === o.value)?.cellType ?? '?'))];
    return { ok: true, count: opts.length, types, prompt: buildEnginePrompt(st, a.id) };
  }
  return { ok: false, count: 0, types: [] as string[], prompt: null };
}

// ─────────────────────────────────────────────────────────────
console.log('=== bug D：传送目的地必须按卡牌参数过滤 ===');

check('a024「翻筋斗」只能传送到赌博站点（Risk）', () => {
  const st = game();
  const r = playAt(st, 'a024', 'Risk');
  assert.ok(r.ok, 'a024 应在赌博站点能打出');
  assert.ok(r.count > 0, '应给出目的地');
  assert.deepEqual(r.types, ['Risk'],
    `只该有赌博站点，实际包含 ${r.types.join(', ')}`);
  console.log(`      ${r.count} 个目的地，类型：${r.types.join(', ')}`);
});

check('a050「警察飞船」只能到法院或办公楼', () => {
  const st = game();
  // a050 的 cellTypeId 是 Police → 必须在**警察格**打
  const r = playAt(st, 'a050', 'Police');
  assert.ok(r.ok, 'a050 应能在警察格打出');
  assert.deepEqual([...r.types].sort(), ['Courthouse', 'Office'],
    `应只有法院/办公楼，实际 ${r.types.join(', ')}`);
  console.log(`      类型：${r.types.join(', ')}`);
});

check('a129「贿赂有道」只能到贿赂站点', () => {
  const st = game();
  // a129 的 cellTypeId 是 Bribe → 在**贿赂格**打
  const r = playAt(st, 'a129', 'Bribe');
  assert.ok(r.ok, 'a129 应能在贿赂格打出');
  assert.deepEqual(r.types, ['Bribe'], `应只有贿赂站点，实际 ${r.types.join(', ')}`);
  console.log(`      ${r.count} 个目的地：${r.types.join(', ')}`);
});

check('a018「一流移位机」文案是"任意站点或建筑" → 覆盖全部格子', () => {
  const st = game();
  const r = playAt(st, 'a018', 'Plant');
  assert.ok(r.ok, 'a018 应能打出');
  assert.ok(r.types.length > 8, `"任意"应给出很多类型，实际只有 ${r.types.length} 种`);
  console.log(`      ${r.count} 个目的地，${r.types.length} 种类型（符合"任意"）`);
});

check('界面通过 placeOptions 拿到地点（而不是一串文字按钮）', () => {
  const st = game();
  const r = playAt(st, 'a024', 'Risk');
  assert.ok(r.prompt, '应有提示');
  assert.equal(r.prompt!.type, 'choose');
  assert.equal(r.prompt!.placeOptions?.length, r.count,
    'placeOptions 应等于目的地数量 —— 界面靠它在地图上高亮');
  console.log(`      placeOptions=${r.prompt!.placeOptions!.length} 项`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== bug E：位置必须永远是合法格 id ===');

check('teleportTargetCells 把"格子类型 id"解析成真实格 id', () => {
  const st = game();
  const map = getMap(st);
  // a163 的参数 D6534DE007B18E10 是 Office 的 cellType key
  // ⚠️ D6534DE007B18E10 对应的是**法院**（Courthouse），不是办公楼。
  // 起初我按 cell_types.json 的 Name 字段判断成了 Office —— 但那个文件把
  // Office/Courthouse 两行标反了；以**棋盘自身**的 cellType 为准。
  const cells = teleportTargetCells(st, ['D6534DE007B18E10']);
  assert.ok(cells.length > 0, '应解析出格子');
  for (const c of cells) {
    assert.ok(map.cells.some((x) => x.id === c.id), `${c.id} 应是真实格 id`);
    assert.equal(map.cells.find((x) => x.id === c.id)!.cellType, 'Courthouse',
      '应解析到法院');
  }
  console.log(`      解析到 ${cells.length} 个法院：${cells.map((c) => c.label).join(', ')}`);
});

check('a163「审判日」把对手传送到**真实格子**（不是类型 key）', () => {
  const st = game();
  const map = getMap(st);
  const a = getPlayer(st, 'P0')!;
  const b = getPlayer(st, 'P1')!;
  const ids = new Set(map.cells.map((c) => c.id));
  a.cellId = map.cells.find((c) => c.cellType === 'Bank')!.id;
  a.hand = [CARD_BY_NAME['a163']!.id];

  let r = playCard(st, a.id, CARD_BY_NAME['a163']!.id);
  let guard = 0;
  while (st.pending && guard++ < 10) {
    const pend = st.pending;
    const rr = answerChoice(st, pend.playerId, pend.options.slice(0, 1).map((o) => o.value));
    st.pending = rr.pending;
    if (!st.pending) break;
  }
  void r;
  assert.ok(ids.has(b.cellId),
    `对手位置应是合法格 id，实际 ${b.cellId}（长度 ${b.cellId.length}）`);
  console.log(`      对手位置 = ${map.cells.find((c) => c.id === b.cellId)?.cellType}`);
});

check('长时间对局中，任何玩家的位置都不会变成非法 id', () => {
  // 这是用户可见的症状：位置一旦变成 cellType key，
  // 后续 getCell 全部失败，界面会显示"未知"
  let turns = 0;
  for (const seed of [44444, 1, 7, 42, 20240601, 999]) {
    const st: EngineState = createState({
      roomId: 'tp2', seed, targetScore: 20,
      players: ['Banker', 'Damned', 'Engineer'].map((nm, i) => ({
        id: `P${i}`, name: `P${i}`, isAI: true, characterId: charOf(nm),
      })),
      chaosEnabled: true,
    });
    const ids = new Set(getMap(st).cells.map((c) => c.id));
    let steps = 0;
    while (st.phase === 'playing' && steps++ < 3000) {
      runAIPlayers(st, 4);
      if (st.pending) {
        const pend = st.pending;
        const r = answerChoice(st, pend.playerId,
          pend.options.slice(0, Math.max(1, pend.min ?? 1)).map((o) => o.value));
        st.pending = r.pending;
      }
      for (const p of st.players) {
        assert.ok(ids.has(p.cellId),
          `seed=${seed} 第 ${steps} 步：${p.name} 位置非法 (${p.cellId})`);
      }
    }
    turns += steps;
  }
  console.log(`      6 个 seed 共 ${turns} 步，位置始终合法`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n=== 不变量 ===');

check('所有传送卡的参数都能解析到真实格子（或是有意为之的语义标记）', () => {
  const st = game();
  const marker = /^(All|Card|Opponent)$/i;
  const problems: string[] = [];
  const all = [...ACTION_CARDS];
  for (const c of all) {
    for (const act of c.actions ?? []) {
      if (!/^(Teleport|OpponentTeleport)$/.test(String(act.type))) continue;
      for (const raw of act.params ?? []) {
        if (!raw || marker.test(raw)) continue;
        if (teleportTargetCells(st, [raw]).length === 0) {
          problems.push(`${c.name}(${act.type}) 参数 ${raw} 在棋盘上找不到格子`);
        }
      }
    }
  }
  assert.equal(problems.length, 0, problems.join('; '));
  console.log('      所有传送参数都能解析');
});

check('a103 的中文补齐了"传送到法院"（原版中文漏了这半句）', () => {
  const c = CARD_BY_NAME['a103']!;
  const d = displayCardRules(c);
  // 参数指向法院，文案必须提到法院，否则玩家会以为把自己送进监狱
  assert.ok(d.includes('法院'), `文案应提到法院：${d}`);
  console.log(`      ${d}`);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
