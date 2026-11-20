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
- 上传被拒或拉取不能 fast-forward 时停止并报告，不自动合并、不覆盖本地；
- 主机和普通设备都使用同一个 remote；主机角色只用于组织项目组和操作方向。

Git 仓库建在当前记忆目录根部，本地同步配置放在 `.sync/config.json`，该目录不会进入同步。默认记忆目录位于项目仓库内时，初始化会把该目录加入父仓库的 `.git/info/exclude`（只在本机生效、不提交），避免项目 `git add .` 把它当成 embedded repository；不会改写项目的 `.gitignore`。

## 设置

常规设置保存后会自动重载插件并刷新面板，不需要手动重载。如果重载较慢，会显示“仍在自动重载，稍后会刷新”。网络同步设置只写入当前记忆目录的 `.sync/config.json`，保存后立即生效，不需要重载插件。

---
