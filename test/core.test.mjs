import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import net from 'node:net';
import zlib from 'node:zlib';
import { execFileSync, spawn } from 'node:child_process';

import { MemoryStore } from '../lib/store.js';
import { defaultMemoryDirIgnoreStatus, ensureDefaultMemoryDirIgnored, ensureGitignoreEntry } from '../lib/gitignore.js';
import { MemoryScopes, sessionKey } from '../lib/scopes.js';
import { decodeWorkspaceBucket, encodeWorkspace, resolveWorkspacePath, workspaceIndex } from '../lib/dsh-workspace.js';
import {
  chat, embed, listModels, normalizeExternal, parseEmbeddingResponse, parseRerankResponse,
  probe, resolveBaseUrl, embedEndpoint, rerankEndpoint, buildRequest, PROBE_TIMEOUT_MS,
} from '../lib/external.js';
import {
  classifyRecord,
  extractFacts,
  parseCategoryReply,
  parseKnowledgeReply,
  parseSummaryReply,
  summarizeTurns,
} from '../lib/external-ops.js';
import { evaluateDecision } from '../lib/decision.js';
import {
  buildRagIndex, cosine, embeddingIdentity, ragCandidates, ragManifestPath, ragModelStatus, ragStats, readRagIndex,
  rerankCandidates, sameEmbeddingSpace,
} from '../lib/rag.js';
import {
  buildKnowledgeExport, exportArtifact, knowledgeExportPayload, normalizeExportFormat, normalizeExportTypeList,
  writeExportArtifacts, writeKnowledgeExport,
} from '../lib/export.js';
import { knowledgeDatabasePath, sqliteAvailable } from '../lib/knowledge-sqlite.js';
import {
  formatSqlResult, isSafeSelect, routeKnowledgeQuery, runSqlQuery, translateToSql,
} from '../lib/knowledge-query.js';
import { applyDisclosure, RRF_K, reciprocalRankFusion, search, snippetOf, tokenize } from '../lib/retrieval.js';
import { CATEGORIES, hourKey, listJsonlFiles } from '../lib/util.js';
import { buildUiState } from '../lib/ui-state.js';
import { listLocalModels, listLocalModelsCached, resetLocalModelsCache } from '../lib/model-catalog.js';
import { buildServerArgs, findModelFile, resolveModel, restoreLocalEngines, startLocalEngine, stopAllLocalEngines, stopLocalEngine, updateModelConfig } from '../lib/local-engine.js';
import {
  commitSync, initSync, pullSync, pushSync, readSyncConfig, syncStatus, writeSyncConfig,
  parseGitRemote, probeHost,
} from '../lib/git-sync.js';
import { collectTurnDigest } from '../lib/auto.js';
import { buildContextSnapshot, collectTurns, formatContextMarkdown, formatRestoreContext, snapshotOfTurns } from '../lib/context.js';
import { handleMcpMessage, MCP_PATH, mcpToolNames } from '../lib/mcp.js';
import { packageVersion } from '../lib/version.js';
import { ensureMcpToken, mcpTokenPath } from '../lib/mcp-token.js';
import { contentTokens, selectTurnsByTopic, topicSimilarity } from '../lib/similarity.js';
import {
  AUTO_SNAPSHOT_PREFIX, isAutoSnapshot, planSnapshotPrune, snapshotText,
} from '../lib/snapshot.js';
import { exceedsUsageThreshold, formatPressure, usagePercentOf } from '../lib/pressure.js';
import { boostScore, recencyWeight, USAGE_HALF_LIFE_DAYS } from '../lib/usage.js';
import {
  candidatesFromDecision, candidatesFromRecord, candidatesFromTurn, findDuplicate,
  materialChange, splitSentenceDetails,
  KNOWLEDGE_CATEGORIES, knowledgeKey, normalizeCategory, normalizeKnowledge, normalizeProvenance,
  normalizeSource, stripInjectedText, withTokens,
} from '../lib/knowledge.js';
import { listRootRows, readRoots, rememberRoot, resolveRegisteredRoot } from '../lib/registry.js';
import { appendAudit, readAudit } from '../lib/audit.js';
import {
  decodeSeqRanges, encodeSeqRanges, encodeZstdLog, findSessionLogs, formatRepairReport,
  formatScanReport, repairSessionLog, resolveSessionLogTarget, scanSessionLogs, validateSessionEvents,
} from '../lib/session-repair.js';
import { isTrustedRequest } from '../lib/api.js';
import { apply, compileParameterSchema, Config, createTools, installContextManagement, memoryContext, normalizeConfig, searchWithRag, workspaceOf } from '../index.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agm-test-'));
}

/** Explicit local endpoint: the product default is now "unconfigured". */
function localExternal(extra = {}) {
  return normalizeExternal({ baseUrl: 'http://127.0.0.1:8080', ...extra });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

function fakeExec(cwd) {
  return { agent: { session: { header: { cwd } } } };
}

const SURFACE_MESSAGE_TYPES = new Set([
  'system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result',
]);

/**
 * Minimal stand-in for a live DSH session: a contiguous event log, a surface
 * node list, and an `append` that honours `surfaceOp: replace` the way the
 * real session fold does. Enough to exercise clearing end to end.
 */
function fakeSession(events, id = 'session-clear') {
  const log = events.map((event, seq) => ({ ...event, seq }));
  const nodes = log.filter((event) => SURFACE_MESSAGE_TYPES.has(event.type)).map((event) => event.seq);
  const session = {
    id,
    header: { cwd: process.cwd() },
    ownEvents: () => log.slice(),
    surface: { nodes },
    eventAt: (seq) => log[seq],
    deriveEventMessage: (event) => {
      if (!event) return null;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data.message ?? null;
      return null;
    },
    append(type, data, options = {}) {
      const seq = log.length;
      log.push({ seq, type, data, ...options });
      const op = options.surfaceOp;
      if (op && op.op === 'replace') {
        const start = nodes.indexOf(op.startSeq);
        const end = nodes.indexOf(op.endSeq);
        assert.ok(start >= 0 && end >= start, `replace range ${op.startSeq}-${op.endSeq}`);
        nodes.splice(start, end - start + 1, seq);
      } else if (SURFACE_MESSAGE_TYPES.has(type)) {
        // Log-only events (`compaction/prune`) never join the surface.
        nodes.push(seq);
      }
      return { seq };
    },
  };
  return { session, log, nodes };
}

/** Four turns that all keep talking about the same subject. */function onTopicEvents() {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '上下文清理要按相似度保留高相似度的轮次' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '相似度高的留下' }] } } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '相似度低的老轮次才清出上下文' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '清出前先存档' }] } } },
    { type: 'turn/end', data: { turn: 2 } },
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '清出的上下文要能 restore 调回' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '存档就是调回的来源' }] } } },
    { type: 'turn/end', data: { turn: 3 } },
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '继续按相似度清理上下文' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '明白' }] } } },
    { type: 'turn/end', data: { turn: 4 } },
  ];
}

test('staging records get unique ids and archive idempotently', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    const first = store.stage({ content: '点击设置菜单', kind: 'action', source: 'gui' });
    const second = store.stage({ content: 'API 超时', kind: 'error', source: 'api', risk: 'medium' });
    assert.notEqual(first.dedup_id, second.dedup_id);
    assert.equal(first.category, 'action_logs');
    assert.equal(second.category, 'errors_fixes');
    assert.equal(store.stagingRecords().length, 2);

    const stats = store.archive();
    assert.deepEqual(
      { archived: stats.archived, skipped: stats.skipped, failed: stats.failed },
      { archived: 2, skipped: 0, failed: 0 },
    );
    assert.equal(store.archivedCount('action_logs'), 1);
    assert.equal(store.archivedCount('errors_fixes'), 1);

    const again = store.archive();
    assert.equal(again.archived, 0);
    assert.equal(again.skipped, 2);
    assert.equal(store.archivedCount(), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a torn last line is repaired before the next append', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root).init();
    const file = path.join(store.stagingDir, `staging_${hourKey()}.jsonl`);
    fs.writeFileSync(file, '{"kind":"action","content":"ok"}\n{"kind":"action","content":"torn', 'utf8');
    store.stage({ content: '正常记录' });
    const records = store.stagingRecords();
    assert.deepEqual(records.map((row) => row.content), ['ok', '正常记录']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('snapshots are safe-named, unique and restorable', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    const first = store.snapshot({ name: '../evil/name', state: { step: 1 } });
    const second = store.snapshot({ name: '../evil/name', state: { step: 2 } });
    assert.notEqual(first.snapshot_id, second.snapshot_id);
    assert.equal(path.dirname(path.join(root, first.file)), path.join(root, 'snapshots'));

    assert.deepEqual(store.restoreSnapshot(first.snapshot_id), { step: 1 });
    assert.deepEqual(store.restoreSnapshot('../evil/name'), { step: 2 });
    assert.equal(store.listSnapshots().length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('knowledge search defaults to snippets and full text is explicit', () => {
  const long = `超时处理步骤：${'先重试再记录错误。'.repeat(80)}TAIL_MARKER`;
  const docs = [{ doc_id: 'long', category: 'errors_fixes', text: long }];
  const summary = search(docs, '超时处理', { mode: 'hybrid', topK: 1 });
  assert.equal(summary.length, 1);
  assert.ok(summary[0].text.length < long.length);
  assert.equal(summary[0].text_chars, long.length);
  assert.equal(summary[0].text_truncated, true);
  const full = search(docs, '超时处理', { mode: 'hybrid', topK: 1, detail: 'full' });
  assert.equal(full[0].text, long);
  assert.equal(full[0].text_truncated, false);
});

test('retrieval cache modes select the same result set', () => {
  const docs = [
    { doc_id: 'a', category: 'ui_facts', text: '网关超时需要重试', updated_at: '2026-01-01T00:00:00Z' },
    { doc_id: 'b', category: 'ui_facts', text: '设置页面有通知开关', updated_at: '2026-01-02T00:00:00Z' },
  ];
  const auto = search(docs, '网关超时', { mode: 'hybrid', cacheMode: 'auto' });
  const library = search(docs, '网关超时', { mode: 'hybrid', cacheMode: 'library' });
  const document = search(docs, '网关超时', { mode: 'hybrid', cacheMode: 'document' });
  assert.deepEqual(auto.map((hit) => hit.doc_id), library.map((hit) => hit.doc_id));
  assert.deepEqual(auto.map((hit) => hit.doc_id), document.map((hit) => hit.doc_id));
});

test('Chinese snippets center on multi-character query terms, not the first single char', () => {
  const text = `${'无关开头。'.repeat(100)}网关超时，必须重试三次。`;
  const snippet = snippetOf(text, '网关超时', 100);
  assert.ok(snippet.startsWith('…'));
  assert.match(snippet, /网关超时/);
  assert.doesNotMatch(snippet, /^无关开头/);
});

test('applyDisclosure is idempotent on a search summary', () => {
  const long = `超时处理步骤：${'先重试再记录错误。'.repeat(80)}`;
  const summary = search([{ doc_id: 'long', category: 'errors_fixes', text: long }], '超时处理', {
    mode: 'hybrid', topK: 1,
  });
  const again = applyDisclosure(summary, '超时处理');
  assert.equal(again[0].text, summary[0].text);
  assert.equal(again[0].text_chars, long.length);
  assert.equal(again[0].text_truncated, true);
  const full = search([{ doc_id: 'long', category: 'errors_fixes', text: long }], '超时处理', {
    mode: 'hybrid', topK: 1, detail: 'full',
  });
  const disclosed = applyDisclosure(full, '超时处理');
  assert.equal(disclosed[0].text_chars, long.length);
  assert.equal(disclosed[0].text_truncated, true);
});

test('knowledge search supports bm25, vector and hybrid', () => {
  const docs = [
    { doc_id: 'err_timeout', category: 'errors_fixes', text: 'API 超时时重试三次，记录错误日志，仍失败则通知用户' },
    { doc_id: 'ui_settings', category: 'ui_facts', text: '设置页面包含用户信息、安全设置、通知偏好三个选项卡' },
    { doc_id: 'behavior_retry', category: 'behavior_tristate', text: '处理超时的标准行为：重试三次，记录错误，通知用户' },
  ];
  for (const mode of ['bm25', 'vector', 'hybrid']) {
    const hits = search(docs, '超时处理', { mode, topK: 5 });
    assert.ok(hits.length >= 1, `${mode} should return hits`);
    assert.ok(hits.every((hit) => hit.score > 0));
    assert.ok(['err_timeout', 'behavior_retry'].includes(hits[0].doc_id), `${mode}: ${hits[0].doc_id}`);
  }

  // Confidence is a bounded modifier, not dead metadata: equal relevance must
  // rank the high-confidence fact first.
  const ranked = search([
    { doc_id: 'low', category: 'project_facts', text: '发布前必须跑测试', confidence: 0.3 },
    { doc_id: 'high', category: 'project_facts', text: '发布前必须跑测试', confidence: 0.9 },
  ], '发布前必须跑测试', { mode: 'bm25', topK: 2 });
  assert.equal(ranked[0].doc_id, 'high');
  assert.equal(ranked[0].confidence, 0.9);
  const filtered = search(docs, '设置', { category: 'ui_facts', mode: 'hybrid' });
  assert.ok(filtered.length >= 1);
  assert.ok(filtered.every((hit) => hit.category === 'ui_facts'));
  assert.deepEqual(search(docs, 'zzzzqqqq', { mode: 'bm25' }), []);

  const store = new MemoryStore(tempRoot());
  try {
    store.remember({ doc_id: 'err_timeout', text: docs[0].text, category: 'errors_fixes' });
    store.remember({ doc_id: 'ui_settings', text: docs[1].text, category: 'ui_facts' });
    const hits = store.search('超时', { mode: 'hybrid', topK: 5 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].doc_id, 'err_timeout');
    assert.equal(store.documents().length, 2);
  } finally {
    fs.rmSync(store.root, { recursive: true, force: true });
  }
});

test('decision review gates on reversibility, not on reason length', () => {
  const low = evaluateDecision({ decision: '关闭设置页', risk: 'low' });
  assert.equal(low.outcome, 'approved');
  assert.equal(low.reviewed, false);

  const rejected = evaluateDecision({
    decision: '删除全部文件',
    risk: 'high',
    thesis: '释放磁盘空间，而且这是一段刻意写得很长的支持理由，用来证明字数不能换放行',
    antithesis: '会丢数据',
    irreversible: true,
    recoverable_via: '没有备份',
  });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.approved, false);
  assert.equal(rejected.weights.gate, 'reversibility');

  // A short thesis + a long antithesis must NOT be rejected when recovery is
  // stated: the old ratio gate punished exactly this honest case.
  const approved = evaluateDecision({
    decision: '清理已归档日',
    risk: 'high',
    thesis: '可恢',
    antithesis: '日志里有排障线索，删早了会拖慢定位；这是一个很长的反对理由'
      + '在旧算法里足以让 risk_adjusted_score 超过 0.3，但现在只作为审计信息',
    irreversible: false,
    recoverable_via: '先归档到 cold storage，保留 30 天，可随时 restore',
  });
  assert.equal(approved.outcome, 'approved');
  assert.equal(approved.weights.advisory_only, true);
  assert.ok(approved.weights.risk_adjusted_score > 0.3);

  const missing = evaluateDecision({
    decision: '删除全部文件', risk: 'high', thesis: '释放空间', antithesis: '可能丢数',
  });
  assert.equal(missing.outcome, 'needs_more_info');

  const noRecovery = evaluateDecision({
    decision: '迁移数据', risk: 'high', thesis: '更快', antithesis: '有停机风',
    irreversible: false,
  });
  assert.equal(noRecovery.outcome, 'needs_more_info');

  const mediumAuto = evaluateDecision({ decision: '调整重试', risk: 'medium' }, { reviewHighRiskOnly: true });
  assert.equal(mediumAuto.reviewed, false);
  assert.equal(mediumAuto.outcome, 'approved');

  const mediumReviewed = evaluateDecision({
    decision: '调整重试',
    risk: 'medium',
    thesis: '快',
    antithesis: '可能导致请求风暴，压垮下游服务',
    irreversible: true,
  }, { reviewHighRiskOnly: false });
  assert.equal(mediumReviewed.outcome, 'rejected');
});

test('tools are registered and executable against the session workspace', async () => {
  const root = tempRoot();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(root, 'dsh-home');
  try {
    const registered = [];
    const ctx = {
      tools: { register: (tool) => { registered.push(tool); return () => {}; } },
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
    };
    apply(ctx, {});
    assert.deepEqual(registered.map((tool) => tool.name), ['aim_memory', 'aim_search', 'aim_decide', 'aim_context', 'aim_ask', 'aim_repair']);
    for (const tool of registered) {
      assert.equal(tool.parameters.type, 'object');
      assert.ok(tool.output.render);
    }

    const memory = registered.find((tool) => tool.name === 'aim_memory');
    const searchTool = registered.find((tool) => tool.name === 'aim_search');
    const decideTool = registered.find((tool) => tool.name === 'aim_decide');
    const exec = fakeExec(root);

    const staged = await memory.execute({ action: 'stage', content: '用户点击设置', kind: 'action' }, exec);
    assert.match(staged, /已写入过程记录/);

    const status = await memory.execute({ action: 'status' }, exec);
    assert.match(status, /过程记录层：1 个文件 \/ 1 条记录/);
    assert.match(status, /记忆根目录/);

    const archived = await memory.execute({ action: 'archive' }, exec);
    assert.match(archived, /archived=1/);

    const snapshot = await memory.execute({
      action: 'snapshot', name: 'before-delete', state: { files: ['a.txt'] },
    }, exec);
    assert.match(snapshot, /已创建快照/);
    const restored = await memory.execute({ action: 'restore', snapshot_id: 'before-delete' }, exec);
    assert.match(restored, /a\.txt/);

    await memory.execute({
      action: 'remember', doc_id: 'err_1', text: '超时后重试三次', category: 'errors_fixes',
    }, exec);
    const hits = await searchTool.execute({ query: '超时', mode: 'hybrid' }, exec);
    assert.match(hits, /err_1/);

    const decision = await decideTool.execute({
      decision: '删除全部文件', risk: 'high', thesis: '空间不足', antithesis: '可能丢失数据',
      irreversible: true,
    }, exec);
    assert.match(decision, /rejected/);
    assert.ok(fs.readdirSync(path.join(root, '.ai-for-memory', 'decisions')).length === 1);

    // The global registry now knows this workspace root.
    const registryDir = path.join(process.env.DSH_HOME, 'ai-for-memory');
    assert.equal(readRoots(registryDir).length, 1);
    assert.equal(readRoots(registryDir)[0].workspace, root);
  } finally {
    process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ui state exposes every memory layer', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    store.stage({ content: '点击设置', kind: 'action' });
    store.stage({ content: '保存超时', kind: 'error', risk: 'medium' });
    const stats = store.archive();
    assert.equal(stats.archived, 2);
    const snap = store.snapshot({ name: 'before-cleanup', state: { step: 1 } });
    store.remember({ doc_id: 'err_1', text: '超时重试三次', category: 'errors_fixes' });
    store.recordDecision(evaluateDecision({
      decision: '删除全部文件', risk: 'high', thesis: '空间不足', antithesis: '可能丢失数据',
      irreversible: true,
    }));

    const state = buildUiState(store);
    assert.equal(state.counts.staging, 2);
    assert.equal(state.counts.archive, 2);
    assert.equal(state.counts.snapshots, 1);
    assert.equal(state.counts.knowledge, 1);
    assert.equal(state.counts.decisions, 1);
    assert.equal(state.archive.find((group) => group.category === 'errors_fixes').count, 1);
    assert.equal(state.snapshots[0].snapshot_id, snap.snapshot_id);
    assert.match(state.snapshots[0].state_text, /step/);
    assert.equal(state.decisions[0].outcome, 'rejected');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('registry only resolves roots it recorded', () => {
  const root = tempRoot();
  try {
    const registryDir = path.join(root, 'registry');
    const alpha = path.join(root, 'alpha');
    const beta = path.join(root, 'beta');
    rememberRoot(alpha, path.join(root, 'workspace-alpha'), registryDir);
    rememberRoot(beta, path.join(root, 'workspace-beta'), registryDir);

    const rows = listRootRows(registryDir);
    assert.equal(rows.length, 2);
    assert.equal(resolveRegisteredRoot(alpha, registryDir), alpha);
    assert.equal(resolveRegisteredRoot(path.join(root, 'unknown'), registryDir), null);
    assert.equal(resolveRegisteredRoot('', registryDir), rows[0].root);
    assert.equal(resolveRegisteredRoot(path.join(root, 'fixed'), registryDir, [path.join(root, 'fixed')]), path.join(root, 'fixed'));

    const fixedRows = listRootRows(registryDir, path.join(root, 'fixed'));
    assert.equal(fixedRows[0].fixed, true);
    assert.equal(fixedRows.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parameter compilation lifts required and keeps enums', () => {
  const schema = compileParameterSchema({
    action: { type: 'string', required: true, enum: ['a', 'b'] },
    note: { type: 'string' },
  });
  assert.deepEqual(schema.required, ['action']);
  assert.equal(schema.properties.action.required, undefined);
  assert.deepEqual(schema.properties.action.enum, ['a', 'b']);
});

test('workspace prefers the live working-directory service', () => {
  const session = { header: { cwd: '/original' } };
  const exec = { agent: { session } };
  assert.equal(workspaceOf(exec, { get: () => '/current' }), '/current');
  assert.equal(workspaceOf(exec, { get: () => { throw new Error('not ready'); } }), '/original');
  assert.equal(workspaceOf(exec, undefined), '/original');
});

test('turn digest keeps the last completed turns', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第一轮问题' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一轮回答' }] } } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第二轮问题' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二轮回答' }, { type: 'tool-call' }] } } },
    { type: 'turn/end', data: { turn: 2 } },
  ];
  const digest = collectTurnDigest(events, 2);
  assert.match(digest, /自动记忆/);
  assert.match(digest, /第 1-2 轮/);
  assert.match(digest, /第一轮问题/);
  assert.match(digest, /第二轮回答/);
  assert.equal(collectTurnDigest(events, 1).includes('第一轮问题'), false);
  assert.equal(collectTurnDigest([], 2), null);
});

test('auto mode triggers after the configured number of turns', async () => {
  const root = tempRoot();
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const memoryRoot = path.join(root, 'memory');
  const registryDir = path.join(root, 'registry');
  try {
    const session = {
      id: 'session-test',
      header: { cwd: workspace },
      ownEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { content: [{ type: 'text', text: '记住这件事' }] } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
        { type: 'turn/end', data: { turn: 1 } },
      ],
    };
    const handlers = new Map();
    let compacted = 0;
    const agent = { whenIdle: async () => {} };
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: (service) => {
        if (service === 'agents') return { get: () => agent };
        if (service === 'compaction') {
          return { compactNow: async () => { compacted += 1; return { shadowedSeqs: [1], shadowedTokenCount: 10 }; } };
        }
        return undefined;
      },
    };
    const config = normalizeConfig({
      autoEnabled: true,
      autoEveryRounds: 2,
      root: memoryRoot,
      // This test covers the legacy whole-window compaction path; the
      // similarity-aware policy has its own tests below.
      topicalClear: false,
    });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir, getService: ctx.get }, runtime);
    const onSessionEvent = handlers.get('session/event');
    assert.equal(typeof onSessionEvent, 'function');

    const scopes = new MemoryScopes(memoryRoot);
    const conversation = scopes.sessionStoreFor('session-test', {});
    assert.equal(conversation.key, sessionKey('session-test'));
    assert.equal(scopes.readMeta(conversation.key).schema_version, 1);

    onSessionEvent(session, { type: 'turn/end', data: { turn: 1 } });
    assert.equal(conversation.store.stagingRecords().length, 0);
    onSessionEvent(session, { type: 'turn/end', data: { turn: 2 } });

    const records = conversation.store.stagingRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'digest');
    assert.match(records[0].content, /自动记忆/);
    assert.equal(conversation.store.archivedCount('action_logs'), 1);
    assert.equal(conversation.store.listContexts().length, 1);
    // Automatic tidying writes only into the conversation's own scope.
    assert.equal(scopes.sharedStore().stagingRecords().length, 0);
    assert.equal(runtime.activity.get('session-test') > 0, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(compacted, 1);
    assert.equal(conversation.store.readCompactionStatus().state, 'done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context tool saves, lists and restores a context', async () => {
  const root = tempRoot();
  try {
    const memoryRoot = path.join(root, 'memory');
    const registered = [];
    const ctx = {
      tools: { register: (tool) => { registered.push(tool); return () => {}; } },
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
    };
    apply(ctx, { root: memoryRoot });
    const contextTool = registered.find((tool) => tool.name === 'aim_context');
    assert.ok(contextTool);

    let injected = null;
    const session = {
      id: 'session-context',
      header: { cwd: root },
      ownEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { content: [{ type: 'text', text: '需要记住的上下文' }] } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到' }] } } },
        { type: 'turn/end', data: { turn: 1 } },
      ],
    };
    const exec = {
      agent: {
        session,
        inject: async (message) => { injected = message; },
      },
    };

    const saved = await contextTool.execute({ action: 'save', name: 'checkpoint' }, exec);
    const match = saved.match(/context_[0-9_]+_[0-9a-f]+/);
    assert.ok(match, saved);
    const contextId = match[0];
    assert.match(saved, /checkpoint/);

    const listed = await contextTool.execute({ action: 'list' }, exec);
    assert.match(listed, new RegExp(contextId));
    assert.match(listed, /checkpoint/);

    const restored = await contextTool.execute({ action: 'restore', context_id: contextId }, exec);
    assert.match(restored, /将在下一步生效/);
    assert.match(restored, /字符预算注入/);
    assert.ok(injected);
    assert.match(injected.content[0].text, /需要记住的上下文/);
    assert.equal(injected.source.kind, 'ai-for-memory');

    const status = await contextTool.execute({ action: 'status' }, exec);
    assert.match(status, /清理策略：话题相似度/);
    assert.match(status, /保留最近 2 轮/);

    const cleared = await contextTool.execute({ action: 'clear' }, exec);
    assert.match(cleared, /立即清理/);
    assert.match(cleared, /下一次模型请求前/);
    assert.match(cleared, /按话题相似度/);
    assert.match(cleared, /store|restore/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context snapshot captures completed turns and restores text', () => {
  const events = [
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第三轮问题' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第三轮回答' }] } } },
    { type: 'turn/end', data: { turn: 3 } },
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第四轮问题' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第四轮回答' }] } } },
    { type: 'turn/end', data: { turn: 4 } },
  ];
  const snapshot = buildContextSnapshot(events, { maxChars: 1000 });
  assert.equal(snapshot.turnFrom, 3);
  assert.equal(snapshot.turnTo, 4);
  assert.equal(snapshot.turnCount, 2);
  assert.match(snapshot.text, /第三轮问题/);
  assert.match(snapshot.text, /第四轮回答/);

  const inFlight = buildContextSnapshot([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '首轮进行中' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正在处理' }] } } },
  ], { maxChars: 1000 });
  assert.ok(inFlight);
  assert.equal(inFlight.turnCount, 1);
  assert.match(inFlight.text, /首轮进行中/);
  assert.match(inFlight.text, /正在处理/);

  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    const saved = store.saveContext({ label: 'test', sessionId: 's1', ...snapshot });
    assert.match(saved.context_id, /^context_/);
    const rows = store.listContexts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].context_id, saved.context_id);
    const loaded = store.loadContext(saved.context_id);
    assert.equal(loaded.turn_from, 3);
    assert.match(loaded.text, /第四轮回答/);
    assert.equal(store.loadContext('missing'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore keeps the newest turns within the restore budget', () => {
  const record = {
    context_id: 'context_budget',
    turn_from: 1,
    turn_to: 4,
    created_at: '2026-11-18T00:00:00.000Z',
    text: '整份存档不应当被直接注入',
    turns: [
      { turn: 1, user: `第一轮旧内容${'甲'.repeat(80)}`, assistant: '旧回答' },
      { turn: 2, user: `第二轮旧内容${'乙'.repeat(80)}`, assistant: '旧回答' },
      { turn: 3, user: `第三轮内容${'丙'.repeat(80)}`, assistant: '第三轮回答' },
      { turn: 4, user: `第四轮内容${'丁'.repeat(80)}`, assistant: '第四轮回答' },
    ],
  };
  const restored = formatRestoreContext(record, { maxChars: 220 });
  assert.match(restored, /预算恢复最近/);
  assert.match(restored, /第四轮内容/);
  assert.doesNotMatch(restored, /第一轮旧内容/);
  const body = restored.split('\n\n')[1] ?? '';
  assert.ok(body.length <= 220, `restore body ${body.length} > 220`);
  assert.ok(restored.length < record.text.length + 500);

  // Records from older versions/imports may have no turns[]; fall back to a
  // clipped text instead of injecting the whole archive.
  const fallback = formatRestoreContext({
    context_id: 'context_no_turns',
    turn_from: 1,
    turn_to: 1,
    created_at: '2026-11-18T00:00:00.000Z',
    text: '很长的旧正文'.repeat(100),
  }, { maxChars: 80 });
  assert.match(fallback, /预算恢复最近内容/);
  assert.ok(fallback.length < 400);
});

