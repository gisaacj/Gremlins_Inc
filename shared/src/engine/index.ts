// =============================================================
// engine —— 基于原版权威数据的引擎（服务端与客户端共用）
//
// 数据源见 `../gamedata/`，抽取管线见 `test/tools/README.md`。
//
// 本模块**不依赖任何平台 API**（无 process / fs / Buffer / setTimeout），
// 因此可以同时跑在 Node（服务端权威）与浏览器（单机模式）。
//
// 模块职责：
//   model.ts       状态模型（玩家 / 棋盘索引 / 待决策 / 日志）
//   resources.ts   资源操作与 ActionParams 语法
//   interp.ts      动作解释器（挂起 / 重放）
//   permanents.ts  永久卡 Perm_* 与事件钩子
//   abilities.ts   角色能力数据驱动注册表
//   state.ts       初始化、移动（含岔路）、站点结算、回合流转、服刑
//   serialize.ts   转协议 SerializedGameState / PlayerPrompt
//   api.ts         给调用方（server / AI / 客户端单机）的稳定动作接口
// =============================================================
export * from './model.js';
export * from './resources.js';
export * from './permanents.js';
export * from './abilities.js';
export * from './dialog.js';
export * from './options.js';
export * from './interp.js';
export * from './state.js';
export * from './serialize.js';
export * from './api.js';
export * from './ai.js';
export * from './local.js';
