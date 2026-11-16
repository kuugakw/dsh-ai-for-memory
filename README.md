# AI for Memory — DSH 插件

[![Status](https://img.shields.io/badge/status-test%20build%200.1-orange.svg)]()
[![Version](https://img.shields.io/badge/version-0.1-lightgrey.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **这是测试版 0.1，不是正式版。** 核心链路已实测可用，但接口、存储格式、面板布局都还会改。
> 测试期间统一标 **0.1**，不按功能拆分版本号；正式发布后再启用语义化版本号。
> 不建议直接用于关键生产数据；升级前请备份记忆目录。

一个给 **DeepSeek Harness** 用的**项目级分层记忆插件**，同时解决两个层面的问题：

1. **上下文层面**——把对话整理进存储、按话题相似度清理当前上下文、需要时再调回来；
2. **记忆层面**——把工作过程、决策、错误、界面事实沉淀成可检索、可恢复的本地数据；
3. **知识层面**——把结论沉淀成带分类与出处的文本知识；与已有知识冲突时先问你，确认后才写入。

纯 Node 实现（只用 Node 内置模块），**不联网、不依赖 embedding 服务、不需要 API Key**；
数据全部落在你指定的目录，跨会话、清空上下文之后仍然可读。

---

## 这个插件基于什么改写

本插件是 Python 项目 **[ai-game-for-memory](https://github.com/kuugakw/ai-game-for-memory)** 的
DSH 重写版。

那个项目最初叫 `memory-layer`（MemoryLayer），是作者为一个单机游戏里的本地 AI 写的记忆骨架：
游戏需要一个**完全离线**的 AI 记住玩家的行为、任务状态、世界事实，又不能把上下文撑爆，
还得在不能调云 API、不能依赖外部向量库的条件下跑起来。于是有了那套三层记忆结构
（临时记录 → 分类归档 → 精确快照）+ 本地 RAG + 正反合决策审查。

后来游戏方向变了，代码没用上，就以 `ai-game-for-memory` 的名字开源了。

本插件把这套思路搬到 DSH 上，并针对 Harness 的运行方式做了这些改造：

| 方面 | Python 原版 | 本插件 |
|---|---|---|
| 运行时 | Python 3.8+ | Node 20+，零外部依赖 |
| 使用者 | 库调用方 | Agent 工具（`aim_*`）+ Web 面板 |
| 工作区 | 调用方指定路径 | 跟随 DSH 会话工作区（含 `cd`），也可固定目录 |
| 上下文 | 自己维护 token 预算、淘汰旧内容 | 按话题相似度选轮次清理（也可退回 DSH `compaction` 整段压缩） |
| 恢复 | 快照恢复为 Python 对象 | 快照/上下文恢复为注入会话的消息 |
| 界面 | 无 | 侧栏面板：六层浏览 + 设置 |

所以它不是"又一个笔记工具"：**原版管的是"上下文有上界、记忆无上界"，本插件把这条主线
在 DSH 里真正实现了一遍**——包括压缩会话、把它存下来、以后调回去。

---

## 它解决什么问题

| 问题 | 本插件的做法 |
|---|---|
| **上下文会爆**：多步任务、长对话迅速占满窗口 | 按话题相似度清出低相似度老轮次 → 需要时 `restore` 调回（也可退回整段压缩） |
| **一清上下文就失忆**：全清重建成本高且容易丢状态 | 清理前先存 `contexts/`，恢复时作为消息注入，不靠语义检索碰运气 |
| **记忆无处安放**：重要决策、错误、界面事实散落在聊天里 | 过程记录 + 分类归档 + 知识库检索，全部落文件系统 |
| **单模型决策风险**：不可逆操作容易翻车 | 正反合审查，高风险必须给出正反理由，权重可审计 |
| **知识检索不准**：所有东西塞一个索引互相干扰 | 只检索知识文档，支持按分类过滤；过程记录不进检索索引 |
| **对话互相污染**：多段工作共用一个记忆池，历史越混越乱 | 每个对话独立存储；默认跨对话检索，命中标注来源 |

---

## 对话隔离：每个对话独立，又能跨对话

记忆以**对话（Session）为单位隔离**，而不是所有对话共用一坨数据：

- **新建对话就自动建记忆文件夹**：`sessions/s_<hash>/` 里预建六层和 `session.json`，不用等到第一次写入；
- 每个对话写入的是**自己的六层存储**，别的对话不会看到你的临时记录、快照和上下文存档；
- 每个对话可以**读到**其他对话的知识和记录——`aim_search` 默认就跨对话检索，命中结果逐条标注来源；
- **工作区分组**：对话按「它是在哪个工作区里开的」分层，判据是 DSH 自己的会话分桶
  （`~/.dsh/sessions/--D-ai-~5DE5~4F5C~533A--/` 这类编码路径），而不是对话当下的 cwd——
  对话中途 `cd` 进子目录不会冒出一个假工作区，只有你在 DSH 里新建工作区才会多出一组；
- 面板上有「查看范围」：先选范围（本对话 / 指定对话 / 全部对话 / 共享层），选「指定对话」后再选
  **工作区**和该工作区下的**对话**；「全部对话」是合并视图，每行标注来源对话；
- 下拉里显示**对话名称**：面板里可以给对话命名（会同步到 DSH 侧栏标题），不命名时显示 DSH 自动生成的标题，例如
  「修复GitHub发布文件夹问题」「大肥鱼」；
- **每个对话可以单独设置对外开放 / 不开放**：不开放的对话只有它自己能读，别的对话的跨对话检索、
  恢复和「全部对话」视图都会跳过它。

这样同时满足三件事：**历史干净**（不会把别的对话的过程记录混进来）、**记忆不丢**（新对话可以检索旧对话
沉淀的知识）和**可控隐私**（敏感对话可以关掉对外访问）。这就是"变相的跨对话"：写入隔离、读取按开关。

| 层 | 作用域 | 其他对话能读吗 |
|---|---|---|
| 过程记录 `staging/` | 本对话 | 通过面板「全部对话」可见 |
| 分类归档 `archive/` | 本对话 | 同上 |
| 快照 `snapshots/` | 本对话 | `aim_memory restore` 默认先本对话、找不到再跨对话 |
| 知识 `knowledge/` | 本对话 | **是**，`aim_search` 默认跨对话 |
| 决策 `decisions/` | 本对话 | 面板「全部对话」可见 |
| 上下文存档 `contexts/` | 本对话 | `aim_context restore` 可跨对话调回 |

> 以上"其他对话能读"都只在**该对话对外开放**时成立；关闭后一律不可见（本对话始终可读自己）。

写入范围用 `scope` 参数控制：

- `scope=session`（默认）：写进当前对话自己的存储；
- `scope=shared`：写进根目录的**共享层**，所有对话共用（适合跨对话约定、全局事实）。

> 升级到本版本后，**旧的根目录数据不会丢**，它们落在「共享层」里：默认视图（本对话）看到的是空的，
> 切到「共享层」或「全部对话」即可看到。新写入从对话隔离层开始，旧数据保持原样。
> 升级前已存在的对话不会自动补建目录，但下一次 `turn/end` 或记忆工具调用会自动补上。

---

## 架构：六层存储

```text
                     ┌──────────────── AI for Memory ────────────────┐
                     │                                               │
 每步过程/决策/错误 │  ① 过程记录  staging/    按小时滚动，只追加      │
 截图/推理/状态 ────┼──▶ 未分类原始记录 ──┐                          │
                     │                     ▼                         │
                     │  ② 分类归档  archive/   按 kind 路由，幂等      │
                     │                                               │
 需要精确恢复的状态 ┼──▶ ③ 快照  snapshots/  全量 JSON，直接替换     │
                     │                                               │
 可检索的知识文档 ──┼──▶ ④ 知识  knowledge/  BM25 + 哈希向量          │
                     │                                               │
 需要审查的决策 ────┼──▶ ⑤ 决策  decisions/  正反合 + 可审计权重     │
                     │                                               │
 上下文要清理时 ────┼──▶ ⑥ 上下文 contexts/  对话存档，可注入恢复    │
                     └───────────────────────────────────────────────┘
```

数据流向是单向的：**先记过程（快）→ 再归档（可重放）→ 状态/上下文用存档兜底**。
上面这套六层在每个对话目录里各有一份；根目录那份是共享层。

每个功能是干什么的（面板里点了也会在标签下方显示这段说明）：

| 功能 | 一句话解释 | 什么时候用它 |
|---|---|---|
| ① 过程记录 `staging/` | 把「刚发生了什么」原样落下，一行一条，只追加不修改 | 每一步动作、决策、错误、界面事实，先记下来 |
| ② 分类归档 `archive/` | 把过程记录按类型收进固定分类文件，幂等可重放 | 一个阶段结束，或需要按类型回看历史时 |
| ③ 快照 `snapshots/` | 保存某一刻的精确状态对象，按 id/名字原样取回 | 重构前、清理前，需要精确回滚的时候 |
| ④ 知识 `knowledge/` | 一句句可复用的结论，八类分类 + 出处 + 自动合并 | 记住网页/推理得到的事实、你给的规则，或从三层提炼 |
| ⑤ 决策 `decisions/` | 高风险操作的正反理由、权重与审查结论 | 不可逆操作之前，回答「为什么当初这么定」 |
| ⑥ 上下文 `contexts/` | 对话窗口的存档，清理前先全文保存 | 清出低相似度轮次之前，之后用 restore 调回 |

---

## 工具参考

插件注册四个工具。**手动工具始终可用，与自动整理开关无关。**

### `aim_memory` — 记忆读写

| action | 作用 | 必填参数 |
|---|---|---|
| `stage` | 追加一条过程记录 | `content` |
| `archive` | 按 kind 归到分类文件（幂等） | — |
| `snapshot` | 保存精确状态快照 | `name` |
| `restore` | 按 id/名称恢复快照 | `snapshot_id` |
| `list` | 列出快照 | — |
| `remember` | 写入一条知识（同一条重复写入会合并；与已有知识冲突时先返回待确认） | `text`（`doc_id` 可省） |
| `learn` | 批量写入知识（逐条走同一个冲突闸门） | `items` |
| `promote` | 从过程记录/归档/上下文提炼知识 | — |
| `forget` | 删除一条错误知识 | `doc_id` |
| `status` | 各层统计（含知识分类/来源与待提炼数） | — |

`scope` 参数（所有 action 通用，默认 `session`）：

| 取值 | 写入位置 |
|---|---|
| `session` | 当前对话自己的存储（默认） |
| `shared` | 根目录共享层，所有对话共用 |

`stage` 的附加参数：

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `kind` | `action` / `screenshot` / `decision` / `reasoning` / `error` / `state` / `digest` / `unknown` | `action` | 决定归档去向 |
| `source` | 任意字符串 | `""` | 来源标识，如 `gui`、`api`、`agent` |
| `risk` | `low` / `medium` / `high` | `low` | 风险等级（记录用） |
| `verify` | `pending` / `pass` / `fail` / `skip` | `pending` | 验证状态 |

kind → 归档分类的路由表：

| kind | 归档分类 |
|---|---|
| `action` | `action_logs` |
| `screenshot` | `ui_facts` |
| `decision` / `reasoning` | `decisions_reasoning` |
| `error` | `errors_fixes` |
| `state` | `behavior_tristate` |
| `digest` / `unknown` | `action_logs` |

`ui_maps` 与 `snapshots` 是保留分类；需要时可给 `archive` 传 `category` 强制写入。

```text
aim_memory action=stage content="设置页有三个选项卡" kind=screenshot source=gui
aim_memory action=stage content="保存超时，重试后成功" kind=error risk=medium
aim_memory action=stage content="发布前必须跑测试" kind=state scope=shared
aim_memory action=archive
aim_memory action=snapshot name=before-cleanup state={"step":"清理临时文件"}
aim_memory action=restore snapshot_id=before-cleanup
aim_memory action=remember doc_id=err_timeout text="超时先重试三次，仍失败则通知用户" category=errors_fixes
aim_memory action=status
```

---

## 知识：文本层（RAG 的前置）

知识分两半：**文本**和 **RAG**。当前只实现文本层；RAG 要等文本语料稳定之后，再从这些文档建索引，
最后挂到模型身上（检索后注入）。所以这里刻意把文档形状定死，让后面建索引不用返工。

### 文字从哪里来

| 来源 | 由谁写 | 怎么进 |
|---|---|---|
| 网页 / 推理得到的结论 | 模型 | `remember` / `learn`，带 `source=web` 或 `reasoning`，网页必须带 `url` |
| 用户给的规则、偏好、约定 | 模型 | `remember` / `learn`，带 `source=user` |
| 过程记录、归档、上下文里的用户规则 | 插件 | `promote` 自动提炼（按「记住/以后/统一/必须/不要/禁止/默认…」这类句式） |
| 错误与修复 | 插件 | 过程记录里 `kind=error` 的条目 |
| 决策与理由 | 插件 | `aim_decide` 的决策记录 |
| 状态类事实 | 插件 | 过程记录里 `kind=state` 的条目 |

自动整理开启时（`autoKnowledge: true`），每 N 轮的整理会顺带跑一次 `promote`，
所以知识库会自己长大；`aim_memory status` 里的「待提炼」就是还没提炼的层条目数。

### 每条知识的形状

```json
{
  "doc_id": "k_921036f3",
  "text": "DSH 的压缩阈值默认是 0.8",
  "category": "tools_apis",
  "source": "web",
  "tags": ["compaction"],
  "url": "https://example.com/compaction",
  "confidence": 0.7,
  "evidence": [{ "kind": "web", "ref": "web", "at": "2026-11-16T13:19:41.400Z" }],
  "created_at": "...",
  "updated_at": "...",
  "revision": 2
}
```

- **一条一句结论**：不是过程日志，也不是整段摘要；
- **分类固定八选一**：`project_facts` / `ui_facts` / `errors_fixes` / `decisions_reasoning` /
  `tools_apis` / `workflow_rules` / `external_sources` / `open_questions`；
- **`doc_id` 由正文推导**（`k_<hash8>`），同一条事实重复写入会合并：`evidence` 累积、标签取并集、
  创建时间保留、首个来源不变——这是去重，也是"同一事实被多层确认"的证据链；
- **出处**：`source` 说明谁写的，`evidence` 记录每一次确认来自哪个层/哪条记录（`staging:`、`archive:`、
  `context:xxx#turn3`、`decision:xxx`）。

### 与已有知识冲突时，先问人

写入不是"覆盖式"的。`remember` / `learn` 在落盘前会先比对已有知识：

| 情况 | 行为 |
|---|---|
| 完全同义（token 重合 ≥ 0.85） | 合并进同一条，证据累积 |
| 同话题、措辞不同（0.55 ~ 0.85） | **不写入**，返回 `needs_confirm` + 至多 3 条冲突条目（`doc_id`、分类、相似度） |
| 无关 | 直接写入 |

被拦下时模型必须先问你：以哪条为准、是否覆盖旧条目、还是只是补充。你同意后它才带
`confirm=true` 重试（要覆盖旧条目就同时传旧条目的 `doc_id`）；你不同意，这条就不会进库。
"新内容与你自己的认知不一致"同样适用——这是工具描述里写明的行为，不依赖模型自由发挥。

`promote` 走内部合并（`confirm: true`），不受这个闸门影响：它合并的是同一份过程记录的重复说法，
不是你确认过的结论。


### 提炼是确定性的

`promote` 不做改写、不调模型、不联网：它只把**已经说得像结论的句子**从三层里挑出来，
加上分类与出处写进 `knowledge/`。它也因此保守——提炼不出来的时候，需要模型自己用 `remember` 写。
`_promoted.json` 是提炼台账，保证同一层条目只提炼一次，重复跑不会产生重复文档。

```text
aim_memory action=promote dry_run=true          # 先看会提炼出什么
aim_memory action=promote                       # 写入
aim_memory action=remember text="发布前必须跑测试" category=workflow_rules source=user
aim_memory action=learn items=[{"text":"...","category":"tools_apis","source":"reasoning"}]
aim_memory action=forget doc_id=k_921036f3      # 写错了一条，删掉
```

### `aim_search` — 本地知识检索

| 参数 | 说明 |
|---|---|
| `query`（必填） | 检索词或自然语言问题 |
| `scope` | `all`（默认，跨对话）/ `session`（只查本对话）/ `shared`（只查共享层） |
| `category` | 只检索某个知识分类 |
| `mode` | `bm25` / `vector` / `hybrid`（默认） |
| `top_k` | 返回条数，1–50，默认取配置 |

- `bm25`：关键词匹配（k1=1.5，b=0.75）
- `vector`：128 维哈希词袋向量 + 余弦相似度
- `hybrid`：`0.6 × 归一化 BM25 + 0.4 × 余弦`

> 这是**词袋向量，不是语义 embedding**：同义改写可能检索不到。
> `scope=all` 时每个对话各建一份索引再合并排序，所以同名 `doc_id` 不会互相覆盖，命中会标注「来源：本对话 / 对话 xxx / 共享」；
> **未对外开放的对话不会出现在 `all` 结果里**（本对话除外）。

```text
aim_search query="超时怎么处理" mode=hybrid
aim_search query="设置页" category=ui_facts top_k=3
aim_search query="发布流程" scope=session
```

### `aim_decide` — 正反合决策审查

| 参数 | 说明 |
|---|---|
| `decision`（必填） | 要执行的决策 |
| `risk` | `low` / `medium` / `high`，默认 `low` |
| `thesis` | 支持理由（正） |
| `antithesis` | 反对理由（反） |

规则：

| 风险 | 行为 |
|---|---|
| `low` | 直接放行（不浪费审查），`reviewed=false` |
| `medium` | 默认放行；`reviewHighRiskOnly=false` 时审查，`antithesis_weight ≤ 0.5` 批准 |
| `high` | 必须审查，`risk_adjusted_score ≤ 0.3` 才批准 |
| 缺理由 | 需要审查却没给正/反理由 → `needs_more_info`，**不会编造理由替你放行** |

权重：

```text
thesis_weight       = len(thesis) / (len(thesis) + len(antithesis))
antithesis_weight   = len(antithesis) / (len(thesis) + len(antithesis))
risk_adjusted_score = antithesis_weight × risk_multiplier
risk_multiplier     = low 1.0 / medium 1.2 / high 1.5
```

`risk_adjusted_score` 是"风险调整后的反对强度"，越高越危险。审查记录写入 `decisions/`，可审计。

```text
aim_decide decision="删除全部临时文件" risk=high \
  thesis="释放磁盘空间，避免写满" \
  antithesis="可能丢失未归档的过程记录"
```

### `aim_context` — 上下文存档 / 清理 / 恢复

| action | 作用 |
|---|---|
| `save` | 把当前对话（含进行中的轮次）整理成存档，存进**本对话** |
| `clear` | 登记一次清理：本轮结束后按**话题相似度**清出低相似度的老轮次，相似度高的原样保留 |
| `restore` | 把指定存档注入回当前会话（下一步生效）；默认先找本对话，再找其他对话和共享层 |
| `list` | 列出上下文存档；默认只列本对话，`scope=all` 列全部 |
| `status` | 清理策略与阈值、自动整理状态、待清理标记、最近一次清理结果、对话数量 |
| `sessions` | 列出所有**可见**对话及其各层规模（未对外开放的只显示数量，不显示内容） |

`scope` 参数控制 `list` / `restore` 的查找范围：`session`（默认）/ `all` / `shared`。

```text
aim_context action=save name=before-refactor
aim_context action=clear
aim_context action=list
aim_context action=list scope=all
aim_context action=restore context_id=context_20261113_172815_e4f9
aim_context action=sessions
aim_context action=status
```

### 清理按话题相似度，而不是按"旧的都清掉"

早期版本 `clear` 直接调用 `compaction.compactNow()`，那是一次**整段压缩**：凡是超出保留尾部的历史，
不管还相不相关都会被摘要替换，长对话里常常"清太多了"。现在的 `clear` 是逐个轮次判断：

1. 以**当轮与上轮**的话题为基准（最近 `keepRecentTurns` 轮永远保留）；
2. 每个更早的轮次与基准做话题相似度打分（本地词面重合 + 哈希向量余弦，无网络、无模型调用）；
3. 相似度 ≥ `similarityThreshold` 的轮次**原样留在上下文里**，只有真正换了话题的老轮次才清出；
4. 清出前先把这些轮次的全文写进 `contexts/`，被清出的位置换成一条说明（第几轮、存档 id、怎么调回）；
5. 单次清理受 `maxClearTurns` / `minClearChars` / `maxClearChars` 约束，不会一次掏空。

被清出的内容随时可以用 `aim_context restore` 调回——这条没有变，也**不能**丢：
存档写在替换之前，即使清理失败也已经落盘。

`topicalClear: false` 可以退回旧的整段压缩行为（需要 `@deepseek-ai/dsh-compaction-basic`）。

---

## 手动工具 + 自动整理：共存

这是本插件最重要的使用约定：

- **手动工具始终可用**。自动整理开或关，`aim_memory` / `aim_search` / `aim_decide` / `aim_context` 都在。
- **自动整理只是一个可开关的附加层**：开启后额外每 N 轮自动跑一次整理，不会夺走手动能力。

### 自动整理开启时，每 N 轮会做

1. 把最近 N 轮对话压成一条 `digest` 过程记录；
2. 归档到分类文件；
3. 本轮结束后按话题相似度清理上下文：低相似度的老轮次被清出并先存档，相似度高的原样保留。

其他规则：

- 自动整理写入**当前对话自己的存储**，不会污染其他对话；
- 子会话（subagent）不触发自动整理，避免同一段记忆写两遍；但子会话里的手动 `clear` 仍生效。
- 轮次计数是内存态：插件重载 / 进程重启后从 0 开始计。
- 关闭自动整理不会删除已产生的任何数据。

---

## 上下文生命周期

```text
对话进行中
   │
   ├─（手动）aim_context save ──────────────▶ contexts/<id>.json
   │
   ├─（手动）aim_context clear
   │      ├─ 1. 标记"待清理"
   │      └─ 2. 本轮 turn/end 后、agent 空闲时：
   │             ├─ 按当轮/上轮话题打分，挑出相似度低的老轮次
   │             ├─ 先把这些轮次全文写进 contexts/<id>.json
   │             └─ 把它们在窗口里替换成一条"已清理 + 存档 id"的说明
   │
   └─（自动整理开启）每 N 轮重复上面两件事

需要旧信息时
   │
   └─ aim_context restore <id>
          └─ agent.inject() ──▶ 存档作为一条上下文消息进入下一步
```

关键点：

- **清理必须等本轮结束**：改写会话表面前要确保 agent 空闲，所以 `clear` 是"本轮结束后生效"。
- **恢复是注入，不是改历史**：`restore` 不重写已发生的会话事件，只是把存档作为下一条消息喂给模型。
- **存档先于清理**：`contexts/` 在替换之前写入，清理失败也不会丢内容；`restore` 读的就是它。
- **存档按对话隔离但可跨对话恢复**：本对话的上下文存在本对话目录；`restore` 也接受别的对话保存过的 id。
- **清理结果会落盘**：每个对话目录各有 `compaction_status.json`，记录 `state`（started / done / skipped / error / unavailable）、
  清出轮数、条数、字符数、保留轮数、存档 id 与原因；`aim_context status` 和面板都能看到。
- **旧的整段压缩仍可选用**：`topicalClear: false` 时回到 `compaction.compactNow()`，此时才需要 `@deepseek-ai/dsh-compaction-basic`。

---

## Web 面板

安装后左侧栏出现「AI 记忆」图标（三层堆叠图标），点开是面板：

| 区域 | 功能 |
|---|---|
| 顶部 | **查看范围**（本对话 / 指定对话 / 全部对话 / 共享层）、**工作区**、**对话**、记忆目录下拉（固定目录优先）、刷新 |
| 路径条 | 显示当前目录、**复制**、**打开文件夹**（调系统文件管理器） |
| 统计 | 六个数字：过程记录 / 归档 / 快照 / 知识 / 决策 / 上下文（按当前范围统计） |
| 对话设置 | **对话名称**（可编辑，会同步 DSH 侧栏标题）、**对外开放**开/关、记忆文件夹位置 |
| 页签 | 六层浏览，每个页签带一句说明；知识页签带 id / 正文 / 分类 / 出处过滤；快照可展开看 state；「全部对话」时每行标注来源 |
| 设置 | **自动整理开/关**、每 N 轮、**按话题相似度清理**开/关 + 阈值 + 保留轮数、记忆地址、目录名、**新对话默认对外开放**；保存后插件自动重载 |

「查看范围」的行为：

- 打开面板默认落在**本对话**（Host 按最近活动判断当前对话，面板用 `useSessions` 目录补上标题）；
- 选「指定对话」后多出两级下拉：先是**工作区**（按 DSH 的会话分桶分组，显示目录名与对话数，鼠标悬停看完整路径），
  再是该工作区下的**对话**；切换工作区会自动选中它的第一个对话；
- **工作区只在你真的新建工作区时才会变多**：判据是 DSH 记录的分桶路径，而不是对话当下的 cwd，
  所以对话中途 `cd` 进子目录不会多出假工作区；早期没有记录工作区的旧对话统一归到「未记录工作区」；
- 选「全部对话」会合并所有**开放**对话 + 共享层，并给每条记录加来源标签；
- 本对话为空但共享层有旧数据时，面板会提示共享层还有多少条，可直接切换。

界面细节：

- 六个页签的选中态是**当前页签内部的一条指示条**（只有选中页签会渲染它），切换时旧的下划线随元素卸载，
  不会残留在上一个页签上；
- 设置区的开/关是**文字 + ● 标记**（选中品牌色加粗），不用下边框，也就不存在"旧开关还留着下划线"；
- 面板动效统一（面板淡入上移、页签指示条展开、切换页签内容淡入、悬停微浮、按钮按下缩放、刷新时脉冲），
  时长 ≤ 260ms，系统开启「减少动态效果」时全部关闭。

「对话设置」的行为：

- 名称留空时显示 DSH 自动生成的标题；填了名称就以这里为准，并尽量同步到 DSH 侧栏；
- 对外开放默认跟随配置 `defaultPublic`；关掉后其他对话的检索/恢复/合并视图都读不到它；
- 切换顶部「查看范围」后可以逐个对话设置。

面板通过 Host 的只读 HTTP API 读数据：

- `GET /ai-for-memory/api/state?scope=session|all|shared&session=<对话>` — 当前范围的六层快照 + 对话列表
- `POST /ai-for-memory/api/session` — 修改一个对话的名称 / 对外开放状态
- `POST /ai-for-memory/api/reveal` — 打开文件夹
- `POST /ai-for-memory/api/config` — 保存设置

安全边界：

- 只允许访问**登记过的记忆目录**（`$DSH_HOME/ai-for-memory/roots.json`）与配置的固定目录，
  不会变成任意文件读取器；
- 写操作要求回环来源 + 可信 Origin；
- 目录名必须是单段名称（不允许 `..`、路径分隔符）。

---

## 数据目录

默认：每个项目各自存在工作区下的 `.ai-for-memory/`。
在面板设置里填**绝对路径**（如 `D:\ai\工作区\ai-for-memory-data`）则所有项目共用一个固定目录。

```text
<记忆地址>/
├── staging/staging_<YYYYMMDDTHH00>.jsonl   # 共享层 ① 过程记录
├── archive/<category>.jsonl                # 共享层 ② 分类归档（含 START_MARKER 审计行）
├── snapshots/<name>_<ts>.json              # 共享层 ③ 精确状态快照
├── knowledge/<doc_id>.json                 # 共享层 ④ 知识文档
├── knowledge/_promoted.json                # 提炼台账（哪些层条目已提炼过）
├── decisions/<decision_id>.json            # 共享层 ⑤ 决策审查记录
├── contexts/<context_id>.json              # 共享层 ⑥ 上下文存档
├── compaction_status.json                  # 共享层最近一次清理/压缩结果
└── sessions/                               # 每个对话一份完整六层
    └── s_<16 位哈希>/
        ├── session.json                    # 对话元数据（session_id / workspace / parent / 时间）
        ├── staging/ archive/ snapshots/ knowledge/ decisions/ contexts/
        └── compaction_status.json
```

- 目录名是 `Session id` 的哈希（`s_` + 16 位十六进制），所以任何 Session id 都不会变成非法路径；
  真实 id 记录在 `session.json` 里，面板和工具用它显示「对话 xxxx」。
- `session.json` 记录：`session_id`、`workspace`、`parent_session_id`、`auto_title`（DSH 自动标题）、
  `label`（面板里手动起的名字，优先于自动标题）、`public`（是否对外开放，缺省为开放）。
- 根目录的六层是**共享层**：升级前的旧数据就在这里，`scope=shared` 写的新数据也在这里。
- 新建对话时就会创建对话目录并预建六层；升级前已存在的旧对话在下一次 `turn/end` 或记忆工具调用时补建。

### 文件格式

**过程记录**（每行一条 JSON）：

```json
{
  "dedup_id": "40 位 sha256 前缀",
  "source_file": "staging/staging_20261113T1800.jsonl",
  "entry_index": 0,
  "timestamp": "2026-11-13T10:00:00.000Z",
  "kind": "error",
  "content": "保存超时，重试后成功",
  "source": "api",
  "risk": "medium",
  "verify": "pending"
}
```

**归档行**：`type: "ARCHIVE_ENTRY"`，字段同上并追加 `archived_at`；
`type: "START_MARKER"` 记录批次（`batch_id` / `timestamp` / `source_files` / `category`），仅供审计。

**上下文存档**：

```json
{
  "context_id": "context_20261113_172815_e4f9",
  "label": "manual-checkpoint",
  "session_id": "session-bc1b8d41-...",
  "created_at": "2026-11-13T09:28:15.258Z",
  "turn_from": 1, "turn_to": 15, "turn_count": 15, "chars": 29704,
  "turns": [ { "turn": 1, "user": "...", "assistant": "..." } ],
  "text": "已渲染的完整文本（恢复时用它）"
}
```

**知识文档**：

```json
{
  "doc_id": "k_921036f3",
  "text": "DSH 的压缩阈值默认是 0.8",
  "category": "tools_apis",
  "source": "web",
  "tags": ["compaction"],
  "url": "https://example.com/compaction",
  "confidence": 0.7,
  "evidence": [{ "kind": "web", "ref": "web", "at": "2026-11-16T13:19:41.400Z" }],
  "created_at": "...", "updated_at": "...", "revision": 2
}
```

**提炼台账** `knowledge/_promoted.json`：`{updated_at, refs: {"staging:<dedup_id>": {at, doc_id}, "context:<id>#turn3": {...}}}`，
只记"哪条层条目已经提炼过"，最多保留 4000 条。

---

## 配置

在 profile 的 `cordis.patch.yml` 覆盖 `ai-for-memory` 行，或用面板的「使用与存储设置」：

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `directoryName` | `.ai-for-memory` | 单段名称 | 工作区下的记忆目录名（`root` 为空时生效） |
| `root` | `""` | 绝对路径或空 | 固定记忆目录；非空时所有项目共用 |
| `autoEnabled` | `false` | 布尔 | 自动整理开关；**手动工具始终可用** |
| `autoEveryRounds` | `5` | 1–100 | 自动整理每 N 轮触发 |
| `maxContextChars` | `30000` | 1000–200000 | 单份上下文存档最大字符数（`save` 用；清理存档不受此限） |
| `topicalClear` | `true` | 布尔 | `true`=按话题相似度清理；`false`=旧的整段压缩（需要 compaction 后端） |
| `similarityThreshold` | `0.06` | 0.01–0.95 | 相似度阈值：低于它的老轮次才清出；调大清得更多 |
| `keepRecentTurns` | `2` | 1–20 | 始终原样保留的最近轮数（当轮 + 上轮） |
| `maxClearTurns` | `8` | 1–50 | 单次清理最多清出几轮 |
| `minClearChars` | `600` | 0–20000 | 可清理内容少于这个字符数就不动，避免频繁抖动 |
| `maxClearChars` | `120000` | 1000–1000000 | 单次清理的存档上限；超出的轮次留到下次 |
| `autoKnowledge` | `true` | 布尔 | 自动整理时顺带 `promote`，让知识库自己长大 |
| `autoKnowledgeLimit` | `10` | 1–100 | 每次自动提炼最多写入几条 |
| `defaultTopK` | `5` | ≥1 | 检索默认返回条数 |
| `reviewHighRiskOnly` | `true` | 布尔 | `true` 时中风险直接放行，只审查高风险 |
| `maxContentChars` | `20000` | ≥1 | 单条过程记录 / 知识正文上限 |
| `maxSnapshotBytes` | `262144` | ≥1 | 单份快照序列化上限 |
| `defaultPublic` | `true` | 布尔 | 新建对话默认是否对外开放（之后可在面板逐个修改） |

---

## 设计取舍

- **零依赖**：不 import `@deepseek-ai/*`，避免插件管理器做 peer 版本校验时装不上；
  工具定义用普通对象，参数表由插件自己编译成 JSON Schema。
- **工作区按调用解析**：写记忆时优先 `workingDirectory` 服务（跟随 `cd`），回退 `session.header.cwd`；
  **面板里的工作区分组**则用 DSH 自己的会话分桶，因为对话中途 `cd` 不该产生新工作区。
- **知识写入有闸门**：同话题但措辞不同的新事实不会静默覆盖，而是返回冲突让模型先问用户——
  "不擅自改用户确认过的结论"是硬约束，宁可少写一条，也不悄悄换掉一条。
- **崩溃安全**：过程记录一行一条 JSON；若上次崩溃留下没有换行符的半行，追加前先补换行，
  读取时跳过坏行；序号按物理行计数，**`dedup_id` 不会复用**。
- **幂等归档**：归档前检查目标分类的 `dedup_id`，重复执行只补缺失条目。
- **快照脱敏**：快照名转成安全文件名（`../x`、`a/b` 写不出目录），同一秒同名自动加序号。
- **恢复用注入而不是改历史**：不篡改会话事件，只影响后续步骤。
- **清理按话题相似度选轮次**：复用本地 BM25/哈希向量词表打分，不花模型调用；
  只清相似度低的老轮次，相似度高的留原样，且存档先于替换——"删了能调回"是硬约束。
- **整段压缩作为可选后端**：`topicalClear: false` 时才走 DSH 原生 `compaction.compactNow()`。
- **检索是词袋**：BM25 + 128 维哈希向量，够用但不语义。
- **知识先文本后 RAG**：先把"一条一句、分类、带出处"的文本语料攒起来（`knowledge/<doc_id>.json`），
  再在这份语料上建索引；`promote` 的提炼是确定性的，不花模型调用，也不改写事实。
- **对话隔离用目录**：一个对话一个 `sessions/s_<hash>/`，删除某个对话的记忆只需删那个目录；
  跨对话只做"读"，写入永远落在明确的范围里，避免误改别的对话。
- **决策权重看理由长度**：粗糙，只适合示意 / 审计。

---

## 安装

```bash
git clone https://github.com/kuugakw/dsh-ai-for-memory.git
```

在 DSH 里用插件管理器安装该目录的绝对路径：

```text
plugin_manager action=install_bundle target=<克隆下来的 dsh-ai-for-memory 目录>
```

安装后：

- 工具列表出现 `aim_memory` / `aim_search` / `aim_decide` / `aim_context`；
- 侧栏出现「AI 记忆」面板；
- 插件管理器条目显示标题「AI 记忆」。

**上下文清理默认不需要额外的压缩后端**：按话题相似度的清理在插件内部完成，只改写会话表面前先存档。
如果需要旧的整段压缩（`topicalClear: false`），再启用 DSH 自带的压缩后端：

```text
plugin_manager action=set_plugin target=include:compaction-basic enabled=true
```

`aim_context status` 的「清理策略」一行会显示当前用的是哪一种。

### 卸载 / 升级

```text
plugin_manager action=remove_bundle target=dsh-ai-for-memory
```

升级：先 `remove_bundle`，再 `install_bundle`（同一目录链接会被复用，需重装才能加载新代码）。
升级前建议备份记忆目录。

---

## 开发与测试

```bash
cd dsh-ai-for-memory
node --test test/          # 34 个测试，无需启动 DSH
```

测试覆盖：过程记录去重与半行修复、归档幂等与路由、快照脱敏/恢复、三种检索模式、
决策三种结果、工具注册与端到端执行、面板数据组装、记忆根目录登记与解析、
上下文轮次归档（含进行中轮次）、自动整理触发、上下文保存/列表/恢复、
**话题相似度打分与轮次选择、按相似度清出并保留相似轮次、清理前存档可恢复、
全相关时不清理、低于阈值下限不抖动**、
**知识分类归一与稳定 id、词面去重、三层提炼（记录/上下文/决策）、提炼只跑一次、
同一条知识合并且出处累积、批量写入与删除、面板知识出处字段**、
**对话范围隔离与解析、跨对话检索的来源标注、每对话上下文存档与跨对话恢复、面板多来源合并、
新对话自动建目录与标题/访问默认、私有对话对其他对话不可见**。

插件结构：

```text
dsh-ai-for-memory/
├── index.js            # 插件入口：配置校验、4 个工具、自动整理监听、上下文管理
├── client.js           # Web 面板（侧栏入口 + 主面板 + 查看范围切换）
├── cordis.patch.yml    # bundle 挂载声明
├── package.json
├── icon.svg
├── locale/{en,zh}.json
├── lib/
│   ├── store.js        # 六层文件存储 + 幂等归档 + 快照/上下文
│   ├── scopes.js       # 对话隔离：每对话一份 store + session.json 元数据 + 解析
│   ├── activity.js     # 进程内对话活跃表（面板默认「本对话」的依据）
│   ├── util.js         # 去重 id、文件名脱敏、JSONL 安全读写
│   ├── retrieval.js    # 分词、BM25、哈希向量、混合检索
│   ├── decision.js     # 正反合审查与权重
│   ├── auto.js         # 轮次摘要
│   ├── context.js      # 轮次收集、上下文快照与恢复渲染
│   ├── similarity.js   # 话题相似度打分与"留哪些轮次"的选择
│   ├── knowledge.js    # 知识分类/去重/提炼（文本层，RAG 的前置）
│   ├── registry.js     # 记忆根目录登记表
│   ├── ui-state.js     # 面板数据组装（支持多对话合并）
│   └── api.js          # 面板 HTTP API（scope/session 参数）
└── test/core.test.mjs
```

---

## 版本策略

- **测试期间**：所有改动统一标 **0.1**，不按功能拆分版本号（避免"测试版却一路涨版本"的误导）。
- **正式发布后**：启用语义化版本号，并在本节之下记录每个版本的变更。
- 升级插件时（`remove_bundle` → `install_bundle`）请先备份记忆目录；本插件的数据格式会随之演进。

### 0.1 变更（测试期）

- **上下文清理按话题相似度**：不再整段压掉，只清与当轮/上轮相似度低的老轮次；清出前先存档，
  `aim_context restore` 可原样调回；面板里可调阈值与保留轮数，关掉则回到 DSH 原生整段压缩。
- **知识文本层**：八类分类、`doc_id` 由正文推导、证据链累积；`promote` 从过程记录/归档/上下文/决策
  确定性提炼，带台账避免重复；`remember` / `learn` / `forget` 手写与删除。
- **知识冲突闸门**：同话题不同说法先问用户，确认后才写入（`confirm` 参数）。
- **面板**：「查看范围」改成 范围 → 工作区 → 对话 两级目录，工作区按 DSH 会话分桶分组（中途 `cd`
  不会多出假工作区）；六个页签各带一句说明；选中指示条只在当前页签内渲染，修掉切换后旧下划线残留；
  设置区开/关改成文字 + ● 标记；统一面板动效并尊重系统「减少动态效果」。
- **两处修掉的坑**：对话列表曾用 cwd 当工作区（中途 `cd` 会造假工作区）；开关曾用实底药丸配白字，
  在浅色品牌色下文字看不清——现在是纯文字 + 品牌色加粗。

---

## 路线图

- [ ] 面板内直接编辑 / 删除 / 归档单条记录
- [ ] **知识 RAG**：在 `knowledge/` 文本语料上建本地向量索引，检索结果自动挂到模型上下文
- [x] 知识冲突的人工确认：同话题不同说法先问用户，确认后才写入（`confirm` 参数）
- [ ] 知识合并的人工确认：让用户挑选相似文档里哪条留、哪条覆盖
- [ ] 对话管理：合并、迁移、清理单个对话的记忆
- [ ] 自动整理按 token 压力触发，而不只是固定轮数
- [ ] 上下文存档增量与去重，避免重复保存
- [ ] 接入真实 embedding（本地小模型），替换哈希词袋向量
- [ ] 检索索引缓存，避免每次全量重建
- [ ] 单写者文件锁 / 更明确的并发语义
- [ ] 决策权重接入模型结构化置信度
- [ ] 面板虚拟滚动与大数据量分页
- [ ] 补齐英文文档与更完整的错误提示

---

## 已知限制

- **清理依赖 compaction**：没有压缩后端时只存档不清理；且只能在本轮结束、agent 空闲时执行。
- **恢复进入下一步**：不会重写已发生的历史，也不会自动"替换"当前上下文。
- **单写者**：同一工作区不要用多个进程同时写。
- **旧数据落在共享层**：升级后默认「本对话」视图是空的，切到「共享层」或「全部对话」能看到升级前的数据。
- **当前对话按最近活动判断**：面板拿不到「你此刻正在看哪个对话」的直接信号，默认取最近一次
  `turn/end`（或记忆工具调用）所在的对话；判断错了就用顶部「查看范围」手动选。
- **对话名称的双向同步**：面板改名会写进 `session.json` 并尝试同步 DSH 侧栏；会话已归档/非 live 时
  只能改记忆侧名称，侧栏标题需要等会话恢复后再改。
- **新建对话就建目录**：即使用户从不写入记忆，每个新对话也会有一个空的记忆文件夹；
  不需要的话可以在插件设置里把根目录指向临时位置，或之后手动删除。
- **跨对话检索是合并排序**：每个对话独立建索引再合并、按各自分数比较，不是全局单一索引。
- **面板只读**：浏览 + 设置，暂不支持删改单条记录。
- **冲突判定是词面重合**：`findConflicts` 比的是 token 重合度（0.55~0.85），不是语义理解；
  完全换一种说法的矛盾可能漏判，近义但互补的两条也可能被判成冲突——后者多问一次，方向是安全的。
- **检索是词袋**：同义改写可能检索不到；规模很大时每次调用都会重建索引。
- **没有事务**：崩溃保证"不毁掉已有行"，不是 WAL。
- **初版接口可能调整**：升级前备份记忆目录。

## License

MIT，见 [LICENSE](LICENSE)。
