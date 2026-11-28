# 安全架构：单一边界，而不是逐点补丁

这份文档回答一个问题：**为什么不继续在每条路径上补漏洞，而是先定一套边界与不变量。** 它不是使用说明，读完应该能判断「新功能该把检查写在哪、写不出来算不算 bug」。

## 1. 现状：补丁清单本身就是问题

从 0.5.7 到 0.5.12，安全修复的形态高度一致：

| 版本 | 补的路径 | 形态 |
|---|---|---|
| 0.5.7 | MCP 出口、面板 CSRF、导出目录、`aim_repair` 目录、文件权限、SQL 通道 | 每条路径各补一次 |
| 0.5.8 | 记忆回灌边界 | 逐个出口加 `wrapMemoryData` |
| 0.5.10 | 迁移回填脱敏、锁 owner 校验、SQL CTE 自连接、`Sec-Fetch-Site`、端点缓存 | 每类各补一次 |
| 0.5.11 | 缓存字节预算、异步锁、`aim_memory` 回显边界、带引号 JSON 键 | 又是逐个出口/键型 |
| 0.5.12 | `promote`/`stage` 回显边界、迁移备份权限、JSONL 原子写 | 同上 |
| 未发布 | SQL 只读通道关系白名单（`knowledge_docs` + JSON 表函数 + CTE，拒绝内部表/表函数） | 从「计数 `knowledge_docs`」改为「只允许已知关系」 |

共同点：**每次都是「发现一条新路径 → 在这条路径上加一个检查」**。这类修复有两个结构性缺陷：

1. **漏一个就泄漏**。`wrapMemoryData` 在 `index.js` 有 13 个手工调用点，任何新 action 忘了包，输出就是裸记忆正文；测试只能事后发现，不能预防。
2. **无法证明「已经安全」**。面板 11 个路由各自复制了一遍 `isTrustedRequest`，但真正的保护来自 `register()` 里的统一入口——重复检查让人误以为每条路由都要记得写，反而掩盖了「其实已经有一个单点」的事实。

## 2. 威胁模型与信任等级

先明确谁在攻击、哪些数据不可信，后面的不变量才有依据。

**攻击者/风险源**

- **同账户的本机进程**（脚本、npm postinstall、VS Code 扩展）：能直接读记忆文件、伪造 HTTP 头。插件无法在内做认证；真正的边界是操作系统账户与文件权限（0600/0700）。
- **恶意网页**：DNS rebinding、跨站请求面板 API。靠 Host/Origin/Sec-Fetch 元数据拦截。
- **被提示注入的模型**：把记忆/网页里的文字当指令执行。靠数据边界 + 写路径硬限制缓解，不保证。
- **被污染的记忆/外部数据**：网页、MCP 客户端、外部模型写入的文本。
- **越权访问**：跨对话读别人的存档（默认关闭，面板授权）。
- **错误配置**：把 MCP 开到公网、记忆目录放进 Git、备份留在盘上。

**数据信任等级**

| 等级 | 内容 | 处理规则 |
|---|---|---|
| L0 | 系统/用户指令 | 唯一可执行的内容 |
| L1 | 用户直接输入 | 可信来源，但仍作为数据处理 |
| L2 | 记忆库正文 | **不可信**：可能是网页、其他对话、模型写入的；出口必须带边界 |
| L3 | 外部网页 / 外部模型输出 | 不可信，且不自动入记忆 |
| L4 | 密钥/令牌 | 不落盘（脱敏）、不回显、不进日志 |

## 3. 五条不变量与唯一执行点

每条不变量都必须有**恰好一个**执行点；新增功能只能复用这个点，不能另写一份。

