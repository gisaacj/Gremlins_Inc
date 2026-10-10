// =============================================================
// 日志系统共享接口
// =============================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 默认日志级别（可被环境变量覆盖） */
export const DEFAULT_LEVEL: LogLevel = 'info';

/** 一条日志记录的结构 */
export interface LogEntry {
  ts: number;          // 时间戳
  level: LogLevel;
  category: string;    // 模块分类（net/room/engine/ai/client...）
  tag?: string;        // 子标签（如 socket id、房间号）
  message: string;
  args?: unknown[];    // 附加参数
}

/** 日志输出器接口，server 和 client 各有实现 */
export interface Logger {
  readonly category: string;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** 创建带子标签的子 logger（如 logger.child(roomId)） */
  child(tag: string): Logger;
}

/** 解析级别字符串 */
export function parseLevel(s: string | undefined, fallback: LogLevel = DEFAULT_LEVEL): LogLevel {
  if (!s) return fallback;
  const v = s.toLowerCase().trim();
  if (v in LEVEL_PRIORITY) return v as LogLevel;
  return fallback;
}

/** 解析类别白名单（逗号分隔，'*' 表示全部） */
export function parseCategories(s: string | undefined): Set<string> | null {
  if (!s || s === '*' || s === 'all') return null; // null = 全部启用
  return new Set(s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
}
