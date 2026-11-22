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

1. 跑完测试；
2. 按重大/功能/修复位更新 `package.json` 和 README 徽章；
3. 提交发布改动；
4. 创建对应的 Git tag 和 GitHub Release；
5. 推送提交与 tag。

## 开发与测试

要求 Node.js 20+。

```bash
npm test
# 等价于
node --test test/core.test.mjs
```

当前测试覆盖六层读写、对话隔离、上下文清理/恢复、知识冲突、模型自述确认、事故记录、SQL 路由、RAG 构建、导出、面板数据组装，以及本地引擎的 GGUF 发现和 llama.cpp 启动参数等。

全套 181 个用例。Node 20 上 16 项依赖 `node:sqlite`、zstd 或 git 的用例会 skip（165 pass / 16 skip），另有 2 项使用 shell 包装器的引擎用例只在 POSIX 上运行（Windows 上 163 pass / 18 skip）；Node 22.15+ 全量。CI 同时跑 Node 20 与 22。新用例若依赖运行时能力，用 `t.skip()` 标注原因，保持这条边界可核对。

主要代码：

```text
index.js                  # 插件入口和六个工具
lib/session-repair.js     # DSH 会话日志体检与修复（zstd 多帧、格式校验、备份/原子写回）
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
test/core.test.mjs        # 测试
```

---
