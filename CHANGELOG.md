# 更新记录

本项目从 `0.1.0` 起使用三段式版本号，规则见 [开发与测试](docs/development.md#版本号与发布)。

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
