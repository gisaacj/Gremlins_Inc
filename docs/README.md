# 《地精公司》网页复刻 · 规则文档索引

> 本文档集的目标：**按反编译代码把原版规则梳理清楚，作为网页版实现的唯一依据**。
> UI/音乐等后续处理，优先保证逻辑一致。

---

## 〇、⚠️ 先读：本次审计的时效性更正

**第三节的"更正清单"曾经严重过时。**

整理文档时我读的是**较早的分支**，而仓库当前实现（GitHub `master`）
**已经修掉了其中大部分**。后来做了一次逐项实测审计（读引擎源码 + 跑行为），结论：

| 文档原列的更正 | 实测结果 |
|---|---|
| 起始金钱 200 / 收入 30 | ✅ **已实现** |
| 贿赂付不出 = 固定 +1 罪恶 | ✅ **已实现** |
| 经过生效的格子只有 Income/Bribe/Misfortune | ✅ **已实现**（`resolvePassThrough` 过滤 + switch 仅此三 case） |
| 「借口编造器」1d6 ≥ 4 | ✅ **已实现** |
| 演讲格 = 下注 + 掷骰门槛 | ✅ **已实现**（含 `Label1..5` 档位解析） |
| Danger 停留掷骰（含 40$ 保险） | ✅ **已实现** |
| Risk 停留掷骰奖金表 | ✅ **已实现** |
| 天界电梯 = 图结构加边 | ✅ **已实现**（`astralFromBank`） |
| `ELECTION_SCORE_BONUS` 不该被使用 | ✅ 确实**未被使用**（与原版一致） |
| 选举按罪恶判定 | ✅ **已按罪恶判定** |
| **监狱 rank 系统** | ❌ 原先**缺失** → **本轮已实现** |
| **监狱每回合抽牌 2/2/3/3/4** | ❌ 原先**缺失** → **本轮已实现** |
| `m029` 玩家 ≥5 剔除 | ❌ 仍未实现 |
| `targetScore` 默认 30 | ⚠️ 原版 `GOAL_SCORE_1 = 10`（可配置 10..100），当前默认 30 偏高 |

**教训**：文档里的"更正清单"是**某时间点的快照**，不是长期缺陷表。
落地前必须**实测审计**，不要直接照改。

### 本轮已实现：监狱 rank 系统

依据全部来自反编译源码（详见 [`建筑效果.md`](建筑效果.md) / [`规则总览.md`](规则总览.md)）：

- 升级经验门槛 `JAIL_RANK_1..5_TERM` = **5 / 7 / 8 / 10 / 3**
- 每回合候选监狱牌数 `GetJailCardLimit()` = **2 / 2 / 3 / 3 / 4**
- 等级名 = **新手 / 农民 / 恶棍 / 二把手 / 老大**
- `ChangeRes` 的 `Term` 分支：满门槛 → 升级；**rank 4 再满 → 折成齿轮**
- **两个字段必须区分**：`JailTerm`（剩余刑期）vs `Resources.Term`（监狱经验）
- 教程："每在狱中待一回合获得 1 点监狱经验"
- 「全部拒绝」= +1 罪恶、刑期 −1（`CellType_Jail_Decline_Final`）
- 候选受 `GJailCard.Rank`（解锁等级）与 `Karma`（表现 −1/0/+1）约束

`takeJailTurn` 现在会**挂起让玩家从 N 张候选里选一张**
（候选只有 1 张时直接结算），结算走 `resolveJailPick`，
挂起 kind 为 `JAIL_PICK_KIND`，由 `resolvePending` 分流。

新增测试 `server/src/__tests__/jail-rank.test.ts`（20 项）。

### 本轮已实现：卡牌「移动时效果」（[m] / [i]）

**这是覆盖面最大的一个缺口**：原版一张行动卡的说明里有 `[m]` / `[i]` 两段，
但它们**不在 `ActionList` 里**，所以生成的数据只留了整条动作序列，
引擎**无从区分"在站点打出"与"用它移动"**，这 17 张卡移动时的规则整体丢失。

