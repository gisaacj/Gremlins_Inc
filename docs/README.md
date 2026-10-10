# 《地精公司》网页复刻 · 规则文档索引



> 本文档集的目标：**按反编译代码把原版规则梳理清楚，作为网页版实现的唯一依据**。

> UI/音乐等后续处理，优先保证逻辑一致。



---




### 第 20 轮：AI 长局卡死 + 回合内执行顺序确认

#### 一、执行顺序（用户描述，已用测试钉住）

```
移动 → 判断是否冲突 → 看是否有可打的牌 → 执行建筑/站点效果
```

角色技能按各自描述的时机触发（`fireAbility` 的 event 字段：`turnStart` /
`afterMove` / `afterRoll` / `turnEnd` / `gameStart` / `afterPlayCard` …）。

实测确认（`turn-order.test.ts`，11 项）：
- Move 后落点已定，但**站点效果尚未结算**（金钱不变、`pendingCellEffect` 已登记）
- 对手在目标格 → **先**挂起 conflict；实测链 `conflict → conflict → police:P0`
- 建筑可容纳多人 → 不引发交锋
- UseCard 阶段站点仍未结算；无牌可打时自动跳过（第 19 轮的 bug #9）
- UseCell 阶段才结算（收入格 +60）并给出建筑可选动作
- `skipPlay` 与 `nextTurn` 两条路径结算结果一致

#### 二、AI「走着走着不动了」——日志上限导致防卡死保险误触发

两个 AI 驱动的防卡死保险都用 `state.log.length` 判断"这一轮有没有变化"，
但 **`state.log` 有 400 条上限**（超过就 `shift()`）→ 长局中 `log.length`
恒为 400、`before === after` **永远成立** → 保险每轮误触发，AI 刚做一步就被
强制结束回合。**短局看不出，长局才明显**，正好符合"走着走着就不动了"。

`LocalGame.runAI` 更糟：它把 `log.length` 拼进判据字符串，饱和后同样恒等。

**修复**：`EngineState` 新增 **`progress`**（只增不减的进度计数，
`pushLog()` 与 `endTurn()` 都会推进），两个 AI 驱动的判据改用它。

> ⚠️ 不能用 `round` 替代：一轮内有多次行动时 `round` 不变，
> 会把正常的多次行动误判成"卡死"。

**验证**：`state.log` 饱和到 400 后 `progress` 仍正常递增；
对局模拟 5 个 seed × 3 人局全部正常结束、0 错误。

---

### 第 19 轮：用户第三批问题（9 个，全部修复）

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 2 | 建筑/站点效果**概率性**不生效 | `nextTurn()` 不结算"欠着的站点效果"，而客户端的**「结束回合」按钮正好走这条路**；「不出牌」走 `skipPlay` 才会结算 —— 取决于点哪个按钮，看起来像随机 | 把结算**放进 `nextTurn` 自身**，任何调用方都绕不过去 |
| 6 | 地狱效果不触发 | **与 #2 同一根因**（地狱格扣 100 金钱也被跳过） | 同上。实测两条路径现在完全一致 |
| 3 | 「作弊」移动不符预期 | ① `Move_Back` 被当成"退后 N 步"，`MOVE()+Move_Back()` 净位移 0；② **只有预览支持逆行**，引擎永远沿 `out` 走 | `Move_Back` 改为只置标记；`startMove`/`autoPickBranch`/`pathTo` 统一按 `isReverseMoveCard` 走 `cur.in` |
| 5 | 「不测风云」张数不对 | `WindOfChanges` **完全忽略参数**，把所有人手牌丢了重抽 | 按 `params[0]` 传；**同时结算**（先各取 N 张再统一发），手牌不足按持有量 |
| 4 | 拿别人手牌的卡没展示 | `OpponentShowHand` **只写了一条日志** | 新增 `state.revealedHand` + 协议字段（**只发查看者**）+ 界面面板 |
| 1 | 「二手货」不生效 | ① 用 `Math.random()` 抽牌（破坏可复现性）；② **丢了目的地**，闷头乱走 | 改用引擎 RNG；改为**两段式**（选对手 → 算出可达目的地 → 选目的地后按路径走） |
| 8 | 行动卡牌没有全中文 | 中文语言包**在源头被截断**：只保留第一句，`[m]`/`[i]` 那些句子根本没被翻译（日/韩/俄同样如此，是基础数据的缺陷） | 为 18 种 `[m]`/`[i]` 文本做中文对照表（按语义单元拼装）；记号换成「【移动时】」「【交锋时】」；主体若回退英文则把其中自带的英文效果句摘掉 |
| 7 | 其他玩家面板太小、信息不全 | — | 字号 11→13、头像 18→26px、加 `flex-wrap`；补上**收入/选票/罪恶/秘密卡/所在站点/永久卡数/交锋战绩/监狱经验** |
| 9 | 无可操作步骤应自动跳过 | — | UseCard 阶段无牌可打 → **不再返回该阶段提示**，直接进 UseCell；新增 `PlayerPrompt.canEndPhase`，结束按钮只在"可选"阶段出现 |

**验证**：三端类型检查 0 错误；全量测试 **576 项**通过（新增 `turn-fixes` 11 项、
`bugfixes` / `ignore-cell` / `interaction` 等）；对局模拟 8 组 0 错误 0 违规 0 未实现；
socket e2e 10 项通过；客户端构建成功。

**两条值得记住的教训**：

1. **"概率性不生效"往往是"有两条代码路径，只修了一条"** —— 用户描述的"随机"
   本质是按钮之争（#2 与 #6 是同一个根因）。
2. **测试的构造方式会让断言失去意义**：bug #5 的测试若用 2 人局，
   `SelectOpponent` 会自动选中而不挂起，"带目标就不二次挂起"永远为真 ——
   必须用 3 人局才测得出问题。

