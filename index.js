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

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { MemoryScopes, sessionKey, shortSessionId } from './lib/scopes.js';
import { findDuplicate, withTokens } from './lib/knowledge.js';
import { ensureDefaultMemoryDirIgnored } from './lib/gitignore.js';
import { markActivity } from './lib/activity.js';
import { evaluateDecision } from './lib/decision.js';
import { CATEGORIES, KINDS, RISKS, VERIFIES, clip } from './lib/util.js';
import { defaultRegistryDir, listRootRows, rememberRoot } from './lib/registry.js';
import { installApi } from './lib/api.js';
import { createEndpointGate } from './lib/engine-gate.js';
import { listLocalModelsCached } from './lib/model-catalog.js';
import {
  localEngineStatus, restoreLocalEngines, startLocalEngine, stopLocalEngine,
} from './lib/local-engine.js';
import { ensureMcpToken } from './lib/mcp-token.js';
import { summarizeTurnActivity } from './lib/turn-activity.js';
import { packageVersion } from './lib/version.js';
import { collectTurnDigest } from './lib/auto.js';
import {
  buildContextSnapshot, collectTurns, formatRestoreContext, snapshotOfTurns,
} from './lib/context.js';
import { SIMILARITY_DEFAULT, describeTurns, selectTurnsByTopic } from './lib/similarity.js';
import { AUTO_SNAPSHOT_PREFIX, isAutoSnapshot, planSnapshotPrune } from './lib/snapshot.js';
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
  buildRagIndex, embeddingIdentity, RAG_DEFAULTS, ragCandidates, ragModelStatus, ragStats, rerankCandidates,
  sameEmbeddingSpace,
} from './lib/rag.js';
import { writeExportArtifacts } from './lib/export.js';
import { effectivePluginConfig } from './lib/model-routing.js';
import { RRF_K, applyDisclosure, reciprocalRankFusion } from './lib/retrieval.js';
import { USAGE_BOOST, boostScore, weightLabel } from './lib/usage.js';
import {
  formatSqlResult, routeKnowledgeQuery, runSqlQuery,
} from './lib/knowledge-query.js';
import { dshSessionsDir } from './lib/dsh-workspace.js';
import {
  formatRepairReport,
  formatScanReport,
  repairSessionLog,
  resolveSessionLogTarget,
  scanSessionLogs,
} from './lib/session-repair.js';

export const name = 'dsh-ai-for-memory';

/** Only the tool registry is required; workspace comes from each call. */
export const inject = ['tools'];

const DEFAULTS = Object.freeze({
  directoryName: '.ai-for-memory',
  root: '',
  autoEnabled: false,
  autoEveryRounds: 5,
  // Automatic exact snapshots: every N completed turns a recent context window
  // is written to snapshots/. They are cheap, restore any state, and are pruned
  // by similarity once the cap is exceeded (near-duplicates go first).
  autoSnapshot: true,
  autoSnapshotEvery: 5,
  autoSnapshotMax: 10,
  // Percentage of the routed context window that also triggers a clear, on top
  // of the every-N-rounds trigger. Measured from the provider's last prompt size.
  contextUsagePercent: 70,
  // RAG over the knowledge layer: the index is built on demand (action=index)
  // and only used by aim_search while this mount switch is on. Off by default:
  // the local BM25 path never needs an external service.
  ragMount: false,
  maxContextChars: 30000,
  // Restoring an archive injects text into the live window. Restoring the
  // whole archive can immediately refill what clearing just removed, so the
  // restore path gets its own smaller budget (the newest turns win).
  restoreMaxChars: 12000,
  defaultTopK: 5,
  // Knowledge storage backend: 'json' (one file per document, default) or
  // 'sqlite' (a single queryable knowledge.sqlite, mirrored back to JSON).
  knowledgeBackend: 'json',
  reviewHighRiskOnly: true,
  maxContentChars: 20000,
  maxSnapshotBytes: 262144,
  // New conversations are private by default. Cross-conversation search,
  // restore and the merged view can read full archived conversations, so
  // opening a conversation must be an explicit, per-conversation decision.
  defaultPublic: false,
  // External model endpoint: any OpenAI-compatible HTTP API (llama.cpp,
  // Ollama, LM Studio, vLLM, a hosted gateway). This is the transport the
  // future RAG index will use; nothing calls it unless asked.
  // Empty = not configured. The panel shows a localhost example as a
  // placeholder, but no request is made until the user fills it in; otherwise
  // opening/probing the panel would wait on a dead 8080 service.
  externalBaseUrl: '',
  externalModel: '',
  externalApiKey: '',
  externalTimeoutMs: 60000,
  // The three layers below run on embedding + rerank models, so those endpoints
  // can live on their own process/port/provider. Empty = same as above.
  externalEmbedBaseUrl: '',
  externalEmbedModel: '',
  externalEmbedApiKey: '',
  externalRerankBaseUrl: '',
  externalRerankModel: '',
  externalRerankApiKey: '',
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
  // Steps of the running turn that survive a hard reset verbatim. A real DSH
  // task is one user request executed over many tool steps, so the running turn
  // holds the whole working set. Keeping it whole would keep the whole window
  // and a mid-task reset could never fire; keeping too few would clear the task
  // that is still running.
  keepRecentSteps: 3,
  maxClearTurns: 8,
  minClearChars: 200,
  maxClearChars: 120000,
  // Text knowledge is mined from the three layers during automatic tidying so
  // the knowledge base grows without an extra prompt from the user.
  autoKnowledge: true,
  autoKnowledgeLimit: 10,
  // Every completed turn that called a tool becomes one decision record: tool
  // names, failures and the local files touched. The decision layer then also
  // answers "what was executed", not only "which risky choices were reviewed".
  autoDecisionLog: true,
  // Local llama.cpp engine lifecycle:
  //   'manual' — start/stop only from the panel or API (nothing automatic);
  //   'always' — keep runnable local models running (load + before each turn);
  //   'turn'   — start them at the first model request of a turn and stop the
  //              engines this mode started when that turn ends.
  engineLifecycle: 'manual',
  // Retention. Staging only loses a file after every record in it is archived;
  // context/decision retention is opt-in because those layers are restorable
  // or auditable data, not mirrors of archive/.
  stagingRetentionDays: 30,
  contextRetentionDays: 0,
  decisionRetentionDays: 0,
  // When a harness checkpoint (time/schema/reload notice) arrives without a
  // new user request in this same step, append a short anchor so the model does
  // not answer an older topic. A real incoming request always wins. Off only
  // for token-strict setups.
  requestAnchor: true,
  // MCP egress over the DSH Web server's loopback listener. It exposes a small
  // read/write memory surface to other MCP clients. Authentication is optional
  // and OFF by default: acceptable only because DSH binds 127.0.0.1. Set a token
  // before exposing the listener through any local reverse proxy.
  mcpEnabled: true,
  mcpToken: '',
});

/**
 * Related-memory lines injected into a mid-task reset brief, and their budget.
 */
const RESET_RELATED_LIMIT = 3;
const RESET_RELATED_CHARS = 1200;

/** Integer bounds for the numeric settings; `null` marks a float setting. */
const NUMERIC_BOUNDS = Object.freeze({
  autoEveryRounds: [1, 100],
  autoSnapshotEvery: [1, 100],
  autoSnapshotMax: [1, 200],
  contextUsagePercent: [1, 100],
  maxContextChars: [1000, 200000],
  restoreMaxChars: [1000, 100000],
  keepRecentTurns: [1, 20],
  keepRecentSteps: [1, 20],
  maxClearTurns: [1, 50],
  minClearChars: [0, 20000],
  maxClearChars: [1000, 1000000],
  stagingRetentionDays: [0, 3650],
  contextRetentionDays: [0, 3650],
  decisionRetentionDays: [0, 3650],
  autoKnowledgeLimit: [1, 100],
  similarityThreshold: [0.01, 0.95, 'float'],
  externalTimeoutMs: [1000, 600000],
});

/** Canonical knowledge backend; `sql` is the friendly alias for `sqlite`. */
function canonicalKnowledgeBackend(raw) {
  return raw === 'sql' ? 'sqlite' : raw;
}

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
        if (key === 'knowledgeBackend') {
          const backend = canonicalKnowledgeBackend(input[key]);
          if (!['json', 'sqlite'].includes(backend)) {
            issues.push({ message: 'knowledgeBackend 必须是 json 或 sqlite', path: [key] });
            continue;
          }
          value[key] = backend;
          continue;
        }
        if (key === 'engineLifecycle') {
          if (!['manual', 'always', 'turn'].includes(input[key])) {
            issues.push({ message: 'engineLifecycle 必须是 manual、always 或 turn', path: [key] });
            continue;
          }
          value[key] = input[key];
          continue;
        }
        value[key] = input[key];
      }
      if (typeof value.mcpToken === 'string' && value.mcpToken.length > 500) {
        issues.push({ message: 'mcpToken 不能超过 500 字符', path: ['mcpToken'] });
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
  value.knowledgeBackend = canonicalKnowledgeBackend(value.knowledgeBackend);
  if (!['json', 'sqlite'].includes(value.knowledgeBackend)) value.knowledgeBackend = 'json';
  if (!['manual', 'always', 'turn'].includes(value.engineLifecycle)) value.engineLifecycle = 'manual';
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
    stagingRetentionDays: config.stagingRetentionDays,
    contextRetentionDays: config.contextRetentionDays,
    decisionRetentionDays: config.decisionRetentionDays,
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
  // Protect the common case: `<project>/.ai-for-memory/` sits inside the user's
  // git worktree and holds full conversation text. If the project already has a
  // `.gitignore`, add the directory before its first creation so `git add .`
  // cannot sweep the archive into a public repository. Custom roots are left
  // alone; the README tells users to ignore those themselves.
  let gitignore = null;
  try {
    gitignore = ensureDefaultMemoryDirIgnored(root, workspace, config.directoryName);
  } catch (error) {
    // Never let a read-only `.gitignore` block memory writes, but keep the
    // warning so status/panel can tell the user the archive is unprotected.
    gitignore = { changed: false, reason: 'error', warning: `无法检查 .gitignore：${error?.message ?? error}` };
  }
  const registryDir = deps.registryDir ?? defaultRegistryDir();
  try {
    // Record every root the agent touches so the panel can list it later.
    rememberRoot(root, workspace, registryDir);
  } catch {
    // A read-only home must not break memory writes.
  }
  const sessionId = sessionOf(exec);
  if (runtime && sessionId !== '') markActivity(runtime, sessionId);
  return {
    scopes: createScopes(root, config),
    sessionId,
    workspace,
    root,
    meta: sessionMetaFrom(exec, workspace),
    gitignore,
  };
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
    // Only explicitly-opened conversations are visible across scopes; a missing
    // `public` field is private, not open.
    if (row.public !== true) continue;
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
  return scopes.listSessions().filter((row) => row.key === ownKey || row.public === true);
}

