# engine —— 基于原版权威数据的引擎

**服务端与客户端共用的唯一引擎。**

- 服务端（`server/src/rooms.ts`）用它做权威判定
- 客户端单机模式（`LocalGame`）在浏览器里直接跑同一套逻辑与 AI

数据源：`shared/src/gamedata/`（从原版 `Assembly-CSharp.dll` 的 `DM.Init()` 导出），
管线见 [`test/tools/README.md`](../../../test/tools/README.md)。

## 模块

| 文件 | 职责 |
|---|---|
| [model.ts](model.ts) | 状态模型：玩家、棋盘索引、待决策、日志 |
| [resources.ts](resources.ts) | 资源操作 + `ActionParams` 语法解析 |
| [interp.ts](interp.ts) | 动作解释器（挂起 / 重放） |
| [permanents.ts](permanents.ts) | 永久卡 `Perm_*` 与事件钩子层 |
| [abilities.ts](abilities.ts) | 角色能力数据驱动注册表（49 条） |
| [state.ts](state.ts) | 初始化、移动（含岔路）、站点结算、回合流转、服刑回合 |
| [serialize.ts](serialize.ts) | 转协议 `SerializedGameState` / `PlayerPrompt` |
| [api.ts](api.ts) | 给调用方的稳定动作接口 |
| [ai.ts](ai.ts) | AI 策略（纯函数，服务端与单机共用） |
| [local.ts](local.ts) | `LocalGame`：单机对局门面 |

## 平台无关

引擎**不依赖任何平台 API**（无 `process` / `fs` / `Buffer` / `setTimeout` / `node:`），
所以同一份代码能同时跑在 Node 与浏览器：

```bash
grep -nE "require\(|process\.|node:|Buffer" shared/src/engine/*.ts   # 应为空
```

## 设计要点

**1. 数据驱动，不写特例**

原版把每张卡、每个角色能力都表达为**有序动作序列**（`ActionList`），
元素是 `ActionType` + `ActionParams`。例如卡 `a001`「游说」：

```
[ SelectOpponent("A96166AC656D0C4B"), OpponentLoseVotes("1") ]
```

`SelectOpponent` 本身不产生效果，只设定**后续动作的作用目标**。
所以引擎的核心是 `interp.ts` 的解释器，而不是 186 个 if/else。

**2. 隐式目标上下文**

| 动作 | 作用 |
|---|---|
| `SelectOpponent` / `SelectSelf` / `SelectEvil` / `SelectGovernor` | 写 `ctx.targets`（玩家） |
| `AllOpponents` / `AllPlayers` / `EvilPlayers` | 批量写 `ctx.targets` |
| `NameLocation` / `SelectDeckCard` / `SelectPermanent` | 写 `ctx.scratch`（非玩家目标） |

**3. 挂起 / 重放模型**

遇到 `Select*` 且没有答案时返回 `PendingChoice` 挂起。**挂起时不推进下标**，
玩家回答后从同一个选择动作重放，`applyChoice()` 把答案写进上下文并继续。

**4. 资源参数语法**

`ActionParams` 里的资源槽是**计算依据**，不是支付币种：

| 参数 | 含义 |
|---|---|
| `["250"]` | 固定金额 250 |
| `["Malice","20","Arrest"]` | 金额 = 玩家罪恶 × 20，**以金钱支付**；不足额则逮捕 |
| `["200","GetHalf","Arrest"]` | 固定 200，付出一半返还；不足额则逮捕 |

支付币种由动作原语决定（`OpponentPayScore` → 齿轮，`OpponentLoseVotes` → 选票）。

**5. 稳定标识，不用中文名**

旧实现用中文名字符串判定角色（`name === '工程师'`），数据一改就断。
现在一律用原版内部名（`Engineer`）或 UIN。

**6. 移动不受地点限制**

**全部 186 张卡都带 `CellID`**（连移动牌也有），不存在"地点不限"的卡。
但卡面写的是"使用此卡牌的**站点**"——地点限制只作用于**到建筑后打出效果**。

| 函数 | 用途 | 校验内容 |
|---|---|---|
| `canMoveWithCard` | 用牌移动 | 持有 + 有移动点数 + 付得起费用 |
| `canPlayCard` | 在建筑打效果 | 上面这些 + 当前格子类型 == 卡牌 `CellTypeId` |

**7. 牌堆构成**

主牌堆只放**行动卡**（按 `DeckCount` 展开，共 225 张）。

- `DeckCount == 0` 表示不入牌库（如 `a159`），不能用 `max(1,..)` 补一张
- **混沌卡是事件卡**，结构不同（没有移动点数、不能持在手上），不能混进主牌堆