test('conversation scopes isolate records and resolve by id or prefix', () => {
  const root = tempRoot();
  try {
    const scopes = new MemoryScopes(root);
    const alpha = scopes.sessionStoreFor('session-alpha-with-a-long-id', { workspace: root });
    const beta = scopes.sessionStoreFor('session-beta', { parent_session_id: 'session-alpha-with-a-long-id' });
    assert.notEqual(alpha.key, beta.key);
    assert.match(alpha.key, /^s_[0-9a-f]{16}$/);
    assert.equal(sessionKey('session-alpha-with-a-long-id'), alpha.key);

    alpha.store.stage({ content: 'A 的过程记录', kind: 'action' });
    alpha.store.remember({ doc_id: 'alpha_doc', text: '只属于 A 的知识', category: 'errors_fixes' });
    beta.store.remember({ doc_id: 'beta_doc', text: '只属于 B 的知识', category: 'ui_facts' });
    scopes.sharedStore().stage({ content: '共享层记录', kind: 'action' });

    assert.equal(alpha.store.stagingRecords().length, 1);
    assert.equal(beta.store.stagingRecords().length, 0);
    assert.deepEqual(beta.store.documents().map((doc) => doc.doc_id), ['beta_doc']);
    assert.equal(scopes.sharedStore().stagingRecords().length, 1);

    const rows = scopes.listSessions();
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.key === beta.key).parentSessionId, 'session-alpha-with-a-long-id');
    assert.equal(scopes.resolve(alpha.key).sessionId, 'session-alpha-with-a-long-id');
    assert.equal(scopes.resolve('session-beta').key, beta.key);
    assert.equal(scopes.resolve('session-alpha').key, alpha.key);
    assert.equal(scopes.resolve('session-beta').meta.workspace ?? '', '');
    assert.equal(scopes.resolve('s_ffffffffffffffff'), null);
    assert.equal(scopes.sharedHasData(), true);

    const counts = scopes.counts(alpha.key);
    assert.equal(counts.staging, 1);
    assert.equal(counts.knowledge, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cross conversation search labels every hit', async () => {
  const root = tempRoot();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(root, 'dsh-home');
  try {
    const memoryRoot = path.join(root, 'memory');
    const registered = [];
    apply({
      tools: { register: (tool) => { registered.push(tool); return () => {}; } },
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
    }, { root: memoryRoot });
    const memory = registered.find((tool) => tool.name === 'aim_memory');
    const searchTool = registered.find((tool) => tool.name === 'aim_search');
    const contextTool = registered.find((tool) => tool.name === 'aim_context');

    const execA = {
      agent: {
        session: { id: 'conv-alpha', header: { cwd: root }, ownEvents: () => [] },
      },
    };
    const execB = {
      agent: {
        session: { id: 'conv-beta', header: { cwd: root }, ownEvents: () => [] },
      },
    };

    await memory.execute({
      action: 'remember', doc_id: 'deploy_note', text: '部署脚本位于 scripts/deploy.sh，发布前先跑测试', category: 'errors_fixes',
    }, execA);
    await memory.execute({
      action: 'stage', content: 'B 的过程记录', kind: 'action',
    }, execB);
    await memory.execute({
      action: 'remember', doc_id: 'deploy_cmd', text: '部署命令是 npm run deploy', category: 'action_logs',
    }, execB);

    // Cross-conversation reads require an explicit open under the new default.
    const scopes = new MemoryScopes(memoryRoot);
    scopes.setPublic(sessionKey('conv-alpha'), true);
    scopes.setPublic(sessionKey('conv-beta'), true);

    // A's own scope still only contains A's document.
    const own = await searchTool.execute({ query: '部署', scope: 'session' }, execA);
    assert.match(own, /deploy_note/);
    assert.doesNotMatch(own, /deploy_cmd/);

    // Cross-conversation search is the default and names the source conversation.
    const all = await searchTool.execute({ query: '部署' }, execA);
    assert.match(all, /deploy_note/);
    assert.match(all, /deploy_cmd/);
    assert.match(all, /对话：本对话/);
    assert.match(all, /对话：对话/);

    const status = await memory.execute({ action: 'status' }, execA);
    assert.match(status, /当前范围：本对话/);
    assert.match(status, /其他对话：1 个/);

    const conversations = await contextTool.execute({ action: 'sessions' }, execA);
    assert.match(conversations, /共 2 个对话/);
    assert.match(conversations, /共享层/);

    // Writing to the shared layer stays visible to everyone and is not duplicated.
    await memory.execute({
      action: 'remember', doc_id: 'shared_fact', text: '所有对话共用的事实：发布前必须跑测试', category: 'errors_fixes', scope: 'shared',
    }, execA);
    const sharedSearch = await searchTool.execute({ query: '共用', scope: 'shared' }, execB);
    assert.match(sharedSearch, /对话：共享/);

    // Decisions follow the same scope rule as the other writes.
    const decideTool = registered.find((tool) => tool.name === 'aim_decide');
    const reviewed = await decideTool.execute({
      decision: '把跨对话约定写进共享层', risk: 'low', scope: 'shared',
    }, execA);
    assert.match(reviewed, /范围：共享/);
    assert.equal(scopes.sharedStore().decisionStats().total, 1);
    assert.equal(scopes.counts(sessionKey('conv-alpha')).decisions, 0);
  } finally {
    process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context archives stay per conversation and restore can cross', async () => {
  const root = tempRoot();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(root, 'dsh-home');
  try {
    const memoryRoot = path.join(root, 'memory');
    const registered = [];
    apply({
      tools: { register: (tool) => { registered.push(tool); return () => {}; } },
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
    }, { root: memoryRoot });
    const contextTool = registered.find((tool) => tool.name === 'aim_context');

    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'A 对话里的重要上下文' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A 的回答' }] } } },
      { type: 'turn/end', data: { turn: 1 } },
    ];
    let injected = null;
    const execA = {
      agent: {
        session: { id: 'conv-alpha', header: { cwd: root }, ownEvents: () => events },
        inject: async (message) => { injected = message; },
      },
    };
    const execB = {
      agent: {
        session: { id: 'conv-beta', header: { cwd: root }, ownEvents: () => [] },
        inject: async (message) => { injected = message; },
      },
    };

    const saved = await contextTool.execute({ action: 'save', name: 'a-checkpoint' }, execA);
    const match = saved.match(/context_[0-9_]+_[0-9a-f]+/);
    assert.ok(match, saved);
    assert.match(saved, /本对话/);

    // Restoring another conversation's archive now requires opening it first.
    const scopes = new MemoryScopes(memoryRoot);
    scopes.setPublic(sessionKey('conv-alpha'), true);

    assert.match(await contextTool.execute({ action: 'list' }, execB), /本对话暂无上下文存档/);
    const all = await contextTool.execute({ action: 'list', scope: 'all' }, execB);
    assert.match(all, new RegExp(match[0]));
    assert.match(all, /对话 conv-alpha/);

    const restored = await contextTool.execute({ action: 'restore', context_id: match[0] }, execB);
    assert.match(restored, /将在下一步生效/);
    assert.ok(injected);
    assert.match(injected.content[0].text, /A 对话里的重要上下文/);

    const status = await contextTool.execute({ action: 'status' }, execB);
    assert.match(status, /对话数量：2 个/);
    assert.match(status, /上下文存档：0 个（本对话）/);

    // Both conversations keep their own compaction diagnostics.
    assert.equal(scopes.counts(sessionKey('conv-beta')).contexts, 0);
    assert.equal(scopes.counts(sessionKey('conv-alpha')).contexts, 1);
  } finally {
    process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ui state merges conversation sources and labels rows', () => {
  const root = tempRoot();
  try {
    const scopes = new MemoryScopes(root);
    const alpha = scopes.sessionStoreFor('conv-alpha', {});
    const beta = scopes.sessionStoreFor('conv-beta', {});
    alpha.store.stage({ content: 'A 记录', kind: 'action' });
    beta.store.stage({ content: 'B 记录', kind: 'error' });
    beta.store.stage({ content: 'B 记录二', kind: 'action' });
    scopes.sharedStore().stage({ content: '共享记录', kind: 'state' });

    const sources = [
      { store: alpha.store, scope: 'session', key: alpha.key, sessionId: 'conv-alpha', label: '本对话' },
      { store: beta.store, scope: 'session', key: beta.key, sessionId: 'conv-beta', label: '对话 conv-beta' },
      { store: scopes.sharedStore(), scope: 'shared', key: '', sessionId: '', label: '共享' },
    ];
    const state = buildUiState(sources);
    assert.equal(state.scope, 'all');
    assert.equal(state.counts.staging, 4);
    assert.equal(state.staging.length, 4);
    const labels = new Set(state.staging.map((row) => row.session_label));
    assert.deepEqual([...labels].sort(), ['共享', '对话 conv-beta', '本对话'].sort());
    const row = state.staging.find((item) => item.content === 'B 记录');
    assert.equal(row.session_id, 'conv-beta');
    assert.equal(row.session_key, beta.key);

    // Single-source calls keep their scope and still work with a bare store.
    const single = buildUiState([sources[0]]);
    assert.equal(single.scope, 'session');
    assert.equal(single.counts.staging, 1);
    const legacy = buildUiState(alpha.store);
    assert.equal(legacy.counts.staging, 1);
    assert.equal(legacy.staging[0].session_label, '共享');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('knowledge normalizes categories, ids and duplicates', () => {
  assert.equal(normalizeCategory('errors_fixes'), 'errors_fixes');
  assert.equal(normalizeCategory('behavior_tristate'), 'project_facts');
  assert.equal(normalizeCategory('unknown-thing', 'workflow_rules'), 'workflow_rules');
  assert.equal(normalizeSource('web'), 'web');
  assert.equal(normalizeSource('mcp'), 'mcp');
  assert.equal(normalizeSource('gui'), 'unknown');
  assert.equal(normalizeProvenance('model', 'mcp'), 'model');
  // An absent/misspelled source must not become "authored and verified"; the
  // only caller of the write tool is the model, so it defaults to a claim.
  assert.equal(normalizeProvenance(undefined, 'unknown'), 'model');
  assert.equal(normalizeProvenance(undefined, 'gui'), 'model');
  const untrusted = normalizeKnowledge({ text: '来路不明的一条结论', source: 'gui' });
  assert.equal(untrusted.provenance, 'model');
  assert.equal(untrusted.verified, false);
  assert.equal(normalizeProvenance(undefined, 'context'), 'user');

  // The id is derived from the text, so the same fact always lands on one file.
  assert.equal(knowledgeKey('部署前必须跑测试'), knowledgeKey('  部署前必须跑测试  '));
  assert.notEqual(knowledgeKey('部署前必须跑测试'), knowledgeKey('部署后必须跑测试'));

  const docs = withTokens([{ doc_id: 'k_a', text: '发布前必须跑测试，通过后才允许打标签' }]);
  assert.equal(findDuplicate('发布前必须跑测试，通过后才允许打标签', docs)?.doc_id, 'k_a');
  assert.equal(findDuplicate('晚餐吃火锅还是烧烤', docs), null);
});

test('split long prose restores a subject and tags clause fragments', () => {
  const long = `这个网关的超时默认是 30 秒，必须改成 120 秒，否则大文件上传会断，${'补充背景'.repeat(100)}`;
  const details = splitSentenceDetails(long);
  assert.ok(details.length >= 2);
  assert.equal(details.every((detail) => detail.clause === true), true);
  assert.match(details[0].text, /这个网关的超时默认是 30 秒/);
  // The subjectless "必须改成 120 秒" is not allowed to stand alone.
  const prefixed = details.find((detail) => detail.text.includes('必须改成 120 秒'));
  assert.ok(prefixed);
  assert.match(prefixed.text, /这个网关的超时，必须改成 120 秒/);

  const candidates = candidatesFromRecord({
    dedup_id: 'd7', content: long, kind: 'action', verify: 'pass',
  }, 'staging');
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.every((candidate) => candidate.tags.includes('clause')));
  assert.equal(candidates.find((candidate) => candidate.text.includes('必须改成 120 秒'))?.confidence, 0.35);

  const fromUser = candidatesFromTurn({ turn: 1, user: long }, 'ctx-long');
  assert.ok(fromUser.length >= 1);
  assert.ok(fromUser.every((candidate) => candidate.tags.includes('clause')));
  assert.equal(fromUser.find((candidate) => candidate.text.includes('必须改成 120 秒'))?.confidence, 0.6);
});

test('material changes catch common Chinese polarity flips', () => {
  assert.equal(materialChange('网关默认打开', '网关默认关闭')?.kind, 'polarity');
  // Bare 是/否 are morphemes: 就是/总是/是否 must not look like a flip.
  assert.equal(materialChange('端口默认是 8080', '端口默认否 8080'), null);
  assert.equal(materialChange('这个判断就是正确的', '这个判断是否错误'), null);
  assert.equal(materialChange('默认就是开启', '默认总是开启'), null);
  assert.equal(materialChange('配置默认是正确的', '配置默认是错误的')?.kind, 'polarity');
  assert.equal(materialChange('旧目录保留', '旧目录删除')?.kind, 'polarity');
  assert.equal(materialChange('走内网', '走公网')?.kind, 'polarity');
  assert.equal(materialChange('默认开启', '默认关闭')?.kind, 'polarity');
});


test('knowledge candidates come from verified records, decisions and user rules only', () => {
  const error = candidatesFromRecord({
    dedup_id: 'd1', content: '压缩失败：原因是 retention 配置为 0', kind: 'error', verify: 'pass',
  }, 'staging');
  assert.equal(error.length, 1);
  assert.equal(error[0].category, 'errors_fixes');
  assert.equal(error[0].source, 'staging');
  assert.equal(error[0].source_ref, 'staging:d1');
  assert.equal(error[0].provenance, 'model');
  assert.equal(error[0].verified, false);

  // A model-written state/error is not a fact until it was verified; otherwise
  // stage(kind=state) -> promote -> search would launder a guess into knowledge.
  assert.equal(candidatesFromRecord({
    dedup_id: 'd0', content: '当前发布分支是 release', kind: 'state',
  }, 'staging').length, 0);
  assert.equal(candidatesFromRecord({
    dedup_id: 'd0', content: '压缩失败：原因是 retention 配置为 0', kind: 'error',
  }, 'staging').length, 0);

  // Plain actions are the process log, not knowledge.
  assert.equal(candidatesFromRecord({ dedup_id: 'd2', content: '点击了设置菜单并刷新面板', kind: 'action' }, 'staging').length, 0);
  // …unless they state a durable rule and the record was verified.
  const rule = candidatesFromRecord({
    dedup_id: 'd3', content: '以后统一用 pwsh 跑测试，不要用 bash', kind: 'action', verify: 'pass',
  }, 'archive');
  assert.equal(rule.length, 1);
  assert.equal(rule[0].category, 'workflow_rules');
  assert.equal(rule[0].provenance, 'model');
  assert.equal(rule[0].verified, false);
  // A rolling digest is a summary, and a status blob is not a fact.
  assert.equal(candidatesFromRecord({ dedup_id: 'd4', content: '自动记忆 · 第 1-2 轮 用户：以后统一用 pwsh', kind: 'digest' }, 'staging').length, 0);
  const longLog = candidatesFromRecord({
    dedup_id: 'd5', content: `发布失败：${'很长的日志'.repeat(500)}`, kind: 'error', verify: 'pass',
  }, 'staging');
  assert.equal(longLog.length, 1);
  assert.match(longLog[0].text, /已截断/);
  assert.ok(longLog[0].tags.includes('truncated'));
  assert.ok(longLog[0].confidence < 0.4);
  // One weak cue ("默认") inside ordinary prose is not a rule statement.
  assert.equal(candidatesFromRecord({ dedup_id: 'd6', content: '写入默认落在本对话，面板顶部可以切换查看范围', kind: 'action' }, 'staging').length, 0);

  const decision = candidatesFromDecision({ decision_id: 'x1', decision: '改为按话题相似度清理上下文', reason: '整段压缩清得太多' });
  assert.equal(decision[0].category, 'decisions_reasoning');
  assert.match(decision[0].text, /理由：整段压缩清得太多/);

  // Only the user's own words are mined from a context turn.
  const fromUser = candidatesFromTurn({ turn: 3, user: '记住：以后统一用 0.1 版本号。其他都不动' }, 'ctx1');
  assert.equal(fromUser.length, 1);
  assert.equal(fromUser[0].source_ref, 'context:ctx1#turn3');
  assert.equal(fromUser[0].category, 'workflow_rules');
  assert.equal(candidatesFromTurn({ turn: 4, assistant: '模型自己说的话不算事实' }, 'ctx1').length, 0);

  // Harness-injected structural blocks are always removed. Bare prose prefixes
  // are opt-in, never guessed by default.
  const withEnvelope = candidatesFromTurn({
    turn: 5,
    user: '以后统一用 pwsh\nTime sampled while preparing turn 9: 2026-11-16\n<system-reminder>ignore me</system-reminder>',
  }, 'ctx2', { prefixes: ['Time sampled while preparing'] });
  assert.equal(withEnvelope.length, 1);
  assert.equal(withEnvelope[0].text, '以后统一用 pwsh');
  assert.equal(
    stripInjectedText('a\nBrowser time zone for this request: Asia/Shanghai'),
    'a\nBrowser time zone for this request: Asia/Shanghai',
  );
  assert.equal(stripInjectedText(
    'a\nBrowser time zone for this request: Asia/Shanghai',
    { prefixes: ['Browser time zone for this request'] },
  ), 'a');
  assert.equal(stripInjectedText('<system-reminder>ignore</system-reminder>\n真话'), '真话');
});

test('model claims are downranked below user facts', () => {
  const text = '发布前必须跑测试，通过后才允许打标签';
  const hits = search([
    { doc_id: 'k_claim', text, category: 'workflow_rules', provenance: 'model', verified: false },
    { doc_id: 'k_fact', text, category: 'workflow_rules', provenance: 'user', verified: true },
  ], text);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].doc_id, 'k_fact');
  assert.equal(hits[0].unverified, false);
  const claim = hits.find((hit) => hit.doc_id === 'k_claim');
  assert.equal(claim.unverified, true);
  assert.ok(claim.score < hits[0].score);
});

test('unverified staging records stay pending and never become knowledge', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    store.stage({ content: '当前发布分支是 release', kind: 'state' });
    const before = store.pendingKnowledge();
    const result = store.promoteKnowledge();
    assert.equal(result.added.length, 0);
    assert.equal(result.skippedUnverified.staging, 1);
    assert.equal(store.documents().length, 0);
    // Not consumed: the record remains visible as waiting, not silently mined.
    assert.equal(store.pendingKnowledge(), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('promote mines the three layers once and deduplicates', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    store.stage({ content: '发布失败：原因是发布脚本没有先跑测试', kind: 'error', verify: 'pass' });
    store.stage({ content: '点击了部署按钮', kind: 'action', verify: 'pass' });
    store.archive();
    store.saveContext({
      label: 'manual',
      sessionId: 's1',
      turnFrom: 1,
      turnTo: 2,
      turns: [
        { turn: 1, user: '以后统一用 pwsh 跑测试，不要用 bash', assistant: '好的' },
        { turn: 2, user: '今天天气不错', assistant: '是的' },
      ],
      text: 'x',
      chars: 1,
    });
    store.recordDecision({
      decision_id: 'd1',
      decision: '先存档再清理上下文',
      reason: '删掉的内容必须能恢复',
      risk_level: 'high',
      outcome: 'approved',
      approved: true,
      reviewed: true,
      timestamp: new Date().toISOString(),
    });

    const before = store.pendingKnowledge();
    assert.ok(before >= 4, `pending=${before}`);

    const preview = store.promoteKnowledge({ dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.ok(preview.added.length >= 3, `added=${preview.added.length}`);
    assert.equal(store.documents().length, 0);
    assert.equal(store.pendingKnowledge(), before);

    const first = store.promoteKnowledge({ limit: 20 });
    assert.ok(first.added.length >= 3);
    const docs = store.documents();
    const stagedDoc = docs.find((doc) => doc.category === 'errors_fixes' && doc.source === 'staging');
    assert.ok(stagedDoc);
    assert.equal(stagedDoc.provenance, 'model');
    assert.equal(stagedDoc.verified, false);
    const userDoc = docs.find((doc) => doc.category === 'workflow_rules' && doc.source === 'context');
    assert.ok(userDoc);
    assert.equal(userDoc.provenance, 'user');
    assert.equal(userDoc.verified, true);
    const decisionDoc = docs.find((doc) => doc.category === 'decisions_reasoning' && doc.source === 'decision');
    assert.ok(decisionDoc);
    assert.equal(decisionDoc.provenance, 'model');
    assert.equal(decisionDoc.verified, false);
    // Every mined document carries provenance back to its layer item.
    assert.ok(docs.every((doc) => doc.evidence.length >= 1));
    assert.ok(docs.every((doc) => /^(staging|archive|context|decision):/.test(doc.evidence[0].ref)));
    assert.ok(docs.every((doc) => doc.schema_version === 1));
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'knowledge', '_promoted.json'), 'utf8'));
    assert.equal(ledger.version, 2);
    assert.equal(ledger.schema_version, 1);

    // A second pass is a no-op: the ledger remembers what was mined.
    const second = store.promoteKnowledge();
    assert.equal(second.added.length, 0);
    assert.equal(second.merged.length, 0);
    assert.equal(store.documents().length, docs.length);
    assert.equal(store.pendingKnowledge(), 0);

    // Search reaches mined knowledge, and the hit names its producer.
    const hits = store.search('发布 测试');
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].source);
    assert.ok(hits.some((hit) => hit.unverified === true));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remember merges the same fact and keeps provenance', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    const first = store.remember({
      text: 'DSH 的压缩阈值默认是 0.8',
      category: 'tools_apis',
      source: 'web',
      url: 'https://example.com/compaction',
      tags: ['compaction'],
    });
    assert.equal(first.merged, false);
    const createdAt = first.created_at;
    const second = store.remember({
      text: 'DSH 的压缩阈值默认是 0.8',
      category: 'tools_apis',
      source: 'reasoning',
      tags: ['dsh'],
    });
    assert.equal(second.merged, true);
    assert.equal(second.doc_id, first.doc_id);
    assert.equal(second.created_at, createdAt);
    assert.equal(second.url, 'https://example.com/compaction');
    assert.deepEqual(second.tags.sort(), ['compaction', 'dsh']);
    assert.equal(second.evidence.length, 2);
    assert.equal(second.provenance, 'authored');
    assert.equal(second.verified, true);

    // A model claim with the same text must not downgrade the existing fact.
    const downgraded = store.remember({
      text: 'DSH 的压缩阈值默认是 0.8',
      category: 'tools_apis',
      source: 'staging',
      provenance: 'model',
      verified: false,
    }, { confirm: true });
    assert.equal(downgraded.provenance, 'authored');
    assert.equal(downgraded.verified, true);
    assert.equal(store.documents().length, 1);

    // A different custom id for the same text still merges into the first doc.
    const aliased = store.remember({
      doc_id: 'another_custom_id',
      text: 'DSH 的压缩阈值默认是 0.8',
      category: 'tools_apis',
    }, { confirm: true });
    assert.equal(aliased.merged, true);
    assert.equal(aliased.doc_id, first.doc_id);
    assert.equal(store.documents().length, 1);

    // The same custom id with different text must not overwrite the old fact.
    const collided = store.remember({
      doc_id: first.doc_id,
      text: '另一条完全不同的知识，不能覆盖旧事实',
      category: 'project_facts',
    }, { confirm: true });
    assert.notEqual(collided.doc_id, first.doc_id);
    assert.equal(store.documents().length, 2);
    assert.equal(store.documents().find((doc) => doc.doc_id === first.doc_id).text, 'DSH 的压缩阈值默认是 0.8');
    assert.equal(collided.schema_version, 1);

    // A web fact is classified as external sourcing even without a category.
    const web = store.remember({ text: 'DSH 插件文档在线上可查', source: 'web', url: 'https://example.com/docs' });
    assert.equal(web.category, 'external_sources');
    assert.equal(web.url, 'https://example.com/docs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a changed value is an update, not a silent merge', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    const first = store.remember({
      text: 'DSH 的本地服务端口默认是 8080，改端口后需要重启插',
      category: 'tools_apis',
    }, { confirm: true });
    const oldId = first.doc_id;

    const blocked = store.remember({
      text: 'DSH 的本地服务端口默认是 8081，改端口后需要重启插',
      category: 'tools_apis',
    });
    assert.equal(blocked.needs_confirm, true);
    assert.equal(blocked.kind, 'update');
    assert.equal(blocked.conflicts[0].doc_id, oldId);
    assert.equal(blocked.conflicts[0].update, true);
    assert.equal(blocked.conflicts[0].change.kind, 'number');
    assert.deepEqual(blocked.conflicts[0].change.before, ['8080']);
    assert.deepEqual(blocked.conflicts[0].change.after, ['8081']);
    assert.equal(store.documents().length, 1);
    assert.equal(store.documents()[0].text, 'DSH 的本地服务端口默认是 8080，改端口后需要重启插');

    const updated = store.remember({
      text: 'DSH 的本地服务端口默认是 8081，改端口后需要重启插',
      category: 'tools_apis',
    }, { confirm: true });
    assert.equal(updated.doc_id, oldId);
    assert.equal(updated.text, 'DSH 的本地服务端口默认是 8081，改端口后需要重启插');
    assert.equal(updated.changes.length, 1);
    assert.equal(updated.changes[0].kind, 'number');
    assert.equal(updated.changes[0].previous_text, 'DSH 的本地服务端口默认是 8080，改端口后需要重启插');
    assert.equal(store.documents().length, 1);
    const hit = store.search('本地服务端口', { mode: 'bm25' })[0];
    assert.equal(hit.changes_count, 1);

    // Decimals are not content tokens, so the base Jaccard is 1 here; the
    // number comparison must still catch 0.8 0.9 as an update.
    const threshold = store.remember({
      text: '压缩阈值默认是 0.8，超过就压缩上下',
      category: 'tools_apis',
    }, { confirm: true });
    const decimalUpdate = store.remember({
      text: '压缩阈值默认是 0.9，超过就压缩上下',
      category: 'tools_apis',
    });
    assert.equal(decimalUpdate.kind, 'update');
    assert.deepEqual(decimalUpdate.conflicts[0].change.before, ['0.8']);
    assert.deepEqual(decimalUpdate.conflicts[0].change.after, ['0.9']);
    assert.equal(store.documents().find((doc) => doc.doc_id === threshold.doc_id).text,
      '压缩阈值默认是 0.8，超过就压缩上下');

    // Even a non-value rewrite is visible: it merges, but records a text change
    // instead of replacing the old sentence with no trace.
    const paraphrase = store.remember({
      text: '压缩阈值默认是 0.8，超过就压缩上下文',
      category: 'tools_apis',
    });
    assert.equal(paraphrase.merged, true);
    assert.equal(paraphrase.changes.length, 1);
    assert.equal(paraphrase.changes[0].kind, 'text');

    // An exact restatement still merges silently and records no new change.
    const same = store.remember({
      text: 'DSH 的本地服务端口默认是 8081，改端口后需要重启插',
      category: 'tools_apis',
    });
    assert.equal(same.merged, true);
    assert.equal(same.changes.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('promote never rewrites a confirmed fact and queues material updates', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    const originalText = 'DSH 的本地服务端口默认是 8080，改端口后需要重启插件并重新连接面板';
    const changedText = 'DSH 的本地服务端口默认是 8081，改端口后需要重启插件并重新连接面板';
    const first = store.remember({
      text: originalText,
      category: 'project_facts',
      source: 'user',
      provenance: 'user',
      verified: true,
    }, { confirm: true });
    const originalRevision = first.revision;

    // A non-material restatement from mining may add evidence, but the sentence
    // the user confirmed must survive untouched.
    const supported = store.remember({
      text: 'DSH 的本地服务端口默认是 8080,改端口后需要重启插件并重新连接面板',
      category: 'project_facts',
      source: 'staging',
      evidence: [{ kind: 'staging', ref: 'staging:support' }],
    }, { preserveText: true });
    assert.equal(supported.merged, true);
    assert.equal(supported.preserved_text, true);
    assert.equal(supported.text, originalText);
    assert.equal(supported.revision, originalRevision);
    assert.equal(supported.changes, undefined);

    // A material value change is not written by mining at all.
    store.stage({ content: changedText, kind: 'state', verify: 'pass' });
    const preview = store.promoteKnowledge({ dryRun: true });
    assert.equal(preview.pending.length, 1);
    assert.equal(store.documents()[0].text, originalText);

    const mined = store.promoteKnowledge();
    assert.equal(mined.pending.length, 1);
    assert.equal(mined.added.length, 0);
    assert.equal(store.documents()[0].text, originalText);
    assert.equal(store.pendingPromotions().length, 1);
    assert.equal(store.pendingPromotions()[0].update_of, first.doc_id);
    assert.equal(store.pendingPromotions()[0].text, changedText);
    const ui = buildUiState(store);
    assert.equal(ui.knowledgePendingUpdates.length, 1);
    assert.equal(ui.knowledgePendingUpdates[0].update_of, first.doc_id);
    assert.equal(ui.knowledgePendingUpdates[0].text, changedText);

    // Re-running dedupes the same proposal and keeps it pending for review.
    const again = store.promoteKnowledge();
    assert.equal(again.pending.length, 1);
    assert.equal(store.pendingPromotions().length, 1);

    // Only an explicit confirmation applies it, and resolves the review item.
    const confirmed = store.remember({
      text: changedText,
      category: 'project_facts',
      source: 'user',
      provenance: 'user',
      verified: true,
    }, { confirm: true });
    assert.equal(confirmed.doc_id, first.doc_id);
    assert.equal(confirmed.text, changedText);
    assert.ok(confirmed.revision > originalRevision);
    assert.equal(store.pendingPromotions().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RRF fuses RAG and local ranks without dropping channel-unique documents', () => {
  assert.equal(RRF_K, 60);
  const fused = reciprocalRankFusion([
    {
      name: 'rag',
      rows: [
        { doc_id: 'rag_only', text: 'RAG 独有', score: 0.92, origin_key: 's1' },
        { doc_id: 'both', text: '两个通道都有', score: 0.81, origin_key: 's1' },
      ],
    },
    {
      name: 'local',
      rows: [
        { doc_id: 'both', text: '两个通道都有', score: 4.2, origin_key: 's1' },
        { doc_id: 'local_only', text: '旧文档，只被 BM25 索引', score: 1.5, origin_key: 's1' },
      ],
    },
  ]);
  assert.equal(fused[0].doc_id, 'both');
  assert.equal(fused[0].rrf_ranks.rag, 2);
  assert.equal(fused[0].rrf_ranks.local, 1);
  assert.ok(Math.abs(fused[0].rrf_score - (1 / 62 + 1 / 61)) < 1e-12);
  const localOnly = fused.find((row) => row.doc_id === 'local_only');
  assert.ok(localOnly);
  assert.equal(localOnly.rrf_ranks.local, 2);
  assert.equal(localOnly.rrf_ranks.rag, undefined);
  const ragOnly = fused.find((row) => row.doc_id === 'rag_only');
  assert.ok(ragOnly);
  assert.equal(ragOnly.rrf_ranks.rag, 1);
  assert.equal(ragOnly.rrf_ranks.local, undefined);
  // Same doc_id in different conversations must not collapse into one row.
  const isolated = reciprocalRankFusion([
    { name: 'local', rows: [{ doc_id: 'same', text: 'A', origin_key: 'a' }] },
    { name: 'local', rows: [{ doc_id: 'same', text: 'B', origin_key: 'b' }] },
  ]);
  assert.equal(isolated.length, 2);
});

test('RAG + local BM25 are fused with RRF and the deduped old doc remains visible', async () => {
  const root = tempRoot();
  const previousFetch = globalThis.fetch;
  try {
    const store = new MemoryStore(root);
    const oldDoc = store.remember({
      text: '旧版部署脚本放在 scripts/legacy-deploy.ps1，步骤沿用 2019 年的流程。',
      category: 'project_facts',
    }, { confirm: true });
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    const newDoc = store.remember({
      text: '新版发布流程改用 GitHub Actions，部署入口是 .github/workflows/release.yml。',
      category: 'project_facts',
    }, { confirm: true });
    const endpoint = normalizeExternal({ baseUrl: 'http://mock.local', model: 'mock-embed' });
    const fake = async (url, init) => {
      if (url.endsWith('/embeddings')) {
        const body = JSON.parse(init.body);
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return new Response(JSON.stringify({
          data: inputs.map(() => ({ embedding: [1, 0, 0] })),
        }), { status: 200 });
      }
      if (url.endsWith('/rerank')) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          results: body.documents.map((_, index) => ({
            index,
            relevance_score: 1 - index * 0.01,
          })),
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    await buildRagIndex(store, endpoint, { fetchImpl: fake });
    const index = readRagIndex(root);
    assert.equal(Object.keys(index.docs).length, 1);
    // The semantic index keeps the newer representative only.
    assert.equal(index.docs[oldDoc.doc_id], undefined);
    assert.ok(index.docs[newDoc.doc_id]);

    const config = normalizeConfig({
      root,
      ragMount: true,
      externalBaseUrl: 'http://mock.local',
      externalEmbedModel: 'mock-embed',
      externalRerankModel: 'mock-rerank',
    });
    globalThis.fetch = fake;
    const result = await searchWithRag(
      config,
      [{ store, label: '本对话', key: 's1', scope: 'session' }],
      'legacy-deploy',
      { topK: 5, store },
    );
    assert.equal(result.ok, true);
    assert.match(result.text, /RRF 融合/);
    assert.match(result.text, /legacy-deploy/);
    assert.match(result.text, /BM25#/);
    assert.match(result.text, /RAG#/);
    // RRF is the final order. If a post-fusion multiplier reorders hits, the
    // printed RRF values stop being monotonic — the exact bug users saw as
    // "RAG#1 is printed below RAG#4".
    const rrfValues = [...result.text.matchAll(/RRF=([0-9.]+)/g)].map((match) => Number(match[1]));
    assert.ok(rrfValues.length > 0);
    for (let index = 1; index < rrfValues.length; index += 1) {
      assert.ok(rrfValues[index - 1] >= rrfValues[index] - 1e-12,
        `RRF printout is not monotonic at ${index}: ${rrfValues.join(', ')}`);
    }
    assert.match(result.text, /通道内先按使用率/);
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('knowledge tools write, learn in batch and preview promotion', async () => {
  const root = tempRoot();
  try {
    const memoryRoot = path.join(root, 'memory');
    const registered = [];
    const ctx = {
      tools: { register: (tool) => { registered.push(tool); return () => {}; } },
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
    };
    apply(ctx, { root: memoryRoot });
    const memory = registered.find((tool) => tool.name === 'aim_memory');
    const exec = { agent: { session: { id: 'session-k', header: { cwd: root }, ownEvents: () => [] } } };

    const one = await memory.execute({
      action: 'remember',
      text: '面板设置保存后会重载插件',
      category: 'ui_facts',
      source: 'reasoning',
      tags: ['panel'],
    }, exec);
    assert.match(one, /知识已写入/);
    assert.match(one, /ui_facts/);
    assert.match(one, /panel/);

    const batch = await memory.execute({
      action: 'learn',
      items: [
        { text: 'aim_search 默认跨对话检索', category: 'tools_apis', source: 'reasoning' },
        { text: '网页知识要带出处链接', category: 'external_sources', source: 'web', url: 'https://example.com/k' },
      ],
    }, exec);
    assert.match(batch, /已写入知识 2 条/);
    assert.match(batch, /新增 2/);

    // The only caller of aim_memory is the model. Even source=user/reasoning is
    // a model transcription, so tool writes must start unverified.
    const written = new MemoryScopes(memoryRoot).sessionStoreFor('session-k', {}).store.documents();
    assert.equal(written.length, 3);
    assert.ok(written.every((doc) => doc.provenance === 'model' && doc.verified === false));

    const st = await memory.execute({ action: 'status' }, exec);
    assert.match(st, /知识库：3 篇/);
    assert.match(st, /知识来源：/);
    assert.match(st, /待提炼：约/);

    // Promote on an empty three-layer set writes nothing but still reports.
    const promote = await memory.execute({ action: 'promote', dry_run: true }, exec);
    assert.match(promote, /提炼预览（未写入）/);
    assert.match(promote, /过程记录 0/);

    // A wrong fact can be removed; an unknown id reports instead of pretending.
    const forgotten = await memory.execute({ action: 'forget', doc_id: 'k_missing' }, exec);
    assert.match(forgotten, /未删除/);
    const listed = await memory.execute({ action: 'status' }, exec);
    assert.match(listed, /知识库：3 篇/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verification clears a model claim and incidents are compact unverified prose', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    const claim = store.remember({
      text: '发布分支可能是 release',
      category: 'project_facts',
      source: 'reasoning',
      provenance: 'model',
      verified: false,
    }, { confirm: true });
    const before = store.documents().find((doc) => doc.doc_id === claim.doc_id);
    assert.equal(before.provenance, 'model');
    assert.equal(before.verified, false);
    const evidenceBefore = before.evidence.length;

    const result = store.verifyKnowledge(claim.doc_id);
    assert.equal(result.verified, true);
    assert.equal(result.doc_id, claim.doc_id);
    const after = store.documents().find((doc) => doc.doc_id === claim.doc_id);
    assert.equal(after.doc_id, before.doc_id);
    assert.equal(after.text, before.text, 'confirmation never rewrites the sentence');
    assert.equal(after.verified, true);
    assert.equal(after.evidence.length, evidenceBefore + 1);
    assert.equal(after.evidence.at(-1).kind, 'user-confirm');

    const undone = store.unverifyKnowledge(claim.doc_id);
    assert.equal(undone.undone, true);
    const reverted = store.documents().find((doc) => doc.doc_id === claim.doc_id);
    assert.equal(reverted.verified, false);
    assert.equal(reverted.confirmed, false);
    assert.equal(reverted.source, before.source);
    assert.equal(reverted.evidence.length, evidenceBefore);
    // A second undo is a no-op rather than a source-mangling edit.
    assert.equal(store.unverifyKnowledge(claim.doc_id).undone, undefined);

    // A claim written without a source is untraceable by default. Confirming it
    // must make the confirmation itself the traceable source; otherwise every
    // reload forces verified back to false and the panel button looks broken.
    const untraceable = store.remember({ text: '没有写来源的模型结论' }, { confirm: true });
    assert.equal(untraceable.source, 'unknown');
    assert.equal(untraceable.verified, false);
    assert.equal(untraceable.confirmed, false);
    const fixed = store.verifyKnowledge(untraceable.doc_id);
    assert.equal(fixed.verified, true);
    const reloaded = new MemoryStore(root).documents().find((doc) => doc.doc_id === untraceable.doc_id);
    assert.equal(reloaded.verified, true);
    assert.equal(reloaded.confirmed, true);
    assert.equal(reloaded.source, 'user-confirmed');
    assert.equal(reloaded.provenance, 'user');
    // Export → re-import must not erase the confirmation either.
    const exported = buildKnowledgeExport(store).docs.find((doc) => doc.doc_id === untraceable.doc_id);
    const imported = normalizeKnowledge(exported);
    assert.equal(imported.verified, true);
    assert.equal(imported.source, 'user-confirmed');

    const incident = store.recordIncident({
      title: '一次测试事故',
      what_happened: '文件被覆盖',
      cause: '错误的写入命令',
      fix: '从快照恢复',
      prevention: '写入前先备份',
    });
    assert.equal(incident.provenance, 'model');
    assert.equal(incident.verified, false);
    assert.ok(incident.confidence < 1);
    assert.equal(/\n/.test(incident.text), false, 'incident is one compact line, not a six-line template');
    assert.match(incident.text, /\[事故\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ui state exposes knowledge provenance and pending count', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    store.remember({
      text: '新知识要带分类',
      category: 'workflow_rules',
      source: 'user',
      tags: ['rule'],
      evidence: [{ kind: 'authored', ref: 'user' }],
    });
    store.stage({ content: '提交前必须先跑测试', kind: 'action' });
    const stored = store.documents()[0];
    store.recordKnowledgeUsage([stored.doc_id]);
    const state = buildUiState([{ store, scope: 'session', label: '本对话' }]);
    assert.equal(state.counts.knowledge, 1);
    assert.equal(state.knowledgeTotal, 1);
    assert.equal(state.knowledgeReturned, 1);
    assert.equal(state.knowledgeLimit, 200);
    assert.equal(state.knowledgeLimited, false);
    const doc = state.knowledge[0];
    assert.equal(doc.category, 'workflow_rules');
    assert.equal(doc.source, 'user');
    assert.deepEqual(doc.tags, ['rule']);
    assert.equal(doc.evidence_count, 1);
    assert.equal(doc.hits, 1);
    assert.ok(doc.weight > 0);
    assert.ok(state.knowledgePending >= 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ui state discloses the 200-row knowledge cap instead of hiding rows', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true });
    for (let index = 0; index < 201; index += 1) {
      // Write the JSON base directly: `remember` intentionally merges
      // near-duplicate prose, which would make this a dedupe test instead of a
      // pagination-cap test.
      fs.writeFileSync(path.join(root, 'knowledge', `k_cap_${index}.json`), JSON.stringify({
        doc_id: `k_cap_${index}`,
        text: `唯一知识条目 ${index} 用于验证知识点分页上限`,
        category: 'project_facts',
        source: 'user',
        evidence: [{ kind: 'authored', ref: 'user' }],
      }));
    }
    const state = buildUiState([{ store, scope: 'session', label: '本对话' }]);
    assert.equal(state.counts.knowledge, 201);
    assert.equal(state.knowledgeTotal, 201);
    assert.equal(state.knowledgeReturned, 200);
    assert.equal(state.knowledgeLimit, 200);
    assert.equal(state.knowledgeLimited, true);
    assert.equal(state.knowledge.length, 200);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('panel wiring keeps knowledge filters, batch confirm and cap disclosure', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  for (const needle of [
    'knowledgeCategory', 'knowledgeSource', 'knowledgeStatus', 'knowledgeSort',
    'selectedKnowledge', 'verifySelectedKnowledge', 'knowledgeLimited',
    'cappedNotice', 'verifyUndo', 'retentionConfirm', 'localModelStopConfirm',
  ]) {
    assert.ok(source.includes(needle), `panel wiring is missing ${needle}`);
  }
});

test('new conversations get their own folder, title and access default', () => {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const memoryRoot = path.join(root, 'memory');
    const registryDir = path.join(root, 'registry');
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (name, handler) => { handlers.set(name, handler); return () => {}; },
      get: (service) => (service === 'sessionTitle'
        ? { get: () => ({ title: '大肥鱼', source: { kind: 'fallback' } }) }
        : undefined),
    };
    const config = normalizeConfig({ root: memoryRoot });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir, getService: ctx.get }, runtime);
    const onCreated = handlers.get('session/created');
    assert.equal(typeof onCreated, 'function');

    const session = { id: 'session-big-fish', header: { cwd: workspace } };
    onCreated(session);

    const scopes = new MemoryScopes(memoryRoot);
    const rows = scopes.listSessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, 'session-big-fish');
    assert.equal(rows[0].title, '大肥鱼');
    assert.equal(rows[0].name, '大肥鱼');
    assert.equal(rows[0].public, false);
    const key = rows[0].key;
    // The folder exists with its six layers, ready for the first write.
    for (const dir of ['staging', 'archive', 'snapshots', 'knowledge', 'decisions', 'contexts']) {
      assert.ok(fs.existsSync(path.join(memoryRoot, 'sessions', key, dir)), dir);
    }
    assert.ok(fs.existsSync(path.join(memoryRoot, 'sessions', key, 'session.json')));

    // Subagent sessions must not spawn their own memory folders.
    onCreated({ id: 'session-child', header: { cwd: workspace, parentSession: 'session-big-fish' } });
    assert.equal(scopes.listSessions().length, 1);

    // An explicit label wins over the generated title.
    scopes.touch(key, { label: '修复 GitHub 发布文件夹问题' });
    assert.equal(scopes.listSessions()[0].name, '修复 GitHub 发布文件夹问题');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default memory directory is appended to an existing project .gitignore once', () => {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'project');
    fs.mkdirSync(workspace, { recursive: true });
    const file = path.join(workspace, '.gitignore');
    fs.writeFileSync(file, 'node_modules\n');

    const first = ensureGitignoreEntry(workspace, '.ai-for-memory/');
    assert.equal(first.changed, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'node_modules\n.ai-for-memory/\n');

    const second = ensureGitignoreEntry(workspace, '.ai-for-memory/');
    assert.equal(second.changed, false);
    assert.equal(second.reason, 'already-ignored');

    // A user who wrote it with a leading or trailing variant is still covered.
    fs.writeFileSync(file, '/.ai-for-memory/\n');
    assert.equal(ensureGitignoreEntry(workspace, '.ai-for-memory/').reason, 'already-ignored');

    // No .gitignore means no file is invented, and custom roots are left alone.
    fs.rmSync(file);
    const missing = ensureDefaultMemoryDirIgnored(
      path.join(workspace, '.ai-for-memory'), workspace, '.ai-for-memory',
    );
    assert.equal(missing.reason, 'no-gitignore');
    assert.match(missing.warning, /没有 \.gitignore/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(defaultMemoryDirIgnoreStatus(path.join(workspace, '.ai-for-memory'), workspace).state, 'no-gitignore');

    fs.writeFileSync(file, 'dist/\n');
    const custom = ensureDefaultMemoryDirIgnored(
      path.join(root, 'outside-memory'), workspace, '.ai-for-memory',
    );
    assert.equal(custom.reason, 'custom-root');
    assert.equal(fs.readFileSync(file, 'utf8'), 'dist/\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('first default memory context adds the ignore entry before creating the directory', () => {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const file = path.join(workspace, '.gitignore');
    fs.writeFileSync(file, 'build/\n');
    const exec = { agent: { session: { id: 'session-ignore', header: { cwd: workspace } } } };

    memoryContext(normalizeConfig({}), exec, { registryDir: path.join(root, 'registry') });

    assert.match(fs.readFileSync(file, 'utf8'), /(^|\n)\.ai-for-memory\/\n$/);
    // The context only prepares the root; it must not create the archive yet.
    assert.equal(fs.existsSync(path.join(workspace, '.ai-for-memory')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('closed conversations are invisible to other conversations', async () => {
  const root = tempRoot();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(root, 'dsh-home');
  try {
    const memoryRoot = path.join(root, 'memory');
    const registered = [];
    apply({
      tools: { register: (tool) => { registered.push(tool); return () => {}; } },
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
    }, { root: memoryRoot });
    const memory = registered.find((tool) => tool.name === 'aim_memory');
    const searchTool = registered.find((tool) => tool.name === 'aim_search');
    const contextTool = registered.find((tool) => tool.name === 'aim_context');

    const execA = { agent: { session: { id: 'conv-open', header: { cwd: root }, ownEvents: () => [] } } };
    const execB = { agent: { session: { id: 'conv-other', header: { cwd: root }, ownEvents: () => [] } } };

    await memory.execute({
      action: 'remember', doc_id: 'open_doc', text: '开放对话的部署笔记', category: 'errors_fixes',
    }, execA);
    await memory.execute({
      action: 'remember', doc_id: 'other_doc', text: '另一个对话的私有布置', category: 'errors_fixes',
    }, execB);

    const scopes = new MemoryScopes(memoryRoot);
    const keyA = sessionKey('conv-open');
    scopes.setPublic(keyA, false);

    // The other conversation can still search its own knowledge only.
    const cross = await searchTool.execute({ query: '部署', scope: 'all' }, execB);
    assert.doesNotMatch(cross, /open_doc/);

    // Its own scope always sees its own data, even when closed.
    const own = await searchTool.execute({ query: '部署', scope: 'session' }, execA);
    assert.match(own, /open_doc/);

    const status = await memory.execute({ action: 'status' }, execB);
    assert.match(status, /另有 1 个对话未对外开放/);

    const conversations = await contextTool.execute({ action: 'sessions' }, execB);
    assert.match(conversations, /共 1 个对话/);
    assert.match(conversations, /另有 1 个对话未对外开放/);

    // Re-opening makes it visible again.
    scopes.setPublic(keyA, true);
    const reopened = await searchTool.execute({ query: '部署', scope: 'all' }, execB);
    assert.match(reopened, /open_doc/);
  } finally {
    process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cross-conversation search folds the same fact into one hit', async () => {
  const root = tempRoot();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(root, 'dsh-home');
  try {
    const memoryRoot = path.join(root, 'memory');
    const registered = [];
    apply({
      tools: { register: (tool) => { registered.push(tool); return () => {}; } },
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
    }, { root: memoryRoot });
    const memory = registered.find((tool) => tool.name === 'aim_memory');
    const searchTool = registered.find((tool) => tool.name === 'aim_search');
    const execA = { agent: { session: { id: 'conv-dup-a', header: { cwd: root }, ownEvents: () => [] } } };
    const execB = { agent: { session: { id: 'conv-dup-b', header: { cwd: root }, ownEvents: () => [] } } };

    // Both writes are legitimate under their own store's dedupe gate.
    await memory.execute({
      action: 'remember', text: '发布前必须跑测试', category: 'workflow_rules',
    }, execA);
    await memory.execute({
      action: 'remember', text: '发布前必须跑测试', category: 'workflow_rules',
    }, execB);

    const scopes = new MemoryScopes(memoryRoot);
    scopes.setPublic(sessionKey('conv-dup-a'), true);
    scopes.setPublic(sessionKey('conv-dup-b'), true);

    const result = await searchTool.execute({
      query: '发布前必须跑测试', scope: 'all', top_k: 5,
    }, execA);
    // One top_k slot, not two; the other conversation is only a "see also" note.
    assert.equal((result.match(/发布前必须跑测试/g) ?? []).length, 1);
    assert.match(result, /已折叠跨来源重复 1 /);
    assert.match(result, /另见/);
  } finally {
    process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('config validator bounds auto settings', () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.autoEnabled, false);
  assert.equal(defaults.autoEveryRounds, 5);
  assert.equal(defaults.contextUsagePercent, 70);
  assert.equal(defaults.maxContextChars, 30000);
  assert.equal(defaults.defaultPublic, false);
  assert.equal(defaults.topicalClear, true);
  assert.equal(defaults.keepRecentTurns, 2);
  assert.equal(defaults.similarityThreshold, 0.05);
  assert.equal(defaults.minClearChars, 200);
  assert.equal(defaults.externalBaseUrl, '');
  const validator = Config['~standard'].validate;
  assert.equal(validator({ autoEnabled: true, autoEveryRounds: 3 }).value.autoEnabled, true);
  assert.equal(validator({ defaultPublic: false }).value.defaultPublic, false);
  assert.equal(validator({ keepRecentTurns: 3 }).value.keepRecentTurns, 3);
  assert.equal(validator({ similarityThreshold: 0.12 }).value.similarityThreshold, 0.12);
  assert.ok(validator({ defaultPublic: 'no' }).issues);
  assert.ok(validator({ autoEnabled: 'yes' }).issues);
  assert.ok(validator({ autoEveryRounds: 0 }).issues);
  assert.ok(validator({ autoEveryRounds: 101 }).issues);
  assert.equal(validator({ contextUsagePercent: 85 }).value.contextUsagePercent, 85);
  assert.ok(validator({ contextUsagePercent: 0 }).issues);
  assert.ok(validator({ contextUsagePercent: 101 }).issues);
  assert.ok(validator({ contextUsagePercent: 70.5 }).issues);
  assert.ok(validator({ maxContextChars: 500 }).issues);
  assert.ok(validator({ keepRecentTurns: 0 }).issues);
  assert.ok(validator({ keepRecentTurns: 2.5 }).issues);
  assert.ok(validator({ similarityThreshold: 1.5 }).issues);
  assert.ok(validator({ similarityThreshold: 'high' }).issues);
  assert.ok(validator({ topicalClear: 'yes' }).issues);
});

test('context pressure triggers only when measured usage reaches the threshold', () => {
  const measured = { pressureTokens: 70000, contextWindow: 100000 };
  assert.equal(usagePercentOf(measured), 70);
  assert.equal(exceedsUsageThreshold(measured, 70), true);
  assert.equal(exceedsUsageThreshold(measured, 70.1), false);
  assert.equal(exceedsUsageThreshold({ pressureTokens: 30000, contextWindow: 100000 }, 70), false);
  // Unmeasured sessions must never look like 0% or trigger a clear.
  assert.equal(usagePercentOf(null), null);
  assert.equal(usagePercentOf({}), null);
  assert.equal(usagePercentOf({ pressureTokens: 10, contextWindow: 0 }), null);
  assert.equal(exceedsUsageThreshold(null, 70), false);
  assert.equal(exceedsUsageThreshold(measured, 0), false);
  assert.match(formatPressure(measured), /^70%（70000\/100000 tokens）$/);
  assert.match(formatPressure(null), /未知/);
});

test('config validator accepts defaults and rejects wrong types', () => {
  const validator = normalizeConfig;
  assert.equal(validator({}).directoryName, '.ai-for-memory');
  assert.equal(validator({}).mcpEnabled, true);
  assert.equal(validator({}).maxContextChars, 30000);
  assert.equal(validator({}).defaultTopK, 5);
  assert.equal(validator({}).reviewHighRiskOnly, true);
  assert.equal(validator({}).maxContentChars, 20000);
  assert.equal(validator({}).maxSnapshotBytes, 262144);
  assert.equal(validator({}).maxClearTurns, 8);
  assert.equal(validator({}).minClearChars, 200);
  assert.equal(validator({}).maxClearChars, 120000);
  assert.equal(validator({}).autoKnowledge, true);
  assert.equal(validator({}).autoKnowledgeLimit, 10);
  assert.equal(validator({}).stagingRetentionDays, 30);
  assert.equal(validator({}).contextRetentionDays, 0);
  assert.equal(validator({}).decisionRetentionDays, 0);
  assert.equal(validator({}).requestAnchor, true);
  assert.equal(validator({ mcpEnabled: false }).mcpEnabled, false);
  assert.equal(validator({ mcpToken: 'secret' }).mcpToken, 'secret');
  assert.equal(validator({ defaultTopK: 9 }).defaultTopK, 9);
  const tools = createTools(normalizeConfig({ defaultTopK: 7 }));
  assert.match(tools[1].parameters.top_k.description, /7/);
  assert.ok(CATEGORIES.length === 7);
  assert.ok(tokenize('API 超时').includes('超时'));
});

test('topic similarity separates related turns from unrelated ones', () => {
  const related = topicSimilarity(
    '上下文清理按相似度保留高相似度的轮次',
    '上下文清理要按相似度来，删掉的能恢复',
  );
  const unrelated = topicSimilarity('数据库索引的 B+ 树结构', '晚餐吃火锅还是烧烤');
  assert.ok(related > 0.15, `related=${related}`);
  assert.ok(unrelated < 0.05, `unrelated=${unrelated}`);
  assert.equal(topicSimilarity('', '任何内容'), 0);
  assert.equal(topicSimilarity('只有空白的判断', '   '), 0);

  // Single Han characters are function words, so they never count as content.
  assert.equal(contentTokens('的了是在').has('的'), false);
  assert.equal(contentTokens('上下文清理').has('清理'), true);
});

test('similarity selection keeps on-topic turns and their recent neighbours', () => {
  const turns = [
    { turn: 1, text: '上下文清理要按相似度保留高相似度的轮次' },
    { turn: 2, text: '晚餐吃火锅还是烧烤' },
    { turn: 3, text: '今天天气不错适合出门散步' },
    { turn: 4, text: '继续任务吧，上下文清理要按相似度来，删掉的能恢复' },
  ];
  const selection = selectTurnsByTopic(turns, { threshold: 0.05, keepRecent: 2 });
  assert.equal(selection.threshold, 0.05);
  assert.deepEqual(selection.anchors, [3, 4]);
  assert.deepEqual(selection.keep.map((turn) => turn.turn), [1, 3, 4]);
  assert.deepEqual(selection.clear.map((turn) => turn.turn), [2]);
  // Kept-by-recent turns are labelled so a log can explain the decision.
  assert.equal(selection.keep[1].keptBy, 'recent');
  assert.equal(selection.keep[0].keptBy, 'topic');
  assert.ok(selection.clear[0].similarity < 0.05);

  // A higher threshold clears more, and keepRecent still protects the tail.
  const strict = selectTurnsByTopic(turns, { threshold: 0.8, keepRecent: 2 });
  assert.deepEqual(strict.keep.map((turn) => turn.turn), [3, 4]);
});

/** Four turns where the first two left the topic the last two talk about. */
function offTopicEvents() {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '数据库索引的 B+ 树结构怎么设计：订单表已经三千万行，按 created_at 做范围查询要十几秒。先看执行计划，确认有没有走索引，再决定联合索引的列顺序和填充因子' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '按页大小和填充因子决定；如果查询总是按 status，就把 status 放在第二列，并注意统计信息过期后 ANALYZE 一下。' }] } } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '晚餐吃火锅还是烧烤：冰箱里还有番茄和牛腩，但今天不想做饭，想出去吃点热乎的，最好别太辣' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '都可以，你定；如果想吃清淡一点就选火锅，想快一点就烧烤，记得先看看排队情况' }] } } },
    { type: 'turn/end', data: { turn: 2 } },
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '上下文清理要按相似度来，高的留下' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，低相似度才清出' }] } } },
    { type: 'turn/end', data: { turn: 3 } },
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '继续任务吧，上下文清理删掉的要能恢复' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '明白，先存档再清理' }] } } },
    { type: 'turn/end', data: { turn: 4 } },
  ];
}

