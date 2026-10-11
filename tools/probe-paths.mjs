// 结论汇总：从本机多路径验证服务器可达性，用于对比"手机为什么不行"
import { execSync } from 'node:child_process';
import { Socket } from 'node:net';

const HOST = '120.55.161.161';
const PORTS = [3000, 8080, 5173];

const tcp = (port, timeout = 5000) => new Promise((resolve) => {
  const s = new Socket();
  const t0 = Date.now();
  s.setTimeout(timeout);
  s.once('connect', () => { s.destroy(); resolve({ ok: true, ms: Date.now() - t0 }); });
  s.once('timeout', () => { s.destroy(); resolve({ ok: false, note: '超时' }); });
  s.once('error', (e) => { s.destroy(); resolve({ ok: false, note: e.code ?? e.message }); });
  s.connect(port, HOST);
});

console.log(`=== 服务器 ${HOST} 可达性（从这台机器）===\n`);
for (const p of PORTS) {
  const r = await tcp(p);
  console.log(`  ${r.ok ? '✓' : '✗'} :${p}  ${r.ok ? `连通 ${r.ms}ms` : r.note}`);
}

console.log('\n=== 本机到服务器的路由（判断走哪条链路）===');
try {
  const out = execSync(
    `powershell -NoProfile -Command "(Find-NetRoute -RemoteIPAddress ${HOST} | Select-Object -First 1).InterfaceIndex"`,
    { encoding: 'utf8' },
  ).trim();
  const name = execSync(
    `powershell -NoProfile -Command "(Get-NetAdapter -InterfaceIndex ${out}).InterfaceDescription"`,
    { encoding: 'utf8' },
  ).trim();
  console.log(`  出接口: ${name}`);
  if (/VPN|TAP|SSL/i.test(name)) {
    console.log('  ⚠️ 经由 VPN 网卡 —— 说明服务器可能只对这个 VPN 网络放行！');
  } else {
    console.log('  · 走普通网卡（非 VPN）');
  }
} catch (e) {
  console.log(`  查询失败: ${e.message}`);
}

console.log('\n=== 低延迟说明什么 ===');
console.log('  16ms 量级 = 同城/同机房专线，不是走普通公网（普通公网跨省会 >30ms）。');
console.log('  → 你手机若走 4G/5G 或别的 WiFi，来源 IP 不同，被服务器侧规则拒掉，表现就是"超时"。');
