/**
 * AI for Memory — layered project memory for DeepSeek Harness.
 *
 * Based on the AI for Memory prototype: a rolling staging log, an
 * idempotent categorized archive, exact state snapshots, a local BM25 +
 * hashing-vector knowledge search, and risk-reviewed decisions.
 *
 * The plugin is dependency-free on purpose: it only imports Node builtins and
 * its own modules, then registers plain tool definition objects on `ctx.tools`.
 * That keeps installation working across DSH versions and lets the whole store
 * be tested with `node --test` without booting the Harness.
 */

import path from 'node:path';

import { MemoryStore } from './lib/store.js';
import { evaluateDecision } from './lib/decision.js';
import { CATEGORIES, KINDS, RISKS, VERIFIES, clip } from './lib/util.js';
import { defaultRegistryDir, rememberRoot } from './lib/registry.js';
import { installApi } from './lib/api.js';

export const name = 'dsh-ai-for-memory';

/** Only the tool registry is required; workspace comes from each call. */
export const inject = ['tools'];

const DEFAULTS = Object.freeze({
  directoryName: '.ai-for-memory',
  root: '',
  defaultTopK: 5,
  reviewHighRiskOnly: true,
  maxContentChars: 20000,
  maxSnapshotBytes: 262144,
});

/**
 * Config validator implementing the standard-schema shape DSH's loader uses.
 * `undefined` is valid input (a patch row without `config:`) and means defaults.
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-ai-for-memory',
    validate(raw) {
      const input = raw ?? {};
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'config 必须为对象', path: [] }] };
      }
      const issues = [];
      const value = { ...DEFAULTS };
      for (const key of Object.keys(DEFAULTS)) {
        if (!Object.hasOwn(input, key) || input[key] === undefined) continue;
        const fallbackType = typeof DEFAULTS[key];
        if (typeof input[key] !== fallbackType) {
          issues.push({ message: `${key} 必须是 ${fallbackType}`, path: [key] });
          continue;
        }
        value[key] = input[key];
      }
      if (issues.length > 0) return { issues };
      return { value };
    },
  }),
});

/** Resolve a raw config object (already validated or not) into complete values. */
export function normalizeConfig(raw) {
  const input = raw ?? {};
  const value = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.hasOwn(input, key) && input[key] !== undefined) value[key] = input[key];
  }
  return value;
}

// ---- tool schema helpers -------------------------------------------------

/**
 * Compile the implicit property map into the JSON Schema that `tools.register`
 * hands to the model: the property-level `required: true` is lifted to the
 * root `required` array and is not left on the property.
 */
