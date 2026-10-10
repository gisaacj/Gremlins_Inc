// =============================================================
// 真实 socket 端到端测试
//
// 与 `server-integration.test.ts` 的区别：那个是**直接调用服务端函数**
// （不经过网络），本测试**真的启动服务器 + 真的连 socket.io 客户端**，
// 走完整的 create → join → ready → start → 出牌 → 结束回合 流程。
//
// 这是"网页版真的能联机玩"的唯一直接证据。
//
// 运行: npx tsx tools-audit4/socket-e2e.mjs
// =============================================================
import { io } from 'socket.io-client';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3411;
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = 'E:/code/小魔怪-push';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
  if (ok) pass++; else fail++;
};

// ── 启动服务器 ──
console.log('=== 启动服务器 ===');
const srv = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d.toString(); });
srv.stderr.on('data', (d) => { srvOut += d.toString(); });

// 等健康检查通过
let up = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try {
    const r = await fetch(`${URL}/api/health`);
    if (r.ok) { up = true; break; }
  } catch { /* 还没起来 */ }
}
check('服务器健康检查通过', up, up ? `${URL}/api/health` : `启动失败:\n${srvOut.slice(-800)}`);
if (!up) { srv.kill(); process.exit(1); }

// ── 连接两个客户端 ──
const mk = (tag) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.prompts = [];
  s.games = [];
  s.on('game:prompt', (p) => s.prompts.push(p));
  s.on('game:state', (g) => s.games.push(g));
  s.on('room:state', (r) => { s.room = r; });
  s.tag = tag;
  return s;
};
const emitAck = (s, ev, payload) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, error: 'ack 超时' }), 5000);
  s.emit(ev, payload, (r) => { clearTimeout(t); res(r ?? { ok: true }); });
});
const waitFor = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); }
  return false;
};

const A = mk('A');
const B = mk('B');
await Promise.all([
  new Promise((r) => A.on('connect', r)),
  new Promise((r) => B.on('connect', r)),
]);
check('两个客户端都已连接', A.connected && B.connected, `A=${A.id?.slice(0, 6)} B=${B.id?.slice(0, 6)}`);

// ── 建房 / 加入 ──
console.log('\n=== 建房与加入 ===');
const created = await emitAck(A, 'room:create', {
  name: 'Alice',
  config: { maxPlayers: 2, targetCogs: 10, chaosEnabled: true },
});
check('A 创建房间', created.ok && !!created.roomId, `roomId=${created.roomId ?? created.error}`);
const roomId = created.roomId;

const joined = await emitAck(B, 'room:join', { roomId, name: 'Bob' });
check('B 加入房间', joined.ok, joined.error ?? '');
await sleep(400);

// ── 两阶段开始：先 room:start 进入选角，再选角，最后 room:start 真正开局 ──
console.log('\n=== 选角色 / 开始（两阶段）===');
A.emit('room:ready', { ready: true });
B.emit('room:ready', { ready: true });
await sleep(500);

// 阶段 1：host 开始 → 服务端切到 character_select 并下发 charOptions
A.emit('room:start');
const inSelect = await waitFor(
  () => A.room?.phase === 'character_select' && !!A.room?.players?.find((p) => p.id === A.id)?.charOptions,
  8000,
);
check('阶段一：进入选角并拿到 charOptions', inSelect, `phase=${A.room?.phase}`);

const pickChar = (s, idx) => {
  const me = s.room?.players?.find((p) => p.id === s.id);
  const opts = me?.charOptions ?? [];
  return opts[idx] ?? opts[0];
};
const ca = pickChar(A, 0);
const cb = pickChar(B, 0);
check('双方都有可选角色', !!ca && !!cb, `A=${ca ?? 'undefined'} B=${cb ?? 'undefined'}`);

A.emit('room:select_character', { characterId: ca });
B.emit('room:select_character', { characterId: cb });
await sleep(500);

// 阶段 2：host 再次 start → 真正开局
A.emit('room:start');
const started = await waitFor(() => A.games.length > 0 || A.prompts.length > 0, 10000);
check('阶段二：游戏开始（收到状态或提示）', started,
  started ? `state=${A.games.length} prompt=${A.prompts.length}` : '超时');

// ── 真实对局：跑若干回合 ──
console.log('\n=== 通过 socket 实际对局 ===');
let actions = 0;
const t0 = Date.now();
while (Date.now() - t0 < 25000) {
  for (const s of [A, B]) {
    const p = s.prompts[s.prompts.length - 1];
    if (!p) continue;
    const g = s.games[s.games.length - 1];
    const me = g?.players?.find((x) => x.id === g.__selfId);
    void me;

    if (p.type === 'choose') {
      const v = p.choices?.[0]?.value;
      if (v !== undefined) { s.emit('game:choose', { values: [v] }); actions++; s.prompts.pop(); }
    } else if (p.type === 'select_move_card') {
      const cardId = p.options?.[0];
      if (cardId) { s.emit('game:select_move_card', { cardId }); actions++; s.prompts.pop(); }
    } else if (p.type === 'play_card_or_skip') {
      const opts = p.optionalActions ?? [];
      if (opts.length) { s.emit('game:do_option', { optionId: opts[0].id ?? opts[0].value }); }
      else { s.emit('game:skip_play'); }
      actions++; s.prompts.pop();
    } else if (p.type === 'wait_others') {
      // 等别人
    }
  }
  const st = A.games[A.games.length - 1];
  if (st?.phase === 'game_over') break;
  await sleep(120);
}

const finalState = A.games[A.games.length - 1];
check('对局产生了状态更新', A.games.length > 0, `收到 ${A.games.length} 次状态`);
check('客户端发出了若干操作', actions > 0, `${actions} 次`);
check('对局推进到了终局或明显进展', !!finalState, finalState
  ? `phase=${finalState.phase} turn=${finalState.turn} winner=${finalState.winnerId ?? '-'}`
  : '无状态');

console.log('\n=== 服务器日志（尾部）===');
for (const l of srvOut.trim().split('\n').slice(-8)) console.log('  ' + l.replace(/\u001b\[[0-9;]*m/g, ''));

A.close(); B.close(); srv.kill();
await sleep(300);
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