/** Count of conversations hidden from this caller by their access setting. */
export function closedConversationCount(context) {
  const { scopes, sessionId } = context;
  const ownKey = sessionId === '' ? null : sessionKey(sessionId);
  return scopes.listSessions().filter((row) => row.key !== ownKey && row.public !== true).length;
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
  if ((status.knowledge.pendingUpdates ?? 0) > 0) {
    lines.push(`历史待确认知识更新：${status.knowledge.pendingUpdates} 条`
      + '（旧版本提炼入队、未写入；面板知识库页可接受或忽略。新提炼不再入队）');
  }
  // One layer, two kinds: routine turn activity (observed) and reviewed risk
  // decisions (aim_decide). Reporting them together was what made the layer
  // look like an audit dump; report the split explicitly.
  const observedDecisions = status.decisions.byOutcome.observed ?? 0;
  const reviewedDecisions = Math.max(0, status.decisions.total - observedDecisions);
  const reviewedOutcomes = Object.entries(status.decisions.byOutcome)
    .filter(([outcome]) => outcome !== 'observed')
    .map(([outcome, count]) => `${outcome}=${count}`).join('，');
  lines.push(`决策记录：${status.decisions.total} 条（常规 ${observedDecisions}，风险审查 ${reviewedDecisions}`
    + (reviewedOutcomes !== '' ? `｜${reviewedOutcomes}` : '') + '）');
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

/**
 * Fold the same fact found in several stores after cross-conversation search.
 *
 * Each conversation has its own dedupe gate, so the same sentence can legally
 * exist in N stores. Merging hits without folding would spend N of the top_k
 * slots on one fact; here the highest-scoring copy wins and the other origins
 * are kept only as "see also" notes.
 */
function foldDuplicateHits(rows, topK) {
  // Tokenize once per row. The old code passed kept rows without `tokens`, so
  // findDuplicate re-tokenized every kept text for every new candidate — O(n²)
  // tokenization on a cross-conversation RRF page.
  const ordered = withTokens([...rows].sort((left, right) => right.score - left.score));
  const kept = [];
  const keptById = new Map();
  let folded = 0;
  for (const row of ordered) {
    const duplicate = findDuplicate(row.text, kept, { tokens: row.tokens });
    if (!duplicate) {
      const hit = { ...row, see_also: [] };
      kept.push(hit);
      keptById.set(hit.doc_id, hit);
      continue;
    }
    const target = keptById.get(duplicate.doc_id);
    // Folding is for the same fact repeated across conversations. Two distinct
    // docs in the same store are not a cross-source duplicate: the RAG index may
    // have deduplicated the older one, and the local channel must still surface
    // it after RRF instead of hiding it behind its newer twin.
    if (target && target.origin_key === row.origin_key) {
      const hit = { ...row, see_also: [] };
      kept.push(hit);
      keptById.set(hit.doc_id, hit);
      continue;
    }
    folded += 1;
    if (!target) continue;
    const note = {
      label: row.origin_label ?? '',
      key: row.origin_key ?? '',
      doc_id: row.doc_id,
      score: row.score,
    };
    if (!target.see_also.some((item) => item.key === note.key
      && item.doc_id === note.doc_id && item.label === note.label)) {
      target.see_also.push(note);
    }
  }
  return {
    hits: kept.slice(0, topK).map(({ tokens, ...hit }) => hit),
    folded,
  };
}

function formatHits(query, hits, mode, folded = 0, detail = 'summary') {
  if (hits.length === 0) return `没有命中「${query}」的知识文档（mode=${mode}）。`;
  const claimCount = hits.filter((hit) => hit.unverified === true).length;
  const lines = [`命中 ${hits.length} 条（mode=${mode}`
    + (folded > 0 ? `，已折叠跨来源重复 ${folded} 条` : '')
    + (detail === 'full' ? '，全文' : '，摘要；需要全文用 detail=full') + '）：'];
  if (claimCount > 0) {
    lines.push(`⚠ 其中 ${claimCount} 条是模型自述（未经用户确认），已降权；不要把它们当作项目事实。`);
  }
  hits.forEach((hit, index) => {
    const metric = mode === 'rag'
      ? `（RAG 相似度=${hit.score.toFixed(4)}）`
      : mode === 'rrf'
        ? ''
        : `（bm25=${hit.bm25_score.toFixed(4)}，vector=${hit.vector_score.toFixed(4)}）`;
    const fusion = mode === 'rrf'
      ? `｜RRF=${Number.isFinite(hit.rrf_score) ? hit.rrf_score.toFixed(4) : '?'}`
        + `｜RAG#${hit.rrf_ranks?.rag ?? '—'}｜BM25#${hit.rrf_ranks?.local ?? '—'}`
      : '';
    const usage = Number.isFinite(hit.usage_weight) ? `｜${weightLabel(hit.usage_weight)}` : '';
    const confidence = Number.isFinite(hit.confidence) ? `｜置信度：${hit.confidence.toFixed(2)}` : '';
    const updatedCount = Array.isArray(hit.changes) ? hit.changes.length : (hit.changes_count ?? 0);
    const updated = updatedCount > 0 ? `｜已更新×${updatedCount}` : '';
    const seeAlso = Array.isArray(hit.see_also) && hit.see_also.length > 0
      ? `｜另见：${[...new Set(hit.see_also.map((item) => item.label || '同内容'))].join('、')}`
      : '';
    lines.push(`${index + 1}. [${hit.category}] ${hit.doc_id}  score=${hit.score.toFixed(4)}`
      + metric
      + fusion
      + usage
      + confidence
      + updated
      + (hit.unverified === true ? '｜⚠ 模型自述（未确认）' : '')
      + (hit.source && hit.source !== 'unknown' ? `｜知识来源：${hit.source}` : '')
      + (hit.origin_label ? `｜对话：${hit.origin_label}` : '')
      + seeAlso);
    lines.push(`   ${hit.text}`);
    if (detail !== 'full' && hit.text_truncated === true) {
      lines.push(`   （全文 ${hit.text_chars ?? '?'} 字，已折叠为摘要）`);
    }
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
/**
 * Ranked local channel for RRF. BM25 is deliberately used instead of hybrid:
 * the point of fusion is to complement the semantic RAG channel with a lexical
 * channel, not to reproduce the same ranking twice.
 */
/**
 * Apply score-based priors inside one channel, before RRF sees it.
 *
 * RRF only consumes rank, and its scores live at 1/(k+rank) — rank 1 and rank 5
 * differ by ~0.001. Multiplying the *fused* score by 1.25 (usage) or 0.35
 * (unverified) therefore moves four or more places and destroys the rank
 * signal. Put those priors where they belong: reorder the channel first, then
 * let RRF fuse ranks only.
 */
function rankChannelWithPriors(rows, weights, owner = null) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const owned = owner === null || (
      (row.origin_key ?? '') === (owner.key ?? '')
      && (row.origin_scope ?? 'session') === (owner.scope ?? 'session')
    );
    const usage = owned && Number.isFinite(weights[row.doc_id]) ? weights[row.doc_id] : 0;
    const provenance = typeof row.provenance === 'string' ? row.provenance : 'authored';
    const unverified = row.unverified === true || (provenance === 'model' && row.verified !== true);
    const confidence = Number.isFinite(row.confidence)
      ? Math.min(1, Math.max(0, row.confidence))
      : 0.8;
    const prior = 1 + USAGE_BOOST * usage;
    const base = Number.isFinite(row.local_score) ? row.local_score : (Number.isFinite(row.score) ? row.score : 0);
    return {
      ...row,
      provenance,
      unverified,
      confidence,
      usage_weight: usage,
      channel_prior: prior,
      channel_score: base * prior,
    };
  }).sort((left, right) => right.channel_score - left.channel_score);
}

function localRrfRows(sources, query, options = {}) {
  const rows = [];
  for (const source of sources) {
    const found = source.store.search(query, {
      category: options.category ?? null,
      mode: 'bm25',
      topK: 40,
      detail: 'full',
    });
    // `hit.score` already carries confidence/unverified penalties from local
    // retrieval. Use the raw BM25 component here; the channel prior applies
    // those factors exactly once, before RRF.
    const rawScore = (hit) => (Number.isFinite(hit.bm25_score) ? hit.bm25_score : hit.score);
    const sourceMax = Math.max(0, ...found.map(rawScore));
    for (const hit of found) {
      rows.push({
        ...hit,
        local_score: sourceMax > 0 ? rawScore(hit) / sourceMax : 0,
        origin_label: source.label,
        origin_key: source.key,
        origin_scope: source.scope,
      });
    }
  }
  rows.sort((left, right) => right.local_score - left.local_score);
  return rows;
}

export async function searchWithRag(config, sources, query, options = {}) {
  const effective = effectivePluginConfig(config);
  const models = ragModelStatus(effective);
  if (!models.ready) {
    return {
      ok: false,
      note: `RAG 需要同时配置 Embedding 和 Rerank 两个模型，当前缺少：${models.missing.join('、')}。`
        + '\n请在面板「外部模型」里分别填写 Embedding 模型与 Rerank 模型后再挂载；已回退本地检索。',
    };
  }
  const endpoint = externalOpEndpointFrom(effective, 30000);
  const identity = embeddingIdentity(endpoint);
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
  let staleStores = 0;
  let staleDetail = '';
  const describeStale = (row) => {
    if (row.reason === 'dim-mismatch') {
      return `索引维度 ${row.indexDim}d，当前查询维度 ${row.queryDim}d`;
    }
    if (row.reason === 'model-mismatch') {
      return `索引模型 ${row.indexModel || '未知'}，当前模型 ${row.currentModel}`;
    }
    if (row.reason === 'endpoint-mismatch') {
      return `索引地址 ${row.indexEndpoint || '未知'}，当前地址 ${row.currentEndpoint}`;
    }
    return '';
  };
  for (const source of sources) {
    const result = ragCandidates(source.store, vector, {
      topK: 40,
      category: options.category ?? null,
      model: identity.model,
      endpoint: identity.endpoint,
      space: identity.space,
    });
    if (!result.ok) {
      if (result.reason === 'no-index') {
        unindexedStores += 1;
      } else {
        staleStores += 1;
        if (staleDetail === '') staleDetail = describeStale(result);
      }
      continue;
    }
    indexedStores += 1;
    for (const row of result.candidates) candidates.push({ ...row, source });
  }
  if (indexedStores === 0) {
    if (staleStores > 0) {
      return {
        ok: false,
        note: `RAG 索引与当前嵌入配置不一致（${staleDetail}）——`
          + '换 provider / 模型后索引需要重建：请在面板点「建立/更新索引」，或运行 aim_memory action=index。\n已回退本地检索。',
      };
    }
    return {
      ok: false,
      note: `RAG 已挂载，但所选范围还没有索引（${unindexedStores} 个存储）——先运行 aim_memory action=index。\n已回退本地检索。`,
    };
  }
  candidates.sort((left, right) => right.score - left.score);
  const reranked = await rerankCandidates(endpoint, query, candidates.slice(0, 20), {
    // Keep the full reranked candidate page for RRF. Passing the final topK here
    // silently cut the RAG channel to 5 rows and threw away ranks 6–20, exactly
    // where semantic-only matches live.
    topK: Math.min(candidates.length, 20),
  });
  if (reranked.ok !== true) {
    return { ok: false, note: `RAG 检索失败：${reranked.error ?? '未知错误'}\n已回退本地检索。` };
  }
  if (reranked.via !== 'rerank') {
    return {
      ok: false,
      note: `RAG 需要 Rerank 模型参与重排，但重排服务不可用：${reranked.rerankError ?? '未配置 Rerank 模型'}`
        + '\n已在结果上回退本地检索；请启动/配置 Rerank 模型，或关闭「RAG 挂载」。',
    };
  }
  const covers = `范围：${sources.map((source) => source.label).join(' + ')}`
    + (unindexedStores > 0 ? `（${unindexedStores} 个存储还没有 RAG 索引，只参与本地 BM25 通道）` : '')
    + (staleStores > 0 ? `（${staleStores} 个存储的 RAG 索引与当前嵌入配置不一致，已跳过 RAG 通道；仍参与本地 BM25）` : '');
  // RRF needs both channels on the same result page. RAG is the semantic
  // channel; local BM25 is the lexical channel. The local channel sees every
  // JSON knowledge document, including those the index-level semantic dedupe
  // deliberately left out, so the two paths no longer disagree about existence.
  const callerStore = options.store ?? null;
  const callerOwner = options.owner && typeof options.owner === 'object' ? options.owner : null;
  const weights = callerStore && typeof callerStore.knowledgeWeights === 'function'
    ? callerStore.knowledgeWeights()
    : {};
  const ragRows = reranked.hits.map((row, index) => {
    const provenance = typeof row.doc.provenance === 'string' ? row.doc.provenance : 'authored';
    return {
      doc_id: row.doc.doc_id,
      text: row.doc.text,
      category: row.doc.category,
      source: row.doc.source,
      url: row.doc.url,
      provenance,
      unverified: provenance === 'model' && row.doc.verified !== true,
      confidence: Number.isFinite(row.doc.confidence)
        ? Math.min(1, Math.max(0, row.doc.confidence))
        : 0.8,
      changes_count: Number.isInteger(row.doc.changes_count)
        ? row.doc.changes_count
        : (Array.isArray(row.doc.changes) ? row.doc.changes.length : 0),
      score: row.score,
      rag_rank: index + 1,
      origin_label: row.source.label,
      origin_key: row.source.key,
      origin_scope: row.source.scope,
    };
  });
  const localRows = localRrfRows(sources, query, {
    category: options.category ?? null,
  });
  // Priors belong inside a channel, not on top of the fused RRF score. This also
  // makes `RAG#` / `BM25#` in the output describe the order RRF actually saw.
  const ragChannel = rankChannelWithPriors(ragRows, weights, callerOwner);
  const localChannel = rankChannelWithPriors(localRows, weights, callerOwner);
  const fused = reciprocalRankFusion([
    { name: 'rag', rows: ragChannel },
    { name: 'local', rows: localChannel },
  ], { k: RRF_K });
  const ranked = fused
    .map((row) => {
      const confidence = Number.isFinite(row.confidence)
        ? Math.min(1, Math.max(0, row.confidence))
        : 0.8;
      const prior = (0.85 + 0.15 * confidence) * (row.unverified === true ? 0.35 : 1);
      return {
        ...row,
        // RRF consumes ranks, so priors that must survive fusion are applied
        // after it. Keep `rrf_score` pristine for display/debugging; `score` is
        // the final ordering with confidence and unverified penalties restored.
        score: row.rrf_score * prior,
        post_rrf_prior: prior,
      };
    })
    .sort((left, right) => right.score - left.score);
  if (ranked.length === 0) {
    return {
      ok: true,
      empty: true,
      text: `RRF 融合（RAG ${ragRows.length} 条（Embedding + Rerank）+ 本地 BM25 ${localRows.length} 条）没有命中「${query}」。\n${covers}`,
    };
  }
  const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : config.defaultTopK;
  const detail = options.detail === 'full' ? 'full' : 'summary';
  const { hits, folded } = foldDuplicateHits(ranked, topK);
  const disclosed = applyDisclosure(hits, query, detail);
  if (callerStore && typeof callerStore.recordKnowledgeUsage === 'function') {
    const ownedHits = disclosed.filter((hit) => callerOwner === null || (
      (hit.origin_key ?? '') === (callerOwner.key ?? '')
      && (hit.origin_scope ?? 'session') === (callerOwner.scope ?? 'session')
    ));
    callerStore.recordKnowledgeUsage(ownedHits.map((hit) => hit.doc_id));
  }
  const channelSummary = `RAG ${ragRows.length} 条（Embedding + Rerank）+ 本地 BM25 ${localRows.length} 条 → RRF(k=${RRF_K})`;
  return {
    ok: true,
    empty: false,
    rag_via: reranked.via,
    text: `检索方式：RRF 融合（${channelSummary}）｜${covers}\n`
      + formatHits(query, disclosed, 'rrf', folded, detail)
      + '\n（RAG 通道先用 Embedding 召回，再经 Rerank 重排；Rerank 不可用时不会把只靠 Embedding 的结果当作 RAG。'
      + '索引会按语义去重；被索引去重掉的旧文档仍由本地 BM25 通道带回，不再出现“知识库里有、RAG 里没有”的两套结论。'
      + 'RAG#/BM25# 是通道内先按使用率、确认状态和置信度重排后的名次；RRF 只融合名次，最终分不再乘先验。'
      + '关闭「RAG 挂载」则只走本地 BM25。）',
  };
}

/** Format one `promote` result for the model. */
/** Collect the raw text the external knowledge extractor reads. */
function gatherPromoteSource(store) {
  const chunks = [];
  for (const record of store.stagingRecords().slice(-40)) {
    // Same gate as the deterministic promote: a model's unverified record is
    // not raw material for facts, even when an external model does the reading.
    if (record.verify !== 'pass') continue;
    if (typeof record.content === 'string' && record.content.trim() !== '') {
      chunks.push(record.content.trim());
    }
  }
  for (const category of CATEGORIES) {
    for (const entry of store.archiveEntries(category, 20)) {
      if (entry?.verify !== 'pass') continue;
      const text = entry?.content ?? entry?.text ?? '';
      if (typeof text === 'string' && text.trim() !== '') chunks.push(text.trim());
    }
  }
  return chunks.join('\n\n');
}

/** Build the external endpoint from the plugin config. */
function externalEndpointOf(config) {
  const effective = effectivePluginConfig(config);
  return normalizeExternal({
    baseUrl: effective.externalBaseUrl,
    model: effective.externalModel,
    embedBaseUrl: effective.externalEmbedBaseUrl,
    embedModel: effective.externalEmbedModel,
    rerankBaseUrl: effective.externalRerankBaseUrl,
    rerankModel: effective.externalRerankModel,
    apiKey: effective.externalApiKey,
    embedApiKey: effective.externalEmbedApiKey,
    rerankApiKey: effective.externalRerankApiKey,
    timeoutMs: effective.externalTimeoutMs,
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
  const isUpdate = result?.kind === 'update' || conflicts.some((row) => row?.update === true);
  const lines = [
    isUpdate
      ? '未写入：这条知识是对已有条目的更新（数值/端点/极性发生变化），需要先确认。'
      : '未写入：这条知识可能与已有知识冲突，需要先问用户。',
    `待写入：${clip(pending.text ?? '', 300)}`,
  ];
  for (const row of conflicts.slice(0, 3)) {
    const change = row?.change && typeof row.change === 'object' ? row.change : null;
    const delta = change
      ? `，${change.kind}：${clip((change.before ?? []).join('，'), 80)} → ${clip((change.after ?? []).join('，'), 80)}`
      : '';
    lines.push(`- 已有 [${row.category || '未分类'}] ${row.doc_id}（相似度 ${row.similarity}${delta}）：${clip(row.text, 160)}`);
  }
  lines.push('请向用户确认三件事：以哪条为准、是否覆盖旧条目（给旧条目 doc_id）、是否只是补充；');
  if (isUpdate) {
    lines.push('用户确认后用 confirm=true 重新调用；会写入新正文，并在 changes 中保留上一版审计。');
  } else {
    lines.push('用户同意后再用 confirm=true 重新调用；同意覆盖就同时传旧条目的 doc_id，'
      + '会覆盖该条正文并保留 changes 审计。用户不同意就不要写入。');
  }
  return lines.join('\n');
}

function formatPromotion(result) {
  const scanned = result.scanned ?? {};
  const rows = [...(result.added ?? []), ...(result.merged ?? [])];
  const claims = rows.filter((row) => row.provenance === 'model' && row.verified !== true).length;
  const skippedUnverified = (result.skippedUnverified?.staging ?? 0)
    + (result.skippedUnverified?.archive ?? 0);
  const lines = [
    `${result.dryRun ? '提炼预览（未写入）' : '已从三层提炼知识'}：`
      + `过程记录 ${scanned.staging ?? 0}，归档 ${scanned.archive ?? 0}，`
      + `上下文轮次 ${scanned.contexts ?? 0}，决策 ${scanned.decisions ?? 0}`,
    `${result.dryRun ? '将新增' : '新增'} ${result.added.length} 篇，合并 ${result.merged.length} 篇，`
      + `剩余 ${result.remaining} 条待下次`,
  ];
  if (skippedUnverified > 0) {
    lines.push(`另有 ${skippedUnverified} 条过程记录/归档未通过 verify=pass，未被提炼（保持待核实，不计入知识）。`);
  }
  if (claims > 0) {
    lines.push(`⚠ 其中 ${claims} 篇是模型自述（来自过程记录或决策复盘，未经用户确认）；`
      + '已标记并会在检索时降权，不能当作项目事实。');
  }
  const pending = Array.isArray(result.pending) ? result.pending : [];
  if (pending.length > 0) {
    lines.push(`⚠ ${pending.length} 条提炼结果想改写已有事实，本次没有写入，也没有入队：`);
    for (const row of pending.slice(0, 5)) {
      lines.push(`- 目标 ${row.update_of ?? row.doc_id}：${clip(row.text ?? '', 140)}`);
    }
    lines.push('请逐条核对；用户同意后用 aim_memory remember + confirm=true 写入，'
      + '传目标 doc_id 会覆盖该条正文并保留 changes 审计；不同意就不写。');
  }
  const preserved = (result.merged ?? []).filter((row) => row.preserved === true).length;
  if (preserved > 0) {
    lines.push(`其中 ${preserved} 条只是补充证据，原正文保持不变。`);
  }
  for (const row of result.added.slice(0, 20)) {
    lines.push(`- [${row.category}] ${row.doc_id}（${row.source}）`
      + `${row.provenance === 'model' ? '｜模型自述（未确认）' : ''}：${clip(row.text, 160)}`);
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
    `可逆性：irreversible=${result.irreversible === null || result.irreversible === undefined ? '未提供' : result.irreversible}`
      + (result.recoverable_via ? `｜恢复路径：${result.recoverable_via}` : ''),
    `权重（仅审计，不参与放行）：${weights}`,
    `理由：${result.reason}`,
    `decision_id：${result.decision_id}`,
  ].join('\n');
}

// ---- tool definitions ----------------------------------------------------

/**
 * Normalize the optional `sources` argument of `aim_ask action=chat`.
 *
 * Each source becomes a numbered evidence item the model must cite as `[n]`;
 * the tool result then maps every number back to an id/url/text so a generated
 * summary can be audited afterwards. Both strings and `{id,text,url}` objects
 * are accepted.
 */
export function normalizeChatSources(raw, limit = 20) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  let total = 0;
  const maxChars = 12000;
  for (const item of raw.slice(0, limit)) {
    let text = '';
    let id = '';
    let url = '';
    if (typeof item === 'string') {
      text = item;
    } else if (item && typeof item === 'object') {
      text = typeof item.text === 'string'
        ? item.text
        : (typeof item.content === 'string' ? item.content : '');
      id = typeof item.id === 'string' && item.id.trim() !== ''
        ? item.id.trim()
        : (typeof item.doc_id === 'string' ? item.doc_id.trim() : '');
      url = typeof item.url === 'string' ? item.url.trim() : '';
    }
    text = clip(text.trim(), 2000);
    if (text === '') continue;
    if (total + text.length > maxChars) break;
    total += text.length;
    rows.push({
      id: id !== '' ? id : `S${rows.length + 1}`,
      url,
      text,
    });
  }
  return rows;
}

/** System instruction + numbered evidence block for a chat call with sources. */
export function buildChatSourcePrompt(sources, { json = false } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) return '';
  const block = sources
    .map((source, index) => `[${index + 1}] id=${source.id}${source.url ? ` url=${source.url}` : ''}\n${source.text}`)
    .join('\n\n');
  const rule = json === true
    ? '以下是编号来源材料，作为回答的事实依据；不要编造材料之外的事实。\n\n'
    : '以下是编号来源材料。只依据这些材料回答；每个结论后必须用 [1]、[2] 这样的编号标注依据；'
      + '来源不足时明确说“来源未覆盖”，不要编造来源编号。\n\n';
  return rule + block;
}

/** One-line audit footer for an external chat call. */
export function formatChatTrace({ endpoint, result, inputText, output, truncated }) {
  const hash = createHash('sha256').update(String(inputText ?? '')).digest('hex').slice(0, 12);
  const parts = [
    `model=${result.model || endpoint.model || 'local'}`,
    `地址=${endpoint.baseUrl}`,
    `时间=${new Date().toISOString()}`,
    `输入 sha256:${hash}（${String(inputText ?? '').length} 字）`,
    `输出 ${String(output ?? '').length} 字${truncated ? '（已截断，原文更长）' : ''}`,
  ];
  if (result.id) parts.push(`请求 id=${result.id}`);
  if (Number.isFinite(result.created)) {
    parts.push(`服务时间=${new Date(result.created * 1000).toISOString()}`);
  }
  if (Number.isFinite(result.usage?.total_tokens)) parts.push(`tokens=${result.usage.total_tokens}`);
  if (result.finishReason) parts.push(`结束=${result.finishReason}`);
  return `— 调用记录：${parts.join('｜')}`;
}

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
        + '过程记录、归档、上下文这三层里的用户规则、错误修复、决策理由，用 promote 提炼；'
        + '但 promote 只自动提炼 verify=pass 的过程记录和用户原话，模型自己写的 state/error/decision 属于「模型自述」，'
        + '即使入库也会标为未确认并在检索时降权，不能当作项目事实。'
        + '每条知识只写一句可复用的结论，必须带分类，并尽量给出处（url 或 source）。'
        + '默认写入当前对话自己的独立记忆；scope=shared 时写入所有对话共用的共享层。'
        + '冲突规则：新知识与已有知识、或与你自己的认知不一致时，先询问用户，得到同意后再带 confirm=true 写入；'
        + '冲突不会入队：不带 confirm 的写入若与已有知识相近但不同，会返回 needs_confirm 并列出冲突条目，必须先问用户，不要擅自覆盖。'
        + '注意：只改数字（端口/阈值/版本）、URL 或开关（开启/关闭）的“更新”即使措辞高度相似也会返回 kind=update，必须先确认；'
        + '确认后传原 doc_id + confirm=true 会覆盖该条正文，并在 changes 中保留上一版审计，不要把它当普通重复直接合并。'
        + '需要检索时用 aim_search（默认跨对话）。不要写入密钥、令牌或用户没有说过的事实。'
        + 'remember/learn/incident 的调用方是模型，写入内容默认标为模型自述（provenance=model、verified=false、检索降权），'
        + '用户可在面板对单条点「确认这条」，确认后保留原 doc_id 与证据链并清除黄标；不要假装已确认。'
        + '面板可把「归档 / 知识库提炼 / 上下文清理」分别切到外部模型模式（任何 OpenAI 兼容服务）；'
        + '外部模式失败会自动回退本地规则，结果里会写明用了哪条路。'
        + 'RAG：索引建在知识库上（action=index），是否挂到 aim_search 由面板「RAG 挂载」开关控制，可随时挂/摘。'
        + '事故：出现文件损坏、数据丢失、严重误操作等事故时，用 action=incident 把事故单独记为 incidents 类型'
        + '（title 必填，what_happened/impact/cause/fix/prevention 选填），不要混进普通知识。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['stage', 'archive', 'snapshot', 'restore', 'list', 'remember', 'learn', 'promote', 'forget', 'index', 'export', 'incident', 'status'],
          description:
            'stage=追加一条过程记录（content 必填）；archive=按 kind 归档（可传 category 强制分类）；'
            + 'snapshot=保存 state 快照（name 必填）；restore=按 snapshot_id 恢复；list=列出快照；'
            + 'remember=写入一条知识（text 必填，doc_id 可省）；learn=批量写知识（items 必填）；'
            + 'promote=从过程记录/归档/上下文提炼知识（仅 verify=pass 的模型记录 + 用户原话；dry_run 可预览；'
            + '不改写已有正文，数值/端点/开关变化只在结果里列出，不写入、不入队）；'
            + 'forget=删除一条错误知识（doc_id 必填）；'
            + 'index=为当前范围的知识库建立/更新 RAG 索引（需要 Embedding + Rerank 两个模型都配置好）；'
            + 'export=把知识库全量导出（可选一种或多种：knowledge=JSON/Markdown、sql=SQLite 数据库、rag=向量索引）；'
            + 'incident=把一次事故写进知识库，单独归为 incidents 类型（title 必填）；'
            + 'status=查看统计。',
        },
        scope: {
          type: 'string',
          enum: ['session', 'shared'],
          description:
            '写入范围，默认 session=当前对话独立存储（默认不对外开放，其他对话检索不到；需要时在面板逐个打开）；'
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
          description: 'remember 用：知识文档 id，可省略——默认按正文生成稳定 id。传已有条目的 doc_id 时，'
            + '它是‘要改写的目标’：不带 confirm 返回更新确认，带 confirm=true 用新正文覆盖该条（旧正文留在 changes 审计）；'
            + '不传时按正文去重。',
        },
        dest: {
          type: 'string',
          description:
            'export 用：导出目标，可以是另一块盘上的目录（每个类型一个文件）或完整文件路径；'
            + '省略时写到记忆目录的 exports/ 下。',
        },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['knowledge', 'sql', 'rag'] },
          description:
            'export 用：可多选——knowledge=知识库（JSON 或 Markdown，格式由 format 决定）、'
            + 'sql=完整 SQLite 数据库（knowledge.sqlite）、rag=RAG 向量索引；默认只导出 knowledge。',
        },
        format: {
          type: 'string',
          enum: ['json', 'markdown'],
          description: 'export 用（仅 knowledge）：json=无损全量（默认，含证据字段），markdown=人直接阅读。',
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
        title: {
          type: 'string',
          description: 'incident 用：事故标题（必填），例如「index.js 被 PowerShell 改写后中文编码损坏」。',
        },
        what_happened: {
          type: 'string',
          description: 'incident 用：发生了什么（触发条件、现象、报错原文）。',
        },
        impact: {
          type: 'string',
          description: 'incident 用：影响范围与损失（哪些文件/数据/功能受影响，是否已恢复）。',
        },
        cause: {
          type: 'string',
          description: 'incident 用：根因（不是「手滑」这种结论，要写到具体操作与机制）。',
        },
        fix: {
          type: 'string',
          description: 'incident 用：怎么处理的（恢复步骤、验证方式）。',
        },
        prevention: {
          type: 'string',
          description: 'incident 用：以后怎么避免（会写进知识库，供后续对话检索）。',
        },
        severity: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'incident 用：严重度，默认 medium。',
        },
        incident_status: {
          type: 'string',
          enum: ['open', 'mitigated', 'resolved'],
          description: 'incident 用：当前状态，默认 open（也可用 status 传入）。',
        },
        status: {
          type: 'string',
          enum: ['open', 'mitigated', 'resolved'],
          description: 'incident 用：incident_status 的别名，默认 open。',
        },
        occurred_at: {
          type: 'string',
          description: 'incident 用：发生时间（ISO 字符串），省略时用当前时间。',
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
            + '此时必须先向用户确认；用户同意后再带 confirm=true 重试。要覆盖旧条目正文就同时传旧条目的 doc_id（保留 changes 审计）。',
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
            // The only caller of this tool is the model. Even source=user is a
            // model transcription, not a verified fact; mark it unverified until
            // the user confirms it through the panel.
            provenance: 'model',
            verified: false,
            evidence: [{ kind: 'authored', ref: String(args?.source ?? 'authored') }],
          }, { confirm: args?.confirm === true });
          if (doc && doc.needs_confirm) return formatConflict(doc);
          // Writing a document counts as using it: it becomes the most recent
          // knowledge in this conversation and ranks higher on next search.
          if (typeof source.store.recordKnowledgeUsage === 'function') {
            source.store.recordKnowledgeUsage([doc.doc_id]);
          }
          return [
            `${doc.merged
              ? ((doc.changes?.length ?? 0) > 0 ? '知识已更新' : '知识已合并')
              : '知识已写入'}（${source.label}）：${doc.doc_id}`,
            `分类：${doc.category}｜来源：${doc.source}`
              + (doc.tags.length > 0 ? `｜标签：${doc.tags.join('，')}` : '')
              + (doc.url !== '' ? `｜出处：${doc.url}` : '')
              + `｜状态：${doc.verified === true ? '已确认' : '模型自述（未确认）'}`,
            `修订：${doc.revision ?? 1}`
              + ((doc.changes?.length ?? 0) > 0 ? `｜最近变化：${doc.changes[doc.changes.length - 1].kind}` : ''),
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
                provenance: 'model',
                verified: false,
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
          if (written.length > 0 && typeof source.store.recordKnowledgeUsage === 'function') {
            source.store.recordKnowledgeUsage(written.map((doc) => doc.doc_id));
          }
          const lines = [
            `已写入知识 ${written.length} 条（新增 ${written.length - merged}，合并 ${merged}）`
              + (blocked.length > 0 ? `，待确认 ${blocked.length} 条` : '')
              + (failed.length > 0 ? `，失败 ${failed.length}` : ''),
            '模型写入默认是模型自述（未确认）；用户在面板「确认这条」后才转为已确认。',
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

        if (action === 'incident') {
          const title = String(args?.title ?? '').trim();
          if (title === '') throw new Error('incident 需要 title');
          const severity = ['low', 'medium', 'high'].includes(args?.severity) ? args.severity : 'medium';
          const incidentStatusRaw = args?.incident_status ?? args?.status;
          const incidentStatus = ['open', 'mitigated', 'resolved'].includes(incidentStatusRaw)
            ? incidentStatusRaw
            : 'open';
          const doc = store.recordIncident({
            title,
            what_happened: args?.what_happened,
            impact: args?.impact,
            cause: args?.cause,
            fix: args?.fix,
            prevention: args?.prevention,
            severity,
            status: incidentStatus,
            occurred_at: args?.occurred_at,
            source: args?.source,
            tags: args?.tags,
          });
          if (typeof store.recordKnowledgeUsage === 'function') store.recordKnowledgeUsage([doc.doc_id]);
          return [
            `事故已写入知识库（${source.label}）：${doc.doc_id}`,
            `分类：incidents（独立类型「事故」）｜严重度：${severity}｜状态：${incidentStatus}`,
            `知识状态：模型自述（未确认）｜置信度：${doc.confidence}；面板确认后清除黄标`,
            clip(doc.text, 800),
            '事故记录不触发知识冲突闸门，也不会被普通知识的冲突确认拦下；'
              + '之后可用 aim_search（category=incidents 或直接搜「事故」）检索。',
          ].join('\n');
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
            let pending = 0;
            const ids = [];
            for (const item of mined.items) {
              const doc = store.remember(
                {
                  text: item.text,
                  category: item.category,
                  source: 'external-model',
                  provenance: 'model',
                  verified: false,
                  confidence: 0.5,
                },
                { preserveText: true },
              );
              if (doc?.needs_confirm) {
                // Never queued: the caller reports it, the user decides, and a
                // confirmed remember with the old doc_id overwrites the body.
                pending += 1;
                continue;
              }
              if (doc?.doc_id) {
                written += 1;
                if (doc.merged) merged += 1;
                ids.push(doc.doc_id);
              }
            }
            return [
              `外部模型提炼完成（${source.label}）：候选 ${mined.items.length} 条，写入 ${written} 条`
                + `${merged > 0 ? `（其中 ${merged} 条与已有知识合并）` : ''}`
                + `${pending > 0 ? `，${pending} 条改写已有事实的提议未写入、待确认` : ''}。`,
              ...ids.slice(0, 8).map((id) => `  - ${id}`),
              '⚠ 这些条目来自外部模型对过程记录的再表述，已标为「模型自述（未确认）」并在检索时降权；不要当作项目事实。',
              '说明：外部模型提炼不会覆盖已有正文；数值/端点/开关变化只在结果里列出，不写入、不入队；确认后用 remember + confirm=true（传旧条目 doc_id 可覆盖正文）。',
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
          const effective = effectivePluginConfig(config);
          const models = ragModelStatus(effective);
          if (!models.ready) {
            return `RAG 索引未建立：需要同时配置 Embedding 和 Rerank 两个模型，当前缺少：${models.missing.join('、')}。\n`
              + '请在面板「外部模型」中分别填写 Embedding 模型与 Rerank 模型后重试。';
          }
          const endpoint = externalOpEndpointFrom(effective, 60000);
          const built = await buildRagIndex(store, endpoint);
          if (!built.ok) {
            return `RAG 索引未建立（${source.label}）：${built.error}\n`
              + '已索引的旧条目保持不变；确认外部嵌入服务可用后重试 aim_memory action=index。';
          }
          const mount = effective.ragMount ? '已挂载，aim_search 将优先用 RAG' : '未挂载（可在面板打开「RAG 挂载」）';
          const switchNote = built.changed
            ? '已按当前嵌入配置全量重建（旧索引可能来自其他地址/模型，与当前维度不兼容）。\n'
            : '';
          return `${switchNote}RAG 索引已更新（${source.label}）：${built.indexed} 篇知识文档，本次嵌入 ${built.embedded} 篇`
            + `；知识库共 ${built.considered} 篇`
            + (built.truncated > 0 ? `，其中 ${built.truncated} 篇超过 maxDocs=${built.maxDocs ?? RAG_DEFAULTS.maxDocs} 上限未参与索引` : '')
            + `，语义去冗余 ${built.deduped} 篇（同分类且相似度 ≥0.95 的旧重复），清理 ${built.removed} 条失效向量，`
            + `维度 ${built.dim}（模型 ${built.model}），分片 ${built.shards} 个（只在内容变化时重写对应分片）。\n${mount}。`;
        }

        if (action === 'export') {
          const written = writeExportArtifacts(store, {
            scope: source.scope === 'shared' ? 'shared' : 'session',
            label: source.label,
            sessionId: source.sessionId ?? context.sessionId ?? '',
            dest: typeof args?.dest === 'string' ? args.dest : '',
            format: typeof args?.format === 'string' ? args.format : 'json',
            types: args?.types,
          });
          if (!written.ok) return `知识库导出失败：${written.error}`;
          const lines = written.files.map((row) => `- ${row.type}：${row.path}`
            + `（${row.bytes} 字节${row.docs > 0 ? `，${row.docs} 篇` : ''}）`);
          return `知识库已导出 ${written.files.length} 个文件，共 ${written.bytes} 字节：\n${lines.join('\n')}\n`
            + '导出是完整副本，不删除本地任何内容；三个类型可任意组合，内容全在文件里，'
            + '没有为了省空间而遗忘或裁剪。';
        }
        if (action === 'status') {
          const others = readableConversations(context)
            .filter((row) => source.scope !== 'session' || row.key !== source.key)
            .map((row) => ({ ...row, counts: context.scopes.counts(row.key) }));
          const rag = ragStats(store.root);
          const currentEmbedding = embeddingIdentity(externalEndpointOf(config));
          const ragStale = rag.built && !sameEmbeddingSpace(rag, currentEmbedding);
          const ragLine = `RAG：${effectivePluginConfig(config).ragMount ? '已挂载到知识库检索' : '未挂载（面板可切换）'}｜`
            + (rag.built
              ? `索引 ${rag.docs} 篇（知识库 ${rag.considered} 篇`
                + `${rag.truncated > 0 ? `，超出上限 ${rag.truncated} 篇未索引` : ''}`
                + `；语义去重 ${rag.deduped} 篇），维度 ${rag.dim}，${rag.built_at}`
              : '索引未建立（aim_memory action=index）')
            + (ragStale ? '｜索引来自其他嵌入模型/地址，检索会回退本地，请重建' : '');
          const storage = store.knowledgeBackendInfo();
          const usageCount = Object.keys(
            typeof store.knowledgeUsage === 'function' ? store.knowledgeUsage() : {},
          ).length;
          const usageLine = `知识权重：本对话已记录 ${usageCount} 条最近使用（半衰期 14 天，只影响本对话排序）`;
          const incidentCount = store.documents()
            .filter((doc) => doc.category === 'incidents').length;
          const incidentLine = `事故记录：${incidentCount} 条（独立类型 incidents；`
            + '出现事故用 aim_memory action=incident 记录）';
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
          })}\n${storageLine}\n${ragLine}\n${usageLine}\n${incidentLine}`;
        }

        throw new Error(`未知 action：${String(action)}`);
      },
    },
    {
      name: 'aim_search',
      description:
        '检索当前项目的 AI for Memory 知识库，并自动选择通道：'
        + '指标/聚合/精确 doc_id 类问题走 SQL（Text-to-SQL，基于 JSON 底座的内存只读表）；'
        + '模糊、开放性的文档问题走向量检索（面板「RAG 挂载」开启且索引就绪时，RAG 语义结果与本地 BM25 结果用 RRF 融合；否则只用本地 BM25）；'
        + '两者兼有的问题走混合（SQL 出统计 + 向量补相关文档）；'
        + 'SQL 翻译不了时回退向量，向量零命中时反向用 SQL 兜底。'
        + 'JSON 是基础底座，SQL 与 RAG 都是从 JSON 派生出来的视图。'
        + '排序会叠加本对话的最近使用权重（14 天半衰期，只影响本对话），结果里标出权重。'
        + '被标为「模型自述（未确认）」的条目来自模型自己的过程记录或决策复盘，已降权，不是用户确认的事实；'
        + '回答时不得把它当作项目已知事实，必要时向用户确认。'
        + '默认跨对话检索本对话、已打开的其他对话与共享层，结果逐条标注来源对话；'
        + '同一事实在多处各存一份时，合并后会折叠成一条（保留最高分，其他来源写成「另见」），不重复占 top_k。'
        + '默认每条只返回查询附近的摘要和全文长度；需要全文时传 detail=full，不要为了浏览而一次性倾倒整篇知识。'
        + '未打开的对话不可见（默认新建对话不开放，需在面板逐个打开）。'
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
          description: '检索模式，默认 hybrid（BM25 与哈希向量按排名融合）；bm25 / vector 可单独使用。',
        },
        top_k: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: `返回条数，默认 ${config.defaultTopK}。`,
        },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: '默认 summary=返回查询附近摘要和全文长度；full=返回完整正文（显式请求才用，避免一次性占满上下文）。',
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
        const detail = args?.detail === 'full' ? 'full' : 'summary';
        const scope = ['all', 'session', 'shared'].includes(args?.scope) ? args.scope : 'all';
        const context = memoryContext(config, exec, deps, runtime);
        const sources = memorySources(context, scope);
        // Usage weights belong to the caller: own conversation, or the shared
        // layer when the caller explicitly searches it.
        const callerStore = scope === 'shared'
          ? context.scopes.sharedStore()
          : memorySources(context, 'session')[0].store;
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
        // Usage weights belong to the caller's conversation. A cross-conversation
        // hit must not be scored with the caller's history, even when both rows
        // happen to share a doc_id.
        const callerSource = sources.find((source) => source.store === callerStore) ?? null;
        const callerOwner = callerSource === null
          ? null
          : { key: callerSource.key ?? '', scope: callerSource.scope ?? 'session' };
        const ownedHit = (hit) => callerOwner === null || (
          (hit.origin_key ?? '') === callerOwner.key
          && (hit.origin_scope ?? 'session') === callerOwner.scope
        );
        const localRun = () => {
          const weights = typeof callerStore.knowledgeWeights === 'function'
            ? callerStore.knowledgeWeights()
            : {};
          const merged = [];
          for (const source of sources) {
            const found = source.store.search(query, {
              category: args?.category ?? null,
              mode,
              topK: Math.max(topK, 10),
              detail: 'full',
            });
            // BM25 scores are not comparable across stores because each store's
            // corpus and document frequency differ. Normalize within the store
            // before merging, so a huge score in a tiny conversation cannot
            // drown out a strong hit elsewhere.
            const sourceMax = Math.max(0, ...found.map((hit) => hit.score));
            for (const hit of found) {
              const owned = callerOwner !== null
                && (source.key ?? '') === callerOwner.key
                && (source.scope ?? 'session') === callerOwner.scope;
              const weight = owned && Number.isFinite(weights[hit.doc_id]) ? weights[hit.doc_id] : 0;
              const baseScore = sourceMax > 0 ? hit.score / sourceMax : 0;
              merged.push({
                ...hit,
                usage_weight: weight,
                score: boostScore(baseScore, weight),
                origin_label: source.label,
                origin_key: source.key,
                origin_scope: source.scope,
              });
            }
          }
          if (merged.length === 0) {
            return { empty: true, text: `没有命中「${query}」的知识文档（mode=${mode}，范围=${scope}）。` };
          }
          // Fold the same fact across conversations after scoring. Each store's
          // own dedupe gate cannot see the others, so without this one sentence
          // repeated in N conversations spends N top_k slots.
          const { hits, folded } = foldDuplicateHits(merged, topK);
          const disclosed = applyDisclosure(hits, query, detail);
          // A returned hit counts as "used" for the caller's conversation, which
          // lifts it on later searches here (and only here).
          if (typeof callerStore.recordKnowledgeUsage === 'function') {
            callerStore.recordKnowledgeUsage(disclosed.filter(ownedHit).map((hit) => hit.doc_id));
          }
          return {
            empty: false,
            text: `检索范围：${sources.map((source) => source.label).join(' + ')}`
              + '（排序含本对话最近使用权重）\n' + formatHits(query, disclosed, mode, folded, detail),
          };
        };

        let fallbackNote = '';
        if (routed.route === 'sql' && sqlResult) {
          fallbackNote = `SQL 通道未执行（${sqlResult.error ?? '无法翻译'}），已回退向量检索。\n`;
        }
        let picked;
        const effectiveForSearch = effectivePluginConfig(config);
        if (effectiveForSearch.ragMount === true) {
          const rag = await searchWithRag(effectiveForSearch, sources, query, {
            topK,
            category: args?.category ?? null,
            store: callerStore,
            owner: callerOwner,
            detail,
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
        '对不可逆或高风险操作做正反合审查：给出决策、正/反理由，以及结构化的 irreversible / recoverable_via。'
        + '高风险不再按理由字数放行（字数只进审计），而是看操作是否可逆：irreversible=true 直接拒绝；'
        + 'irreversible=false 必须同时给出 recoverable_via 才放行；缺字段返回 needs_more_info。',
      parameters: {
        decision: {
          type: 'string',
          required: true,
          description: '要执行的决策，一句话。',
        },
        risk: {
          type: 'string',
          enum: [...RISKS],
          description: '风险等级，默认 low（低风险直接放行，不浪费审查）。按操作实际影响标注；'
            + '标 low 不会让 irreversible=true 绕过审查。',
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
        irreversible: {
          type: 'boolean',
          description: '该操作是否不可逆。高风险必须明确填写；true 会被拒绝，false 需要可恢复路径。',
        },
        recoverable_via: {
          type: 'string',
          description: 'irreversible=false 时如何恢复/回滚，例如“已做数据库快照，可 restore”。',
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
            irreversible: args?.irreversible,
            recoverable_via: args?.recoverable_via,
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
        '上下文管理：save=把当前已完成对话整理进存储；clear=按话题相似度清理会话上下文（默认在下一次模型请求前执行，不等到轮末）；'
        + 'restore=把保存的上下文重新注入当前会话（不整份注入：按 restoreMaxChars 预算从尾部取最近的轮次或事件段）；'
        + 'list=列出存档；status=查看清理策略与存档状态；'
        + 'sessions=列出所有对话及其记忆规模。'
        + '手动 clear 按话题相似度：相似度低的老轮次先完整存档再清出，相似度高的保留，随时可用 restore 调回。'
        + '自动整理开启时，上下文占用达到设定百分比会做硬重置，而且是在任务进行中就做：'
        + `下一次模型请求前，按步骤清出当前轮较早的工具步骤（保留当前请求、最近 ${config.keepRecentSteps} 步和最近 keepRecentTurns 轮），`
        + '并注入续接包（当前请求 + 最近进展 + 相关记忆）后继续同一个任务，不用等到轮末；'
        + '若这一轮已经结束、没有下一次请求，则在轮末保留最近几轮后清出其余内容。'
        + '每 N 轮的自动整理仍按相似度选择，手动工具始终可用。'
        + '存档默认按对话隔离（每个对话只列出自己的），restore 默认可以跨对话找到别的对话保存过的上下文，'
        + '但只有已打开的对话可见（新建对话默认不开放）。',
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
            runtime.pending.set(String(session.id), {
              kind: 'manual',
              mode: 'immediate',
              at: new Date().toISOString(),
            });
            return '已登记立即清理：下一次模型请求前按话题相似度清理本对话上下文，不需要等到轮末。\n'
              + '当轮仍在进行，绝不会被清掉；只有已经完整的旧轮次会进入选择。\n'
              + `保留最近 ${config.keepRecentTurns} 轮（当轮与上轮始终保留）；相似度阈值 ${config.similarityThreshold}；`
              + `单次最多清出 ${config.maxClearTurns} 轮。\n`
              + '相似度高的轮次原样保留；被清出的轮次会先完整存档，之后可用 restore 调回。'
              + '如果本轮不再发起模型请求，会在本轮收尾时执行，效果等同于下轮开始前已清空。';
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
          // Restoring the whole archive can immediately undo the clear. Use a
          // separate, smaller restore budget; the newest turns win and the
          // archive remains complete for a later restore.
          const restoreBudget = Math.min(
            Number.isInteger(config.restoreMaxChars) ? config.restoreMaxChars : 12000,
            Number.isInteger(config.maxContextChars) ? config.maxContextChars : 30000,
          );
          await exec.agent.inject({
            content: [{ type: 'text', text: formatRestoreContext(found.record, { maxChars: restoreBudget }) }],
            source: { kind: 'ai-for-memory' },
          });
          return `已恢复上下文 ${found.record.context_id}（${found.source.label}，第 ${found.record.turn_from}-${found.record.turn_to} 轮），`
            + `按 ${restoreBudget} 字符预算注入，将在下一步生效。`;
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
              ? `整段压缩（compaction 服务${compaction && typeof compaction.compactNow === 'function' ? '可用' : '不可用'}）；占用阈值仍全量重置`
              : '话题相似度（手动/每 N 轮）；上下文占用达到阈值时全量清出并回载任务续接'}`,
            `相似度设置：阈值 ${config.similarityThreshold}，保留最近 ${config.keepRecentTurns} 轮，`
              + `单次最多 ${config.maxClearTurns} 轮（${config.minClearChars}~${config.maxClearChars} 字符）`,
            `恢复预算：单次 restore 最多注入 ${config.restoreMaxChars ?? 12000} 字符，从尾部取最近的轮次/事件段`,
            `自动整理：${config.autoEnabled ? `开启（每 ${config.autoEveryRounds} 轮按相似度；上下文占用到 ${config.contextUsagePercent}% 时全量重置）` : '关闭'}`,
            ...(context.gitignore?.warning ? [`⚠ ${context.gitignore.warning}`] : []),            `保留策略：staging ${config.stagingRetentionDays ?? 30} 天（仅已归档文件）；`
              + `contexts ${config.contextRetentionDays > 0 ? `${config.contextRetentionDays} 天` : '不自动删除'}；`
              + `decisions ${config.decisionRetentionDays > 0 ? `${config.decisionRetentionDays} 天` : '不自动删除'}`,            (() => {
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
            `待清理：${!session || !session.id || !runtime.pending.has(String(session.id))
              ? '否'
              : runtime.pending.get(String(session.id))?.mode === 'immediate'
                ? '是（下一次模型请求前）'
                : '是（轮末）'}`,
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
              + `｜最近 ${row.updatedAt || '未知'}${row.public !== true ? '｜未对外开放' : ''}`);
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
        + 'chat 可传 sources 作为编号来源，回答里用 [n] 标注依据，结果末尾会附「来源对照 + 调用记录」'
        + '（模型、地址、请求 id、输入 sha256、输出长度、截断状态），方便追溯一次摘要具体来自哪次调用、哪些材料。'
        + '只连插件配置的地址（externalBaseUrl 留空=未配置，不联网；示例 http://127.0.0.1:8080，填 .../v1 或完整接口地址也认），不写任何记忆。',
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
        sources: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'chat 用：可选来源材料，每项 {id?, text, url?}（字符串也可）。会编号并要求模型用 [n] 标注依据；'
            + '结果末尾附每条来源是否被引用，以及调用记录。',
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
          const rows = result.results.map((row, index) => {
            const score = Number(row.score);
            const shown = Number.isFinite(score) && score !== 0 && Math.abs(score) < 0.001
              ? score.toExponential(3)
              : (Number.isFinite(score) ? score.toFixed(4) : String(row.score));
            return `${index + 1}. 分数 ${shown}｜文档 #${row.index}：`
              + clip(String(documents[row.index] ?? ''), 120);
          });
          return [`rerank 排序（query：${clip(String(args?.query ?? ''), 80)}）：`, ...rows, describeEndpoint(endpoint)].join('\n');
        }

        if (action !== 'chat') throw new Error(`未知 action：${String(action)}`);
        const sources = normalizeChatSources(args?.sources);
        const sourcePrompt = buildChatSourcePrompt(sources, { json: args?.json === true });
        const system = [typeof args?.system === 'string' ? args.system : '', sourcePrompt]
          .filter((part) => part !== '').join('\n\n');
        let messages = args?.messages;
        if (sources.length > 0 && Array.isArray(messages) && messages.length > 0) {
          const copied = messages
            .filter((message) => message && typeof message.content === 'string')
            .map((message) => ({ ...message }));
          if (copied[0] && copied[0].role === 'system') {
            copied[0].content = `${sourcePrompt}\n\n${copied[0].content}`;
          } else {
            copied.unshift({ role: 'system', content: sourcePrompt });
          }
          messages = copied;
        }
        const inputText = Array.isArray(messages) && messages.length > 0
          ? messages.map((message) => `${message.role ?? 'user'}: ${message.content}`).join('\n')
          : `${system}\n${String(args?.prompt ?? '')}`;
        const result = await externalChat(endpoint, {
          messages,
          prompt: args?.prompt,
          system,
          temperature: args?.temperature,
          maxTokens: args?.max_tokens,
          json: args?.json === true,
        });
        if (!result.ok) return `调用外部模型失败：${result.error}`;
        const output = clip(result.text, 4000);
        const truncated = output.length < result.text.length;
        const cited = new Set();
        for (const match of result.text.matchAll(/\[(\d{1,2})\]|【(\d{1,2})】/g)) {
          const index = Number(match[1] ?? match[2]);
          if (index >= 1 && index <= sources.length) cited.add(index);
        }
        const sourceLines = sources.length > 0
          ? [`— 来源对照：传入 ${sources.length} 条，模型引用 ${cited.size} 条`]
            .concat(sources.map((source, index) => (
              `[${index + 1}] ${cited.has(index + 1) ? '✓ 已引用' : '· 未引用'}`
              + `｜${source.id}${source.url ? `｜${source.url}` : ''}`
            )))
          : [];
        return [
          output,
          '',
          formatChatTrace({ endpoint, result, inputText, output, truncated }),
          ...sourceLines,
        ].join('\n');
      },
    },
    {
      name: 'aim_repair',
      description:
        'DSH 会话日志体检与修复。DSH 把每个对话写成 session.v<N>.jsonl.zstd（多段 zstd 帧），'
        + '其中一条事件结构不合规就会让整个对话打不开（stored log is corrupt / SessionFormatError），'
        + '而 DSH 自身没有删除或修复接口。'
        + 'scan=列出 <DSH_HOME>/sessions 下的会话日志，默认只读文件头；deep=true 才异步解压并逐事件校验；'
        + 'repair=修复一份日志：先备份原文件，再优先把旧版插件写入的游离 developer 便条改写成等价的 user 便条'
        + '（保留全部历史），否则截断到第一处损坏之前并用 DSH 自带的合成收尾事件补全回合；'
        + 'compact=对结构有效但物理体积异常膨胀的日志重排 zstd 帧（事件一个不改）；'
        + '默认只预演，apply=true 才写回。修完要重新打开该对话才会重新加载。'
        + '会话日志修复依赖 Node 22.15+ 的 zstd；Node 20 上其余功能正常，诊断页会显示不可用及校验器回退原因。'
        + '不要修复当前正在进行的对话。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['scan', 'repair', 'compact'],
          description: 'scan=体检会话日志（deep=true 时解压校验）；repair=修复一份（session 必填）；compact=只重排帧缩小物理体积。',
        },
        session: {
          type: 'string',
          description: 'repair/compact 用：会话 id（session-<uuid>、裸 uuid 或唯一前缀）或 .zstd 日志的绝对路径。',
        },
        deep: {
          type: 'boolean',
          description: 'scan 用：true 时解压并校验事件结构（能发现 developer/message 错位这类损坏，但大日志较慢）。',
        },
        strategy: {
          type: 'string',
          enum: ['auto', 'salvage', 'truncate'],
          description: 'repair 用：auto=先改写便条、失败再截断（默认）；salvage=只改写；truncate=直接截断。',
        },
        apply: {
          type: 'boolean',
          description: 'repair/compact 用：true 才真正写回；默认 false 只返回预演结果。',
        },
      },
      async execute(args, exec) {
        const sessionsDir = dshSessionsDir();
        const action = typeof args?.action === 'string' ? args.action : 'scan';
        if (action === 'scan') {
          const scan = await scanSessionLogs(sessionsDir, { deep: args?.deep === true });
          return formatScanReport(scan, { limit: 40 });
        }
        if (action !== 'repair' && action !== 'compact') throw new Error(`未知 action：${String(action)}`);
        const target = resolveSessionLogTarget(sessionsDir, args?.session);
        const live = sessionOf(exec);
        if (args?.apply === true && live !== ''
          && target.id.replace(/^session-/, '') === live.replace(/^session-/, '')) {
          return '拒绝对当前正在进行的对话执行写回：它仍被 DSH 打开，改写会破坏正在追加的日志。'
            + '请先切换到其他对话，或在面板里修复后重新打开它。';
        }
        const report = await repairSessionLog(target.file, {
          strategy: typeof args?.strategy === 'string' ? args.strategy : 'auto',
          compact: action === 'compact',
          apply: args?.apply === true,
        });
        return formatRepairReport(report);
      },
    },
  ];
}

