# 本地模型目录（手动放置）

插件本身不下载权重。这个目录是插件自带的**示例/可选扫描源**；真正属于你的配置应放在 `$DSH_HOME/ai-for-memory/models/`（默认 `~/.dsh/ai-for-memory/models/`），更新插件时不会丢失。

支持的布局（用户目录和插件目录都适用）：

```text
models/
├── Embedding/
│   └── bge-m3/
│       ├── model.json
│       └── bge-m3-Q8_0.gguf
├── Rerank/
│   └── bge-reranker-v2-m3/
│       ├── model.json
│       └── bge-reranker-v2-m3-Q8_0.gguf
└── Routing/
    └── ...
```

用户目录中的同名模型优先于插件自带的 `models/`。

## model.json

### 直接连接已启动的服务

```json
{
  "name": "bge-m3（本地服务）",
  "baseUrl": "http://127.0.0.1:8080",
  "model": "bge-m3"
}
```

### 由插件启动本地引擎

```json
{
  "name": "BGE-M3（GGUF）",
  "engine": "llama.cpp",
  "model": "bge-m3",
  "pooling": "cls",
  "modelPath": "bge-m3-Q8_0.gguf"
}
```

- `engine`：目前支持 `llama.cpp`。有 `.gguf` 时默认即为它。
- `modelPath`：相对于模型文件夹的 GGUF 路径；省略时自动查找文件夹里的 `.gguf`。
- `binary`：`llama-server` 可执行文件；省略时用 `DSH_LLAMA_SERVER` / `LLAMA_SERVER` 环境变量，再退回 PATH 里的 `llama-server`。
- `pooling`：Embedding 模型的池化方式，BGE-M3 建议 `cls`。
- `ctxSize`：上下文长度，默认 8192。
- `port`：指定端口；省略时自动选一个空闲的 loopback 端口。
- `extraArgs`：额外传给 `llama-server` 的参数数组。
- `startupTimeoutMs`：启动等待时间，默认 120 秒。

面板「模型与检索」里的本地模型卡片会显示「已发现 GGUF（本地引擎）」，点击「启动引擎并填入」后，插件会启动：

```text
llama-server -m <gguf> --host 127.0.0.1 --port <空闲端口> --ctx-size 8192 \
  --embeddings --pooling cls
```

Rerank 模型使用 `--reranking`，例如：

```json
{
  "name": "BGE Reranker v2 m3（GGUF）",
  "engine": "llama.cpp",
  "model": "bge-reranker-v2-m3",
  "modelPath": "bge-reranker-v2-m3-Q8_0.gguf"
}
```

启动完成后填入地址和模型名，**仍需要点一次「保存设置」**；保存会自动重载插件。

## 为什么不在 Node 里做张量推理

BGE-M3 是 5 亿级参数模型，纯 JS 推理既慢又需要自己实现 tokenizer、RoPE、attention 和权重加载；本插件选择管理成熟的 [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` 进程，再走已有的 OpenAI 兼容 Embedding/Rerank 客户端。插件不会下载权重，也不会把大文件提交到仓库。

感谢 ggml-org 和所有 llama.cpp 贡献者：本地推理能力建立在他们长期维护的推理引擎之上。
