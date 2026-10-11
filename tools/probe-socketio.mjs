// 用真的 socket.io 客户端连公网服务器，完整走一遍（polling → websocket 升级）
import { io } from 'socket.io-client';

const HOST = process.env.HOST_IP ?? '120.55.161.161';
const PORTS = (process.env.PORTS ?? '3000,5173,8080').split(',').map(Number);

async function tryConnect(port) {
  const url = `http://${HOST}:${port}`;
  return new Promise((resolve) => {
    const events = [];
    const s = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 8000,
    });
    const finish = (ok, note) => {
      events.push(note);
      try { s.close(); } catch { /* ignore */ }
      resolve({ port, ok, note, events });
    };
    s.on('connect', () => {
      const tr = s.io.engine.transport.name;
      events.push(`连接建立 id=${s.id} transport=${tr}`);
      // 等 1.5s 看会不会掉线 / 升级
      setTimeout(() => {
        const tr2 = s.io.engine.transport.name;
        finish(true, `connected via ${tr} → 1.5s 后 transport=${tr2}, connected=${s.connected}`);
      }, 1500);
    });
    s.on('connect_error', (e) => finish(false, `connect_error: ${e.message}`));
    s.on('disconnect', (r) => events.push(`disconnect: ${r}`));
    s.io.on('upgrade', (t) => events.push(`upgrade → ${t.name}`));
    s.io.on('upgradeError', (e) => events.push(`upgradeError: ${e.message}`));
    setTimeout(() => finish(false, '总超时'), 12000);
  });
}

console.log(`=== socket.io 完整连接测试 → ${HOST} ===\n`);

for (const p of PORTS) {
  const r = await tryConnect(p);
  console.log(`${r.ok ? '✓' : '✗'} :${p}  ${r.note}`);
  for (const e of r.events) console.log(`      · ${e}`);
  console.log('');
}

// 顺便验证：能否真的创建一个房间（端到端业务通路）
console.log('=== 业务通路：创建房间 ===');
const url = `http://${HOST}:${PORTS[0]}`;
await new Promise((resolve) => {
  const s = io(url, { transports: ['websocket'], reconnection: false, timeout: 8000 });
  s.on('connect', () => {
    console.log(`  ✓ 已连接 ${url} id=${s.id}`);
    s.emit('lobby:create', { name: 'probe', isAI: false }, (resp) => {
      console.log(`  创建房间回调: ${JSON.stringify(resp).slice(0, 200)}`);
      s.close();
      resolve();
    });
    setTimeout(() => { console.log('  ✗ 创建房间无回调（8s）'); s.close(); resolve(); }, 8000);
  });
  s.on('connect_error', (e) => { console.log(`  ✗ ${e.message}`); resolve(); });
  setTimeout(() => { s.close(); resolve(); }, 12000);
});
