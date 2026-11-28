/**
 * Route-level smoke tests for the panel API. The security suite covers the
 * guards; this file walks the action routes so a handler regression cannot hide
 * behind "the route table exists".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installApi } from '../lib/api.js';
import { MemoryStore } from '../lib/store.js';
import { MemoryScopes, sessionKey } from '../lib/scopes.js';
import { normalizeConfig } from '../lib/config.js';

const HOST = '127.0.0.1:57579';
const PORT = 57579;

function captureRoutes(deps) {
  const routes = new Map();
  const server = {
    register(spec) { routes.set(spec.path, spec.handler); return { dispose() {} }; },
    reply() {},
  };
  const webCtx = {
    webServer: server,
    get(name) { return name === 'webServer' ? server : undefined; },
    effect(fn) { return fn(); },
  };
  const ctx = {
    inject(_names, callback) { callback(webCtx); },
    effect(fn) { return fn; },
  };
  installApi(ctx, deps);
  return routes;
}

function response() {
  return {
    statusCode: null,
    headersSent: false,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(code, extra = {}) {
      this.statusCode = code;
      for (const [name, value] of Object.entries(extra)) this.headers[name.toLowerCase()] = value;
      this.headersSent = true;
    },
    end(chunk = '') {
      this.body += String(chunk);
      if (this.statusCode === null) this.statusCode = 200;
      this.headersSent = true;
    },
  };
}

function call(routes, route, { method = 'POST', body = {}, query = '' } = {}) {
  const req = {
    method,
    url: route + query,
    headers: { host: HOST, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1', localPort: PORT },
    async *[Symbol.asyncIterator]() {
      if (method !== 'GET') yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = response();
  const handler = routes.get(route);
  assert.ok(handler, `route ${route} is registered`);
  return handler(req, res).then(() => res);
}

function json(res) { return JSON.parse(res.body); }

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-routes-api-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-routes-reg-'));
  const store = new MemoryStore(root).init();
  store.remember({
    doc_id: 'k_fact',
    text: '面板路由测试事实',
    category: 'project_facts',
    source: 'user-confirmed',
    provenance: 'user',
    verified: true,
  });
  store.remember({
    doc_id: 'k_claim',
    text: '面板路由测试模型自述',
    category: 'project_facts',
    source: 'mcp',
    provenance: 'model',
    verified: false,
  });
  const left = store.snapshot({ name: 'left', state: { step: 1 } });
  const right = store.snapshot({ name: 'right', state: { step: 2 } });
  store.saveContext({ label: 'ctx', turnFrom: 1, turnTo: 2, text: '上下文存档' });
  const deps = {
    config: normalizeConfig({ root, mcpEnabled: false }),
    registryDir,
    runtime: {},
    entry: {},
    editor: null,
    runMcpTool: async (name) => `tool:${name}`,
  };
  return { root, registryDir, store, deps, routes: captureRoutes(deps), left, right };
}

test('panel action routes invoke their tools', async () => {
  const { root, routes, deps } = setup();
  try {
    for (const [route, body] of [
      ['/ai-for-memory/api/search', { root, query: 'q' }],
      ['/ai-for-memory/api/ask', { root, question: 'q' }],
      ['/ai-for-memory/api/memory/action', { root, action: 'stage', content: 'x' }],
      ['/ai-for-memory/api/context/action', { root, action: 'save' }],
      ['/ai-for-memory/api/context/restore', { root, context_id: 'c1' }],
      ['/ai-for-memory/api/snapshot/restore', { root, snapshot_id: 's1' }],
    ]) {
      const res = await call(routes, route, { body });
      assert.equal(res.statusCode, 200, `${route}: ${res.body}`);
      assert.equal(json(res).ok, true);
      assert.match(json(res).text, /^tool:/);
    }
    assert.ok(deps.runMcpTool);
    for (const [route, body, status] of [
      ['/ai-for-memory/api/memory/action', { root, action: 'nope' }, 400],
      ['/ai-for-memory/api/context/action', { root, action: 'nope' }, 400],
      ['/ai-for-memory/api/context/restore', { root }, 400],
      ['/ai-for-memory/api/snapshot/restore', { root }, 400],
    ]) {
      const res = await call(routes, route, { body });
      assert.equal(res.statusCode, status, route);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('panel knowledge and retention routes use the real store', async () => {
  const { root, routes, left, right } = setup();
  try {
    let res = await call(routes, '/ai-for-memory/api/knowledge/verify', {
      body: { root, scope: 'shared', doc_id: 'k_claim' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).verified, true);

    res = await call(routes, '/ai-for-memory/api/knowledge/verify/batch', {
      body: { root, scope: 'shared', doc_ids: ['k_fact', 'missing'] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).total, 2);

    res = await call(routes, '/ai-for-memory/api/knowledge/unverify', {
      body: { root, scope: 'shared', doc_id: 'k_claim' },
    });
    assert.equal(res.statusCode, 200, res.body);

    res = await call(routes, '/ai-for-memory/api/knowledge/forget', {
      body: { root, scope: 'shared', doc_id: 'k_claim' },
    });
    assert.equal(res.statusCode, 200, res.body);

    res = await call(routes, '/ai-for-memory/api/knowledge/pending/resolve', {
      body: { root, scope: 'shared', action: 'nope' },
    });
    assert.equal(res.statusCode, 400);

    res = await call(routes, '/ai-for-memory/api/retention/cleanup', { body: { root } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).ok, true);

    res = await call(routes, '/ai-for-memory/api/snapshot/compare', {
      body: { root, scope: 'shared', left: left.snapshot_id, right: right.snapshot_id },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).left.snapshot_id, left.snapshot_id);

    res = await call(routes, '/ai-for-memory/api/snapshot/compare', {
      body: { root, scope: 'shared', left: 'missing', right: 'missing' },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('panel conversation and validation routes answer without crashing', async () => {
  const { root, routes } = setup();
  const key = sessionKey('routes-conversation');
  try {
    const scopes = new MemoryScopes(root);
    scopes.setPublic(key, false);
    let res = await call(routes, '/ai-for-memory/api/conversations/bulk', {
      body: { root, action: 'open', keys: [key] },
    });
    assert.equal(res.statusCode, 200, res.body);
    res = await call(routes, '/ai-for-memory/api/conversations/bulk', {
      body: { root, action: 'nope', keys: [key] },
    });
    assert.equal(res.statusCode, 400);
    res = await call(routes, '/ai-for-memory/api/conversations/bulk', {
      body: { root, action: 'open', keys: [] },
    });
    assert.equal(res.statusCode, 400);

    res = await call(routes, '/ai-for-memory/api/session', {
      body: { root, session: key, label: 'renamed' },
    });
    assert.equal(res.statusCode, 200, res.body);
    res = await call(routes, '/ai-for-memory/api/session', { body: { root } });
    assert.equal(res.statusCode, 400);

    res = await call(routes, '/ai-for-memory/api/rag/index', { body: { root, scope: 'shared' } });
    assert.equal(res.statusCode, 400, res.body);

    res = await call(routes, '/ai-for-memory/api/record/download', {
      method: 'GET',
      query: `?root=${encodeURIComponent(root)}&kind=knowledge&id=missing`,
    });
    assert.equal(res.statusCode, 404, res.body);

    res = await call(routes, '/ai-for-memory/api/mcp/rotate', { body: {} });
    assert.equal(res.statusCode, 400, res.body);

    res = await call(routes, '/ai-for-memory/api/local-engine/config', { body: { modelId: 'missing' } });
    assert.equal(res.statusCode, 400, res.body);

    res = await call(routes, '/ai-for-memory/api/local-engine', { method: 'GET' });
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
