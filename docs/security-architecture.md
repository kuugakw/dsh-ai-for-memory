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

### P0（本版，未发布）

- **不变量测试**：`test/security-invariants.test.mjs` 用假的 web server 捕获 `installApi()` 注册的**全部**路由，断言：无 Fetch Metadata 的请求一律 403、同源请求放行、MCP 无 token 401、MCP 关闭 404。以后新增路由自动被覆盖，不需要逐条补测试。
- **把「单点」写进测试**：上述 403 断言是遍历捕获到的 `routes` 的；任何绕过 `register()` 直接 `server.register()` 的路由也会被抓进循环并因缺少统一门而失败。
- 文档化信任等级与出口规则（本文）。

### P1（本版部分完成）

- **出口收口（第一步）**：边界实现移到 `lib/egress.js` 单一定义（`wrapMemoryData`、`containsMemoryBoundary`、伪造结束标记替换），`index.js` 只做 re-export；新增不变量测试遍历所有会回显记忆正文的 action（`remember`/`learn`/`incident`/`promote`/`search`），断言输出带边界、且伪造结束标记只出现一处（被中和）。`stage` 的回显是调用方输入、不是库里的旧数据，按 0.5.12 的设计不走边界，改为在正文里标注来源。
- **路径收口**：`lib/safe-path.js` 的 `resolveRelativeWithin` + `realPathInside` 成为唯一解析器，导出目标与 `aim_repair` 的会话日志符号链接复核都已改用它。
- **动作分类强制**：测试枚举每个工具的 `action` 枚举值，要求每个 `(tool, action)` 都在 `EGRESS_CLASSIFICATION` 里被显式分类（memory / caller-input / external / other）。新增 action 必须先回答「它的输出里有没有库里的正文」才能提交；memory 类由出口测试实际执行（`context restore` 检查的是 `agent.inject` 的正文，而不是工具状态行）。
- **出口收口**：`aim_search` 先改为单一出口——本地检索、向量/RRF、SQL 兜底各分支只拼纯文本，最后统一 `renderMemoryText` 包一次边界（此前只包住向量段，SQL 行和兜底说明在边界外）。随后 `aim_memory` 的 remember/learn/incident/promote、`aim_context` 的 list/restore 注入、`aim_search` 的 SQL 早退也都换到同一个出口函数；旧的 `wrapMemoryData(...)` 调用保留为一行注释备查。边界实现仍然只有 `lib/egress.js` 一处。
- **信任标签**：`formatHits`、`formatSnapshotList`、`formatRestoreContext` 不再返回裸字符串，而是返回 `tagMemory(...)` 标记；组装点必须用 `taggedText(...)` 取正文，出口再 `renderMemoryText` 包一次。标记对象在字符串化时**直接抛错**（不是 `[object Object]`），所以任何忘记取正文的插值都会在出错的那一行报「必须用 taggedText() 取值」；另有静态守卫扫描三处 formatter 的调用行。面板 `/search` 等走同一工具，返回的本来就是带边界的文本，不受影响。
- **仍未做**：把标签从 formatter 层下沉到 store 读取层（这样绕过 formatter 的新代码也带标签），以及给「忘记 renderMemoryText」加运行期兜底。原因：工具当前直接拼字符串（`return parts.join('\n')`），自动包裹需要先把 store 读取接口改成返回 tagged 值、所有 action 走统一 formatter，属于跨 13 个 action 的重构，单独排期。
- **控制面**：10 处路由内重复的 `isTrustedRequest` 已注释关闭（保留原文作为语义标记），并新增静态扫描测试：`lib/api.js` 里未注释的 gate 调用只允许 2 处（`register()` 包装器 + POST 读体器），有人再复制一份就会失败。

### P2

- **能力令牌**：破坏性操作（`export`、`aim_repair`、`forget`、`prune`、启用 MCP）在配置里显式授予能力，操作审计事件带能力 id；默认全部关闭，用户按需打开。
- **启动自检**：初始化时检查文件权限、MCP 状态、备份存在、schema 版本、异常 0600 文件，生成一份「安全体检」给面板展示；不通过时在面板顶部提示而不是只写日志。

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