| # | 不变量 | 唯一执行点 | 现状 |
|---|---|---|---|
| I1 | 所有面板 HTTP 请求先过环回 + Host + Origin/Sec-Fetch 检查 | `lib/api.js` `register()` 的包装器（`isTrustedRequest`） | 已成立；11 个路由内的副本已注释关闭 |
| I2 | MCP 出口额外要求 Bearer token（配置了才要求） | MCP 路由内部 `bearerMatches` | 已成立 |
| I3 | 所有「记忆正文出门」都包在 `<<<MEMORY-DATA…>>>` 里，伪造结束标记被替换 | `lib/egress.js` `wrapMemoryData()` | 单一定义 + 不变量测试（出口仍逐调用点，未自动） |
| I4 | 所有写入走 store 方法：校验 + 脱敏 + 配额 + 锁 + 0600/0700 | `lib/store.js` 的写方法 / `lib/util.js` 的 `writeJson`/`appendJsonLine`/`ensureDir` | 基本成立；导出、迁移各自有旁路 |
| I5 | 所有文件操作落在允许目录内 | `lib/safe-path.js`（`resolveRelativeWithin`/`realPathInside`） | 导出已收口；`aim_repair` 的 sessions 树仍单列 |

**已经做对的部分**：I1/I2 是真正的单点，`register()` 天然覆盖未来所有路由；I4 的 `writeJson`/`appendJsonLine` 也只有一个落盘入口（fsync、0600、临时文件重命名都在里面）。问题集中在 I3/I5：**出口和路径还是「每个功能自己记得」**。

## 4. 差距清单

1. **I3 出口**：`wrapMemoryData` 是纯函数，但「什么时候需要包」靠调用点判断。新增 action 的最省事写法就是直接返回 store 文本——这正是 0.5.8/0.5.10/0.5.11/0.5.12 反复补的原因。
2. **I5 路径**：导出、`aim_repair`、SQLite 库文件、面板「在文件管理器打开」各有各的解析函数，安全属性（符号链接、`..`、盘符）分别实现。
3. **I1 的冗余**：重复的 `isTrustedRequest` 让「单点」这一事实不可见，也不利于静态检查「有没有绕过」。
4. **缺少可证明性**：没有一条测试能回答「这个版本所有出口都包了吗」。人工审计 13 个点能过，下一次就未必。

## 5. 路线图

### P0（已完成，0.5.19）

- **不变量测试**：`test/security-invariants.test.mjs` 用假的 web server 捕获 `installApi()` 注册的**全部**路由，断言：无 Fetch Metadata 的面板请求一律 403、同源请求放行、MCP 关闭 404、MCP 无 token 401，以及 MCP 豁免浏览器元数据后仍受可信 Host/Origin 与 token 约束。以后新增路由自动被覆盖，不需要逐条补测试。
- **把「单点」写进测试**：上述 403 断言是遍历捕获到的 `routes` 的；任何绕过 `register()` 直接 `server.register()` 的路由也会被抓进循环并因缺少统一门而失败。
- 文档化信任等级与出口规则（本文）。

### P1（已完成，0.5.19 / 0.5.20）