test('similarity clear removes unrelated turns and their archive stays restorable', async () => {
  const root = tempRoot();
  const memoryRoot = path.join(root, 'memory');
  try {
    const { session, log, nodes } = fakeSession(offTopicEvents());
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: (service) => (service === 'agents' ? {
        get: () => ({
          whenIdle: async () => {},
          runMaintenance: async (task) => task(),
        }),
      } : undefined),
    };
    const config = normalizeConfig({
      root: memoryRoot,
      keepRecentTurns: 2,
    });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);

    const before = nodes.length;
    runtime.pending.set('session-clear', 'manual');
    handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // One replaced node for the two adjacent off-topic turns; the on-topic
    // turns 3-4 stay verbatim on the surface.
    assert.equal(nodes.length, before - 3);
    // The log keeps the original events (that is what `restore` reads); only
    // the model-visible surface is shadowed by the replacement.
    const keptText = nodes.map((seq) => log[seq])
      .flatMap((event) => event.data?.content ?? event.data?.message?.content ?? [])
      .map((block) => block.text ?? '')
      .join('\n');
    assert.match(keptText, /上下文清理要按相似度来/);
    assert.doesNotMatch(keptText, /数据库索引/);

    const scopes = new MemoryScopes(memoryRoot);
    const store = scopes.sessionStoreFor('session-clear', {}).store;
    const contexts = store.listContexts();
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].label, 'before-clear');
    const archived = store.loadContext(contexts[0].context_id);
    assert.equal(archived.turn_from, 1);
    assert.equal(archived.turn_to, 2);
    assert.match(archived.text, /数据库索引/);
    assert.match(archived.text, /晚餐吃火锅/);

    const replacement = log.find((event) => event.type === 'user/message' && event.surfaceOp);
    assert.match(replacement.data.content[0].text, /上下文清理/);
    assert.match(replacement.data.content[0].text, new RegExp(contexts[0].context_id));
    assert.deepEqual(replacement.data.source, {
      kind: 'ai-for-memory',
      form: 'notice',
      summary: replacement.data.source.summary,
    });
    assert.match(replacement.data.source.summary, /^上下文清理：/);
    assert.deepEqual(replacement.sourceEventSeqs, [1, 2, 5, 6]);
    assert.ok(log.some((event) => event.type === 'compaction/prune'));

    const status = store.readCompactionStatus();
    assert.equal(status.state, 'done');
    assert.equal(status.turns, 2);
    assert.equal(status.kept, 2);
    assert.equal(status.threshold, config.similarityThreshold);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('raw context archives keep tool results and untruncated message tails', () => {
  const long = `${'长'.repeat(5000)}TAIL_MARKER`;
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: long }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '调用工具' }] } } },
    { type: 'tool/result', data: { content: [{ type: 'text', text: 'TOOL_OUTPUT_MARKER' }] } },
    { type: 'turn/end', data: { turn: 1 } },
  ];
  const turns = collectTurns(events);
  const snapshot = snapshotOfTurns(turns, { maxChars: Infinity });
  // The display field is intentionally capped, but the raw archive is not.
  assert.ok(snapshot.turns[0].user.length < long.length);
  const record = {
    ...snapshot,
    raw_events: events.map((event, seq) => ({ ...event, seq })),
  };
  const restored = formatRestoreContext(record, { maxChars: 100000 });
  assert.match(restored, /TOOL_OUTPUT_MARKER/);
  assert.match(restored, /TAIL_MARKER/);
});

