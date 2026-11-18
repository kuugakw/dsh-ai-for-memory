# Rerank 模型

把一个本地 rerank 模型文件夹放在这里，并在文件夹内放 `model.json`：

```json
{
  "name": "bge-reranker（本地）",
  "baseUrl": "http://127.0.0.1:8080",
  "model": "bge-reranker"
}
```

插件不会在这里运行推理；`baseUrl` 应指向已经启动并支持 rerank 接口的 OpenAI 兼容服务。
