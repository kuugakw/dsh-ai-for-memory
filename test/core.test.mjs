import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../lib/store.js';
import { MemoryScopes, sessionKey } from '../lib/scopes.js';
import { evaluateDecision } from '../lib/decision.js';
import { search, tokenize } from '../lib/retrieval.js';
import { CATEGORIES, hourKey } from '../lib/util.js';
import { buildUiState } from '../lib/ui-state.js';
import { collectTurnDigest } from '../lib/auto.js';
import { buildContextSnapshot } from '../lib/context.js';
import { listRootRows, readRoots, rememberRoot, resolveRegisteredRoot } from '../lib/registry.js';
import { apply, compileParameterSchema, Config, createTools, installContextManagement, normalizeConfig, workspaceOf } from '../index.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agm-test-'));
}

function fakeExec(cwd) {
  return { agent: { session: { header: { cwd } } } };
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
    assert.match(status, /compaction 服务：不可用/);
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
    assert.match(all, /来源：本对话/);
    assert.match(all, /来源：对话/);

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
    assert.match(sharedSearch, /来源：共享/);

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
  const validator = Config['~standard'].validate;
  assert.equal(validator({ autoEnabled: true, autoEveryRounds: 3 }).value.autoEnabled, true);
  assert.equal(validator({ defaultPublic: false }).value.defaultPublic, false);
  assert.ok(validator({ defaultPublic: 'no' }).issues);
  assert.ok(validator({ autoEnabled: 'yes' }).issues);
  assert.ok(validator({ autoEveryRounds: 0 }).issues);
  assert.ok(validator({ autoEveryRounds: 101 }).issues);
  assert.ok(validator({ maxContextChars: 500 }).issues);
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
