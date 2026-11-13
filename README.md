# AI for Memory — DSH 插件

[![Version](https://img.shields.io/badge/version-0.4.0-blue.svg)](package.json)
[![Status](https://img.shields.io/badge/status-early%20preview-orange.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **这是初版（当前 v0.4.0）。** 核心功能已可用、已实测，但仍在早期阶段；接口、存储格式和界面后续都可能
> 继续调整与优化（见 [路线图](#路线图)）。欢迎试用和提建议，不建议直接用于关键生产数据。

把一套分层记忆思路做成 DeepSeek Harness 的**项目级记忆插件**：流水、归档、快照、本地检索、
风险审查决策，外加一个 **Web 面板**用来浏览记忆文件。

纯 Node 实现（只依赖 Node 内置模块），不联网、不依赖 embedding 服务；数据落在你指定的目录，
跨会话、清空上下文后仍然可读。

## 提供的工具

| 工具 | 用途 |
|------|------|
| `aim_memory` | `stage` 追加流水 / `archive` 分类归档 / `snapshot` 保存状态 / `restore` 恢复 / `list` 列快照 / `remember` 写知识 / `status` 查看各层统计 |
| `aim_search` | 检索知识文档（BM25 + 本地哈希向量，`bm25` / `vector` / `hybrid`） |
| `aim_decide` | 正反合审查：`approved` / `rejected` / `needs_more_info`，返回可审计权重 |
| `aim_context` | 上下文管理：`save` 存档当前对话 / `clear` 存档并压缩清理 / `restore` 调回存档 / `list` 列存档 / `status` 查看压缩服务状态 |

典型用法：

```text
aim_memory  action=stage  content="设置页有三个选项卡" kind=screenshot
aim_memory  action=stage  content="保存超时，重试后成功" kind=error risk=medium
aim_memory  action=archive
aim_memory  action=snapshot name=before-cleanup state={"step":"清理临时文件"}
aim_memory  action=remember doc_id=err_timeout text="超时先重试三次，仍失败则通知用户" category=errors_fixes
aim_search  query="超时怎么处理" mode=hybrid
aim_decide  decision="删除全部临时文件" risk=high thesis="释放空间" antithesis="可能丢失未归档流水"
```

## 使用方式：手动工具 + 自动整理（共存）

**手动工具始终可用，和自动整理的开关无关。** 自动整理只是额外的自动整理层；开启或关闭它都不会禁用
`aim_memory` / `aim_search` / `aim_decide` / `aim_context`。

### 手动工具（始终可用）

在对话框里直接让 agent 调用：

```text
把当前对话整理进上下文存储       → aim_context save
把当前上下文压缩清理掉           → aim_context clear
把 context_xxx 的上下文调回来    → aim_context restore
把这次决策记进项目记忆           → aim_memory / aim_decide
查一下之前关于超时的记录         → aim_search
```

`aim_context clear` 会先保存完整上下文，再交给 DSH 的 `compaction` 服务压缩当前会话；
压缩必须等本轮结束、agent 空闲时执行，因此它是**本轮结束后生效**。

### 自动整理（可开关）

面板「使用与存储设置」里把「自动整理」切到 **开**，设置 **每 N 轮自动整理**：

- 每 N 个对话轮结束后，自动把当前对话归档成一条 `context` 记录，同时写 `digest` 流水并归档；
- 然后调用 `compaction.compactNow()` 压缩/清理会话上下文，给后续对话腾出窗口；
- 自动整理开启时，手动工具**仍然可用**；关闭自动整理也不会影响任何手动工具；
- 需要旧信息时，用 `aim_context restore <id>` 把归档上下文重新注入；
- 子会话（subagent）不会触发自动整理，但子会话里的手动 `clear` 仍会生效；
- 计数是内存态：插件重载 / 进程重启后从 0 开始计。

> **依赖**：清理上下文依赖 DSH 的 `compaction` 服务。本插件会检测它；如果没有启用
> `@deepseek-ai/dsh-compaction-basic`，`clear` 会保存上下文但跳过压缩，并在 `aim_context status` 里显示“不可用”。
> 自动整理的摘要是本地文本压缩（截断 + 拼接），不是模型生成的摘要。

## Web 面板

安装后在 Web 界面左侧栏会出现「AI 记忆」图标，点开是记忆浏览面板：

- **记忆目录选择**：列出所有写过的项目记忆目录（来自全局登记表），可切换查看。
- **路径操作**：显示当前目录、一键复制、在系统文件管理器中打开。
- **六层视图**：流水 / 归档 / 快照 / 知识 / 决策 / 上下文，各自的统计和最近条目。
- **知识检索**：面板内按 id / 正文 / 分类过滤。
- **使用与存储设置**：自动整理开关、每 N 轮自动整理、记忆地址、目录名，保存后插件自动重载；手动工具不受开关影响。

> 面板数据通过 Host 的只读 HTTP API（`/ai-for-memory/api/state`）读取；只允许访问
> 插件登记过的记忆目录，不会变成任意文件读取器。写操作要求同源 + 回环来源。

## 存储位置

默认每个项目各自保存在工作区下的 `.ai-for-memory/`；在面板「存储设置」里填一个
**绝对路径**（例如 `D:\ai\工作区\ai-for-memory-data`）即可让所有项目共用一个固定目录，
方便直接用文件管理器查看。修改配置后插件会自动重载。

目录结构：

```text
<记忆地址>/
├── staging/staging_<hour>.jsonl     # 第一层：按小时滚动的流水
├── archive/<category>.jsonl         # 第二层：幂等分类归档（含 START_MARKER 审计行）
├── snapshots/<name>_<ts>.json       # 第三层：精确状态快照
├── knowledge/<doc_id>.json          # 知识文档（检索来源）
├── decisions/<decision_id>.json     # 审查记录
└── contexts/<context_id>.json       # 上下文存档（清理前保存，可恢复）
```

所有记忆根目录登记在 `$DSH_HOME/ai-for-memory/roots.json`，面板据此列出可查看的项目。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `ai-for-memory` 行，或用面板的存储设置：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `directoryName` | `.ai-for-memory` | 工作区下的记忆目录名（`root` 为空时生效） |
| `root` | `""` | 固定记忆目录（绝对路径）；非空时所有项目共用 |
| `autoEnabled` | `false` | 自动整理开关；手动工具始终可用 |
| `autoEveryRounds` | `5` | 自动整理每 N 轮触发一次（1~100） |
| `maxContextChars` | `30000` | 单份上下文存档的最大字符数（1000~200000） |
| `defaultTopK` | `5` | 检索默认返回条数 |
| `reviewHighRiskOnly` | `true` | `true` 时中风险决策直接放行，只审查高风险 |
| `maxContentChars` | `20000` | 单条流水/知识正文上限 |
| `maxSnapshotBytes` | `262144` | 单份快照序列化上限 |

## 设计要点

- **零依赖**：不 import `@deepseek-ai/*`，避免插件管理器做 peer 版本校验时装不上；
  工具定义用普通对象，参数表由插件自己编译成 JSON Schema。
- **工作区按调用解析**：优先 `workingDirectory` 服务（跟随 `cd`），回退 `session.header.cwd`。
- **崩溃安全**：流水一行一条 JSON；如果上次崩溃留下没有换行符的半行，追加前会先补换行，
  读取时跳过坏行；序号按物理行计数，`dedup_id` 不会复用。
- **幂等归档**：归档前检查目标分类的 `dedup_id`，重复执行只补缺失条目。
- **快照脱敏**：快照名会转成安全文件名，同一秒同名自动加序号。
- **检索是词袋**：BM25 + 128 维 hashing 向量，不是语义 embedding；同义改写可能检索不到。
- **决策权重看理由长度**：只适合做示意/审计，正式场景应换成模型给出的结构化置信度。
- **上下文清理走 compaction**：归档后调用 DSH 的 `compaction.compactNow()`，只在 agent 空闲
  （本轮结束）时执行；没有 compaction 实现时保存照常、清理跳过。
- **恢复用注入而不是改历史**：`aim_context restore` 通过 `agent.inject()` 把存档作为下一条
  用户态上下文注入，不篡改已有会话事件。

## 安装

```bash
git clone https://github.com/kuugakw/dsh-ai-for-memory.git
```

然后在 DSH 里用插件管理器安装这个目录的**绝对路径**：

```text
plugin_manager action=install_bundle target=<克隆下来的 dsh-ai-for-memory 目录>
```

安装后四个工具（`aim_memory` / `aim_search` / `aim_decide` / `aim_context`）出现在工具列表里，
侧栏出现「AI 记忆」面板；插件管理器条目会显示标题「AI 记忆」。

> 要启用真正的上下文清理，还需要在同一个 profile 里启用 DSH 自带的
> `@deepseek-ai/dsh-compaction-basic`（提供 `compaction` 服务）。
> 用插件管理器把 `include:compaction-basic` 设为启用即可。

## 开发与测试

```bash
cd dsh-ai-for-memory
node --test test/
```

测试覆盖：流水去重、归档幂等与路由、半行修复、快照脱敏/恢复、三种检索模式、
决策三种结果、工具注册与端到端执行、面板数据组装、记忆根目录登记与解析、
上下文轮次归档、自动整理触发、上下文保存/列表/恢复。

## 路线图

v0.3.0 仍是**初版**，以下方向会继续优化：

- [ ] 面板内直接编辑 / 删除 / 归档单条记忆
- [ ] 自动整理支持按 token 压力而不是固定轮数触发
- [ ] 上下文存档支持增量与去重，避免重复保存
- [ ] 接入真实 embedding（本地小模型），替换 hashing 词袋向量
- [ ] 检索索引缓存，避免每次全量重建
- [ ] 单写者文件锁 / 更明确的并发语义
- [ ] 决策权重接入模型结构化置信度
- [ ] 面板虚拟滚动与大数据量分页
- [ ] 补齐英文文档与更完整的错误提示

## 已知限制

- 清理上下文依赖 `compaction` 服务，且只能在本轮结束、agent 空闲时执行；
  没有启用 `compaction-basic` 时 `clear` 只保存不清理。
- 恢复的上下文通过注入进入**下一步**；不会重写已发生的历史。
- 单写者：同一工作区不要用多个进程同时写。
- 面板目前是只读浏览 + 设置，尚不支持在面板里删改条目。
- 检索每次调用重建索引；记忆规模很大时应加缓存（当前面向个人项目的小数据量）。
- 没有文件锁/事务；崩溃保证的是"不毁掉已有行"，不是 WAL。
- 初版接口可能调整；升级前建议备份记忆目录。

## License

MIT，见 [LICENSE](LICENSE)。