审计后发现关键结构：原版把两种用法写在**同一条 `ActionList`** 里，
用 `MOVE` 当分界线——

```
MOVE() → SelectSelf() → OpponentLoseMoney(20)          ← MOVE 之后 = 移动时触发
Teleport(...) → MOVE() → AddTurn(1) → SelectSelf() → …  ← 之前 = 站点打出时
```

这与说明里的 `[m]` 段**逐字对得上**。现在数据里多存两个字段：

| 字段 | 内容 |
|---|---|
| `moveText` | `[m]` 段原文（英文；中文表常被截断成只剩标记符） |
| `moveActions` | `MOVE` 之后的动作，可直接执行 |
| `handText` | `[i]` 段原文（留在手中、交锋时触发） |

**取文本时必须同时看两个来源并取更完整的那个**：语言包对这批卡常被截断
（a015 的语言包只给 `"[m]"`，JSON `Description` 才给完整句）。

结果：**17 张卡全部覆盖**，其中 16 张效果落在 `moveActions`
（扣钱/加罪恶/扣选票/跳过回合/逆行/改为掷骰/用对手的牌移动…），
唯一例外 **a066「巧夺先机」** 的效果存在 `SpecialMove(20)` 的参数里
（付 20$ 把移动点数改成 4），不在 `MOVE` 之后，已在测试中单独钉住。

新增测试 `server/src/__tests__/card-move-effects.test.ts`（21 项）。

### 本轮另一处修正

`targetScore` 缺省值原为魔法数 `30`，现改为读权威常量
`GAME_CONST.GOAL_SCORE_1`（= **10**）。原版这是**可配置**的 19 档（10..100），
客户端 Lobby 早已暴露该配置（`targetCogs`），只是引擎缺省值不对。

### 本轮实现之二：**负参数约定**（一类静默失效的 bug）

审计卡牌数据时发现全库有 **24 处负参数**，涉及 8 种动作，而引擎有两处写错了方向：

| 动作 | 旧实现 | 问题 | 正确语义 |
|---|---|---|---|
| `OpponentLoseMoney(-20)` | `payAmount` → `transferRes` 里 `Math.max(0, …)` | 负值被**夹成 0**，效果静默消失 | 目标 **+20$** |
| `OpponentLose{Votes,Score,Malice,Income}(-N)` | `if (amount > 0)` | 负值被**直接跳过** | 目标 **+N** |
| `AddTurn(-1)` | `extraTurns += 1` | 写死 +1，**方向反了** | **减少** 1 次额外走牌 |

第 2 行那个 `if (amount > 0)` 影响最大——a017/a019/a074/a150 等卡的"获得"分支
**整体无效**。第 3 行的 `AddTurn` 更隐蔽：`m038` 的 `AddTurn(-1)` 本意是"少走一次"，
旧实现反而**多给一次**。

修完后另外三种动作（`ChangeTerm` / `SelectBonus` / `MoneyRoll`）核对下来**本就正确**，
负值分别表示"减少刑期" / "二选一里的减项" / "掷骰金额表"。

新增测试 `negative-params.test.ts`（13 项）钉住这套约定。

### 本轮实现之一：卡牌**移动时效果接入引擎**

数据侧补齐（见下）之后，`startMove` 走完时执行 `card.moveActions`。
注意这与"在站点打出效果"是**同一张卡的两种用法、两个时机**，
`MOVE` 之前的动作仍属站点效果，互不干扰。

新增测试 `card-move-exec.test.ts`（13 项），用真实卡牌走真实移动流程验证：
a015 移动 −20$、a017 +1^、a019 −1&、a074 +20$、a150 +50$、
a076/a123 移动后跳过 1 回合、a031 逆行、a140 移动 −50$ 且 −1^。

### 本轮实现：交锋用牌（`[i]` 段，留在手中时触发）

只有 2 张卡带 `[i]` 段，都是**交锋相关**，且都发生在"判定胜负之后、付款之前"：

