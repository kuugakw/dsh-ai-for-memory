# 开发与测试

> 返回 [主 README](../README.md)。

## 项目定位

AI for Memory 是面向 DSH 的**项目级记忆插件**。记忆类插件已有不少实现，本项目不声称发明了新品类；发布说明统一使用“本插件的第 N 个正式版”，不要写成“首个项目级正式版”或暗示这是同类插件的第一次出现。

## 版本号与发布

从 `0.1.0` 起使用三段式版本号：

| 位置 | 含义 | 示例 |
|---|---|---|
| 第一位 | 重大更新：工具大范围修改、接口或存储格式调整、需要迁移 | `0.1.0` → `1.0.0` |
| 第二位 | 功能更新：新增工具、动作、面板能力，保持向后兼容 | `0.1.0` → `0.2.0` |
| 第三位 | 修复更新：只修 bug，不改变既有接口 | `0.2.0` → `0.2.1` |

版本号以 `package.json` 的 `version` 为准，README 徽章、发布标签和面板显示必须与它一致。每次发布都要同时更新这三处。

Release 标题**只写版本号**（如 `0.1.1`），不写「第 N 个正式版」之类的附加说明；更新频率高，标题保持与 tag 一致即可。正文说明这次是修复、功能还是重大更新，以及主要变化。

**什么时候改版本号：**

- 本地开发、修 bug、未发布的改动：不改版本号；
- 只有准备发布到 GitHub 时才改：更新 `package.json` 的 `version`、README 徽章和发布标签/GitHub Release；
- 普通开发提交（包括只推送到分支、还没有正式发布的提交）不算发布；
- 判断标准：仓库里的 `version` 始终指向最近一次已发布版本。

发布顺序：

1. 本地跑全部门禁：`npm ci && npm test && npm run check && npm run typecheck && npm run coverage`；
2. 按重大/功能/修复位更新 `package.json`，并同步 README 的两个徽章、安装命令与“当前版本”行，`docs/features.md` 的对应版本，`docs/installation.md` 的安装命令，以及 `CHANGELOG.md` 的当前版本小节；再跑 `npm install --package-lock-only` 让 lockfile 根版本跟上（元数据检查会校验它）；
3. 再跑一次 `npm run check`，提交发布改动，打 `v*` tag；
4. 推送提交与 tag：`publish` 先校验 tag 与 `package.json` 版本一致，再跑 `npm ci && npm run check && npm test`、发布到 npm（带 provenance），并在成功后自动创建 GitHub Release；不需要手工建 Release，也不需要 PAT。`market` 在 `publish` 成功后在 tagged commit 上重建索引并部署 Pages（失败不会部署旧索引），本地再把生成的 `market/index.json` 提交一次。

### npm 发布

npm 上的包名是 `dsh-ai-for-memory`；`package.json` 已移除 `private`，并限制 `files` 只打包入口、lib、文档、locale、示例模型 README 和许可证，`models/.engine.lock` 不会被发布。

首版 `0.5.1` 已手动发布。包现已配置 GitHub Actions Trusted Publisher：仓库 `kuugakw/dsh-ai-for-memory`，workflow 文件名 `publish.yml`，允许 `npm publish`。后续发布只需要推送 `v*` tag，`.github/workflows/publish.yml` 会跑测试并通过 OIDC 发布，自动生成 npm provenance；需要 npm CLI 11.5.1+、Node 22.14+、公开仓库和匹配的 `repository`。workflow 需要 `id-token: write`，不需要 `NODE_AUTH_TOKEN`。

同一个 workflow 在 `npm publish` 成功后用 `GITHUB_TOKEN`（`contents: write`）自动创建 GitHub Release，标题与 tag 一致、正文由 GitHub 生成；Release 创建在发布之后，发布失败不会留下指向空版本的 Release。

`0.0.0-stage` 是首次发布流程留下的占位版本，已用 `npm deprecate` 标记废弃（该操作需要 npm 账号的一次性验证码，CI 的 OIDC 令牌不能代替）。

本地手工发布仍可用 `npm publish --dry-run` 检查包内容，再 `npm publish`；本地发布必须满足 npm 的 2FA 要求，且不会生成 CI provenance。

## 开发与测试

插件运行时要求 **Node.js 22.15+**；开发（lint）要求 Node 22.15+ / 24+，因为 ESLint 10 的下限如此，且 `node:sqlite` 与 zstd 从 22.5 / 22.15 起才可用。