// ---- plugin entry --------------------------------------------------------

/**
 * Context management: archive and clear the conversation window with the
 * configured policy. Auto mode also does this every N turns; manual mode only
 * reacts to explicit `aim_context` tool calls. The default policy is
 * topic-aware: the turns that still share the current topic stay verbatim, and
 * only the ones the conversation has moved away from are replaced — after their
 * full text has been archived, so `restore` can always bring them back.
 *
 * A manual clear requested inside a tool call is applied at the next
 * `agent/pre-step`: the previous tool result is already committed, so the
 * surface replacement cannot split a tool call/result pair and the old context
 * is gone before the next model request. `turn/end` remains the fallback when
 * the turn does not issue another request. Subagents are skipped.
 */
/**
 * One contiguous surface prefix that a hard reset may replace, or `null`.
 *
 * A hard reset promises "archive everything, then leave only what the task in
 * progress still needs". Two things used to break that promise:
 *
 * - Per-turn ranges: one earlier partial clear leaves a turn whose nodes are no
 *   longer contiguous, `turnRange` refuses it forever, and the reset degrades
 *   into "clear the newest turn" on every pass.
 * - Turn granularity: a real DSH task is one long turn full of tool steps, so
 *   "keep the running turn" keeps the whole window and a mid-task reset can
 *   never fire at all.
 *
 * The prefix form has neither problem: it starts right after the system prompt
 * and ends at the first node of the block being kept, so it is contiguous by
 * construction. Inside the running turn the kept block starts at a **step**
 * boundary (the last `keepRecentSteps` steps stay verbatim), and a step
 * boundary is safe because every tool call is answered by a `tool/result`
 * before the next step starts — the cut never lands between a call and its
 * result.
 *
 * @param {object} session live DSH session (needs `surface.nodes` and `eventAt`)
 * @param {Array<object>} turns `collectTurns()` output, oldest first
 * @param {number|{keepRecentTurns?: number, keepRecentSteps?: number}} options
 *   a number keeps the same meaning as `keepRecentTurns`
 * @returns {{run: object, keptTurns: Array<object>}|null}
 */
