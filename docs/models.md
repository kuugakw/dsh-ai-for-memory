# 模型与本地推理引擎

> 返回 [主 README](../README.md)。

## 外部模型设置

- 常用服务预设；
- 主服务、Embedding、Rerank 三组地址和 Key；
- 超时时间；
- 归档 / 知识库提炼 / 上下文清理三个“本地规则 | 外部模型”开关；
- 「测试连接」会先保存当前表单，再请求服务探测能力。

## 本地模型文件夹

模型配置放在**用户目录** `$DSH_HOME/ai-for-memory/models/`（未设置 `DSH_HOME` 时为 `~/.dsh/ai-for-memory/models/`），插件更新不会覆盖；插件自带的 `models/` 只作为可选的示例/扫描源：

```text
$DSH_HOME/ai-for-memory/models/
├── Embedding/
│   └── bge-m3/
│       ├── model.json
│       └── bge-m3-Q8_0.gguf
├── Rerank/
│   └── bge-reranker-v2-m3/
│       ├── model.json
│       └── bge-reranker-v2-m3-Q8_0.gguf
├── Routing/
│   └── my-router/
│       └── model.json
└── 未来能力/
    └── 某个模型/
        └── model.json
```

`model.json` 里的 `extraArgs`、`ctxSize`、`port`、`binary` 是机器相关配置，必须放在这个用户目录，不要放插件安装目录。用户目录中的同名模型优先于插件自带的 `models/`。

直接连接已经启动的本地服务：

```json
{
  "name": "bge-m3（本地服务）",
  "baseUrl": "http://127.0.0.1:8080",
  "model": "bge-m3"
}
```

交给插件启动本地 llama.cpp 引擎：

```json
{
  "name": "BGE-M3（GGUF）",
  "engine": "llama.cpp",
  "model": "bge-m3",
  "pooling": "cls",
  "modelPath": "bge-m3-Q8_0.gguf"
}
```

Rerank 示例：

```json
{
  "name": "BGE Reranker v2 m3（GGUF）",
  "engine": "llama.cpp",
  "model": "bge-reranker-v2-m3",
  "modelPath": "bge-reranker-v2-m3-Q8_0.gguf"
}
```

- `Embedding` 和 `Rerank` 是插件当前使用的两类；
- `engine` 目前支持 `llama.cpp`；有 `.gguf` 时默认即为它；
- `binary` 可指定 `llama-server`，省略时用 `DSH_LLAMA_SERVER` / `LLAMA_SERVER` 环境变量，再退回 PATH；
- `modelPath` 相对于模型文件夹；省略时自动找文件夹里的 `.gguf`；
- `pooling` 用于 Embedding，BGE-M3 建议 `cls`；`ctxSize` 默认 8192；`port` 省略时自动选空闲端口；
- 面板里点「启动引擎并填入」会启动 `llama-server`，再填入地址和模型名，仍需点「保存设置」；
- 启动失败时插件保留 `llama-server` 的 stderr/stdout 尾部、实际启动命令和按日志识别的修复提示（GGUF 版本、`--reranking`、`--pooling`、OOM、路径问题等），面板的「启动失败诊断」会一直显示，不用去终端手敲参数；
- 每次启动会把 `{pid, port, model, modelPath, baseUrl, command, startedAt, fingerprint}` 写入 `models/.engine.lock`；插件重新加载/DSH 重启后先探测该端口的 `/health`、`/props`（必要时 `/v1/models`），模型路径或名称对得上就接管进「模型」页，端口已被占用时不会再起第二份；对不上只清理锁文件，不杀未知进程；
- `model.json` 或 GGUF 的 `mtime+size` 变化后，已在运行的引擎会被标记为 stale，下一次启动返回 `stale: true` 并拒绝复用；先停止旧引擎，再启动新配置；
- `Routing` 是给后续模型路由预留的分类，目前只显示、不能启动本地引擎、不参与调用；对 `Routing` 调用 `/local-engine/start` 会被拒绝；
- 没有 `model.json` 的文件夹也会显示，但标记为“未配置 API”。

**重要：插件不在 Node 进程里做张量推理，也不下载权重。** 本地引擎管理的是 `llama-server` 子进程：Embedding 用 `--embeddings --pooling cls`，Rerank 用 `--reranking`；插件再通过已有的 OpenAI 兼容客户端调用它。请把 GGUF 放在模型文件夹里，不要把大型权重提交到仓库。

## 关于 llama.cpp

本地推理引擎建立在 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` 之上。感谢 ggml-org 以及所有 llama.cpp 贡献者：他们让普通机器上的本地 Embedding 和 Rerank 成为可能，也让这个插件可以坚持“不下载模型、不依赖云服务”的选择。
