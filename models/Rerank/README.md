# Rerank 模型

放一个本地 rerank 模型文件夹在这里。推荐 BGE Reranker v2 m3 的 GGUF：

```text
Rerank/bge-reranker-v2-m3/
├── model.json
└── bge-reranker-v2-m3-Q8_0.gguf
```

`model.json`：

```json
{
  "name": "BGE Reranker v2 m3（GGUF）",
  "engine": "llama.cpp",
  "model": "bge-reranker-v2-m3",
  "modelPath": "bge-reranker-v2-m3-Q8_0.gguf"
}
```

插件启动时使用 `llama-server --reranking`。没有 GGUF 时，也可以填写已经支持 `/v1/rerank` 的本地服务地址。

插件不下载权重。
