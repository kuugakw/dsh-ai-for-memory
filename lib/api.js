/**
 * HTTP API backing the Web panel.
 *
 * Routes (same-origin, loopback only):
 *   GET  /ai-for-memory/api/state     memory snapshot for one registered root
 *   POST /ai-for-memory/api/reveal    open a registered root in the OS file manager
 *   POST /ai-for-memory/api/config    persist a fixed memory directory via configEditor
 *
 * The API never reads arbitrary paths: a root must come from the registry or
 * from the plugin's own configured `root`. A conversation must be one the
 * plugin itself recorded under `<root>/sessions` (or the id the Host is
 * currently using), so the state route is not a generic Session reader either.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { MemoryScopes, isSessionKey, sessionKey, shortSessionId } from './scopes.js';
import { recentSessionId } from './activity.js';
import { buildUiState } from './ui-state.js';
import { listRootRows, resolveRegisteredRoot } from './registry.js';
import { normalizeExternal, probe as probeExternal } from './external.js';
import { buildRagIndex, embeddingIdentity, ragModelStatus, ragStats } from './rag.js';
import { exportArtifact } from './export.js';

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

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function originTrusted(origin, host) {
  try {
    const url = new URL(origin);
    if (url.host === host) return true;
    return url.protocol === 'dsh-app:';
  } catch {
    return false;
  }
}

/** Writes require a loopback peer and, when present, a trusted Origin. */
function isSameOrigin(request) {
  if (!isLoopback(request.socket?.remoteAddress)) return false;
  const origin = request.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  return originTrusted(origin, request.headers?.host);
}

function applyCors(request, response) {
  if (!isLoopback(request.socket?.remoteAddress)) return;
  const origin = request.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return;
  if (!originTrusted(origin, request.headers?.host)) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'origin');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
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