---

### 第 18 轮：用户第二批实测 bug（6 个，已全部修复）

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 移动预览可选「监狱」，实际走到「赌博」 | `startMove` **忽略** `destinationTileId`，每到岔路口重问，落点由 `autoPickBranch` 贪心凑出，与预览无关 | 新增 `findPathTo()`，**预览与执行共用同一份寻路**；`startMove` 预存 `plannedPath` 后一路走完 |
| 2 | 「恶作剧」交换位置后仍触发建筑 | `ignoreCell` 只挡住**自动落点结算**，没挡住**可选动作** | `cellOptions()` 开头早退：`ignoreCell` 置位时本站不给任何动作 |
| 3 | 卡牌「收获」打出来没效果 | `playEffectCard` **完全没结算** `card.income` / `card.outcome` | 新增 `applyCardResourceBundle()`；实测 **137/186 张卡有收获**、16 张有代价 —— 原先 **153 张卡打出来毫无资源变化** |
| 4 | 交锋出价只能从固定档位挑 | 引擎早已支持任意金额，但 UI 没有数值输入通道 | `PlayerPrompt` 新增 `numeric`；客户端新增 `NumericBid`（默认填上限） |
| 5 | 选玩家的卡要选两次 | 界面已选好目标，但服务端 `game:play_card` **把 target 丢了** | `playCard()` 新增 `targetPlayerId`，直接回答第一个挂起；非法目标回退成正常挂起 |
| 6 | 掷骰卡可反复重掷到满意 | 客户端用 `Math.random()` 自己掷骰再发给服务端 | 新增 `game:roll_move_dice`，**服务端权威 RNG** 掷骰并 ack 回传；不再接受客户端 `customSteps` |

**验证**：bug #1 用脚本穷举「每个起点 × 1..5 步 × 每个预览声称可达的目的地」共
**1587 组**，逐一比对引擎实际落点 —— **不一致 0 组**。

**两处关键教训**（都写进测试注释，避免以后踩回去）：

1. **bug #5 的测试必须用 3 人局**：`SelectOpponent` 在"只剩一个合法目标"时会
   **自动选中**而不挂起，所以 2 人局下"带目标不二次挂起"永远为真、测不出问题。
2. **`ignoreCell` 会连角色能力动作一并屏蔽**（如政治家在银行的天界俱乐部）。
   依据是 a160「好运」的措辞"该站点的规则**不会影响你**"—— 既然本站规则不生效，
   本站给出的动作都不该出现。这是取舍，不是 bug。

### ⚠️ 用户提供的 wiki 无法访问（网络限制）

用户给的 `https://gremlinsinc.fandom.com/wiki/Gremlinsinc_Wiki` 在本机**不可达**：
DNS 能解析（`118.184.26.113`），但 `gremlinsinc.fandom.com` / `fandom.com` 的 443 均连不通，
`web_fetch` 与 `web_search` 都取不到内容。等效站点（namu.wiki）也因"非公网 IP"被拒。

因此**"用 wiki 全面复核规则"这一项尚未完成**。已尝试过的替代来源：
- 日文攻略站（hebihead）—— 只覆盖部分角色能力，且与游戏数据有出入
  （它写收藏家保险 20，而数据与用户实测都是 10，以数据为准）
- 官方 Steam 公告 —— 页面超时

**下次要继续这项**：需在能访问 fandom 的网络环境下抓取，或由用户提供页面内容。

---

### 第 17 轮：修复用户实测反馈的 5 个 bug

用户实际玩过之后报的问题，全部已修（新增 `bugfixes.test.ts`，21 项）：

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 卡牌描述显示「-4&」这种天书 | UI 调 `displayCardDescription()` **没传 `formatted`**，符号原样留在文案里 | 新增 `displayCardRules()`：替换 `{n}` → 归一化符号 → 还原中文名。**103/186 张卡**含裸符号 |
| 2 | 「给予其{1}$」看不懂（不知道给多少） | 中文文案**被截断**，丢掉了 `{n}` 关键数值（如 a008 中文只剩「选择任意玩家。」），而旧判据认为它"完整" | 新增 `isMissingKeyNumbers()`：英文有 `{n}` 而中文无占位符也无数字 → 判为截断，回退英文。**41/186 张**命中 |
| 3 | 收藏家「挖宝」不触发（不能选双倍收入/换牌） | `excavation` 只写了个 flag，**从没变成可选动作** | 收入格标 `autoCellEffect:false` + 给出 `excavation.income` / `excavation.swap` 两个选项。同时删掉一份语义不符的重复选项（旧的把"双倍收入"写成单倍） |
| 4 | 到警察站**先问站点、再问用牌**，顺序反了 | 站点效果在 **Move 阶段**就结算了 | 改为原版顺序 **Move → Conflict → UseCard → UseCell**：格子效果推迟到 `skipPlay`/打完牌后由 `finishTurnActions()` 结算。附带好处：**用移动牌离开能躲开原站效果** |
| 5 | 收藏家到冒险格保险被收 40（应 10） | `resolveCellEffect` 的 Danger 分支**硬编码** `params[0] ?? 40`，没查角色能力（`options.ts` 那条路径反而算对了，两处不一致） | 抽出单一来源 `insuranceCost(p)`，两条路径都用它 |

**过程中另外查出并修掉的 3 个隐患**：

1. **推迟格子结算会让没能力的人丢效果**：无条件推迟后，银行家停在收入格
   既没自动结算、也没有任何选项 → 金钱完全不涨。改成**只有真能拿到选项的人**
   才推迟（用共享判据 `hasCellChoice`，避免两处漂移）。
2. **换牌会把牌换没**：旧实现按 id 从手牌删旧牌，同一张牌被重抽回来时
   会被误删（实测 1 张手牌换牌后变 0 张）。改为精确重建 `p.hand = drawn`。
