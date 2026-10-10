import { io, type Socket } from 'socket.io-client';
import type { C2SEvents, S2CEvents } from '@gremlins/shared';
import { loggers } from '../utils/logger.js';

// Socket 类型参数：<Listen=服务端发往客户端, Emit=客户端发往服务端>
export type GameSocket = Socket<S2CEvents, C2SEvents>;

let socket: GameSocket | null = null;

/** 运行时可配置的服务端地址在 localStorage 里的键 */
export const SERVER_URL_KEY = 'gremlins.serverUrl';

/** 是否运行在 Capacitor 原生壳里（而非普通浏览器） */
export function isNativeApp(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

/**
 * 安全读取 Vite 的 `import.meta.env`。
 *
 * ⚠️ 不能直接写 `import.meta.env.VITE_SERVER_URL`：在**非 Vite 环境**
 * （Node 里跑测试、或某些 SSR/打包场景）`import.meta.env` 是 `undefined`，
 * 直接取属性会抛 `Cannot read properties of undefined`。
 */
function viteEnv(): Record<string, string | boolean | undefined> {
  const meta = import.meta as unknown as { env?: Record<string, string | boolean | undefined> };
  return meta.env ?? {};
}

/**
 * 移动端默认的服务端地址。
 *
 * ⚠️ 原生壳里**不能**用 `window.location.origin`：Capacitor 的 WebView
 * 把页面放在自己的本地 scheme 上（Android 默认 `https://localhost`），
 * 所以 origin 指的是**设备本机**，不是我们的服务器。
 * 不处理的话，APK 装上后会一直连不上（`capacitor.config.ts` 里那句
 * "实际部署时在 App 内设置中填写服务端 IP" 就是留的这个坑）。
 *
 * 返回 `undefined` 表示"还没配置，需要玩家填"。
 */
export function defaultServerUrl(): string | undefined {
  const env = viteEnv();
  const configured = env.VITE_SERVER_URL as string | undefined;
  if (configured) return configured;
  if (env.DEV) return '/';
  // 原生壳：必须由玩家/打包方指定
  if (isNativeApp()) return undefined;
  // 普通浏览器：与服务端同源部署是默认形态
  if (typeof window === 'undefined') return undefined;
  return window.location.origin;
}

/** 读取已保存的服务端地址（没有则返回默认值） */
export function getServerUrl(): string | undefined {
  try {
    const saved = globalThis.localStorage?.getItem(SERVER_URL_KEY);
    if (saved) return saved;
  } catch {
    // localStorage 在某些隐私模式下会抛异常 —— 忽略即可
  }
  return defaultServerUrl();
}

/**
 * 保存服务端地址，并**断开现有连接**，让下次 `getSocket()` 用新地址重连。
 *
 * @param url 空字符串表示清除回默认值
 */
export function setServerUrl(url: string): void {
  try {
    if (url) globalThis.localStorage?.setItem(SERVER_URL_KEY, url);
    else globalThis.localStorage?.removeItem(SERVER_URL_KEY);
  } catch {
    // 同上，忽略
  }
  disconnectSocket();
}

/**
 * 归一化玩家输入的服务端地址。
 *
 * 允许玩家直接填 `192.168.1.10:3000` 这种简写——补上协议头，
 * 否则 socket.io 会把它当相对路径。
 */
export function normalizeServerUrl(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return s;              // 相对路径，保持原样
  return `http://${s}`;
}

export function getSocket(): GameSocket {
  if (socket) return socket;
  const url = getServerUrl();
  if (!url) {
    // 原生壳且未配置：不建立连接，抛出明确错误让 UI 提示去设置里填地址。
    // 静默连到 localhost 只会让玩家看到"一直连不上"，更难排查。
    throw new Error('尚未配置服务端地址：请在「设置」里填写服务器 IP 和端口');
  }
  loggers.socket.info(`connecting to ${url}`);
  socket = io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionAttempts: 10,
  });
  socket.on('connect', () => {
    loggers.socket.info(`connected id=${socket?.id}`);
  });
  socket.on('disconnect', (reason) => {
    loggers.socket.warn(`disconnected reason=${reason}`);
  });
  socket.on('connect_error', (err) => {
    loggers.socket.error(`connect_error ${err.message}`);
  });
  // socket.io v4: 重连事件需要通过 socket.io.on 监听
  socket.io.on('reconnect_attempt', (attempt) => {
    loggers.socket.info(`reconnect_attempt #${attempt}`);
  });
  socket.io.on('reconnect', (attempt) => {
    loggers.socket.info(`reconnected after #${attempt} attempts`);
  });
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    loggers.socket.info('disconnectSocket()');
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