test('plugin notices stay out of turn.user and never become user rules', () => {
  const notice = '版本号只在正式发布到 GitHub 时修改，本地修 bug 不要改。';
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '检查一下发布流程' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] } } },
    // A clear/anchor note is model-visible, but it is not the user speaking.
    { type: 'user/message', data: {
      role: 'user',
      content: [{ type: 'text', text: notice }],
      source: { kind: 'ai-for-memory', form: 'notice' },
    } },
    { type: 'turn/end', data: { turn: 1 } },
  ];
  const turns = collectTurns(events);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user, '检查一下发布流程');
  assert.deepEqual(turns[0].notices, [notice]);
  // The archive still shows the notice, just not as the user's words.
  assert.match(snapshotOfTurns(turns, { maxChars: Infinity }).text, /便条：/);
  assert.ok(candidatesFromTurn(turns[0], 'ctx-notice').every((item) => !item.text.includes('版本号')));
  const digest = collectTurnDigest(events, 1);
  assert.ok(digest);
  assert.doesNotMatch(digest, /版本号/);
  // Older archives predate the source tag; the text-level guard still keeps
  // known notice lines out of knowledge mining.
  const legacy = { turn: 1, user: '检查一下发布流程\n只处理上面这个请求，不要重复历史回答' };
  assert.ok(candidatesFromTurn(legacy, 'ctx-legacy').every((item) => !item.text.includes('只处理上面')));
});

test('MCP egress lists and routes root-scoped memory tools', async () => {
  const root = tempRoot();
  try {
    const roots = [
      { root: path.join(root, 'mem-a'), workspace: path.join(root, 'work-a'), label: 'a' },
      { root: path.join(root, 'mem-b'), workspace: path.join(root, 'work-b'), label: 'b' },
    ];
    const calls = [];
    const deps = {
      version: '0.3.0',
      listRoots: () => roots,
      runTool: async (name, args, target) => {
        calls.push({ name, args, target });
        return `${name}:${args.query ?? args.text ?? ''}@${target.root}`;
      },
    };
    assert.equal(MCP_PATH, '/ai-for-memory/mcp');
    assert.ok(mcpToolNames().includes('aim_search'));
    assert.ok(mcpToolNames().includes('aim_remember'));

    const init = await handleMcpMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' },
    }, deps);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'ai-for-memory');
    assert.equal(init.result.serverInfo.version, '0.3.0');
    // Without an injected version, MCP falls back to package.json, not a
    // hand-maintained string.
    const initDefault = await handleMcpMessage({
      jsonrpc: '2.0', id: 11, method: 'initialize', params: { protocolVersion: '2025-06-18' },
    }, { ...deps, version: undefined });
    assert.equal(initDefault.result.serverInfo.version, packageVersion());

    const listed = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps);
    assert.ok(listed.result.tools.some((tool) => tool.name === 'aim_context_list'));
    assert.equal(listed.result.tools.find((tool) => tool.name === 'aim_search').annotations.readOnlyHint, true);
    assert.equal(listed.result.tools.find((tool) => tool.name === 'aim_remember').annotations.readOnlyHint, false);

    const search = await handleMcpMessage({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'aim_search', arguments: { query: '发布', root: roots[1].root } },
    }, deps);
    assert.equal(search.result.isError, false);
    assert.ok(search.result.content[0].text.endsWith(`@${roots[1].root}`));
    assert.equal(calls[0].target.workspace, roots[1].workspace);

    const remembered = await handleMcpMessage({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'aim_remember', arguments: { text: '发布前跑测试', root: roots[0].root } },
    }, deps);
    assert.equal(remembered.result.isError, false);
    assert.equal(calls[1].name, 'aim_memory');
    assert.equal(calls[1].args.action, 'remember');
    assert.equal(calls[1].args.scope, 'shared');
    assert.equal(calls[1].args.source, 'mcp');

    const missingRoot = await handleMcpMessage({
      jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'aim_search', arguments: { query: '发布' } },
    }, deps);
    assert.equal(missingRoot.result.isError, true);
    assert.match(missingRoot.result.content[0].text, /必须显式提供 root/);

    const missing = await handleMcpMessage({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'aim_status', arguments: { root: path.join(root, 'nope') } },
    }, deps);
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /没有登记这个记忆根目录/);

    const notice = await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps);
    assert.equal(notice, null);
    const unknown = await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'nope' }, deps);
    assert.equal(unknown.error.code, -32601);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP token is generated once on disk and configured tokens win', () => {
  const root = tempRoot();
  try {
    const first = ensureMcpToken(root);
    assert.equal(first.source, 'file');
    assert.ok(first.token.length >= 32);
    assert.equal(first.file, mcpTokenPath(root));
    assert.equal(fs.readFileSync(first.file, 'utf8').trim(), first.token);
    const second = ensureMcpToken(root);
    assert.equal(second.token, first.token);
    const configured = ensureMcpToken(root, 'configured-token');
    assert.deepEqual(configured, { token: 'configured-token', source: 'config', file: '' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('audit log is append-only, bounded and newest first', () => {
  const root = tempRoot();
  try {
    appendAudit(root, { action: 'knowledge.verify', root: '/memory', detail: 'k_a' });
    appendAudit(root, { action: 'context.clear', root: '/memory', detail: 'c_a' });
    const rows = readAudit(root, 10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, 'context.clear');
    assert.equal(rows[1].action, 'knowledge.verify');
    assert.equal(readAudit(root, 1).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context archives render a readable Markdown escape hatch', () => {
  const markdown = formatContextMarkdown({
    context_id: 'context_test',
    label: 'before-clear',
    created_at: '2026-11-21T00:00:00.000Z',
    turn_from: 1,
    turn_to: 2,
    chars: 42,
    turns: [
      { turn: 1, user: '真实请求：修会话', assistant: '收到' },
      { turn: 2, user: '', notices: ['【上下文清理】旧轮次'], assistant: '完成' },
    ],
  });
  assert.match(markdown, /^# Context archive context_test/);
  assert.match(markdown, /真实请求：修会话/);
  assert.match(markdown, /\*\*Assistant\*\*/);
  assert.match(markdown, /> Notice/);
  assert.match(markdown, /完成/);
});

test('raw context restore keeps the newest segments when the budget is small', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'EARLY_MARKER' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '早期回答' }] } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '中间问题' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'TAIL_MARKER' }] } } },
    { type: 'turn/end', data: { turn: 2 } },
  ];
  const record = {
    context_id: 'c-tail',
    turn_from: 1,
    turn_to: 2,
    raw_events: events.map((event, seq) => ({ ...event, seq })),
  };
  const restored = formatRestoreContext(record, { maxChars: 30 });
  assert.match(restored, /TAIL_MARKER/);
  assert.doesNotMatch(restored, /EARLY_MARKER/);
  assert.match(restored, /按 30 字符预算恢复最近 3\/6 段/);
});

test('raw restore renders tool calls, developer messages, and caps tool results', () => {
  const huge = `${'R'.repeat(9000)}RESULT_TAIL`;
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"CALL_ARG_MARKER"}' } },
    { type: 'developer/message', data: { content: [{ type: 'text', text: 'DEV_MARKER' }] } },
    { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: huge }] } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } } },
    { type: 'turn/end', data: { turn: 1 } },
  ];
  const record = {
    context_id: 'c-tool',
    turn_from: 1,
    turn_to: 1,
    raw_events: events.map((event, seq) => ({ ...event, seq })),
  };
  const restored = formatRestoreContext(record, { maxChars: 100000 });
  assert.match(restored, /CALL_ARG_MARKER/);
  assert.match(restored, /DEV_MARKER/);
  assert.match(restored, /工具结果已截断/);
  assert.doesNotMatch(restored, /RESULT_TAIL/);
});

test('usage pressure resets the whole window instead of keeping topic-similar turns', async () => {
  const root = tempRoot();
  try {
    const rawEvents = onTopicEvents();
    // Prove that turn ranges keep log-only tool calls and developer messages,
    // not just model-visible surface nodes.
    rawEvents.splice(2, 0,
      { type: 'developer/message', data: { content: [{ type: 'text', text: 'ARCHIVE_DEV_MARKER' }] } },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"ARCHIVE_CALL_MARKER"}' } },
    );
    const { session, log, nodes } = fakeSession(rawEvents);
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: (service) => {
        if (service === 'agents') {
          return { get: () => ({ whenIdle: async () => {}, runMaintenance: async (task) => task() }) };
        }
        if (service === 'tokenMeter') {
          return { contextPressure: () => ({ pressureTokens: 70000, contextWindow: 100000 }) };
        }
        return undefined;
      },
    };
    const config = normalizeConfig({
      root: path.join(root, 'memory'),
      autoEnabled: true,
      autoEveryRounds: 100,
      contextUsagePercent: 50,
      keepRecentTurns: 2,
    });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);

    const before = nodes.length;
    handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Every completed turn that is not one of the newest `keepRecentTurns` is
    // replaced by the hard-reset note, even the on-topic ones a similarity
    // clear would have kept.
    assert.ok(nodes.length < before);
    const keptText = nodes.map((seq) => log[seq])
      .flatMap((event) => event.data?.content ?? event.data?.message?.content ?? [])
      .map((block) => block.text ?? '')
      .join('\n');
    assert.doesNotMatch(keptText, /相似度高的留下/);
    // The newest completed turns stay verbatim: the model must still see what
    // it was just asked and just answered, or the next turn is answered against
    // the previous one.
    assert.match(keptText, /继续按相似度清理上下文/);
    assert.match(keptText, /明白/);

    const store = new MemoryScopes(path.join(root, 'memory')).sessionStoreFor('session-clear', {}).store;
    const contexts = store.listContexts();
    assert.equal(contexts.length, 1);
    assert.match(contexts[0].label, /^auto-usage-/);
    const archived = store.loadContext(contexts[0].context_id);
    assert.ok(archived.raw_events.some((event) => event.type === 'developer/message'));
    assert.ok(archived.raw_events.some((event) => event.type === 'tool/call'));
    assert.equal(store.readCompactionStatus().state, 'reset');
    assert.equal(store.readCompactionStatus().kept, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manual clear runs at the next pre-step and keeps the in-flight turn', async () => {
  const root = tempRoot();
  try {
    const events = offTopicEvents();
    // Turn 5 is the tool-calling turn that asked for the clear. It has no
    // `turn/end`, so it is in flight and must never be a clear candidate.
    events.push(
      { type: 'turn/start', data: { turn: 5 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '当前这轮正在执行工具，不能被清掉' }] } },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '正在执行清理工具' }] } } },
    );
    const { session, log, nodes } = fakeSession(events);
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: () => undefined,
    };
    const config = normalizeConfig({
      root: path.join(root, 'memory'),
      keepRecentTurns: 2,
    });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);

    const before = nodes.length;
    runtime.pending.set('session-clear', { kind: 'manual', mode: 'immediate' });
    let nextCalls = 0;
    const preStep = handlers.get('agent/pre-step');
    // A cancelled step must not rewrite the surface or consume the request.
    const aborted = new AbortController();
    aborted.abort();
    await preStep({ agent: { session }, signal: aborted.signal }, async () => { nextCalls += 1; });
    assert.equal(nodes.length, before);
    assert.equal(runtime.pending.has('session-clear'), true);

    const result = await preStep({
      agent: { session },
      signal: new AbortController().signal,
    }, async () => { nextCalls += 1; });
    assert.equal(result, undefined);
    assert.equal(nextCalls, 2);
    assert.equal(runtime.pending.has('session-clear'), false);

    // Old turns are replaced inside the same turn, before the next request.
    assert.equal(nodes.length, before - 3);
    const keptText = nodes.map((seq) => log[seq])
      .flatMap((event) => event.data?.content ?? event.data?.message?.content ?? [])
      .map((block) => block.text ?? '')
      .join('\n');
    assert.match(keptText, /当前这轮正在执行工具/);
    assert.doesNotMatch(keptText, /数据库索引/);
    assert.match(keptText, /上下文清理/);

    const store = new MemoryScopes(path.join(root, 'memory')).sessionStoreFor('session-clear', {}).store;
    assert.equal(store.readCompactionStatus().state, 'done');
    assert.equal(store.listContexts()[0].label, 'before-clear');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a busy agent is retried once before the clear gives up', async () => {
  const root = tempRoot();
  try {
    const { session, nodes } = fakeSession(offTopicEvents());
    const handlers = new Map();
    let maintenanceCalls = 0;
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: (service) => (service === 'agents' ? {
        get: () => ({
          whenIdle: async () => {},
          runMaintenance: async (task) => {
            maintenanceCalls += 1;
            // `turn/end` can still fire while the agent settles, so the first
            // maintenance entry is expected to be refused.
            if (maintenanceCalls === 1) throw new Error('agent is active');
            return task();
          },
        }),
      } : undefined),
    };
    const config = normalizeConfig({ root: path.join(root, 'memory'), minClearChars: 0 });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);

    const before = nodes.length;
    runtime.pending.set('session-clear', 'manual');
    handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(maintenanceCalls, 2);
    assert.equal(nodes.length, before - 3);
    const store = new MemoryScopes(path.join(root, 'memory')).sessionStoreFor('session-clear', {}).store;
    assert.equal(store.readCompactionStatus().state, 'done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prompt and tool refreshes inside a turn do not block clearing it', async () => {
  const root = tempRoot();
  try {
    const { session, log, nodes } = fakeSession([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '数据库索引的 B+ 树结构怎么设计' }] } },
      { type: 'system/message', data: { message: { id: 'sys-2', role: 'system', content: [{ type: 'text', text: 'prompt refresh' }], source: { kind: 'system-prompt' } } } },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '按页大小和填充因子决定' }] } } },
      { type: 'developer/message', data: { message: { id: 'dev-1', role: 'developer', content: [{ type: 'text', text: 'tool catalog update' }], source: { kind: 'user' } } } },
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '晚餐吃火锅还是烧烤' }] } },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '都可以，你定' }] } } },
      { type: 'turn/end', data: { turn: 2 } },
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '上下文清理要按相似度来，高的留下' }] } },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，低相似度才清出' }] } } },
      { type: 'turn/end', data: { turn: 3 } },
      { type: 'turn/start', data: { turn: 4 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '继续任务吧，上下文清理删掉的要能恢复' }] } },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '明白，先存档再清理' }] } } },
      { type: 'turn/end', data: { turn: 4 } },
    ]);
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: (service) => (service === 'agents'
        ? { get: () => ({ whenIdle: async () => {}, runMaintenance: async (task) => task() }) }
        : undefined),
    };
    const config = normalizeConfig({ root: path.join(root, 'memory'), minClearChars: 0, keepRecentTurns: 2 });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);

    runtime.pending.set('session-clear', 'manual');
    handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Turns 1-2 were replaced by a single note that also swallowed the
    // interleaved system/developer nodes (seqs 2 and 4).
    const replacement = log.find((event) => event.type === 'user/message' && event.surfaceOp);
    assert.ok(replacement, 'expected one replacement note');
    assert.equal(replacement.data.source.kind, 'ai-for-memory');
    assert.equal(replacement.data.source.form, 'notice');
    assert.deepEqual(replacement.sourceEventSeqs, [1, 2, 3, 4, 7, 8]);
    assert.equal(nodes.length, 5);

    const store = new MemoryScopes(path.join(root, 'memory')).sessionStoreFor('session-clear', {}).store;
    const contexts = store.listContexts();
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].turn_from, 1);
    assert.equal(contexts[0].turn_to, 2);
    assert.equal(store.readCompactionStatus().state, 'done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('similarity clear leaves an entirely on-topic window untouched', async () => {
  const root = tempRoot();
  try {
    const { session, log, nodes } = fakeSession(onTopicEvents());
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: (service) => (service === 'agents' ? { get: () => ({ whenIdle: async () => {} }) } : undefined),
    };
    const config = normalizeConfig({ root: path.join(root, 'memory'), minClearChars: 0 });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);

    const before = nodes.length;
    runtime.pending.set('session-clear', 'manual');
    handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(nodes.length, before);
    assert.equal(log.filter((event) => event.surfaceOp).length, 0);
    const scopes = new MemoryScopes(path.join(root, 'memory'));
    const store = scopes.sessionStoreFor('session-clear', {}).store;
    assert.equal(store.listContexts().length, 0);
    assert.equal(store.readCompactionStatus().state, 'skipped');
    assert.match(store.readCompactionStatus().reason, /全部轮次都与当前话题相关/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('similarity clear respects the minimum size budget', async () => {
  const root = tempRoot();
  try {
    const { session, log, nodes } = fakeSession([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '数据库索引' }] } },
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '晚餐吃火锅' }] } },
      { type: 'turn/end', data: { turn: 2 } },
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '上下文清理按相似度' }] } },
      { type: 'turn/end', data: { turn: 3 } },
    ]);
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: (service) => (service === 'agents' ? { get: () => ({ whenIdle: async () => {} }) } : undefined),
    };
    const config = normalizeConfig({ root: path.join(root, 'memory'), minClearChars: 600 });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);

    const before = nodes.length;
    runtime.pending.set('session-clear', 'manual');
    handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 3 } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(nodes.length, before);
    assert.equal(log.filter((event) => event.surfaceOp).length, 0);
    const store = new MemoryScopes(path.join(root, 'memory')).sessionStoreFor('session-clear', {}).store;
    assert.equal(store.readCompactionStatus().reason, '可清理内容太少');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a conversation groups by the workspace that opened it, not its live cwd', () => {
  const root = tempRoot();
  try {
    const memoryRoot = path.join(root, 'memory');
    const workspace = path.join(root, '工作区');
    const subFolder = path.join(workspace, 'repo');
    fs.mkdirSync(subFolder, { recursive: true });

    // DSH keeps one bucket per workspace, named after the encoded path.
    const dshDir = path.join(root, 'dsh-sessions');
    const bucket = encodeWorkspace(workspace);
    fs.mkdirSync(path.join(dshDir, bucket, 'session-abc'), { recursive: true });

    const scopes = new MemoryScopes(memoryRoot, { dshSessionsDir: dshDir });
    // The conversation recorded its panel metadata while sitting in a sub-folder.
    scopes.sessionStoreFor('abc', { workspace: subFolder });
    const row = scopes.listSessions().find((item) => item.sessionId === 'abc');
    assert.ok(row, 'expected the conversation to be listed');
    assert.equal(row.workspace, workspace);

    // Encoding round-trips, including the hyphen ambiguity.
    assert.equal(resolveWorkspacePath(decodeWorkspaceBucket(bucket)), workspace);
    const hyphened = path.join(root, 'my-project');
    fs.mkdirSync(hyphened, { recursive: true });
    assert.equal(resolveWorkspacePath(decodeWorkspaceBucket(encodeWorkspace(hyphened))), hyphened);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});



test('workspace buckets decode to the path style DSH actually used', () => {
  // DSH's projectKey collapses `:`/`\`/`/` into one `-`; a Windows drive
  // bucket is not a POSIX absolute path and vice versa.
  assert.equal(encodeWorkspace('D:\\ai\\工作区'), '--D-ai-~5DE5~4F5C~533A--');
  assert.equal(encodeWorkspace('/tmp/工作区'), '--tmp-~5DE5~4F5C~533A--');
  assert.equal(decodeWorkspaceBucket('--D-ai-~5DE5~4F5C~533A--'), 'D:\\ai\\工作区');
  assert.equal(decodeWorkspaceBucket('--tmp-~5DE5~4F5C~533A--'), '/tmp/工作区');

  // A POSIX bucket that no longer exists must still fall back to POSIX, not
  // to a backslash pseudo-path (which used to split one workspace into many
  // panel groups).
  const fallback = resolveWorkspacePath('/definitely/missing/工作区');
  assert.equal(fallback, '/definitely/missing/工作区');
});

