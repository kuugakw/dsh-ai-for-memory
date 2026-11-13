# AI for Memory — DSH 插件

[![Status](https://img.shields.io/badge/status-test%20build%200.1-orange.svg)]()
[![Version](https://img.shields.io/badge/version-0.1-lightgrey.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **这是测试版 0.1，不是正式版。** 核心链路已实测可用，但接口、存储格式、面板布局都还会改。
> 测试期间统一标 **0.1**，不按功能拆分版本号；正式发布后再启用语义化版本号。
> 不建议直接用于关键生产数据；升级前请备份记忆目录。

一个给 **DeepSeek Harness** 用的**项目级分层记忆插件**，同时解决两个层面的问题：

1. **上下文层面**——把对话整理进存储、压缩清理当前上下文、需要时再调回来；
2. **记忆层面**——把工作过程、决策、错误、界面事实沉淀成可检索、可恢复的本地数据。

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
| 上下文 | 自己维护 token 预算、淘汰旧内容 | 直接对接 DSH `compaction` 服务做真正的会话压缩 |
| 恢复 | 快照恢复为 Python 对象 | 快照/上下文恢复为注入会话的消息 |
| 界面 | 无 | 侧栏面板：六层浏览 + 设置 |

所以它不是"又一个笔记工具"：**原版管的是"上下文有上界、记忆无上界"，本插件把这条主线
在 DSH 里真正实现了一遍**——包括压缩会话、把它存下来、以后调回去。

---

## 它解决什么问题

| 问题 | 本插件的做法 |
|---|---|
| **上下文会爆**：多步任务、长对话迅速占满窗口 | 归档当前对话 → 调用 `compaction` 压缩清理 → 需要时 `restore` 调回 |
| **一清上下文就失忆**：全清重建成本高且容易丢状态 | 清理前先存 `contexts/`，恢复时作为消息注入，不靠语义检索碰运气 |
| **记忆无处安放**：重要决策、错误、界面事实散落在聊天里 | 过程记录 + 分类归档 + 知识库检索，全部落文件系统 |
| **单模型决策风险**：不可逆操作容易翻车 | 正反合审查，高风险必须给出正反理由，权重可审计 |
| **知识检索不准**：所有东西塞一个索引互相干扰 | 只检索知识文档，支持按分类过滤；过程记录不进检索索引 |

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
| `remember` | 写入/覆盖知识文档 | `doc_id` `text` `category` |
| `status` | 各层统计 | — |

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
aim_memory action=archive
aim_memory action=snapshot name=before-cleanup state={"step":"清理临时文件"}
aim_memory action=restore snapshot_id=before-cleanup
aim_memory action=remember doc_id=err_timeout text="超时先重试三次，仍失败则通知用户" category=errors_fixes
aim_memory action=status
```

### `aim_search` — 本地知识检索

| 参数 | 说明 |
|---|---|
| `query`（必填） | 检索词或自然语言问题 |
| `category` | 只检索某个知识分类 |
| `mode` | `bm25` / `vector` / `hybrid`（默认） |
| `top_k` | 返回条数，1–50，默认取配置 |

- `bm25`：关键词匹配（k1=1.5，b=0.75）
- `vector`：128 维哈希词袋向量 + 余弦相似度
- `hybrid`：`0.6 × 归一化 BM25 + 0.4 × 余弦`

> 这是**词袋向量，不是语义 embedding**：同义改写可能检索不到。

```text
aim_search query="超时怎么处理" mode=hybrid
aim_search query="设置页" category=ui_facts top_k=3
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
| `save` | 把当前对话（含进行中的轮次）整理成存档 |
| `clear` | 存档，然后在本轮结束后压缩清理会话上下文 |
| `restore` | 把指定存档注入回当前会话（下一步生效） |
| `list` | 列出所有上下文存档 |
| `status` | compaction 是否可用、自动整理状态、待压缩标记、最近一次压缩结果 |

```text
aim_context action=save name=before-refactor
aim_context action=clear
aim_context action=list
aim_context action=restore context_id=context_20261113_172815_e4f9
aim_context action=status
```

---

## 手动工具 + 自动整理：共存

这是本插件最重要的使用约定：

- **手动工具始终可用**。自动整理开或关，`aim_memory` / `aim_search` / `aim_decide` / `aim_context` 都在。
- **自动整理只是一个可开关的附加层**：开启后额外每 N 轮自动跑一次整理，不会夺走手动能力。

### 自动整理开启时，每 N 轮会做

1. 把最近 N 轮对话压成一条 `digest` 过程记录；
2. 归档到分类文件；
3. 把完整对话存进 `contexts/`；
4. 本轮结束后调用 `compaction.compactNow()` 压缩清理会话上下文。

其他规则：

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
   │      ├─ 1. 先存档（含进行中的轮次）
   │      ├─ 2. 标记"待压缩"
   │      └─ 3. 本轮 turn/end 后、agent 空闲时：
   │             compaction.compactNow() ───▶ 会话历史被摘要替换（腾出窗口）
   │
   └─（自动整理开启）每 N 轮重复上面两件事

需要旧信息时
   │
   └─ aim_context restore <id>
          └─ agent.inject() ──▶ 存档作为一条上下文消息进入下一步
```

关键点：

- **清理必须等本轮结束**：compaction 要求 agent 空闲，所以 `clear` 是"本轮结束后生效"。
- **恢复是注入，不是改历史**：`restore` 不重写已发生的会话事件，只是把存档作为下一条消息喂给模型。
- **压缩结果会落盘**：`compaction_status.json` 记录 `state`（started / done / error / unavailable）、
  压缩条数、tokens、是否 no-op；`aim_context status` 和面板都能看到。
- **依赖 compaction 服务**：没启用 `@deepseek-ai/dsh-compaction-basic` 时，`clear` 会保存上下文但跳过压缩。

---

## Web 面板

安装后左侧栏出现「AI 记忆」图标（三层堆叠图标），点开是面板：

| 区域 | 功能 |
|---|---|
| 顶部 | 记忆目录下拉（固定目录优先）、刷新 |
| 路径条 | 显示当前目录、**复制**、**打开文件夹**（调系统文件管理器） |
| 统计 | 六个数字：过程记录 / 归档 / 快照 / 知识 / 决策 / 上下文 |
| 页签 | 六层浏览；知识页签带 id / 正文 / 分类过滤；快照可展开看 state |
| 设置 | **自动整理开/关**、每 N 轮、记忆地址、目录名；保存后插件自动重载 |

面板通过 Host 的只读 HTTP API 读数据：

- `GET /ai-for-memory/api/state` — 六层快照
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
├── staging/staging_<YYYYMMDDTHH00>.jsonl   # ① 过程记录（按小时滚动，只追加）
├── archive/<category>.jsonl                # ② 分类归档（含 START_MARKER 审计行）
├── snapshots/<name>_<ts>.json              # ③ 精确状态快照
├── knowledge/<doc_id>.json                 # ④ 知识文档
├── decisions/<decision_id>.json            # ⑤ 决策审查记录
├── contexts/<context_id>.json              # ⑥ 上下文存档
└── compaction_status.json                  # 最近一次压缩结果
```

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

---

## 配置

在 profile 的 `cordis.patch.yml` 覆盖 `ai-for-memory` 行，或用面板的「使用与存储设置」：

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `directoryName` | `.ai-for-memory` | 单段名称 | 工作区下的记忆目录名（`root` 为空时生效） |
| `root` | `""` | 绝对路径或空 | 固定记忆目录；非空时所有项目共用 |
| `autoEnabled` | `false` | 布尔 | 自动整理开关；**手动工具始终可用** |
| `autoEveryRounds` | `5` | 1–100 | 自动整理每 N 轮触发 |
| `maxContextChars` | `30000` | 1000–200000 | 单份上下文存档最大字符数 |
| `defaultTopK` | `5` | ≥1 | 检索默认返回条数 |
| `reviewHighRiskOnly` | `true` | 布尔 | `true` 时中风险直接放行，只审查高风险 |
| `maxContentChars` | `20000` | ≥1 | 单条过程记录 / 知识正文上限 |
| `maxSnapshotBytes` | `262144` | ≥1 | 单份快照序列化上限 |

---

## 设计取舍

- **零依赖**：不 import `@deepseek-ai/*`，避免插件管理器做 peer 版本校验时装不上；
  工具定义用普通对象，参数表由插件自己编译成 JSON Schema。
- **工作区按调用解析**：优先 `workingDirectory` 服务（跟随 `cd`），回退 `session.header.cwd`。
- **崩溃安全**：过程记录一行一条 JSON；若上次崩溃留下没有换行符的半行，追加前先补换行，
  读取时跳过坏行；序号按物理行计数，**`dedup_id` 不会复用**。
- **幂等归档**：归档前检查目标分类的 `dedup_id`，重复执行只补缺失条目。
- **快照脱敏**：快照名转成安全文件名（`../x`、`a/b` 写不出目录），同一秒同名自动加序号。
- **恢复用注入而不是改历史**：不篡改会话事件，只影响后续步骤。
- **压缩走 DSH 原生 compaction**：不自己实现摘要模型，复用 Harness 的压缩后端。
- **检索是词袋**：BM25 + 128 维哈希向量，够用但不语义。
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

**上下文清理需要额外启用 DSH 自带的压缩后端**：

```text
plugin_manager action=set_plugin target=include:compaction-basic enabled=true
```

未启用时插件仍工作，只是 `clear` 只存档不清理，`aim_context status` 会显示「compaction 服务：不可用」。

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
node --test test/          # 16 个测试，无需启动 DSH
```

测试覆盖：过程记录去重与半行修复、归档幂等与路由、快照脱敏/恢复、三种检索模式、
决策三种结果、工具注册与端到端执行、面板数据组装、记忆根目录登记与解析、
上下文轮次归档（含进行中轮次）、自动整理触发、上下文保存/列表/恢复。

插件结构：

```text
dsh-ai-for-memory/
├── index.js            # 插件入口：配置校验、4 个工具、自动整理监听、上下文管理
├── client.js           # Web 面板（侧栏入口 + 主面板）
├── cordis.patch.yml    # bundle 挂载声明
├── package.json
├── icon.svg
├── locale/{en,zh}.json
├── lib/
│   ├── store.js        # 六层文件存储 + 幂等归档 + 快照/上下文
│   ├── util.js         # 去重 id、文件名脱敏、JSONL 安全读写
│   ├── retrieval.js    # 分词、BM25、哈希向量、混合检索
│   ├── decision.js     # 正反合审查与权重
│   ├── auto.js         # 轮次摘要
│   ├── context.js      # 上下文快照与恢复渲染
│   ├── registry.js     # 记忆根目录登记表
│   ├── ui-state.js     # 面板数据组装
│   └── api.js          # 面板 HTTP API
└── test/core.test.mjs
```

---

## 版本策略

- **测试期间**：所有改动统一标 **0.1**，不按功能拆分版本号（避免"测试版却一路涨版本"的误导）。
- **正式发布后**：启用语义化版本号，并在本节之下记录每个版本的变更。
- 升级插件时（`remove_bundle` → `install_bundle`）请先备份记忆目录；本插件的数据格式会随之演进。

---

## 路线图

- [ ] 面板内直接编辑 / 删除 / 归档单条记录
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
- **面板只读**：浏览 + 设置，暂不支持删改单条记录。
- **检索是词袋**：同义改写可能检索不到；规模很大时每次调用都会重建索引。
- **没有事务**：崩溃保证"不毁掉已有行"，不是 WAL。
- **初版接口可能调整**：升级前备份记忆目录。

## License

MIT，见 [LICENSE](LICENSE)。
