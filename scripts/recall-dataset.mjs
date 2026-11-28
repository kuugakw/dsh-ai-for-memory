/**
 * Ground truth for the recall benchmark: a small, deliberately adversarial
 * corpus of project memories. Each query names one verified target; some
 * topics also include a plausible near-miss, an unverified model claim, or a
 * distractor that repeats the query's words with the wrong answer.
 *
 * Keep this dataset in the repository (not in a test temp dir) so a ranking
 * change can be compared against the same 20 queries.
 */

const AT = '2026-11-20T08:00:00.000Z';

function doc(id, text, category, extra = {}) {
  return {
    schema_version: 2,
    doc_id: id,
    text,
    category,
    source: extra.source ?? 'user-confirmed',
    tags: extra.tags ?? [],
    url: '',
    confidence: extra.confidence ?? 0.9,
    provenance: extra.provenance ?? 'user',
    confirmed: extra.confirmed ?? true,
    verified: extra.verified ?? true,
    evidence: extra.evidence ?? [{ kind: 'authored', ref: 'recall-benchmark' }],
    changes: extra.changes ?? [],
    created_at: AT,
    updated_at: extra.updatedAt ?? AT,
    revision: 1,
  };
}

export const DOCS = [
  doc('k_port_fixed', '本地 llama-server 的服务端口固定为 8081，只绑定 127.0.0.1，重启后端口不变。', 'tools_apis', { tags: ['端口', 'llama-server'] }),
  doc('k_port_random', '测试环境的服务端口由系统随机分配，每次启动都不同，日志里会打印实际端口。', 'tools_apis'),
  doc('k_port_9090', '服务端口固定为 9090，这是最新配置。', 'tools_apis', {
    source: 'mcp', provenance: 'model', confirmed: false, verified: false,
  }),

  doc('k_cleanup_archive', '上下文清理会先把整轮压成存档，再从上下文里清出，清出的内容可以 restore 调回。', 'workflow_rules', { tags: ['清理', '存档'] }),
  doc('k_cleanup_delete', '手动删除记忆目录会直接删掉当前语料，不经过归档和备份。', 'errors_fixes'),
  doc('k_cleanup_drop', '上下文清理会直接丢弃旧轮次，不生成存档。', 'workflow_rules', {
    source: 'staging', provenance: 'model', confirmed: false, verified: false,
  }),

  doc('k_redact_tokens', '写入知识库前会脱敏 GitHub token、API key 和 Authorization 头，明文不落盘。', 'security', { tags: ['脱敏', 'token'] }),
  doc('k_redact_logs', '排查问题时把完整 token 写进日志最方便，脱敏会丢信息。', 'errors_fixes'),

  doc('k_sqlite_mirror', '知识默认存 JSON 文件，SQLite 只是可选的镜像与查询视图，不是唯一数据源。', 'project_facts'),
  doc('k_sqlite_only', 'SQLite 是知识库的唯一数据源，JSON 只是导出格式。', 'project_facts'),

  doc('k_engine_loopback', '本地 llama-server 只绑定 127.0.0.1，extraArgs 也不能改 host 或 port。', 'security', { tags: ['引擎', 'loopback'] }),
  doc('k_engine_lan', '本地引擎可以绑定 0.0.0.0，方便局域网里的其他机器调用。', 'tools_apis'),
  doc('k_engine_any', '引擎默认监听 0.0.0.0:8080。', 'tools_apis', {
    source: 'mcp', provenance: 'model', confirmed: false, verified: false,
  }),

  doc('k_conflict_confirm', '新知识与已有知识冲突时先询问用户，确认后才覆盖旧值，并在 changes 里保留 previous_text。', 'decisions_reasoning'),
  doc('k_conflict_overwrite', '冲突时直接用新值覆盖旧值，不需要确认，旧值也不保留。', 'decisions_reasoning'),

  doc('k_mcp_auth', 'MCP 出口默认关闭，开启后所有请求必须带 Authorization: Bearer 令牌。', 'security', { tags: ['MCP', '令牌'] }),
  doc('k_mcp_open', 'MCP 出口默认开启，本机请求不需要令牌。', 'security'),

  doc('k_restore_tail', 'restore 不整份注入：按 restoreMaxChars 预算从尾部取最近的轮次，分批恢复。', 'workflow_rules', { tags: ['restore', '预算'] }),
  doc('k_restore_all', 'restore 会把整份存档一次性注入上下文，不受预算限制。', 'workflow_rules'),

  doc('k_export_capability', '导出记忆需要显式 capabilityExport 能力，未授权时拒绝并写审计。', 'security'),
  doc('k_export_free', '导出记忆不需要授权，面板上随时可以全量下载。', 'security'),

  doc('k_cross_private', '未开放的对话默认不能被其他对话检索；只有 public 或 viewers 点名后可见。', 'workflow_rules', { tags: ['对话隔离'] }),
  doc('k_cross_public', '所有对话默认互相可见，跨对话检索不需要授权。', 'workflow_rules'),
  doc('k_cross_any', '对话默认对全部工作区公开。', 'workflow_rules', {
    source: 'staging', provenance: 'model', confirmed: false, verified: false,
  }),

  doc('k_rag_models', 'RAG 索引需要同时配置 Embedding 和 Rerank 两个模型，缺一个就不可用。', 'tools_apis'),
  doc('k_rag_bm25', 'RAG 只用 BM25 就能工作，不需要 Embedding 或 Rerank。', 'tools_apis'),

  doc('k_snapshot_state', '快照保存精确 state 对象，restore 按 snapshot_id 恢复；上下文存档是另一层。', 'ui_facts'),
  doc('k_snapshot_archive', '快照就是归档的副本，restore 只能恢复最近一次归档。', 'ui_facts'),

  doc('k_provenance_penalty', '未确认的模型自述在检索排序中被降权，面板用黄色标记提示确认。', 'decisions_reasoning', { tags: ['provenance', '排序'] }),

  // Unrelated but plausible project memories: they keep the corpus from being
  // a keyword lookup table and give the ranker something to reject.
  doc('k_tool_pnpm', '工作区使用 pnpm 管理依赖，Node 版本要求 22.15 以上。', 'tools_apis'),
  doc('k_tool_release', '发布前需要跑 npm test、npm run check 和 typecheck。', 'workflow_rules'),
  doc('k_ui_theme', '面板的深色主题跟随 DSH 设置，不单独保存。', 'ui_facts'),
  doc('k_taxonomy', '知识分类固定为九类，事故单独归入 incidents。', 'ui_facts'),
  doc('k_mcp_shared', 'MCP 工具 aim_remember 固定写共享层。', 'workflow_rules'),
  doc('k_sql_guard', 'SQL 路由会拒绝 sqlite_master 和 pragma 查询。', 'security'),
  doc('k_export_dir', '导出文件默认写入记忆目录的 exports 子目录。', 'workflow_rules'),
  doc('k_shared_layer', '对话隔离的共享层所有对话可读。', 'workflow_rules'),
  doc('k_topical_clear', '自动整理每四轮运行一次，按话题相似度清理。', 'workflow_rules'),
  doc('k_snapshot_redact', '快照文件脱敏后保存，恢复前会校验结构。', 'security'),
  doc('k_model_gguf', '本地模型权重不随插件下载，需要用户自己放 GGUF。', 'tools_apis'),
  doc('k_cache_lru', '检索缓存按条数和 64MB 预算 LRU 淘汰。', 'project_facts'),
];