| 卡 | 规则 | 实现 |
|---|---|---|
| **a099「保险政策」** | 交锋**胜出**时可弃掉此卡，**改为不付钱** | 弃卡 → 跳过付款（`conflictPaid` 不增加） |
| **a070「敲诈！」** | 交锋中可弃掉此卡，把对手挪到离自己一格的位置（可逆行），且**对手付你 50$** | 对手付 Param1 → 出价**照付**（此卡不免付）→ 对手被捕 |

为此把 `settleConflict` 拆成两段：
`decideConflict`（纯判定，无副作用）+ `applyConflictOutcome`（扣款/统计/钩子/逮捕），
中间插入"是否打出手中的 `[i]` 卡"的挂起。

**过程中抓到两个自己写的 bug**：
1. a070 的位移被 `arrest()` 覆盖——逮捕会把输家送进监狱格，所以位移必须
   **记下来、等逮捕之后再放**（否则测试看到对手落在 Jail 而不是相邻格）。
2. 重构时把 `conflictInit` 写成 `+= 0`，导致"引发交锋"统计失效——
   由既有测试 `conflict.test.ts` 抓到。

另：`conflict.test.ts` 的 `fight()` 辅助现在会**清空双方手牌**，
以便与 `[i]` 卡特性隔离（否则赢家手里有 a070/a099 时会多一次挂起）。

新增测试 `conflict-hand-cards.test.ts`（17 项）。

### 本轮实现：厄运牌堆的两条规则（含"按人数改卡池"）

原版 `GGame.nonlockedMFPickCard()` 里构造牌堆的代码（同一段连着写了两遍，
因为"抽完立即重洗"也走这里）暴露了两件事：

```csharp
foreach (card in DM.MisFortuneCards)
    for (int j = 0; j < card.DeckCount; j++) list.Add(card.ID);   // 按 DeckCount 展开
UIN[] array = list.OrderBy(x => GGame.GetNextInt32(rnd)).ToArray();  // 洗牌
for (int k = 0; k < array.Length; k++)
    if (this.Players.Count < 5 || !(array[k] == "F7C040EC0741FE1C"))
        this.MFCDeck.AddFirst(array[k]);                         // ★ 人数规则
```

| 规则 | 说明 |
|---|---|
| **按 `DeckCount` 展开** | 引擎原先直接 `MISFORTUNE_CARDS.map(c => c.id)`，忽略了 `DeckCount`（当前 40 张恰好都是 1，所以没暴露，但语义是错的） |
| **玩家 ≥5 人剔除 m029** | `F7C040EC0741FE1C` = **m029「丢失的债券」**。5 人及以上时这张牌不进牌堆（40 → 39 张）。这是原版少见的"按人数改卡池"规则 |

实现：新增 `buildMisfortuneDeck(state)` 统一构造（`interp.ts`），
`createState` 与 `drawMisfortune` 的"抽完重洗"都走它。

⚠️ **构造时机有坑**：人数规则依赖 `state.players.length`，
而 `createState` 里原先在玩家填好**之前**就构造牌堆 → 规则永远不生效。
已改到玩家排序之后构造（测试专门覆盖了 2/3/4/5/6 人五种情况）。

新增测试 `misfortune-deck.test.ts`（16 项）。

### 顺带修掉一个"看运气"的测试

`jail-rank.test.ts` 的「服刑 5 回合后应升到 rank 1」在洗牌顺序变化后失败——
原因是它从牌堆随机抽牌，而监狱牌里有 **t051「特赦」**（直接释放），
抽到就提前出狱，5 回合根本走不满。

这是**测试脆弱**而不是引擎问题：改为把牌堆固定成"不含释放牌"的集合，
把变量控制在"经验累积"这一件事上。

### 本轮：中文截断的结论 + 参数 tag 审计（查出 3 个静默错误）

#### 一、中文截断 → 确认**只是显示问题**

之前列过"44 张卡中文被截断"。这次把口径放宽（长度比 < 0.55 或缺失）
重新统计，实际受影响 **168 张**（31 张中文为空 + 137 张疑似截断）。

