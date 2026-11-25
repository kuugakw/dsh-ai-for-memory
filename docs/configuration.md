# 配置与数据目录

> 返回 [主 README](../README.md)。

## 数据目录

默认：

```text
<workspace>/.ai-for-memory/
├── schema.json     # 数据版本与迁移记录
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

### 并发写入

同一份记忆目录可能同时被 DSH 宿主、Web 面板的 API 进程和 MCP 客户端写。原子写（临时文件 + rename）只保证单个文件不会写坏，不保证两次读改写不互相覆盖；所以所有**读改写**的共享文件都加了跨进程锁：

- 锁是数据文件旁的 `<file>.lock/` 目录（`mkdir` 原子创建，目录里的 `owner.json` 记录 pid/主机/时间），进程结束即删；
- 写者发现锁超过 10 秒没更新，会认定持有者已崩溃并接管（`staleMs`）；如果锁的 owner 记录里是同一台机器上已经不存在的 pid，则立即接管；如果锁目录里根本没有 owner 记录（崩溃发生在「建目录」和「写 owner」之间）且已存在超过 1 秒，也会被接管；等待超过 5 秒仍未拿到锁会抛错，而不是静默写入（`timeoutMs`）；释放前会校验 owner 的 nonce/pid/host，锁被接管后旧持有者不会删掉新锁；
- **记忆目录不支持跨机器共享**：锁的存活判断依赖同机 pid 和本机时钟，跨机器（NFS/SMB 同时挂载）时活锁只能等 `staleMs` 超时，而调用方通常先超时。需要多机访问时请每台机器各自用自己的记忆目录（或用 Git 同步，但别同时写）；
- 覆盖范围：知识用量权重 `_usage.json`、待确认/待提炼队列、提炼账本、`roots.json`、`session.json`、以及带 fsync 的 JSONL 追加；`staging` 这类高频日志仍走无锁追加（单行 O_APPEND，读侧容忍半行）。
- **同步锁与异步锁**：宿主钩子（`ensureSession`/`setTitle`）和迁移、登记表用同步锁；检索热路径（`recordKnowledgeUsage`）和面板写（`session.json` 的 `touchAsync`/`setPublic`/`setViewers`）改用异步锁，等待时不再用 `Atomics.wait` 卡住事件循环。异步锁对同步回调会在释放后才返回，避免「同进程异步持有 + 同步等待」的互等。
- **未加锁的部分**：RAG 索引重建不做整段锁——它要调外部 Embedding 服务，锁可能被持有几分钟；分片和 manifest 都是原子替换，并发重建以最后一次为准。SQLite 镜像由 SQLite 自己加锁。

### 格式版本与迁移

每个记忆根都有一个 `schema.json`（`{"schema_version": 2, "updated_at": "…"}`），记录这份数据是按哪一版布局写的。规则：

- **老数据自动迁移**：插件启动时读 `schema.json`，比当前版本旧就按 `lib/migrate.js` 里的 `MIGRATIONS` 顺序执行迁移；每一步只跑一次，整条链成功后才把版本号写回，链断了（缺某一步）会直接报错而不是跳过。v1→v2 是「把 0.5.7 之前落盘的旧数据全库脱敏」，逐文件备份、幂等，并遵守 `redactSecrets` 开关。
- **迁移前自动备份**：每一步声明它要改写的文件，迁移开始前先把这些文件复制到 `backups/schema-v<旧版本>-<时间戳>/`（保留相对路径）。迁移中途失败可以按备份还原，不需要你提前手工备份。
- **新数据拒绝降级**：`schema.json` 的版本比当前插件新时（例如从 0.6 回到 0.5），初始化直接报「数据由更新版本的插件写入」，宁可打不开也不按旧规则改写。
- **没有 `schema.json` 的旧目录**：视为 v1（已知最早布局）并跑完整条迁移链，而不是当成最新版——迁移是幂等的，跳过才可能留下旧布局。
- **加新迁移**：在 `lib/migrate.js` 的 `MIGRATIONS` 里追加 `{ from, to, description, files(store), run(store) }`，把 `SCHEMA_VERSION` 加一，并补一个用 v1 fixture 跑通迁移的测试（参考 `test/core.test.mjs` 的 migration 用例）。


---

## 常用配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `root` | 空 | 记忆目录；空=跟随工作区 |
| `directoryName` | `.ai-for-memory` | 跟随工作区时使用的目录名 |
| `defaultTopK` | 5 | 默认返回条数 |
| `knowledgeBackend` | `json` | `json` 或 `sqlite` |
| `redactSecrets` | `true` | 写入前脱敏（`sk-…`/`ghp_…`/`password=…` 等）；确实要记录配置行时可关 |
| `defaultPublic` | `false` | 新对话是否默认对其他对话开放 |
| `reviewHighRiskOnly` | `true` | `true`=只审查 high，medium 直接放行；设为 `false` 才审查 medium |
| `autoEnabled` | `true` | 自动整理总开关 |
| `autoEveryRounds` | 5 | 每几轮自动整理 |
| `engineLifecycle` | `manual` | 本地引擎运行方式：`manual` 常闭（面板手动启停）、`always` 常开、`turn` 每轮开始启动、空闲约 2 分钟后释放由该模式启动的实例 |
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
| `mcpEnabled` | `false` | 是否启用 `/ai-for-memory/mcp` MCP 出口（默认关闭；开启后才生成 `mcp-token`，且仍受回环 Host 校验） |
| `mcpToken` | 空 | 可选的 MCP Bearer 令牌；空=用开启时自动生成的 token 文件，面板不回显明文 |
| `decisionRetentionDays` | 0 | 决策记录保留天数；0=不自动删 |
| `autoDecisionRetentionDays` | 30 | 每轮自动活动记录（`decision_auto_*`）保留天数；只删这类记录，0=只看数量上限；`aim_decide` 审查记录不受它影响 |
| `autoDecisionLog` | `true` | 每轮把工具调用和本地文件改动自动记入决策层（outcome=observed，不进知识库） |
| `ragMount` | false | 是否把 RAG 索引挂到检索 |
| `externalBaseUrl` | 空 | 外部模型主地址；空=未配置，不发起探活或请求。示例见面板 placeholder |
| `externalEmbedModel` | 空 | Embedding 模型 |
| `externalRerankModel` | 空 | Rerank 模型 |
| `externalTimeoutMs` | 60000 | 真实外部请求超时；探活固定上限 5000ms |

完整配置可以直接编辑插件配置；面板会覆盖最常用的设置。

---