3. **`pendingCellEffect` 会残留到下一回合**：`endTurn` 不清它，
   `runOption` 之后也没人清。现在选项路径会显式清掉并标记 `cellResolved`。

> ⚠️ 关于「挖宝」的**语义**：生成数据里该能力的名称/说明 UIN
> 在语言包里查不到，`nums=[6]` 只能间接推断。本实现按**用户实测描述**
> （"双倍收入 或 换牌"）实现；冒险格保险额按**游戏数据** `nums=[10]`
> （外部攻略站写的是 20，但数据与用户实测都是 10，以数据和实测为准）。




## 〇、⚠️ 先读：本次审计的时效性更正



**第三节的"更正清单"是历史快照，不是长期缺陷表** —— 已按第 15/16 轮实测复核逐条标注。



### 第 16 轮（续）：补完最后一条规则缺口 —— 政治家「呼吸税」



第 15 轮复核后规则清单只剩两条：`SpecialFlag`（显示层）与呼吸税。

这轮把呼吸税做掉，**规则清单上已无未实现条目**。



源码依据（`GPlayer.GetBribe()`，GPlayer.cs:1136-1169）：



```csharp

foreach (GPlayer gp in this.Game.Players.Values) {

    if (gp.Governor) {

        if (DM.Characters[gp.CharacterID].Name == "Politician"

            && gp.GetCharacterAbility(EAction.Politician_Breathing_Tax) != null) {

            num += gp.GetCharacterAbilityParam(EAction.Politician_Breathing_Tax, 5, 2);

            break;

        }

        break;

    }

}

```



三个容易搞错的点：



1. **判定的是"镇长那个人"是不是政治家** —— 与"在算谁的贿赂"**无关**。

   所以只要政治家当镇长，**全场每个人的贿赂都 +5**，不是只给镇长自己加。

2. 默认值 **5**（`GetCharacterAbilityParam` 的第二个参数是默认值）。

3. 遍历到镇长就 `break`，**最多加一次**，不会因场上有多个政治家而叠加。



实现：`breathingTaxFrom(state)`（`abilities.ts`）+ `bribeAmount()` 里累加。

⚠️ 该能力**不在导出的角色数据里**，必须**手工登记**进 `CHARACTER_ABILITIES`，

否则 `abilitiesOf` 找不到它 → 恒为 0，测试里专门钉了一条防这个坑。



**顺带纠正我自己的过期笔记**：我曾记过"6 条能力不在数据里"

（`Politician_Loyal_Electorate` / `Politician_Connections` / `Banker_*` 等），

实测核对后**当前只有 `Politician_Breathing_Tax` 这一条**属于此情况。

`abilities.test.ts` 的条数比对已改为"扣除豁免条目后相等"，

并**顺带断言豁免清单里的条目确实已登记**，避免清单悄悄失效。



新增测试 `bribe.test.ts`（15 项）。



---



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

| `ELECTION_SCORE_BONUS` 不该被使用 | ⚠️ 见第 513 行的**更正**——它是"当选就职 +1 齿轮"，应被使用 |

| 选举按罪恶判定 | ❌ **我写错了**。判定依据是**选票**；罪恶只决定谁拿 +3 票加成（见下方更正） |

| **监狱 rank 系统** | ❌ 原先**缺失** → ✅ 已实现 |

| **监狱每回合抽牌 2/2/3/3/4** | ❌ 原先**缺失** → ✅ 已实现 |

| `m029` 玩家 ≥5 剔除 | ❌ 原先**缺失** → ✅ 已实现（`MF_EXCLUDED_AT_FIVE_PLAYERS`） |

| 检察官贿赂（每 2 点罪恶 +1） | ❌ 原先**缺失** → ✅ 已实现（`judgeJustice`） |

| 监狱牌 `Rank` / `Karma` | ❌ 原先**缺失** → ✅ 已实现（`jailKarma` / `jailCardLimit`） |

| `targetScore` 默认 30 | ✅ 已改为读 `GOAL_SCORE_1`（= 10） |



> ⚠️ 上表在**后续几轮里又被更新过多次**，其中三行（`m029`、检察官贿赂、

> 监狱 `Rank`/`Karma`）曾长期停留在"未实现"，直到**第 15 轮**做了一次

> 全表逐条实测复核才纠正。**务必以第 3 节各表的"复核状态"列为准。**



### 仍未实现（截至第 16 轮复核：**已无**）

规则清单上**已无未实现条目**（`SpecialFlag` 也已补为显示层角标）。


| # | 项目 | 说明 |

|---|---|---|

| 28 | `SpecialFlag` 语义 | 混沌卡 c001 的卡面"特殊规则"角标；**属显示层信息，不影响逻辑** |



> ✅ 第 16 轮把 **#14 政治家「呼吸税」** 补完了（见下），

> 规则清单上已**没有未实现的条目**。



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



**当时仍有 5 个 tag 未实现**（`Permanent` a045 / `HaltFailed` a179 /

`oppmalicepenalty` a179 / `moneybonus` a156 / `malicebonus` a156），

已在测试里用 `KNOWN_UNIMPLEMENTED` 清单**显式钉住**。



> ✅ **后续已全部补齐**，`KNOWN_UNIMPLEMENTED` 现已清空。

> 这个清单在补齐时**第一次跑测试就失败并点名了这 5 个 tag** —— 正是它设计的目的。



新增测试 `param-tags.test.ts`（14 项）。



### 本轮：补齐上一轮钉住的 5 个语义 tag



上一轮把 5 个未实现 tag 列进 `KNOWN_UNIMPLEMENTED` 清单，这轮按牌面语义全部补齐。



| tag | 卡 | 语义 |

|---|---|---|

| `Permanent` | a045「房产税」 | 每个对手按**自己持有的永久卡数量** × 单价（50）付款 |