**8. 入狱不是死锁**

服刑回合走 `takeJailTurn()`：抽一张监狱卡按其 `actions` 结算，
可能减刑/加刑/获释/拿收入；刑期归零即出狱。

**9. 永久卡：事件钩子层**

33 张永久卡的 `Perm_*` 动作分两类：

| 类别 | 例子 | 处理方式 |
|---|---|---|
| 数值型 | `Perm_Income(10)` → 收入 +10 | 打出时一次性落地 |
| 触发型 | `Perm_CasinoMoney(25)` → 任意玩家进赌场时持卡者 +25 | 注册到事件，时机到了才触发 |

`PERM_TRIGGERS` 把每个 `Perm_*` 原语映射到「触发事件 + 作用域 + 数值来源」，
引擎在 28 个事件点调用 `fireTrigger()`。

**踩过的坑**：一次性激活若用广播（`fireTrigger('cardActivated')`），
刚打出的卡会连带触发**别人**已激活的 `Perm_*` 效果 —— 实测「寡头」会把自己弃掉。
所以必须用 `onlyCardId` 限定到刚打出的那张卡。已固化成回归测试。

**10. 角色能力（数据驱动）**

`abilities.ts` 把 12 个角色的 **49 条能力**做成注册表，按角色内部名索引，
**不再用 `characterName` 硬编码分派**。触发点与永久卡并列：

| 事件 | 时机 |
|---|---|
| `gameStart` | 开局（原型试样、恶魔之仆、未付账单…） |
| `visitHome` | 造访主场（薪资、法院人脉） |
| `afterRoll` | 掷骰后（赌注 6、安慰奖 1） |
| `afterPlayCard` | 打牌后（有利秘密、恶有恶报、黑暗契约、返现、加班费） |
| `afterMove` | 移动后（动起来、停止、印花税） |
| `arrest` | 被捕时（秘密关系按 6 判刑、穷人勿进改送垃圾场） |
| `turnStart` / `turnEnd` | 回合两端（平民主义、钱生钱） |
| `skipMove` | 跳过一次走牌（买卖） |

**关键坑**：

1. `ActionParams` 前两个参数是**文本 UIN**，数值从第 3 个起
2. 不能按 `ActionType` 字面直译——`OpponentSkipTurn` 挂在移动牌上时表示
   「**你自己**跳过下一回合」（卡牌代价），不是让对手跳过。
   所以每条能力的语义都能在**原版英文说明**里找到对应句子
   （`GameCharacter.text.description` 的分节说明）
3. `createState` 会按 **StepOrderNum 重排玩家**，调用方不能用 `players[0]`
   假设输入顺序

**11. 骰子规则写在格子的 `Label1..6` 里，不要猜**

格子类型（`GCellType`）的 `Label1..6` 就是**该格六个骰子点数的结算表**，
`{N}` 指向 `Param1..6`。这是**唯一权威来源**，按直觉写公式会错：

| 格子 | `Label` 给出的真实规则 |
|---|---|
| Casino | `1,2,3 = -100,-50,-25$`；`4,5,6 = +25,+50,+100$` |
| Junkyard | `1 = -1&`；`2,3 = 无事`；`4,5,6 = +10,+20,+30$` |
| Risk | `1 = 厄运`；`2 = -50$`；`3 = -1&,+1^`；`4,5,6 = +50$,+2&,+100$` |
| Tribune | `6 / 5,6 / 4,5,6 / 3,4,5,6 / 2,3,4,5,6 = +1&`（对应下注 10~50） |
| Jail | `1,2 = {3}`；`3,4 = {2}`；`5,6 = {1}`（`{N}` → `params[N-1]`） |
| Treasure | `1..6 = +10,+25,+50,+100,+150,+200$` |

解析器在 `options.ts` 的 `parseDiceTable()`，测试在
`server/src/__tests__/dice-tables.test.ts`（35 项，含"旧错误实现会失败"的回归锁）。

⚠️ 两个已踩的坑：

- **Casino / Risk 不是"最低点数→奖金"的递增表**，而是逐点映射（含负收益）
- **Tribune 的 `{N}` 参数表与 Label 是逐档对应的**，而 `diceTableOf()` 会把
  同一结果按点数合并（多个档位共享同一结果），所以 tribune **必须按档位逐行解析**，
  不能拿合并表按下标取档位

**12. `BUTTON` 是"二选一"，且必须**按组**处理**

原版用一张牌里的**两个 `BUTTON`** 表达"两害取其轻"，各带一条分支动作：

