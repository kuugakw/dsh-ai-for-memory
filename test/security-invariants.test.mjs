import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installApi, isTrustedRequest } from '../lib/api.js';

const HOST = '127.0.0.1:57578';
const PORT = 57578;

/** Install the panel API against a fake web server and capture every route. */
function captureRoutes(deps) {
  const routes = new Map();
  const server = {
    register(spec) {
      routes.set(spec.path, spec.handler);
      return { dispose() {} };
    },
    reply() {},
  };
  const webCtx = {
    webServer: server,
    get(name) { return name === 'webServer' ? server : undefined; },
    // Cordis effects run their callback and keep the disposer; the test only
    // needs the registration side effect.
    effect(fn) { return fn(); },
  };
  const ctx = {
    inject(names, callback) { callback(webCtx); },
    effect(fn) { return fn; },
  };
  installApi(ctx, deps);
  return routes;
}

function request(headers = {}, method = 'GET') {
  return {
    method,
    headers: { host: HOST, ...headers },
    socket: { remoteAddress: '127.0.0.1', localPort: PORT },
    async *[Symbol.asyncIterator]() { /* no body */ },
  };
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
    end(chunk = '') { this.body += chunk; this.headersSent = true; },
    write(chunk = '') { this.body += chunk; },
  };
}

const deps = () => ({
  config: {},
  registryDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aim-api-')),
  runtime: {},
});

test('every panel route goes through the single trusted-request gate', async () => {
  const routes = captureRoutes(deps());
  assert.ok(routes.size > 10, 'expected the panel API to register its routes');
  // A request with no Fetch Metadata and no Origin is what a local script
  // sends; the route wrapper must reject it before any handler runs.
  for (const [routePath, handler] of routes) {
    const res = response();
    await handler(request({}), res);
    assert.equal(res.statusCode, 403, `${routePath} must reject an untrusted request`);
  }
});

test('the gate accepts a same-origin browser request', async () => {
  const routes = captureRoutes(deps());
  const handler = routes.get('/ai-for-memory/api/state');
  assert.ok(typeof handler === 'function');
  const res = response();
  await handler(request({ 'sec-fetch-site': 'same-origin' }), res);
  assert.notEqual(res.statusCode, 403);
});

test('isTrustedRequest rejects metadata the browser would not send', () => {
  assert.equal(isTrustedRequest(request({})), false);
  assert.equal(isTrustedRequest(request({ 'sec-fetch-site': 'none' })), false);
  assert.equal(isTrustedRequest(request({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isTrustedRequest(request({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(isTrustedRequest(request({ origin: 'http://127.0.0.1:57578' })), true);
  assert.equal(isTrustedRequest(request({ origin: 'http://evil.example' })), false);
});

test('the MCP route still requires its bearer token when one is configured', async () => {
  const d = deps();
  d.config = { mcpEnabled: true };
  d.mcpToken = 'secret-token';
  const routes = captureRoutes(d);
  const handler = routes.get('/ai-for-memory/mcp');
  assert.ok(typeof handler === 'function', 'MCP route must be registered');

  const denied = response();
  await handler(request({ 'sec-fetch-site': 'same-origin' }, 'POST'), denied);
  assert.equal(denied.statusCode, 401);

  const accepted = response();
  await handler(request({
    'sec-fetch-site': 'same-origin',
    authorization: 'Bearer secret-token',
    'content-type': 'application/json',
  }, 'POST'), accepted);
  assert.notEqual(accepted.statusCode, 401);
});

test('the MCP route is absent when the egress is disabled', async () => {
  const routes = captureRoutes(deps());
  const handler = routes.get('/ai-for-memory/mcp');
  assert.ok(typeof handler === 'function');
  const res = response();
  await handler(request({ 'sec-fetch-site': 'same-origin' }, 'POST'), res);
  assert.equal(res.statusCode, 404);
});