| `moneybonus` / `malicebonus` | a156 | **按实际收到的齿轮数**，每 1 个给 +50$ / +1^ |

| `HaltFailed` / `oppmalicepenalty` | a179「昂贵的命令」 | 付不出则**整段不生效**，改为 +3^ |



三个实现要点：



1. **a156 的奖励必须在循环之后结算**。牌面是"每收到 1 个 \* 你 +50$"，

   而对手可能齿轮不足导致少给（`payAmount` 会夹取）。用名义值（×人数）

   会算多。所以 `handleResourceLoss` 里累积 `receivedTotal`，

   循环结束后再乘系数。



2. **a179 需要"中止后续动作"的能力**。它的动作链是

   `付款 → 加齿轮 → 减齿轮 → 加罪恶`，"付不出就整段不生效"意味着

   得把**后面的动作一起停掉**。引擎原本没有这个机制，于是给

   `ActionContext` 加了 `haltRest` 标记，`runActions` 每轮开头检查。



3. **`takeTaggedNumbers` 新辅助**：原版用「tag 后跟数值」表达带参 tag

   （`OpponentPayScore(1|moneybonus|50|malicebonus|1)`），

   只靠 `firstNumber` 分不清数值归属，需要按 tag 定位后续槽位。



`KNOWN_UNIMPLEMENTED` 现在清空。这个清单的价值在实现过程中体现了：

补齐后**第一次跑测试就失败**并点名了这 5 个 tag，提醒同步文档——

正是它设计的目的。



新增测试 `param-tags2.test.ts`（15 项）。



⚠️ 写测试时踩到一个坑值得记下：`createState` 会按角色行动顺序

（`StepOrderNum`）**重排** `state.players`，所以 `st.players[0]` **不是** `p0`。

必须用 `getPlayer(st, id)` 按 id 取人，否则 setup 会改错对象。



### 本轮：文案显示层（`{n}` 占位符 + 中文缺失回退英文）



之前把"中文截断"定性为**只影响显示**，这轮就去修显示层。实测出两个具体缺陷：



| 缺陷 | 影响面 | 表现 |

|---|---|---|

| 说明里的 `{n}` 占位符**未被替换** | **78/186** 张卡 | UI 上直接显示「丢弃**{1}**张卡牌。」 |

| 中文**缺失或只剩标记** | 31 张中文为空 + a015/a099 只给 `[m]`/`[i]` | UI 上显示光秃秃的「[m]」 |



修复方式：新增 `shared/src/display-text.ts`（`cleanGameText` /

`isIncompleteZh` / `displayCardName` / `displayCardDescription` / `displayCardText`）：

1. 用卡牌自己的 `params` 替换 `{n}`

2. 清掉 `\r` 等控制符（原版文案里大量 `\r\r`）

3. 中文**明确不完整**时回退英文原文



**判据刻意保守**：只抓"空 / 只剩 `[m]` / 没有任何中文或字母数字"三种情况，

**不比较中英长度**。原因是我最初的启发式用了长度比，结果把

**140/186** 张卡的正常译名误报成"截断"（「永动机」vs "Perpetuum mobile"）——

中文信息密度天然高于英文，长度比根本不能用。



#### 三处实现要点



1. **数据层要补 `en` 字段**：`a015` 的语言包英文也只有 `"[m]"`，

   必须用 `pickFuller(语言包, JSON Description)` 取更完整的那个，

   否则回退到英文后仍然只得到 `[m]`（实测踩过这个坑）。

2. **`JailCard` 也要加 `en`**：原先只有 `ActionCard` 有，

   而监狱牌的选项文案同样需要回退。

3. **模块分层避免循环依赖**：`display-text.ts` **只依赖 `gamedata`**，

   因为它要被 `engine/state.ts` 使用（生成玩家可见的选项文案）；

   若放在 `card-display.ts`（依赖 `engine/abilities.ts`）里就会形成

   `engine → card-display → engine` 的循环。`card-display.ts` 转出这些函数供 UI 使用。



接入点：`client/src/components/Card.tsx`（卡名/说明/风味）、

`engine/state.ts` 的监狱牌选项 label、以及交锋用牌 label。



新增测试 `text-display.test.ts`（19 项），其中包含"186 张卡+18 张监狱卡的

显示说明都不得残留 `{n}`"这类全量断言。



---



## 本轮：端到端可玩性验证（跑通"能赢"与混沌收尾）



之前所有测试都是**局部**的（某个动作、某张卡、某个 tag）。这轮补上**整条链路**：

从开局到终局判定，并逐个统计"哪些机制真的被触发了"。



### 一、先确认：赛局能真正结束



新增 `server/src/__tests__/helpers/autoplay.ts`（从 `playthrough.ts` 提炼的复用驱动器），

再用它跑不同人数 × 不同目标：



| 目标齿轮 | 2 人 | 3 人 | 4 人 |

|---|---|---|---|

| 10 | ✅ P0 胜 | ✅ P0 胜 | ✅ P3 胜 |

| 15 | ✅ P0 胜 | ✅ P0 胜 | ✅ P3 胜 |

| 20 | ✅ P1 胜 | ✅ P0 胜 | ✅ P3 胜 |



9 组全部 `finished=true`、0 错误、0 不变量违规、0 未实现原语。

**这是"网页版能玩完一局"的直接证据**——此前只有"跑 N 回合不崩"。



### 二、机制触发统计暴露的问题



对一局 183 轮的对局统计触发次数，发现**两个子系统几乎零覆盖**：



| 机制 | 触发 | 判断 |

|---|---|---|

| 选举 | 7 | ✅ 正常 |

| 厄运 | 30 | ✅ 正常 |

| 掷骰 | 35 | ✅ 正常 |

| **混沌卡** | **0 / 6** | ❌ 驱动器从不尝试 |

