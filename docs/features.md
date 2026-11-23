# AI for Memory 功能全览

> 这是一份**介绍性文档**，用于完整说明插件现在有哪些能力、这些能力如何协作、以及各自的使用边界。
>
> 它不替代主 [README](../README.md)，也不替代安装、工具参数、面板操作、本地模型等专门文档。需要精确操作时，请以对应文档和面板为准。
>
> 对应版本：**0.5.0**。

---

## 1. 它是什么

AI for Memory 是面向 **DeepSeek Harness（DSH）** 的项目级记忆插件。

它解决的不是“聊天记录存哪里”，而是：

- 上次已经确认过的项目事实，下一次还要重新解释；
- 刚修过的错误，过几天又踩一遍；
- 上下文被清掉后，之前的讨论、决策和结论找不回来；
- 多个对话各知道一点，但彼此不互通；
- 网页资料、项目约定、模型自己的推测混在一起，分不清哪些可信；
- 长对话塞满上下文窗口，清理时又怕把正在做的事一起删掉。

它的基本取向是：

- **JSON 是底座**：知识、上下文、快照、决策都能直接打开、审查、修正；
- **模型写入默认不是事实**：模型自己写的内容默认标为“模型自述（未确认）”；
- **清理前先存档**：上下文离开窗口之前先写入 `contexts/`，之后可以恢复；
- **对话默认隔离**：每个对话有自己的六层记忆，默认不互相读取；
- **本地优先**：默认使用本地规则和本地检索，不联网、不需要 API Key；
- **可选增强**：SQL、RAG、本地 llama.cpp 模型、网络同步都是可选的。

---

## 2. 一句话理解六层

| 层 | 可以理解成 | 典型用途 |
|---|---|---|
| `staging` 过程记录 | 工作日志 | 刚发生了什么，先一行一条记下来 |
| `archive` 分类归档 | 整理后的档案 | 把过程记录按错误、决策、界面事实等归类 |
| `snapshots` 快照 | 状态存档 | 保存任意状态对象，之后原样恢复 |
| `knowledge` 知识库 | 项目事实卡片 | 一条一句结论，可检索、可提炼、可导出 |
| `decisions` 决策 | 决策复盘 | 高风险操作的正反理由、可逆性与结论 |
| `contexts` 上下文 | 对话存档 | 清理前保存完整轮次，之后可以恢复 |

数据流大致是：

```text
过程记录 ──归档──► 分类归档
   │                  │
   └──────提炼───────► 知识库 ──► 可选 SQL / RAG 视图
                         ▲
上下文、决策 ───提炼────┘

快照、上下文：独立保存，按需恢复
```

---

## 3. 对话隔离与共享层

### 3.1 默认行为

每个 DSH 对话有自己的记忆目录：

```text
sessions/s_<hash>/
├── session.json
├── staging/
├── archive/
├── snapshots/
├── knowledge/
├── decisions/
├── contexts/
└── rag/
```

目录名使用 Session id 的稳定哈希，不直接暴露真实 id。

### 3.2 三个范围

- **本对话 `session`**：默认写入范围；其他对话默认看不到；
- **共享层 `shared`**：记忆根目录下的公共层，所有对话可读；
- **全部 `all`**：本对话 + 已打开的其他对话 + 共享层。

“全部”不是“磁盘上所有目录”，未打开的对话不会出现在检索、恢复和合并视图里，避免默认泄露别人的完整对话存档。

### 3.3 最近使用权重也隔离

每条对话有自己的 `knowledge/_usage.json`：

- 检索命中会增加该对话的最近使用次数；
- 权重按 14 天半衰期衰减；
- A 对话使用 B 对话的文档，不会把 B 的 `doc_id` 写进 A 的使用记录；
- 旧版本留下的跨对话脏记录会在读取时清掉。

---

## 4. 六个工具

### 4.1 `aim_memory`

分层记忆的统一入口。

