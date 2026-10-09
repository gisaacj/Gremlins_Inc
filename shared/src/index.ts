export * from './types.js';
export * from './protocol.js';
export * from './logger.js';
export * from './board-view.js';
export * from './card-display.js';

/**
 * 权威数据层：直接从原版 Assembly-CSharp.dll (GServer.DM) 导出。
 *
 * 这是**唯一**的数据源。OCR 时期的近似数据（含手写数字棋盘）已删除——
 * 那些数值错误较多（例如卡 a001 的移动点数被识别成 8，实际是 3）。
 *
 * 数据管线见 `test/tools/README.md`。
 */
export * from './gamedata/index.js';
