# 网络同步（Git）

> 返回 [主 README](../README.md)。

用于多人项目：每台设备是同一份 Git 仓库的工作副本，主机提供 SSH/HTTP remote，其他设备 **上传** 时推送到主机，**拉取** 时从主机取回。

- **默认关闭**：不启用时不会执行任何网络命令；
- 本机角色可设为「主机」或「非主机」；主机地址填 `ssh://user@host/path/memory.git`、HTTPS Git 地址，或从 `git remote -v` 复制的 `git@host:path/memory.git`；
- 同一局域网设备填同一个「项目组」名称，便于识别；
- 传输层使用已有 SSH/HTTP remote，插件**不启动**未认证的 Git daemon；认证、SSH key、端口由你的 Git 环境管理；
- 同步内容由用户勾选：知识库、归档、决策、快照、过程记录、上下文、全部对话目录；
- 默认只选知识库、归档、决策、快照；
- `contexts/` 包含完整对话，勾选前请确认网络和权限可信；
- `_usage.json`、RAG 索引、`knowledge.sqlite`（含 WAL/SHM）、`compaction_status.json`、导出目录和 `.sync/` 本地设置不会同步；
- **上传** = 提交本地变化 + `git push`；
- **拉取** = `git fetch` + `git merge --ff-only`；
- 同步仓库固定使用 `main` 分支，不继承本机 `init.defaultBranch`；已有仓库若停在 `master`，会明确提示先执行 `git branch -m main`，不会静默推出第二个分支；
- 拉取前先确认 `origin/main` 存在；不存在时列出远端现有分支，并说明是分支名不一致，而不是误报“本地已分叉”；
- 推送失败或远端已有其他分支时，会列出远端分支；
- 面板状态中的 `ahead` / `behind` 来自 `git rev-list --count --left-right HEAD...@{upstream}`，没有 upstream 时为 0；
- 上传被拒或拉取不能 fast-forward 时停止并报告，不自动合并、不覆盖本地；
- 主机和普通设备都使用同一个 remote；主机角色只用于组织项目组和操作方向。

Git 仓库建在当前记忆目录根部，本地同步配置放在 `.sync/config.json`，该目录不会进入同步。默认记忆目录位于项目仓库内时，初始化会把该目录加入父仓库的 `.git/info/exclude`（只在本机生效、不提交），避免项目 `git add .` 把它当成 embedded repository；不会改写项目的 `.gitignore`。

**记忆根本身已经是一个 Git 仓库时，插件不会直接接管它。** 新建同步仓库会写入 `.sync/owned` 标记；只有带这个标记、或首个提交是 AI for Memory 旧版同步提交的仓库才允许继续。否则 `initSync` / 推送会拒绝，并提示把记忆根移到独立目录——避免往用户项目的 `.git/info/exclude` 写整块规则、把记忆提交叠进项目历史、或把项目已跟踪文件推到同步远端。

取消勾选某个同步层后，下次提交会用 `git rm -r --cached` 把该层已跟踪的文件移出索引（工作区文件不删除），只提交仍勾选的层；不会因为文件已经 tracked 就继续上传。

**允许所有层都不勾选。** 空集合会原样保存，不会静默恢复默认四项；此时 `commitSync` / `pushSync` / `pullSync` 直接返回 `stopped: true` 和“已停止同步：没有勾选任何同步层”，不再操作仓库或网络。

## 设置

常规设置保存后会自动重载插件并刷新面板，不需要手动重载。如果重载较慢，会显示“仍在自动重载，稍后会刷新”。网络同步设置只写入当前记忆目录的 `.sync/config.json`，保存后立即生效，不需要重载插件。

---