| action | 作用 |
|---|---|
| `stage` | 写一条过程记录 |
| `archive` | 按 kind 归档；可强制分类 |
| `snapshot` | 保存 state 快照 |
| `restore` | 按 `snapshot_id` 恢复快照 |
| `list` | 列出快照 |
| `remember` | 写一条知识 |
| `learn` | 批量写知识 |
| `promote` | 从过程记录、归档、上下文中提炼知识 |
| `forget` | 删除一条错误知识 |
| `index` | 为当前范围建立/更新 RAG 索引 |
| `export` | 导出 knowledge / SQL / RAG |
| `incident` | 单独记录一次事故 |
| `status` | 查看分层统计 |

`remember` / `learn` / `incident` 由模型调用时，默认写入：

```text
provenance: model
verified: false
```

检索时降权，面板显示黄色“模型自述（未确认）”。用户确认后才会变成已确认事实。

### 4.2 `aim_search`

跨对话检索知识库。

- 默认范围 `all`，但只包含已打开的对话与共享层；
- `scope=session|shared|all` 可收窄；
- `category` 可按分类过滤；
- `route=auto|sql|vector|hybrid` 选择检索通道；
- `mode=bm25|vector|hybrid` 选择本地检索方式；
- `top_k` 控制返回条数；
- `detail=summary` 默认只返回查询附近的摘要和全文长度；
- `detail=full` 才返回完整正文；
- 缓存路由是内部实现（倒排索引原地增量 + 库级向量表），不作为工具参数暴露。

输出会标注：

- 命中来自哪个通道（SQL / RAG / BM25 / RRF）；
- 来源对话；
- 最近使用权重；
- 模型自述与确认状态；
- 摘要/全文状态。

### 4.3 `aim_context`

对话上下文管理。

| action | 作用 |
|---|---|
| `save` | 把当前已完成轮次整理进上下文存档 |
| `clear` | 按策略清理当前对话上下文 |
| `restore` | 把存档重新注入当前对话 |
| `list` | 列出上下文存档 |
| `status` | 查看清理策略、占用、最近状态 |
| `sessions` | 列出所有对话及记忆规模 |

`save` 是“先存档”；`clear` 是“存档后再清出”；`restore` 不是整份倒回，而是按 `restoreMaxChars` 从尾部取最近的轮次/事件段，避免再次塞满窗口。

### 4.4 `aim_decide`

对高风险或不可逆操作做正反合审查。

- `risk=low` 直接放行（但调用方自己标了 `irreversible=true` 时不再放行）；
- `risk=high` 不再按理由字数放行；
- `irreversible=true` 直接拒绝（任何风险等级）；
- `irreversible=false` 必须给出 `recoverable_via`；
- 缺字段返回 `needs_more_info`；
- 结果写入 `decisions`，包含正题、反题、结论、风险、可逆性和恢复路径；
- `risk` 是调用方自己的标注，审查门只能校验结构化字段是否自洽；把不可逆操作同时标成 `low` 和 `irreversible=false` 属于威胁模型边界（审查记录仍保留声明的 risk 与 auto 闸门）。

### 4.4.1 自动执行记录

除了 `aim_decide` 的正反合审查，每次 `turn/end` 只要本轮调用过工具，就会自动往 `decisions` 写一条 `outcome: observed` 的记录：

- `decision`：第 N 轮、工具调用次数与名称分布、修改了哪些本地文件、失败次数；
- `reason`：完整工具/文件清单与风险推断说明；
- `tools` / `files`：结构化的工具计数（含失败数）和读取/修改文件列表；
- `risk_level`：按工具类型和 shell 命令位置推断（`rm`、`git rm` / `git mv`、`Remove-Item` 等删除/移动/终止操作 = high，写文件 = medium，只读 = low）。参数里的 `format`、`rm`、`kill` 不会命中；

它是“做了什么”的执行审计，不占用正反合审查，也不会被 `promote` 提炼进知识库；同一轮重复落库会按 `session + turn` 覆盖同一条。`autoDecisionLog: false` 可关闭。

面板「决策」页按两类分栏展示：**常规**（`outcome: observed` 的自动执行记录）与**风险**（`aim_decide` 的正反合审查）。两类共用同一个 `decisions` 层和保留策略，只是职责分开。

### 4.5 `aim_ask`

调用任何 OpenAI 兼容 HTTP API。

