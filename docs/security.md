# 隐私与安全

> 返回 [主 README](../README.md)。

- 记忆默认保存在本地，不需要联网；
- 面板 API 只接受回环连接，且要求 `Host` 是字面量回环地址（`127.0.0.1` / `localhost` / `[::1]`，端口与监听端口一致）、`Origin` 同源；`Host` 为外部域名时直接 403，防 DNS rebinding；
- 跨对话默认关闭，需要你在面板里逐个开放；
- 上下文存档包含完整对话，可能包含敏感信息，请务必排除出 Git；
- 外部模型模式会把相关内容发送到你配置的服务；敏感项目优先使用本地 Ollama / LM Studio / llama.cpp；
- API Key 只保存在本机配置里，面板只显示“是否已保存”，不会把密钥回读给浏览器；
- **MCP 出口默认开启**，只接受回环监听器；它不是浏览器会话，本机进程可直接 POST，因此额外使用 `$DSH_HOME/ai-for-memory/mcp-token` 自动令牌，所有 MCP 请求都必须带 `Authorization: Bearer`。不需要时在面板关闭；
- MCP 的 `aim_remember` 固定写共享层，标记 `source: mcp`、`provenance: model`，面板显示 **MCP** 标记，仍按模型自述处理；
- 模型写入的知识默认未确认，不会直接当作项目事实。

---
