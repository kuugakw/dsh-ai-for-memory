# 记得住，也要管得住：主流 AI 记忆插件对比与 AI for Memory 的定位

> 对比对象是 2025–2026 年主流的「AI 记忆」方案。它们大多解决同一个问题——**让模型记住跨会话的事实**——但切入点不同：有的做知识图谱，有的做向量召回，有的做托管记忆层。本文只比较**设计取向**，不比较模型质量（那取决于使用者的模型和查询）。

## 1. 对比对象

| 方案 | 形态 | 存储 | 部署 | 主要场景 |
|---|---|---|---|---|
| [Anthropic Knowledge Graph Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)（MCP 官方参考实现） | MCP server | 本地 JSONL 知识图谱（实体 / 关系 / 观察） | 单进程，无界面 | 让 Claude 记住用户信息 |
| [Basic Memory](https://www.basicmemory.com/) | MCP 工具 + 本地/云 | Markdown 笔记 + 搜索索引，观察/关系构成图 | 本地或托管，有 Web app | 个人/团队知识库 |
| [mem0](https://docs.mem0.ai/core-concepts/how-it-works) | 记忆层（SDK/云/自托管） | LLM 抽取事实 + 向量 + 可选图 | 需要服务与向量库 | 产品里的跨会话用户记忆 |
| [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | 自托管服务（REST + MCP + OAuth + dashboard） | ChromaDB + 知识图谱 | 常驻 Python 服务 | 多 agent 管线共享记忆 |
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | Claude Code 插件 | 自动捕获 + AI 压缩 + Chroma 索引 | 插件，随 Claude Code 运行 | 编码会话自动记忆 |
| [Graphiti / Zep](https://github.com/getzep/graphiti) | 时序上下文图框架 | 图数据库（双时态、带来源） | 需要图库与 LLM | 生产级 agent 的演化事实 |
| **AI for Memory**（本插件） | DSH bundle | 每对话一个目录：JSON 六层 + 可选 SQLite / RAG 索引 | 本地进程，零外部依赖 | DSH 里的项目工作记忆 |

## 2. 逐维度对比

| 维度 | 大多数竞品 | AI for Memory |
|---|---|---|
| **记忆模型** | 一条事实流（抽取出的「记忆条目」） | 六层生命周期：过程记录 → 归档 → 快照 → 知识库 → 决策 → 上下文；写进来之后还会被归档、提炼、审查 |
| **底座可读性** | 向量库 / 图数据库，用户只能看到召回结果 | JSON 是底座，Markdown 可导出；SQLite 与 RAG 只是派生视图，坏了不反噬 |
| **对话隔离** | 通常是「用户级」隔离（同一用户的所有对话共享），或全局共享 | 每个对话独立目录；默认私有；可**只对指定对话开放**（`viewers` 名单），不开放的不出现在检索、恢复、面板视图里 |
| **上下文治理** | 基本不碰窗口；Claude-Mem 才做压缩注入 | 清理前**先完整存档**，可 `restore` 调回；占用到阈值时在任务**进行中**做硬重置并注入续接包，继续同一个任务 |
| **可信度** | 写入即事实 | 模型写入默认 `provenance=model / verified=false`，检索降权；冲突写入先拦截、要用户确认；保留来源与证据链 |
| **决策与风险** | 无 | `aim_decide` 审查不可逆操作（不可逆直接拒绝），每轮工具活动自动记一条决策；事故单独归档 |
| **运行成本** | 常需 Python / Chroma / 图库 / LLM 抽取 | 插件本体零外部依赖，只用 Node 内置模块；RAG、外部模型、SQL 都是可选项 |
| **客户端** | 跨客户端 MCP（Claude Desktop / Cursor / Codex…） | DSH 一等公民（面板、tokenMeter、自动整理）；也能通过 MCP 出口给别的工具用 |
| **多用户 / 团队** | Basic Memory Teams、mem0 云版支持 | 单机单用户（无多租户） |
| **时序推理** | Graphiti/Zep 有双时态与演化 | 无；只有 JSON 里的时间戳与变更审计 |

## 3. 本插件的特点

1. **项目记忆，不是聊天收藏夹**：关注事实、约定、错误修复、决策和上下文，而不是「用户喜欢什么」。
2. **六层数据各有职责**：过程记录是工作日志，归档是整理后的档案，快照能原样恢复状态，知识库是一条一句的结论，决策层记录正反理由与可逆性，上下文层保存完整对话存档。
3. **对话级权限**：三种开放方式（不开放 / 只对指定对话开放 / 对全部对话开放），授权单向、可多选；关闭会清空名单。
4. **可恢复的上下文清理**：清理 = 存档 + 腾出窗口，不是丢弃；`aim_context restore` 按预算从尾部注入；自动整理默认开启，任务进行中也会硬重置并续接。
5. **可信度分层**：模型自述与用户事实分开，冲突先确认，未确认条目在检索结果里带黄标并降权。
6. **决策审计**：高风险操作先 `aim_decide`，不可逆的拒绝；每轮工具调用自动记一条「常规」决策，风险审查记「风险」，分开计数。
7. **检索三通道**：SQL（Text-to-SQL 统计/精确 id）、BM25、RAG 向量，按问题自动路由；同一事实跨对话折叠成一条「另见」。
8. **本地优先、零依赖**：没有 API Key 也能用；数据在本地目录里，可 git 化、可导出（JSON / Markdown / SQLite / RAG 索引）。
9. **DSH 原生集成**：Web 面板（总览、知识、上下文、诊断、审计）、上下文占用来自 tokenMeter、自动整理与自动快照。
10. **运维面的补课**：`aim_repair` 能体检/修复 DSH 自己的会话日志（序号断层、缺日志、投影比日志新），这是记忆插件里少见的「数据层急救」。

## 4. 相对竞品的优点

- **可审计**：每个字节都能用编辑器打开；出问题能定位到具体文件，而不是「向量里好像没有」。
- **可迁移**：JSON 底座 + 导出格式，换机器、换工具不锁死。
- **不丢上下文**：竞品要么不碰窗口，要么压缩后不可逆；这里清出前必存档，随时恢复。
- **权限粒度细**：多数方案只有「全局共享」或「用户级隔离」，这里能精确到「A 只对 B、C 开放」。
- **不依赖 LLM 抽取**：本地规则即可工作，成本与延迟可控；外部模型只是增强，失败会回退本地。
- **可信度机制**：模型写的东西不会被当成项目事实，冲突不会静默覆盖。
- **装完即用**：无服务、无数据库、无账号。

## 5. 局限（选型时要看清）

- **绑定 DSH**：面板、tokenMeter、会话日志修复都是 DSH 专属；MCP 出口可以桥接其他客户端，但不是一等公民。
- **单机单用户**：没有多租户、团队共享、云同步（Basic Memory Teams、mem0 云版有）。
- **无时序图推理**：不追踪「事实如何演化」（Graphiti/Zep 的强项），只有时间戳和变更记录。
- **检索质量依赖查询与索引**：默认哈希向量 + BM25，语义召回不如专门的嵌入模型；RAG 需要自己配 Embedding/Rerank。
- **生态小**：没有跨客户端插件市场，用户基数远小于 mem0 / Basic Memory。

## 6. 什么时候选它

- 你在 **DSH** 里做长期项目，需要「记得住 + 查得到 + 清得掉还能恢复」；
- 你要的是**项目事实与决策**，不是用户画像；
- 你在意**数据可读、可迁移、可审计**，不想引入常驻服务；
- 你需要**对话之间的权限边界**（比如客户 A 与客户 B 的对话不能互相读）。

反过来：要跨多个 AI 客户端共享记忆，选 Basic Memory / mem0；要时序图谱推理，选 Graphiti/Zep；只要 Claude Code 的自动记忆，选 Claude-Mem。

## 参考

- [Anthropic 官方 Knowledge Graph Memory Server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
- [Basic Memory 文档](https://docs.basicmemory.com/start-here/what-is-basic-memory)
- [mem0: How it works](https://docs.mem0.ai/core-concepts/how-it-works)
- [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service)
- [Claude-Mem](https://github.com/thedotmack/claude-mem)
- [Graphiti](https://github.com/getzep/graphiti)
