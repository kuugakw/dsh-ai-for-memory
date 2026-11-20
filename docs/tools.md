# 工具参考

> 返回 [主 README](../README.md)。

## 五个工具

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
- `doc_id` 默认由正文生成；自定义 id 只影响命名，去重仍按正文；
- 与已有知识相近但不同，会返回 `needs_confirm`，先问用户；
- 数字、URL、开关发生变化，会当成“更新”而不是普通重复；
- 更新会保留 `changes` 审计，不会悄悄覆盖旧内容。

#### `promote` 是什么

`promote` 会从过程记录、分类归档、上下文存档和决策记录里提炼知识：

- 只自动提炼 `verify=pass` 的过程记录和归档；
- 上下文只提炼用户原话；
- 决策提炼“决策 + 理由”；
- 提炼不会覆盖已有正文；发现值变化时放入待确认队列；
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

- 最近 `keepRecentTurns` 轮始终保留；
- 旧轮次按话题相似度选择，低相似度才清出；
- 清理前先完整存档，`restore` 可以调回；
- 恢复不会整份塞回去，按 `restoreMaxChars` 只取最近轮次；
- `clear` 登记后在下一次模型请求前执行，不会等到轮末；
- 当轮正在进行时，本轮的上下文不会被清掉。

### `aim_search`：跨对话检索

| 参数 | 说明 |
|---|---|
| `query` | 检索词或自然语言问题，必填 |
| `scope` | `all`（默认）/ `session` / `shared` |
| `route` | `auto`（默认）/ `sql` / `vector` / `hybrid` |
| `mode` | `bm25` / `vector` / `hybrid`（默认） |
| `category` | 只搜某个分类 |
| `top_k` | 返回条数，默认 5，最大 50 |

它会自动选择通道：

- 问“多少条、按分类统计、某个 `k_...` id” → SQL；
- 问“怎么做、为什么、相关背景” → 本地检索或 RAG；
- 两者兼有 → hybrid；
- SQL 翻译不了 → 回退向量；
- 向量没有命中 → 用 SQL 兜底。

检索结果会标出来源对话、分类、来源、最近使用权重和未确认标记。跨对话的相同内容会折叠成一条，其他来源写成“另见”，不重复占返回名额。

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

---
