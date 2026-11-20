# 更新记录

本项目从 `0.1.0` 起使用三段式版本号，规则见 [开发与测试](docs/development.md#版本号与发布)。

## 0.1.0（2026-11-20）

### 版本概览

AI for Memory 是面向 DSH 的项目级记忆插件；`0.1.0` 是本插件的第一个正式版。这一版把六层记忆、五个 `aim_*` 工具、Web 面板、对话隔离、可恢复的上下文清理、BM25/SQL/RAG 检索、知识库冲突确认和风险决策审查整合为可安装的 DSH bundle；插件本体零外部依赖，所有记忆默认保存在本地。

### 新增

- **本地 llama.cpp 推理引擎**：读取 `models/Embedding|Rerank/*/model.json`，发现 GGUF，自动启动 `llama-server`，支持 BGE-M3 的 `--embeddings --pooling cls` 和 BGE Reranker v2 m3 的 `--reranking`。
- 面板「模型与检索」增加本地模型启动入口和引擎运行状态；启动后填入地址，保存设置自动生效。
- 上下文占用达到 `contextUsagePercent` 时执行**全量硬重置**：已完成轮次全部存档并清出；下一次模型请求前回载当前请求和最近进展，轮末没有下一次请求时直接全部清出。
- 设置保存后自动重载插件并轮询新状态，不再需要手动重载。

### 修复

- 工作区分桶解码同时支持 Windows 与 POSIX 路径，避免 POSIX 上出现 `\tmp\...` 伪路径和分组碎裂。
- 测试命令改为显式 `node --test test/core.test.mjs`，README 与 `npm test` 一致。
- 面板导航切换后旧按钮焦点框残留；导航与设置分组按钮显式清理非选中边框。
- 面板 API 的本地引擎路由修正 same-origin 检查。

### 六层记忆

- 过程记录、分类归档、快照、知识库、决策、上下文；
- 对话隔离 + 共享层 + 可逐个开放的其他对话；
- JSON 作为底座，SQLite 只读镜像、RAG 索引、导出都从 JSON 派生。

### 工具与面板

- `aim_memory`、`aim_context`、`aim_search`、`aim_decide`、`aim_ask`；
- Web 面板：总览、六层浏览、设置页、模型页、网络同步；
- 知识冲突/更新待确认、模型自述黄标、确认转正；
- 风险决策审查按可逆性放行或拒绝。

### 检索与存储

- 本地 BM25 + 哈希向量 + RRF；
- Text-to-SQL 只读查询通道；
- 可选 RAG：Embedding + Rerank + 分片索引；
- 上下文存档可 `restore`，恢复按预算只注入最近轮次；
- Git 同步默认关闭，传输层复用已有 SSH/HTTP remote。
