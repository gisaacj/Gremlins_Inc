# 《地精公司》Gremlins, Inc. · 网页复刻版

> 局域网联机桌游复刻，支持 2-6 人对战，可移植到 Android/iOS。
> 仅限局域网内部使用，仅供学习交流。

## 技术栈

- **前端**：Vite + React 18 + TypeScript + Zustand
- **后端**：Node.js + Express + Socket.io（服务端权威）
- **棋盘**：SVG + CSS（轻量、可缩放、移动端友好）
- **移动端**：Capacitor 6（同一套代码打包成 App）
- **状态管理**：Zustand
- **数据**：TypeScript 数据模块（卡牌 201 张 + 厄运 38 个 + 角色 12 套 + 完整棋盘）

## 目录结构

```
小魔怪/
├── package.json              # 根（npm workspaces）
├── tsconfig.base.json
├── shared/                   # 共享类型 + 数据
│   └── src/
│       ├── types.ts          # 类型定义（资源/卡牌/棋盘/玩家/状态）
│       ├── protocol.ts       # Socket.io 事件协议
│       └── data/             # 卡牌/棋盘/角色/厄运数据
├── server/                   # 服务端（权威引擎 + Socket.io）
│   └── src/
│       ├── engine/           # 纯逻辑引擎
│       │   ├── state.ts      # 状态初始化 + 基础状态变更
│       │   ├── rng.ts        # 可种子化随机
│       │   ├── movement.ts   # 路径计算
│       │   ├── stations.ts   # 7种站点效果结算
│       │   ├── cards.ts      # 卡牌打出/碰撞/赌博
│       │   ├── election.ts   # 镇长选举
│       │   ├── turn.ts       # 回合状态机
│       │   └── serialize.ts  # 客户端序列化
│       ├── rooms.ts          # 房间管理 + Socket 事件
│       ├── ai.ts             # AI 对手
│       └── index.ts          # HTTP + Socket.io 启动
└── client/                   # 前端（Vite + React + Capacitor）
    └── src/
        ├── pages/            # 菜单/大厅/角色选择/游戏/结算
        ├── components/        # 棋盘/手牌/HUD
        ├── store/            # Zustand store
        ├── net/              # Socket.io 客户端
        ├── styles/
        └── main.tsx
```

## 启动方式

### 开发模式（同时启动 server + client）

```bash
npm install
npm run dev
```

- 服务端：http://localhost:3000
- 客户端：http://localhost:5173（Vite 会代理 /socket.io 到服务端）

### 局域网部署

```bash
# 1. 构建产物
npm run build

# 2. 启动服务端
npm run start:server

# 3. 用静态服务器托管 client/dist
npx serve client/dist
```

同一局域网内其他设备通过 `http://<本机IP>:3000` 访问，并在客户端 UI 中输入服务端 IP。
（Capacitor App 中需要用户在设置中填写服务端 IP）

### 移动端打包（Capacitor）

```bash
# 1. 添加原生平台（首次）
cd client
npx cap add android
# 或 npx cap add ios

# 2. 构建 + 同步
cd ..
npm run mobile:sync

# 3. 在 Android Studio / Xcode 中打开
npm run mobile:open:android
# 或 npm run mobile:open:ios
```

## 玩法说明

详见 `设计文档.md`，这里给出要点：

- **每回合 3 个决策点**：移动用哪张牌 → 到达建筑后打哪张牌 → 资源怎么花
- **3 种核心资源 + 1 胜利资源**：金币 / 选票 / 罪恶值 / 齿轮
- **胜利条件**：率先达到目标齿轮数（默认 30，可在房间配置 15-60）
- **选举**：每 20 回合举行，选票最多者当选镇长，享多项特权
- **碰撞**：移动到他人所在格触发碰撞，对方被送回监狱
- **AI**：房间可加 AI 补位，策略简化但可玩

## 网络协议

详见 `shared/src/protocol.ts`：

