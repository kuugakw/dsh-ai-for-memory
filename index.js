/**
 * AI for Memory — layered project memory for DeepSeek Harness.
 *
 * Rewritten from the Python project `ai-game-for-memory` (originally
 * MemoryLayer): a rolling process log, an idempotent categorized archive,
 * exact state snapshots, a local BM25 + hashing-vector knowledge search, and
 * risk-reviewed decisions.
 *
 * On top of that, this plugin connects to DSH's `compaction` service so a
 * conversation can be archived, compacted out of the live window, and later
 * restored through `agent.inject()`.
 *
 * The plugin is dependency-free on purpose: it only imports Node builtins and
 * its own modules, then registers plain tool definition objects on `ctx.tools`.
 * That keeps installation working across DSH versions and lets the whole store
 * be tested with `node --test` without booting the Harness.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { MemoryScopes, sessionKey, shortSessionId } from './lib/scopes.js';
import { markActivity } from './lib/activity.js';
import { evaluateDecision } from './lib/decision.js';
import { CATEGORIES, KINDS, RISKS, VERIFIES, clip } from './lib/util.js';
import { defaultRegistryDir, rememberRoot } from './lib/registry.js';
import { installApi } from './lib/api.js';
import { collectTurnDigest } from './lib/auto.js';
import {
  buildContextSnapshot, collectTurns, formatRestoreContext, snapshotOfTurns,
} from './lib/context.js';
import { SIMILARITY_DEFAULT, describeTurns, selectTurnsByTopic } from './lib/similarity.js';
import { exceedsUsageThreshold, formatPressure, usagePercentOf } from './lib/pressure.js';
import {
  chat as externalChat,
  describeEndpoint,
  embed as externalEmbed,
  listModels as externalListModels,
  normalizeExternal,
  probe as externalProbe,
  rerank as externalRerank,
} from './lib/external.js';
import {
  classifyRecord,
  extractFacts,
  summarizeTurns as summarizeTurnsExternally,
} from './lib/external-ops.js';
import {
  buildRagIndex, ragCandidates, ragStats, rerankCandidates,
} from './lib/rag.js';
import {
  formatSqlResult, routeKnowledgeQuery, runSqlQuery,
} from './lib/knowledge-query.js';

export const name = 'dsh-ai-for-memory';

/** Only the tool registry is required; workspace comes from each call. */
export const inject = ['tools'];

const DEFAULTS = Object.freeze({
  directoryName: '.ai-for-memory',
  root: '',
  autoEnabled: false,
  autoEveryRounds: 5,
  // Percentage of the routed context window that also triggers a clear, on top
  // of the every-N-rounds trigger. Measured from the provider's last prompt size.
  contextUsagePercent: 70,
  // RAG over the knowledge layer: the index is built on demand (action=index)
  // and only used by aim_search while this mount switch is on. Off by default:
  // the local BM25 path never needs an external service.
  ragMount: false,
  maxContextChars: 30000,
  defaultTopK: 5,
  // Knowledge storage backend: 'json' (one file per document, default) or
  // 'sqlite' (a single queryable knowledge.sqlite, mirrored back to JSON).
  knowledgeBackend: 'json',
  reviewHighRiskOnly: true,
  maxContentChars: 20000,
  maxSnapshotBytes: 262144,
  // New conversations start open; the panel can close each one individually.
  defaultPublic: true,
  // External model endpoint: any OpenAI-compatible HTTP API (llama.cpp,
  // Ollama, LM Studio, vLLM, a hosted gateway). This is the transport the
  // future RAG index will use; nothing calls it unless asked.
  externalBaseUrl: 'http://127.0.0.1:8080',
  externalModel: '',
  externalApiKey: '',
  externalTimeoutMs: 60000,
  // The three layers below run on embedding + rerank models, so those endpoints
  // can live on their own process/port/provider. Empty = same as above.
  externalEmbedBaseUrl: '',
  externalEmbedModel: '',
  externalRerankBaseUrl: '',
  externalRerankModel: '',
  // Per-layer mode switch: false = the deterministic pipeline (always works,
  // offline), true = the external local model (same pipeline, model does the
  // reading). Every external pass falls back to the deterministic one on failure.
  archiveExternal: false,
  knowledgeExternal: false,
  contextExternal: false,
  // Clearing policy. A similarity-aware clear keeps the turns that still share
  // the current topic and removes only the ones the conversation has left
  // behind, instead of trimming by recency alone.
  topicalClear: true,
  similarityThreshold: SIMILARITY_DEFAULT,
  keepRecentTurns: 2,
  maxClearTurns: 8,
  minClearChars: 600,
  maxClearChars: 120000,
  // Text knowledge is mined from the three layers during automatic tidying so
  // the knowledge base grows without an extra prompt from the user.
  autoKnowledge: true,
  autoKnowledgeLimit: 10,
});