test('cache views invalidate across store instances and retention is archive-safe', () => {
  const root = tempRoot();
  try {
    const first = new MemoryStore(root);
    const second = new MemoryStore(root);
    first.remember({ text: '第一条跨实例缓存事实', category: 'project_facts' }, { confirm: true });
    assert.equal(second.documents().length, 1);
    // Prime second's cache, then write through first: the shared epoch must
    // make second see the new document immediately.
    assert.equal(second.documents().length, 1);
    first.remember({ text: '第二条跨实例缓存事实', category: 'project_facts' }, { confirm: true });
    assert.equal(second.documents().length, 2);
    // Cached document objects are frozen; handing them out must not let a caller
    // poison every later read within the TTL.
    const visible = first.documents()[0];
    assert.throws(() => { visible.text = 'MUTATED'; }, TypeError);
    assert.notEqual(first.documents()[0].text, 'MUTATED');

    // A staging hour file older than the cutoff stays until it is archived.
    first.stage({ content: '一条等待归档的旧记录', kind: 'action' });
    const stagingFile = listJsonlFiles(first.stagingDir)[0];
    const old = new Date(Date.now() - 31 * 86400000);
    fs.utimesSync(stagingFile, old, old);
    assert.equal(first.pruneStaging(30), 0);
    assert.equal(fs.existsSync(stagingFile), true);
    first.archive();
    assert.equal(fs.existsSync(stagingFile), true);
    assert.equal(first.pruneStaging(30), 1);
    assert.equal(fs.existsSync(stagingFile), false);
    assert.equal(first.archivedCount(), 1);

    // Context/decision retention is explicit; contexts are restorable data.
    const saved = first.saveContext({
      label: 'old-context', sessionId: 's1', turnFrom: 1, turnTo: 1, turnCount: 1, chars: 2,
      turns: [{ turn: 1, user: '旧', assistant: '答案' }], text: '旧 答案',
    });
    const contextFile = path.join(first.contextDir, `${saved.context_id}.json`);
    fs.utimesSync(contextFile, old, old);
    assert.equal(first.pruneContexts(30), 1);
    assert.equal(first.listContexts().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('promote ledger never evicts old refs just to stay under a cap', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    store.init();
    const refs = Array.from({ length: 4100 }, (_, index) => ({ ref: `staging:r${index}`, doc_id: '' }));
    store.markPromoted(refs);
    const ledger = store.promotedLedger();
    assert.equal(Object.keys(ledger.refs).length, 4100);
    assert.ok(ledger.refs['staging:r0'], 'oldest ref must survive');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local engine resolves GGUF files and builds llama.cpp arguments', () => {
  const root = tempRoot();
  try {
    const models = path.join(root, 'models');
    const embedDir = path.join(models, 'Embedding', 'bge-m3');
    const rerankDir = path.join(models, 'Rerank', 'bge-reranker-v2-m3');
    const routingDir = path.join(models, 'Routing', 'my-router');
    fs.mkdirSync(embedDir, { recursive: true });
    fs.mkdirSync(rerankDir, { recursive: true });
    fs.mkdirSync(routingDir, { recursive: true });
    fs.writeFileSync(path.join(embedDir, 'bge-m3-Q8_0.gguf'), '');
    fs.writeFileSync(path.join(rerankDir, 'bge-reranker.gguf'), '');
    fs.writeFileSync(path.join(routingDir, 'router.gguf'), '');
    fs.writeFileSync(path.join(embedDir, 'model.json'), JSON.stringify({
      name: 'BGE-M3', model: 'bge-m3', pooling: 'cls',
    }));
    fs.writeFileSync(path.join(rerankDir, 'model.json'), JSON.stringify({
      name: 'BGE Reranker v2 m3', model: 'bge-reranker-v2-m3',
    }));
    fs.writeFileSync(path.join(routingDir, 'model.json'), JSON.stringify({
      name: 'My Router', model: 'my-router',
    }));

    assert.equal(path.basename(findModelFile(embedDir)), 'bge-m3-Q8_0.gguf');
    const embedding = resolveModel({ modelsRoot: models, modelId: 'Embedding/bge-m3' });
    assert.equal(embedding.ok, true);
    assert.equal(embedding.model.kind, 'embedding');
    assert.equal(embedding.model.model, 'bge-m3');
    const embedArgs = buildServerArgs(embedding.model, 19001);
    assert.ok(embedArgs.includes('--embeddings'));
    assert.deepEqual(embedArgs.slice(embedArgs.indexOf('--pooling'), embedArgs.indexOf('--pooling') + 2), ['--pooling', 'cls']);
    assert.ok(embedArgs.includes('--port'));

    // An explicit kind in model.json wins over the folder name; otherwise a
    // panel "mark as Rerank" would silently start an embedding server.
    fs.writeFileSync(path.join(embedDir, 'model.json'), JSON.stringify({
      name: 'BGE-M3', model: 'bge-m3', pooling: 'cls', kind: 'Rerank',
    }));
    const marked = resolveModel({ modelsRoot: models, modelId: 'Embedding/bge-m3' });
    assert.equal(marked.ok, true);
    assert.equal(marked.model.kind, 'rerank');
    const markedArgs = buildServerArgs(marked.model, 19003);
    assert.ok(markedArgs.includes('--reranking'));
    assert.deepEqual(markedArgs.slice(markedArgs.indexOf('--pooling'), markedArgs.indexOf('--pooling') + 2), ['--pooling', 'rank']);
    fs.writeFileSync(path.join(embedDir, 'model.json'), JSON.stringify({
      name: 'BGE-M3', model: 'bge-m3', pooling: 'cls',
    }));

    const rerank = resolveModel({ modelsRoot: models, modelId: 'Rerank/bge-reranker-v2-m3' });
    assert.equal(rerank.ok, true);
    assert.equal(rerank.model.kind, 'rerank');
    assert.ok(buildServerArgs(rerank.model, 19002).includes('--reranking'));
    const rerankArgs = buildServerArgs(rerank.model, 19002);
    assert.deepEqual(rerankArgs.slice(rerankArgs.indexOf('--pooling'), rerankArgs.indexOf('--pooling') + 2), ['--pooling', 'rank']);

    const missing = resolveModel({ modelsRoot: models, modelId: 'Embedding/missing' });
    assert.equal(missing.ok, false);

    const routing = resolveModel({ modelsRoot: models, modelId: 'Routing/my-router' });
    assert.equal(routing.ok, false);
    assert.match(routing.error, /Routing|预留/);
    const catalog = listLocalModels(models);
    const routingCategory = catalog.categories.find((category) => category.name === 'Routing');
    assert.equal(routingCategory.models[0].runnable, false);
    assert.match(routingCategory.models[0].error, /预留/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loose GGUF files are classified by name and can be marked by the user', () => {
  const root = tempRoot();
  try {
    const models = path.join(root, 'models');
    fs.mkdirSync(models, { recursive: true });
    fs.writeFileSync(path.join(models, 'jina-reranker-v3.5-BF16.gguf'), '');
    fs.writeFileSync(path.join(models, 'Qwen3-Embedding-4B-Q4_K_M.gguf'), '');
    fs.writeFileSync(path.join(models, 'mystery-model.gguf'), '');

    const catalog = listLocalModels(models);
    const loose = catalog.categories.find((category) => category.name === 'Loose');
    assert.ok(loose);
    const byName = Object.fromEntries(loose.models.map((model) => [model.folder, model]));
    assert.equal(byName['jina-reranker-v3.5-BF16.gguf'].kind, 'Rerank');
    assert.equal(byName['jina-reranker-v3.5-BF16.gguf'].kindSource, 'name');
    assert.equal(byName['Qwen3-Embedding-4B-Q4_K_M.gguf'].kind, 'Embedding');
    assert.equal(byName['mystery-model.gguf'].kind, '');
    assert.equal(byName['mystery-model.gguf'].runnable, false);

    const rerank = resolveModel({ modelsRoot: models, modelId: 'Loose/jina-reranker-v3.5-BF16.gguf' });
    assert.equal(rerank.ok, true);
    assert.equal(rerank.model.kind, 'Rerank');
    assert.ok(buildServerArgs(rerank.model, 19003).includes('--reranking'));
    const unknown = resolveModel({ modelsRoot: models, modelId: 'Loose/mystery-model.gguf' });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /标记|Embedding|Rerank/);

    const marked = updateModelConfig({
      modelsRoot: models,
      modelId: 'Loose/mystery-model.gguf',
      kind: 'Embedding',
    });
    assert.equal(marked.ok, true);
    assert.equal(marked.kind, 'Embedding');
    const after = listLocalModels(models).categories.find((category) => category.name === 'Loose')
      .models.find((model) => model.folder === 'mystery-model.gguf');
    assert.equal(after.kind, 'Embedding');
    assert.equal(after.kindSource, 'user');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed llama-server start reports its stderr and exact command', async () => {
  const root = tempRoot();
  try {
    const models = path.join(root, 'models');
    const modelDir = path.join(models, 'Embedding', 'fake');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'fake.gguf'), '');
    // The test executable deliberately does not understand llama-server's
    // -m/--host flags, so it exits quickly with a real stderr diagnostic.
    fs.writeFileSync(path.join(modelDir, 'model.json'), JSON.stringify({
      binary: process.execPath,
      startupTimeoutMs: 1500,
    }));

    const started = await startLocalEngine({ modelsRoot: models, modelId: 'Embedding/fake' });
    assert.equal(started.ok, false);
    assert.match(started.error, /bad option|unknown option|--/i);
    assert.match(started.error, /stderr:/);
    assert.match(started.error, /命令：/);
    assert.ok(started.engine.stderr.length > 0);
    assert.match(started.engine.command, /fake\.gguf/);
  } finally {
    await stopAllLocalEngines();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a live llama-server from the previous plugin process is adopted', async () => {
  const root = tempRoot();
  let child = null;
  try {
    const models = path.join(root, 'models');
    const modelDir = path.join(models, 'Embedding', 'fake');
    fs.mkdirSync(modelDir, { recursive: true });
    const modelPath = path.join(modelDir, 'fake.gguf');
    fs.writeFileSync(modelPath, '');
    fs.writeFileSync(path.join(modelDir, 'model.json'), JSON.stringify({ model: 'fake' }));

    const port = await freePort();
    const readyFile = path.join(root, 'engine-ready');
    const serverScript = [
      "const http = require('http');",
      "const fs = require('fs');",
      "const server = http.createServer((req, res) => {",
      "  if (req.url === '/health') { res.end('ok'); return; }",
      "  if (req.url === '/props') { res.setHeader('content-type', 'application/json');",
      "    res.end(JSON.stringify({ model_path: process.argv[1] })); return; }",
      "  res.statusCode = 404; res.end();",
      "});",
      `server.listen(Number(process.argv[3]), '127.0.0.1', () => fs.writeFileSync(process.argv[2], 'ready'));`,
    ].join('\n');
    child = spawn(process.execPath, ['-e', serverScript, modelPath, readyFile, String(port)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(readyFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(fs.existsSync(readyFile), 'fake llama-server did not start');

    fs.writeFileSync(path.join(models, '.engine.lock'), JSON.stringify({
      version: 1,
      engines: [{
        id: 'Embedding/fake',
        pid: child.pid,
        port,
        model: 'fake',
        modelPath,
        baseUrl: `http://127.0.0.1:${port}`,
        command: 'llama-server',
        startedAt: new Date().toISOString(),
      }],
    }));

    const statuses = await restoreLocalEngines({ modelsRoot: models });
    const adopted = statuses.find((row) => row.id === 'Embedding/fake');
    assert.ok(adopted, 'expected the live engine to be adopted');
    assert.equal(adopted.ready, true);
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.pid, child.pid);
    assert.equal(adopted.stale, false);
    const lockDir = path.join(models, '.engine.lock');
    // The legacy single-file journal is migrated to one file per model.
    assert.equal(fs.statSync(lockDir).isDirectory(), true);
    assert.equal(fs.readdirSync(lockDir).filter((name) => name.endsWith('.json')).length, 1);

    // A model.json edit changes the fingerprint; the live process is not
    // silently reused under the old name.
    fs.writeFileSync(path.join(modelDir, 'model.json'), JSON.stringify({ model: 'fake-v2' }));
    const stale = await startLocalEngine({ modelsRoot: models, modelId: 'Embedding/fake' });
    assert.equal(stale.ok, false);
    assert.equal(stale.stale, true);
    assert.match(stale.error, /配置已变更/);

    // Even if model.json now points at a different weight file, the old
    // process is still adopted so it can be reclaimed; it remains stale.
    fs.writeFileSync(path.join(modelDir, 'fake2.gguf'), '');
    fs.writeFileSync(path.join(modelDir, 'model.json'), JSON.stringify({
      model: 'fake-v2', modelPath: 'fake2.gguf',
    }));
    const readopted = await restoreLocalEngines({ modelsRoot: models });
    const readoptedRow = readopted.find((row) => row.id === 'Embedding/fake');
    assert.ok(readoptedRow);
    assert.equal(readoptedRow.stale, true);

    // Stopping an adopted engine must terminate the surviving process too.
    const stopped = await stopLocalEngine('Embedding/fake');
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(stopped.stopped, true, JSON.stringify(stopped));
    for (let attempt = 0; attempt < 100 && child.exitCode === null && child.signalCode === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'adopted process was not terminated');
    assert.equal(fs.readdirSync(lockDir).filter((name) => name.endsWith('.json')).length, 0);
  } finally {
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('probeHost accepts scp remotes and probes common ports concurrently', async () => {
  assert.deepEqual(parseGitRemote('git@github.com:kuugakw/dsh-ai-for-memory.git'), {
    host: 'github.com', port: null, path: 'kuugakw/dsh-ai-for-memory.git',
  });
  assert.equal(parseGitRemote('ssh://git@github.com:2222/kuugakw/dsh-ai-for-memory.git').port, 2222);
  assert.equal(parseGitRemote('https://github.com/kuugakw/dsh-ai-for-memory.git').host, 'github.com');
  assert.equal(parseGitRemote('not a remote'), null);

  const started = [];
  const result = await probeHost('git@example.test:group/repo.git', async (host, port) => {
    started.push(port);
    if (port === 443) return { ok: true, host, port };
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { ok: false, host, port };
  });
  assert.equal(result.ok, true);
  assert.equal(result.port, 443);
  assert.deepEqual(started.sort((a, b) => a - b), [22, 80, 443, 9418]);
});

test('probeHost rejects only addresses that cannot be parsed', async () => {
  const result = await probeHost('not a remote');
  assert.equal(result.ok, false);
  assert.match(result.error, /git@host:path/);
});

test('a fact that disagrees with stored knowledge waits for the user', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(path.join(root, 'memory'));
    store.remember({ text: '合并代码前必须先跑完整测试套件', category: 'project_facts' }, { confirm: true });
    assert.equal(store.documents().length, 1);

    // Same topic, different claim: refuse and report the old document.
    const blocked = store.remember({ text: '合并代码前不需要跑完整测试套件', category: 'project_facts' });
    assert.equal(blocked.needs_confirm, true);
    assert.ok(blocked.conflicts.length > 0);
    assert.equal(blocked.conflicts[0].text, '合并代码前必须先跑完整测试套件');
    assert.equal(store.documents().length, 1, 'nothing is written before confirmation');

    // After the user agrees, the fact is stored.
    const written = store.remember({ text: '合并代码前不需要跑完整测试套件', category: 'project_facts' }, { confirm: true });
    assert.ok(written.doc_id);
    assert.equal(store.documents().length, 2);

    // Unrelated facts pass straight through.
    const unrelated = store.remember({ text: '面板右上角是刷新按钮', category: 'ui_facts' });
    assert.equal(unrelated.needs_confirm, undefined);
    assert.ok(unrelated.doc_id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external endpoint is unconfigured by default and probes use a 5s budget', async () => {
  assert.equal(normalizeExternal({}).baseUrl, '');
  assert.equal(resolveBaseUrl('').api, '');
  assert.equal(PROBE_TIMEOUT_MS, 5000);

  let called = 0;
  const result = await probe(normalizeExternal({}), async () => {
    called += 1;
    throw new Error('must not be contacted');
  });
  assert.equal(result.ok, false);
  assert.equal(result.via, 'unconfigured');
  assert.match(result.error, /未配置外部模型地址/);
  assert.equal(called, 0);

  // An explicit endpoint still works; only the empty default is inert.
  const explicit = await probe(localExternal(), async (url) => (
    url.endsWith('/health') ? new Response('{"status":"ok"}', { status: 200 }) : new Response('{}')
  ));
  assert.equal(explicit.ok, true);
});

test('external client speaks the llama.cpp OpenAI-compatible protocol', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      model: 'qwen',
      choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
      usage: { total_tokens: 12 },
    }), { status: 200 });
  };
  const config = normalizeExternal({ baseUrl: 'http://127.0.0.1:8080/', model: 'qwen', timeoutMs: 5000 });
  assert.equal(config.baseUrl, 'http://127.0.0.1:8080');

  const result = await chat(config, { prompt: '你好', system: '你是助手', maxTokens: 64 }, fakeFetch);
  assert.equal(result.ok, true);
  assert.equal(result.text, '你好');
  assert.equal(result.usage.total_tokens, 12);
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(calls[0].body.model, 'qwen');
  assert.deepEqual(calls[0].body.messages, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ]);
  assert.equal(calls[0].body.max_tokens, 64);
  assert.equal(calls[0].body.stream, false);

  // an empty prompt never reaches the network
  const empty = await chat(config, { prompt: '   ' }, fakeFetch);
  assert.equal(empty.ok, false);
  assert.equal(calls.length, 1);
});

test('external client turns failures into readable messages', async () => {
  const rejecting = async () => new Response(
    JSON.stringify({ error: { message: 'model not loaded' } }),
    { status: 400 },
  );
  const failed = await chat(localExternal(), { prompt: 'hi' }, rejecting);
  assert.equal(failed.ok, false);
  assert.ok(failed.error.includes('400'));
  assert.ok(failed.error.includes('model not loaded'));

  const hanging = async (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const timedOut = await chat(localExternal({ timeoutMs: 1000 }), { prompt: 'hi' }, hanging);
  assert.equal(timedOut.ok, false);
  assert.ok(timedOut.error.includes('超时'));

  const unreachable = async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  const offline = await chat(localExternal(), { prompt: 'hi' }, unreachable);
  assert.equal(offline.ok, false);
  assert.ok(offline.error.includes('ECONNREFUSED'));
  assert.ok(offline.error.includes('llama.cpp'));
});

test('external embeddings keep input order and explain a missing --embeddings', async () => {
  const embedding = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8080/v1/embeddings');
    const body = JSON.parse(init.body);
    const count = Array.isArray(body.input) ? body.input.length : 1;
    return new Response(JSON.stringify({
      data: Array.from({ length: count }, (_, index) => ({ embedding: [0.1, 0.2, index] })),
    }), { status: 200 });
  };
  const vectors = await embed(localExternal(), ['a', 'b'], embedding);
  assert.equal(vectors.ok, true);
  assert.equal(vectors.vectors.length, 2);
  assert.equal(vectors.vectors[1][2], 1);

  const wrong = async () => new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 });
  const missing = await embed(localExternal(), ['a', 'b'], wrong);
  assert.equal(missing.ok, false);
  assert.ok(missing.error.includes('--embeddings'));
});

test('probe falls back from /health to /v1/models', async () => {
  const fakeFetch = async (url) => {
    if (url.endsWith('/health')) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b' }] }), { status: 200 });
  };
  const result = await probe(localExternal(), fakeFetch);
  assert.equal(result.ok, true);
  assert.equal(result.via, 'models');
  assert.deepEqual(result.models, ['qwen2.5-7b']);
});

test('base URLs resolve for servers with and without /v1', () => {
  assert.equal(resolveBaseUrl('http://127.0.0.1:8080').api, 'http://127.0.0.1:8080/v1');
  assert.equal(resolveBaseUrl('http://127.0.0.1:8080/').api, 'http://127.0.0.1:8080/v1');
  assert.equal(resolveBaseUrl('https://api.openai.com/v1').api, 'https://api.openai.com/v1');
  assert.equal(resolveBaseUrl('https://api.openai.com/v1/').server, 'https://api.openai.com');
  assert.equal(resolveBaseUrl('https://api.openai.com/v1/embeddings').api, 'https://api.openai.com/v1');
  assert.equal(resolveBaseUrl('http://host:8080/v1/chat/completions').api, 'http://host:8080/v1');
  assert.equal(resolveBaseUrl('http://host:8080/v1/rerank').server, 'http://host:8080');
  // A non-OpenAI mount path is preserved instead of guessing /v1.
  assert.equal(resolveBaseUrl('http://host:8080/embed').api, 'http://host:8080/embed/v1');
});

test('embedding and rerank payloads accept every protocol shape', () => {
  assert.deepEqual(parseEmbeddingResponse({ data: [{ embedding: [1, 2] }] }).vectors, [[1, 2]]);
  assert.deepEqual(parseEmbeddingResponse({ embeddings: [[1, 2], [3, 4]] }).vectors, [[1, 2], [3, 4]]);
  assert.deepEqual(parseEmbeddingResponse([[1, 2], [3, 4]]).vectors, [[1, 2], [3, 4]]);
  assert.deepEqual(parseEmbeddingResponse({ data: [{ embedding: ['x'] }] }).vectors, []);
  assert.deepEqual(parseRerankResponse([{ index: 1, score: 0.2 }, { index: 0, score: 0.9 }]),
    [{ index: 0, score: 0.9 }, { index: 1, score: 0.2 }]);
  assert.deepEqual(parseRerankResponse({ results: [{ index: 0, relevance_score: 0.7 }] }), [{ index: 0, score: 0.7 }]);
  assert.deepEqual(parseRerankResponse({ data: [{ index: 2, score: 0.1 }] }), [{ index: 2, score: 0.1 }]);
});

test('a base URL ending in /v1 is not doubled', async () => {
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ data: [{ embedding: [0.5, 0.5] }] }), { status: 200 });
  };
  const vectors = await embed(normalizeExternal({ baseUrl: 'https://api.example.com/v1' }), 'hello', fake);
  assert.equal(vectors.ok, true);
  assert.deepEqual(seen, ['https://api.example.com/v1/embeddings']);
});

test('unversioned embedding servers (TEI shape) are reached via fallback', async () => {
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    if (url.endsWith('/v1/embeddings')) return new Response('not found', { status: 404 });
    if (url.endsWith('/embeddings')) return new Response(JSON.stringify([[0.25, 0.75]]), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const vectors = await embed(normalizeExternal({ baseUrl: 'http://127.0.0.1:9000' }), 'x', fake);
  assert.equal(vectors.ok, true);
  assert.deepEqual(vectors.vectors, [[0.25, 0.75]]);
  assert.deepEqual(seen, ['http://127.0.0.1:9000/v1/embeddings', 'http://127.0.0.1:9000/embeddings']);
});

test('listModels tolerates a bare array of models', async () => {
  const fake = async (url) => {
    assert.equal(url, 'https://api.example.com/v1/models');
    return new Response(JSON.stringify([{ id: 'm1' }, { id: 'm2' }]), { status: 200 });
  };
  const result = await listModels(normalizeExternal({ baseUrl: 'https://api.example.com/v1' }), fake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['m1', 'm2']);
});

test('external replies are parsed defensively', () => {
  // fenced JSON, prose around it, and a bare category name all work
  assert.equal(parseCategoryReply('```json\n{"category":"ui_facts"}\n```'), 'ui_facts');
  assert.equal(parseCategoryReply('我觉得这条应该归到 errors_fixes 吧'), null);
  assert.equal(parseCategoryReply('{"category":"errors_fixes"}'), 'errors_fixes');
  assert.equal(parseCategoryReply('errors_fixes'), 'errors_fixes');
  assert.equal(parseCategoryReply('{"category":"nonsense"}'), null);
  assert.equal(parseCategoryReply('{"category":"UI-FACTS"}'), 'ui_facts');

  const facts = parseKnowledgeReply(JSON.stringify([
    { text: '知识写入前先查冲突。', category: 'errors_fixes' },
    { text: '知识写入前先查冲突。', category: 'errors_fixes' },
    { text: '分类不认识就落到第一类。', category: 'whatever' },
    { text: '  ', category: 'ui_facts' },
    { text: 'x'.repeat(400), category: 'ui_facts' },
  ]));
  assert.equal(facts.length, 3);
  assert.equal(facts[1].category, 'project_facts');
  assert.equal(facts[2].text.length, 200);

  const wrapped = parseKnowledgeReply('说明如下：\n{"facts":[{"text":"面板范围是两级目录","category":"ui_facts"}]}');
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].category, 'ui_facts');

  assert.equal(parseSummaryReply('{"summary":"做了还原点","topics":["还原点"]}').summary, '做了还原点');
  assert.equal(parseSummaryReply('纯文本摘要').summary, '纯文本摘要');
  assert.equal(parseSummaryReply(''), null);
});

test('external classify uses embeddings, then rerank when available', async () => {
  // Deterministic fake embedding: count a few keyword groups per text.
  const GROUPS = [['面板', '截图', '界面'], ['bug', '修复', '报错'], ['决定', '因为', '取舍'], ['工具', 'api', '命令']];
  const vec = (value) => GROUPS.map((words) => words.reduce((sum, word) => (String(value).includes(word) ? sum + 1 : sum), 0));
  const seen = [];
  const fake = async (url, init) => {
    seen.push(url);
    if (url.endsWith('/v1/embeddings')) {
      const body = JSON.parse(init.body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({ data: inputs.map((input) => ({ embedding: vec(input) })) }), { status: 200 });
    }
    return new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }],
    }), { status: 200 });
  };
  const config = localExternal();
  const picked = await classifyRecord(config, { kind: 'state', content: '面板截图显示按钮位置' }, fake);
  assert.equal(picked.ok, true);
  assert.equal(picked.category, 'ui_facts');
  assert.equal(picked.via, 'rerank');
  assert.ok(seen.some((url) => url.endsWith('/v1/embeddings')));
  assert.ok(seen.some((url) => url.endsWith('/v1/rerank')));

  // Without a reranker the embedding result still wins (404 falls through).
  const noRerank = async (url, init) => {
    if (!url.endsWith('/v1/embeddings')) return new Response('nope', { status: 404 });
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({ data: inputs.map((input) => ({ embedding: vec(input) })) }), { status: 200 });
  };
  const embeddingOnly = await classifyRecord(config, { kind: 'state', content: '修复了 bug 和报错' }, noRerank);
  assert.equal(embeddingOnly.ok, true);
  assert.equal(embeddingOnly.via, 'embedding');
  assert.equal(embeddingOnly.category, 'errors_fixes');
});

test('external extract and summary are extractive and fail closed', async () => {
  const vec = (value) => {
    const groups = [['面板', '截图'], ['bug', '修复'], ['决定', '因为'], ['必须', '不要']];
    return groups.map((words) => words.reduce((sum, word) => (String(value).includes(word) ? sum + 1 : sum), 0));
  };
  const fake = async (url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({ data: inputs.map((input) => ({ embedding: vec(input) })) }), { status: 200 });
  };
  const config = localExternal();
  const mined = await extractFacts(config, [
    '面板范围改成两级目录。',
    '面板范围改成两级目录。',
    '修 bug 的时候要先复现。',
    '决定用本地规则兜底因为模型可能挂。',
  ].join(''), fake);
  assert.equal(mined.ok, true);
  assert.ok(mined.items.length >= 2);
  for (const item of mined.items) {
    assert.ok(['project_facts', 'ui_facts', 'errors_fixes', 'decisions_reasoning', 'tools_apis', 'workflow_rules', 'external_sources', 'open_questions'].includes(item.category));
  }

  const summary = await summarizeTurns(config, [
    { turn: 1, user: '把面板的查看范围改成两层。', assistant: '已经改成范围到工作区再到对话。' },
  ], fake);
  assert.equal(summary.ok, true);
  assert.ok(summary.summary.includes('范围') || summary.summary.includes('工作区'));

  const offline = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  assert.equal((await classifyRecord(config, { content: '正文' }, offline)).ok, false);
  assert.equal((await extractFacts(config, '正文内容足够长的一句话。', offline)).ok, false);
  assert.equal((await summarizeTurns(config, [{ turn: 1, user: 'a', assistant: 'b' }], offline)).ok, false);
});

test('archive honours model-chosen categories and ignores unknown ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-archive-override-'));
  const store = new MemoryStore(dir);
  store.init();
  const first = store.stage({ kind: 'action', content: '第一条记录' });
  const second = store.stage({ kind: 'action', content: '第二条记录' });
  const stats = store.archive({ categories: { [first.dedup_id]: 'ui_maps', [second.dedup_id]: 'not_a_category' } });
  assert.equal(stats.archived, 2);
  const uiMaps = store.archiveEntries('ui_maps', 20);
  assert.equal(uiMaps.length, 1);
  assert.equal(uiMaps[0].content, '第一条记录');
  // the unknown override falls back to the kind-based route
  const actions = store.archiveEntries('action_logs', 20);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].content, '第二条记录');
});

test('probe deep reports embedding and rerank capabilities', async () => {
  const fake = async (url, init) => {
    if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
    if (url.endsWith('/v1/embeddings')) {
      const body = JSON.parse(init.body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({ data: inputs.map(() => ({ embedding: [1, 0, 0] })) }), { status: 200 });
    }
    if (url.endsWith('/v1/rerank')) {
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.5 }] }), { status: 200 });
    }
    return new Response('no', { status: 404 });
  };
  const result = await probe(localExternal(), fake, { deep: true });
  assert.equal(result.ok, true);
  assert.equal(result.capabilities.embeddings.ok, true);
  assert.equal(result.capabilities.rerank.ok, true);
  assert.ok(result.endpoints.embeddings.startsWith('http://127.0.0.1:8080'));

  // A server without --embeddings still gets a useful verdict.
  const noEmbed = async (url) => (url.endsWith('/health')
    ? new Response('{"status":"ok"}', { status: 200 })
    : new Response('missing', { status: 404 }));
  const plain = await probe(localExternal(), noEmbed, { deep: true });
  assert.equal(plain.capabilities.embeddings.ok, false);
  assert.equal(plain.capabilities.rerank.ok, false);
});

test('RAG index embeds once, reuses unchanged docs and prunes removed ones', async () => {
  const root = tempRoot();
  const docs = [
    { doc_id: 'k_a', text: '面板截图显示按钮位置', category: 'ui_facts', source: 'agent', updated_at: '2026-01-01' },
    { doc_id: 'k_b', text: '超时先重试三次', category: 'errors_fixes', source: 'agent', updated_at: '2026-01-02' },
  ];
  const store = { root, documents: () => docs };
  let requests = 0;
  const fake = async (url, init) => {
    requests += 1;
    assert.ok(url.endsWith('/embeddings'), `unexpected URL ${url}`);
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map((text) => ({ embedding: [text.length, 1, 0] })),
    }), { status: 200 });
  };
  const endpoint = localExternal();
  const built = await buildRagIndex(store, endpoint, { fetchImpl: fake });
  assert.equal(built.ok, true);
  assert.equal(built.indexed, 2);
  assert.equal(built.embedded, 2);
  assert.equal(readRagIndex(root).docs.k_a.hash.length > 0, true);
  assert.equal(ragStats(root).docs, 2);

  // Nothing changed: no embedding request at all.
  const before = requests;
  const again = await buildRagIndex(store, endpoint, { fetchImpl: fake });
  assert.equal(again.embedded, 0);
  assert.equal(requests, before);

  // Changed text is re-embedded; a removed document disappears from the index.
  docs[1] = { ...docs[1], text: '超时重试两次即可' };
  docs.push({ doc_id: 'k_c', text: '新的知识', category: 'project_facts', source: 'user', updated_at: '2026-01-03' });
  const changed = await buildRagIndex(store, endpoint, { fetchImpl: fake });
  assert.equal(changed.embedded, 2);
  assert.equal(ragStats(root).docs, 3);
  const removedStore = { root, documents: () => docs.filter((doc) => doc.doc_id !== 'k_c') };
  const pruned = await buildRagIndex(removedStore, endpoint, { fetchImpl: fake });
  assert.equal(pruned.removed, 1);
  assert.equal(ragStats(root).docs, 2);
});

test('RAG embedding failure leaves the previous index intact', async () => {
  const root = tempRoot();
  const store = { root, documents: () => [{ doc_id: 'k_a', text: 'old', category: 'ui_facts', source: 'agent' }] };
  const good = async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 });
  const first = await buildRagIndex(store, localExternal(), { fetchImpl: good });
  assert.equal(first.ok, true);
  const oldHash = readRagIndex(root).docs.k_a.hash;
  store.documents = () => [{ doc_id: 'k_a', text: 'new', category: 'ui_facts', source: 'agent' }];
  const failing = async () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
  const failed = await buildRagIndex(store, localExternal(), { fetchImpl: failing });
  assert.equal(failed.ok, false);
  assert.equal(readRagIndex(root).docs.k_a.hash, oldHash);
});

