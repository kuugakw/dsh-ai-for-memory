# 工具参考

> 返回 [主 README](../README.md)。

## 六个工具

### `aim_memory`：记忆管理

最常用的工具，负责写入、整理、导出和查看状态。

| action | 主要参数 | 作用 |
|---|---|---|
| `stage` | `content`；可选 `kind`、`source`、`risk`、`verify` | 追加一条过程记录 |
| `archive` | 可选 `category` | 把过程记录归档；可强制分类 |
| `snapshot` | `name`；可选 `state` | 保存状态快照 |
| `restore` | `snapshot_id` | 恢复快照；接受 id、名称或唯一前缀 |
| `list` | — | 列出快照 |
| `remember` | `text`；可选分类、标签、URL、置信度 | 写入一条知识 |
| `learn` | `items` | 批量写入知识，最多 100 条 |
| `promote` | `dry_run`、`limit` | 从过程记录 / 归档 / 上下文 / 决策提炼知识 |
| `forget` | `doc_id` | 删除一条知识；接受精确 id 或唯一前缀 |
| `index` | — | 为当前范围建立 / 更新 RAG 索引 |
| `export` | `types`、`format`、`dest` | 导出知识库、SQL 镜像或 RAG 索引 |
| `incident` | `title` 等 | 记录一次事故，归入 `incidents` |
| `status` | — | 查看各层统计和运行状态 |

写入范围：

- `scope=session`（默认）：写当前对话；
- `scope=shared`：写共享层，所有对话可读。

#### 写知识时会发生什么

- `text` 必填，一条一句结论，单条最多约 2000 字符；
- 不写 `category` 时默认 `project_facts`；带 `url` 时默认归到 `external_sources`；
- `doc_id` 默认由正文生成；传已有条目的 `doc_id` 表示“要改写这一条”：不带 `confirm` 返回更新确认，带 `confirm=true` 覆盖正文并保留 `changes` 审计；
- 与已有知识相近但不同，会返回 `needs_confirm`，先问用户；
- 被拦下的写入会记一条到 `knowledge/conflicts.jsonl`（只做审计，不会自动应用）；`status` 显示未确认冲突数，面板「知识库」页也能看到，模型忘了转述时用户仍可发现；确认覆盖后该条自动标为已确认；
- 数字、URL、开关发生变化，会当成“更新”而不是普通重复；
- 更新会保留 `changes` 审计，不会悄悄覆盖旧内容。

#### `promote` 是什么

`promote` 会从过程记录、分类归档、上下文存档和决策记录里提炼知识：

- 只自动提炼 `verify=pass` 的过程记录和归档；
- 上下文只提炼用户原话；
- 决策提炼“决策 + 理由”；
- 提炼不会覆盖已有正文；发现值变化时只在结果里列出，不写入、不入队；确认后用 `remember` + `confirm=true`（传旧条目 `doc_id`）覆盖；
- 提炼台账会记住处理过的条目，不重复挖；旧台账版本失效时整体重扫；
- `dry_run=true` 只预览，不写盘。

#### 事故记录 `incident`

`incident` 用于记录文件损坏、数据丢失、严重误操作等事件，单独归入 `incidents`。

- `title` 必填；
- 可选 `what_happened`、`impact`、`cause`、`fix`、`prevention`、`severity`、`status`、`occurred_at`；
- 会生成一条紧凑的单行摘要，不会把六行模板塞进知识库；
- 默认 `provenance: model`、`verified: false`、置信度 `0.55`；
- 事故跳过普通事实冲突闸门，但仍会在检索时降权并显示黄标，确认后才转正。

#### 导出

`export` 支持三种类型：

- `knowledge`：JSON（无损）或 Markdown（按分类、便于阅读）；
- `sql`：完整 SQLite 数据库；
- `rag`：当前 RAG 索引的合并副本。

JSON 导出保留 `provenance`、`verified`、`changes`、`confidence`、`evidence` 等完整字段；Markdown 会显示确认状态和 provenance；SQL 导出表也包含这些列。备份或迁移后，确认状态和黄标信息不会丢。