关键验证：**这些卡的效果是否完整存在于 `ActionList`/`Income`/`Outcome`？**

| 检查项 | 结果 |
|---|---|
| `ActionList` 为空且无 `Income`/`Outcome` | **0 张** |
| 含引擎未实现的动作 | **0 处** |

→ **效果不依赖文案**，中文截断只影响显示。这是个好消息：不必为了正确性
去补 168 条文案，只需在 UI 层做兜底（无中文时显示英文）。

#### 二、真正的问题：`ActionParams` 里的**语义 tag**

`ActionParams` 里除数字与 UIN，还有 57 种**有语义的字符串 tag**
（如 `Evil` / `GetHalf` / `Bribe`）。它们最容易被当成"无用字符串"忽略掉，
一旦忽略就**静默改变效果**。逐个核对后确认 **3 个是真漏实现**：

| tag | 卡 | 旧行为（错） | 正确语义 |
|---|---|---|---|
| `Governor` | **a090** | 忽略门控 → **非总督打出也白拿 +300$、+3^** | 只有当前总督才生效（不满足则**整段跳过**） |
| `Percent` | a139 | `firstNumber` 取到 50 → **固定扣 50** | 扣目标 **50% 的金钱** |
| `Poorest` | a011 | 忽略 → 永远只收 50 | 出牌者最穷时**金额翻倍** |

`Governor` 那条最严重：实测确认非总督打出 a090 会凭空 +300$、+3^。

实现要点：
- `Governor` 做成 `handleResourceLoss` 开头的**通用门控**，
  与既有 `OpponentArrest(Evil)` 的"不满足就跳过"语义一致；
- `Percent` 在 `OpponentLoseMoney` 分支内按目标当前持有量计算；
- `Poorest` 翻倍逻辑放在 `payAmount` 的 `poorestDouble` 开关里——
  `resources.ts` 拿不到全局玩家列表，无法自行判断谁最穷，必须由调用方告知。

⚠️ 顺带避坑：本想直接 import `abilities.isPoorest`，但 `abilities.ts` 已经
import 了 `interp.ts`，反向依赖会**形成循环**，改为就地一行判定。

**仍有 5 个 tag 未实现**（`Permanent` a045 / `HaltFailed` a179 /
`oppmalicepenalty` a179 / `moneybonus` a156 / `malicebonus` a156），
已在测试里用 `KNOWN_UNIMPLEMENTED` 清单**显式钉住**：将来一旦实现，
测试会失败并提醒同步文档，避免出现"以为支持了"的错觉。

新增测试 `param-tags.test.ts`（14 项）。

---

## 一、重要前提：反编译范围的边界 ⚠️

**必须先读这一节**，否则会误判文档的权威程度。

这次反编译的是 **`Assembly-CSharp.dll`（客户端程序集）**，不是服务器程序集。
证据：

```csharp
// Assembly-CSharp/SGame.cs —— 客户端侧的桩实现
public class SGame : ISGame
{
    public void ExecuteAICommand(IGCommand com, GPlayer pl) { }   // 空
    public void ExecuteGameCommand(IGCommand com) { }             // 空 ★
    public void SendCommand(IGCommand com) { }
    public void AddLog(string log) { }
}

// GServer/ISGame.cs —— 接口只有这么几个成员
public interface ISGame
{
    GGame Game { get; set; }
    bool CharPerks { get; set; }
    Dictionary<UIN, GPlayer> Players { get; }
    void ExecuteAICommand(IGCommand com, GPlayer pl);
    void ExecuteGameCommand(IGCommand com);   // ★ 真正的规则解析入口
    void SendCommand(IGCommand com);
    void AddLog(string log);
    ...
}
```

`ExecuteGameCommand` 就是**服务器解析玩家动作的地方**，而客户端是空实现。
因此 **原版的"动作 → 结算"解析器不在本次反编译里**。

### 那么这份文档能保证什么、不能保证什么