export const QUERIES = [
  { id: 'q-port-exact', text: '服务端口 8081', target: 'k_port_fixed', kind: 'exact' },
  { id: 'q-cleanup-exact', text: '上下文清理 存档', target: 'k_cleanup_archive', kind: 'exact' },
  { id: 'q-redact-exact', text: 'GitHub token 脱敏', target: 'k_redact_tokens', kind: 'exact' },
  { id: 'q-sqlite-exact', text: 'SQLite 镜像', target: 'k_sqlite_mirror', kind: 'exact' },
  { id: 'q-engine-exact', text: 'llama-server 绑定 127.0.0.1', target: 'k_engine_loopback', kind: 'exact' },
  { id: 'q-conflict-exact', text: '冲突 确认 previous_text', target: 'k_conflict_confirm', kind: 'exact' },
  { id: 'q-mcp-exact', text: 'MCP Bearer 令牌', target: 'k_mcp_auth', kind: 'exact' },
  { id: 'q-restore-exact', text: 'restore 预算 尾部', target: 'k_restore_tail', kind: 'exact' },

  { id: 'q-conflict-para', text: '旧值被替换前会不会先问我', target: 'k_conflict_confirm', kind: 'paraphrase' },
  { id: 'q-redact-para', text: '凭据在写进文件前怎么处理', target: 'k_redact_tokens', kind: 'paraphrase' },
  { id: 'q-engine-para', text: '本机服务的监听地址被限制在哪', target: 'k_engine_loopback', kind: 'paraphrase' },
  { id: 'q-sqlite-para', text: '知识到底存在哪种文件里', target: 'k_sqlite_mirror', kind: 'paraphrase' },
  { id: 'q-cleanup-para', text: '清出的旧轮次还能拿回来吗', target: 'k_cleanup_archive', kind: 'paraphrase' },
  { id: 'q-cleanup-para2', text: '清理前先把历史放到哪里', target: 'k_cleanup_archive', kind: 'paraphrase' },

  { id: 'q-sqlite-trap', text: 'SQLite 是唯一数据源吗', target: 'k_sqlite_mirror', kind: 'trap' },
  { id: 'q-engine-trap', text: '引擎可以绑定 0.0.0.0 吗', target: 'k_engine_loopback', kind: 'trap' },
  { id: 'q-mcp-trap', text: 'MCP 默认开启吗', target: 'k_mcp_auth', kind: 'trap' },

  { id: 'q-port-prov', text: '服务端口是多少', target: 'k_port_fixed', kind: 'provenance', unverifiedTrap: true },
  { id: 'q-cross-prov', text: '对话默认公开吗', target: 'k_cross_private', kind: 'provenance', unverifiedTrap: true },
  { id: 'q-engine-prov', text: '引擎默认监听哪里', target: 'k_engine_loopback', kind: 'provenance', unverifiedTrap: true },
];
