# 《地精公司》Gremlins, Inc. · 网页复刻版

> 局域网联机桌游复刻，支持 2-6 人对战，可打包成 Android App。
> 仅限局域网内部使用，仅供学习交流。

## 仓库

- **Gitee**: https://gitee.com/gisaacj/Gremlins_Inc2
- **GitHub**: https://github.com/gisaacj/Gremlins_Inc

## 技术栈

- **前端**：Vite + React 18 + TypeScript + Zustand
- **后端**：Node.js + Express + Socket.io（服务端权威）
- **棋盘**：SVG（直线连接、透明背景）
- **移动端**：Capacitor 6（同一套代码打包成 App）
- **数据**：从原版 `Assembly-CSharp.dll` 反编译导出 + 用户自定义棋盘坐标

## 目录结构

```
├── package.json              # 根（npm workspaces）
├── 地图.csv / 地图.txt        # 用户提供的 67 节点坐标与连线规则
├── shared/                   # 共享类型 + 数据 + 引擎
│   └── src/
│       ├── engine/           # 纯逻辑引擎（不依赖 node / 浏览器）
│       │   ├── state.ts      # 状态初始化 + 回合流程 + 格子结算
│       │   ├── interp.ts     # 动作解释器（94 种 ActionType / 228 组参数）
│       │   ├── options.ts    # 可选动作（建筑 / 站点）
│       │   ├── api.ts        # 对外 API（移动/打牌/选项/自动结束）
│       │   ├── ai.ts         # AI 对手
│       │   ├── abilities.ts  # 50 条角色能力 + 触发事件
│       │   ├── permanents.ts # 永久卡事件钩子
│       │   ├── model.ts      # 类型定义 + 棋盘索引
│       │   ├── local.ts      # 单机对局封装（LocalGame）
│       │   └── serialize.ts  # 客户端序列化 / 提示生成
│       ├── gamedata/         # 反编译数据
│       └── board-view.ts     # 棋盘 UI 视图（坐标渲染）
├── server/                   # 服务端
│   └── src/
│       ├── rooms.ts          # 房间管理 + Socket 事件
│       └── index.ts          # HTTP + Socket.io 启动
├── client/                   # 前端
│   └── src/{pages,components,store,styles}
├── tools/                    # 构建 / 推送 / 端到端脚本
└── docs/                     # 全部文档（见下）
```

## 启动方式

```bash
npm install

# 开发模式（server + client）
npm run dev

# 局域网部署
npm run build
npm run start:server
# 其他设备访问 http://<本机IP>:3000
```

## 数据规模（实测）

| 项目 | 数量 |
|---|---|
| 行动卡 | **186** 张（其中 34 张永久卡、26 张秘密卡、18 张罪恶卡） |
| 混沌卡 / 厄运卡 / 监狱卡 | 6 / **40** / 18 |
| 角色 | **12** 个（共 50 条能力） |
| 棋盘 | **67 格**（18 种格子类型） |
| 数据里出现的动作类型 | **94** 种，共 **228** 组 (动作, 参数) |
| 已实现动作 | **94 / 94**（无一个落到"尚未实现"） |

## 棋盘

当前使用用户自定义的 67 节点棋盘（`地图.csv` + `地图.txt`）：

- **67 格**：11 个建筑 + 56 个站点
- **82 条边**，直线连接，**0 交叉**
- **67/67 全部可达**，无孤岛节点
- 坐标从用户提供的像素值归一化到 0-100

### 建筑（11 个）

监狱 / 地狱 / 赌场 / 法院 / 藏宝阁 / 天界 / 银行 / 办公楼 / 工厂 / 垃圾场 / 市场

### 格子分两类（实测 18 种）

- **自动效果型（7 种）**：警察、收入、厄运、地狱、贿赂、藏宝阁、监狱
  —— 落地即结算（可能挂起问玩家）
- **可选动作型（11 种）**：银行、冒险、办公楼、演讲、工厂、垃圾场、市场、
  赌场、法院、天界、赌博
  —— 落地后给出按钮，由玩家决定做不做

## 回合流程（权威顺序）

```
Move → Conflict → UseCard → UseCell
```

1. **Move** —— 选一张牌移动到目的地
2. **Conflict** —— 与落点其他玩家交锋（出价，输者被捕）
3. **UseCard** —— 若赢了/无交锋，可打一张效果牌（需匹配当前格类型）
4. **UseCell** —— 结算本站效果 / 执行可选动作
5. **自动结束** —— 无可操作时自动交棒（服务端与单机都有这条收尾）

**落地顺序**：先交锋，**赢了留在格上**才处理格子效果。

## 验证体系（重点）