| action | 作用 |
|---|---|
| `chat` | 一次性补全 |
| `embed` | 取文本向量 |
| `rerank` | 按 query 给候选文档打分排序 |
| `models` | 列出服务端模型 |
| `probe` | 连通性检查；`deep=true` 顺带探测 embed/rerank |
| `sources` | chat 可带编号来源，结果附来源对照和调用记录 |

它主要服务于 Embedding / Rerank：

- 三层记忆的“外部模型”模式靠 embed + rerank 工作；
- RAG 也靠它们；
- `chat` 只是附带能力，不会用 Embedding/Rerank 冒充 chat。

### 4.6 `aim_repair`

DSH 会话日志体检与修复。

DSH 把每个对话写成 `session.v4.jsonl.zstd`。其中一条事件结构不合规，DSH 的 reader 会拒绝整个对话，常见报错是 `stored log is corrupt`。

| action | 作用 |
|---|---|
| `scan` | 扫描会话日志；默认只读头部 |
| `repair` | 备份后修复一份日志 |
| `compact` | 重排 zstd 帧，缩小物理体积；事件不改 |

修复策略：

- **salvage**：把旧版插件写入的游离 `developer/message` 改写成等价的 `user/message` notice；
- **truncate**：截断到第一处结构违规之前，并补写 DSH 自己的收尾事件。

安全措施：

- 修复前先备份；
- 原子替换；
- 写回后复验；
- 正在进行的对话拒绝就地修复：当前对话和另一个标签页里仍在生成的对话都算，面板按运行时的活动回合判断；
- 写回前按内容指纹（`mtime + size + sha256`）复核，规划期间被追加/替换/删除就放弃，不用旧快照覆盖新事件；`compact` 同样受保护；
- 默认只预演，`apply=true` 才写回；
- 截断确认会明确显示“将丢弃 N 条事件”；
- 深度体检是显式动作，不是打开页面自动跑；
- zstd 解压使用异步路径，避免冻结事件循环；
- 扫描结果按 `mtime + size` 缓存；
- 诊断页显示实际使用的是 DSH 内置校验器还是本地回退校验器，以及回退原因。

会话日志修复依赖 Node 的 zstd，需要 **Node 22.15+**；Node 20 上插件其余功能正常，诊断页会明确标记该功能不可用。

---

## 5. 上下文清理与恢复

### 5.1 手动 `clear`

手动清理按话题相似度选择：

- 最近 `keepRecentTurns` 轮始终保留，当前轮最近 `keepRecentSteps` 步也始终保留；
- 老轮次按话题相似度选择，低相似度才清出；
- 当轮仍在执行时，绝不作为清理候选；
- 清理前先完整存档；
- 被清出的轮次随时可用 `restore` 调回；
- 单次受 `maxClearTurns`、`minClearChars`、`maxClearChars` 约束。

### 5.2 每 N 轮自动整理

`autoEnabled=true` 时，每个 `turn/end` 检查：

- 每 `autoEveryRounds` 轮触发一次；
- 执行轮次摘要、归档；
- 可选提炼知识；
- 再按话题相似度清理。

完整机制（相似度打分、存档与恢复、调参、能力边界）见 [上下文清理机制](context-clearing.md)。

### 5.3 上下文占用阈值

当实测上下文占用达到 `contextUsagePercent` 时，走**硬重置**：

- 在下一次模型请求前，把已完成轮次全部存档并清出；
- 当轮仍在进行时不会被清；
- 工具调用/结果对不会被拆开；
- 只重新载入当前请求和最近进展；
- 如果这一轮已经结束、没有下一次请求，则在 `turn/end` 直接全部清出；
- 硬重置不受 `minClearChars`、`maxClearTurns` 的常规裁剪限制；
- 手动 `clear` 仍按相似度选择，不强制全清。

自动触发需要 `autoEnabled=true`。

### 5.4 任务续接

硬重置后，不是只留一条“已清理”的空提示，而是重新载入：

- 当前请求；
- 最近进展；
- 以及必要的任务锚点。

这样清理完还能继续当前任务，而不是从零开始。

### 5.5 请求锚点

当系统检查点消息到达、而当前步骤没有新的真实用户请求时，插件会追加一条很短的内部提示，提醒模型上一轮真实用户请求，避免答非所问或重复历史回答。