| **永久卡** | **0 张** | ⚠️ 见下 |

| 交锋 | 0 | ⚠️ 已知缺陷（`resolveLanding` 提前返回） |



### 三、由此查出的真 bug：`chaosOptions` 与 `playChaosCard` 不一致



**`chaosOptions` 报告 c001「供奉」`playable: true`，但实际打出必然失败** ——

因为它只检查了地点与费用，而 `playChaosCard` 还要求

`SacrificePermanent`（需先丢弃一张激活的永久卡）。



实测：一局里 5 次"可打出"全部以「没有可丢弃的永久卡」告终，

且这是混沌子系统**唯一的失败来源**。已在 `chaosOptions` 补上同样的检查。



⚠️ 修复后有个既有测试失败了 —— `chaos.test.ts` 的

「在地狱时 c001/c002/c003 变为可打出」**没给永久卡却断言可打出**，

等于在固化那个 bug。已改为给一张永久卡，并**另加**一个用例断言

"没有永久卡时不可打出"。



### 四、混沌卡完整生命周期（首次覆盖）



混沌卡此前没有任何端到端覆盖。新增 `chaos-lifecycle.test.ts`（14 项），

覆盖：共享池语义、地点限定（地狱/天界/工厂）、c001 的永久卡前置、

收益与代价、重复打出被拒、以及**最关键的收尾规则**：



> 原版："The session will end at the **end of the round** during which the

> last Chaos Card has been played."



测试明确断言**打完最后一张时赛局不能立刻结束**（`phase` 仍为 `playing`），

必须等到轮末才按齿轮最高者判胜。



驱动器的永久卡部分也做了改进（优先打永久卡以触发持续钩子），

但仍有 **193/198 次因"地点限定"打不出**——这是驱动器不会找地点，

**不是引擎缺陷**，已如实记录。



---



## 本轮：把"提到了"升级为"能执行"（动作原语运行时覆盖）



之前验证过"143 个动作类型在引擎源码里**被提到**"——但那是**字符串层面**的检查，

不能说明它们跑得通（某个 case 可能一进去就抛异常，或只处理了部分参数形态）。



新增 `action-runtime.test.ts`，对每个动作类型：

从真实卡牌数据里找出**实际用到它**的卡 → 放到该卡的使用地点、给足资源 →

**真正执行一次**并应答挂起 → 断言不抛异常、日志里不出现"尚未实现"。



结果：



| 检查 | 结果 |

|---|---|

| 数据里出现的动作类型 | 94 |

| 其中成功执行 | **85**（另 9 个无行动卡承载，跳过） |

| 执行中抛异常或报"尚未实现" | **0** |

| 全部 **186 张行动卡**各打一次 | **0 异常** |

| 全部 **40 张厄运卡**各结算一次 | **0 异常** |



这把动作层的信心从"代码里有这个分支"提升到了"这条分支真的能跑完"。



### 顺带澄清一处疑点



`CElectionForm.showResultVote()` 里显示的是 `SumVote / 2`，

一度让人怀疑票数单位有问题。核对后确认：**/2 只是动画收尾的显示处理**，

胜负比较用的是未除的 `SumVote`；票数累加处（`pl.Vote + bonus`）没有除以 2。

**不做过读解**。



---



## 本轮：真实 socket 端到端（"能联机玩"的直接证据）



之前所有集成测试都是**直接调用服务端函数**（`server-integration.test.ts`），

不经过网络。这轮补上**真启动服务器 + 真连 socket.io 客户端**的端到端。



新增 `tools/socket-e2e.mjs`（`node --use-system-ca tools/socket-e2e.mjs`，约 30 秒）：



| 阶段 | 验证内容 |

|---|---|

| 启动 | 服务器起来，`/api/health` 通过 |

| 连接 | 两个独立 socket 客户端连上 |

| 建房 | A `room:create` 拿到 roomId，B `room:join` |

| 选角 | **两阶段**：`room:start` → 切 `character_select` 并下发 `charOptions` → 各自选角 → 再次 `room:start` 真正开局 |

| 对局 | 双方按 `game:prompt` 自动应答，实际跑起来 |



实测结果：**200 次状态更新 / 199 次客户端操作 / 推进到第 45 回合**，10 项断言全通过。



### 顺带写清了两件事



1. **开局是两阶段的**：`room:start` 第一次只切到选角阶段（下发

   `charOptions`），选完再 `room:start` 才真正 `startGame`。

   我第一版测试按"一次 start 就开局"写，卡在这里。

2. **客户端 emit 与服务端处理完全对齐**：逐条比对

   `C2SEvents` 声明（18 个）、客户端 `emit`（18 个）、服务端 `.on` 注册（19 个，

   多一个 `disconnect`），**未覆盖 0 个**。



（另：`LobbyState.players[i].charOptions` 是**本玩家**的可选角色，

不是全局角色池。）



---



## 本轮：移动端连通性（修掉一个真实阻断 bug）



计划做 APK 构建，先查环境，结果**在环境之前先查出一个真 bug**。



### 一、原生壳永远连不上服务端



原实现取连接地址：



```ts

const url = import.meta.env.VITE_SERVER_URL

         || (import.meta.env.DEV ? '/' : window.location.origin);

```



Capacitor 的 WebView 把页面放在**自己的本地 scheme** 上

（Android 默认 `https://localhost`），所以 `window.location.origin`

指的是**设备本机**，不是服务器。→ APK 装上后**永远连不上**，且看不出原因。

`capacitor.config.ts` 里那句"实际部署时在 App 内设置中填写服务端 IP"

说明当时就留了这个坑。



**修复**：地址改为**运行时**可配置（`localStorage`，主菜单新增「服务器」一栏，

支持裸 `IP:端口` 自动补协议）；原生壳未配置时**明确报错**并显示给玩家，

而不是静默连 `localhost`。网页版行为不变（仍默认同源）。

