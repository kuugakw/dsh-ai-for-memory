# Routing 模型（预留）

这个目录用于后续的 **模型路由 / 路由模型**。当前版本还没有消费 Routing 模型的逻辑，但模型目录扫描器已经会识别这里：

- 文件夹名 `Routing` 会作为一个独立分类显示在面板；
- 每个子目录可以放一个 `model.json`；
- 后续加入路由功能时，不需要改目录结构。

示例：

```text
models/Routing/
└── my-router/
    └── model.json
```

```json
{
  "name": "my-router",
  "baseUrl": "http://127.0.0.1:8080",
  "model": "my-router"
}
```

和 Embedding / Rerank 一样，这里只登记本地服务地址，不在插件进程内加载权重或运行推理。推荐用 llama.cpp、Ollama、LM Studio 等服务通过 API 提供模型。
