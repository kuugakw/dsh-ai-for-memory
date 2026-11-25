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

`model.json` 里的 `extraArgs`、`ctxSize`、`port`、`binary` 是机器相关配置，必须放在这个用户目录，不要放插件安装目录。用户目录中的同名模型优先于插件自带的 `models/`。启动成功的本地 Embedding / Rerank 引擎会自动成为对应端点的回退：未配置外部 Embedding/Rerank 地址，或地址仍是旧的 loopback 端口时，检索、RAG、promote/archive 等调用会直接使用运行中的本地模型；显式配置的云端地址优先，不会被本地引擎覆盖。

也可以把 `.gguf` 直接丢在 `models/` 根目录：面板会把它列在 **Loose** 分类下，按文件名推断类型（`embedding` / `bge-m3` / `jina-embeddings` → Embedding；`rerank` / `reranker` / `cross-encoder` → Rerank）。推断只用于提示，不是事实；识别不出来时面板会显示「未识别」，必须由用户点「标为 Embedding」或「标为 Rerank」。用户标记和根目录模型的 ctx/port 存在 `models/.model-meta.json`，不会改写 GGUF。

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
- `modelPath` 相对于模型文件夹；省略时自动找文件夹里的 `.gguf`；面板「llama.cpp → 高级设置」可直接改，不用手写 `model.json`；
- `pooling` 用于 Embedding，BGE-M3 建议 `cls`；`ctxSize` 默认 2048（可调，面板每个本地模型旁有 `ctx-size` 输入框；embedding 实际输入很短，过大的 ctx 会白占常驻 KV cache）；`port` 省略时自动选空闲端口；端口被抢占（`EADDRINUSE`）时自动换端口重试最多 3 次，显式 `port` 不重试；
- 面板里点「启动引擎并填入」会启动 `llama-server`，再填入地址和模型名，仍需点「保存设置」；
- 生命周期默认是「常闭」：启动/停止都是显式操作，插件加载时只接管本 profile 锁记录里的 `llama-server`，不会自动启动；**插件关闭再打开（调试）或保存设置后的重载不会停掉它们**，只有 DSH 正常退出（关闭窗口 / 退出应用）时，插件才在进程退出前停掉自己启动的引擎；接管来的进程不按裸 PID 强杀，停止前按命令行身份重新确认。DSH 被强制结束（任务管理器、崩溃）时子进程可能残留，下次启动会先读**带本 profile owner 的锁**接管；锁文件也丢了时，只扫描**当前 DSH 进程直接 spawn** 的 `llama-server`，把模型路径在当前模型目录下的进程重新接管，不会认领用户手起或别的 profile 启动的进程。跨 DSH 重启且锁丢失的孤儿进程不会被自动认领，这是为了不把未知进程写进本实例的可停止列表；
- 本地模型存在、但某一类引擎没开启时，打开面板会弹一次提醒「检测到 … 模型，但还没有开启模型」；常闭模式下它只提醒、不自动拉起，到「设置 → 模型」点「启动这个模型」即可，启动后提醒消失；
- 启动失败时插件保留 `llama-server` 的 stderr/stdout 尾部、实际启动命令和按日志识别的修复提示（GGUF 版本、`--reranking`、`--pooling`、OOM、路径问题等），面板的「启动失败诊断」会一直显示，不用去终端手敲参数；
- 每次启动会把 `{owner, pid, port, model, modelPath, baseUrl, command, startedAt, fingerprint}` 写入 `models/.engine.lock/*.json`；一个模型一个文件（旧版单文件 `.engine.lock` 会在首次保存时自动迁移），并发启动 Embedding/Rerank 不会互相覆盖锁记录；`owner` 是当前 DSH profile 的摘要，两个 profile 共用一个 models 目录时不会互相接管/删锁；插件重新加载/DSH 重载后先探测该端口的 `/health`、`/props`（必要时 `/v1/models`），模型路径或名称对得上就接管进「模型」页，端口已被占用时不会再起第二份；PID 还活着但探测失败时，只有进程命令行仍指向同一模型和端口才保留为可停止状态，否则按过期锁清理且**绝不按旧 PID 杀进程**；停止同样先验证身份，再 SIGTERM，1.5 秒内未退出才 SIGKILL，确认目标消失后才删锁；
- `model.json` 或 GGUF 的 `mtime+size` 变化后，已在运行的引擎会被标记为 stale，下一次启动返回 `stale: true` 并拒绝复用；先停止旧引擎，再启动新配置；
- `Routing` 是给后续模型路由预留的分类，目前只显示、不能启动本地引擎、不参与调用；对 `Routing` 调用 `/local-engine/start` 会被拒绝；
- 没有 `model.json` 的文件夹也会显示，但标记为“未配置 API”。