有新的真实用户输入时，不注入旧锚点。

### 5.6 便条不是用户原话

清理便条、请求锚点、任务续接都由插件写入：

```text
source.kind = ai-for-memory
form = notice
```

它们对模型可见，但：

- 不进入 `turn.user`；
- 不会被 `promote` 当成用户规则；
- 不会被知识库误当成“用户确认过的事实”；
- 旧存档里没有 source 标签的已知便条前缀也会在提炼时过滤。

### 5.7 自动快照

`autoSnapshot` 默认开启：

- 每 `autoSnapshotEvery` 轮保存最近上下文窗口；
- 超过 `autoSnapshotMax` 时按相似度清理旧快照；
- 相似度高的旧快照先删，差异大的保留；
- 自动快照与自动整理开关独立。

### 5.8 保留策略

- `stagingRetentionDays`：删除已归档的旧过程记录文件；
- `contextRetentionDays`：上下文存档保留天数，0=不自动删除；
- `decisionRetentionDays`：决策记录保留天数；
- `autoDecisionRetentionDays`：只删除 `decision_auto_*` 每轮自动活动记录（默认 90 天），审查记录不受影响；
- 保留清理每天检查一次，即使自动整理关闭也会执行。

---

## 6. 检索

### 6.1 本地检索

默认轻量模式：

- **BM25**：关键词精确匹配；
- **128 维哈希向量**：无需模型，确定性地做近似语义匹配；
- **RRF**：两路结果按排名融合，而不是把不同量纲的分数直接相加；
- 置信度、来源确认状态、最近使用权重作为有界修正。

### 6.2 渐进披露

默认只返回查询附近的摘要：

```text
text          摘要
text_chars    全文长度
text_truncated 是否截断
```

只有显式 `detail=full` 才返回完整正文，避免一次把多篇全文倒进模型上下文。

摘要定位优先使用多字词/中文二元组，避免被单个汉字拉到文档开头。

`applyDisclosure` 只做降级：`search()` 与它共用同一份 `summarizeHits`，对已经是摘要的结果幂等；`detail: 'full'` 是直通——摘要里只有 preview 和 `text_chars`，无法还原全文，需要全文时用 `search(..., { detail: 'full' })`。

### 6.3 缓存

检索缓存全部是 LRU（命中会刷新顺序），分三层：

- **逐文档 tokens/向量**：按 `doc_id + updated_at + revision` 缓存；写一篇只重算受影响的一篇；
- **倒排索引原地增量更新**：索引保留每篇文档的 postings 快照，写一篇只移除并重加这一篇的 postings，删除同样按文档回收，不再每次 O(全库 token) 重建；
- **库级向量表**：由逐文档向量拼装，同样按文档增量更新。

缓存键是 `(库根, 分类)`，不同 MemoryStore 或分类各用各的索引，不会互相覆盖。`cacheMode` 是内部/测试开关：`document` 只跳过库级向量表，倒排索引在所有模式下都走增量。

### 6.4 SQL 通道

`aim_search` 的 `route` 可以走只读 SQL：

- 计数、分组、精确 doc_id、最近 N 条等问题走 SQL；
- 模糊/开放性问题走向量/BM25；
- 混合问题用 SQL 出统计、向量补相关文档；
- SQL 翻译失败回退向量，向量零命中可反向用 SQL 兜底。

JSON 仍是底座，SQL 只是派生视图。

### 6.5 RAG

RAG 索引建立在知识库上：

- 分片存储，只在内容变化时重写对应分片；
- 支持 Embedding + Rerank；
- 默认通过 RRF 与本地 BM25 融合；
- 索引按 embedding 空间记录模型与地址，避免混用不同模型/维度的向量；
- 本地 Embedding 使用稳定的 `local:<model>` 身份，llama-server 重启换临时端口不会让索引失效；
- 语义去重是索引级过滤，不改知识库本体，BM25 仍然看得到全部文档；
- 去重比较使用单位向量点积，并在长循环中主动让出事件循环。

### 6.6 切块/去重

知识文档是短结论，但索引仍会：

- 按分类做语义去重；
- 保留最新代表；
- 记录 `duplicate_of` 和相似度；
- 不在知识库里删除重复文档。