/** Integer bounds for the numeric settings; `null` marks a float setting. */
const NUMERIC_BOUNDS = Object.freeze({
  autoEveryRounds: [1, 100],
  contextUsagePercent: [1, 100],
  maxContextChars: [1000, 200000],
  keepRecentTurns: [1, 20],
  maxClearTurns: [1, 50],
  minClearChars: [0, 20000],
  maxClearChars: [1000, 1000000],
  autoKnowledgeLimit: [1, 100],
  similarityThreshold: [0.01, 0.95, 'float'],
  externalTimeoutMs: [1000, 600000],
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
        if (Object.hasOwn(NUMERIC_BOUNDS, key)) {
          const [low, high, kind] = NUMERIC_BOUNDS[key];
          const raw = input[key];
          const isFloat = kind === 'float';
          const shapeOk = typeof raw === 'number' && Number.isFinite(raw)
            && (isFloat || Number.isInteger(raw));
          if (!shapeOk || raw < low || raw > high) {
            issues.push({
              message: `${key} 必须是 ${low}~${high} 的${isFloat ? '数字' : '整数'}`,
              path: [key],
            });
          } else {
            value[key] = raw;
          }
          continue;
        }
        const fallbackType = typeof DEFAULTS[key];
        if (typeof input[key] !== fallbackType) {
          issues.push({ message: `${key} 必须是 ${fallbackType}`, path: [key] });
          continue;
        }
        if (key === 'knowledgeBackend' && !['json', 'sqlite', 'sql'].includes(input[key])) {
          issues.push({ message: 'knowledgeBackend 必须是 json 或 sqlite', path: [key] });
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
  // `sql` is a friendly alias; anything unknown falls back to the file backend.
  if (value.knowledgeBackend === 'sql') value.knowledgeBackend = 'sqlite';
  if (!['json', 'sqlite'].includes(value.knowledgeBackend)) value.knowledgeBackend = 'json';
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

/** Store options shared by every scope. */
function storeOptions(config) {
  return {
    maxContentChars: config.maxContentChars,
    maxSnapshotBytes: config.maxSnapshotBytes,
    defaultTopK: config.defaultTopK,
    knowledgeBackend: config.knowledgeBackend,
  };
}

/** Conversation id of the current call, or `''` when there is none. */
export function sessionOf(exec) {
  const id = exec?.agent?.session?.id;
  if (typeof id === 'string') return id;
  if (typeof id === 'number') return String(id);
  return '';
}

/** Facts worth persisting next to a conversation's memory. */
export function sessionMetaFrom(exec, workspace) {
  const header = exec?.agent?.session?.header ?? {};
  const meta = { workspace };
  if (typeof header.parentSession === 'string' && header.parentSession !== '') {
    meta.parent_session_id = header.parentSession;
  }
  if (typeof header.agentPreset === 'string' && header.agentPreset !== '') {
    meta.agent_preset = header.agentPreset;
  }
  if (typeof header.origin === 'string' && header.origin !== '') meta.origin = header.origin;
  return meta;
}

/** Scopes wrapper for one memory root. */
export function createScopes(root, config) {
  return new MemoryScopes(root, storeOptions(config));
}

/**
 * Resolve everything one tool call needs: the root, the scopes wrapper and the
 * calling conversation.
 *
 * @returns {{scopes: MemoryScopes, sessionId: string, workspace: string, root: string, meta: object}}
 */
export function memoryContext(config, exec, deps = {}, runtime = undefined) {
  const workspace = workspaceOf(exec, deps.workingDirectory);
  const root = rootFor(config, exec, deps.workingDirectory);
  const registryDir = deps.registryDir ?? defaultRegistryDir();
  try {
    // Record every root the agent touches so the panel can list it later.
    rememberRoot(root, workspace, registryDir);
  } catch {
    // A read-only home must not break memory writes.
  }
  const sessionId = sessionOf(exec);
  if (runtime && sessionId !== '') markActivity(runtime, sessionId);
  return { scopes: createScopes(root, config), sessionId, workspace, root, meta: sessionMetaFrom(exec, workspace) };
}

// ---- conversation activity ----------------------------------------------

/** Human label for a conversation row shown next to the own conversation. */
export function conversationLabel(row, ownKey = '') {
  if (typeof row?.scope === 'string') return row.scope === 'shared' ? '共享' : '本对话';
  const key = String(row?.key ?? row?.session_key ?? '');
  const isOwn = ownKey !== '' && key === ownKey;
  const prefix = isOwn ? '本对话' : '对话';
  const name = String(row?.name ?? '').trim();
  if (name !== '') return `${prefix} ${name}`;
  const sessionId = String(row?.sessionId ?? row?.session_id ?? '');
  if (sessionId !== '') return `${prefix} ${shortSessionId(sessionId)}`;
  return `${prefix} ${key.slice(-6) || '未知'}`;
}

/**
 * Every readable source for one call, in read order.
 *
 * `session` = only the calling conversation (falls back to shared when the call
 * has no Session), `shared` = only the root-level layer, `all` = the calling
 * conversation first, then every other conversation, then the shared layer.
 *
 * @returns {Array<{store: MemoryStore, scope: 'session'|'shared', key: string,
 *   sessionId: string, label: string, meta: object}>}
 */
export function memorySources(context, scope = 'session') {
  const { scopes, sessionId, meta } = context;
  const ownKey = sessionId === '' ? null : sessionKey(sessionId);
  const shared = {
    store: scopes.sharedStore(), scope: 'shared', key: '', sessionId: '', label: '共享', meta: {},
  };
  if (scope === 'shared') return [shared];
  let own = null;
  if (ownKey !== null) {
    const resolved = scopes.sessionStoreFor(sessionId, meta);
    own = {
      store: resolved.store, scope: 'session', key: ownKey, sessionId, label: '本对话', meta: resolved.meta,
    };
  }
  if (scope === 'session') return own ? [own] : [shared];

  const sources = own ? [own] : [];
  for (const row of scopes.listSessions()) {
    if (ownKey !== null && row.key === ownKey) continue;
    // A conversation that is not open is invisible to every other conversation:
    // no cross-conversation search, no restored contexts, no merged panel view.
    if (row.public === false) continue;
    sources.push({
      store: scopes.sessionStore(row.key),
      scope: 'session',
      key: row.key,
      sessionId: row.sessionId,
      label: conversationLabel(row, ownKey),
      meta: row,
    });
  }
  if (scopes.sharedHasData()) sources.push(shared);
  return sources;
}

/**
 * Conversations the caller may read: its own plus every open one.
 *
 * Used by the status/sessions summaries so a closed conversation never leaks
 * its name or size to another conversation.
 */
export function readableConversations(context) {
  const { scopes, sessionId } = context;
  const ownKey = sessionId === '' ? null : sessionKey(sessionId);
  return scopes.listSessions().filter((row) => row.key === ownKey || row.public !== false);
}

/** Count of conversations hidden from this caller by their access setting. */
export function closedConversationCount(context) {
  const { scopes, sessionId } = context;
  const ownKey = sessionId === '' ? null : sessionKey(sessionId);
  return scopes.listSessions().filter((row) => row.key !== ownKey && row.public === false).length;
}

/** The one store a write targets. */
export function writeSource(context, scope = 'session') {
  return memorySources(context, scope === 'shared' ? 'shared' : 'session')[0];
}

/** All conversation stores plus shared, for a cross-conversation lookup. */
export function lookupSources(context) {
  const sources = memorySources(context, 'all');
  if (sources.every((source) => source.scope !== 'shared')) sources.push(memorySources(context, 'shared')[0]);
  return sources;
}

// ---- formatting ----------------------------------------------------------

/** Format one store's layer counts as the human summary lines. */
function formatLayers(status) {
  const lines = [];
  lines.push(`过程记录层：${status.staging.files} 个文件 / ${status.staging.entries} 条记录`);
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
  const knowledgeSources = Object.entries(status.knowledge.sources ?? {});
  if (knowledgeSources.length > 0) {
    lines.push(`知识来源：${knowledgeSources.map(([from, count]) => `${from}=${count}`).join('，')}`);
  }
  lines.push(`待提炼：约 ${status.knowledge.pending ?? 0} 条（promote 预览/写入，learn 直接写知识）`);
  lines.push(`决策记录：${status.decisions.total} 条`
    + (status.decisions.total > 0
      ? `（${Object.entries(status.decisions.byOutcome).map(([outcome, count]) => `${outcome}=${count}`).join('，')}）`
      : ''));
  if (status.recent.length > 0) {
    lines.push('最近过程记录：');
    for (const row of status.recent) {
      lines.push(`  - [${row.kind}] ${row.content}（${row.timestamp}）`);
    }
  }
  return lines;
}

/**
 * Status for the current scope plus a compact view of the other conversations.
 *
 * @param {object} status - one store's `status()`.
 * @param {{label: string, root: string, otherRows?: Array<object>}} context
 */
function formatStatus(status, context) {
  const lines = [`记忆根目录：${context.root}`, `当前范围：${context.label}`];
  lines.push(...formatLayers(status));
  const others = Array.isArray(context.otherRows) ? context.otherRows : [];
  if (others.length > 0) {
    lines.push(`其他对话：${others.length} 个（可用 aim_memory/get scope=shared、aim_search scope=all 或 aim_context sessions 访问）`);
    for (const row of others.slice(0, 10)) {
      const counts = row.counts ?? {};
      lines.push(`  - ${conversationLabel(row)}：过程记录 ${counts.staging ?? 0}，归档 ${counts.archive ?? 0}，知识库 ${counts.knowledge ?? 0}，上下文 ${counts.contexts ?? 0}，最近 ${row.updatedAt || '未知'}`);
    }
  }
  if (context.closedCount > 0) {
    lines.push(`另有 ${context.closedCount} 个对话未对外开放（本对话读不到）`);
  }
  if (context.sharedCounts) {
    const shared = context.sharedCounts;
    lines.push(`共享层：过程记录 ${shared.staging}，归档 ${shared.archive}，快照 ${shared.snapshots}，知识库 ${shared.knowledge}，决策 ${shared.decisions}，上下文 ${shared.contexts}`);
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
    const metric = mode === 'rag'
      ? `（RAG 相似度=${hit.score.toFixed(4)}）`
      : `（bm25=${hit.bm25_score.toFixed(4)}，vector=${hit.vector_score.toFixed(4)}）`;
    lines.push(`${index + 1}. [${hit.category}] ${hit.doc_id}  score=${hit.score.toFixed(4)}`
      + metric
      + (hit.source && hit.source !== 'unknown' ? `｜知识来源：${hit.source}` : '')
      + (hit.origin_label ? `｜对话：${hit.origin_label}` : ''));
    lines.push(`   ${clip(hit.text, 320)}`);
  });
  return lines.join('\n');
}

/**
 * RAG path for `aim_search`, used only while the manual mount switch is on.
 *
 * The query is embedded once, every selected store's index is scored locally,
 * and only the merged candidates go through one optional rerank call. Any
 * failure returns a note so the caller can fall back to local retrieval.
 */
async function searchWithRag(config, sources, query, options = {}) {
  const endpoint = externalOpEndpointFrom(config, 30000);
  const embedded = await externalEmbed(endpoint, query);
  if (!embedded.ok) {
    return {
      ok: false,
      note: `RAG 已挂载，但查询嵌入失败：${embedded.error}\n已回退本地检索。`,
    };
  }
  const vector = embedded.vectors[0];
  const candidates = [];
  let indexedStores = 0;
  let unindexedStores = 0;
  for (const source of sources) {
    const result = ragCandidates(source.store, vector, { topK: 40, category: options.category ?? null });
    if (!result.ok) {
      unindexedStores += 1;
      continue;
    }
    indexedStores += 1;
    for (const row of result.candidates) candidates.push({ ...row, source });
  }
  if (indexedStores === 0) {
    return {
      ok: false,
      note: `RAG 已挂载，但所选范围还没有索引（${unindexedStores} 个存储）——先运行 aim_memory action=index。\n已回退本地检索。`,
    };
  }
  candidates.sort((left, right) => right.score - left.score);
  const reranked = await rerankCandidates(endpoint, query, candidates.slice(0, 20), {
    topK: Number.isInteger(options.topK) && options.topK > 0 ? options.topK : config.defaultTopK,
  });
  if (reranked.ok !== true) {
    return { ok: false, note: `RAG 检索失败：${reranked.error ?? '未知错误'}\n已回退本地检索。` };
  }
  const covers = `范围：${sources.map((source) => source.label).join(' + ')}`
    + (unindexedStores > 0 ? `（${unindexedStores} 个存储还没有索引，未参与）` : '');
  if (reranked.hits.length === 0) {
    return {
      ok: true,
      empty: true,
      text: `RAG 检索（${reranked.via === 'rerank' ? '嵌入 + 重排' : '嵌入'}）没有命中「${query}」。\n${covers}`,
    };
  }
  const hits = reranked.hits.map((row) => ({
    doc_id: row.doc.doc_id,
    text: row.doc.text,
    category: row.doc.category,
    source: row.doc.source,
    url: row.doc.url,
    score: row.score,
    origin_label: row.source.label,
    origin_key: row.source.key,
    origin_scope: row.source.scope,
  }));
  return {
    ok: true,
    empty: false,
    text: `检索方式：RAG（${reranked.via === 'rerank' ? '嵌入 + 重排' : '嵌入'}）｜${covers}\n`
      + formatHits(query, hits, 'rag')
      + '\n（RAG 只覆盖已建索引的知识文档；在面板关闭「RAG 挂载」即可回到本地 BM25 检索。）',
  };
}

/** Format one `promote` result for the model. */
/** Collect the raw text the external knowledge extractor reads. */
function gatherPromoteSource(store) {
  const chunks = [];
  for (const record of store.stagingRecords().slice(-40)) {
    if (typeof record.content === 'string' && record.content.trim() !== '') {
      chunks.push(record.content.trim());
    }
  }
  for (const category of CATEGORIES) {
    for (const entry of store.archiveEntries(category, 20)) {
      const text = entry?.content ?? entry?.text ?? '';
      if (typeof text === 'string' && text.trim() !== '') chunks.push(text.trim());
    }
  }
  return chunks.join('\n\n');
}

/** Build the external endpoint from the plugin config. */
function externalEndpointOf(config) {
  return normalizeExternal({
    baseUrl: config.externalBaseUrl,
    model: config.externalModel,
    embedBaseUrl: config.externalEmbedBaseUrl,
    embedModel: config.externalEmbedModel,
    rerankBaseUrl: config.externalRerankBaseUrl,
    rerankModel: config.externalRerankModel,
    apiKey: config.externalApiKey,
    timeoutMs: config.externalTimeoutMs,
  });
}

/**
 * The endpoint used by the per-layer switches. Its timeout is capped so a
 * half-dead model can never stall an archive/promote/clear for a whole minute
 * per record; the caller falls back to the deterministic path instead.
 */
function externalOpEndpointFrom(config, capMs = 15000) {
  const endpoint = externalEndpointOf(config);
  return { ...endpoint, timeoutMs: Math.min(endpoint.timeoutMs, capMs) };
}

/**
 * Report a blocked knowledge write: the fact was **not** stored because it may
 * contradict something already known, so the user has to decide first.
 */
function formatConflict(result) {
  const pending = result?.pending ?? {};
  const conflicts = Array.isArray(result?.conflicts) ? result.conflicts : [];
  const lines = [
    '未写入：这条知识可能与已有知识冲突，需要先问用户。',
    `待写入：${clip(pending.text ?? '', 300)}`,
  ];
  for (const row of conflicts.slice(0, 3)) {
    lines.push(`- 已有 [${row.category || '未分类'}] ${row.doc_id}（相似度 ${row.similarity}）：${clip(row.text, 160)}`);
  }
  lines.push('请向用户确认三件事：以哪条为准、是否覆盖旧条目（给旧条目 doc_id）、是否只是补充；');
  lines.push('用户同意后再用 confirm=true 重新调用（同意覆盖时同时传旧条目的 doc_id）。用户不同意就不要写入。');
  return lines.join('\n');
}

function formatPromotion(result) {
  const scanned = result.scanned ?? {};
  const lines = [
    `${result.dryRun ? '提炼预览（未写入）' : '已从三层提炼知识'}：`
      + `过程记录 ${scanned.staging ?? 0}，归档 ${scanned.archive ?? 0}，`
      + `上下文轮次 ${scanned.contexts ?? 0}，决策 ${scanned.decisions ?? 0}`,
    `${result.dryRun ? '将新增' : '新增'} ${result.added.length} 篇，合并 ${result.merged.length} 篇，`
      + `剩余 ${result.remaining} 条待下次`,
  ];
  for (const row of result.added.slice(0, 20)) {
    lines.push(`- [${row.category}] ${row.doc_id}（${row.source}）：${clip(row.text, 160)}`);
  }
  for (const row of result.merged.slice(0, 10)) {
    lines.push(`- 已合并进 ${row.doc_id}：${clip(row.text, 120)}`);
  }
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
export function createTools(config, deps = {}, runtime = { counters: new Map(), pending: new Map(), activity: new Map() }) {
  return [
    {
      name: 'aim_memory',
      description:
        '分层项目管理记忆（AI for Memory）：把工作过程记进过程记录、归档成分类、保存/恢复精确状态快照、'
        + '写入与检索知识库、查看各层统计。数据保存在当前工作区的记忆目录，跨会话/清空上下文后可读。'
        + '知识库分两类来源：你从网页或推理得到的、用户给你的，用 remember/learn 写；'
        + '过程记录、归档、上下文这三层里的用户规则、错误修复、决策理由，用 promote 提炼。'
        + '每条知识只写一句可复用的结论，必须带分类，并尽量给出处（url 或 source）。'
        + '默认写入当前对话自己的独立记忆；scope=shared 时写入所有对话共用的共享层。'
        + '冲突规则：新知识与已有知识、或与你自己的认知不一致时，先询问用户，得到同意后再带 confirm=true 写入；'
        + '不带 confirm 的写入若与已有知识相近但不同，会返回 needs_confirm 并列出冲突条目，此时必须先问用户，不要擅自覆盖。'
        + '需要检索时用 aim_search（默认跨对话）。不要写入密钥、令牌或用户没有说过的事实。'
        + '面板可把「归档 / 知识库提炼 / 上下文清理」分别切到外部模型模式（任何 OpenAI 兼容服务）；'
        + '外部模式失败会自动回退本地规则，结果里会写明用了哪条路。'
        + 'RAG：索引建在知识库上（action=index），是否挂到 aim_search 由面板「RAG 挂载」开关控制，可随时挂/摘。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['stage', 'archive', 'snapshot', 'restore', 'list', 'remember', 'learn', 'promote', 'forget', 'index', 'status'],
          description:
            'stage=追加一条过程记录（content 必填）；archive=按 kind 归档（可传 category 强制分类）；'
            + 'snapshot=保存 state 快照（name 必填）；restore=按 snapshot_id 恢复；list=列出快照；'
            + 'remember=写入一条知识（text 必填，doc_id 可省）；learn=批量写知识（items 必填）；'
            + 'promote=从过程记录/归档/上下文提炼知识（dry_run 可预览）；forget=删除一条错误知识（doc_id 必填）；'
            + 'index=为当前范围的知识库建立/更新 RAG 索引（需要外部嵌入服务）；status=查看统计。',
        },
        scope: {
          type: 'string',
          enum: ['session', 'shared'],
          description:
            '写入范围，默认 session=当前对话独立存储（其他对话看不到写入，但可被检索）；'
            + 'shared=所有对话共用的共享层（适合跨对话约定、全局事实）。',
        },
        content: {
          type: 'string',
          description: 'stage 用：一条简洁的过程记录内容（决策、错误、界面事实或状态）。',
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
          description: 'remember 用：知识文档 id，可省略——省略时按正文生成稳定 id，同一条知识重复写入会合并。',
        },
        text: {
          type: 'string',
          description: 'remember 用：知识正文，一句话一条结论，避免罗列琐碎条目。',
        },
        items: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'learn 用：批量知识条目，每项 {text, category?, tags?, url?, source?, confidence?}；'
            + '适合一次写入多轮对话里得到的若干条结论。',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'remember/learn 用：标签（最多 8 个），便于按主题过滤。',
        },
        url: {
          type: 'string',
          description: 'remember/learn 用：出处链接。网页得来的知识必须带上，分类会归到 external_sources。',
        },
        confidence: {
          type: 'number',
          description: 'remember/learn 用：置信度 0~1，默认 0.8；网页单源事实建议 0.6~0.7。',
        },
        confirm: {
          type: 'boolean',
          description:
            'remember/learn 用：默认 false。与已有知识相近但内容不同时，写入会被拦下并返回冲突，'
            + '此时必须先向用户确认；用户同意后再带 confirm=true 重试，同意"以新为准"就再传旧条目的 doc_id。',
        },
        dry_run: {
          type: 'boolean',
          description: 'promote 用：只预览会提炼出什么，不写盘。',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'promote 用：单次最多写入多少条，默认 20。',
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
        const context = memoryContext(config, exec, deps, runtime);
        const action = args?.action;
        const requested = args?.scope === 'shared' ? 'shared' : 'session';
        const source = writeSource(context, requested);
        const store = source.store;

        if (action === 'stage') {
          const record = store.stage({
            content: args?.content,
            kind: args?.kind,
            source: args?.source,
            risk: args?.risk,
            verify: args?.verify,
          });
          return [
            `已写入过程记录：${record.source_file} #${record.entry_index}`,
            `范围：${source.label}（${source.scope === 'shared' ? '共享层' : shortSessionId(context.sessionId)}）`,
            `kind=${record.kind} → ${record.category}｜risk=${record.risk}｜verify=${record.verify}`,
            clip(record.content, 500),
          ].join('\n');
        }

        if (action === 'archive') {
          const forced = args?.category ?? null;
          let overrides = null;
          let modelNote = '';
          if (config.archiveExternal === true) {
            const endpoint = externalOpEndpointFrom(config);
            // Cap the per-run model work; whatever is left keeps the local route.
            const staged = store.stagingRecords().slice(0, 12);
            overrides = {};
            let classified = 0;
            let reranked = 0;
            let failed = 0;
            for (const record of staged) {
              if (!record.dedup_id) continue;
              const picked = await classifyRecord(endpoint, record);
              if (picked.ok) {
                overrides[record.dedup_id] = picked.category;
                classified += 1;
                if (picked.via === 'rerank') reranked += 1;
              } else {
                failed += 1;
              }
            }
            modelNote = classified > 0
              ? `\n外部模型（嵌入${reranked > 0 ? '+重排' : ''}）分类 ${classified} 条`
                + `${reranked > 0 ? `，其中 ${reranked} 条经重排定稿` : ''}`
                + `${failed > 0 ? `，${failed} 条回退本地规则` : ''}`
              : '\n外部模型没给出可用分类，本次全部用本地规则。';
          }
          const stats = store.archive({ category: forced, categories: overrides ?? undefined });
          return `归档完成（${source.label}）：archived=${stats.archived}，skipped=${stats.skipped}，failed=${stats.failed}`
            + (stats.categories.length > 0 ? `\n涉及分类：${stats.categories.join('，')}` : '')
            + modelNote;
        }

        if (action === 'snapshot') {
          const info = store.snapshot({
            name: args?.name,
            state: args?.state ?? {},
          });
          return `已创建快照（${source.label}）：${info.snapshot_id}\nstate≈${info.state_size} 字符，文件：${info.file}`;
        }

        if (action === 'restore') {
          const id = String(args?.snapshot_id ?? '').trim();
          if (id === '') throw new Error('restore 需要 snapshot_id');
          // Snapshots are conversation-scoped by default, but a cross-conversation
          // restore is exactly the "access another conversation" case.
          const candidates = requested === 'shared' ? [source] : [source, ...lookupSources(context)];
          let found = null;
          for (const candidate of candidates) {
            const state = candidate.store.restoreSnapshot(id);
            if (state !== null) {
              found = { state, source: candidate };
              break;
            }
          }
          if (!found) throw new Error(`未找到快照：${id}`);
          return [
            `已恢复快照：${id}（${found.source.label}）`,
            clip(JSON.stringify(found.state, null, 2), 20000),
          ].join('\n');
        }

        if (action === 'list') {
          const own = store.listSnapshots();
          const outside = lookupSources(context)
            .filter((candidate) => candidate.store !== store)
            .reduce((sum, candidate) => sum + candidate.store.listSnapshots().length, 0);
          return formatSnapshotList(own)
            + (outside > 0
              ? `\n其他对话/共享层还有 ${outside} 个快照；restore 默认会跨对话查找。`
              : '');
        }

        if (action === 'remember') {
          const doc = store.remember({
            doc_id: args?.doc_id,
            text: args?.text,
            category: args?.category,
            source: args?.source,
            tags: args?.tags,
            url: args?.url,
            confidence: args?.confidence,
            evidence: [{ kind: 'authored', ref: String(args?.source ?? 'authored') }],
          }, { confirm: args?.confirm === true });
          if (doc && doc.needs_confirm) return formatConflict(doc);
          return [
            `${doc.merged ? '知识已合并' : '知识已写入'}（${source.label}）：${doc.doc_id}`,
            `分类：${doc.category}｜来源：${doc.source}`
              + (doc.tags.length > 0 ? `｜标签：${doc.tags.join('，')}` : '')
              + (doc.url !== '' ? `｜出处：${doc.url}` : ''),
            clip(doc.text, 400),
          ].join('\n');
        }

        if (action === 'learn') {
          const items = Array.isArray(args?.items) ? args.items : [];
          if (items.length === 0) throw new Error('learn 需要非空的 items 数组');
          const written = [];
          const failed = [];
          const blocked = [];
          for (const item of items.slice(0, 100)) {
            if (!item || typeof item !== 'object') {
              failed.push('跳过一条非对象条目');
              continue;
            }
            try {
              const doc = store.remember({
                text: item.text,
                category: item.category,
                source: item.source ?? 'reasoning',
                tags: item.tags,
                url: item.url,
                confidence: item.confidence,
              }, { confirm: args?.confirm === true });
              if (doc && doc.needs_confirm) {
                blocked.push(doc);
                continue;
              }
              written.push(doc);
            } catch (error) {
              failed.push(`${clip(item.text ?? '', 60)}：${error?.message ?? error}`);
            }
          }
          const merged = written.filter((doc) => doc.merged).length;
          const lines = [
            `已写入知识 ${written.length} 条（新增 ${written.length - merged}，合并 ${merged}）`
              + (blocked.length > 0 ? `，待确认 ${blocked.length} 条` : '')
              + (failed.length > 0 ? `，失败 ${failed.length}` : ''),
          ];
          for (const doc of written) {
            lines.push(`- [${doc.category}] ${doc.doc_id}（${doc.source}）：${clip(doc.text, 120)}`);
          }
          for (const doc of blocked.slice(0, 5)) {
            lines.push('');
            lines.push(formatConflict(doc));
          }
          for (const row of failed.slice(0, 5)) lines.push(`  ! ${row}`);
          return lines.join('\n');
        }

        if (action === 'promote') {
          if (config.knowledgeExternal === true) {
            const text = gatherPromoteSource(store);
            if (text.trim() === '') return '没有可提炼的过程记录或归档。';
            const mined = await extractFacts(externalOpEndpointFrom(config, 30000), text);
            if (!mined.ok) {
              return `外部模型提炼失败：${mined.error}\n本次没有写入知识。`
                + '关掉「知识用外部模型」可回到本地提炼，或先启动 llama-server。';
            }
            if (args?.dry_run === true) {
              return [`外部模型提炼预览（${source.label}）：${mined.items.length} 条（未写入）`,
                ...mined.items.map((item, index) => `${index + 1}. [${item.category}] ${item.text}`)].join('\n');
            }
            let written = 0;
            let merged = 0;
            const ids = [];
            for (const item of mined.items) {
              const doc = store.remember(
                { text: item.text, category: item.category, source: 'external-model' },
                { confirm: true },
              );
              if (doc?.doc_id) {
                written += 1;
                if (doc.merged) merged += 1;
                ids.push(doc.doc_id);
              }
            }
            return [
              `外部模型提炼完成（${source.label}）：候选 ${mined.items.length} 条，写入 ${written} 条`
                + `${merged > 0 ? `（其中 ${merged} 条与已有知识合并）` : ''}。`,
              ...ids.slice(0, 8).map((id) => `  - ${id}`),
              '说明：外部模型提炼与本地 promote 一样走 confirm 写入，不再逐条询问冲突。',
            ].join('\n');
          }
          const result = store.promoteKnowledge({
            dryRun: args?.dry_run === true,
            limit: Number.isInteger(args?.limit) ? args.limit : 20,
          });
          return formatPromotion(result);
        }

        if (action === 'forget') {
          const removed = store.forgetKnowledge(args?.doc_id);
          if (!removed.deleted) return `未删除：${removed.reason}`;
          return `已删除知识：${removed.doc_id}（${source.label}）`;
        }

        if (action === 'index') {
          const endpoint = externalOpEndpointFrom(config, 60000);
          const built = await buildRagIndex(store, endpoint);
          if (!built.ok) {
            return `RAG 索引未建立（${source.label}）：${built.error}\n`
              + '已索引的旧条目保持不变；确认外部嵌入服务可用后重试 aim_memory action=index。';
          }
          const mount = config.ragMount ? '已挂载，aim_search 将优先用 RAG' : '未挂载（可在面板打开「RAG 挂载」）';
          return `RAG 索引已更新（${source.label}）：${built.indexed} 篇知识文档，本次嵌入 ${built.embedded} 篇`
            + `，清理 ${built.removed} 条失效向量，维度 ${built.dim}（模型 ${built.model}）。\n${mount}。`;
        }

        if (action === 'status') {
          const others = readableConversations(context)
            .filter((row) => source.scope !== 'session' || row.key !== source.key)
            .map((row) => ({ ...row, counts: context.scopes.counts(row.key) }));
          const rag = ragStats(store.root);
          const ragLine = `RAG：${config.ragMount ? '已挂载到知识库检索' : '未挂载（面板可切换）'}｜`
            + (rag.built
              ? `索引 ${rag.docs} 篇，维度 ${rag.dim}，${rag.built_at}`
              : '索引未建立（aim_memory action=index）');
          const storage = store.knowledgeBackendInfo();
          const storageLine = '知识库底座：JSON（始终启用，供审查）'
            + (storage.sqlMirror
              ? `｜SQL 只读镜像：${storage.file}`
              : '｜SQL 只读镜像：未启用（查询仍按需从 JSON 建只读表）')
            + (storage.sqliteAvailable ? '' : '｜当前 Node 不支持 node:sqlite')
            + (storage.error ? `｜镜像已回退：${storage.error}` : '');
          return `${formatStatus(store.status(), {
            root: context.root,
            label: source.label,
            otherRows: others,
            closedCount: closedConversationCount(context),
            sharedCounts: source.scope === 'shared' ? null : context.scopes.sharedCounts(),
          })}\n${storageLine}\n${ragLine}`;
        }

        throw new Error(`未知 action：${String(action)}`);
      },
    },
    {
      name: 'aim_search',
      description:
        '检索当前项目的 AI for Memory 知识库，并自动选择通道：'
        + '指标/聚合/精确 doc_id 类问题走 SQL（Text-to-SQL，基于 JSON 底座的内存只读表）；'
        + '模糊、开放性的文档问题走向量检索（面板「RAG 挂载」开启且索引就绪时用嵌入 + 重排，否则本地 BM25）；'
        + '两者兼有的问题走混合（SQL 出统计 + 向量补相关文档）；'
        + 'SQL 翻译不了时回退向量，向量零命中时反向用 SQL 兜底。'
        + 'JSON 是基础底座，SQL 与 RAG 都是从 JSON 派生出来的视图。'
        + '默认跨对话检索：本对话、其他对话、共享层都会命中，结果逐条标注来源对话。'
        + '需要历史约定、先前决策、错误修复记录或界面事实时先检索，不要凭空猜测。',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '检索词或自然语言问题，中英文均可。',
        },
        scope: {
          type: 'string',
          enum: ['all', 'session', 'shared'],
          description:
            '检索范围，默认 all=本对话+其他对话+共享层（跨对话检索）；'
            + 'session=只查本对话；shared=只查共享层。',
        },
        category: {
          type: 'string',
          description: '可选：只检索某个知识分类，例如 errors_fixes。',
        },
        route: {
          type: 'string',
          enum: ['auto', 'sql', 'vector', 'hybrid'],
          description:
            '查询路由，默认 auto：按问题自动判断——指标/聚合/精确 doc_id → SQL（Text-to-SQL）；'
            + '模糊、开放性的文档问题 → 向量检索；两者兼有 → 混合（SQL 出统计 + 向量补文档）；'
            + 'SQL 翻译不了回退向量，向量零命中时用 SQL 兜底。也可强制 sql / vector / hybrid。',
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
        const scope = ['all', 'session', 'shared'].includes(args?.scope) ? args.scope : 'all';
        const context = memoryContext(config, exec, deps, runtime);
        const sources = memorySources(context, scope);
        const topK = Number.isInteger(args?.top_k) && args.top_k > 0 ? args.top_k : config.defaultTopK;

        // Route: metrics / aggregation / exact ids → SQL; fuzzy documents → vector;
        // both signals → hybrid (SQL facts + vector context). JSON stays the base
        // material; SQL and RAG are derived views of it.
        const requestedRoute = ['auto', 'sql', 'vector', 'hybrid'].includes(args?.route)
          ? args.route : 'auto';
        const routed = requestedRoute === 'auto'
          ? routeKnowledgeQuery(query)
          : { route: requestedRoute, intent: `forced-${requestedRoute}`, reason: `手动指定 ${requestedRoute}` };

        const collectDocs = () => sources.flatMap((source) => source.store.documents()
          .map((doc) => ({ ...doc, origin: source.label })));
        const sqlResult = routed.route === 'sql' || routed.route === 'hybrid'
          ? runSqlQuery(collectDocs(), query)
          : null;
        if (routed.route === 'sql' && sqlResult?.ok === true) {
          return formatSqlResult(query, sqlResult);
        }

        // Vector path: RAG when mounted, local BM25 otherwise. It doubles as the
        // fallback when SQL translation fails, and can itself be backed by SQL
        // when the vector side has no hits.
        const localRun = () => {
          const merged = [];
          for (const source of sources) {
            const hits = source.store.search(query, {
              category: args?.category ?? null,
              mode,
              topK,
            });
            for (const hit of hits) {
              merged.push({
                ...hit,
                origin_label: source.label,
                origin_key: source.key,
                origin_scope: source.scope,
              });
            }
          }
          // Scores come from per-store indexes, so compare them as-is and keep
          // the best `topK` overall; every conversation is its own namespace.
          merged.sort((left, right) => right.score - left.score);
          if (merged.length === 0) {
            return { empty: true, text: `没有命中「${query}」的知识文档（mode=${mode}，范围=${scope}）。` };
          }
          const hits = merged.slice(0, topK);
          return {
            empty: false,
            text: `检索范围：${sources.map((source) => source.label).join(' + ')}\n` + formatHits(query, hits, mode),
          };
        };

        let fallbackNote = '';
        if (routed.route === 'sql' && sqlResult) {
          fallbackNote = `SQL 通道未执行（${sqlResult.error ?? '无法翻译'}），已回退向量检索。\n`;
        }
        let picked;
        if (config.ragMount === true) {
          const rag = await searchWithRag(config, sources, query, {
            topK,
            category: args?.category ?? null,
          });
          if (rag.ok === true) {
            picked = { empty: rag.empty === true, text: rag.text };
          } else {
            fallbackNote += `${rag.note}\n`;
            picked = localRun();
          }
        } else {
          picked = localRun();
        }

        // Vector zero hits: SQL may still answer the metric/exact part.
        if (picked.empty && routed.route === 'vector') {
          const sqlFallback = runSqlQuery(collectDocs(), query);
          if (sqlFallback.ok === true && sqlFallback.rows.length > 0) {
            picked = {
              empty: false,
              text: `检索路由：向量没有命中，SQL 兜底。\n${formatSqlResult(query, sqlFallback)}`,
            };
          }
        }

        if (routed.route === 'hybrid') {
          const parts = [];
          if (sqlResult?.ok === true) parts.push(formatSqlResult(query, sqlResult));
          else if (sqlResult) parts.push(`SQL 部分未执行：${sqlResult.error ?? '无法翻译'}`);
          parts.push(`— 向量补充 —\n${picked.text}`);
          return parts.join('\n\n');
        }
        return fallbackNote + picked.text;
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
        scope: {
          type: 'string',
          enum: ['session', 'shared'],
          description: '写入范围，默认 session=本对话独立存储；shared=共享层。',
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
        const context = memoryContext(config, exec, deps, runtime);
        const source = writeSource(context, args?.scope === 'shared' ? 'shared' : 'session');
        source.store.recordDecision(result);
        return `${formatDecision(result)}\n范围：${source.label}`;
      },
    },
    {
      name: 'aim_context',
      description:
        '上下文管理：save=把当前已完成对话整理进存储；clear=按话题相似度清理会话上下文；'
        + 'restore=把保存的上下文重新注入当前会话；list=列出存档；status=查看清理策略与存档状态；'
        + 'sessions=列出所有对话及其记忆规模。'
        + '清理不再一刀切：以当轮与上轮的话题为基准，相似度低的老轮次会被清出上下文，相似度高的原样保留；'
        + '被清出的轮次会先完整存档，随时可以用 restore 调回。'
        + '存档默认按对话隔离（每个对话只列出自己的），restore 默认可以跨对话找到别的对话保存过的上下文。'
        + '自动整理开启时每 N 轮、或上下文占用达到设定百分比（默认 70%）时自动执行 save+clear；两个条件任一满足就触发，手动工具始终可用。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['save', 'clear', 'restore', 'list', 'status', 'sessions'],
          description:
            'save=保存当前对话上下文；clear=按话题相似度清理（低相似度清出、高相似度保留，清出的可 restore）；'
            + 'restore=恢复存档（可跨对话）；list=列存档；status=查看状态；sessions=列出所有对话。',
        },
        scope: {
          type: 'string',
          enum: ['session', 'all', 'shared'],
          description:
            'list/restore 的查找范围，默认 session=只查本对话（restore 例外：默认先本对话、再其他对话、再共享层）；'
            + 'all=所有对话；shared=只查共享层。',
        },
        name: {
          type: 'string',
          description: 'save 用：存档标签，默认 manual。',
        },
        context_id: {
          type: 'string',
          description: 'restore 用：上下文 id（也接受 id 前缀）。',
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: `AI for Memory · context ${String(args?.action ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
      async execute(args, exec) {
        const context = memoryContext(config, exec, deps, runtime);
        const action = args?.action;
        const session = exec?.agent?.session;
        const source = writeSource(context, 'session');
        const store = source.store;

        const snapshot = () => {
          if (!session || typeof session.ownEvents !== 'function') {
            throw new Error('当前调用没有可用的会话上下文');
          }
          const built = buildContextSnapshot(session.ownEvents(), { maxChars: config.maxContextChars });
          if (!built) throw new Error('还没有可保存的已完成对话');
          return built;
        };

        if (action === 'save') {
          const built = snapshot();
          const saved = store.saveContext({
            label: args?.name ?? 'manual',
            sessionId: String(session.id),
            ...built,
          });
          return `已保存上下文（${source.label}）：${saved.context_id}\n`
            + `标签：${saved.label}\n`
            + `第 ${saved.turn_from}-${saved.turn_to} 轮，${saved.turn_count} 轮，约 ${saved.chars} 字符\n`
            + `文件：${saved.file}`;
        }

        if (action === 'clear') {
          if (!session || typeof session.ownEvents !== 'function') {
            throw new Error('当前调用没有可用的会话上下文');
          }
          if (config.topicalClear !== false) {
            runtime.pending.set(String(session.id), 'manual');
            return '已登记清理请求：本轮结束后按话题相似度清理本对话上下文。\n'
              + `保留最近 ${config.keepRecentTurns} 轮（当轮与上轮始终保留）；相似度阈值 ${config.similarityThreshold}；`
              + `单次最多清出 ${config.maxClearTurns} 轮。\n`
              + '相似度高的轮次原样保留；被清出的轮次会先完整存档，之后可用 restore 调回。';
          }
          const built = snapshot();
          const saved = store.saveContext({
            label: args?.name ?? 'before-clear',
            sessionId: String(session.id),
            ...built,
          });
          const compaction = deps.getService?.('compaction');
          if (!compaction || typeof compaction.compactNow !== 'function') {
            return `已保存上下文 ${saved.context_id}（${source.label}），但当前 profile 未启用 compaction 服务，无法清理会话上下文。`
              + '请在 DSH 插件中启用 @deepseek-ai/dsh-compaction-basic。';
          }
          if (session && session.id) runtime.pending.set(String(session.id), saved.context_id);
          return `已保存上下文 ${saved.context_id}（${source.label}，第 ${saved.turn_from}-${saved.turn_to} 轮）。\n`
            + '将在本轮结束后压缩/清理会话上下文；需要时可执行 restore 调回。';
        }

        if (action === 'restore') {
          const id = String(args?.context_id ?? '').trim();
          if (id === '') throw new Error('restore 需要 context_id');
          const requested = args?.scope === undefined ? null : args.scope;
          const candidates = requested === 'shared'
            ? [memorySources(context, 'shared')[0]]
            : requested === 'session'
              ? [source]
              : [source, ...lookupSources(context).filter((item) => item !== source)];
          let found = null;
          for (const candidate of candidates) {
            const record = candidate.store.loadContext(id);
            if (record) {
              found = { record, source: candidate };
              break;
            }
          }
          if (!found) throw new Error(`未找到上下文：${id}`);
          if (!exec.agent || typeof exec.agent.inject !== 'function') {
            throw new Error('当前调用没有可注入的 agent');
          }
          await exec.agent.inject({
            content: [{ type: 'text', text: formatRestoreContext(found.record) }],
            source: { kind: 'ai-for-memory' },
          });
          return `已恢复上下文 ${found.record.context_id}（${found.source.label}，第 ${found.record.turn_from}-${found.record.turn_to} 轮），将在下一步生效。`;
        }

        if (action === 'list') {
          const requested = args?.scope === 'all' ? 'all' : args?.scope === 'shared' ? 'shared' : 'session';
          const rows = [];
          for (const candidate of memorySources(context, requested)) {
            for (const row of candidate.store.listContexts()) {
              rows.push({ ...row, origin_label: candidate.label });
            }
          }
          if (rows.length === 0) {
            return requested === 'session'
              ? '本对话暂无上下文存档（可用 scope=all 查看其他对话）。'
              : '暂无上下文存档。';
          }
          rows.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
          return [`共 ${rows.length} 个上下文存档${requested === 'all' ? '（所有对话）' : ''}：`, ...rows.map((row) => (
            `- ${row.context_id}｜${row.label}｜${row.origin_label}｜第 ${row.turn_from}-${row.turn_to} 轮｜${row.turn_count} 轮｜${row.chars} 字符｜${row.created_at}`
          ))].join('\n');
        }

        if (action === 'status') {
          const compaction = deps.getService?.('compaction');
          const rows = readableConversations(context)
            .map((row) => ({ ...row, counts: context.scopes.counts(row.key) }));
          const shared = context.scopes.sharedCounts();
          const totalContexts = rows.reduce((sum, row) => sum + row.counts.contexts, 0) + shared.contexts;
          const closed = closedConversationCount(context);
          return [
            `清理策略：${config.topicalClear === false
              ? `整段压缩（compaction 服务${compaction && typeof compaction.compactNow === 'function' ? '可用' : '不可用'}）`
              : '话题相似度（低相似度清出，高相似度保留）'}`,
            `相似度设置：阈值 ${config.similarityThreshold}，保留最近 ${config.keepRecentTurns} 轮，`
              + `单次最多 ${config.maxClearTurns} 轮（${config.minClearChars}~${config.maxClearChars} 字符）`,
            `自动整理：${config.autoEnabled ? `开启（每 ${config.autoEveryRounds} 轮，或上下文占用到 ${config.contextUsagePercent}%）` : '关闭'}`,
            (() => {
              const meter = deps.getService?.('tokenMeter');
              let pressure = null;
              if (meter && typeof meter.contextPressure === 'function' && session) {
                try {
                  pressure = meter.contextPressure(session) ?? null;
                } catch {
                  pressure = null;
                }
              }
              return `上下文占用：${formatPressure(pressure)}（阈值 ${config.contextUsagePercent}%）`;
            })(),
            '手动工具：始终可用',
            `当前对话：${source.label}${context.sessionId ? `（${shortSessionId(context.sessionId)}）` : ''}`,
            `上下文存档：${store.listContexts().length} 个（本对话），可见对话共 ${totalContexts} 个`,
            `对话数量：${rows.length} 个${closed > 0 ? `（另有 ${closed} 个未对外开放）` : ''}`,
            `待清理：${session && session.id && runtime.pending.has(String(session.id)) ? '是' : '否'}`,
            (() => {
              const last = store.readCompactionStatus();
              if (!last) return '最近清理：无记录';
              const detail = Number.isInteger(last.turns)
                ? `，清出 ${last.turns} 轮 / ${last.cleared ?? 0} 条 / ${last.chars ?? 0} 字符，保留 ${last.kept ?? '?'} 轮`
                : `${Number.isInteger(last.compacted) ? `，${last.compacted} 条 / ${last.tokens ?? 0} tokens` : ''}`
                  + `${last.noop ? '，无可压缩历史' : ''}`;
              return `最近清理：${last.state}${last.reason ? `（${last.reason}）` : ''}${detail}`
                + `${last.error ? `（${last.error}）` : ''}${last.at ? ` @ ${last.at}` : ''}`;
            })(),
          ].join('\n');
        }

        if (action === 'sessions') {
          const rows = readableConversations(context)
            .map((row) => ({ ...row, counts: context.scopes.counts(row.key) }));
          if (rows.length === 0) return '还没有任何对话的记忆。';
          const lines = [`共 ${rows.length} 个对话（按最近活动排序）：`];
          for (const row of rows) {
            const counts = row.counts;
            lines.push(`- ${conversationLabel(row, source.scope === 'session' ? source.key : '')}｜${row.key}`
              + `｜过程记录 ${counts.staging}，归档 ${counts.archive}，快照 ${counts.snapshots}，知识库 ${counts.knowledge}，决策 ${counts.decisions}，上下文 ${counts.contexts}`
              + `｜最近 ${row.updatedAt || '未知'}${row.public === false ? '｜未对外开放' : ''}`);
          }
          const shared = context.scopes.sharedCounts();
          lines.push(`共享层：过程记录 ${shared.staging}，归档 ${shared.archive}，知识库 ${shared.knowledge}，上下文 ${shared.contexts}`);
          const closed = closedConversationCount(context);
          if (closed > 0) lines.push(`另有 ${closed} 个对话未对外开放（本对话读不到）`);
          return lines.join('\n');
        }

        throw new Error(`未知 action：${String(action)}`);
      },
    },
    {
      name: 'aim_ask',
      description:
        '调用外部模型（任何 OpenAI 兼容 HTTP API：llama.cpp / Ollama / LM Studio / vLLM / 云端网关均可）：'
        + 'chat=一次性补全；embed=取文本向量；rerank=按 query 给候选文档打分排序；'
        + 'models=列出模型；probe=检查连通性（deep=true 时顺带探测 embed/rerank 能力）。'
        + '这里的模型主要用作 Embedding 和 Rerank：三层记忆的「外部模型」模式靠 embed + rerank 工作，不依赖 chat。'
        + '只连插件配置的地址（默认 http://127.0.0.1:8080；填 .../v1 或完整接口地址也认），不写任何记忆。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['chat', 'embed', 'rerank', 'models', 'probe'],
          description:
            'chat=对话补全（prompt 或 messages）；embed=取向量（text 或 texts）；'
            + 'rerank=按 query 给 documents 打分（需服务支持 rerank）；'
            + 'models=列出服务端模型；probe=连通性检查。',
        },
        prompt: { type: 'string', description: 'chat 用：单条用户输入。' },
        system: { type: 'string', description: 'chat 用：系统提示。' },
        messages: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'chat 用：[{role, content}]，适合多轮或自定义角色；与 prompt 二选一。',
        },
        temperature: { type: 'number', description: 'chat 用：0~2，默认交给模型。' },
        max_tokens: { type: 'integer', description: 'chat 用：最多生成多少 token。' },
        json: { type: 'boolean', description: 'chat 用：true 时请求 JSON 对象输出。' },
        text: { type: 'string', description: 'embed 用：单条文本。' },
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: 'embed 用：多条文本，返回同样数量的向量。',
        },
        query: { type: 'string', description: 'rerank 用：查询语句。' },
        documents: {
          type: 'array',
          items: { type: 'string' },
          description: 'rerank 用：候选文档（最多 64 条）。',
        },
        top_n: { type: 'integer', description: 'rerank 用：只返回前 N 条。' },
        deep: { type: 'boolean', description: 'probe 用：true 时额外探测 embed / rerank 能力。' },
      },
      async execute(args) {
        const endpoint = externalEndpointOf(config);
        const action = typeof args?.action === 'string' ? args.action : 'chat';

        if (action === 'probe') {
          const result = await externalProbe(endpoint, undefined, { deep: args?.deep === true });
          const lines = [
            result.ok ? `外部模型可用：${result.detail}` : `外部模型不可用：${result.error}`,
            describeEndpoint(endpoint),
          ];
          if (result.capabilities) {
            const cap = (name) => (result.capabilities[name].ok
              ? '可用'
              : `不可用（${result.capabilities[name].error}）`);
            lines.push(`embeddings：${cap('embeddings')}`, `rerank：${cap('rerank')}`);
          }
          return lines.join('\n');
        }

        if (action === 'models') {
          const result = await externalListModels(endpoint);
          if (!result.ok) return `列出模型失败：${result.error}`;
          if (result.models.length === 0) return `接口在线，但没有列出模型。\n${describeEndpoint(endpoint)}`;
          return `可用模型（${result.models.length}）：\n- ${result.models.join('\n- ')}\n${describeEndpoint(endpoint)}`;
        }

        if (action === 'embed') {
          const input = Array.isArray(args?.texts) && args.texts.length > 0 ? args.texts : args?.text;
          const result = await externalEmbed(endpoint, input);
          if (!result.ok) return `取向量失败：${result.error}`;
          const dimension = result.vectors[0]?.length ?? 0;
          const head = (result.vectors[0] ?? []).slice(0, 6).map((value) => Number(value.toFixed(4)));
          return [
            `已取到 ${result.vectors.length} 个向量，维度 ${dimension}。`,
            head.length > 0 ? `首个向量前 6 维：${head.join(', ')}…` : '',
            `这批向量可以逐条存进 knowledge 的索引里，供之后的 RAG 检索。`,
            describeEndpoint(endpoint),
          ].filter(Boolean).join('\n');
        }

        if (action === 'rerank') {
          const documents = Array.isArray(args?.documents) ? args.documents.slice(0, 64) : [];
          const result = await externalRerank(endpoint, {
            query: args?.query,
            documents,
            topN: Number.isInteger(args?.top_n) ? args.top_n : documents.length,
          });
          if (!result.ok) return `rerank 失败：${result.error}`;
          const rows = result.results.map((row, index) => (
            `${index + 1}. 分数 ${row.score.toFixed(4)}｜文档 #${row.index}：`
            + clip(String(documents[row.index] ?? ''), 120)
          ));
          return [`rerank 排序（query：${clip(String(args?.query ?? ''), 80)}）：`, ...rows, describeEndpoint(endpoint)].join('\n');
        }

        if (action !== 'chat') throw new Error(`未知 action：${String(action)}`);
        const result = await externalChat(endpoint, {
          messages: args?.messages,
          prompt: args?.prompt,
          system: args?.system,
          temperature: args?.temperature,
          maxTokens: args?.max_tokens,
          json: args?.json === true,
        });
        if (!result.ok) return `调用外部模型失败：${result.error}`;
        const usage = result.usage && typeof result.usage === 'object'
          ? `｜tokens ${result.usage.total_tokens ?? '?'}`
          : '';
        return `${clip(result.text, 4000)}\n\n— ${describeEndpoint(endpoint)}${usage}`
          + `${result.finishReason ? `｜结束：${result.finishReason}` : ''}`;
      },
    },
  ];
}

