// 端到端：从公网完整走一遍"建房间 → 加入 → 开始"
import { io } from 'socket.io-client';

const HOST = process.env.HOST_IP ?? '120.55.161.161';
const PORT = Number(process.env.PORT ?? 3000);
const url = `http://${HOST}:${PORT}`;

const connect = () => new Promise((resolve, reject) => {
  const s = io(url, { transports: ['websocket'], reconnection: false, timeout: 8000 });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
  setTimeout(() => reject(new Error('连接超时')), 10000);
});

const emitAck = (s, ev, payload, ms = 8000) => new Promise((resolve) => {
  let done = false;
  s.emit(ev, payload, (r) => { done = true; resolve(r); });
  setTimeout(() => { if (!done) resolve({ ok: false, error: '(无回调)' }); }, ms);
});

console.log(`=== 公网端到端 → ${url} ===\n`);

const a = await connect();
console.log(`✓ 房主已连接 id=${a.id}`);

const created = await emitAck(a, 'room:create', { name: '房主' });
console.log(`  room:create → ${JSON.stringify(created)}`);
if (!created.ok) { a.close(); process.exit(1); }

let lobby = null;
a.on('room:state', (st) => { lobby = st; });
await new Promise((r) => setTimeout(r, 800));
console.log(`  room:state → roomId=${lobby?.roomId} phase=${lobby?.phase} players=${lobby?.players?.length}`);

const b = await connect();
console.log(`\n✓ 第二个客户端已连接 id=${b.id}`);
const joined = await emitAck(b, 'room:join', { roomId: created.roomId, name: '玩家2' });
console.log(`  room:join → ${JSON.stringify(joined)}`);

await new Promise((r) => setTimeout(r, 800));
console.log(`  room:state → players=${lobby?.players?.length} ${JSON.stringify(lobby?.players?.map((p) => p.name))}`);

console.log('\n=== 结果 ===');
const pass = created.ok && joined.ok && (lobby?.players?.length ?? 0) >= 2;
console.log(pass
  ? '  ✓ 公网服务器业务通路完全正常（建房间 / 加入 / 广播）'
  : '  ✗ 有环节失败');

a.close(); b.close();
process.exit(pass ? 0 : 1);