- **出口收口（第一步）**：边界实现移到 `lib/egress.js` 单一定义（`wrapMemoryData`、`containsMemoryBoundary`、伪造结束标记替换），`index.js` 只做 re-export；新增不变量测试遍历所有会回显记忆正文的 action（`remember`/`learn`/`incident`/`promote`/`search`），断言输出带边界、且伪造结束标记只出现一处（被中和）。`stage` 的回显是调用方输入、不是库里的旧数据，按 0.5.12 的设计不走边界，改为在正文里标注来源。
- **路径收口**：`lib/safe-path.js` 的 `resolveRelativeWithin` + `realPathInside` 成为唯一解析器，导出目标与 `aim_repair` 的会话日志符号链接复核都已改用它。
- **动作分类强制**：测试枚举每个工具的 `action` 枚举值，要求每个 `(tool, action)` 都在 `EGRESS_CLASSIFICATION` 里被显式分类（memory / caller-input / external / other）。新增 action 必须先回答「它的输出里有没有库里的正文」才能提交；memory 类由出口测试实际执行（`context restore` 检查的是 `agent.inject` 的正文，而不是工具状态行）。
- **出口收口**：`aim_search` 先改为单一出口——本地检索、向量/RRF、SQL 兜底各分支只拼纯文本，最后统一 `renderMemoryText` 包一次边界（此前只包住向量段，SQL 行和兜底说明在边界外）。随后 `aim_memory` 的 remember/learn/incident/promote、`aim_context` 的 list/restore 注入、`aim_search` 的 SQL 早退也都换到同一个出口函数；旧的 `wrapMemoryData(...)` 调用保留为一行注释备查。边界实现仍然只有 `lib/egress.js` 一处。
- **信任标签**：`formatHits`、`formatSnapshotList`、`formatRestoreContext` 不再返回裸字符串，而是返回 `tagMemory(...)` 标记；组装点必须用 `taggedText(...)` 取正文，出口再 `renderMemoryText` 包一次。标记对象在字符串化时**直接抛错**（不是 `[object Object]`），所以任何忘记取正文的插值都会在出错的那一行报「必须用 taggedText() 取值」；另有静态守卫扫描三处 formatter 的调用行。面板 `/search` 等走同一工具，返回的本来就是带边界的文本，不受影响。
- **运行期兜底（读取台账）**：每次工具调用跑在 `AsyncLocalStorage` 台账里（`lib/egress.js` 的 `runWithMemoryLedger`），`MemoryStore` 的 `search()` / `documents()` 读到正文时记一笔；工具出口由 `withMemoryLedger` 包装，发现「本次读过库 + 结果是 ≥120 字符的长文本 + 没有边界」就整段补包并注明是自动兜底。短状态行（如 restore 的「将在下一步生效」）与显式豁免动作（`aim_context:restore`）不受影响；面板不在台账里读库，JSON 保持纯净。
- **标签下沉到 store 读取层**：`MemoryStore.search()` 支持 `tagText: true`——命中项的 `title`/`text` 在 store 边界就变成 `tagMemory` 标记（`knowledge/search/text`），工具的两个检索通道都带这个开关，`formatHits`/`foldDuplicateHits`/`summarizeHits` 用 `taggedText` 取正文。这样即使新代码绕过 formatter 直接拿 store 命中做拼装，只要忘了取正文就会在那一行抛错；面板调用 `search()` 不带开关，依旧是纯 JSON。
- **`documents()` 列表回显：评估后不做**——面板需要纯数组；工具侧的列表出口都走 search/formatter，已由 `tagText` 与 `renderMemoryText` 覆盖，单独给 `documents()` 加标记只会多一个无人调用的开关。
- **控制面**：10 处路由内重复的 `isTrustedRequest` 已注释关闭（保留原文作为语义标记），并新增静态扫描测试：`lib/api.js` 里未注释的 gate 调用只允许 2 处（`register()` 包装器 + POST 读体器），有人再复制一份就会失败。

### P2（已完成，0.5.19 / 0.5.20）

- **能力令牌（已实现）**：`capabilityExport` / `capabilityForget` / `capabilityRepair` / `capabilityMcp` 四个布尔能力默认全部关闭。删除知识、导出记忆、`aim_repair` 写回、开启 MCP 都要先显式授权；未授权时工具返回带能力名的说明，拒绝事件写审计（`capability.denied`，带能力 id），放行事件写 `capability.granted`。面板「设置 → 破坏性能力」可开关，配置里直接改同样生效；`mcpEnabled=true` 但缺 `capabilityMcp` 时 MCP 保持关闭并写明原因。
- **启动自检（已实现）**：新增 `lib/security-check.js`，只读检查记忆根/知识/快照/导出目录的 0700、知识文件抽样 0600、`audit.jsonl` 0600、迁移备份的存在与数量、schema 版本、MCP 能力与 token 文件是否匹配。插件启动时若配置了固定 `root` 就检查一次并写日志；面板「诊断」页新增「安全体检」区显示每条结果（不通过标明原因），也可直接 `GET /ai-for-memory/api/security/check`。自检永不阻塞操作。0.5.19 补齐 token 文件的 0600 检查、自定义 `mcpToken` 不要求自动 token 文件、Windows 上不再把不存在的 POSIX mode 报成失败。