### 本地引擎运行方式（`engineLifecycle`）

在「设置 → llama.cpp」里选择，保存后立即生效；只对磁盘上能被插件启动的 `Embedding` / `Rerank` 模型生效（有 GGUF、`llama-server` 可执行、分类受支持）。

| 取值 | 面板 | 行为 |
|---|---|---|
| `manual` | 常闭 | 只有点击「启动 / 停止」才改变；插件不自动启动或停止。默认值。 |
| `always` | 常开 | 插件加载时启动所有可运行模型，并在每轮开始前确保它们在运行；不会在轮末停止。面板手动停止后，下一次轮开始会重新拉起。 |
| `turn` | 每轮开关 | 每轮第一个模型请求前启动可运行模型；轮末进入空闲计时，约 2 分钟没有新的主对话轮次后，停止**由这个模式启动**的实例。手动启动（或插件重载后接管）的引擎不在停止范围内。 |

说明：

- **代价**：`turn` 在长时间空闲后需要一次冷启动（1.5 GB 级模型常见几秒到几十秒），连续对话期间模型保持热；`always` 在插件加载后常驻内存/显存。默认 `manual` 正是为了避免这两笔成本——只有确认显存/内存够、且确实需要本地模型时才切过去。
- **短轮次不会杀加载中的模型**：轮末不立即停进程，而是等空闲窗口；即使窗口到期时模型还在加载，停止也会等它就绪后再做，不会把 SIGTERM 记成「启动失败」。
- **检测规则**：模型目录里存在 `.gguf`、`kind` 是 `Embedding`/`Rerank`、`engine` 为空或 `llama.cpp`，才算「可运行」；检测不到时三种模式都只是空转，不会报错。
- **端点可用时跳过**：对每一类模型先看已配置的端点——`externalEmbedBaseUrl` / `externalRerankBaseUrl`，为空时回退 `externalBaseUrl`。只有在端点**确实提供这一类能力**时才跳过本地启动，显式命名和兜底用同一个判据：llama.cpp 看 `/props` 的 `has_embeddings` / `has_reranking`，其他服务向真实端点发一个最小请求，2xx 才算可用；401/404/500 一律算不可用。因此只配了 chat 端点、或显式端点的 key 配错（返回 401）时都不会压住本地 GGUF，而是拉起本地引擎作为后备。跳过原因会写进 `/state`（`localEngineSkips`）并显示在面板对应模型行；端点不可达（连接失败或超时）或根本没配置时照常拉起本地引擎。探测结果按「kind + 地址 + 模型名 + 凭据」缓存：**成功结果在进程内长期有效**（能力不会自己变，也避免对云端按轮计费），失败仍每 5 秒重试（`ENDPOINT_PROBE_TTL_MS`）；缓存上限 64 条。探测本身是短超时（1.2 秒/路径，`ENDPOINT_PROBE_TIMEOUT_MS`），不会阻塞模型请求；面板「测试连接」用的是另一套 5 秒预算，和每轮探测无关。
- **启动是异步的**：模型加载可能几秒到几十秒，`turn`/`always` 不会阻塞模型请求；加载完成前的检索/RAG 会退回确定性路径。
- **失败冷却**：一次启动失败（二进制缺失、GGUF 不兼容、OOM 等）会记一条警告，并在 60 秒内不重试同一个模型，避免每轮反复拉起。
- **子代理不参与**：子代理的轮次不会触发启动或停止，避免它把父对话正在用的引擎关掉。
- **退出**：常开/每轮模式启动的引擎仍然是插件自己的子进程，DSH 正常退出时由插件停掉。

**重要：插件不在 Node 进程里做张量推理，也不下载权重。** 本地引擎管理的是 `llama-server` 子进程：Embedding 用 `--embeddings --pooling cls`，Rerank 用 `--reranking`；插件再通过已有的 OpenAI 兼容客户端调用它。请把 GGUF 放在模型文件夹里，不要把大型权重提交到仓库。

## 关于 llama.cpp

本地推理引擎建立在 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` 之上。感谢 ggml-org 以及所有 llama.cpp 贡献者：他们让普通机器上的本地 Embedding 和 Rerank 成为可能，也让这个插件可以坚持“不下载模型、不依赖云服务”的选择。