test('RAG candidates honour the category filter and rerank falls back to embeddings', async () => {
  const root = tempRoot();
  const docs = [
    { doc_id: 'k_a', text: 'aaaa', category: 'ui_facts', source: 'agent' },
    { doc_id: 'k_b', text: 'bbbb', category: 'errors_fixes', source: 'agent' },
  ];
  const store = { root, documents: () => docs };
  const fake = async (url, init) => {
    if (url.endsWith('/embeddings')) {
      const body = JSON.parse(init.body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({ data: inputs.map((text) => ({ embedding: [text.length, 0, 0] })) }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  };
  await buildRagIndex(store, localExternal(), { fetchImpl: fake });
  const all = ragCandidates(store, [4, 0, 0], { topK: 5 });
  assert.equal(all.ok, true);
  assert.equal(all.candidates.length, 2);
  const filtered = ragCandidates(store, [4, 0, 0], { topK: 5, category: 'ui_facts' });
  assert.equal(filtered.candidates.length, 1);
  assert.equal(filtered.candidates[0].doc.doc_id, 'k_a');
  assert.equal(cosine([1, 0], [1, 0]), 1);
  // The rerank endpoint is missing: the embedding order must still be returned.
  const reranked = await rerankCandidates(localExternal(), 'aaaa', all.candidates, {
    topK: 1,
    fetchImpl: fake,
  });
  assert.equal(reranked.ok, true);
  assert.equal(reranked.via, 'embedding');
  assert.equal(reranked.hits.length, 1);
});

test('knowledge export is lossless JSON and keeps every field', () => {
  const root = tempRoot();
  const store = new MemoryStore(root).init();
  store.remember({
    doc_id: 'k_export',
    text: '导出必须是完整副本，不裁剪任何字段',
    category: 'project_facts',
    source: 'user',
    tags: ['export', 'backup'],
    url: 'https://example.com/export',
    confidence: 0.9,
  });
  const payload = knowledgeExportPayload(store, { scope: 'session', label: '本对话', format: 'json' });
  assert.equal(payload.ok, true);
  assert.equal(payload.docs, 1);
  assert.ok(payload.bytes > 0);
  assert.ok(payload.filename.endsWith('.json'));
  const bundle = JSON.parse(payload.content);
  assert.equal(bundle.kind, 'ai-for-memory-knowledge');
  assert.equal(bundle.version, 1);
  assert.equal(bundle.counts.total, 1);
  const doc = bundle.docs[0];
  assert.equal(doc.doc_id, 'k_export');
  assert.equal(doc.text, '导出必须是完整副本，不裁剪任何字段');
  assert.deepEqual(doc.tags, ['export', 'backup']);
  assert.equal(doc.url, 'https://example.com/export');
  assert.equal(doc.confidence, 0.9);
  assert.equal(doc.provenance, 'authored');
  assert.equal(doc.verified, true);
  assert.ok(Array.isArray(doc.changes));
  assert.ok(Array.isArray(doc.evidence));
  assert.equal(normalizeExportFormat('md'), 'markdown');
  assert.equal(normalizeExportFormat('json'), 'json');
  assert.equal(normalizeExportFormat('pdf'), '');
});

test('knowledge export round-trips provenance, verification and changes', () => {
  const root = tempRoot();
  try {
    const sourceStore = new MemoryStore(path.join(root, 'source')).init();
    const first = sourceStore.remember({
      text: '本地服务端口默认是 8081',
      category: 'tools_apis',
      source: 'reasoning',
      provenance: 'model',
      verified: true,
      changes: [{
        at: '2026-01-01T00:00:00.000Z',
        kind: 'number',
        before: ['8080'],
        after: ['8081'],
        previous_text: '本地服务端口默认是 8080',
      }],
    }, { confirm: true });
    const original = sourceStore.documents()[0];
    assert.equal(original.doc_id, first.doc_id);
    assert.equal(original.provenance, 'model');
    assert.equal(original.verified, true);
    assert.ok(original.changes.length > 0);

    const payload = knowledgeExportPayload(sourceStore, { format: 'json' });
    const exported = JSON.parse(payload.content).docs[0];
    assert.equal(exported.provenance, 'model');
    assert.equal(exported.verified, true);
    assert.equal(exported.changes.length, original.changes.length);

    // Re-import the full exported document (not just text) into a fresh store.
    const importedStore = new MemoryStore(path.join(root, 'imported')).init();
    const imported = importedStore.remember(exported, { confirm: true });
    assert.equal(imported.provenance, 'model');
    assert.equal(imported.verified, true);
    assert.equal(imported.changes.length, original.changes.length);
    assert.equal(imported.doc_id, original.doc_id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('knowledge export writes to another directory and renders Markdown', () => {
  const root = tempRoot();
  const store = new MemoryStore(root).init();
  store.remember({ doc_id: 'k_a', text: '归档分类要稳定', category: 'project_facts', source: 'user' });
  const dest = path.join(root, 'offline-disk');
  const written = writeKnowledgeExport(store, { dest, format: 'json' });
  assert.equal(written.ok, true);
  assert.equal(written.docs, 1);
  assert.equal(path.dirname(written.path), dest);
  assert.equal(fs.existsSync(written.path), true);
  const parsed = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  assert.equal(parsed.docs[0].doc_id, 'k_a');

  const md = knowledgeExportPayload(store, { scope: 'shared', label: '共享', format: 'markdown' });
  assert.equal(md.ok, true);
  assert.ok(md.filename.endsWith('.md'));
  assert.match(md.content, /# 知识库导出/);
  assert.match(md.content, /## project_facts/);
  assert.match(md.content, /归档分类要稳定/);
  assert.match(md.content, /来源 user/);
  assert.match(md.content, /确认状态 已确认｜provenance authored/);
  assert.equal(normalizeExportFormat('markdown'), 'markdown');

  const badFormat = writeKnowledgeExport(store, { dest, format: 'pdf' });
  assert.equal(badFormat.ok, false);
  assert.match(badFormat.error, /json|markdown/);
});

test('knowledge, SQL and RAG exports can be selected in any combination', async (t) => {
  if (!sqliteAvailable()) {
    t.skip('node:sqlite is unavailable on this Node build');
    return;
  }
  const root = tempRoot();
  const store = new MemoryStore(root).init();
  store.remember({ doc_id: 'k_a', text: '组合导出必须完整', category: 'project_facts', source: 'user' });

  assert.deepEqual(normalizeExportTypeList(['knowledge', 'sqlite']), ['knowledge', 'sql']);
  assert.deepEqual(normalizeExportTypeList(['rag']), ['rag']);
  assert.deepEqual(normalizeExportTypeList(['knowledge', 'pdf']), []);

  // Missing RAG index is reported, not silently skipped.
  const missingRag = exportArtifact(store, { type: 'rag' });
  assert.equal(missingRag.ok, false);
  assert.match(missingRag.error, /RAG/);

  const dest = path.join(root, 'multi-export');
  const written = writeExportArtifacts(store, { types: ['knowledge', 'sql'], dest, format: 'json' });
  assert.equal(written.ok, true);
  assert.equal(written.files.length, 2);
  assert.ok(written.bytes > 0);
  const sqlFile = written.files.find((row) => row.type === 'sql').path;
  assert.equal(path.dirname(sqlFile), dest);
  assert.ok(sqlFile.endsWith('.sqlite'));
  const knowledgeFile = written.files.find((row) => row.type === 'knowledge').path;
  assert.equal(JSON.parse(fs.readFileSync(knowledgeFile, 'utf8')).docs[0].doc_id, 'k_a');

  // The exported .sqlite is a complete, queryable copy of the JSON base.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(sqlFile);
  const rows = db.prepare('SELECT doc_id, text, provenance, verified, changes FROM knowledge_docs').all();
  db.close();
  assert.deepEqual(rows.map((row) => row.doc_id), ['k_a']);
  assert.equal(rows[0].text, '组合导出必须完整');
  assert.equal(rows[0].provenance, 'authored');
  assert.equal(rows[0].verified, 1);
  assert.deepEqual(JSON.parse(rows[0].changes), []);

  // With a sharded index present, RAG export merges it into one JSON file.
  const fakeEmbed = async (url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({ data: inputs.map(() => ({ embedding: [1, 0, 0] })) }), { status: 200 });
  };
  await buildRagIndex(store, localExternal(), { fetchImpl: fakeEmbed });
  const rag = exportArtifact(store, { type: 'rag' });
  assert.equal(rag.ok, true);
  assert.ok(rag.filename.endsWith('.json'));
  const exportedRag = JSON.parse(rag.buffer.toString('utf8'));
  assert.ok(exportedRag.docs.k_a);
  assert.equal(exportedRag.docs.k_a.text, '组合导出必须完整');
});

test('RAG index is sharded and rewrites only changed shards', async () => {
  const root = tempRoot();
  let docs = [
    { doc_id: 'k_a', text: 'aaaa', category: 'ui_facts', source: 'user' },
    { doc_id: 'k_b', text: 'bbbb', category: 'errors_fixes', source: 'user' },
  ];
  const store = { root, documents: () => docs };
  const fake = async (url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map((text) => ({ embedding: [text.length, 1, 0] })),
    }), { status: 200 });
  };
  const first = await buildRagIndex(store, localExternal(), { fetchImpl: fake });
  assert.equal(first.ok, true);
  assert.equal(first.shards, 2);
  const manifest1 = JSON.parse(fs.readFileSync(ragManifestPath(root), 'utf8'));
  assert.equal(manifest1.layout, 'sharded');
  assert.equal(manifest1.count, 2);
  assert.equal(manifest1.shards.length, 2);
  assert.equal(fs.existsSync(path.join(root, 'rag', 'index.json')), false);
  for (const shard of manifest1.shards) {
    assert.equal(fs.existsSync(path.join(root, 'rag', shard.file)), true);
  }
  const hashes1 = Object.fromEntries(manifest1.shards.map((shard) => [shard.id, shard.hash]));

  // Nothing changed: no embedding and no shard rewrite.
  const second = await buildRagIndex(store, localExternal(), { fetchImpl: fake });
  assert.equal(second.embedded, 0);
  const manifest2 = JSON.parse(fs.readFileSync(ragManifestPath(root), 'utf8'));
  assert.deepEqual(Object.fromEntries(manifest2.shards.map((shard) => [shard.id, shard.hash])), hashes1);

  // Only the touched category's shard changes.
  docs = docs.map((doc) => (doc.doc_id === 'k_a' ? { ...doc, text: 'aaaa-changed' } : doc));
  const third = await buildRagIndex(store, localExternal(), { fetchImpl: fake });
  assert.equal(third.embedded, 1);
  const manifest3 = JSON.parse(fs.readFileSync(ragManifestPath(root), 'utf8'));
  const hashes3 = Object.fromEntries(manifest3.shards.map((shard) => [shard.id, shard.hash]));
  assert.notEqual(hashes3.ui_facts, hashes1.ui_facts);
  assert.equal(hashes3.errors_fixes, hashes1.errors_fixes);
});

test('split prose does not broadcast a subject and keeps near-limit clauses', () => {
  const mixed = `网关超时默认是 30 秒，重试次数必须为 3，日志格式统一为 JSON，${'补充背景'.repeat(100)}`;
  const details = splitSentenceDetails(mixed);
  assert.ok(details.some((detail) => detail.text === '重试次数必须为 3'));
  assert.ok(details.some((detail) => detail.text === '日志格式统一为 JSON'));
  assert.equal(details.some((detail) => detail.text.startsWith('网关超时，重试次数')), false);
  assert.equal(details.some((detail) => detail.text.startsWith('网关超时，日志格式')), false);

  const first = '网关超时默认是 30 秒';
  const nearLimit = `必须${'x'.repeat(396)}`; // 398 chars: adding "网关超时，" would exceed 400.
  const long = `${first}，${nearLimit}`;
  assert.ok(long.length > 400);
  const split = splitSentenceDetails(long);
  assert.ok(split.some((detail) => detail.text === nearLimit), 'near-limit clause must not be dropped');

  const huge = `必须${'y'.repeat(500)}`;
  const truncated = splitSentenceDetails(`${first}，${huge}`)
    .find((detail) => detail.text.includes('已截断'));
  assert.ok(truncated);
  assert.equal(truncated.truncated, true);
});

test('RAG reports the maxDocs cap and the dedupe reduction separately', async () => {
  const root = tempRoot();
  try {
    const docs = [
      { doc_id: 'k_a', text: 'aaaa', category: 'ui_facts', source: 'user' },
      { doc_id: 'k_b', text: 'bbbb', category: 'ui_facts', source: 'user' },
      { doc_id: 'k_c', text: 'cccc', category: 'errors_fixes', source: 'user' },
    ];
    const store = { root, documents: () => docs };
    const fake = async (url, init) => {
      const body = JSON.parse(init.body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const vectors = { aaaa: [1, 0, 0], bbbb: [0, 1, 0], cccc: [0, 0, 1] };
      return new Response(JSON.stringify({
        data: inputs.map((text) => ({ embedding: vectors[String(text)] ?? [1, 0, 0] })),
      }), { status: 200 });
    };
    const built = await buildRagIndex(store, localExternal(), { fetchImpl: fake, maxDocs: 2 });
    assert.equal(built.ok, true);
    assert.equal(built.considered, 3);
    assert.equal(built.truncated, 1);
    assert.equal(built.indexed, 2);
    const manifest = JSON.parse(fs.readFileSync(ragManifestPath(root), 'utf8'));
    assert.equal(manifest.considered, 3);
    assert.equal(manifest.truncated, 1);
    assert.equal(manifest.maxDocs, 2);
    assert.equal(manifest.count, 2);
    const stats = ragStats(root);
    assert.equal(stats.considered, 3);
    assert.equal(stats.truncated, 1);
    assert.equal(stats.docs, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readRagIndex reuses one parsed generation until the manifest changes', async () => {
  const root = tempRoot();
  try {
    const docs = [{ doc_id: 'k_a', text: 'aaaa', category: 'ui_facts', source: 'user' }];
    const store = { root, documents: () => docs };
    const fake = async () => new Response(JSON.stringify({
      data: [{ embedding: [1, 0, 0] }],
    }), { status: 200 });
    assert.equal((await buildRagIndex(store, localExternal(), { fetchImpl: fake })).ok, true);
    const first = readRagIndex(root);
    assert.equal(readRagIndex(root), first);
    // A new build publishes a new manifest generation; the cache must follow.
    const rebuilt = await buildRagIndex(store, localExternal(), { fetchImpl: fake });
    assert.equal(rebuilt.ok, true);
    const second = readRagIndex(root);
    assert.notEqual(second, first);
    assert.equal(second.docs.k_a.text, 'aaaa');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('single-file RAG indexes are rejected and deleted on rebuild', async () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'rag'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rag', 'index.json'), JSON.stringify({
    version: 1,
    model: 'old-model',
    dim: 3,
    built_at: '2026-01-01T00:00:00.000Z',
    docs: { k_old: { hash: 'h_old', vector: [1, 0, 0] } },
  }));
  // The old layout is no longer readable at all.
  assert.equal(readRagIndex(root), null);
  assert.equal(ragStats(root).built, false);
  fs.writeFileSync(ragManifestPath(root), JSON.stringify({
    version: 2, layout: 'sharded', model: 'old', endpoint: 'http://old', dim: 3, shards: [],
  }));
  // Older sharded manifests are invalidated too, forcing a rebuild.
  assert.equal(readRagIndex(root), null);
  assert.equal(ragStats(root).built, false);

  const docs = [{ doc_id: 'k_new', text: 'nn', category: 'ui_facts', source: 'user' }];
  const store = { root, documents: () => docs };
  const fake = async () => new Response(JSON.stringify({ data: [{ embedding: [2, 1, 0] }] }), { status: 200 });
  const built = await buildRagIndex(store, localExternal(), { fetchImpl: fake });
  assert.equal(built.ok, true);
  // Rebuilding cleans up the old file instead of migrating it.
  assert.equal(fs.existsSync(path.join(root, 'rag', 'index.json')), false);
  assert.equal(fs.existsSync(ragManifestPath(root)), true);
  assert.equal(readRagIndex(root).docs.k_new.hash.length > 0, true);
  assert.equal(ragStats(root).layout, 'sharded');
});

test('RAG requires both embedding and rerank models', () => {
  assert.equal(ragModelStatus({}).ready, false);
  assert.deepEqual(ragModelStatus({}).missing.length, 2);
  assert.equal(ragModelStatus({ externalEmbedModel: 'bge-m3' }).ready, false);
  assert.equal(ragModelStatus({ externalRerankModel: 'reranker' }).ready, false);
  assert.equal(ragModelStatus({
    externalEmbedModel: 'bge-m3',
    externalRerankModel: 'reranker',
  }).ready, true);
});

test('concurrent RAG builds serialize and a stale writer lock is ignored', async () => {
  const root = tempRoot();
  const docs = Array.from({ length: 6 }, (_, index) => ({
    doc_id: `k_${index}`,
    text: `text-${index}`,
    category: index % 2 === 0 ? 'ui_facts' : 'errors_fixes',
    source: 'user',
  }));
  const store = { root, documents: () => docs };
  const fake = async (url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map((text) => {
        const vector = [0, 0, 0, 0, 0, 0];
        const index = Number(String(text).split('-')[1]);
        vector[Number.isInteger(index) ? index % 6 : 0] = 1;
        return { embedding: vector };
      }),
    }), { status: 200 });
  };
  // A stale lock whose owner pid is dead must be reclaimed promptly, without
  // waiting for LOCK_STALE_MS or freezing the event loop.
  fs.mkdirSync(path.join(root, 'rag'), { recursive: true });
  const lockFile = path.join(root, 'rag', '.lock');
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: 99999999,
    at: new Date(Date.now() - 5_000).toISOString(),
  }));
  const lockStarted = Date.now();

  const [a, b] = await Promise.all([
    buildRagIndex(store, localExternal(), { fetchImpl: fake }),
    buildRagIndex(store, localExternal(), { fetchImpl: fake }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.ok(Date.now() - lockStarted < 2_000, 'dead writer lock should not wait for the full stale window');
  const manifest = JSON.parse(fs.readFileSync(ragManifestPath(root), 'utf8'));
  assert.equal(manifest.count, docs.length);
  assert.equal(fs.existsSync(lockFile), false);
  const candidates = ragCandidates(store, [1, 1, 1, 1, 1, 1], { topK: 10 });
  assert.equal(candidates.ok, true);
  assert.equal(candidates.candidates.length, 6);
  // Cached text/category in shards means the search path does not need this.
  const textOnly = { root, documents: () => [] };
  assert.equal(ragCandidates(textOnly, [1, 1, 1, 1, 1, 1], { topK: 10 }).candidates.length, 6);
});

test('knowledge backend config accepts json / sqlite and rejects unknown values', () => {
  assert.equal(normalizeConfig({}).knowledgeBackend, 'json');
  assert.equal(normalizeConfig({ knowledgeBackend: 'sqlite' }).knowledgeBackend, 'sqlite');
  assert.equal(normalizeConfig({ knowledgeBackend: 'sql' }).knowledgeBackend, 'sqlite');
  const validator = Config['~standard'].validate;
  assert.equal(validator({ knowledgeBackend: 'sqlite' }).value.knowledgeBackend, 'sqlite');
  // The loader only sees Config.validate; an accepted alias must already be
  // normalized there, otherwise the store silently falls back to JSON.
  assert.equal(validator({ knowledgeBackend: 'sql' }).value.knowledgeBackend, 'sqlite');
  assert.ok(validator({ knowledgeBackend: 'mysql' }).issues);
});

test('SQLite knowledge backend imports JSON rows, mirrors writes and deletes', (t) => {
  if (!sqliteAvailable()) {
    t.skip('node:sqlite is unavailable on this Node build');
    return;
  }
  const root = tempRoot();
  const jsonStore = new MemoryStore(root).init();
  jsonStore.remember({ doc_id: 'k_old', text: '旧的 JSON 知识', category: 'ui_facts', source: 'user' });

  const store = new MemoryStore(root, { knowledgeBackend: 'sqlite' });
  assert.equal(store.knowledgeBackend, 'sqlite');
  // First open imports existing JSON documents, so nothing written before the
  // switch disappears.
  assert.equal(store.documents().length, 1);

  const written = store.remember({
    doc_id: 'k_new',
    text: '写进 SQLite 的知识',
    category: 'errors_fixes',
    source: 'agent',
  });
  assert.equal(written.merged, false);
  assert.equal(store.documents().length, 2);

  const dbFile = knowledgeDatabasePath(root);
  assert.equal(fs.existsSync(dbFile), true);
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(dbFile);
  const rows = db.prepare('SELECT doc_id FROM knowledge_docs ORDER BY doc_id').all();
  db.close();
  assert.deepEqual(rows.map((row) => row.doc_id), ['k_new', 'k_old']);

  // The JSON mirror keeps a switch back to the file backend lossless.
  const back = new MemoryStore(root);
  assert.equal(back.knowledgeBackend, 'json');
  assert.equal(back.documents().length, 2);
  const info = store.knowledgeBackendInfo();
  assert.equal(info.source, 'json');
  assert.equal(info.sqlMirror, true);

  // JSON alone decides what the knowledge base contains: a row written only
  // into the SQL mirror must not appear in documents(), because SQLite is a
  // derived read-only view rather than a second source of truth.
  const dbOnly = new DatabaseSync(dbFile);
  dbOnly.prepare('INSERT INTO knowledge_docs (doc_id, text) VALUES (?, ?)').run('k_sql_only', 'SQL only');
  dbOnly.close();
  assert.equal(store.documents().some((doc) => doc.doc_id === 'k_sql_only'), false);
  assert.equal(store.documents().length, 2);

  const removed = store.forgetKnowledge('k_new');
  assert.equal(removed.deleted, true);
  assert.equal(store.documents().length, 1);
  assert.equal(back.documents().length, 1);
});

test('query router sends metrics to SQL and fuzzy questions to vectors', () => {
  assert.equal(routeKnowledgeQuery('知识一共有多少条').route, 'sql');
  assert.equal(routeKnowledgeQuery('按分类统计知识数量').route, 'sql');
  assert.equal(routeKnowledgeQuery('k_5ec4c66a 是什么').route, 'sql');
  assert.equal(routeKnowledgeQuery('最近 3 条知识').route, 'sql');
  assert.equal(routeKnowledgeQuery('如何清理上下文').route, 'vector');
  assert.equal(routeKnowledgeQuery('错误修复有多少条，相关文档有哪些').route, 'hybrid');
  assert.equal(translateToSql('知识一共有多少条').kind, 'count');
  assert.equal(translateToSql('按分类统计知识数量').kind, 'group');
  assert.equal(translateToSql('k_5ec4c66a 是什么').kind, 'exact');
  assert.equal(translateToSql('最近 3 条知识').kind, 'recent');
  assert.equal(translateToSql('如何清理上下文'), null);
  // A bare "最多" is not a category/source aggregate; it must not turn into a
  // confident SQL answer about workflow_rules.
  assert.equal(routeKnowledgeQuery('哪个方案最多坑').route, 'vector');
  assert.equal(translateToSql('哪个方案最多坑'), null);
  assert.equal(translateToSql('哪个分类最多').kind, 'top');
  assert.equal(translateToSql('未确认的模型自述有几条').kind, 'unverified');
});

test('raw SQL is accepted only as one read-only statement', () => {
  assert.equal(isSafeSelect('SELECT COUNT(*) FROM knowledge_docs'), true);
  assert.equal(isSafeSelect('select * from knowledge_docs where category = ?'), true);
  assert.equal(isSafeSelect('DELETE FROM knowledge_docs'), false);
  assert.equal(isSafeSelect('SELECT 1; DROP TABLE knowledge_docs'), false);
  assert.equal(isSafeSelect('SELECT * FROM knowledge_docs;'), true);
  assert.equal(translateToSql('DELETE FROM knowledge_docs'), null);
});

test('SQL route answers counts and groups from the JSON base', (t) => {
  if (!sqliteAvailable()) {
    t.skip('node:sqlite is unavailable on this Node build');
    return;
  }
  const store = new MemoryStore(tempRoot()).init();
  store.remember({ doc_id: 'k_abc12345', text: '界面按钮位置', category: 'ui_facts', source: 'agent' });
  store.remember({ doc_id: 'k_b', text: '超时重试三次', category: 'errors_fixes', source: 'user' });
  store.remember({ doc_id: 'k_c', text: '发布前跑测试', category: 'errors_fixes', source: 'user' });

  const total = runSqlQuery(store, '知识一共有多少条');
  assert.equal(total.ok, true);
  assert.equal(total.rows[0].n, 3);

  const grouped = runSqlQuery(store, '按分类统计知识数量');
  assert.equal(grouped.ok, true);
  const byCategory = Object.fromEntries(grouped.rows.map((row) => [row.label, row.n]));
  assert.equal(byCategory.errors_fixes, 2);
  assert.equal(byCategory.ui_facts, 1);

  // Category filter must produce valid SQL (`WHERE` after `FROM`).
  const filteredCount = runSqlQuery(store, '错误修复有多少条');
  assert.equal(filteredCount.ok, true);
  assert.equal(filteredCount.rows[0].n, 2);

  const exact = runSqlQuery(store, 'k_abc12345 是什么');
  assert.equal(exact.ok, true);
  assert.equal(exact.rows[0].doc_id, 'k_abc12345');

  const output = formatSqlResult('知识一共有多少条', total);
  assert.match(output, /检索路由：SQL/);
  assert.match(output, /n=3/);

  // The same query works against a merged document list with origin labels.
  const merged = store.documents().map((doc) => ({ ...doc, origin: '本对话' }));
  const mergedTotal = runSqlQuery(merged, '知识一共有多少条');
  assert.equal(mergedTotal.rows[0].n, 3);
});

test('SQL view keeps provenance/changes and counts copies across conversations', (t) => {
  if (!sqliteAvailable()) {
    t.skip('node:sqlite is unavailable on this Node build');
    return;
  }
  const root = tempRoot();
  let store;
  try {
    store = new MemoryStore(root, { knowledgeBackend: 'sqlite' });
    store.remember({
      text: '模型自己猜的发布分支是 main',
      category: 'project_facts',
      source: 'staging',
      provenance: 'model',
      verified: false,
    }, { confirm: true });
    store.remember({
      text: '发布分支实际是 release',
      category: 'project_facts',
      source: 'user',
      provenance: 'user',
      verified: true,
    }, { confirm: true });

    const docs = store.documents();
    const merged = [
      ...docs.map((doc) => ({ ...doc, origin: '对话 A' })),
      ...docs.map((doc) => ({ ...doc, origin: '对话 B' })),
    ];

    // The same doc_id exists in two conversations. COUNT(*) must count copies;
    // COUNT(DISTINCT doc_id) remains the "distinct facts" number.
    const total = runSqlQuery(merged, '知识一共有多少条');
    assert.equal(total.ok, true);
    assert.equal(total.rows[0].n, 4);
    assert.equal(total.rows[0].distinct_docs, 2);
    const distinct = runSqlQuery(merged, 'SELECT COUNT(DISTINCT doc_id) AS n FROM knowledge_docs');
    assert.equal(distinct.ok, true);
    assert.equal(distinct.rows[0].n, 2);

    // Both schemas expose the same semantic columns.
    const schemaRow = runSqlQuery(
      merged,
      'SELECT provenance, verified, changes, origin FROM knowledge_docs LIMIT 1',
    );
    assert.equal(schemaRow.ok, true);
    assert.ok(Object.hasOwn(schemaRow.rows[0], 'provenance'));
    assert.ok(Object.hasOwn(schemaRow.rows[0], 'verified'));
    assert.ok(Object.hasOwn(schemaRow.rows[0], 'changes'));
    assert.ok(Object.hasOwn(schemaRow.rows[0], 'origin'));

    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const mirror = new DatabaseSync(knowledgeDatabasePath(root));
    const columns = mirror.prepare('PRAGMA table_info(knowledge_docs)').all().map((row) => row.name);
    mirror.close();
    for (const column of ['provenance', 'verified', 'changes', 'origin']) {
      assert.ok(columns.includes(column), `persistent mirror is missing ${column}`);
    }

    const claims = runSqlQuery(merged, '未确认的模型自述有几条');
    assert.equal(claims.ok, true);
    assert.equal(claims.rows[0].n, 2);

    const listed = runSqlQuery(merged, '列出未确认的模型自述');
    assert.equal(listed.ok, true);
    assert.match(formatSqlResult('列出未确认的模型自述', listed), /模型自述/);
  } finally {
    try { store.knowledgeSql?.close?.(); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('local model folders are discovered by category without loading weights', () => {
  const root = tempRoot();
  try {
    const embedding = path.join(root, 'models', 'Embedding', 'bge-m3');
    fs.mkdirSync(embedding, { recursive: true });
    fs.writeFileSync(path.join(embedding, 'model.json'), JSON.stringify({
      name: 'BGE M3 本地',
      baseUrl: 'http://127.0.0.1:8080',
      model: 'bge-m3',
      apiKey: 'must-not-leak',
    }));
    const rerank = path.join(root, 'models', 'Rerank', 'ranker');
    fs.mkdirSync(rerank, { recursive: true });
    const routing = path.join(root, 'models', 'Routing', 'router');
    fs.mkdirSync(routing, { recursive: true });
    const future = path.join(root, 'models', 'Future', 'thing');
    fs.mkdirSync(future, { recursive: true });
    fs.writeFileSync(path.join(future, 'model.json'), JSON.stringify({
      name: 'future', baseUrl: '', model: '', apiKey: 'also-secret',
    }));

    const catalog = listLocalModels(path.join(root, 'models'));
    assert.deepEqual(catalog.categories.map((item) => item.name), ['Embedding', 'Rerank', 'Routing', 'Future']);
    const embed = catalog.categories[0].models[0];
    assert.equal(embed.label, 'BGE M3 本地');
    assert.equal(embed.baseUrl, 'http://127.0.0.1:8080');
    assert.equal(embed.model, 'bge-m3');
    assert.equal(embed.configured, true);
    assert.equal(Object.hasOwn(embed, 'apiKey'), false);
    assert.equal(catalog.categories[1].models[0].configured, false);
    assert.equal(catalog.categories[2].models[0].configured, false);
    assert.match(catalog.categories[2].models[0].error, /预留/);
    assert.equal(catalog.categories[3].models[0].configured, false);
    assert.match(catalog.categories[3].models[0].error, /预留/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default model configuration lives under DSH home, not the plugin install root', () => {
  const root = tempRoot();
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = root;
    const userModel = path.join(root, 'ai-for-memory', 'models', 'Embedding', 'user-model');
    fs.mkdirSync(userModel, { recursive: true });
    fs.writeFileSync(path.join(userModel, 'weights.gguf'), '');
    const resolved = resolveModel({ modelId: 'Embedding/user-model' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.model.modelsRoot, path.join(root, 'ai-for-memory', 'models'));

    // The plugin-bundled models/ directory is still visible as a secondary
    // source, but it is not where user configuration is written.
    const catalog = listLocalModels();
    assert.equal(catalog.root, path.join(root, 'ai-for-memory', 'models'));
    assert.deepEqual(catalog.roots.map((row) => row.source), ['user', 'install']);
  } finally {
    resetLocalModelsCache();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the model catalog is TTL-cached instead of walking the tree on every state read', () => {
  const root = tempRoot();
  try {
    const models = path.join(root, 'models');
    fs.mkdirSync(path.join(models, 'Embedding', 'first'), { recursive: true });
    const first = listLocalModelsCached(models, 60000);
    assert.equal(first.categories[0].models[0].id, 'Embedding/first');

    // A new folder inside the TTL window is intentionally not visible yet.
    fs.mkdirSync(path.join(models, 'Embedding', 'second'), { recursive: true });
    const cached = listLocalModelsCached(models, 60000);
    assert.deepEqual(cached.categories[0].models.map((model) => model.id), ['Embedding/first']);

    resetLocalModelsCache();
    const fresh = listLocalModelsCached(models, 60000);
    assert.deepEqual(fresh.categories[0].models.map((model) => model.id).sort(), [
      'Embedding/first', 'Embedding/second',
    ]);
  } finally {
    resetLocalModelsCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git sync commits only selected layers and stays local until enabled', async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('git is not installed');
    return;
  }
  const root = tempRoot();
  try {
    writeSyncConfig(root, {
      enabled: false,
      role: 'host',
      remote: 'ssh://example.invalid/memory.git',
      group: 'demo',
      paths: ['knowledge'],
    });
    assert.equal((await initSync(root)).ok, false, 'disabled sync must not initialize');
    writeSyncConfig(root, { enabled: true });
    assert.equal(readSyncConfig(root).enabled, true);
    const init = await initSync(root);
    assert.equal(init.ok, true);
    assert.equal(fs.existsSync(path.join(root, '.sync', 'owned')), true);
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), 'main');
    // Re-running init must preserve user-owned exclude rules and identity.
    fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '# keep-this-rule\ncustom-rule\n');
    execFileSync('git', ['config', 'user.name', 'Alice Existing'], { cwd: root });
    assert.equal((await initSync(root)).ok, true);
    assert.match(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /custom-rule/);
    assert.equal(execFileSync('git', ['config', '--get', 'user.name'], { cwd: root, encoding: 'utf8' }).trim(), 'Alice Existing');
    const knowledgeDir = path.join(root, 'knowledge');
    const contextsDir = path.join(root, 'contexts');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.mkdirSync(contextsDir, { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, 'doc.json'), '{"doc_id":"k_a"}\n');
    fs.writeFileSync(path.join(contextsDir, 'secret.json'), '{"text":"must not sync"}\n');
    fs.writeFileSync(path.join(root, 'compaction_status.json'), '{"state":"done"}\n');
    const committed = await commitSync(root, 'test sync');
    assert.equal(committed.ok, true);
    assert.equal(committed.committed, true);
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/);
    assert.ok(tracked.includes('knowledge/doc.json'));
    assert.equal(tracked.some((file) => file.startsWith('contexts/')), false);
    assert.equal(tracked.some((file) => file.includes('compaction_status')), false);
    const status = await syncStatus(root);
    assert.equal(status.initialized, true);
    assert.equal(status.dirty, 0);
    assert.equal(status.config.role, 'host');

    // Deselecting a previously synced layer must remove its tracked files from
    // the index, not leave them in the repository where exclude cannot hide
    // them. Working copies stay on disk.
    writeSyncConfig(root, { paths: ['archive'] });
    const archiveDir = path.join(root, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'archived.json'), '{"kind":"action"}\n');
    const narrowed = await commitSync(root, 'deselect contexts');
    assert.equal(narrowed.ok, true, narrowed.error);
    const trackedAfter = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/);
    assert.equal(trackedAfter.includes('knowledge/doc.json'), false);
    assert.equal(trackedAfter.includes('archive/archived.json'), true);
    assert.equal(fs.existsSync(path.join(knowledgeDir, 'doc.json')), true);

    // "Uncheck everything" is a real, persistent setting, not a reset to the
    // default four layers. It must stop before touching the repository.
    writeSyncConfig(root, { paths: [] });
    assert.deepEqual(readSyncConfig(root).paths, []);
    const stopped = await commitSync(root, 'no layers');
    assert.equal(stopped.ok, true);
    assert.equal(stopped.committed, false);
    assert.equal(stopped.stopped, true);
    const stoppedPush = await pushSync(root, 'no layers');
    assert.equal(stoppedPush.ok, true);
    assert.equal(stoppedPush.stopped, true);
    const stoppedPull = await pullSync(root);
    assert.equal(stoppedPull.ok, true);
    assert.equal(stoppedPull.stopped, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('git sync refuses to take over an existing project repository', async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('git is not installed');
    return;
  }
  const root = tempRoot();
  try {
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', 'app.js'), 'export const app = true;\n');
    execFileSync('git', ['init'], { cwd: project, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Project Owner'], { cwd: project });
    execFileSync('git', ['config', 'user.email', 'owner@example.invalid'], { cwd: project });
    execFileSync('git', ['add', '-A'], { cwd: project });
    execFileSync('git', ['commit', '-m', 'real project commit'], { cwd: project, stdio: 'ignore' });
    const commitsBefore = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
    const excludeFile = path.join(project, '.git', 'info', 'exclude');
    const excludeBefore = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
    writeSyncConfig(project, {
      enabled: true,
      remote: 'ssh://example.invalid/memory.git',
      paths: ['knowledge'],
    });
    const initialized = await initSync(project);
    assert.equal(initialized.ok, false);
    assert.match(initialized.error, /\.sync\/owned|拒绝接管/);
    assert.equal(fs.existsSync(path.join(project, '.sync', 'owned')), false);
    if (excludeBefore !== '') {
      assert.equal(fs.readFileSync(excludeFile, 'utf8'), excludeBefore);
    } else {
      assert.equal(fs.existsSync(excludeFile), false);
    }
    assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim(), commitsBefore);
    assert.equal(fs.existsSync(path.join(project, 'src', 'app.js')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('git sync pulls into a fresh peer that has no local commit yet', async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('git is not installed');
    return;
  }
  const root = tempRoot();
  try {
    const remote = path.join(root, 'remote.git');
    const host = path.join(root, 'host');
    const peer = path.join(root, 'peer');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    fs.mkdirSync(path.join(host, 'knowledge'), { recursive: true });
    execFileSync('git', ['init'], { cwd: host, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Host'], { cwd: host });
    execFileSync('git', ['config', 'user.email', 'host@example.invalid'], { cwd: host });
    fs.writeFileSync(path.join(host, 'knowledge', 'host.json'), '{"doc_id":"k_host"}\n');
    writeSyncConfig(host, { enabled: true, remote, paths: ['knowledge'] });
    // This host was initialized manually (as an old/self-managed repository);
    // mark it as owned so the new safety check does not reject it.
    fs.writeFileSync(path.join(host, '.sync', 'owned'), JSON.stringify({
      version: 1, owner: 'ai-for-memory',
    }));
    const pushed = await pushSync(host, 'host initial');
    assert.equal(pushed.ok, true, pushed.error);
    fs.writeFileSync(path.join(host, 'knowledge', 'ahead.json'), '{"doc_id":"k_ahead"}\n');
    assert.equal((await commitSync(host, 'host ahead')).ok, true);
    const aheadStatus = await syncStatus(host);
    assert.equal(aheadStatus.upstream, 'origin/main');
    assert.equal(aheadStatus.ahead, 1);
    assert.equal(aheadStatus.behind, 0);

    fs.mkdirSync(peer, { recursive: true });
    writeSyncConfig(peer, { enabled: true, remote, paths: ['knowledge'] });
    assert.equal((await initSync(peer)).ok, true);
    const pulled = await pullSync(peer);
    assert.equal(pulled.ok, true, pulled.error);
    assert.equal(fs.existsSync(path.join(peer, 'knowledge', 'host.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('git sync reports a missing branch instead of pretending local divergence', async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('git is not installed');
    return;
  }
  const root = tempRoot();
  try {
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    const peer = path.join(root, 'peer');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    fs.mkdirSync(path.join(seed, 'knowledge'), { recursive: true });
    execFileSync('git', ['init'], { cwd: seed, stdio: 'ignore' });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/master'], { cwd: seed });
    execFileSync('git', ['config', 'user.name', 'Seed'], { cwd: seed });
    execFileSync('git', ['config', 'user.email', 'seed@example.invalid'], { cwd: seed });
    fs.writeFileSync(path.join(seed, 'knowledge', 'seed.json'), '{"doc_id":"k_seed"}\n');
    execFileSync('git', ['add', '-A'], { cwd: seed });
    execFileSync('git', ['commit', '-m', 'seed master'], { cwd: seed, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: seed });
    execFileSync('git', ['push', '-u', 'origin', 'master'], { cwd: seed, stdio: 'ignore' });

    fs.mkdirSync(peer, { recursive: true });
    writeSyncConfig(peer, { enabled: true, remote, paths: ['knowledge'] });
    assert.equal((await initSync(peer)).ok, true);
    const pulled = await pullSync(peer);
    assert.equal(pulled.ok, false);
    assert.match(pulled.error, /远端没有 main 分支/);
    assert.match(pulled.error, /master/);
    assert.doesNotMatch(pulled.error, /本地与主机已分叉/);

    const pushed = await pushSync(peer, 'peer main');
    assert.equal(pushed.ok, false);
    assert.match(pushed.error, /远端已有分支 master/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('git sync never adopts or excludes files from a parent project repository', async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('git is not installed');
    return;
  }
  const root = tempRoot();
  try {
    const project = path.join(root, 'project');
    const memory = path.join(project, 'memory');
    fs.mkdirSync(memory, { recursive: true });
    execFileSync('git', ['init'], { cwd: project, stdio: 'ignore' });
    const parentExclude = path.join(project, '.git', 'info', 'exclude');
    const parentRules = '# project-owned exclude\nkeep-me\n';
    fs.writeFileSync(parentExclude, parentRules);

    writeSyncConfig(memory, {
      enabled: true,
      remote: 'ssh://example.invalid/memory.git',
      paths: ['knowledge'],
    });
    const init = await initSync(memory);
    assert.equal(init.ok, true);

    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: memory,
      encoding: 'utf8',
    }).trim();
    const canon = (value) => {
      const resolved = fs.realpathSync.native(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    assert.equal(canon(top), canon(memory));
    assert.match(fs.readFileSync(parentExclude, 'utf8'), /project-owned exclude/);
    assert.match(fs.readFileSync(parentExclude, 'utf8'), /memory\//);
    const parentStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: project,
      encoding: 'utf8',
    });
    assert.doesNotMatch(parentStatus, /memory/);
    assert.equal((await syncStatus(memory)).initialized, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('harness checkpoints get a current-request anchor, not a repeated answer', async () => {
  const root = tempRoot();
  try {
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: () => undefined,
    };
    const config = normalizeConfig({ root: path.join(root, 'memory'), requestAnchor: true });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);
    const appended = [];
    const session = {
      id: 'session-anchor',
      header: {},
      ownEvents: () => [
        { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '真实请求：加网络层' }] } },
        { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '<system-reminder>\nA skill is reusable.\n</system-reminder>' }] } },
        { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] } },
      ],
      append: (type, data, options) => { appended.push({ type, data, options }); },
    };
    const preStep = handlers.get('agent/pre-step');
    await preStep({ agent: { session }, signal: new AbortController().signal }, () => {});
    assert.equal(appended.length, 1);
    assert.equal(appended[0].type, 'user/message');
    assert.equal(appended[0].data.source.kind, 'ai-for-memory');
    assert.equal(appended[0].data.source.form, 'notice');
    assert.match(appended[0].data.content[0].text, /真实请求：加网络层/);
    // Same checkpoint must not add the anchor again on every step.
    await preStep({ agent: { session }, signal: new AbortController().signal }, () => {});
    assert.equal(appended.length, 1);

    // A checkpoint and a new user request can enter the same step. The newer
    // request must win; the old request must not be injected as an anchor.
    const nextSession = { ...session, id: 'session-anchor-with-request' };
    await preStep({
      agent: { session: nextSession },
      messages: [{ role: 'user', content: [{ type: 'text', text: '新请求：修 .engine.lock 并发写入' }] }],
      signal: new AbortController().signal,
    }, () => {});
    assert.equal(appended.length, 1);

    // A checkpoint prefix followed by a real request is not a pure checkpoint;
    // it must not make the old request win.
    const mixedSession = { ...session, id: 'session-anchor-mixed' };
    await preStep({
      agent: { session: mixedSession },
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Time sampled while preparing turn 2\n新请求：检查缓存签名' }],
      }],
      signal: new AbortController().signal,
    }, () => {});
    assert.equal(appended.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('知识权重按最近使用衰减，且只作用于本对话', () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;
  assert.equal(recencyWeight(new Date(now).toISOString(), now), 1);
  assert.ok(Math.abs(recencyWeight(new Date(now - 14 * day).toISOString(), now) - 0.5) < 1e-9);
  assert.ok(Math.abs(recencyWeight(new Date(now - 28 * day).toISOString(), now) - 0.25) < 1e-9);
  assert.equal(USAGE_HALF_LIFE_DAYS, 14);
  assert.equal(recencyWeight('not-a-date', now), 0);
  assert.equal(boostScore(1, 0), 1);
  assert.equal(boostScore(1, 1), 1.25);

  const memoryRoot = tempRoot();
  const scopes = new MemoryScopes(memoryRoot);
  const a = scopes.sessionStore(sessionKey('conv-weight-a'));
  const b = scopes.sessionStore(sessionKey('conv-weight-b'));
  const doc = a.remember({
    text: '知识权重按对话隔离，A 对话最近使用不会抬高 B 对话的排序。',
    category: 'project_facts',
    source: 'user',
  }, { confirm: true });
  assert.equal(doc.needs_confirm, undefined);

  // 刚用过：A 权重=1；B 从未使用
  a.recordKnowledgeUsage([doc.doc_id], { at: new Date(now).toISOString() });
  assert.ok(a.knowledgeWeight(doc.doc_id, now) > 0.999);
  assert.equal(b.knowledgeWeight(doc.doc_id, now), 0);
  assert.equal(a.knowledgeUsage()[doc.doc_id].count, 1);

  // A returned hit from B must not be written into A's usage log. B is empty,
  // so this is a foreign doc even though doc_id exists in A.
  b.recordKnowledgeUsage([doc.doc_id], { at: new Date(now - 28 * day).toISOString() });
  assert.equal(b.knowledgeWeight(doc.doc_id, now), 0);
  assert.equal(b.knowledgeUsage()[doc.doc_id], undefined);

  // Once B actually owns a copy of the fact, its own usage applies.
  const bDoc = b.remember({
    text: '知识权重按对话隔离，A 对话最近使用不会抬高 B 对话的排序。',
    category: 'project_facts',
    source: 'user',
  }, { confirm: true });
  assert.equal(bDoc.doc_id, doc.doc_id);
  b.recordKnowledgeUsage([doc.doc_id], { at: new Date(now - 28 * day).toISOString() });
  assert.ok(Math.abs(b.knowledgeWeight(doc.doc_id, now) - 0.25) < 1e-9);
  assert.ok(a.knowledgeWeight(doc.doc_id, now) > 0.999);

  // 使用记录不进入文档列表；forget 后记录一并清掉
  assert.equal(a.documents().some((row) => row.doc_id === doc.doc_id), true);
  a.forgetKnowledge(doc.doc_id);
  assert.equal(a.knowledgeUsage()[doc.doc_id], undefined);
});

test('aim_search 记录本对话使用并标注权重', async () => {
  const root = tempRoot();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(root, 'dsh-home');
  try {
    const memoryRoot = path.join(root, 'memory');
    const registered = [];
    apply({
      tools: { register: (tool) => { registered.push(tool); return () => {}; } },
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
    }, { root: memoryRoot });
    const memory = registered.find((tool) => tool.name === 'aim_memory');
    const searchTool = registered.find((tool) => tool.name === 'aim_search');
    const execA = {
      agent: { session: { id: 'conv-weight-a', header: { cwd: root }, ownEvents: () => [] } },
    };
    const execB = {
      agent: { session: { id: 'conv-weight-b', header: { cwd: root }, ownEvents: () => [] } },
    };

    await memory.execute({
      action: 'remember',
      doc_id: 'weight_marker_doc',
      text: '权重标记测试：本对话最近使用过的知识应该排得更靠前。',
      category: 'project_facts',
      source: 'user',
    }, execA);

    const first = await searchTool.execute({ query: '权重标记测试', scope: 'session' }, execA);
    assert.match(first, /排序含本对话最近使用权重/);
    assert.match(first, /权重 1\.00（最近使用）/);
    assert.match(first, /weight_marker_doc/);

    // A 的搜索只记录 A 自己的使用记录
    const aStore = new MemoryScopes(memoryRoot).sessionStore(sessionKey('conv-weight-a'));
    const aUsage = aStore.knowledgeUsage();
    assert.ok(Object.keys(aUsage).length >= 1);
    assert.ok(aUsage.weight_marker_doc.count >= 1);

    // A cross-conversation hit must not enter A's usage log (and must not get
    // A's +25% boost on the next search).
    await memory.execute({
      action: 'remember',
      doc_id: 'b_only_doc',
      text: 'B 对话独有的知识，用来验证跨对话使用日志不污染 A。',
      category: 'project_facts',
      source: 'user',
    }, execB);
    new MemoryScopes(memoryRoot).setPublic(sessionKey('conv-weight-b'), true);
    const cross = await searchTool.execute({ query: 'B 对话独有' }, execA);
    assert.match(cross, /b_only_doc/);
    assert.equal(aStore.knowledgeUsage().b_only_doc, undefined);
    assert.match(cross, /权重 0\.00（未使用）/);

    // B never used this knowledge, and can read it only because A is opened.
    new MemoryScopes(memoryRoot).setPublic(sessionKey('conv-weight-a'), true);
    const second = await searchTool.execute({ query: '权重标记测试' }, execB);
    assert.match(second, /weight_marker_doc/);
    assert.match(second, /权重 0\.00（未使用）/);

    // B's search returned A's doc, but B owns no copy of it, so B's usage log
    // stays empty for that foreign doc too.
    const bStore = new MemoryScopes(memoryRoot).sessionStore(sessionKey('conv-weight-b'));
    assert.equal(bStore.knowledgeUsage().weight_marker_doc, undefined);
    assert.ok(aStore.knowledgeUsage().weight_marker_doc.count >= aUsage.weight_marker_doc.count);
  } finally {
    process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('事故记录是独立类型，写入知识库且不吃冲突闸门', () => {
  const store = new MemoryStore(tempRoot());
  store.remember({
    doc_id: 'deploy_fact',
    text: '部署脚本在 scripts/deploy.sh，发布前先跑测试',
    category: 'errors_fixes',
  });
  const incident = store.recordIncident({
    title: 'PowerShell 改写 index.js 导致中文编码损坏',
    what_happened: '用 Get-Content | Set-Content 做替换，UTF-8 中文被按 ANSI 解码后写回。',
    impact: 'index.js 中文乱码、语法检查失败；从 git HEAD 与会话编辑日志恢复。',
    cause: 'Shell 以 ANSI 读取 UTF-8 文件，再以 UTF-8 写回乱码字符串。',
    fix: '重放提交之后的 edit 恢复文件，68 个测试全过。',
    prevention: '不再用 shell 管道改写源码，只用 edit/write。',
    severity: 'high',
    status: 'resolved',
    occurred_at: '2026-11-17T14:30:00.000Z',
  });
  assert.equal(incident.category, 'incidents');
  assert.equal(incident.source, 'incident');
  assert.equal(incident.needs_confirm, undefined);
  assert.match(incident.text, /^\[事故\] PowerShell/);
  assert.match(incident.text, /发生时间：2026-11-17T14:30:00.000Z/);
  assert.match(incident.text, /严重度：high/);
  assert.match(incident.text, /状态：resolved/);
  assert.match(incident.text, /预防：不再用 shell/);
  assert.deepEqual(incident.tags.slice(0, 3), ['incident', 'high', 'resolved']);
  assert.equal(store.documents().filter((doc) => doc.category === 'incidents').length, 1);
  assert.equal(normalizeCategory('事故'), 'incidents');
  assert.ok(KNOWLEDGE_CATEGORIES.includes('incidents'));

  // 普通知识仍然经过冲突闸门，事故类型没有削弱它
  const conflict = store.remember({
    text: '部署脚本在 scripts/deploy.sh，上线前先跑测试',
    category: 'errors_fixes',
  });
  assert.equal(conflict.needs_confirm, true);
});

test('aim_memory incident 动作单独记录事故并可检索', async () => {
  const root = tempRoot();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(root, 'dsh-home');
  try {
    const registered = [];
    apply({
      tools: { register: (tool) => { registered.push(tool); return () => {}; } },
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
    }, { root: path.join(root, 'memory') });
    const memory = registered.find((tool) => tool.name === 'aim_memory');
    const searchTool = registered.find((tool) => tool.name === 'aim_search');
    const exec = {
      agent: { session: { id: 'conv-incident', header: { cwd: root }, ownEvents: () => [] } },
    };

    const written = await memory.execute({
      action: 'incident',
      title: '测试事故：缓存目录写满',
      what_happened: '临时目录被测试数据写满，写入失败。',
      impact: '只有临时数据，业务库未受影响。',
      cause: '测试结束没有清理临时文件。',
      fix: '删除临时文件后恢复。',
      prevention: '测试脚本结束时清理临时目录。',
      severity: 'low',
      status: 'resolved',
    }, exec);
    assert.match(written, /事故已写入知识库/);
    assert.match(written, /分类：incidents/);
    assert.match(written, /严重度：low/);
    assert.match(written, /状态：resolved/);

    const status = await memory.execute({ action: 'status' }, exec);
    assert.match(status, /事故记录：1 条/);
    assert.match(status, /独立类型 incidents/);

    const found = await searchTool.execute({
      query: '缓存目录写满', scope: 'session', route: 'vector', mode: 'bm25',
    }, exec);
    assert.match(found, /\[incidents\]/);
    assert.match(found, /测试事故：缓存目录写满/);
  } finally {
    process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('云端服务可分别配置嵌入/重排的地址、模型与 API Key', async () => {
  const config = normalizeExternal({
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: 'sk-main',
    embedBaseUrl: 'https://api.siliconflow.cn/v1',
    embedModel: 'BAAI/bge-m3',
    embedApiKey: 'sk-embed',
    rerankBaseUrl: 'https://api.jina.ai/v1',
    rerankModel: 'jina-reranker-v2-base-multilingual',
    rerankApiKey: 'sk-rerank',
  });
  assert.equal(config.embedApiKey, 'sk-embed');
  assert.equal(config.rerankApiKey, 'sk-rerank');

  const embedEp = embedEndpoint(config);
  assert.equal(embedEp.apiKey, 'sk-embed');
  assert.equal(embedEp.model, 'BAAI/bge-m3');
  const rerankEp = rerankEndpoint(config);
  assert.equal(rerankEp.apiKey, 'sk-rerank');
  assert.equal(rerankEp.model, 'jina-reranker-v2-base-multilingual');

  // 没单独配 key 的端点沿用主 key（本地服务一般留空）
  const inherited = localExternal({ apiKey: 'sk-main' });
  assert.equal(embedEndpoint(inherited).apiKey, 'sk-main');
  assert.equal(rerankEndpoint(inherited).apiKey, 'sk-main');

  // 云端 HTTPS 地址 + Bearer 鉴权头
  const request = buildRequest(embedEp, '/embeddings', { body: { input: 'hi' } });
  assert.equal(request.url, 'https://api.siliconflow.cn/v1/embeddings');
  assert.equal(request.init.headers.authorization, 'Bearer sk-embed');

  // 真发一次，确认 request 与响应解析都走云端的形状
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
  };
  const result = await embed(config, 'hello', fake);
  assert.equal(result.ok, true);
  assert.deepEqual(seen[0], {
    url: 'https://api.siliconflow.cn/v1/embeddings',
    auth: 'Bearer sk-embed',
  });
});

test('local embedding identity survives ephemeral port changes', () => {
  const first = embeddingIdentity(normalizeExternal({
    baseUrl: 'http://127.0.0.1:1001', model: 'bge-m3',
  }));
  const second = embeddingIdentity(normalizeExternal({
    baseUrl: 'http://127.0.0.1:1002', model: 'bge-m3',
  }));
  assert.equal(first.space, 'local:bge-m3');
  assert.equal(second.space, first.space);
  assert.equal(sameEmbeddingSpace({ ...first, endpoint: first.endpoint }, second), true);
  // A remote provider with the same model name is still another space.
  const cloud = embeddingIdentity(normalizeExternal({
    baseUrl: 'https://api.example.com/v1', model: 'bge-m3',
  }));
  assert.equal(sameEmbeddingSpace({ ...first, endpoint: first.endpoint }, cloud), false);
});

test('RAG rebuilds every vector when the embedding provider or model changes', async () => {
  const root = tempRoot();
  const docs = [
    { doc_id: 'k_a', text: '面板截图显示按钮位置', category: 'ui_facts', source: 'agent' },
    { doc_id: 'k_b', text: '超时先重试三次', category: 'errors_fixes', source: 'agent' },
  ];
  const store = { root, documents: () => docs };
  const vectorsOf = (dim) => async (url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map((text) => ({
        embedding: Array.from({ length: dim }, (_, index) => (index === 0 ? text.length : 0)),
      })),
    }), { status: 200 });
  };
  const endpointA = normalizeExternal({ baseUrl: 'http://127.0.0.1:8080', model: 'bge-m3' });
  const first = await buildRagIndex(store, endpointA, { fetchImpl: vectorsOf(3) });
  assert.equal(first.dim, 3);
  assert.equal(first.changed, false);
  assert.ok(ragStats(root).endpoint.endsWith('/v1'));

  // Same provider + model: unchanged documents keep their vectors.
  const same = await buildRagIndex(store, endpointA, { fetchImpl: vectorsOf(3) });
  assert.equal(same.embedded, 0);

  // Same model name, another provider, another dimension: nothing is reused.
  const endpointB = normalizeExternal({ baseUrl: 'https://api.siliconflow.cn/v1', model: 'bge-m3' });
  const switched = await buildRagIndex(store, endpointB, { fetchImpl: vectorsOf(5) });
  assert.equal(switched.ok, true);
  assert.equal(switched.changed, true);
  assert.equal(switched.embedded, 2);
  assert.equal(switched.dim, 5);
  const reopened = readRagIndex(root);
  assert.equal(reopened.dim, 5);
  assert.equal(reopened.endpoint, 'https://api.siliconflow.cn/v1');
  for (const entry of Object.values(reopened.docs)) assert.equal(entry.vector.length, 5);

  // A query embedded at the old dimension is refused instead of scoring zeros.
  const oldQuery = ragCandidates(store, [1, 0, 0], {});
  assert.equal(oldQuery.ok, false);
  assert.equal(oldQuery.reason, 'dim-mismatch');
  assert.equal(oldQuery.indexDim, 5);
  const fresh = ragCandidates(store, [1, 0, 0, 0, 0], {
    model: 'bge-m3', endpoint: 'https://api.siliconflow.cn/v1',
  });
  assert.equal(fresh.ok, true);
  // Even with the same dimension, model/endpoint drift is reported.
  assert.equal(ragCandidates(store, [1, 0, 0, 0, 0], { model: 'other' }).reason, 'model-mismatch');
  assert.equal(ragCandidates(store, [1, 0, 0, 0, 0], {
    model: 'bge-m3', endpoint: 'https://other.example/v1',
  }).reason, 'endpoint-mismatch');
});

test('RAG rebuild never mixes dimensions when the endpoint changes its output', async () => {
  const root = tempRoot();
  const docs = [{ doc_id: 'k_a', text: 'alpha', category: 'ui_facts', source: 'agent' }];
  const store = { root, documents: () => docs };
  const vectorsOf = (dim) => async (url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map(() => ({ embedding: Array.from({ length: dim }, (_, index) => (index === 0 ? 1 : 0)) })),
    }), { status: 200 });
  };
  const endpoint = localExternal();
  await buildRagIndex(store, endpoint, { fetchImpl: vectorsOf(3) });
  // A new document arrives after the server silently changed to 4 dimensions.
  docs.push({ doc_id: 'k_b', text: 'beta', category: 'errors_fixes', source: 'agent' });
  const rebuilt = await buildRagIndex(store, endpoint, { fetchImpl: vectorsOf(4) });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.dim, 4);
  assert.equal(rebuilt.embedded, 2);
  const index = readRagIndex(root);
  assert.equal(index.dim, 4);
  assert.equal(index.docs.k_a.vector.length, 4);
  assert.equal(index.docs.k_b.vector.length, 4);
});

test('aim_ask chat returns a call trace and a source citation map', async () => {
  const tools = createTools(normalizeConfig({
    externalBaseUrl: 'http://127.0.0.1:18099/v1',
    externalModel: 'mock-chat',
    externalTimeoutMs: 5000,
  }));
  const ask = tools.find((tool) => tool.name === 'aim_ask');
  assert.ok(ask);
  const originalFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      id: 'chatcmpl-trace-1',
      created: 1700000000,
      model: 'mock-chat-v2',
      choices: [{ message: { content: '面板范围是两级目录 [1]' }, finish_reason: 'stop' }],
      usage: { total_tokens: 12 },
    }), { status: 200 });
  };
  try {
    const out = await ask.execute({
      action: 'chat',
      prompt: '总结面板范围',
      sources: [
        { id: 'k_a', text: '面板范围是两级目录', url: 'https://example.com/a' },
        { id: 'k_b', text: '未被引用的来源' },
      ],
    });
    // 调用记录：模型、地址、时间、输入指纹、输出长度、请id、tokens    assert.match(out, /调用记录：model=mock-chat-v2/);
    assert.match(out, /地址=http:\/\/127\.0\.0\.1:18099\/v1/);
    assert.match(out, /时间=\d{4}-\d{2}-\d{2}T/);
    assert.match(out, /输入 sha256:[0-9a-f]{12}/);
    assert.match(out, /输出 \d+ 字/);
    assert.match(out, /请求 id=chatcmpl-trace-1/);
    assert.match(out, /tokens=12/);
    // 来源对照：编id/url，并标明模型是否真的引用    assert.match(out, /来源对照：传2 条，模型引用 1 );
    assert.match(out, /\[1\] ✓ 已引用｜k_a｜https:\/\/example\.com\/a/);
    assert.match(out, /\[2\] · 未引用｜k_b/);
    // 编号材料确实发给了模型，system 里带引用规则    assert.equal(seen.url, 'http://127.0.0.1:18099/v1/chat/completions');
    const system = seen.body.messages.find((message) => message.role === 'system');
    assert.match(system.content, /\[1\] id=k_a url=https:\/\/example\.com\/a/);
    assert.match(system.content, /每个结论后必须用 \[1\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('automatic snapshots prune near-duplicates and keep distinct states', () => {
  const textA = '面板范围是两级目录，设置页新增自动快照开关';
  const entries = [
    { snapshot_id: 's1', state: { text: textA } },
    { snapshot_id: 's2', state: { text: textA } },
    { snapshot_id: 's3', state: { text: '数据库迁移前必须备份知识目录' } },
    { snapshot_id: 's4', state: { text: textA } },
  ];
  const plan = planSnapshotPrune(entries, { max: 2 });
  assert.equal(plan.keep.length, 2);
  // The distinct topic survives; the newest near-duplicate is the representative.
  assert.equal(plan.keep[0].snapshot_id, 's3');
  assert.equal(plan.keep[1].snapshot_id, 's4');
  assert.deepEqual(plan.removed.map((row) => row.snapshot_id), ['s1', 's2']);
  assert.ok(plan.removed.every((row) => row.reason === 'similar'));

  // Under the cap nothing is removed at all.
  assert.equal(planSnapshotPrune(entries, { max: 10 }).removed.length, 0);

  // All-distinct overflow falls back to dropping the oldest entry.
  const diverse = ['alpha beta', 'gamma delta', 'epsilon zeta']
    .map((text, index) => ({ snapshot_id: `d${index}`, state: { text } }));
  const fallback = planSnapshotPrune(diverse, { max: 2, threshold: 0.99 });
  assert.deepEqual(fallback.removed.map((row) => row.snapshot_id), ['d0']);
  assert.equal(fallback.removed[0].reason, 'oldest');

  // Name/metadata detection and text extraction.
  const row = { name: `${AUTO_SNAPSHOT_PREFIX}t5`, state: { text: 'hello' } };
  assert.equal(isAutoSnapshot(row), true);
  assert.equal(snapshotText(row), 'hello');
  assert.equal(isAutoSnapshot({ name: 'manual' }), false);
});

test('automatic snapshot config defaults and store deletion', () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.autoSnapshot, true);
  assert.equal(defaults.autoSnapshotEvery, 5);
  assert.equal(defaults.autoSnapshotMax, 10);
  assert.equal(normalizeConfig({ autoSnapshot: false }).autoSnapshot, false);
  assert.equal(normalizeConfig({ autoSnapshotMax: 25 }).autoSnapshotMax, 25);
  assert.equal(Config['~standard'].validate({ autoSnapshot: 'yes' }).issues.length, 1);
  assert.equal(Config['~standard'].validate({ autoSnapshotMax: 0 }).issues.length, 1);

  const root = tempRoot();
  const store = new MemoryStore(root, {});
  try {
    const info = store.snapshot({
      name: `${AUTO_SNAPSHOT_PREFIX}t5`,
      state: { kind: 'auto-snapshot', text: '面板范围是两级目录' },
      metadata: { kind: 'auto-snapshot' },
    });
    assert.equal(store.listSnapshots().length, 1);
    assert.equal(store.removeSnapshot(info.snapshot_id), true);
    assert.equal(store.listSnapshots().length, 0);
    assert.equal(store.removeSnapshot('missing'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automatic snapshots fire every N turns and hold the cap', () => {
  const root = tempRoot();
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const memoryRoot = path.join(root, 'memory');
  const registryDir = path.join(root, 'registry');
  try {
    const events = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      events.push({ type: 'turn/start', data: { turn } });
      events.push({ type: 'user/message', data: { content: [{ type: 'text', text: `第 ${turn} 轮的问题` }] } });
      events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `第 ${turn} 轮的回答` }] } } });
      events.push({ type: 'turn/end', data: { turn } });
    }
    const session = {
      id: 'session-snapshot',
      header: { cwd: workspace },
      ownEvents: () => events,
    };
    const handlers = new Map();
    const agent = { whenIdle: async () => {} };
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: (service) => {
        if (service === 'agents') return { get: () => agent };
        return undefined;
      },
    };
    const config = normalizeConfig({
      root: memoryRoot,
      autoEnabled: false,
      autoSnapshot: true,
      autoSnapshotEvery: 2,
      autoSnapshotMax: 1,
    });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir, getService: ctx.get }, runtime);
    const onSessionEvent = handlers.get('session/event');
    const store = new MemoryScopes(memoryRoot)
      .sessionStoreFor('session-snapshot', {}).store;

    onSessionEvent(session, { type: 'turn/end', data: { turn: 1 } });
    assert.equal(store.listSnapshots().length, 0);
    onSessionEvent(session, { type: 'turn/end', data: { turn: 2 } });
    assert.equal(store.listSnapshots().length, 1);
    assert.match(store.listSnapshots()[0].name, /^auto-snapshot-t/);

    // Another interval creates a snapshot, but the cap keeps exactly one.
    onSessionEvent(session, { type: 'turn/end', data: { turn: 3 } });
    onSessionEvent(session, { type: 'turn/end', data: { turn: 4 } });
    assert.equal(store.listSnapshots().length, 1);
    const saved = store.loadSnapshot(store.listSnapshots()[0].snapshot_id);
    assert.equal(saved.state.kind, 'auto-snapshot');
    assert.match(saved.state.text, /第 1 轮/);

    // Disabled snapshotting leaves the layer untouched.
    const quietRuntime = { counters: new Map(), pending: new Map(), activity: new Map() };
    const quietHandlers = new Map();
    const quietCtx = {
      effect: (fn) => fn(),
      on: (event, handler) => { quietHandlers.set(event, handler); return () => {}; },
      get: (service) => (service === 'agents' ? { get: () => agent } : undefined),
    };
    const quiet = normalizeConfig({ root: path.join(root, 'quiet'), autoSnapshot: false, autoSnapshotEvery: 1 });
    installContextManagement(quietCtx, quiet, { registryDir, getService: quietCtx.get }, quietRuntime);
    quietHandlers.get('session/event')(session, { type: 'turn/end', data: { turn: 1 } });
    assert.equal(new MemoryScopes(path.join(root, 'quiet'))
      .sessionStoreFor('session-snapshot', {}).store.listSnapshots().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RAG build dedupes near-identical documents by embedding', async () => {
  const root = tempRoot();
  const docs = [
    { doc_id: 'k_new', text: '面板范围是两级目录（新）', category: 'ui_facts', source: 'agent', updated_at: '2026-01-03' },
    { doc_id: 'k_old', text: '面板范围是两级目录（旧）', category: 'ui_facts', source: 'agent', updated_at: '2026-01-02' },
    { doc_id: 'k_other_cat', text: '面板范围是两级目录（跨分类）', category: 'project_facts', source: 'user', updated_at: '2026-01-01' },
    { doc_id: 'k_distinct', text: '数据库迁移前必须备份', category: 'ui_facts', source: 'user', updated_at: '2026-01-01' },
  ];
  const store = { root, documents: () => docs };
  const fake = async (url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map((text) => ({
        embedding: String(text).includes('面板') ? [1, 0, 0] : [0, 1, 0],
      })),
    }), { status: 200 });
  };
  try {
    const built = await buildRagIndex(store, localExternal(), { fetchImpl: fake });
    assert.equal(built.ok, true);
    // k_old is a near-duplicate of k_new in the same category; the cross-category
    // document and the distinct fact stay indexed.
    assert.equal(built.indexed, 3);
    assert.equal(built.deduped, 1);
    assert.equal(built.duplicates[0].doc_id, 'k_old');
    assert.equal(built.duplicates[0].duplicate_of, 'k_new');
    assert.ok(built.duplicates[0].similarity >= 0.95);
    const index = readRagIndex(root);
    assert.equal(index.docs.k_old, undefined);
    assert.ok(index.docs.k_new);
    assert.ok(index.docs.k_other_cat);
    assert.ok(index.docs.k_distinct);
    assert.equal(ragStats(root).docs, 3);
    assert.equal(ragStats(root).deduped, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('panel API rejects DNS-rebinding hosts and cross-site origins', () => {
  const socket = { remoteAddress: '127.0.0.1', localPort: 56296 };
  const request = (headers, extra = {}) => ({
    socket: { ...socket, ...(extra.socket ?? {}) },
    headers,
  });

  // Same loopback origin in its usual spellings.
  assert.equal(isTrustedRequest(request({ host: '127.0.0.1:56296' })), true);
  assert.equal(isTrustedRequest(request({ host: 'localhost:56296' })), true);
  assert.equal(isTrustedRequest(request({ host: '[::1]:56296' })), true);
  assert.equal(isTrustedRequest(request({
    host: '127.0.0.1:56296', origin: 'http://127.0.0.1:56296',
  })), true);

  // A rebound domain still carries its own Host; the old host===origin check
  // accepted it, the Host allowlist must not.
  assert.equal(isTrustedRequest(request({
    host: 'evil.example:56296', origin: 'http://evil.example:56296',
  })), false);
  assert.equal(isTrustedRequest(request({
    host: '127.0.0.1:56296', origin: 'http://evil.example',
  })), false);
  assert.equal(isTrustedRequest(request({
    host: '127.0.0.1:56296', origin: 'null',
  })), false);
  assert.equal(isTrustedRequest(request({
    host: '127.0.0.1:56296', 'sec-fetch-site': 'cross-site',
  })), false);
  assert.equal(isTrustedRequest(request({ host: '127.0.0.1:9999' })), false);
  assert.equal(isTrustedRequest({
    socket: { remoteAddress: '10.0.0.5', localPort: 56296 },
    headers: { host: '127.0.0.1:56296' },
  }), false);

  // The desktop custom scheme is not reachable from a web page.
  assert.equal(isTrustedRequest(request({ host: 'dsh-app', origin: 'dsh-app://dsh' })), true);
});

// ---- DSH session log health and repair ----------------------------------

const zstdAvailable = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';

/** Write one synthetic DSH artifact under a fake workspace bucket. */
function writeSyntheticSessionLog(dir, events, headerExtra = {}) {
  const header = {
    type: 'session',
    version: 4,
    id: 'session-synthetic',
    createdAt: 1795173530790,
    cwd: 'C:\\work',
    isSeeded: false,
    delegationDepth: 0,
    ...headerExtra,
  };
  const lines = [`${JSON.stringify(header)}\n`].concat(events.map((event) => `${JSON.stringify(event)}\n`));
  const chunks = [lines[0]];
  for (let index = 1; index < lines.length; index += 2) chunks.push(lines.slice(index, index + 2).join(''));
  const sessionDir = path.join(dir, '--C-work--', 'session-synthetic');
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, encodeZstdLog(chunks));
  return { file, sessionDir };
}

/** A balanced turn whose only defect is a `developer/message` outside an open step. */
function eventsWithMisplacedNotice(sourceKind = 'ai-for-memory') {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    {
      type: 'user/message', seq: 2, time: 1, surfaceOp: 'append',
      data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
    },
    {
      type: 'assistant/message', seq: 3, time: 1, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: { id: 'a1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'ok' }] },
      },
    },
    { type: 'step/end', seq: 4, time: 1, data: { turn: 1, step: 1 } },
    {
      type: 'developer/message', seq: 5, time: 1, surfaceOp: 'append',
      data: {
        turn: 1, step: 2,
        message: {
          id: 'd1', role: 'developer', source: { kind: sourceKind },
          content: [{ type: 'text', text: 'notice' }],
        },
      },
    },
    { type: 'step/start', seq: 6, time: 1, data: { turn: 1, step: 2 } },
    { type: 'step/end', seq: 7, time: 1, data: { turn: 1, step: 2 } },
    { type: 'turn/end', seq: 8, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

test('session repair: the lifecycle replay finds a developer note outside an open step', () => {
  const events = eventsWithMisplacedNotice();
  const result = validateSessionEvents({ version: 4, isSeeded: false }, events);
  assert.equal(result.ok, false);
  assert.equal(result.index, 5);
  assert.match(result.error, /developer\/message/);

  // Moving the same event inside the step that follows makes the log valid.
  const moved = events.slice();
  moved.splice(6, 0, moved.splice(5, 1)[0]);
  moved.forEach((event, index) => { event.seq = index; });
  moved[6] = { ...moved[6], data: { ...moved[6].data, step: 2 } };
  assert.equal(validateSessionEvents({ version: 4, isSeeded: false }, moved).ok, true);
});

test('session repair: an ai-for-memory developer note is salvaged as a user notice', async (t) => {
  if (!zstdAvailable) { t.skip('node:zlib zstd is unavailable on this Node'); return; }
  const root = tempRoot();
  try {
    const { file } = writeSyntheticSessionLog(root, eventsWithMisplacedNotice());

    const scan = await scanSessionLogs(root, { deep: true });
    assert.equal(scan.logs.length, 1);
    assert.equal(scan.logs[0].status, 'corrupt');
    assert.equal(typeof scan.validator.note, 'string');
    assert.ok(['dsh', 'local'].includes(scan.logs[0].validator));
    assert.match(formatScanReport(scan), /结构损坏/);
    // A second unchanged scan is served from the mtime+size cache.
    const cached = await scanSessionLogs(root, { deep: true });
    assert.equal(cached.logs[0].status, 'corrupt');

    const dry = await repairSessionLog(file, { apply: false });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.strategy, 'salvage');
    assert.equal(dry.badIndex, 5);
    assert.equal(dry.dropped, 0);
    assert.equal(dry.repaired, false);

    const applied = await repairSessionLog(file, { apply: true });
    assert.equal(applied.repaired, true);
    assert.equal(applied.strategy, 'salvage');
    assert.equal(applied.after.events, 9);
    assert.ok(applied.backupPath !== '');
    assert.ok(fs.existsSync(applied.backupPath));
    assert.match(formatRepairReport(applied), /保留全部 9 个事件/);

    const after = await repairSessionLog(file, { apply: false });
    assert.equal(after.valid, true);
    assert.equal(after.repaired, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session repair: an unrecognized orphan event is truncated and closed', async (t) => {
  if (!zstdAvailable) { t.skip('node:zlib zstd is unavailable on this Node'); return; }
  const root = tempRoot();
  try {
    const { file } = writeSyntheticSessionLog(root, eventsWithMisplacedNotice('harness'));
    const applied = await repairSessionLog(file, { apply: true });
    assert.equal(applied.repaired, true);
    assert.equal(applied.strategy, 'truncate');
    assert.equal(applied.after.events, 6);
    assert.equal(applied.dropped, 3);
    const log = fs.readFileSync(file);
    assert.ok(log.length > 0);
    const verified = await repairSessionLog(file, { apply: false });
    assert.equal(verified.valid, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session repair: sourceEventSeqs storage ranges round-trip', () => {
  assert.deepEqual(encodeSeqRanges([1, 2, 3, 7]), [[1, 3], 7]);
  assert.deepEqual(encodeSeqRanges([5]), [5]);
  assert.deepEqual(decodeSeqRanges([[1, 3], 7]), [1, 2, 3, 7]);
  assert.deepEqual(decodeSeqRanges([]), []);
});

test('session repair: find/resolve a synthetic artifact by id, prefix and path', async (t) => {
  if (!zstdAvailable) { t.skip('node:zlib zstd is unavailable on this Node'); return; }
  const root = tempRoot();
  try {
    const { file } = writeSyntheticSessionLog(root, eventsWithMisplacedNotice());
    const logs = findSessionLogs(root);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].id, 'session-synthetic');
    assert.equal(resolveSessionLogTarget(root, 'session-synthetic').file, file);
    assert.equal(resolveSessionLogTarget(root, 'synthetic').file, file);
    assert.equal(resolveSessionLogTarget(root, file).file, file);
    assert.throws(() => resolveSessionLogTarget(root, 'missing'), /没有找到会话/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session repair: compact re-frames a valid log without changing events', async (t) => {
  if (!zstdAvailable) { t.skip('node:zlib zstd is unavailable on this Node'); return; }
  const root = tempRoot();
  try {
    // 40 balanced turns written as one frame per event: the physical artifact is
    // deliberately wasteful, exactly like a long DSH conversation.
    const events = [];
    let seq = 0;
    for (let turn = 1; turn <= 40; turn += 1) {
      events.push({ type: 'turn/start', seq: seq++, time: turn, data: { turn } });
      events.push({ type: 'step/start', seq: seq++, time: turn, data: { turn, step: 1 } });
      events.push({
        type: 'user/message', seq: seq++, time: turn, surfaceOp: 'append',
        data: {
          id: `u${turn}`, role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: `request ${turn} `.repeat(20) }],
        },
      });
      events.push({ type: 'step/end', seq: seq++, time: turn, data: { turn, step: 1 } });
      events.push({ type: 'turn/end', seq: seq++, time: turn, data: { turn, reason: { kind: 'completed' } } });
    }
    const header = {
      type: 'session', version: 4, id: 'session-synthetic', createdAt: 1,
      cwd: 'C:\\work', isSeeded: false, delegationDepth: 0,
    };
    const lines = [`${JSON.stringify(header)}\n`].concat(events.map((event) => `${JSON.stringify(event)}\n`));
    const sessionDir = path.join(root, '--C-work--', 'session-synthetic');
    fs.mkdirSync(sessionDir, { recursive: true });
    const file = path.join(sessionDir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, encodeZstdLog(lines));
    const originalBytes = fs.statSync(file).size;

    const valid = await repairSessionLog(file, { apply: false });
    assert.equal(valid.valid, true);

    const dry = await repairSessionLog(file, { compact: true, apply: false });
    assert.equal(dry.repaired, false);
    assert.equal(dry.strategy, 'compact');
    assert.ok(dry.after.physicalBytes < originalBytes);

    const applied = await repairSessionLog(file, { compact: true, apply: true });
    assert.equal(applied.repaired, true);
    assert.equal(applied.strategy, 'compact');
    assert.equal(applied.after.events, events.length);
    assert.ok(fs.statSync(file).size < originalBytes);
    assert.ok(fs.existsSync(applied.backupPath));

    const recheck = await repairSessionLog(file, { apply: false });
    assert.equal(recheck.valid, true);
    assert.equal(recheck.before.events, events.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pressure reset clears a fragmented window in one contiguous replacement', async () => {
  const root = tempRoot();
  try {
    const events = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      events.push(
        { type: 'turn/start', data: { turn } },
        { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `第 ${turn} 轮的问题` }] } },
        { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: `第 ${turn} 轮的回答` }] } } },
        { type: 'turn/end', data: { turn } },
      );
    }
    const { session, log, nodes } = fakeSession(events);
    // An earlier partial clear left turn 2 non-contiguous: its user node is
    // gone from the surface. Per-turn ranges can never clear it again, which is
    // exactly how a "hard reset" used to degrade into clearing one turn.
    const lost = nodes.find((seq) => log[seq].data?.content?.[0]?.text === '第 2 轮的问题');
    nodes.splice(nodes.indexOf(lost), 1);

    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: (service) => {
        if (service === 'agents') {
          return { get: () => ({ whenIdle: async () => {}, runMaintenance: async (task) => task() }) };
        }
        if (service === 'tokenMeter') {
          return { contextPressure: () => ({ pressureTokens: 90000, contextWindow: 100000 }) };
        }
        return undefined;
      },
    };
    const config = normalizeConfig({
      root: path.join(root, 'memory'),
      autoEnabled: true,
      autoEveryRounds: 100,
      contextUsagePercent: 50,
      keepRecentTurns: 1,
    });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);

    const before = nodes.length;
    handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 5 } });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const replacements = log.filter((event) => event.type === 'user/message'
      && event.data?.source?.kind === 'ai-for-memory'
      && event.surfaceOp && event.surfaceOp.op === 'replace');
    assert.equal(replacements.length, 1, 'a hard reset must be one replacement');
    const run = replacements[0];
    assert.equal(log[run.surfaceOp.startSeq].data.content[0].text, '第 1 轮的问题');
    // The newest completed turn survives verbatim; every older node, including
    // the fragmented turn, is gone from the model-visible surface.
    assert.equal(nodes.length, 3);
    const keptText = nodes.map((seq) => log[seq])
      .flatMap((event) => event.data?.content ?? event.data?.message?.content ?? [])
      .map((block) => block.text ?? '')
      .join('\n');
    assert.match(keptText, /第 5 轮的问题/);
    assert.match(keptText, /第 5 轮的回答/);
    assert.doesNotMatch(keptText, /第 1 轮的问题/);
    assert.doesNotMatch(keptText, /第 2 轮的回答/);
    assert.ok(nodes.length < before);

    const store = new MemoryScopes(path.join(root, 'memory')).sessionStoreFor('session-clear', {}).store;
    const status = store.readCompactionStatus();
    assert.equal(status.state, 'reset');
    assert.equal(status.turns, 4);
    assert.equal(status.kept, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('request anchor never fires on later steps of a turn', async () => {
  const root = tempRoot();
  try {
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: () => undefined,
    };
    const config = normalizeConfig({ root: path.join(root, 'memory'), requestAnchor: true });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);
    const appended = [];
    const session = {
      id: 'session-anchor-step',
      header: {},
      ownEvents: () => [
        { type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: '真实请求：加网络层' }] } },
        { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] } },
      ],
      surface: { nodes: [1, 2] },
      append: (type, data, options) => { appended.push({ type, data, options }); },
    };
    const preStep = handlers.get('agent/pre-step');
    // Step 2 carries tool results, so it has no user text; the anchor must not
    // treat that as "a checkpoint arrived".
    await preStep({ agent: { session }, step: 2, turn: 1, signal: new AbortController().signal }, () => {});
    assert.equal(appended.length, 0);
    // The first step is where a checkpoint can legitimately need the anchor.
    await preStep({ agent: { session }, step: 1, turn: 1, signal: new AbortController().signal }, () => {});
    assert.equal(appended.length, 1);
    assert.match(appended[0].data.content[0].text, /真实请求：加网络层/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('request anchor never restates a request that already left the surface', async () => {
  const root = tempRoot();
  try {
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: () => undefined,
    };
    const config = normalizeConfig({ root: path.join(root, 'memory'), requestAnchor: true });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);
    const appended = [];
    const session = {
      id: 'session-anchor-cleared',
      header: {},
      ownEvents: () => [
        { type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: '早就被清出的旧请求' }] } },
        { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 9' }] } },
      ],
      // Seq 1 was cleared: the surface only holds the checkpoint.
      surface: { nodes: [2] },
      append: (type, data, options) => { appended.push({ type, data, options }); },
    };
    await handlers.get('agent/pre-step')(
      { agent: { session }, step: 1, turn: 9, signal: new AbortController().signal },
      () => {},
    );
    assert.equal(appended.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a long running turn is cleared mid-task and continues from a resume brief', async () => {
  const root = tempRoot();
  try {
    const events = [
      { type: 'system/message', data: { turn: 0, step: 0, message: { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] } } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '当前任务：把存储层迁移到新 schema' }] } },
    ];
    // One long task turn: six steps, each with an assistant message that owns a
    // tool call and the tool result that answers it. That is the real shape of
    // a DSH task, and a turn-granular clear could never shrink it.
    for (let step = 1; step <= 6; step += 1) {
      events.push(
        {
          type: 'assistant/message',
          data: {
            turn: 1,
            step,
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: `步骤 ${step} 的进展` },
                { type: 'tool-call', id: `call-${step}`, name: 'read', arguments: '{}' },
              ],
            },
          },
        },
        {
          type: 'tool/result',
          data: {
            turn: 1,
            step,
            message: { role: 'tool', toolCallId: `call-${step}`, content: [{ type: 'text', text: `步骤 ${step} 的工具输出 STEP_${step}` }] },
          },
        },
      );
    }
    const { session, log, nodes } = fakeSession(events);
    let pressure = { pressureTokens: 90000, contextWindow: 100000 };
    const handlers = new Map();
    const ctx = {
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      get: (service) => (service === 'tokenMeter' ? { contextPressure: () => pressure } : undefined),
    };
    const config = normalizeConfig({
      root: path.join(root, 'memory'),
      autoEnabled: true,
      autoEveryRounds: 100,
      contextUsagePercent: 50,
      keepRecentTurns: 1,
    });
    const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };
    installContextManagement(ctx, config, { registryDir: path.join(root, 'registry'), getService: ctx.get }, runtime);
    const preStep = handlers.get('agent/pre-step');
    const signal = new AbortController().signal;

    await preStep({ agent: { session }, step: 7, turn: 1, messages: [], signal }, () => {});

    const replacements = log.filter((event) => event.surfaceOp?.op === 'replace');
    assert.equal(replacements.length, 1, 'a mid-task reset replaces the old steps once');
    const run = replacements[0];
    // The cut is a step boundary: it ends on the tool result of step 3, never
    // between a tool call and its result. It starts at the first assistant node,
    // so the user request and the harness reminders that came with it stay.
    assert.equal(log[run.surfaceOp.startSeq].type, 'assistant/message');
    assert.equal(log[run.surfaceOp.startSeq].data.step, 1);
    assert.equal(log[run.surfaceOp.endSeq].type, 'tool/result');
    assert.equal(log[run.surfaceOp.endSeq].data.step, 3);
    const keptText = nodes.map((seq) => log[seq])
      .flatMap((event) => event.data?.content ?? event.data?.message?.content ?? [])
      .map((block) => block.text ?? '')
      .join('\n');
    assert.match(keptText, /当前任务：把存储层迁移到新 schema/);
    assert.match(keptText, /步骤 4 的进展/);
    assert.match(keptText, /步骤 6 的工具输出 STEP_6/);
    assert.doesNotMatch(keptText, /步骤 1 的进展/);
    const brief = String(run.data.content[0].text);
    assert.match(brief, /任务续接/);
    assert.match(brief, /当前任务：把存储层迁移到新 schema/);
    assert.match(brief, /不是新的用户请求/);
    assert.match(brief, /本轮较早的 6 个步骤/);

    const store = new MemoryScopes(path.join(root, 'memory')).sessionStoreFor('session-clear', {}).store;
    assert.equal(store.readCompactionStatus().state, 'reset');
    const archived = store.loadContext(store.listContexts()[0].context_id);
    assert.ok(archived.raw_events.some((event) => event.type === 'tool/result'));

    // Nothing new has been sent, so the measured size is unchanged and the reset
    // must not fire again for the same measurement.
    await preStep({ agent: { session }, step: 8, turn: 1, messages: [], signal }, () => {});
    assert.equal(log.filter((event) => event.surfaceOp?.op === 'replace').length, 1);

    // A new request reports a new prompt size, which makes the reset eligible
    // again; with only the newest three steps left there is too little to trim,
    // so the running turn is kept whole instead of eating what was just kept.
    pressure = { pressureTokens: 70000, contextWindow: 100000 };
    const before = nodes.length;
    await preStep({ agent: { session }, step: 9, turn: 1, messages: [], signal }, () => {});
    assert.equal(nodes.length, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