```
m020  BUTTON ["-$150","Money","150"]   BUTTON ["-*2"]
      SelectSelf / OpponentLoseMoney    SelectSelf / OpponentLoseScore
说明: -{1}$（你必须拥有{1}$）或 -{2}*
```

按钮文案两种形态（见 `dialog.ts` 的 `parseButtonLabel`）：

| 形态 | 例子 | 处理 |
|---|---|---|
| 符号语法 | `-$150`、`+^4`、`-*2`、`+^5 +*1` | 符号在数字**前面**，解析成「-150 金钱」 |
| 十六进制 UIN | `CACBE81C8D511C3D` | 换算成十进制查文案表 → 「丢弃」 |

⚠️ 三个坑（都踩过）：

1. **`ActionParams` 里的 UIN 是十六进制**，而文案表按十进制索引。
   直接拿十六进制串查表必然查不到 —— 按钮文案会变成一串十六进制。
2. **两个 `BUTTON` 与它们的分支共用一条动作列表**。选完分支 0 后，
   主循环会继续走到分支 1 的动作，导致**两条分支都结算**。
   所以 `BUTTON` 要按"组"处理：只跑选中分支（用子 `ActionContext`），
   然后跳到组末尾。
3. **分支 0 的起点紧邻 `BUTTON` 自己**。若用"把 index 设回 branchStart - 1"
   来跳转，会自跳成死循环。按组处理 + `ctx.scratch` 记账可避免。

另外 `drawMisfortune` 必须**接收** `runActions` 的返回值并写回 `state.pending`，
否则厄运牌里的决策会被静默跳过。

**13. 有些原语要读「卡牌自身」的 params，动作参数是空的**

`Auction` 的 `ActionParams` 是 `[""]`，但两种形态完全不同：

| 卡 | 说明 | **卡牌** params | 结算 |
|---|---|---|---|
| a061 拍卖 | 最高者付价并 +出价额 齿轮 | `[3]` | 只最高者付钱 |
| m031 总统造访 | 所有出价都付，最低者 -出价额 齿轮 | `[2]` | 全员付钱 |

所以 `ActionContext` 带上了 `sourceCardId`（由 `state.ts` / `interp.ts` 的
三个调用点传入，并随 `PendingChoice.resume` 一起快照），
`handleAuction` 用它回查卡牌 params。**不要**从 `action.params` 里找。

**14. 玩家交锋（Player Conflict）是一次两方拍卖**

两位玩家停在**同一非建筑站**时触发（建筑可容纳任意人数）：

> 每位玩家出价。出价最高的玩家付款并留在该站点，另一位玩家被逮捕。
> 如果出价相等，则 `^` 最少的玩家获胜。

- 挂起 kind 为 `conflict:<challengerId>:<defenderId>`，逐个收价，
  `state.pendingInput` 暂存双方出价（**不**放在 `ctx.scratch`，
  因为这些输入不属于动作序列）
- 结算在 `settleConflict()`：赢家付自己的出价（钱给银行，不是给对手），
  输家 `arrest()`
- 统计字段 `conflictTotal / conflictInit / conflictWon / conflictPaid`
  对应原版 `GPlayer` 的 `ConflictTotal / ConflictInit / ConflictWon / ConflictPaid`
  （字段名是从 DLL 里挖出来的），并通过协议 `player.conflicts` 暴露给客户端
- 触发 `playerConflict` / `loseConflict` 两个永久卡钩子

**出价是数值输入，不是固定档位**：DLL 的 `ComConflictWindow` 协议里有
`MaxResultValue`（最大可出价）与 `Answer.Result`（回传的数值）。
所以 `bidOptions()` 按"持有金钱"生成档位（含"全押"），引擎按数值结算。

**15. 岔路口必须由玩家选路**

真实地图**不是单环，而是分支图**。普通地图 67 格的出度分布：

```
出度 1: 51 格（纯走廊）   出度 2: 11 格
出度 3:  3 格             出度 4:  2 格
```

即 **16 个真正的岔路口**。移动拆成 `startMove()` + `MoveCursor`：

- 走廊（出度 1）自动前进
- 岔路口（出度 > 1）抛 `moveBranch:N` 挂起，等玩家选方向，再续跑剩余步数
- 走完清理 `moveCursor` 与残留 `pending`

界面上是"点目的地 → 确认"，所以 `api.ts` 的 `moveWithCard()` 会**按目的地自动选岔路**
（每个候选方向都算一次"剩余步数能否走到目的地"，唯一可行或唯一最短时才自动选）。