测试不是"按报过的 bug 写用例"，而是**按元素穷举成矩阵**。
5 个矩阵测试 + 44 个专项测试，共 **49 个测试文件 / 684 个 check**：

| 矩阵 | 覆盖对象 | 保证什么 |
|---|---|---|
| `matrix-card-move` | **全部 186 张行动卡** | 每张牌是否能移动；落点合法、步数一致、走完不卡死 |
| `matrix-cell` | **全部 67 格 / 18 种类型** | 每个站点走上去都能触发（自动效果或给出可选动作），0 卡死 |
| `matrix-card-effect` | **全部 250 张卡** | 每张牌打出都有效果（资源/挂起/日志至少一项），无"尚未实现"，需要选择就真挂起 |
| `matrix-character` | **全部 12 角色 / 50 条能力** | 每条能力都有登记、挂在**会被触发**的事件上、开局与回合都能推进 |
| `matrix-turn-order` | 顺序 + 不变量 | 落地留账给 UseCell、三条收尾路径一致、强随机压测不卡死 |

```bash
# 跑单个矩阵
npx tsx server/src/__tests__/matrix-card-move.test.ts
npx tsx server/src/__tests__/matrix-cell.test.ts
npx tsx server/src/__tests__/matrix-card-effect.test.ts
npx tsx server/src/__tests__/matrix-character.test.ts
npx tsx server/src/__tests__/matrix-turn-order.test.ts
```

另外还有三层回归：

- `tools/socket-e2e.mjs` —— 真起服务端 + 真 Socket 客户端端到端（10 项）
- `server/src/__tests__/playthrough.ts` —— 20 组对局模拟（5 seed × 2/3/4/5 人）
- 三端 `tsc --noEmit` 类型检查

## 已实现特性

- ✅ 自定义 67 节点棋盘（0 交叉，全部可达）
- ✅ **94 / 94 动作类型全部实现**（228 组参数组合逐一验过，无"尚未实现"）
- ✅ **250 张卡逐张验过"打出来有效果"**
- ✅ **186 张行动卡逐张验过"能用于移动"**
- ✅ **67 格逐格验过"走上去会触发"**
- ✅ **12 角色 50 条能力逐条验过"挂在会被触发的事件上"**
- ✅ 玩家交锋（出价 + 输者被捕）/ 警察格二选一 / 混沌卡 / 选举
- ✅ 完整中文卡面（250 张；显示层保证无占位符、无裸符号）
- ✅ AI 补位（出牌 / 移动 / 可选动作 / 混沌卡）
- ✅ 服务端权威 + 断线重连
- ✅ 单机模式（`LocalGame`）+ 联机模式共用同一套引擎

## 已知限制

- ⚠️ **移动端未在本仓库 CI 中自动构建**（`tools/build-apk.mjs` 可用，但需本机 Android 环境）
- ⚠️ `OpponentShowHand` 的 `SelectCards`（a176「公开性」）目前按"对手不揭开"结算，
  未提供"对手自己选揭几张"的交互
- ⚠️ `SelectPermanent` 里"由对方选择"的卡（a152「伪装卡牌」）默认取对方第一张永久卡，
  未提供对方选择交互
- ⚠️ 部分一次性效果在**同时作用于所有玩家**时，日志会合并成一条，不够细

详见 [`待办事项.md`](待办事项.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/规则总览.md`](docs/规则总览.md) | 常量 / 资源 / 回合流程的权威数值 |
| [`docs/回合流程.md`](docs/回合流程.md) | Move→Conflict→UseCard→UseCell 的逐步说明 |
| [`docs/动作清单.md`](docs/动作清单.md) | 全部 ActionType 与实现状态 |
| [`docs/行动卡.md`](docs/行动卡.md) | 186 张行动卡逐张数据 |
| [`docs/格子与站点.md`](docs/格子与站点.md) | 67 格 / 18 种类型的规则 |
| [`docs/建筑效果.md`](docs/建筑效果.md) | 11 个建筑的可选动作 |
| [`docs/特殊牌与角色.md`](docs/特殊牌与角色.md) | 永久卡 / 混沌 / 厄运 / 监狱 / 12 角色 |
| [`docs/资源系统.md`](docs/资源系统.md) | 6 种资源与符号 |
| [`docs/交锋与选举.md`](docs/交锋与选举.md) | 交锋出价、选举、镇长 |
| [`docs/移动端构建.md`](docs/移动端构建.md) | APK 打包步骤 |
| [`docs/测试矩阵.md`](docs/测试矩阵.md) | **5 个矩阵测试的覆盖范围与跑法** |
| [`docs/README.md`](docs/README.md) | 逐轮开发记录（最新在最上） |
