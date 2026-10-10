import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry, LogLevel } from '@gremlins/shared';
import {
  getRecentLogs, subscribeLogs, getLogLevel, setLogLevel,
  getLogCategories, setLogCategories, createLogger, clearLogs,
} from '../utils/logger.js';
import { useGameStore } from '../store/game.js';
import '../styles/debug-overlay.css';

const CATEGORIES = ['net', 'socket', 'store', 'ui', 'game', 'client'];

const log = createLogger('ui', 'debug');

export function DebugOverlay() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [activeCats, setActiveCats] = useState<Set<string> | null>(getLogCategories());
  const [level, setLevel] = useState<LogLevel>(getLogLevel());
  const [version, setVersion] = useState(0); // 强制重渲染
  const logsBoxRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const connected = useGameStore((s) => s.connected);
  const mySocketId = useGameStore((s) => s.mySocketId);
  const view = useGameStore((s) => s.view);
  const roomId = useGameStore((s) => s.roomId);

  // 热键：Ctrl+` 或 Ctrl+D 切换
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === '`' || e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        setOpen((v) => !v);
        log.info(`debug overlay ${open ? 'closed' : 'opened'}`);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 订阅日志变化
  useEffect(() => {
    if (!open) return;
    const unsub = subscribeLogs(() => setVersion((v) => v + 1));
    return unsub;
  }, [open]);

  // 自动滚动到底部
  useEffect(() => {
    if (open && autoScroll && logsBoxRef.current) {
      logsBoxRef.current.scrollTop = logsBoxRef.current.scrollHeight;
    }
  }, [version, open, autoScroll]);

  const allLogs = useMemo(() => getRecentLogs(), [version]);

  const filteredLogs = useMemo(() => {
    let arr = allLogs;
    if (activeCats) {
      arr = arr.filter((e) => activeCats.has(e.category.toLowerCase()));
    }
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      arr = arr.filter((e) =>
        e.message.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        (e.tag ?? '').toLowerCase().includes(q),
      );
    }
    return arr;
  }, [allLogs, activeCats, filter]);

  const stats = useMemo(() => {
    const byLevel: Record<string, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    const byCat: Record<string, number> = {};
    for (const e of allLogs) {
      byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
      byCat[e.category] = (byCat[e.category] ?? 0) + 1;
    }
    return { byLevel, byCat, total: allLogs.length };
  }, [allLogs]);

  if (!open) {
    return (
      <div className="debug-toggle-hint" title="按 Ctrl+` 或 Ctrl+D 切换调试面板">
        Ctrl+` 调试
      </div>
    );
  }

  const toggleCat = (cat: string) => {
    const cur = activeCats ? new Set(activeCats) : new Set(CATEGORIES);
    if (cur.has(cat)) cur.delete(cat);
    else cur.add(cat);
    if (cur.size === 0) {
      setActiveCats(null);
      setLogCategories('*');
    } else {
      setActiveCats(cur);
      setLogCategories(Array.from(cur).join(','));
    }
  };

  const changeLevel = (lvl: LogLevel) => {
    setLevel(lvl);
    setLogLevel(lvl);
  };

  const handleClear = () => {
    clearLogs();
    setVersion((v) => v + 1);
  };

  return (
    <div className="debug-overlay">
      <div className="debug-header">
        <h2>调试面板</h2>
        <div className="debug-stats">
          <span>共 {stats.total} 条</span>
          <span style={{ color: '#888' }}>D:{stats.byLevel.debug}</span>
          <span style={{ color: '#4dd0e1' }}>I:{stats.byLevel.info}</span>
          <span style={{ color: '#f1c40f' }}>W:{stats.byLevel.warn}</span>
          <span style={{ color: '#e74c3c' }}>E:{stats.byLevel.error}</span>
        </div>
        <span className="spacer" />
        <div className="debug-controls">
          <label>级别</label>
          <select value={level} onChange={(e) => changeLevel(e.target.value as LogLevel)}>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <label>过滤</label>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="关键字..."
            style={{ width: 120 }}
          />
          <label>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />{' '}
            自动滚动
          </label>
          <button className="debug-btn" onClick={handleClear}>清空</button>
          <button className="debug-btn" onClick={() => setOpen(false)}>关闭 (Esc)</button>
        </div>
      </div>

      <div className="debug-filter-bar">
        <span style={{ color: '#888', fontSize: 10 }}>类别:</span>
        <button
          className={`debug-cat-toggle ${activeCats === null ? 'active' : ''}`}
          onClick={() => { setActiveCats(null); setLogCategories('*'); }}
        >
          全部
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className={`debug-cat-toggle ${activeCats?.has(c) ? 'active' : ''}`}
            onClick={() => toggleCat(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="debug-logs" ref={logsBoxRef}>
        {filteredLogs.length === 0 && (
          <div style={{ color: '#666', padding: 20, textAlign: 'center' }}>暂无日志</div>
        )}
        {filteredLogs.map((e, i) => (
          <LogRow key={i} entry={e} />
        ))}
      </div>

      <div className="debug-footer">
        <span>
          连接: {connected ? '✓' : '✗'} | socket: {mySocketId.slice(0, 12) || '-'} | 视图: {view} | 房间: {roomId || '-'}
        </span>
        <span>热键: Ctrl+` 或 Ctrl+D 切换 · Esc 关闭</span>
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const ts = new Date(entry.ts).toISOString().slice(11, 23);
  const argStr = entry.args && entry.args.length > 0
    ? ' ' + entry.args.map((a) => formatArg(a)).join(' ')
    : '';
  return (
    <div className={`debug-log-row lvl-${entry.level} cat-${entry.category}`}>
      <span className="ts">{ts}</span>
      <span className="lvl">{entry.level}</span>
      <span className="cat">{entry.category}{entry.tag ? `:${entry.tag}` : ''}</span>
      <span className="msg">{entry.message}{argStr}</span>
    </div>
  );
}

function formatArg(a: unknown): string {
  if (a === null) return 'null';
  if (a === undefined) return 'undefined';
  if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return String(a);
  if (a instanceof Error) return a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}