function openInFileManager(target) {
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', [target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
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
      const base = {
        ok: true,
        generatedAt: new Date().toISOString(),
        roots,
        fixedRoot: deps.config.root ?? '',
        directoryName: deps.config.directoryName,
        mode: deps.config.autoEnabled ? 'auto' : 'manual',
        autoEnabled: deps.config.autoEnabled,
        autoEveryRounds: deps.config.autoEveryRounds,
        // Automatic snapshots are independent from automatic tidying.
        autoSnapshot: deps.config.autoSnapshot !== false,
        autoSnapshotEvery: deps.config.autoSnapshotEvery ?? 5,
        autoSnapshotMax: deps.config.autoSnapshotMax ?? 10,
        contextUsagePercent: deps.config.contextUsagePercent ?? 70,
        defaultPublic: deps.config.defaultPublic === true,
        topicalClear: deps.config.topicalClear !== false,
        similarityThreshold: deps.config.similarityThreshold,
        keepRecentTurns: deps.config.keepRecentTurns,
        maxClearTurns: deps.config.maxClearTurns ?? 8,
        minClearChars: deps.config.minClearChars ?? 200,
        maxClearChars: deps.config.maxClearChars ?? 120000,
        restoreMaxChars: deps.config.restoreMaxChars ?? 12000,
        // External model endpoint (never the API key) so the panel can show and
        // edit the address without keeping a secret in the browser.
        externalBaseUrl: deps.config.externalBaseUrl ?? '',
        externalModel: deps.config.externalModel ?? '',
        externalTimeoutMs: deps.config.externalTimeoutMs ?? 60000,
        externalEmbedBaseUrl: deps.config.externalEmbedBaseUrl ?? '',
        externalEmbedModel: deps.config.externalEmbedModel ?? '',
        externalRerankBaseUrl: deps.config.externalRerankBaseUrl ?? '',
        externalRerankModel: deps.config.externalRerankModel ?? '',
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
        ragMount: deps.config.ragMount === true,
        // Both models are mandatory for RAG: embedding indexes, rerank reorders.
        ragModelsReady: ragModelStatus(deps.config).ready,
        ragModelsMissing: ragModelStatus(deps.config).missing,
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
        // Closed conversations are invisible to everyone except themselves.
        sources = rows
          .filter((row) => row.current || row.public === true)
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
        baseUrl: deps.config.externalBaseUrl,
        model: deps.config.externalModel,
        embedBaseUrl: deps.config.externalEmbedBaseUrl,
        embedModel: deps.config.externalEmbedModel,
        apiKey: deps.config.externalApiKey,
        timeoutMs: deps.config.externalTimeoutMs,
      }));
      const stats = sources.length > 0
        ? ragStats(sources[0].store.root)
        : { built: false, docs: 0, dim: 0, model: '', endpoint: '', built_at: '' };
      const ragIndex = {
        ...stats,
        current_model: currentEmbedding.model,
        current_endpoint: currentEmbedding.endpoint,
        stale: stats.built === true
          && (stats.model !== currentEmbedding.model
            || (stats.endpoint !== '' && stats.endpoint !== currentEmbedding.endpoint)),
      };
      // Which backend actually serves the knowledge rows (SQLite may have
      // downgraded to JSON on an old Node), plus the file shown in the panel.
      const knowledgeStorage = sources.length > 0
        ? sources[0].store.knowledgeBackendInfo()
        : { backend: deps.config.knowledgeBackend ?? 'json', file: '', sqliteAvailable: false, error: '' };
      sendJson(response, 200, {
        ...base,
        ...state,
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

    register(`${PREFIX}/session`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
        return;
      }
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
      if (label === undefined && isPublic === undefined) {
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
      scopes.touch(resolved.key, patch);

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
        saved: { key: resolved.key, label: label ?? row?.label ?? '', public: isPublic ?? row?.public === true },
        session: row ? sessionRow(row, scopes.counts(row.key), false) : null,
      });
    });

    register(`${PREFIX}/reveal`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
        return;
      }
      const body = await readJson(request);
      const target = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      if (target === null) {
        sendJson(response, 404, { ok: false, error: '记忆目录未登记' });
        return;
      }
      // The fixed root may not have been used yet; create it so "open folder" works.
      fs.mkdirSync(target, { recursive: true });
      openInFileManager(target);
      sendJson(response, 200, { ok: true, root: target });
    });

    /** Connectivity check for the external model (any OpenAI-compatible API). */
    register(`${PREFIX}/external`, async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      const endpoint = normalizeExternal({
        baseUrl: deps.config.externalBaseUrl,
        model: deps.config.externalModel,
        embedBaseUrl: deps.config.externalEmbedBaseUrl,
        embedModel: deps.config.externalEmbedModel,
        rerankBaseUrl: deps.config.externalRerankBaseUrl,
        rerankModel: deps.config.externalRerankModel,
        apiKey: deps.config.externalApiKey,
        timeoutMs: deps.config.externalTimeoutMs,
      });
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
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
        return;
      }
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
      const models = ragModelStatus(deps.config);
      if (!models.ready) {
        sendJson(response, 400, {
          ok: false,
          error: `建立 RAG 索引需要同时配置 Embedding 和 Rerank 两个模型；当前缺少：${models.missing.join('、')}`,
        });
        return;
      }
      const endpoint = normalizeExternal({
        baseUrl: deps.config.externalBaseUrl,
        model: deps.config.externalModel,
        embedBaseUrl: deps.config.externalEmbedBaseUrl,
        embedModel: deps.config.externalEmbedModel,
        apiKey: deps.config.externalApiKey,
        timeoutMs: deps.config.externalTimeoutMs,
      });
      const built = await buildRagIndex(store, endpoint);
      if (!built.ok) {
        sendJson(response, 200, { ok: false, error: built.error, indexed: built.indexed, pending: built.pending });
        return;
      }
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
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
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
    register(`${PREFIX}/config`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
        return;
      }
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
      const knowledgeBackend = body?.knowledgeBackend === undefined
        ? (deps.config.knowledgeBackend ?? 'json')
        : (body.knowledgeBackend === 'sql' ? 'sqlite' : body.knowledgeBackend);
      const defaultPublic = body?.defaultPublic === undefined
        ? deps.config.defaultPublic === true
        : body.defaultPublic;
      const topicalClear = body?.topicalClear === undefined
        ? deps.config.topicalClear !== false
        : body.topicalClear;
      const similarityThreshold = body?.similarityThreshold === undefined
        ? deps.config.similarityThreshold
        : body.similarityThreshold;
      const keepRecentTurns = body?.keepRecentTurns === undefined
        ? deps.config.keepRecentTurns
        : body.keepRecentTurns;
      const restoreMaxChars = body?.restoreMaxChars === undefined
        ? (deps.config.restoreMaxChars ?? 12000)
        : body.restoreMaxChars;
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
      if (ragMount) {
        const models = ragModelStatus({
          externalEmbedModel,
          externalRerankModel,
        });
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
      if (typeof similarityThreshold !== 'number' || !Number.isFinite(similarityThreshold)
        || similarityThreshold < 0.01 || similarityThreshold > 0.95) {
        sendJson(response, 400, { ok: false, error: '相似度阈值必须是 0.01~0.95 的数字' });
        return;
      }
      if (!Number.isInteger(keepRecentTurns) || keepRecentTurns < 1 || keepRecentTurns > 20) {
        sendJson(response, 400, { ok: false, error: '保留轮数必须是 1~20 的整数' });
        return;
      }
      if (!Number.isInteger(restoreMaxChars) || restoreMaxChars < 1000 || restoreMaxChars > 100000) {
        sendJson(response, 400, { ok: false, error: '恢复字符预算必须是 1000~100000 的整数' });
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
          autoSnapshot,
          autoSnapshotEvery,
          autoSnapshotMax,
          contextUsagePercent,
          restoreMaxChars,
          ragMount,
          knowledgeBackend,
          defaultPublic,
          topicalClear,
          similarityThreshold,
          keepRecentTurns,
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
      sendJson(response, 200, {
        ok: true,
        saved: {
          root,
          directoryName,
          autoEnabled,
          autoEveryRounds,
          autoSnapshot,
          autoSnapshotEvery,
          autoSnapshotMax,
          contextUsagePercent,
          restoreMaxChars,
          ragMount,
          knowledgeBackend,
          defaultPublic,
          topicalClear,
          similarityThreshold,
          keepRecentTurns,
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