export function planPrefixReset(session, turns, options = 1) {
  const resolved = typeof options === 'number'
    ? { keepRecentTurns: options, keepRecentSteps: 0 }
    : (options && typeof options === 'object' ? options : {});
  const nodes = session?.surface && Array.isArray(session.surface.nodes)
    ? session.surface.nodes : null;
  if (!nodes || nodes.length <= 1) return null;
  const position = new Map();
  nodes.forEach((seq, index) => position.set(seq, index));
  const keepTurnCount = Math.max(1, Number.isFinite(Number(resolved.keepRecentTurns))
    ? Number(resolved.keepRecentTurns) : 1);
  const keepStepCount = Math.max(0, Number.isFinite(Number(resolved.keepRecentSteps))
    ? Number(resolved.keepRecentSteps) : 0);
  const list = Array.isArray(turns) ? turns : [];
  const completed = list.filter((turn) => turn.inFlight !== true);
  const inFlight = list.filter((turn) => turn.inFlight === true);
  const keptTurns = [
    ...completed.slice(Math.max(0, completed.length - keepTurnCount)),
    ...inFlight,
  ];
  // Node 0 is the system prompt whenever it holds one, and a clear never
  // shadows it; a session whose first node is already a message may clear from 0.
  const eventAt = typeof session.eventAt === 'function'
    ? (seq) => session.eventAt(seq) : () => undefined;
  const head = eventAt(nodes[0]);
  const firstClearIndex = head && head.type === 'system/message' ? 1 : 0;

  // The kept block starts at the earliest still-visible node of any kept turn.
  // A kept turn that is already fully shadowed contributes nothing.
  let keepIndex = nodes.length;
  const keptCompleted = keptTurns.filter((turn) => turn.inFlight !== true);
  for (const turn of keptCompleted) {
    for (const seq of Array.isArray(turn.seqs) ? turn.seqs : []) {
      const index = position.get(seq);
      if (index !== undefined && index < keepIndex) keepIndex = index;
    }
  }
  // Step granularity inside the running turn: keep only its newest steps, and
  // cut at the first surface node of the earliest kept step.
  if (keepStepCount > 0 && inFlight.length > 0) {
    for (const turn of inFlight) {
      const stepStart = new Map();
      // A real user message carries no turn/step of its own, so the running
      // turn's first node has to come from its collected `seqs`, not from
      // `data.turn` on individual events.
      let turnFirst = nodes.length;
      for (const seq of Array.isArray(turn.seqs) ? turn.seqs : []) {
        const index = position.get(seq);
        if (index !== undefined && index < turnFirst) turnFirst = index;
      }
      for (let index = firstClearIndex; index < nodes.length; index += 1) {
        const event = eventAt(nodes[index]);
        if (!event || event.data?.turn !== turn.turn) continue;
        const step = Number(event.data?.step);
        if (!Number.isInteger(step)) continue;
        if (!stepStart.has(step)) stepStart.set(step, index);
      }
      const steps = [...stepStart.keys()].sort((left, right) => left - right);
      if (steps.length <= keepStepCount || steps.length === 0) {
        // Too few steps to trim: keep the whole running turn. Without this the
        // second reset would clear the steps the first one deliberately kept.
        if (turnFirst < keepIndex) keepIndex = turnFirst;
        continue;
      }
      // Prefer the newest kept step boundary. A boundary right after an
      // assistant message that still owns tool calls is unsafe: the matching
      // results live in the next step, so the range would end in an unanswered
      // call. Step back one step instead of skipping the trim: giving up here
      // would leave keepIndex at the end and clear the whole running turn.
      let safeCut = null;
      for (let pick = steps.length - keepStepCount; pick >= 0; pick -= 1) {
        const candidate = stepStart.get(steps[pick]);
        if (!Number.isInteger(candidate) || candidate <= firstClearIndex) break;
        const before = eventAt(nodes[candidate - 1]);
        const ownsToolCalls = before?.type === 'assistant/message'
          && Array.isArray(before.data?.message?.content)
          && before.data.message.content.some((block) => block?.type === 'tool-call');
        if (!ownsToolCalls) {
          safeCut = candidate;
          break;
        }
      }
      if (safeCut !== null) {
        if (safeCut < keepIndex) keepIndex = safeCut;
      } else if (turnFirst < keepIndex) {
        // Even the earliest step boundary is unsafe (or starts at the clear
        // boundary): keep the whole running turn rather than clearing it down
        // to the request, which is what the old `continue` fallback did.
        keepIndex = turnFirst;
      }
    }
  }
  if (keepIndex <= firstClearIndex) return null;
  // Keep the running turn's preamble: its user request and the harness
  // reminders that arrived with it are the only copy of what this task *is*.
  // The raw steps are what grows, so a mid-task clear starts at the first
  // assistant node of the running turn and leaves the request itself visible
  // (in the transcript as well as to the model).
  let clearFromIndex = firstClearIndex;
  if (inFlight.length > 0) {
    const runningTurn = inFlight[inFlight.length - 1].turn;
    for (let index = firstClearIndex; index < keepIndex; index += 1) {
      const event = eventAt(nodes[index]);
      if (event?.type === 'assistant/message' && event.data?.turn === runningTurn) {
        clearFromIndex = index;
        break;
      }
    }
  }
  if (keepIndex <= clearFromIndex) return null;
  // A prefix that holds nothing but the plugin's own notices is not worth a
  // replacement: it would archive a note and write a new one, forever.
  let hasRealContent = false;
  for (let index = clearFromIndex; index < keepIndex; index += 1) {
    const event = eventAt(nodes[index]);
    if (event?.data?.source?.kind !== 'ai-for-memory') { hasRealContent = true; break; }
  }
  if (!hasRealContent) return null;
  const startSeq = nodes[clearFromIndex];
  const endSeq = nodes[keepIndex - 1];
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || endSeq < startSeq) return null;
  // Only fully completed turns are archived as turns: a running turn is cut in
  // the middle, and its kept tail is still in the window, so listing it as
  // "cleared" would duplicate it on restore. Its removed steps are still kept
  // in `raw_events`.
  const cleared = list.filter((turn) => turn.inFlight !== true
    && (Array.isArray(turn.seqs) ? turn.seqs : []).some((seq) => seq >= startSeq && seq <= endSeq));
  return {
    keptTurns,
    clearedTurns: cleared,
    currentTurn: inFlight.length > 0 ? inFlight[inFlight.length - 1].turn : null,
    run: {
      turns: cleared,
      seqs: nodes.slice(clearFromIndex, keepIndex),
      startSeq,
      endSeq,
      startIdx: clearFromIndex,
      endIdx: keepIndex - 1,
      chars: cleared.reduce((sum, turn) => sum + Number(turn.chars ?? 0), 0),
      similarity: 0,
    },
  };
}

