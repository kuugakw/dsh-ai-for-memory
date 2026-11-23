# 安装、升级与首次使用

> 返回 [主 README](../README.md)。

AI for Memory 是面向 DSH 的项目级记忆插件。下面从排除记忆目录开始，完成安装和第一次使用。

## 安装

### 1. 把记忆目录排除出 Git

默认记忆目录是工作区下的 `.ai-for-memory/`。里面可能有完整对话和内部信息，第一次使用前请在你的项目根目录的 `.gitignore` 中加入：

```gitignore
.ai-for-memory/
```

确认：

```bash
git check-ignore -v .ai-for-memory/
```

如果已经提交过，`.gitignore` 不会删除历史记录；需要先 `git rm -r --cached .ai-for-memory`，再视情况轮换密钥或清理历史。

插件只做一层兜底：默认目录首次创建、且 `.gitignore` 已存在时，会尝试追加这条规则；不新建 `.gitignore`，也不会处理自定义目录。项目没有 `.gitignore`、或目录已存在但未被忽略时，`aim_memory status` 和面板会明确警告，不会静默当作已保护。仍然建议你自己确认。

### 2. 安装 bundle

推荐从 npm 安装：

```bash
dsh plugin --profile <profile> add dsh-ai-for-memory@0.5.3
```

`<profile>` 换成你的 DSH profile（例如 `desktop`）。安装后重启 DSH；工具、侧栏入口和面板由 bundle 自动加载。

也可以在 DSH 的 **设置 → 插件 → 添加插件** 中直接填 npm 包名 `dsh-ai-for-memory` 安装。

**从插件索引安装**（DSH 实验特性）：在 **插件 → 实验性插件** 里开启 **Custom plugin indexes**，进入 **发现 → 添加索引源**，填入：

```text
https://kuugakw.github.io/dsh-ai-for-memory/index.json
```

索引里列出 0.5.1 及之后的全部版本，选中版本确认即可安装，不用手输包名。索引文件本身在仓库的 `market/` 目录，由 tag 触发的 `market` workflow 自动更新并发布到 GitHub Pages。

本地开发或离线安装仍然可以用目录：

```text
plugin_manager action=install_bundle target=<dsh-ai-for-memory 目录>
```

安装后应看到：

- 工具：`aim_memory`、`aim_search`、`aim_context`、`aim_decide`、`aim_ask`、`aim_repair`；
- 侧栏入口「AI 记忆」；
- 面板页面，包含六层浏览、外部模型和设置。

环境要求：

- **Node.js 20+** 可以运行插件和本地记忆；
- **DSH 0.2.x**（`>=0.2.0-rc.1 <0.3.0`）；
- **SQL 查询和 SQLite 镜像**需要运行时有 `node:sqlite`（Node 22.5+ 起内置）；
- RAG 需要配置外部 Embedding 和 Rerank 服务，不需要 `node:sqlite`。

### 3. 验证

```text
aim_memory action=status
```

能看到过程记录、归档、快照、知识库、决策、上下文的统计，以及 JSON 底座、SQL 镜像和 RAG 状态，就说明基本可用。

### 4. 升级与卸载

升级前先备份整个记忆目录。

```bash
# 升级到当前 npm 最新版
dsh plugin --profile <profile> add dsh-ai-for-memory@latest
```

安装后重启 DSH。旧 bundle 也可以先在「设置 → 插件」里移除，再重新安装；不建议只替换文件。

卸载：

```bash
dsh plugin --profile <profile> remove dsh-ai-for-memory
```

用 `plugin_manager` 安装的本地目录，仍用 `plugin_manager action=remove_bundle target=dsh-ai-for-memory` 卸载。

旧的根目录数据会留在共享层；旧对话目录会在下次使用或下一轮结束时补上元数据。旧版 RAG 单文件索引不再读取，需要重新建立。

---

## 第一次使用

下面是一组最小示例。

```text
# 1. 记一条过程记录；verify=pass 的记录才容易被自动提炼
aim_memory action=stage content="修复了导出中文文件名 500 的问题" kind=error verify=pass

# 2. 归档过程记录
aim_memory action=archive

# 3. 写一条知识
aim_memory action=remember text="发布前必须跑 node --test test/core.test.mjs" category=workflow_rules

# 4. 检索
aim_search query="发布前要做什么"

# 5. 预览能从各层提炼出什么，不写盘
aim_memory action=promote dry_run=true

# 6. 上下文清理（先存档，之后可 restore）
aim_context action=save name=before-cleanup
aim_context action=clear
```

注意：第 3 步写入的知识默认是**未确认的模型自述**。到面板知识库页，确认无误后点「确认这条」，它才会变成已确认事实。

---