详见 [`移动端构建.md`](移动端构建.md)。



### 二、APK 构建环境不齐（已如实记录，未擅自安装）



| 组件 | 要求 | 本机 |

|---|---|---|

| JDK | Capacitor 6 需 **17** | 只有 15 和 8 ❌ |

| SDK `platforms/` | 需 android-3x | **空** ❌ |

| SDK `build-tools/` | 需 3x.x.x | **空** ❌ |

| 网络 | dl.google.com | 可达 ✅ |



补齐约需下载 500MB+。**已与用户确认：暂不安装**，步骤写成

[`移动端构建.md`](移动端构建.md) 备查；该文档同时**明确标注**了

"从未跑通"的部分，避免把未验证的步骤当成可用。



### 三、顺带记录一个测试组织上的坑



我最初把客户端代码的测试放进 `server/src/__tests__/`，结果

`server/tsconfig.json` 的 `rootDir` 不允许跨项目引用 → 类型检查失败。

已移到 `tools/test-server-url.mts`（用 tsx 直接跑，不进编译项目）。

另：`import.meta.env` 在非 Vite 环境是 `undefined`，直接取属性会抛错，

已改为 optional 取值。



---



## 第 15 轮：文档与实现的最终一致性复核



起因：第 12 轮改选举时踩了"文档写反、我照着做错"的坑。这轮把

`docs/README.md` 的 29 条更正表**逐条与代码实测对照**。



### 查出 3 条文档过时（说未实现，其实早实现了）



| # | 项目 | 文档说 | 实际 |

|---|---|---|---|

| 13 | 检察官贿赂（每 2 点罪恶 +1） | 未实现 | ✅ `judgeJustice`，`perMalice = 1/2` |

| 25 | 厄运牌库剔除 `m029`（≥5 人） | 未实现 | ✅ `MF_EXCLUDED_AT_FIVE_PLAYERS` |

| 29 | 监狱牌 `Rank` / `Karma` | 未实现 | ✅ `jailKarma` / `jailCardLimit` |



**危害**：照这张表去"修"，会把已经正确的地方**改坏**。



### 复核后确认**仍缺**的只有 2 条



| # | 项目 | 说明 |

|---|---|---|

| 14 | 政治家「呼吸税」`Politician_Breathing_Tax` | 镇长是政治家时全员贿赂 +5；引擎内无任何命中 | ✅ **已修**（`breathingTaxFrom`）。本条原标"未实现"**已过时** |

| 28 | `SpecialFlag` 语义 | 混沌卡 c001 的卡面"特殊规则"角标；**属显示层，不影响逻辑** |



### 顺手澄清一处曾经的过度声明



第 11 条「建筑每回合一次」我早先写成"11 个 `*Visited` 字段证明每建筑每回合一次"，

后来降级为未确认。这次精确了：



- **规则本身已实现**：`optionUsedThisTurn`（每次到访只能用一个可选动作）。

- **但**"每个建筑一个 `visited` 字段"这个**具体机制无法证实** ——

  `GPlayer` 里那些 `*Visited` 字段全仓库**没有任何读写点**（只有声明）。

  所以原版是否真的按建筑分别记录，仍属**不可知**。



### 新增可重复运行的审计脚本



`tools/audit-doc-consistency.mjs` —— 逐条核对更正表里**声称仍缺失**的条目，

检查引擎里是否其实已经有了；只对"声称缺失"的行报错，避免把历史列的说明当现状。



```

$ node tools/audit-doc-consistency.mjs

✓ 没有"声称缺失但其实已实现"的条目

```



这条脚本以后可以随时跑，防止表格再次悄悄说谎。



---



## 第 16 轮：修正落地顺序 —— **先交锋，赢了留在格上才处理格子效果**

> ⚠️ **本轮结论已被第 17 轮进一步修正。** 这里定的是"交锋在格子效果之前"，
> 但当时仍把**格子效果放在 Move 阶段**结算，于是玩家还没机会用牌就被强制
> 处理站点（用户第 17 轮实测报的 bug #4）。正确的完整顺序是：
>
> **Move → Player Conflict → UseCard → UseCell**
>
> 即"先交锋"是对的，但"格子效果"还要再往后推到 **UseCard 之后**。
> 详见本文档开头「第 17 轮」一节。



### 用户指正



> "格子效果是先交锋，赢了留在格子才处理格子"



我上一轮（第 11 轮）把顺序定成了"先格子、后交锋"，理由是技术性的

（反过来会让格子效果被静默丢掉）。**这个顺序是错的。**



### 源码依据



`TAG.Game_Label_Conflict_Description`：



> "Players {1} and {2} are in Player Conflict! Each player calls their bid.

> **The player who bids the most pays up and remains on the spot, the other

> player is arrested.** If the bids are equal, the player with the least ^ wins."



关键在 **"remains on the spot"（留在该站点）** —— 输家被带走，

只有赢家留下来。所以格子效果自然只结算给**留下来的人**。

若先结算格子效果，等于"没争到站点的人也照吃了站点效果"，与原版不符。



### 实现



难点：交锋会挂起等双方出价，而**挂起被应答后引擎不会回到 `resolveLanding`**。

所以新增一个"欠账"机制：



- 发起交锋时把 `{playerId, cellId}` 记进 `state.pendingCellEffect`；

- 交锋结算完（`applyConflictOutcome`）或被逃避（`applyConflictEscape`）后，

  调 `resumePendingCellEffect` 补做格子效果；

- 补做前**比对 `cellId`** —— 赢家可能被 `[i]` 卡（a070「敲诈！」）挪到相邻格，

  此时已不在原格，就不该再吃原格效果。



实测挂起链（P0 走到对手所在的格子）：



| 格子 | 挂起链 |

|---|---|

