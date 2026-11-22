# 同赛道对比：AI for Memory 的定位与优势

> 调研时间：2026-11-20。样本来自 DSH 社区记忆插件目录与各项目 README；星数为目录页当时的快照，只代表关注度，不代表质量。
>
> 本文比较的是**设计取舍**，不是跑分。不同插件解决的问题不同，下面的“优势”都限定在本次抽样和“项目级、可审查记忆”这个方向上。

## 一句话结论

同赛道大致分成几派：常驻注入派、七层/多层事实库、审批审计型、Git 仓库型、上下文生命周期型，以及“记忆 + 技能/待办/多 Agent”的平台型。

**AI for Memory 的差异点是：把项目记忆当成一套可审查、可恢复、可迁移的数据层，而不是只做“记住一句话”的注入器。** 六层数据、对话隔离、知识确认/冲突闸门、上下文硬重置、决策审查和 MCP 出口是组合在一起的；同时默认不依赖任何外部模型，RAG / SQL / 本地 llama.cpp 都是可选增强。

## 调研样本

| 插件 | 目录星数（快照） | 它主要怎么做 |
|---|---:|---|
| [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | 1066 | 组合式三档记忆：runtime memory / Project Documents / Memory Spaces；多种 strategy、Provider、Skills 自进化，Memory System UI |
| [dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve) | 873 | 五轨记忆 + 待办 + 技能 + 多会话/外部 AI 调度，偏“Agent 工作台” |
| [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) | 400 | 七层 SQLite（soul/user/project/fact/lesson/topic/rules），首轮快照 + 每消息关键词 top-2，dream 整理，压缩后重注入 |
| [dsh-memento](https://github.com/PerryLink/dsh-memento) | 145 | 类型安全 `ctx.memory` 接缝 + 本地 SQLite；审批门、审计、硬预算、冻结快照；只读 stdio MCP |
| [dsh-memory-palace](https://github.com/lovezi0/dsh-memory-palace) | 30 | 文件式 Markdown 记忆：用户级 + 工作区级，人类可读、可改 |
| [dsh-memory-hub](https://github.com/ARFCON/dsh-hotplug-hub/tree/HEAD/dsh-hotplug-hub/dsh-memory-hub) | 28 | 全局 memory pack + BM25 + 确认制提案队列 + pinned 预算 + 审计 + GUI 页签 |
| [Starry0214/dsh-memory](https://github.com/Starry0214/dsh-memory) | 11 | SQLite 主题树、压缩后拦截式重灌、前缀缓存优化、主动提醒、统计/图谱 |
| [dsh-get-memory](https://github.com/krodon998/dsh-get-memory) | 3 | GitHub 仓库当记忆；会话开始拉取注入，结束提取写回并提交；细粒度 PAT、文件权限中心 |

参考目录：[awesome-dsh-plugins / memory-sessions](https://github.com/dshworks/awesome-dsh-plugins/blob/main/lists/memory-sessions.md)。

## 同赛道在怎么做

### 1. 常驻注入派：先把“你是谁”塞进首轮

代表是 meow-memory、dsh-memory-palace、Starry0214/dsh-memory。它们把用户画像、项目约定、规则或主题索引放进 system prompt / 首轮快照，让模型在开口前就知道背景。

- 优点：无需模型主动调用工具，冷启动体验好；
- 代价：注入预算固定，内容多了要裁剪、分层或只用索引；
- 常见治理：首轮只注入稳定层，后续按关键词/主题按需召回。

### 2. 多层事实库派：把记忆拆成类型

meow-memory 用七层 SQLite 表；dsh-mnemon 用 runtime / documents / spaces 三档；dsh-memento 用 user/agent × global/workspace 两轨两层。共同点是**不同类型的事实用不同的生命周期和预算**，而不是所有内容都塞进一个 Markdown。

- 优点：事实、偏好、项目文档、长期证据各归各位；
- 代价：层越多，写入路由、冲突、迁移和 UI 越复杂。

### 3. 审批审计派：写入不是模型说了算

dsh-memento 把审批门做在服务内部，写入带预算、审批载荷和审计链；dsh-memory-hub 用确认制提案队列；dsh-memory-evolve 的记忆写入也强调用户确认。它们把“模型可以写记忆”变成“模型可以提议写记忆”。

- 优点：高风险写入可控、可追溯；
- 代价：每条记忆多一步交互，自动沉淀的流畅度下降。

### 4. Git 仓库派：记忆跟着仓库走

dsh-get-memory 直接以 GitHub 仓库中的 Markdown 为真源，会话开始拉取、结束提取写回，靠 SHA 做并发保护；dsh-memory-evolve 也提供项目记忆的 Git 同步。

- 优点：跨设备、跨重启天然一致，人能直接在仓库里读改；
- 代价：依赖网络/令牌，写回要处理冲突、额度和敏感信息。

### 5. 上下文生命周期派：不只“记”，还要“清”和“还”

Starry0214/dsh-memory 做压缩后重灌、检查点归档和主动提醒；meow-memory 做压缩后重注入；dsh-memory-palace 做上下文压力下的整轮归档。它们都在解决同一个问题：**上下文窗口有限，清理不能等于失忆。**

- 优点：长会话可持续；
- 代价：要理解 DSH 的 surface / turn / tool call 边界，实现难度高。

### 6. 平台派：记忆只是入口

dsh-memory-evolve、dsh-mnemon 把技能、待办、多 Agent、外部 Provider 都接进来。记忆不再是单独的插件，而是 Agent 工作台的一部分。

- 优点：能力强、场景覆盖广；
- 代价：安装面、学习成本和耦合度都更高。

## AI for Memory 的优势

### 1. 六层项目记忆，不是“一个事实列表”

我们把项目工作拆成 **过程记录 → 分类归档 → 快照 / 知识 / 决策 / 上下文**：

- 过程记录保留“刚发生了什么”，先记再整理；
- 归档按错误、决策、界面事实等分类；
- 快照保存精确状态对象，能原样恢复；
- 知识库是一条一句、带分类和出处的结论；
- 决策层保留正反理由、风险、是否可逆和恢复路径；
- 上下文层保存清理前的完整轮次。

多数同类把“记忆”做成事实/画像/主题几层；我们的六层更接近**项目工作流审计**：既能回答“项目事实是什么”，也能回答“当时为什么这么定、清掉的上下文去哪了”。

### 2. 知识治理是默认行为，不是可选项

模型写入默认是：

```text
provenance: model
verified: false
```

检索时降权、面板上黄标，用户确认后才成为已确认事实。新知识与已有知识相近但不同会先返回冲突/更新，要求确认；数值、URL、开关变化单独识别，不会静默覆盖。

同类里 dsh-memento 的审批门很强，但更偏“写入审批 + 预算”；我们的治理覆盖**来源、确认状态、冲突/更新、证据链、面板逐条确认**，并且把“模型自述”与“用户确认”区分成检索排序的一部分。

### 3. 上下文清理是完整闭环

我们的上下文路径不是只调用 compaction：

- 清理前先完整存档到 `contexts/`；
- 手动 clear 按话题相似度选择，保留高相似轮次；
- 上下文占用超过阈值时，在下一次模型请求前**全量硬重置**，清出已完成轮次并回载“当前请求 + 最近进展”；
- 轮末没有下一次请求时直接全清，不留下旧内容；
- `restore` 按 `restoreMaxChars` 从尾部取，不会一次把刚清掉的窗口重新灌满；
- 单个工具结果恢复最多渲染 8 KiB，原始事件仍完整保留。

这比“压缩后重新注入一段摘要”更重，但换来的是**清理可回滚、恢复有预算、当轮工具调用不会被拆开**。

### 4. 对话级隔离 + 显式共享层

每个对话有自己的六层记忆，写入默认只进本对话；共享层需要显式 `scope=shared`。跨对话检索默认只包含**已打开**的对话，未打开的对话在检索、恢复、面板合并视图里都不可见。

这比“所有会话共享一个记忆池”更安全，也避免了 A 对话的临时信息污染 B。代价是用户要主动开放需要共享的对话，但我们认为对项目数据这是正确的默认值。

### 5. JSON 是底座，派生视图可丢

知识库先写 `knowledge/<doc_id>.json`，这个文件是审查点；SQLite 镜像、RAG 索引、导出文件都从 JSON 派生。派生视图损坏不会反向破坏 JSON。

这带来两个实际好处：

- 随时可以用文本工具审查/备份/迁移；
- 关掉 SQLite 或 RAG，记忆本身仍然完整可用。

### 6. 本地优先，外部能力全部可选

默认不需要 API Key、不联网：

- 本地 BM25 + 128 维哈希向量 + 混合检索；
- SQL 路由和 RAG 是可选增强；
- Embedding / Rerank 可接任何 OpenAI 兼容服务，也可从 `models/` 启动本地 llama.cpp；
- 外部模型失败自动回退本地规则。

对比需要云端 Provider 或强制 embedding 的方案，我们的默认路径更轻；需要语义能力时再打开，而不是一开始就绑定服务。

### 7. 决策审查层

`aim_decide` 对高风险/不可逆操作做正反合审查：

- `irreversible=true` 直接拒绝；
- `irreversible=false` 必须给出 `recoverable_via` 才放行；
- 决策、理由、风险、审查结果写入 `decisions/`，后续可提炼成知识。

在本次样本里，记忆插件普遍记录“事实/偏好/教训”，把**决策可逆性**作为独立层和工具面的较少。这是 AI for Memory 面向工程操作的一个明显差异点。

### 8. 面板不是只读统计

面板覆盖：

- 总览、六层记忆页、范围/工作区/对话选择；
- 知识逐条确认、冲突/更新查看；
- 上下文存档与清理状态；
- RAG 索引、外部模型、本地模型引擎；
- Git 网络同步；
- 设置保存后自动重载并刷新。

dsh-memento 的面板偏只读，Starry 偏统计/图谱；我们的面板更接近**日常管理界面**：查看、确认、清理、恢复、配置都在同一处。

### 9. MCP 出口：直接接其他工具

我们提供 HTTP MCP 端点：

```text
http://127.0.0.1:<DSH 端口>/ai-for-memory/mcp
```

- Streamable HTTP + JSON-RPC，无额外进程；
- 工具：`aim_roots` / `aim_search` / `aim_remember` / `aim_status` / `aim_context_list` / `aim_context_restore`；
- 根目录必须来自登记表，不能借 MCP 读任意路径；
- 只读的 `aim_context_restore` 返回文本，不注入在线会话；
- 可选 Bearer 令牌，默认 loopback + Host 校验。

dsh-memento 也提供 MCP，但是**只读 stdio**；我们的出口是可被本地客户端直接连接的 HTTP 服务，并且通过 MCP 可以写共享知识。

### 10. 跨平台和工程化细节

- DSH 会话分桶在 Windows / POSIX 上都能解码并修复连字符歧义；
- 便条、请求锚点、任务续接有 `source.kind = ai-for-memory` 标记，不会污染知识提炼；
- 状态、清理、恢复都有可读的诊断记录；
- 测试覆盖 175 项（截至本次改动；Node 20 上 15 项、Windows 上另 1 项按运行时能力跳过），不依赖启动 DSH。

这些不是“功能列表”里最显眼的，但决定了插件在真实项目里是否可维护。

## 相对差距，保持诚实

为了不把优势写成广告，也列出本次样本里别人更强的地方：

- **生态和装机量**：dsh-mnemon、dsh-memory-evolve、meow-memory 的社区规模、文档、Provider 生态明显更大；我们目前是早期项目。
- **自动注入的顺滑度**：meow-memory、dsh-mnemon 的首轮快照/每轮关键词命中更“无感”；我们的默认路径更依赖模型主动调用 `aim_search` 和用户管理范围。
- **自我进化/技能**：dsh-mnemon 的 Skills 自进化、dsh-memory-evolve 的技能/待办/多 Agent 调度，是我们没有覆盖的。
- **Git 自动化**：dsh-get-memory 的仓库拉取/写回和 SHA 冲突处理更接近“开箱即用”；我们的 Git 同步更偏受控的手动/面板操作。
- **MCP 形态**：我们只有 HTTP，没有 stdio；某些只支持 stdio 的客户端需要适配器。
- **审批门深度**：dsh-memento 把审批做在服务内部、带预算和审计载荷，这一点比我们的工具层确认更严格。

## 适合谁

AI for Memory 更适合：

- 把 DSH 当**工程项目工作台**，需要跨会话保留约定、错误修复、决策和上下文；
- 在意“模型说的”和“用户确认的”要分开；
- 希望记忆是本地 JSON、可审查、可迁移，而不是绑定某个云服务；
- 需要上下文清理后还能恢复；
- 想让 Claude Desktop / Cursor / 脚本通过 MCP 读同一份记忆。

如果你更想要“装上就自动记住一切、零管理”，dsh-mnemon / meow-memory 的自动注入路径可能更顺；如果你更想要“每条写入都经过严格审批和审计”，dsh-memento 更专注；如果你要 GitHub 跨设备账本，dsh-get-memory 更直接。

## 主要来源

- [awesome-dsh-plugins / memory-sessions](https://github.com/dshworks/awesome-dsh-plugins/blob/main/lists/memory-sessions.md)
- [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)
- [dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve)
- [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)
- [dsh-memento](https://github.com/PerryLink/dsh-memento)
- [dsh-memory-palace](https://github.com/lovezi0/dsh-memory-palace)
- [dsh-memory-hub](https://github.com/ARFCON/dsh-hotplug-hub/tree/HEAD/dsh-hotplug-hub/dsh-memory-hub)
- [Starry0214/dsh-memory](https://github.com/Starry0214/dsh-memory)
- [dsh-get-memory](https://github.com/krodon998/dsh-get-memory)
- [AI for Memory](https://github.com/kuugakw/dsh-ai-for-memory)