```bash
npm ci          # 安装 lint 依赖（CI 使用同一条命令）
npm test        # 单元测试（含面板冒烟测试）
npm run lint    # ESLint flat config：只查正确性（未定义名、未用变量、重复键、ASI 陷阱等）
npm run typecheck # tsc --noEmit：检查带 `// @ts-check` 的文件
npm run check   # lint + 元数据一致性（README/docs/CHANGELOG/package.json/market 索引）
npm run coverage # 覆盖率门禁：全局行 ≥80%、函数 ≥80%、分支 ≥65%，并按文件设地板（api/index/tools/store 等）
```

类型检查覆盖 `index.js` + `lib/**/*.js` 全部模块（`checkJs: true`，`npm run typecheck` 应为 0 错误）；`client.js` 不在范围里——它是 DSH 面板的单文件 module-loader 脚本，不是 Node 模块。CI 只在 ubuntu + Node 22 上跑覆盖率与类型检查，避免六个矩阵任务重复付费。

`test/client-smoke.test.mjs` 在 VM 里加载 `client.js`，用假的 `window.__ModuleLoader__` 和真实 React 跑 `factory()` + `apply()`，断言面板注册了侧栏入口与主面板、双语标题正确——这是目前唯一覆盖面板代码的测试。

当前测试覆盖六层读写、对话隔离、上下文清理/恢复、知识冲突、模型自述确认、事故记录、SQL 路由、RAG 构建、导出、面板数据组装、安全不变量，以及本地引擎的 GGUF 发现和 llama.cpp 启动参数等。规模与召回数据见 [规模压测](benchmarks.md) 和 [记忆召回基准](recall-benchmark.md)（`npm run bench:scale` / `npm run bench:recall`，发布前手动跑）。

全套测试数以 `npm test` 输出为准（当前 289 项）；依赖 `node:sqlite`、zstd 或平台符号链接/权限能力的用例按运行时能力 `skip()`，CI 同时跑 Node 22 与 24。新用例若依赖运行时能力，用 `t.skip()` 标注原因，保持这条边界可核对。对抗场景单独列在 [对抗评测](adversarial.md)（`test/adversarial.test.mjs`）。

**质量门禁**：CI 的 `tests` 工作流在 ubuntu/windows/macos × Node 22/24 上执行 `npm ci && npm test && npm run check`；`publish` 工作流在 tag 上先校验 `v<version>` 与 `package.json` 一致，再跑 `npm ci && npm run check && npm test`，然后 `npm publish --provenance`。README 的两个徽章、安装命令、当前版本行、`docs/features.md` 的对应版本、`docs/installation.md` 的安装版本、`package-lock.json` 根版本与 `CHANGELOG.md` 的小节都必须与 `package.json` 一致，否则 `npm run check` 直接失败。Lint 规则只覆盖 correctness，不引入格式审查，避免大范围重排掩盖真实改动。

主要代码：

```text
index.js                  # 插件入口：apply() 与工具注册（约 200 行）
lib/tools.js              # 六个 aim_* 工具定义 + 格式化/检索辅助
lib/context-management.js # 上下文清理、恢复、自动整理与锚点
lib/config.js             # 默认值、配置校验、能力令牌与审计
lib/schema.js             # 工具/MCP 参数的 JSON Schema 校验
client.js                 # Web 面板
lib/store.js              # 文件存储和六层数据
lib/scopes.js             # 对话隔离、共享层、工作区分组
lib/knowledge.js          # 知识规范化、冲突、提炼候选
lib/retrieval.js          # 本地 BM25 / 向量 / RRF
lib/knowledge-query.js    # SQL 路由和临时只读表
lib/knowledge-sqlite.js   # SQLite 只读镜像
lib/rag.js                # RAG 分片索引
lib/local-engine.js       # 本地 llama.cpp 引擎生命周期
lib/api.js                # 面板 API
lib/context.js            # 上下文保存 / 恢复
lib/decision.js           # 决策审查
lib/external.js           # OpenAI 兼容外部服务
lib/export.js             # 知识库 / SQL / RAG 导出
lib/egress.js             # 记忆数据边界与信任标记（唯一定义）
lib/safe-path.js          # 允许目录内的路径解析（唯一定义）
lib/security-check.js     # 只读安全体检
lib/audit.js              # 面板审计日志
test/core.test.mjs        # 测试
test/security-invariants.test.mjs  # 安全不变量
test/client-smoke.test.mjs        # 面板冒烟
```

---