| 类别 | 可信度 | 依据 |
|---|---|---|
| **常量与数值**（起始资源、贿赂、选举、监狱、目标） | ✅ 权威 | `GConst.cs` 明文 |
| **卡牌/格子/角色/厄运/监狱/混沌的全部参数与文案** | ✅ 权威 | `DM.cs` 里的数据表 |
| **资源增减语义**（夹取、实际增量、转移） | ✅ 权威 | `GPlayer.ChangeRes` / `PayResource` 实现 |
| **贿赂额公式、收入公式** | ✅ 权威 | `GPlayer.GetBribe` / `GetIncome` 实现 |
| **监狱 rank 机制** | ✅ 权威 | `GPlayer.ChangeRes` 的 `Term` 分支 |
| **建筑/站点"每次到访一次"** | ✅ 权威 | `GPlayer` 的 `*Visited` 字段 |
| **回合阶段与结算顺序** | ⚠️ 需交叉验证 | 客户端不解析，只能从状态字段、命令流、文案反推 |
| **动作解析细节**（每个 ActionType 具体怎么算） | ⚠️ 部分可推 | 参数 `Param1..6` + 文案占位符 `{1}..{6}` + 客户端读取逻辑 |
| **AI 决策** | ⚠️ 仅估值 | 只有 `AI_*_VALUE` 常量 |

**结论**：数值和数据结构是权威的；**流程与解析顺序需要用"文案 + 参数 + 已知原版行为"交叉验证**，
文档里凡属推断的都已明确标注。

---

## 二、文档清单

| 文档 | 内容 | 状态 |
|---|---|---|
| [`规则总览.md`](规则总览.md) | 常量、贿赂、收入、监狱、建筑访问 | ✅ |
| [`资源系统.md`](资源系统.md) | 六种资源、`ChangeRes`/`PayResource` 语义 | ✅ |
| [`动作清单.md`](动作清单.md) | `EAction` 全部 163 个动作 + 数据覆盖情况 | ✅ |
| [`格子与站点.md`](格子与站点.md) | 18 种格子的路过/停留效果与骰子表 | 🚧 提取中 |
| [`建筑效果.md`](建筑效果.md) | 11 个建筑的可做动作、花费、限制 | 🚧 提取中 |
| [`行动卡.md`](行动卡.md) | 186 张行动卡逐张（中文名/费用/地点/效果/动作链） | 🚧 提取中 |
| [`特殊牌与角色.md`](特殊牌与角色.md) | 厄运牌/监狱牌/混沌牌 + 12 角色 49+ 条能力 | 🚧 提取中 |
| [`回合流程.md`](回合流程.md) | 回合阶段、结算顺序、移动、选举、胜负 | 🚧 提取中 |
| [`交锋与选举.md`](交锋与选举.md) | 玩家交锋出价、选举、掷骰、移动 | 🚧 提取中 |

---

## 三、已确认的**重大规则更正**（相对当前网页版实现）

这些是读源码后发现的、当前实现**确实错了**的地方。
详细推导见各文档，这里只列结论，便于优先修。

### 3.1 数值类

| # | 项目 | 当前实现 | 原版 | 依据 |
|---|---|---|---|---|
| 1 | 起始金钱 | 100 | **200** | `GConst.INITIAL_MONEY` |
| 2 | 起始收入 | 20 | **30** | `GConst.INITIAL_INCOME` |
| 3 | 胜利目标 | 写死 30 | **可配置 10..100（19 档）** | `GConst.GOAL_SCORE_1..19` |
| 4 | 「一帆风顺」贿赂基数 | 5 | **10**（= `DEFAULT_BRIBE/2`） | `GPlayer.GetBribe` |

### 3.2 机制类