- **C2S**：`room:create/join/leave/ready/select_character/start/add_ai/update_config`，`game:select_move_card/play_card/skip_play/police_choice/gamble_bet/active_ability/sync`，`chat:send`
- **S2C**：`room:state/character_select`，`game:start/state/patch/prompt/log/over/ai_thinking`，`error`，`chat:recv`

## 已实现特性

- ✅ 完整 4 阶段回合循环（移动 → 站点结算 → 建筑打牌 → 补牌）
- ✅ 7 种站点效果（收入/贿赂/警察/厄运/赌博/演讲/危险）
- ✅ 11 个建筑分支
- ✅ 12 个角色被动/主动技能
- ✅ 201 张主牌堆 + 6 张暴乱卡（可开关）
- ✅ 38 个厄运事件
- ✅ 罪恶值/贿赂/选举联动
- ✅ 碰撞与传送（监狱/地狱）
- ✅ 永久卡持续效果（Robot Bureaucrat/One-armed Robber 等）
- ✅ 房间制联机 + 断线重连
- ✅ AI 补位（房主可加 AI 凑人数）
- ✅ 服务端权威：所有操作服务端校验
- ✅ 移动端响应式 UI（窄屏切换竖向布局）

## 后续可扩展

- 客户端预测 + 服务端回滚（降低延迟感）
- 单元测试（引擎纯函数已具备可测性）
- 卡牌编辑器（数据驱动，便于扩展）
- 团队模式（2v2 / 3v3）
- 计时器（房间配置已含 turnTimerSec，未触发）
- 主动技能 UI（引擎已实装 active_ability，UI 可补足）

## 日志系统（本地调试用）

服务端和客户端都有结构化日志，按 **级别**（debug/info/warn/error）+ **类别**（net/room/engine/ai/store/socket/ui/game）分类输出。

### 服务端

启动时自动打印当前配置，并在 `logs/server.log`（相对 server 工作目录）追加无色日志，stdout 同步输出彩色 ANSI 日志。

环境变量调参：

```bash
# cmd / PowerShell
set LOG_LEVEL=debug          # 默认 info
set LOG_CATS=net,engine      # 默认 *（全部）；只看指定类别
set LOG_NO_FILE=1            # 禁用文件输出
set LOG_NO_COLOR=1           # 禁用颜色

# 或 bash
LOG_LEVEL=debug LOG_CATS=net,room npm run dev:server
```

示例输出：
```
2026-10-05T05:18:26.245Z info  ai      AI AI 1 auto-pick deputy
2026-10-05T05:18:26.246Z info  engine  game started firstPlayer=XBzItZI5 turn=1
2026-10-05T05:18:26.248Z info  engine  move Alice: card=告密 steps=5 from=0 path=[1,2,3,4,5]
```

### 客户端

所有日志同时输出到浏览器 Console（彩色 CSS）和内存环形缓冲（500 条）。

**调试面板**：浏览器里按 `Ctrl + \`` 或 `Ctrl + D` 切换全屏调试面板，支持：
- 级别筛选（debug/info/warn/error）
- 类别多选（net/store/socket/ui/game/client）
- 关键字过滤
- 自动滚动开关
- 一键清空
- 实时显示连接状态/socket id/当前视图/房间号

也可在 Console 里直接调整：
```js
localStorage.setItem('LOG_LEVEL', 'debug')   // 持久化级别
localStorage.setItem('LOG_CATS', 'net,store') // 持久化类别白名单
location.reload()
```

或在 `.env.local`（Vite）：
```
VITE_LOG_LEVEL=debug
VITE_LOG_CATS=*
```

### 排查"按钮没反应"等问题

最简流程：
1. 看服务端 stdout 是否有 `[logger] level=info cats=* file=...`——没有说明 server 没启动（端口占用？）
2. 看 client Console 是否有 `socket:connected`——没有说明连接失败
3. 打开 DebugOverlay（`Ctrl + \``），按 `net`/`store` 类别筛，能看到每次 emit 和 recv 的完整链路
