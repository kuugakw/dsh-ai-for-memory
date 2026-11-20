# MCP 出口

AI for Memory 可以把自己的知识库、统计和上下文存档暴露成一个 **MCP 服务**，让 Claude Desktop、Cursor、脚本或其他 MCP 客户端直接读取；不需要额外进程，也不需要把记忆目录同步到别处。

## 地址

MCP 端点跑在当前 DSH Web 监听器上：

```text
http://127.0.0.1:<DSH 端口>/ai-for-memory/mcp
```

面板「设置 → 使用与存储设置 → MCP 出口」会显示当前完整地址，并可用开关启用/停用。默认启用，只接受回环地址（`127.0.0.1` / `localhost` / `::1`）和可信 Host；这层校验与面板 API 相同，用来防止 DNS rebinding。

传输是 **Streamable HTTP + JSON-RPC 2.0**，无状态：向该地址 POST 一个 JSON-RPC 请求，读取 JSON 响应。不支持 stdio。

## 工具

| 工具 | 作用 |
|---|---|
| `aim_roots` | 列出已登记的记忆根目录，先选 `root` |
| `aim_search` | 检索知识库（默认跨对话 + 共享层） |
| `aim_remember` | 向**共享层**写一条知识；MCP 写入不会落到临时会话 |
| `aim_status` | 查看分层统计 |
| `aim_context_list` | 列出上下文存档，找到 `context_id` |
| `aim_context_restore` | 读取存档并返回文本；只返回，不注入 DSH 对话 |

除 `aim_roots` 外，工具都接受可选 `root`。省略时使用最近登记/配置的根目录；传了未登记的路径会直接报错，不会读取任意目录。

`aim_search` 的 `scope` 支持 `all` / `session` / `shared`。MCP 没有“当前 DSH 对话”，所以 `session` 只对应 MCP 自己的临时会话；跨对话检索请用 `all`。

## 客户端配置

具体字段名随客户端版本不同，核心是一个 HTTP MCP 地址。例如：

```json
{
  "mcpServers": {
    "ai-for-memory": {
      "type": "http",
      "url": "http://127.0.0.1:61470/ai-for-memory/mcp"
    }
  }
}
```

把端口换成面板显示的实际端口。通过 DSH 自己的 MCP 客户端接入时，使用 `transport: streamable-http` 和同一个 `url`。

## 访问令牌

默认只依赖回环地址保护。如果 DSH 监听器经过本地反向代理，或你希望多一道门，可在面板填写 **访问令牌**；之后客户端必须带：

```http
Authorization: Bearer <token>
```

令牌只保存在本机配置里，面板只显示“是否已设置”，不回显明文。留空保存表示保持原值，填 `-` 表示清除。

## 手动验证

先取根目录和工具列表：

```bash
curl -s http://127.0.0.1:61470/ai-for-memory/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

再检索一次：

```bash
curl -s http://127.0.0.1:61470/ai-for-memory/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"aim_search","arguments":{"query":"发布流程"}}}'
```

如果启用了令牌，加上对应 `Authorization` 头。
