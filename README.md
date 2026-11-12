# AI for Memory — DSH 插件

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](package.json)
[![Status](https://img.shields.io/badge/status-early%20preview-orange.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **这是初版（当前 v0.2.0）。** 核心功能已可用、已实测，但仍在早期阶段；接口、存储格式和界面后续都可能
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

## 使用模式（手动挡 / 自动挡）

### 手动挡（默认）

在对话框里让 agent 调用 `aim_*` 工具触发，例如：

```text
把这次决策记进项目记忆
帮我查一下之前关于超时的记录
```

agent 会调用 `aim_memory` / `aim_search` / `aim_decide` 读写记忆。

### 自动挡

在面板「使用与存储设置」里切到「自动挡」，设置 **每 N 轮触发**：

- 每 N 个对话轮结束后，自动把最近 N 轮的「用户提问 + 助手回答」压缩成一条
  `digest` 记录写入流水，并立即归档；
- 不需要手动提醒，也不需要模型额外调用工具；
- 子会话（subagent）不会触发，避免同一段记忆写两遍；
- 计数是内存态：插件重载 / 进程重启后从 0 开始计。

> 自动挡的摘要是**本地文本压缩**（截断 + 拼接），不是模型生成的摘要；后续路线图会加入更聪明的版本。

## Web 面板

安装后在 Web 界面左侧栏会出现「AI 记忆」图标，点开是记忆浏览面板：

- **记忆目录选择**：列出所有写过的项目记忆目录（来自全局登记表），可切换查看。
- **路径操作**：显示当前目录、一键复制、在系统文件管理器中打开。
- **五层视图**：流水 / 归档 / 快照 / 知识 / 决策，各自的统计和最近条目。
- **知识检索**：面板内按 id / 正文 / 分类过滤。
- **存储设置**：可以直接在面板里设置「记忆地址」（绝对路径）与「目录名」并保存。

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
└── decisions/<decision_id>.json     # 审查记录
```

所有记忆根目录登记在 `$DSH_HOME/ai-for-memory/roots.json`，面板据此列出可查看的项目。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `ai-for-memory` 行，或用面板的存储设置：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `directoryName` | `.ai-for-memory` | 工作区下的记忆目录名（`root` 为空时生效） |
| `root` | `""` | 固定记忆目录（绝对路径）；非空时所有项目共用 |
| `usageMode` | `"manual"` | `manual` 手动挡 / `auto` 自动挡 |
| `autoEveryRounds` | `5` | 自动挡每 N 轮触发一次（1~100） |
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

## 安装

```bash
git clone https://github.com/kuugakw/dsh-ai-for-memory.git
```

然后在 DSH 里用插件管理器安装这个目录的**绝对路径**：

```text
plugin_manager action=install_bundle target=<克隆下来的 dsh-ai-for-memory 目录>
```

安装后三个工具（`aim_memory` / `aim_search` / `aim_decide`）出现在工具列表里，
侧栏出现「AI 记忆」面板；插件管理器条目会显示标题「AI 记忆」。

## 开发与测试

```bash
cd dsh-ai-for-memory
node --test test/
```

测试覆盖：流水去重、归档幂等与路由、半行修复、快照脱敏/恢复、三种检索模式、
决策三种结果、工具注册与端到端执行、面板数据组装、记忆根目录登记与解析。

## 路线图

v0.1.0 是**初版**，以下方向会继续优化：

- [ ] 面板内直接编辑 / 删除 / 归档单条记忆
- [ ] 接入真实 embedding（本地小模型），替换 hashing 词袋向量
- [ ] 检索索引缓存，避免每次全量重建
- [ ] 单写者文件锁 / 更明确的并发语义
- [ ] 决策权重接入模型结构化置信度
- [ ] 面板虚拟滚动与大数据量分页
- [ ] 补齐英文文档与更完整的错误提示

## 已知限制

- 单写者：同一工作区不要用多个进程同时写。
- 面板目前是只读浏览 + 存储设置，尚不支持在面板里删改条目。
- 检索每次调用重建索引；记忆规模很大时应加缓存（当前面向个人项目的小数据量）。
- 没有文件锁/事务；崩溃保证的是"不毁掉已有行"，不是 WAL。
- 初版接口可能调整；升级前建议备份记忆目录。

## License

MIT，见 [LICENSE](LICENSE)。
