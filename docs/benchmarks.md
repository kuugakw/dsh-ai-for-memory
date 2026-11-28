# 规模压测

用于观察 JSON 存储层在较大语料下的实际耗时，不是单元测试。脚本：`scripts/bench-scale.mjs`。检索质量（是否找得到）见 [记忆召回基准](recall-benchmark.md)。

```bash
node scripts/bench-scale.mjs --docs=3000 --contexts=20
node scripts/bench-scale.mjs --docs=3000 --contexts=20 --json
```

默认 3000 篇知识、20 个上下文存档、10 个会话（每个 20 条知识）；`--keep` 保留临时库，`--json` 输出机器可读结果。脚本只用本地规则，不联网、不启动 llama.cpp。

## 最近一次结果

环境：Windows、Node 26.13，临时目录（NTFS），2026-11-28。

| 操作 | 耗时 |
|---|---:|
| `store.init` | 27.4 ms |
| `documents()` 冷启动（3000 篇） | 3107.3 ms |
| `documents()` 热 | 0 ms |
| BM25 检索 冷（首次建索引） | 304.3 ms |
| BM25 检索 热 | 0.1 ms |
| hybrid 检索 热 | 64.2 ms |
| SQL 分类统计 | 67.3 ms |
| SQL 原始 SELECT 50 行 | 14.0 ms |
| 导出知识 JSON（约 1.5 MB） | 13.6 ms |
| 导出知识 Markdown | 17.4 ms |
| `listContexts()`（20 个存档） | 26.3 ms |
| `listSessions()`（10 × 20） | 5.3 ms |
| `saveContext()` 平均 | 19.8 ms |

## 怎么看这些数字

- **冷启动的 3.1 s 主要花在 3000 次文件 stat/read 与 JSON 解析上**，不是检索；之后 `documents()` 命中进程内缓存为 0 ms。面板首次打开大库会有这段等待，刷新不会重复付费。
- **检索热路径很快**：BM25 0.1 ms、hybrid 64 ms（哈希向量 + 候选融合）；首次 BM25 需要建倒排，3000 篇约 300 ms。
- SQL 每次都从 JSON 重建内存库；分类统计 67 ms、50 行原始查询 14 ms，属于可接受范围；更大的库建议用 SQLite 镜像（`knowledgeBackend: sqlite`）并把 SQL 当分析通道。
- 导出是纯内存拼装，1.5 MB JSON 约 14 ms；瓶颈在写盘，不在序列化。
- 脚本内置宽松上限（冷检索 8 s、热检索 500 ms、原始 SQL 8 s），超过时以非零退出，方便在慢机器上发现回归；日常 CI 不跑这个脚本，发布前手动跑一次并更新本页。

未纳入：RAG 索引构建（需要真实 Embedding 模型）、llama.cpp 启停（需要 GGUF 与可执行文件）、多进程并发写（已有锁与并发测试覆盖）。