---

## 7. 知识库

### 7.1 分类

归档层固定 7 类：

```text
ui_facts
action_logs
decisions_reasoning
ui_maps
errors_fixes
behavior_tristate
snapshots
```

知识分类可以自由填写；`incidents` 是独立事故类型；网页来源会归到 `external_sources`。

### 7.2 一条一句

知识库要求：

- 一条一句可复用的结论；
- 必带分类；
- 尽量带出处 `url` 或 `source`；
- 不写密钥、令牌或用户没说过的事实；
- 标签最多 8 个；可传字符串数组或逗号分隔字符串，非字符串项会丢弃；
- 置信度 0~1；接受数字或数字字符串，无法解析的值会报错。

### 7.3 来源与确认

- 用户给的：来源 `user`，可直接视为已确认；
- 网页/推理：来源 `web` / `reasoning`；
- 模型自己写的：`provenance=model`、`verified=false`，检索降权；
- `source` 缺失或拼错归一为 `unknown`，按模型自述处理，不会因为少传参数变成已确认事实。

### 7.4 冲突与更新

新知识可能与已有知识相近但不同：

- 高度相似、数字/URL/开关都没变：合并为同一条，追加证据；
- 高度相似但数字/URL/开关变了：视为更新，先询问；
- 相似但不完全一样：返回冲突，先问用户；
- `promote` 发现值变化时只在结果里列出，不写入、不入队；
- 被拦下的写入记一条到 `knowledge/conflicts.jsonl`（审计，不是队列）：面板知识库页显示最近冲突与未确认数，`aim_memory status` 报未确认数；确认覆盖后自动标记为已确认；
- 用户确认后，传原 `doc_id` + `confirm=true` 覆盖正文，并写入 `changes` 审计。

### 7.5 删除与确认

- `forget` 按 doc_id 或前缀删除错误知识；
- 确认一条知识会保留原 id 与证据链，清除“模型自述”标记；
- 面板支持单条确认、批量确认、撤销确认；
- 支持按分类、来源、确认状态、时间、置信度、命中次数、权重筛选和排序。

### 7.6 导出

`aim_memory action=export`：

- `knowledge`：JSON 或 Markdown；
- `sql`：完整 SQLite 数据库；
- `rag`：RAG 向量索引；
- 可多选；
- 可导出到另一块盘的目录，避免磁盘满时先写本机。

JSON 导出是无损副本，保留证据、来源、确认、变更等全部字段。

### 7.7 SQLite 镜像

`knowledgeBackend=sqlite` 时：

- JSON 仍是 canonical 底座；
- SQLite 是派生只读镜像，用于 SQL 查询；
- 没有 `node:sqlite` 时自动回退 JSON，并在面板说明。

---

## 8. 本地模型与推理引擎

### 8.1 模型目录

用户配置从：

```text
$DSH_HOME/ai-for-memory/models/
```

读取。插件自带的 `models/` 只是可选扫描源；更新插件不会保留里面的 `model.json`。

目录结构：

```text
models/
├── Embedding/bge-m3/
│   ├── model.json
│   └── bge-m3.gguf
├── Rerank/bge-reranker/
│   ├── model.json
│   └── reranker.gguf
└── Loose/
    └── some-model.gguf
```

### 8.2 本地引擎

插件不下载权重，也不在 Node 进程里做张量推理。它按 `model.json` 启动 `llama-server`：

- Embedding：`--embeddings --pooling cls`；
- Rerank：`--reranking --pooling rank`；
- 支持 `ctxSize`、`port`、`binary`、`startupTimeoutMs`、`extraArgs`；
- `ctxSize` 默认 2048，可在面板调整；过大的 ctx 会白占常驻 KV cache；
- 自动端口冲突时换端口重试最多 3 次；显式端口不重试；
- 启动前写 `.engine.lock/<model>.json`（含本 profile 的 `owner`），插件重启后只接管本 profile 的锁；锁文件丢失时只扫描当前 DSH 进程直接 spawn 的 `llama-server` 重新接管，用户手起或别的 profile 启动的进程不会被认领；停止会先核对命令行里的模型路径和端口，PID 被系统回收时只清理过期锁、不杀无关进程；确认身份后才 SIGTERM / SIGKILL，只有确认死亡才删锁；
- 面板「llama.cpp → 高级设置（model.json）」可改模型类型、权重相对路径、ctx-size、端口、pooling、启动超时、binary 和 `extraArgs`，不用手写配置文件；
- 启动失败保留 stderr/stdout 尾部和实际启动命令，面板显示诊断提示。

