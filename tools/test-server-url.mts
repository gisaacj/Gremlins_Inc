// =============================================================
// 服务端地址解析测试（移动端连通性的关键逻辑）
//
// 背景：原实现是
//   `import.meta.env.VITE_SERVER_URL || (DEV ? '/' : window.location.origin)`
// 在 **Capacitor 原生壳**里 `window.location.origin` 指的是 WebView 自己，
// 不是我们的服务器 —— Android 默认 scheme 下它是 `https://localhost`。
// 结果：APK 装上后**永远连不上服务端**，而且看不出原因。
// `client/capacitor.config.ts` 里那句"实际部署时在 App 内设置中填写服务端 IP"
// 正说明这块当时没做完。
//
// 现在改为：地址可在**运行时**配置（localStorage），原生壳未配置时**明确报错**
// 而不是静默连 localhost。
//
// 运行: npx tsx server/src/__tests__/server-url.test.ts
// =============================================================
import assert from 'node:assert/strict';
import {
  SERVER_URL_KEY, defaultServerUrl, getServerUrl, getSocket, isNativeApp,
  normalizeServerUrl, setServerUrl,
} from '../client/src/net/socket.js';

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); fail++; }
};

// ── 一个最小的 localStorage 替身 ──
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    _dump: () => Object.fromEntries(m),
  };
}

console.log('=== 1. normalizeServerUrl：归一化玩家输入 ===');
check('裸 IP:端口 → 补上 http://', () => {
  assert.equal(normalizeServerUrl('192.168.1.10:3000'), 'http://192.168.1.10:3000');
});
check('已带 http:// 保持不变', () => {
  assert.equal(normalizeServerUrl('http://a.b:1'), 'http://a.b:1');
});
check('已带 https:// 保持不变', () => {
  assert.equal(normalizeServerUrl('https://a.b'), 'https://a.b');
});
check('相对路径保持原样（同源部署用）', () => {
  assert.equal(normalizeServerUrl('/'), '/');
  assert.equal(normalizeServerUrl('/api'), '/api');
});
check('前后空白被去掉', () => {
  assert.equal(normalizeServerUrl('  1.2.3.4:80  '), 'http://1.2.3.4:80');
});
check('空字符串 → 空（表示清除配置）', () => {
  assert.equal(normalizeServerUrl(''), '');
  assert.equal(normalizeServerUrl('   '), '');
});
check('大小写不敏感地识别协议', () => {
  assert.equal(normalizeServerUrl('HTTP://a.b'), 'HTTP://a.b');
});
check('主机名（非 IP）也能处理', () => {
  assert.equal(normalizeServerUrl('gremlins.example.com'), 'http://gremlins.example.com');
});

console.log('\n=== 2. isNativeApp：识别 Capacitor 原生壳 ===');
check('没有 Capacitor 全局对象 → 不是原生', () => {
  const g = globalThis as { Capacitor?: unknown };
  const saved = g.Capacitor;
  delete g.Capacitor;
  assert.equal(isNativeApp(), false);
  if (saved !== undefined) g.Capacitor = saved;
});
check('Capacitor.isNativePlatform() 为 true → 是原生', () => {
  const g = globalThis as { Capacitor?: unknown };
  const saved = g.Capacitor;
  g.Capacitor = { isNativePlatform: () => true };
  assert.equal(isNativeApp(), true);
  if (saved === undefined) delete g.Capacitor; else g.Capacitor = saved;
});
check('Capacitor 存在但返回 false → 不是原生（网页版）', () => {
  const g = globalThis as { Capacitor?: unknown };
  const saved = g.Capacitor;
  g.Capacitor = { isNativePlatform: () => false };
  assert.equal(isNativeApp(), false);
  if (saved === undefined) delete g.Capacitor; else g.Capacitor = saved;
});