| # | 项目 | 当前实现 | 原版 | 依据 |
|---|---|---|---|---|
| 5 | 贿赂付不出 | 无惩罚（标记未使用） | **+1 罪恶（固定值，不是每点未付+1）** | `GPlayer.PayBribe` |
| 6 | 双倍贿赂 | 单次判定 | **两段判定**（原值一次、双倍值一次，可能 +2 罪恶） | 同上 |
| 7 | 「借口编造器」 | 无条件 50% | **1d6 ≥ 4** | `PayBribe` 的 `rnd.Next(1,7) > 3` |
| 8 | 「一帆风顺」 | 覆盖贿赂额 | **覆盖的是"罪恶值"** | `PayBribe` 里改的是 `malice` 变量 |
| 9 | 监狱刑期 | `term--`，归零释放 | **累加到上限 → `JailRank++`；rank 满 → +1 齿轮** | `ChangeRes` 的 `Term` 分支 |
| 10 | 服刑抽牌 | 1 张/回合 | **2/2/3/3/4 张（按 rank）** | `GPlayer.GetJailCardLimit` |
| 11 | 建筑每回合一次 | 只有站点动作限次 | **所有建筑/站点都有 visited 标记** | `GPlayer.*Visited` 共 11 个字段 |
| 12 | 收入夹取 | — | **被夹取时不触发银行家「钱生钱」** | `ChangeRes` 的 `flag` 语义 |
| 13 | 检察官贿赂 | 未实现 | **每 2 点罪恶 +1 贿赂**（而非每点） | `GetBribe` 的 Judge 分支 |
| 14 | 政治家「呼吸税」 | 未实现 | **镇长是政治家时，全员贿赂 +5** | `GetBribe` 的 Breathing_Tax 分支 |

### 3.3 遗漏的动作

`EAction` 共 **163** 个动作，卡牌数据里只用到 **143** 个。
另外 **20 个**是引擎内部直接引用、不写进卡牌 `ActionList` 的，其中包含
**4 条被漏掉的"角色能力"**：

```
Politician_Loyal_Electorate    政治家·忠实选民
Politician_Astral_Club         政治家·天界俱乐部（旧版，与 Astral_Club_2 并存）
Politician_Connections         政治家·人脉
Politician_Breathing_Tax       政治家·呼吸税     ← 已在 GetBribe 里生效
Banker_Old_Investments         银行家·旧投资
Banker_Bank_Account            银行家·银行账户
Banker_Money_Makes_Money       银行家·钱生钱（旧版）
```

所以"49 条角色能力"的统计**不完整**——`DM.Characters` 的 `ActionList` 里没有这些，
但引擎会按角色名直接调用。

### 3.4 站点规则（经源码独立复核）

以下每条都用源码/数据复核过，都是当前实现的**实际错误**：

| # | 项目 | 当前实现 | 原版 | 依据 |
|---|---|---|---|---|
| 15 | **经过生效的格子** | Income/Bribe 对，Misfortune 注释"经过不触发" | **只有 `Income` / `Bribe` / `Misfortune` 三格经过生效**；其余 15 格经过完全无效果 | `LocationDetailsPanel.cs:341-346` 的 `passEffectTypes` 写死 |
| 16 | **经过厄运格** | 不抽厄运 | **必须抽 1 张厄运**；停留才是"指定对手从牌堆顶 `MF_SELECT=2` 张里选 1 张" | 同上 + `GConst.MF_SELECT` |
| 17 | **演讲格 Tribune** | 停留直接 `+param1` 选票 | **下注 10/20/30/40/50$ 后掷骰**；`Label1..5` 是五档下注的判定门槛，`Label6` 是"不演讲" | `params=[10,20,30,40,50,0]` + `TAG.CellType_Tribune_Label1..5`（Label1「6=+1&」…Label5「2,3,4,5,6=+1&」） |
| 18 | **冒险格 Danger** | 停留只打日志 | **强制掷骰**：掷 1 → 厄运；可先买 40$ 保险（有保险则自己指定谁吃） | `params=[40,...]` + `TAG.CellType_Danger_Label1..6`（L1「1=厄运」，L2-6「-」） |
| 19 | **赌博格 Risk** | 停留只打日志 | 掷骰：1 厄运 / 2 `−50$` / 3 `−1& +1^` / 4 `+50$` / 5 `+2&` / 6 `+100$` | `params=[0,50,1,50,2,100]` + Label1..6 |
| 20 | **监狱格刑期** | `term--` 归零释放 | **掷骰定刑**：1,2 → 4 次；3,4 → 3 次；5,6 → 2 次。**单次刑期上限只有 4**，与 `JAIL_RANK_*_TERM`（5/7/8/10/3）是**两套不同机制**，极易混淆 | `TAG.CellType_Jail_Label1..6` + `Jail.params=[2,3,4]` |
| 21 | **Bribe/Police 对镇长无效** | 部分实现 | 两格**明文"本格规则对镇长无效"**，且**贿赂不给镇长** | `cell_types.json` 的 `Description`（英文完整） |
| 22 | **天界电梯** | 当作"可选动作" | 原版是**在地图图结构上加一条"银行→天界"的边**（改 `OutCells`/`InCells`） | `CD.cs:10966` / `CD.cs:11015` |