## 单机模式

`LocalGame`（[local.ts](local.ts)）让客户端脱离服务端跑完整对局：

```ts
const g = new LocalGame({
  roomId: 'local',
  seats: [
    { id: 'me',  name: '我',    isAI: false, characterId: engineerId },
    { id: 'ai1', name: 'AI 1', isAI: true,  characterId: bankerId },
  ],
  targetScore: 30,
  think: (state) => { runAIPlayers(state); },   // 注入 AI 策略
});

g.move('me', cardId, destTileId);
g.runAI();                    // 让 AI 行动到轮到人类
g.viewFor('me');              // 序列化状态（与联机同一形状）
g.promptFor('me');            // 该做什么
```

AI 策略在 [ai.ts](ai.ts)，服务端与单机共用同一份，避免两套行为不一致。

## 棋盘布局

原作 `GMap` 只存图结构（`OutCells`/`InCells`），**没有坐标**——UI 布局要自己算。
`gamedata/board-layout.ts` 由 `test/tools/gen-board-layout.mjs` 生成：

1. 从监狱出发抽一条主干道（优先走出度 1 的走廊）
2. 主干铺成圆环
3. 其余格按到主干的最短距离向外分层展开
4. 归一到 0..100

校验项（数据层 smoke test）：每格坐标都在 0..100、岔路口列表与出度 > 1 的格一致、
主干格不重复、**任意两格最小间距 3.79**（不重叠）。

## 验证

```bash
# 引擎（在 server 下跑，测试文件在 server/src/__tests__）
npx tsx server/src/__tests__/engine.test.ts            # 引擎 24 项
npx tsx server/src/__tests__/permanents.test.ts        # 永久卡 26 项
npx tsx server/src/__tests__/abilities.test.ts         # 角色能力 34 项
npx tsx server/src/__tests__/local-game.test.ts        # 单机对局 11 项
npx tsx server/src/__tests__/server-integration.test.ts # 服务端集成 18 项
npx tsx server/src/__tests__/playthrough.ts 30         # 30 回合自动对局

# 数据层与棋盘（在 test/ 下）
node test/tools/smoke-gamedata.mjs      # 23 项
node test/tools/smoke-board-view.mjs    # 19 项

# 端到端（需服务端已启动）
node test/tools/e2e-socket.mjs http://127.0.0.1:3000 8000   # 14 项
```

各测试的重点：

- **永久卡 / 角色能力**里有多条**防漏实现的元测试**：注册表必须覆盖数据里出现的
  全部原语，且每个角色的能力条数与数据一致。防止后续加内容时静默漏实现
- **服务端集成**验证序列化字段形状（`position` 是格 id 而非下标、资源字段名、
  日志 `round → turn` 映射）、提示按视角生成
- **单机对局**验证无需服务端也能跑完整局（AI 互战到分出胜负）
- **端到端**连真 socket.io 跑「建房 → 加 AI → 走完 pick3 选角 → 开局 → 移动」

## 覆盖进度

| 类别 | 状态 |
|---|---|
| 目标选择（`Select*`）、作用域、资源增减与转移 | ✅ |
| 移动（真实邻接 + 岔路选路）、传送、反向移动 | ✅ |
| 回合流程、选举、逮捕/释放/刑期/服刑回合、监狱卡 | ✅ |
| 永久卡 `Perm_*`（33 种 + 28 个事件点） | ✅ |
| 角色能力（49 种，数据驱动） | ✅ |
| 服务端接入（rooms / ai / 协议）+ 单机模式 | ✅ |
| 可选动作的交互流程（办公楼再打一张、冒险格弃牌、卖收入） | 🔶 规则已登记，缺 UI 交互 |
| `BUTTON`（对话框确认，厄运牌高频） | 🔶 非阻塞 |
| `Auction` / `CompareResource` 等交互型原语 | 🔶 |
| 混沌卡触发时机（事件卡，不在手牌） | 🔶 待设计 |

未实现的 `ActionType` 会在日志里留下「效果「X」尚未实现」，
便于按实际对局暴露的频次排优先级，而不是盲目铺满 143 种。

## 下一步

1. **可选动作的交互流程**：停在办公楼再打一张、冒险格弃牌、卖收入、收入格二选一
2. `BUTTON` / `Auction` / `CompareResource` 等交互型原语
3. 移动端：Capacitor 打包链路未受影响，但需真机验证本轮协议变更
4. 客户端包体：引擎进客户端后 gzip 约 150 KB，若需优化可把
   `gamedata` 改为运行时按需加载 JSON
