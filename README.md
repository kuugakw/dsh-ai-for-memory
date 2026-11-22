# AI for Memory — 面向 DSH 的项目级记忆插件

[![tests](https://github.com/kuugakw/dsh-ai-for-memory/actions/workflows/test.yml/badge.svg)](https://github.com/kuugakw/dsh-ai-for-memory/actions/workflows/test.yml)
[![Status](https://img.shields.io/badge/status-stable%200.4.2-brightgreen.svg)]()
[![Version](https://img.shields.io/badge/version-0.4.2-lightgrey.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **0.4.2 是检索与本地引擎的生命周期修复版。** AI for Memory 是面向 DSH 的项目级记忆插件：六层记忆、六个 `aim_*` 工具、Web 面板、对话隔离、可恢复的上下文清理、BM25/SQL/RAG 检索、知识库冲突确认和风险决策审查整合为可安装的 DSH bundle；插件本体零外部依赖，只使用 Node 内置模块，所有记忆默认保存在本地。本版把倒排索引改为原地增量更新、四个检索缓存统一为 LRU，摘要只保留一份实现；`turn` 模式的引擎停止改为空闲释放，关闭最后一个会话也会触发；端点能力探测先验证真实能力，只配 chat 端点时不再压住本地引擎。
>
> 升级前请备份记忆目录。

**快速入口：** [安装](docs/installation.md) · [功能全览](docs/features.md) · [工具参考](docs/tools.md) · [面板](docs/panel.md) · [本地模型/推理引擎](docs/models.md) · [上下文与自动行为](docs/context.md) · [上下文清理机制](docs/context-clearing.md) · [检索与 RAG](docs/search.md) · [知识库](docs/knowledge.md) · [配置](docs/configuration.md) · [隐私](docs/security.md) · [常见问题](docs/faq.md) · [开发](docs/development.md) · [更新记录](CHANGELOG.md)

---

## 定位

AI for Memory 是面向 DSH 的**项目级记忆插件**。它关注项目工作流中的事实、约定、错误修复、决策和对话上下文，而不是做一个通用的聊天记录收藏夹。

记忆类插件已有不少实现；本项目的重点是把项目记忆放在可审查、可恢复、可迁移的本地数据层上：JSON 是底座，模型写入默认标为未确认，上下文清理前先存档。

---

## 它解决什么问题

用 AI 写代码时，经常会遇到这些情况：

- 上次已经决定过的事，这次又要重新解释；
- 刚修过的错误，过几天又踩一遍；
- 上下文被清理后，之前的讨论和结论找不回来；
- 多个对话各自知道一点，但互相不通气；
- 网页上查到的资料、项目里的约定、模型自己的推测，混在一起分不清。

AI for Memory 把这些信息分开保存、按需取回：

- **对话上下文**：太长的对话可以清掉，但清掉前先完整存档，之后能恢复；
- **项目记忆**：过程记录、归档、快照、知识库、决策和上下文六层；
- **跨对话检索**：默认只读“本对话 + 已开放的其他对话 + 共享层”；
- **知识库**：一条一句、带分类和出处，可以检索、提炼、导出；
- **可选增强**：SQL 查询、RAG 语义检索、外部 Embedding / Rerank 服务，以及从 `models/` 启动本地 [llama.cpp](https://github.com/ggml-org/llama.cpp) 引擎（BGE-M3 / BGE Reranker v2 m3，不下载权重）。

默认是**轻量模式**：本地规则 + 本地检索，不联网、不需要 API Key。RAG、SQL 持久镜像和外部模型默认关闭；自动快照默认开启，自动整理默认关闭。

---

## 一句话理解六层

| 层 | 你可以把它理解成 | 主要用途 |
|---|---|---|
| 过程记录 `staging` | 工作日志 | 刚发生了什么，先一行一条记下来 |
| 分类归档 `archive` | 整理后的档案 | 把过程记录按错误、决策、界面事实等分类 |
| 快照 `snapshots` | 状态存档 | 保存任意状态对象，之后原样恢复 |
| 知识库 `knowledge` | 项目事实卡片 | 一条一句的结论，可检索、可提炼、可导出 |
| 决策 `decisions` | 决策复盘 + 执行记录 | 高风险操作的正反理由、可逆性和结论；每轮的工具调用与本地文件改动也会自动记一条 |
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

详细的数据布局见 [配置与数据目录](docs/configuration.md)。

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

检索时会被降权，面板上会带黄色「模型自述（未确认）」标记。`source` 缺失或拼错时归一为 `unknown`，同样按模型自述处理，不会因为少传一个参数变成已确认事实。显式写 `provenance: user` 也只信任 `context`（用户原话）和 `user-confirmed`（面板确认）两种来源，模型无法自行声明“这是用户事实”。用户确认后才会转成已确认事实。

---

## 快速开始

```text
plugin_manager action=install_bundle target=<dsh-ai-for-memory 目录>
aim_memory action=status
```

安装、`.gitignore` 排除、升级和第一次使用示例见 [安装与首次使用](docs/installation.md)。

---

## 六个工具

| 工具 | 一句话用途 | 详情 |
|---|---|---|
| `aim_memory` | 写过程记录、归档、快照、知识库、决策、事故，导出和状态 | [工具参考](docs/tools.md) |
| `aim_context` | 保存、清理、恢复对话上下文 | [工具参考](docs/tools.md) |
| `aim_search` | 跨对话检索知识、过程记录、决策和上下文 | [工具参考](docs/tools.md) |
| `aim_decide` | 高风险/不可逆操作的正反合审查 | [工具参考](docs/tools.md) |
| `aim_ask` | 连接外部模型，做 chat / embed / rerank / probe | [工具参考](docs/tools.md) |
| `aim_repair` | 体检并修复 DSH 打不开的会话日志（`stored log is corrupt`） | [工具参考](docs/tools.md) |

最小用法见 [安装与首次使用](docs/installation.md#第一次使用)；完整参数和返回格式见 [工具参考](docs/tools.md)。

---

## 面板与本地推理

侧栏「AI 记忆」打开面板，包含总览、六层记忆页、插件设置和模型页。面板会显示当前范围、工作区、对话、记忆目录和最近清理状态；工作区分组来自 DSH 的会话分桶，不使用对话中途的 `cwd`。

本地模型配置放在 `$DSH_HOME/ai-for-memory/models/`（默认 `~/.dsh/ai-for-memory/models/`），插件自带的 `models/` 只是可选扫描源。可以放 BGE-M3 和 BGE Reranker v2 m3 的 GGUF。插件不下载权重，而是按 `model.json` 启动 `llama-server`：

- Embedding：`--embeddings --pooling cls`；
- Rerank：`--reranking`；
- 启动后由既有 OpenAI 兼容客户端调用。

详细步骤见 [模型与本地推理引擎](docs/models.md)，面板说明见 [面板导览](docs/panel.md)。

### 感谢 llama.cpp

本地推理引擎建立在 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` 之上。感谢 **ggml-org** 以及所有 llama.cpp 贡献者：他们让普通机器上的本地 Embedding 和 Rerank 成为可能，也让这个插件可以坚持“不下载模型、不依赖云服务”的选择。

---

## 自动行为与上下文

- **每 N 轮**：自动生成轮次摘要、归档，并按相似度清理；
- **上下文占用超过阈值**：任务进行中就在下一次模型请求前硬重置——按**步骤**清出旧的工具步骤（保留当前请求、当前轮最近 `keepRecentSteps` 步（默认 3）和最近 `keepRecentTurns` 轮），注入续接包（当前请求 + 最近进展 + 相关记忆）后继续同一个任务，不用等到轮末；如果这一轮已经结束，则在轮末走同一条路径；
- **自动快照**：每 N 轮保存最近上下文窗口，超限时优先删除相似的旧自动快照；
- **请求锚点**：只在每轮第一步、系统检查点到达、且本步没有新的真实用户请求时，提醒模型上一轮真实请求；后续工具步骤不注入，已被清出的请求也不会被重新写回；一旦有新请求，锚点不注入。
- **便条与真实输入分开**：插件写入的便条仍是模型可见的 `user/message`，但 `source.kind = ai-for-memory`、`source.form = notice`，并用 `source.summary` 标注；真实用户输入的 `source.kind = user`。

完整规则、保留策略和恢复预算见 [上下文与自动行为](docs/context.md)；触发条件、相似度打分与调参见 [上下文清理机制](docs/context-clearing.md)。恢复按 `restoreMaxChars` 从尾部取最近的轮次/事件段；单个工具结果恢复时最多渲染 8 KiB，超出会标记截断，原始事件仍保留在存档里。

---

## 检索与知识库

- **本地检索**：BM25 + 128 维哈希向量，用排名融合；倒排索引按文档原地增量更新、缓存全部 LRU；默认每条只返回摘要，`detail=full` 才取全文；
- **SQL 通道**：计数、分组、精确 id、最近 N 条等问题走只读 SQL；
- **RAG**：配置 Embedding 和 Rerank 后，可把语义索引挂到检索上，再用 RRF 与 BM25 融合；
- **知识库**：九类、来源、确认状态、冲突/更新闸门、完整 JSON 文档形状。

详见 [检索与 RAG](docs/search.md) 和 [知识库](docs/knowledge.md)。

---

## 数据、配置与安全

默认记忆目录是工作区下的 `.ai-for-memory/`；根目录是共享层，`sessions/s_*/` 是每个对话自己的六层。目录布局、配置表和远端同步见 [配置与数据目录](docs/configuration.md) 与 [网络同步](docs/network.md)。

安全边界、API Key 处理、跨对话开放和 DNS rebinding 防护见 [隐私与安全](docs/security.md)。常见问题见 [FAQ](docs/faq.md)。

**MCP 出口默认开启**，只绑定 DSH 的 loopback 监听器；它是独立于浏览器会话的本地 HTTP 入口，因此默认生成 `$DSH_HOME/ai-for-memory/mcp-token`，所有 MCP 请求都必须带 `Authorization: Bearer`。MCP 的 `aim_remember` 固定写共享层并标记 `source: mcp`，仍按模型自述处理。不需要时请在面板关闭 MCP 开关。

---

## 更新内容

当前版本 **0.4.2**。版本号规则：本地开发和未发布改动不改版本号；只有正式发布到 GitHub 时才更新 `package.json`、README 徽章和 tag/Release。详细发布流程见 [开发与测试](docs/development.md#版本号与发布)。

近期更新：

- **知识冲突日志**：被冲突闸门拦下的写入记入 `knowledge/conflicts.jsonl`（只做审计，不是队列，不参与检索）；`aim_memory status` 报未确认数，面板知识库页显示最近冲突，确认覆盖后自动标记为已确认；
- **自动活动记录保留**：新增 `autoDecisionRetentionDays`（默认 90 天），只清理 `decision_auto_*` 每轮自动记录，`aim_decide` 审查记录仍默认永不自动删除；
- **稳定性**：用户数据写入 fsync；RAG 索引缓存按 manifest 内容识别代际，避免跨实例读到旧索引；
- **本地引擎运行方式**：设置页可选常闭 / 常开 / 每轮开关；自动拉起前先探测已配置的 Embedding/Rerank 端点，能连上就跳过，不重复起进程；`turn` 在轮末不立即杀进程，空闲约 2 分钟后才释放，短轮次不会把加载中的模型记成启动失败；
- **决策层拆分**：每轮工具活动自动记成「常规」，`aim_decide` 的审查保留在「风险」，面板与 `aim_memory status` 分开计数；
- **诊断/用量页**：运行环境、知识命中与权重、对话磁盘占用、批量开放/关闭和面板操作审计集中在一页；
- 知识页支持**分类/来源/确认状态筛选**、**时间/置信度/命中次数/权重排序**、**批量确认**与**撤销确认**；
- 知识、上下文和快照条目可直接**打开 JSON / 下载全文**；context 可**导出 Markdown**，快照可**恢复/并排对比**；
- **会话日志体检与修复**：总览默认只做快速头部扫描，深度体检需显式点击（异步 zstd、mtime+size 缓存）；诊断页可扫描/修复/重排 DSH 的 `session.v4.jsonl.zstd`，并显示校验器来源和降级原因；
- 总览补齐六层卡片，并显示 tokenMeter 的**实时上下文占用**（阈值单独保留）；
- **MCP 出口**：本机 MCP 客户端可列出记忆根并调用现有 `aim_*` 工具；
- 上下文占用达到阈值时的**全量硬重置**与任务续接；
- 本地 **llama.cpp 推理引擎**：自动发现 GGUF、由用户在面板显式启动/停止 `llama-server`，支持 BGE-M3 与 BGE Reranker v2 m3；启动失败时面板显示 stderr 尾部、实际命令和针对性修复提示；启动前会把 PID/端口写入用户模型目录的 `.engine.lock/<模型>.json`（一个模型一个文件，并发启动不会覆盖彼此的锁记录），插件重启后自动探测并接管还活着的引擎，不再重复拉起第二份；**插件关闭/重载不会停掉模型**，只有 DSH 正常退出时才停；模型存在但没开启时，打开面板会弹一次提醒；
- 设置保存后**自动重载并刷新**，不需要手动重载；
- 工作区分桶在 Windows / POSIX 上的跨平台解码修复；
- 外部模型地址默认留空、探活超时 5 秒，未配置时不再连接本地 8080；
- 网络同步支持 `git@host:path` 式 remote，常见端口并发探测；
- `.gitignore` 缺失或记忆目录未忽略时，状态和面板明确警告；
- 面板导航焦点框、布局和若干稳定性修复。

完整版本记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 开发与测试

要求 Node.js 20+。会话日志体检/修复依赖 Node 的 zstd，需要 Node 22.15+；在 Node 20 上插件其余功能正常，诊断页会明确标记这一项不可用，而不是等用户点下去才报错。

测试共 164 项；Node 20 上 13 项依赖 `node:sqlite`、zstd 或 git 的用例按运行时能力跳过（151 pass / 13 skip），另有 1 项模拟慢加载的引擎用例只在 POSIX 上运行（Windows 上 150 pass / 14 skip）。Node 22.15+ 全量通过（Windows 上 163 pass / 1 skip）。CI 覆盖 Linux / Windows / macOS × Node 20 / 22。“全绿”指没有失败，不等于每个平台都跑满 164 项。

```bash
npm test
# 等价于
node --test test/core.test.mjs
```

代码结构、测试覆盖和发布流程见 [开发与测试](docs/development.md)。

---

## 致谢

- [llama.cpp](https://github.com/ggml-org/llama.cpp) / ggml-org：本地 Embedding 与 Rerank 推理；
- DSH（DeepSeek Harness）与 Cordis：插件运行时、工具和面板 API；
- 所有提交 bug、测试和文档建议的使用者。

本地模型权重由使用者自行提供，本项目不下载、不再分发模型。

---

## License

MIT。见 [LICENSE](LICENSE)。
