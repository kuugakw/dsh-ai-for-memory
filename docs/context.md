# 上下文与自动行为

> 返回 [主 README](../README.md)。

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
- 清出后的便条仍是模型可见的 `user/message`，但带上 `source.kind = ai-for-memory`、`source.form = notice` 和 `source.summary`；真实用户输入的 `source.kind = user`，据此可区分两者；
- 手动 `clear` 仍按话题相似度选择，不会强制全清。

`topicalClear=false` 时，手动/每轮触发先保存上下文，再走 DSH 原生压缩；上下文占用阈值仍走全量重置。

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
