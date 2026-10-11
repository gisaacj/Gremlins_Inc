// 探测公网服务器：哪些端口开着、HTTP/socket.io 是否可达
import { Socket } from 'node:net';

const HOST = process.env.HOST_IP ?? '120.55.161.161';
const PORTS = (process.env.PORTS ?? '80,443,3000,5173,8080,8081,8000').split(',').map(Number);

const tcpProbe = (host, port, timeout = 4000) => new Promise((resolve) => {
  const s = new Socket();
  const t0 = Date.now();
  const done = (ok, note) => { s.destroy(); resolve({ port, ok, ms: Date.now() - t0, note }); };
  s.setTimeout(timeout);
  s.once('connect', () => done(true, 'TCP 已连通'));
  s.once('timeout', () => done(false, '超时（被防火墙丢弃 / 服务没起）'));
  s.once('error', (e) => done(false, `${e.code ?? e.message}`));
  s.connect(port, host);
});

const httpProbe = async (url, timeout = 6000) => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(t);
    const body = (await r.text()).slice(0, 120).replace(/\s+/g, ' ');
    return { ok: true, note: `HTTP ${r.status} · ${body}` };
  } catch (e) {
    return { ok: false, note: `${e.name}: ${e.message}` };
  }
};

console.log(`=== 探测 ${HOST} ===\n`);
console.log('--- TCP 端口 ---');
const tcp = [];
for (const p of PORTS) {
  const r = await tcpProbe(HOST, p);
  tcp.push(r);
  console.log(`  ${r.ok ? '✓' : '✗'} ${String(p).padEnd(6)} ${r.note}${r.ok ? `  (${r.ms}ms)` : ''}`);
}

console.log('\n--- HTTP ---');
const open = tcp.filter((r) => r.ok).map((r) => r.port);
for (const p of [80, 443, ...open].filter((v, i, a) => a.indexOf(v) === i)) {
  const scheme = p === 443 ? 'https' : 'http';
  const r = await httpProbe(`${scheme}://${HOST}:${p}/api/health`);
  console.log(`  ${r.ok ? '✓' : '✗'} ${scheme}://${HOST}:${p}/api/health`);
  console.log(`      ${r.note}`);
}

console.log('\n--- socket.io 握手 ---');
for (const p of open) {
  const url = `http://${HOST}:${p}/socket.io/?EIO=4&transport=polling`;
  const r = await httpProbe(url);
  console.log(`  ${r.ok ? '✓' : '✗'} :${p}  ${r.note.slice(0, 90)}`);
}

console.log('\n=== 结论 ===');
if (!open.length) {
  console.log(`  ${HOST} 上这几个端口**全部不可达**。`);
  console.log('  → 要么服务器上没跑服务，要么云厂商安全组没放行。');
} else {
  console.log(`  可达端口: ${open.join(', ')}`);
}