### `aim_context`：上下文保存、清理和恢复

| action | 作用 |
|---|---|
| `save` | 保存当前已完成的轮次 |
| `clear` | 按话题相似度清理，默认在下一次模型请求前执行 |
| `restore` | 把存档重新注入当前会话 |
| `list` | 列出上下文存档 |
| `status` | 查看清理策略、上下文占用和最近状态 |
| `sessions` | 列出所有对话及其记忆规模 |

特点：

- 最近 `keepRecentTurns` 轮始终保留，当前轮最近 `keepRecentSteps` 步也始终保留；
- 旧轮次按话题相似度选择，低相似度才清出；
- 清理前先完整存档，`restore` 可以调回；
- 恢复不会整份塞回去，按 `restoreMaxChars` 从尾部取最近的轮次/事件段；
- 恢复内容作为一条带通知标记的 `user/message` 注入（`role: 'user'`、`source.kind = ai-for-memory`、`source.form = notice`），下一步生效，不是新的用户请求；
- `clear` 登记后在下一次模型请求前执行，不会等到轮末；
- 当轮正在进行时，本轮的上下文不会被清掉。

### `aim_search`：跨对话检索

| 参数 | 说明 |
|---|---|
| `query` | 检索词或自然语言问题，必填 |
| `scope` | `all`（默认）/ `session` / `shared` |
| `route` | `auto`（默认）/ `sql` / `vector` / `hybrid` |
| `mode` | `bm25` / `vector` / `hybrid`（默认，按排名融合） |
| `category` | 只搜某个分类 |
| `top_k` | 返回条数，默认 5，最大 50 |
| `detail` | `summary`（默认，查询附近摘要 + 全文长度）/ `full`（完整正文） |

它会自动选择通道：

- 问“多少条、按分类统计、某个 `k_...` id” → SQL；
- 问“怎么做、为什么、相关背景” → 本地检索或 RAG；
- 两者兼有 → hybrid；
- SQL 翻译不了 → 回退向量；
- 向量没有命中 → 用 SQL 兜底。

检索结果会标出来源对话、分类、来源、最近使用权重和未确认标记。跨对话的相同内容会折叠成一条，其他来源写成“另见”，不重复占返回名额。

`scope=all` 只遍历**本对话有权读取**的其他对话：对方必须 `public: true`，或它的 `viewers` 里点名了本对话（面板「仅对这些对话开放」）。没授权的不出现在结果里，也不会泄露名字和规模；本对话自己的记忆永远可读。

### `aim_decide`：高风险操作审查

用于不可逆或高风险操作的正反合审查。

参数：

- `decision`：要做的决策，必填；
- `risk`：`low` / `medium` / `high`；
- `thesis`：支持理由；
- `antithesis`：反对理由；
- `irreversible`：是否不可逆；
- `recoverable_via`：如果可逆，如何恢复；
- `scope`：写本对话或共享层。

结果只有三种：

- `approved`：可以执行；
- `rejected`：拒绝；
- `needs_more_info`：信息不足，补充理由或恢复路径。

审查看的是**可逆性**，不是理由字数。高风险且不可逆会直接拒绝；可逆但没有恢复路径也不会放行。

`reviewHighRiskOnly` 默认 `true`：这个默认值表示 medium 风险直接放行，只有 high 走审查。想让 medium 也审查，把它设为 `false`。这个开关会改变流程，不是只影响显示。

### `aim_ask`：连接外部模型

只连接插件配置的外部服务，不写记忆。

| action | 用途 |
|---|---|
| `chat` | 一次性对话补全；可带来源材料 |
| `embed` | 取文本向量 |
| `rerank` | 按 query 给候选文档重排 |
| `models` | 列出服务端模型 |
| `probe` | 检查连通性；可顺带探测 Embedding / Rerank |

`chat` 可以传 `sources`，结果会要求模型用 `[n]` 标注依据，并附调用记录和来源对照，便于追溯一次回答来自哪些材料。

### `aim_repair`：会话日志体检与修复