export function compileParameterSchema(properties) {
  const result = {};
  const required = [];
  for (const [key, spec] of Object.entries(properties ?? {})) {
    if (spec === null || typeof spec !== 'object') continue;
    const { required: isRequired, ...rest } = spec;
    result[key] = rest;
    if (isRequired === true) required.push(key);
  }
  const schema = { type: 'object', properties: result };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Text-only tool output; `render` is required and must never be omitted. */
const TEXT_OUTPUT = Object.freeze({
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
});

/** Convert one raw definition into the shape `tools.register` accepts. */
export function toRegistrableTool(tool) {
  return {
    ...tool,
    parameters: compileParameterSchema(tool.parameters),
    output: tool.output ?? TEXT_OUTPUT,
  };
}

// ---- workspace / store ---------------------------------------------------

/**
 * Session workspace.
 *
 * Prefers the `workingDirectory` service, which tracks the session's *current*
 * effective directory after a `cd`; falls back to the recorded header cwd, then
 * the process directory. This keeps memory attached to the project the user is
 * actually working in.
 */
export function workspaceOf(exec, workingDirectory) {
  const session = exec?.agent?.session;
  if (workingDirectory && typeof workingDirectory.get === 'function' && session) {
    try {
      const current = workingDirectory.get(session);
      if (typeof current === 'string' && current.length > 0) return current;
    } catch {
      // Fall back to the committed header location below.
    }
  }
  const cwd = session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  return process.cwd();
}

/** Memory root for one call. Config `root` wins; relative values anchor at the workspace. */
export function rootFor(config, exec, workingDirectory) {
  const workspace = workspaceOf(exec, workingDirectory);
  if (typeof config.root === 'string' && config.root.trim() !== '') {
    return path.isAbsolute(config.root) ? config.root : path.join(workspace, config.root);
  }
  return path.join(workspace, config.directoryName);
}

function storeFor(config, exec, deps = {}) {
  const workspace = workspaceOf(exec, deps.workingDirectory);
  const root = rootFor(config, exec, deps.workingDirectory);
  const registryDir = deps.registryDir ?? defaultRegistryDir();
  try {
    // Record every root the agent touches so the panel can list it later.
    rememberRoot(root, workspace, registryDir);
  } catch {
    // A read-only home must not break memory writes.
  }
  return new MemoryStore(root, {
    maxContentChars: config.maxContentChars,
    maxSnapshotBytes: config.maxSnapshotBytes,
    defaultTopK: config.defaultTopK,
  });
}

// ---- formatting ----------------------------------------------------------

function formatStatus(status) {
  const lines = [`记忆根目录：${status.root}`];
  lines.push(`流水层：${status.staging.files} 个文件 / ${status.staging.entries} 条记录`);
  const archive = Object.entries(status.archive);
  lines.push(archive.length > 0
    ? `归档层：${archive.map(([category, count]) => `${category}=${count}`).join('，')}`
    : '归档层：空');
  lines.push(status.snapshots.count > 0
    ? `快照层：${status.snapshots.count} 个（最新 ${status.snapshots.latest}）`
    : '快照层：空');
  const knowledgeCategories = Object.entries(status.knowledge.categories);
  lines.push(knowledgeCategories.length > 0
    ? `知识库：${status.knowledge.documents} 篇（${knowledgeCategories.map(([category, count]) => `${category}=${count}`).join('，')}）`
    : '知识库：空');
  lines.push(`决策记录：${status.decisions.total} 条`
    + (status.decisions.total > 0
      ? `（${Object.entries(status.decisions.byOutcome).map(([outcome, count]) => `${outcome}=${count}`).join('，')}）`
      : ''));
  if (status.recent.length > 0) {
    lines.push('最近流水：');
    for (const row of status.recent) {
      lines.push(`  - [${row.kind}] ${row.content}（${row.timestamp}）`);
    }
  }
  return lines.join('\n');
}

function formatSnapshotList(rows) {
  if (rows.length === 0) return '暂无快照。';
  const lines = [`共 ${rows.length} 个快照（从旧到新）：`];
  for (const row of rows) {
    lines.push(`  - ${row.snapshot_id}（state≈${row.state_size} 字符，${row.timestamp}）`);
  }
  return lines.join('\n');
}

function formatHits(query, hits, mode) {
  if (hits.length === 0) return `没有命中「${query}」的知识文档（mode=${mode}）。`;
  const lines = [`命中 ${hits.length} 条（mode=${mode}）：`];
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. [${hit.category}] ${hit.doc_id}  score=${hit.score.toFixed(4)}`
      + `（bm25=${hit.bm25_score.toFixed(4)}，vector=${hit.vector_score.toFixed(4)}）`);
    lines.push(`   ${clip(hit.text, 320)}`);
  });
  return lines.join('\n');
}

function formatDecision(result) {
  const weights = Object.entries(result.weights)
    .map(([key, value]) => `${key}=${value}`)
    .join('，');
  return [
    `决策审查结果：${result.outcome}（approved=${result.approved}）`,
    `风险等级：${result.risk_level}｜是否审查：${result.reviewed}`,
    `权重：${weights}`,
    `理由：${result.reason}`,
    `decision_id：${result.decision_id}`,
  ].join('\n');
}

// ---- tool definitions ----------------------------------------------------

/**
 * Build the model-facing tools.
 *
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {object[]} raw definitions (parameters still a property map).
 */
export function createTools(config, deps = {}) {
  return [
    {
      name: 'aim_memory',
      description:
        '分层项目管理记忆（AI for Memory）：把工作过程写进流水、归档成分类、保存/恢复精确状态快照、'
        + '写入可检索的知识文档、查看各层统计。数据保存在当前工作区的记忆目录，跨会话/清空上下文后可读。'
        + '适合记录决策与理由、错误与修复、界面事实、任务状态；需要检索时用 aim_search。'
        + '不要写入密钥、令牌或用户没有说过的事实。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['stage', 'archive', 'snapshot', 'restore', 'list', 'remember', 'status'],
          description:
            'stage=追加一条流水（content 必填）；archive=按 kind 归档（可传 category 强制分类）；'
            + 'snapshot=保存 state 快照（name 必填）；restore=按 snapshot_id 恢复；list=列出快照；'
            + 'remember=写入知识文档（doc_id/text/category 必填）；status=查看统计。',
        },
        content: {
          type: 'string',
          description: 'stage 用：一条简洁的流水内容（决策、错误、界面事实或状态）。',
        },
        kind: {
          type: 'string',
          enum: [...KINDS],
          description: 'stage 用：粗分类，决定归档去向。默认 action。',
        },
        source: {
          type: 'string',
          description: 'stage 用：来源标识，例如 gui、api、agent。',
        },
        risk: {
          type: 'string',
          enum: [...RISKS],
          description: 'stage 用：风险等级，默认 low。',
        },
        verify: {
          type: 'string',
          enum: [...VERIFIES],
          description: 'stage 用：验证状态，默认 pending。',
        },
        category: {
          type: 'string',
          description:
            'archive 用：强制归档分类（' + CATEGORIES.join('/') + '）；'
            + 'remember 用：知识分类（自由字符串，如 errors_fixes）。',
        },
        name: {
          type: 'string',
          description: 'snapshot 用：快照名称（会脱敏后用于文件名）。',
        },
        state: {
          type: 'object',
          additionalProperties: true,
          description: 'snapshot 用：需要精确恢复的状态对象，默认空对象。',
        },
        snapshot_id: {
          type: 'string',
          description: 'restore 用：快照 id（也接受快照名称或 id 前缀）。',
        },
        doc_id: {
          type: 'string',
          description: 'remember 用：知识文档唯一 id，重复写入即覆盖。',
        },
        text: {
          type: 'string',
          description: 'remember 用：知识正文，一句话一条，避免流水账。',
        },
      },
      output: TEXT_OUTPUT,
      // Index assignment depends on the previous append; never run two writes together.
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: `AI for Memory · ${String(args?.action ?? 'memory')}`,
        kind: 'other',
        rawInput: args,
      }),
      async execute(args, exec) {
        const store = storeFor(config, exec, deps);
        const action = args?.action;

        if (action === 'stage') {
          const record = store.stage({
            content: args?.content,
            kind: args?.kind,
            source: args?.source,
            risk: args?.risk,
            verify: args?.verify,
          });
          return [
            `已写入流水：${record.source_file} #${record.entry_index}`,
            `kind=${record.kind} → ${record.category}｜risk=${record.risk}｜verify=${record.verify}`,
            clip(record.content, 500),
          ].join('\n');
        }

        if (action === 'archive') {
          const stats = store.archive({ category: args?.category ?? null });
          return `归档完成：archived=${stats.archived}，skipped=${stats.skipped}，failed=${stats.failed}`
            + (stats.categories.length > 0 ? `\n涉及分类：${stats.categories.join('，')}` : '');
        }

        if (action === 'snapshot') {
          const info = store.snapshot({
            name: args?.name,
            state: args?.state ?? {},
          });
          return `已创建快照：${info.snapshot_id}\nstate≈${info.state_size} 字符，文件：${info.file}`;
        }

        if (action === 'restore') {
          const id = String(args?.snapshot_id ?? '').trim();
          if (id === '') throw new Error('restore 需要 snapshot_id');
          const state = store.restoreSnapshot(id);
          if (state === null) throw new Error(`未找到快照：${id}`);
          return `已恢复快照：${id}\n${clip(JSON.stringify(state, null, 2), 20000)}`;
        }

        if (action === 'list') {
          return formatSnapshotList(store.listSnapshots());
        }

        if (action === 'remember') {
          const doc = store.remember({
            doc_id: args?.doc_id,
            text: args?.text,
            category: args?.category,
          });
          return `知识已写入：${doc.doc_id}（category=${doc.category}）\n${clip(doc.text, 300)}`;
        }

        if (action === 'status') {
          return formatStatus(store.status());
        }

        throw new Error(`未知 action：${String(action)}`);
      },
    },
    {
      name: 'aim_search',
      description:
        '检索当前项目的 AI for Memory 知识库（BM25 关键词 + 本地哈希向量）。'
        + '需要历史约定、先前决策、错误修复记录或界面事实时先检索，不要凭空猜测。'
        + '结果按相关度排序，并过滤掉零命中的文档。',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '检索词或自然语言问题，中英文均可。',
        },
        category: {
          type: 'string',
          description: '可选：只检索某个知识分类，例如 errors_fixes。',
        },
        mode: {
          type: 'string',
          enum: ['bm25', 'vector', 'hybrid'],
          description: '检索模式，默认 hybrid（0.6 BM25 + 0.4 余弦）。',
        },
        top_k: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: `返回条数，默认 ${config.defaultTopK}。`,
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: 'AI for Memory · search',
        kind: 'search',
        rawInput: args,
      }),
      async execute(args, exec) {
        const query = String(args?.query ?? '').trim();
        if (query === '') throw new Error('query 必须为非空字符串');
        const mode = args?.mode ?? 'hybrid';
        const store = storeFor(config, exec, deps);
        const hits = store.search(query, {
          category: args?.category ?? null,
          mode,
          topK: args?.top_k ?? config.defaultTopK,
        });
        return formatHits(query, hits, mode);
      },
    },
    {
      name: 'aim_decide',
      description:
        '对不可逆或高风险操作做正反合审查：给出决策与正/反理由，返回 approved / rejected / needs_more_info '
        + '以及可审计的权重。高风险要求 risk_adjusted_score ≤ 0.3，中风险要求 antithesis_weight ≤ 0.5；'
        + '缺少任一侧理由时返回 needs_more_info，不会编造理由替你放行。',
      parameters: {
        decision: {
          type: 'string',
          required: true,
          description: '要执行的决策，一句话。',
        },
        risk: {
          type: 'string',
          enum: [...RISKS],
          description: '风险等级，默认 low（低风险直接放行，不浪费审查）。',
        },
        thesis: {
          type: 'string',
          description: '支持该决策的理由（正）。',
        },
        antithesis: {
          type: 'string',
          description: '反对该决策的理由（反）。',
        },
      },
      output: TEXT_OUTPUT,
      // Writes one decision record; keep it serialized with other writes.
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: 'AI for Memory · decide',
        kind: 'other',
        rawInput: args,
      }),
      async execute(args, exec) {
        const result = evaluateDecision(
          {
            decision: args?.decision,
            risk: args?.risk ?? 'low',
            thesis: args?.thesis,
            antithesis: args?.antithesis,
          },
          { reviewHighRiskOnly: config.reviewHighRiskOnly },
        );
        const store = storeFor(config, exec, deps);
        store.recordDecision(result);
        return formatDecision(result);
      },
    },
  ];
}

// ---- plugin entry --------------------------------------------------------

/**
 * Register the three tools on the plugin's context.
 *
 * Each registration goes through `ctx.effect` so unloading the plugin removes
 * it; a failure for one tool (for example a future name clash) must not take
 * the other two down with it.
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config);
  let workingDirectory;
  try {
    workingDirectory = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined;
  } catch {
    workingDirectory = undefined;
  }
  const registryDir = defaultRegistryDir();
  const deps = { workingDirectory, registryDir };
  for (const raw of createTools(resolved, deps)) {
    const tool = toRegistrableTool(raw);
    try {
      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => ctx.tools.register(tool));
      } else {
        ctx.tools.register(tool);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[ai-for-memory] 工具 ${tool.name} 注册失败：${error?.message ?? error}`);
    }
  }

  // The Web panel reads the same store over a small same-origin HTTP API.
  let editor;
  try {
    editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined;
  } catch {
    editor = undefined;
  }
  try {
    installApi(ctx, {
      config: resolved,
      entry: ctx?.fiber?.entry,
      editor,
      registryDir,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[ai-for-memory] 面板 API 注册失败：${error?.message ?? error}`);
  }
}
