# 权威数据层

`shared/src/gamedata/` 下的数据**全部来自原版游戏本体**，不是 OCR 识别、也不是照着设计文档手写的。

- 数据来源：`D:\Steam\steamapps\common\Gremlins\Gremlins_Inc_Data\Managed\Assembly-CSharp.dll`
  （与导出目录 `test/Assembly-CSharp.dll` 的 SHA256 完全一致）
- 原始数据定义在 `Assembly-CSharp/GServer/DM.cs` 的 `DM.Init()` 中
- 文案键为原版 UIN，文本来自 `Resources` 里的 `Loc/<Language>` 语言包

## 为什么用「执行」而不是「解析」

`DM.Init()` 在内存里逐条构造 186 张卡、2 张地图、12 个角色等对象。与其解析 25058 行 C# 字面量，
不如加载游戏原生 Unity 程序集并**直接调用这个方法**，再把对象图序列化成 JSON —— 没有翻译误差。

## 重新生成

需要 64 位 Windows PowerShell（.NET Framework）与 Steam 版游戏本体。

```powershell
cd test

# 1. 从 DLL 导出 DM 的权威数据（约 1 分钟）
. .\tools\extract-dm.ps1          # 或: Invoke-Expression (Get-Content .\tools\extract-dm.ps1 -Raw)

# 2. 用游戏自身的 GBufferReader 解析 13 种语言包
. .\tools\extract-strings.ps1

# 3. 生成 shared/src/gamedata/*.ts 并构建
node tools\gen-shared-data.mjs

# 4. 为真实棋盘拓扑算渲染坐标（原作 GMap 没有坐标）
node tools\gen-board-layout.mjs

# 5. 校验（23 项：规模 / 已知数值 / 引用完整性 / 文案 / 棋盘布局）
cd ..\shared; npx tsc -p tsconfig.json
cd ..\test;   node tools\smoke-gamedata.mjs
```

> 脚本无法通过 `-File` 直接运行（本机执行策略禁止脚本文件），需用 `Invoke-Expression` 方式调用。

## 产物

`shared/src/gamedata/`（生成物，来自原版数据）：

| 模块 | 内容 |
|---|---|
| `enums.ts` | 18 种格子类型、4 种费用类型、**143 种动作原语** `ActionType` |
| `cards.ts` | 186 张行动卡（含旗标/费用/收获/`Param1..6`/动作序列/中英文案） |
| `board.ts` | 2 张地图共 131 格，含原版 `OutCells`/`InCells` 邻接关系 |
| `board-layout.ts` | 按拓扑算出的渲染坐标 + 岔路口列表（原作无坐标） |
| `characters.ts` | 12 个角色（`order` 即原版行动顺序）+ 18 张监狱卡 |
| `decks.ts` | 6 张混沌卡、40 张厄运卡、18 种格子类型定义、`GConst` 数值常量 |
| `strings.ts` | 770 条 UIN 文案 × 中/英 |
| `text.ts` | 原版资源符号与 `{n}` 占位符的解析函数 |

`shared/src/`（手写消费层，服务于 gamedata）：

| 模块 | 内容 |
|---|---|
| `board-view.ts` | 把真实拓扑转成 UI 需要的「格子 + 边」，含移动可达遍历、边弯曲辅助 |
| `card-display.ts` | 从结构化数值派生卡面文案（成本/收获/地点/主题）与角色技能条目 |

## 顶层导出就是权威数据（唯一数据源）

`@gremlins/shared` 顶层的 `CARD_BY_ID` / `CHARACTERS` / `BOARD_MAPS` 等名字
**直接指向 `gamedata`**。

**OCR 数据已删除**（`shared/src/data/`、`game_data.ts`、`shared/data/`，
以及过渡用的 `legacy-bridge.ts`）。删除原因是一个真实踩坑：之前顶层被
`data/index.js` 遮蔽，`BOARD_MAPS` 直接是 `undefined`、`CARD_BY_ID` 拿到 OCR 版，
导致 `cardMoveSteps('action_card_游说')` 返回 0（应为 3）——**同名两套数据**。

旧引擎（`server/src/engine/`）同样已删除，服务端统一使用 `server/src/engine2/`。

## 几个已确认的原版约定

**资源符号**（`CAvatarForm` / `CACardForm` / `CChaosCardForm`）

| 符号 | 含义 | 符号 | 含义 |
|---|---|---|---|
| `$` | 金钱 | `~` | 贿赂 |
| `&` | 选票 | `\|` | 收入 |
| `^` | 罪恶 | `*` | 齿轮（分数） |

文案里的 `{1}..{6}` 对应卡牌的 `Param1..Param6`。
`formatGameText()` 会把符号归一化成 `[[money]]` 这类标记，客户端可决定渲染成图标还是文字。

**id 空间**（容易混淆，务必注意）

- `Card.cellTypeId` 指向 **`CellTypeDef.id`**（该卡能在哪类格子打出），例如 `a001` → `Office`；
  它**不是**棋盘格 id。
- 棋盘格 `BoardCell.cellTypeId` 也指向 `CellTypeDef.id`；格子的文案继承自该格子类型。

**语言包二进制格式**（`GBufferReader.ReadString` 用 `Encoding.Unicode`）

```
int32 count
count × ( 8 字节 UIN | int32 byteLen | byteLen 字节 UTF-16LE 文本 )
```

## 与旧数据的区别

`shared/src/data/` 与 `shared/src/game_data.ts` 是**基于游戏截图 OCR** 的历史数据，
数值错误较多。已确认的例子：

| 卡 a001「游说」 | OCR 数据 | 权威数据 |
|---|---|---|
| 移动点数 | 8 ❌ | **3** |
| 费用 | 20 金钱 ❌ | **50 金钱** |
| 收获 | 掷骰子相关 ❌ | **+3 选票** |

两者目前并存（`gamedata` 以命名空间导出，避免重名）。引擎按原作规则重写时统一迁移到
`gamedata`，随后删除 OCR 数据与 `test/` 导出目录。

## 随包语言

目前只打包 `zh` + `en` 以控制体积。其余 11 种语言已导出在 `test/data/strings/`，
改 `tools/gen-shared-data.mjs` 里的 `SHIPPED_LANGS` 即可启用。
