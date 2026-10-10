import fs from 'node:fs';
import path from 'node:path';
import type { Logger, LogLevel, LogEntry } from '@gremlins/shared';
import { LEVEL_PRIORITY, parseLevel, parseCategories } from '@gremlins/shared';

// =============================================================
// 配置（环境变量）
//   LOG_LEVEL   = debug|info|warn|error   默认 info
//   LOG_CATS    = * 或 net,room,engine     默认 *
//   LOG_FILE    = 日志文件路径             默认 logs/server.log
//   LOG_NO_FILE = 1 禁用文件输出           默认 启用文件输出
//   LOG_NO_COLOR= 1 禁用 ANSI 颜色         默认 启用颜色（tty 时）
// =============================================================

const LEVEL: LogLevel = parseLevel(process.env.LOG_LEVEL, 'info');
const CATEGORIES: Set<string> | null = parseCategories(process.env.LOG_CATS);
const LOG_FILE: string = process.env.LOG_FILE || path.resolve(process.cwd(), 'logs/server.log');
const FILE_DISABLED: boolean = process.env.LOG_NO_FILE === '1';
const COLOR_DISABLED: boolean = process.env.LOG_NO_COLOR === '1';

// ANSI 颜色码
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: C.gray,
  info: C.cyan,
  warn: C.yellow,
  error: C.brightRed,
};

const CATEGORY_COLOR: Record<string, string> = {
  net: C.magenta,
  room: C.green,
  engine: C.blue,
  ai: C.yellow,
  server: C.cyan,
};

// 文件输出流（懒初始化，确保目录存在）
let fileStream: fs.WriteStream | null = null;
function getFileStream(): fs.WriteStream | null {
  if (FILE_DISABLED) return null;
  if (fileStream) return fileStream;
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    return fileStream;
  } catch {
    return null;
  }
}

// 启动时打印一次配置
function logConfig(): void {
  const enabledCats = CATEGORIES ? Array.from(CATEGORIES).join(',') : '*';
  // 不写入文件，仅 stdout
  const line = `${C.gray}[logger] level=${LEVEL} cats=${enabledCats} file=${FILE_DISABLED ? 'off' : LOG_FILE}${C.reset}`;
  process.stdout.write(line + '\n');
}
logConfig();

/** 实际输出一条日志 */
function emit(entry: LogEntry): void {
  // 级别过滤
  if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[LEVEL]) return;
  // 类别过滤
  if (CATEGORIES && !CATEGORIES.has(entry.category.toLowerCase())) return;

  const ts = new Date(entry.ts).toISOString();
  const cat = entry.category;
  const catColor = CATEGORY_COLOR[cat] ?? C.cyan;
  const lvlColor = LEVEL_COLOR[entry.level];
  const tagStr = entry.tag ? ` ${C.dim}[${entry.tag}]${C.reset}` : '';

  const msg = entry.message;
  const argsStr = entry.args && entry.args.length > 0 ? ' ' + entry.args.map(formatArg).join(' ') : '';

  // stdout（带颜色）
  if (!COLOR_DISABLED) {
    const line = `${C.gray}${ts}${C.reset} ${lvlColor}${entry.level.padEnd(5)}${C.reset} ${catColor}${cat.padEnd(7)}${C.reset}${tagStr} ${msg}${argsStr}`;
    process.stdout.write(line + '\n');
  } else {
    const line = `${ts} ${entry.level.padEnd(5)} ${cat.padEnd(7)} ${tagStr ? `[${entry.tag}] ` : ''}${msg}${argsStr}`;
    process.stdout.write(line + '\n');
  }

  // 文件输出（无颜色）
  const fs_ = getFileStream();
  if (fs_) {
    const plain = `${ts} ${entry.level.padEnd(5)} ${cat.padEnd(7)} ${entry.tag ? `[${entry.tag}] ` : ''}${msg}${argsStr}\n`;
    fs_.write(plain);
  }
}

function formatArg(a: unknown): string {
  if (a === null) return 'null';
  if (a === undefined) return 'undefined';
  if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return String(a);
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** 创建一个 logger */
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

/** 预创建一些常用 logger */
export const loggers = {
  server: createLogger('server'),
  net: createLogger('net'),
  room: createLogger('room'),
  engine: createLogger('engine'),
  ai: createLogger('ai'),
};