DSH 把每个对话写成 `~/.dsh/sessions/<工作区分桶>/<会话>/session.v<N>.jsonl.zstd`（多段 zstd 帧，逐批追加）。只要某一段完整帧里有一条事件违反当前会话格式，DSH 读取时就会整体拒绝，报 `stored session ... is corrupt` / `SessionFormatError`；DSH 自身没有删除或修复接口，于是这个对话再也打不开。

> **格式边界。** 本工具只处理 `v${4}`（当前 DSH 的 `session.v4`）。这套日志是 DSH 私有的、逆向实现的格式，不是公开 API：DSH 一旦改成 `session.v5` 或调整事件结构，`scan` / `doctor` 会把日志标成「版本不支持」，`repair` / `compact` 直接拒绝，**不会用旧规则改写不认识的字节**；等插件跟进新格式后再修。**离开 DSH 没有独立形态**——体检、修复、占位日志都依赖 DSH 的目录与格式，不能单独使用。

| action | 主要参数 | 作用 |
|---|---|---|
| `scan` | 可选 `deep` | 列出所有会话日志：物理/逻辑大小、事件数、结构状态、异常膨胀标记。`deep=true` 会解压并逐个事件校验（含消息身份，大日志较慢） |
| `repair` | `session` 必填；可选 `strategy`（`auto`/`identity`/`salvage`/`truncate`）、`apply` | 修复一份日志。默认只预演；`apply=true` 才写回 |
| `compact` | `session` 必填；可选 `apply` | 对结构有效的日志重排 zstd 帧（DSH 每次追加一批就写一个帧，长对话会积累上万个碎帧）；事件一个不改，只缩小物理体积 |
| `doctor` | 可选 `apply`、`ghosts`、`cache`、`repairLogs` | 跨「日志 / `workspace.json` 索引 / 投影缓存」三处体检并修复：序号断层、缺日志、投影比日志新、回合没写成收尾 |

`session` 接受 `session-<uuid>`、裸 uuid、唯一前缀，或 `.zstd` 的绝对路径。

#### `doctor`：三处存储对不上时先体检

DSH 把一个对话摊在三处，任何一处落后都会表现成「对话打不开 / 显示空白 / 侧栏有但点开报缺少日志」：

| 位置 | 作用 | 失配时的界面表现 |
|---|---|---|
| `sessions/<分桶>/<会话>/session.v<N>.jsonl.zstd` | 正文（唯一真源） | — |
| `storages/workspace.json` | 侧栏列出的会话索引 | 列出但打不开（缺日志） |
| `storages/session_projcache/sessions/<会话>.json` | 投影缓存 | 侧栏/统计里的轮次、token 与日志对不上 |

`doctor` 取三处的并集，给每个会话一个状态：

- `ok`：序号连续，且回合已收尾（本来就是空对话也算 ok）；
- `gap`：`seq` 不连续。典型成因是「把旧日志复制回来」时，仍在运行的 DSH 宿主用内存里的编号（例如 77248）接在恢复的前缀（53239）后面，于是整份日志被读取器拒绝；
- `invalid`：序号连续、回合也收尾了，但有消息缺身份（`id`/`role`/`source`）。DSH 打开时会报 `lacks an identified message`，而序号检查看不出来；
- `open`：日志停在回合中间（写入被打断）；
- `missing`：索引里有、磁盘上没有日志；
- `unreadable`：解压或解析失败。

对「日志还在」的会话，`doctor` 还会比一次**覆盖度**：从插件记忆存档的文件名里取最新轮次（`auto-snapshot-t<轮>`、`decision_auto_t<轮>`），日志比存档少时直接写明「日志只到第 N 轮，插件存档到第 M 轮」。这类缺口只能用 `aim_context restore` 把存档调回，日志本身补不回来。

默认只预演，参数含义：

