# 知识库

> 返回 [主 README](../README.md)。

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
