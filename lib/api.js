/**
 * HTTP API backing the Web panel.
 *
 * Routes (same-origin, loopback only):
 *   GET  /ai-for-memory/api/state     memory snapshot for one registered root
 *   POST /ai-for-memory/api/reveal    open a registered root in the OS file manager
 *   POST /ai-for-memory/api/knowledge/verify  confirm one model-authored knowledge doc
 *   POST /ai-for-memory/api/config    persist a fixed memory directory via configEditor
 *
 * The API never reads arbitrary paths: a root must come from the registry or
 * from the plugin's own configured `root`. A conversation must be one the
 * plugin itself recorded under `<root>/sessions` (or the id the Host is
 * currently using), so the state route is not a generic Session reader either.
 */

import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MemoryScopes, isSessionKey, sessionKey, shortSessionId } from './scopes.js';
import { isSessionActive, recentSessionId } from './activity.js';
import { buildUiState } from './ui-state.js';
import { listRootRows, resolveRegisteredRoot, samePath } from './registry.js';
import { defaultMemoryDirIgnoreStatus } from './gitignore.js';
import { externalConfigFrom, normalizeExternal, probe as probeExternal } from './external.js';
import { buildRagIndex, embeddingIdentity, ragModelStatus, ragStats, sameEmbeddingSpace } from './rag.js';
import { exportArtifact } from './export.js';
import {
  commitSync, initSync, probeHost, pullSync, pushSync, readSyncConfig, syncStatus, writeSyncConfig,
} from './git-sync.js';
import { listLocalModelsCached, resetLocalModelsCache } from './model-catalog.js';
import {
  autoStartSkips, localEngineStatus, missingLocalEngineKinds, startLocalEngine, stopLocalEngine, updateModelConfig,
  waitForLocalAdoption,
} from './local-engine.js';
import { MCP_PATH, handleMcpMessage } from './mcp.js';
import { dshSessionsDir } from './dsh-workspace.js';
import {
  formatRepairReport, repairSessionLog, resolveSessionLogTarget, scanSessionLogs, zstdAvailable,
} from './session-repair.js';
import { formatContextMarkdown } from './context.js';
import { sqliteAvailable } from './knowledge-sqlite.js';
import { appendAudit, readAudit } from './audit.js';
import { formatPressure, usagePercentOf } from './pressure.js';
import { effectivePluginConfig, localModelRouting } from './model-routing.js';
import { safeStem } from './util.js';

const PREFIX = '/ai-for-memory/api';
const MAX_BODY_BYTES = 64 * 1024;

const ZERO_COUNTS = Object.freeze({
  staging: 0, archive: 0, snapshots: 0, knowledge: 0, decisions: 0, contexts: 0,
});

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

/** Bytes below one directory, ignoring unreadable entries. */
function directoryBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // A file can disappear while the panel is open; ignore it.
        }
      }
    }
  }
  return total;
}

function storageSummary(root) {
  const layers = ['staging', 'archive', 'snapshots', 'knowledge', 'decisions', 'contexts', 'backups'];
  const bytes = {};
  for (const layer of layers) bytes[layer] = directoryBytes(path.join(root, layer));
  return {
    totalBytes: directoryBytes(root),
    bytes,
  };
}