### P3（进行中）

- **P3-1 覆盖率抬升（已完成，0.5.22）**：补上面板 `state` / `diagnostics` / `session-logs` / `config` 的载荷用例后，`lib/api.js` 行覆盖从 31.00% 升到 51.07%（Node 22/26 一致），全局行覆盖 86%+；按文件地板把 `api.js` 从 27% 提到 48%（行）/40%（分支）/45%（函数），只升不降。
- **P3-2 类型收紧（部分完成，0.5.22 + 未发布）**：启用六个严格子项——`noImplicitThis`、`alwaysStrict`、`strictBindCallApply`、`strictFunctionTypes`、`noImplicitOverride`、`useUnknownInCatchVariables`；catch 变量统一走 `errorMessage()` / `errorCode()`，84 个 `unknown` 错误清零。剩余 `strictNullChecks` 269 个、`noImplicitAny` 1349 个，按 `api.js` → `tools.js` → `store.js` 分批处理，不一次性打开 `strict`。
- **P3-3 MCP token 轮换（已完成，0.5.22）**：后端 `POST /api/mcp/rotate` 删除并重建自动 token，运行中的 MCP 路由立即改用新值，旧 token 下一次请求即 401；自定义 `mcpToken` 拒绝轮换并提示改配置。面板「MCP 出口」加了「轮换自动令牌」按钮，拒绝/轮换都写审计。
- **P3-4 market 索引自动提交（已完成，0.5.22）**：`market` 改为 checkout `main`，构建后如果 `market/index.json` 有变化就由 `github-actions[bot]` 提交并推送（提交信息带 `[skip ci]`），不再依赖本地手动提交；需要仓库允许 bot 推送 main，分支保护下会在该步骤失败。
- **P3-5 路径统一剩余面（已完成，0.5.22）**：核查 `knowledgeDatabasePath()` 由 `store.root` 直接派生、面板 reveal 只接受登记根/固定根，均无用户可控拼接；补了「未登记根 reveal 返回 404」与安全体检路由的用例。SQLite 库文件与 reveal 不新增 `safe-path` 包装，避免把无输入的路径也套一层解析。
- **P3-6 评估记录：SQLite authorizer 拒读 `sqlite_*` 不可行**——SQLite 内部查询也会读 `sqlite_master.ROWID`，安装后正常 `SELECT count(*)` 都会被拒；保留解析层（关系白名单）作为唯一闸门，不引入第二套半可用的检查。


## 6. 明确不做（以及为什么）

- **进程内认证**：同账户脚本能读文件、伪造头，插件内任何「认证」都只是装饰。真实边界是 OS 账户与 0600/0700。
- **加密记忆**：密钥放哪都是同一个账户可读；没有硬件隔离时加密只增加复杂度，不增加边界。
- **保证模型不被注入**：边界标记是缓解措施（让数据与指令可区分），不是沙箱。写路径的硬限制（`exports/`、`sessions/`、文件权限）是最后一道闸。
- **把本机脚本当攻击者**：如果攻击者已经能执行同账户代码，记忆文件本来就可读；插件不承诺阻止这种情况。

## 7. 新增功能时的检查表

1. 它返回记忆正文吗？→ 走 formatter/边界（P1 后自动），不要直接拼字符串。
2. 它读写文件吗？→ 用 `resolveWithin` 的允许目录，不要自己 `path.join`。
3. 它是新路由吗？→ 只能通过 `registerApiRoute()`；如果它面向非浏览器客户端，显式声明 `allowNonBrowser` 并自带 token。
4. 它写数据吗？→ 只能走 store 方法，不要直接 `fs.writeFileSync` 记忆文件。
5. 它产生可见的安全事件吗？→ `appendAudit`，事件名与字段遵循既有 schema。
