# 知识库

> 返回 [主 README](../README.md)。

## 知识库细节

### 分类

固定九类：

`project_facts`、`ui_facts`、`errors_fixes`、`decisions_reasoning`、`tools_apis`、`workflow_rules`、`external_sources`、`open_questions`、`incidents`。

旧分类名会自动映射到当前分类。

### 来源和确认状态

- `source`：`user`、`user-confirmed`、`web`、`reasoning`、`staging`、`archive`、`context`、`decision`、`incident`、`unknown`；
- `provenance`：
  - `authored`：显式导入 / 迁移且来源可追溯的已确认数据；
  - `user`：从上下文用户原话提炼；显式传 `provenance: user` 时也只信任 `source=context` / `user-confirmed`，其余来源（包括 `mcp`、`staging`）一律按 `model` 处理，避免模型自行声明成用户事实；
  - `model`：模型写入或提炼的内容，默认未确认；来源缺失或拼错统一变成 `unknown`，也归入这一档；
- `verified`：是否已经过用户确认。

工具写入的知识默认是模型自述；面板点「确认这条」后，`verified` 变为 `true`，正文、`doc_id` 和证据链都不变，但 `source` 会改为可追溯的 `user-confirmed`、`provenance` 改为 `user`，并写入独立的 `confirmed: true` 字段，否则来源缺失的文档每次读取都会被重新判回未确认，确认按钮看起来像没生效。即使工具调用时传 `source=user`，它也只是“模型转述用户的话”，不会自动获得 `verified`。`confirmed` 是人的明确表态，来源推断只能影响未确认文档的可信度，不能反过来否决它。

### 拆分片段

超过 400 字符的段落会按逗号拆成子句。拆分产生的条目会在 `tags` 里带 `clause`，并从原句第一个逗号前的片段补一个主语前缀（例如「这个网关的超时，必须改成 120 秒」）；前缀只贴给**紧邻且本身没有主语短语**的下一个子句，不会广播给后面换了话题的子句；`confidence` 再降一档，避免无主语的「必须改成 120 秒」被当成独立事实。单个子句达到 400 字符上限时，先按原子句判长度：加前缀会超限就保留原子句，不整条丢弃；原子句仍超限则截断并带 `truncated` 标签/标记。面板会原样显示 `clause` 标签。

### 冲突与更新

- 相似度很高且数字、URL、开关都没变：合并为同一条，追加证据；
- 相似度很高但数字 / URL / 开关变了：视为更新，先询问；
- 开关类变化覆盖开启/关闭、打开/关闭、打开/关掉、保留/删除、内网/公网，以及「是正确的/是错误的」这类完整句式；裸「是/否」不参与匹配（它们会撞上就是、只是、总是、是否等语素）；
- 相似但不完全一样：返回冲突，先问用户；
- `promote` 发现值变化时不入队、不覆盖已有正文：结果里列出待确认项，确认后用 `remember` + `confirm=true` 写入，传旧条目的 `doc_id` 会覆盖该条正文、旧正文记入 `changes`；
- `remember` 传入已有条目的 `doc_id` 表示“要改写这一条”：不带 `confirm` 返回更新确认，带 `confirm=true` 才覆盖正文；
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
