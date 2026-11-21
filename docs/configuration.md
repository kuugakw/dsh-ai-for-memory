# 配置与数据目录

> 返回 [主 README](../README.md)。

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
| `keepRecentSteps` | 3 | 硬重置时保留当前轮最近几个工具步骤 |
| `maxClearTurns` | 8 | 单次最多清出轮数 |
| `minClearChars` | 200 | 少于这个字符数不清理 |
| `maxClearChars` | 120000 | 单次清出字符上限 |
| `restoreMaxChars` | 12000 | 单次 restore 最多注入字符数 |
| `stagingRetentionDays` | 30 | 旧过程记录保留天数；只删已归档文件 |
| `contextRetentionDays` | 0 | 上下文存档保留天数；0=不自动删 |
| `requestAnchor` | `true` | 检查点到达且本步没有新用户请求时，加一条“上一轮请求参考”；有新请求则不注入 |
| `mcpEnabled` | `true` | 是否启用 `/ai-for-memory/mcp` MCP 出口（仍受回环 Host 校验） |
| `mcpToken` | 空 | 可选的 MCP Bearer 令牌；空=只靠回环地址保护，面板不回显明文 |
| `decisionRetentionDays` | 0 | 决策记录保留天数；0=不自动删 |
| `ragMount` | false | 是否把 RAG 索引挂到检索 |
| `externalBaseUrl` | 空 | 外部模型主地址；空=未配置，不发起探活或请求。示例见面板 placeholder |
| `externalEmbedModel` | 空 | Embedding 模型 |
| `externalRerankModel` | 空 | Rerank 模型 |
| `externalTimeoutMs` | 60000 | 真实外部请求超时；探活固定上限 5000ms |

完整配置可以直接编辑插件配置；面板会覆盖最常用的设置。

---
