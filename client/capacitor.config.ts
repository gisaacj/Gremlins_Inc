import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置。
 *
 * ============================================================
 * ⚠️ 移动端联机为什么必须这么配（三层限制，缺一层就连不上）
 * ============================================================
 *
 * 我们的服务端是**明文 HTTP**（`http://<IP>:3000`），而 Android 有三层
 * 互相独立的限制。之前只修了第 1 层，于是手机上仍然报
 * `TypeError: Failed to fetch`（**即时**失败，不是超时 —— 请求根本没发出去）。
 *
 * 第 1 层 · Android app 明文策略（API 28+ 默认禁止明文）
 *     → 由 `AndroidManifest.xml` 的 `android:usesCleartextTraffic="true"`
 *       与 `res/xml/network_security_config.xml` 解决。
 *
 * 第 2 层 · WebView **混合内容**（Mixed Content）  ← 之前漏的就是这个
 *     `androidScheme: 'https'` 会让页面源变成 `https://localhost`。
 *     从 https 源去请求 `http://...` 属于混合内容，Android WebView
 *     **默认直接拒绝**，抛 `TypeError: Failed to fetch`。
 *
 *     实证（`@capacitor/android` 6.2.2 源码）：
 *       CapConfig.java:46   `private boolean allowMixedContent = false;`
 *       Bridge.java:575     `if (this.config.isMixedContentAllowed())`
 *       Bridge.java:576         `settings.setMixedContentMode(MIXED_CONTENT_ALWAYS_ALLOW);`
 *     即**默认不设置** mixed content 模式 → WebView 用系统的
 *     `MIXED_CONTENT_NEVER_ALLOW` → `fetch('http://...')` 立即失败。
 *
 *     修法（两道保险，都开）：
 *       a) `server.androidScheme: 'http'` —— 源变成 `http://localhost`，
 *          "http 页面请求 http 接口"是同 scheme，**根本不产生混合内容**。
 *          （Capacitor 文档明确只支持 `http` / `https` 两种 scheme。）
 *       b) `android.allowMixedContent: true` —— 万一将来改回 https 源，
 *          WebView 也不会拦跨 scheme 请求。
 *          ⚠️ 注意它属于**顶层 `android` 节**，不是 `server` 节
 *          （CapConfig.java 读的键就是 `android.allowMixedContent`）。
 *
 * 第 3 层 · Capacitor WebView 自身的明文开关
 *     `server.cleartext: true` —— 让 WebView 允许明文 HTTP。
 *     注意：这与 manifest 那个 `usesCleartextTraffic` 是**两回事**，
 *     后者管"应用进程的网络策略"，前者管"WebView 内部"。
 *
 * 结论：三层都要开。少任何一层，App 都会在发出请求前就被拦掉。
 */
const config: CapacitorConfig = {
  appId: 'com.gremlinsinc.web',
  appName: '地精公司',
  webDir: 'dist',
  server: {
    // 第 2 层 a)：http 源，从根上避免 https→http 的混合内容
    androidScheme: 'http',
    // 第 3 层：允许 WebView 使用明文 HTTP（与 manifest 的开关互不替代）
    cleartext: true,
    // 保持 localhost：Capacitor 文档建议保留，以维持安全上下文
    hostname: 'localhost',
  },
  android: {
    // 第 2 层 b)：保险 —— 即使源是 https 也允许跨 scheme 请求
    allowMixedContent: true,
    // 联机失败时能用 Chrome 的 chrome://inspect 看 WebView 控制台
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1a1a2e',
    },
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
