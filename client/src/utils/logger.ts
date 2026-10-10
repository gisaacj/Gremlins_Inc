import type { Logger, LogLevel, LogEntry } from '@gremlins/shared';
import { LEVEL_PRIORITY, parseLevel, parseCategories } from '@gremlins/shared';

// =============================================================
// 配置（通过 localStorage 持久化，或导入期 env）
//   localStorage.LOG_LEVEL = debug|info|warn|error
//   localStorage.LOG_CATS  = * 或 net,store,ui
// 启动时也读取 Vite env: VITE_LOG_LEVEL / VITE_LOG_CATS
// =============================================================

function readLevel(): LogLevel {
  const fromLs = typeof localStorage !== 'undefined' ? localStorage.getItem('LOG_LEVEL') : null;
  if (fromLs) return parseLevel(fromLs, 'info');
  const fromEnv = (import.meta.env as any)?.VITE_LOG_LEVEL;
  return parseLevel(fromEnv, 'info');
}

function readCats(): Set<string> | null {
  const fromLs = typeof localStorage !== 'undefined' ? localStorage.getItem('LOG_CATS') : null;
  const fromEnv = (import.meta.env as any)?.VITE_LOG_CATS;
  return parseCategories(fromLs ?? fromEnv);
}

let CURRENT_LEVEL: LogLevel = readLevel();
let CURRENT_CATS: Set<string> | null = readCats();

export function setLogLevel(level: LogLevel): void {
  CURRENT_LEVEL = level;
  try { localStorage.setItem('LOG_LEVEL', level); } catch {}
}
export function setLogCategories(cats: string): void {
  CURRENT_CATS = parseCategories(cats);
  try { localStorage.setItem('LOG_CATS', cats); } catch {}
}
export function getLogLevel(): LogLevel { return CURRENT_LEVEL; }
export function getLogCategories(): Set<string> | null { return CURRENT_CATS; }

// =============================================================
// 环形缓冲（DebugOverlay 用）
// =============================================================

const BUFFER_SIZE = 500;
const ringBuffer: LogEntry[] = [];
const listeners = new Set<(entries: LogEntry[]) => void>();

export function getRecentLogs(): LogEntry[] {
  return ringBuffer.slice();
}

export function clearLogs(): void {
  ringBuffer.length = 0;
  notifyListeners();
}

export function subscribeLogs(fn: (entries: LogEntry[]) => void): () => void {
  listeners.add(fn);
  fn(getRecentLogs());
  return () => { listeners.delete(fn); };
}

function notifyListeners(): void {
  const snapshot = getRecentLogs();
  listeners.forEach((fn) => {
    try { fn(snapshot); } catch {}
  });
}

// =============================================================
// console 颜色（CSS）
// =============================================================

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: 'color:#888;font-style:italic',
  info: 'color:#4dd0e1',
  warn: 'color:#f1c40f;background:rgba(241,196,15,0.1);padding:1px 4px;border-radius:3px',
  error: 'color:#e74c3c;background:rgba(231,76,60,0.1);padding:1px 4px;border-radius:3px',
};

const CAT_STYLE: Record<string, string> = {
  net: 'color:#e91e63',
  store: 'color:#2ecc71',
  ui: 'color:#9b59b6',
  socket: 'color:#f39c12',
  client: 'color:#3498db',
  game: 'color:#f5b800',
};

const consoleFn: Record<LogLevel, 'log' | 'info' | 'warn' | 'error'> = {
  debug: 'log',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

// =============================================================
// emit
// =============================================================

function emit(entry: LogEntry): void {
  // 环形缓冲总是先存（这样切换级别后能看历史）
  ringBuffer.push(entry);
  if (ringBuffer.length > BUFFER_SIZE) ringBuffer.shift();
  notifyListeners();

  // 级别过滤
  if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[CURRENT_LEVEL]) return;
  // 类别过滤
  if (CURRENT_CATS && !CURRENT_CATS.has(entry.category.toLowerCase())) return;

  const ts = new Date(entry.ts).toISOString().slice(11, 23); // HH:mm:ss.SSS
  const catStyle = CAT_STYLE[entry.category] ?? 'color:#888';
  const lvlStyle = LEVEL_STYLE[entry.level];

  const prefix = `%c${ts}%c ${entry.level.padEnd(5)}%c ${entry.category.padEnd(7)}%c${entry.tag ? ` [${entry.tag}]` : ''}`;
  const styles = [
    'color:#888',
    lvlStyle,
    catStyle,
    'color:inherit',
  ];

  const args = entry.args && entry.args.length > 0 ? entry.args : [];
  const fn = console[consoleFn[entry.level]];
  if (args.length > 0) {
    fn(prefix, ...styles, entry.message, ...args);
  } else {
    fn(prefix, ...styles, entry.message);
  }
}

export function createLogger(category: string, tag?: string): Logger {
  const log = (level: LogLevel, args: unknown[]) => {
    const message = typeof args[0] === 'string' ? args[0] : '';
    const rest = message ? args.slice(1) : args;
    emit({
      ts: Date.now(),
      level,
      category,
      tag,
      message,
      args: rest,
    });
  };
  return {
    category,
    debug: (...args: unknown[]) => log('debug', args),
    info: (...args: unknown[]) => log('info', args),
    warn: (...args: unknown[]) => log('warn', args),
    error: (...args: unknown[]) => log('error', args),
    child(subTag: string): Logger {
      const newTag = tag ? `${tag}:${subTag}` : subTag;
      return createLogger(category, newTag);
    },
  };
}

export const loggers = {
  client: createLogger('client'),
  net: createLogger('net'),
  socket: createLogger('socket'),
  store: createLogger('store'),
  ui: createLogger('ui'),
  game: createLogger('game'),
};