### 8.3 自动路由

当运行中的本地 Embedding / Rerank 引擎存在时：

- 对应端点配置为空，或仍是旧的 loopback 端口：自动使用运行中的本地引擎；
- 显式配置的云端地址优先，不会被本地覆盖；
- 两个本地模型都运行、且没有配置外部端点时，RAG 自动挂载；
- `aim_ask`、RAG、promote/archive 等走 Embedding/Rerank 的路径都会使用这套路由。

本地模型是 Embedding/Rerank，不冒充 chat；`aim_ask chat` 仍需要单独的 chat 端点。

### 8.4 会话日志修复的 Node 要求

- 插件本体：Node 20+；
- 会话日志修复：Node 22.15+（zstd）；
- Node 20 上其余功能正常，诊断页明确标记修复不可用。

---

## 9. 面板

侧栏「AI 记忆」打开面板。

### 9.1 总览

- 六层规模卡片；
- 当前范围、工作区、对话、记忆目录；
- 上下文实时占用；
- RAG / 网络 / 知识存储状态；
- 最近过程记录；
- 会话日志健康摘要；
- 快速入口。

### 9.2 六层页面

每层有列表、详情、搜索、展开/收起、分页、导出、恢复等操作。

### 9.3 设置页

设置分为：

- **常规与上下文**：记忆目录、目录名、自动整理、自动快照、RAG 挂载、MCP、SQL、默认开放等；
- **模型与检索**：外部模型、本地模型目录、Embedding/Rerank、连接测试；
- **llama.cpp**：选择模型，调整 ctx-size、端口、pooling、启动超时、binary、额外参数；
- **高级策略与保留**：上下文预算、清理预算、知识上限、快照上限、保留天数、请求锚点等；
- **网络同步**：Git 同步开关、角色、remote、同步内容、初始化/提交/推送/拉取/探测；
- **当前对话**：对话名称、是否对其他对话开放、记忆文件夹。

设置保存后自动重载插件并刷新，不需要手动重载。

### 9.4 诊断页

- Node 版本、`node:sqlite`、Git、`llama-server`、模型目录、记忆目录可写性、gitignore、磁盘占用；
- 知识命中次数与当前权重；
- 未命中条目优先显示，便于发现死条目；
- 对话磁盘占用与批量开放/关闭；
- 面板操作审计；
- 会话日志健康、校验器来源与回退原因；
- 快照并排对比。

### 9.5 文件操作

知识、上下文、快照条目可以直接：

- **打开 JSON**：在文件管理器中定位到具体文件；
- **下载全文**：下载原始 JSON，不受面板摘要截断影响。

### 9.6 操作审计

关键面板操作写入 `$DSH_HOME/ai-for-memory/audit.jsonl`：

- 确认/删除知识；
- 接受/拒绝待确认更新；
- 上下文保存/清理/恢复；
- 快照恢复；
- 保存配置；
- 批量开放/关闭；
- 清理保留期；
- 建 RAG 索引；
- Git 同步操作；
- 本地模型参数保存。

诊断页显示最近记录。

---

## 10. MCP 出口

面板可启用/停用 MCP：

```text
http://127.0.0.1:<DSH 端口>/ai-for-memory/mcp
```

- 只接受回环地址与可信 Host；
- 默认生成 `$DSH_HOME/ai-for-memory/mcp-token`，请求必须带 `Authorization: Bearer`；
- 也支持在面板设置自定义 token；
- 工具：`aim_roots`、`aim_search`、`aim_remember`、`aim_status`、`aim_context_list`、`aim_context_restore`；
- `aim_remember` 固定写共享层，标记 `source: mcp`，仍按模型自述处理；
- MCP 的 `serverInfo.version` 来自 `package.json`，不再手写版本常量；
- 不需要时在面板关闭 MCP 开关。