// ---- plugin entry --------------------------------------------------------

/**
 * Context management: archive and clear the conversation window with the
 * configured policy. Auto mode also does this every N turns; manual mode only
 * reacts to explicit `aim_context` tool calls. The listener is always installed
 * so a manual `clear` can finish after the current turn closes.
 *
 * The default policy is topic-aware: the turns that still share the current
 * topic stay verbatim, and only the ones the conversation has moved away from
 * are replaced — after their full text has been archived, so `restore` can
 * always bring them back. Clearing must run while the agent is idle, so it is
 * deferred to `turn/end` and awaited through `agent.whenIdle()`. Subagents are
 * skipped.
 */
export function installContextManagement(ctx, config, deps, runtime) {
  const counters = runtime?.counters ?? new Map();
  const pending = runtime?.pending ?? new Map();
  const getService = deps.getService ?? (() => undefined);

  /**
   * Latest measured context pressure for one session, or `null` when DSH has not
   * logged a provider prompt size yet (nothing to compare with the threshold).
   * The `tokenMeter` service owns this projection; the plugin only reads it.
   */
  const contextPressureOf = (session) => {
    const meter = getService('tokenMeter');
    if (!meter || typeof meter.contextPressure !== 'function') return null;
    try {
      return meter.contextPressure(session) ?? null;
    } catch {
      return null;
    }
  };

  /** Latest DSH-generated title for one live session, or `''`. */
  const titleOfSession = (session) => {
    try {
      const titles = getService('sessionTitle');
      const snapshot = titles && typeof titles.get === 'function' ? titles.get(session) : undefined;
      return snapshot && typeof snapshot.title === 'string' ? snapshot.title : '';
    } catch {
      return '';
    }
  };

  /**
   * Make sure one conversation has its own memory directory, and keep its name
   * and the DSH-generated title in sync.
   *
   * Called for every new conversation (layers pre-created) and again after each
   * turn (cheap fallback that also picks up a generated title).
   *
   * @returns {string|null} the conversation key.
   */
  const rememberConversation = (session, options = {}) => {
    try {
      const context = memoryContext(config, { agent: { session } }, deps, runtime);
      const key = sessionKey(String(session.id));
      if (key === null) return null;
      const existing = context.scopes.readMeta(key);
      const patch = { ...context.meta };
      // Access is a per-conversation user setting: only seed it on creation.
      if (existing === null) patch.public = config.defaultPublic !== false;
      context.scopes.ensureSession(String(session.id), patch);
      if (options.initLayers === true) context.scopes.sessionStore(key).init();
      const title = titleOfSession(session);
      if (title !== '') context.scopes.setTitle(key, title);
      return key;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[ai-for-memory] 创建对话记忆目录失败：${error?.message ?? error}`);
      return null;
    }
  };

  /** Memory store of one session, or `undefined` when it cannot be resolved. */
  const storeOfSession = (session) => {
    try {
      const context = memoryContext(config, { agent: { session } }, deps, runtime);
      return writeSource(context, 'session').store;
    } catch {
      return undefined;
    }
  };

  /** Diagnostics sink for the last clear/compaction attempt. */
  const recorderOf = (store) => (data) => {
    try {
      store?.writeCompactionStatus(data);
    } catch {
      // Status is diagnostics only; never fail clearing because of it.
    }
  };

  /** Heuristic token price of one shadowed surface node. */
  const priceOfNode = (session, seq) => {
    try {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
      if (!event) return 0;
      const message = typeof session.deriveEventMessage === 'function'
        ? session.deriveEventMessage(event) : null;
      if (!message) return 0;
      const meter = getService('tokenMeter');
      if (meter && typeof meter.estimateMessage === 'function') {
        return Number(meter.estimateMessage(message)) || 0;
      }
      return Math.ceil(JSON.stringify(message.content ?? '').length / 4);
    } catch {
      return 0;
    }
  };

  /**
   * Surface range of one turn, or `null` when clearing it is not safe.
   *
   * A turn is addressable only while every one of its events is still on the
   * surface as one contiguous run: a turn already split by an earlier
   * compaction or clear cannot be replaced as a unit. Node 0 holds the system
   * prompt and is never part of a clear.
   */
  const turnRange = (session, turn) => {
    const nodes = session && session.surface && Array.isArray(session.surface.nodes)
      ? session.surface.nodes : null;
    const seqs = Array.isArray(turn?.seqs) ? turn.seqs : [];
    if (!nodes || nodes.length === 0 || seqs.length === 0) return null;
    const position = new Map();
    nodes.forEach((seq, index) => position.set(seq, index));
    const indexes = [];
    for (const seq of seqs) {
      const index = position.get(seq);
      if (index === undefined) return null;
      indexes.push(index);
    }
    for (let index = 1; index < indexes.length; index += 1) {
      if (indexes[index] !== indexes[index - 1] + 1) return null;
    }
    // Node 0 holds the system prompt and may never be shadowed by a clear.
    if (indexes[0] === 0) {
      const head = typeof session.eventAt === 'function' ? session.eventAt(nodes[0]) : undefined;
      if (!head || head.type === 'system/message') return null;
    }
    return {
      seqs: [...seqs],
      startSeq: seqs[0],
      endSeq: seqs[seqs.length - 1],
      startIdx: indexes[0],
      endIdx: indexes[indexes.length - 1],
    };
  };

  /**
   * Group cleared turns into the contiguous surface runs one replacement can
   * cover. Adjacent cleared turns share a run; a kept turn in between always
   * splits it, so retained context is never swallowed.
   */
  const groupRuns = (session, cleared) => {
    const runs = [];
    for (const turn of cleared) {
      const range = turnRange(session, turn);
      if (!range) continue;
      const last = runs[runs.length - 1];
      if (last && last.endIdx + 1 === range.startIdx) {
        last.turns.push(turn);
        last.seqs.push(...range.seqs);
        last.endSeq = range.endSeq;
        last.endIdx = range.endIdx;
        last.chars += turn.chars ?? 0;
        last.similarity = Math.max(last.similarity, turn.similarity ?? 0);
      } else {
        runs.push({
          turns: [turn],
          seqs: [...range.seqs],
          startSeq: range.startSeq,
          endSeq: range.endSeq,
          startIdx: range.startIdx,
          endIdx: range.endIdx,
          chars: turn.chars ?? 0,
          similarity: turn.similarity ?? 0,
        });
      }
    }
    return runs;
  };

  /**
   * Replace one surface run with a short model-facing note.
   *
   * The note says what left the window and how to bring it back, so the model
   * keeps a pointer to the archive instead of silently losing the subject. The
   * archive is written before this function is ever called.
   */
  const clearRun = (session, run, contextId, modelNote = '') => {
    let shadowedTokens = 0;
    for (const seq of run.seqs) shadowedTokens += priceOfNode(session, seq);
    // Shadow-price protocol: the metering event and its replacement are
    // appended adjacently so a pure consumer can subtract the shadowed price.
    // Pricing is diagnostics; a log that refuses it must not block the clear.
    try {
      session.append('compaction/prune', {
        shadowedRange: { start: run.startSeq, end: run.endSeq },
        shadowedSeqs: run.seqs,
        shadowedTokenCount: shadowedTokens,
      });
    } catch {
      // keep clearing
    }
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: `【上下文清理】${describeTurns(run.turns, run.similarity)}已清出当前上下文，`
          + (modelNote !== '' ? `${modelNote}\n` : '')
          + `原文完整保存在本对话的记忆存档 ${contextId}。`
          + `需要时调用 aim_context restore（context_id=${contextId}）即可调回。`,
      }],
      source: { kind: 'ai-for-memory' },
    }, {
      surfaceOp: { op: 'replace', startSeq: run.startSeq, endSeq: run.endSeq },
      sourceEventSeqs: run.seqs,
    });
  };

  /**
   * Similarity-aware clear: keep the turns that still share the current topic,
   * remove the ones the conversation has moved away from, and archive exactly
   * what is removed before touching the transcript.
   */
  const runTopicalClear = (session, options = {}) => {
    const label = String(options.label ?? 'before-clear');
    const store = storeOfSession(session);
    const record = recorderOf(store);
    if (!session || typeof session.ownEvents !== 'function') {
      record({ state: 'unavailable', reason: 'no-session' });
      return;
    }
    if (typeof session.append !== 'function' || !session.surface) {
      record({ state: 'unavailable', reason: 'session 不支持清理窗口' });
      return;
    }
    const agents = getService('agents');
    const agent = agents && typeof agents.get === 'function' ? agents.get(session.id) : undefined;

    /** Everything the clear does, once the agent is safely idle. */
    const clearNow = async () => {
      const events = session.ownEvents();
      const turns = collectTurns(events);
      if (turns.length === 0) {
        record({ state: 'skipped', reason: 'empty' });
        return;
      }
      const selection = selectTurnsByTopic(turns, {
        threshold: config.similarityThreshold,
        keepRecent: config.keepRecentTurns,
        anchorTurns: 2,
      });
      if (selection.clear.length === 0) {
        record({
          state: 'skipped',
          reason: '全部轮次都与当前话题相关',
          kept: selection.keep.length,
          cleared: 0,
          threshold: selection.threshold,
        });
        return;
      }
      const runs = groupRuns(session, selection.clear);
      if (runs.length === 0) {
        record({ state: 'skipped', reason: '没有可安全清理的连续轮次', kept: selection.keep.length, cleared: 0 });
        return;
      }

      // Budget is applied oldest first: the turns furthest from the current
      // topic go first, and every chosen turn must fit in the archive.
      const chosen = [];
      let chars = 0;
      let turnCount = 0;
      for (const run of runs) {
        if (turnCount + run.turns.length > config.maxClearTurns) break;
        if (chars + run.chars > config.maxClearChars) break;
        chosen.push(run);
        chars += run.chars;
        turnCount += run.turns.length;
      }
      if (chosen.length === 0) {
        record({ state: 'skipped', reason: '超出单次清理预算' });
        return;
      }
      if (chars < config.minClearChars) {
        record({ state: 'skipped', reason: '可清理内容太少', chars, cleared: 0 });
        return;
      }

      const clearedTurns = chosen.flatMap((run) => run.turns);
      const snapshot = snapshotOfTurns(clearedTurns, { maxChars: Infinity });
      // External mode: let the local model describe what is leaving, so the
      // replacement note carries a summary instead of only counts. A failed
      // summary must never block the clear — it just adds nothing.
      let modelNote = '';
      if (config.contextExternal === true) {
        const summarized = await summarizeTurnsExternally(
          externalOpEndpointFrom(config, 20000),
          clearedTurns,
        );
        if (summarized.ok) {
          modelNote = `摘要（嵌入抽取）：${summarized.summary}`
            + (summarized.topics.length > 0 ? `｜主题：${summarized.topics.join('、')}` : '');
        }
      }
      // Archive first: nothing leaves the window before it is restorable.
      const saved = store.saveContext({
        label,
        sessionId: String(session.id),
        ...snapshot,
        ...(modelNote === '' ? {} : { model_summary: modelNote }),
      });

      let shadowed = 0;
      for (const run of chosen) {
        clearRun(session, run, saved.context_id, modelNote);
        shadowed += run.seqs.length;
      }
      record({
        state: 'done',
        session: String(session.id),
        cleared: shadowed,
        turns: turnCount,
        chars,
        kept: selection.keep.length,
        context: saved.context_id,
        threshold: selection.threshold,
      });
      // eslint-disable-next-line no-console
      console.log(`[ai-for-memory] 已按话题相似度清出 ${turnCount} 轮（保留 ${selection.keep.length} 轮），存档 ${saved.context_id}`);
    };

    void (async () => {
      try {
        record({ state: 'started', session: String(session.id) });
        // `turn/end` still fires while the agent is settling, so the surface may
        // only be rewritten once it is idle. Prefer the agent's maintenance
        // entry point: it additionally withholds later waking input while the
        // replacement lands. It throws when the agent is active, which is why
        // idle is awaited first and the entry retried once.
        if (agent && typeof agent.whenIdle === 'function') await agent.whenIdle();
        const maintenance = agent && typeof agent.runMaintenance === 'function'
          ? agent.runMaintenance.bind(agent)
          : null;
        if (!maintenance) {
          await clearNow();
          return;
        }
        try {
          await maintenance(() => clearNow());
        } catch (busyError) {
          if (typeof agent.whenIdle !== 'function') throw busyError;
          await agent.whenIdle();
          await maintenance(() => clearNow());
        }
      } catch (error) {
        record({ state: 'error', session: String(session.id), error: String(error?.message ?? error) });
        // eslint-disable-next-line no-console
        console.error(`[ai-for-memory] 上下文清理失败：${error?.message ?? error}`);
      }
    })();
  };

  /** Legacy whole-window compaction, kept behind `topicalClear: false`. */
  const runCompaction = (session) => {
    const agents = getService('agents');
    const agent = agents && typeof agents.get === 'function' ? agents.get(session.id) : undefined;
    const compaction = getService('compaction');
    const record = recorderOf(storeOfSession(session));
    if (!agent || !compaction || typeof compaction.compactNow !== 'function') {
      record({ state: 'unavailable', error: 'compaction 服务不可用' });
      // eslint-disable-next-line no-console
      console.warn('[ai-for-memory] 上下文已归档，但当前 profile 未启用 compaction，无法清理会话上下文');
      return;
    }
    void (async () => {
      try {
        record({ state: 'started', session: String(session.id) });
        if (typeof agent.whenIdle === 'function') await agent.whenIdle();
        const result = await compaction.compactNow(agent, new AbortController().signal);
        record({
          state: 'done',
          session: String(session.id),
          compacted: result ? (result.shadowedSeqs?.length ?? 0) : 0,
          tokens: result ? (result.shadowedTokenCount ?? 0) : 0,
          noop: result === null,
        });
        if (result) {
          // eslint-disable-next-line no-console
          console.log(`[ai-for-memory] 上下文已压缩：${result.shadowedSeqs?.length ?? 0} 条历史，约 ${result.shadowedTokenCount ?? 0} tokens`);
        }
      } catch (error) {
        record({ state: 'error', session: String(session.id), error: String(error?.message ?? error) });
        // eslint-disable-next-line no-console
        console.error(`[ai-for-memory] 上下文压缩失败：${error?.message ?? error}`);
      }
    })();
  };

  /** Run the configured clear policy for one conversation. */
  const runClear = (session, kind = 'auto', meta = {}) => {
    if (config.topicalClear === false) {
      runCompaction(session);
      return;
    }
    const label = kind === 'manual'
      ? 'before-clear'
      : meta.reason === 'usage'
        ? `auto-usage-${meta.percent ?? config.contextUsagePercent}pct`
        : `auto-${config.autoEveryRounds}rounds`;
    runTopicalClear(session, { label });
  };

  const onSessionEvent = (session, event) => {
    if (!session || !event || event.type !== 'turn/end') return;
    const id = String(session.id);
    const isSubagent = Boolean(session.header?.parentSession);

    // Conversations are the unit of independence, so activity is recorded for
    // every one of them; the panel uses it to default to "the conversation in use".
    if (!isSubagent) {
      markActivity(runtime, id);
      // Fallback for conversations that predate this plugin load: ensure the
      // directory exists and refresh the generated title.
      rememberConversation(session);
    }

    // Automatic archiving never runs for subagents; a manual `clear` still
    // honors its pending request below.
    if (!isSubagent && config.autoEnabled) {
      // Two independent triggers share one tidy pass: every N rounds, and the
      // measured context usage reaching the configured share of the window.
      // Both firing at once still tidies once.
      const count = (counters.get(id) ?? 0) + 1;
      const pressure = contextPressureOf(session);
      const byRounds = count >= config.autoEveryRounds;
      const byUsage = exceedsUsageThreshold(pressure, config.contextUsagePercent);
      if (!byRounds && !byUsage) {
        counters.set(id, count);
      } else {
        counters.delete(id);
        const trigger = byUsage ? 'usage' : 'rounds';
        const percent = usagePercentOf(pressure);
        // eslint-disable-next-line no-console
        console.log(`[ai-for-memory] 自动整理触发：${byUsage
          ? `上下文占用 ${formatPressure(pressure)} ≥ ${config.contextUsagePercent}%`
          : `每 ${config.autoEveryRounds} 轮（当前占用 ${formatPressure(pressure)}）`}`);
        try {
          const events = session.ownEvents();
          const context = memoryContext(config, { agent: { session } }, deps, runtime);
          const store = writeSource(context, 'session').store;
          const digest = collectTurnDigest(events, config.autoEveryRounds);
          if (digest) {
            store.stage({ content: digest, kind: 'digest', source: 'auto' });
            store.archive();
          }
          if (config.autoKnowledge !== false) {
            // Mine the three layers for knowledge while tidying: rules the user
            // stated, error→fix pairs, decisions with their reason.
            let promoted;
            try {
              promoted = store.promoteKnowledge({ limit: config.autoKnowledgeLimit });
            } catch (error) {
              // eslint-disable-next-line no-console
              console.warn(`[ai-for-memory] 自动提炼知识失败：${error?.message ?? error}`);
              promoted = null;
            }
            if (promoted && promoted.added.length > 0) {
              // eslint-disable-next-line no-console
              console.log(`[ai-for-memory] 自动提炼知识：新增 ${promoted.added.length} 篇，合并 ${promoted.merged.length} 篇`);
            }
          }
          if (config.topicalClear === false) {
            // Legacy mode still snapshots the recent window before compacting.
            const snapshot = buildContextSnapshot(events, { maxChars: config.maxContextChars });
            if (snapshot) {
              const saved = store.saveContext({
                label: `auto-${config.autoEveryRounds}rounds`,
                sessionId: id,
                ...snapshot,
              });
              pending.set(id, saved.context_id);
              // eslint-disable-next-line no-console
              console.log(`[ai-for-memory] 自动整理：已归档上下文 ${saved.context_id}（第 ${saved.turn_from}-${saved.turn_to} 轮）`);
            }
          } else {
            // Similarity mode archives exactly what it clears, inside runClear.
            // The object carries why the tidy fired, so the saved context label
            // says `auto-usage-70pct` instead of pretending it was the round count.
            pending.set(id, { kind: 'auto', reason: trigger, percent });
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`[ai-for-memory] 自动归档上下文失败：${error?.message ?? error}`);
        }
      }
    }

    if (pending.has(id)) {
      const request = pending.get(id);
      pending.delete(id);
      const meta = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
      runClear(session, request === 'manual' ? 'manual' : 'auto', meta);
    }
  };

  ctx.effect(() => ctx.on('session/event', onSessionEvent));
  ctx.effect(() => ctx.on('session/disposed', (session) => {
    const id = String(session?.id);
    counters.delete(id);
    pending.delete(id);
  }));
  ctx.effect(() => ctx.on('session/created', (session) => {
    if (!session || Boolean(session.header?.parentSession)) return;
    rememberConversation(session, { initLayers: true });
  }));
}

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
  const getService = (serviceName) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(serviceName) : undefined;
    } catch {
      return undefined;
    }
  };
  const deps = { workingDirectory, registryDir, getService };
  const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };

  try {
    installContextManagement(ctx, resolved, deps, runtime);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[ai-for-memory] 上下文管理注册失败：${error?.message ?? error}`);
  }

  for (const raw of createTools(resolved, deps, runtime)) {
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
      runtime,
      getService,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[ai-for-memory] 面板 API 注册失败：${error?.message ?? error}`);
  }
}
