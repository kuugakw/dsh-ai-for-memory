/**
 * AI for Memory — Web panel.
 *
 * Registers a sidebar entry plus the matching main panel (`sidebar.panellist`
 * id and `main` key share the same id). Data comes from the Host HTTP API at
 * `/ai-for-memory/api/*`; the panel never reads files directly.
 */

window.__ModuleLoader__.load({
  id: 'dsh-ai-for-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/ai-for-memory/api';
    const PANEL_ID = 'ai-for-memory';
    const lang = (() => {
      const value = typeof navigator !== 'undefined' ? String(navigator.language || '') : '';
      return value.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    })();

    const STRINGS = {
      zh: {
        nav: 'AI 记忆',
        title: 'AI 记忆',
        subtitle: '分层项目记忆：对话隔离 · 过程记录 · 归档 · 快照 · 知识库 · 决策',
        refresh: '刷新',
        loading: '加载中…',
        loadFailed: '读取记忆失败',
        retry: '重试',
        copy: '复制路径',
        copied: '路径已复制',
        copyFailed: '复制失败',
        reveal: '打开文件夹',
        revealed: '已在文件管理器中打开',
        noRoot: '还没有记忆数据：先用 aim_memory 写入一条过程记录，或设置固定目录。',
        noRootShort: '暂无记忆目录',
        root: '记忆目录',
        fixedRoot: '固定目录',
        followProject: '跟随项目',
        tabStaging: '过程记录',
        tabArchive: '归档',
        tabSnapshots: '快照',
        tabKnowledge: '知识库',
        tabDecisions: '决策',
        tabContexts: '上下文',
        tabHints: {
          staging: '过程记录：把「刚发生了什么」原样落下——决策、错误、界面事实、任务状态，一行一条。这是六层里唯一会持续追加的流水，先记下来，再决定归档到哪一类。',
          archive: '归档：把过程记录按类型收进固定的分类文件（界面事实 / 动作日志 / 决策理由 / 错误修复…）。归档是幂等的，重复执行只补缺失条目，所以可以随时再跑一次。',
          snapshots: '快照：保存「某一刻的精确状态对象」，需要时按 id 或名字原样取回。它不描述过程，只负责让你能把状态恢复成当时的样子。',
          knowledge: '知识库：从过程记录、归档、上下文三层里提炼出来的一句句结论，加上我或你直接写入的事实。九类分类（其中「事故」incidents 是独立类型）、自带出处、同一条会自动合并。',
          decisions: '决策：高风险或不可逆操作的正反理由与审查结果，带权重和结论。它回答「为什么当初这么定」，而不只是「做了什么」。',
          contexts: '上下文：对话窗口的存档。按话题相似度清出低相似度的老轮次之前，先把全文存到这里，随时可以用 aim_context restore 调回。',
        },
        emptyStaging: '还没有过程记录。',
        emptyArchive: '还没有归档记录。',
        emptySnapshots: '还没有快照。',
        emptyKnowledge: '知识库还是空的。',
        knowledgePending: '待提炼',
        knowledgeHint: '知识库只存结论：三层里提炼出的用户规则/错误修复/决策理由，加上我或你直接写入的事实；每条都带分类与出处。新内容与库中已有知识或我的认知冲突时，会先问你，确认后才写入。',
        exportButton: '导出',
        exportClose: '收起导出',
        exportKnowledge: '知识库（JSON / Markdown）',
        exportSql: 'SQL 镜像（.sqlite）',
        exportRag: 'RAG 索引',
        exportFormat: '知识库格式',
        exportRun: '导出所选',
        exportPick: '至少选择一种导出类型',
        exportStarted: '已开始下载 {n} 个文件。',
        exportHint: '勾选任意组合：知识库（可选 JSON 无损 / Markdown 可读）、SQL 镜像（完整 .sqlite）、RAG 索引（向量文件）。导出是完整副本，不裁剪、不遗忘，浏览器直接下载到你选定的位置。',
        externalTitle: '外部模型（RAG 用）',
        externalBase: 'API 地址',
        externalModel: '模型名（可留空）',
        externalTimeout: '超时（毫秒）',
        externalHint: '主要用 Embedding 和 Rerank 模型：嵌入地址/模型 + 重排地址/模型留空就沿用主地址。三个开关打开后，归档靠「嵌入找分类 + 重排定胜负」，知识库靠「句子嵌入取最中心」，上下文靠「句子嵌入挑重点」。主地址只在显式调用 chat 时才用。测试连接会顺带检查 embed/rerank 是否启用。',
        externalTest: '测试连接',
        externalTesting: '测试中…',
        externalOk: '连接正常',
        externalFail: '连接失败',
        externalEmbedBase: 'Embedding 地址（留空=主地址）',
        externalEmbedModel: 'Embedding 模型',
        externalRerankBase: 'Rerank 地址（留空=主地址）',
        externalRerankModel: 'Rerank 模型',
        externalSameAs: '留空沿用主地址',
        externalPreset: '常用服务（云端 / 本地）',
        externalApiKey: '主 API Key',
        externalEmbedApiKey: 'Embedding API Key（留空=主 Key）',
        externalRerankApiKey: 'Rerank API Key（留空=主 Key）',
        externalKeySaved: '已保存，留空保持不变，填 - 清除',
        externalKeyEmpty: '未设置（云端服务通常必填）',
        externalCloudHint: '云端服务：选一个预设或填 https 地址，再填 API Key。Key 只保存在本机，面板只显示是否已保存，留空不覆盖、填 - 清除；嵌入/重排可用不同服务商，各填自己的地址与 Key。支持 OpenAI、DeepSeek、SiliconFlow、百炼、智谱、Kimi、火山方舟、Cohere、Jina 以及本地 Ollama / LM Studio / llama.cpp。',
        capOk: '可用',
        capMissing: '不可用',
        modeArchive: '归档方式',
        modeKnowledge: '知识库提炼',
        modeContext: '上下文清理',
        modeLocal: '本地规则',
        modeExternal: '外部模型',
        modeHint: '三个开关各自独立：本地规则离线、确定性、随时可用；外部模型交给任何 OpenAI 兼容服务（llama.cpp / Ollama / LM Studio / vLLM / 云端 API）做分类/提炼/摘要。外部调用失败时会自动退回本地规则，数据不会丢。',
        modeNeedsServer: '已启用外部模型模式：请确认配置的 OpenAI 兼容服务可访问，否则对应操作会自动回退本地规则（结果里会注明）。',
        modeLocalHint: '当前三层都用本地规则，不依赖任何外部服务。',
        evidence: '证据',
        sourceUrl: '出处',
        emptyDecisions: '还没有决策审查记录。',
        emptyContexts: '还没有上下文存档。',
        expandAll: '全部展开',
        collapseAll: '全部收起',
        showMore: '显示更多',
        listShown: '当前显示',
        expandRow: '展开这条',
        collapseRow: '收起这条',
        scopeLabel: '查看范围',
        scopeCurrent: '本对话',
        scopePick: '指定对话',
        scopeWorkspace: '工作区',
        scopeConversation: '对话',
        scopeNoWorkspace: '未记录工作区',
        scopeNoConversation: '该工作区暂无对话',
        scopeChooseConversation: '选择对话…',
        scopeAll: '全部对话',
        scopeShared: '共享层',
        scopeAuto: '本对话（自动识别）',
        conversation: '对话',
        scopeHintSession: '只显示这个对话自己的记忆；其他对话的数据仍在磁盘上，切换范围即可查看，AI 也可以跨对话检索（aim_search 默认）。',
        scopeHintAll: '合并显示所有对话与共享层，每条记录都标注来源对话。',
        scopeHintShared: '只显示早期共享层：旧数据与所有对话共用的事实。',
        scopeHintUnknown: '还没有识别到当前对话，临时显示共享层；在任意对话里继续一次后就能定位到本对话。',
        conversationSettings: '对话设置',
        conversationHint: '每个对话有自己的记忆文件夹。在这里给它命名、决定是否对其他对话开放；在顶部「查看范围」切换对话后，可以分别设置每一个。',
        conversationName: '对话名称',
        conversationNamePlaceholder: '例如：修复GitHub发布文件夹问题 / 大肥鱼',
        conversationAccess: '对外开放',
        conversationOpen: '开放',
        conversationClosed: '不开放',
        conversationOpenHintOn: '其他对话可以通过 aim_search（默认跨对话）和面板「全部对话」读到它。',
        conversationOpenHintOff: '只有本对话能读自己的记忆；其他对话的检索、恢复和合并视图都会跳过它。',
        conversationFolder: '记忆文件夹',
        saveConversation: '保存对话设置',
        conversationSaved: '对话设置已保存',
        conversationSaveFailed: '保存对话设置失败',
        privateBadge: '私有',
        defaultPublic: '新对话默认对外开放',
        defaultPublicHint: '新建对话时自动创建记忆文件夹，并按这个默认值设置开放状态。',
        clearingTopic: '按话题相似度清理',
        clearingThreshold: '相似度阈值（越大清得越狠）',
        clearingKeep: '始终保留最近几轮',
        clearingHint: '按话题相似度清理：以当轮与上轮为基准，相似度低的老轮次被清出，相似度高的原样保留；清出前先完整存档，随时可以 restore 调回。',
        ragTitle: 'RAG 挂载（知识库检索）',
        ragNeedModels: '启用 RAG 需要同时填写 Embedding 模型和 Rerank 模型（在下方「外部模型」区设置）；缺一个都不能挂载。',
        ragHintOn: '已挂载：aim_search 优先用外部嵌入 + 重排检索知识库，结果会标注「检索方式：RAG」；关掉即回到本地 BM25。',
        ragHintOff: '未挂载：aim_search 用本地 BM25 + 哈希向量（离线可用）；打开后改用外部嵌入检索，可随时摘下来。',
        ragBuild: '建立/更新 RAG 索引',
        ragBuilding: '正在建索引…',
        ragBuilt: '索引已更新，共',
        ragBuildFail: '建索引失败',
        ragIndexed: '索引：',
        ragStale: '嵌入模型或地址已变化，旧索引维度可能不兼容；请点「建立/更新索引」重建后再检索。',
        ragNoIndex: '尚未建立索引（先建一次）',
        storageBase: 'JSON 文件：始终启用（唯一底座，先写 JSON 供审查与修正；SQL / RAG 都从它派生）',
        storageSqlTitle: 'SQL 只读镜像（派生）',
        storageSqlOn: '已启用：每次写入 JSON 后同步一份 knowledge/knowledge.sqlite，供 SQL 工具查询；关掉不影响 JSON，也不影响 RAG。',
        storageSqlOff: '未启用：只写 JSON 底座；SQL 查询仍会从 JSON 临时建只读表，RAG 也不受影响。',
        storageSqliteUnavailable: '当前 Node 不支持 node:sqlite（需要 Node 22.5+），会继续只用 JSON。',
        contextRestoreHint: '需要恢复时，在对话里让我执行 aim_context restore。',
        searchPlaceholder: '搜索知识库（id/正文/分类/来源/标签）',
        clearSearch: '清空',
        state: '状态',
        time: '时间',
        source: '来源',
        size: '大小',
        category: '分类',
        kind: '类型',
        risk: '风险',
        outcome: '结果',
        reason: '理由',
        thesis: '正',
        antithesis: '反',
        storageSettings: '使用与存储设置',
        storageHint: '固定目录：所有项目共用这个文件夹（绝对路径）；留空则每个项目各自保存在工作区下的目录里。保存后插件会自动重载。',
        autoMode: '自动整理',
        switchOn: '开',
        switchOff: '关',
        modeRounds: '每几轮自动整理',
        modeUsage: '占用到百分之几时清理',
        snapshotTitle: '自动快照',
        snapshotHint: '默认开启：每 N 轮把最近的上下文窗口存成快照，默认每 5 轮、最多 10 个。超过上限时按相似度清理——相似度高的旧快照先删，差异大的保留；快照与自动整理开关互相独立，关掉整理仍会留快照。',
        snapshotEvery: '快照间隔（轮）',
        snapshotMax: '快照上限（个）',
        modeHintManual: '自动整理已关闭；手动工具始终可用：aim_memory / aim_search / aim_decide / aim_context。',
        modeHintAuto: '自动整理已开启：每 N 轮，或上下文占用达到设定百分比时，自动执行 摘要→归档→按话题相似度清理；两个条件任一满足就触发，手动工具仍然可用。',
        fixedPath: '记忆地址（绝对路径，留空=跟随项目）',
        dirName: '目录名（跟随项目时使用）',
        save: '保存设置',
        saving: '保存中…',
        saved: '已保存，插件重载后生效…',
        saveFailed: '保存失败',
        counts: {
          staging: '过程记录',
          archive: '归档',
          snapshots: '快照',
          knowledge: '知识库',
          decisions: '决策',
          contexts: '上下文',
        },
        decisionsSummary: '审查结果',
        details: '查看详情',
      },
      en: {
        nav: 'AI for Memory',
        title: 'AI for Memory',
        subtitle: 'Layered project memory: per-conversation isolation · process log · archive · snapshots · knowledge base · decisions',
        refresh: 'Refresh',
        loading: 'Loading…',
        loadFailed: 'Failed to load memory',
        retry: 'Retry',
        copy: 'Copy path',
        copied: 'Path copied',
        copyFailed: 'Copy failed',
        reveal: 'Open folder',
        revealed: 'Opened in the file manager',
        noRoot: 'No memory yet. Write a staged record with aim_memory first, or set a fixed directory.',
        noRootShort: 'No memory directory',
        root: 'Memory directory',
        fixedRoot: 'Fixed directory',
        followProject: 'Follow project',
        tabStaging: 'Process log',
        tabArchive: 'Archive',
        tabSnapshots: 'Snapshots',
        tabKnowledge: 'Knowledge base',
        tabDecisions: 'Decisions',
        tabContexts: 'Contexts',
        tabHints: {
          staging: 'Process log: records what just happened, verbatim — decisions, errors, UI facts, task state, one line each. It is the only layer that keeps appending; capture first, classify later.',
          archive: 'Archive: files those records into fixed categories (UI facts, action logs, decision reasons, error fixes…). Archiving is idempotent — re-running only fills in what is missing.',
          snapshots: 'Snapshots: an exact state object saved at one moment, restored later by id or name. It does not describe the process; it makes the state recoverable.',
          knowledge: 'Knowledge: one-sentence conclusions distilled from the three layers, plus facts written by the model or the user. Nine categories (incidents are their own type), provenance on every document, duplicates merged.',
          decisions: 'Decisions: the thesis, antithesis, weights and outcome of risky or irreversible operations — they answer "why this was chosen", not just "what was done".',
          contexts: 'Contexts: archived conversation windows. Before the topic-aware clear removes low-similarity older turns their full text lands here, and aim_context restore brings it back.',
        },
        emptyStaging: 'No process records yet.',
        emptyArchive: 'Nothing archived yet.',
        emptySnapshots: 'No snapshots yet.',
        emptyKnowledge: 'The knowledge base is still empty.',
        knowledgePending: 'To distill',
        knowledgeHint: 'Knowledge stores conclusions only: user rules, error→fix pairs and decision reasons mined from the three layers, plus facts written by the model or the user. Each document carries a category and a source. When a new fact conflicts with stored knowledge or with the model’s own understanding, you are asked first and it is stored only after you agree.',
        exportButton: 'Export',
        exportClose: 'Close export',
        exportKnowledge: 'Knowledge base (JSON / Markdown)',
        exportSql: 'SQL mirror (.sqlite)',
        exportRag: 'RAG index',
        exportFormat: 'Knowledge format',
        exportRun: 'Export selected',
        exportPick: 'Pick at least one export type',
        exportStarted: 'Started downloading {n} file(s).',
        exportHint: 'Pick any combination: knowledge base (JSON lossless / Markdown readable), SQL mirror (full .sqlite), RAG index (vector file). The export is a complete copy — nothing trimmed or forgotten — and the browser saves it where you choose.',
        externalTitle: 'External model (for RAG)',
        externalBase: 'API address',
        externalModel: 'Model name (optional)',
        externalTimeout: 'Timeout (ms)',
        externalHint: 'Built around embedding and rerank models: the embedding address/model and the rerank address/model fall back to the main address when empty. With a switch on, archive = embedding picks the category and the reranker breaks ties, knowledge = the most central sentences by embedding, context = the most central sentences of the turns being cleared. The main address is only used for an explicit chat call. Test connection also reports whether embeddings and rerank are enabled.',
        externalTest: 'Test connection',
        externalTesting: 'Testing…',
        externalOk: 'Connected',
        externalFail: 'Connection failed',
        externalEmbedBase: 'Embedding address (empty = main)',
        externalEmbedModel: 'Embedding model',
        externalRerankBase: 'Rerank address (empty = main)',
        externalRerankModel: 'Rerank model',
        externalSameAs: 'Empty uses the main address',
        externalPreset: 'Common providers (cloud / local)',
        externalApiKey: 'Main API key',
        externalEmbedApiKey: 'Embedding API key (empty = main key)',
        externalRerankApiKey: 'Rerank API key (empty = main key)',
        externalKeySaved: 'Saved; leave empty to keep, enter - to clear',
        externalKeyEmpty: 'Not set (usually required by cloud services)',
        externalCloudHint: 'Cloud services: pick a preset or paste an https URL, then fill the API key. Keys stay on this machine; the panel only shows whether one is saved. Leave the field empty to keep it, enter - to clear it. Embedding and rerank may use different providers, each with its own address and key. Works with OpenAI, DeepSeek, SiliconFlow, DashScope, Zhipu, Kimi, Volcano Ark, Cohere, Jina, and local Ollama / LM Studio / llama.cpp.',
        capOk: 'available',
        capMissing: 'not available',
        modeArchive: 'Archive mode',
        modeKnowledge: 'Knowledge-base extraction',
        modeContext: 'Context summary',
        modeLocal: 'Local rules',
        modeExternal: 'External model',
        modeHint: 'The three switches are independent: local rules are offline, deterministic and always available; external mode hands classifying, mining and summarising to any OpenAI-compatible service (llama.cpp / Ollama / LM Studio / vLLM / hosted API). If the call fails the operation falls back to the local rules, so no data is lost.',
        modeNeedsServer: 'External mode is on: make sure the configured OpenAI-compatible service is reachable, otherwise those operations fall back to the local rules (the result says so).',
        modeLocalHint: 'All three layers currently use local rules and need no external service.',
        evidence: 'Evidence',
        sourceUrl: 'Source',
        emptyDecisions: 'No decision reviews yet.',
        emptyContexts: 'No archived contexts yet.',
        expandAll: 'Expand all',
        collapseAll: 'Collapse all',
        showMore: 'Show more',
        listShown: 'Showing',
        expandRow: 'Expand this entry',
        collapseRow: 'Collapse this entry',
        scopeLabel: 'Scope',
        scopeCurrent: 'This conversation',
        scopePick: 'Specific conversation',
        scopeWorkspace: 'Workspace',
        scopeConversation: 'Conversation',
        scopeNoWorkspace: 'Workspace not recorded',
        scopeNoConversation: 'No conversation in this workspace',
        scopeChooseConversation: 'Choose a conversation…',
        scopeAll: 'All conversations',
        scopeShared: 'Shared layer',
        scopeAuto: 'This conversation (auto)',
        conversation: 'Conversation',
        scopeHintSession: 'Only this conversation\'s own memory is shown. Other conversations keep their data; switch the scope to browse it, and the model can search across conversations (aim_search by default).',
        scopeHintAll: 'Merged view of every conversation plus the shared layer; every row names its source conversation.',
        scopeHintShared: 'Only the early shared layer: legacy data and facts shared by every conversation.',
        scopeHintUnknown: 'The current conversation is not identified yet, so the shared layer is shown; it resolves after one more turn in any conversation.',
        conversationSettings: 'Conversation settings',
        conversationHint: 'Every conversation has its own memory folder. Name it here and choose whether other conversations may read it; switch conversations in "Scope" above to configure each one.',
        conversationName: 'Conversation name',
        conversationNamePlaceholder: 'e.g. Fix GitHub release folder / Big Fish',
        conversationAccess: 'Open to others',
        conversationOpen: 'Open',
        conversationClosed: 'Closed',
        conversationOpenHintOn: 'Other conversations can read it through aim_search (cross-conversation by default) and the "All conversations" view.',
        conversationOpenHintOff: 'Only this conversation can read its memory; other conversations skip it in search, restore and merged views.',
        conversationFolder: 'Memory folder',
        saveConversation: 'Save conversation',
        conversationSaved: 'Conversation settings saved',
        conversationSaveFailed: 'Failed to save conversation settings',
        privateBadge: 'private',
        defaultPublic: 'New conversations open by default',
        defaultPublicHint: 'A new conversation gets its memory folder automatically, seeded with this access setting.',
        clearingTopic: 'Topic similarity',
        clearingThreshold: 'Similarity threshold (higher clears more)',
        clearingKeep: 'Always keep the last N turns',
        clearingHint: 'Topic-aware clearing: each older turn is compared with the current and previous turn. Turns that still share the topic stay verbatim; only the ones the conversation has left behind are cleared, and their full text is archived first so restore can always bring them back.',
        contextRestoreHint: 'To restore one, ask me in the chat to run aim_context restore.',
        ragTitle: 'RAG mount (knowledge search)',
        ragNeedModels: 'RAG needs both an embedding model and a rerank model (set them in External model below). It cannot be mounted with only one.',
        ragHintOn: 'Mounted: aim_search uses external embeddings + rerank over the knowledge layer and marks results as RAG. Turn it off to go back to local BM25.',
        ragHintOff: 'Not mounted: aim_search uses local BM25 + hashing vectors (offline). Turn it on to switch retrieval to the external embedding index; it can be unmounted at any time.',
        ragBuild: 'Build / refresh RAG index',
        ragBuilding: 'Building index…',
        ragBuilt: 'Index updated:',
        ragBuildFail: 'Index build failed',
        ragIndexed: 'Index:',
        ragStale: 'The embedding model or endpoint changed, so the old index may use an incompatible dimension. Rebuild with "Build / update index" before searching.',
        ragNoIndex: 'No index yet (build once)',
        storageBase: 'JSON files: always on (the single base; everything is written to JSON first for review and correction, and SQL / RAG are derived from it)',
        storageSqlTitle: 'SQL read-only mirror (derived)',
        storageSqlOn: 'On: every JSON write also syncs knowledge/knowledge.sqlite for SQL tools. Turning it off does not affect JSON or RAG.',
        storageSqlOff: 'Off: JSON stays the only base; SQL queries still build a temporary read-only table from JSON, and RAG is unaffected.',
        storageSqliteUnavailable: 'This Node build has no node:sqlite (Node 22.5+ required); JSON only.',
        searchPlaceholder: 'Search the knowledge base (id, text, category, source, tag)',
        clearSearch: 'Clear',
        state: 'State',
        time: 'Time',
        source: 'Source',
        size: 'Size',
        category: 'Category',
        kind: 'Kind',
        risk: 'Risk',
        outcome: 'Outcome',
        reason: 'Reason',
        thesis: 'Thesis',
        antithesis: 'Antithesis',
        storageSettings: 'Usage and storage settings',
        storageHint: 'Fixed directory: every project shares this folder (absolute path). Leave empty to keep one memory directory inside each workspace. The plugin reloads after saving.',
        autoMode: 'Auto tidy',
        switchOn: 'On',
        switchOff: 'Off',
        modeRounds: 'Auto tidy every N rounds',
        modeUsage: 'Clear at what percent of context',
        snapshotTitle: 'Automatic snapshots',
        snapshotHint: 'On by default: every N turns the recent context window is saved as a snapshot (5 turns / 10 snapshots by default). Above the cap, near-duplicates are removed first by similarity, while distinct snapshots are kept. Snapshotting is independent of automatic tidying: turning tidying off still keeps checkpoints.',
        snapshotEvery: 'Snapshot every N turns',
        snapshotMax: 'Snapshot cap',
        modeHintManual: 'Auto tidy is off; manual tools are always available: aim_memory / aim_search / aim_decide / aim_context.',
        modeHintAuto: 'Auto tidy is on: it digests, archives and runs a topic-aware clear every N turns, or as soon as context usage reaches the set percentage. Either trigger suffices; manual tools remain available.',
        fixedPath: 'Memory path (absolute, empty = follow project)',
        dirName: 'Directory name (used when following the project)',
        save: 'Save settings',
        saving: 'Saving…',
        saved: 'Saved; the plugin is reloading…',
        saveFailed: 'Save failed',
        counts: {
          staging: 'Process log',
          archive: 'Archive',
          snapshots: 'Snapshots',
          knowledge: 'Knowledge',
          decisions: 'Decisions',
          contexts: 'Contexts',
        },
        decisionsSummary: 'Reviews',
        details: 'Details',
      },
    };
    const t = STRINGS[lang];

    // ---- motion system -----------------------------------------------------
    //
    // The panel renders with inline styles, which cannot declare keyframes, so
    // the shared motion vocabulary lives in one injected stylesheet. Every
    // effect is short (<= 260ms), uses the same easing, and is disabled under
    // `prefers-reduced-motion`.
    const MOTION_STYLE_ID = 'aim-motion-styles';
    const MOTION_CSS = `
@keyframes aim-fade-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes aim-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes aim-slide-down { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
@keyframes aim-indicator-in { from { opacity: 0; transform: scaleX(.35); } to { opacity: 1; transform: scaleX(1); } }
@keyframes aim-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }

.aim-page { animation: aim-fade-up .26s cubic-bezier(.2,.7,.3,1) both; }
.aim-fade-up { animation: aim-fade-up .22s cubic-bezier(.2,.7,.3,1) both; }
.aim-content { animation: aim-fade .24s ease-out both; }
.aim-notice { animation: aim-slide-down .2s cubic-bezier(.2,.7,.3,1) both; }
.aim-indicator { animation: aim-indicator-in .18s cubic-bezier(.2,.7,.3,1) both; transform-origin: left center; }
.aim-pulse { animation: aim-pulse 1.4s ease-in-out infinite; }

.aim-btn { transition: background-color .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease, transform .09s ease; }
.aim-btn:hover:not(:disabled) { filter: brightness(1.05); }
.aim-btn:active:not(:disabled) { transform: scale(.97); }
.aim-btn:disabled { opacity: .6; cursor: default; }

.aim-tab { transition: color .16s ease, opacity .16s ease, transform .09s ease; }
.aim-tab:hover { opacity: .9; }
.aim-tab:active { transform: translateY(1px); }

.aim-row, .aim-tile { transition: transform .18s cubic-bezier(.2,.7,.3,1), box-shadow .18s ease, border-color .18s ease; }
.aim-row:hover, .aim-tile:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,.10); }

.aim-icon { transition: transform .2s cubic-bezier(.2,.7,.3,1); }
.aim-icon:hover { transform: translateY(-1px) scale(1.06); }

@media (prefers-reduced-motion: reduce) {
  .aim-page, .aim-fade-up, .aim-content, .aim-notice, .aim-indicator, .aim-pulse { animation: none !important; }
  .aim-btn, .aim-tab, .aim-row, .aim-tile, .aim-icon { transition: none !important; }
  .aim-row:hover, .aim-tile:hover, .aim-icon:hover, .aim-btn:active, .aim-tab:active { transform: none; }
}

/* Belt and braces for the layer tabs: whatever a host stylesheet does to
   buttons (focus ring underline, inherited border), the tab row never shows
   more than the one indicator element rendered by the selected tab. */
.aim-switch, .aim-switch:hover, .aim-switch:focus, .aim-switch:focus-visible, .aim-switch:active {
  text-decoration: none !important;
  border-bottom: none !important;
  outline: none !important;
}

/* The selected switch is marked by a dot drawn from aria-checked, so the
   label itself stays plain text that no background can swallow. */
.aim-switch[aria-checked="true"]::before {
  content: '●';
  font-size: 9px;
  margin-right: 4px;
  vertical-align: middle;
}

.aim-tabs, .aim-tabs button,
.aim-tabs button:hover, .aim-tabs button:focus, .aim-tabs button:focus-visible,
.aim-tabs button:active {
  text-decoration: none !important;
  border-bottom: none !important;
  outline: none !important;
}
`;

    /** Inject the shared motion stylesheet once per page. */
    function installMotionStyles() {
      const doc = globalThis.document;
      if (!doc || !doc.head) return () => {};
      if (doc.getElementById(MOTION_STYLE_ID)) return () => {};
      const style = doc.createElement('style');
      style.id = MOTION_STYLE_ID;
      style.textContent = MOTION_CSS;
      doc.head.append(style);
      return () => {
        const installed = doc.getElementById(MOTION_STYLE_ID);
        if (installed) installed.remove();
      };
    }

    function apiBase() {
      const location = globalThis.location;
      if (location && (location.protocol === 'http:' || location.protocol === 'https:')) return '';
      const transport = globalThis.__DSH_TRANSPORT__;
      const origin = transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl : '';
      return origin.replace(/\/+$/, '');
    }

    async function callApiAt(url, options) {
      const method = options?.method ?? 'GET';
      const response = await fetch(url, {
        method,
        headers: options?.body === undefined ? {} : { 'content-type': 'application/json' },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text === '' ? null : JSON.parse(text);
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload ?? {};
    }

    async function callApi(path, options) {
      const base = apiBase();
      const candidates = base === '' ? [''] : [base, ''];
      let lastError = null;
      for (const prefix of candidates) {
        try {
          return await callApiAt(prefix + API + path, options);
        } catch (error) {
          lastError = error;
          if (!(error instanceof TypeError)) break;
        }
      }
      throw lastError ?? new Error('request failed');
    }

    const colors = {
      label: 'var(--dsw-alias-label-primary, #1f2329)',
      secondary: 'var(--dsw-alias-label-secondary, #646a73)',
      border: 'var(--dsw-alias-border-l2, #dee0e3)',
      bg: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      bg2: 'var(--dsw-alias-bg-layer-2, #f5f6f7)',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      error: 'var(--dsw-alias-state-error-primary, #d83931)',
      success: 'var(--dsw-alias-state-success-primary, #2ea121)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
    };

    const styles = {
      page: {
        display: 'flex', flexDirection: 'column', gap: '14px', color: colors.label,
        fontSize: '13px', lineHeight: '1.6', padding: '20px 24px 32px',
        maxWidth: '1040px', margin: '0 auto', width: '100%', boxSizing: 'border-box',
        height: '100%', overflowY: 'auto',
      },
      header: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' },
      title: { fontSize: '18px', fontWeight: 650, margin: 0 },
      subtitle: { margin: '2px 0 0', color: colors.secondary, fontSize: '12.5px' },
      actions: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
      card: {
        border: `1px solid ${colors.border}`, borderRadius: '10px', background: colors.bg,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px',
      },
      cardTitle: { fontSize: '13px', fontWeight: 650, margin: 0 },
      hint: { color: colors.secondary, fontSize: '12px', margin: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      input: {
        font: 'inherit', fontSize: '13px', color: colors.label, background: colors.bg2,
        border: `1px solid ${colors.border}`, borderRadius: '7px', padding: '6px 9px',
        outline: 'none', minWidth: 0, width: '100%', boxSizing: 'border-box',
      },
      button: {
        font: 'inherit', fontSize: '12.5px', color: colors.label, background: colors.bg2,
        border: `1px solid ${colors.border}`, borderRadius: '7px', padding: '5px 12px',
        cursor: 'pointer', whiteSpace: 'nowrap',
      },
      primary: {
        font: 'inherit', fontSize: '12.5px', fontWeight: 600, color: colors.label,
        background: colors.bg2, border: `1px solid ${colors.brand}`, borderRadius: '7px',
        padding: '5px 14px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      pathRow: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '8px 12px',
        background: colors.bg,
      },
      path: {
        flex: '1 1 320px', minWidth: 0, overflowWrap: 'anywhere',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px', color: colors.secondary,
      },
      tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' },
      tile: {
        border: `1px solid ${colors.border}`, borderRadius: '10px', background: colors.bg,
        padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '2px',
      },
      tileLabel: { fontSize: '11.5px', color: colors.secondary },
      tileValue: { fontSize: '20px', fontWeight: 650, fontVariantNumeric: 'tabular-nums' },
      tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap', borderBottom: `1px solid ${colors.border}` },
      modeRow: {
        display: 'flex', gap: '4px', flexWrap: 'wrap',
        borderBottom: `1px solid ${colors.border}`, paddingBottom: '4px',
      },
      tab: {
        font: 'inherit', fontSize: '12.5px', color: colors.secondary, background: 'transparent',
        border: 'none', borderBottom: '2px solid transparent', padding: '7px 10px',
        cursor: 'pointer', display: 'flex', gap: '6px', alignItems: 'center',
      },
      tabOn: { color: colors.label, borderBottomColor: colors.brand, fontWeight: 600 },
      // The six layer tabs draw their own active indicator element instead of
      // relying on a bottom border: a border can be inherited from a host
      // stylesheet and then two tabs look underlined at once.
      tabBar: {
        font: 'inherit', fontSize: '12.5px', color: colors.secondary, background: 'transparent',
        border: 'none', borderBottom: 'none', textDecoration: 'none', boxShadow: 'none',
        padding: '7px 10px 8px', cursor: 'pointer', position: 'relative',
        display: 'flex', gap: '6px', alignItems: 'center',
      },
      tabBarOn: { color: colors.label, fontWeight: 600 },
      // Settings switches: text only, no filled background and no border. The
      // selected option is brand-coloured, bold, and marked with a dot drawn by
      // CSS from aria-checked, so the label can never sit unreadable on top of
      // a background colour (light and dark themes both keep it readable).
      switchOption: {
        fontSize: '12.5px', lineHeight: '1.5', minHeight: '24px',
        color: colors.secondary, background: 'transparent',
        border: 'none', borderRadius: '6px', padding: '2px 8px', cursor: 'pointer',
        textDecoration: 'none', boxShadow: 'none', whiteSpace: 'nowrap',
      },
      switchOptionOn: { color: colors.brand, fontWeight: 700, background: 'transparent' },
      tabBarIndicator: {
        position: 'absolute', left: '8px', right: '8px', bottom: '-1px', height: '2px',
        borderRadius: '2px', background: colors.brand,
      },
      tabCount: {
        fontSize: '11px', color: colors.secondary, background: colors.bg2,
        border: `1px solid ${colors.border}`, borderRadius: '999px', padding: '0 6px',
        fontVariantNumeric: 'tabular-nums',
      },
      list: { display: 'flex', flexDirection: 'column', gap: '6px' },
      row: {
        border: `1px solid ${colors.border}`, borderRadius: '8px', background: colors.bg,
        padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '4px',
      },
      rowHead: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
      // Collapsible log rows: header always visible, body rendered on demand.
      logHead: {
        display: 'flex', alignItems: 'flex-start', gap: '6px', width: '100%',
        background: 'transparent', border: 'none', padding: 0, margin: 0,
        color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
      },
      logHeadMain: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', flex: 1 },
      logChevron: { color: colors.secondary, fontSize: '11px', lineHeight: '18px', width: '10px', flex: 'none' },
      logBody: { display: 'flex', flexDirection: 'column', gap: '4px' },
      logPreview: {
        margin: 0, color: colors.secondary, fontSize: '12px',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
      logBar: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' },
      groupHead: {
        display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
        background: 'transparent', border: 'none', padding: 0, color: 'inherit',
        font: 'inherit', textAlign: 'left', cursor: 'pointer',
      },
      content: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '12.5px' },
      meta: { color: colors.secondary, fontSize: '11.5px', display: 'flex', gap: '10px', flexWrap: 'wrap' },
      badge: {
        fontSize: '11px', borderRadius: '999px', padding: '0 7px', border: '1px solid',
        lineHeight: '17px',
      },
      notice: { borderRadius: '8px', padding: '7px 10px', fontSize: '12px', border: '1px solid' },
      details: { borderTop: `1px solid ${colors.border}`, paddingTop: '6px' },
      summary: { cursor: 'pointer', fontWeight: 600, fontSize: '12.5px' },
      grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' },
      label: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12px', color: colors.secondary },
      pre: {
        margin: 0, padding: '8px 10px', background: colors.bg2, borderRadius: '8px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11.5px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      },
      empty: { color: colors.secondary, fontSize: '12.5px', margin: '4px 0' },
    };

    function badgeStyle(kind) {
      const map = {
        low: colors.success,
        medium: colors.warn,
        high: colors.error,
        approved: colors.success,
        rejected: colors.error,
        needs_more_info: colors.warn,
        pending: colors.secondary,
        pass: colors.success,
        fail: colors.error,
        skip: colors.secondary,
      };
      const color = map[kind] ?? colors.secondary;
      return { ...styles.badge, color, borderColor: color };
    }

    function formatTime(value) {
      const text = String(value ?? '');
      return text === '' ? '' : text.replace('T', ' ').slice(0, 19);
    }

    function formatBytes(value) {
      const bytes = Number(value) || 0;
      if (bytes < 1024) return `${bytes} B`;
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        className: 'aim-icon',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { display: 'block' },
      },
      h('path', { d: 'M12 3 21 7.5 12 12 3 7.5 12 3Z' }),
      h('path', { d: 'M3 12.5 12 17l9-4.5' }),
      h('path', { d: 'M3 17.5 12 22l9-4.5' }));
    }

    function Tile(props) {
      return h('div', { className: 'aim-tile', style: styles.tile },
        h('div', { style: styles.tileLabel }, props.label),
        h('div', { style: styles.tileValue }, String(props.value ?? 0)));
    }

    function Empty(props) {
      return h('p', { style: styles.empty }, props.text);
    }

    /** One clipped preview line so a collapsed log row still says something. */
    function clipPreview(text, max = 120) {
      const value = String(text ?? '').replace(/\s+/g, ' ').trim();
      return value.length > max ? `${value.slice(0, max)}…` : value;
    }

    /**
     * A collapsible log row.
     *
     * Six layers of logs add up fast — a full process-record list is quickly
     * thousands of pixels tall. The header always renders; the body only renders
     * when the row is open. The owner of the open-key set decides what is open,
     * which is what lets "expand all / collapse all" work across a whole tab.
     */
    function LogRow(props) {
      const open = props.open === true;
      return h('div', { className: 'aim-log', style: { ...styles.row, gap: '6px' } },
        h('button', {
          type: 'button',
          className: 'aim-log-head',
          'aria-expanded': open,
          title: open ? t.collapseRow : t.expandRow,
          onClick: () => props.onToggle(props.rowKey),
          style: styles.logHead,
        },
          h('span', { style: styles.logChevron, 'aria-hidden': true }, open ? '▾' : '▸'),
          h('span', { style: styles.logHeadMain }, props.head)),
        open
          ? h('div', { style: styles.logBody }, props.children)
          : (props.preview ? h('p', { style: styles.logPreview }, clipPreview(props.preview)) : null));
    }

    function EntryRow(props) {
      const row = props.row;
      return h(LogRow, {
        rowKey: props.rowKey,
        open: props.open,
        onToggle: props.onToggle,
        head: [
          row.kind ? h('span', { key: 'kind', style: badgeStyle('pending') }, row.kind) : null,
          row.risk ? h('span', { key: 'risk', style: badgeStyle(row.risk) }, `${t.risk}: ${row.risk}`) : null,
          row.category ? h('span', { key: 'category', style: badgeStyle('pending') }, row.category) : null,
          props.showSession && row.session_label
            ? h('span', { key: 'session', style: badgeStyle('pending') }, row.session_label)
            : null,
          h('span', { key: 'time', style: { marginLeft: 'auto', color: colors.secondary, fontSize: '11.5px' } }, formatTime(row.timestamp)),
        ],
        preview: row.content,
        children: [
          h('p', { key: 'content', style: styles.content }, row.content ?? ''),
          row.source || row.dedup_id ? h('div', { key: 'meta', style: styles.meta },
            row.source ? h('span', null, `${t.source}: ${row.source}`) : null,
            row.dedup_id ? h('span', { style: styles.mono }, row.dedup_id.slice(0, 10)) : null) : null,
        ],
      });
    }

    /**
     * The panel is registered on the root-scoped `main` slot, so the renderer
     * hands it the root standard kit, including the `useSessions` selector hook
     * over the Session catalog. That catalog supplies conversation titles; the
     * Host API supplies the memory rows and which conversation is current.
     */
    /**
   * Cloud / local OpenAI-compatible presets. Picking one only fills the base URL
   * and the typical embedding/rerank model names; every field stays editable.
   */
  const EXTERNAL_PRESETS = [
    { id: 'custom', label: '自定义 / 本地', baseUrl: '', embedModel: '', rerankModel: '' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', embedModel: 'text-embedding-3-small', rerankModel: '' },
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', embedModel: '', rerankModel: '' },
    { id: 'siliconflow', label: 'SiliconFlow 硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', embedModel: 'BAAI/bge-m3', rerankModel: 'BAAI/bge-reranker-v2-m3' },
    { id: 'dashscope', label: '阿里云百炼（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', embedModel: 'text-embedding-v3', rerankModel: '' },
    { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', embedModel: 'embedding-3', rerankModel: 'rerank' },
    { id: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', embedModel: '', rerankModel: '' },
    { id: 'ark', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', embedModel: 'doubao-embedding', rerankModel: '' },
    { id: 'cohere', label: 'Cohere', baseUrl: 'https://api.cohere.com/v1', embedModel: 'embed-multilingual-v3.0', rerankModel: 'rerank-multilingual-v3.0' },
    { id: 'jina', label: 'Jina AI', baseUrl: 'https://api.jina.ai/v1', embedModel: 'jina-embeddings-v3', rerankModel: 'jina-reranker-v2-base-multilingual' },
    { id: 'ollama', label: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', embedModel: 'nomic-embed-text', rerankModel: '' },
    { id: 'lmstudio', label: 'LM Studio 本地', baseUrl: 'http://127.0.0.1:1234/v1', embedModel: '', rerankModel: '' },
    { id: 'llamacpp', label: 'llama.cpp 本地', baseUrl: 'http://127.0.0.1:8080', embedModel: '', rerankModel: '' },
  ];

  function Dashboard(props) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [tab, setTab] = React.useState('staging');
      const [query, setQuery] = React.useState('');
      // Log lists collapse: `openRows` holds the row keys the user opened and
      // `listLimit` how many rows each list shows before "show more".
      const [openRows, setOpenRows] = React.useState(() => new Set());
      const [listLimit, setListLimit] = React.useState(8);
      const [notice, setNotice] = React.useState(null);
      const [formRoot, setFormRoot] = React.useState('');
      const [formDir, setFormDir] = React.useState('.ai-for-memory');
      const [formMode, setFormMode] = React.useState('manual');
      const [formRounds, setFormRounds] = React.useState(5);
      // Automatic snapshots: independent of automatic tidying, on by default,
      // every N turns, capped at M entries (near-duplicates pruned by similarity).
      const [formAutoSnapshot, setFormAutoSnapshot] = React.useState(true);
      const [formSnapshotEvery, setFormSnapshotEvery] = React.useState(5);
      const [formSnapshotMax, setFormSnapshotMax] = React.useState(10);
      // Percentage of the context window that also triggers a tidy, next to the
      // every-N-rounds trigger (both coexist; default 70%).
      const [formUsage, setFormUsage] = React.useState(70);
      // One export button with three selectable, multi-pick types.
      const [exportOpen, setExportOpen] = React.useState(false);
      const [exportTypes, setExportTypes] = React.useState(['knowledge']);
      const [exportFormat, setExportFormat] = React.useState('json');
      const [formDefaultPublic, setFormDefaultPublic] = React.useState(true);
      const [formTopical, setFormTopical] = React.useState(true);
      const [formThreshold, setFormThreshold] = React.useState(0.06);
      const [formKeepRecent, setFormKeepRecent] = React.useState(2);
      // RAG is mounted on the knowledge layer: the switch decides whether
      // aim_search uses the vector index; building the index is a separate click.
      const [formRagMount, setFormRagMount] = React.useState(false);
      const [ragIndex, setRagIndex] = React.useState({ built: false, docs: 0, dim: 0, model: '', built_at: '' });
      const [ragBusy, setRagBusy] = React.useState(false);
      // Knowledge storage backend: 'json' (files) or 'sqlite' (queryable db).
      const [formStorage, setFormStorage] = React.useState('json');
      const [formExternalBase, setFormExternalBase] = React.useState('');
      const [formExternalModel, setFormExternalModel] = React.useState('');
      const [formExternalTimeout, setFormExternalTimeout] = React.useState(60000);
      const [formEmbedBase, setFormEmbedBase] = React.useState('');
      const [formEmbedModel, setFormEmbedModel] = React.useState('');
      const [formRerankBase, setFormRerankBase] = React.useState('');
      const [formRerankModel, setFormRerankModel] = React.useState('');
      // Cloud keys are write-only: the panel only knows whether one is stored.
      const [formExternalKey, setFormExternalKey] = React.useState('');
      const [formEmbedKey, setFormEmbedKey] = React.useState('');
      const [formRerankKey, setFormRerankKey] = React.useState('');
      const [hasExternalKey, setHasExternalKey] = React.useState(false);
      const [hasEmbedKey, setHasEmbedKey] = React.useState(false);
      const [hasRerankKey, setHasRerankKey] = React.useState(false);
      const [formPreset, setFormPreset] = React.useState('custom');
      const [externalProbing, setExternalProbing] = React.useState(false);
      const [externalStatus, setExternalStatus] = React.useState('');
      const [formArchiveExternal, setFormArchiveExternal] = React.useState(false);
      const [formKnowledgeExternal, setFormKnowledgeExternal] = React.useState(false);
      const [formContextExternal, setFormContextExternal] = React.useState(false);
      const [formName, setFormName] = React.useState('');
      const [formPublic, setFormPublic] = React.useState(true);
      const [saving, setSaving] = React.useState(false);
      const [sessionSaving, setSessionSaving] = React.useState(false);

      // `useSessions` is a Hook supplied as a prop by the slot renderer. The
      // renderer always binds it for the root kit, so this branch is stable for
      // the page lifetime; when a future shell omits it, labels fall back to ids.
      const useSessions = props?.useSessions;
      const catalog = typeof useSessions === 'function'
        ? useSessions((state) => (state && state.byId ? state.byId : null))
        : null;

      const titles = React.useMemo(() => {
        const map = {};
        for (const [id, row] of Object.entries(catalog ?? {})) {
          if (row && typeof row.title === 'string' && row.title !== '') map[id] = row.title;
        }
        return map;
      }, [catalog]);

      // DSH knows every conversation; the memory store only knows the ones that
      // already got a folder. Merging the catalog lets "Scope" list a brand-new
      // conversation before its folder exists; choosing it creates the folder.
      const catalogRows = React.useMemo(() => {
        if (!catalog) return [];
        return Object.entries(catalog)
          .map(([sessionId, row]) => ({
            sessionId,
            title: row && typeof row.title === 'string' ? row.title : '',
            updatedAt: Number(row?.updatedAt) || 0,
          }))
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, 40);
      }, [catalog]);

      const scopeRef = React.useRef(null);
      const [scope, setScopeState] = React.useState(null);
      const applyScope = React.useCallback((next) => {
        scopeRef.current = next;
        setScopeState(next);
      }, []);

      const load = React.useCallback(async (root, nextScope) => {
        setBusy(true);
        try {
          const active = nextScope ?? scopeRef.current;
          const kind = active?.kind ?? 'session';
          const params = new URLSearchParams();
          if (typeof root === 'string' && root !== '') params.set('root', root);
          params.set('scope', kind);
          if (kind === 'session' && active?.key) params.set('session', active.key);
          const payload = await callApi(`/state?${params.toString()}`);
          setData(payload);
          setError(null);
          if (typeof payload.fixedRoot === 'string') setFormRoot(payload.fixedRoot);
          if (typeof payload.directoryName === 'string') setFormDir(payload.directoryName);
          if (typeof payload.autoEnabled === 'boolean') setFormMode(payload.autoEnabled ? 'auto' : 'manual');
          else if (payload.mode === 'manual' || payload.mode === 'auto') setFormMode(payload.mode);
          if (Number.isInteger(payload.autoEveryRounds)) setFormRounds(payload.autoEveryRounds);
          if (typeof payload.autoSnapshot === 'boolean') setFormAutoSnapshot(payload.autoSnapshot);
          if (Number.isInteger(payload.autoSnapshotEvery)) setFormSnapshotEvery(payload.autoSnapshotEvery);
          if (Number.isInteger(payload.autoSnapshotMax)) setFormSnapshotMax(payload.autoSnapshotMax);
          if (Number.isInteger(payload.contextUsagePercent)) setFormUsage(payload.contextUsagePercent);
          if (typeof payload.defaultPublic === 'boolean') setFormDefaultPublic(payload.defaultPublic);
          if (typeof payload.topicalClear === 'boolean') setFormTopical(payload.topicalClear);
          if (typeof payload.ragMount === 'boolean') setFormRagMount(payload.ragMount);
          if (payload.ragIndex && typeof payload.ragIndex === 'object') setRagIndex(payload.ragIndex);
          if (payload.knowledgeBackend === 'sqlite' || payload.knowledgeBackend === 'json') {
            setFormStorage(payload.knowledgeBackend);
          }
          if (typeof payload.similarityThreshold === 'number') setFormThreshold(payload.similarityThreshold);
          if (Number.isInteger(payload.keepRecentTurns)) setFormKeepRecent(payload.keepRecentTurns);
          if (typeof payload.externalBaseUrl === 'string') setFormExternalBase(payload.externalBaseUrl);
          if (typeof payload.externalModel === 'string') setFormExternalModel(payload.externalModel);
          if (Number.isInteger(payload.externalTimeoutMs)) setFormExternalTimeout(payload.externalTimeoutMs);
          if (typeof payload.externalEmbedBaseUrl === 'string') setFormEmbedBase(payload.externalEmbedBaseUrl);
          if (typeof payload.externalEmbedModel === 'string') setFormEmbedModel(payload.externalEmbedModel);
          if (typeof payload.externalRerankBaseUrl === 'string') setFormRerankBase(payload.externalRerankBaseUrl);
          if (typeof payload.externalRerankModel === 'string') setFormRerankModel(payload.externalRerankModel);
          setHasExternalKey(payload.externalHasApiKey === true);
          setHasEmbedKey(payload.externalEmbedHasApiKey === true);
          setHasRerankKey(payload.externalRerankHasApiKey === true);
          setFormExternalKey('');
          setFormEmbedKey('');
          setFormRerankKey('');
          if (typeof payload.archiveExternal === 'boolean') setFormArchiveExternal(payload.archiveExternal);
          if (typeof payload.knowledgeExternal === 'boolean') setFormKnowledgeExternal(payload.knowledgeExternal);
          if (typeof payload.contextExternal === 'boolean') setFormContextExternal(payload.contextExternal);
          const selected = payload?.selectedSession ?? null;
          setFormName(selected?.label ?? '');
          setFormPublic(selected?.public !== false);
          applyScope({
            kind: typeof payload.scope === 'string' ? payload.scope : kind,
            key: payload?.selectedSession?.key ?? (kind === 'session' ? (active?.key ?? null) : null),
          });
        } catch (fetchError) {
          setError(String(fetchError?.message ?? fetchError));
        } finally {
          setBusy(false);
        }
      }, [applyScope]);

      React.useEffect(() => { load(); }, [load]);

      const selectedRoot = data?.selectedRoot ?? '';
      const roots = Array.isArray(data?.roots) ? data.roots : [];
      const counts = data?.counts ?? {};
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      const showSession = data?.scope === 'all';

      const optionRows = React.useMemo(() => {
        const known = new Set();
        for (const row of sessions) {
          if (row.sessionId) known.add(row.sessionId);
        }
        const extras = [];
        for (const item of catalogRows) {
          if (known.has(item.sessionId)) continue;
          extras.push({
            key: '',
            sessionId: item.sessionId,
            label: '',
            title: item.title,
            name: item.title,
            public: true,
            current: false,
            updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : '',
            counts: { staging: 0, archive: 0, snapshots: 0, knowledge: 0, decisions: 0, contexts: 0 },
          });
        }
        return [...sessions, ...extras];
      }, [sessions, catalogRows]);

      // Scope is a two-level directory: memory folders live inside the
      // workspace that produced them, so the picker groups by workspace first
      // instead of listing every conversation in one flat blob.
      const workspaceGroups = React.useMemo(() => {
        const groups = new Map();
        for (const row of optionRows) {
          // Rows without a folder key cannot be selected as a scope target.
          if (!row.key) continue;
          const workspace = typeof row.workspace === 'string' ? row.workspace : '';
          if (!groups.has(workspace)) groups.set(workspace, []);
          groups.get(workspace).push(row);
        }
        return [...groups.entries()]
          .map(([workspace, rows]) => ({
            workspace,
            short: workspace === ''
              ? t.scopeNoWorkspace
              : (workspace.split(/[\\/]/).filter(Boolean).pop() || workspace),
            rows,
          }))
          .sort((left, right) => {
            if (left.workspace === right.workspace) return 0;
            if (left.workspace === '') return 1;
            if (right.workspace === '') return -1;
            return left.workspace.localeCompare(right.workspace);
          });
      }, [optionRows, t]);

      const titleOf = (row) => titles[row?.sessionId] ?? '';
      const conversationName = (row) => {
        if (!row) return '';
        // An explicit panel name wins, then the live DSH title, then the title
        // snapshotted by the Host, then a short id.
        const name = row.label || titleOf(row) || row.title || '';
        return name !== '' ? name : String(row.sessionId ?? row.key ?? '').slice(0, 8);
      };
      const selectedSession = data?.selectedSession ?? null;
      const namePlaceholder = selectedSession
        ? (titleOf(selectedSession) || selectedSession.title || t.conversationNamePlaceholder)
        : t.conversationNamePlaceholder;
      const scopeHint = scope?.kind === 'all'
        ? t.scopeHintAll
        : scope?.kind === 'shared'
          ? t.scopeHintShared
          : (data?.sessionUnknown ? t.scopeHintUnknown : t.scopeHintSession);
      const hasNothingHere = ['staging', 'archive', 'snapshots', 'knowledge', 'decisions', 'contexts']
        .every((key) => (counts[key] ?? 0) === 0);
      // RAG needs two models; check the form so the toggle reacts before saving.
      const ragFormReady = formEmbedModel.trim() !== '' && formRerankModel.trim() !== '';
      const sharedNote = scope?.kind === 'session' && hasNothingHere && data?.shared?.hasData
        ? `${t.scopeShared}：过程记录 ${data.shared.counts?.staging ?? 0} 条，知识库 ${data.shared.counts?.knowledge ?? 0} 篇。`
        : '';
      const scopeIsSession = scope == null || scope.kind === 'session';
      const currentKey = scope?.kind === 'session' ? (scope.key ?? null) : null;
      const activeRow = (currentKey !== null
        ? optionRows.find((row) => row.key === currentKey)
        : optionRows.find((row) => row.current))
        ?? null;
      const activeWorkspace = typeof activeRow?.workspace === 'string' ? activeRow.workspace : '';
      const conversationRows = workspaceGroups.find((group) => group.workspace === activeWorkspace)?.rows ?? [];
      const pickConversation = (row) => {
        if (!row || !row.key) return;
        const next = { kind: 'session', key: row.key };
        applyScope(next);
        load(selectedRoot, next);
      };
      // 'auto' keeps the Host-decided current conversation; 'pick' jumps into
      // the workspace/conversation selects below.
      const scopeValue = scope == null
        ? 'auto'
        : scope.kind === 'all' ? 'all'
          : scope.kind === 'shared' ? 'shared'
            : (scope.key ? 'pick' : 'auto');

      const copyPath = async () => {
        if (selectedRoot === '') return;
        try {
          await navigator.clipboard.writeText(selectedRoot);
          setNotice({ kind: 'ok', text: t.copied });
        } catch {
          setNotice({ kind: 'err', text: t.copyFailed });
        }
      };

      const reveal = async () => {
        if (selectedRoot === '') return;
        setBusy(true);
        try {
          await callApi('/reveal', { method: 'POST', body: { root: selectedRoot } });
          setNotice({ kind: 'ok', text: t.revealed });
        } catch (revealError) {
          setNotice({ kind: 'err', text: String(revealError?.message ?? revealError) });
        } finally {
          setBusy(false);
        }
      };

      const saveConfig = async () => {
        setSaving(true);
        setNotice(null);
        try {
          await callApi('/config', {
            method: 'POST',
            body: {
              root: formRoot.trim(),
              directoryName: formDir.trim(),
              autoEnabled: formMode === 'auto',
              autoEveryRounds: Number(formRounds) || 5,
              autoSnapshot: formAutoSnapshot,
              autoSnapshotEvery: Number(formSnapshotEvery) || 5,
              autoSnapshotMax: Number(formSnapshotMax) || 10,
              contextUsagePercent: Number(formUsage) || 70,
              defaultPublic: formDefaultPublic,
              topicalClear: formTopical,
              ragMount: formRagMount,
              knowledgeBackend: formStorage,
              similarityThreshold: Number(formThreshold) || 0.06,
              keepRecentTurns: Number(formKeepRecent) || 2,
              externalBaseUrl: formExternalBase.trim(),
              externalModel: formExternalModel.trim(),
              externalTimeoutMs: Number(formExternalTimeout) || 60000,
              externalEmbedBaseUrl: formEmbedBase.trim(),
              externalEmbedModel: formEmbedModel.trim(),
              externalRerankBaseUrl: formRerankBase.trim(),
              externalRerankModel: formRerankModel.trim(),
              // Empty = keep the stored key; "-" clears it; anything else sets it.
              externalApiKey: formExternalKey.trim(),
              externalEmbedApiKey: formEmbedKey.trim(),
              externalRerankApiKey: formRerankKey.trim(),
              archiveExternal: formArchiveExternal,
              knowledgeExternal: formKnowledgeExternal,
              contextExternal: formContextExternal,
            },
          });
          setNotice({ kind: 'ok', text: t.saved });
          setTimeout(() => load(''), 2500);
        } catch (saveError) {
          setNotice({ kind: 'err', text: `${t.saveFailed}: ${String(saveError?.message ?? saveError)}` });
        } finally {
          setSaving(false);
        }
      };

      /** Ask the Host to probe the configured external model (any OpenAI-compatible API). */
      const testExternal = async () => {
        setExternalProbing(true);
        setExternalStatus('');
        try {
          // Save the form first so the probe tests exactly what the user typed
          // (an unsaved cloud key would otherwise be missing from the host).
          await callApi('/config', {
            method: 'POST',
            body: {
              externalBaseUrl: formExternalBase.trim(),
              externalModel: formExternalModel.trim(),
              externalTimeoutMs: Number(formExternalTimeout) || 60000,
              externalEmbedBaseUrl: formEmbedBase.trim(),
              externalEmbedModel: formEmbedModel.trim(),
              externalRerankBaseUrl: formRerankBase.trim(),
              externalRerankModel: formRerankModel.trim(),
              externalApiKey: formExternalKey.trim(),
              externalEmbedApiKey: formEmbedKey.trim(),
              externalRerankApiKey: formRerankKey.trim(),
            },
          });
          const payload = await callApi('/external?deep=1');
          const probe = payload?.probe ?? {};
          const parts = [probe.ok ? t.externalOk : t.externalFail];
          if (probe.detail) parts.push(probe.detail);
          if (probe.error) parts.push(probe.error);
          const caps = probe.capabilities;
          if (caps) {
            parts.push(`embeddings ${caps.embeddings.ok ? t.capOk : t.capMissing}`);
            parts.push(`rerank ${caps.rerank.ok ? t.capOk : t.capMissing}`);
          }
          setExternalStatus(parts.join(' | '));
        } catch (error) {
          setExternalStatus(`${t.externalFail}: ${String(error?.message ?? error)}`);
        } finally {
          setExternalProbing(false);
        }
      };
      /** Build/refresh the RAG index for the currently visible scope. */
      const buildRag = async () => {
        setRagBusy(true);
        setNotice(null);
        try {
          const payload = await callApi('/rag/index', {
            method: 'POST',
            body: {
              root: selectedRoot,
              scope: scope?.kind === 'shared' ? 'shared' : 'session',
              session: data?.currentSessionId
                || data?.selectedSession?.session_id
                || (scope?.kind === 'session' ? scope?.key : '')
                || '',
            },
          });
          if (payload?.ok) {
            setRagIndex({
              built: true,
              docs: payload.docs ?? payload.indexed ?? 0,
              dim: payload.dim ?? 0,
              model: payload.model ?? '',
              built_at: payload.built_at ?? '',
            });
            setNotice({ kind: 'ok', text: `${t.ragBuilt}: ${payload.indexed ?? payload.docs ?? 0}` });
            load(selectedRoot, scope);
          } else {
            setNotice({ kind: 'err', text: `${t.ragBuildFail}: ${payload?.error ?? ''}` });
          }
        } catch (error) {
          setNotice({ kind: 'err', text: `${t.ragBuildFail}: ${String(error?.message ?? error)}` });
        } finally {
          setRagBusy(false);
        }
      };
      /**
       * One export button, three optional types (knowledge / SQL / RAG index),
       * any combination. Each selected type is downloaded as its own file via
       * the API's `content-disposition: attachment`; the browser picks the
       * download folder, so nothing is written to the nearly-full memory disk.
       */
      const toggleExportType = (type) => {
        setExportTypes((current) => (current.includes(type)
          ? current.filter((item) => item !== type)
          : [...current, type]));
      };
      const exportSelected = () => {
        if (exportTypes.length === 0) {
          setNotice({ kind: 'err', text: t.exportPick });
          return;
        }
        const params = new URLSearchParams();
        if (selectedRoot) params.set('root', selectedRoot);
        params.set('scope', scope?.kind === 'shared' ? 'shared' : 'session');
        const session = data?.currentSessionId
          || data?.selectedSession?.session_id
          || (scope?.kind === 'session' ? scope?.key : '');
        if (session) params.set('session', session);
        params.set('format', exportFormat);
        const base = apiBase();
        exportTypes.forEach((type, index) => {
          setTimeout(() => {
            const anchor = document.createElement('a');
            anchor.href = `${base}/ai-for-memory/api/knowledge/export?${params.toString()}&type=${type}`;
            anchor.rel = 'noopener';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
          }, index * 250);
        });
        setNotice({ kind: 'ok', text: t.exportStarted.replace('{n}', String(exportTypes.length)) });
      };
      const saveConversation = async () => {
        if (!selectedSession) return;
        setSessionSaving(true);
        setNotice(null);
        try {
          await callApi('/session', {
            method: 'POST',
            body: {
              root: selectedRoot,
              session: selectedSession.key,
              label: formName.trim(),
              public: formPublic,
            },
          });
          setNotice({ kind: 'ok', text: t.conversationSaved });
          await load(selectedRoot);
        } catch (saveError) {
          setNotice({ kind: 'err', text: `${t.conversationSaveFailed}: ${String(saveError?.message ?? saveError)}` });
        } finally {
          setSessionSaving(false);
        }
      };

      const tabs = [
        { id: 'staging', label: t.tabStaging, count: counts.staging },
        { id: 'archive', label: t.tabArchive, count: counts.archive },
        { id: 'snapshots', label: t.tabSnapshots, count: counts.snapshots },
        { id: 'knowledge', label: t.tabKnowledge, count: counts.knowledge },
        { id: 'decisions', label: t.tabDecisions, count: counts.decisions },
        { id: 'contexts', label: t.tabContexts, count: counts.contexts },
      ];

      const knowledge = (data?.knowledge ?? []).filter((doc) => {
        if (query.trim() === '') return true;
        const needle = query.trim().toLowerCase();
        return String(doc.doc_id).toLowerCase().includes(needle)
          || String(doc.category).toLowerCase().includes(needle)
          || String(doc.source ?? '').toLowerCase().includes(needle)
          || (Array.isArray(doc.tags) ? doc.tags.join(' ') : '').toLowerCase().includes(needle)
          || String(doc.url ?? '').toLowerCase().includes(needle)
          || String(doc.text).toLowerCase().includes(needle);
      });
      const keyOf = (sessionKey, id) => `${sessionKey ?? ''}:${id}`;
      const rowOpen = (key) => openRows.has(key);
      const toggleRow = (key) => setOpenRows((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      const openAll = (keys) => setOpenRows(new Set(keys));
      const collapseAll = () => setOpenRows(new Set());
      const moreRow = (key, total) => h('button', {
        key,
        type: 'button',
        className: 'aim-btn',
        style: styles.button,
        onClick: () => setListLimit((value) => value + 8),
      }, `${t.showMore}（${Math.min(listLimit, total)}/${total}）`);

      // Every row key of the current tab, for "expand all".
      const tabKeys = tab === 'staging'
        ? (data?.staging ?? []).map((row) => keyOf(row.session_key, row.dedup_id))
        : tab === 'archive'
          ? (data?.archive ?? []).flatMap((group) => group.entries.map((row) => keyOf(row.session_key, row.dedup_id)))
          : tab === 'snapshots'
            ? (data?.snapshots ?? []).map((row) => keyOf(row.session_key, row.snapshot_id))
            : tab === 'knowledge'
              ? knowledge.map((doc) => keyOf(doc.session_key, doc.doc_id))
              : tab === 'decisions'
                ? (data?.decisions ?? []).map((row) => keyOf(row.session_key, row.decision_id))
                : (data?.contexts ?? []).map((row) => keyOf(row.session_key, row.context_id));

      let content = null;
      if (tab === 'staging') {
        const rows = data?.staging ?? [];
        content = rows.length === 0
          ? h(Empty, { text: t.emptyStaging })
          : h('div', { style: styles.list },
            ...rows.slice(0, listLimit).map((row) => {
              const key = keyOf(row.session_key, row.dedup_id);
              return h(EntryRow, {
                key,
                rowKey: key,
                open: rowOpen(key),
                onToggle: toggleRow,
                row,
                showSession,
              });
            }),
            rows.length > listLimit ? moreRow('more-staging', rows.length) : null);
      } else if (tab === 'archive') {
        const groups = data?.archive ?? [];
        content = groups.length === 0
          ? h(Empty, { text: t.emptyArchive })
          : h('div', { style: styles.list }, groups.map((group) => {
            const groupKey = `cat:${group.category}`;
            const groupOpen = rowOpen(groupKey);
            const entries = group.entries ?? [];
            return h('section', { key: group.category, style: styles.card },
              h('button', {
                type: 'button',
                style: styles.groupHead,
                'aria-expanded': groupOpen,
                onClick: () => toggleRow(groupKey),
              },
                h('span', { style: styles.logChevron, 'aria-hidden': true }, groupOpen ? '▾' : '▸'),
                h('h3', { style: { ...styles.cardTitle, margin: 0 } }, group.category),
                h('span', { style: styles.tabCount }, String(group.count ?? entries.length))),
              groupOpen
                ? h('div', { style: { ...styles.list, marginTop: '8px' } },
                  ...(entries.length === 0
                    ? [h(Empty, { key: 'empty', text: t.emptyArchive })]
                    : entries.slice(0, listLimit).map((row) => {
                      const key = keyOf(row.session_key, row.dedup_id);
                      return h(EntryRow, {
                        key,
                        rowKey: key,
                        open: rowOpen(key),
                        onToggle: toggleRow,
                        row: { ...row, category: group.category },
                        showSession,
                      });
                    })),
                  entries.length > listLimit ? moreRow(`more-${group.category}`, entries.length) : null)
                : null);
          }));
      } else if (tab === 'snapshots') {
        const rows = data?.snapshots ?? [];
        content = rows.length === 0
          ? h(Empty, { text: t.emptySnapshots })
          : h('div', { style: styles.list },
            ...rows.slice(0, listLimit).map((row) => {
              const key = keyOf(row.session_key, row.snapshot_id);
              return h(LogRow, {
                key,
                rowKey: key,
                open: rowOpen(key),
                onToggle: toggleRow,
                head: [
                  h('span', { key: 'id', style: { fontWeight: 600 } }, row.snapshot_id),
                  showSession && row.session_label
                    ? h('span', { key: 'session', style: badgeStyle('pending') }, row.session_label)
                    : null,
                  h('span', { key: 'size', style: styles.meta }, `${t.size}: ${formatBytes(row.state_size)}`),
                  h('span', { key: 'time', style: { ...styles.meta, marginLeft: 'auto' } }, formatTime(row.timestamp)),
                ],
                preview: row.state_text,
                children: h('pre', { style: styles.pre }, row.state_text),
              });
            }),
            rows.length > listLimit ? moreRow('more-snapshots', rows.length) : null);
      } else if (tab === 'knowledge') {
        const pending = Number(data?.knowledgePending ?? 0);
        content = h('div', { style: styles.list },
          h('div', { style: styles.actions },
            h('input', {
              style: { ...styles.input, maxWidth: '320px' },
              placeholder: t.searchPlaceholder,
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            query !== '' ? h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: () => setQuery('') }, t.clearSearch) : null,
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              onClick: () => setExportOpen((current) => !current),
            }, exportOpen ? t.exportClose : t.exportButton)),
          exportOpen
            ? h('div', {
              style: {
                display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center',
                padding: '8px 10px', border: '1px solid rgba(127, 127, 127, 0.28)', borderRadius: '8px',
              },
            },
            h('label', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center', fontSize: '12.5px' } },
              h('input', {
                type: 'checkbox',
                checked: exportTypes.includes('knowledge'),
                onChange: () => toggleExportType('knowledge'),
              }), t.exportKnowledge),
            h('label', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center', fontSize: '12.5px' } },
              h('input', {
                type: 'checkbox',
                checked: exportTypes.includes('sql'),
                onChange: () => toggleExportType('sql'),
              }), t.exportSql),
            h('label', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center', fontSize: '12.5px' } },
              h('input', {
                type: 'checkbox',
                checked: exportTypes.includes('rag'),
                onChange: () => toggleExportType('rag'),
              }), t.exportRag),
            exportTypes.includes('knowledge')
              ? h('label', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '12.5px' } },
                t.exportFormat,
                h('select', {
                  style: { ...styles.input, width: 'auto', padding: '2px 6px' },
                  value: exportFormat,
                  onChange: (event) => setExportFormat(event.target.value),
                },
                h('option', { value: 'json' }, 'JSON'),
                h('option', { value: 'markdown' }, 'Markdown')))
              : null,
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: exportTypes.length === 0,
              onClick: exportSelected,
            }, `${t.exportRun}（${exportTypes.length}）`))
            : null,
          h('p', { style: styles.hint }, t.exportHint),
          h('p', { style: styles.hint },
            pending > 0 ? `${t.knowledgePending}: ${pending}` : t.knowledgeHint),
          knowledge.length === 0
            ? h(Empty, { text: t.emptyKnowledge })
            : h('div', { style: styles.list },
              ...knowledge.slice(0, listLimit).map((doc) => {
                const key = keyOf(doc.session_key, doc.doc_id);
                return h(LogRow, {
                  key,
                  rowKey: key,
                  open: rowOpen(key),
                  onToggle: toggleRow,
                  head: [
                    h('span', { key: 'id', style: { fontWeight: 600 } }, doc.doc_id),
                    h('span', { key: 'cat', style: badgeStyle('pending') }, doc.category),
                    doc.source ? h('span', { key: 'src', style: badgeStyle('pending') }, doc.source) : null,
                    (doc.tags ?? []).map((tag) => h('span', { key: `tag-${tag}`, style: styles.meta }, `#${tag}`)),
                    showSession && doc.session_label
                      ? h('span', { key: 'session', style: badgeStyle('pending') }, doc.session_label)
                      : null,
                    h('span', { key: 'time', style: { ...styles.meta, marginLeft: 'auto' } },
                      `${t.evidence}: ${doc.evidence_count ?? 0}｜${formatTime(doc.updated_at || doc.created_at)}`),
                  ],
                  preview: doc.text,
                  children: [
                    h('p', { key: 'text', style: styles.content }, doc.text),
                    doc.url ? h('p', { key: 'url', style: styles.hint }, `${t.sourceUrl}: ${doc.url}`) : null,
                  ],
                });
              }),
              knowledge.length > listLimit ? moreRow('more-knowledge', knowledge.length) : null));
      } else if (tab === 'decisions') {
        const rows = data?.decisions ?? [];
        content = rows.length === 0
          ? h(Empty, { text: t.emptyDecisions })
          : h('div', { style: styles.list },
            ...rows.slice(0, listLimit).map((row) => {
              const key = keyOf(row.session_key, row.decision_id);
              return h(LogRow, {
                key,
                rowKey: key,
                open: rowOpen(key),
                onToggle: toggleRow,
                head: [
                  h('span', { key: 'outcome', style: badgeStyle(row.outcome) }, row.outcome),
                  h('span', { key: 'risk', style: badgeStyle(row.risk_level) }, `${t.risk}: ${row.risk_level}`),
                  showSession && row.session_label
                    ? h('span', { key: 'session', style: badgeStyle('pending') }, row.session_label)
                    : null,
                  h('span', { key: 'time', style: { ...styles.meta, marginLeft: 'auto' } }, formatTime(row.timestamp)),
                ],
                preview: row.decision,
                children: [
                  h('p', { key: 'decision', style: styles.content }, row.decision),
                  row.reason ? h('p', { key: 'reason', style: styles.hint }, `${t.reason}: ${row.reason}`) : null,
                  row.thesis || row.antithesis
                    ? h('div', { key: 'thesis', style: styles.meta },
                      row.thesis ? h('span', null, `${t.thesis}: ${row.thesis}`) : null,
                      row.antithesis ? h('span', null, `${t.antithesis}: ${row.antithesis}`) : null)
                    : null,
                ],
              });
            }),
            rows.length > listLimit ? moreRow('more-decisions', rows.length) : null);
      } else if (tab === 'contexts') {
        const rows = data?.contexts ?? [];
        content = rows.length === 0
          ? h(Empty, { text: t.emptyContexts })
          : h('div', { style: styles.list },
            ...rows.slice(0, listLimit).map((row) => {
              const key = keyOf(row.session_key, row.context_id);
              const meta = `第 ${row.turn_from}-${row.turn_to} 轮｜${row.turn_count} 轮｜${row.chars} 字符`;
              return h(LogRow, {
                key,
                rowKey: key,
                open: rowOpen(key),
                onToggle: toggleRow,
                head: [
                  h('span', { key: 'id', style: { fontWeight: 600 } }, row.context_id),
                  h('span', { key: 'label', style: badgeStyle('pending') }, row.label),
                  showSession && row.session_label
                    ? h('span', { key: 'session', style: badgeStyle('pending') }, row.session_label)
                    : null,
                  h('span', { key: 'time', style: { ...styles.meta, marginLeft: 'auto' } }, formatTime(row.created_at)),
                ],
                preview: `${meta}｜${clipPreview(row.text ?? '', 80)}`,
                children: [
                  h('div', { key: 'meta', style: styles.meta },
                    h('span', null, `第 ${row.turn_from}-${row.turn_to} 轮`),
                    h('span', null, `${row.turn_count} 轮`),
                    h('span', null, `${row.chars} 字符`)),
                  row.model_summary
                    ? h('p', { key: 'summary', style: styles.hint }, row.model_summary)
                    : null,
                  row.text ? h('pre', { key: 'text', style: styles.pre }, row.text) : null,
                  h('p', { key: 'hint', style: styles.hint }, t.contextRestoreHint),
                ],
              });
            }),
            rows.length > listLimit ? moreRow('more-contexts', rows.length) : null);
      }

      return h('div', { className: 'aim-page', style: styles.page },
        h('div', { style: styles.header },
          h('div', null,
            h('h2', { style: styles.title }, t.title),
            h('p', { style: styles.subtitle }, t.subtitle)),
          h('div', { style: styles.actions },
            h('label', { style: { ...styles.label, minWidth: '190px' } },
              t.scopeLabel,
              h('select', {
                style: styles.input,
                value: scopeValue,
                onChange: (event) => {
                  const value = event.target.value;
                  if (value === 'all' || value === 'shared') {
                    const next = { kind: value };
                    applyScope(next);
                    load(selectedRoot, next);
                    return;
                  }
                  if (value === 'auto') {
                    const next = { kind: 'session', key: null };
                    applyScope(next);
                    load(selectedRoot, next);
                    return;
                  }
                  // "pick": stay on the current conversation when one is known,
                  // otherwise start from the first saved conversation.
                  pickConversation(activeRow ?? conversationRows[0] ?? null);
                },
              },
              h('option', { value: 'auto' }, t.scopeAuto),
              h('option', { value: 'pick' }, t.scopePick),
              h('option', { value: 'all' }, t.scopeAll),
              h('option', { value: 'shared' }, t.scopeShared))),
            scopeIsSession
              ? h('label', { style: { ...styles.label, minWidth: '190px' } },
                t.scopeWorkspace,
                h('select', {
                  style: styles.input,
                  value: workspaceGroups.some((group) => group.workspace === activeWorkspace)
                    ? activeWorkspace
                    : (workspaceGroups[0]?.workspace ?? ''),
                  onChange: (event) => {
                    const group = workspaceGroups.find((item) => item.workspace === event.target.value);
                    pickConversation(group?.rows.find((row) => row.current) ?? group?.rows[0] ?? null);
                  },
                },
                workspaceGroups.map((group) => h('option', {
                  key: group.workspace,
                  value: group.workspace,
                  title: group.workspace === '' ? t.scopeNoWorkspace : group.workspace,
                }, `${group.short}（${group.rows.length}）`))))
              : null,
            scopeIsSession
              ? h('label', { style: { ...styles.label, minWidth: '210px' } },
                t.scopeConversation,
                h('select', {
                  style: styles.input,
                  value: currentKey ?? '',
                  onChange: (event) => {
                    pickConversation(conversationRows.find((row) => row.key === event.target.value) ?? null);
                  },
                },
                h('option', { value: '' }, conversationRows.length === 0 ? t.scopeNoConversation : t.scopeChooseConversation),
                conversationRows.map((row) => h('option', {
                  key: row.key,
                  value: row.key,
                }, `${conversationName(row)}${row.current ? `（${t.scopeCurrent}）` : ''}${row.public === false ? `（${t.privateBadge}）` : ''}`))))
              : null,
            h('label', { style: { ...styles.label, minWidth: '200px' } },
              t.root,
              h('select', {
                style: styles.input,
                value: selectedRoot ?? '',
                // A conversation key belongs to one root; switching roots must
                // fall back to "let the Host decide the current conversation".
                onChange: (event) => load(event.target.value, { kind: 'session', key: null }),
              },
              roots.length === 0 ? h('option', { value: '' }, t.noRootShort) : null,
              roots.map((row) => h('option', {
                key: row.root,
                value: row.root,
              }, `${row.fixed ? t.fixedRoot : row.label}${row.root === selectedRoot ? '' : ` — ${row.root}`}`)))),
            h('button', {
              type: 'button',
              className: busy ? 'aim-btn aim-pulse' : 'aim-btn',
              style: styles.button,
              disabled: busy,
              onClick: () => load(selectedRoot),
            }, busy ? '…' : t.refresh))),

        notice !== null
          ? h('div', {
            className: 'aim-notice',
            style: {
              ...styles.notice,
              color: notice.kind === 'err' ? colors.error : colors.success,
              borderColor: notice.kind === 'err' ? colors.error : colors.success,
            },
          }, notice.text)
          : null,

        error !== null
          ? h('div', { style: styles.card },
            h('p', { style: styles.hint }, `${t.loadFailed}: ${error}`),
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: () => load(selectedRoot) }, t.retry))
          : null,

        selectedRoot === ''
          ? h('div', { style: styles.card }, h('p', { style: styles.hint }, t.noRoot))
          : h('div', { style: styles.pathRow },
            h('code', { style: styles.path }, selectedRoot),
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: copyPath }, t.copy),
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, disabled: busy, onClick: reveal }, t.reveal)),

        h('p', { style: styles.hint }, scopeHint),
        sharedNote !== '' ? h('p', { style: styles.hint }, sharedNote) : null,

        selectedSession !== null
          ? h('section', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t.conversationSettings),
            h('p', { style: styles.hint }, t.conversationHint),
            h('div', { style: styles.grid2 },
              h('label', { style: styles.label },
                t.conversationName,
                h('input', {
                  style: styles.input,
                  value: formName,
                  placeholder: namePlaceholder,
                  maxLength: 80,
                  onChange: (event) => setFormName(event.target.value),
                })),
              h('div', { style: styles.label },
                t.conversationAccess,
                h('div', { style: styles.modeRow },
                  h('button', {
                    type: 'button',
                    role: 'switch',
                    'aria-checked': formPublic,
                    className: 'aim-switch',
              style: { ...styles.switchOption, ...(formPublic ? styles.switchOptionOn : {}) },
                    onClick: () => setFormPublic(true),
                  }, t.conversationOpen),
                  h('button', {
                    type: 'button',
                    role: 'switch',
                    'aria-checked': !formPublic,
                    className: 'aim-switch',
              style: { ...styles.switchOption, ...(!formPublic ? styles.switchOptionOn : {}) },
                    onClick: () => setFormPublic(false),
                  }, t.conversationClosed)))),
            h('p', { style: styles.hint }, formPublic ? t.conversationOpenHintOn : t.conversationOpenHintOff),
            h('div', { style: styles.meta },
              h('span', { style: styles.mono }, `${t.conversationFolder}: sessions/${selectedSession.key}`),
              selectedSession.sessionId
                ? h('span', { style: styles.mono }, `id: ${String(selectedSession.sessionId).slice(0, 16)}…`)
                : null),
            h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
              h('button', {
                type: 'button',
                className: 'aim-btn',
                style: styles.primary,
                disabled: sessionSaving,
                onClick: saveConversation,
              }, sessionSaving ? t.saving : t.saveConversation)))
          : null,

        h('div', { style: styles.tiles },
          h(Tile, { label: t.counts.staging, value: counts.staging }),
          h(Tile, { label: t.counts.archive, value: counts.archive }),
          h(Tile, { label: t.counts.snapshots, value: counts.snapshots }),
          h(Tile, { label: t.counts.knowledge, value: counts.knowledge }),
          h(Tile, { label: t.counts.decisions, value: counts.decisions }),
          h(Tile, { label: t.counts.contexts, value: counts.contexts })),

        h('div', { className: 'aim-tabs', style: styles.tabs, role: 'tablist' }, tabs.map((item) => {
          const active = tab === item.id;
          return h('button', {
            key: item.id,
            type: 'button',
            role: 'tab',
            'aria-selected': active,
            title: (t.tabHints && t.tabHints[item.id]) || '',
            style: { ...styles.tabBar, ...(active ? styles.tabBarOn : {}) },
            onClick: () => setTab(item.id),
          },
          item.label,
          h('span', { style: styles.tabCount }, String(item.count ?? 0)),
          // The indicator exists only for the selected tab, so switching can
          // never leave the previous tab's underline behind.
          active ? h('span', { 'aria-hidden': 'true', className: 'aim-indicator', style: styles.tabBarIndicator }) : null);
        })),

        h('p', { style: styles.hint }, (t.tabHints && t.tabHints[tab]) || ''),

        h('div', { style: styles.logBar },
          h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: () => openAll(tabKeys) }, t.expandAll),
          h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: collapseAll }, t.collapseAll),
          h('span', { style: styles.hint }, `${t.listShown}：${Math.min(listLimit, tabKeys.length)}/${tabKeys.length}`),
          tabKeys.length > listLimit
            ? h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              onClick: () => setListLimit((value) => value + 8),
            }, t.showMore)
            : null),

        h('div', { key: tab, className: 'aim-content', style: styles.card }, content),

        h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.externalTitle),
          h('p', { style: styles.hint }, t.externalHint),
          h('div', { style: styles.grid2 },
            h('label', { style: styles.label },
              t.externalPreset,
              h('select', {
                style: styles.input,
                value: formPreset,
                onChange: (event) => {
                  const preset = EXTERNAL_PRESETS.find((row) => row.id === event.target.value);
                  setFormPreset(event.target.value);
                  if (!preset || preset.id === 'custom') return;
                  setFormExternalBase(preset.baseUrl);
                  setFormEmbedBase('');
                  setFormRerankBase('');
                  setFormEmbedModel(preset.embedModel);
                  setFormRerankModel(preset.rerankModel);
                },
              }, EXTERNAL_PRESETS.map((preset) => h('option', {
                key: preset.id,
                value: preset.id,
              }, preset.label)))),
            h('label', { style: styles.label },
              t.externalApiKey,
              h('input', {
                style: styles.input,
                type: 'password',
                autoComplete: 'off',
                value: formExternalKey,
                placeholder: hasExternalKey ? t.externalKeySaved : t.externalKeyEmpty,
                onChange: (event) => setFormExternalKey(event.target.value),
              })),
            h('label', { style: styles.label },
              t.externalEmbedApiKey,
              h('input', {
                style: styles.input,
                type: 'password',
                autoComplete: 'off',
                value: formEmbedKey,
                placeholder: hasEmbedKey ? t.externalKeySaved : t.externalKeyEmpty,
                onChange: (event) => setFormEmbedKey(event.target.value),
              })),
            h('label', { style: styles.label },
              t.externalRerankApiKey,
              h('input', {
                style: styles.input,
                type: 'password',
                autoComplete: 'off',
                value: formRerankKey,
                placeholder: hasRerankKey ? t.externalKeySaved : t.externalKeyEmpty,
                onChange: (event) => setFormRerankKey(event.target.value),
              })),
            h('label', { style: styles.label },
              t.externalBase,
              h('input', {
                style: styles.input,
                type: 'url',
                value: formExternalBase,
                placeholder: 'http://127.0.0.1:8080',
                onChange: (event) => setFormExternalBase(event.target.value),
              })),
            h('label', { style: styles.label },
              t.externalModel,
              h('input', {
                style: styles.input,
                value: formExternalModel,
                placeholder: 'qwen2.5-7b-instruct',
                onChange: (event) => setFormExternalModel(event.target.value),
              })),
            h('label', { style: styles.label },
              t.externalTimeout,
              h('input', {
                style: styles.input,
                type: 'number',
                min: 1000,
                max: 600000,
                step: 1000,
                value: formExternalTimeout,
                onChange: (event) => setFormExternalTimeout(event.target.value),
              })),
            h('label', { style: styles.label },
              t.externalEmbedBase,
              h('input', {
                style: styles.input,
                type: 'url',
                value: formEmbedBase,
                placeholder: t.externalSameAs,
                onChange: (event) => setFormEmbedBase(event.target.value),
              })),
            h('label', { style: styles.label },
              t.externalEmbedModel,
              h('input', {
                style: styles.input,
                value: formEmbedModel,
                placeholder: 'bge-m3 / nomic-embed-text',
                onChange: (event) => setFormEmbedModel(event.target.value),
              })),
            h('label', { style: styles.label },
              t.externalRerankBase,
              h('input', {
                style: styles.input,
                type: 'url',
                value: formRerankBase,
                placeholder: t.externalSameAs,
                onChange: (event) => setFormRerankBase(event.target.value),
              })),
            h('label', { style: styles.label },
              t.externalRerankModel,
              h('input', {
                style: styles.input,
                value: formRerankModel,
                placeholder: 'qwen3-reranker-0.6b',
                onChange: (event) => setFormRerankModel(event.target.value),
              }))),
          h('p', { style: styles.hint }, t.externalCloudHint),
          h('div', { style: styles.actions },
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: externalProbing,
              onClick: testExternal,
            }, externalProbing ? t.externalTesting : t.externalTest),
            externalStatus !== '' ? h('span', { style: styles.hint }, externalStatus) : null),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.modeArchive),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': !formArchiveExternal,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formArchiveExternal ? {} : styles.switchOptionOn) },
              onClick: () => setFormArchiveExternal(false),
            }, t.modeLocal),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formArchiveExternal,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formArchiveExternal ? styles.switchOptionOn : {}) },
              onClick: () => setFormArchiveExternal(true),
            }, t.modeExternal)),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.modeKnowledge),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': !formKnowledgeExternal,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formKnowledgeExternal ? {} : styles.switchOptionOn) },
              onClick: () => setFormKnowledgeExternal(false),
            }, t.modeLocal),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formKnowledgeExternal,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formKnowledgeExternal ? styles.switchOptionOn : {}) },
              onClick: () => setFormKnowledgeExternal(true),
            }, t.modeExternal)),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.modeContext),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': !formContextExternal,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formContextExternal ? {} : styles.switchOptionOn) },
              onClick: () => setFormContextExternal(false),
            }, t.modeLocal),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formContextExternal,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formContextExternal ? styles.switchOptionOn : {}) },
              onClick: () => setFormContextExternal(true),
            }, t.modeExternal)),
          h('p', { style: styles.hint }, t.modeHint),
          h('p', { style: styles.hint }, (formArchiveExternal || formKnowledgeExternal || formContextExternal)
            ? t.modeNeedsServer
            : t.modeLocalHint)),

        h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.storageSettings),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.autoMode),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formMode === 'auto',
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formMode === 'auto' ? styles.switchOptionOn : {}) },
              onClick: () => setFormMode('auto'),
            }, t.switchOn),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formMode === 'manual',
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formMode === 'manual' ? styles.switchOptionOn : {}) },
              onClick: () => setFormMode('manual'),
            }, t.switchOff)),
          h('p', { style: styles.hint }, formMode === 'auto' ? t.modeHintAuto : t.modeHintManual),
          formMode === 'auto'
            ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              h('label', { style: { ...styles.label, maxWidth: '220px' } },
                t.modeRounds,
                h('input', {
                  style: styles.input,
                  type: 'number',
                  min: 1,
                  max: 100,
                  value: formRounds,
                  onChange: (event) => setFormRounds(event.target.value),
                })),
              h('label', { style: { ...styles.label, maxWidth: '220px' } },
                t.modeUsage,
                h('input', {
                  style: styles.input,
                  type: 'number',
                  min: 1,
                  max: 100,
                  step: 5,
                  value: formUsage,
                  onChange: (event) => setFormUsage(event.target.value),
                })))
            : null,
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.snapshotTitle),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formAutoSnapshot,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formAutoSnapshot ? styles.switchOptionOn : {}) },
              onClick: () => setFormAutoSnapshot(true),
            }, t.switchOn),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': !formAutoSnapshot,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(!formAutoSnapshot ? styles.switchOptionOn : {}) },
              onClick: () => setFormAutoSnapshot(false),
            }, t.switchOff)),
          h('p', { style: styles.hint }, t.snapshotHint),
          formAutoSnapshot
            ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              h('label', { style: { ...styles.label, maxWidth: '220px' } },
                t.snapshotEvery,
                h('input', {
                  style: styles.input,
                  type: 'number',
                  min: 1,
                  max: 100,
                  value: formSnapshotEvery,
                  onChange: (event) => setFormSnapshotEvery(event.target.value),
                })),
              h('label', { style: { ...styles.label, maxWidth: '220px' } },
                t.snapshotMax,
                h('input', {
                  style: styles.input,
                  type: 'number',
                  min: 1,
                  max: 200,
                  value: formSnapshotMax,
                  onChange: (event) => setFormSnapshotMax(event.target.value),
                })))
            : null,
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.ragTitle),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formRagMount,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formRagMount ? styles.switchOptionOn : {}) },
              onClick: () => {
                if (!ragFormReady) {
                  setNotice({ kind: 'err', text: t.ragNeedModels });
                  return;
                }
                setFormRagMount(true);
              },
            }, t.switchOn),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': !formRagMount,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(!formRagMount ? styles.switchOptionOn : {}) },
              onClick: () => setFormRagMount(false),
            }, t.switchOff)),
          h('p', { style: styles.hint }, formRagMount
            ? t.ragHintOn
            : (ragFormReady ? t.ragHintOff : `${t.ragHintOff} ${t.ragNeedModels}`)),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: ragBusy || !ragFormReady,
              onClick: buildRag,
            }, ragBusy ? t.ragBuilding : t.ragBuild),
            h('span', { style: styles.hint }, ragIndex?.built
              ? `${t.ragIndexed} ${ragIndex.docs} 篇 · ${ragIndex.dim}d · ${ragIndex.model || 'local'}`
              : t.ragNoIndex)),
          ragIndex?.stale
            ? h('p', { style: { ...styles.hint, color: '#c2410c', margin: '6px 0 0' } },
              `${t.ragStale}（${ragIndex.dim}d · ${ragIndex.model || 'local'} → ${ragIndex.current_model || 'local'}）`)
            : null,
          h('p', { style: { ...styles.hint, margin: '8px 0 0' } }, t.storageBase),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.storageSqlTitle),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formStorage === 'sqlite',
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formStorage === 'sqlite' ? styles.switchOptionOn : {}) },
              onClick: () => setFormStorage('sqlite'),
            }, t.switchOn),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formStorage === 'json',
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formStorage === 'json' ? styles.switchOptionOn : {}) },
              onClick: () => setFormStorage('json'),
            }, t.switchOff)),
          h('p', { style: styles.hint }, formStorage === 'sqlite' ? t.storageSqlOn : t.storageSqlOff),
          formStorage === 'sqlite' && data?.knowledgeStorage?.sqliteAvailable === false
            ? h('p', { style: styles.hint }, t.storageSqliteUnavailable)
            : null,
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.defaultPublic),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formDefaultPublic,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formDefaultPublic ? styles.switchOptionOn : {}) },
              onClick: () => setFormDefaultPublic(true),
            }, t.switchOn),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': !formDefaultPublic,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(!formDefaultPublic ? styles.switchOptionOn : {}) },
              onClick: () => setFormDefaultPublic(false),
            }, t.switchOff)),
          h('p', { style: styles.hint }, t.defaultPublicHint),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.clearingTopic),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formTopical,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formTopical ? styles.switchOptionOn : {}) },
              onClick: () => setFormTopical(true),
            }, t.switchOn),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': !formTopical,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(!formTopical ? styles.switchOptionOn : {}) },
              onClick: () => setFormTopical(false),
            }, t.switchOff)),
          h('p', { style: styles.hint }, t.clearingHint),
          formTopical
            ? h('div', { style: styles.grid2 },
              h('label', { style: styles.label },
                t.clearingThreshold,
                h('input', {
                  style: styles.input,
                  type: 'number',
                  min: 0.01,
                  max: 0.95,
                  step: 0.01,
                  value: formThreshold,
                  onChange: (event) => setFormThreshold(event.target.value),
                })),
              h('label', { style: styles.label },
                t.clearingKeep,
                h('input', {
                  style: styles.input,
                  type: 'number',
                  min: 1,
                  max: 20,
                  value: formKeepRecent,
                  onChange: (event) => setFormKeepRecent(event.target.value),
                })))
            : null,
          h('p', { style: styles.hint }, t.storageHint),
          h('div', { style: styles.grid2 },
            h('label', { style: styles.label },
              t.fixedPath,
              h('input', {
                style: styles.input,
                value: formRoot,
                placeholder: 'D:\\ai\\工作区\\ai-for-memory-data',
                onChange: (event) => setFormRoot(event.target.value),
              })),
            h('label', { style: styles.label },
              t.dirName,
              h('input', {
                style: styles.input,
                value: formDir,
                onChange: (event) => setFormDir(event.target.value),
              }))),
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.primary,
              disabled: saving,
              onClick: saveConfig,
            }, saving ? t.saving : t.save))));
    }

    return {
      inject: ['slots'],
      apply(clientCtx) {
        if (typeof clientCtx.effect === 'function') {
          clientCtx.effect(() => installMotionStyles());
        } else {
          installMotionStyles();
        }
        clientCtx.slots.inject('sidebar.panellist', () => clientCtx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 45,
          label: () => t.nav,
        }, (props) => h(PanelIcon, props)));

        clientCtx.slots.inject('main', () => clientCtx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Dashboard));
      },
    };
  },
});