| 参数 | 取值 | 含义 |
|---|---|---|
| `apply` | `true` | 真正写盘 |
| `repairLogs` | `true` | 截断 `gap` 日志到断点、给 `invalid` 日志补消息身份，与 `repair` 共用同一条「先备份、写后复验、冲突即放弃」的路径；默认只报告，避免碰到另一个标签页正在写的会话 |
| `ghosts` | `auto`（默认）/ `placeholder` / `prune` / `keep` | 缺日志时：`auto` 以插件记忆存档为准——有存档就保留并写占位日志，没有就移除条目；`placeholder` 全部保留（占位日志打开是空对话）；`prune` 全部移除（先备份 `workspace.json.bak-<时间戳>`）；`keep` 只报告 |
| `cache` | `clear`（默认）/ `keep` | 把比日志新的投影缓存改名成 `.bak-<时间戳>`，让 DSH 重新生成；`keep` 只报告 |

`doctor` 不删除任何会话日志，也不覆盖已存在的日志：占位日志只写在没有日志的会话目录里。`apply=true` 且修复成功时，本次报告里该行状态归为 `ok` 并带「已修复」标记（`rows[].repaired`），摘要计数按修复后的状态统计；失败的行保留原状态并在「已执行」里写明原因。

修复策略：

- `identity`（`auto` 里最先尝试）：只给缺身份的消息补 `id`/`role`，事件、序号和正文一个不改。DSH 打开会话时要求每条消息带 `id`（`user/message` 还要 `role`、`source.kind`、`content`），缺了会整份拒绝并报 `lacks an identified message`；
  - 能力边界：它只能补 `id`/`role`。缺 `source.kind`、`assistant/message` 缺 `source.provider`/`source.model`、`tool/result` 缺 `source.callId`（或与 `toolCallId` 不一致）的消息它补不了——`auto` 会继续尝试 `salvage`/`truncate`，显式 `strategy=identity` 则报告「没有找到能通过校验的修复方案」，不会凭空造内容；
- `salvage`：把旧版插件写入、却落在 step 之外的 `developer/message` 请求锚点/清理便条改写为等价的 `user/message` 便条，**保留全部历史事件**。当前版本已经改用 `user/message`，所以这些只是历史遗留的载体；
- `truncate`（兜底）：截断到第一处结构损坏之前，并用 DSH 自带的合成收尾事件（未完成工具结果、`step/end`、`turn/end`）补全回合；会丢弃损坏点之后的事件，报告里写明丢了多少。

`scan deep=true` 除了格式校验，还会逐条检查消息身份：格式校验器（`restoreReleasedV4Artifact`）和本地生命周期回放都接受缺 `id` 的消息，只看它们会把这种日志报成「正常」，而对话打开时照样被拒——所以这条检查是单独加上去的。

安全约束：

- 写回前先把原文件备份成 `session.v<N>.jsonl.zstd.bak-<时间戳>`，写回后立即复验，复验失败会自动还原。
- 校验优先使用**当前安装的 DSH 包**（`restoreReleasedV4Artifact` + `KNOWN_SESSION_EVENT_TYPES`），解析不到时退回本地生命周期回放。
- 拒绝修复**仍在进行中的对话**（当前对话，或另一个标签页里正在生成的对话）；只做预演不受影响。修完要重新打开该对话才会重新加载。
- 写回前按内容复核：读取时记录 `mtime + size + sha256`，备份前和原子替换前各复核一次。会话日志在规划期间被追加、替换或删除（DSH 正在写、另一个 DSH 进程、或同一注册目录里的其他写入者）就放弃本次写回并报告冲突，磁盘上的新事件不会被旧快照覆盖；`compact` 重排走同一条保护。
- 写入是临时文件 + 原子替换；目标被占用时直接报错，不会截断。

关于大小：DSH 的会话日志是只追加的，逻辑大小（解压后）通常约等于物理大小的 3 倍。一个 150 MB / 5 万事件的日志说明对话非常长，而不是损坏；`scan` 会给这种日志打 `oversized` / `many-events` 标记，但只有结构损坏才需要修复。修复重写时按 200 个事件一批重新分帧，通常还能顺带缩掉一部分物理体积。

读取和改写会话日志需要运行时的 zstd 支持（Node 22.15+ / 23.8+ 的 `node:zlib`）。更老的运行时会直接报告「当前 Node 不支持 zstd」，不会改动任何文件。

---
