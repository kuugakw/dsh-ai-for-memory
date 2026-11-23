# 更新记录

本项目从 `0.1.0` 起使用三段式版本号，规则见 [开发与测试](docs/development.md#版本号与发布)。

## 未发布

### 会话存储

- **新增 `aim_repair action=doctor`**：把会话日志、`storages/workspace.json` 索引和 `session_projcache` 投影缓存放在一起体检，识别四类失配——序号断层（`seq` 不连续）、回合未收尾、索引里有但磁盘上没有日志、投影比日志新；并比较插件记忆存档里的最新轮次，报告「日志比存档少 N 轮」。默认只预演；`apply=true` 时可截断断档日志（需 `repairLogs=true`）、把过期投影改名归档。缺日志的会话按 `ghosts=auto`（默认）处理：插件记忆里有存档的保留并写占位日志（打开是空对话），没有存档的从索引移除（先备份 `workspace.json`）。
- **测试入口改为 `node --test test/`**，新增 `test/session-doctor.test.mjs`（6 项）：断档截断、占位日志可被校验器接受、索引清理与备份、过期投影归档、预演不写盘、占位日志识别两种 id 写法。

## 0.5.2（2026-11-23）

### 发布与安装

- **安装文档改为 npm 优先**：`dsh plugin --profile <profile> add dsh-ai-for-memory@<version>`，DSH 设置里的「添加插件」也可直接填包名；本地目录 `install_bundle` 保留为开发/离线方式，升级与卸载都有 npm 命令。
- **tag 触发的 GitHub Actions 发布**：新增 `.github/workflows/publish.yml`，推送 `v*` tag 后跑测试，并通过 npm Trusted Publisher OIDC 执行 `npm publish --provenance --access public`；发布使用 `id-token: write`，不需要 `NODE_AUTH_TOKEN`，`publishConfig.provenance` 也已开启。
- **包元数据补齐**：`engines.dsh` 与 `dsh.compatibility.dsh` 声明兼容 `>=0.2.0-rc.1 <0.3.0`；keywords 增加 `context`、`compaction`、`repair`。

## 0.5.1（2026-11-23）

### 本地引擎

- **只认自己 profile 的锁和进程**：`discoverLiveEngines()` 之前只要可执行文件名以 `llama-server` 开头、权重在当前 models 根目录下就认领，两个 DSH profile 共用 models 目录或用户手起过 `llama-server` 时，都会把别人的进程写进本实例的内存 map 和锁，之后停止/清理就可能 SIGKILL 它。现在锁记录带当前 DSH profile 的 `owner`，owner 不匹配的锁不探测、不改写、不删除；锁文件丢失时也只扫描 `ppid === process.pid` 的直接子进程。`stopAllLocalEngines()` 也只会停当前进程自己 spawn、仍有 child handle 的实例，接管来的 survivor 不参与 dispose。跨 DSH 重启且锁丢失的孤儿进程不再自动认领，宁可留给人处理，也不把未知进程变成可停止实例。回归用例覆盖其他 profile 的锁、无 owner 的旧锁，以及当前/非当前父进程判定。
- **PID 不再当作进程身份**：锁里只有 PID 时，系统回收 PID 后可能把旧记录指向无关进程；接管探测失败路径和停止路径现在都会先核对命令行里的可执行文件、`-m` 模型路径和 `--port`，核对不上就只清理过期锁，不发信号。健康检查通过的引擎仍可停，自定义 binary 不依赖进程名。`process.once('exit')` 也只杀当前进程自己 spawn 的 child，不再对 map 里的裸 PID 发 SIGKILL。回归用例用 `sleep`/Node 进程模拟 PID 回收，确认 restore 与 stop 都不会杀掉它。
- **`..` 开头的目录名不再被当成越界**：`modelIdFromPath()` 用 `relative.startsWith('..')` 判断是否离开 models 根目录，`models/..cache/x.gguf` 这类合法路径会被误判；现在只把 `..` 本身和 `..${path.sep}` 前缀视为越界，仍保留 `path.isAbsolute()` 检查。

### 自动活动记录

- **命令行风险按命令位置判断**：`DESTRUCTIVE_COMMAND` 之前是裸子串正则，`git log --format=...`、`grep -rn "rm" .`、`grep -rn format src/` 都会被判成 high，自动活动记录和面板风险徽标因此失真。现在先按 shell 分隔符切段、按引号分词，只看每段的执行命令和关键子命令；参数里的 `format`、`rm`、`kill` 不再命中，`rm`、`git rm`、`git mv`、`git reset --hard`、`Remove-Item`、`taskkill`、`bash -c 'rm ...'`、`xargs rm` 等命令位置仍会判 high。回归用例覆盖只读命令、复合命令和 PowerShell 写法。

### 知识查询

- **`WITH` 别名校验不再误伤**：`hasUnsafeCte()` 之前扫描语句里每个 `WITH` token，`SELECT 1 AS with` 会被当成 CTE 起始并拒绝；现在只有语句开头或 `(` 后的 `WITH` 才按 CTE 解析，`AS with` / `AS "with"` 这类合法别名放行。递归 CTE、子查询 CTE 和原有的 `WITH RECURSIVE` 拦截保持不变。

## 0.5.0（2026-11-23）

### 本地引擎

- **停止失败不再删除锁文件，孤儿进程可重新接管**：`stopAllLocalEngines()` 之前无论 PID 是否还在都删除 `.engine.lock`，`stopProcess()` 也在 2.5 秒后直接返回而不升级强杀；模型加载慢或忽略 SIGTERM 时，面板会显示已停止而 1.5 GB 的 `llama-server` 继续运行。现在先 SIGTERM、等待 PID 退出，1.5 秒后升级 SIGKILL，只有确认 PID 消失才删锁；停止全部时保留幸存进程的状态与锁，下一次仍可停止。
- **健康探测失败不再当作进程已死**：接管时 `/health` 超时或模型名不匹配会删除锁，随后 `engines` 里没有条目，面板显示“未启动”，但进程仍活着。现在 PID 还活着就保留锁并显示为“进程仍在运行，但接管探测失败”，停止按钮仍可用；再次启动会被拒绝，避免在旧进程旁再起一份。
- **丢失锁的进程会被重新发现**：启动时除读取 `.engine.lock` 外，还会枚举本机 `llama-server` 进程（Windows 用 CIM，POSIX 用 `ps`），按命令行里的 `-m` 路径归属到当前模型目录，探测成功后写回锁。这样旧版本已经丢锁的孤儿进程也能重新出现在面板里并被停止。

### 面板

- **新增「高级设置（model.json）」**：llama.cpp 页选中模型后可直接改模型类型、权重相对路径、ctx-size、端口、pooling、启动超时、binary 和 `extraArgs`，并显示写入的是 `model.json` 还是根目录 `.model-meta.json`；类型改为“自动”会清掉显式 `kind`，权重路径留空会恢复自动发现 `.gguf`。Loose 模型在根目录 GGUF 上不能另指权重路径，但可以标记类型。
- **模型配置 API 补齐 `modelPath` / 可清空的 `kind`**：`updateModelConfig()` 校验新权重文件存在后才写入，`kind: ''` 清除显式类型；接口现在也允许编辑尚未标记类型的 Loose 模型。
- **补上自动活动开关**：高级策略页新增「记录每轮自动活动」（`autoDecisionLog`），关闭后不再写每轮「常规」决策记录，`aim_decide` 的风险审查记录不受影响。

## 0.4.6（2026-11-23）

### 知识库

- **`tags` / `confidence` 输入清洗**：`tags` 现在接受字符串数组或逗号分隔字符串，非字符串数组项直接丢弃，不会再被 `String()` 成 `"[object Object]"`；`confidence` 接受数字或数字字符串，`"high"` 等无法解析的值直接报错，不再静默回落 0.8。回归用例覆盖逗号字符串、脏数组项、对象 tags、数字字符串和非法 confidence。

### 安全

- **分类字段不能再变成对象或函数**：`normalizeCategory()` 直接读 `CATEGORY_ALIASES[value]`，而 `__proto__` / `constructor` 会命中原型链，返回 `Object.prototype` 或 `Function`，写入后分类字段就不再是字符串。现在只认 `Object.hasOwn()` 的自有别名，且别名必须是已知分类；`fallback` 也限制在已知分类内，无法字符串化的对象回退到 `project_facts`。回归用例覆盖 `__proto__`、`constructor`、对象 fallback 与 `Object.create(null)`。

### 知识查询

- **单行大对象在 SQLite 分配前拒绝**：`SQL_MAX_ROW_BYTES` 只能在 `iterate()` 拿到行之后检查，`randomblob(134217728)` 仍会先让 RSS 上涨 128 MB。现在在暴露 `db.limits` 的 Node 上把 SQLite `SQLITE_LIMIT_LENGTH` 设为 2 MiB，SQLite 在构造超限值时就报 `string or blob too big`，不会先产出再检查；同时为临时库注册有上限的 `randomblob` / `zeroblob` 实现，超过 2 MiB 在分配前抛错。`printf`、`format`、`hex`、`quote`、`json_quote`、`replace`、`concat` / `concat_ws`、`group_concat` / `string_agg`、`json_group_*` 等可放大或跨行聚合的函数在只读 SQL 校验和 authorizer 层拒绝；`substr` 只截取已有值，保留可用。回归用例覆盖 `hex(randomblob(1048576))`、`group_concat`、带引号函数名和 128 MiB Blob，实测 RSS 只增加约 1 MiB。
- **逗号分隔的 FROM 表不再绕过递归 CTE 检查**：`bodyReferencesCte()` 之前只检查 `FROM` / `JOIN` 后的第一个表，`WITH c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM knowledge_docs, c)` 因此通过检查并可能无限递归。现在按 FROM 列表扫描：逗号后的表、`JOIN` 后的表、`FROM (a, b)` 括号表组和 schema 限定名都会比对 CTE 名，并正确跳过子查询、函数参数和别名；回归用例覆盖逗号、`AS` 别名、括号表组和安全的逗号列表。

## 0.4.5（2026-11-22）

### 安全

- **知识库记录下载 / 打开只用 safeStem 落盘文件**：`recordFile()` 的 knowledge 分支之前把面板传入的原始 `doc_id` 直接拼进 `knowledgeDir`。写入用的是 `safeStem(doc_id)`，于是 `doc_id: '../../secret'` 可以经 `/record/download` 或 `/reveal` 读出记忆目录外的 JSON。现在按写入规则取 `safeStem()`，再用 `path.resolve` + `path.relative` 做目录包含校验；context / snapshot 分支同样校验。
- **文件管理器启动失败不再终止宿主**：`openInFileManager()` 之前 spawn 后只 `unref()`，缺少 `xdg-open` 时异步 `error` 事件没有监听，Node 会以未捕获异常退出 DSH 进程。现在监听 `spawn` / `error`，失败返回 `{ ok:false, error }`，`/reveal` 返回 500 而不是崩溃；同步 spawn 异常也走同一条错误路径。
- **MCP JSON-RPC 批次有上限且禁止嵌套**：`handleMcpMessage()` 对数组直接 `Promise.all`，一条无上限的 batch 可并发数百次 `aim_search`；嵌套 batch 还能绕过外层计数。现在单批最多 20 条，超限在调用任何工具前返回 `-32600`，批次项本身是数组也按非法请求拒绝。

### 知识提炼

- **自由文本候选的 base ref 不再提前消费**：`candidatesFromRecord()` 的自由文本候选用 `staging:<id>#N` 作为 `source_ref`，收尾台账却拿 `staging:<id>` 去精确匹配，于是把 base ref 标成已消费。被冲突闸门挡下的提案只报告一次就消失。现在按 `base ref` 前缀归组，只有该条目的所有候选都已入账或在本轮处理完，才消费 base ref；pending 和因预算跳过的候选都会留到下轮。回归用例覆盖自由文本 pending 连续两轮可见。
- **同一 turn 的候选各自有 ref**：`candidatesFromTurn()` 之前让一个 turn 的所有候选共用 `context:<id>#turnN`。第一条候选成功写入就把整条 ref 记进台账，同 turn 里因数值变更进入 pending 的兄弟候选下一轮被当成已提炼而消失。现在每个候选带 `#N` 后缀，turn ref 作为 base，按前缀等到所有候选都解析后才消费；回归用例覆盖“一条已存在 + 一条数值变更”的 turn 连续两轮可见 pending，确认后才消费 base。
- **删除知识后可以重新提炼**：`forgetKnowledge()` 只删 `entry.doc_id === docId` 的台账项，而候选成功后写入的 base ref 的 `doc_id` 是空串，残留下来会让整个 layer item 被当成已提炼；再次 `promoteKnowledge()` 返回 0 条新增。现在删除候选的 `base#N` 时一并删掉它的 base ref，源条目重新可见；回归用例验证 forget 后 base 与候选 ref 都消失，下一次 promote 能重新写入同一篇知识。

### 上下文压力

- **阈值按原始 token 比较，不再用四舍五入后的百分比**：`exceedsUsageThreshold()` 之前复用 `usagePercentOf()` 的一位小数结果，69950 / 100000 = 69.95% 被舍入成 70，70% 阈值因此提前触发全量清出。现在直接用 `pressureTokens` 与 `contextWindow` 比较，显示仍保留一位小数；回归用例覆盖 69.95%、69.99% 不触发、70.00% 触发。
- **abort 中的手动立即清理不再丢请求**：`onPreStep` 的 `finally` 无条件 `pending.delete(id)`，而 `runTopicalClear()` 在外部摘要窗口收到 abort 时只是提前返回、没有清理也没有存档，请求因此静默消失。现在 abort 期间保留该请求，留到下一个可用边界；回归用例用中途翻转的 signal 验证 surface 未变且 pending 仍在。

### 会话日志

- **修复后保留 POSIX 权限位**：`backupFile()` 的 `copyFileSync` 与 `replaceAtomically()` 的 `openSync(temp,'w')` 都按进程 umask 新建文件，原本 0600 的会话日志修复后变成 0644，备份也一样。备份按源文件 mode `chmod`，写回在 rename 前对临时 inode `fchmod`；回归用例在 POSIX 上验证主文件与备份都保持 0600。
- **zstd 解压上限在分配前检查**：`decodeZstdLog()` 之前先完整解压每一帧，再用 `total > cap` 事后拒绝；几百字节约 128MB 的帧会先分配完整输出。`scanZstdFrames()` 现在解析帧头的 content size，超预算时在解压前抛错；未声明大小的帧把剩余预算作为 `maxOutputLength` 交给 zstd，谎报/缺失大小也无法超量分配。
- **`sourceEventSeqs` 区间展开有上限**：`decodeSeqRanges()` 之前只校验安全整数，`[[0, 8000000]]` 会先生成 800 万个元素。展开上限设为 1,000,000 项，超限在分配前抛错；回归用例覆盖默认上限、自定义上限与边界。
- **浅扫描读首帧也受解压上限约束**：`scanSessionLogs(deep:false)` 的 `readHeaderOnly()` 之前不带 `maxOutputLength`、也不看帧头 content size，压缩炸弹在“只读头部”路径上仍会完整分配。现在首帧先按 `maxDecodedBytes` 与 1 MiB 头部上限检查声明大小，解压时再传 `maxOutputLength`；回归用例用 8 MiB 的合法头部验证 1024 字节上限在解析 JSON 前生效。

### 请求锚点

- **`<system-reminder>` 前缀后的真实请求不再被当作 harness 文本**：`isHarnessText()` 遇到提醒前缀直接返回 true，跳过了“剥离提醒后再判断”的逻辑；提醒块后跟着新请求时，锚点仍注入上一轮的旧请求。现在先剥离提醒块，再判断剩余文本是否全为 harness 内容。回归用例覆盖“提醒块 + 新请求”不做旧请求锚点。

### 检索缓存

- **文档版本包含正文指纹**：`docVersion()` 之前只用 `updated_at + revision`，公开 `search()` / `buildIndex()` 传入同时间戳、同 revision 但正文不同的文档时会复用旧倒排索引/向量，搜新正文为空、搜旧正文仍命中。现在版本键加入正文长度与 FNV-1a 哈希；回归用例覆盖同 id、同时间戳、同 revision 的正文替换。

### 本地引擎

- **动态端口启动增加同步占位**：两个并发 `startLocalEngine()` 在 `engines` 尚无条目时都能通过检查，随后各自 `await freePort()`，再各自 spawn，第二个 `engines.set()` 覆盖第一个，留下孤儿 llama-server。现在在第一个 await 之前用 `startLocks` 占用模型，后来者直接复用同一个启动 Promise。回归用例在 POSIX 上用慢启动包装脚本并发启动两次，断言只 spawn 一次。

### 知识查询

- **标签名不再被分隔符正则吞字**：`标签[^\w]*` 的分隔符类会连中文一起吃掉，`标签项目事实` 只剩 `实`，查询变成 `LIKE '%实%'`。现在分隔符只匹配非中文标点/空白，标签名完整保留。
- **按标签统计返回 count**：`按标签 项目事实 统计` 之前命中标签列表分支，返回 20 条明细；现在带“多少/几条/数量/总数/统计”等计数意图时生成 `COUNT(*)` + `tags LIKE ?`。
- **只读 SQL 检查忽略字符串字面量与注释**：`isSafeSelect("SELECT ... LIKE '%delete%'")` 之前被关键字扫描误杀。现在先把单/双/反引号字符串、方括号标识符、行注释和块注释替换为空格，再检查分号与写关键字；未闭合的引号或注释直接拒绝。字符串里的 `;` 不再被当成第二条语句。
- **标签后的计数短语不再并入标签**：`标签为项目事实有多少条` 之前被贪婪捕获成 `项目事实有多少条`，`LIKE '%项目事实有多少条%'` 恒为 0。现在只剥离已知的尾部问句形式（`有多少条` / `的数量` / `的统计` 等），标签本身保留；回归用例覆盖三种问法都生成 `COUNT(*)` 且参数为 `%项目事实%`。
- **“最近多少条”按计数处理**：`latest && wantsList` 在通用计数分支之前，`最近有多少条` 被当成列表取 10 行。现在同时出现计数词时跳过列表分支，回到 `COUNT(*)`；`最近 3 条知识` 仍返回列表。
- **递归 CTE 在只读检查阶段拒绝，结果按行预算迭代**：`isSafeSelect()` 之前只检查首关键字，`WITH RECURSIVE c(x) AS (...)` 能通过；SQLite 甚至允许省略 `RECURSIVE` 的自引用 CTE，同步执行没有步数上限。现在解析每个 `WITH` 的 CTE 列表，拒绝 `RECURSIVE`、自引用和无法解析的定义；执行端改用 `StatementSync.iterate()`，到 50 行即停止，不再先物化全部结果。回归用例覆盖带/不带 `RECURSIVE`、嵌套在 `SELECT` 里的 CTE，以及 81 行原始 SQL 只返回 50 行。
- **原始 SQL 结果增加单行/总字节上限**：`iterate()` 之后只限制了 50 行，`SELECT randomblob(33554432) FROM knowledge_docs` 仍可让 50 行各 32 MB，峰值约 1.6 GB。现在每行按字符串/Blob 的实际大小估算，单行超过 2 MiB 或累计超过 16 MiB 在加入结果前返回错误，不再把大对象累积进 `rows`。
- **引号标识符不再绕过递归 CTE 检查**：检查之前跑在 `sqlWithoutLiterals()` 的结果上，而它把 `"c"` 抹成空格，`WITH c(x) AS (... FROM "c")` 因此看不到自引用。现在单独把原始 SQL 切成 token：字符串和注释丢弃，双引号/反引号/方括号标识符保留解码后的名字，再比较 `FROM`/`JOIN` 目标；`FROM "c"`、``FROM `c` ``、`FROM [c]` 和 `main."c"` 都能识别，普通引号列名与字符串不会误报。

### 检索预览

- **截断标记按内容判断，不再比长度**：正文恰好 241 字符时，预览是 240 字符加一个省略号，长度仍为 241，`preview.length < full.length` 为 false，`text_truncated` 被错误置为 false。现在比较预览与原文是否一致；恰好 240 字符的正文仍不标记截断。

### 面板

- **知识勾选键包含 scope/session**：批量选择之前只用 `doc.doc_id`，两个对话存在同 id 知识时会一起被勾选/确认。现在选择键为 `scope:session_key:doc_id`，全选、单行勾选和批量确认共用同一个键。
- **`/state` 加载增加请求序号**：慢响应可能在切换 scope 后覆盖新数据。现在每次 `load()` 递增 `stateRequestSeq`，只有最新请求能写入 `data`、错误和 busy 状态。
- **llama 表单不再被任意 `/state` 重载重置**：同步 effect 依赖 `data.localModels`，保存、启动、停止或任何面板刷新都会把未保存的 ctx/端口/pooling 等字段改回服务端值。现在按所选模型的存储配置生成 key，只有配置真正变化或切换模型时才回填。
- **冲突未解决数按完整日志统计**：`buildUiState()` 之前从截断到 50 条的 `conflictLog(50).items` 计数，超过 50 条未解决冲突时面板最多显示 50。现在累加 `conflictLog(50).open`（由完整日志算出），列表仍只返回 50 行。
- **上下文行去掉重复的恢复按钮**：折叠头部和展开内容各有一个“恢复”，展开后同一行出现两个相同操作。现在只保留头部按钮。

## 0.4.4（2026-11-22）

### 安全

- **快照 / 上下文 id 只接受纯文件名**：`loadSnapshot` / `loadContext` 之前把调用方传入的 id 直接拼进 `path.join`，`../knowledge/k_secret` 可以读出目录外的 JSON；`removeSnapshot` 还会用记录里的 `snapshot_id` 拼路径，构造一条恶意快照记录即可删除任意 JSON。现在只在 id 不含 `/`、`\`、`:`、NUL 且不是 `.` / `..` 时走精确路径，否则退回按名称/前缀扫描；删除前也复核记录里的 id。回归用例覆盖越界读取和越界删除。

### SQL 路由

- **分类识别改用知识库分类**：`categoryOf` 之前遍历归档层的 `CATEGORIES`，`workflow_rules` / `tools_apis` / `project_facts` 等知识分类识别为 `null`，统计退化成全库总数；`action_logs` 这类归档分类则生成恒为 0 的过滤。现在使用 `KNOWLEDGE_CATEGORIES`，回归用例覆盖知识分类与 `action_logs`。

### 检索

- **每文档缓存键加入 scope**：token / vector 缓存之前只用 `doc_id + updated_at + revision`，两个对话存在同 id、同时间戳、同 revision 但不同文本时，后一个对话会复用前一个的 tokens/向量，搜自己的文本 0 命中、反而命中对方向量。现在缓存键带 `cacheScope`，与库级索引的分键一致；回归用例覆盖 hybrid 与 document 两种模式。

### 面板

- **`/probe-external` 不再漏 API Key**：面板探测与 `/rag/index` 之前手工拼 `normalizeExternal`，漏了 `embedApiKey` / `rerankApiKey`，面板“测试连接”的 Embedding/Rerank 探测不带 key，实际调用却正常。现在两处统一调用 `externalConfigFrom()`，与 `aim_ask` 的工具路径共用同一份配置构造。

### 决策保留

- **`pruneDecisions` 不再误删自动活动记录**：该函数现在跳过 `decision_auto_*`；这些每轮记录由 `pruneAutoDecisions` 的独立保留期处理。用户开启 `decisionRetentionDays` 不会再把自动活动日志一起清掉。

### 决策审查

- **`risk` 校验不再接受原型属性**：`evaluateDecision` 之前用 `risk in RISK_MULTIPLIER` 判断，`toString` / `constructor` / `__proto__` 等原型链属性会被当成合法等级写进审查记录。现在要求 `risk` 是字符串且为表的自有属性（`Object.hasOwn`），回归用例覆盖原型属性与数字。

### 审计日志

- **`readAudit(..., 0)` 不再返回 200 条**：limit 表达式用 `||` 回退默认值，显式 0 被当成“未指定”。现在显式 0 或负数返回空数组，有限值向下取整并夹在 0..200；缺失或非数字才用默认 200。回归用例覆盖 0、负数、小数与超上限。

### 端点探测

- **`/props` 快路径恢复生效**：`createEndpointGate` 的 `request()` 为释放 socket 无条件读取 `response.arrayBuffer()`，而 `propsOf()` 随后还要 `response.json()`；Fetch 的 body 只能读一次，第二次抛 `Body is unusable: Body has already been read` 被吞掉，`has_embeddings` / `has_reranking` 永远读不到，所有端点都退化为发真实推理请求。现在只有状态探测才排空 body，读取 `/props` 的请求保留 body。
- 回归用例：真实 HTTP 服务返回 `has_embeddings:true` 时只请求一次 `/props`，不再发 `/v1/embeddings`；mock 响应也改成单次消费的 body（`arrayBuffer` + `json` 共享 used 标记），避免同类问题再次被 mock 掩盖。

## 0.4.3（2026-11-22）

### 会话日志修复

- **写回前按内容复核**：`repairSessionLog` 读取时记录 `mtime + size + sha256`，备份前和原子替换前各复核一次；对话仍在生成、另一个 DSH 进程写入或文件被替换时放弃写回，不再用旧快照覆盖读取后追加的事件。`compact` 重排走同一条保护；冲突时不还原备份（备份可能比计划新），磁盘上的新字节保持原样。
- **“正在使用”不再只看最近会话**：运行时暴露当前活动回合集合（`activeTurns`），工具和面板都能拒绝另一个标签页里仍在流式生成的对话。原来面板只比对 `recentSessionId`（最近完成的会话），流式生成中的会话会漏过；现在即使两条启发式都没命中，写回前的指纹复核仍会拦住旧快照。
- 回归用例：规划后追加 → 冲突、原文件保留新字节且不产生备份；compact 路径同样；`isSessionActive` 处理 `session-` 前缀；读取期间被写入时直接拒绝。

### 端点探测

- **显式端点返回 401 不再算「可用」**：`externalEmbedBaseUrl` / `externalRerankBaseUrl` 之前只做存活探测，任何 HTTP 响应（含 401）都被当成已就绪；key 配错或经过鉴权代理时本地引擎被压住，RAG 每轮 embedding 实际返回 401，且没有本地后备。现在显式命名与 `externalBaseUrl` 兜底使用同一套能力验证：llama.cpp 看 `/props` 的 `has_embeddings` / `has_reranking`，其他服务向真实端点发最小请求，2xx 才算可用。
- 回归用例：返回 401 的显式 Embedding 端点不再抑制本地启动；只答 `/health` 的端点同样不够；显式 Rerank 端点 2xx 时仍抑制，并携带 per-kind Bearer key。

### 检索

- **hybrid / vector 不再收哈希碰撞噪音**：TF 向量在 128 维 FNV-1a 空间里，无关文档只要有一维撞上查询就会得到正余弦（30 token 量级约 0.19），在 RRF 里拿到 `0.4/(60+rank)` 的分数并进入结果；0.05 的余弦下限挡不住这个量级。现在向量通道只给与查询至少共享一个 token 的文档打分，纯碰撞文档保持 0 分，不会进入 hybrid / vector 结果。
- 回归用例：查询「测试」不再召回「天气预报和烹饪」这类零相关文档；单字查询「测」同样只返回真正含该字的文档。
- **同一批文档里重复 `doc_id` 不再虚高 BM25**：`search()` / `buildIndex()` 先按 `doc_id` 去重（最后一条生效），重复 id 不会再把 `index.n` 算两次、累加词频，也不会返回两条同 id 的结果。生产路径逐 store 检索本就不会重复；这是给公开导出函数的防御。
- 回归用例：重复 id 与去重后的文档集合得到相同的 id/分数；`buildIndex().n` 与 `avgLength` 一致；hybrid 每个 id 只出现一次。

## 0.4.2（2026-11-22）

### 本地引擎生命周期

- **短轮次不再杀掉加载中的模型**：`turn` 模式的轮末停止改为空闲计时——约 2 分钟没有新的主对话轮次后才释放由该模式启动的实例。正在读权重的 `llama-server` 不会再在轮末被 SIGTERM，也就不会再被记成「llama-server 退出」的启动失败并触发 60 秒冷却；连续对话期间模型保持热，冷启动只发生在长时间空闲之后。
- **显式停止立即取消**：面板点停止会取消进行中的加载，返回「启动已取消」而不是崩溃；启动链路识别取消结果，不写失败冷却。
- **关闭最后一个会话也会进入空闲释放**：`session/disposed` 与 `turn/end` 同样处理——最后一个主对话被关闭后启动空闲计时，`turn` 启动的引擎不会常驻到下一次无关轮次结束或 DSH 退出。
- 回归用例：模拟慢加载的引擎在 `starting` 状态被停止时返回 `cancelled`（POSIX 运行，Windows 跳过）。

### 端点探测

- **只配 chat 端点不再压住本地引擎**：`externalEmbedBaseUrl` / `externalRerankBaseUrl` 显式命名时，端点能应答即视为可用；只有 `externalBaseUrl` 兜底时才验证真实能力——llama.cpp 读 `/props` 的 `has_embeddings` / `has_reranking`，其他服务向 `/embeddings` 或 `/rerank` 发一个最小请求，2xx 才算可用。401/404 不再被当成「embedding 已就绪」。
- **跳过原因可见**：被端点抑制的模型写入 `/state` 的 `localEngineSkips`，面板模型行直接显示「检测到已配置的 … 端点 … 可用，已跳过本地自动启动」，并只记一次日志。
- **探测缓存 30s → 5s**：端点挂掉后最多 5 秒就允许本地引擎启动，而不是半分钟内所有 turn 都不尝试。
- 回归用例：chat-only 端点（`/props` 报 `has_embeddings:false` 或 `/v1/embeddings` 404）不抑制本地启动；显式 Embedding 端点仍抑制；`/props` 为真时无需推理；兜底探测携带对应 kind 的 Bearer key。

### 检索缓存

- **倒排索引改为原地增量更新**：索引保留每篇文档的 postings 与长度快照，写一篇只移除并重加这一篇，删除按文档回收，不再每次 O(全库 token) 重建；BM25 的 `n`/`avgLength` 同步维护。库级向量表同样按文档增量。
- **四个缓存改为 LRU**：tokens、向量、倒排索引、库级向量表命中时刷新顺序，热索引不会被一次性查询按 FIFO 挤掉。
- **缓存键带库根与分类**：不同 MemoryStore 或分类各用各的索引，互不覆盖；`cacheMode: 'document'` 也复用增量倒排（只跳过库级向量表），注释与实现一致。
- 回归用例：改写/删除/新增文档后 BM25 结果与统计正确；不同 store/category 的索引互不污染。

### 检索摘要

- **摘要只保留一份实现**：`search()` 与 `applyDisclosure()` 共用 `summarizeHits`，不再各写一套截断逻辑，改 `snippetOf` 语义只需改一处。
- **`applyDisclosure(detail: 'full')` 明确为直通**：摘要条目只剩 preview 与 `text_chars`，无法还原全文；要全文请用 `search(..., { detail: 'full' })`。注释写明了这个边界，不再假装能“升级”。
- 回归用例：`search()` 的摘要与 `applyDisclosure(full)` 逐字段相等。

## 0.4.1（2026-11-22）

- **冲突日志**：被知识冲突闸门拦下的写入记入 `knowledge/conflicts.jsonl`（只做审计，不是队列，不参与检索）；`aim_memory status` 报未确认数，面板知识库页显示最近冲突，确认覆盖后自动标记为已确认。
- **自动活动记录保留**：新增 `autoDecisionRetentionDays`（默认 90 天），只清理 `decision_auto_*` 每轮自动记录；`aim_decide` 审查记录仍由 `decisionRetentionDays` 控制（默认 0=永不删）。决策层的日常增长不再无界。
- **决策写缓存**：`recordDecision` 不再 bump 全局 epoch，只失效决策视图，避免每轮自动记录连带重扫知识/过程记录缓存。
- **稳定性**：用户数据写入 fsync；RAG 索引缓存按 manifest 内容识别代际，避免跨实例读到旧索引。
- **文档**：测试口径更正（159 项；Node 20 上 13 项依赖 sqlite/zstd/git 的用例按能力跳过，146 pass），补充同构事实批量导入阈值与引擎生命周期成本说明。

## 0.4.0（2026-11-21）

### 本地模型生命周期

- **三种运行方式**（`engineLifecycle`，在「设置 → llama.cpp」选择）：`manual` 常闭（默认，只有面板手动启停）、`always` 常开（插件加载时启动，每轮开始前确保在跑，轮末不停）、`turn` 每轮开关（每轮第一个模型请求前启动，轮末只停止该模式启动的实例）。手动启动或重载后接管的引擎不受 `turn` 停止影响；多个主对话同时运行时，等全部结束才停。
- **检测规则**：只有磁盘上可运行的 `Embedding` / `Rerank` 模型（有 GGUF、`llama-server` 可执行）才参与；检测不到时模式空转，不报错。启动失败记警告并冷却 60 秒；子代理轮次不触发启动/停止。
- **已配置端点可达时跳过**：先探测 `externalEmbedBaseUrl` / `externalRerankBaseUrl`（为空回退 `externalBaseUrl`），能连上就不启动本地引擎，避免和手工管理或云端服务重复；端点不可达或未配置时才拉起。任何 HTTP 响应都算可达，探测缓存 30 秒、短超时，不阻塞模型请求。

### 决策层

- **每轮工具活动自动记录**：`turn/end` 里至少调用过一次工具的轮次会写一条 `outcome=observed` 的决策记录：工具名、失败次数、读/改的文件、按工具推断的风险等级；记录 id 按会话+轮次确定，重放覆盖而不是重复。
- **常规与风险分开**：面板「决策」页拆成「常规」（自动记录）和「风险」（`aim_decide` 审查）两段，各自计数；`aim_memory status` 也分开报告。自动记录不参与知识提炼，`autoDecisionLog` 可关闭。

### 知识库

- **冲突不再排队**：`promote` 和外部提炼遇到冲突或更新时，直接把条目返回给调用方，由模型询问用户，不再写入 `pending/knowledge.json`；旧队列仍可查看。
- **确认覆盖**：`remember` 传了已存在的 `doc_id` 时，不带 `confirm` 返回更新建议；`confirm=true` 才替换正文、递增 revision，并把旧句子记进 `changes`。

### 检索与稳定性

- **文档**：新增 [上下文清理机制](docs/context-clearing.md)，完整说明触发条件、相似度打分、压力硬重置、存档恢复与调参边界。
- **配置与检索收紧**：`keepRecentSteps` 成为正式配置项（默认 3，1~20）并接入校验、`/config` 和面板；`aim_search` 不再暴露内部 `cache_mode`；token/向量缓存按 `updated_at + revision` 取键，同长度改写不再复用旧缓存。
- **清理安全边界**：前缀重置在最近的安全边界会切在 assistant 工具调用之后时，往回退一步；没有安全边界时保留整轮。
- **文件解析缓存有界**：`fileJsonCache` / `fileJsonlCache` 改为带条数和字节预算的 LRU，不再把每个记忆目录的每个文件留到进程退出。
- **DSH_HOME 修复**：环境变量未设置时不再解析成字面 `undefined` 目录；`~/.dsh` 回退集中到一个 helper，并把 `undefined`/`null` 字面值当作未设置。
- **对抗性加固**：混合检索显式使用 RRF，平局时保留两路排名；相似度打分丢弃英文停用词、只按两个以上共享内容词计 Dice；`provenance=user` 只信任上下文/用户确认来源；`irreversible=true` 的决策直接拒绝，不能靠标低 risk 绕过。
- 测试：156 个用例（Node 22.15+ 全量通过；Node 20 上 13 项依赖 `node:sqlite` / zstd / git 的用例按运行时能力跳过，其余通过）。

## 0.3.2（2026-11-21）

### 本地模型生命周期与提醒

- **插件停用/重载不再停模型**：停用再启用插件、保存设置后的重载都不会停掉 `llama-server`；只有 DSH 正常退出时，插件才在进程退出前停掉自己启动或接管的引擎。DSH 被强制结束导致残留时，下次启动优先接管，不会起第二份。
- **未启动提醒**：打开面板时，如果磁盘上有可运行的本地 GGUF 模型、但对应种类的引擎没就绪，会弹一次「检测到 … 模型，但还没有开启模型」；只提醒、不自动启动，引擎启动后提醒自动消失。
- **模型类型大小写修复**：散装 GGUF 与目录模型的 kind 大小写不一致（`Rerank` / `rerank`），运行中的 Rerank 现在能正确覆盖散装模型，不再误报；engine 不是 llama.cpp 的模型不参与提醒。

### 上下文清理与请求锚点

- **任务进行中就清**：DSH 的一个任务是一个用户请求跨很多工具步骤，整轮都在一个未结束的 turn 里；硬重置改为替换一个连续前缀——从当前回合第一个 assistant 节点到步骤边界，保留当前请求、最近 3 步和最近 `keepRecentTurns` 轮，替换文本是续接包（当前请求 + 最近进展 + 相关记忆），不再等轮末。
- **清出量真正下降**：按轮替换时，前面的部分清出会让后面的区间失效，结果每次只清最新一轮、占用停在 50% 上下；连续前缀不会失效，清出的内容全部先存档。
- **请求锚点只在每轮第一步注入**，且只针对仍在表面上的请求；新请求优先于旧锚点，避免回答慢一拍或答非所问。
- **压力重置的抑制带上测量值**：长任务在下一次请求报告新的尺寸后可以再次重置；轮次触发与用量触发互相独立，不再互相吞掉。

### 检索与其他

- **检索缓存路由**：库级索引/向量缓存走快路径，文档级增量缓存兜底，`cache_mode=auto|library|document` 可选；修复中文检索片段和显式模型种类。
- **RAG 建索引**：大规模去重时分批让出事件循环，不再卡住 DSH。
- **MCP 版本**：`initialize` 的 `serverInfo.version` 从 `package.json` 读取，不再手写。
- **文档**：新增完整功能总览 [docs/features.md](docs/features.md)。
- 测试：新增提醒判定等用例，全套 145 个用例通过。

## 0.3.1（2026-11-21）

### 本地模型增强

- **运行中的本地模型自动接管 Embedding/Rerank**：配置为空或仍是旧 loopback 端口时，RAG、`aim_search`、`aim_ask`、归档/提炼等调用自动使用当前运行中的 Qwen3-Embedding / Qwen3-Reranker；显式云端地址优先，不会被覆盖。
- **RAG 自动挂载**：两个本地引擎都就绪且未配置独立外部端点时，自动挂载 RAG；索引身份使用 `local:<model>`，llama-server 重启换临时端口不再让索引失效。
- **Rerank 真正参与 RAG**：Rerank 启动显式加 `--pooling rank`；RAG 在 Rerank 不可用时拒绝“只靠 Embedding”的结果并回退 BM25；检索输出明确标注 `Embedding + Rerank`，小 logits 用科学计数法显示。
- **`ctx-size` 可调**：本地模型默认从 8192 降到 2048，面板每个模型可单独修改并写回 `model.json`；自动选端口遇到 `EADDRINUSE` 时换端口重试最多 3 次，显式端口仍直接报错。
- **模型页**：Embedding / Rerank 分栏，llama.cpp 调参页支持 ctx-size、port、pooling（含 `rank`）、启动超时、binary、额外参数。

### 会话恢复与诊断

- **会话日志修复改为异步**：`zstdDecompress` 异步解压，按 `mtime+size` 缓存；总览默认只读文件头，深度体检需显式点击，避免打开页面冻结 DSH 事件循环。
- **Node 能力显式化**：`/state` 和诊断页返回 `sessionRepairAvailable`；Node 20 上明确标记会话修复不可用，而不是点下去才报错。
- **校验器可追溯**：深度体检显示使用 DSH 内置校验器还是本地回退，并给出回退原因；截断修复先预演，确认按钮明确写出“将丢弃 N 条事件”。
- 会话日志深度体检限制最近 20 份；compact 启动前保留备份和写后复验。

## 0.3.0（2026-11-21）

### 新增

- **`aim_repair`：DSH 会话日志体检与修复**。DSH 把对话写成多段 zstd 帧的 `session.v<N>.jsonl.zstd`，一条事件结构不合规就会让整个对话打不开（`stored log is corrupt` / `SessionFormatError: developer/message does not match an open turn and step`），而 DSH 没有删除/修复接口。新工具可以扫描 `$DSH_HOME/sessions` 下所有日志（物理/逻辑大小、事件数、结构状态、异常膨胀标记），并修复单个日志：优先把旧版插件写入、落在 step 之外的 `developer/message` 便条改写为等价 `user/message`，保留全部历史；否则截断到第一处损坏之前并用 DSH 自带的合成收尾事件补全。写回前自动备份、写回后复验，失败自动还原；校验优先使用当前安装的 DSH 包规则，拒绝修复正在进行的对话。
- **会话日志重排**：`aim_repair action=compact` 把 DSH 逐批追加产生的上万个碎帧重新按 200 个事件一批分帧，事件内容不变，只缩小物理体积（实测 55.4 MB → 22.3 MB，157 MB 逻辑日志）。
- **面板入口**：总览主页面新增「会话日志修复」卡片，打开页面自动对最近 3 份日志做深度体检（解压并校验帧/事件），异常时红字提示先恢复上下文；可就地两步确认修复/重排，诊断页保留完整列表和全量深度体检。
- **上下文恢复与导出**：上下文页每行行头直接「恢复到当前对话」（`aim_context restore`），并可「导出 Markdown」，把 context 存档变成可直接阅读的文件。
- **快照恢复与对比**：快照页每行行头有「恢复」，顶部可选两个快照并排查看完整 `state`；手动快照仍不参与自动清理。
- **会话健康警示**：总览自动深检最近 3 份会话日志，`corrupt` / `unreadable` / `torn-tail`（帧未闭合）会触发红色提示；仅体积异常时用琥珀色提示，不误报为损坏。

## 0.2.0（2026-11-21）

### 新增

- **诊断与用量页**：汇总 Node / `node:sqlite` / Git / `llama-server` / 模型目录 / 记忆目录可写性 / gitignore / 磁盘占用；列出知识命中次数和近因权重，权重 0 的死条目优先显示。
- **面板操作审计**：确认、删除、清理、恢复、保存配置、批量开放、建索引和 Git 操作写入 `audit.jsonl`，诊断页可查看。
- **知识页交互**：按分类、source/provenance、确认状态筛选；按更新时间、置信度、命中次数、权重排序；支持全选与批量确认，确认后可撤销。
- **记录审查出口**：知识、上下文、快照条目可直接打开对应 JSON 或下载原始 JSON；诊断页支持两个快照并排对比。
- **实时上下文占用**：总览显示 tokenMeter 实测百分比和 token 数，不再把配置阈值当成当前占用；六层总览卡片补齐归档、快照和决策。
- **MCP 出口**：面板/本机 MCP 客户端可列出记忆根并调用现有 `aim_*` 工具；默认启用回环与 Host 防护，可另设访问令牌。
- **上下文压力硬重置**：占用达到阈值时全量存档并清出已完成轮次，下一次请求前回载任务续接；轮末没有下一次请求时直接清空。

### 修复

- 清理便条、请求锚点和任务续接信息使用 `source.kind = ai-for-memory`，不再进入 `turn.user`，不会被 `promote` 当成用户规则；旧存档按已知前缀过滤。
- `/state` 明确返回知识总量、实际返回数、200 条上限和是否被截断，面板显示「只加载最新 200 条」。
- 危险操作补充二次确认：停止本地引擎、保留清理；上下文清理与删除保留两步确认。

## 0.1.1（2026-11-20）

### 修复

- 清理便条保留 `user/message` 以便模型可见，但改为 `source.kind = ai-for-memory`、`source.form = notice`、`source.summary` 标记；真实用户输入保持 `source.kind = user`。不要使用 `developer/message`：DSH 会把它投影成 system update，全量清出后可能缺少前置 user 而请求失败。
- 请求锚点使用同一种 `notice` source，避免 developer 类型在 provider 投影时被过滤或报错。
- `llama-server` 启动改为捕获 stdout/stderr 尾部；失败面板显示真实错误、实际命令和 GGUF 版本/`--reranking`/`--pooling`/OOM/路径等修复提示，不再只有 `code=1` 或 `ECONNREFUSED`。
- 本地引擎增加 `models/.engine.lock` 启动日志：启动时写入 PID/端口/模型路径，插件加载时探测 `/health`、`/props`、`/v1/models` 并接管仍存活的进程；停止接管进程时按 PID 回收，避免插件重启后堆出第二份 `llama-server`。`stopProcess` 不再因超时前设置 `exited` 而跳过 kill。
- **修正预留分类被当成 Embedding**：`resolveModel` 只接受 Embedding/Rerank；`Routing` 等目录即使有 GGUF 也标记不可运行，面板不显示启动按钮，直接调 `/local-engine/start` 会被拒绝，避免用 `--embeddings --pooling cls` 拉起路由模型污染向量。
- **模型变更不再复用旧进程**：启动时记录 `model.json` 和 GGUF 的 `mtime+size` 指纹；`model.json` 的模型名/路径/参数或 GGUF 变化后，`startLocalEngine` 返回 `{ok:false, stale:true}` 并拒绝复用，面板提示先停止再启动；锁文件也保存指纹，重启后即使模型路径已改，旧进程仍会被接管以便停止回收。
- **模型目录迁到用户配置区**：`model.json` 和 `.engine.lock` 默认放在 `$DSH_HOME/ai-for-memory/models/`，插件自带的 `models/` 只作为可选扫描源，更新插件不会带走 `extraArgs` / `ctxSize` / `port` / `binary`；用户目录同名模型优先。
- **模型目录 TTL 缓存**：`/state` 的 `listLocalModelsCached()` 缓存 5 秒，避免每次刷新都同步递归扫描 `models/` 和所有 `model.json`；结果提供 `roots` 区分用户目录和插件目录。
- **未知来源不再默认已确认**：`normalizeSource` 的缺省/拼错值统一为 `unknown`，而 `normalizeProvenance` 把 `unknown` 归入 `model`；少传 `source` 的写入现在会带「模型自述（未确认）」标记，不再因为缺省而变成 `authored` / `verified: true`。
- **外部模型地址默认留空**：`externalBaseUrl` 不再默认 `http://127.0.0.1:8080`，空值表示未配置；面板只显示 placeholder，不会在打开或检测连接时静默等待本地服务。探活超时固定上限 5000ms（真实生成/重排仍用 `externalTimeoutMs`），未配置时直接返回可读提示而不发请求。
- **网络同步接受 scp 式 remote 并并发探端口**：`git@github.com:org/repo.git` 这类从 `git remote -v` 复制的地址现在能解析；无显式端口时 22/443/80/9418 并发探测，最坏等待从 12s 降到 3s。
- **`.gitignore` 保护状态不再静默**：项目没有 `.gitignore`、记忆目录已存在但未被忽略、或 `.gitignore` 不是普通文件时，`aim_memory status` 和面板都会给出警告；自动写入仍只在已有 `.gitignore` 且目录尚未创建时发生。
- **`sql` 别名在 `Config.validate` 内归一化**：DSH loader 走 `~standard.validate`，以前放行 `sql` 却原样返回，store 只认 `sqlite`，配置会静默退回 JSON；现在 `validate` 和 `normalizeConfig` 共用同一个 canonicalizer，`sql → sqlite` 在进入 loader 时已完成，未知值直接报错。
- **拆句片段补主语并标记 `clause`**：超过 400 字符的段落按逗号拆分时，后续子句会带上原句主语前缀，`tags` 增加 `clause`，`confidence` 降一档；无主语的「必须改成 120 秒」不会再被当成独立规则。
- **中文对立词补充**：`materialChange` 新增打开/关掉、打开/关闭、是/否、保留/删除、内网/公网等组合，避免 Jaccard 命中后把「从开变关」静默合并。

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
