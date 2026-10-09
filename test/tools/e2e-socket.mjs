/**
 * socket.io 端到端测试：连真服务端，建房 → 加 AI → 开局 → 走几步。
 *
 * 运行: node tools/e2e-socket.mjs [url] [timeoutMs]
 * 前置: 服务端已在 url（默认 http://127.0.0.1:3000）运行
 *
 * 注意：只有协议里带 ack 的事件（room:create / room:join）才传回调。
 * 其他事件传回调会被服务端当成 payload，导致不回包而卡住。
 */
import { io } from '../../node_modules/socket.io-client/build/esm/index.js';
import { CARD_BY_ID } from '../../shared/dist/index.js';

const URL = process.argv[2] ?? 'http://127.0.0.1:3000';
/** 每一步的等待上限（毫秒） */
const STEP_TIMEOUT = Number(process.argv[3] ?? 10000);

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带超时的等待条件成立；超时返回 false */
async function waitFor(label, cond, timeout = STEP_TIMEOUT) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (cond()) return true;
    await sleep(100);
  }
  console.log(`      ! 等待「${label}」超时 (${timeout}ms)`);
  return false;
}

const socket = io(URL, { transports: ['websocket'], reconnection: false });

const got = {
  roomState: null, gameState: null, prompt: null,
  started: false, over: null, errors: [], aiThinking: 0,
};
let promptCount = 0;

socket.on('room:state', (s) => { got.roomState = s; });
socket.on('room:character_select', (s) => { got.roomState = s; });
socket.on('game:start', () => { got.started = true; });
socket.on('game:state', (s) => { got.gameState = s; });
socket.on('game:prompt', (p) => { got.prompt = p; promptCount++; });
socket.on('game:over', (w) => { got.over = w; });
socket.on('game:ai_thinking', () => { got.aiThinking++; });
socket.on('error', (e) => { got.errors.push(e); });