| Bribe | `conflict → conflict`（格子效果即时结算，赢家付双倍贿赂） |

| Danger | `conflict → conflict → danger:P0` |

| Police | `conflict → conflict → police:P0` |



**交锋确实排在格子交互之前**，且只有留下来的赢家进入格子交互。



### 顺带修掉的两处



1. 第 11 轮我写的回归测试断言的是**错误顺序**（"先挂格子交互"），

   这轮改成断言正确顺序。

2. `settleConflict` 的一个 `return undefined;` 在改写时被误删了函数结尾的 `}`，

   类型检查立刻报出来（`TS1005: '}' expected`），已修。



新增测试 `landing-order.test.ts`（10 项），含"输家从不吃格子效果"

"赢家留在原格""整条链无残留挂起"等断言。



---



## 代码仓库与推送



项目有两处远端，**分支名不同**：



| 远端 | 地址 | 分支 |

|---|---|---|

| GitHub | `github.com/gisaacj/Gremlins_Inc` | `master` |

| Gitee | `gitee.com/gisaacj/Gremlins_Inc2` | **`main`** |



一次推两边：



```powershell

node tools/push-both.mjs

```



**踩过的坑**：



1. **Gitee 的默认分支叫 `main`**，不是 `master` —— 直接 `push origin master`

   会在 Gitee 上多出一个 `master` 分支，而默认分支仍是旧的 `main`。

2. **Gitee 凭据在 Windows 凭据管理器里，但仓库没配 `credential.helper`**，

   所以 git 默认**不会**去读它（表现为匿名推送 → 权限拒绝）。

   脚本显式带 `-c credential.helper=wincred`。

3. `-c` 是 **git 全局选项，必须在子命令之前**：

   写 `git push -c x=y` 会报 `unknown switch 'c'`，得写 `git -c x=y push`。

4. GitHub 间歇性 443 超时 / 502；超时时用 `tools/push-via-api.mjs`

   走 Git Data API 通道兜底（会重建对象，故 sha 与本地不同，但 tree 一致）。



**另**：主工作区 `E:\code\小魔怪` 里还有与游戏无关的辅助目录

（`gremlins-ocr` OCR 工具、`test/` 反编译产物与数据提取脚本、若干日志），

这些**不在仓库里**，只有游戏本体代码入库。



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



> ⚠️ **本表已按代码实测复核（见下方"复核状态"列）**。

> "当前实现"一列记录的是**当初写文档时**的旧实现，不是现在的状态——

> 很多条已经修好了，照它去改代码会把已经正确的地方改坏。



| # | 项目 | 当时的实现 | 原版 | 依据 | 复核状态 |

|---|---|---|---|---|---|

| 1 | 起始金钱 | 100 | **200** | `GConst.INITIAL_MONEY` | ✅ 已修 |

| 2 | 起始收入 | 20 | **30** | `GConst.INITIAL_INCOME` | ✅ 已修 |

| 3 | 胜利目标 | 写死 30 | **可配置 10..100（19 档）** | `GConst.GOAL_SCORE_1..19` | ✅ 已修（缺省读 `GOAL_SCORE_1`） |

| 4 | 「一帆风顺」贿赂基数 | 5 | **10**（= `DEFAULT_BRIBE/2`） | `GPlayer.GetBribe` | ✅ 已修 |



### 3.2 机制类



| # | 项目 | 当时的实现 | 原版 | 依据 | 复核状态 |

|---|---|---|---|---|---|

| 5 | 贿赂付不出 | 无惩罚（标记未使用） | **+1 罪恶（固定值，不是每点未付+1）** | `GPlayer.PayBribe` | ✅ 已修 |

| 6 | 双倍贿赂 | 单次判定 | **两段判定**（原值一次、双倍值一次，可能 +2 罪恶） | 同上 | ⚠️ 待确认 |

| 7 | 「借口编造器」 | 无条件 50% | **1d6 ≥ 4** | `PayBribe` 的 `rnd.Next(1,7) > 3` | ✅ 已修 |

| 8 | 「一帆风顺」 | 覆盖贿赂额 | **覆盖的是"罪恶值"** | `PayBribe` 里改的是 `malice` 变量 | ✅ 已修（`homelessSmooth`） |

| 9 | 监狱刑期 | `term--`，归零释放 | **累加到上限 → `JailRank++`；rank 满 → +1 齿轮** | `ChangeRes` 的 `Term` 分支 | ✅ 已修 |

| 10 | 服刑抽牌 | 1 张/回合 | **2/2/3/3/4 张（按 rank）** | `GPlayer.GetJailCardLimit` | ✅ 已修 |

| 11 | 建筑每回合一次 | 只有站点动作限次 | **每次到访只能用一个可选动作** | `GPlayer.*Visited` 共 11 个字段 | ✅ 规则已实现（`optionUsedThisTurn`）；⚠️ 原版"每建筑一个 visited 字段"的**语义仍无法证实**（那些字段全仓库无读写点） |

| 12 | 收入夹取 | — | **被夹取时不触发银行家「钱生钱」** | `ChangeRes` 的 `flag` 语义 | ⚠️ 待确认 |

| 13 | 检察官贿赂 | 未实现 | **每 2 点罪恶 +1 贿赂**（而非每点） | `GetBribe` 的 Judge 分支 | ✅ **已修**（`judgeJustice`，`perMalice = 1/2`）。本条原标"未实现"**已过时** |

| 14 | 政治家「呼吸税」 | 未实现 | **镇长是政治家时，全员贿赂 +5** | `GetBribe` 的 `Breathing_Tax` 分支 | ✅ **已修**（`breathingTaxFrom`）。本条原标"未实现"**已过时** |



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



以下每条都用源码/数据复核过；**"当时的实现"是旧状态，多数已修**（见复核状态列）。



| # | 项目 | 当时的实现 | 原版 | 依据 | 复核状态 |

