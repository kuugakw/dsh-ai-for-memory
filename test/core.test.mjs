import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../lib/store.js';
import { MemoryScopes, sessionKey } from '../lib/scopes.js';
import { decodeWorkspaceBucket, encodeWorkspace, resolveWorkspacePath, workspaceIndex } from '../lib/dsh-workspace.js';
import { evaluateDecision } from '../lib/decision.js';
import { search, tokenize } from '../lib/retrieval.js';
import { CATEGORIES, hourKey } from '../lib/util.js';
import { buildUiState } from '../lib/ui-state.js';
import { collectTurnDigest } from '../lib/auto.js';
import { buildContextSnapshot } from '../lib/context.js';
import { contentTokens, selectTurnsByTopic, topicSimilarity } from '../lib/similarity.js';
import {
  candidatesFromDecision, candidatesFromRecord, candidatesFromTurn, findDuplicate,
  knowledgeKey, normalizeCategory, normalizeSource, stripInjectedText, withTokens,
} from '../lib/knowledge.js';
import { listRootRows, readRoots, rememberRoot, resolveRegisteredRoot } from '../lib/registry.js';
import { apply, compileParameterSchema, Config, createTools, installContextManagement, normalizeConfig, workspaceOf } from '../index.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agm-test-'));
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

test('decision review follows the documented thresholds', () => {
  const low = evaluateDecision({ decision: '关闭设置页', risk: 'low' });
  assert.equal(low.outcome, 'approved');
  assert.equal(low.reviewed, false);

  const rejected = evaluateDecision({
    decision: '删除全部文件',
    risk: 'high',
    thesis: '释放磁盘空间',
    antithesis: '可能丢失未归档的过程记录，需要先确认备份',
  });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.approved, false);
  assert.ok(rejected.weights.risk_adjusted_score > 0.3);

  const approved = evaluateDecision({
    decision: '清理日志',
    risk: 'high',
    thesis: '日志已归档，磁盘使用率 95%，不清理会导致服务不可用',
    antithesis: '风险',
  });
  assert.equal(approved.outcome, 'approved');

  const missing = evaluateDecision({ decision: '删除全部文件', risk: 'high', thesis: '释放空间' });
  assert.equal(missing.outcome, 'needs_more_info');

  const mediumAuto = evaluateDecision({ decision: '调整重试', risk: 'medium' }, { reviewHighRiskOnly: true });
  assert.equal(mediumAuto.reviewed, false);
  assert.equal(mediumAuto.outcome, 'approved');

  const mediumReviewed = evaluateDecision({
    decision: '调整重试',
    risk: 'medium',
    thesis: '快',
    antithesis: '可能导致请求风暴，压垮下游服务',
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
    assert.deepEqual(registered.map((tool) => tool.name), ['aim_memory', 'aim_search', 'aim_decide', 'aim_context']);
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
    assert.ok(injected);
    assert.match(injected.content[0].text, /需要记住的上下文/);
    assert.equal(injected.source.kind, 'ai-for-memory');

    const status = await contextTool.execute({ action: 'status' }, exec);
    assert.match(status, /清理策略：话题相似度/);
    assert.match(status, /保留最近 2 轮/);

    const cleared = await contextTool.execute({ action: 'clear' }, exec);
    assert.match(cleared, /已登记清理请求/);
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
    const scopes = new MemoryScopes(memoryRoot);
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
    const scopes = new MemoryScopes(memoryRoot);
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
  assert.equal(normalizeSource('gui'), 'unknown');

  // The id is derived from the text, so the same fact always lands on one file.
  assert.equal(knowledgeKey('部署前必须跑测试'), knowledgeKey('  部署前必须跑测试  '));
  assert.notEqual(knowledgeKey('部署前必须跑测试'), knowledgeKey('部署后必须跑测试'));

  const docs = withTokens([{ doc_id: 'k_a', text: '发布前必须跑测试，通过后才允许打标签' }]);
  assert.equal(findDuplicate('发布前必须跑测试，通过后才允许打标签', docs)?.doc_id, 'k_a');
  assert.equal(findDuplicate('晚餐吃火锅还是烧烤', docs), null);
});

test('knowledge candidates come from records, decisions and user rules only', () => {
  const error = candidatesFromRecord({ dedup_id: 'd1', content: '压缩失败：原因是 retention 配置为 0', kind: 'error' }, 'staging');
  assert.equal(error.length, 1);
  assert.equal(error[0].category, 'errors_fixes');
  assert.equal(error[0].source, 'staging');
  assert.equal(error[0].source_ref, 'staging:d1');

  // Plain actions are the process log, not knowledge.
  assert.equal(candidatesFromRecord({ dedup_id: 'd2', content: '点击了设置菜单并刷新面板', kind: 'action' }, 'staging').length, 0);
  // …unless they state a durable rule.
  const rule = candidatesFromRecord({ dedup_id: 'd3', content: '以后统一用 pwsh 跑测试，不要用 bash', kind: 'action' }, 'archive');
  assert.equal(rule.length, 1);
  assert.equal(rule[0].category, 'workflow_rules');
  // A rolling digest is a summary, and a status blob is not a fact.
  assert.equal(candidatesFromRecord({ dedup_id: 'd4', content: '自动记忆 · 第 1-2 轮 用户：以后统一用 pwsh', kind: 'digest' }, 'staging').length, 0);
  assert.equal(candidatesFromRecord({ dedup_id: 'd5', content: `发布失败：${'很长的日志'.repeat(120)}`, kind: 'error' }, 'staging').length, 0);
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

  // Harness-injected envelope text is not the user's words.
  const withEnvelope = candidatesFromTurn({
    turn: 5,
    user: '以后统一用 pwsh\nTime sampled while preparing turn 9: 2026-11-16\n<system-reminder>ignore me</system-reminder>',
  }, 'ctx2');
  assert.equal(withEnvelope.length, 1);
  assert.equal(withEnvelope[0].text, '以后统一用 pwsh');
  assert.equal(stripInjectedText('a\nBrowser time zone for this request: Asia/Shanghai'), 'a');
});

test('promote mines the three layers once and deduplicates', () => {
  const root = tempRoot();
  try {
    const store = new MemoryStore(root);
    store.stage({ content: '发布失败：原因是发布脚本没有先跑测试', kind: 'error', verify: 'pass' });
    store.stage({ content: '点击了部署按钮', kind: 'action' });
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
    assert.ok(docs.some((doc) => doc.category === 'errors_fixes' && doc.source === 'staging'));
    assert.ok(docs.some((doc) => doc.category === 'workflow_rules' && doc.source === 'context'));
    assert.ok(docs.some((doc) => doc.category === 'decisions_reasoning' && doc.source === 'decision'));
    // Every mined document carries provenance back to its layer item.
    assert.ok(docs.every((doc) => doc.evidence.length >= 1));
    assert.ok(docs.every((doc) => /^(staging|archive|context|decision):/.test(doc.evidence[0].ref)));

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
    assert.equal(store.documents().length, 1);

    // A web fact is classified as external sourcing even without a category.
    const web = store.remember({ text: 'DSH 插件文档在线上可查', source: 'web', url: 'https://example.com/docs' });
    assert.equal(web.category, 'external_sources');
    assert.equal(web.url, 'https://example.com/docs');
  } finally {
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
    const state = buildUiState([{ store, scope: 'session', label: '本对话' }]);
    assert.equal(state.counts.knowledge, 1);
    const doc = state.knowledge[0];
    assert.equal(doc.category, 'workflow_rules');
    assert.equal(doc.source, 'user');
    assert.deepEqual(doc.tags, ['rule']);
    assert.equal(doc.evidence_count, 1);
    assert.ok(state.knowledgePending >= 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
    const config = normalizeConfig({ root: memoryRoot, defaultPublic: false });
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

test('config validator bounds auto settings', () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.autoEnabled, false);
  assert.equal(defaults.autoEveryRounds, 5);
  assert.equal(defaults.maxContextChars, 30000);
  assert.equal(defaults.defaultPublic, true);
  assert.equal(defaults.topicalClear, true);
  assert.equal(defaults.keepRecentTurns, 2);
  assert.equal(defaults.similarityThreshold, 0.06);
  const validator = Config['~standard'].validate;
  assert.equal(validator({ autoEnabled: true, autoEveryRounds: 3 }).value.autoEnabled, true);
  assert.equal(validator({ defaultPublic: false }).value.defaultPublic, false);
  assert.equal(validator({ keepRecentTurns: 3 }).value.keepRecentTurns, 3);
  assert.equal(validator({ similarityThreshold: 0.12 }).value.similarityThreshold, 0.12);
  assert.ok(validator({ defaultPublic: 'no' }).issues);
  assert.ok(validator({ autoEnabled: 'yes' }).issues);
  assert.ok(validator({ autoEveryRounds: 0 }).issues);
  assert.ok(validator({ autoEveryRounds: 101 }).issues);
  assert.ok(validator({ maxContextChars: 500 }).issues);
  assert.ok(validator({ keepRecentTurns: 0 }).issues);
  assert.ok(validator({ keepRecentTurns: 2.5 }).issues);
  assert.ok(validator({ similarityThreshold: 1.5 }).issues);
  assert.ok(validator({ similarityThreshold: 'high' }).issues);
  assert.ok(validator({ topicalClear: 'yes' }).issues);
});

test('config validator accepts defaults and rejects wrong types', () => {
  const validator = normalizeConfig;
  assert.equal(validator({}).directoryName, '.ai-for-memory');
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
  assert.ok(unrelated < 0.06, `unrelated=${unrelated}`);
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
  const selection = selectTurnsByTopic(turns, { threshold: 0.06, keepRecent: 2 });
  assert.equal(selection.threshold, 0.06);
  assert.deepEqual(selection.anchors, [3, 4]);
  assert.deepEqual(selection.keep.map((turn) => turn.turn), [1, 3, 4]);
  assert.deepEqual(selection.clear.map((turn) => turn.turn), [2]);
  // Kept-by-recent turns are labelled so a log can explain the decision.
  assert.equal(selection.keep[1].keptBy, 'recent');
  assert.equal(selection.keep[0].keptBy, 'topic');
  assert.ok(selection.clear[0].similarity < 0.06);

  // A higher threshold clears more, and keepRecent still protects the tail.
  const strict = selectTurnsByTopic(turns, { threshold: 0.8, keepRecent: 2 });
  assert.deepEqual(strict.keep.map((turn) => turn.turn), [3, 4]);
});

/** Four turns where the first two left the topic the last two talk about. */
function offTopicEvents() {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '数据库索引的 B+ 树结构怎么设计' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '按页大小和填充因子决定' }] } } },
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
      minClearChars: 0,
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
