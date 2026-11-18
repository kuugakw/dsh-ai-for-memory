# AI for Memory — DSH 插件

[![Status](https://img.shields.io/badge/status-test%20build%200.1-orange.svg)]()
[![Version](https://img.shields.io/badge/version-0.1.0-lightgrey.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **0.1.0 测试版。** 接口、面板布局和存储格式都可能继续调整；升级前请备份记忆目录。
> 插件本体零外部依赖，只用 Node 内置模块。

AI for Memory 是给 **DeepSeek Harness** 用的项目级分层记忆插件。它把「当前对话的上下文」和「跨对话可复用的项目记忆」分开处理：

- **上下文**：把已完成的对话轮次存档，按话题相似度清理，需要时再调回；
- **过程记忆**：过程记录、分类归档、精确快照、决策审查；
- **知识库**：一条一句、带分类和出处的文本知识，可检索、可提炼、可导出；
- **可选增强**：SQLite 只读镜像、RAG 索引、外部 Embedding/Rerank 服务。

默认配置是轻量模式：本地规则 + 本地 BM25，不联网、不需要 API Key。RAG、SQL 持久镜像、外部模型三层默认关闭；自动快照默认开启，自动整理默认关闭。

---

## 先看边界

### JSON 是底座，其他都是派生视图

知识库只有一条写入路径：

1. 先写 `knowledge/<doc_id>.json`；
2. 这个 JSON 文件就是审查点，合适就保留，不合适就修改或删除；
3. SQLite 镜像、RAG 索引、导出文件都从 JSON 派生，损坏或删除不会反向影响 JSON 底座。

`documents()` 永远只读 JSON。SQLite 打开失败时，知识库会继续以 JSON 运行，只是镜像不可用。

### 对话默认不对外开放

`defaultPublic=false`。新建对话只对当前对话可见；别的对话要跨对话检索、恢复它的上下文，必须在面板里**逐个打开**。`session.json` 里没有 `public: true` 的旧数据也按不开放处理。

### 模型自述不是项目事实

从过程记录、归档、决策复盘提炼出来的知识会标成 `provenance: "model"`、`verified: false`。检索时按 **0.35 倍**降权，结果里标「⚠ 模型自述（未确认）」。用户原话（`user`）和显式 `remember` 写入的内容（`authored`）才按正常事实参与排序。

---

## 安装

### 1. 把记忆目录排除出项目 Git

默认记忆目录是工作区下的 `.ai-for-memory/`，`contexts/` 里是**完整对话全文**，可能包含密钥、内部接口或客户数据。第一次使用前，在你的项目根目录加入：

```gitignore
.ai-for-memory/
```

确认生效：

```bash
git check-ignore -v .ai-for-memory/
```

如果已经提交过，`.gitignore` 不会删除历史数据；需要 `git rm -r --cached .ai-for-memory`、轮换泄露的密钥，必要时用 `git filter-repo` 重写历史。

插件只做一层兜底：当默认目录**首次创建**、且项目的 `.gitignore` **已经存在**时，自动追加 `.ai-for-memory/`（已存在任意形式则不重复；不新建 `.gitignore`；自定义 `root` 不处理）。这不替代你手动确认。

### 2. 安装 bundle

```text
plugin_manager action=install_bundle target=<dsh-ai-for-memory 目录>
```

安装后：

- 工具列表出现 `aim_memory`、`aim_search`、`aim_context`、`aim_decide`、`aim_ask`；
- 侧栏出现「AI 记忆」入口；
- 主面板加载同一页面，包含六层浏览、外部模型和设置。

环境要求：**Node.js 20+**，零外部依赖。SQLite 持久镜像额外要求运行时有 `node:sqlite`（Node 22.5+ 起内置），没有时该开关不可用，但 JSON 与 RAG 不受影响。

### 3. 验证

```text
aim_memory action=status
```

应看到过程记录、归档、快照、知识库、决策、上下文的统计，以及 JSON 底座、SQL 镜像、RAG 状态。

### 4. 常用操作

```text
# 记一条过程记录；verify=pass 才会被 promote 自动提炼
aim_memory action=stage content="修复了导出中文文件名 500 的问题" kind=error verify=pass

# 归档过程记录
aim_memory action=archive

# 写入一条明确知识（同话题冲突时会返回 needs_confirm）
aim_memory action=remember text="发布前必须跑 node --test test/" category=workflow_rules

# 检索，默认跨对话
aim_search query="发布前要做什么" category=workflow_rules

# 预览能从过程记录/归档/上下文/决策里提炼什么
aim_memory action=promote dry_run=true

# 清理上下文前先存档，之后可 restore
aim_context action=save name=before-cleanup
aim_context action=clear
```

> 上下文清理默认在插件内部按话题相似度完成，不需要额外的压缩后端。只有把 `topicalClear` 设为 `false`、要退回 DSH 原生整段压缩时，才需要启用 `include:compaction-basic`。

### 卸载/升级

```text
plugin_manager action=remove_bundle target=dsh-ai-for-memory
```

升级建议先备份记忆目录，再移除、重新安装。重装前请重新加载插件，不要只替换文件。

---

## 数据目录

默认：

```text
<workspace>/.ai-for-memory/          # 共享层 + 对话目录
├── staging/                         # 过程记录，按小时一个 .jsonl
├── archive/                         # 分类归档，按分类一个 .jsonl
├── snapshots/                       # 精确状态快照
├── knowledge/                       # 知识库 JSON；可选 knowledge.sqlite / _usage.json
├── decisions/                       # 决策审查记录
├── contexts/                        # 对话上下文存档
├── exports/                         # 默认导出目录（按需创建）
├── sessions/
│   └── s_<sha256(sessionId) 前16位>/
│       ├── session.json             # 对话元数据
│       ├── compaction_status.json   # 最近一次清理状态（有则存在）
│       └── staging/ archive/ snapshots/ knowledge/ decisions/ contexts/ rag/
└── rag/                             # 共享层 RAG；对话索引在 sessions/s_*/rag/
```

根目录那一份是**共享层**，所有对话可读；`sessions/s_*/` 是每个对话自己的六层。目录名是 Session id 的稳定哈希，不把真实 id 直接暴露成路径。

`config.root` 留空时跟随工作区；非空时绝对路径直接使用，相对路径相对工作区解析。用过的根目录会登记到 `$DSH_HOME/ai-for-memory/roots.json`（默认 `~/.dsh/ai-for-memory/roots.json`，最多 100 条），面板的「记忆地址」下拉从这里读。

### 升级兼容

- 旧的根目录数据不会丢，它们留在共享层；升级后切到「共享层」或「全部对话」仍可见。
- 旧对话目录不会主动补建；下一次 `turn/end` 或记忆工具调用时会补上 `session.json`。
- 知识文档、`session.json`、`_promoted.json` 带 `schema_version: 1`；`contexts/`、`snapshots/`、`decisions/` 目前没有这个字段。
- RAG 只认 v3 分片索引。旧的单文件 `rag/index.json` 不再读取，重建时会被删除；旧 manifest 需要重建。
- `_promoted.json` 带 `version: 2`（提炼规则版本）和 `schema_version: 1`；版本不一致时台账整体作废并重新评估，不会继续相信旧规则的结果。

---

## 六层与数据流

```text
过程记录 staging  →  分类归档 archive
        │                  │
        │                  └── promote ──┐
        │                                  ▼
        └── promote ───────────────────► 知识库 knowledge
                                           │
快照 snapshots（精确状态）                  ├── SQLite 镜像（可选）
决策 decisions（审查记录）                  └── RAG 索引（可选）

上下文 contexts（清理前存档，可 restore）
```

| 层 | 目录 | 作用 | 是否可跨对话读 |
|---|---|---|---|
| 过程记录 | `staging/` | 刚发生的事，一行一条，只追加 | 面板「全部对话」可见（需开放） |
| 分类归档 | `archive/` | 按 kind/分类归档，按 `dedup_id` 幂等 | 面板可见（需开放） |
| 快照 | `snapshots/` | 保存/恢复任意状态对象 | `aim_memory restore` 先本对话，再找可见对话/共享层 |
| 知识库 | `knowledge/` | 可检索的文本事实 | `aim_search` 默认跨对话（需开放） |
| 决策 | `decisions/` | 可逆性审查结果 | 面板可见（需开放） |
| 上下文 | `contexts/` | 清出的对话轮次全文 | `aim_context restore` 可跨可见对话 |

写入范围由 `scope` 控制：

- `scope=session`（默认）：写当前对话自己的目录；
- `scope=shared`：写根目录的共享层，所有对话可读。

### 过程记录

`aim_memory action=stage` 追加一条记录，字段包括 `dedup_id`、`source_file`、`entry_index`、`timestamp`、`kind`、`content`、`source`、`risk`、`verify`。

- `content` 非空，且不超过 `maxContentChars`（默认 20000）；
- `kind`：`action`（默认）、`screenshot`、`decision`、`reasoning`、`error`、`state`、`digest`、`unknown`；
- `risk`：`low`（默认）/ `medium` / `high`；
- `verify`：`pending`（默认）/ `pass` / `fail` / `skip`。

`kind` 会映射到归档分类：`action→action_logs`、`screenshot→ui_facts`、`decision/reasoning→decisions_reasoning`、`error→errors_fixes`、`state→behavior_tristate`、`digest→action_logs`、`unknown→action_logs`。

### 分类归档

`aim_memory action=archive` 把过程记录按 `kind` 写入对应分类文件，也支持传 `category` 强制分类。归档按 `dedup_id` 幂等：重跑只补缺，不会重复写同一条。

归档分类是：`ui_facts`、`action_logs`、`decisions_reasoning`、`ui_maps`、`errors_fixes`、`behavior_tristate`、`snapshots`。

### 快照

`aim_memory action=snapshot name=... state={...}` 写 `snapshots/<id>.json`，`state` 必须是对象，序列化后不超过 `maxSnapshotBytes`（默认 262144 字节）。`aim_memory action=restore snapshot_id=...` 接受 id、名称或唯一前缀。

自动快照（见下文）与手动快照共用快照目录；**只有自动快照参与上限剪枝**，手动快照不会因为数量多而被自动删除。

### 决策

`aim_decide` 把决策、正反理由、风险、可逆性和可恢复路径写入 `decisions/`。审查看的是**可逆性**，不是理由字数：

1. `risk=low`，或 `risk=medium` 且 `reviewHighRiskOnly=true`：直接通过（`approved`，`reviewed=false`）；
2. 缺 `thesis` 或 `antithesis`：`needs_more_info`；
3. `irreversible` 不是布尔值：`needs_more_info`；
4. `irreversible=true`：`rejected`；
5. `irreversible=false` 但 `recoverable_via` 为空：`needs_more_info`；
6. 否则：`approved`。

`thesis_weight`、`antithesis_weight`、`risk_adjusted_score` 只写入审计，标记 `advisory_only: true`，不参与放行。

### 上下文

`aim_context` 负责保存、清理、恢复对话上下文。

- `save`：把当前已完成的轮次写成 `contexts/<id>.json`，包含 `turns[]` 和渲染文本；
- `clear`：默认登记待清理，在轮末按话题相似度真正清理；`topicalClear=false` 时改为先存档、再走 DSH 原生 `compaction`；
- `restore`：把存档重新注入当前会话（下一步生效），默认按「本对话 → 其他可见对话 → 共享层」查找。**不会整份注入**：按 `restoreMaxChars`（默认 12000 字符）只取最近的轮次，标题会写明「预算恢复最近 N/M 轮」，完整存档仍在 `contexts/`；
- `list` / `status` / `sessions`：列出存档、清理策略、上下文占用和其他对话规模。

**清理算法**：

- 最近 `keepRecentTurns`（默认 2）轮必留；
- 其余轮次与最近 2 轮比较主题相似度，低于 `similarityThreshold`（默认 0.05）的进入候选；
- 相似度 = 内容词 Sørensen–Dice（CJK 双字 + 拉丁词）+ 0.15 × 余弦；余弦只在大于 0.60 时计入；
- 只清连续、序号完整的轮次，系统提示节点不清理；
- 受 `maxClearTurns`（8）、`maxClearChars`（120000）、`minClearChars`（200）约束；
- **先写 `contexts/` 存档，再替换会话表面**；替换失败会写 `compaction_status.json`。

> `minClearChars` 是总字符下限：少于 200 字符的清理直接跳过，避免小对话反复抖动。

---

## 对话隔离、共享层与可见性

- 每个对话有独立 `sessions/s_*/`；写操作默认只写自己的对话。
- `scope=shared` 写共享层；共享层任何对话都能读。
- `aim_search` 默认 `scope=all`：本对话 + 其他**已开放**对话 + 共享层，结果标注来源对话。
- 面板「查看范围」：本对话 / 指定对话 / 全部对话 / 共享层。工作区分组来自 DSH 的会话分桶，不使用对话中途的 `cwd`。
- 跨对话检索先在每个 store 内按最高分归一化，再合并；相同内容用 Jaccard ≥0.85 折叠成一条，其他来源写成「另见」，不占 `top_k`。
- 未开放的对话在跨对话检索、恢复、面板合并视图里都不可见，数量也只显示汇总值。
- 对话名称可用面板修改，最长 80 字符；未命名时显示 DSH 自动标题。

---

## 工具参考

### `aim_memory`

| action | 必填/主要参数 | 作用 |
|---|---|---|
| `stage` | `content` | 追加过程记录；可选 `kind`、`source`、`risk`、`verify` |
| `archive` | — | 把过程记录归档；可选 `category` 强制分类 |
| `snapshot` | `name` | 保存状态快照；`state` 默认空对象 |
| `restore` | `snapshot_id` | 恢复快照；接受 id、名称或唯一前缀 |
| `list` | — | 列出本对话快照与可见层数量 |
| `remember` | `text` | 写入一条知识；可选 `doc_id`、`category`、`tags`、`url`、`confidence` |
| `learn` | `items` | 批量写知识，最多处理 100 条 |
| `promote` | — | 从过程记录/归档/上下文/决策提炼；`dry_run` 可预览，`limit` 默认 20 |
| `forget` | `doc_id` | 删除知识；接受精确 id 或唯一前缀 |
| `index` | — | 为当前范围建/更新 RAG 索引；要求 Embedding 与 Rerank 都配置 |
| `export` | — | 导出 `knowledge` / `sql` / `rag`，可多选；`dest` 省略写 `<root>/exports/` |
| `incident` | `title` | 单独记录一次事故，归入 `incidents` |
| `status` | — | 各层统计、底座/镜像/RAG/权重/事故状态 |

所有写入 action 支持 `scope=session|shared`，默认 `session`。

#### `remember` 的规则

- `text` 必填，单条最多 **2000 字符**；
- `category` 默认 `project_facts`；带 `url` 时归到 `external_sources`；
- `tags` 最多 8 个；
- `confidence` 默认 `0.8`；
- `doc_id` 默认由正文生成 `k_<hash8>`；自定义 id 只影响命名，**去重仍按正文**；同一 id 被不同正文占用时退回正文 id，不覆盖旧事实；
- 不带 `confirm=true` 时，如果新内容与已有知识相似度在 **0.55~0.85**，写入会被拦下，返回 `needs_confirm` 和最多 3 条冲突；先问用户，同意后再带 `confirm=true` 重试；
- **高相似度不等于同一条**：≥0.85 时还会比较数字、URL 和相反词。端口 `8080→8081`、阈值 `0.8→0.9`、`开启→关闭` 会被判定为 **update**，返回 `kind: "update"` 和变化明细，不会静默合并；确认后写入旧条目并保留 `changes` 审计；
- 只有高相似度且这些值都没变的重复写入才直接合并：保留 `created_at`，正文不变时 `revision` 不增加，`evidence` 追加（最多 20 条），`tags` 取并集，`confidence` 取较大值，`provenance` 只升不降。

#### `promote` 的规则

- 只自动提炼 `verify=pass` 的过程记录/归档；
- 上下文只提炼**用户原话**；
- 决策记录按「决策 + 理由」提炼；
- 结构化记录超过 **1200 字符**会截断，标 `truncated`，置信度降到 `0.35`；普通事实超过 400 字符、决策超过 400 字符也会截断并标记；
- 模型推导的内容写 `provenance: model`、`verified: false`；
- **提炼不覆盖已有正文**：`promote` 用 `preserveText: true` 调 `remember`，命中去重条目时只补 `evidence`，保留原句与 `revision`；
- 如果提炼出的数值/URL/开关与已有条目不同，判定为 update：不写盘，进入 `pending/knowledge.json` 待确认队列，返回 `pending` 列表；源 ref 不消费，下次还会提示；面板知识库页和 `aim_memory status` 会显示待确认数量；
- 用户确认后用 `remember` + `confirm=true` 写入原 `doc_id`，同时清掉对应的待确认项；
- 提炼台账 `knowledge/_promoted.json` 记录已处理的 ref，`version` 不匹配时整体重扫；台账最多 4000 条；
- `dry_run=true` 只返回预览，不写盘。

#### `incident` 的规则

`title` 必填，可选 `what_happened`、`impact`、`cause`、`fix`、`prevention`、`severity`、`status`/`incident_status`、`occurred_at`、`tags`。会生成固定模板正文，分类为 `incidents`，来源 `incident`，置信度 `1`，并绕过知识冲突闸门；自动 `promote` 不扫描事故。

#### `index` 与 `export`

`index` 只建索引，不改变是否挂载；挂载由配置 `ragMount` 决定。需要 `externalEmbedModel` 和 `externalRerankModel` 同时非空。

`export`：

- `knowledge`：JSON（无损）或 Markdown（按分类、含证据）；
- `sql`：从 JSON 现场生成完整 `knowledge.sqlite`；
- `rag`：合并当前 v3 分片索引为一个自包含 JSON。

文件默认写到 `<root>/exports/`；单类型 `dest` 可以给完整文件路径。导出是额外副本，不删除、不裁剪本地数据。

### `aim_search`

参数：

- `query` 必填；
- `scope`：`all`（默认）/ `session` / `shared`；
- `route`：`auto`（默认）/ `sql` / `vector` / `hybrid`；
- `mode`：`bm25` / `vector` / `hybrid`（默认），只在本地检索路径生效；
- `category`：按知识分类过滤；
- `top_k`：默认 5，最大 50。

路由规则：

- 指标、聚合、精确 `k_...` id → SQL；
- 模糊、开放问题 → 向量（RAG 已挂载且索引就绪时，RAG + 本地 BM25 做 RRF 融合）或本地检索；
- 两者兼有 → hybrid（SQL 统计 + 向量补充）；
- SQL 翻译失败 → 回退向量；向量零命中 → 反向 SQL 兜底。

本地检索：

- BM25：`k1=1.5`、`b=0.75`；
- 向量：128 维哈希词袋，余弦；
- hybrid：`0.6 × 归一化 BM25 + 0.4 × max(0, 余弦)`；
- 最终分再乘 `(0.85 + 0.15 × confidence)`；`model + 未 verified` 再乘 `0.35`；
- 再乘最近使用权重 `(1 + 0.25 × w)`，`w = 0.5^(距上次使用天数 / 14)`，从未用过的 `w=0`；
- 被更新过的知识在结果里标 `｜已更新×N`，面板里也有 `⤴ 已更新`；
- 权重只使用**调用方自己的 store**：A 对话的最近使用不会抬高 B 对话里的同一文档。

SQL 通道每次从 JSON 底座临时建只读内存表，只允许单条 `SELECT` / `WITH`，最多返回 50 行；不执行 DML/DDL，不需要打开 SQLite 持久镜像。

### `aim_context`

| action | 参数 | 作用 |
|---|---|---|
| `save` | `name` 可选 | 保存当前已完成轮次 |
| `clear` | — | 登记/执行按话题相似度清理 |
| `restore` | `context_id` | 恢复存档到当前会话 |
| `list` | `scope` | 列出存档 |
| `status` | — | 清理策略、上下文占用、待清理、最近清理 |
| `sessions` | — | 列出对话及其记忆规模 |

`scope`：`session`（默认）/ `all` / `shared`。`restore` 不传 `scope` 时按本对话 → 其他可见对话 → 共享层查找。

### `aim_decide`

参数：`decision` 必填；`risk`（默认 `low`）、`thesis`、`antithesis`、`irreversible`、`recoverable_via`、`scope`。

结果只有三种：`approved`、`rejected`、`needs_more_info`。判定顺序见上文「决策」。结果总写入 `decisions/`，包括审计权重，即使结论是自动放行。

### `aim_ask`

只连接插件配置的外部服务，不写记忆。

| action | 参数 | 说明 |
|---|---|---|
| `chat` | `prompt` 或 `messages`、`system`、`sources` | 一次性补全；`sources` 编号并要求用 `[n]` 标注 |
| `embed` | `text` 或 `texts` | 取向量 |
| `rerank` | `query`、`documents`（最多 64） | 按 query 重排 |
| `models` | — | 列出服务端模型 |
| `probe` | `deep` | 连通性检查；`deep=1` 额外探测 embed/rerank |

`chat` 的 `sources` 最多 20 条，每条最多 2000 字，合计最多 12000 字。结果末尾附：

- **调用记录**：模型、地址、时间、输入 sha256 短指纹与字数、输出长度/是否截断、请求 id、服务端 created、tokens、finish_reason；
- **来源对照**：每条来源 id/url + ✓已引用 / ·未引用，兼容 `[n]` 和 `【n】`。

---

## 自动行为

### 自动整理

由 `autoEnabled` 控制，默认**关闭**。打开后，在每个 `turn/end`：

- 每 `autoEveryRounds` 轮（默认 5）触发一次；或
- 上下文占用达到 `contextUsagePercent`（默认 70%）触发一次（读数来自 DSH `tokenMeter`，没有测量值时不触发）。

两个条件任一满足，本轮只整理一次：

1. 生成轮次摘要 `digest`，写入过程记录；
2. 执行归档；
3. 如果 `autoKnowledge !== false`，顺带执行 `promote`，`autoKnowledgeLimit` 默认 10。

`topicalClear=false` 时，先保存上下文，再走 DSH 原生 `compaction`；为 `true` 时按话题相似度清理。

**subagent 不触发自动整理**（不会写自动摘要/自动快照）。

### 自动快照

由 `autoSnapshot` 控制，默认**开启**，与 `autoEnabled` 独立。

- 每 `autoSnapshotEvery` 轮（默认 5），把最近 `maxContextChars` 窗口写入 `snapshots/auto-snapshot-t<turn>.json`；
- 最多保留 `autoSnapshotMax` 个（默认 10）；
- 超过上限时，先找最相似的一对自动快照，相似度 ≥0.82 删除较旧的那个；没有相似对时删最旧的；
- 只用 `isAutoSnapshot` 识别的自动快照参与剪枝；手动快照不受上限影响。

### 自动知识提炼

`autoKnowledge` 默认 `true`，但它挂在自动整理流程里：`autoEnabled=false` 时不会自动提炼；手动 `aim_memory action=promote` 始终可用。

---

## 知识库

### 分类

固定九类，一条知识只属于一类：

`project_facts`、`ui_facts`、`errors_fixes`、`decisions_reasoning`、`tools_apis`、`workflow_rules`、`external_sources`、`open_questions`、`incidents`。

旧名称（如 `behavior_tristate`、`ui_maps`、`action_logs`、`rules`、`bugs`、`事故`、`postmortem`）会映射到当前分类。

### 来源与出处

`source` 是：`user`、`web`、`reasoning`、`staging`、`archive`、`context`、`decision`、`incident`、`unknown`。

`provenance` 是三档：

- `authored`：`remember` / `learn` 显式写入；
- `user`：从上下文的用户原话提炼；
- `model`：从过程记录、归档或决策复盘提炼，检索时降权。

`evidence` 最多 20 条，记录每次确认来自哪一层/哪条记录，例如 `staging:<dedup_id>`、`context:<id>#turn3`、`decision:<id>`。

### 文档形状

```json
{
  "doc_id": "k_921036f3",
  "schema_version": 1,
  "text": "DSH 的压缩阈值默认是 0.8",
  "category": "tools_apis",
  "source": "web",
  "tags": ["compaction"],
  "url": "https://example.com/compaction",
  "confidence": 0.7,
  "provenance": "authored",
  "verified": true,
  "evidence": [
    { "kind": "web", "ref": "web", "at": "2026-11-16T13:19:41.400Z" }
  ],
  "changes": [
    {
      "at": "2026-11-17T09:00:00.000Z",
      "kind": "number",
      "before": ["0.7"],
      "after": ["0.8"],
      "previous_text": "DSH 的压缩阈值默认是 0.7"
    }
  ],
  "created_at": "2026-11-16T13:19:41.400Z",
  "updated_at": "2026-11-16T13:19:41.400Z",
  "revision": 2
}
```

字段说明：

- `doc_id`：默认 `k_<hash8>`，由正文推导；自定义 id 只影响命名；
- `schema_version`：当前 `1`；
- `text`：一条一句结论；
- `tags`：最多 8 个；
- `confidence`：0~1，参与排序，但有界；
- `verified`：模型自述默认 `false`；
- `revision`：正文实际变更次数；合并同句/只补证据不增加；`created_at` 首次写入后保留；
- `changes`：正文发生更新时追加的审计，最多 5 条；每条含 `at`、`kind`（`number`/`url`/`polarity`/`text`）、`before`、`after`、`previous_text`。检索和面板会显示「已更新」标记。

### 冲突与合并

- 相似度 ≥0.85 且数字、URL、极性都没变：视为同一条，合并进已有文档；
- 相似度 ≥0.85 但数字/URL/极性变了：视为**更新**，不静默合并；不带 `confirm=true` 时返回 `kind: "update"`，确认后写入原 `doc_id`，并在 `changes` 里保留上一版；
- 提炼（`promote` / 外部模型提炼）永远不覆盖已有正文：同义改写只补证据；值变化进入 `pending/knowledge.json`，面板知识库页显示「待确认知识更新」，由用户确认后才写；
- 0.55 ≤ 相似度 < 0.85：视为同话题异措辞，`remember` 不带 `confirm=true` 时拒绝写入，返回冲突条目；
- `incidents` 跳过冲突闸门；
- 合并时 `category` 以新写入为准，`source` 保留首个非 `unknown`，`url` 空值沿用旧值，`provenance` 只升不降，`verified` 取或，`confidence` 取较大值。

---

## 检索与 RAG

### 本地检索

见 `aim_search` 一节的公式。本地检索不需要任何服务，默认 `hybrid`。

### SQL 路由

`route=sql` 或 `auto` 命中指标/聚合/精确 id 时，插件会把 JSON 文档装进一个临时只读库，把问题翻译成单条 `SELECT` / `WITH`。支持统计、分组、最近 N 条、标签、置信度、最长文档、精确 id 等；不允许写操作，结果最多 50 行。

`route=auto` 在 SQL 翻译失败时回退向量；向量零命中时反向用 SQL 兜底。

### RAG

RAG 是知识库上的**可选挂载索引**，不是默认检索。索引建在**当前 store 的 `rag/`** 下：共享层在根目录，对话索引在 `sessions/s_*/rag/`，互不混用。

建索引前必须同时配置：

- `externalEmbedModel`（非空）；
- `externalRerankModel`（非空）。

缺任一模型，`aim_memory action=index`、面板「建立/更新索引」和 `ragMount=true` 的保存都会被拒绝。

索引布局 v3：

```text
rag/
├── manifest.json          # 最后原子写
├── shard-<category>.json  # 每个知识分类一个分片
└── .lock                  # 跨进程构建锁
```

特点：

- 正文 sha256 复用：模型、地址、维度一致且正文未变时复用向量；
- 只重写变化的分片；分片 hash 不变则跳过；
- 同分类内嵌入余弦 ≥0.95 视为近重复，只索引较新一篇（知识库本身不删除）；
- 构建失败时保留旧索引，不会把半成品写进去；
- 并发构建按 root 串行，跨进程用 `.lock`（stale 60 秒，等待 3 秒）；
- 旧单文件 `rag/index.json` 不再读取；旧 manifest 不认，需重建。

查询：

- **RRF 融合**：`ragMount=true` 且索引就绪时，同时跑 RAG 语义通道与本地 BM25 通道，用 Reciprocal Rank Fusion（`k=60`）合并排名，避免两套通道各给一份不一致的答案；
- 只在 RAG 索引里被语义去重掉的旧文档，仍由 BM25 通道带回；结果行会标 `RRF=...｜RAG#n｜BM25#m`，能直接看出某条来自哪一路；
- 先按分类过滤，嵌入召回候选，再强制 rerank；
- 如果重排服务返回的是纯嵌入排序、或模型/地址/维度不匹配，回退本地 BM25，并在结果里写明原因，不会静默假装 RAG 可用；
- RAG / BM25 融合后的命中同样应用 confidence、provenance 和最近使用权重；
- 跨对话检索仍在融合后折叠重复；同一 store 内的不同文档不会被跨来源折叠吃掉。
- 未建索引的 store 只参与 BM25 通道，结果里的 `covers` 会注明。

---

## SQLite 只读镜像

`knowledgeBackend`：

- `json`（默认）：只写 JSON；
- `sqlite`（别名 `sql`）：在写 JSON 之后，额外 upsert 一份 `knowledge/knowledge.sqlite`。

事实：

- JSON 是唯一底座；SQLite 不是 canonical；
- 表 `knowledge_docs` 含 `doc_id`、正文、分类、来源、标签、置信度、provenance、verified、证据、时间、revision；
- 首次打开会把已有 JSON 导入；
- `documents()` 不读 SQLite；镜像被外部改坏不影响知识库；
- 删除知识时两边一起删；
- 运行时没有 `node:sqlite` 时自动回退 JSON，并在面板提示。

打开镜像只增加磁盘写入，不提升检索精度；`aim_search` 的 SQL 路由本来就会从 JSON 临时建只读表。

---

## 外部模型

三层「外部模型」模式只用 **Embedding + Rerank**，不需要生成式 chat：

| 层 | 外部模式做什么 | 失败时 |
|---|---|---|
| 归档 | 记录向量与分类描述比余弦，取前 3 名交 rerank 复核 | 回退本地 `kind → 分类` |
| 知识库提炼 | 句子嵌入，取对全文平均相似度最高的句子，按分类描述归类 | 回退本地确定性提炼 |
| 上下文清理 | 被清轮次按中心句抽取式摘要 | 回退本地摘要/存档 |

配置项：

- 主服务：`externalBaseUrl`、`externalModel`、`externalApiKey`、`externalTimeoutMs`；
- Embedding：`externalEmbedBaseUrl`、`externalEmbedModel`、`externalEmbedApiKey`；
- Rerank：`externalRerankBaseUrl`、`externalRerankModel`、`externalRerankApiKey`。

地址可以填服务根、带 `/v1` 的地址或完整接口地址；Embedding/Rerank 地址留空时沿用主地址。API Key 留空时沿用主 Key。

请求兼容 OpenAI 风格：

- Embedding：`/v1/embeddings`，失败再试无版本路径；
- Rerank：`/v1/rerank`，失败再试无版本路径；
- Models：兼容 `{data: [...]}` 和裸数组。

预设服务包括 OpenAI、DeepSeek、SiliconFlow、百炼、智谱、Kimi、火山方舟、Cohere、Jina、Ollama、LM Studio、llama.cpp。

**数据会发给你配置的服务**。敏感项目优先本地服务；用云端时要接受网络依赖、费用和数据出域。

---

## 面板

面板是一个单页，不是独立设置页。侧栏「AI 记忆」打开。

### 顶部

- **查看范围**：本对话（自动识别）/ 指定对话 / 全部对话 / 共享层；
- 选「指定对话」后出现**工作区**和**对话**两级下拉；
- **记忆目录**：从已登记根目录中选择；
- 刷新、当前目录路径、复制路径、在文件管理器中打开；
- 对话设置：名称（最长 80）、开放/不开放、保存。

### 六个 tab

| tab | 内容 |
|---|---|
| 过程记录 | kind、来源、风险、验证、时间、正文 |
| 归档 | 按分类分组，分组和条目都可折叠 |
| 快照 | id、大小、时间、状态 JSON |
| 知识库 | 搜索、分类/来源/标签/证据数、模型自述黄标、`⤴ 已更新` 标记、导出 |
| 决策 | outcome、risk、决策、正/反理由 |
| 上下文 | id、标签、时间、轮次区间、字符数、摘要、全文、restore 提示 |

工具条支持全部展开/收起、显示更多（每次 +8）。折叠时只渲染一行摘要，展开才渲染正文。

### 外部模型卡

- 常用服务预设；
- 主 / Embedding / Rerank 三栏 Key（password）；
- 地址、模型、超时；
- 归档方式 / 知识库提炼 / 上下文清理三个「本地规则 | 外部模型」开关；
- 「测试连接」会先保存表单，再请求 `/external?deep=1`。

### 使用与存储设置

- 自动整理开关、每几轮、占用百分比；
- 自动快照开关、间隔、上限；
- RAG 挂载开关、建立/更新索引、索引状态与陈旧警告；
- JSON 底座说明 + SQL 只读镜像开关；
- 新对话默认对外开放（建议关闭）；
- 按话题相似度清理开关、阈值、保留轮数；
- 记忆地址、目录名。

### 保存行为

面板设置通过 `POST /config` 全量提交。API Key 三态：

- 空字符串：保留已保存的值；
- `-`：清除；
- 其他：替换（最多 500 字符）。

`/state` 只返回 `externalHasApiKey`、`externalEmbedHasApiKey`、`externalRerankHasApiKey` 三个布尔，不返回明文；保存响应也不含 Key。

---

## 配置

配置文件由 DSH profile 的 `cordis.patch.yml` 或面板保存。下表默认值来自当前代码。

### 运行与存储

| 键 | 默认 | 说明/范围 |
|---|---|---|
| `directoryName` | `.ai-for-memory` | 跟随项目时使用的目录名 |
| `root` | `""` | 空=跟随工作区；非空绝对路径或相对工作区的路径 |
| `maxContentChars` | `20000` | 单条过程记录上限（整数，代码层硬限制） |
| `maxSnapshotBytes` | `262144` | 单次快照序列化上限（字节） |
| `defaultTopK` | `5` | `aim_search` 默认条数 |
| `knowledgeBackend` | `"json"` | `json` / `sqlite`（`sql` 视为 `sqlite`） |
| `defaultPublic` | `false` | 新对话是否默认对外开放 |
| `reviewHighRiskOnly` | `true` | `medium` 风险是否只做自动放行 |

### 自动整理与清理

| 键 | 默认 | 说明/范围 |
|---|---|---|
| `autoEnabled` | `false` | 自动整理总开关 |
| `autoEveryRounds` | `5` | 每几轮触发（1~100） |
| `contextUsagePercent` | `70` | 上下文占用触发阈值（1~100） |
| `autoKnowledge` | `true` | 自动整理时顺带提炼知识 |
| `autoKnowledgeLimit` | `10` | 每次自动提炼上限（1~100） |
| `topicalClear` | `true` | `false` 时退回 DSH 原生压缩 |
| `similarityThreshold` | `0.05` | 相似度阈值（0.01~0.95） |
| `keepRecentTurns` | `2` | 始终保留最近轮数（1~20） |
| `maxClearTurns` | `8` | 单次最多清出轮数（1~50） |
| `minClearChars` | `200` | 低于此字符数不清理（0~20000） |
| `maxClearChars` | `120000` | 单次清出字符上限（1000~1000000） |
| `maxContextChars` | `30000` | 上下文快照/窗口字符上限（1000~200000） |
| `restoreMaxChars` | `12000` | 单次 restore 注入上限（1000~100000）；只取最近轮次，不满整份存档 |

### 自动快照

| 键 | 默认 | 说明/范围 |
|---|---|---|
| `autoSnapshot` | `true` | 自动快照开关（独立于自动整理） |
| `autoSnapshotEvery` | `5` | 每几轮快照（1~100） |
| `autoSnapshotMax` | `10` | 自动快照上限（1~200） |

### RAG 与外部模型

| 键 | 默认 | 说明/范围 |
|---|---|---|
| `ragMount` | `false` | 是否把 RAG 挂到 `aim_search` |
| `externalBaseUrl` | `http://127.0.0.1:8080` | 主服务地址 |
| `externalModel` | `""` | 主模型名 |
| `externalApiKey` | `""` | 主 Key |
| `externalTimeoutMs` | `60000` | 超时（1000~600000） |
| `externalEmbedBaseUrl` | `""` | 空=沿用主地址 |
| `externalEmbedModel` | `""` | 非空才能建 RAG |
| `externalEmbedApiKey` | `""` | 空=沿用主 Key |
| `externalRerankBaseUrl` | `""` | 空=沿用主地址 |
| `externalRerankModel` | `""` | 非空才能建 RAG |
| `externalRerankApiKey` | `""` | 空=沿用主 Key |
| `archiveExternal` | `false` | 归档使用外部模型 |
| `knowledgeExternal` | `false` | 知识库提炼使用外部模型 |
| `contextExternal` | `false` | 上下文清理使用外部模型 |

> `defaultTopK` 和 `maxSnapshotBytes` 只做数字校验，没有额外范围限制；其余数值项按上表范围校验。

---

## 面板 HTTP API

前缀：`/ai-for-memory/api`。

安全限制：

- 只接受回环地址（`127.0.0.1`、`::1`、`::ffff:127.0.0.1`）；
- 写操作要求可信 Origin：Origin 的 host 与请求 host 相同，或协议为 `dsh-app:`；没有 Origin 头时放行；
- JSON 请求体上限 64 KB；
- `root` 只能取自已登记根目录或插件配置的 `root`，不能读任意路径；
- 每个路由只接受自己声明的方法；方法不匹配时返回 405 并带 `allow`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/state` | 面板快照；参数 `root`、`session`、`scope` |
| POST | `/session` | 修改对话名称/开放状态 |
| POST | `/reveal` | 在系统文件管理器中打开记忆目录 |
| GET | `/external` | 探测外部服务；`deep=1` 额外测 embed/rerank |
| POST | `/rag/index` | 建立/更新 RAG 索引 |
| GET | `/knowledge/export` | 导出 knowledge/sql/rag（虽然是 GET，也做 same-origin 检查） |
| POST | `/config` | 保存面板设置 |

`/state` 的返回经过截断：过程记录 100 条、归档每类 40 条、快照 30 条、知识 200 条、决策 100 条、对话列表 40 条；上下文列表全量，但正文最多 6000 字符、摘要最多 600 字符。

---

## 隐私与安全

- 默认 `root` 在工作区内；`contexts/` 是全文存档，务必排除出版本库。
- 新对话默认不开放；开放是逐个对话的显式动作。
- 共享层所有对话可读；不要把秘密写进共享层。
- API 不返回 Key 明文；配置文件里的 Key 仍以明文形式存在，注意目录权限。
- 外部模式会把文本片段发送到你配置的服务。
- `aim_search` 的 SQL 只读且单条，但结果仍来自记忆库，不要把不可信内容当成系统指令。
- 记忆目录里可能有完整对话，备份/分享前先检查。

### 误提交后的处理

```bash
git rm -r --cached .ai-for-memory
git commit -m "stop tracking local memory archives"
```

`.gitignore` 不会删除历史；如果已经推送过，按泄露处理：轮换密钥，必要时用 `git filter-repo`/BFG 重写并通知协作者。

---

## 已知限制

- 0.1.0 是测试版，存储格式和面板可能继续调整。
- 知识库的 SQLite 镜像依赖 `node:sqlite`；Node 20 可以运行插件，但镜像需要更高版本。
- 自动快照只剪枝自动快照，手动快照不会自动清理。
- `aim_context clear` 在默认策略下登记待清理，轮末才真正执行。
- `restore` 按 `restoreMaxChars` 取最近轮次，不是整份存档；如果恢复后仍嫌窗口大，调小该值，而不是反复 clear/restore。
- subagent 不触发自动整理/自动快照，但仍可主动调用记忆工具写入。
- `promote` 的「剩余」是上限估计，不是精确未提炼数。
- RAG 需要 Embedding + Rerank 两个模型；缺一个就不可用，也不会退化成纯嵌入排序。
- 本地检索是词袋 BM25/哈希向量，不是语义模型；同义改写命中能力有限。
- 更新检测只覆盖数字、URL 和少数相反词（开启/关闭、启用/禁用等）；更隐蔽的语义改写仍按 0.55~0.85 冲突或低相似度新事实处理，不能保证所有“改了意思”的句子都被拦下。
- 跨对话可见性完全依赖 `public === true`；旧数据缺少字段时按不开放处理。

---

## 开发与测试

```bash
node --test test/
```

当前 **89 条测试**，不需要启动 DSH。

测试覆盖：

- 过程记录去重、归档幂等、快照保存/恢复；
- 三种本地检索模式、confidence/provenance 降权、最近使用权重；
- 跨对话归一化与重复折叠；
- 知识分类、`doc_id` 生成与自定义 id 去重、冲突闸门、事故独立分类；
- 高相似度更新检测（端口/阈值/URL/极性）与 `changes` 审计；
- `promote` 仅提炼 `verify=pass`、台账版本失效、长记录截断；
- 上下文相似度清理、存档可恢复、自动整理触发、restore 按预算只注入最近轮次；
- 自动快照与相似度剪枝；
- RAG 分片构建/复用/失败保留/双模型门槛/旧 manifest 失效；
- SQLite 镜像导入/写入/删除/降级；
- SQL 路由安全、导出三种类型；
- 面板数据组装、对话隔离与私有对话不可见；
- `.gitignore` 幂等与默认目录首次创建。

### 文件结构

```text
dsh-ai-for-memory/
├── index.js              # 插件入口：配置、5 个工具、自动整理/快照、上下文管理
├── client.js             # Web 面板
├── cordis.patch.yml      # bundle 挂载声明
├── package.json
├── icon.svg
├── locale/{zh,en}.json   # 面板标题/描述
├── lib/
│   ├── store.js          # 六层文件存储、知识合并、快照/上下文
│   ├── scopes.js         # 每对话一份 store + session.json
│   ├── registry.js       # 记忆根目录登记
│   ├── activity.js       # 进程内最近活动对话
│   ├── context.js        # 轮次收集、存档、恢复渲染
│   ├── auto.js           # 轮次摘要
│   ├── similarity.js     # 话题相似度与轮次选择
│   ├── snapshot.js       # 自动快照识别与剪枝
│   ├── pressure.js       # 上下文占用阈值
│   ├── decision.js       # 可逆性审查
│   ├── knowledge.js      # 分类、去重、冲突、提炼
│   ├── retrieval.js      # 分词、BM25、哈希向量、混合检索
│   ├── knowledge-query.js# 查询路由 + 只读 Text-to-SQL
│   ├── knowledge-sqlite.js # SQLite 只读镜像
│   ├── rag.js            # 分片 RAG 索引
│   ├── export.js         # knowledge/sql/rag 导出
│   ├── external.js       # OpenAI 兼容 HTTP 客户端
│   ├── external-ops.js   # 三层的 Embedding + Rerank 实现
│   ├── usage.js          # 知识最近使用权重
│   ├── gitignore.js      # 默认目录兜底
│   ├── dsh-workspace.js  # DSH 会话分桶 → 工作区
│   ├── ui-state.js       # 面板数据组装
│   └── api.js            # 面板 HTTP API
└── test/core.test.mjs
```

## License

MIT。见 [LICENSE](LICENSE)。