---

## 11. 网络同步

每个记忆根目录可以单独配置 Git 同步：

- 启用/停用；
- 同步角色；
- remote（支持 `git@host:path`）；
- 可选的同步内容（避免把完整上下文存档推到远端）；
- 初始化仓库；
- 提交；
- 推送；
- 拉取；
- 探测远端端口。

同步配置保存在设备本地，不随记忆目录上传。

---

## 12. 数据目录

默认：

```text
<workspace>/.ai-for-memory/
├── staging/
├── archive/
├── snapshots/
├── knowledge/
├── decisions/
├── contexts/
├── exports/
├── sessions/
│   └── s_<hash>/
│       ├── session.json
│       └── staging/ archive/ snapshots/ knowledge/ decisions/ contexts/ rag/
└── rag/
```

`root` 可以：

- 留空：跟随工作区，使用 `.ai-for-memory/`；
- 绝对路径：所有项目共用一个目录；
- 相对路径：相对工作区解析。

用过的根目录登记到 `$DSH_HOME/ai-for-memory/roots.json`。

写入方式：

- 用户数据（知识文档、确认/撤销、快照、上下文存档、决策记录、归档）走临时文件 + 原子替换，并在替换前后 `fsync`：先刷文件数据再 rename，POSIX 上再刷目录，掉电最多丢「正在进行的那一次操作」，不会留下半截文件；归档追加同样刷盘。
- 派生/高频数据（知识使用计数、promote 账本、旧 pending 队列、压缩状态、staging 事件）只做原子替换、不强制 `fsync`，掉电最多丢最后一条计数；它们都能从知识库重建或本来就不影响事实。
- RAG 索引分片同样是临时文件 + rename，但索引可重建，不额外刷盘。

---

## 13. 常用配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `root` | 空 | 记忆目录；空=跟随工作区 |
| `directoryName` | `.ai-for-memory` | 跟随工作区时的目录名 |
| `defaultTopK` | 5 | 默认返回条数 |
| `knowledgeBackend` | `json` | `json` 或 `sqlite` |
| `defaultPublic` | `false` | 新对话是否默认对其他对话开放 |
| `reviewHighRiskOnly` | `true` | 只审查 high，medium 直接放行；false 才审查 medium |
| `autoEnabled` | `false` | 自动整理总开关 |
| `autoEveryRounds` | 5 | 每几轮自动整理 |
| `engineLifecycle` | `manual` | 本地引擎运行方式：常闭 / 常开 / 每轮开关（空闲约 2 分钟后释放） |
| `contextUsagePercent` | 70 | 占用达到多少百分比触发全量重置 |
| `autoKnowledge` | `true` | 自动整理时顺带提炼知识 |
| `autoKnowledgeLimit` | 10 | 每次自动提炼上限 |
| `autoSnapshot` | `true` | 自动快照 |
| `autoSnapshotEvery` | 5 | 每几轮快照 |
| `autoSnapshotMax` | 10 | 自动快照上限 |
| `topicalClear` | `true` | 按话题相似度清理；关掉则用整段压缩（占用阈值仍全量重置） |
| `similarityThreshold` | 0.05 | 话题相似度阈值 |
| `keepRecentTurns` | 2 | 始终保留最近几轮 |
| `keepRecentSteps` | 3 | 硬重置时保留当前轮最近几个工具步骤 |
| `maxClearTurns` | 8 | 单次最多清出轮数 |
| `minClearChars` | 200 | 少于这个字符数不清理 |
| `maxClearChars` | 120000 | 单次清出字符上限 |
| `restoreMaxChars` | 12000 | 单次 restore 最多注入字符数 |
| `stagingRetentionDays` | 30 | 旧过程记录保留天数；只删已归档文件 |
| `contextRetentionDays` | 0 | 上下文存档保留天数；0=不自动删 |
| `decisionRetentionDays` | 0 | 决策记录保留天数；0=不自动删 |
| `autoDecisionLog` | `true` | 每轮把工具调用和本地文件改动自动记入决策层（outcome=observed） |
| `requestAnchor` | `true` | 检查点到且本步无新请求时注入上一轮请求锚点 |
| `mcpEnabled` | `true` | 是否启用 MCP 出口 |
| `mcpToken` | 空 | 可选自定义 Bearer 令牌；空=自动生成本机令牌 |
| `ragMount` | `false` | 是否把 RAG 索引挂到检索；本地双模型运行且无外部端点时可自动挂载 |
| `externalBaseUrl` | 空 | 外部模型主地址；空=未配置 |
| `externalEmbedModel` | 空 | Embedding 模型 |
| `externalRerankModel` | 空 | Rerank 模型 |
| `externalTimeoutMs` | 60000 | 外部请求超时；探活固定上限 5000ms |

