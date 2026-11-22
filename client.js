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
        navOverview: '总览',
        navLayers: '记忆数据',
        navSystem: '系统',
        navSettings: '设置',
        navDiagnostics: '诊断与修复',
        diagTitle: '诊断与用量',
        diagSubtitle: '运行时健康、知识命中权重、对话占用和面板操作审计。',
        diagRefresh: '重新检查',
        diagHealth: '运行环境',
        diagNode: 'Node',
        diagSqlite: 'node:sqlite',
        diagGit: 'Git',
        diagLlama: 'llama-server',
        diagModels: '本地模型目录',
        diagWritable: '记忆目录可写',
        diagGitignore: 'gitignore 保护',
        diagStorage: '磁盘占用',
        diagSessionRepair: '会话日志修复',
        diagValidator: '校验器',
        diagUsage: '知识命中与权重',
        diagUsageHint: '按权重从低到高排列；权重 0 表示本对话从未命中，可能是死条目。',
        diagHits: '命中',
        diagWeight: '权重',
        diagDead: '未命中',
        diagConversations: '对话占用与批量开放',
        diagBulkOpen: '批量开放',
        diagBulkClose: '批量关闭',
        diagBytes: '磁盘',
        diagAudit: '操作审计',
        diagNoAudit: '还没有审计记录。',
        diagOpenFile: '打开 JSON',
        diagDownload: '下载全文',
        diagCompare: '快照对比',
        diagCompareLeft: '左侧快照',
        diagCompareRight: '右侧快照',
        diagCompareRun: '对比',
        diagNoUsage: '还没有知识条目。',
        diagAvailable: '可用',
        diagUnavailable: '不可用',
        diagNoSnapshotCompare: '至少需要两个快照。',
        diagNoConversations: '还没有对话记忆。',
        diagSessionLogs: '会话日志体检与修复',
        diagSessionLogsHint: 'DSH 的历史对话只要有一条事件结构损坏，整个对话就打不开（stored log is corrupt）。这里直接读 DSH 的 sessions 目录：快速扫描只读文件头，深度体检会解压并校验每个事件。修复前自动备份原文件；当前正在进行的对话不允许就地修复。',
        diagSessionLogScan: '快速扫描',
        diagSessionLogDeep: '深度体检',
        diagSessionLogRepair: '修复',
        diagSessionLogCompact: '重排帧',
        diagSessionLogRepairConfirm: '确认修复',
        diagSessionLogRepairConfirmDropped: '确认修复（将丢弃 {n} 条事件）',
        diagSessionLogCompactConfirm: '确认压缩',
        diagSessionLogBusy: '处理中…',
        diagSessionLogNoLogs: '没有找到会话日志。',
        diagSessionLogOk: '正常',
        diagSessionLogCorrupt: '结构损坏',
        diagSessionLogTorn: '帧未闭合',
        diagSessionLogUnreadable: '无法读取',
        diagSessionLogUnsupported: '版本不支持',
        diagSessionLogUnknown: '未体检',
        sessionLogTitle: '会话日志修复',
        sessionLogHint: '历史对话打不开（stored log is corrupt）时，在这里体检并修复。修复前自动备份原文件；当前正在进行的对话不会被改写，修完重新打开该对话即可。',
        sessionLogSummary: '共 {n} 份，异常 {m} 份',
        sessionLogShallowSummary: '共 {n} 份，尚未深度体检',
        sessionLogShallowHint: '浅扫描只读了文件头；点「深度体检」解压并逐条校验，才能确认有没有损坏。',
        sessionLogAllOk: '全部正常，没有需要处理的日志。',
        sessionLogDanger: '上次会话可能未正常关闭，建议先恢复上下文存档；不要直接继续写入旧对话。',
        sessionLogShallowWarning: '当前只读了文件头，无法确认帧序是否闭合；请点「深度体检」。',
        sessionLogUnavailable: '会话日志修复需要 Node 22.15+；当前 Node 不支持 zstd。',
        sessionLogOversizedWarning: '日志结构正常，但体积/事件数异常偏大；可以「重排帧」缩小，不需要截断历史。',
        sessionLogIdle: '点击「快速扫描」检查会话日志；「深度体检」会解压并逐条校验事件。',
        sessionLogOpenDiagnostics: '在诊断页查看全部',
        overviewTitle: '记忆总览',
        overviewSubtitle: '当前工作区的记忆规模、运行状态和最近活动。',
        overviewHealth: '运行状态',
        overviewRecent: '最近活动',
        overviewQuick: '快捷操作',
        overviewNoRecent: '还没有可展示的记录。',
        overviewGenerated: '更新时间',
        overviewRoot: '当前记忆目录',
        overviewBackend: '知识存储',
        overviewRag: 'RAG 索引',
        overviewNetwork: '网络同步',
        overviewConfigured: '已配置',
        overviewNotConfigured: '未配置',
        overviewOn: '已开启',
        overviewOff: '未开启',
        overviewClear: '上下文清理',
        overviewClearValue: '阈值 {n}%',
        overviewLocalPill: '本地记忆 · 默认不联网',
        overviewSearchPlaceholder: '检索知识库：输入一句话，自动选择 BM25 / SQL / RAG…',
        overviewSearch: '检索',
        overviewContextBehavior: '上下文与自动行为',
        overviewContextBehaviorText: '上下文达到 {n}% 时全量清出已完成轮次；下一次请求前回载当前任务，轮末没有下一次请求则直接清空。最近 {k} 轮始终保留。',
        overviewContextUsage: '上下文占用',
        settingsTitle: '设置',
        settingsSubtitle: '插件内部设置；保存后自动重载，不需要打开 DSH 设置页。',
        settingsGeneral: '常规与上下文',
        settingsModels: '模型与检索',
        settingsLlama: 'llama.cpp',
        settingsAdvanced: '高级策略与保留',
        settingsNetwork: '网络同步',
        settingsConversation: '当前对话',
        settingsBack: '返回总览',
        openSettings: '打开设置',
        viewAll: '查看全部',
        overviewCards: '记忆分层',
        overviewSession: '当前对话',
        overviewSessionEmpty: '还没有登记对话。',
        overviewPrivate: '私有',
        overviewPublic: '已开放',
        sidebarFooter: '本地优先 · 对话隔离',
        navLayersHint: '六层记忆数据',
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
        pendingUpdates: '旧版本待确认知识更新',
        pendingUpdatesHint: '旧版本提炼入队、想改写已有事实但没有写入；核对后再决定是否覆盖。新提炼不再入队。',
        pendingUpdateTarget: '目标',
        pendingAccepted: '已接受更新并写入知识库',
        pendingRejected: '已拒绝这条待确认更新',
        pendingResolveFailed: '处理待确认更新失败',
        conflictsTitle: '知识冲突（只做审计）',
        conflictsOpen: '未确认',
        conflictsResolved: '已确认',
        conflictsHint: '被拦下的写入记录在这里，不会自动应用；确认后才会覆盖知识。模型没转述时，你仍能在这里看到。',
        conflictsTarget: '已有知识',
        conflictsIncoming: '待写入',
        conflictsNone: '最近没有冲突。',
        pendingAccept: '接受并写入',
        pendingReject: '拒绝',
        delete: '删除这条',
        confirmDelete: '再点一次确认删除',
        forgotten: '知识已删除',
        forgetFailed: '删除知识失败',
        searchResult: '检索结果',
        searching: '检索中…',
        searchFailed: '检索失败',
        searchRun: '检索',
        sqlRun: '执行 SQL',
        sqlResult: 'SQL 查询结果',
        sqlPlaceholder: 'SELECT category, count(*) AS n FROM knowledge_docs GROUP BY category',
        contextRestoreTitle: '上下文恢复内容',
        contextRestore: '恢复到当前对话',
        contextSaveTitle: '保存上下文结果',
        contextSave: '保存当前上下文',
        contextSaved: '当前上下文已保存',
        contextClearTitle: '清理上下文结果',
        contextClear: '清理上下文',
        contextClearConfirm: '再点一次确认清理',
        contextClearQueued: '清理已登记，将按策略生效',
        contextActionFailed: '上下文操作失败',
        contextRestored: '上下文已恢复注入，将在下一步生效',
        contextRestoreFailed: '恢复上下文失败',
        snapshotRestoreTitle: '快照状态',
        snapshotRestore: '恢复',
        snapshotRestoreFailed: '读取快照失败',
        contextExportMarkdown: '导出 Markdown',
        quickActions: '立即操作',
        memoryTextPlaceholder: '一段过程记录 / 一条事实 / 事故经过…',
        memoryNamePlaceholder: '快照名或事故标题（可选）',
        memoryTextRequired: '请先填写内容',
        memoryActionDone: '操作完成',
        memoryActionFailed: '操作失败',
        memoryActionResult: '操作结果',
        actionStage: '记过程',
        actionRemember: '写事实',
        actionPromote: '立即提炼',
        actionSnapshot: '打快照',
        actionArchive: '立即归档',
        actionIncident: '记事故',
        askTitle: '外部模型调试',
        askHint: '直接调用 aim_ask：列出远端模型、发一句话看向量、或按 query 对候选做 rerank。用于排查模型名和本地 llama-server。',
        askModels: '列出模型',
        askProbe: '深度探活',
        askChat: 'Chat',
        askEmbed: 'Embed',
        askRerank: 'Rerank',
        askTextPlaceholder: '要发给模型的一句话 / 向量文本 / rerank query',
        askDocsPlaceholder: 'rerank 候选，每行一条（留空则用上面的文本）',
        askFailed: '外部模型调用失败',
        knowledgeHint: '知识库只存结论：三层里提炼出的用户规则/错误修复/决策理由，加上模型写入的内容；每条都带分类与出处。模型通过 remember/learn/incident 写入的内容默认是未确认自述，点「确认这条」后才转为已确认。新内容与库中已有知识或我的认知冲突时，会先问你，确认后才写入。',
        exportButton: '导出',
        exportClose: '收起导出',
        closePanel: '关闭',
        exportKnowledge: '知识库（JSON / Markdown）',
        exportSql: 'SQL 镜像（.sqlite）',
        exportRag: 'RAG 索引',
        exportFormat: '知识库格式',
        exportRun: '导出所选',
        exportPick: '至少选择一种导出类型',
        exportStarted: '已开始下载 {n} 个文件。',
        exportHint: '勾选任意组合：知识库（可选 JSON 无损 / Markdown 可读）、SQL 镜像（完整 .sqlite）、RAG 索引（向量文件）。导出是完整副本，不裁剪、不遗忘，浏览器直接下载到你选定的位置。',
        externalTitle: '外部模型（检索、归档、提炼、清理）',
        externalBase: 'API 地址',
        externalModel: '模型名（可留空）',
        externalTimeout: '超时（毫秒）',
        externalHint: 'Embedding 和 Rerank 不只给 RAG 用：归档分类、知识库提炼和上下文清理也可以走它们。本插件不在进程内加载权重或做推理；推荐用 llama.cpp / Ollama / LM Studio 等工具启动模型，再通过 API 接入。模型配置放在 $DSH_HOME/ai-for-memory/models/，详见「本地模型目录」。',
        localModelsTitle: '本地模型目录（手动放置）',
        localModelsHint: '用户配置从 $DSH_HOME/ai-for-memory/models/ 读取；插件自带的 models/ 只作为可选扫描源，更新插件不会保留里面的 model.json。把文件夹放进 models/Embedding 或 models/Rerank，启动本地服务后在下面一键填入地址。',
        localModelsEmpty: '还没有发现已登记模型。在 $DSH_HOME/ai-for-memory/models/ 下新建模型文件夹和 model.json。',
        localModelsRoot: '目录',
        localModelReady: '已配置 API',
        localModelGguf: '已发现 GGUF（本地引擎）',
        localModelEngineRunning: '本地引擎运行中',
        localModelAdopted: '已接管（插件重启前启动）',
        localModelStaleEngine: '配置已变更，待重启',
        localModelUnconfigured: '未配置 API',
        localModelUse: '填入地址',
        localModelStart: '启动引擎并填入',
        localModelStarting: '启动本地引擎中…',
        localModelStarted: '本地引擎已启动并填入地址；确认后点「保存设置」。',
        localModelStartFailed: '本地引擎启动失败',
        localModelStop: '停止引擎',
        localModelStopConfirm: '停止这个本地引擎？正在使用它的请求会失败。',
        localModelStopped: '本地引擎已停止',
        localModelStopFailed: '停止本地引擎失败',
        localModelCtx: '上下文 ctx-size',
        localModelCtxHint: 'embedding 输入很短，ctx-size 过大会预分配一份常驻 KV cache；按模型能力调小，保存后重启引擎生效。',
        localModelCtxSave: '保存 ctx',
        localModelCtxSaved: 'ctx-size 已保存；重启本地引擎后生效。',
        localModelCtxInvalid: 'ctx-size 必须是 256~131072 的整数。',
        localModelKind: '类型',
        localModelKindUnknown: '未识别',
        localModelKindByName: '按名称识别',
        localModelMarkEmbedding: '标为 Embedding',
        localModelMarkRerank: '标为 Rerank',
        localModelKindSaved: '模型类型已保存。',
        llamaColumns: '两类本地模型',
        llamaEmbeddingColumn: 'Embedding 模型',
        llamaRerankColumn: 'Rerank 模型',
        llamaNoModels: '没有识别出这一类模型。',
        llamaTuneTitle: 'llama.cpp 调参',
        llamaTuneHint: '这些参数写入模型的 model.json 或根目录 .model-meta.json；保存后点击启动，正在运行的实例不会热改。',
        llamaSelectModel: '选择模型',
        llamaModel: '模型',
        llamaCtx: 'ctx-size',
        llamaPort: '端口（0=自动）',
        llamaPooling: 'pooling',
        llamaTimeout: '启动超时（毫秒）',
        llamaBinary: 'llama-server 路径（留空=PATH）',
        llamaExtra: '额外参数（每行一个）',
        llamaSave: '保存模型参数',
        llamaSaved: '模型参数已保存；启动后生效。',
        llamaSaveFailed: '保存模型参数失败',
        llamaStart: '启动这个模型',
        llamaStop: '停止这个模型',
        llamaRunning: '运行中',
        llamaNotRunning: '未运行',
        llamaAutoPort: '自动',
        engineLifecycle: '本地引擎运行方式',
        engineLifecycleManual: '常闭',
        engineLifecycleAlways: '常开',
        engineLifecycleTurn: '每轮开关',
        engineLifecycleManualHint: '只在你点击「启动/停止」时改变；插件不会自动启动或停止任何本地模型。',
        engineLifecycleAlwaysHint: '插件加载时启动所有可运行的本地模型，并在每轮开始前确保它们在运行；不会在轮末停止。已配置的对应端点能连上时跳过，不会重复拉起本地进程。',
        engineLifecycleTurnHint: '检测到可运行的模型时，每轮第一个模型请求前启动，轮末停止；只停由这个模式启动的实例，手动启动的保持不动。已配置端点可达时同样跳过。',
        engineLifecycleDetected: '已检测到可运行的本地模型，该模式会在保存后生效。',
        engineLifecycleNone: '未检测到可运行的本地模型；该模式会在模型就绪后自动生效。',
        engineLifecycleSaveNote: '切换后点上方「保存设置」生效。',
        localModelStale: '模型配置已变更，旧引擎不再复用；请先停止引擎，再重新启动。',
        localModelDiagnostics: '启动失败诊断（llama-server stderr）',
        localModelApplied: '已填入模型地址；确认后点「保存设置」。',
        localModelReserved: '预留分类，尚未接入调用。',
        localModelFuture: '其他目录会按名字显示，插件不限制未来的能力类型。',
        networkTitle: '网络同步（Git，默认关闭）',
        networkHint: '用于多人项目：每台设备是一个 Git 工作副本，主机提供 SSH/HTTP remote，其他设备推送到主机或从主机拉取。默认不联网；请先手动启用。冲突时只报告，不自动覆盖。',
        networkEnable: '启用网络同步',
        networkRole: '本机角色',
        networkHost: '主机',
        networkPeer: '非主机',
        networkRemote: '主机 Git 地址（SSH / HTTP）',
        networkGroup: '项目组（同一局域网）',
        networkPaths: '同步内容',
        networkPathKnowledge: '知识库',
        networkPathArchive: '归档',
        networkPathDecisions: '决策',
        networkPathSnapshots: '快照',
        networkPathStaging: '过程记录',
        networkPathContexts: '上下文（含完整对话，慎选）',
        networkPathSessions: '全部对话目录',
        networkSave: '保存同步设置',
        networkInit: '初始化仓库',
        networkCommit: '提交本地变化',
        networkUpload: '上传到主机',
        networkPull: '从主机拉取',
        networkScan: '检测主机',
        networkStatus: '状态',
        networkClean: '工作区干净',
        networkDirty: '有 {n} 个未提交变化',
        networkNoRepo: '尚未初始化 Git 仓库',
        networkSaved: '同步设置已保存',
        networkBusy: '同步中…',
        networkDone: '操作完成',
        networkFailed: '同步操作失败',
        networkConflict: '拉取/上传被拒绝：主机已有新提交或本地已分叉。不会自动合并，请手动处理后再试。',
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
        modelClaim: '模型自述（未确认）',
        modelClaimHint: '这条来自模型自己的过程记录、推理或事故记录，不是用户确认的事实；检索已降权，请勿当作项目已知事实。确认无误后点「确认这条」清除黄标。',
        verifyClaim: '确认这条',
        verifying: '确认中…',
        verified: '已确认',
        verifyFailed: '确认失败',
        verifyUndone: '已撤销确认，恢复为模型自述',
        verifyUndo: '撤销确认',
        verifyUndoFailed: '撤销确认失败',
        updated: '已更新',
        updatedHint: '这条知识的正文被修改过；展开可见上一版。',
        previousText: '上一版',
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
        defaultPublic: '新对话默认对外开放（建议关）',
        defaultPublicHint: '默认关闭：只有你明确打开某个对话，其他对话才能跨对话检索、恢复它的全文存档。对话存档包含完整 user / assistant 内容，可能含密钥、客户数据；打开前请确认范围。',
        clearingTopic: '按话题相似度清理',
        clearingThreshold: '相似度阈值（越大清得越狠）',
        clearingKeep: '始终保留最近几轮',
        clearingKeepSteps: '始终保留当前轮最近几步',
        clearingHint: '按话题相似度清理：以当轮与上轮为基准，相似度低的老轮次被清出，相似度高的原样保留；清出前先完整存档，随时可以 restore 调回。',
        restoreBudget: '恢复时最多注入字符数',
        advancedHint: '这些是 DSH 记忆内核的硬边界：上下文预算、检索条数、归档字符上限、自动提炼和三层保留。留空/0 的保留天数表示不自动删除。',
        maxContextChars: '上下文窗口总预算（字符）',
        defaultTopK: '默认检索条数 top_k',
        reviewHighRiskOnly: '只审查高风险（medium 自动放行）',
        maxContentChars: '单条知识/记录最大字符',
        maxSnapshotBytes: '快照最大字节',
        maxClearTurns: '单次清理最多轮数',
        minClearChars: '清理最少字符',
        maxClearChars: '清理最多字符',
        autoKnowledge: '自动整理时提炼知识',
        autoKnowledgeLimit: '每次自动提炼上限',
        retentionTitle: '保留与磁盘',
        stagingRetentionDays: '过程记录保留天数（只删已归档）',
        contextRetentionDays: '上下文存档保留天数（0=永不删）',
        decisionRetentionDays: '决策记录保留天数（0=永不删）',
        autoDecisionRetentionDays: '自动活动记录保留天数（只删每轮自动记录，0=永不删）',
        requestAnchor: '系统检查点请求锚点',
        retentionNever: '0 = 永不自动删除',
        storageUsed: '当前记忆目录占用',
        storageContexts: '上下文存档',
        retentionCleanup: '立即执行保留清理',
        retentionConfirm: '立即删除超过保留期的存档？此操作不可撤销（已归档的过程记录会先确认已归档）。',
        retentionCleaning: '清理中…',
        retentionDone: '保留清理完成',
        retentionFailed: '保留清理失败',
        ragTitle: 'RAG 挂载（知识库检索）',
        ragNeedModels: '启用 RAG 需要同时填写 Embedding 模型和 Rerank 模型（在下方「外部模型」区设置）；缺一个都不能挂载。',
        ragHintOn: '已挂载：aim_search 优先用外部嵌入 + 重排检索知识库，结果会标注「检索方式：RAG」；关掉即回到本地 BM25。',
        ragHintOff: '未挂载：aim_search 用本地 BM25 + 哈希向量（离线可用）；打开后改用外部嵌入检索，可随时摘下来。',
        ragBuild: '建立/更新 RAG 索引',
        ragBuilding: '正在建索引…',
        ragBuilt: '索引已更新，共',
        ragBuildFail: '建索引失败',
        ragIndexed: '索引：',
        ragConsidered: '知识库',
        ragDeduped: '语义去重',
        ragTruncated: '超出上限未索引',
        ragStale: '嵌入模型或地址已变化，旧索引维度可能不兼容；请点「建立/更新索引」重建后再检索。',
        ragNoIndex: '尚未建立索引（先建一次）',
        storageBase: 'JSON 文件：始终启用（唯一底座，先写 JSON 供审查与修正；SQL / RAG 都从它派生）',
        storageSqlTitle: 'SQL 只读镜像（派生）',
        storageSqlOn: '已启用：每次写入 JSON 后同步一份 knowledge/knowledge.sqlite，供 SQL 工具查询；关掉不影响 JSON，也不影响 RAG。',
        storageSqlOff: '未启用：只写 JSON 底座；SQL 查询仍会从 JSON 临时建只读表，RAG 也不受影响。',
        storageSqliteUnavailable: '当前 Node 不支持 node:sqlite（需要 Node 22.5+），会继续只用 JSON。',
        searchPlaceholder: '搜索知识库（id/正文/分类/来源/标签）',
        filterCategory: '分类',
        filterSource: '来源',
        filterStatus: '状态',
        all: '全部',
        unverified: '未确认',
        sortUpdated: '按更新时间',
        sortConfidence: '按置信度',
        sortHits: '按命中次数',
        sortWeight: '按权重',
        selectAll: '全选当前列表',
        batchVerify: '批量确认',
        loadedOf: '当前显示',
        cappedNotice: '只加载最新 {n} 条',
        clearSearch: '清空',
        state: '状态',
        time: '时间',
        source: '来源',
        size: '大小',
        category: '分类',
        kind: '类型',
        risk: '风险',
        confidence: '置信度',
        lastChange: '最近变化',
        decisionReviewed: '已审查',
        decisionAuto: '自动放行',
        decisionObserved: '自动记录',
        decisionRoutine: '常规',
        emptyRoutine: '还没有常规记录。',
        decisionApproved: '已批准',
        decisionRejected: '已拒绝',
        decisionGate: '可逆性',
        decisionIrreversible: '不可逆',
        decisionReversible: '可恢复',
        decisionRecoverable: '恢复路径',
        decisionStats: '决策分布',
        overviewLimits: '容量上限',
        overviewSessions: '对话',
        overviewGitignore: '.gitignore 保护',
        gitignoreIgnored: '已忽略',
        gitignoreNoFile: '无 .gitignore',
        gitignoreNotIgnored: '未忽略',
        gitignoreAlready: '目录已存在但未忽略',
        gitignoreCustom: '自定义目录（不适用）',
        gitignoreInvalid: '目录名无效',
        gitignoreError: '读取失败',
        gitignoreNotApplicable: '固定目录（不适用）',
        networkAhead: '领先',
        networkBehind: '落后',
        networkStaged: '已暂存',
        outcome: '结果',
        reason: '理由',
        thesis: '正',
        antithesis: '反',
        storageSettings: '使用与存储设置',
        storageHint: '固定目录：所有项目共用这个文件夹（绝对路径）；留空则每个项目各自保存在工作区下的目录里。保存后插件会自动重载。',
        mcpTitle: 'MCP 出口',
        mcpHint: '把记忆开放给其他 MCP 工具：同一台机器上的客户端连这个地址即可，默认只监听回环地址。工具：aim_roots / aim_search / aim_remember / aim_status / aim_context_list / aim_context_restore。',
        mcpEnabledLabel: '启用 MCP 出口',
        mcpUrlLabel: 'MCP 地址',
        mcpTokenLabel: '访问令牌（可选）',
        mcpTokenSaved: '已设置，留空或填 - 切回自动令牌',
        mcpTokenNone: '未设置；将自动生成到本机文件',
        mcpTokenAuto: '自动令牌文件',
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
        modeHintAuto: '自动整理已开启：每 N 轮按话题相似度整理；上下文占用达到设定百分比时，已完成轮次全部存档并清出，只回载当前请求和最近进展。手动工具仍然可用。',
        fixedPath: '记忆地址（绝对路径，留空=跟随项目）',
        dirName: '目录名（跟随项目时使用）',
        save: '保存设置',
        saving: '保存中…',
        saved: '已保存，正在自动重新加载…',
        savedReloaded: '已保存并自动重新加载',
        savedPendingReload: '已保存；插件仍在自动重载，稍后会刷新',
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
        navOverview: 'Overview',
        navLayers: 'Memory data',
        navSystem: 'System',
        navSettings: 'Settings',
        navDiagnostics: 'Diagnostics & repair',
        diagTitle: 'Diagnostics and usage',
        diagSubtitle: 'Runtime health, knowledge hit weights, conversation disk use and panel audit.',
        diagRefresh: 'Check again',
        diagHealth: 'Runtime',
        diagNode: 'Node',
        diagSqlite: 'node:sqlite',
        diagGit: 'Git',
        diagLlama: 'llama-server',
        diagModels: 'Local models',
        diagWritable: 'Memory directory writable',
        diagGitignore: 'gitignore protection',
        diagStorage: 'Disk use',
        diagSessionRepair: 'Session-log repair',
        diagValidator: 'Validator',
        diagUsage: 'Knowledge hits and weights',
        diagUsageHint: 'Lowest weight first; 0 means never used in this conversation and may be dead.',
        diagHits: 'Hits',
        diagWeight: 'Weight',
        diagDead: 'Never used',
        diagConversations: 'Conversation disk and bulk access',
        diagBulkOpen: 'Open selected',
        diagBulkClose: 'Close selected',
        diagBytes: 'Disk',
        diagAudit: 'Action audit',
        diagNoAudit: 'No audit entries yet.',
        diagOpenFile: 'Open JSON',
        diagDownload: 'Download',
        diagCompare: 'Snapshot compare',
        diagCompareLeft: 'Left snapshot',
        diagCompareRight: 'Right snapshot',
        diagCompareRun: 'Compare',
        diagNoUsage: 'No knowledge entries yet.',
        diagAvailable: 'available',
        diagUnavailable: 'unavailable',
        diagNoSnapshotCompare: 'At least two snapshots are required.',
        diagNoConversations: 'No conversation memory yet.',
        diagSessionLogs: 'Session logs: check and repair',
        diagSessionLogsHint: 'One structurally invalid event makes DSH refuse the whole conversation ("stored log is corrupt"). This reads DSH\'s own sessions directory: a quick scan decodes only the header frame, a deep check decompresses and validates every event. A repair backs up the original first and refuses the live conversation.',
        diagSessionLogScan: 'Quick scan',
        diagSessionLogDeep: 'Deep check',
        diagSessionLogRepair: 'Repair',
        diagSessionLogCompact: 'Re-frame',
        diagSessionLogRepairConfirm: 'Confirm repair',
        diagSessionLogRepairConfirmDropped: 'Confirm repair (drops {n} events)',
        diagSessionLogCompactConfirm: 'Confirm compaction',
        diagSessionLogBusy: 'Working…',
        diagSessionLogNoLogs: 'No session log found.',
        diagSessionLogOk: 'ok',
        diagSessionLogCorrupt: 'corrupt',
        diagSessionLogTorn: 'open frame',
        diagSessionLogUnreadable: 'unreadable',
        diagSessionLogUnsupported: 'unsupported',
        diagSessionLogUnknown: 'not checked',
        sessionLogTitle: 'Session log repair',
        sessionLogHint: 'When a past conversation will not open ("stored log is corrupt"), check and repair it here. The original is backed up first; the live conversation is never rewritten — reopen the repaired conversation afterwards.',
        sessionLogSummary: '{m} of {n} need attention',
        sessionLogShallowSummary: '{n} logs · not deep-checked',
        sessionLogShallowHint: 'A quick scan reads headers only. Run "Deep check" to decompress and validate every event.',
        sessionLogAllOk: 'All normal — nothing to repair.',
        sessionLogDanger: 'The last session may not have closed cleanly. Restore a context archive before writing into it again.',
        sessionLogShallowWarning: 'Only file headers were read; frame closure is not verified. Run "Deep check".',
        sessionLogUnavailable: 'Session-log repair needs Node 22.15+; this Node has no zstd support.',
        sessionLogOversizedWarning: 'The log is structurally valid but unusually large. "Re-frame" can shrink it without truncating history.',
        sessionLogIdle: 'Click "Quick scan" to check session logs; "Deep check" decompresses and validates every event.',
        sessionLogOpenDiagnostics: 'Open full list in Diagnostics',
        overviewTitle: 'Memory overview',
        overviewSubtitle: 'Size, runtime health and recent activity for the selected workspace.',
        overviewHealth: 'Runtime status',
        overviewRecent: 'Recent activity',
        overviewQuick: 'Quick actions',
        overviewNoRecent: 'Nothing to show yet.',
        overviewGenerated: 'Updated',
        overviewRoot: 'Memory root',
        overviewBackend: 'Knowledge storage',
        overviewRag: 'RAG index',
        overviewNetwork: 'Network sync',
        overviewConfigured: 'Configured',
        overviewNotConfigured: 'Not configured',
        overviewOn: 'On',
        overviewOff: 'Off',
        overviewClear: 'Context cleanup',
        overviewClearValue: 'Threshold {n}%',
        overviewLocalPill: 'Local memory · offline by default',
        overviewSearchPlaceholder: 'Search knowledge: ask a question; BM25 / SQL / RAG is chosen automatically…',
        overviewSearch: 'Search',
        overviewContextBehavior: 'Context and automatic behavior',
        overviewContextBehaviorText: 'At {n}% usage, completed turns are fully cleared and the active task is reloaded before the next request; if the turn ends with no next request, the window is cleared. The latest {k} turns stay protected.',
        overviewContextUsage: 'Context usage',
        settingsTitle: 'Settings',
        settingsSubtitle: 'Plugin-local settings. Saving reloads the plugin automatically; no DSH settings page needed.',
        settingsGeneral: 'General & context',
        settingsModels: 'Models & retrieval',
        settingsLlama: 'llama.cpp',
        settingsAdvanced: 'Advanced & retention',
        settingsNetwork: 'Network sync',
        settingsConversation: 'Current conversation',
        settingsBack: 'Back to overview',
        openSettings: 'Open settings',
        viewAll: 'View all',
        overviewCards: 'Memory layers',
        overviewSession: 'Current conversation',
        overviewSessionEmpty: 'No conversation registered yet.',
        overviewPrivate: 'Private',
        overviewPublic: 'Open',
        sidebarFooter: 'Local first · conversation isolated',
        navLayersHint: 'Six memory layers',
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
        pendingUpdates: 'Legacy knowledge updates awaiting confirmation',
        pendingUpdatesHint: 'Queued by older versions when mining wanted to rewrite an existing fact; nothing was written. New mining no longer queues; review before overwriting.',
        pendingUpdateTarget: 'Target',
        pendingAccepted: 'Update accepted and written',
        pendingRejected: 'Pending update rejected',
        pendingResolveFailed: 'Failed to resolve pending update',
        conflictsTitle: 'Knowledge conflicts (audit only)',
        conflictsOpen: 'Unconfirmed',
        conflictsResolved: 'Resolved',
        conflictsHint: 'Blocked writes are logged here and never applied automatically; a fact is overwritten only after you confirm it. If the model forgets to relay the question, this list still shows it.',
        conflictsTarget: 'Existing fact',
        conflictsIncoming: 'Proposed write',
        conflictsNone: 'No recent conflicts.',
        pendingAccept: 'Accept & write',
        pendingReject: 'Reject',
        delete: 'Delete this',
        confirmDelete: 'Click again to confirm',
        forgotten: 'Knowledge deleted',
        forgetFailed: 'Failed to delete knowledge',
        searchResult: 'Search results',
        searching: 'Searching…',
        searchFailed: 'Search failed',
        searchRun: 'Search',
        sqlRun: 'Run SQL',
        sqlResult: 'SQL query results',
        sqlPlaceholder: 'SELECT category, count(*) AS n FROM knowledge_docs GROUP BY category',
        contextRestoreTitle: 'Restored context',
        contextRestore: 'Restore into current chat',
        contextSaveTitle: 'Save context result',
        contextSave: 'Save current context',
        contextSaved: 'Current context saved',
        contextClearTitle: 'Clear context result',
        contextClear: 'Clear context',
        contextClearConfirm: 'Click again to confirm clear',
        contextClearQueued: 'Clear registered and will apply by policy',
        contextActionFailed: 'Context action failed',
        contextRestored: 'Context restored and injected; it applies on the next step',
        contextRestoreFailed: 'Failed to restore context',
        snapshotRestoreTitle: 'Snapshot state',
        snapshotRestore: 'Restore',
        snapshotRestoreFailed: 'Failed to read snapshot',
        contextExportMarkdown: 'Export Markdown',
        quickActions: 'Quick actions',
        memoryTextPlaceholder: 'A process record / fact / incident description…',
        memoryNamePlaceholder: 'Snapshot name or incident title (optional)',
        memoryTextRequired: 'Enter some text first',
        memoryActionDone: 'Action completed',
        memoryActionFailed: 'Action failed',
        memoryActionResult: 'Action result',
        actionStage: 'Log process',
        actionRemember: 'Write fact',
        actionPromote: 'Distill now',
        actionSnapshot: 'Snapshot',
        actionArchive: 'Archive now',
        actionIncident: 'Log incident',
        askTitle: 'External model debug',
        askHint: 'Calls aim_ask directly: list remote models, send a chat/embed request, or rerank candidates. Useful for model-name and llama-server troubleshooting.',
        askModels: 'List models',
        askProbe: 'Deep probe',
        askChat: 'Chat',
        askEmbed: 'Embed',
        askRerank: 'Rerank',
        askTextPlaceholder: 'Prompt / text to embed / rerank query',
        askDocsPlaceholder: 'Rerank candidates, one per line (empty = use the text above)',
        askFailed: 'External model call failed',
        knowledgeHint: 'Knowledge stores conclusions only: user rules, error→fix pairs and decision reasons mined from the three layers, plus model-written content. Each document carries a category and a source. Content written through remember/learn/incident starts as an unverified model claim; click "Confirm this" to accept it. When a new fact conflicts with stored knowledge or with the model’s own understanding, you are asked first and it is stored only after you agree.',
        exportButton: 'Export',
        exportClose: 'Close export',
        closePanel: 'Close',
        exportKnowledge: 'Knowledge base (JSON / Markdown)',
        exportSql: 'SQL mirror (.sqlite)',
        exportRag: 'RAG index',
        exportFormat: 'Knowledge format',
        exportRun: 'Export selected',
        exportPick: 'Pick at least one export type',
        exportStarted: 'Started downloading {n} file(s).',
        exportHint: 'Pick any combination: knowledge base (JSON lossless / Markdown readable), SQL mirror (full .sqlite), RAG index (vector file). The export is a complete copy — nothing trimmed or forgotten — and the browser saves it where you choose.',
        externalTitle: 'External model (search, archive, extraction, cleanup)',
        externalBase: 'API address',
        externalModel: 'Model name (optional)',
        externalTimeout: 'Timeout (ms)',
        externalHint: 'Embedding and Rerank are not only for RAG: archive classification, knowledge extraction and context cleanup can use them too. This plugin does not load weights or run inference in-process; run the model with llama.cpp / Ollama / LM Studio and connect over API. Model configuration goes under $DSH_HOME/ai-for-memory/models/; see "Local model folder".',
        localModelsTitle: 'Local model folder (manual)',
        localModelsHint: 'User configuration is read from $DSH_HOME/ai-for-memory/models/. The plugin-bundled models/ directory is only an optional scan source; model.json there is lost on update. Put a folder in models/Embedding or models/Rerank, start the local server, then fill the address below.',
        localModelsEmpty: 'No registered model found. Create a model folder and model.json under $DSH_HOME/ai-for-memory/models/.',
        localModelsRoot: 'Directory',
        localModelReady: 'API configured',
        localModelGguf: 'GGUF found (local engine)',
        localModelEngineRunning: 'Local engine running',
        localModelAdopted: 'Adopted from before the plugin reload',
        localModelStaleEngine: 'Config changed; restart required',
        localModelUnconfigured: 'API not configured',
        localModelUse: 'Use this address',
        localModelStart: 'Start engine & use',
        localModelStarting: 'Starting local engine…',
        localModelStarted: 'Local engine started and address filled; click "Save settings" to apply.',
        localModelStartFailed: 'Local engine failed to start',
        localModelStop: 'Stop engine',
        localModelStopConfirm: 'Stop this local engine? In-flight requests using it will fail.',
        localModelStopped: 'Local engine stopped',
        localModelStopFailed: 'Failed to stop local engine',
        localModelCtx: 'Context ctx-size',
        localModelCtxHint: 'Embedding inputs are short; a large ctx-size reserves a permanent KV cache. Lower it to the model’s actual need; restart the engine after saving.',
        localModelCtxSave: 'Save ctx',
        localModelCtxSaved: 'ctx-size saved; restart the local engine to apply.',
        localModelCtxInvalid: 'ctx-size must be an integer from 256 to 131072.',
        localModelKind: 'Type',
        localModelKindUnknown: 'Unrecognized',
        localModelKindByName: 'inferred from name',
        localModelMarkEmbedding: 'Mark as Embedding',
        localModelMarkRerank: 'Mark as Rerank',
        localModelKindSaved: 'Model type saved.',
        llamaColumns: 'Local model columns',
        llamaEmbeddingColumn: 'Embedding models',
        llamaRerankColumn: 'Rerank models',
        llamaNoModels: 'No model of this type detected.',
        llamaTuneTitle: 'llama.cpp tuning',
        llamaTuneHint: 'These values are written to the model.json or the root .model-meta.json; save then start. A running instance is not hot-reloaded.',
        llamaSelectModel: 'Select model',
        llamaModel: 'Model',
        llamaCtx: 'ctx-size',
        llamaPort: 'Port (0 = auto)',
        llamaPooling: 'pooling',
        llamaTimeout: 'Startup timeout (ms)',
        llamaBinary: 'llama-server path (empty = PATH)',
        llamaExtra: 'Extra args (one per line)',
        llamaSave: 'Save model settings',
        llamaSaved: 'Model settings saved; start to apply.',
        llamaSaveFailed: 'Failed to save model settings',
        llamaStart: 'Start this model',
        llamaStop: 'Stop this model',
        llamaRunning: 'running',
        llamaNotRunning: 'not running',
        llamaAutoPort: 'auto',
        engineLifecycle: 'Local engine lifecycle',
        engineLifecycleManual: 'Always off',
        engineLifecycleAlways: 'Always on',
        engineLifecycleTurn: 'Per turn',
        engineLifecycleManualHint: 'Engines only change when you press Start/Stop; the plugin never starts or stops one by itself.',
        engineLifecycleAlwaysHint: 'Start every runnable local model at plugin load, and make sure it stays up at the start of each turn. Never stopped at turn end. Skipped when the configured endpoint answers, so a second process is not spawned.',
        engineLifecycleTurnHint: 'When a runnable model is detected, start it before the first model request of a turn and stop the engines this mode started at turn end. Engines started by hand are left running. A reachable configured endpoint also suppresses the start.',
        engineLifecycleDetected: 'A runnable local model was detected; the mode applies after saving.',
        engineLifecycleNone: 'No runnable local model detected yet; the mode will take effect once one is ready.',
        engineLifecycleSaveNote: 'Click "Save settings" above after switching.',
        localModelStale: 'The model configuration changed, so the old engine was not reused. Stop it and start again.',
        localModelDiagnostics: 'Startup diagnostics (llama-server stderr)',
        localModelApplied: 'Model address filled; click "Save settings" to apply.',
        localModelReserved: 'Reserved category; not wired into calls yet.',
        localModelFuture: 'Other folders are shown by name; future capabilities are not restricted.',
        networkTitle: 'Network sync (Git, off by default)',
        networkHint: 'For multi-person projects: each device is a Git worktree; the host provides an SSH/HTTP remote, peers push/pull from it. No network activity until enabled. Conflicts are reported, never auto-overwritten.',
        networkEnable: 'Enable network sync',
        networkRole: 'This device',
        networkHost: 'Host',
        networkPeer: 'Peer',
        networkRemote: 'Host Git remote (SSH / HTTP)',
        networkGroup: 'Project group (same LAN)',
        networkPaths: 'Sync content',
        networkPathKnowledge: 'Knowledge',
        networkPathArchive: 'Archive',
        networkPathDecisions: 'Decisions',
        networkPathSnapshots: 'Snapshots',
        networkPathStaging: 'Process log',
        networkPathContexts: 'Contexts (full conversations; use with care)',
        networkPathSessions: 'All conversation folders',
        networkSave: 'Save sync settings',
        networkInit: 'Initialize repository',
        networkCommit: 'Commit local changes',
        networkUpload: 'Upload to host',
        networkPull: 'Pull from host',
        networkScan: 'Probe host',
        networkStatus: 'Status',
        networkClean: 'Working tree clean',
        networkDirty: '{n} uncommitted change(s)',
        networkNoRepo: 'Git repository not initialized',
        networkSaved: 'Sync settings saved',
        networkBusy: 'Syncing…',
        networkDone: 'Done',
        networkFailed: 'Sync failed',
        networkConflict: 'Push/pull rejected: the host has newer commits or histories diverged. Nothing was auto-merged; resolve manually and retry.',
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
        modelClaim: 'Model claim (unverified)',
        modelClaimHint: 'This came from the model’s own process log, reasoning or incident prose, not from a user-confirmed fact. Retrieval downranks it; do not treat it as established project knowledge. Click "Confirm this" to clear the badge.',
        verifyClaim: 'Confirm this',
        verifying: 'Confirming…',
        verified: 'Confirmed',
        verifyFailed: 'Confirmation failed',
        verifyUndone: 'Confirmation undone; back to a model claim',
        verifyUndo: 'Undo confirmation',
        verifyUndoFailed: 'Could not undo confirmation',
        updated: 'Updated',
        updatedHint: 'The stored text was changed; expand to see the previous version.',
        previousText: 'Previous version',
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
        defaultPublic: 'New conversations open by default (recommended off)',
        defaultPublicHint: 'Off by default: another conversation can search or restore this one only after you explicitly open it. Archives contain full user / assistant text and may hold secrets or customer data; check the scope before opening.',
        clearingTopic: 'Topic similarity',
        clearingThreshold: 'Similarity threshold (higher clears more)',
        clearingKeep: 'Always keep the last N turns',
        clearingKeepSteps: 'Always keep the last N steps of the running turn',
        clearingHint: 'Topic-aware clearing: each older turn is compared with the current and previous turn. Turns that still share the topic stay verbatim; only the ones the conversation has left behind are cleared, and their full text is archived first so restore can always bring them back.',
        restoreBudget: 'Max characters injected by restore',
        advancedHint: 'Hard bounds of the memory core: context budget, retrieval count, archive size limits, auto-distillation and per-layer retention. A retention of 0 means never auto-delete.',
        maxContextChars: 'Context window budget (chars)',
        defaultTopK: 'Default retrieval top_k',
        reviewHighRiskOnly: 'Review high risk only (auto-pass medium)',
        maxContentChars: 'Max chars per knowledge/record entry',
        maxSnapshotBytes: 'Max snapshot bytes',
        maxClearTurns: 'Max turns cleared per run',
        minClearChars: 'Min chars to clear',
        maxClearChars: 'Max chars to clear',
        autoKnowledge: 'Distill knowledge during auto tidy',
        autoKnowledgeLimit: 'Auto-distill items per run',
        retentionTitle: 'Retention & disk',
        stagingRetentionDays: 'Process log retention days (archived only)',
        contextRetentionDays: 'Context archive retention days (0 = never)',
        decisionRetentionDays: 'Decision retention days (0 = never)',
        autoDecisionRetentionDays: 'Auto activity retention days (routine records only, 0 = never)',
        requestAnchor: 'Harness checkpoint request anchor',
        retentionNever: '0 = never auto-delete',
        storageUsed: 'Current memory directory usage',
        storageContexts: 'Context archives',
        retentionCleanup: 'Run retention cleanup now',
        retentionConfirm: 'Delete archives older than the retention window now? This cannot be undone (process records are only removed after archival).',
        retentionCleaning: 'Cleaning…',
        retentionDone: 'Retention cleanup finished',
        retentionFailed: 'Retention cleanup failed',
        ragTitle: 'RAG mount (knowledge search)',
        ragNeedModels: 'RAG needs both an embedding model and a rerank model (set them in External model below). It cannot be mounted with only one.',
        ragHintOn: 'Mounted: aim_search uses external embeddings + rerank over the knowledge layer and marks results as RAG. Turn it off to go back to local BM25.',
        ragHintOff: 'Not mounted: aim_search uses local BM25 + hashing vectors (offline). Turn it on to switch retrieval to the external embedding index; it can be unmounted at any time.',
        ragBuild: 'Build / refresh RAG index',
        ragBuilding: 'Building index…',
        ragBuilt: 'Index updated:',
        ragBuildFail: 'Index build failed',
        ragIndexed: 'Index:',
        ragConsidered: 'knowledge',
        ragDeduped: 'semantic dedupe',
        ragTruncated: 'over cap, not indexed',
        ragStale: 'The embedding model or endpoint changed, so the old index may use an incompatible dimension. Rebuild with "Build / update index" before searching.',
        ragNoIndex: 'No index yet (build once)',
        storageBase: 'JSON files: always on (the single base; everything is written to JSON first for review and correction, and SQL / RAG are derived from it)',
        storageSqlTitle: 'SQL read-only mirror (derived)',
        storageSqlOn: 'On: every JSON write also syncs knowledge/knowledge.sqlite for SQL tools. Turning it off does not affect JSON or RAG.',
        storageSqlOff: 'Off: JSON stays the only base; SQL queries still build a temporary read-only table from JSON, and RAG is unaffected.',
        storageSqliteUnavailable: 'This Node build has no node:sqlite (Node 22.5+ required); JSON only.',
        searchPlaceholder: 'Search the knowledge base (id, text, category, source, tag)',
        filterCategory: 'Category',
        filterSource: 'Source',
        filterStatus: 'Status',
        all: 'All',
        unverified: 'Unverified',
        sortUpdated: 'By update time',
        sortConfidence: 'By confidence',
        sortHits: 'By hits',
        sortWeight: 'By weight',
        selectAll: 'Select shown',
        batchVerify: 'Confirm selected',
        loadedOf: 'Showing',
        cappedNotice: 'only the newest {n} are loaded',
        clearSearch: 'Clear',
        state: 'State',
        time: 'Time',
        source: 'Source',
        size: 'Size',
        category: 'Category',
        kind: 'Kind',
        risk: 'Risk',
        confidence: 'Confidence',
        lastChange: 'Last change',
        decisionReviewed: 'Reviewed',
        decisionAuto: 'Auto-approved',
        decisionObserved: 'Auto-recorded',
        decisionRoutine: 'Routine',
        emptyRoutine: 'No routine records yet.',
        decisionApproved: 'Approved',
        decisionRejected: 'Rejected',
        decisionGate: 'Reversibility',
        decisionIrreversible: 'Irreversible',
        decisionReversible: 'Recoverable',
        decisionRecoverable: 'Recovery path',
        decisionStats: 'Decision mix',
        overviewLimits: 'Limits',
        overviewSessions: 'Conversations',
        overviewGitignore: '.gitignore protection',
        gitignoreIgnored: 'Ignored',
        gitignoreNoFile: 'No .gitignore',
        gitignoreNotIgnored: 'Not ignored',
        gitignoreAlready: 'Directory exists but is not ignored',
        gitignoreCustom: 'Custom directory (not applicable)',
        gitignoreInvalid: 'Invalid directory name',
        gitignoreError: 'Read failed',
        gitignoreNotApplicable: 'Fixed directory (not applicable)',
        networkAhead: 'Ahead',
        networkBehind: 'Behind',
        networkStaged: 'Staged',
        outcome: 'Outcome',
        reason: 'Reason',
        thesis: 'Thesis',
        antithesis: 'Antithesis',
        storageSettings: 'Usage and storage settings',
        storageHint: 'Fixed directory: every project shares this folder (absolute path). Leave empty to keep one memory directory inside each workspace. The plugin reloads after saving.',
        mcpTitle: 'MCP egress',
        mcpHint: 'Expose memory to other MCP tools: a client on this machine can connect to this URL; the listener stays loopback-only. Tools: aim_roots / aim_search / aim_remember / aim_status / aim_context_list / aim_context_restore.',
        mcpEnabledLabel: 'Enable MCP egress',
        mcpUrlLabel: 'MCP URL',
        mcpTokenLabel: 'Access token (optional)',
        mcpTokenSaved: 'Stored; leave empty or enter - to use the automatic token',
        mcpTokenNone: 'Not set; a token is generated in a local file',
        mcpTokenAuto: 'Automatic token file',
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
        modeHintAuto: 'Auto tidy is on: every N turns it uses topic-aware cleanup; when context usage reaches the set percentage, all completed turns are archived and cleared, then only the current request and latest progress are reloaded. Manual tools remain available.',
        fixedPath: 'Memory path (absolute, empty = follow project)',
        dirName: 'Directory name (used when following the project)',
        save: 'Save settings',
        saving: 'Saving…',
        saved: 'Saved; reloading the plugin…',
        savedReloaded: 'Saved and reloaded',
        savedPendingReload: 'Saved; the plugin is still reloading and will refresh shortly',
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
.aim-nav-item { transition: background-color .14s ease, color .14s ease, border-color .14s ease; }
.aim-nav-item:focus { outline: none !important; box-shadow: none !important; }
.aim-nav-item:focus-visible { outline: 2px solid #4d6bfe !important; outline-offset: 1px; }
.aim-nav-item:hover:not(.aim-nav-item-on) { background: rgba(127,127,127,.08); }
.aim-stat-card { transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }
.aim-stat-card:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(0,0,0,.08); border-color: rgba(77,107,254,.35) !important; }
.aim-shell { min-height: 0; }
@media (max-width: 980px) {
  .aim-shell { flex-direction: column !important; overflow: auto !important; height: auto !important; }
  .aim-sidebar { width: auto !important; flex: none !important; border-right: 0 !important; border-bottom: 1px solid rgba(127,127,127,.22); }
  .aim-sidebar .aim-nav-group { flex-direction: row !important; flex-wrap: wrap; }
  .aim-sidebar .aim-nav-group-title { display: none; }
  .aim-app-main { min-height: 0; }
  .aim-settings-shell { flex-direction: column !important; }
  .aim-settings-nav { width: auto !important; flex: none !important; flex-direction: row !important; flex-wrap: wrap; position: static !important; }
  .aim-overview-grid { grid-template-columns: 1fr !important; }
}
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
      accent: '#4d6bfe',
      error: 'var(--dsw-alias-state-error-primary, #d83931)',
      success: 'var(--dsw-alias-state-success-primary, #2ea121)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
    };

    const styles = {
      shell: {
        display: 'flex', height: '100%', minHeight: 0, width: '100%',
        background: colors.bg2, color: colors.label, overflow: 'hidden',
        border: `1px solid ${colors.border}`, borderRadius: '16px',
      },
      sidebar: {
        width: '210px', flex: '0 0 210px', minHeight: 0, overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: '16px',
        padding: '18px 10px 14px', borderRight: `1px solid ${colors.border}`,
        background: colors.bg, boxSizing: 'border-box',
      },
      brand: { display: 'flex', alignItems: 'center', gap: '9px', padding: '0 6px 14px' },
      brandTitle: { fontSize: '14px', fontWeight: 700, margin: 0, lineHeight: 1.25 },
      brandSub: { fontSize: '10.5px', color: colors.secondary, margin: '2px 0 0' },
      navGroup: { display: 'flex', flexDirection: 'column', gap: '3px' },
      navGroupTitle: {
        fontSize: '10.5px', color: colors.secondary, fontWeight: 600,
        letterSpacing: '.04em', padding: '0 10px 4px',
      },
      navItem: {
        display: 'flex', alignItems: 'center', gap: '9px', width: '100%', boxSizing: 'border-box',
        padding: '7px 10px', border: '1px solid transparent', borderRadius: '8px',
        background: 'transparent', color: colors.label, font: 'inherit', fontSize: '12.5px',
        textAlign: 'left', cursor: 'pointer',
      },
      navItemOn: {
        background: 'rgba(77,107,254,.13)', borderColor: 'rgba(77,107,254,.55)',
        color: '#4d6bfe', fontWeight: 650,
      },
      navBadge: {
        marginLeft: 'auto', fontSize: '10.5px', color: colors.secondary,
        fontVariantNumeric: 'tabular-nums',
      },
      sidebarFooter: { marginTop: 'auto', padding: '10px 10px 0', borderTop: `1px solid ${colors.border}` },
      appMain: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
      topbar: {
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        padding: '12px 22px', borderBottom: `1px solid ${colors.border}`,
        background: colors.bg, boxSizing: 'border-box',
      },
      topbarTitle: { display: 'flex', flexDirection: 'column', gap: '1px', marginRight: '4px' },
      topbarTitleText: { fontSize: '15px', fontWeight: 700, margin: 0, lineHeight: 1.3 },
      topbarSubText: { fontSize: '11.5px', color: colors.secondary, margin: 0 },
      topbarActions: { marginLeft: 'auto', display: 'flex', alignItems: 'flex-end', gap: '8px', flexWrap: 'wrap' },
      main: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 24px 36px', boxSizing: 'border-box' },
      page: {
        display: 'flex', flexDirection: 'column', gap: '16px', color: colors.label,
        fontSize: '13px', lineHeight: '1.6', padding: 0,
        maxWidth: '1180px', margin: '0 auto', width: '100%', boxSizing: 'border-box',
        height: 'auto', overflow: 'visible',
      },
      hero: {
        display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
        border: `1px solid ${colors.border}`, borderRadius: '12px', background: colors.bg,
        padding: '16px 18px',
      },
      heroTitle: { fontSize: '20px', fontWeight: 700, margin: 0, lineHeight: 1.25 },
      heroSub: { margin: '3px 0 0', color: colors.secondary, fontSize: '12.5px' },
      overviewToolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      overviewPill: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 9px',
        border: `1px solid ${colors.border}`, borderRadius: '999px',
        color: colors.secondary, background: colors.bg, fontSize: '11.5px', whiteSpace: 'nowrap',
      },
      overviewSearch: { flex: '1 1 300px', minWidth: '220px' },
      overviewNote: {
        border: `1px solid ${colors.border}`, borderRadius: '10px', background: colors.bg,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '4px',
      },
      overviewGrid: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(260px, .8fr)', gap: '14px' },
      settingsShell: { display: 'flex', gap: '18px', alignItems: 'flex-start' },
      settingsNav: {
        width: '184px', flex: '0 0 184px', display: 'flex', flexDirection: 'column', gap: '3px',
        position: 'sticky', top: 0,
      },
      settingsNavItem: {
        display: 'block', width: '100%', boxSizing: 'border-box', padding: '7px 10px',
        border: '1px solid transparent', borderRadius: '8px', background: 'transparent',
        color: colors.label, font: 'inherit', fontSize: '12.5px', textAlign: 'left', cursor: 'pointer',
      },
      settingsNavItemOn: {
        background: 'rgba(77,107,254,.13)', borderColor: 'rgba(77,107,254,.55)',
        color: '#4d6bfe', fontWeight: 650,
      },
      settingsBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' },
      header: {
        display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap',
        padding: '2px 0 14px', borderBottom: `1px solid ${colors.border}`,
        position: 'sticky', top: 0, zIndex: 2, background: colors.bg2,
      },
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
        background: colors.bg2, border: `1px solid ${colors.accent}`, borderRadius: '7px',
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
      tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: '10px' },
      tile: {
        border: `1px solid ${colors.border}`, borderRadius: '12px', background: colors.bg,
        padding: '14px 15px', display: 'flex', flexDirection: 'column', gap: '4px',
      },
      tileLabel: { fontSize: '12px', color: colors.secondary },
      tileValue: { fontSize: '26px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
      tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap', borderBottom: `1px solid ${colors.border}` },
      modeRow: {
        display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center',
        padding: '2px 0',
      },
      tab: {
        font: 'inherit', fontSize: '12.5px', color: colors.secondary, background: 'transparent',
        border: 'none', borderBottom: '2px solid transparent', padding: '7px 10px',
        cursor: 'pointer', display: 'flex', gap: '6px', alignItems: 'center',
      },
      tabOn: { color: colors.label, borderBottomColor: colors.accent, fontWeight: 600 },
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
        fontSize: '12px', lineHeight: '1.4', minHeight: '26px',
        color: colors.secondary, background: colors.bg2,
        border: `1px solid ${colors.border}`, borderRadius: '999px', padding: '3px 11px', cursor: 'pointer',
        textDecoration: 'none', boxShadow: 'none', whiteSpace: 'nowrap',
      },
      switchOptionOn: {
        color: colors.accent, fontWeight: 650, background: colors.bg,
        borderColor: colors.accent, boxShadow: 'inset 0 0 0 1px rgba(77,107,254,.18)',
      },
      tabBarIndicator: {
        position: 'absolute', left: '8px', right: '8px', bottom: '-1px', height: '2px',
        borderRadius: '2px', background: colors.accent,
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
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
        props.leading
          ? h('span', { key: 'leading', style: { display: 'flex', alignItems: 'center', paddingLeft: '2px' } }, props.leading)
          : null,
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
        props.actions
          ? h('span', { key: 'row-actions', style: { display: 'flex', alignItems: 'center', gap: '4px' } }, props.actions)
          : null,
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
            row.dedup_id ? h('span', { style: styles.mono }, row.dedup_id.slice(0, 10)) : null,
            Number.isInteger(row.entry_index)
              ? h('span', { style: styles.mono }, `#${row.entry_index}`)
              : null) : null,
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
      // Top-level page: overview / one memory layer / the plugin's own settings.
      const [view, setView] = React.useState('overview');
      const [settingsSection, setSettingsSection] = React.useState('general');
      const [query, setQuery] = React.useState('');
      // Overview search is a shortcut into the knowledge layer, not a second
      // independent filter: pressing Enter opens the same filtered list.
      const [overviewQuery, setOverviewQuery] = React.useState('');
      // Server-side retrieval / debug / maintenance output. `toolText` is a
      // shared result card so search, SQL and memory actions do not need four
      // different inline renderers.
      const [toolTitle, setToolTitle] = React.useState('');
      const [toolText, setToolText] = React.useState('');
      const [toolBusy, setToolBusy] = React.useState('');
      const [sqlQuery, setSqlQuery] = React.useState('');
      const [deleteArmed, setDeleteArmed] = React.useState('');
      const [contextClearArmed, setContextClearArmed] = React.useState(false);
      const [pendingBusy, setPendingBusy] = React.useState('');
      // Compact memory-action form (stage/remember/promote/snapshot/archive/incident).
      const [memoryAction, setMemoryAction] = React.useState('remember');
      const [memoryText, setMemoryText] = React.useState('');
      const [memoryName, setMemoryName] = React.useState('');
      const [askAction, setAskAction] = React.useState('models');
      const [askText, setAskText] = React.useState('ping');
      const [askDocs, setAskDocs] = React.useState('');
      const [askBusy, setAskBusy] = React.useState(false);
      const [askResult, setAskResult] = React.useState('');
      const [retentionBusy, setRetentionBusy] = React.useState(false);
      // Diagnostics is a separate top-level page: health, usage weights,
      // conversation bytes and the panel action audit in one place.
      const [diagnostics, setDiagnostics] = React.useState(null);
      const [diagnosticsBusy, setDiagnosticsBusy] = React.useState(false);
      const [selectedConversations, setSelectedConversations] = React.useState(() => new Set());
      const [bulkBusy, setBulkBusy] = React.useState('');
      const [sessionLogScan, setSessionLogScan] = React.useState(null);
      const [sessionLogBusy, setSessionLogBusy] = React.useState('');
      const [sessionLogArmed, setSessionLogArmed] = React.useState('');
      const [sessionLogPreview, setSessionLogPreview] = React.useState(null);
      const [sessionLogResult, setSessionLogResult] = React.useState('');
      const [snapshotCompare, setSnapshotCompare] = React.useState({ left: '', right: '', result: null, error: '' });
      // Knowledge filters and multi-select. Filters operate on the rows already
      // returned by /state; the total/returned metadata is shown so a capped
      // list never looks like data loss.
      const [knowledgeCategory, setKnowledgeCategory] = React.useState('all');
      const [knowledgeSource, setKnowledgeSource] = React.useState('all');
      const [knowledgeStatus, setKnowledgeStatus] = React.useState('all');
      const [knowledgeSort, setKnowledgeSort] = React.useState('updated');
      const [selectedKnowledge, setSelectedKnowledge] = React.useState(() => new Set());
      const [knowledgeBusy, setKnowledgeBusy] = React.useState('');
      // Log lists collapse: `openRows` holds the row keys the user opened and
      // `listLimit` how many rows each list shows before "show more".
      const [openRows, setOpenRows] = React.useState(() => new Set());
      const [listLimit, setListLimit] = React.useState(8);
      const [notice, setNotice] = React.useState(null);
      // One reminder per panel open: the panel must not nag again after the
      // user stops an engine on purpose, but a fresh open (or a reloaded page
      // after a DSH restart) should still say that the model is not running.
      const engineReminder = React.useRef({ checked: false, text: '' });
      const [formRoot, setFormRoot] = React.useState('');
      const [formDir, setFormDir] = React.useState('.ai-for-memory');
      const [formMode, setFormMode] = React.useState('manual');
      const [formEngineLifecycle, setFormEngineLifecycle] = React.useState('manual');
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
      const [formDefaultPublic, setFormDefaultPublic] = React.useState(false);
      const [formTopical, setFormTopical] = React.useState(true);
      const [formThreshold, setFormThreshold] = React.useState(0.05);
      const [formKeepRecent, setFormKeepRecent] = React.useState(2);
      const [formKeepSteps, setFormKeepSteps] = React.useState(3);
      const [formRestoreMax, setFormRestoreMax] = React.useState(12000);
      const [formMaxContext, setFormMaxContext] = React.useState(30000);
      const [formTopK, setFormTopK] = React.useState(5);
      const [formReviewHighRiskOnly, setFormReviewHighRiskOnly] = React.useState(true);
      const [formMaxContent, setFormMaxContent] = React.useState(20000);
      const [formMaxSnapshotBytes, setFormMaxSnapshotBytes] = React.useState(262144);
      const [formMaxClearTurns, setFormMaxClearTurns] = React.useState(8);
      const [formMinClearChars, setFormMinClearChars] = React.useState(200);
      const [formMaxClearChars, setFormMaxClearChars] = React.useState(120000);
      const [formAutoKnowledge, setFormAutoKnowledge] = React.useState(true);
      const [formAutoKnowledgeLimit, setFormAutoKnowledgeLimit] = React.useState(10);
      const [formStagingRetention, setFormStagingRetention] = React.useState(30);
      const [formContextRetention, setFormContextRetention] = React.useState(0);
      const [formDecisionRetention, setFormDecisionRetention] = React.useState(0);
      const [formAutoDecisionRetention, setFormAutoDecisionRetention] = React.useState(90);
      const [formRequestAnchor, setFormRequestAnchor] = React.useState(true);
      // RAG is mounted on the knowledge layer: the switch decides whether
      // aim_search uses the vector index; building the index is a separate click.
      const [formRagMount, setFormRagMount] = React.useState(false);
      // MCP egress for other local tools. The token is write-only: state only
      // reports whether one is stored, never the value.
      const [formMcpEnabled, setFormMcpEnabled] = React.useState(true);
      const [formMcpToken, setFormMcpToken] = React.useState('');
      const [mcpHasToken, setMcpHasToken] = React.useState(false);
      const [mcpTokenFile, setMcpTokenFile] = React.useState('');
      const [ragIndex, setRagIndex] = React.useState({
        built: false, docs: 0, considered: 0, truncated: 0, deduped: 0, dim: 0, model: '', built_at: '',
      });
      const [ragBusy, setRagBusy] = React.useState(false);
      // Knowledge storage backend: 'json' (files) or 'sqlite' (queryable db).
      const [formStorage, setFormStorage] = React.useState('json');
      // Git network sync is device-local and off by default.
      const [formNetworkEnabled, setFormNetworkEnabled] = React.useState(false);
      const [formNetworkRole, setFormNetworkRole] = React.useState('peer');
      const [formNetworkRemote, setFormNetworkRemote] = React.useState('');
      const [formNetworkGroup, setFormNetworkGroup] = React.useState('');
      const [formNetworkPaths, setFormNetworkPaths] = React.useState(['knowledge', 'archive', 'decisions', 'snapshots']);
      const [networkStatus, setNetworkStatus] = React.useState(null);
      const [networkBusy, setNetworkBusy] = React.useState(false);
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
      const [localModelBusy, setLocalModelBusy] = React.useState('');
      const [localCtxDrafts, setLocalCtxDrafts] = React.useState({});
      const [llamaModelId, setLlamaModelId] = React.useState('');
      const [llamaCtx, setLlamaCtx] = React.useState(2048);
      const [llamaPort, setLlamaPort] = React.useState(0);
      const [llamaPooling, setLlamaPooling] = React.useState('');
      const [llamaTimeout, setLlamaTimeout] = React.useState(120000);
      const [llamaBinary, setLlamaBinary] = React.useState('');
      const [llamaExtra, setLlamaExtra] = React.useState('');
      const [externalStatus, setExternalStatus] = React.useState('');
      const [formArchiveExternal, setFormArchiveExternal] = React.useState(false);
      const [formKnowledgeExternal, setFormKnowledgeExternal] = React.useState(false);
      const [formContextExternal, setFormContextExternal] = React.useState(false);
      const [formName, setFormName] = React.useState('');
      const [formPublic, setFormPublic] = React.useState(true);
      const [saving, setSaving] = React.useState(false);
      const [sessionSaving, setSessionSaving] = React.useState(false);
      const [verifyingId, setVerifyingId] = React.useState('');

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
          if (['manual', 'always', 'turn'].includes(payload.engineLifecycle)) setFormEngineLifecycle(payload.engineLifecycle);
          if (Number.isInteger(payload.autoEveryRounds)) setFormRounds(payload.autoEveryRounds);
          if (typeof payload.autoSnapshot === 'boolean') setFormAutoSnapshot(payload.autoSnapshot);
          if (Number.isInteger(payload.autoSnapshotEvery)) setFormSnapshotEvery(payload.autoSnapshotEvery);
          if (Number.isInteger(payload.autoSnapshotMax)) setFormSnapshotMax(payload.autoSnapshotMax);
          if (Number.isInteger(payload.contextUsagePercent)) setFormUsage(payload.contextUsagePercent);
          if (typeof payload.defaultPublic === 'boolean') setFormDefaultPublic(payload.defaultPublic);
          if (typeof payload.topicalClear === 'boolean') setFormTopical(payload.topicalClear);
          if (typeof payload.ragMount === 'boolean') setFormRagMount(payload.ragMount);
          if (typeof payload.mcpEnabled === 'boolean') setFormMcpEnabled(payload.mcpEnabled);
          setMcpHasToken(payload.mcpHasToken === true);
          setMcpTokenFile(typeof payload.mcpTokenFile === 'string' ? payload.mcpTokenFile : '');
          setFormMcpToken('');
          if (payload.ragIndex && typeof payload.ragIndex === 'object') setRagIndex(payload.ragIndex);
          if (payload.knowledgeBackend === 'sqlite' || payload.knowledgeBackend === 'json') {
            setFormStorage(payload.knowledgeBackend);
          }
          if (payload.network && typeof payload.network === 'object') {
            setFormNetworkEnabled(payload.network.enabled === true);
            setFormNetworkRole(payload.network.role === 'host' ? 'host' : 'peer');
            setFormNetworkRemote(typeof payload.network.remote === 'string' ? payload.network.remote : '');
            setFormNetworkGroup(typeof payload.network.group === 'string' ? payload.network.group : '');
            if (Array.isArray(payload.network.paths)) setFormNetworkPaths(payload.network.paths);
          }
          if (typeof payload.similarityThreshold === 'number') setFormThreshold(payload.similarityThreshold);
          if (Number.isInteger(payload.keepRecentTurns)) setFormKeepRecent(payload.keepRecentTurns);
          if (Number.isInteger(payload.keepRecentSteps)) setFormKeepSteps(payload.keepRecentSteps);
          if (Number.isInteger(payload.restoreMaxChars)) setFormRestoreMax(payload.restoreMaxChars);
          if (Number.isInteger(payload.maxContextChars)) setFormMaxContext(payload.maxContextChars);
          if (Number.isInteger(payload.defaultTopK)) setFormTopK(payload.defaultTopK);
          if (typeof payload.reviewHighRiskOnly === 'boolean') setFormReviewHighRiskOnly(payload.reviewHighRiskOnly);
          if (Number.isInteger(payload.maxContentChars)) setFormMaxContent(payload.maxContentChars);
          if (Number.isInteger(payload.maxSnapshotBytes)) setFormMaxSnapshotBytes(payload.maxSnapshotBytes);
          if (Number.isInteger(payload.maxClearTurns)) setFormMaxClearTurns(payload.maxClearTurns);
          if (Number.isInteger(payload.minClearChars)) setFormMinClearChars(payload.minClearChars);
          if (Number.isInteger(payload.maxClearChars)) setFormMaxClearChars(payload.maxClearChars);
          if (typeof payload.autoKnowledge === 'boolean') setFormAutoKnowledge(payload.autoKnowledge);
          if (Number.isInteger(payload.autoKnowledgeLimit)) setFormAutoKnowledgeLimit(payload.autoKnowledgeLimit);
          if (Number.isInteger(payload.stagingRetentionDays)) setFormStagingRetention(payload.stagingRetentionDays);
          if (Number.isInteger(payload.contextRetentionDays)) setFormContextRetention(payload.contextRetentionDays);
          if (Number.isInteger(payload.decisionRetentionDays)) setFormDecisionRetention(payload.decisionRetentionDays);
          if (Number.isInteger(payload.autoDecisionRetentionDays)) setFormAutoDecisionRetention(payload.autoDecisionRetentionDays);
          if (typeof payload.requestAnchor === 'boolean') setFormRequestAnchor(payload.requestAnchor);
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
          setFormPublic(selected?.public === true);
          applyScope({
            kind: typeof payload.scope === 'string' ? payload.scope : kind,
            key: payload?.selectedSession?.key ?? (kind === 'session' ? (active?.key ?? null) : null),
          });
          return payload;
        } catch (fetchError) {
          setError(String(fetchError?.message ?? fetchError));
          return null;
        } finally {
          setBusy(false);
        }
      }, [applyScope]);

      React.useEffect(() => { load(); }, [load]);

      React.useEffect(() => {
        if (data == null) return;
        const reminder = typeof data.localEngineReminder === 'string' ? data.localEngineReminder : '';
        if (!engineReminder.current.checked) {
          engineReminder.current.checked = true;
          if (reminder !== '') {
            engineReminder.current.text = reminder;
            setNotice({ kind: 'err', text: reminder });
          }
          return;
        }
        // The engines caught up (for example, started from another tab or the
        // CLI): drop the stale line, but never a notice from another action.
        if (reminder === '' && engineReminder.current.text !== '') {
          const previous = engineReminder.current.text;
          engineReminder.current.text = '';
          setNotice((current) => (current?.text === previous ? null : current));
        }
      }, [data]);

      const selectedRoot = data?.selectedRoot ?? '';
      const localModelRows = (data?.localModels?.categories ?? [])
        .flatMap((category) => (category.models ?? []).map((model) => ({ ...model, category: category.name })));
      const llamaModelKind = (model) => String(model?.kind ?? '').toLowerCase();
      const llamaModels = localModelRows.filter((model) => model.runnable
        && ['embedding', 'rerank'].includes(llamaModelKind(model)));
      const llamaSelected = llamaModels.find((model) => model.id === llamaModelId) ?? null;
      React.useEffect(() => {
        if (llamaModelId === '' && llamaModels.length > 0) setLlamaModelId(llamaModels[0].id);
      }, [llamaModelId, localModelRows.length]);
      React.useEffect(() => {
        const model = llamaModels.find((row) => row.id === llamaModelId);
        if (!model) return;
        setLlamaCtx(model.ctxSize > 0 ? model.ctxSize : 2048);
        setLlamaPort(model.port > 0 ? model.port : 0);
        setLlamaPooling(model.pooling ?? '');
        setLlamaTimeout(model.startupTimeoutMs > 0 ? model.startupTimeoutMs : 120000);
        setLlamaBinary(model.binary ?? '');
        setLlamaExtra(Array.isArray(model.extraArgs) ? model.extraArgs.join('\n') : '');
      }, [llamaModelId, data?.localModels]);
      const roots = Array.isArray(data?.roots) ? data.roots : [];
      const gitignoreWarning = typeof data?.gitignore?.warning === 'string' ? data.gitignore.warning : '';
      const gitignoreState = data?.gitignore?.state ?? '';
      const gitignoreText = data?.gitignore === null || data?.gitignore === undefined
        ? t.gitignoreNotApplicable
        : ({
          ignored: t.gitignoreIgnored,
          'no-gitignore': t.gitignoreNoFile,
          'not-ignored': t.gitignoreNotIgnored,
          'already-created': t.gitignoreAlready,
          'custom-root': t.gitignoreCustom,
          'invalid-directory': t.gitignoreInvalid,
          error: t.gitignoreError,
        }[gitignoreState] ?? gitignoreState)
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
        if (name !== '') return name;
        const id = String(row.sessionId || row.key || '');
        if (id === '') return '';
        // Keys and ids share a long prefix; the tail is what distinguishes
        // conversations in the picker.
        return id.length > 12 ? id.slice(-8) : id.slice(0, 8);
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
        const body = {
          root: formRoot.trim(),
          directoryName: formDir.trim(),
          autoEnabled: formMode === 'auto',
          autoEveryRounds: Number(formRounds) || 5,
          engineLifecycle: formEngineLifecycle,
          autoSnapshot: formAutoSnapshot,
          autoSnapshotEvery: Number(formSnapshotEvery) || 5,
          autoSnapshotMax: Number(formSnapshotMax) || 10,
          contextUsagePercent: Number(formUsage) || 70,
          defaultPublic: formDefaultPublic,
          topicalClear: formTopical,
          ragMount: formRagMount,
          mcpEnabled: formMcpEnabled,
          mcpToken: formMcpToken.trim(),
          knowledgeBackend: formStorage,
          similarityThreshold: Number(formThreshold) || 0.05,
          keepRecentTurns: Number(formKeepRecent) || 2,
          keepRecentSteps: Number(formKeepSteps) || 3,
          restoreMaxChars: Number(formRestoreMax) || 12000,
          maxContextChars: Number(formMaxContext) || 30000,
          defaultTopK: Number(formTopK) || 5,
          reviewHighRiskOnly: formReviewHighRiskOnly,
          maxContentChars: Number(formMaxContent) || 20000,
          maxSnapshotBytes: Number(formMaxSnapshotBytes) || 262144,
          maxClearTurns: Number(formMaxClearTurns) || 8,
          minClearChars: Number(formMinClearChars) || 0,
          maxClearChars: Number(formMaxClearChars) || 120000,
          autoKnowledge: formAutoKnowledge,
          autoKnowledgeLimit: Number(formAutoKnowledgeLimit) || 10,
          stagingRetentionDays: Number(formStagingRetention) || 0,
          contextRetentionDays: Number(formContextRetention) || 0,
          decisionRetentionDays: Number(formDecisionRetention) || 0,
          autoDecisionRetentionDays: Number(formAutoDecisionRetention) || 0,
          requestAnchor: formRequestAnchor,
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
        };
        // The config editor reconciles the profile before /config resolves, so
        // the next state read normally shows the new values. Poll briefly anyway:
        // a slow reload must not leave the panel displaying stale settings.
        const expectedHasToken = true;
        const configMatches = (payload) => Boolean(payload)
          && payload.fixedRoot === body.root
          && payload.directoryName === body.directoryName
          && payload.autoEnabled === body.autoEnabled
          && payload.autoEveryRounds === body.autoEveryRounds
          && payload.engineLifecycle === body.engineLifecycle
          && payload.autoSnapshot === body.autoSnapshot
          && payload.autoSnapshotEvery === body.autoSnapshotEvery
          && payload.autoSnapshotMax === body.autoSnapshotMax
          && payload.contextUsagePercent === body.contextUsagePercent
          && payload.defaultPublic === body.defaultPublic
          && payload.topicalClear === body.topicalClear
          && payload.ragMount === body.ragMount
          && payload.mcpEnabled === body.mcpEnabled
          && payload.mcpHasToken === expectedHasToken
          && payload.knowledgeBackend === body.knowledgeBackend
          && payload.similarityThreshold === body.similarityThreshold
          && payload.keepRecentTurns === body.keepRecentTurns
          && payload.keepRecentSteps === body.keepRecentSteps
          && payload.restoreMaxChars === body.restoreMaxChars
          && payload.maxContextChars === body.maxContextChars
          && payload.defaultTopK === body.defaultTopK
          && payload.reviewHighRiskOnly === body.reviewHighRiskOnly
          && payload.maxContentChars === body.maxContentChars
          && payload.maxSnapshotBytes === body.maxSnapshotBytes
          && payload.maxClearTurns === body.maxClearTurns
          && payload.minClearChars === body.minClearChars
          && payload.maxClearChars === body.maxClearChars
          && payload.autoKnowledge === body.autoKnowledge
          && payload.autoKnowledgeLimit === body.autoKnowledgeLimit
          && payload.stagingRetentionDays === body.stagingRetentionDays
          && payload.contextRetentionDays === body.contextRetentionDays
          && payload.decisionRetentionDays === body.decisionRetentionDays
          && payload.autoDecisionRetentionDays === body.autoDecisionRetentionDays
          && payload.requestAnchor === body.requestAnchor
          && payload.externalBaseUrl === body.externalBaseUrl
          && payload.externalModel === body.externalModel
          && payload.externalTimeoutMs === body.externalTimeoutMs
          && payload.externalEmbedBaseUrl === body.externalEmbedBaseUrl
          && payload.externalEmbedModel === body.externalEmbedModel
          && payload.externalRerankBaseUrl === body.externalRerankBaseUrl
          && payload.externalRerankModel === body.externalRerankModel
          && payload.archiveExternal === body.archiveExternal
          && payload.knowledgeExternal === body.knowledgeExternal
          && payload.contextExternal === body.contextExternal;
        try {
          await callApi('/config', { method: 'POST', body });
          setNotice({ kind: 'ok', text: t.saved });
          const deadline = Date.now() + 8000;
          let refreshed = null;
          do {
            refreshed = await load('');
            if (configMatches(refreshed)) {
              setNotice({ kind: 'ok', text: t.savedReloaded });
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
          } while (Date.now() < deadline);
          setNotice({ kind: 'ok', text: t.savedPendingReload });
          setTimeout(() => load(''), 1500);
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
      /** Fill endpoint fields from a discovered model folder, starting the local engine when it has a GGUF. */
      const applyLocalModel = async (category, model) => {
        if (!model) return;
        const capability = String(category === 'Loose' ? model.kind : category ?? '').toLowerCase();
        if (!capability.includes('embed') && !capability.includes('rerank')) {
          // Routing and future categories are discovery-only until the plugin
          // has a consumer for them. Do not silently stuff them into the chat
          // endpoint.
          setNotice({ kind: 'ok', text: t.localModelReserved });
          return;
        }
        const fill = (baseUrl, modelName) => {
          if (capability.includes('embed')) {
            setFormEmbedBase(baseUrl);
            setFormEmbedModel(modelName);
          } else {
            setFormRerankBase(baseUrl);
            setFormRerankModel(modelName);
          }
        };
        if (model.runnable === true) {
          setLocalModelBusy(model.id);
          setNotice({ kind: 'ok', text: t.localModelStarting });
          try {
            const payload = await callApi('/local-engine/start', {
              method: 'POST',
              body: { model: model.id },
            });
            if (payload?.ok !== true || !payload?.endpoint) {
              setNotice({
                kind: 'err',
                text: payload?.stale === true
                  ? t.localModelStale
                  : `${t.localModelStartFailed}: ${clipPreview(payload?.error ?? '', 500)}`,
              });
              // Refresh the engine list so the persistent diagnostics block
              // below the model row keeps the stderr tail, not just a toast.
              await load('');
              return;
            }
            fill(payload.endpoint.baseUrl, payload.endpoint.model || model.model);
            setNotice({ kind: 'ok', text: t.localModelStarted });
          } catch (error) {
            setNotice({ kind: 'err', text: `${t.localModelStartFailed}: ${String(error?.message ?? error)}` });
          } finally {
            setLocalModelBusy('');
          }
          return;
        }
        if (model.configured !== true) {
          setNotice({ kind: 'err', text: model.error || t.localModelUnconfigured });
          return;
        }
        fill(model.baseUrl, model.model);
        setNotice({ kind: 'ok', text: t.localModelApplied });
      };
      /** Persist device-local Git sync settings; network stays idle until enabled. */
      const saveNetwork = async () => {
        setNetworkBusy(true);
        setNotice(null);
        try {
          const payload = await callApi('/network', {
            method: 'POST',
            body: {
              root: selectedRoot,
              enabled: formNetworkEnabled,
              role: formNetworkRole,
              remote: formNetworkRemote.trim(),
              group: formNetworkGroup.trim(),
              paths: formNetworkPaths,
            },
          });
          setNetworkStatus(payload.status ?? null);
          setNotice({ kind: 'ok', text: t.networkSaved });
        } catch (error) {
          setNotice({ kind: 'err', text: `${t.networkFailed}: ${String(error?.message ?? error)}` });
        } finally {
          setNetworkBusy(false);
        }
      };
      const runNetwork = async (action) => {
        setNetworkBusy(true);
        setNotice(null);
        try {
          const payload = await callApi('/network/action', {
            method: 'POST',
            body: { root: selectedRoot, action, message: `AI for Memory sync ${new Date().toISOString()}` },
          });
          setNetworkStatus(payload.status ?? null);
          if (payload.ok === true) {
            const stopped = payload.result?.stopped === true;
            setNotice({
              kind: 'ok',
              text: stopped
                ? String(payload.result?.message ?? '已停止同步：没有勾选任何同步层')
                : `${t.networkDone}: ${action}`,
            });
          } else {
            const detail = payload.result?.error ?? payload.error ?? '';
            const conflict = /fast-forward|rejected|分叉|non-fast-forward/i.test(detail);
            setNotice({ kind: 'err', text: conflict ? t.networkConflict : `${t.networkFailed}: ${detail}` });
          }
        } catch (error) {
          setNotice({ kind: 'err', text: `${t.networkFailed}: ${String(error?.message ?? error)}` });
        } finally {
          setNetworkBusy(false);
        }
      };
      const toggleNetworkPath = (id) => {
        setFormNetworkPaths((current) => (current.includes(id)
          ? current.filter((item) => item !== id)
          : [...current, id]));
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
              considered: payload.considered ?? payload.docs ?? payload.indexed ?? 0,
              truncated: payload.truncated ?? 0,
              deduped: payload.deduped ?? 0,
              dim: payload.dim ?? 0,
              model: payload.model ?? '',
              built_at: payload.built_at ?? '',
            });
            const capped = Number(payload.truncated) > 0
              ? `；${t.ragConsidered} ${payload.considered ?? 0} 篇，${t.ragTruncated} ${payload.truncated} 篇`
              : '';
            setNotice({
              kind: 'ok',
              text: `${t.ragBuilt} ${payload.indexed ?? payload.docs ?? 0} 篇${capped}`,
            });
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

      /** User confirmation for a model-authored claim: clear the yellow badge without changing its text/id. */
      const verifyKnowledgeDoc = async (doc) => {
        setVerifyingId(doc.doc_id);
        setNotice(null);
        const docScope = doc.session_scope === 'shared' ? 'shared' : 'session';
        const docSession = doc.session_key
          || (docScope === 'session' ? (data?.currentSessionId || scope?.key || '') : '');
        try {
          await callApi('/knowledge/verify', {
            method: 'POST',
            body: {
              root: selectedRoot,
              scope: docScope,
              session: docSession,
              doc_id: doc.doc_id,
            },
          });
          setNotice({ kind: 'ok', text: t.verified });
          await load(selectedRoot);
        } catch (verifyError) {
          setNotice({ kind: 'err', text: `${t.verifyFailed}: ${String(verifyError?.message ?? verifyError)}` });
        } finally {
          setVerifyingId('');
        }
      };

      const verifySelectedKnowledge = async () => {
        const chosen = (data?.knowledge ?? []).filter((doc) => selectedKnowledge.has(doc.doc_id));
        if (chosen.length === 0) return;
        setKnowledgeBusy('verify');
        setNotice(null);
        try {
          const groups = new Map();
          for (const doc of chosen) {
            const scopeKind = doc.session_scope === 'shared' ? 'shared' : 'session';
            const session = doc.session_key
              || (scopeKind === 'session' ? (data?.currentSessionId || scope?.key || '') : '');
            const key = `${scopeKind}:${session}`;
            if (!groups.has(key)) groups.set(key, { scope: scopeKind, session, ids: [] });
            groups.get(key).ids.push(doc.doc_id);
          }
          let verified = 0;
          for (const group of groups.values()) {
            const result = await callApi('/knowledge/verify/batch', {
              method: 'POST',
              body: { root: selectedRoot, scope: group.scope, session: group.session, doc_ids: group.ids },
            });
            verified += Number(result?.verified ?? 0);
          }
          setNotice({ kind: 'ok', text: `${t.verified} ${verified}/${chosen.length}` });
          setSelectedKnowledge(new Set());
          await load(selectedRoot);
        } catch (batchError) {
          setNotice({ kind: 'err', text: `${t.verifyFailed}: ${String(batchError?.message ?? batchError)}` });
        } finally {
          setKnowledgeBusy('');
        }
      };

      const unverifyKnowledgeDoc = async (doc) => {
        setVerifyingId(doc.doc_id);
        setNotice(null);
        try {
          await callApi('/knowledge/unverify', {
            method: 'POST',
            body: {
              root: selectedRoot,
              scope: doc.session_scope === 'shared' ? 'shared' : 'session',
              session: doc.session_key || panelSession,
              doc_id: doc.doc_id,
            },
          });
          setNotice({ kind: 'ok', text: t.verifyUndone });
          await load(selectedRoot);
        } catch (undoError) {
          setNotice({ kind: 'err', text: `${t.verifyUndoFailed}: ${String(undoError?.message ?? undoError)}` });
        } finally {
          setVerifyingId('');
        }
      };

      const panelSession = data?.currentSessionId
        || data?.selectedSession?.session_id
        || scope?.key
        || '';
      const panelScope = scope?.kind === 'shared' ? 'shared' : 'session';
      const showTool = (title, text) => {
        setToolTitle(title);
        setToolText(String(text ?? ''));
      };
      const closeTool = () => {
        setToolTitle('');
        setToolText('');
      };

      const runSearch = async (text, route = 'auto') => {
        const next = String(text ?? query).trim();
        if (next === '' || selectedRoot === '') return;
        setQuery(next);
        setToolBusy('search');
        showTool(t.searchResult, t.searching);
        try {
          const payload = await callApi('/search', {
            method: 'POST',
            body: {
              root: selectedRoot,
              session: panelSession,
              query: next,
              scope: panelScope,
              route,
              mode: 'hybrid',
              top_k: 10,
            },
          });
          showTool(route === 'sql' ? t.sqlResult : t.searchResult, payload.text ?? '');
        } catch (searchError) {
          showTool(t.searchResult, `${t.searchFailed}: ${String(searchError?.message ?? searchError)}`);
        } finally {
          setToolBusy('');
        }
      };

      const saveLlamaConfig = async () => {
        if (!llamaSelected) return;
        setLocalModelBusy(llamaSelected.id);
        setNotice(null);
        try {
          await callApi('/local-engine/config', {
            method: 'POST',
            body: {
              model: llamaSelected.id,
              ctxSize: Number(llamaCtx),
              port: Number(llamaPort),
              pooling: llamaPooling,
              startupTimeoutMs: Number(llamaTimeout),
              binary: llamaBinary.trim(),
              extraArgs: llamaExtra.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
            },
          });
          setNotice({ kind: 'ok', text: t.llamaSaved });
          await load('');
        } catch (llamaError) {
          setNotice({ kind: 'err', text: `${t.llamaSaveFailed}: ${String(llamaError?.message ?? llamaError)}` });
        } finally {
          setLocalModelBusy('');
        }
      };
      const startLlamaModel = async (model = llamaSelected) => {
        if (!model) return;
        setLocalModelBusy(model.id);
        setNotice({ kind: 'ok', text: t.localModelStarting });
        try {
          const payload = await callApi('/local-engine/start', {
            method: 'POST',
            body: { model: model.id },
          });
          if (payload?.ok !== true) {
            setNotice({ kind: 'err', text: `${t.localModelStartFailed}: ${clipPreview(payload?.error ?? '', 500)}` });
          } else {
            const endpoint = payload.endpoint ?? {};
            const baseUrl = endpoint.baseUrl ?? '';
            const modelName = endpoint.model || model.model;
            if (llamaModelKind(model) === 'embedding') {
              setFormEmbedBase(baseUrl);
              setFormEmbedModel(modelName);
            } else if (llamaModelKind(model) === 'rerank') {
              setFormRerankBase(baseUrl);
              setFormRerankModel(modelName);
            }
            setNotice({ kind: 'ok', text: t.localModelStarted });
          }
          await load('');
        } catch (startError) {
          setNotice({ kind: 'err', text: `${t.localModelStartFailed}: ${String(startError?.message ?? startError)}` });
        } finally {
          setLocalModelBusy('');
        }
      };
      const stopLlamaModel = async (model = llamaSelected) => {
        if (!model) return;
        setLocalModelBusy(model.id);
        try {
          await callApi('/local-engine/stop', { method: 'POST', body: { model: model.id } });
          setNotice({ kind: 'ok', text: t.localModelStopped });
          await load('');
        } catch (stopError) {
          setNotice({ kind: 'err', text: `${t.localModelStopFailed}: ${String(stopError?.message ?? stopError)}` });
        } finally {
          setLocalModelBusy('');
        }
      };

      const saveLocalKind = async (model, kind) => {
        setLocalModelBusy(model.id);
        setNotice(null);
        try {
          await callApi('/local-engine/config', {
            method: 'POST',
            body: { model: model.id, kind },
          });
          setNotice({ kind: 'ok', text: t.localModelKindSaved });
          await load('');
        } catch (kindError) {
          setNotice({ kind: 'err', text: String(kindError?.message ?? kindError) });
        } finally {
          setLocalModelBusy('');
        }
      };

      const saveLocalCtx = async (model) => {
        const value = Number(localCtxDrafts[model.id] ?? (model.ctxSize > 0 ? model.ctxSize : 2048));
        if (!Number.isInteger(value) || value < 256 || value > 131072) {
          setNotice({ kind: 'err', text: t.localModelCtxInvalid });
          return;
        }
        setLocalModelBusy(model.id);
        setNotice(null);
        try {
          await callApi('/local-engine/config', {
            method: 'POST',
            body: { model: model.id, ctxSize: value },
          });
          setLocalCtxDrafts((prev) => {
            const next = { ...prev };
            delete next[model.id];
            return next;
          });
          setNotice({ kind: 'ok', text: t.localModelCtxSaved });
          await load('');
        } catch (ctxError) {
          setNotice({ kind: 'err', text: String(ctxError?.message ?? ctxError) });
        } finally {
          setLocalModelBusy('');
        }
      };

      const stopLocalEngine = async (model) => {
        if (typeof window !== 'undefined' && !window.confirm(t.localModelStopConfirm)) return;
        setLocalModelBusy(model.id);
        setNotice(null);
        try {
          await callApi('/local-engine/stop', { method: 'POST', body: { model: model.id } });
          setNotice({ kind: 'ok', text: t.localModelStopped });
          await load('');
        } catch (stopError) {
          setNotice({ kind: 'err', text: `${t.localModelStopFailed}: ${String(stopError?.message ?? stopError)}` });
        } finally {
          setLocalModelBusy('');
        }
      };

      const runContextAction = async (action) => {
        if (action === 'clear' && !contextClearArmed) {
          setContextClearArmed(true);
          return;
        }
        setContextClearArmed(false);
        setToolBusy(`context:${action}`);
        try {
          const payload = await callApi('/context/action', {
            method: 'POST',
            body: { root: selectedRoot, session: panelSession, action },
          });
          showTool(action === 'save' ? t.contextSaveTitle : t.contextClearTitle, payload.text ?? '');
          setNotice({ kind: 'ok', text: action === 'save' ? t.contextSaved : t.contextClearQueued });
          await load(selectedRoot);
        } catch (actionError) {
          setNotice({ kind: 'err', text: `${t.contextActionFailed}: ${String(actionError?.message ?? actionError)}` });
        } finally {
          setToolBusy('');
        }
      };

      const restoreContextRow = async (row) => {        setToolBusy(`context:${row.context_id}`);
        try {
          const payload = await callApi('/context/restore', {
            method: 'POST',
            body: {
              root: selectedRoot,
              session: panelSession,
              context_id: row.context_id,
              scope: 'all',
            },
          });
          showTool(t.contextRestoreTitle, payload.text ?? '');
          setNotice({ kind: 'ok', text: t.contextRestored });
          await load(selectedRoot);
        } catch (restoreError) {
          setNotice({ kind: 'err', text: `${t.contextRestoreFailed}: ${String(restoreError?.message ?? restoreError)}` });
        } finally {
          setToolBusy('');
        }
      };

      const restoreSnapshotRow = async (row) => {
        setToolBusy(`snapshot:${row.snapshot_id}`);
        try {
          const payload = await callApi('/snapshot/restore', {
            method: 'POST',
            body: {
              root: selectedRoot,
              session: row.session_id || row.session_key || panelSession,
              snapshot_id: row.snapshot_id,
            },
          });
          showTool(t.snapshotRestoreTitle, payload.text ?? '');
        } catch (restoreError) {
          setNotice({ kind: 'err', text: `${t.snapshotRestoreFailed}: ${String(restoreError?.message ?? restoreError)}` });
        } finally {
          setToolBusy('');
        }
      };

      const resolvePendingUpdate = async (row, action) => {
        setPendingBusy(row.pending_id);
        setNotice(null);
        try {
          await callApi('/knowledge/pending/resolve', {
            method: 'POST',
            body: {
              root: selectedRoot,
              scope: row.origin_scope === 'shared' ? 'shared' : 'session',
              session: row.origin_key || panelSession,
              pending_id: row.pending_id,
              action,
            },
          });
          setNotice({ kind: 'ok', text: action === 'accept' ? t.pendingAccepted : t.pendingRejected });
          await load(selectedRoot);
        } catch (resolveError) {
          setNotice({ kind: 'err', text: `${t.pendingResolveFailed}: ${String(resolveError?.message ?? resolveError)}` });
        } finally {
          setPendingBusy('');
        }
      };

      const forgetKnowledgeDoc = async (doc) => {
        if (deleteArmed !== doc.doc_id) {
          setDeleteArmed(doc.doc_id);
          return;
        }
        setDeleteArmed('');
        try {
          await callApi('/knowledge/forget', {
            method: 'POST',
            body: {
              root: selectedRoot,
              scope: doc.session_scope === 'shared' ? 'shared' : 'session',
              session: doc.session_key || doc.session_id || panelSession,
              doc_id: doc.doc_id,
            },
          });
          setNotice({ kind: 'ok', text: t.forgotten });
          await load(selectedRoot);
        } catch (forgetError) {
          setNotice({ kind: 'err', text: `${t.forgetFailed}: ${String(forgetError?.message ?? forgetError)}` });
        }
      };

      const runMemoryAction = async () => {
        const action = memoryAction;
        const body = {
          root: selectedRoot,
          session: panelSession,
          action,
          scope: panelScope,
        };
        if (action === 'stage') {
          if (memoryText.trim() === '') {
            setNotice({ kind: 'err', text: t.memoryTextRequired });
            return;
          }
          body.content = memoryText.trim();
          body.kind = 'action';
          body.source = 'gui';
          body.verify = 'pass';
        } else if (action === 'remember') {
          if (memoryText.trim() === '') {
            setNotice({ kind: 'err', text: t.memoryTextRequired });
            return;
          }
          body.text = memoryText.trim();
          body.category = 'project_facts';
        } else if (action === 'snapshot') {
          body.name = memoryName.trim() || `panel_${Date.now()}`;
          body.state = {};
        } else if (action === 'incident') {
          body.title = memoryName.trim() || memoryText.trim().split('\n')[0] || '面板记录的事故';
          body.what_happened = memoryText.trim();
          body.severity = 'medium';
        }
        setToolBusy(`memory:${action}`);
        try {
          const payload = await callApi('/memory/action', { method: 'POST', body });
          showTool(t.memoryActionResult, payload.text ?? '');
          setNotice({ kind: 'ok', text: t.memoryActionDone });
          setMemoryText('');
          await load(selectedRoot);
        } catch (memoryError) {
          setNotice({ kind: 'err', text: `${t.memoryActionFailed}: ${String(memoryError?.message ?? memoryError)}` });
        } finally {
          setToolBusy('');
        }
      };

      const runAskAction = async (action) => {
        setAskAction(action);
        setAskBusy(true);
        setAskResult('');
        const body = { root: selectedRoot, action };
        if (action === 'chat') body.prompt = askText.trim() || 'ping';
        else if (action === 'embed') body.text = askText.trim() || 'ping';
        else if (action === 'rerank') {
          body.query = askText.trim() || 'ping';
          body.documents = askDocs.split('\n').map((row) => row.trim()).filter(Boolean);
          if (body.documents.length === 0) body.documents = [askText.trim() || 'ping'];
        } else if (action === 'probe') body.deep = true;
        try {
          const payload = await callApi('/ask', { method: 'POST', body });
          setAskResult(payload.text ?? '');
        } catch (askError) {
          setAskResult(`${t.askFailed}: ${String(askError?.message ?? askError)}`);
        } finally {
          setAskBusy(false);
        }
      };

      const runRetentionCleanup = async () => {
        if (typeof window !== 'undefined' && !window.confirm(t.retentionConfirm)) return;
        setRetentionBusy(true);
        try {
          const payload = await callApi('/retention/cleanup', {
            method: 'POST',
            body: { root: selectedRoot },
          });
          showTool(t.retentionDone, JSON.stringify(payload, null, 2));
          setNotice({ kind: 'ok', text: t.retentionDone });
          await load(selectedRoot);
        } catch (cleanupError) {
          setNotice({ kind: 'err', text: `${t.retentionFailed}: ${String(cleanupError?.message ?? cleanupError)}` });
        } finally {
          setRetentionBusy(false);
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

      const settingsSections = [
        { id: 'general', label: t.settingsGeneral },
        { id: 'models', label: t.settingsModels },
        { id: 'llama', label: t.settingsLlama },
        { id: 'advanced', label: t.settingsAdvanced },
        { id: 'network', label: t.settingsNetwork },
        { id: 'conversation', label: t.settingsConversation },
      ];
      const activeLayer = tabs.find((item) => item.id === tab) ?? tabs[0];
      const isOverview = view === 'overview';
      const isSettings = view === 'settings';
      const isDiagnostics = view === 'diagnostics';
      React.useEffect(() => {
        if (!isDiagnostics || selectedRoot === '') return undefined;
        let cancelled = false;
        setDiagnosticsBusy(true);
        void callApi(`/diagnostics?root=${encodeURIComponent(selectedRoot)}`)
          .then((payload) => {
            if (!cancelled) {
              setDiagnostics(payload ?? null);
              setSelectedConversations(new Set());
            }
          })
          .catch((diagError) => {
            if (!cancelled) setError(String(diagError?.message ?? diagError));
          })
          .finally(() => {
            if (!cancelled) setDiagnosticsBusy(false);
          });
        // Session logs live outside the memory root, so they are scanned on the
        // same visit but independently: a shallow scan only decodes headers.
        void callApi('/session-logs?deep=0')
          .then((payload) => { if (!cancelled) setSessionLogScan(payload ?? null); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [isDiagnostics, selectedRoot]);
      // Overview only needs the cheap header scan; the deep validator is an
      // explicit diagnostics action because it can inflate large logs.
      React.useEffect(() => {
        if (!isOverview) return undefined;
        let cancelled = false;
        void callApi('/session-logs?deep=0&limit=20')
          .then((payload) => { if (!cancelled) setSessionLogScan(payload ?? null); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [isOverview, selectedRoot]);
      React.useEffect(() => {
        if (!isSettings || settingsSection !== 'network' || selectedRoot === '') return undefined;
        let cancelled = false;
        void callApi(`/network/status?root=${encodeURIComponent(selectedRoot)}`)
          .then((payload) => {
            if (!cancelled) setNetworkStatus(payload?.status ?? null);
          })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [isSettings, settingsSection, selectedRoot]);
      const goOverview = () => setView('overview');
      const goLayer = (id) => {
        setTab(id);
        setView('layer');
        setOpenRows(new Set());
        setListLimit(8);
      };
      const goSettings = (section) => {
        setSettingsSection(section || settingsSection);
        setView('settings');
      };
      const goDiagnostics = () => {
        setView('diagnostics');
      };
      const searchFromOverview = () => {
        const next = overviewQuery.trim();
        if (next !== '') setQuery(next);
        goLayer('knowledge');
        if (next !== '') void runSearch(next);
      };
      const navIcon = (id) => {
        const glyphs = {
          overview: '▦', staging: '≡', archive: '▤', snapshots: '◫',
          knowledge: '◇', decisions: '⌘', contexts: '▧', settings: '⚙', diagnostics: '▣',
        };
        return h('span', {
          key: 'icon',
          'aria-hidden': true,
          style: { width: '16px', textAlign: 'center', color: 'inherit', opacity: 0.9, fontSize: '13px' },
        }, glyphs[id] ?? '•');
      };
      const navItem = (item, active, onClick) => h('button', {
        key: item.id,
        type: 'button',
        className: active ? 'aim-nav-item aim-nav-item-on' : 'aim-nav-item',
        style: {
          ...styles.navItem,
          borderColor: active ? 'rgba(77,107,254,.55)' : 'transparent',
          ...(active ? styles.navItemOn : {}),
        },
        onClick: (event) => {
          event.currentTarget.blur();
          onClick();
        },
      },
      navIcon(item.id),
      h('span', null, item.label),
      item.count === undefined ? null : h('span', { style: styles.navBadge }, String(item.count ?? 0)));

      const knowledgeRows = data?.knowledge ?? [];
      const knowledgeConflicts = Array.isArray(data?.knowledgeConflicts) ? data.knowledgeConflicts : [];
      const knowledgeConflictOpen = Number(data?.knowledgeConflictOpen ?? 0);
      const knowledgeCategories = [...new Set(knowledgeRows.map((doc) => String(doc.category ?? '')).filter(Boolean))].sort();
      const knowledgeSources = [...new Set(knowledgeRows.flatMap((doc) => [
        String(doc.source ?? 'unknown'),
        String(doc.provenance ?? ''),
      ]).filter(Boolean))].sort();
      const knowledge = knowledgeRows
        .filter((doc) => {
          if (knowledgeCategory !== 'all' && String(doc.category ?? '') !== knowledgeCategory) return false;
          if (knowledgeSource !== 'all' && String(doc.source ?? 'unknown') !== knowledgeSource
            && String(doc.provenance ?? '') !== knowledgeSource) return false;
          if (knowledgeStatus === 'verified' && doc.verified !== true) return false;
          if (knowledgeStatus === 'unverified' && doc.verified === true) return false;
          if (query.trim() === '') return true;
          const needle = query.trim().toLowerCase();
          return String(doc.doc_id).toLowerCase().includes(needle)
            || String(doc.category ?? '').toLowerCase().includes(needle)
            || String(doc.source ?? '').toLowerCase().includes(needle)
            || (Array.isArray(doc.tags) ? doc.tags.join(' ') : '').toLowerCase().includes(needle)
            || String(doc.url ?? '').toLowerCase().includes(needle)
            || String(doc.text ?? '').toLowerCase().includes(needle);
        })
        .sort((left, right) => {
          if (knowledgeSort === 'confidence') return Number(right.confidence ?? 0) - Number(left.confidence ?? 0);
          if (knowledgeSort === 'hits') return Number(right.hits ?? 0) - Number(left.hits ?? 0);
          if (knowledgeSort === 'weight') return Number(right.weight ?? 0) - Number(left.weight ?? 0);
          return String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? ''));
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
        const comparePanel = h('div', { style: { ...styles.card, marginBottom: '8px' } },
          h('div', { style: styles.actions },
            h('select', {
              style: styles.input,
              value: snapshotCompare.left,
              onChange: (event) => setSnapshotCompare((prev) => ({ ...prev, left: event.target.value, result: null })),
            },
            h('option', { value: '' }, t.diagCompareLeft),
            rows.map((row) => h('option', { key: row.snapshot_id, value: row.snapshot_id }, row.snapshot_id))),
            h('select', {
              style: styles.input,
              value: snapshotCompare.right,
              onChange: (event) => setSnapshotCompare((prev) => ({ ...prev, right: event.target.value, result: null })),
            },
            h('option', { value: '' }, t.diagCompareRight),
            rows.map((row) => h('option', { key: row.snapshot_id, value: row.snapshot_id }, row.snapshot_id))),
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: snapshotCompare.left === '' || snapshotCompare.right === '',
              onClick: async () => {
                try {
                  const result = await callApi('/snapshot/compare', {
                    method: 'POST',
                    body: {
                      root: selectedRoot,
                      scope: 'session',
                      session: rows.find((item) => item.snapshot_id === snapshotCompare.left)?.session_id
                        || rows.find((item) => item.snapshot_id === snapshotCompare.left)?.session_key
                        || panelSession,
                      left: snapshotCompare.left,
                      right: snapshotCompare.right,
                    },
                  });
                  setSnapshotCompare((prev) => ({ ...prev, result, error: '' }));
                } catch (compareError) {
                  setSnapshotCompare((prev) => ({
                    ...prev,
                    result: null,
                    error: String(compareError?.message ?? compareError),
                  }));
                }
              },
            }, t.diagCompareRun)),
          snapshotCompare.error ? h('p', { style: { color: colors.error } }, snapshotCompare.error) : null,
          snapshotCompare.result
            ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
              h('pre', { style: { ...styles.pre, maxHeight: '220px' } }, JSON.stringify(snapshotCompare.result.left?.state ?? {}, null, 2)),
              h('pre', { style: { ...styles.pre, maxHeight: '220px' } }, JSON.stringify(snapshotCompare.result.right?.state ?? {}, null, 2)))
            : null);
        content = h('div', null,
          rows.length > 1 ? comparePanel : null,
          rows.length === 0
            ? h(Empty, { text: t.emptySnapshots })
            : h('div', { style: styles.list },
              ...rows.slice(0, listLimit).map((row) => {
                const key = keyOf(row.session_key, row.snapshot_id);
                return h(LogRow, {
                  key,
                  rowKey: key,
                  open: rowOpen(key),
                  onToggle: toggleRow,
                  actions: h('span', { style: { display: 'flex', gap: '4px' } },
                    h('button', {
                      type: 'button',
                      className: 'aim-btn',
                      style: { ...styles.primary, padding: '2px 8px', fontSize: '11.5px' },
                      disabled: toolBusy === `snapshot:${row.snapshot_id}`,
                      onClick: (event) => {
                        event.stopPropagation();
                        void restoreSnapshotRow(row);
                      },
                    }, toolBusy === `snapshot:${row.snapshot_id}` ? '…' : t.snapshotRestore),
                    h('button', {
                      type: 'button',
                      className: 'aim-btn',
                      style: { ...styles.button, padding: '2px 8px', fontSize: '11.5px' },
                      onClick: (event) => {
                        event.stopPropagation();
                        setSnapshotCompare((prev) => ({ ...prev, left: prev.left || row.snapshot_id, right: prev.right || '', result: null }));
                      },
                    }, t.diagCompare)),
                  head: [
                    h('span', { key: 'id', style: { fontWeight: 600 } }, row.snapshot_id),
                    row.label ? h('span', { key: 'label', style: badgeStyle('pending') }, row.label) : null,
                    showSession && row.session_label
                      ? h('span', { key: 'session', style: badgeStyle('pending') }, row.session_label)
                      : null,
                    h('span', { key: 'size', style: styles.meta }, `${t.size}: ${formatBytes(row.state_size)}`),
                    h('span', { key: 'time', style: { ...styles.meta, marginLeft: 'auto' } }, formatTime(row.timestamp)),
                  ],
                  preview: row.state_text,
                  children: [
                    h('pre', { key: 'state', style: styles.pre }, row.state_text),
                    h('div', { key: 'files', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                      h('button', {
                        type: 'button',
                        className: 'aim-btn',
                        style: styles.button,
                        onClick: (event) => {
                          event.stopPropagation();
                          void callApi('/reveal', {
                            method: 'POST',
                            body: { root: selectedRoot, scope: 'session', session: row.session_key || panelSession, kind: 'snapshot', id: row.snapshot_id },
                          }).catch((openError) => setNotice({ kind: 'err', text: String(openError?.message ?? openError) }));
                        },
                      }, t.diagOpenFile),
                      h('a', {
                        href: `/ai-for-memory/api/record/download?${new URLSearchParams({
                          root: selectedRoot, scope: 'session', session: row.session_key || panelSession,
                          kind: 'snapshot', id: row.snapshot_id,
                        }).toString()}`,
                        target: '_blank',
                        rel: 'noreferrer',
                        className: 'aim-btn',
                        style: { ...styles.button, textDecoration: 'none' },
                        onClick: (event) => event.stopPropagation(),
                      }, t.diagDownload)),
                    h('div', { key: 'actions', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                      h('button', {
                        key: 'restore',
                        type: 'button',
                        className: 'aim-btn',
                        style: styles.primary,
                        disabled: toolBusy === `snapshot:${row.snapshot_id}`,
                        onClick: (event) => {
                          event.stopPropagation();
                          void restoreSnapshotRow(row);
                        },
                      }, toolBusy === `snapshot:${row.snapshot_id}` ? '…' : t.snapshotRestore),
                      h('button', {
                        key: 'compare-set',
                        type: 'button',
                        className: 'aim-btn',
                        style: styles.button,
                        onClick: (event) => {
                          event.stopPropagation();
                          setSnapshotCompare((prev) => ({ ...prev, left: row.snapshot_id, right: prev.right || '', result: null }));
                        },
                      }, t.diagCompare)),
                  ],
                });
              }),
              rows.length > listLimit ? moreRow('more-snapshots', rows.length) : null));
      } else if (tab === 'knowledge') {
        const pending = Number(data?.knowledgePending ?? 0);
        content = h('div', { style: styles.list },
          h('div', { style: styles.actions },
            h('input', {
              style: { ...styles.input, maxWidth: '320px' },
              placeholder: t.searchPlaceholder,
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void runSearch(query);
              },
            }),
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.primary,
              disabled: toolBusy === 'search',
              onClick: () => runSearch(query),
            }, toolBusy === 'search' ? t.searching : t.searchRun),
            query !== '' ? h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: () => setQuery('') }, t.clearSearch) : null,
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              onClick: () => setExportOpen((current) => !current),
            }, exportOpen ? t.exportClose : t.exportButton)),
          h('div', { style: styles.actions },
            h('select', {
              style: styles.input, value: knowledgeCategory,
              onChange: (event) => setKnowledgeCategory(event.target.value),
            },
            h('option', { value: 'all' }, `${t.filterCategory}: ${t.all}`),
            knowledgeCategories.map((category) => h('option', { key: category, value: category }, category))),
            h('select', {
              style: styles.input, value: knowledgeSource,
              onChange: (event) => setKnowledgeSource(event.target.value),
            },
            h('option', { value: 'all' }, `${t.filterSource}: ${t.all}`),
            knowledgeSources.map((source) => h('option', { key: source, value: source }, source))),
            h('select', {
              style: styles.input, value: knowledgeStatus,
              onChange: (event) => setKnowledgeStatus(event.target.value),
            },
            h('option', { value: 'all' }, `${t.filterStatus}: ${t.all}`),
            h('option', { value: 'unverified' }, t.unverified),
            h('option', { value: 'verified' }, t.verified)),
            h('select', {
              style: styles.input, value: knowledgeSort,
              onChange: (event) => setKnowledgeSort(event.target.value),
            },
            h('option', { value: 'updated' }, t.sortUpdated),
            h('option', { value: 'confidence' }, t.sortConfidence),
            h('option', { value: 'hits' }, t.sortHits),
            h('option', { value: 'weight' }, t.sortWeight)),
            h('button', {
              type: 'button', className: 'aim-btn', style: styles.button,
              disabled: knowledge.length === 0,
              onClick: () => setSelectedKnowledge((prev) => {
                const next = new Set(prev);
                const allSelected = knowledge.every((doc) => next.has(doc.doc_id));
                for (const doc of knowledge) {
                  if (allSelected) next.delete(doc.doc_id); else next.add(doc.doc_id);
                }
                return next;
              }),
            }, t.selectAll),
            h('button', {
              type: 'button', className: 'aim-btn', style: styles.primary,
              disabled: knowledgeBusy !== '' || selectedKnowledge.size === 0,
              onClick: verifySelectedKnowledge,
            }, knowledgeBusy === 'verify' ? '…' : `${t.batchVerify} (${selectedKnowledge.size})`),
            h('span', { style: { ...styles.meta, marginLeft: 'auto' } },
              `${t.loadedOf}: ${knowledge.length}/${data?.knowledgeTotal ?? knowledgeRows.length}`
                + (data?.knowledgeLimited
                  ? `｜${t.cappedNotice.replace('{n}', String(data?.knowledgeLimit ?? 200))}`
                  : ''))),
          h('div', { style: styles.actions },
            h('input', {
              style: { ...styles.input, maxWidth: '520px' },
              placeholder: t.sqlPlaceholder,
              value: sqlQuery,
              onChange: (event) => setSqlQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void runSearch(sqlQuery, 'sql');
              },
            }),
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: toolBusy === 'search',
              onClick: () => runSearch(sqlQuery || query, 'sql'),
            }, t.sqlRun)),
          h('div', {
            style: {
              padding: '8px 10px', border: '1px solid rgba(127,127,127,0.28)',
              borderRadius: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center',
            },
          },
          h('span', { style: { fontSize: '12.5px', fontWeight: 600 } }, t.quickActions),
          h('select', {
            style: { ...styles.input, maxWidth: '150px' },
            value: memoryAction,
            onChange: (event) => setMemoryAction(event.target.value),
          },
          h('option', { value: 'stage' }, t.actionStage),
          h('option', { value: 'remember' }, t.actionRemember),
          h('option', { value: 'promote' }, t.actionPromote),
          h('option', { value: 'snapshot' }, t.actionSnapshot),
          h('option', { value: 'archive' }, t.actionArchive),
          h('option', { value: 'incident' }, t.actionIncident)),
          ['stage', 'remember', 'incident'].includes(memoryAction)
            ? h('textarea', {
              style: { ...styles.input, minWidth: '260px', minHeight: '34px', flex: '1 1 320px' },
              placeholder: t.memoryTextPlaceholder,
              value: memoryText,
              onChange: (event) => setMemoryText(event.target.value),
            })
            : null,
          ['snapshot', 'incident'].includes(memoryAction)
            ? h('input', {
              style: { ...styles.input, maxWidth: '220px' },
              placeholder: t.memoryNamePlaceholder,
              value: memoryName,
              onChange: (event) => setMemoryName(event.target.value),
            })
            : null,
          h('button', {
            type: 'button',
            className: 'aim-btn',
            style: styles.button,
            disabled: toolBusy === `memory:${memoryAction}`,
            onClick: runMemoryAction,
          }, toolBusy === `memory:${memoryAction}` ? '…' : t.quickActions)),
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
          (data?.knowledgePendingUpdates ?? []).length > 0
            ? h('div', {
              style: {
                padding: '8px 10px', border: '1px solid #f59e0b', borderRadius: '8px',
                background: '#fffbeb', color: '#92400e', fontSize: '12.5px',
              },
            },
            h('div', { style: { fontWeight: 600 } },
              `⚠ ${t.pendingUpdates}：${data.knowledgePendingUpdates.length}`),
            h('div', { style: { margin: '4px 0' } }, t.pendingUpdatesHint),
            ...data.knowledgePendingUpdates.slice(0, 5).map((row) => h('div', {
              key: row.pending_id,
              style: { margin: '6px 0', paddingTop: '6px', borderTop: '1px dashed rgba(146,64,14,0.35)' },
            },
            h('div', { style: { fontWeight: 600 } },
              `${t.pendingUpdateTarget}: ${row.update_of}`),
            h('div', { style: { whiteSpace: 'pre-wrap' } }, clipPreview(row.text, 220)),
            h('div', { style: { opacity: 0.85, marginTop: '2px' } },
              `${row.reason || ''}${row.seen_count ? `｜见过 ${row.seen_count} 次` : ''}`
                + (row.first_seen_at ? `｜首次 ${formatTime(row.first_seen_at)}` : '')),
            (row.conflicts ?? []).length > 0
              ? h('div', { style: { marginTop: '3px', opacity: 0.9 } },
                `⚠ 冲突：${(row.conflicts ?? []).map((item) => item.text ?? item).join(' / ')}`)
              : null,
            row.origin_label ? h('div', { style: { opacity: 0.8 } }, `对话：${row.origin_label}`) : null,
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '5px' } },
              h('button', {
                type: 'button',
                className: 'aim-btn',
                style: styles.primary,
                disabled: pendingBusy === row.pending_id,
                onClick: (event) => {
                  event.stopPropagation();
                  resolvePendingUpdate(row, 'accept');
                },
              }, pendingBusy === row.pending_id ? '…' : t.pendingAccept),
              h('button', {
                type: 'button',
                className: 'aim-btn',
                style: styles.button,
                disabled: pendingBusy === row.pending_id,
                onClick: (event) => {
                  event.stopPropagation();
                  resolvePendingUpdate(row, 'reject');
                },
              }, t.pendingReject)))))
            : null,
          knowledgeConflicts.length > 0
            ? h('div', {
              style: {
                padding: '8px 10px', border: '1px solid #f59e0b', borderRadius: '8px',
                background: '#fffbeb', color: '#92400e', fontSize: '12.5px',
              },
            },
            h('div', { style: { fontWeight: 600 } },
              `⚠ ${t.conflictsTitle}：${knowledgeConflictOpen} ${t.conflictsOpen}`),
            h('div', { style: { margin: '4px 0' } }, t.conflictsHint),
            ...knowledgeConflicts.slice(0, 5).map((row) => h('div', {
              key: row.conflict_id,
              style: { margin: '6px 0', paddingTop: '6px', borderTop: '1px dashed rgba(146,64,14,0.35)' },
            },
            h('div', { style: { fontWeight: 600 } },
              `${row.resolved ? t.conflictsResolved : t.conflictsOpen}｜${formatTime(row.at)}`
                + (row.category ? `｜${row.category}` : '')),
            h('div', { style: { whiteSpace: 'pre-wrap' } },
              `${t.conflictsIncoming}: ${clipPreview(row.text, 220)}`),
            (row.conflicts ?? []).length > 0
              ? h('div', { style: { marginTop: '3px', opacity: 0.9 } },
                `${t.conflictsTarget}: ${(row.conflicts ?? []).map((item) => clipPreview(item.text ?? '', 120)).join(' / ')}`)
              : null,
            row.origin_label ? h('div', { style: { opacity: 0.8 } }, `对话：${row.origin_label}`) : null,
            )))
            : null,
          knowledge.length === 0
            ? h(Empty, { text: t.emptyKnowledge })
            : h('div', { style: styles.list },
              ...knowledge.slice(0, listLimit).map((doc) => {
                const key = keyOf(doc.session_key, doc.doc_id);
                const modelClaim = doc.provenance === 'model' && doc.verified !== true;
                return h(LogRow, {
                  key,
                  rowKey: key,
                  open: rowOpen(key),
                  onToggle: toggleRow,
                  leading: h('input', {
                    type: 'checkbox',
                    checked: selectedKnowledge.has(doc.doc_id),
                    onClick: (event) => event.stopPropagation(),
                    onChange: (event) => setSelectedKnowledge((prev) => {
                      const next = new Set(prev);
                      if (event.target.checked) next.add(doc.doc_id); else next.delete(doc.doc_id);
                      return next;
                    }),
                  }),
                  head: [
                    h('span', { key: 'id', style: { fontWeight: 600 } }, doc.doc_id),
                    h('span', { key: 'cat', style: badgeStyle('pending') }, doc.category),
                    doc.source === 'mcp'
                      ? h('span', { key: 'mcp', style: { ...badgeStyle('pending'), background: '#eef2ff', color: '#4338ca' } }, 'MCP')
                      : null,
                    (doc.changes_count ?? 0) > 0
                      ? h('span', {
                        key: 'updated',
                        style: { ...badgeStyle('pending'), background: '#eff6ff', color: '#1d4ed8', borderColor: '#93c5fd' },
                      }, `⤴ ${t.updated} ×${doc.changes_count}`)
                      : null,
                    modelClaim
                      ? h('span', {
                        key: 'claim',
                        style: { ...badgeStyle('pending'), background: '#fef3c7', color: '#92400e', borderColor: '#f59e0b' },
                      }, `⚠ ${t.modelClaim}`)
                      : null,
                    doc.source ? h('span', { key: 'src', style: badgeStyle('pending') }, doc.source) : null,
                    h('span', { key: 'hits', style: styles.meta }, `${t.diagHits}: ${doc.hits ?? 0}`),
                    h('span', { key: 'weight', style: styles.meta }, `${t.diagWeight}: ${Number(doc.weight ?? 0).toFixed(2)}`),
                    h('span', { key: 'confidence', style: styles.meta },
                      `${t.confidence}: ${Number(doc.confidence ?? 0.8).toFixed(2)}`),
                    Number(doc.revision ?? 1) > 1
                      ? h('span', { key: 'revision', style: badgeStyle('pending') }, `r${doc.revision}`)
                      : null,
                    (doc.tags ?? []).map((tag) => h('span', { key: `tag-${tag}`, style: styles.meta }, `#${tag}`)),
                    showSession && doc.session_label
                      ? h('span', { key: 'session', style: badgeStyle('pending') }, doc.session_label)
                      : null,
                    h('span', { key: 'time', style: { ...styles.meta, marginLeft: 'auto' } },
                      `${t.evidence}: ${doc.evidence_count ?? 0}｜${formatTime(doc.updated_at || doc.created_at)}`),
                  ],
                  preview: doc.text,
                  children: [
                    modelClaim
                      ? h('p', { key: 'claim-hint', style: { ...styles.hint, color: '#92400e' } },
                        `⚠ ${t.modelClaimHint}`)
                      : null,
                    modelClaim
                      ? h('button', {
                        key: 'verify',
                        type: 'button',
                        className: 'aim-btn',
                        style: styles.primary,
                        disabled: verifyingId === doc.doc_id,
                        onClick: (event) => {
                          event.stopPropagation();
                          verifyKnowledgeDoc(doc);
                        },
                      }, verifyingId === doc.doc_id ? t.verifying : t.verifyClaim)
                      : null,
                    doc.verified === true && doc.source === 'user-confirmed'
                      ? h('button', {
                        key: 'unverify',
                        type: 'button',
                        className: 'aim-btn',
                        style: styles.button,
                        disabled: verifyingId === doc.doc_id,
                        onClick: (event) => {
                          event.stopPropagation();
                          void unverifyKnowledgeDoc(doc);
                        },
                      }, t.verifyUndo)
                      : null,
                    h('button', {
                      key: 'open-file',
                      type: 'button',
                      className: 'aim-btn',
                      style: styles.button,
                      onClick: (event) => {
                        event.stopPropagation();
                        void callApi('/reveal', {
                          method: 'POST',
                          body: {
                            root: selectedRoot,
                            scope: doc.session_scope === 'shared' ? 'shared' : 'session',
                            session: doc.session_key || panelSession,
                            kind: 'knowledge',
                            id: doc.doc_id,
                          },
                        }).catch((openError) => setNotice({ kind: 'err', text: String(openError?.message ?? openError) }));
                      },
                    }, t.diagOpenFile),
                    h('a', {
                      href: `/ai-for-memory/api/record/download?${new URLSearchParams({
                        root: selectedRoot,
                        scope: doc.session_scope === 'shared' ? 'shared' : 'session',
                        session: doc.session_key || panelSession || '',
                        kind: 'knowledge',
                        id: doc.doc_id,
                      }).toString()}`,
                      target: '_blank',
                      rel: 'noreferrer',
                      className: 'aim-btn',
                      style: { ...styles.button, textDecoration: 'none' },
                      onClick: (event) => event.stopPropagation(),
                    }, t.diagDownload),
                    h('button', {
                      key: 'delete',
                      type: 'button',
                      className: 'aim-btn',
                      style: {
                        ...styles.button,
                        color: deleteArmed === doc.doc_id ? colors.error : undefined,
                      },
                      onClick: (event) => {
                        event.stopPropagation();
                        void forgetKnowledgeDoc(doc);
                      },
                    }, deleteArmed === doc.doc_id ? t.confirmDelete : t.delete),
                    h('p', { key: 'text', style: styles.content }, doc.text),
                    (doc.changes_count ?? 0) > 0
                      ? h('p', { key: 'updated-hint', style: styles.hint },
                        `⤴ ${t.updatedHint}`
                          + (doc.last_change_kind ? `｜${t.lastChange}: ${doc.last_change_kind}` : '')
                          + (doc.last_change_at ? ` ${formatTime(doc.last_change_at)}` : ''))
                      : null,
                    (doc.changes_count ?? 0) > 0 && doc.previous_text
                      ? h('p', { key: 'previous-text', style: styles.hint },
                        `${t.previousText}: ${doc.previous_text}`)
                      : null,
                    doc.url ? h('p', { key: 'url', style: styles.hint }, `${t.sourceUrl}: ${doc.url}`) : null,
                  ],
                });
              }),
              knowledge.length > listLimit ? moreRow('more-knowledge', knowledge.length) : null));
      } else if (tab === 'decisions') {
        const rows = data?.decisions ?? [];
        const outcomeSummary = Object.entries(data?.decisionsByOutcome ?? {})
          .map(([outcome, count]) => `${outcome}=${count}`).join('｜');
        // Routine records are observed turn activity; risk records are the
        // reviewed aim_decide decisions. They stay in one layer but are shown
        // as two sections so the original review path keeps its own place.
        const isRoutine = (row) => row.outcome === 'observed' || row.kind === 'turn-activity';
        const routineRows = rows.filter(isRoutine);
        const riskRows = rows.filter((row) => !isRoutine(row));
        const routineTotal = data?.decisionsByOutcome?.observed ?? routineRows.length;
        const riskTotal = Math.max(0, (data?.counts?.decisions ?? rows.length) - routineTotal);
        const decisionCard = (row) => {
          const key = keyOf(row.session_key, row.decision_id);
          return h(LogRow, {
            key,
            rowKey: key,
            open: rowOpen(key),
            onToggle: toggleRow,
            head: [
              h('span', { key: 'outcome', style: badgeStyle(row.outcome) }, row.outcome),
              h('span', { key: 'review', style: badgeStyle(row.reviewed ? 'pending' : 'approved') },
                row.reviewed
                  ? t.decisionReviewed
                  : (row.outcome === 'observed' ? t.decisionObserved : t.decisionAuto)),
              h('span', { key: 'approved', style: badgeStyle(row.approved ? 'approved' : 'rejected') },
                row.approved ? t.decisionApproved : t.decisionRejected),
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
              row.irreversible !== null && row.irreversible !== undefined
                ? h('p', { key: 'gate', style: styles.hint },
                  `${t.decisionGate}: ${row.irreversible ? t.decisionIrreversible : t.decisionReversible}`
                    + (row.recoverable_via ? `｜${t.decisionRecoverable}: ${row.recoverable_via}` : ''))
                : null,
            ],
          });
        };
        const decisionSection = (label, total, list, emptyText, moreKey) => h('div', { key: `section-${moreKey}` },
          h('p', { style: { ...styles.hint, margin: '0 0 4px', fontWeight: 600 } }, `${label}（${total}）`),
          list.length === 0
            ? h('p', { style: { ...styles.hint, margin: '0 0 8px' } }, emptyText)
            : h('div', { style: styles.list },
              ...list.slice(0, listLimit).map((row) => decisionCard(row)),
              list.length > listLimit ? moreRow(moreKey, list.length) : null));
        content = h('div', null,
          outcomeSummary !== ''
            ? h('p', { style: { ...styles.hint, margin: '0 0 8px' } }, `${t.decisionStats}: ${outcomeSummary}`)
            : null,
          decisionSection(t.decisionRoutine, routineTotal, routineRows, t.emptyRoutine, 'more-routine'),
          decisionSection(t.risk, riskTotal, riskRows, t.emptyDecisions, 'more-decisions'));
      } else if (tab === 'contexts') {
        const rows = data?.contexts ?? [];
        content = h('div', null,
          h('div', { style: { ...styles.actions, marginBottom: '8px' } },
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.primary,
              disabled: toolBusy === 'context:save',
              onClick: () => runContextAction('save'),
            }, toolBusy === 'context:save' ? '…' : t.contextSave),
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: { ...styles.button, color: contextClearArmed ? colors.error : undefined },
              disabled: toolBusy === 'context:clear',
              onClick: () => runContextAction('clear'),
            }, contextClearArmed ? t.contextClearConfirm : t.contextClear)),
          rows.length === 0
          ? h(Empty, { text: t.emptyContexts })
          : h('div', { style: styles.list },
            ...rows.slice(0, listLimit).map((row) => {
              const key = keyOf(row.session_key, row.context_id);
              const rowScope = row.session_scope === 'shared' ? 'shared' : 'session';
              const meta = `第 ${row.turn_from}-${row.turn_to} 轮｜${row.turn_count} 轮｜${row.chars} 字符`;
              return h(LogRow, {
                key,
                rowKey: key,
                open: rowOpen(key),
                onToggle: toggleRow,
                actions: h('button', {
                  type: 'button',
                  className: 'aim-btn',
                  style: { ...styles.primary, padding: '2px 8px', fontSize: '11.5px' },
                  disabled: toolBusy === `context:${row.context_id}`,
                  onClick: (event) => {
                    event.stopPropagation();
                    void restoreContextRow(row);
                  },
                }, toolBusy === `context:${row.context_id}` ? '…' : t.contextRestore),
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
                  h('div', { key: 'files', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                    h('button', {
                      type: 'button',
                      className: 'aim-btn',
                      style: styles.button,
                      onClick: (event) => {
                        event.stopPropagation();
                        void callApi('/reveal', {
                          method: 'POST',
                          body: { root: selectedRoot, scope: rowScope, session: row.session_key || panelSession, kind: 'context', id: row.context_id },
                        }).catch((openError) => setNotice({ kind: 'err', text: String(openError?.message ?? openError) }));
                      },
                    }, t.diagOpenFile),
                    h('a', {
                      href: `/ai-for-memory/api/record/download?${new URLSearchParams({
                        root: selectedRoot, scope: rowScope, session: row.session_key || panelSession,
                        kind: 'context', id: row.context_id,
                      }).toString()}`,
                      target: '_blank',
                      rel: 'noreferrer',
                      className: 'aim-btn',
                      style: { ...styles.button, textDecoration: 'none' },
                      onClick: (event) => event.stopPropagation(),
                    }, t.diagDownload),
                    h('a', {
                      href: `/ai-for-memory/api/record/download?${new URLSearchParams({
                        root: selectedRoot, scope: rowScope, session: row.session_key || panelSession,
                        kind: 'context', id: row.context_id, format: 'markdown',
                      }).toString()}`,
                      target: '_blank',
                      rel: 'noreferrer',
                      className: 'aim-btn',
                      style: { ...styles.button, textDecoration: 'none' },
                      onClick: (event) => event.stopPropagation(),
                    }, t.contextExportMarkdown)),
                  h('button', {
                    key: 'restore',
                    type: 'button',
                    className: 'aim-btn',
                    style: styles.primary,
                    disabled: toolBusy === `context:${row.context_id}`,
                    onClick: (event) => {
                      event.stopPropagation();
                      void restoreContextRow(row);
                    },
                  }, toolBusy === `context:${row.context_id}` ? t.searching : t.contextRestore),
                ],
              });
            }),
            rows.length > listLimit ? moreRow('more-contexts', rows.length) : null));
      }

      const healthRows = [
        [t.overviewRoot, selectedRoot || '—'],
        [t.overviewSessions, `${data?.sessionsTotal ?? sessions.length} 个`],
        [t.overviewGitignore, `${gitignoreText}${data?.gitignore?.entry ? `（${data.gitignore.entry}）` : ''}`],
        [t.overviewLimits, `${data?.maxContentChars ?? 30000} 字符｜快照 ${formatBytes(data?.maxSnapshotBytes ?? 262144)}｜top ${data?.defaultTopK ?? 5}`],
        [t.overviewBackend, data?.knowledgeBackend === 'sqlite' ? 'SQLite' : 'JSON'],
        [t.overviewRag, formRagMount
          ? (ragIndex?.built
            ? `${ragIndex.docs} 篇 · ${t.ragConsidered} ${ragIndex.considered ?? ragIndex.docs}`
              + ` · ${t.ragDeduped} ${ragIndex.deduped ?? 0}`
              + (Number(ragIndex.truncated) > 0 ? ` · ${t.ragTruncated} ${ragIndex.truncated}` : '')
            : t.overviewOn)
          : t.overviewOff],
        [t.overviewNetwork, formNetworkEnabled ? t.overviewOn : t.overviewOff],
        [t.overviewContextUsage, data?.contextMeasuredText ?? '未知（还没有测量数据）'],
        [t.overviewClear, t.overviewClearValue.replace('{n}', String(data?.contextUsagePercent ?? 70))],
      ];
      const loadSessionLogs = async (deep) => {
        setSessionLogBusy(deep ? 'deep' : 'scan');
        setSessionLogPreview(null);
        setSessionLogArmed('');
        setSessionLogResult('');
        try {
          const payload = await callApi(`/session-logs?deep=${deep ? '1' : '0'}${deep ? '&limit=20' : ''}`);
          setSessionLogScan(payload ?? null);
        } catch (scanError) {
          setNotice({ kind: 'err', text: String(scanError?.message ?? scanError) });
        } finally {
          setSessionLogBusy('');
        }
      };
      const runSessionLogRepair = async (file, compact = false, apply = false) => {
        setSessionLogBusy(apply ? 'repair' : 'preview');
        setSessionLogResult('');
        try {
          const payload = await callApi('/session-logs/repair', {
            method: 'POST',
            body: { session: file, compact, apply },
          });
          const report = payload?.report ?? {};
          if (!apply) {
            setSessionLogPreview({
              file,
              text: String(payload?.text ?? ''),
              dropped: Number.isInteger(report.dropped) ? report.dropped : null,
              strategy: report.strategy ?? (compact ? 'compact' : 'auto'),
            });
            setSessionLogArmed(file);
            return;
          }
          setSessionLogArmed('');
          setSessionLogPreview(null);
          setSessionLogResult(String(payload?.text ?? t.diagSessionLogOk));
          await loadSessionLogs(true);
        } catch (repairError) {
          setSessionLogResult(String(repairError?.message ?? repairError));
          setSessionLogArmed('');
          setSessionLogPreview(null);
        } finally {
          setSessionLogBusy('');
        }
      };
      const sessionLogRow = (row) => {
        const torn = Array.isArray(row.anomalies) && row.anomalies.includes('torn-tail');
        const statusText = torn ? t.diagSessionLogTorn
          : row.status === 'ok' ? t.diagSessionLogOk
            : row.status === 'corrupt' ? t.diagSessionLogCorrupt
              : row.status === 'unreadable' ? t.diagSessionLogUnreadable
                : row.status === 'unsupported' ? t.diagSessionLogUnsupported
                  : t.diagSessionLogUnknown;
        const broken = row.status === 'corrupt' || row.status === 'unreadable' || torn;
        const oversized = row.status === 'ok' && Array.isArray(row.anomalies) && row.anomalies.includes('oversized');
        const actionable = broken || oversized;
        const armed = sessionLogArmed === row.file;
        const preview = sessionLogPreview && sessionLogPreview.file === row.file ? sessionLogPreview : null;
        const sizeText = row.logicalBytes === null || row.logicalBytes === undefined
          ? formatBytes(row.physicalBytes)
          : `${formatBytes(row.logicalBytes)} / ${formatBytes(row.physicalBytes)}`;
        const confirmText = preview
          ? (preview.strategy === 'compact'
            ? t.diagSessionLogCompactConfirm
            : (preview.strategy === 'salvage'
              ? t.diagSessionLogRepairConfirm
              : t.diagSessionLogRepairConfirmDropped.replace('{n}', String(preview.dropped ?? 0))))
          : null;
        return h('div', {
          key: row.file,
          style: {
            display: 'flex', alignItems: 'center', gap: '7px', padding: '3px 0',
            borderTop: `1px solid ${colors.border}`, fontSize: '12px',
          },
        },
        h('span', {
          style: { ...styles.mono, flex: '1 1 180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: row.file,
        }, row.id),
        h('span', { style: { flex: '0 0 62px', color: broken ? colors.error : colors.secondary } }, statusText),
        h('span', { style: { ...styles.mono, flex: '0 0 132px', color: colors.secondary } }, sizeText),
        h('span', { style: { ...styles.mono, flex: '0 0 58px', color: colors.secondary } },
          row.events === null || row.events === undefined ? '—' : String(row.events)),
        h('button', {
          type: 'button',
          className: 'aim-btn',
          style: { ...styles.button, padding: '1px 7px', fontSize: '11px', marginLeft: 'auto' },
          disabled: sessionLogBusy !== '' || !actionable,
          onClick: () => {
            if (armed && preview) void runSessionLogRepair(row.file, oversized && !broken, true);
            else void runSessionLogRepair(row.file, oversized && !broken, false);
          },
        }, preview
          ? confirmText
          : (oversized && !broken ? t.diagSessionLogCompact : t.diagSessionLogRepair)));
      };
      /**
       * One card shared by the overview (compact: only problems) and the
       * diagnostics page (full list). Repair is a two-step button because it
       * rewrites a file on disk.
       */
      const sessionLogCard = (compact) => {
        const scan = sessionLogScan;
        const logs = Array.isArray(scan?.logs) ? scan.logs : [];
        const unavailable = scan?.unavailable === true;
        const shallow = scan !== null && scan?.deep !== true;
        const actionable = logs.filter((row) => row.status === 'corrupt' || row.status === 'unreadable'
          || (Array.isArray(row.anomalies) && row.anomalies.includes('torn-tail'))
          || (row.status === 'ok' && Array.isArray(row.anomalies) && row.anomalies.includes('oversized')));
        const brokenRows = logs.filter((row) => row.status === 'corrupt' || row.status === 'unreadable'
          || (Array.isArray(row.anomalies) && row.anomalies.includes('torn-tail')));
        const oversizedRows = logs.filter((row) => row.status === 'ok'
          && Array.isArray(row.anomalies) && row.anomalies.includes('oversized'));
        const danger = !shallow && brokenRows.length > 0;
        const oversized = !danger && !shallow && oversizedRows.length > 0;
        const visible = compact ? actionable : logs;
        const summary = !scan
          ? '—'
          : shallow
            ? t.sessionLogShallowSummary.replace('{n}', String(logs.length))
            : t.sessionLogSummary.replace('{n}', String(logs.length)).replace('{m}', String(actionable.length));
        return h('section', {
          style: {
            ...styles.card,
            ...(danger ? { borderColor: colors.error, background: 'rgba(216,57,49,.06)' } : {}),
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('h3', { style: { ...styles.cardTitle, color: danger ? colors.error : undefined } },
              compact ? t.sessionLogTitle : t.diagSessionLogs),
            h('span', { style: { ...styles.hint, marginLeft: 'auto', color: danger ? colors.error : undefined } }, summary)),
          h('p', { style: styles.hint }, compact ? t.sessionLogHint : t.diagSessionLogsHint),
          scan?.deep === true && scan?.validator?.note
            ? h('p', { style: { ...styles.hint, marginTop: 0 } },
              `${t.diagValidator}: ${scan.validator.note}`)
            : null,
          unavailable
            ? h('p', { style: { color: colors.error, fontWeight: 600, margin: '4px 0' } }, scan.error ?? t.sessionLogUnavailable)
            : null,
          danger
            ? h('p', { style: { color: colors.error, fontWeight: 600, margin: '4px 0' } }, t.sessionLogDanger)
            : (shallow
              ? h('p', { style: { color: colors.warning ?? '#b45309', fontWeight: 600, margin: '4px 0' } },
                t.sessionLogShallowWarning)
              : (oversized
                ? h('p', { style: { color: colors.warning ?? '#b45309', fontWeight: 600, margin: '4px 0' } },
                  t.sessionLogOversizedWarning)
                : null)),
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' } },
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: sessionLogBusy !== '' || unavailable,
              onClick: () => loadSessionLogs(false),
            }, sessionLogBusy === 'scan' ? t.diagSessionLogBusy : t.diagSessionLogScan),
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: sessionLogBusy !== '' || unavailable,
              onClick: () => loadSessionLogs(true),
            }, sessionLogBusy === 'deep' ? t.diagSessionLogBusy : t.diagSessionLogDeep),
            compact
              ? h('button', {
                type: 'button',
                className: 'aim-btn',
                style: { ...styles.button, marginLeft: 'auto' },
                onClick: () => {
                  goDiagnostics();
                  void loadSessionLogs(false);
                },
              }, t.sessionLogOpenDiagnostics)
              : null),
          sessionLogResult !== ''
            ? h('pre', {
              style: { ...styles.pre, maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap', marginBottom: '6px' },
            }, sessionLogResult)
            : null,
          sessionLogPreview && sessionLogPreview.text !== ''
            ? h('pre', {
              style: { ...styles.pre, maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap', marginBottom: '6px', borderColor: colors.warning ?? '#b45309' },
            }, sessionLogPreview.text)
            : null,
          !scan
            ? h(Empty, { text: t.sessionLogIdle })
            : visible.length === 0
              ? h('p', {
                style: {
                  ...styles.hint,
                  color: compact && !shallow ? colors.success : colors.secondary,
                  margin: 0,
                },
              }, compact
                ? (shallow ? t.sessionLogShallowHint : t.sessionLogAllOk)
                : t.diagSessionLogNoLogs)
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                visible.map((row) => sessionLogRow(row))));
      };
      const recentStaging = (data?.staging ?? []).slice(0, 5);
      const mcpUrl = `${typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:PORT'}`
        + `${data?.mcpPath ?? '/ai-for-memory/mcp'}`;
      const llamaColumnCard = (kind, title) => {
        const models = llamaModels.filter((model) => llamaModelKind(model) === kind);
        return h('section', { key: kind, style: styles.card },
          h('h3', { style: styles.cardTitle }, title),
          models.length === 0
            ? h('p', { style: styles.hint }, t.llamaNoModels)
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
              models.map((model) => {
                const engine = (data?.localEngines ?? []).find((row) => row.id === model.id);
                const running = engine?.ready === true;
                return h('div', {
                  key: model.id,
                  style: { borderTop: `1px solid ${colors.border}`, paddingTop: '6px' },
                },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: '12.5px', fontWeight: 600 } }, model.label),
                  h('span', { style: { ...styles.hint, marginLeft: 'auto' } },
                    running ? `${t.llamaRunning}：${engine.baseUrl}` : t.llamaNotRunning)),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', marginTop: '4px' } },
                  h('span', { style: styles.hint }, t.localModelCtx),
                  h('input', {
                    style: { ...styles.input, width: '76px', padding: '2px 5px', fontSize: '11.5px' },
                    type: 'number',
                    min: 256,
                    max: 131072,
                    step: 256,
                    value: localCtxDrafts[model.id] ?? (model.ctxSize > 0 ? model.ctxSize : 2048),
                    onChange: (event) => setLocalCtxDrafts((prev) => ({ ...prev, [model.id]: event.target.value })),
                  }),
                  h('button', {
                    type: 'button', className: 'aim-btn', style: { ...styles.button, padding: '1px 7px', fontSize: '11px' },
                    disabled: localModelBusy === model.id,
                    onClick: () => saveLocalCtx(model),
                  }, t.localModelCtxSave),
                  model.runnable && !running
                    ? h('button', {
                      type: 'button', className: 'aim-btn', style: styles.primary,
                      disabled: localModelBusy === model.id,
                      onClick: () => startLlamaModel(model),
                    }, localModelBusy === model.id ? t.localModelStarting : t.localModelStart)
                    : null,
                  running
                    ? h('button', {
                      type: 'button', className: 'aim-btn', style: styles.button,
                      disabled: localModelBusy === model.id,
                      onClick: () => stopLlamaModel(model),
                    }, t.localModelStop)
                    : null));
              })));
      };
      const llamaColumns = h('div', {
        className: 'aim-overview-grid',
        style: { ...styles.overviewGrid, marginBottom: '10px' },
      },
      llamaColumnCard('embedding', t.llamaEmbeddingColumn),
      llamaColumnCard('rerank', t.llamaRerankColumn));

      const overview = h('div', { className: 'aim-fade-up', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        h('div', { style: styles.overviewToolbar },
          h('span', { style: styles.overviewPill }, `● ${t.overviewLocalPill}`),
          data?.contextMeasuredPercent === null || data?.contextMeasuredPercent === undefined
            ? h('span', { style: styles.overviewPill }, `${t.overviewContextUsage}: —`)
            : h('span', { style: styles.overviewPill },
              `${t.overviewContextUsage}: ${Number(data.contextMeasuredPercent).toFixed(1)}% / `
                + `${Number(data?.contextUsagePercent ?? 70)}%`),
          h('input', {
            style: { ...styles.input, ...styles.overviewSearch },
            placeholder: t.overviewSearchPlaceholder,
            value: overviewQuery,
            onChange: (event) => setOverviewQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') searchFromOverview();
            },
          }),
          h('button', {
            type: 'button',
            className: 'aim-btn',
            style: styles.button,
            onClick: searchFromOverview,
          }, t.overviewSearch),
          h('button', {
            type: 'button',
            className: 'aim-btn',
            style: styles.button,
            onClick: () => {
              goDiagnostics();
              void loadSessionLogs(true);
            },
          }, t.sessionLogTitle)),
        h('div', { style: styles.hero },
          h(PanelIcon, { size: 30 }),
          h('div', { style: { minWidth: 0, flex: '1 1 360px' } },
            h('h3', { style: styles.heroTitle }, activeRow ? (conversationName(activeRow) || t.overviewSession) : t.overviewSessionEmpty),
            h('p', { style: styles.heroSub }, `${t.overviewRoot}：${selectedRoot || '—'}`)),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: copyPath }, t.copy),
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, disabled: busy, onClick: reveal }, t.reveal),
            h('button', { type: 'button', className: 'aim-btn', style: styles.primary, onClick: () => goSettings() }, t.openSettings))),
        h('div', { className: 'aim-overview-grid', style: styles.overviewGrid },
          h('section', { style: styles.card },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('h3', { style: styles.cardTitle }, t.overviewCards),
              h('span', { style: styles.hint }, t.navLayersHint)),
            h('div', { style: styles.tiles }, [
              { id: 'staging', label: t.tabStaging, value: String(counts.staging ?? 0) },
              { id: 'archive', label: t.tabArchive, value: String(counts.archive ?? 0) },
              { id: 'snapshots', label: t.tabSnapshots, value: String(counts.snapshots ?? 0) },
              { id: 'knowledge', label: t.tabKnowledge, value: String(counts.knowledge ?? 0) },
              { id: 'decisions', label: t.tabDecisions, value: String(counts.decisions ?? 0) },
              { id: 'contexts', label: t.tabContexts, value: String(counts.contexts ?? 0) },
            ].map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: 'aim-stat-card',
              style: { ...styles.tile, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' },
              onClick: () => goLayer(item.id),
            },
            h('span', { style: styles.tileLabel }, item.label),
            h('span', { style: styles.tileValue }, item.value))))),
          h('section', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t.overviewHealth),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
              healthRows.map(([label, value]) => h('div', {
                key: label,
                style: { display: 'flex', gap: '10px', alignItems: 'flex-start', fontSize: '12px' },
              },
              h('span', { style: { color: colors.secondary, flex: '0 0 92px' } }, label),
              h('span', { style: { ...styles.mono, overflowWrap: 'anywhere', flex: 1 } }, String(value))))))),
        sessionLogCard(true),
        h('div', { className: 'aim-overview-grid', style: styles.overviewGrid },
          h('section', { style: styles.card },
            h('div', { style: { display: 'flex', alignItems: 'center' } },
              h('h3', { style: styles.cardTitle }, t.overviewRecent),
              h('button', { type: 'button', className: 'aim-btn', style: { ...styles.button, marginLeft: 'auto', padding: '2px 9px', fontSize: '11.5px' }, onClick: () => goLayer('staging') }, t.viewAll)),
            recentStaging.length === 0
              ? h(Empty, { text: t.overviewNoRecent })
              : h('div', { style: styles.list }, recentStaging.map((row) => h('div', {
                key: row.dedup_id,
                style: { ...styles.row, padding: '7px 9px' },
              },
              h('div', { style: styles.rowHead },
                row.kind ? h('span', { style: badgeStyle('pending') }, row.kind) : null,
                row.category ? h('span', { style: badgeStyle('pending') }, row.category) : null,
                h('span', { style: { ...styles.meta, marginLeft: 'auto' } }, formatTime(row.timestamp))),
              h('p', { style: styles.logPreview }, clipPreview(row.content, 150)))))),
          h('section', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t.overviewQuick),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
              h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: () => goLayer('knowledge') }, `${t.tabKnowledge} · ${counts.knowledge ?? 0}`),
              h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: () => goLayer('contexts') }, `${t.tabContexts} · ${counts.contexts ?? 0}`),
              h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: () => goSettings('models') }, t.settingsModels),
              h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: () => goSettings('network') }, t.settingsNetwork),
              formRagMount && ragFormReady
                ? h('button', {
                  type: 'button',
                  className: 'aim-btn',
                  style: styles.button,
                  disabled: ragBusy,
                  onClick: buildRag,
                }, ragBusy ? t.ragBuilding : t.ragBuild)
                : null,
              formNetworkEnabled
                ? h('button', {
                  type: 'button',
                  className: 'aim-btn',
                  style: styles.button,
                  disabled: networkBusy,
                  onClick: () => runNetwork('push'),
                }, networkBusy ? t.networkBusy : t.networkUpload)
                : null),
            h('p', { style: { ...styles.hint, marginTop: '3px' } },
              `${t.overviewGenerated}：${formatTime(data?.generatedAt)}`))),
        h('section', { style: styles.overviewNote },
          h('h3', { style: styles.cardTitle }, t.overviewContextBehavior),
          h('p', { style: styles.hint },
            t.overviewContextBehaviorText
              .replace('{n}', String(data?.contextUsagePercent ?? 70))
              .replace('{k}', String(data?.keepRecentTurns ?? 2)))));


      const refreshDiagnostics = async () => {
        if (selectedRoot === '') return;
        setDiagnosticsBusy(true);
        try {
          const payload = await callApi(`/diagnostics?root=${encodeURIComponent(selectedRoot)}`);
          setDiagnostics(payload ?? null);
        } catch (diagError) {
          setNotice({ kind: 'err', text: String(diagError?.message ?? diagError) });
        } finally {
          setDiagnosticsBusy(false);
        }
      };
      const openRecord = async (kind, id, scope, session) => {
        try {
          await callApi('/reveal', {
            method: 'POST',
            body: { root: selectedRoot, kind, id, scope, session },
          });
        } catch (revealError) {
          setNotice({ kind: 'err', text: String(revealError?.message ?? revealError) });
        }
      };
      const downloadRecord = (kind, id, scope, session) => {
        const params = new URLSearchParams({ root: selectedRoot, kind, id, scope: scope ?? 'session' });
        if (session) params.set('session', session);
        window.open(`/ai-for-memory/api/record/download?${params.toString()}`, '_blank', 'noopener');
      };
      const bulkConversations = async (action) => {
        if (selectedConversations.size === 0) return;
        setBulkBusy(action);
        try {
          const payload = await callApi('/conversations/bulk', {
            method: 'POST',
            body: { root: selectedRoot, action, keys: [...selectedConversations] },
          });
          setDiagnostics((prev) => (prev ? { ...prev, conversations: payload.conversations ?? [] } : prev));
          setSelectedConversations(new Set());
        } catch (bulkError) {
          setNotice({ kind: 'err', text: String(bulkError?.message ?? bulkError) });
        } finally {
          setBulkBusy('');
        }
      };
      const diag = diagnostics ?? {};
      const diagHealthRows = [
        [t.diagNode, diag.node ?? '—'],
        [t.diagSqlite, diag.sqlite === true ? t.diagAvailable : t.diagUnavailable],
        [t.diagGit, diag.git?.available === true ? t.diagAvailable : t.diagUnavailable],
        [t.diagLlama, diag.llamaServer ?? t.diagUnavailable],
        [t.diagModels, diag.models?.root ?? '—'],
        [t.diagWritable, diag.writable === true ? t.diagAvailable : t.diagUnavailable],
        [t.diagGitignore, diag.gitignore?.state ?? '—'],
        [t.diagStorage, formatBytes(diag.storage?.totalBytes ?? 0)],
        [t.diagSessionRepair, diag.sessionRepairAvailable === true
          ? t.diagAvailable
          : `${t.diagUnavailable}（${diag.sessionRepairNeed ?? 'Node 22.15+'}，当前 ${diag.node ?? '?'}）`],
      ];
      const diagUsage = Array.isArray(diag.usage) ? diag.usage : [];
      const diagConversations = Array.isArray(diag.conversations) ? diag.conversations : [];
      const diagAudit = Array.isArray(diag.audit) ? diag.audit : [];
      const diagPage = h('div', { className: 'aim-fade-up', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('div', { style: { flex: 1 } },
            h('h3', { style: styles.cardTitle }, t.diagTitle),
            h('p', { style: styles.hint }, t.diagSubtitle)),
          h('button', {
            type: 'button',
            className: 'aim-btn',
            style: styles.button,
            disabled: diagnosticsBusy,
            onClick: refreshDiagnostics,
          }, diagnosticsBusy ? '…' : t.diagRefresh)),
        h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.diagHealth),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '6px' } },
            diagHealthRows.map(([label, value]) => h('div', {
              key: label,
              style: { display: 'flex', gap: '8px', fontSize: '12px', padding: '3px 0' },
            },
            h('span', { style: { color: colors.secondary, flex: '0 0 96px' } }, label),
            h('span', { style: { ...styles.mono, overflowWrap: 'anywhere' } }, String(value)))))),
        sessionLogCard(false),
        h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.diagUsage),
          h('p', { style: styles.hint }, t.diagUsageHint),
          diagUsage.length === 0
            ? h(Empty, { text: t.diagNoUsage })
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              diagUsage.slice(0, 60).map((row) => h('div', {
                key: `${row.scope}:${row.session}:${row.doc_id}`,
                style: { display: 'flex', alignItems: 'center', gap: '7px', padding: '4px 0', borderTop: `1px solid ${colors.border}`, fontSize: '12px' },
              },
              h('span', { style: { ...styles.mono, flex: '0 0 88px', color: colors.secondary } }, row.count === 0 ? t.diagDead : `${t.diagHits} ${row.count}`),
              h('span', { style: { ...styles.mono, flex: '0 0 54px' } }, Number(row.weight).toFixed(2)),
              h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: row.text }, row.text),
              h('button', {
                type: 'button', className: 'aim-btn', style: { ...styles.button, padding: '1px 7px', fontSize: '11px' },
                onClick: () => openRecord('knowledge', row.doc_id, row.scope, row.session),
              }, t.diagOpenFile))))),
        h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.diagConversations),
          h('div', { style: { display: 'flex', gap: '6px', marginBottom: '6px' } },
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, disabled: bulkBusy !== '' || selectedConversations.size === 0, onClick: () => bulkConversations('open') }, t.diagBulkOpen),
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, disabled: bulkBusy !== '' || selectedConversations.size === 0, onClick: () => bulkConversations('close') }, t.diagBulkClose),
            h('span', { style: { ...styles.hint, marginLeft: 'auto' } }, `${selectedConversations.size}/${diagConversations.length}`)),
          diagConversations.length === 0
            ? h(Empty, { text: t.diagNoConversations })
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
              diagConversations.map((row) => h('label', {
                key: row.key,
                style: { display: 'flex', alignItems: 'center', gap: '7px', padding: '3px 0', borderTop: `1px solid ${colors.border}`, fontSize: '12px' },
              },
              h('input', {
                type: 'checkbox',
                checked: selectedConversations.has(row.key),
                onChange: (event) => setSelectedConversations((prev) => {
                  const next = new Set(prev);
                  if (event.target.checked) next.add(row.key); else next.delete(row.key);
                  return next;
                }),
              }),
              h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label || row.session_id || row.key),
              h('span', { style: { ...styles.mono, color: colors.secondary } }, `${row.public ? 'open' : 'closed'} · ${formatBytes(row.bytes)}`))))),
        h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.diagAudit),
          diagAudit.length === 0
            ? h(Empty, { text: t.diagNoAudit })
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
              diagAudit.slice(0, 60).map((row, index) => h('div', {
                key: `${row.at}:${index}`,
                style: { display: 'flex', gap: '7px', fontSize: '12px', padding: '3px 0', borderTop: `1px solid ${colors.border}` },
              },
              h('span', { style: { ...styles.mono, flex: '0 0 132px', color: colors.secondary } }, formatTime(row.at)),
              h('span', { style: { flex: '0 0 150px' } }, row.action),
              h('span', { style: { ...styles.mono, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: row.detail }, row.detail))))),
        h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.diagCompare),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            h('select', { style: styles.input, value: snapshotCompare.left, onChange: (event) => setSnapshotCompare((prev) => ({ ...prev, left: event.target.value, result: null })) },
              h('option', { value: '' }, t.diagCompareLeft),
              (data?.snapshots ?? []).map((row) => h('option', { key: row.snapshot_id, value: row.snapshot_id }, row.snapshot_id))),
            h('select', { style: styles.input, value: snapshotCompare.right, onChange: (event) => setSnapshotCompare((prev) => ({ ...prev, right: event.target.value, result: null })) },
              h('option', { value: '' }, t.diagCompareRight),
              (data?.snapshots ?? []).map((row) => h('option', { key: row.snapshot_id, value: row.snapshot_id }, row.snapshot_id))),
            h('button', {
              type: 'button', className: 'aim-btn', style: styles.button,
              disabled: snapshotCompare.left === '' || snapshotCompare.right === '',
              onClick: async () => {
                try {
                  const result = await callApi('/snapshot/compare', {
                    method: 'POST',
                    body: { root: selectedRoot, scope: 'session', session: panelSession, left: snapshotCompare.left, right: snapshotCompare.right },
                  });
                  setSnapshotCompare((prev) => ({ ...prev, result, error: '' }));
                } catch (compareError) {
                  setSnapshotCompare((prev) => ({ ...prev, result: null, error: String(compareError?.message ?? compareError) }));
                }
              },
            }, t.diagCompareRun)),
          snapshotCompare.error ? h('p', { style: { color: colors.error } }, snapshotCompare.error) : null,
          snapshotCompare.result
            ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' } },
              h('pre', { style: styles.pre }, JSON.stringify(snapshotCompare.result.left?.state ?? {}, null, 2)),
              h('pre', { style: styles.pre }, JSON.stringify(snapshotCompare.result.right?.state ?? {}, null, 2)))
            : null));

      return h('div', { className: 'aim-shell', style: styles.shell },
        h('aside', { className: 'aim-sidebar', style: styles.sidebar },
          h('div', { style: styles.brand },
            h(PanelIcon, { size: 24 }),
            h('div', null,
              h('h1', { style: styles.brandTitle }, t.title),
              h('p', { style: styles.brandSub }, t.navLayersHint))),
          h('div', { className: 'aim-nav-group', style: styles.navGroup },
            h('div', { className: 'aim-nav-group-title', style: styles.navGroupTitle }, t.navOverview),
            navItem({ id: 'overview', label: t.navOverview }, isOverview, goOverview)),
          h('div', { className: 'aim-nav-group', style: styles.navGroup },
            h('div', { className: 'aim-nav-group-title', style: styles.navGroupTitle }, t.navLayers),
            ...tabs.map((item) => navItem(item, view === 'layer' && tab === item.id, () => goLayer(item.id)))),
          h('div', { className: 'aim-nav-group', style: styles.navGroup },
            h('div', { className: 'aim-nav-group-title', style: styles.navGroupTitle }, t.navSystem),
            navItem({ id: 'settings', label: t.navSettings }, isSettings, () => goSettings()),
            navItem({ id: 'diagnostics', label: t.navDiagnostics }, isDiagnostics, () => goDiagnostics())),
          h('div', { style: styles.sidebarFooter },
            h('p', { style: { ...styles.hint, fontSize: '10.5px' } }, t.sidebarFooter))),
        h('div', { className: 'aim-app-main', style: styles.appMain },
          h('main', { className: 'aim-main', style: styles.main },
            h('div', { className: 'aim-page', style: styles.page },
        h('div', { style: styles.header },
          h('div', null,
            h('h2', { style: styles.title }, isSettings
              ? t.settingsTitle
              : (isDiagnostics ? t.diagTitle : (isOverview ? t.overviewTitle : (activeLayer?.label ?? t.title)))),
            h('p', { style: styles.subtitle }, isSettings
              ? t.settingsSubtitle
              : (isDiagnostics ? t.diagSubtitle : (isOverview ? t.overviewSubtitle : t.subtitle)))),
          h('div', { style: styles.actions },
            isSettings ? h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              onClick: goOverview,
            }, t.settingsBack) : null,
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
                }, `${conversationName(row)}${row.current ? `（${t.scopeCurrent}）` : ''}${row.public !== true ? `（${t.privateBadge}）` : ''}`))))
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

        toolText !== ''
          ? h('section', { style: styles.card },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('h3', { style: { ...styles.cardTitle, margin: 0 } }, toolTitle || t.searchResult),
              h('button', {
                type: 'button',
                className: 'aim-btn',
                style: { ...styles.button, marginLeft: 'auto' },
                onClick: closeTool,
              }, t.closePanel)),
            h('pre', { style: styles.pre }, toolText))
          : null,

        gitignoreWarning !== ''
          ? h('div', {
            className: 'aim-notice',
            style: {
              ...styles.notice,
              color: colors.warn,
              borderColor: colors.warn,
            },
          }, `⚠ ${gitignoreWarning}`)
          : null,

        error !== null
          ? h('div', { style: styles.card },
            h('p', { style: styles.hint }, `${t.loadFailed}: ${error}`),
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: () => load(selectedRoot) }, t.retry))
          : null,

        !isSettings && !isOverview
          ? (selectedRoot === ''
            ? h('div', { style: styles.card }, h('p', { style: styles.hint }, t.noRoot))
            : h('div', { style: styles.pathRow },
              h('code', { style: styles.path }, selectedRoot),
              h('button', { type: 'button', className: 'aim-btn', style: styles.button, onClick: copyPath }, t.copy),
              h('button', { type: 'button', className: 'aim-btn', style: styles.button, disabled: busy, onClick: reveal }, t.reveal)))
          : null,

        !isSettings && !isOverview ? h('p', { style: styles.hint }, scopeHint) : null,
        !isSettings && !isOverview && sharedNote !== '' ? h('p', { style: styles.hint }, sharedNote) : null,

        isSettings ? h('div', {
          style: {
            display: 'flex', gap: '4px', flexWrap: 'wrap',
            borderBottom: `1px solid ${colors.border}`, paddingBottom: '6px',
          },
        }, settingsSections.map((item) => h('button', {
          key: item.id,
          type: 'button',
          className: 'aim-btn',
          style: {
            ...styles.settingsNavItem,
            width: 'auto',
            borderColor: settingsSection === item.id ? 'rgba(77,107,254,.55)' : 'transparent',
            ...(settingsSection === item.id ? styles.settingsNavItemOn : {}),
          },
          onClick: (event) => {
            event.currentTarget.blur();
            setSettingsSection(item.id);
          },
        }, item.label))) : null,

        isSettings && (settingsSection === 'general' || settingsSection === 'models'
          || settingsSection === 'llama')
          ? h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' } },
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.primary,
              disabled: saving,
              onClick: saveConfig,
            }, saving ? t.saving : t.save)) : null,

        isSettings && settingsSection === 'conversation' && selectedSession === null
          ? h('section', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t.conversationSettings),
            h('p', { style: styles.hint }, t.overviewSessionEmpty))
          : null,
        isSettings && settingsSection === 'conversation' && selectedSession !== null
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

        view === 'layer'
          ? h('div', { style: styles.tiles },
            h(Tile, { label: t.counts.staging, value: counts.staging }),
            h(Tile, { label: t.counts.archive, value: counts.archive }),
            h(Tile, { label: t.counts.snapshots, value: counts.snapshots }),
            h(Tile, { label: t.counts.knowledge, value: counts.knowledge }),
            h(Tile, { label: t.counts.decisions, value: counts.decisions }),
            h(Tile, { label: t.counts.contexts, value: counts.contexts }))
          : null,

        isDiagnostics ? diagPage : null,

        isOverview ? overview : null,

        view === 'layer'
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
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
              active ? h('span', { 'aria-hidden': 'true', className: 'aim-indicator', style: styles.tabBarIndicator }) : null);
            })),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('p', { style: { ...styles.hint, flex: 1 } }, (t.tabHints && t.tabHints[tab]) || ''),
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
            h('div', { key: tab, className: 'aim-content', style: styles.card }, content))
          : null,

        isSettings && settingsSection === 'models'
          ? h('section', { style: styles.card },
          llamaColumns,
          h('h3', { style: styles.cardTitle }, t.externalTitle),
          h('p', { style: styles.hint }, t.externalHint),
          h('div', {
            style: {
              margin: '8px 0', padding: '8px 10px', border: `1px solid ${colors.border}`,
              borderRadius: '8px', background: colors.bg2,
            },
          },
          h('div', { style: { fontWeight: 600, fontSize: '12.5px' } }, t.localModelsTitle),
          h('p', { style: styles.hint }, t.localModelsHint),
          (data?.localModels?.roots ?? (data?.localModels?.root
            ? [{ dir: data.localModels.root }]
            : [])).length > 0
            ? h('p', { style: styles.meta }, `${t.localModelsRoot}: ${(data.localModels.roots
              ?? [{ dir: data.localModels.root }]).map((row) => row.dir).join(' · ')}`)
            : null,
          (data?.localModels?.categories ?? []).length === 0
            ? h('p', { style: styles.hint }, t.localModelsEmpty)
            : (data.localModels.categories.map((category) => h('div', {
              key: category.name,
              style: { marginTop: '6px' },
            },
            h('div', { style: { fontWeight: 600, fontSize: '12px' } }, category.name),
            category.models.length === 0
              ? h('p', { style: styles.hint }, t.localModelsEmpty)
              : category.models.map((model) => h('div', {
                key: model.id,
                style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '3px' },
              },
              h('span', { style: { fontSize: '12.5px' } }, model.label),
              h('span', { style: styles.hint },
                `${t.localModelKind}: ${model.kind || t.localModelKindUnknown}`
                  + (model.kindSource === 'name' ? `（${t.localModelKindByName}）` : '')),
              category.name === 'Loose'
                ? h('span', { style: { display: 'flex', gap: '4px' } },
                  h('button', {
                    type: 'button',
                    className: 'aim-btn',
                    style: { ...styles.button, padding: '1px 7px', fontSize: '11px' },
                    disabled: localModelBusy === model.id,
                    onClick: () => saveLocalKind(model, 'Embedding'),
                  }, t.localModelMarkEmbedding),
                  h('button', {
                    type: 'button',
                    className: 'aim-btn',
                    style: { ...styles.button, padding: '1px 7px', fontSize: '11px' },
                    disabled: localModelBusy === model.id,
                    onClick: () => saveLocalKind(model, 'Rerank'),
                  }, t.localModelMarkRerank))
                : null,
              model.runnable
                ? h('span', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                  h('span', { style: styles.hint }, t.localModelCtx),
                  h('input', {
                    style: { ...styles.input, width: '78px', padding: '2px 5px', fontSize: '11.5px' },
                    type: 'number',
                    min: 256,
                    max: 131072,
                    step: 256,
                    value: localCtxDrafts[model.id] ?? (model.ctxSize > 0 ? model.ctxSize : 2048),
                    onChange: (event) => setLocalCtxDrafts((prev) => ({ ...prev, [model.id]: event.target.value })),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'aim-btn',
                    style: { ...styles.button, padding: '1px 7px', fontSize: '11px' },
                    disabled: localModelBusy === model.id,
                    onClick: () => saveLocalCtx(model),
                  }, t.localModelCtxSave))
                : null,
              h('span', { style: styles.hint },
                model.runnable
                  ? ((data?.localEngines ?? []).find((engine) => engine.id === model.id)?.ready
                    ? `${(data?.localEngines ?? []).find((engine) => engine.id === model.id)?.stale
                      ? t.localModelStaleEngine
                      : (data?.localEngines ?? []).find((engine) => engine.id === model.id)?.adopted
                        ? t.localModelAdopted
                        : t.localModelEngineRunning}：${(data?.localEngines ?? []).find((engine) => engine.id === model.id)?.baseUrl ?? ''}`
                    : t.localModelGguf)
                  : (model.configured ? t.localModelReady : (model.error || t.localModelUnconfigured))),
              (model.runnable || model.configured)
                && (['Embedding', 'Rerank'].includes(category.name) || category.name === 'Loose')
                ? h('button', {
                  type: 'button',
                  className: 'aim-btn',
                  style: { ...styles.button, padding: '2px 8px', fontSize: '11.5px' },
                  disabled: localModelBusy === model.id,
                  onClick: () => applyLocalModel(category.name, model),
                }, localModelBusy === model.id
                  ? t.localModelStarting
                  : (model.runnable ? t.localModelStart : t.localModelUse))
                : null,
              (data?.localEngines ?? []).some((engine) => engine.id === model.id)
                ? h('button', {
                  type: 'button',
                  className: 'aim-btn',
                  style: { ...styles.button, padding: '2px 8px', fontSize: '11.5px' },
                  disabled: localModelBusy === model.id,
                  onClick: () => stopLocalEngine(model),
                }, t.localModelStop)
                : null)))),
          ((data?.localEngines ?? []).filter((engine) => engine.error).length > 0
            ? h('div', { style: { marginTop: '8px' } },
              h('div', { style: { fontWeight: 600, fontSize: '12px' } }, t.localModelDiagnostics),
              ...(data.localEngines ?? []).filter((engine) => engine.error).map((engine) => h('pre', {
                key: `engine-error-${engine.id}`,
                style: {
                  margin: '4px 0 0',
                  padding: '8px',
                  maxHeight: '240px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: '11px',
                  lineHeight: 1.45,
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  background: 'rgba(0, 0, 0, 0.04)',
                  border: '1px solid rgba(0, 0, 0, 0.12)',
                  borderRadius: '6px',
                },
              }, engine.error)))
            : null),
          h('p', { style: styles.hint }, t.localModelFuture))),
          h('div', {
            style: {
              margin: '10px 0', padding: '8px 10px', border: `1px solid ${colors.border}`,
              borderRadius: '8px', background: colors.bg2,
            },
          },
          h('div', { style: { fontWeight: 600, fontSize: '12.5px' } }, t.askTitle),
          h('p', { style: styles.hint }, t.askHint),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '6px 0' } },
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, disabled: askBusy, onClick: () => runAskAction('models') }, t.askModels),
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, disabled: askBusy, onClick: () => runAskAction('probe') }, t.askProbe),
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, disabled: askBusy, onClick: () => runAskAction('chat') }, t.askChat),
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, disabled: askBusy, onClick: () => runAskAction('embed') }, t.askEmbed),
            h('button', { type: 'button', className: 'aim-btn', style: styles.button, disabled: askBusy, onClick: () => runAskAction('rerank') }, t.askRerank)),
          h('input', {
            style: styles.input,
            placeholder: t.askTextPlaceholder,
            value: askText,
            onChange: (event) => setAskText(event.target.value),
          }),
          h('textarea', {
            style: { ...styles.input, marginTop: '5px', minHeight: '48px' },
            placeholder: t.askDocsPlaceholder,
            value: askDocs,
            onChange: (event) => setAskDocs(event.target.value),
          }),
          askResult !== ''
            ? h('pre', { style: { ...styles.pre, maxHeight: '260px', marginTop: '6px' } }, askResult)
            : null),
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
            : t.modeLocalHint)) : null,

        isSettings && settingsSection === 'network'
          ? h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.networkTitle),
          h('p', { style: styles.hint }, t.networkHint),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.networkEnable),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formNetworkEnabled,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formNetworkEnabled ? styles.switchOptionOn : {}) },
              onClick: () => setFormNetworkEnabled(true),
            }, t.switchOn),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': !formNetworkEnabled,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formNetworkEnabled ? {} : styles.switchOptionOn) },
              onClick: () => setFormNetworkEnabled(false),
            }, t.switchOff)),
          h('div', { style: styles.grid2 },
            h('label', { style: styles.label },
              t.networkRole,
              h('select', {
                style: styles.input,
                value: formNetworkRole,
                onChange: (event) => setFormNetworkRole(event.target.value),
              },
              h('option', { value: 'host' }, t.networkHost),
              h('option', { value: 'peer' }, t.networkPeer))),
            h('label', { style: styles.label },
              t.networkGroup,
              h('input', {
                style: styles.input,
                value: formNetworkGroup,
                placeholder: 'project-group',
                onChange: (event) => setFormNetworkGroup(event.target.value),
              }))),
          h('label', { style: styles.label },
            t.networkRemote,
            h('input', {
              style: styles.input,
              value: formNetworkRemote,
              placeholder: 'ssh://user@host/path/to/memory.git',
              onChange: (event) => setFormNetworkRemote(event.target.value),
            })),
          h('div', { style: styles.label },
            t.networkPaths,
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              ...[
                ['knowledge', t.networkPathKnowledge],
                ['archive', t.networkPathArchive],
                ['decisions', t.networkPathDecisions],
                ['snapshots', t.networkPathSnapshots],
                ['staging', t.networkPathStaging],
                ['contexts', t.networkPathContexts],
                ['sessions', t.networkPathSessions],
              ].map(([id, label]) => h('label', {
                key: id,
                style: { display: 'inline-flex', gap: '4px', alignItems: 'center', fontSize: '12px' },
              },
              h('input', {
                type: 'checkbox',
                checked: formNetworkPaths.includes(id),
                onChange: () => toggleNetworkPath(id),
              }), label)))),
          h('div', { style: styles.logBar },
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.primary,
              disabled: networkBusy,
              onClick: saveNetwork,
            }, t.networkSave),
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: networkBusy || !formNetworkEnabled,
              onClick: () => runNetwork('init'),
            }, t.networkInit),
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: networkBusy || !formNetworkEnabled,
              onClick: () => runNetwork('commit'),
            }, t.networkCommit),
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: networkBusy || !formNetworkEnabled,
              onClick: () => runNetwork('push'),
            }, t.networkUpload),
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: networkBusy || !formNetworkEnabled,
              onClick: () => runNetwork('pull'),
            }, t.networkPull),
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.button,
              disabled: networkBusy || !formNetworkEnabled,
              onClick: () => runNetwork('scan'),
            }, t.networkScan)),
          networkStatus
            ? h('p', { style: styles.hint },
              networkStatus.error
                ? networkStatus.error
                : `${t.networkStatus}: ${networkStatus.initialized ? (networkStatus.branch || 'git') : t.networkNoRepo}`
                  + (networkStatus.dirty > 0 ? `｜${t.networkDirty.replace('{n}', String(networkStatus.dirty))}` : `｜${t.networkClean}`)
                  + (networkStatus.ahead > 0 ? `｜${t.networkAhead} ${networkStatus.ahead}` : '')
                  + (networkStatus.behind > 0 ? `｜${t.networkBehind} ${networkStatus.behind}` : '')
                  + (networkStatus.lastCommit ? `｜${networkStatus.lastCommit.hash} ${networkStatus.lastCommit.subject}` : ''))
            : null) : null,

        isSettings && settingsSection === 'llama'
          ? h('section', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t.llamaTuneTitle),
            h('p', { style: styles.hint }, t.llamaTuneHint),
            h('div', { style: { margin: '2px 0 10px' } },
              h('div', { style: { ...styles.label, marginBottom: '4px' } }, t.engineLifecycle),
              h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
                [['manual', t.engineLifecycleManual], ['always', t.engineLifecycleAlways],
                  ['turn', t.engineLifecycleTurn]].map(([value, label]) => h('label', {
                  key: value,
                  style: { display: 'inline-flex', gap: '5px', alignItems: 'center', fontSize: '12.5px' },
                },
                h('input', {
                  type: 'radio',
                  name: 'aimEngineLifecycle',
                  value,
                  checked: formEngineLifecycle === value,
                  onChange: () => setFormEngineLifecycle(value),
                }), label))),
              h('p', { style: { ...styles.hint, margin: '4px 0 0' } },
                formEngineLifecycle === 'manual' ? t.engineLifecycleManualHint
                  : formEngineLifecycle === 'always' ? t.engineLifecycleAlwaysHint
                    : t.engineLifecycleTurnHint),
              h('p', { style: { ...styles.hint, margin: '2px 0 0' } },
                llamaModels.length > 0 ? t.engineLifecycleDetected : t.engineLifecycleNone),
              h('p', { style: { ...styles.hint, margin: '2px 0 0' } }, t.engineLifecycleSaveNote)),
            h('label', { style: styles.label },
              t.llamaSelectModel,
              h('select', {
                style: styles.input,
                value: llamaModelId,
                onChange: (event) => setLlamaModelId(event.target.value),
              },
              llamaModels.length === 0 ? h('option', { value: '' }, t.llamaNoModels) : null,
              llamaModels.map((model) => h('option', { key: model.id, value: model.id },
                `${model.label}（${model.kind}）`)))),
            llamaSelected
              ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: '8px', marginTop: '8px' } },
                h('label', { style: styles.label }, t.llamaCtx,
                  h('input', {
                    style: styles.input, type: 'number', min: 256, max: 131072, step: 256,
                    value: llamaCtx, onChange: (event) => setLlamaCtx(event.target.value),
                  })),
                h('label', { style: styles.label }, t.llamaPort,
                  h('input', {
                    style: styles.input, type: 'number', min: 0, max: 65535,
                    value: llamaPort, onChange: (event) => setLlamaPort(event.target.value),
                  })),
                h('label', { style: styles.label }, t.llamaPooling,
                  h('select', {
                    style: styles.input, value: llamaPooling,
                    onChange: (event) => setLlamaPooling(event.target.value),
                  },
                  h('option', { value: '' }, '—'),
                  ['cls', 'mean', 'last', 'none', 'rank'].map((value) => h('option', { key: value, value }, value)))),
                h('label', { style: styles.label }, t.llamaTimeout,
                  h('input', {
                    style: styles.input, type: 'number', min: 1000, max: 600000, step: 1000,
                    value: llamaTimeout, onChange: (event) => setLlamaTimeout(event.target.value),
                  })),
                h('label', { style: styles.label }, t.llamaBinary,
                  h('input', {
                    style: styles.input, value: llamaBinary,
                    placeholder: 'llama-server',
                    onChange: (event) => setLlamaBinary(event.target.value),
                  })),
                h('label', { style: { ...styles.label, gridColumn: '1 / -1' } }, t.llamaExtra,
                  h('textarea', {
                    style: { ...styles.input, minHeight: '62px', resize: 'vertical', fontFamily: 'ui-monospace, Consolas, monospace' },
                    value: llamaExtra, onChange: (event) => setLlamaExtra(event.target.value),
                  })))
              : null,
            h('div', { style: { display: 'flex', gap: '7px', flexWrap: 'wrap', marginTop: '9px', alignItems: 'center' } },
              h('button', {
                type: 'button', className: 'aim-btn', style: styles.primary,
                disabled: !llamaSelected || localModelBusy === llamaSelected.id,
                onClick: saveLlamaConfig,
              }, t.llamaSave),
              llamaSelected?.runnable
                ? h('button', {
                  type: 'button', className: 'aim-btn', style: styles.button,
                  disabled: localModelBusy === llamaSelected.id,
                  onClick: () => startLlamaModel(),
                }, t.llamaStart)
                : null,
              llamaSelected && (data?.localEngines ?? []).some((engine) => engine.id === llamaSelected.id)
                ? h('button', {
                  type: 'button', className: 'aim-btn', style: styles.button,
                  disabled: localModelBusy === llamaSelected.id,
                  onClick: () => stopLlamaModel(),
                }, t.llamaStop)
                : null,
              h('span', { style: { ...styles.hint, marginLeft: 'auto' } },
                llamaSelected
                  ? `${t.llamaModel}：${llamaSelected.path}`
                  : t.llamaNoModels)))
          : null,

        isSettings && settingsSection === 'advanced'
          ? h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.settingsAdvanced),
          h('p', { style: styles.hint }, t.advancedHint),
          h('div', { style: styles.grid2 },
            h('label', { style: styles.label },
              t.maxContextChars,
              h('input', { style: styles.input, type: 'number', min: 1000, max: 200000, value: formMaxContext, onChange: (event) => setFormMaxContext(event.target.value) })),
            h('label', { style: styles.label },
              t.defaultTopK,
              h('input', { style: styles.input, type: 'number', min: 1, max: 50, value: formTopK, onChange: (event) => setFormTopK(event.target.value) })),
            h('label', { style: styles.label },
              t.maxContentChars,
              h('input', { style: styles.input, type: 'number', min: 1000, max: 200000, value: formMaxContent, onChange: (event) => setFormMaxContent(event.target.value) })),
            h('label', { style: styles.label },
              t.maxSnapshotBytes,
              h('input', { style: styles.input, type: 'number', min: 1024, max: 1000000000, step: 1024, value: formMaxSnapshotBytes, onChange: (event) => setFormMaxSnapshotBytes(event.target.value) })),
            h('label', { style: styles.label },
              t.maxClearTurns,
              h('input', { style: styles.input, type: 'number', min: 1, max: 50, value: formMaxClearTurns, onChange: (event) => setFormMaxClearTurns(event.target.value) })),
            h('label', { style: styles.label },
              t.minClearChars,
              h('input', { style: styles.input, type: 'number', min: 0, max: 20000, value: formMinClearChars, onChange: (event) => setFormMinClearChars(event.target.value) })),
            h('label', { style: styles.label },
              t.maxClearChars,
              h('input', { style: styles.input, type: 'number', min: 1000, max: 1000000, value: formMaxClearChars, onChange: (event) => setFormMaxClearChars(event.target.value) })),
            h('label', { style: styles.label },
              t.autoKnowledgeLimit,
              h('input', { style: styles.input, type: 'number', min: 1, max: 100, value: formAutoKnowledgeLimit, onChange: (event) => setFormAutoKnowledgeLimit(event.target.value) }))),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.reviewHighRiskOnly),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': formReviewHighRiskOnly,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formReviewHighRiskOnly ? styles.switchOptionOn : {}) },
              onClick: () => setFormReviewHighRiskOnly(true),
            }, t.switchOn),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': !formReviewHighRiskOnly,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(!formReviewHighRiskOnly ? styles.switchOptionOn : {}) },
              onClick: () => setFormReviewHighRiskOnly(false),
            }, t.switchOff)),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.autoKnowledge),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': formAutoKnowledge,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formAutoKnowledge ? styles.switchOptionOn : {}) },
              onClick: () => setFormAutoKnowledge(true),
            }, t.switchOn),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': !formAutoKnowledge,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(!formAutoKnowledge ? styles.switchOptionOn : {}) },
              onClick: () => setFormAutoKnowledge(false),
            }, t.switchOff)),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.requestAnchor),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': formRequestAnchor,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formRequestAnchor ? styles.switchOptionOn : {}) },
              onClick: () => setFormRequestAnchor(true),
            }, t.switchOn),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': !formRequestAnchor,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(!formRequestAnchor ? styles.switchOptionOn : {}) },
              onClick: () => setFormRequestAnchor(false),
            }, t.switchOff)),
          h('h4', { style: { ...styles.cardTitle, marginTop: '14px' } }, t.retentionTitle),
          h('div', { style: styles.grid2 },
            h('label', { style: styles.label },
              t.stagingRetentionDays,
              h('input', { style: styles.input, type: 'number', min: 0, max: 3650, value: formStagingRetention, onChange: (event) => setFormStagingRetention(event.target.value) })),
            h('label', { style: styles.label },
              t.contextRetentionDays,
              h('input', { style: styles.input, type: 'number', min: 0, max: 3650, value: formContextRetention, onChange: (event) => setFormContextRetention(event.target.value) })),
            h('label', { style: styles.label },
              t.decisionRetentionDays,
              h('input', { style: styles.input, type: 'number', min: 0, max: 3650, value: formDecisionRetention, onChange: (event) => setFormDecisionRetention(event.target.value) })),
            h('label', { style: styles.label },
              t.autoDecisionRetentionDays,
              h('input', { style: styles.input, type: 'number', min: 0, max: 3650, value: formAutoDecisionRetention, onChange: (event) => setFormAutoDecisionRetention(event.target.value) }))),
          h('p', { style: styles.hint }, t.retentionNever),
          h('p', { style: styles.hint },
            `${t.storageUsed}: ${formatBytes(data?.storage?.totalBytes ?? 0)}｜`
              + `${t.storageContexts}: ${counts.contexts ?? 0} 个 / ${formatBytes(data?.storage?.bytes?.contexts ?? 0)}｜`
              + `${t.tabDecisions}: ${counts.decisions ?? 0} 个 / ${formatBytes(data?.storage?.bytes?.decisions ?? 0)}`),
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' } },
            h('button', {
              type: 'button', className: 'aim-btn', style: styles.button,
              disabled: retentionBusy, onClick: runRetentionCleanup,
            }, retentionBusy ? t.retentionCleaning : t.retentionCleanup),
            h('button', {
              type: 'button', className: 'aim-btn', style: styles.primary,
              disabled: saving, onClick: saveConfig,
            }, saving ? t.saving : t.save))) : null,

        isSettings && settingsSection === 'general'
          ? h('section', { style: styles.card },
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
              ? `${t.ragIndexed} ${ragIndex.docs} 篇 · ${t.ragConsidered} ${ragIndex.considered ?? ragIndex.docs} 篇 · `
                + `${t.ragDeduped} ${ragIndex.deduped ?? 0} 篇`
                + (Number(ragIndex.truncated) > 0 ? ` · ${t.ragTruncated} ${ragIndex.truncated} 篇` : '')
                + ` · ${ragIndex.dim}d · ${ragIndex.model || 'local'}`
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
                })),
              h('label', { style: styles.label },
                t.clearingKeepSteps,
                h('input', {
                  style: styles.input,
                  type: 'number',
                  min: 1,
                  max: 20,
                  value: formKeepSteps,
                  onChange: (event) => setFormKeepSteps(event.target.value),
                })))
            : null,
          h('label', { style: styles.label },
            t.restoreBudget,
            h('input', {
              style: styles.input,
              type: 'number',
              min: 1000,
              max: 100000,
              step: 1000,
              value: formRestoreMax,
              onChange: (event) => setFormRestoreMax(event.target.value),
            })),
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
          h('div', {
            style: {
              borderTop: '1px solid rgba(127,127,127,0.22)',
              marginTop: '14px',
              paddingTop: '12px',
            },
          },
          h('h4', { style: { ...styles.cardTitle, margin: '0 0 6px' } }, t.mcpTitle),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.mcpEnabledLabel),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formMcpEnabled,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(formMcpEnabled ? styles.switchOptionOn : {}) },
              onClick: () => setFormMcpEnabled(true),
            }, t.switchOn),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': !formMcpEnabled,
              className: 'aim-switch',
              style: { ...styles.switchOption, ...(!formMcpEnabled ? styles.switchOptionOn : {}) },
              onClick: () => setFormMcpEnabled(false),
            }, t.switchOff)),
          h('p', { style: styles.hint }, t.mcpHint),
          h('label', { style: styles.label },
            t.mcpUrlLabel,
            h('input', {
              style: styles.input,
              readOnly: true,
              value: mcpUrl,
              onFocus: (event) => event.target.select(),
            })),
          h('label', { style: styles.label },
            t.mcpTokenLabel,
            h('input', {
              style: styles.input,
              type: 'password',
              value: formMcpToken,
              placeholder: mcpHasToken ? t.mcpTokenSaved : t.mcpTokenNone,
              onChange: (event) => setFormMcpToken(event.target.value),
            })),
          mcpTokenFile
            ? h('p', { style: styles.hint }, `${t.mcpTokenAuto}: ${mcpTokenFile}`)
            : null),
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
            h('button', {
              type: 'button',
              className: 'aim-btn',
              style: styles.primary,
              disabled: saving,
              onClick: saveConfig,
            }, saving ? t.saving : t.save))) : null)
          )
        )
      );
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