console.log('\n=== 3. setServerUrl / getServerUrl：运行时配置 ===');
check('保存后能读回（归一化后的值由调用方负责）', () => {
  const g = globalThis as { localStorage?: unknown };
  const saved = g.localStorage;
  g.localStorage = fakeStorage();
  setServerUrl('http://10.0.0.5:3000');
  assert.equal(getServerUrl(), 'http://10.0.0.5:3000');
  g.localStorage = saved;
});
check('写入的是约定的那个 key', () => {
  const g = globalThis as { localStorage?: unknown };
  const saved = g.localStorage;
  const st = fakeStorage();
  g.localStorage = st;
  setServerUrl('http://x:1');
  assert.ok(st._dump()[SERVER_URL_KEY] === 'http://x:1', JSON.stringify(st._dump()));
  g.localStorage = saved;
});
check('传空字符串 → 清除配置，回落到默认值', () => {
  const g = globalThis as { localStorage?: unknown };
  const saved = g.localStorage;
  g.localStorage = fakeStorage();
  setServerUrl('http://x:1');
  setServerUrl('');
  // 测试环境不是 DEV、也不是原生 → 默认值应是当前 origin
  assert.notEqual(getServerUrl(), 'http://x:1', '不该还读得到旧值');
  g.localStorage = saved;
});
check('localStorage 抛异常时不崩溃（隐私模式）', () => {
  const g = globalThis as { localStorage?: unknown };
  const saved = g.localStorage;
  g.localStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.doesNotThrow(() => setServerUrl('http://x:1'));
  assert.doesNotThrow(() => getServerUrl());
  g.localStorage = saved;
});

console.log('\n=== 3b. 原生壳未配置时的失败方式（本来的坑）===');
check('原生壳 + 未配置 → defaultServerUrl() 返回 undefined（不猜 origin）', () => {
  const g = globalThis as { Capacitor?: unknown; localStorage?: unknown };
  const sc = g.Capacitor; const sl = g.localStorage;
  g.Capacitor = { isNativePlatform: () => true };
  g.localStorage = fakeStorage();
  assert.equal(defaultServerUrl(), undefined,
    '原生壳里 window.location.origin 是设备本机，绝不能当服务器地址用');
  g.Capacitor = sc; g.localStorage = sl;
});
check('原生壳 + 未配置 → getSocket() 明确报错，而不是静默连 localhost', () => {
  const g = globalThis as { Capacitor?: unknown; localStorage?: unknown };
  const sc = g.Capacitor; const sl = g.localStorage;
  g.Capacitor = { isNativePlatform: () => true };
  g.localStorage = fakeStorage();
  assert.throws(() => getSocket(), /服务端地址|设置/,
    '必须给出可读错误，否则玩家只会看到"一直连不上"');
  g.Capacitor = sc; g.localStorage = sl;
});
check('原生壳 + 已配置 → 能正常取到该地址', () => {
  const g = globalThis as { Capacitor?: unknown; localStorage?: unknown };
  const sc = g.Capacitor; const sl = g.localStorage;
  g.Capacitor = { isNativePlatform: () => true };
  g.localStorage = fakeStorage();
  setServerUrl(normalizeServerUrl('192.168.1.10:3000'));
  assert.equal(getServerUrl(), 'http://192.168.1.10:3000');
  g.Capacitor = sc; g.localStorage = sl;
});
check('网页版（非原生）仍默认同源，不需要玩家配置', () => {
  const g = globalThis as { Capacitor?: unknown; localStorage?: unknown; window?: unknown };
  const sc = g.Capacitor; const sl = g.localStorage; const sw = g.window;
  delete g.Capacitor;
  g.localStorage = fakeStorage();
  g.window = { location: { origin: 'http://example.test' } };
  assert.equal(defaultServerUrl(), 'http://example.test');
  g.Capacitor = sc; g.localStorage = sl;
  if (sw === undefined) delete g.window; else g.window = sw;
});

console.log('\n=== 4. 不变量 ===');
check('normalizeServerUrl 幂等（归一化两次结果一致）', () => {
  for (const raw of ['1.2.3.4:5', 'http://a.b', '/', 'https://c.d:9']) {
    const once = normalizeServerUrl(raw);
    assert.equal(normalizeServerUrl(once), once, `不幂等：${raw} → ${once}`);
  }
});
check('归一化结果要么为空、要么以协议头或 / 开头', () => {
  for (const raw of ['1.2.3.4', 'a.b', '/', '/x', '', 'https://q']) {
    const r = normalizeServerUrl(raw);
    assert.ok(r === '' || /^(https?:\/\/|\/)/i.test(r), `异常结果：${raw} → ${r}`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