⚠️ **Danger 与 Police 的 `Label1..6` 在 `cell_types.json` 里全是 0**（导出时丢失），
真值在 `TAG.cs`。另外 `cell_types_zh.json` **不是中文版**（与英文版内容相同）。
→ `gen_shared_data` 应改用 `TAG.cs` 兜底，并重新导出这两类格子的骰子表。

骰子表原文见 [`格子与站点.md`](格子与站点.md)；
逐字段原始转储见 `test/data/cell_types_full_dump.txt`。

### 3.5 选举与牌库（经客户端代码验证）

| # | 项目 | 当前实现 | 原版 | 依据 |
|---|---|---|---|---|
| 23 | **选举胜出条件** | 未按罪恶比较（按票数/sort） | **罪恶最低者当选**（不是票数最高）。候选人得票 = `3 + 政治家 Politician_Connections 加成`。**全员并列最低则无人得票**（镇长空缺） | 客户端三处一致实现：`CElectionForm` / `CAvatarForm` / `GameExtensions` |
| 24 | **`ELECTION_SCORE_BONUS = 1`** | 当选 +1 齿轮 | **全仓库无使用点**——这个常量在原版里**没被用到** | grep 无引用 |
| 25 | **厄运牌库剔除规则** | 未实现 | **玩家 ≥ 5 人时硬编码剔除 `m029 丢失的债券`**（hex `F7C040EC0741FE1C`） | `GGame.cs:708-769` |
| 26 | **厄运/监狱/混沌牌堆** | 部分实现 | 抽完**不回库**、整副**立即重洗**；每次抽取广播 `ComUpdateMFCount` → **牌库剩余数与顶牌是公开信息** | `GGame.cs:708-769` / `824-860` |
| 27 | **混沌卡归属** | 共享池（已对） | 6 张**共享公开池**、无 `DeckCount`/无归属者 → **每张全局唯一，先抢先得** ✅ 与现实现一致 | `CChaosCardForm.cs` |
| 28 | **`SpecialFlag` 语义** | 未知 | = **卡面"特殊规则"角标**（只有 c001 供奉为 true） | `CChaosCardForm.cs:757` |
| 29 | **监狱牌 `Rank`/`Karma`** | 未实现 | 监狱牌有 `Rank`（解锁等级）与 `Karma`（表现 −1/0/+1，决定可抽卡池）；19 张（t001 特赦 `DeckCount=2`） | `GJailCard.cs` + `GGame.JailPickCard()` |

---

## 四、实现优先级建议

1. **先改数值类更正（第 1–4 项）**——改动小、依据明确、立刻影响玩法。
2. **再改站点规则（第 15–21 项）**——这几条决定了"走一格会发生什么"，
   是玩法差异最明显的地方。
3. **补齐监狱 rank 系统（第 5、9、10、20 项）**——当前是一套完全不同的模型。
4. **把所有建筑的"每次到访一次"落实**（第 11 项）。
5. **按 `行动卡.md` 逐张核对卡牌效果**，以文档为准。
6. 最后处理回合流程与解析顺序（受反编译范围所限，需交叉验证）。
