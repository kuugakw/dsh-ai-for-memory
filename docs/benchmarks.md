# 规模压测

用于观察 JSON 存储层在较大语料下的实际耗时，不是单元测试。脚本：`scripts/bench-scale.mjs`。检索质量（是否找得到）见 [记忆召回基准](recall-benchmark.md)。

```bash
node scripts/bench-scale.mjs --docs=3000 --contexts=20
node scripts/bench-scale.mjs --docs=10000 --contexts=20
node scripts/bench-scale.mjs --docs=30000 --contexts=20
node scripts/bench-scale.mjs --docs=3000 --contexts=20 --json
```

默认 3000 篇知识、20 个上下文存档、10 个会话（每个 20 条知识）；`--keep` 保留临时库，`--json` 输出机器可读结果。脚本只用本地规则，不联网、不启动 llama.cpp。

## 曲线（2026-11-28，Windows / Node 26.13，NTFS 临时目录）

| 操作 | 3,000 篇 | 10,000 篇 | 30,000 篇 |
|---|---:|---:|---:|
| `documents()` 冷启动 | 3,107 ms | 5,726 ms | 18,585 ms |
| `documents()` 热 | 0 ms | 0 ms | 0.1 ms |
| BM25 冷（首次建索引） | 304 ms | 355 ms | 1,138 ms |
| BM25 热 | 0.1 ms | 0 ms | 0 ms |
| hybrid 首次 | 64 ms | 150 ms | **19,445 ms** |
| hybrid 第二次 | — | — | 0.1 ms |
| SQL 分类统计 | 67 ms | 59 ms | **22,320 ms** |
| SQL 原始 SELECT 50 行 | 14 ms | 8 ms | 73 ms |
| 导出知识 JSON | 14 ms | 16 ms | 228 ms |

30k 的 hybrid 与 SQL 是**明显的非线性悬崖**，不是文档里“线性外推”的 30 s 冷启动那么简单；同一台机器上 10k 的 SQL 还是 59 ms。

## 怎么看这些数字

- **冷启动基本线性**：约 0.6 ms/篇（3k 3.1 s、10k 5.7 s、30k 18.6 s），主要花在逐文件 stat/read 与 JSON 解析。面板首次打开大库要等这段，之后 `documents()` 命中进程内缓存为 0 ms。
- **BM25 冷建索引也基本线性**：0.1–0.3 ms/篇；热查询不受规模影响。
- **hybrid 在 30k 出现悬崖**：首次 19.4 s、第二次 0.1 ms，说明不是查询本身贵，而是首次为候选文档构建向量/分词缓存时被内存或缓存淘汰拖慢。已经做了两处低风险优化（`auto` 不再预先给全库建向量；向量复用 BM25 的分词缓存），但没有消除悬崖。30k 不能按“能跑”宣传。
- **SQL 在 30k 同样异常**：分类统计 22.3 s，而 10k 只有 59 ms；需要单独 profiling，优先怀疑 SQLite 建库/插入时的内存压力，而不是 SQL 文本。
- 导出是纯内存拼装，30k 约 15 MB / 228 ms；瓶颈在磁盘写，不在序列化。
- 脚本内置宽松上限（冷检索 8 s、热检索 500 ms、原始 SQL 8 s）；30k 会超过这些上限，属于已知问题，不是脚本误报。

## 结论

3k 是当前可接受规模；10k 冷启动已到 5–6 s；**30k 还没有达到可用标准**，hybrid 与 SQL 需要单独定位并优化后再写进“支持规模”。

未纳入：RAG 索引构建（需要真实 Embedding 模型）、llama.cpp 启停（需要 GGUF 与可执行文件）、多进程并发写（已有锁与并发测试覆盖）。