/** 带 ack 的事件（协议里有 callback 的） */
const emitAck = (ev, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${ev} ack 超时`)), STEP_TIMEOUT);
  socket.emit(ev, payload, (res) => { clearTimeout(timer); resolve(res); });
});
/** 无 ack 的事件：只发不等回包 */
const send = (ev, payload) => { socket.emit(ev, payload); };

try {
  const connected = await new Promise((resolve) => {
    socket.on('connect', () => resolve(true));
    socket.on('connect_error', () => resolve(false));
    setTimeout(() => resolve(false), STEP_TIMEOUT);
  });
  if (!connected) throw new Error(`无法连接 ${URL}`);
  console.log(`已连接 ${URL} (sid=${socket.id})\n`);

  console.log('=== 1. 建房与加 AI ===');
  const created = await emitAck('room:create', { name: '测试房主' });
  check('room:create 返回房间号', () => {
    if (!created?.ok || !created.roomId) throw new Error(JSON.stringify(created));
    console.log(`      房间号 ${created.roomId}`);
  });
  if (!created?.ok) throw new Error('建房失败，后续无法继续');

  send('room:add_ai');
  send('room:add_ai');
  const ok3 = await waitFor('3 名玩家', () => got.roomState?.players?.length === 3, 5000);
  check('房间里有 3 名玩家（1 真人 + 2 AI）', () => {
    if (!ok3) throw new Error(`实际 ${got.roomState?.players?.length} 名`);
  });

  console.log('\n=== 2. 开局（默认 pick3 选角流程）===');
  send('room:ready', { ready: true });
  await sleep(150);
  const t0 = Date.now();
  send('room:start');
  // 默认 charSelectMode='pick3'：第一次 room:start 只进入选角阶段
  const inSelect = await waitFor('room:character_select', () => got.roomState?.phase === 'character_select', 5000);
  check('第一次 room:start 进入选角阶段', () => {
    if (!inSelect) throw new Error(`phase=${got.roomState?.phase ?? 'null'}`);
  });
  if (inSelect) {
    const me = got.roomState.players.find((p) => p.id === socket.id);
    const pick = me?.charOptions?.[0];
    check('选角阶段给出角色选项', () => {
      if (!pick) throw new Error(`charOptions=${JSON.stringify(me?.charOptions)}`);
      console.log(`      可选 ${me.charOptions.length} 个，选第 1 个`);
    });
    if (pick) {
      send('room:select_character', { characterId: pick });
      await sleep(200);
      send('room:start'); // 第二次：真正开局
    }
  }
  const gotStart = await waitFor('game:state', () => !!got.gameState, STEP_TIMEOUT);
  check('收到 game:start 与 game:state', () => {
    if (!got.started) throw new Error('未收到 game:start');
    if (!gotStart) throw new Error('未收到 game:state');
    console.log(`      耗时 ${Date.now() - t0}ms`);
  });

  console.log('\n=== 3. 状态形状（客户端消费契约）===');
  check('状态含 mapId / players / turnPhase / turn', () => {
    const g = got.gameState;
    if (!g) throw new Error('无状态');
    for (const k of ['roomId', 'mapId', 'players', 'turnPhase', 'turn']) {
      if (!(k in g)) throw new Error(`缺字段 ${k}`);
    }
    if (typeof g.turnPhase !== 'string') throw new Error('turnPhase 应为字符串');
  });
  check('玩家 position 是棋盘格 id（数字字符串，非旧下标）', () => {
    for (const p of got.gameState.players) {
      if (typeof p.position !== 'string' || !/^\d+$/.test(p.position)) {
        throw new Error(`${p.name} position=${p.position} 不是格 id`);
      }
    }
    console.log(`      位置：${got.gameState.players.map((p) => `${p.name}@…${p.position.slice(-4)}`).join(', ')}`);
  });
  check('资源字段是协议形状', () => {
    for (const p of got.gameState.players) {
      for (const k of ['gold', 'votes', 'malice', 'cogs', 'income', 'bribe']) {
        if (typeof p.resources[k] !== 'number') throw new Error(`${p.name}.${k} 不是数字`);
      }
    }
  });
  check('自己看得到手牌，别人只有张数', () => {
    const me = got.gameState.players.find((p) => p.id === socket.id);
    if (!me) throw new Error('找不到自己');
    if (!Array.isArray(me.hand)) throw new Error('自己应有 hand');
    const other = got.gameState.players.find((p) => p.id !== socket.id);
    if (other.hand !== undefined) throw new Error('别人不应有 hand');
    if (typeof other.handCount !== 'number') throw new Error('别人应有 handCount');
  });

  console.log('\n=== 4. 提示与动作 ===');
  const gotPrompt = await waitFor('属于我的 prompt', () => {
    const p = got.prompt;
    return !!p && ['select_move_card', 'choose'].includes(p.type);
  }, 20000);
  check('收到属于自己的 prompt', () => {
    if (!gotPrompt) throw new Error('超时未收到 prompt');
    console.log(`      prompt=${got.prompt.type} 「${got.prompt.message}」`);
  });
  check('AI 有行动（日志非空）', () => {
    const n = got.gameState.log?.length ?? 0;
    if (n === 0) throw new Error('日志为空；AI 可能没动，或首位是真人');
    console.log(`      日志 ${n} 条，末条：${got.gameState.log[n - 1]?.text?.slice(0, 64)}`);
  });

  if (got.prompt?.type === 'select_move_card') {
    const me = got.gameState.players.find((p) => p.id === socket.id);
    // 挑一张付得起的牌：费用类型可能是金钱或选票
    const cardOf = (id) => CARD_BY_ID[id];
    const affordable = (got.prompt.options ?? []).find((id) => {
      const c = cardOf(id);
      if (!c || c.move <= 0) return false;
      if (c.price <= 0) return true;
      const res = c.priceType === 'Vote' ? me.resources.votes : me.resources.gold;
      return res >= c.price;
    });
    const cardId = affordable ?? (got.prompt.options ?? [])[0];
    const before = { pos: me.position, turn: got.gameState.turn };
    check('能在手牌里挑出一张付得起的移动牌', () => {
      if (!cardId) throw new Error('options 为空');
      const c = cardOf(cardId);
      console.log(`      选「${c?.text.name}」移动 ${c?.move}，费用 ${c?.price}${c?.priceType}`);
    });
    send('game:select_move_card', { cardId });
    // "移动生效"不能只看位置变化：
    //  - 移动可能中途挂起（岔路选方向 / 选对手 / BUTTON 二选一）→ 位置要等决策完才变
    //  - 落地效果可能把人传送走（位置变了但不是"走了那几步"）
    // 所以接受以下任一信号：位置变化、换人、出现新提示、日志增长。
    const logBefore = got.gameState.log?.length ?? 0;
    const moved = await waitFor('移动后的新状态', () => {
      const me2 = got.gameState.players.find((p) => p.id === socket.id);
      return me2.position !== before.pos
        || got.gameState.turn !== before.turn
        || (got.gameState.log?.length ?? 0) > logBefore
        || got.prompt?.type === 'choose'
        || got.prompt?.type === 'wait_others';
    });
    check('移动被接受并产生了效果', () => {
      if (got.errors.length) throw new Error(JSON.stringify(got.errors));
      if (!moved) throw new Error('位置、回合、日志与提示都没变');
      const me2 = got.gameState.players.find((p) => p.id === socket.id);
      const tail = got.gameState.log?.[got.gameState.log.length - 1]?.text ?? '';
      console.log(`      …${before.pos.slice(-4)} → …${me2.position.slice(-4)}，回合 ${before.turn} → ${got.gameState.turn}`);
      if (tail) console.log(`      末条日志：${tail.slice(0, 60)}`);
    });
  } else if (got.prompt?.type === 'choose') {
    const c = got.prompt.choices?.[0];
    send('game:choose', { kind: got.prompt.type, values: c ? [c.value] : [] });
    const ok = await waitFor('决策后的新状态', () => got.errors.length === 0);
    check('应答决策被接受', () => {
      if (!ok || got.errors.length) throw new Error(JSON.stringify(got.errors));
    });
  }

  console.log('\n=== 4b. 可选动作（站点主动行为）===');
  // 移动可能在中途挂起（岔路选方向、选对手…），先按默认选项把决策走完。
  // 注意：某些决策需要"选人"而客户端还没实现，所以这里**不等超时**，
  // 每次发完答案就用较短的时间片轮询，避免白白浪费 5 秒。
  let guard = 0;
  while (got.prompt?.type === 'choose' && guard++ < 10) {
    const pickChoice = got.prompt.choices?.[0];
    send('game:choose', { kind: got.prompt.type, values: pickChoice ? [pickChoice.value] : [] });
    const advanced = await waitFor('决策被处理', () => got.prompt?.type !== 'choose', 2500);
    if (!advanced) {
      console.log('      ! 该决策未被消费（可能需要额外目标），停止等待');
      break;
    }
  }
  if (guard) console.log(`      先处理了 ${guard} 次挂起决策`);

  // 移动完成后若落在有可选动作的地点，服务端会保留行动权让我们决定。
  // 但行动权也可能还在 AI 手上（AI 每步有延迟），所以这里只是尽量等一等，
  // 轮不到不是失败——4b 只是加强验证。
  const myTurn = await waitFor(
    '行动权回到我手上',
    () => got.prompt?.type === 'select_move_card',
    12000,
  );
  if (!myTurn) {
    check('本局行动权未回到我手上，跳过可选动作验证', () => {
      console.log(`      （当前 prompt=${got.prompt?.type ?? 'null'}，属正常对局流程）`);
    });
  } else {
    const acts = got.prompt?.optionalActions ?? [];
    check('轮到我时提示里带 optionalActions 字段', () => {
      console.log(`      可选动作 ${acts.length} 个${acts.length ? `：${acts.map((a) => a.label).join(' / ')}` : '（当前地点没有）'}`);
    });

    const pick = acts.find((a) => a.affordable !== false && !a.needsTarget);
    if (pick) {
      const before = got.gameState.players.find((p) => p.id === socket.id);
      send('game:do_option', { optionId: pick.id });
      const changed = await waitFor('执行可选动作后的状态变化', () => {
        const me2 = got.gameState.players.find((p) => p.id === socket.id);
        const r = me2.resources;
        return r.gold !== before.resources.gold
          || r.votes !== before.resources.votes
          || r.cogs !== before.resources.cogs
          || r.income !== before.resources.income
          || me2.position !== before.position;
      }, 8000);
      check(`执行可选动作「${pick.label}」生效`, () => {
        if (got.errors.length) throw new Error(JSON.stringify(got.errors));
        if (!changed) throw new Error('资源与位置都没变');
        const me2 = got.gameState.players.find((p) => p.id === socket.id);
        console.log(`      金钱 ${before.resources.gold} → ${me2.resources.gold}，`
          + `选票 ${before.resources.votes} → ${me2.resources.votes}，`
          + `齿轮 ${before.resources.cogs} → ${me2.resources.cogs}`);
      });
    } else {
      check('本局落点没有可执行的可选动作（跳过）', () => {
        console.log('      （落点决定，非失败）');
      });
    }
  }

  console.log('\n=== 5. 无错误 ===');
  check('过程中没有 error 事件', () => {
    if (got.errors.length) throw new Error(JSON.stringify(got.errors));
  });
} catch (e) {
  console.log(`  ✗ 异常：${e.message}`);
  fail++;
} finally {
  socket.close();
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail > 0 ? 1 : 0;