完整配置与目录细节见 [配置与数据目录](configuration.md)。

---

## 14. 安全与隐私

- 默认不联网；MCP 只绑定 DSH 的 loopback 监听器；
- API Key 只保存在本机，面板只显示“是否已保存”，不回显明文；
- 知识、上下文、快照、决策都是本地 JSON；
- 上下文存档包含完整对话，可能含密钥、内部接口或客户数据，默认不对外开放；
- MCP 默认生成 Bearer token；任何能访问 loopback 端口的本机进程仍可能读写，不要把监听器暴露到公网；
- 不应把完整上下文存档提交到 Git；网络同步可以选择只同步知识等层；
- 本地模型权重由用户自行提供，本插件不下载、不再分发权重。

---

## 15. 已知边界

- 默认检索是 BM25 + 128 维哈希向量，不等同于真正的语义模型；RAG 才是语义增强；
- RAG 的语义去重是 O(n²) 比较；已经用单位向量点积、精确文本短路和事件循环让出降低影响，但超大知识库仍建议控制 `maxDocs`；
- 本地 llama.cpp 引擎依赖用户自己放置的 GGUF 和可用的 `llama-server`；
- 会话日志修复依赖 Node 22.15+ 的 zstd；Node 20 上该功能不可用；
- MCP 是本地 HTTP 入口，不是浏览器会话；安全边界依赖 loopback + token，不依赖 DSH 登录态；
- 自动整理的触发依赖 DSH 的 `agent/pre-step` 与 `turn/end` 事件；当前进行中的超长轮次可能只在下一个边界生效。

---

## 16. 典型工作流

### 第一次使用

```text
plugin_manager action=install_bundle target=<dsh-ai-for-memory 目录>
aim_memory action=status
```

### 记录一条项目事实

```text
aim_memory action=remember
  text="发布前必须跑完整测试套件"
  category=project_facts
  scope=shared
```

模型写入默认未确认；用户确认后才会变成已确认事实。

### 检索历史约定

```text
aim_search query="发布流程" scope=all detail=summary top_k=5
```

需要全文时再 `detail=full`。

### 清理上下文

```text
aim_context action=clear
```

清理前自动存档；之后可用 `aim_context restore` 调回。

### 高风险操作审查

```text
aim_decide decision="删除生产数据库" risk=high irreversible=true
```

不可逆操作直接拒绝。

### 本地模型增强

1. 把 GGUF 和 `model.json` 放到 `$DSH_HOME/ai-for-memory/models/`；
2. 在面板「模型」或「llama.cpp」页启动 Embedding / Rerank；
3. 两个模型都启动后，RAG 与检索自动使用它们；
4. 需要时在面板建立/更新 RAG 索引。

### 会话日志损坏

```text
aim_repair action=scan deep=true
aim_repair action=repair session=<id> apply=false
aim_repair action=repair session=<id> apply=true
```

先预演，看清将丢弃多少事件，再写回。

---

## 17. 相关文档

- [主 README](../README.md)
- [安装与首次使用](installation.md)
- [工具参考](tools.md)
- [面板导览](panel.md)
- [上下文与自动行为](context.md)
- [上下文清理机制](context-clearing.md)
- [检索与 RAG](search.md)
- [知识库](knowledge.md)
- [本地模型/推理引擎](models.md)
- [MCP 出口](mcp.md)
- [网络同步](network.md)
- [配置与数据目录](configuration.md)
- [隐私与安全](security.md)
- [FAQ](faq.md)
- [开发与测试](development.md)
- [更新记录](../CHANGELOG.md)