/** Locate a binary on PATH without spawning a shell. */
function findExecutable(command) {
  const name = String(command ?? '').trim();
  if (name === '') return null;
  const candidates = [];
  if (path.isAbsolute(name) || /[\\/]/.test(name)) {
    candidates.push(name);
  } else {
    const pathValue = process.env.PATH ?? '';
    for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(dir, name));
      if (process.platform === 'win32') {
        const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
        for (const ext of exts) candidates.push(path.join(dir, `${name}${ext.toLowerCase()}`));
        for (const ext of exts) candidates.push(path.join(dir, `${name}${ext}`));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/** Knowledge usage/weight rows, dead entries first. */
function usageRows(scopes, limit = 300) {
  const entries = [
    { scope: 'shared', session: '', label: 'shared', store: scopes.sharedStore() },
    ...scopes.listSessions().map((row) => ({
      scope: 'session',
      session: row.sessionId || row.key,
      label: row.label || row.sessionId || row.key,
      store: scopes.sessionStore(row.key),
    })),
  ];
  const rows = [];
  for (const entry of entries) {
    const store = entry.store;
    const docs = store.documents();
    if (docs.length === 0) continue;
    const usage = store.knowledgeUsage();
    const weights = store.knowledgeWeights();
    for (const doc of docs) {
      const hit = usage[doc.doc_id] ?? null;
      rows.push({
        doc_id: doc.doc_id,
        text: String(doc.text ?? '').slice(0, 240),
        category: doc.category ?? '',
        scope: entry.scope,
        session: entry.session,
        label: entry.label,
        count: Number.isInteger(hit?.count) ? hit.count : 0,
        at: hit?.at ?? '',
        weight: weights[doc.doc_id] ?? 0,
        verified: doc.verified === true,
      });
    }
  }
  return rows
    .sort((left, right) => left.weight - right.weight || left.count - right.count)
    .slice(0, limit);
}

/** Conversation rows with public state, counts and on-disk bytes. */
function conversationRows(scopes) {
  return scopes.listSessions().map((row) => ({
    key: row.key,
    session_id: row.sessionId ?? '',
    label: row.label ?? '',
    workspace: row.workspace ?? '',
    public: row.public === true,
    viewers: Array.isArray(row.viewers) ? [...row.viewers] : [],
    updatedAt: row.updatedAt ?? '',
    counts: scopes.counts(row.key),
    bytes: directoryBytes(scopes.sessionDir(row.key)),
  })).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

/**
 * Whether one panel row is readable by the current conversation.
 *
 * Mirrors the tool-side rule: self, `public`, or a named `viewers` grant. The
 * API cannot import `scopeVisibleTo` from the plugin entry without a cycle, so
 * the same three clauses live here too.
 */
function rowVisibleTo(row, currentKey, currentSessionId) {
  if (row === null || typeof row !== 'object') return false;
  if (row.current === true || row.key === currentKey) return true;
  if (row.public === true) return true;
  const viewers = Array.isArray(row.viewers) ? row.viewers : [];
  if (viewers.length === 0) return false;
  return viewers.includes(currentKey) || (currentSessionId !== '' && viewers.includes(currentSessionId));
}

/** Resolve one record's JSON file inside a layer directory, or null. */
function recordPath(dir, id, fallback) {
  const root = path.resolve(dir);
  // The id may come from a stored document: keep the same safe-stem rule the
  // writer used, then verify the resolved file really stays under this layer.
  const file = path.resolve(root, `${safeStem(id, fallback)}.json`);
  const relative = path.relative(root, file);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) return null;
  return file;
}

/** Resolve one record's JSON file inside a store, refusing anything outside it. */
function recordFile(store, kind, id) {
  const value = String(id ?? '').trim();
  if (value === '') return null;
  if (kind === 'knowledge') {
    const doc = store.documents().find((row) => row.doc_id === value);
    if (!doc) return null;
    // remember() writes the file through safeStem(doc_id); joining the raw
    // doc_id here let '../../secret' read a JSON file outside knowledge/.
    const file = recordPath(store.knowledgeDir, doc.doc_id, 'doc');
    return file && fs.existsSync(file) ? file : null;
  }
  if (kind === 'context') {
    const record = store.loadContext(value);
    if (!record) return null;
    const file = recordPath(store.contextDir, record.context_id, 'context');
    return file && fs.existsSync(file) ? file : null;
  }
  if (kind === 'snapshot') {
    const record = store.loadSnapshot(value);
    if (!record) return null;
    const file = recordPath(store.snapshotDir, record.snapshot_id, 'snapshot');
    return file && fs.existsSync(file) ? file : null;
  }
  return null;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * The panel is loopback-only. Accept only a Host that is literally a loopback
 * name, and reject a port that does not match the socket the request arrived
 * on. This is the DNS-rebinding guard: a page on `evil.example` resolving to
 * 127.0.0.1 still sends `Host: evil.example`, so binding alone is not enough.
 */
function trustedHost(host, localPort) {
  if (host === 'dsh-app') return true;
  if (typeof host !== 'string' || host === '') return false;
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return false;
  if (parsed.port !== '' && localPort !== undefined && parsed.port !== String(localPort)) return false;
  return true;
}

function originTrusted(origin, host, localPort) {
  try {
    const url = new URL(origin);
    // The desktop shell's custom scheme is not reachable from a web page.
    if (url.protocol === 'dsh-app:') return host === 'dsh-app' || trustedHost(host, localPort);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return trustedHost(host, localPort) && url.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Every panel route requires a loopback peer, a trusted Host, and browser fetch
 * metadata: a same-origin `Origin`, or `Sec-Fetch-Site: same-origin`. `none`
 * is not accepted: a local script can send it just as easily as a browser, so
 * accepting it would only pretend to authenticate the caller.
 *
 * Browsers send both without any help; a local script (`curl`, an npm
 * postinstall hook, a VS Code extension) sends neither, so it is rejected
 * instead of being silently allowed. This is CSRF/naive-script hardening, not
 * authentication — a process running as the same user can forge the headers or
 * simply read the memory files, so the real boundary is the OS account.
 *
 * `allowNonBrowser` is for the MCP route: MCP clients are not browsers (no
 * Origin, no Fetch Metadata) and that route carries its own bearer token.
 *
 * @param {object} request
 * @param {{allowNonBrowser?: boolean}} [options]
 */
export function isTrustedRequest(request, options = {}) {
  if (!isLoopback(request.socket?.remoteAddress)) return false;
  const host = request.headers?.host;
  const localPort = request.socket?.localPort;
  if (!trustedHost(host, localPort)) return false;
  const origin = request.headers?.origin;
  if (typeof origin === 'string' && origin !== '') {
    return originTrusted(origin, host, localPort);
  }
  const site = request.headers?.['sec-fetch-site'];
  if (options.allowNonBrowser === true) {
    return site === undefined || site === 'same-origin';
  }
  return site === 'same-origin';
}

/** Constant-time bearer comparison for the MCP loopback token. */
function bearerMatches(value, token) {
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  const actual = Buffer.from(String(value ?? ''), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function applyCors(request, response) {
  if (!isLoopback(request.socket?.remoteAddress)) return;
  const host = request.headers?.host;
  const localPort = request.socket?.localPort;
  if (!trustedHost(host, localPort)) return;
  const origin = request.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return;
  if (!originTrusted(origin, host, localPort)) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'origin');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  response.setHeader('access-control-max-age', '600');
}

async function readJson(request) {
  const type = String(request.headers?.['content-type'] ?? '');
  if (!type.includes('application/json')) throw new Error('Content-Type 必须是 application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/**
 * Open a path in the OS file manager.
 *
 * Resolves with `{ ok }` instead of throwing: a missing `xdg-open`/`open` emits
 * an async `error` event, and without a listener Node treats it as an uncaught
 * exception and kills the DSH Host.
 */
export function openInFileManager(target, spawnImpl = spawn) {
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', [target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { detached: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `无法打开文件管理器（${command}）：${error?.message ?? error}` });
      return;
    }
    child.once('error', (error) => {
      resolve({ ok: false, error: `无法打开文件管理器（${command}）：${error?.code ?? error?.message ?? error}` });
    });
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

/** Row shape shared by the conversation list and `selectedSession`. */
function sessionRow(row, counts, isCurrent) {
  const name = row.name ?? row.label ?? row.title ?? '';
  return {
    key: row.key,
    sessionId: row.sessionId ?? '',
    parentSessionId: row.parentSessionId ?? '',
    workspace: row.workspace ?? '',
    label: row.label ?? '',
    title: row.title ?? '',
    name,
    public: row.public === true,
    viewers: Array.isArray(row.viewers) ? [...row.viewers] : [],
    displayLabel: name !== ''
      ? `${isCurrent ? '当前对话' : '对话'} ${name}`
      : (row.sessionId
        ? `${isCurrent ? '当前对话' : '对话'} ${shortSessionId(row.sessionId)}`
        : `对话 ${row.key.slice(-6)}`),
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
    current: isCurrent,
    counts,
  };
}

/**
 * Register the panel API.
 *
 * @param {object} ctx - plugin context.
 * @param {{config: object, entry: object|undefined, editor: object|undefined,
 *   registryDir: string, runtime?: object}} deps
 */
export function installApi(ctx, deps) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer ?? (typeof webCtx.get === 'function' ? webCtx.get('webServer') : undefined);
    if (!server || typeof server.register !== 'function') return undefined;

    const register = (routePath, handler) => webCtx.effect(
      () => server.register({
        kind: 'exact',
        path: routePath,
        handler: async (request, response) => {
          // Enforce the loopback Host/Origin guard on every method, including
          // GET and OPTIONS. CORS headers alone cannot stop DNS rebinding:
          // the rebinding page is same-origin with its own Host name.
          if (!isTrustedRequest(request)) {
            sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
            return;
          }
          applyCors(request, response);
          if (request.method === 'OPTIONS') {
            response.writeHead(204);
            response.end();
            return;
          }
          try {
            await handler(request, response);
          } catch (error) {
            if (!response.headersSent) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          }
        },
      }),
      `ai-for-memory: route ${routePath}`,
    );

    const fixedRoots = () => (deps.config.root ? [path.resolve(deps.config.root)] : []);

    // MCP egress. Streamable HTTP JSON-RPC is stateless here: POST a request,
    // receive a JSON response. The route wrapper already enforces loopback,
    // trusted Host and same-origin CORS; the optional token is an extra gate
    // for users who expose their DSH page through a local proxy.
    register(MCP_PATH, async (request, response) => {
      if (deps.config.mcpEnabled !== true) {
        sendJson(response, 404, { ok: false, error: 'MCP 出口未启用' });
        return;
      }
      const token = typeof deps.mcpToken === 'string' ? deps.mcpToken : (deps.config.mcpToken ?? '');
      if (token !== '') {
        const auth = String(request.headers?.authorization ?? '');
        if (!bearerMatches(auth, token)) {
          response.setHeader('www-authenticate', 'Bearer');
          sendJson(response, 401, { ok: false, error: 'MCP 访问令牌不正确' });
          return;
        }
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        sendJson(response, 200, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: String(error?.message ?? error) },
        });
        return;
      }
      const reply = await handleMcpMessage(body, {
        runTool: deps.runMcpTool,
        listRoots: deps.listMcpRoots,
        version: deps.version,
      });
      if (reply === null) {
        response.writeHead(202);
        response.end();
        return;
      }
      sendJson(response, 200, reply);
    });

    /** Resolve one writable store for a panel action. */
    const storeForScope = (rootPath, scope, session) => {
      const scopes = new MemoryScopes(rootPath, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
        stagingRetentionDays: deps.config.stagingRetentionDays,
        contextRetentionDays: deps.config.contextRetentionDays,
        decisionRetentionDays: deps.config.decisionRetentionDays,
        autoDecisionRetentionDays: deps.config.autoDecisionRetentionDays,
        backupRetentionDays: deps.config.backupRetentionDays,
      });
      if (scope === 'shared') return { store: scopes.sharedStore(), scopes };
      const value = String(session ?? recentSessionId(deps.runtime) ?? '').trim();
      if (value === '') return null;
      const key = isSessionKey(value) ? value : (scopes.resolve(value)?.key ?? sessionKey(value));
      return { store: scopes.sessionStore(key), scopes };
    };

    /** Resolve a panel-selected root and live conversation for a tool call. */
    const panelTarget = (body) => {
      const rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      if (typeof rootPath !== 'string' || rootPath === '') {
        throw new Error('记忆根目录不可用');
      }
      const row = listRootRows(deps.registryDir, deps.config.root)
        .find((candidate) => samePath(candidate.root, rootPath));
      return {
        root: rootPath,
        workspace: row?.workspace ?? rootPath,
        sessionId: typeof body?.session === 'string' ? body.session : undefined,
      };
    };

    const runPanelTool = async (toolName, args, body) => {
      if (typeof deps.runMcpTool !== 'function') throw new Error('当前运行环境没有可调用的记忆工具');
      return deps.runMcpTool(toolName, args, panelTarget(body));
    };

    const readPost = async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return null;
      }
      if (!isTrustedRequest(request, { allowNonBrowser: true })) {
        sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
        return null;
      }
      try {
        return await readJson(request);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return null;
      }
    };

    register(`${PREFIX}/search`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      try {
        const text = await runPanelTool('aim_search', {
          query: body?.query,
          scope: body?.scope,
          category: body?.category,
          route: body?.route,
          mode: body?.mode,
          top_k: body?.top_k,
        }, body);
        sendJson(response, 200, { ok: true, text: String(text ?? '') });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
      }
    });

    register(`${PREFIX}/ask`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      try {
        const text = await runPanelTool('aim_ask', body, body);
        sendJson(response, 200, { ok: true, text: String(text ?? '') });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
      }
    });

    register(`${PREFIX}/memory/action`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      const action = typeof body?.action === 'string' ? body.action : '';
      const allowed = new Set(['stage', 'archive', 'snapshot', 'remember', 'promote', 'incident']);
      if (!allowed.has(action)) {
        sendJson(response, 400, { ok: false, error: '不支持的记忆动作' });
        return;
      }
      try {
        const text = await runPanelTool('aim_memory', { ...body, action }, body);
        sendJson(response, 200, { ok: true, text: String(text ?? '') });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
      }
    });

    register(`${PREFIX}/context/action`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      const action = typeof body?.action === 'string' ? body.action : '';
      if (!['save', 'clear'].includes(action)) {
        sendJson(response, 400, { ok: false, error: '不支持的上下文动作' });
        return;
      }
      try {
        const text = await runPanelTool('aim_context', { ...body, action }, body);
        appendAudit(deps.registryDir, { action: `context.${action}`, root: body?.root, detail: body?.context_id ?? '' });
        sendJson(response, 200, { ok: true, text: String(text ?? '') });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
      }
    });

    register(`${PREFIX}/context/restore`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      if (typeof body?.context_id !== 'string' || body.context_id.trim() === '') {
        sendJson(response, 400, { ok: false, error: '需要 context_id' });
        return;
      }
      try {
        const text = await runPanelTool('aim_context', {
          action: 'restore',
          context_id: body.context_id,
          scope: body.scope,
        }, body);
        appendAudit(deps.registryDir, { action: 'context.restore', root: body?.root, detail: body.context_id });
        sendJson(response, 200, { ok: true, text: String(text ?? '') });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
      }
    });

    register(`${PREFIX}/snapshot/restore`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      if (typeof body?.snapshot_id !== 'string' || body.snapshot_id.trim() === '') {
        sendJson(response, 400, { ok: false, error: '需要 snapshot_id' });
        return;
      }
      try {
        const text = await runPanelTool('aim_memory', {
          action: 'restore',
          snapshot_id: body.snapshot_id,
        }, body);
        appendAudit(deps.registryDir, { action: 'snapshot.restore', root: body?.root, detail: body.snapshot_id });
        sendJson(response, 200, { ok: true, text: String(text ?? '') });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
      }
    });

    register(`${PREFIX}/knowledge/forget`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      const scope = body?.scope === 'shared' ? 'shared' : 'session';
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const resolved = storeForScope(rootPath, scope, body?.session);
      if (resolved === null) {
        sendJson(response, 400, { ok: false, error: '当前没有可用的对话' });
        return;
      }
      const result = resolved.store.forgetKnowledge(body?.doc_id);
      if (result.deleted !== true) {
        sendJson(response, 404, { ok: false, error: result.reason ?? '知识不存在' });
        return;
      }
      appendAudit(deps.registryDir, { action: 'knowledge.forget', root: rootPath, detail: result.doc_id ?? body?.doc_id });
      sendJson(response, 200, { ok: true, ...result });
    });

    register(`${PREFIX}/knowledge/pending/resolve`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      const action = body?.action;
      if (action !== 'accept' && action !== 'reject') {
        sendJson(response, 400, { ok: false, error: 'action 必须是 accept 或 reject' });
        return;
      }
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      const scope = body?.scope === 'shared' ? 'shared' : 'session';
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const resolved = storeForScope(rootPath, scope, body?.session);
      if (resolved === null) {
        sendJson(response, 400, { ok: false, error: '当前没有可用的对话' });
        return;
      }
      const pending = resolved.store.pendingPromotions()
        .find((row) => row.pending_id === body?.pending_id);
      if (!pending) {
        sendJson(response, 404, { ok: false, error: '待确认更新不存在' });
        return;
      }
      if (action === 'reject') {
        const removed = resolved.store.clearPendingPromotionFor(pending.update_of, pending.text);
        appendAudit(deps.registryDir, { action: 'knowledge.pending.reject', root: rootPath, detail: pending.update_of });
        sendJson(response, 200, { ok: true, action, removed });
        return;
      }
      const doc = resolved.store.remember({
        doc_id: pending.update_of,
        text: pending.text,
        category: pending.category,
        source: pending.source,
        tags: [],
        provenance: 'model',
        verified: false,
      }, { confirm: true });
      resolved.store.clearPendingPromotionFor(pending.update_of, pending.text);
      appendAudit(deps.registryDir, { action: 'knowledge.pending.accept', root: rootPath, detail: pending.update_of });
      sendJson(response, 200, {
        ok: true,
        action,
        doc_id: doc?.doc_id ?? pending.update_of,
        revision: doc?.revision ?? null,
      });
    });

    register(`${PREFIX}/retention/cleanup`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const scopes = new MemoryScopes(rootPath, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
        stagingRetentionDays: deps.config.stagingRetentionDays,
        contextRetentionDays: deps.config.contextRetentionDays,
        decisionRetentionDays: deps.config.decisionRetentionDays,
        autoDecisionRetentionDays: deps.config.autoDecisionRetentionDays,
        backupRetentionDays: deps.config.backupRetentionDays,
      });
      const stores = [scopes.sharedStore(), ...scopes.listSessions().map((row) => scopes.sessionStore(row.key))];
      const removed = { staging: 0, contexts: 0, decisions: 0, autoDecisions: 0, backups: 0 };
      for (const store of stores) {
        const result = store.pruneRetention();
        removed.staging += result.staging ?? 0;
        removed.contexts += result.contexts ?? 0;
        removed.decisions += result.decisions ?? 0;
        removed.autoDecisions += result.autoDecisions ?? 0;
        removed.backups += (result.backups ?? []).length;
      }
      appendAudit(deps.registryDir, {
        action: 'retention.cleanup',
        root: rootPath,
        detail: JSON.stringify(removed),
      });
      sendJson(response, 200, {
        ok: true,
        removed,
        storage: storageSummary(rootPath),
      });
    });

    register(`${PREFIX}/state`, async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const roots = listRootRows(deps.registryDir, deps.config.root);
      const selected = resolveRegisteredRoot(
        url.searchParams.get('root'),
        deps.registryDir,
        fixedRoots(),
      );
      // The panel's first render must already see engines adopted from the
      // previous plugin process, not an empty list that invites a second start.
      await waitForLocalAdoption();
      const selectedRow = selected === null
        ? null
        : roots.find((row) => samePath(row.root, selected)) ?? null;
      const inferredWorkspace = selected !== null
        && path.basename(selected) === deps.config.directoryName
        ? path.dirname(selected)
        : '';
      const gitignore = selected === null || selectedRow?.fixed === true
        ? null
        : defaultMemoryDirIgnoreStatus(
          selected,
          selectedRow?.workspace ?? inferredWorkspace,
          deps.config.directoryName,
        );
      const effectiveConfig = effectivePluginConfig(deps.config);
      // One snapshot of the disk/lifecycle state for the three related fields.
      const localModels = listLocalModelsCached();
      const localEngines = localEngineStatus();
      const localEngineSkips = autoStartSkips();
      const missingLocalEngines = missingLocalEngineKinds(localModels, localEngines);
      const base = {
        ok: true,
        generatedAt: new Date().toISOString(),
        roots,
        gitignore,
        storage: selected ? storageSummary(selected) : null,
        fixedRoot: deps.config.root ?? '',
        directoryName: deps.config.directoryName,
        mode: deps.config.autoEnabled ? 'auto' : 'manual',
        autoEnabled: deps.config.autoEnabled,
        autoEveryRounds: deps.config.autoEveryRounds,
        // Local engine lifecycle: manual (panel only), always, or per-turn.
        engineLifecycle: ['manual', 'always', 'turn'].includes(deps.config.engineLifecycle)
          ? deps.config.engineLifecycle : 'manual',
        // Automatic snapshots are independent from automatic tidying.
        autoSnapshot: deps.config.autoSnapshot !== false,
        autoSnapshotEvery: deps.config.autoSnapshotEvery ?? 5,
        autoSnapshotMax: deps.config.autoSnapshotMax ?? 10,
        contextUsagePercent: deps.config.contextUsagePercent ?? 70,
        defaultPublic: deps.config.defaultPublic === true,
        topicalClear: deps.config.topicalClear !== false,
        similarityThreshold: deps.config.similarityThreshold,
        keepRecentTurns: deps.config.keepRecentTurns,
        keepRecentSteps: deps.config.keepRecentSteps ?? 3,
        maxClearTurns: deps.config.maxClearTurns ?? 8,
        minClearChars: deps.config.minClearChars ?? 200,
        maxClearChars: deps.config.maxClearChars ?? 120000,
        maxContentChars: deps.config.maxContentChars ?? 30000,
        maxSnapshotBytes: deps.config.maxSnapshotBytes ?? 262144,
        defaultTopK: deps.config.defaultTopK ?? 5,
        maxContextChars: deps.config.maxContextChars ?? 30000,
        reviewHighRiskOnly: deps.config.reviewHighRiskOnly !== false,
        maxClearTurns: deps.config.maxClearTurns ?? 8,
        minClearChars: deps.config.minClearChars ?? 200,
        maxClearChars: deps.config.maxClearChars ?? 120000,
        autoKnowledge: deps.config.autoKnowledge !== false,
        autoKnowledgeLimit: deps.config.autoKnowledgeLimit ?? 10,
        autoDecisionLog: deps.config.autoDecisionLog !== false,
        stagingRetentionDays: deps.config.stagingRetentionDays ?? 30,
        contextRetentionDays: deps.config.contextRetentionDays ?? 0,
        decisionRetentionDays: deps.config.decisionRetentionDays ?? 0,
        autoDecisionRetentionDays: deps.config.autoDecisionRetentionDays ?? 30,
        backupRetentionDays: deps.config.backupRetentionDays ?? 0,
        requestAnchor: deps.config.requestAnchor !== false,
        restoreMaxChars: deps.config.restoreMaxChars ?? 12000,
        // External model endpoint (never the API key) so the panel can show and
        // edit the address without keeping a secret in the browser.
        externalBaseUrl: deps.config.externalBaseUrl ?? '',
        externalModel: deps.config.externalModel ?? '',
        externalTimeoutMs: deps.config.externalTimeoutMs ?? 60000,
        externalEmbedBaseUrl: effectiveConfig.externalEmbedBaseUrl ?? '',
        externalEmbedModel: effectiveConfig.externalEmbedModel ?? '',
        externalRerankBaseUrl: effectiveConfig.externalRerankBaseUrl ?? '',
        externalRerankModel: effectiveConfig.externalRerankModel ?? '',
        configuredExternalEmbedBaseUrl: deps.config.externalEmbedBaseUrl ?? '',
        configuredExternalEmbedModel: deps.config.externalEmbedModel ?? '',
        configuredExternalRerankBaseUrl: deps.config.externalRerankBaseUrl ?? '',
        configuredExternalRerankModel: deps.config.externalRerankModel ?? '',
        localModelRouting: localModelRouting(),
        // User-provided model folders inside the plugin. These are manifests for
        // local API servers; the plugin never loads model weights itself. Scan
        // once: the reminder and the two payload fields share the same snapshot.
        localModels,
        localEngines,
        // Why a runnable model was not auto-started (for example a usable
        // configured embedding endpoint already answers). The panel shows this
        // next to the model so "engine never starts" has a visible reason.
        localEngineSkips,
        // A reminder, not an auto-start: the panel must not spawn a model just
        // because it exists on disk. Empty string means "nothing to say", which
        // also clears the reminder after the user starts the engine.
        localEngineReminder: missingLocalEngines.length === 0
          ? ''
          : `检测到 ${missingLocalEngines
            .map((kind) => (kind === 'rerank' ? 'Rerank' : 'Embedding')).join(' / ')}`
            + ' 模型，但还没有开启模型；到「设置 → 模型」启动。',
        // Device-local Git sync settings. No network action runs unless enabled.
        network: selected ? readSyncConfig(selected) : null,
        // Cloud keys never leave the host: the panel only learns whether one is
        // stored, so a saved token cannot be read back from the browser.
        externalHasApiKey: (deps.config.externalApiKey ?? '') !== '',
        externalEmbedHasApiKey: (deps.config.externalEmbedApiKey ?? '') !== '',
        externalRerankHasApiKey: (deps.config.externalRerankApiKey ?? '') !== '',
        // Per-layer mode: false = deterministic (offline), true = external model.
        archiveExternal: deps.config.archiveExternal === true,
        knowledgeExternal: deps.config.knowledgeExternal === true,
        contextExternal: deps.config.contextExternal === true,
        // Knowledge storage backend: 'json' files (default) or 'sqlite'.
        knowledgeBackend: deps.config.knowledgeBackend ?? 'json',
        // RAG mount switch (manual): the index is built by /rag/index or the
        // action=index tool; this only decides whether search uses it.
        ragMount: effectiveConfig.ragMount === true,
        ragMountConfigured: deps.config.ragMount === true,
        // MCP egress: the endpoint is on the same loopback listener as the panel.
        mcpEnabled: deps.config.mcpEnabled === true,
        mcpPath: MCP_PATH,
        mcpHasToken: (deps.mcpToken ?? deps.config.mcpToken ?? '') !== '',
        mcpTokenFile: deps.mcpTokenFile ?? '',
        // Both models are mandatory for RAG: embedding indexes, rerank reorders.
        ragModelsReady: ragModelStatus(effectiveConfig).ready,
        ragModelsMissing: ragModelStatus(effectiveConfig).missing,
        sessionRepairAvailable: zstdAvailable(),
        sessionRepairNeed: 'Node 22.15+',
      };
      if (selected === null) {
        sendJson(response, 200, {
          ...base,
          selectedRoot: null,
          scope: 'session',
          sessionUnknown: true,
          currentSessionId: recentSessionId(deps.runtime),
          selectedSession: null,
          sessions: [],
          sessionsTotal: 0,
          shared: { counts: { ...ZERO_COUNTS }, hasData: false },
          counts: { ...ZERO_COUNTS },
          decisionsByOutcome: {},
          staging: [],
          archive: [],
          snapshots: [],
          knowledge: [],
          decisions: [],
          contexts: [],
        });
        return;
      }

      const scopes = new MemoryScopes(selected, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
      });
      const currentSessionId = recentSessionId(deps.runtime);
      const requestedSession = String(url.searchParams.get('session') ?? '').trim();
      const wantedSession = requestedSession || currentSessionId;
      const resolved = wantedSession === '' ? null : scopes.resolve(wantedSession);
      // An unanswered conversation-key (for example after switching memory roots)
      // must not be hashed into a brand-new empty conversation.
      const unknownKey = resolved === null && isSessionKey(wantedSession);
      const selectedKey = resolved?.key ?? (wantedSession === '' || unknownKey ? null : sessionKey(wantedSession));
      const selectedSessionId = resolved?.sessionId ?? (unknownKey ? '' : wantedSession);

      // Measured context pressure belongs to the live session, not to the
      // configured threshold. Keep both: `contextUsagePercent` is the setting,
      // `contextMeasuredPercent` is what the meter reports right now.
      let measuredPressure = null;
      try {
        const agents = deps.getService?.('agents');
        let liveAgent = selectedSessionId && typeof agents?.get === 'function'
          ? agents.get(selectedSessionId)
          : undefined;
        if (!liveAgent && typeof agents?.currentInitiator === 'function') {
          liveAgent = agents.currentInitiator() ?? undefined;
        }
        if (!liveAgent && typeof agents?.list === 'function') {
          const list = agents.list();
          liveAgent = Array.isArray(list) && list.length > 0 ? list[list.length - 1] : undefined;
        }
        const liveSession = liveAgent?.session;
        const meter = deps.getService?.('tokenMeter');
        if (liveSession && meter && typeof meter.contextPressure === 'function') {
          measuredPressure = meter.contextPressure(liveSession) ?? null;
        }
      } catch {
        measuredPressure = null;
      }
      const contextMeasuredPercent = usagePercentOf(measuredPressure);
      const contextMeasuredText = measuredPressure === null
        ? '未知（还没有测量数据）'
        : formatPressure(measuredPressure);

      // A conversation that has never written memory still gets a metadata row,
      // so the picker can show "current conversation" with empty counts.
      if (selectedKey !== null && selectedKey !== undefined && !resolved) {
        scopes.ensureSession(selectedSessionId, {});
      }

      const allRows = scopes.listSessions();
      const MAX_ROWS = 40;
      const trimmed = allRows.length > MAX_ROWS && !allRows.slice(0, MAX_ROWS).some((row) => row.key === selectedKey);
      const visibleRows = trimmed
        ? [...allRows.slice(0, MAX_ROWS), ...allRows.filter((row) => row.key === selectedKey)]
        : allRows.slice(0, MAX_ROWS);
      const rows = visibleRows.map((row) => {
        const counts = scopes.counts(row.key);
        return sessionRow(row, counts, row.key === selectedKey);
      });
      if (selectedKey && !rows.some((row) => row.key === selectedKey)) {
        rows.unshift(sessionRow({
          key: selectedKey,
          sessionId: selectedSessionId,
          public: deps.config.defaultPublic === true,
          createdAt: '',
          updatedAt: '',
        }, { ...ZERO_COUNTS }, true));
      }
      rows.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));

      const requestedScope = String(url.searchParams.get('scope') ?? '');
      const scope = ['session', 'all', 'shared'].includes(requestedScope) ? requestedScope : 'session';

      const sharedCounts = scopes.sharedCounts();
      const sharedHasData = Object.values(sharedCounts).some((count) => count > 0);
      const sharedSource = {
        store: scopes.sharedStore(),
        scope: 'shared',
        key: '',
        sessionId: '',
        label: '共享',
      };

      let sources;
      if (scope === 'shared') {
        sources = [sharedSource];
      } else if (scope === 'all') {
        // Closed conversations are invisible to everyone except themselves, and
        // a named viewer list is invisible to everyone it does not name.
        sources = rows
          .filter((row) => rowVisibleTo(row, selectedKey, selectedSessionId))
          .map((row) => ({
            store: scopes.sessionStore(row.key),
            scope: 'session',
            key: row.key,
            sessionId: row.sessionId,
            label: row.current ? '本对话' : `对话 ${row.name || shortSessionId(row.sessionId)}`,
          }));
        if (sharedHasData) sources.push(sharedSource);
      } else {
        const own = rows.find((row) => row.key === selectedKey);
        sources = own
          ? [{
            store: scopes.sessionStore(own.key),
            scope: 'session',
            key: own.key,
            sessionId: own.sessionId,
            label: '本对话',
          }]
          : [sharedSource];
      }

      const state = buildUiState(sources);
      // The panel shows whether the current scope has a RAG index yet; the
      // build itself happens through POST /rag/index. The index also records
      // which embedding space it was built for, so switching provider/model
      // can be surfaced before a search falls back.
      const currentEmbedding = embeddingIdentity(normalizeExternal({
        baseUrl: effectiveConfig.externalBaseUrl,
        model: effectiveConfig.externalModel,
        embedBaseUrl: effectiveConfig.externalEmbedBaseUrl,
        embedModel: effectiveConfig.externalEmbedModel,
        apiKey: effectiveConfig.externalApiKey,
        timeoutMs: effectiveConfig.externalTimeoutMs,
      }));
      const stats = sources.length > 0
        ? ragStats(sources[0].store.root)
        : { built: false, docs: 0, considered: 0, truncated: 0, deduped: 0, dim: 0, model: '', endpoint: '', built_at: '' };
      const ragIndex = {
        ...stats,
        current_model: currentEmbedding.model,
        current_endpoint: currentEmbedding.endpoint,
        stale: stats.built === true && !sameEmbeddingSpace(stats, currentEmbedding),
      };
      // Which backend actually serves the knowledge rows (SQLite may have
      // downgraded to JSON on an old Node), plus the file shown in the panel.
      const knowledgeStorage = sources.length > 0
        ? sources[0].store.knowledgeBackendInfo()
        : { backend: deps.config.knowledgeBackend ?? 'json', file: '', sqliteAvailable: false, error: '' };
      sendJson(response, 200, {
        ...base,
        ...state,
        contextMeasuredPercent,
        contextMeasuredText,
        ragIndex,
        knowledgeStorage,
        selectedRoot: scopes.root,
        // Explicit scope wins over the merged view's inferred one.
        scope,
        sessionUnknown: selectedKey === null || selectedKey === undefined,
        currentSessionId,
        selectedSession: rows.find((row) => row.current) ?? null,
        sessions: rows,
        sessionsTotal: allRows.length,
        shared: { counts: sharedCounts, hasData: sharedHasData },
      });
    });

    register(`${PREFIX}/diagnostics`, async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(url.searchParams.get('root'), deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      await waitForLocalAdoption();
      const scopes = new MemoryScopes(rootPath, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
        stagingRetentionDays: deps.config.stagingRetentionDays,
        contextRetentionDays: deps.config.contextRetentionDays,
        decisionRetentionDays: deps.config.decisionRetentionDays,
        autoDecisionRetentionDays: deps.config.autoDecisionRetentionDays,
        backupRetentionDays: deps.config.backupRetentionDays,
      });
      const models = listLocalModelsCached();
      const llamaServer = findExecutable(process.env.DSH_LLAMA_SERVER || process.env.LLAMA_SERVER || 'llama-server');
      let writable = false;
      try {
        fs.accessSync(rootPath, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
      let sync = null;
      try {
        sync = await syncStatus(rootPath);
      } catch {
        sync = null;
      }
      const gitignore = defaultMemoryDirIgnoreStatus(
        rootPath,
        path.dirname(rootPath),
        deps.config.directoryName,
      );
      const usage = usageRows(scopes);
      const conversations = conversationRows(scopes);
      sendJson(response, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        root: rootPath,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        sqlite: sqliteAvailable(),
        sessionRepairAvailable: zstdAvailable(),
        sessionRepairNeed: 'Node 22.15+',
        git: {
          available: sync?.gitAvailable === true,
          version: sync?.gitAvailable === true ? 'available' : '',
          status: sync,
        },
        llamaServer,
        models: {
          root: models.root,
          roots: models.roots,
          categories: models.categories,
        },
        writable,
        gitignore,
        storage: storageSummary(rootPath),
        engines: localEngineStatus(),
        usage,
        conversations,
        audit: readAudit(deps.registryDir, 100),
      });
    });

    /**
     * Session-log health. This is deliberately independent of a memory root:
     * it reads DSH's own `sessions` directory, which is where an unloadable
     * conversation actually lives. Shallow scans only decode the header frame,
     * so the panel can list a 150 MiB log without reading it.
     */
    register(`${PREFIX}/session-logs`, async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const deep = ['1', 'true', 'yes'].includes(String(url.searchParams.get('deep') ?? '').toLowerCase());
      const limitRaw = Number(url.searchParams.get('limit'));
      if (!zstdAvailable()) {
        sendJson(response, 200, {
          ok: false,
          unavailable: true,
          error: `会话日志修复需要 Node 22.15+；当前是 ${process.version}`,
          node: process.version,
        });
        return;
      }
      try {
        const scan = await scanSessionLogs(dshSessionsDir(), {
          deep,
          limit: Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
        });
        sendJson(response, 200, { ok: true, ...scan });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
      }
    });

    /**
     * Repair one artifact. `apply=false` only previews; the panel requires a
     * second click before it sends `apply=true`. The live conversation is
     * refused because DSH is still appending to its log.
     */
    register(`${PREFIX}/session-logs/repair`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      let target;
      try {
        target = resolveSessionLogTarget(dshSessionsDir(), body?.session);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      const current = String(recentSessionId(deps.runtime) ?? '').replace(/^session-/, '');
      const currentMatch = current !== '' && target.id.replace(/^session-/, '') === current;
      // `recentSessionId` only names the newest finished conversation. A
      // conversation streaming in another tab is in `activeTurns`; repairing it
      // would overwrite the events DSH appends after the planning read. The
      // repair path also re-checks the file fingerprint before writing.
      const running = isSessionActive(deps.runtime, target.id);
      if (body?.apply === true && (running || currentMatch)) {
        sendJson(response, 409, {
          ok: false,
          error: running
            ? '这个对话仍在进行中（DSH 正在追加日志），不能就地修复。请等它结束后重试。'
            : '当前对话仍被 DSH 打开，不能就地修复。请切换到其他对话，或修复后重新打开这个对话。',
        });
        return;
      }
      try {
        const report = await repairSessionLog(target.file, {
          strategy: typeof body?.strategy === 'string' ? body.strategy : 'auto',
          compact: body?.compact === true,
          apply: body?.apply === true,
        });
        if (report.conflict === true) {
          sendJson(response, 409, {
            ok: false,
            error: report.error,
            report,
            text: formatRepairReport(report),
          });
          return;
        }
        if (report.repaired === true) {
          appendAudit(deps.registryDir, {
            action: body?.compact === true ? 'session-logs.compact' : 'session-logs.repair',
            root: target.file,
            detail: `${target.id} · ${report.strategy} · dropped ${report.dropped}`,
          });
        }
        sendJson(response, 200, { ok: true, report, text: formatRepairReport(report) });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
      }
    });

    register(`${PREFIX}/conversations/bulk`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      const action = body?.action;
      if (action !== 'open' && action !== 'close') {
        sendJson(response, 400, { ok: false, error: 'action 必须是 open 或 close' });
        return;
      }
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const scopes = new MemoryScopes(rootPath, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
      });
      const keys = (Array.isArray(body?.keys) ? body.keys : [])
        .map((key) => String(key ?? '')).filter((key) => isSessionKey(key));
      if (keys.length === 0) {
        sendJson(response, 400, { ok: false, error: '没有可操作的对话' });
        return;
      }
      for (const key of keys) {
        await scopes.setPublic(key, action === 'open');
        // Closing means private: a stale viewer list would keep the conversation
        // readable by the ones it was once shared with.
        if (action !== 'open') await scopes.setViewers(key, []);
      }
      appendAudit(deps.registryDir, {
        action: action === 'open' ? 'conversations.open' : 'conversations.close',
        root: rootPath,
        detail: `${keys.length} conversation(s)`,
      });
      sendJson(response, 200, {
        ok: true,
        action,
        changed: keys.length,
        conversations: conversationRows(scopes),
      });
    });

    register(`${PREFIX}/session`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      // 与 register() 的统一门重复（已关闭，保留作为语义标记）：
      // if (!isTrustedRequest(request)) {
      //   sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
      //   return;
      // }
      const body = await readJson(request);
      const rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      if (rootPath === null) {
        sendJson(response, 404, { ok: false, error: '记忆目录未登记' });
        return;
      }
      const target = String(body?.session ?? '').trim();
      if (target === '') {
        sendJson(response, 400, { ok: false, error: '缺少对话标识' });
        return;
      }
      let label;
      if (body?.label !== undefined) {
        if (typeof body.label !== 'string') {
          sendJson(response, 400, { ok: false, error: '对话名称必须是字符串' });
          return;
        }
        label = body.label.trim();
        if (label.length > 80) {
          sendJson(response, 400, { ok: false, error: '对话名称最多 80 个字符' });
          return;
        }
      }
      let isPublic;
      if (body?.public !== undefined) {
        if (typeof body.public !== 'boolean') {
          sendJson(response, 400, { ok: false, error: '开放状态必须是布尔值' });
          return;
        }
        isPublic = body.public;
      }
      let viewers;
      if (body?.viewers !== undefined) {
        if (!Array.isArray(body.viewers)) {
          sendJson(response, 400, { ok: false, error: '开放对象必须是对话 id 数组' });
          return;
        }
        if (body.viewers.length > 50
          || !body.viewers.every((id) => typeof id === 'string' && id.length <= 100)) {
          sendJson(response, 400, { ok: false, error: '开放对象最多 50 个，每个不超过 100 个字符' });
          return;
        }
        viewers = body.viewers;
      }
      if (label === undefined && isPublic === undefined && viewers === undefined) {
        sendJson(response, 400, { ok: false, error: '没有要修改的设置' });
        return;
      }

      const scopes = new MemoryScopes(rootPath, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
      });
      const resolved = scopes.resolve(target);
      if (!resolved) {
        sendJson(response, 404, { ok: false, error: '对话未登记' });
        return;
      }

      const patch = {};
      if (label !== undefined) patch.label = label;
      if (isPublic !== undefined) patch.public = isPublic;
      await scopes.touchAsync(resolved.key, patch);
      if (isPublic === true) {
        // `public` opens the conversation to everyone, so a named list would be
        // dead weight; turning it on clears the list instead of hiding it.
        await scopes.setViewers(resolved.key, []);
      } else if (viewers !== undefined) {
        await scopes.setViewers(resolved.key, viewers);
      }

      // Keep the DSH sidebar title in sync when this conversation is live; a
      // closed/archived conversation keeps the name in session.json only.
      if (label !== undefined && label !== '') {
        try {
          const agents = deps.getService?.('agents');
          const session = agents?.get?.(resolved.sessionId)?.session;
          const titles = deps.getService?.('sessionTitle');
          if (session && titles && typeof titles.rename === 'function') {
            titles.rename(session, label);
          }
        } catch {
          // The memory-side name is already persisted; sidebar sync is optional.
        }
      }

      const row = scopes.listSessions().find((candidate) => candidate.key === resolved.key);
      sendJson(response, 200, {
        ok: true,
        saved: {
          key: resolved.key,
          label: label ?? row?.label ?? '',
          public: isPublic ?? row?.public === true,
          viewers: row?.viewers ?? [],
        },
        session: row ? sessionRow(row, scopes.counts(row.key), false) : null,
      });
    });

    register(`${PREFIX}/reveal`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      // 与 register() 的统一门重复（已关闭，保留作为语义标记）：
      // if (!isTrustedRequest(request)) {
      //   sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
      //   return;
      // }
      const body = await readJson(request);
      const target = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      if (target === null) {
        sendJson(response, 404, { ok: false, error: '记忆目录未登记' });
        return;
      }
      // Optional single-record reveal: the JSON file is the review point, so
      // send the user to the exact file instead of only the memory root.
      const kind = String(body?.kind ?? '');
      const id = String(body?.id ?? '');
      if (kind !== '' && id !== '') {
        const resolved = storeForScope(target, body?.scope, body?.session);
        if (!resolved) {
          sendJson(response, 404, { ok: false, error: '对话或范围未登记' });
          return;
        }
        const file = recordFile(resolved.store, kind, id);
        if (!file) {
          sendJson(response, 404, { ok: false, error: '记录文件不存在' });
          return;
        }
        const opened = await openInFileManager(file);
        if (!opened.ok) {
          sendJson(response, 500, { ok: false, error: opened.error });
          return;
        }
        sendJson(response, 200, { ok: true, file });
        return;
      }
      // The fixed root may not have been used yet; create it so "open folder" works.
      fs.mkdirSync(target, { recursive: true });
      const opened = await openInFileManager(target);
      if (!opened.ok) {
        sendJson(response, 500, { ok: false, error: opened.error });
        return;
      }
      sendJson(response, 200, { ok: true, root: target });
    });

    register(`${PREFIX}/record/download`, async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const target = resolveRegisteredRoot(url.searchParams.get('root'), deps.registryDir, fixedRoots());
      if (target === null) {
        sendJson(response, 404, { ok: false, error: '记忆目录未登记' });
        return;
      }
      const resolved = storeForScope(
        target,
        url.searchParams.get('scope'),
        url.searchParams.get('session'),
      );
      if (!resolved) {
        sendJson(response, 404, { ok: false, error: '对话或范围未登记' });
        return;
      }
      const kind = String(url.searchParams.get('kind') ?? '');
      const id = String(url.searchParams.get('id') ?? '');
      const format = String(url.searchParams.get('format') ?? '').toLowerCase();
      if (kind === 'context' && format === 'markdown') {
        const record = resolved.store.loadContext(id);
        if (!record) {
          sendJson(response, 404, { ok: false, error: '上下文存档不存在' });
          return;
        }
        const markdown = formatContextMarkdown(record);
        response.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${record.context_id}.md"`,
          'cache-control': 'no-store',
        });
        response.end(markdown);
        return;
      }
      const file = recordFile(resolved.store, kind, id);
      if (!file) {
        sendJson(response, 404, { ok: false, error: '记录文件不存在' });
        return;
      }
      try {
        const data = fs.readFileSync(file);
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${path.basename(file)}"`,
          'cache-control': 'no-store',
        });
        response.end(data);
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
      }
    });

    register(`${PREFIX}/snapshot/compare`, async (request, response) => {
      const body = await readJson(request);
      const target = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      if (target === null) {
        sendJson(response, 404, { ok: false, error: '记忆目录未登记' });
        return;
      }
      const resolved = storeForScope(target, body?.scope, body?.session);
      if (!resolved) {
        sendJson(response, 404, { ok: false, error: '对话或范围未登记' });
        return;
      }
      const left = resolved.store.loadSnapshot(String(body?.left ?? ''));
      const right = resolved.store.loadSnapshot(String(body?.right ?? ''));
      if (!left || !right) {
        sendJson(response, 404, { ok: false, error: '快照不存在' });
        return;
      }
      sendJson(response, 200, { ok: true, left, right });
    });

    /** Connectivity check for the external model (any OpenAI-compatible API). */
    register(`${PREFIX}/external`, async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      const effective = effectivePluginConfig(deps.config);
      const endpoint = externalConfigFrom(effective);
      const deep = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('deep') === '1';
      const result = await probeExternal(endpoint, undefined, { deep });
      sendJson(response, 200, {
        ok: true,
        probe: result,
        endpoint: {
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          embedBaseUrl: endpoint.embedBaseUrl,
          embedModel: endpoint.embedModel,
          rerankBaseUrl: endpoint.rerankBaseUrl,
          rerankModel: endpoint.rerankModel,
          timeoutMs: endpoint.timeoutMs,
          hasApiKey: endpoint.apiKey !== '',
        },
      });
    });
    /** Build/refresh the RAG index over one scope's knowledge layer. */
    register(`${PREFIX}/rag/index`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      // 与 register() 的统一门重复（已关闭，保留作为语义标记）：
      // if (!isTrustedRequest(request)) {
      //   sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
      //   return;
      // }
      const body = await readJson(request);
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const scope = body?.scope === 'shared' ? 'shared' : 'session';
      const scopes = new MemoryScopes(rootPath, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
      });
      const session = String(body?.session ?? recentSessionId(deps.runtime) ?? '').trim();
      let store;
      if (scope === 'shared') {
        store = scopes.sharedStore();
      } else {
        if (session === '') {
          sendJson(response, 400, { ok: false, error: '当前没有可用的对话；请先发一条消息，或改用 shared 范围' });
          return;
        }
        // The panel may send either a raw session id or an internal key.
        const key = isSessionKey(session) ? session : (scopes.resolve(session)?.key ?? sessionKey(session));
        store = scopes.sessionStore(key);
      }
      const effective = effectivePluginConfig(deps.config);
      const models = ragModelStatus(effective);
      if (!models.ready) {
        sendJson(response, 400, {
          ok: false,
          error: `建立 RAG 索引需要同时配置 Embedding 和 Rerank 两个模型；当前缺少：${models.missing.join('、')}`,
        });
        return;
      }
      const endpoint = externalConfigFrom(effective);
      const built = await buildRagIndex(store, endpoint);
      if (!built.ok) {
        sendJson(response, 200, { ok: false, error: built.error, indexed: built.indexed, pending: built.pending });
        return;
      }
      appendAudit(deps.registryDir, { action: 'rag.index', root: rootPath, detail: `scope=${scope} indexed=${built.indexed ?? 0}` });
      sendJson(response, 200, { ok: true, ...built, ...ragStats(store.root) });
    });

    /**
     * Whole knowledge-base export as a download.
     *
     * GET is intentional: the panel links to it and the browser saves the file
     * directly, which is the point when the disk is full — the export can land
     * on another disk without the Host writing it to the full one first.
     */
    register(`${PREFIX}/knowledge/export`, async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      // 与 register() 的统一门重复（已关闭，保留作为语义标记）：
      // if (!isTrustedRequest(request)) {
      //   sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
      //   return;
      // }
      const url = new URL(request.url ?? '/', 'http://localhost');
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(url.searchParams.get('root'), deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const scope = url.searchParams.get('scope') === 'shared' ? 'shared' : 'session';
      const scopes = new MemoryScopes(rootPath, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
      });
      const session = String(url.searchParams.get('session') ?? recentSessionId(deps.runtime) ?? '').trim();
      let store;
      if (scope === 'shared') {
        store = scopes.sharedStore();
      } else {
        if (session === '') {
          sendJson(response, 400, { ok: false, error: '当前没有可用的对话；请先发一条消息，或改用 shared 范围' });
          return;
        }
        const key = isSessionKey(session) ? session : (scopes.resolve(session)?.key ?? sessionKey(session));
        store = scopes.sessionStore(key);
      }
      const payload = exportArtifact(store, {
        type: url.searchParams.get('type') ?? 'knowledge',
        scope,
        label: scope === 'shared' ? '共享' : session,
        sessionId: session,
        format: url.searchParams.get('format') ?? 'json',
      });
      if (payload.ok !== true) {
        sendJson(response, 400, { ok: false, error: payload.error });
        return;
      }
      const asciiName = payload.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      const encodedName = encodeURIComponent(payload.filename);
      response.writeHead(200, {
        'content-type': payload.mime,
        // ASCII fallback for old clients + RFC 5987 for the real (possibly
        // Chinese) name; raw non-ASCII bytes in a header would throw here.
        'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        'cache-control': 'no-store',
      });
      response.end(payload.buffer ?? payload.content);
    });

    /** Confirm an existing model-authored knowledge document. */
    register(`${PREFIX}/knowledge/verify`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      // 与 register() 的统一门重复（已关闭，保留作为语义标记）：
      // if (!isTrustedRequest(request)) {
      //   sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
      //   return;
      // }
      const body = await readJson(request);
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const scope = body?.scope === 'shared' ? 'shared' : 'session';
      const resolved = storeForScope(rootPath, scope, body?.session);
      if (resolved === null) {
        sendJson(response, 400, { ok: false, error: '当前没有可用的对话' });
        return;
      }
      const result = resolved.store.verifyKnowledge(body?.doc_id);
      if (result.verified !== true) {
        sendJson(response, 404, { ok: false, error: result.reason ?? '知识不存在' });
        return;
      }
      appendAudit(deps.registryDir, { action: 'knowledge.verify', root: rootPath, detail: result.doc_id ?? body?.doc_id });
      sendJson(response, 200, { ok: true, ...result });
    });

    register(`${PREFIX}/knowledge/verify/batch`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const resolved = storeForScope(rootPath, body?.scope, body?.session);
      if (!resolved) {
        sendJson(response, 400, { ok: false, error: '当前没有可用的对话' });
        return;
      }
      const ids = (Array.isArray(body?.doc_ids) ? body.doc_ids : [])
        .map((id) => String(id ?? '')).filter((id) => id !== '').slice(0, 500);
      if (ids.length === 0) {
        sendJson(response, 400, { ok: false, error: '没有选择知识' });
        return;
      }
      const results = ids.map((id) => resolved.store.verifyKnowledge(id));
      const verified = results.filter((row) => row.verified === true).length;
      appendAudit(deps.registryDir, {
        action: 'knowledge.verify.batch',
        root: rootPath,
        detail: `${verified}/${ids.length}`,
      });
      sendJson(response, 200, { ok: true, verified, total: ids.length, results });
    });

    register(`${PREFIX}/knowledge/unverify`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const resolved = storeForScope(rootPath, body?.scope, body?.session);
      if (!resolved) {
        sendJson(response, 400, { ok: false, error: '当前没有可用的对话' });
        return;
      }
      const result = resolved.store.unverifyKnowledge(body?.doc_id);
      if (result.undone !== true) {
        sendJson(response, 400, { ok: false, error: result.reason ?? '不能撤销' });
        return;
      }
      appendAudit(deps.registryDir, { action: 'knowledge.unverify', root: rootPath, detail: result.doc_id });
      sendJson(response, 200, { ok: true, ...result });
    });

    /** Read one root's device-local sync settings and likely Git state. */
    register(`${PREFIX}/network/status`, async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(url.searchParams.get('root'), deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      sendJson(response, 200, { ok: true, status: await syncStatus(rootPath) });
    });

    /** Save the device-local Git sync settings (enabled/path scope/remote). */
    register(`${PREFIX}/network`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      // 与 register() 的统一门重复（已关闭，保留作为语义标记）：
      // if (!isTrustedRequest(request)) {
      //   sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
      //   return;
      // }
      const body = await readJson(request);
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const config = writeSyncConfig(rootPath, {
        enabled: body?.enabled,
        role: body?.role,
        remote: body?.remote,
        group: body?.group,
        paths: body?.paths,
      });
      sendJson(response, 200, { ok: true, network: config, status: await syncStatus(rootPath) });
    });

    /** One explicit Git action: init/commit/push/pull/scan/status. */
    register(`${PREFIX}/network/action`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      // 与 register() 的统一门重复（已关闭，保留作为语义标记）：
      // if (!isTrustedRequest(request)) {
      //   sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
      //   return;
      // }
      const body = await readJson(request);
      let rootPath;
      try {
        rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (typeof rootPath !== 'string' || rootPath === '') {
        sendJson(response, 400, { ok: false, error: '记忆根目录不可用' });
        return;
      }
      const action = String(body?.action ?? '');
      let result;
      if (action === 'init') result = await initSync(rootPath);
      else if (action === 'commit') result = await commitSync(rootPath, body?.message);
      else if (action === 'push') result = await pushSync(rootPath, body?.message);
      else if (action === 'pull') result = await pullSync(rootPath);
      else if (action === 'scan') {
        const syncConfig = readSyncConfig(rootPath);
        result = syncConfig.enabled
          ? await probeHost(syncConfig.remote)
          : { ok: false, error: '网络同步未启用：先保存并打开网络同步。' };
      } else if (action === 'status') result = { ok: true };
      else {
        sendJson(response, 400, { ok: false, error: '未知网络操作' });
        return;
      }
      sendJson(response, 200, {
        ok: result.ok === true,
        action,
        result,
        status: await syncStatus(rootPath),
      });
      appendAudit(deps.registryDir, {
        action: `network.${action}`,
        root: rootPath,
        detail: result.ok === true ? 'ok' : String(result.error ?? 'failed').slice(0, 300),
      });
    });

    /**
     * Local inference engine: start/stop one llama.cpp server declared by a
     * models/<category>/<folder>/model.json. No weights are downloaded; the
     * request fails until the user puts a GGUF file in that folder.
     */
    register(`${PREFIX}/local-engine`, async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      await waitForLocalAdoption();
      sendJson(response, 200, { ok: true, engines: localEngineStatus() });
    });

    register(`${PREFIX}/local-engine/start`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      // 与 register() 的统一门重复（已关闭，保留作为语义标记）：
      // if (!isTrustedRequest(request)) {
      //   sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
      //   return;
      // }
      const body = await readJson(request);
      const model = typeof body?.model === 'string' ? body.model.trim() : '';
      if (model === '') {
        sendJson(response, 400, { ok: false, error: '缺少模型 id（分类/文件夹）' });
        return;
      }
      try {
        const result = await startLocalEngine({ modelId: model });
        if (!result.ok) {
          sendJson(response, 200, {
            ok: false,
            stale: result.stale === true,
            error: result.error,
            engine: result.engine ?? null,
            engines: localEngineStatus(),
          });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          endpoint: result.endpoint,
          engine: result.engine,
          engines: localEngineStatus(),
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error), engines: localEngineStatus() });
      }
    });

    register(`${PREFIX}/local-engine/stop`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      // 与 register() 的统一门重复（已关闭，保留作为语义标记）：
      // if (!isTrustedRequest(request)) {
      //   sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
      //   return;
      // }
      const body = await readJson(request);
      const model = typeof body?.model === 'string' ? body.model.trim() : '';
      try {
        // The user clicked stop: cancel an in-flight load immediately instead
        // of making them wait for a multi-second model load to finish.
        const result = await stopLocalEngine(model, { cancelStart: true });
        sendJson(response, 200, { ...result, engines: localEngineStatus() });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error), engines: localEngineStatus() });
      }
    });

    register(`${PREFIX}/local-engine/config`, async (request, response) => {
      const body = await readPost(request, response);
      if (body === null) return;
      const model = typeof body?.model === 'string' ? body.model.trim() : '';
      if (model === '') {
        sendJson(response, 400, { ok: false, error: '缺少模型 id（分类/文件夹）' });
        return;
      }
      const result = updateModelConfig({
        modelId: model,
        kind: body?.kind,
        modelPath: body?.modelPath,
        ctxSize: body?.ctxSize,
        port: body?.port,
        pooling: body?.pooling,
        startupTimeoutMs: body?.startupTimeoutMs,
        binary: body?.binary,
        extraArgs: body?.extraArgs,
      });
      if (result.ok !== true) {
        sendJson(response, 400, { ok: false, error: result.error });
        return;
      }
      resetLocalModelsCache();
      appendAudit(deps.registryDir, {
        action: 'local-engine.config',
        root: result.model,
        detail: `ctxSize=${result.ctxSize} port=${result.port} modelPath=${result.modelPath}`,
      });
      sendJson(response, 200, { ok: true, ...result, localModels: listLocalModelsCached() });
    });

    register(`${PREFIX}/config`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      // 与 register() 的统一门重复（已关闭，保留作为语义标记）：
      // if (!isTrustedRequest(request)) {
      //   sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
      //   return;
      // }
      const body = await readJson(request);
      const root = typeof body?.root === 'string' ? body.root.trim() : deps.config.root;
      const directoryName = typeof body?.directoryName === 'string'
        ? body.directoryName.trim()
        : deps.config.directoryName;
      const autoEnabled = body?.autoEnabled === undefined
        ? deps.config.autoEnabled
        : body.autoEnabled;
      const autoEveryRounds = body?.autoEveryRounds === undefined
        ? deps.config.autoEveryRounds
        : body.autoEveryRounds;
      const autoSnapshot = body?.autoSnapshot === undefined
        ? deps.config.autoSnapshot !== false
        : body.autoSnapshot;
      const autoSnapshotEvery = body?.autoSnapshotEvery === undefined
        ? (deps.config.autoSnapshotEvery ?? 5)
        : body.autoSnapshotEvery;
      const autoSnapshotMax = body?.autoSnapshotMax === undefined
        ? (deps.config.autoSnapshotMax ?? 10)
        : body.autoSnapshotMax;
      const contextUsagePercent = body?.contextUsagePercent === undefined
        ? (deps.config.contextUsagePercent ?? 70)
        : body.contextUsagePercent;
      const ragMount = body?.ragMount === undefined
        ? deps.config.ragMount === true
        : body.ragMount;
      const mcpEnabled = body?.mcpEnabled === undefined
        ? deps.config.mcpEnabled === true
        : body.mcpEnabled;
      const mergeMcpToken = (raw, current) => {
        if (raw === undefined || raw === '') return current ?? '';
        const text = String(raw).trim();
        if (text === '-') return '';
        return text.slice(0, 500);
      };
      const mcpToken = mergeMcpToken(body?.mcpToken, deps.config.mcpToken);
      const knowledgeBackend = body?.knowledgeBackend === undefined
        ? (deps.config.knowledgeBackend ?? 'json')
        : (body.knowledgeBackend === 'sql' ? 'sqlite' : body.knowledgeBackend);
      const defaultPublic = body?.defaultPublic === undefined
        ? deps.config.defaultPublic === true
        : body.defaultPublic;
      const topicalClear = body?.topicalClear === undefined
        ? deps.config.topicalClear !== false
        : body.topicalClear;
      const engineLifecycle = body?.engineLifecycle === undefined
        ? (['manual', 'always', 'turn'].includes(deps.config.engineLifecycle)
          ? deps.config.engineLifecycle : 'manual')
        : body.engineLifecycle;
      const similarityThreshold = body?.similarityThreshold === undefined
        ? deps.config.similarityThreshold
        : body.similarityThreshold;
      const keepRecentTurns = body?.keepRecentTurns === undefined
        ? deps.config.keepRecentTurns
        : body.keepRecentTurns;
      const keepRecentSteps = body?.keepRecentSteps === undefined
        ? (deps.config.keepRecentSteps ?? 3)
        : body.keepRecentSteps;
      const restoreMaxChars = body?.restoreMaxChars === undefined
        ? (deps.config.restoreMaxChars ?? 12000)
        : body.restoreMaxChars;
      const maxContextChars = body?.maxContextChars === undefined
        ? (deps.config.maxContextChars ?? 30000)
        : body.maxContextChars;
      const defaultTopK = body?.defaultTopK === undefined
        ? (deps.config.defaultTopK ?? 5)
        : body.defaultTopK;
      const reviewHighRiskOnly = body?.reviewHighRiskOnly === undefined
        ? deps.config.reviewHighRiskOnly !== false
        : body.reviewHighRiskOnly;
      const maxContentChars = body?.maxContentChars === undefined
        ? (deps.config.maxContentChars ?? 20000)
        : body.maxContentChars;
      const maxSnapshotBytes = body?.maxSnapshotBytes === undefined
        ? (deps.config.maxSnapshotBytes ?? 262144)
        : body.maxSnapshotBytes;
      const maxClearTurns = body?.maxClearTurns === undefined
        ? (deps.config.maxClearTurns ?? 8)
        : body.maxClearTurns;
      const minClearChars = body?.minClearChars === undefined
        ? (deps.config.minClearChars ?? 200)
        : body.minClearChars;
      const maxClearChars = body?.maxClearChars === undefined
        ? (deps.config.maxClearChars ?? 120000)
        : body.maxClearChars;
      const autoKnowledge = body?.autoKnowledge === undefined
        ? deps.config.autoKnowledge !== false
        : body.autoKnowledge;
      const autoKnowledgeLimit = body?.autoKnowledgeLimit === undefined
        ? (deps.config.autoKnowledgeLimit ?? 10)
        : body.autoKnowledgeLimit;
      const autoDecisionLog = body?.autoDecisionLog === undefined
        ? deps.config.autoDecisionLog !== false
        : body.autoDecisionLog;
      const stagingRetentionDays = body?.stagingRetentionDays === undefined
        ? (deps.config.stagingRetentionDays ?? 30)
        : body.stagingRetentionDays;
      const contextRetentionDays = body?.contextRetentionDays === undefined
        ? (deps.config.contextRetentionDays ?? 0)
        : body.contextRetentionDays;
      const decisionRetentionDays = body?.decisionRetentionDays === undefined
        ? (deps.config.decisionRetentionDays ?? 0)
        : body.decisionRetentionDays;
      const autoDecisionRetentionDays = body?.autoDecisionRetentionDays === undefined
        ? (deps.config.autoDecisionRetentionDays ?? 30)
        : body.autoDecisionRetentionDays;
      const backupRetentionDays = body?.backupRetentionDays === undefined
        ? (deps.config.backupRetentionDays ?? 0)
        : body.backupRetentionDays;
      const requestAnchor = body?.requestAnchor === undefined
        ? deps.config.requestAnchor !== false
        : body.requestAnchor;
      const externalBaseUrl = body?.externalBaseUrl === undefined
        ? (deps.config.externalBaseUrl ?? '')
        : String(body.externalBaseUrl).trim();
      const externalModel = body?.externalModel === undefined
        ? (deps.config.externalModel ?? '')
        : String(body.externalModel).trim();
      const externalEmbedBaseUrl = body?.externalEmbedBaseUrl === undefined
        ? (deps.config.externalEmbedBaseUrl ?? '')
        : String(body.externalEmbedBaseUrl).trim();
      const externalEmbedModel = body?.externalEmbedModel === undefined
        ? (deps.config.externalEmbedModel ?? '')
        : String(body.externalEmbedModel).trim();
      const externalRerankBaseUrl = body?.externalRerankBaseUrl === undefined
        ? (deps.config.externalRerankBaseUrl ?? '')
        : String(body.externalRerankBaseUrl).trim();
      const externalRerankModel = body?.externalRerankModel === undefined
        ? (deps.config.externalRerankModel ?? '')
        : String(body.externalRerankModel).trim();
      // Keys are write-only from the browser's point of view: omitted or empty
      // keeps the stored key, a single "-" clears it, anything else replaces it.
      const mergeApiKey = (raw, current) => {
        if (raw === undefined || raw === '') return current ?? '';
        const text = String(raw).trim();
        if (text === '-') return '';
        return text.slice(0, 500);
      };
      const externalApiKey = mergeApiKey(body?.externalApiKey, deps.config.externalApiKey);
      const externalEmbedApiKey = mergeApiKey(body?.externalEmbedApiKey, deps.config.externalEmbedApiKey);
      const externalRerankApiKey = mergeApiKey(body?.externalRerankApiKey, deps.config.externalRerankApiKey);
      const externalTimeoutMs = body?.externalTimeoutMs === undefined
        ? (deps.config.externalTimeoutMs ?? 60000)
        : body.externalTimeoutMs;
      const archiveExternal = body?.archiveExternal === undefined
        ? deps.config.archiveExternal === true
        : body.archiveExternal;
      const knowledgeExternal = body?.knowledgeExternal === undefined
        ? deps.config.knowledgeExternal === true
        : body.knowledgeExternal;
      const contextExternal = body?.contextExternal === undefined
        ? deps.config.contextExternal === true
        : body.contextExternal;

      if (root !== '' && !path.isAbsolute(root)) {
        sendJson(response, 400, { ok: false, error: '记忆地址必须是绝对路径，或留空跟随项目' });
        return;
      }
      if (root.length > 1000 || root.includes('\0')) {
        sendJson(response, 400, { ok: false, error: '记忆地址不合法' });
        return;
      }
      if (directoryName === '' || directoryName.length > 100
        || directoryName === '.' || directoryName === '..' || /[\\/]/.test(directoryName)) {
        sendJson(response, 400, { ok: false, error: '目录名必须是单段名称（不含路径分隔符）' });
        return;
      }
      if (typeof autoEnabled !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'autoEnabled 必须是布尔值' });
        return;
      }
      if (!Number.isInteger(autoEveryRounds) || autoEveryRounds < 1 || autoEveryRounds > 100) {
        sendJson(response, 400, { ok: false, error: '自动触发轮数必须是 1~100 的整数' });
        return;
      }
      if (typeof autoSnapshot !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'autoSnapshot 必须是布尔值' });
        return;
      }
      if (!Number.isInteger(autoSnapshotEvery) || autoSnapshotEvery < 1 || autoSnapshotEvery > 100) {
        sendJson(response, 400, { ok: false, error: '自动快照轮数必须是 1~100 的整数' });
        return;
      }
      if (!Number.isInteger(autoSnapshotMax) || autoSnapshotMax < 1 || autoSnapshotMax > 200) {
        sendJson(response, 400, { ok: false, error: '快照上限必须是 1~200 的整数' });
        return;
      }
      if (!Number.isInteger(contextUsagePercent) || contextUsagePercent < 1 || contextUsagePercent > 100) {
        sendJson(response, 400, { ok: false, error: '上下文占用阈值必须是 1~100 的整数（百分比）' });
        return;
      }
      if (typeof ragMount !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'ragMount 必须是布尔值' });
        return;
      }
      if (typeof mcpEnabled !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'mcpEnabled 必须是布尔值' });
        return;
      }
      if (typeof mcpToken !== 'string' || mcpToken.length > 500) {
        sendJson(response, 400, { ok: false, error: 'MCP 访问令牌不能超过 500 字符' });
        return;
      }
      if (ragMount) {
        const models = ragModelStatus(effectivePluginConfig({
          ...deps.config,
          externalEmbedBaseUrl,
          externalEmbedModel,
          externalRerankBaseUrl,
          externalRerankModel,
        }));
        if (!models.ready) {
          sendJson(response, 400, {
            ok: false,
            error: `启用 RAG 需要同时配置 Embedding 和 Rerank 两个模型；当前缺少：${models.missing.join('、')}`,
          });
          return;
        }
      }
      if (knowledgeBackend !== 'json' && knowledgeBackend !== 'sqlite') {
        sendJson(response, 400, { ok: false, error: 'knowledgeBackend 必须是 json 或 sqlite' });
        return;
      }
      if (typeof defaultPublic !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'defaultPublic 必须是布尔值' });
        return;
      }
      if (typeof topicalClear !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'topicalClear 必须是布尔值' });
        return;
      }
      if (!['manual', 'always', 'turn'].includes(engineLifecycle)) {
        sendJson(response, 400, { ok: false, error: '本地引擎运行方式必须是 manual、always 或 turn' });
        return;
      }
      if (typeof similarityThreshold !== 'number' || !Number.isFinite(similarityThreshold)
        || similarityThreshold < 0.01 || similarityThreshold > 0.95) {
        sendJson(response, 400, { ok: false, error: '相似度阈值必须是 0.01~0.95 的数字' });
        return;
      }
      if (!Number.isInteger(keepRecentTurns) || keepRecentTurns < 1 || keepRecentTurns > 20) {
        sendJson(response, 400, { ok: false, error: '保留轮数必须是 1~20 的整数' });
        return;
      }
      if (!Number.isInteger(keepRecentSteps) || keepRecentSteps < 1 || keepRecentSteps > 20) {
        sendJson(response, 400, { ok: false, error: '保留步数必须是 1~20 的整数' });
        return;
      }
      if (!Number.isInteger(restoreMaxChars) || restoreMaxChars < 1000 || restoreMaxChars > 100000) {
        sendJson(response, 400, { ok: false, error: '恢复字符预算必须是 1000~100000 的整数' });
        return;
      }
      for (const [name, value, min, max] of [
        ['maxContextChars', maxContextChars, 1000, 200000],
        ['defaultTopK', defaultTopK, 1, 50],
        ['maxContentChars', maxContentChars, 1000, 200000],
        ['maxSnapshotBytes', maxSnapshotBytes, 1024, 1000000000],
        ['maxClearTurns', maxClearTurns, 1, 50],
        ['minClearChars', minClearChars, 0, 20000],
        ['maxClearChars', maxClearChars, 1000, 1000000],
        ['autoKnowledgeLimit', autoKnowledgeLimit, 1, 100],
        ['stagingRetentionDays', stagingRetentionDays, 0, 3650],
        ['contextRetentionDays', contextRetentionDays, 0, 3650],
        ['decisionRetentionDays', decisionRetentionDays, 0, 3650],
        ['autoDecisionRetentionDays', autoDecisionRetentionDays, 0, 3650],
        ['backupRetentionDays', backupRetentionDays, 0, 3650],
      ]) {
        if (!Number.isInteger(value) || value < min || value > max) {
          sendJson(response, 400, { ok: false, error: `${name} 必须是 ${min}~${max} 的整数` });
          return;
        }
      }
      if (typeof reviewHighRiskOnly !== 'boolean' || typeof autoKnowledge !== 'boolean'
        || typeof autoDecisionLog !== 'boolean' || typeof requestAnchor !== 'boolean') {
        sendJson(response, 400, { ok: false, error: '策略开关必须是布尔值' });
        return;
      }
      if (externalBaseUrl !== '') {
        let parsed = null;
        try {
          parsed = new URL(externalBaseUrl);
        } catch {
          parsed = null;
        }
        if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          sendJson(response, 400, { ok: false, error: '外部模型地址必须是 http(s) URL，或留空用默认值' });
          return;
        }
      }
      if (!Number.isInteger(externalTimeoutMs) || externalTimeoutMs < 1000 || externalTimeoutMs > 600000) {
        sendJson(response, 400, { ok: false, error: '外部模型超时必须是 1000~600000 的整数（毫秒）' });
        return;
      }
      if (typeof archiveExternal !== 'boolean' || typeof knowledgeExternal !== 'boolean'
        || typeof contextExternal !== 'boolean') {
        sendJson(response, 400, { ok: false, error: '三层模式开关必须是布尔值' });
        return;
      }
      for (const [name, value] of [
        ['externalEmbedBaseUrl', externalEmbedBaseUrl],
        ['externalRerankBaseUrl', externalRerankBaseUrl],
      ]) {
        if (value === '') continue;
        let parsed = null;
        try {
          parsed = new URL(value);
        } catch {
          parsed = null;
        }
        if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          sendJson(response, 400, { ok: false, error: `${name} 必须是 http(s) URL，或留空沿用主地址` });
          return;
        }
      }
      if (!deps.editor || typeof deps.editor.edit !== 'function' || !deps.entry) {
        sendJson(response, 503, { ok: false, error: '当前运行环境不允许从面板保存配置' });
        return;
      }

      try {
        await deps.editor.edit(deps.entry, (current) => ({
          ...(current ?? {}),
          root,
          directoryName,
          autoEnabled,
          autoEveryRounds,
          engineLifecycle,
          autoSnapshot,
          autoSnapshotEvery,
          autoSnapshotMax,
          contextUsagePercent,
          restoreMaxChars,
          maxContextChars,
          defaultTopK,
          reviewHighRiskOnly,
          maxContentChars,
          maxSnapshotBytes,
          maxClearTurns,
          minClearChars,
          maxClearChars,
          autoKnowledge,
          autoKnowledgeLimit,
          autoDecisionLog,
          stagingRetentionDays,
          contextRetentionDays,
          decisionRetentionDays,
          autoDecisionRetentionDays,
          backupRetentionDays,
          requestAnchor,
          ragMount,
          mcpEnabled,
          mcpToken,
          knowledgeBackend,
          defaultPublic,
          topicalClear,
          similarityThreshold,
          keepRecentTurns,
          keepRecentSteps,
          externalBaseUrl,
          externalModel,
          externalApiKey,
          externalTimeoutMs,
          externalEmbedBaseUrl,
          externalEmbedModel,
          externalEmbedApiKey,
          externalRerankBaseUrl,
          externalRerankModel,
          externalRerankApiKey,
          archiveExternal,
          knowledgeExternal,
          contextExternal,
        }));
      } catch (error) {
        sendJson(response, 500, { ok: false, error: `保存配置失败：${error?.message ?? error}` });
        return;
      }
      appendAudit(deps.registryDir, { action: 'config.save', root, detail: directoryName });
      sendJson(response, 200, {
        ok: true,
        saved: {
          root,
          directoryName,
          autoEnabled,
          autoEveryRounds,
          engineLifecycle,
          autoSnapshot,
          autoSnapshotEvery,
          autoSnapshotMax,
          contextUsagePercent,
          restoreMaxChars,
          maxContextChars,
          defaultTopK,
          reviewHighRiskOnly,
          maxContentChars,
          maxSnapshotBytes,
          maxClearTurns,
          minClearChars,
          maxClearChars,
          autoKnowledge,
          autoKnowledgeLimit,
          autoDecisionLog,
          stagingRetentionDays,
          contextRetentionDays,
          decisionRetentionDays,
          autoDecisionRetentionDays,
          backupRetentionDays,
          requestAnchor,
          ragMount,
          mcpEnabled,
          knowledgeBackend,
          defaultPublic,
          topicalClear,
          similarityThreshold,
          keepRecentTurns,
          keepRecentSteps,
          externalBaseUrl,
          externalModel,
          externalTimeoutMs,
          externalEmbedBaseUrl,
          externalEmbedModel,
          externalRerankBaseUrl,
          externalRerankModel,
          archiveExternal,
          knowledgeExternal,
          contextExternal,
        },
      });
    });
  });
}
