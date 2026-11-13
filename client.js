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
        subtitle: '分层项目记忆：过程记录 · 归档 · 快照 · 知识 · 决策',
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
        tabKnowledge: '知识',
        tabDecisions: '决策',
        tabContexts: '上下文',
        emptyStaging: '还没有过程记录。',
        emptyArchive: '还没有归档记录。',
        emptySnapshots: '还没有快照。',
        emptyKnowledge: '还没有知识文档。',
        emptyDecisions: '还没有决策审查记录。',
        emptyContexts: '还没有上下文存档。',
        contextRestoreHint: '需要恢复时，在对话里让我执行 aim_context restore。',
        searchPlaceholder: '搜索知识（标题/正文/分类）',
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
        modeHintManual: '自动整理已关闭；手动工具始终可用：aim_memory / aim_search / aim_decide / aim_context。',
        modeHintAuto: '自动整理已开启：每 N 轮自动执行 摘要→归档→上下文存档→压缩清理；手动工具仍然可用。',
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
          knowledge: '知识',
          decisions: '决策',
          contexts: '上下文',
        },
        decisionsSummary: '审查结果',
        details: '查看详情',
      },
      en: {
        nav: 'AI for Memory',
        title: 'AI for Memory',
        subtitle: 'Layered project memory: process log · archive · snapshots · knowledge · decisions',
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
        tabKnowledge: 'Knowledge',
        tabDecisions: 'Decisions',
        tabContexts: 'Contexts',
        emptyStaging: 'No process records yet.',
        emptyArchive: 'Nothing archived yet.',
        emptySnapshots: 'No snapshots yet.',
        emptyKnowledge: 'No knowledge documents yet.',
        emptyDecisions: 'No decision reviews yet.',
        emptyContexts: 'No archived contexts yet.',
        contextRestoreHint: 'To restore one, ask me in the chat to run aim_context restore.',
        searchPlaceholder: 'Search knowledge (id, text, category)',
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
        modeHintManual: 'Auto tidy is off; manual tools are always available: aim_memory / aim_search / aim_decide / aim_context.',
        modeHintAuto: 'Auto tidy is on: every N turns it digests, archives, saves context and compacts it. Manual tools remain available.',
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
      return h('div', { style: styles.tile },
        h('div', { style: styles.tileLabel }, props.label),
        h('div', { style: styles.tileValue }, String(props.value ?? 0)));
    }

    function Empty(props) {
      return h('p', { style: styles.empty }, props.text);
    }

    function EntryRow(props) {
      const row = props.row;
      return h('div', { style: styles.row },
        h('div', { style: styles.rowHead },
          row.kind ? h('span', { style: badgeStyle('pending') }, row.kind) : null,
          row.risk ? h('span', { style: badgeStyle(row.risk) }, `${t.risk}: ${row.risk}`) : null,
          row.category ? h('span', { style: badgeStyle('pending') }, row.category) : null,
          h('span', { style: { marginLeft: 'auto', color: colors.secondary, fontSize: '11.5px' } }, formatTime(row.timestamp))),
        h('p', { style: styles.content }, row.content ?? ''),
        row.source || row.dedup_id ? h('div', { style: styles.meta },
          row.source ? h('span', null, `${t.source}: ${row.source}`) : null,
          row.dedup_id ? h('span', { style: styles.mono }, row.dedup_id.slice(0, 10)) : null) : null);
    }

    function Dashboard() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [tab, setTab] = React.useState('staging');
      const [query, setQuery] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [formRoot, setFormRoot] = React.useState('');
      const [formDir, setFormDir] = React.useState('.ai-for-memory');
      const [formMode, setFormMode] = React.useState('manual');
      const [formRounds, setFormRounds] = React.useState(5);
      const [saving, setSaving] = React.useState(false);

      const load = React.useCallback(async (root) => {
        setBusy(true);
        try {
          const suffix = typeof root === 'string' && root !== '' ? `?root=${encodeURIComponent(root)}` : '';
          const payload = await callApi(`/state${suffix}`);
          setData(payload);
          setError(null);
          if (typeof payload.fixedRoot === 'string') setFormRoot(payload.fixedRoot);
          if (typeof payload.directoryName === 'string') setFormDir(payload.directoryName);
          if (typeof payload.autoEnabled === 'boolean') setFormMode(payload.autoEnabled ? 'auto' : 'manual');
          else if (payload.mode === 'manual' || payload.mode === 'auto') setFormMode(payload.mode);
          if (Number.isInteger(payload.autoEveryRounds)) setFormRounds(payload.autoEveryRounds);
        } catch (fetchError) {
          setError(String(fetchError?.message ?? fetchError));
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const selectedRoot = data?.selectedRoot ?? '';
      const roots = Array.isArray(data?.roots) ? data.roots : [];
      const counts = data?.counts ?? {};

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
          || String(doc.text).toLowerCase().includes(needle);
      });

      let content = null;
      if (tab === 'staging') {
        content = (data?.staging ?? []).length === 0
          ? h(Empty, { text: t.emptyStaging })
          : h('div', { style: styles.list }, (data?.staging ?? []).map((row) => h(EntryRow, { key: row.dedup_id, row })));
      } else if (tab === 'archive') {
        const categories = data?.archive ?? [];
        content = categories.length === 0
          ? h(Empty, { text: t.emptyArchive })
          : h('div', { style: styles.list }, categories.map((group) => h('section', { key: group.category, style: styles.card },
            h('div', { style: styles.rowHead },
              h('h3', { style: styles.cardTitle }, group.category),
              h('span', { style: styles.tabCount }, String(group.count))),
            group.entries.length === 0
              ? h(Empty, { text: t.emptyArchive })
              : h('div', { style: styles.list }, group.entries.map((row) => h(EntryRow, { key: row.dedup_id, row: { ...row, category: group.category } }))))));
      } else if (tab === 'snapshots') {
        const rows = data?.snapshots ?? [];
        content = rows.length === 0
          ? h(Empty, { text: t.emptySnapshots })
          : h('div', { style: styles.list }, rows.map((row) => h('div', { key: row.snapshot_id, style: styles.row },
            h('div', { style: styles.rowHead },
              h('span', { style: { fontWeight: 600 } }, row.snapshot_id),
              h('span', { style: styles.meta }, `${t.size}: ${formatBytes(row.state_size)}`),
              h('span', { style: { ...styles.meta, marginLeft: 'auto' } }, formatTime(row.timestamp))),
            h('details', { style: styles.details },
              h('summary', { style: styles.summary }, t.details),
              h('pre', { style: styles.pre }, row.state_text)))));
      } else if (tab === 'knowledge') {
        content = h('div', { style: styles.list },
          h('div', { style: styles.actions },
            h('input', {
              style: { ...styles.input, maxWidth: '360px' },
              placeholder: t.searchPlaceholder,
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            query !== '' ? h('button', { type: 'button', style: styles.button, onClick: () => setQuery('') }, t.clearSearch) : null),
          knowledge.length === 0
            ? h(Empty, { text: t.emptyKnowledge })
            : knowledge.map((doc) => h('div', { key: doc.doc_id, style: styles.row },
              h('div', { style: styles.rowHead },
                h('span', { style: { fontWeight: 600 } }, doc.doc_id),
                h('span', { style: badgeStyle('pending') }, doc.category)),
              h('p', { style: styles.content }, doc.text))));
      } else if (tab === 'decisions') {
        const rows = data?.decisions ?? [];
        content = rows.length === 0
          ? h(Empty, { text: t.emptyDecisions })
          : h('div', { style: styles.list }, rows.map((row) => h('div', { key: row.decision_id, style: styles.row },
            h('div', { style: styles.rowHead },
              h('span', { style: badgeStyle(row.outcome) }, row.outcome),
              h('span', { style: badgeStyle(row.risk_level) }, `${t.risk}: ${row.risk_level}`),
              h('span', { style: { ...styles.meta, marginLeft: 'auto' } }, formatTime(row.timestamp))),
            h('p', { style: styles.content }, row.decision),
            row.reason ? h('p', { style: styles.hint }, `${t.reason}: ${row.reason}`) : null,
            row.thesis || row.antithesis
              ? h('div', { style: styles.meta },
                row.thesis ? h('span', null, `${t.thesis}: ${row.thesis}`) : null,
                row.antithesis ? h('span', null, `${t.antithesis}: ${row.antithesis}`) : null)
              : null)));
      } else if (tab === 'contexts') {
        const rows = data?.contexts ?? [];
        content = rows.length === 0
          ? h(Empty, { text: t.emptyContexts })
          : h('div', { style: styles.list }, rows.map((row) => h('div', { key: row.context_id, style: styles.row },
            h('div', { style: styles.rowHead },
              h('span', { style: { fontWeight: 600 } }, row.context_id),
              h('span', { style: badgeStyle('pending') }, row.label),
              h('span', { style: { ...styles.meta, marginLeft: 'auto' } }, formatTime(row.created_at))),
            h('div', { style: styles.meta },
              h('span', null, `第 ${row.turn_from}-${row.turn_to} 轮`),
              h('span', null, `${row.turn_count} 轮`),
              h('span', null, `${row.chars} 字符`)),
            h('p', { style: styles.hint }, t.contextRestoreHint))));
      }

      return h('div', { style: styles.page },
        h('div', { style: styles.header },
          h('div', null,
            h('h2', { style: styles.title }, t.title),
            h('p', { style: styles.subtitle }, t.subtitle)),
          h('div', { style: styles.actions },
            h('label', { style: { ...styles.label, minWidth: '200px' } },
              t.root,
              h('select', {
                style: styles.input,
                value: selectedRoot ?? '',
                onChange: (event) => load(event.target.value),
              },
              roots.length === 0 ? h('option', { value: '' }, t.noRootShort) : null,
              roots.map((row) => h('option', {
                key: row.root,
                value: row.root,
              }, `${row.fixed ? t.fixedRoot : row.label}${row.root === selectedRoot ? '' : ` — ${row.root}`}`)))),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy,
              onClick: () => load(selectedRoot),
            }, busy ? '…' : t.refresh))),

        notice !== null
          ? h('div', {
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
            h('button', { type: 'button', style: styles.button, onClick: () => load('') }, t.retry))
          : null,

        selectedRoot === ''
          ? h('div', { style: styles.card }, h('p', { style: styles.hint }, t.noRoot))
          : h('div', { style: styles.pathRow },
            h('code', { style: styles.path }, selectedRoot),
            h('button', { type: 'button', style: styles.button, onClick: copyPath }, t.copy),
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: reveal }, t.reveal)),

        h('div', { style: styles.tiles },
          h(Tile, { label: t.counts.staging, value: counts.staging }),
          h(Tile, { label: t.counts.archive, value: counts.archive }),
          h(Tile, { label: t.counts.snapshots, value: counts.snapshots }),
          h(Tile, { label: t.counts.knowledge, value: counts.knowledge }),
          h(Tile, { label: t.counts.decisions, value: counts.decisions }),
          h(Tile, { label: t.counts.contexts, value: counts.contexts })),

        h('div', { style: styles.tabs }, tabs.map((item) => h('button', {
          key: item.id,
          type: 'button',
          style: { ...styles.tab, ...(tab === item.id ? styles.tabOn : {}) },
          onClick: () => setTab(item.id),
        }, item.label, h('span', { style: styles.tabCount }, String(item.count ?? 0))))),

        h('div', { style: styles.card }, content),

        h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.storageSettings),
          h('div', { style: styles.modeRow },
            h('span', { style: { fontSize: '13px', fontWeight: 600 } }, t.autoMode),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formMode === 'auto',
              style: { ...styles.tab, ...(formMode === 'auto' ? styles.tabOn : {}) },
              onClick: () => setFormMode('auto'),
            }, t.switchOn),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': formMode === 'manual',
              style: { ...styles.tab, ...(formMode === 'manual' ? styles.tabOn : {}) },
              onClick: () => setFormMode('manual'),
            }, t.switchOff)),
          h('p', { style: styles.hint }, formMode === 'auto' ? t.modeHintAuto : t.modeHintManual),
          formMode === 'auto'
            ? h('label', { style: { ...styles.label, maxWidth: '220px' } },
              t.modeRounds,
              h('input', {
                style: styles.input,
                type: 'number',
                min: 1,
                max: 100,
                value: formRounds,
                onChange: (event) => setFormRounds(event.target.value),
              }))
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
              style: styles.primary,
              disabled: saving,
              onClick: saveConfig,
            }, saving ? t.saving : t.save))));
    }

    return {
      inject: ['slots'],
      apply(clientCtx) {
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
