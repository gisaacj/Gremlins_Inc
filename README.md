# 《地精公司》Gremlins, Inc. · 网页复刻版

> 局域网联机桌游复刻，支持 2-6 人对战，可移植到 Android/iOS。
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
Gremlins_Inc-master/
├── package.json              # 根（npm workspaces）
├── 地图.csv                  # 用户提供的 67 节点坐标
├── 地图.txt                  # 用户提供的连线规则
├── shared/                   # 共享类型 + 数据 + 引擎
│   └── src/
│       ├── engine/           # 纯逻辑引擎
│       │   ├── state.ts      # 状态初始化 + 回合流程 + 站点结算
│       │   ├── interp.ts     # 动作解释器（143 种 ActionType）
│       │   ├── options.ts    # 可选动作（建筑/站点）
│       │   ├── api.ts        # 对外 API（移动/打牌/选项/自动结束）
│       │   ├── ai.ts         # AI 对手
│       │   ├── abilities.ts  # 49 条角色能力
│       │   ├── permanents.ts # 28 个永久卡事件钩子
│       │   ├── model.ts      # 类型定义 + 棋盘索引
│       │   └── serialize.ts  # 客户端序列化
│       ├── gamedata/         # 反编译数据
│       │   ├── custom-board.ts  # 自定义 67 节点棋盘
│       │   ├── cards.ts      # 186 张行动卡
│       │   ├── board.ts      # 原版棋盘（用于角色起始格映射）
│       │   └── ...
│       └── board-view.ts      # 棋盘 UI 视图（坐标渲染）
├── server/                   # 服务端
│   └── src/
│       ├── rooms.ts          # 房间管理 + Socket 事件
│       └── index.ts          # HTTP + Socket.io 启动
└── client/                   # 前端
    └── src/
        ├── pages/            # 菜单/大厅/游戏/结算
        ├── components/        # 棋盘/手牌/HUD
        ├── store/            # Zustand store
        └── styles/
```

## 启动方式

```bash
# 安装
npm install

# 开发模式（server + client）
npm run dev

# 局域网部署
npm run build
npm run start:server
# 其他设备访问 http://<本机IP>:3000
```

## 棋盘

当前使用用户自定义的 67 节点棋盘（`地图.csv` + `地图.txt`）：

- **67 格**：11 个建筑 + 56 个站点
- **82 条边**，直线连接，**0 交叉**
- **67/67 全部可达**，无孤岛节点
- 坐标从用户提供的像素值归一化到 0-100

### 建筑（11 个）

| 建筑 | cell ID | 格子类型 |
|------|---------|----------|
| 监狱 | 1 | Jail |
| 地狱 | 9 | Inferno |
| 赌场 | 15 | Casino |
| 法院 | 20 | Courthouse |
| 藏宝阁 | 26 | Treasure |
| 天界 | 36 | Astral |
| 银行 | 43 | Bank |
| 办公楼 | 47 | Office |
| 工厂 | 52 | Plant |
| 垃圾场 | 57 | Junkyard |
| 市场 | 62 | Marketplace |

### 站点规则（对照反编译）

| 格子 | OptionalFlag | 路过 | 停留 |
|------|:---:|------|------|
| 收入 | false | +1x 收入 | +2x 收入 |
| 贿赂 | false | 付贿赂(不足+1罪恶) | 付 2x 贿赂 |
| 厄运 | false | 抽厄运牌 | 抽厄运牌 |
| 冒险 | false | 不触发 | 买保险→掷骰→1=厄运 |
| 藏宝阁 | false | 不触发 | 自动掷骰 |
| 地狱 | false | 不触发 | 扣 100 金抽 1 牌 |
| 警察 | true | 不触发 | 贿赂 vs 掷骰 |
| 赌博 | true | 不触发 | 可选掷骰 |
| 演讲 | true | 不触发 | 可选下注 |

## 角色

- **12 个角色**，随机分配不重复（原版 `RandomFromThree` 规则）
- 按角色 `StepOrderNum` 排序行动顺序
- 各角色出生点不同（按格子类型+序号映射）：
  - Engineer → 工厂 / Politician → 天界 / Gambler → 赌场
  - SecretAgent → 厄运5 / Thief → 监狱 / Banker → 银行 ...

## 卡牌

- **186 张行动卡**（牌库 225 张）+ **34 张永久卡** + **40 张厄运牌** + 18 张监狱牌 + 6 张混沌卡
- **143 种 ActionType 全部实现**
- a059「二手货」：选对手→随机弃其一张牌→以其移动点数行走→对手补 1 张
- 移动后手牌中可在当前格打出的牌**高亮显示**（绿色脉冲发光）

## 回合流程

1. **Begin** → 角色被动触发
2. **Move** → 选牌移动（路过站点自动结算 + 终点结算）
3. **UseCard** → 可选打一张效果牌（需匹配当前格类型）
4. **UseCell** → 可选建筑动作（投资/赌博/寻宝等）
5. **自动结束** → 无可操作时自动换人

## 已实现特性

- ✅ 自定义 67 节点棋盘（0 交叉，全部可达）
- ✅ 站点规则对照反编译（路过厄运抽厄运、冒险格弹窗、藏宝阁自动掷骰）
- ✅ 角色随机分配不重复 + 按类型映射出生点
- ✅ a059 二手货移动机制（选对手弃牌）
- ✅ 回合自动结束（无可操作时自动换人）
- ✅ 移动后手牌高亮（当前格可打出的牌绿色脉冲）
- ✅ 143 种 ActionType + 49 条角色能力 + 28 个永久卡事件
- ✅ 玩家交锋 / 警察格二选一 / 混沌卡 / 选举
- ✅ AI 补位（出牌/移动/可选动作/混沌卡）
- ✅ 服务端权威 + 断线重连

## 已知限制

- ⚠️ 监狱系统未按反编译的 JailRank(0-4) 实现（当前简化为 term-=1）
- ⚠️ 贿赂金错误地给了镇长（应归银行）
- ⚠️ 角色三选一 UI 未实现（当前随机分配）
- ⚠️ 移动端从未真机验证

详见 [`待办事项.md`](待办事项.md)。