|---|---|---|---|---|---|

| 15 | **经过生效的格子** | Income/Bribe 对，Misfortune 注释"经过不触发" | **只有 `Income` / `Bribe` / `Misfortune` 三格经过生效**；其余 15 格经过完全无效果 | `LocationDetailsPanel.cs:341-346` 的 `passEffectTypes` 写死 | ✅ 已修（过滤器 + switch 均只含这三格） |

| 16 | **经过厄运格** | 不抽厄运 | **必须抽 1 张厄运** | 同上 + `GConst.MF_SELECT` | ✅ 已修 |

| 17 | **演讲格 Tribune** | 停留直接 `+param1` 选票 | **下注 10/20/30/40/50$ 后掷骰**；`Label1..5` 是五档判定门槛，`Label6` 是"不演讲" | `params=[10,20,30,40,50,0]` + `TAG.CellType_Tribune_Label1..5` | ✅ 已修（含档位门槛解析） |

| 18 | **冒险格 Danger** | 停留只打日志 | **强制掷骰**：掷 1 → 厄运；可先买 40$ 保险 | `params=[40,...]` + `TAG.CellType_Danger_Label1..6` | ✅ 已修 |

| 19 | **赌博格 Risk** | 停留只打日志 | 掷骰：1 厄运 / 2 `−50$` / 3 `−1& +1^` / 4 `+50$` / 5 `+2&` / 6 `+100$` | `params=[0,50,1,50,2,100]` + Label1..6 | ✅ 已修 |

| 20 | **监狱格刑期** | `term--` 归零释放 | **掷骰定刑**：1,2→4 次；3,4→3 次；5,6→2 次。**单次刑期上限只有 4**，与 `JAIL_RANK_*_TERM` 是**两套不同机制** | `TAG.CellType_Jail_Label1..6` + `Jail.params=[2,3,4]` | ✅ 已修（`jailTermFor`） |

| 21 | **Bribe/Police 对镇长无效** | 部分实现 | 两格**明文"本格规则对镇长无效"**，且**贿赂不给镇长** | `cell_types.json` 的 `Description`（英文完整） | ✅ 已修（两格均有 `mayorId` 判定） |

| 22 | **天界电梯** | 当作"可选动作" | 原版是**在地图图结构上加一条"银行→天界"的边** | `CD.cs:10966` / `CD.cs:11015` | ✅ 已修（`astralFromBank`） |



### 3.5 选举与牌库（经客户端代码验证）



| # | 项目 | 当时的实现 | 原版 | 依据 | 复核状态 |

|---|---|---|---|---|---|

| 23 | **选举胜出条件** | （曾写反为"罪恶最低者当选"） | ☑️ **已更正**：判定依据是**选票**，**票数最高者当选**。罪恶只决定"谁拿 +3 票加成"（`ELECTION_VOTE_BONUS`），且**全员罪恶相同则无人获得**。另有政治家 `Politician_Connections` 加票。**票数并列**时再按罪恶较低者筛选；若筛选后仍含**全部玩家**则无人当选 | `CAvatarForm.cs:591-664`、`CElectionForm.cs:262-304` | ✅ 已修（含平局与无人当选） |

| 24 | **`ELECTION_SCORE_BONUS = 1`** | 曾写"无使用点" | ☑️ **已更正**：当选即 `+1 齿轮`（客户端只负责显示 `WinPlayerID`，加齿轮在服务端，故客户端 grep 不到） | `CAvatarForm.cs` / `CElectionForm.cs` | ✅ 已实现 |

| 25 | **厄运牌库剔除规则** | 未实现 | **玩家 ≥ 5 人时硬编码剔除 `m029 丢失的债券`**（hex `F7C040EC0741FE1C`） | `GGame.cs:708-769` | ✅ **已修**（`MF_EXCLUDED_AT_FIVE_PLAYERS`）。本条原标"未实现"**已过时** |

| 26 | **厄运/监狱/混沌牌堆** | 部分实现 | 抽完**不回库**、整副**立即重洗** | `GGame.cs:708-769` | ✅ 已修（`buildMisfortuneDeck` 按 `DeckCount` 展开并重洗） |

| 27 | **混沌卡归属** | 共享池（已对） | 6 张**共享公开池**、无 `DeckCount`/无归属 → **每张全局唯一，先抢先得** | `CChaosCardForm.cs` | ✅ 一致（另有全生命周期测试） |

| 28 | **`SpecialFlag` 语义** | 未知 | = **卡面"特殊规则"角标**（`this.SpecialIcon.Active = card.SpecialFlag;`，纯展示） | `CChaosCardForm.cs:757` | ✅ **已实现**（`Card.tsx` 的 `⚙` 角标 + 混沌卡列表前缀）。注意 186 张行动卡里 **145 张** `SpecialFlag=true`，是常态而非例外 |

| 29 | **监狱牌 `Rank`/`Karma`** | 未实现 | 监狱牌有 `Rank`（解锁等级）与 `Karma`（表现 −1/0/+1，决定可抽卡池） | `GJailCard.cs` + `GGame.JailPickCard()` | ✅ **已修**（`jailKarma` / `jailCardLimit`）。本条原标"未实现"**已过时** |



---



## 四、实现优先级建议



1. **先改数值类更正（第 1–4 项）**——改动小、依据明确、立刻影响玩法。

2. **再改站点规则（第 15–21 项）**——这几条决定了"走一格会发生什么"，

   是玩法差异最明显的地方。

3. **补齐监狱 rank 系统（第 5、9、10、20 项）**——当前是一套完全不同的模型。

4. **把所有建筑的"每次到访一次"落实**（第 11 项）。

5. **按 `行动卡.md` 逐张核对卡牌效果**，以文档为准。

6. 最后处理回合流程与解析顺序（受反编译范围所限，需交叉验证）。




