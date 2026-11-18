# AI for Memory — 给项目一个不会忘事的记忆层

[![Status](https://img.shields.io/badge/status-stable%200.1-brightgreen.svg)]()
[![Version](https://img.shields.io/badge/version-0.1.0-lightgrey.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **0.1.0 项目级正式版。** 从这一版起按 `主版本.次版本.修订号` 更新；升级前仍建议备份记忆目录。
> 插件本体零外部依赖，只使用 Node 内置模块。

## 版本号

从 `0.1.0` 起使用三段式版本号：

| 位置 | 含义 | 示例 |
|---|---|---|
| 第一位 | 重大更新：工具大范围修改、接口或存储格式调整、需要迁移 | `0.1.0` → `1.0.0` |
| 第二位 | 功能更新：新增工具、动作、面板能力，保持向后兼容 | `0.1.0` → `0.2.0` |
| 第三位 | 修复更新：只修 bug，不改变既有接口 | `0.2.0` → `0.2.1` |

0.x 阶段的重大更新直接升到 `1.0.0`；普通功能更新只升第二位，修复只升第三位。

版本号以 `package.json` 的 `version` 为准，README 徽章、发布标签和面板显示必须与它一致。每次发布都要同时更新这三处。

---

## 它解决什么问题

用 AI 写代码时，经常会遇到这些情况：

- 上次已经决定过的事，这次又要重新解释；
- 刚修过的错误，过几天又踩一遍；
- 上下文被清理后，之前的讨论和结论找不回来；
- 多个对话各自知道一点，但互相不通气；
- 网页上查到的资料、项目里的约定、模型自己的推测，混在一起分不清。

AI for Memory 做的事，就是把这些信息分开保存、按需取回：

- **对话上下文**：太长的对话可以清掉，但清掉前先完整存档，之后能恢复；
- **项目记忆**：过程记录、归档、快照、知识库、决策和上下文六层；
- **跨对话检索**：默认只读“本对话 + 已开放的其他对话 + 共享层”；
- **知识库**：一条一句、带分类和出处，可以检索、提炼、导出；
- **可选增强**：SQL 查询、RAG 语义检索、外部 Embedding / Rerank 服务。

默认是**轻量模式**：本地规则 + 本地检索，不联网、不需要 API Key。RAG、SQL 持久镜像和外部模型默认关闭；自动快照默认开启，自动整理默认关闭。

---

## 一句话理解六层

| 层 | 你可以把它理解成 | 主要用途 |
|---|---|---|
| 过程记录 `staging` | 工作日志 | 刚发生了什么，先一行一条记下来 |
| 分类归档 `archive` | 整理后的档案 | 把过程记录按错误、决策、界面事实等分类 |
| 快照 `snapshots` | 状态存档 | 保存任意状态对象，之后原样恢复 |
| 知识库 `knowledge` | 项目事实卡片 | 一条一句的结论，可检索、可提炼、可导出 |
| 决策 `decisions` | 决策复盘 | 高风险操作的正反理由、可逆性和结论 |
| 上下文 `contexts` | 对话存档 | 清理前保存完整轮次，之后可以 restore |

数据流大致是：

```text
过程记录 ──归档──► 分类归档
    │                  │
    └──────提炼───────► 知识库 ──► 可选 SQL / RAG 视图
                           ▲
上下文、决策 ───提炼──────┘

快照、上下文：独立保存，按需恢复
```

---

## 对话隔离：默认不串门

每个对话都有自己的记忆目录；写入默认只写当前对话。

- **本对话**：当前对话自己的记忆；
- **共享层**：根目录下的一份公共记忆，所有对话都能读；
- **其他对话**：默认不可见，需要你在面板里逐个“开放”；
- **全部对话**：本对话 + 已开放的其他对话 + 共享层。

`aim_search` 默认范围是 `all`，但“所有”只包含**已开放**的对话。未开放的对话在检索、恢复和面板合并视图里都不可见。

最近使用权重也只属于文档所在的对话：

- A 检索到 B 的文档，不会把 B 的 `doc_id` 写进 A 的使用记录；
- B 的文档不会因为 A 用过而获得 A 的权重加成；
- 旧的跨对话脏记录会在读取使用记录时自动清掉。

---

## 三个重要原则

### 1. JSON 是底座

知识库先写 `knowledge/<doc_id>.json`，这个文件就是审查点。SQLite 镜像、RAG 索引和导出文件都从 JSON 派生；派生视图损坏不会反过来破坏 JSON。

### 2. 对话默认不对外开放

新建对话默认是关闭的。因为上下文存档包含完整对话，可能包含密钥、内部接口或客户数据；需要跨对话读取时，再在面板里明确打开。

### 3. 模型自述不是项目事实

`aim_memory` 是给模型用的工具，模型自己写入的内容（`remember`、`learn`、`incident`）默认是：

```text
provenance: model
verified: false
```

检索时会被降权，面板上会带黄色「模型自述（未确认）」标记。用户确认后才会转成已确认事实。

---

## 安装

### 1. 把记忆目录排除出 Git

默认记忆目录是工作区下的 `.ai-for-memory/`。里面可能有完整对话和内部信息，第一次使用前请在你的项目根目录的 `.gitignore` 中加入：

```gitignore
.ai-for-memory/
```

确认：

```bash
git check-ignore -v .ai-for-memory/
```

如果已经提交过，`.gitignore` 不会删除历史记录；需要先 `git rm -r --cached .ai-for-memory`，再视情况轮换密钥或清理历史。

插件只做一层兜底：默认目录首次创建、且 `.gitignore` 已存在时，会尝试追加这条规则；不新建 `.gitignore`，也不会处理自定义目录。仍然建议你自己确认。

### 2. 安装 bundle

在 DSH 中执行：

```text
plugin_manager action=install_bundle target=<dsh-ai-for-memory 目录>
```

安装后应看到：

- 工具：`aim_memory`、`aim_search`、`aim_context`、`aim_decide`、`aim_ask`；
- 侧栏入口「AI 记忆」；
- 面板页面，包含六层浏览、外部模型和设置。

环境要求：

- **Node.js 20+** 可以运行插件和本地记忆；
- **SQL 查询和 SQLite 镜像**需要运行时有 `node:sqlite`（Node 22.5+ 起内置）；
- RAG 需要配置外部 Embedding 和 Rerank 服务，不需要 `node:sqlite`。

### 3. 验证

```text
aim_memory action=status
```

能看到过程记录、归档、快照、知识库、决策、上下文的统计，以及 JSON 底座、SQL 镜像和 RAG 状态，就说明基本可用。

### 4. 升级与卸载

升级前先备份整个记忆目录。建议移除旧 bundle、重新安装，然后重新加载插件，不要只替换文件。

```text
plugin_manager action=remove_bundle target=dsh-ai-for-memory
```

旧的根目录数据会留在共享层；旧对话目录会在下次使用或下一轮结束时补上元数据。旧版 RAG 单文件索引不再读取，需要重新建立。

---

## 第一次使用

下面是一组最小示例。

```text
# 1. 记一条过程记录；verify=pass 的记录才容易被自动提炼
aim_memory action=stage content="修复了导出中文文件名 500 的问题" kind=error verify=pass

# 2. 归档过程记录
aim_memory action=archive

# 3. 写一条知识
aim_memory action=remember text="发布前必须跑 node --test test/core.test.mjs" category=workflow_rules

# 4. 检索
aim_search query="发布前要做什么"

# 5. 预览能从各层提炼出什么，不写盘
aim_memory action=promote dry_run=true

# 6. 上下文清理（先存档，之后可 restore）
aim_context action=save name=before-cleanup
aim_context action=clear
```

注意：第 3 步写入的知识默认是**未确认的模型自述**。到面板知识库页，确认无误后点「确认这条」，它才会变成已确认事实。

---

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

## 面板导览

侧栏「AI 记忆」打开面板。

### 顶部

- **查看范围**：本对话 / 指定对话 / 全部对话 / 共享层；
- 指定对话时，出现“工作区 → 对话”两级下拉；
- **记忆目录**：切换已登记的根目录；
- 刷新、复制路径、在文件管理器中打开；
- 对话设置：名称（最长 80 字符）、是否对其他对话开放、保存。

工作区分组来自 DSH 的会话分桶，不使用对话中途的 `cwd`；Windows 和 POSIX 路径都会被正确识别，不会出现 `\tmp\...` 这种伪路径。

### 六个 tab

| tab | 内容 |
|---|---|
| 过程记录 | 类型、来源、风险、验证状态、时间、正文 |
| 归档 | 按分类分组，可折叠 |
| 快照 | id、大小、时间、状态 JSON |
| 知识库 | 搜索、分类、来源、标签、证据数、黄标、「确认这条」、更新标记、导出 |
| 决策 | 结论、风险、决策、正反理由 |
| 上下文 | id、标签、时间、轮次范围、字符数、摘要和全文 |

知识库里的「确认这条」就是模型自述的转正入口：确认后保留原 `doc_id` 和证据链，只把 `verified` 置为 `true`。

### 外部模型卡

- 常用服务预设；
- 主服务、Embedding、Rerank 三组地址和 Key；
- 超时时间；
- 归档 / 知识库提炼 / 上下文清理三个“本地规则 | 外部模型”开关；
- 「测试连接」会先保存当前表单，再请求服务探测能力。

### 本地模型文件夹

插件目录下有一个 `models/` 文件夹，供你手动放置本地模型说明：

```text
models/
├── Embedding/
│   └── bge-m3/
│       └── model.json
├── Rerank/
│   └── bge-reranker/
│       └── model.json
├── Routing/
│   └── my-router/
│       └── model.json
└── 未来能力/
    └── 某个模型/
        └── model.json
```

每个模型文件夹放一个 `model.json`：

```json
{
  "name": "bge-m3（本地）",
  "baseUrl": "http://127.0.0.1:8080",
  "model": "bge-m3"
}
```

- `Embedding` 和 `Rerank` 是插件当前使用的两类；
- `Routing` 是给后续模型路由预留的分类，目前只显示、不参与调用；
- 以后新增能力时直接新建目录即可，插件会按目录名显示；
- 没有 `model.json` 的文件夹也会显示，但标记为“未配置 API”；
- 面板里点「填入地址」只会填地址和模型名，仍需点「保存设置」。

**重要：插件不加载权重、不在进程内做模型推理。** 推荐用 llama.cpp（llama-server）、Ollama、LM Studio、vLLM 等成熟工具启动模型，再通过 API 接入。模型目录只负责登记和填写这些本地服务的地址；不要把大型权重文件提交到插件仓库。

## 网络同步（Git，默认关闭）

用于多人项目：每台设备是同一份 Git 仓库的工作副本，主机提供 SSH/HTTP remote，其他设备 **上传** 时推送到主机，**拉取** 时从主机取回。

- **默认关闭**：不启用时不会执行任何网络命令；
- 本机角色可设为「主机」或「非主机」；主机地址填 `ssh://user@host/path/memory.git` 或 HTTPS Git 地址；
- 同一局域网设备填同一个「项目组」名称，便于识别；
- 传输层使用已有 SSH/HTTP remote，插件**不启动**未认证的 Git daemon；认证、SSH key、端口由你的 Git 环境管理；
- 同步内容由用户勾选：知识库、归档、决策、快照、过程记录、上下文、全部对话目录；
- 默认只选知识库、归档、决策、快照；
- `contexts/` 包含完整对话，勾选前请确认网络和权限可信；
- `_usage.json`、RAG 索引、`knowledge.sqlite`（含 WAL/SHM）、`compaction_status.json`、导出目录和 `.sync/` 本地设置不会同步；
- **上传** = 提交本地变化 + `git push`；
- **拉取** = `git fetch` + `git merge --ff-only`；
- 上传被拒或拉取不能 fast-forward 时停止并报告，不自动合并、不覆盖本地；
- 主机和普通设备都使用同一个 remote；主机角色只用于组织项目组和操作方向。

Git 仓库建在当前记忆目录根部，本地同步配置放在 `.sync/config.json`，该目录不会进入同步。默认记忆目录位于项目仓库内时，初始化会把该目录加入父仓库的 `.git/info/exclude`（只在本机生效、不提交），避免项目 `git add .` 把它当成 embedded repository；不会改写项目的 `.gitignore`。

### 设置

常规设置保存后会自动重载插件并刷新面板，不需要手动重载。如果重载较慢，会显示“仍在自动重载，稍后会刷新”。网络同步设置只写入当前记忆目录的 `.sync/config.json`，保存后立即生效，不需要重载插件。

---

## 自动行为

### 自动整理

`autoEnabled` 默认**关闭**。打开后，每个 `turn/end` 检查轮次，每次模型请求前检查一次上下文占用：

- 每 `autoEveryRounds` 轮（默认 5）触发；或
- 上下文占用达到 `contextUsagePercent`（默认 70%）触发。

两个条件任一满足，本轮只整理一次：

1. 生成轮次摘要，写入过程记录；
2. 执行归档；
3. 如果 `autoKnowledge !== false`，顺带提炼知识。

**上下文超过 `contextUsagePercent` 时走硬重置**：

- 在下一次模型请求前，把已完成的轮次全部存档并清出，只重新载入一条任务续接信息（当前请求 + 最近进展）；
- 当轮仍在进行时不会被清；工具调用/结果对不会拆开；
- 如果这一轮已经结束、没有下一次模型请求，则在 `turn/end` 直接全部清出，不再载入旧内容；
- 硬重置不受 `minClearChars`、`maxClearTurns` 的裁剪限制，避免 60%+ 的窗口只清掉一小段；
- 手动 `clear` 仍按话题相似度选择，不会强制全清。

`topicalClear=false` 时，手动/每轮触发先保存上下文，再走 DSH 原生压缩；上下文占用阈值仍走全量重置。

上下文占用超过阈值时不再按相似度筛选：已完成轮次全部存档并清出，下一次模型请求前只回载当前请求和最近进展；如果这一轮已经结束，则在轮末直接全部清出。按轮次触发仍遵守话题和字符下限。

### 自动快照

`autoSnapshot` 默认**开启**，与自动整理互相独立。

- 每 `autoSnapshotEvery` 轮（默认 5）保存最近上下文窗口；
- 最多保留 `autoSnapshotMax` 个（默认 10）；
- 超限时优先删除相似的旧自动快照；
- **只剪枝自动快照**，手动快照不会被自动删除。

### 请求锚点

`requestAnchor` 默认开启。它只在最新输入是系统检查点（`Time sampled...`、工具 schema 更新、插件重载提示等）而不是新的用户请求时，追加一条很短的内部提醒，重申上一轮真实用户请求，并要求模型不要回答历史问题或重复上一轮。

它不会在每个正常请求前重复注入，所以不会变成常驻记忆开销；关闭它可以完全移除这段行为。

### 保留策略

- `stagingRetentionDays` 默认 30 天：只删除“整份都已归档”的旧过程记录文件，未归档内容永不因保留策略丢失；
- `contextRetentionDays` 默认 0：不自动删除上下文存档，因为它是 restore 的来源；
- `decisionRetentionDays` 默认 0：不自动删除决策审计。

保留策略**不依赖自动整理开关**：每个对话每天第一次 `turn/end` 时检查一次；即使自动整理关闭，staging 的 30 天清理也会执行。归档操作本身不再重复重建全量去重集合，分类文件的去重集合按文件签名增量维护。

---

## 检索是怎么工作的

### 本地检索

不需要任何外部服务，默认就能用：

- BM25 关键词检索；
- 128 维哈希向量；
- 两者混合。

适合离线、隐私敏感、没有模型服务的项目。

### SQL 通道

问计数、分组、最近 N 条、标签、置信度、最长文档、未确认模型自述、精确 id 时，插件会把 JSON 文档装进一个临时只读 SQLite 库，翻译成单条 `SELECT` / `WITH`。

- 不允许写操作；
- 最多返回 50 行；
- 不需要打开持久 SQLite 镜像；
- 临时库按文档集合缓存，文档没变时复用；
- 临时表和持久镜像使用同一套语义列；
- 跨对话时，同一个 `doc_id` 会保留每个来源各一行：`COUNT(*)` 是副本数，`COUNT(DISTINCT doc_id)` 是不同事实数；
- 只有“最多 / 最少”但没有分类、来源等聚合对象的问题，会走向量，不会硬答一个无关统计。

### RAG

RAG 是知识库上的可选索引，不是默认检索。启用前需要同时配置：

- Embedding 模型；
- Rerank 模型。

打开「RAG 挂载」后，检索会同时跑 RAG 语义通道和本地 BM25 通道，再做排名融合：

- 只在 RAG 索引里被语义去重掉的旧文档，仍由 BM25 通道带回；
- 结果里会标 `RRF=...｜RAG#n｜BM25#m`；
- 先按分类过滤、嵌入召回，再 rerank；
- 重排服务不可用或返回异常时，明确回退本地检索；
- 各通道先按置信度、确认状态和最近使用权重重排，再做纯排名融合，所以打印出来的 RRF 顺序和最终顺序一致。

---

## 知识库细节

### 分类

固定九类：

`project_facts`、`ui_facts`、`errors_fixes`、`decisions_reasoning`、`tools_apis`、`workflow_rules`、`external_sources`、`open_questions`、`incidents`。

旧分类名会自动映射到当前分类。

### 来源和确认状态

- `source`：`user`、`web`、`reasoning`、`staging`、`archive`、`context`、`decision`、`incident`、`unknown`；
- `provenance`：
  - `authored`：显式导入 / 迁移的已确认数据；
  - `user`：从上下文用户原话提炼；
  - `model`：模型写入或提炼的内容，默认未确认；
- `verified`：是否已经过用户确认。

工具写入的知识默认是模型自述；面板点「确认这条」后，`verified` 变为 `true`，正文、`doc_id` 和证据链都不变。即使工具调用时传 `source=user`，它也只是“模型转述用户的话”，不会自动获得 `verified`。

### 冲突与更新

- 相似度很高且数字、URL、开关都没变：合并为同一条，追加证据；
- 相似度很高但数字 / URL / 开关变了：视为更新，先询问；
- 相似但不完全一样：返回冲突，先问用户；
- `promote` 发现值变化时进入待确认队列，不会覆盖已有正文；
- 事故跳过普通事实冲突闸门，但仍按未确认模型自述降权。

### 文档形状

知识是一条 JSON 文件，核心字段包括：

```json
{
  "doc_id": "k_921036f3",
  "text": "DSH 的压缩阈值默认是 0.8",
  "category": "tools_apis",
  "source": "web",
  "tags": ["compaction"],
  "confidence": 0.7,
  "provenance": "authored",
  "verified": true,
  "evidence": [{ "kind": "web", "ref": "web", "at": "..." }],
  "changes": [],
  "created_at": "...",
  "updated_at": "...",
  "revision": 1
}
```

普通使用不需要手改 JSON；它是给你审查和备份用的。

---

## 数据目录

默认：

```text
<workspace>/.ai-for-memory/
├── staging/        # 过程记录
├── archive/        # 分类归档
├── snapshots/      # 快照
├── knowledge/      # 知识库 JSON；可选 SQLite 镜像和 _usage.json
├── decisions/      # 决策审查
├── contexts/       # 上下文存档
├── exports/        # 导出目录（按需创建）
├── sessions/
│   └── s_<hash>/
│       ├── session.json
│       └── staging/ archive/ snapshots/ knowledge/ decisions/ contexts/ rag/
└── rag/            # 共享层 RAG 索引
```

根目录是共享层，`sessions/s_*/` 是每个对话自己的六层。目录名使用 Session id 的稳定哈希，不直接暴露真实 id。

记忆目录可以改：

- `root` 留空：跟随工作区，放在 `.ai-for-memory/`；
- `root` 绝对路径：所有项目共用这个目录；
- 相对路径：相对工作区解析。

用过的根目录会登记到 `$DSH_HOME/ai-for-memory/roots.json`，面板的“记忆地址”下拉从这里读取。

---

## 常用配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `root` | 空 | 记忆目录；空=跟随工作区 |
| `directoryName` | `.ai-for-memory` | 跟随工作区时使用的目录名 |
| `defaultTopK` | 5 | 默认返回条数 |
| `knowledgeBackend` | `json` | `json` 或 `sqlite` |
| `defaultPublic` | `false` | 新对话是否默认对其他对话开放 |
| `reviewHighRiskOnly` | `true` | `true`=只审查 high，medium 直接放行；设为 `false` 才审查 medium |
| `autoEnabled` | `false` | 自动整理总开关 |
| `autoEveryRounds` | 5 | 每几轮自动整理 |
| `contextUsagePercent` | 70 | 上下文占用达到多少百分比触发全量重置 |
| `autoKnowledge` | `true` | 自动整理时顺带提炼知识 |
| `autoKnowledgeLimit` | 10 | 每次自动提炼上限 |
| `autoSnapshot` | `true` | 自动快照 |
| `autoSnapshotEvery` | 5 | 每几轮快照 |
| `autoSnapshotMax` | 10 | 自动快照上限 |
| `topicalClear` | `true` | 按话题相似度清理手动/每轮触发；关掉则用整段压缩（占用阈值仍走全量重置） |
| `similarityThreshold` | 0.05 | 话题相似度阈值 |
| `keepRecentTurns` | 2 | 始终保留最近几轮 |
| `maxClearTurns` | 8 | 单次最多清出轮数 |
| `minClearChars` | 200 | 少于这个字符数不清理 |
| `maxClearChars` | 120000 | 单次清出字符上限 |
| `restoreMaxChars` | 12000 | 单次 restore 最多注入字符数 |
| `stagingRetentionDays` | 30 | 旧过程记录保留天数；只删已归档文件 |
| `contextRetentionDays` | 0 | 上下文存档保留天数；0=不自动删 |
| `requestAnchor` | `true` | 检查点/时间提示到达时，给模型加一条“当前真实请求”提醒，避免答旧题 |
| `decisionRetentionDays` | 0 | 决策记录保留天数；0=不自动删 |
| `ragMount` | false | 是否把 RAG 索引挂到检索 |
| `externalBaseUrl` | 空 | 外部模型主地址 |
| `externalEmbedModel` | 空 | Embedding 模型 |
| `externalRerankModel` | 空 | Rerank 模型 |
| `externalTimeoutMs` | 60000 | 外部请求超时 |

完整配置可以直接编辑插件配置；面板会覆盖最常用的设置。

---

## 隐私与安全

- 记忆默认保存在本地，不需要联网；
- 跨对话默认关闭，需要你在面板里逐个开放；
- 上下文存档包含完整对话，可能包含敏感信息，请务必排除出 Git；
- 外部模型模式会把相关内容发送到你配置的服务；敏感项目优先使用本地 Ollama / LM Studio / llama.cpp；
- API Key 只保存在本机配置里，面板只显示“是否已保存”，不会把密钥回读给浏览器；
- 模型写入的知识默认未确认，不会直接当作项目事实。

---

## 常见问题

**看不到工具或面板？**

确认 bundle 已安装，并重新加载插件；检查面板是否被 DSH 的布局设置隐藏。

**RAG 打不开？**

RAG 需要同时配置 Embedding 模型和 Rerank 模型。只有其中一个时，保存挂载会被拒绝。

**SQL 查询不可用？**

SQL 通道和 SQLite 镜像需要运行时的 `node:sqlite`。Node 20 可以运行本地记忆，但没有这个内置模块；升级到 Node 22.5+ 或使用带 `node:sqlite` 的运行时。

**清空上下文后还能找回吗？**

清理前会先写 `contexts/` 存档，之后用 `aim_context action=restore context_id=...` 调回。恢复默认只注入预算内的最近轮次，完整存档仍在磁盘上。

**为什么知识库里有黄标？**

那是模型自述，尚未确认。确认无误后在面板点「确认这条」即可；不要直接把黄标内容当成项目事实。

**跨对话检索会污染本对话权重吗？**

不会。跨对话命中不写入调用方使用日志，也不套调用方权重；每个文档的权重只属于它所在的 store。

**保存设置后要手动重载吗？**

不需要。保存会自动重载并刷新面板；如果还在重载，会显示提示并稍后自动刷新。

---

## 开发与测试

要求 Node.js 20+。

```bash
npm test
# 等价于
node --test test/core.test.mjs
```

当前测试覆盖六层读写、对话隔离、上下文清理/恢复、知识冲突、模型自述确认、事故记录、SQL 路由、RAG 构建、导出、面板数据组装等。

主要代码：

```text
index.js                  # 插件入口和五个工具
client.js                 # Web 面板
lib/store.js              # 文件存储和六层数据
lib/scopes.js             # 对话隔离、共享层、工作区分组
lib/knowledge.js          # 知识规范化、冲突、提炼候选
lib/retrieval.js          # 本地 BM25 / 向量 / RRF
lib/knowledge-query.js    # SQL 路由和临时只读表
lib/knowledge-sqlite.js   # SQLite 只读镜像
lib/rag.js                # RAG 分片索引
lib/api.js                # 面板 API
lib/context.js            # 上下文保存 / 恢复
lib/decision.js           # 决策审查
lib/external.js           # OpenAI 兼容外部服务
lib/export.js             # 知识库 / SQL / RAG 导出
test/core.test.mjs        # 测试
```

---

## License

MIT。见 [LICENSE](LICENSE)。