export function installContextManagement(ctx, config, deps, runtime) {
  const counters = runtime?.counters ?? new Map();
  const pending = runtime?.pending ?? new Map();
  const retentionChecked = runtime?.retentionChecked ?? new Map();
  const anchorState = runtime?.anchorState ?? new Map();
  const pressureResets = runtime?.pressureResets ?? new Map();
  const getService = deps.getService ?? (() => undefined);

  // ---- local engine lifecycle ---------------------------------------------
  // The three modes are deliberately narrow: they only ever touch runnable
  // llama.cpp models that the catalog discovered on disk. A missing GGUF
  // binary, an unreachable service or a model without `llama-server` support
  // produces one warning and a 60s cooldown instead of a start attempt every
  // turn.
  const ENGINE_START_COOLDOWN_MS = 60000;
  const engineStartFailures = new Map();
  const engineTurnStarted = new Set();
  // Main-session turns currently running. A per-turn stop waits until this is
  // empty so one conversation ending cannot kill an engine another one uses.
  const activeTurns = new Set();

  /**
   * A configured endpoint that already answers wins over auto-start: the local
   * engine is the fallback for "no service configured" and "the configured
   * service is down". Probes are short and cached inside the gate.
   */
  const endpointGate = createEndpointGate();

  const runnableEngineModels = () => {
    let catalog;
    try {
      catalog = listLocalModelsCached();
    } catch {
      return [];
    }
    const models = [];
    for (const category of catalog?.categories ?? []) {
      for (const model of category?.models ?? []) {
        if (model?.runnable !== true) continue;
        const kind = String(model.kind ?? '').toLowerCase();
        if (kind !== 'embedding' && kind !== 'rerank') continue;
        if (model.engine !== '' && model.engine !== 'llama.cpp') continue;
        models.push({ id: model.id, kind });
      }
    }
    return models;
  };

  /**
   * Start the runnable local models that are not already up.
   *
   * A configured endpoint wins when it answers: the local engine is the
   * fallback for "no service configured" and "configured service is down", so a
   * reachable endpoint (the usual manually managed llama-server, or a cloud
   * provider) must not be duplicated by a second process on another port.
   */
  const ensureLocalEngines = async (mode) => {
    if (mode !== 'always' && mode !== 'turn') return;
    const models = runnableEngineModels();
    if (models.length === 0) return;
    const statuses = new Map(localEngineStatus().map((engine) => [engine.id, engine]));
    for (const { id, kind } of models) {
      const status = statuses.get(id);
      if (status?.ready === true || status?.starting === true) continue;
      if ((engineStartFailures.get(id) ?? 0) > Date.now()) continue;
      if (await endpointGate.configuredEndpointReachable(kind, config)) {
        // The service the user configured already answers; do not start a
        // second one just because a runnable GGUF exists on disk.
        continue;
      }
      // Record before the async start: if the turn ends while the model is
      // still loading, the turn-end stop must know it owns that process.
      if (mode === 'turn') engineTurnStarted.add(id);
      void startLocalEngine({ modelId: id }).then((result) => {
        if (result?.ok === true) {
          engineStartFailures.delete(id);
          // An adopted process (left over from before this plugin load) is not
          // owned by this turn; never stop it just because a turn ended.
          if (result.engine?.adopted === true) engineTurnStarted.delete(id);
          return;
        }
        engineStartFailures.set(id, Date.now() + ENGINE_START_COOLDOWN_MS);
        // eslint-disable-next-line no-console
        console.warn(`[ai-for-memory] 本地引擎自动启动失败：${id}：${result?.error ?? '未知错误'}`);
      }).catch((error) => {
        engineStartFailures.set(id, Date.now() + ENGINE_START_COOLDOWN_MS);
        // eslint-disable-next-line no-console
        console.warn(`[ai-for-memory] 本地引擎自动启动失败：${id}：${error?.message ?? error}`);
      });
      // Do not await the model load: the pre-step caller must never wait for
      // it, and the next ensure sees `starting` and skips the duplicate.
    }
  };

  const stopTurnLocalEngines = async () => {
    const ids = [...engineTurnStarted];
    engineTurnStarted.clear();
    for (const id of ids) {
      try {
        await stopLocalEngine(id);
        // eslint-disable-next-line no-console
        console.log(`[ai-for-memory] 每轮模式：已停止本地引擎 ${id}`);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[ai-for-memory] 每轮模式停止本地引擎失败：${id}：${error?.message ?? error}`);
      }
    }
  };

  const HARNESS_USER_RE = /^(Time sampled while preparing turn|This is an automatically generated checkpoint|Current runtime context|Current working directory|Current DSH file policy|Current DSH implementation checkout|Browser time zone|Elapsed since|Updated Tool Schemas)/i;

  const textOfUserEvent = (event) => {
    const content = event?.data?.content;
    if (!Array.isArray(content)) return '';
    return content.filter((item) => item && item.type === 'text').map((item) => item.text ?? '').join('\n').trim();
  };

  const textOfUserMessage = (message) => {
    const content = message?.content;
    if (!Array.isArray(content)) return '';
    return content.filter((item) => item && item.type === 'text').map((item) => item.text ?? '').join('\n').trim();
  };

  /**
   * True only when the whole user turn is harness/checkpoint text. Do not treat
   * a real request that merely starts with a checkpoint header as harness text;
   * doing so made the anchor fall back to the previous request.
   */
  const isHarnessText = (text) => {
    const value = String(text ?? '');
    if (/^\s*<system-reminder>/i.test(value)) return true;
    const stripped = value.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ').trim();
    if (stripped === '') return true;
    const lines = stripped.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return true;
    return lines.every((line) => HARNESS_USER_RE.test(line)
      || /^(Elapsed since|Browser time zone|Current DSH|Current working directory|Current runtime context|Time sampled while preparing turn|This is an automatically generated checkpoint|Updated Tool Schemas)/i.test(line));
  };

  /** The newest real user request in this exact model step, if visible. */
  const incomingRequestText = (payload) => {
    const incoming = Array.isArray(payload?.messages) ? payload.messages : [];
    for (let index = incoming.length - 1; index >= 0; index -= 1) {
      const message = incoming[index];
      if (message?.role !== 'user' || message?.source?.kind === 'ai-for-memory') continue;
      const text = textOfUserMessage(message);
      if (text !== '' && !isHarnessText(text)) return text;
    }
    return '';
  };

  /**
   * When a harness checkpoint/schema notice arrives as the newest "user"
   * message, keep the last real request in view with one short developer note.
   * This is deliberately not an every-request memory injection: it only fires
   * when the newest input is not a real user request.
   */
  const maybeAnchorRequest = async (session, payload) => {
    if (config.requestAnchor === false || payload?.signal?.aborted) return;
    if (session?.header?.parentSession) return;
    // Only the first step of a turn may carry the anchor. From the second step
    // on, `payload.messages` holds tool results, so "no new user request" is
    // true for a reason that has nothing to do with a checkpoint. Injecting a
    // request note there put a second user-role task statement *inside* the
    // running turn; after that every following step competed with it, and the
    // model kept answering the request it named instead of the newest one.
    const step = Number(payload?.step);
    if (Number.isFinite(step) && step > 1) return;
    const events = typeof session.ownEvents === 'function' ? session.ownEvents() : [];
    // `payload.messages` is exactly what will enter this step. If it already
    // contains a real user request, never inject a stale anchor: a checkpoint
    // and the next request can arrive together, and the anchor used to run
    // before the request was visible in `ownEvents`.
    const hasIncomingRequest = incomingRequestText(payload) !== '';
    if (hasIncomingRequest) return;
    let latestUser = null;
    let realRequest = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'user/message') continue;
      // Never treat a plugin-authored notice as the real user request.
      if (event?.data?.source?.kind === 'ai-for-memory') continue;
      const text = textOfUserEvent(event);
      if (text === '') continue;
      if (latestUser === null) latestUser = { seq: event.seq, text };
      if (!isHarnessText(text)) {
        realRequest = { seq: event.seq, text };
        break;
      }
    }
    if (latestUser === null || realRequest === null) return;
    if (!isHarnessText(latestUser.text)) return;
    // The anchor restates a request *as user input*, so only a request that is
    // still visible may be restated. A cleared request must stay cleared:
    // re-injecting it is the same "answer an older turn" failure through
    // another door.
    const nodes = session?.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : null;
    if (nodes !== null && !nodes.includes(realRequest.seq)) return;
    const id = String(session.id);
    const previous = anchorState.get(id);
    if (previous && previous.requestSeq === realRequest.seq) return;
    const anchor = clip(realRequest.text, 260);
    try {
      // Same carrier rule as clear notes: user-visible/model-visible, but
      // tagged as an ai-for-memory notice rather than genuine user input.
      session.append('user/message', {
        id: randomUUID(),
        role: 'user',
        source: {
          kind: 'ai-for-memory',
          form: 'notice',
          summary: '当前请求锚点',
        },
        content: [{
          type: 'text',
          text: `【上一轮请求参考】最后一条真实用户请求：${anchor}\n`
            + '这是内部提醒，不是新请求。如果本次已经有更新的用户输入，以新输入为准；'
            + '系统时间、工具 schema 更新、插件重载都不是新任务。',
        }],
      }, { surfaceOp: 'append' });
      anchorState.set(id, { latestSeq: latestUser.seq, requestSeq: realRequest.seq });
    } catch {
      // A surface that cannot take the anchor must not break pre-step.
    }
  };

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
      if (existing === null) patch.public = config.defaultPublic === true;
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

  /** Shared-layer store, or `undefined` when this profile has no shared layer. */
  const sharedStoreOfSession = (session) => {
    try {
      const context = memoryContext(config, { agent: { session } }, deps, runtime);
      return context.scopes.sharedStore();
    } catch {
      return undefined;
    }
  };

  /**
   * Compact "related memory" lines for a mid-task reset brief.
   *
   * Clearing mid-task must not mean forgetting the project: what leaves is the
   * raw step-by-step transcript, not the facts. Knowledge that matches the
   * running request is restated in the brief inside a small budget, so the
   * model continues with the same rules and constraints instead of rediscovering
   * them (or inventing them).
   *
   * @returns {string} `- line` rows, or `''` when nothing matches
   */
  const relatedMemoryLines = (store, sharedStore, query) => {
    const text = String(query ?? '').trim();
    if (text === '') return '';
    const lines = [];
    let used = 0;
    const seen = new Set();
    for (const candidate of [store, sharedStore]) {
      if (!candidate || typeof candidate.search !== 'function') continue;
      let hits = [];
      try {
        hits = candidate.search(text, {
          topK: RESET_RELATED_LIMIT,
          detail: 'summary',
          mode: 'hybrid',
        }) ?? [];
      } catch {
        continue;
      }
      for (const hit of hits) {
        const body = String(hit?.text ?? '').replace(/\s+/g, ' ').trim();
        if (body === '' || seen.has(body)) continue;
        seen.add(body);
        const line = `- ${clip(body, 220)}`;
        if (used + line.length > RESET_RELATED_CHARS) break;
        lines.push(line);
        used += line.length + 1;
        if (lines.length >= RESET_RELATED_LIMIT) break;
      }
      if (lines.length >= RESET_RELATED_LIMIT) break;
    }
    return lines.join('\n');
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
    // A mid-task reset clears steps of the running turn, which carry no turn
    // number of their own; describe that case instead of claiming turns left.
    const removed = run.turns.length > 0
      ? describeTurns(run.turns, run.similarity)
      : `本轮较早的 ${run.seqs.length} 个步骤`;
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
    // Keep the note model-visible, but tag it as plugin-authored context rather
    // than typing it as user input. DSH's developer/message is a tool/system
    // update (and can fail provider projection), so the stable carrier is a
    // user message with a `notice` source. Real user input keeps kind `user`.
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: `【上下文清理】${removed}已清出当前上下文，`
          + (modelNote !== '' ? `${modelNote}\n` : '')
          + `原文完整保存在本对话的记忆存档 ${contextId}。`
          + `需要时调用 aim_context restore（context_id=${contextId}）即可调回。`,
      }],
      source: {
        kind: 'ai-for-memory',
        form: 'notice',
        summary: clip(`上下文清理：${removed}`, 120),
      },
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
    const signal = options.signal;
    const pressureFallback = options.pressureFallback === true;
    const hardReset = options.hardReset === true;
    const hardReload = options.hardReload === true;
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
      if (signal?.aborted) return;
      const events = session.ownEvents();
      const turns = collectTurns(events);
      if (turns.length === 0) {
        record({ state: 'skipped', reason: 'empty' });
        return;
      }
      // At `agent/pre-step` the current turn is already open. It stays in the
      // list because it is the best topic anchor for the request that is about
      // to be sent, but it is never a clear candidate: its surface range is
      // still growing and removing it would drop the tool call/result that is
      // about to be committed.
      const selection = selectTurnsByTopic(turns, {
        threshold: config.similarityThreshold,
        keepRecent: config.keepRecentTurns,
        anchorTurns: 2,
      });
      let clearTurns = selection.clear.filter((turn) => turn.inFlight !== true);
      let resetPlan = null;
      if (hardReset) {
        // Hard reset is a single prefix replacement: everything before the
        // newest completed turns goes, and inside the running turn only its
        // newest steps stay. Without the prefix form, fragmented turns made
        // every reset clear just one turn; without the step form, a long
        // single-turn task could never be cleared while it was running.
        resetPlan = planPrefixReset(session, turns, {
          keepRecentTurns: config.keepRecentTurns,
          keepRecentSteps: config.keepRecentSteps,
        });
        if (!resetPlan) {
          record({
            state: 'skipped',
            reason: '没有可安全清理的旧轮次',
            kept: turns.length,
            cleared: 0,
          });
          return;
        }
        clearTurns = resetPlan.run.turns;
      } else if (pressureFallback) {
        const selectedChars = clearTurns.reduce((sum, turn) => sum + Number(turn.chars ?? 0), 0);
        const candidates = turns.filter((turn) => turn.inFlight !== true);
        const fallback = candidates.slice(0, Math.max(0, candidates.length - config.keepRecentTurns));
        if (fallback.length > 0 && (clearTurns.length === 0 || selectedChars < config.minClearChars)) {
          clearTurns = fallback;
        }
      }
      if (clearTurns.length === 0 && !resetPlan) {
        record({
          state: 'skipped',
          reason: '全部轮次都与当前话题相关',
          kept: selection.keep.length,
          cleared: 0,
          threshold: selection.threshold,
        });
        return;
      }
      const runs = resetPlan ? [resetPlan.run] : groupRuns(session, clearTurns);
      if (runs.length === 0) {
        record({ state: 'skipped', reason: '没有可安全清理的连续轮次', kept: selection.keep.length, cleared: 0 });
        return;
      }

      // Budget is applied oldest first: the turns furthest from the current
      // topic go first, and every chosen turn must fit in the archive.
      const chosen = [];
      let chars = 0;
      let turnCount = 0;
      if (resetPlan) {
        // A hard reset is all-or-nothing: do not leave a tail of old turns just
        // because maxClearTurns/maxClearChars is smaller than the whole window.
        chosen.push(resetPlan.run);
        chars = resetPlan.run.chars;
        turnCount = resetPlan.run.turns.length;
      } else {
        for (const run of runs) {
          if (turnCount + run.turns.length > config.maxClearTurns) break;
          if (chars + run.chars > config.maxClearChars) break;
          chosen.push(run);
          chars += run.chars;
          turnCount += run.turns.length;
        }
      }
      if (chosen.length === 0) {
        record({ state: 'skipped', reason: '超出单次清理预算' });
        return;
      }
      if (chars < config.minClearChars && !pressureFallback && !resetPlan) {
        record({ state: 'skipped', reason: '可清理内容太少', chars, cleared: 0 });
        return;
      }

      const clearedTurns = chosen.flatMap((run) => run.turns);
      // A mid-task reset can clear only the running turn's earlier steps. Those
      // are not turns, so `snapshotOfTurns` has nothing to render; the archive
      // still needs a record because `raw_events` is the only complete copy.
      const partialOnly = resetPlan !== null && clearedTurns.length === 0;
      const partialTurn = Number.isInteger(resetPlan?.currentTurn) ? resetPlan.currentTurn : 0;
      const snapshot = snapshotOfTurns(clearedTurns, { maxChars: Infinity })
        ?? (partialOnly ? {
          turns: [],
          text: `（第 ${partialTurn} 轮进行中：已清出 ${resetPlan.run.seqs.length} 个早期步骤节点，`
            + '节点原文见 raw_events，可用 aim_context restore 调回）',
          turnFrom: partialTurn,
          turnTo: partialTurn,
          turnCount: 0,
          chars: 0,
        } : null);
      if (!snapshot) {
        record({ state: 'skipped', reason: '没有可归档的清理内容', cleared: 0 });
        return;
      }
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
      // The step may have been cancelled while the summary was generated.
      // Never mutate the surface after an abort.
      if (signal?.aborted) return;
      const clearedNumbers = new Set(clearedTurns.map((turn) => turn.turn));
      const newestVisibleUser = [...turns].reverse()
        .find((turn) => !clearedNumbers.has(turn.turn) && turn.user)?.user ?? '';
      const latestUser = newestVisibleUser
        || ([...turns].reverse().find((turn) => turn.user)?.user ?? '');
      // At pre-step the exact incoming request in payload.messages is more
      // authoritative than the last event in ownEvents, which can still be the
      // previous turn when a checkpoint and a new request arrive together.
      const taskRequest = String(options.taskRequest ?? '').trim() || latestUser;
      // Progress means the newest kept output, including the running turn: with
      // step-level clearing the most recent progress is inside this turn.
      const latestAssistant = [...turns].reverse()
        .find((turn) => !clearedNumbers.has(turn.turn) && turn.assistant)?.assistant ?? '';
      const related = hardReset && hardReload
        ? relatedMemoryLines(store, sharedStoreOfSession(session), taskRequest)
        : '';
      const taskBrief = hardReset && hardReload
        ? '【任务续接】插件在进行中清出了旧上下文后写的续接包，不是新的用户请求，请继续当前任务。\n'
          + `当前请求：${clip(taskRequest, 360)}`
          + (latestAssistant === '' ? '' : `\n最近进展：${clip(latestAssistant, 420)}`)
          + (related === '' ? '' : `\n相关记忆（来自本对话记忆库，仅供参照）：\n${related}`)
        : '';
      const replacementNote = [modelNote, taskBrief].filter((text) => text !== '').join('\n');
      // Keep the raw event rows as well. The rendered `turns` above
      // deliberately cap text for display, but restore needs tool calls,
      // developer messages and complete tool results that exist nowhere else.
      const rawRanges = chosen.map((run) => [run.startSeq, run.endSeq]);
      const rawEvents = events
        .filter((event) => Number.isInteger(event?.seq)
          && rawRanges.some(([start, end]) => event.seq >= start && event.seq <= end))
        .filter((event) => ['turn/start', 'turn/end', 'developer/message', 'user/message',
          'assistant/message', 'tool/call', 'tool/result'].includes(event.type))
        .map((event) => ({ type: event.type, data: event.data, seq: event.seq }));
      // Archive first: nothing leaves the window before it is restorable.
      const saved = store.saveContext({
        label,
        sessionId: String(session.id),
        ...snapshot,
        raw_events: rawEvents,
        ...(replacementNote === '' ? {} : { model_summary: replacementNote }),
      });

      let shadowed = 0;
      const lastRun = chosen[chosen.length - 1];
      for (const run of chosen) {
        // Only the final replacement carries the task brief; repeating it in
        // every run would waste tokens.
        clearRun(session, run, saved.context_id, run === lastRun ? replacementNote : modelNote);
        shadowed += run.seqs.length;
      }
      record({
        state: hardReset ? 'reset' : 'done',
        session: String(session.id),
        cleared: shadowed,
        turns: turnCount,
        chars,
        kept: resetPlan ? resetPlan.keptTurns.length : selection.keep.length,
        context: saved.context_id,
        threshold: selection.threshold,
      });
      // eslint-disable-next-line no-console
      console.log(`[ai-for-memory] ${hardReset ? '已全量清出' : '已按话题相似度清出'} ${turnCount} 轮 / ${shadowed} 个节点`
        + `（保留 ${resetPlan ? resetPlan.keptTurns.length : selection.keep.length} 轮），存档 ${saved.context_id}`);
      return shadowed > 0;
    };

    // Pre-step mode: run the exact same selection and archive synchronously
    // (to the caller) before the next model request is built. The agent is
    // still in its running phase here, but no tool call is pending: the
    // previous step's tool result has already been committed, so replacing a
    // completed run cannot split a tool call/result pair.
    if (options.immediate === true) {
      return clearNow().catch((error) => {
        record({ state: 'error', session: String(session.id), error: String(error?.message ?? error), via: 'pre-step' });
        // eslint-disable-next-line no-console
        console.error(`[ai-for-memory] 上下文立即清理失败：${error?.message ?? error}`);
      });
    }

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

  /**
   * At the model-request boundary, a window already over the configured usage
   * threshold gets a hard reset: archive every completed turn, remove it, then
   * reload a tiny task brief (current request + latest progress). This is the
   * "delete all, reload the active task" path. The current in-flight turn is
   * excluded because its tool call/result pair is not committed yet.
   */
  /** Last real user message sequence in this session, for reset suppression. */
  const latestUserSeq = (events) => {
    for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'user/message') continue;
      if (event?.data?.source?.kind === 'ai-for-memory') continue;
      if (Number.isInteger(event.seq)) return event.seq;
    }
    return -1;
  };

  const maybePressureReset = async (session, payload) => {
    if (!session || typeof session.ownEvents !== 'function') return false;
    if (session.header?.parentSession) return false;
    if (pending.has(String(session.id))) return false;
    if (config.autoEnabled !== true || payload?.signal?.aborted) return false;
    const pressure = contextPressureOf(session);
    if (!exceedsUsageThreshold(pressure, config.contextUsagePercent)) return false;
    const id = String(session.id);
    const events = session.ownEvents();
    const turns = collectTurns(events);
    const currentTurn = turns[turns.length - 1]?.turn ?? 0;
    // A real task is one turn of many steps, so `{turn, seq}` stays identical
    // for the whole task and one reset would suppress every later one. The
    // measured prompt size is the only thing that changes when a new request
    // has been sent, so it belongs in the key: after a reset the next request
    // reports a fresh (smaller) size, which makes the next reset eligible.
    const resetKey = {
      turn: currentTurn,
      seq: latestUserSeq(events),
      tokens: Number.isFinite(Number(pressure?.pressureTokens))
        ? Number(pressure.pressureTokens) : null,
    };
    const previous = pressureResets.get(id);
    // Suppress only while nothing has been measured since the last reset.
    if (previous && typeof previous === 'object'
      && previous.turn === resetKey.turn && previous.seq === resetKey.seq
      && previous.tokens === resetKey.tokens) return false;
    const percent = usagePercentOf(pressure);
    const cleared = await runTopicalClear(session, {
      label: `auto-pressure-${percent}pct`,
      hardReset: true,
      hardReload: true,
      immediate: true,
      signal: payload.signal,
      taskRequest: incomingRequestText(payload),
    });
    // Only suppress another reset for this request when something was actually
    // removed. A skipped attempt must be allowed to retry at the next step.
    if (cleared !== true) return false;
    pressureResets.set(id, resetKey);
    return true;
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
    if (config.topicalClear === false && meta.reason !== 'usage') {
      runCompaction(session);
      return;
    }
    const label = kind === 'manual'
      ? 'before-clear'
      : meta.reason === 'usage'
        ? `auto-usage-${meta.percent ?? config.contextUsagePercent}pct`
        : `auto-${config.autoEveryRounds}rounds`;
    runTopicalClear(session, {
      label,
      // Usage pressure is a hard reset: the whole completed window is archived
      // and removed. Pre-step resets reload a task brief; turn/end resets are
      // the "task is ending" case and leave no old context behind.
      hardReset: kind === 'auto' && meta.reason === 'usage',
      hardReload: false,
      // Every-N-rounds is also a scheduled pass: if topic similarity rejects
      // everything, clear the oldest completed turns instead of silently
      // deferring the trigger.
      pressureFallback: kind === 'auto',
    });
  };

  /** Keep automatic snapshots at or below the cap, deleting near-duplicates first. */
  const pruneAutoSnapshots = (store, max) => {
    const rows = store.listSnapshots().filter(isAutoSnapshot);
    if (rows.length <= max) return [];
    const entries = [];
    for (const row of rows) {
      const data = store.loadSnapshot(row.snapshot_id);
      if (!data) continue;
      entries.push({
        snapshot_id: row.snapshot_id,
        name: row.name,
        timestamp: row.timestamp,
        state: data.state,
      });
    }
    const plan = planSnapshotPrune(entries, { max });
    for (const removed of plan.removed) store.removeSnapshot(removed.snapshot_id);
    return plan.removed;
  };

  const snapshotCounters = runtime.snapshotCounters instanceof Map
    ? runtime.snapshotCounters
    : new Map();
  runtime.snapshotCounters = snapshotCounters;

  /**
   * Manual clear requested from inside a tool call cannot rewrite the surface
   * yet: the current step still owns a pending tool call, and a replacement
   * appended now would land between that call and its result. Run it at the
   * next `agent/pre-step` instead — after the previous tool result is
   * committed and before the next model request is built. That releases the
   * old context inside the same turn rather than at `turn/end`.
   */
  const onPreStep = async (payload, next) => {
    const proceed = typeof next === 'function' ? next : () => undefined;
    const session = payload?.agent?.session;
    if (!session || !session.id) return proceed();
    const id = String(session.id);
    const request = pending.get(id);
    // `turn` and `always` modes start runnable local models before the first
    // model request of a turn; the start is fire-and-forget so a slow model
    // load never delays the request (evidence/RAG falls back until it is up).
    // A configured endpoint that already answers suppresses the start entirely.
    if (!Boolean(session.header?.parentSession)) void ensureLocalEngines(config.engineLifecycle);
    if (!request || typeof request !== 'object' || request.mode !== 'immediate') {
      await maybePressureReset(session, payload);
      await maybeAnchorRequest(session, payload);
      return proceed();
    }
    // An aborted step must not rewrite the surface; leave the request for the
    // next usable boundary.
    if (payload.signal?.aborted) return proceed();
    try {
      await runTopicalClear(session, {
        label: 'before-clear',
        immediate: true,
        signal: payload.signal,
      });
    } finally {
      // Only consume the exact request this handler started with; a newer
      // manual request queued meanwhile must survive.
      if (pending.get(id) === request) pending.delete(id);
    }
    await maybeAnchorRequest(session, payload);
    return proceed();
  };

  const onSessionEvent = (session, event) => {
    if (!session || !event) return;
    const id = String(session.id);
    const isSubagent = Boolean(session.header?.parentSession);
    if (event.type === 'turn/start') {
      if (!isSubagent) {
        activeTurns.add(id);
        void ensureLocalEngines(config.engineLifecycle);
      }
      return;
    }
    if (event.type !== 'turn/end') return;
    if (!isSubagent) activeTurns.delete(id);

    // `turn`: stop exactly the engines this mode started for this turn. A model
    // the user started by hand (or one adopted from a previous DSH process) is
    // not in `engineTurnStarted`, so switching modes never kills a manual run.
    // The stop is deferred while another main conversation is still running.
    if (!isSubagent && config.engineLifecycle === 'turn' && activeTurns.size === 0) {
      void stopTurnLocalEngines();
    }

    // Conversations are the unit of independence, so activity is recorded for
    // every one of them; the panel uses it to default to "the conversation in use".
    if (!isSubagent) {
      markActivity(runtime, id);
      // Fallback for conversations that predate this plugin load: ensure the
      // directory exists and refresh the generated title.
      rememberConversation(session);
      // Retention is independent of auto-ledger tidying. Without this, the
      // default stagingRetentionDays=30 would never run unless autoEnabled was
      // on or the user manually archived something.
      if ((Number.isFinite(config.stagingRetentionDays) ? config.stagingRetentionDays : 30) > 0
        || (Number.isFinite(config.contextRetentionDays) ? config.contextRetentionDays : 0) > 0
        || (Number.isFinite(config.decisionRetentionDays) ? config.decisionRetentionDays : 0) > 0) {
        try {
          const context = memoryContext(config, { agent: { session } }, deps, runtime);
          const store = writeSource(context, 'session').store;
          const day = new Date().toISOString().slice(0, 10);
          if (retentionChecked.get(store.root) !== day) {
            retentionChecked.set(store.root, day);
            store.pruneRetention();
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn(`[ai-for-memory] 保留策略清理失败：${error?.message ?? error}`);
        }
      }
    }

    // Automatic exact snapshots run independently of the tidying switch: every
    // N turns the recent window is written to snapshots/. They are deliberately
    // not tied to `autoEnabled`, so a conversation can keep checkpoints while
    // automatic clearing stays off. Subagents never write them.
    if (!isSubagent && config.autoSnapshot !== false) {
      const count = (snapshotCounters.get(id) ?? 0) + 1;
      if (count >= config.autoSnapshotEvery) {
        snapshotCounters.delete(id);
        try {
          const context = memoryContext(config, { agent: { session } }, deps, runtime);
          const store = writeSource(context, 'session').store;
          const built = buildContextSnapshot(session.ownEvents(), { maxChars: config.maxContextChars });
          if (built) {
            const info = store.snapshot({
              name: `${AUTO_SNAPSHOT_PREFIX}t${built.turnTo}`,
              state: {
                kind: 'auto-snapshot',
                session_id: id,
                turn_from: built.turnFrom,
                turn_to: built.turnTo,
                turn_count: built.turnCount,
                chars: built.chars,
                text: built.text,
              },
              metadata: {
                kind: 'auto-snapshot',
                session_id: id,
                turn_from: built.turnFrom,
                turn_to: built.turnTo,
              },
            });
            const removed = pruneAutoSnapshots(store, config.autoSnapshotMax);
            // eslint-disable-next-line no-console
            console.log(`[ai-for-memory] 自动快照：${info.snapshot_id}（第 ${built.turnFrom}-${built.turnTo} 轮）`
              + (removed.length > 0
                ? `；清理 ${removed.length} 个（${removed.map((row) => `${row.snapshot_id} 相似度 ${row.similarity}`).join('，')}）`
                : ''));
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`[ai-for-memory] 自动快照失败：${error?.message ?? error}`);
        }
      } else {
        snapshotCounters.set(id, count);
      }
    }

    // Turn activity → decision layer: every completed turn that called a tool
    // gets one observed decision record (tools, failures, files touched). This
    // is independent of automatic tidying and is never mined into knowledge.
    if (!isSubagent && config.autoDecisionLog !== false) {
      try {
        const context = memoryContext(config, { agent: { session } }, deps, runtime);
        const store = writeSource(context, 'session').store;
        const activity = summarizeTurnActivity(session.ownEvents(), id, event.data?.turn);
        if (activity) store.recordDecision(activity);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[ai-for-memory] 自动决策记录失败：${error?.message ?? error}`);
      }
    }

    // Automatic archiving never runs for subagents; a manual `clear` still
    // honors its pending request below.
    // The two triggers are independent: a pre-step 45% reset must not suppress
    // the every-N-rounds pass at turn/end, and an every-N-rounds pass must not
    // reset the round counter when it only fired because of usage.
    if (!isSubagent && config.autoEnabled && !pending.has(id)) {
      // Two independent triggers share one tidy pass when both fire at the same
      // turn; otherwise each one runs on its own schedule.
      const count = (counters.get(id) ?? 0) + 1;
      const pressure = contextPressureOf(session);
      const byRounds = count >= config.autoEveryRounds;
      const byUsage = exceedsUsageThreshold(pressure, config.contextUsagePercent);
      if (!byRounds && !byUsage) {
        counters.set(id, count);
      } else {
        // Only the round trigger consumes the round counter. A usage-only pass
        // leaves it intact so a 2-round setting still fires after two rounds.
        if (byRounds) counters.delete(id);
        else counters.set(id, count);
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
            if (promoted && (promoted.added.length > 0 || (promoted.pending?.length ?? 0) > 0)) {
              // eslint-disable-next-line no-console
              console.log(`[ai-for-memory] 自动提炼知识：新增 ${promoted.added.length} 篇，合并 ${promoted.merged.length} 篇`
                + `${(promoted.pending?.length ?? 0) > 0 ? `，待确认更新 ${promoted.pending.length} 条（未写入）` : ''}`);
            }
          }
          // Retention is best-effort and must never turn a tidy pass into an error.
          try {
            store.pruneRetention();
          } catch (error) {
            // eslint-disable-next-line no-console
            console.warn(`[ai-for-memory] 保留策略清理失败：${error?.message ?? error}`);
          }
          if (config.topicalClear === false && trigger !== 'usage') {
            // Legacy mode still snapshots the recent window before compacting.
            const snapshot = buildContextSnapshot(events, { maxChars: config.maxContextChars });
            if (snapshot) {
              const saved = store.saveContext({
                label: `auto-${config.autoEveryRounds}rounds`,
                sessionId: id,
                ...snapshot,
              });
              // The object carries the trigger, but `reason` is rounds so
              // runClear still takes the legacy compaction path.
              pending.set(id, { kind: 'auto', reason: trigger, percent, context: saved.context_id });
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
      const manual = request === 'manual' || (request && typeof request === 'object' && request.kind === 'manual');
      runClear(session, manual ? 'manual' : 'auto', meta);
    }
  };

  ctx.effect(() => ctx.on('agent/pre-step', onPreStep));
  ctx.effect(() => ctx.on('session/event', onSessionEvent));
  ctx.effect(() => ctx.on('session/disposed', (session) => {
    const id = String(session?.id);
    counters.delete(id);
    pending.delete(id);
    anchorState.delete(id);
    // A disposed session will never emit its turn/end; drop it so a per-turn
    // stop is not blocked forever by a stale active-turn entry.
    activeTurns.delete(id);
  }));
  ctx.effect(() => ctx.on('session/created', (session) => {
    if (!session || Boolean(session.header?.parentSession)) return;
    rememberConversation(session, { initLayers: true });
  }));

  // `always`: bring the runnable local models up at plugin load. A manual
  // "stop" in the panel still wins until the next turn's pre-step re-ensures
  // them; the panel start/stop buttons are never gated by this mode.
  if (config.engineLifecycle === 'always') void ensureLocalEngines('always');
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

  /**
   * Run one existing memory tool for an MCP caller. The caller supplies a
   * registered root; the synthetic session is only a carrier for the root and
   * never a real DSH conversation.
   */
  const runMcpTool = async (toolName, args, target = {}) => {
    if (typeof toolName !== 'string' || toolName === '') throw new Error('缺少工具名');
    const root = typeof target.root === 'string' && target.root !== ''
      ? target.root
      : resolved.root;
    const workspace = typeof target.workspace === 'string' && target.workspace !== ''
      ? target.workspace
      : root;
    const tools = createTools({ ...resolved, root }, deps, runtime);
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool || typeof tool.execute !== 'function') throw new Error(`未知工具：${toolName}`);
    let liveAgent = target.agent;
    if (!liveAgent && typeof target.sessionId === 'string' && target.sessionId !== '') {
      const agents = getService('agents');
      if (agents && typeof agents.get === 'function') liveAgent = agents.get(target.sessionId);
    }
    const liveSession = liveAgent?.session
      ?? (target.session || null)
      ?? {
        id: `mcp-${process.pid}`,
        header: { cwd: workspace },
      };
    let injected = null;
    const exec = {
      agent: {
        session: liveSession,
        whenIdle: typeof liveAgent?.whenIdle === 'function' ? liveAgent.whenIdle.bind(liveAgent) : undefined,
        inject: async (payload) => {
          const text = Array.isArray(payload?.content)
            ? payload.content.map((item) => item?.text ?? '').filter(Boolean).join('\n')
            : '';
          if (text !== '') injected = text;
          if (liveAgent && typeof liveAgent.inject === 'function') await liveAgent.inject(payload);
        },
      },
    };
    const output = await tool.execute(args ?? {}, exec);
    return injected ?? output;
  };
  const listMcpRoots = () => listRootRows(registryDir, resolved.root);

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

  // Adopt llama-server processes left by a previous DSH/plugin process before
  // the panel can offer a start button; otherwise a reload can spawn a second
  // server on a new port while the survivor keeps its VRAM. Adoption never
  // starts or stops a model; lifecycle is an explicit user action.
  try {
    void restoreLocalEngines();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[ai-for-memory] 本地引擎接管失败：${error?.message ?? error}`);
  }

  // The Web panel reads the same store over a small same-origin HTTP API.
  let editor;
  try {
    editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined;
  } catch {
    editor = undefined;
  }
  try {
    const mcpAccess = ensureMcpToken(registryDir, resolved.mcpToken);
    installApi(ctx, {
      config: resolved,
      entry: ctx?.fiber?.entry,
      editor,
      registryDir,
      runtime,
      getService,
      runMcpTool,
      listMcpRoots,
      version: packageVersion(),
      mcpToken: mcpAccess.token,
      mcpTokenFile: mcpAccess.file,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[ai-for-memory] 面板 API 注册失败：${error?.message ?? error}`);
  }
}
