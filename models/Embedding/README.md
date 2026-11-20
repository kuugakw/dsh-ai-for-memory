# Embedding 模型

放一个本地 embedding 模型文件夹在这里。推荐 BGE-M3 的 GGUF：

```text
Embedding/bge-m3/
├── model.json
└── bge-m3-Q8_0.gguf
```

`model.json`：

```json
{
  "name": "BGE-M3（GGUF）",
  "engine": "llama.cpp",
  "model": "bge-m3",
  "pooling": "cls",
  "modelPath": "bge-m3-Q8_0.gguf"
}
```

如果模型服务已经启动，也可以只写：

```json
{
  "name": "BGE-M3（本地服务）",
  "baseUrl": "http://127.0.0.1:8080",
  "model": "bge-m3"
}
```

插件不下载权重；有 GGUF 时，面板可以启动 `llama-server --embeddings --pooling cls`。
