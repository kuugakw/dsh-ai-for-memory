# 本地模型目录（手动放置）

AI for Memory **不在插件进程里加载权重、也不做模型推理**。这里用于登记你已经启动好的本地模型服务，例如：

- llama.cpp / llama-server
- Ollama
- LM Studio
- vLLM
- 其他 OpenAI 兼容服务

推荐用这些成熟工具启动模型，然后通过 API 接入插件。插件只负责发现目录、读取 `model.json`、把地址和模型名填到面板。

## 目录结构

```text
models/
├── Embedding/
│   └── bge-m3/
│       └── model.json
├── Rerank/
│   └── bge-reranker/
│       └── model.json
├── Routing/
│   └── my-router/
│       └── model.json
└── 未来能力/
    └── 某个模型/
        └── model.json
```

`Embedding`、`Rerank` 是当前插件自己会使用的两类；`Routing` 是给后续模型路由预留的分类；以后新增能力时直接新建目录即可，插件会按目录名显示，不要求改代码。

## model.json 模板

```json
{
  "name": "bge-m3（本地）",
  "baseUrl": "http://127.0.0.1:8080",
  "model": "bge-m3"
}
```

- `name`：面板显示的标签，可省略，默认用文件夹名；
- `baseUrl`：已经启动的 OpenAI 兼容服务地址；
- `model`：请求里使用的模型名，可省略，默认用文件夹名。

没有 `model.json` 的文件夹也会显示，但面板会标记“未配置 API”，不能用它一键填入地址。

## 为什么不在插件内推理

模型加载、量化、显存/内存管理、批处理和多平台二进制都比本插件更专业。把推理交给 llama.cpp、Ollama、LM Studio 等工具，插件只通过 API 使用结果，失败时还能回退本地确定性检索。

**不要把大型权重文件提交到本仓库。** 这个目录默认只放你本机的 `model.json` 和小型说明文件。
