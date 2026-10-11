// =============================================================
// 局域网联机诊断 —— 一条命令给出"手机能不能连上"的结论
//
// 用法：node tools\lan-doctor.mjs
//
// 它做四件事：
//   1. 服务端有没有在跑（3000 端口有没有监听）
//   2. 监听地址是不是 0.0.0.0（绑 127.0.0.1 的话手机连不上）
//   3. 本机用**局域网 IP** 访问自己（这一步**绕不过防火墙**）
//   4. 检查防火墙有没有放行 3000（这一步才是手机能不能连的关键）
//
// 注意：本机访问本机**永远**不受防火墙影响，所以第 3 步通过
// 不代表手机能连 —— 必须看第 4 步。
// =============================================================
import { execSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const PORT = Number(process.env.PORT ?? 3000);
const results = [];
const say = (level, label, detail = '') => {
  const icon = level === 'ok' ? '✓' : level === 'warn' ? '!' : '✗';
  results.push({ level, label, detail });
  console.log(`  ${icon} ${label}${detail ? `\n      ${detail}` : ''}`);
};

console.log(`=== 局域网联机诊断（端口 ${PORT}）===\n`);

// ── 1. 端口有没有在监听 ──
let listening = [];
try {
  const raw = execSync(
    `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress }"`,
    { encoding: 'utf8' },
  ).trim();
  listening = raw ? raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
} catch { /* 忽略 */ }

if (!listening.length) {
  say('err', `服务端没有在监听 ${PORT} 端口`, '先启动服务端：npm run start:server（或 npm run dev）');
} else {
  say('ok', `服务端正在监听 ${PORT}`, `监听地址: ${listening.join(', ')}`);
  const onlyLoopback = listening.every((a) => a === '127.0.0.1' || a === '::1');
  if (onlyLoopback) {
    say('err', '只绑在 127.0.0.1，手机连不上',
      '把 server/src/index.ts 的 HOST 设为 0.0.0.0（默认已是），或设环境变量 HOST=0.0.0.0');
  } else {
    say('ok', '监听地址包含 0.0.0.0 / 局域网地址 —— 手机有机会连上');
  }
}

// ── 2. 找出局域网地址 ──
const lan = [];
for (const [name, addrs] of Object.entries(networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
      lan.push({ name, ip: a.address });
    }
  }
}
if (!lan.length) {
  say('err', '找不到局域网 IPv4 地址', '确认电脑已连上 WiFi 或网线（169.254.* 是无效地址，不算）');
} else {
  say('ok', `找到 ${lan.length} 个局域网地址`,
    lan.map((x) => `${x.ip}  (${x.name})`).join('\n      '));
}

// ── 3. 本机用局域网 IP 访问自己 ──
console.log('\n  --- 本机自测（注意：这一步绕不过防火墙）---');
for (const { ip, name } of lan) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`http://${ip}:${PORT}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const body = await r.text();
    say('ok', `${ip} (${name}) 自测通过`, `HTTP ${r.status} ${body.slice(0, 50)}`);
  } catch (e) {
    say('err', `${ip} (${name}) 自测失败`, `${e.name}: ${e.message}`);
  }
}

// ── 4. 防火墙 ──
console.log('\n  --- 防火墙（手机能不能连的关键）---');
let fwText = '';
try {
  fwText = execSync(
    `powershell -NoProfile -Command "Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction SilentlyContinue | ForEach-Object { $pf = $_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue; if ($pf -and ($pf.LocalPort -eq '${PORT}' -or $pf.LocalPort -eq 'Any')) { $_.Profile.ToString() + '|' + $_.DisplayName } }"`,
    { encoding: 'utf8' },
  ).trim();
} catch { /* 忽略 */ }

const rules = fwText ? fwText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
if (rules.length) {
  say('ok', `找到 ${rules.length} 条可能放行 ${PORT} 的入站规则`, rules.slice(0, 6).join('\n      '));
} else {
  say('err', `没有任何入站规则放行 ${PORT}`,
    '手机从外部连进来会被防火墙丢掉。请用管理员身份运行：\n'
    + '      powershell -ExecutionPolicy Bypass -File tools\\open-firewall.ps1');
}

// 活动网络的类别
let category = '';
try {
  category = execSync(
    'powershell -NoProfile -Command "(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -eq \'Internet\' } | Select-Object -First 1).NetworkCategory"',
    { encoding: 'utf8' },
  ).trim();
} catch { /* 忽略 */ }
if (category) {
  say('ok', `当前联网的配置类型：${category}`,
    category === 'Public'
      ? 'Public 配置更严格；tools\\open-firewall.ps1 只放行 Private/Domain，Public 下需把网络设为专用，或改用 -Profile Any'
      : 'Private 配置，open-firewall.ps1 正好覆盖');
}

// ── 结论 ──
console.log('\n=== 结论 ===');
const blockers = results.filter((r) => r.level === 'err');
const primary = lan.find((x) => x.name && !x.name.includes('WLAN')) ?? lan[0];
if (!blockers.length) {
  console.log('  全部通过。手机上填写：');
  for (const { ip } of lan) console.log(`    ${ip}:${PORT}`);
  console.log('  （只填 IP:端口，不要填 http://，也不要用 127.0.0.1）');
} else {
  console.log('  发现以下阻塞项，按顺序解决：');
  blockers.forEach((b, i) => console.log(`    ${i + 1}. ${b.label}`));
  if (primary) {
    console.log(`\n  修好之后，手机上填写：${primary.ip}:${PORT}`);
  }
}
